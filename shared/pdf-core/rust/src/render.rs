use crate::color::ColorSpace;
use crate::display::{
    DisplayList, Gradient, ImageRef, Matrix, NO_BLOB, OP_BLEND, OP_CLIP, OP_FILL, OP_FILL_GRADIENT,
    OP_LINE_CAP, OP_LINE_JOIN, OP_LINE_WIDTH, OP_MITER, OP_RESTORE, OP_SAVE, OP_SHADE, OP_STROKE,
    OP_STROKE_GRADIENT, OP_TEXT_CLIP, PathData, multiply,
};
use crate::document::{Document, Page, PageRequest, borrow_pages};
use crate::failure::{Failure, Outcome};
use crate::filters;
use crate::font::{Font, Glyph};
use crate::image::{Decoded, ImageContext, ImageInput, Pixels, decode_image, image_filter};
use crate::inspection::Limits;
use crate::num::{bounded, f64_to_i64, f64_to_usize, unit_to_u8};
use crate::object::{Dict, ObjRef, Object, Resolver as _, Stream, object_numbers};
use crate::shading::{GradientPaint, Shading, parse_shading};
use crate::syntax::{ContentLexer, ContentToken, Operand};
use crate::text::tail_numbers;
use alloc::rc::Rc;
use core::mem;
use core::ops::Deref;
use std::collections::{HashMap, HashSet};

const IDENTITY: Matrix = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
const MAX_OPERANDS: usize = 512;
const MAX_FORM_DEPTH: usize = 16;
const MAX_STATE_STACK: usize = 256;
const MAX_OPERATORS: usize = 4_000_000;
const MAX_OPS_BYTES: usize = 96 << 20;
const MAX_BLOB_BYTES: usize = 384 << 20;
const MAX_CACHED_FONTS: usize = 1024;
const MAX_CACHED_OUTLINES: usize = 1 << 16;
const MAX_CACHED_IMAGE_BYTES: usize = 96 << 20;
const MAX_CACHED_STREAM_BYTES: usize = 64 << 20;
const MAX_CACHED_SPACES: usize = 4096;
const MAX_OUTLINE_WORK: usize = 16_000_000;
const MAX_MARKED_CONTENT: usize = 1024;
const MAX_VISIBILITY_DEPTH: usize = 8;
const BOX_DESCENT: f64 = -0.2;
const BOX_ASCENT: f64 = 0.8;
const PLACEHOLDER: [u8; 4] = [217, 217, 217, 255];
const FALLBACK_SERIF: u8 = 1;
const FALLBACK_MONO: u8 = 2;
const FALLBACK_BOLD: u8 = 4;
const FALLBACK_ITALIC: u8 = 8;
const FALLBACK_FILL: u8 = 16;
const FALLBACK_STROKE: u8 = 32;
const GLYPH_FILL: u8 = 1;
const GLYPH_STROKE: u8 = 2;
const GLYPH_CLIP: u8 = 4;
const RULE_NONZERO: u8 = 0;
const RULE_EVENODD: u8 = 1;

#[derive(Debug)]
pub(crate) struct RenderedPage {
    pub list: DisplayList,
    pub page_index: u32,
    pub rotate: i32,
    pub view: [f64; 4],
}

#[derive(Default)]
pub(crate) struct RenderSession {
    fonts: HashMap<ObjRef, Rc<RenderFont>>,
    image_bytes: usize,
    images: HashMap<ImageKey, Rc<Decoded>>,
    next_font: u32,
    outlines: HashMap<(u32, u16), Rc<PathData>>,
    spaces: HashMap<ObjRef, Rc<ColorSpace>>,
    stream_bytes: usize,
    streams: HashMap<ObjRef, Rc<[u8]>>,
}

#[derive(Debug, Default)]
pub(crate) struct OptionalContent {
    off: HashSet<ObjRef>,
    present: bool,
}

type NamedSpaces = HashMap<usize, (Rc<Object>, HashMap<Vec<u8>, Rc<ColorSpace>>)>;

type ImageKey = (ObjRef, [u8; 4], u32);

enum ImageData<'source> {
    Inline(&'source [u8]),
    Stream(&'source Stream),
}

enum Face {
    Fallback(u32),
    Outline,
    Type3(Box<Type3>),
}

struct Type3 {
    matrix: Matrix,
    procs: Option<Rc<Object>>,
    resources: Option<Rc<Object>>,
}

struct RenderFont {
    face: Face,
    font: Font,
    id: u32,
}

#[derive(Clone)]
struct Paint {
    color: [u8; 4],
    gradient: Option<Rc<GradientPaint>>,
}

impl Paint {
    const fn solid(color: [u8; 4]) -> Self {
        Self {
            color,
            gradient: None,
        }
    }
}

#[derive(Clone)]
struct GState {
    blend: u8,
    cap: u8,
    char_space: f64,
    ctm: Matrix,
    dash: Rc<(Vec<f64>, f64)>,
    fill: Paint,
    fill_alpha: f64,
    fill_space: Rc<ColorSpace>,
    font: Option<Rc<RenderFont>>,
    font_size: f64,
    join: u8,
    leading: f64,
    line_width: f64,
    miter: f64,
    render_mode: u8,
    rise: f64,
    scale: f64,
    stroke: Paint,
    stroke_alpha: f64,
    stroke_space: Rc<ColorSpace>,
    word_space: f64,
}

#[derive(Clone, Default)]
struct Emitted {
    blend: Option<u8>,
    cap: Option<u8>,
    dash: Option<Rc<(Vec<f64>, f64)>>,
    fill: Option<[u8; 4]>,
    fill_gradient: Option<Rc<GradientPaint>>,
    join: Option<u8>,
    line_width: Option<f64>,
    miter: Option<f64>,
    stroke: Option<[u8; 4]>,
    stroke_gradient: Option<Rc<GradientPaint>>,
    transform: Option<Matrix>,
}

#[derive(Clone)]
struct Frame {
    base: Matrix,
    resources: Rc<Object>,
}

struct TextState {
    clip: bool,
    line: Matrix,
    matrix: Matrix,
}

#[derive(Default)]
struct Marked {
    hidden: usize,
    overflow: usize,
    stack: Vec<bool>,
}

impl Marked {
    fn pop(&mut self) {
        if self.overflow > 0 {
            self.overflow = self.overflow.saturating_sub(1);
        } else if self.stack.pop() == Some(true) {
            self.hidden = self.hidden.saturating_sub(1);
        }
    }

    fn push(&mut self, hidden: bool) {
        if self.stack.len() >= MAX_MARKED_CONTENT {
            self.overflow = self.overflow.saturating_add(1);
            return;
        }
        self.stack.push(hidden);
        if hidden {
            self.hidden = self.hidden.saturating_add(1);
        }
    }
}

impl OptionalContent {
    fn expression(&self, document: &Document<'_>, entry: &Object, depth: usize) -> bool {
        if depth > MAX_VISIBILITY_DEPTH {
            return true;
        }
        let Ok(resolved) = document.follow(entry) else {
            return true;
        };
        let Some(items) = resolved.as_array() else {
            return self.state(entry);
        };
        let operands = items.get(1..).unwrap_or_default();
        let next = depth.saturating_add(1);
        match items.first().and_then(Object::as_name) {
            Some(b"And") => operands
                .iter()
                .all(|item| self.expression(document, item, next)),
            Some(b"Or") => operands
                .iter()
                .any(|item| self.expression(document, item, next)),
            Some(b"Not") => operands
                .first()
                .is_none_or(|item| !self.expression(document, item, next)),
            _ => true,
        }
    }

    pub(crate) fn load(document: &Document<'_>) -> Self {
        let mut content = Self::default();
        let Ok(Some(catalog)) = document.catalog() else {
            return content;
        };
        let Some(properties) = catalog
            .as_dict()
            .and_then(|dict| dict.get(b"OCProperties"))
            .and_then(|value| document.follow(value).ok())
        else {
            return content;
        };
        let Some(dict) = properties.as_dict() else {
            return content;
        };
        content.present = true;
        let config = dict.get(b"D").and_then(|value| document.follow(value).ok());
        let config_dict = config.as_deref().and_then(Object::as_dict);
        let refs = |holder: Option<&Dict>, key: &[u8]| -> Vec<ObjRef> {
            holder
                .and_then(|inner| inner.get(key))
                .and_then(|value| document.follow(value).ok())
                .and_then(|value| {
                    value.as_array().map(|items| {
                        items
                            .iter()
                            .filter_map(|item| {
                                if let Object::Ref(reference) = item {
                                    Some(*reference)
                                } else {
                                    None
                                }
                            })
                            .collect()
                    })
                })
                .unwrap_or_default()
        };
        let base_off = config_dict
            .and_then(|inner| inner.get(b"BaseState"))
            .and_then(Object::as_name)
            == Some(b"OFF");
        if base_off {
            content.off = refs(Some(dict), b"OCGs").into_iter().collect();
            for reference in refs(config_dict, b"ON") {
                let _: bool = content.off.remove(&reference);
            }
        } else {
            content.off = refs(config_dict, b"OFF").into_iter().collect();
        }
        content
    }

    fn state(&self, entry: &Object) -> bool {
        entry
            .as_reference()
            .is_none_or(|reference| !self.off.contains(&reference))
    }

    fn visible(&self, document: &Document<'_>, entry: &Object, depth: usize) -> bool {
        if !self.present || depth > MAX_VISIBILITY_DEPTH {
            return true;
        }
        let Ok(resolved) = document.follow(entry) else {
            return true;
        };
        let Some(dict) = resolved.as_dict() else {
            return true;
        };
        if dict.get(b"Type").and_then(Object::as_name) != Some(b"OCMD") {
            return self.state(entry);
        }
        if let Some(expression) = dict.get(b"VE") {
            return self.expression(document, expression, depth.saturating_add(1));
        }
        let Some(members) = dict.get(b"OCGs") else {
            return true;
        };
        let states: Vec<bool> = match document.follow(members).ok().as_deref() {
            Some(Object::Array(items)) => items.iter().map(|item| self.state(item)).collect(),
            Some(_) => vec![self.state(members)],
            None => Vec::new(),
        };
        if states.is_empty() {
            return true;
        }
        match dict.get(b"P").and_then(Object::as_name) {
            Some(b"AllOn") => states.iter().all(|on| *on),
            Some(b"AnyOff") => states.iter().any(|on| !*on),
            Some(b"AllOff") => states.iter().all(|on| !*on),
            _ => states.iter().any(|on| *on),
        }
    }
}

enum View<'object> {
    Borrowed(&'object Object),
    Shared(Rc<Object>),
}

impl Deref for View<'_> {
    type Target = Object;

    fn deref(&self) -> &Object {
        match self {
            Self::Borrowed(object) => object,
            Self::Shared(object) => object,
        }
    }
}

struct Renderer<'doc, 'data> {
    active: Vec<ObjRef>,
    box_glyph: Option<u32>,
    budget: usize,
    content: &'doc OptionalContent,
    decoded: String,
    document: &'doc Document<'data>,
    emitted: Emitted,
    emitted_stack: Vec<Emitted>,
    glyph_ids: HashMap<(u32, u16), Option<u32>>,
    glyphs: Vec<Glyph>,
    images: HashMap<ImageKey, ImageRef>,
    limits: &'doc Limits,
    list: DisplayList,
    named_spaces: NamedSpaces,
    next_glyph: u32,
    operator_limit: usize,
    operators: usize,
    outline_work: usize,
    scale: f64,
    session: &'doc mut RenderSession,
    truncated: bool,
}

struct PageTarget<'run, 'data> {
    content: &'run OptionalContent,
    document: &'run Document<'data>,
    limits: &'run Limits,
    operator_limit: usize,
    page: &'run Page,
    scale: f64,
}

struct PageSelection<'pages> {
    operator_limit: usize,
    page_indexes: PageRequest<&'pages [u32]>,
    scale: f64,
}

impl GState {
    fn initial() -> Self {
        Self {
            blend: 0,
            cap: 0,
            char_space: 0.0,
            ctm: IDENTITY,
            dash: Rc::new((Vec::new(), 0.0)),
            fill: Paint::solid([0, 0, 0, 255]),
            fill_alpha: 1.0,
            fill_space: Rc::new(ColorSpace::Gray),
            font: None,
            font_size: 0.0,
            join: 0,
            leading: 0.0,
            line_width: 1.0,
            miter: 10.0,
            render_mode: 0,
            rise: 0.0,
            scale: 1.0,
            stroke: Paint::solid([0, 0, 0, 255]),
            stroke_alpha: 1.0,
            stroke_space: Rc::new(ColorSpace::Gray),
            word_space: 0.0,
        }
    }
}

impl Renderer<'_, '_> {
    fn add_image(&mut self, decoded: &Decoded, interpolate: bool) -> ImageRef {
        let (jpeg, raster) = match &decoded.image {
            Pixels::Jpeg(raster) => (true, raster),
            Pixels::Raster(raster) => (false, raster),
        };
        let (mask_jpeg, mask_raster) = match &decoded.mask {
            Some(Pixels::Jpeg(inner)) => (true, Some(inner)),
            Some(Pixels::Raster(inner)) => (false, Some(inner)),
            None => (false, None),
        };
        let (mask, mask_width, mask_height) = mask_raster.map_or((NO_BLOB, 0, 0), |inner| {
            (
                self.list.blob(inner.pixels.clone()),
                inner.width,
                inner.height,
            )
        });
        ImageRef {
            blob: self.list.blob(raster.pixels.clone()),
            height: raster.height,
            interpolate,
            jpeg,
            mask,
            mask_height,
            mask_jpeg,
            mask_width,
            matte: decoded.matte,
            width: raster.width,
        }
    }

    fn annotations(&mut self, page: &Page, frame: &Frame) -> Outcome<()> {
        let Some(annots) = page.dict.get(b"Annots") else {
            return Ok(());
        };
        let Ok(resolved) = self.document.follow(annots) else {
            return Ok(());
        };
        let Some(items) = resolved.as_array() else {
            return Ok(());
        };
        for item in items {
            let Ok(annotation) = self.document.follow(item) else {
                continue;
            };
            let Some(dict) = annotation.as_dict() else {
                continue;
            };
            let flags = dict.get(b"F").and_then(Object::as_integer).unwrap_or(0);
            if flags & (2 | 32) != 0
                || dict.get(b"Subtype").and_then(Object::as_name) == Some(b"Popup")
                || dict.get(b"OC").is_some_and(|marker| self.hidden(marker))
            {
                continue;
            }
            let Some(appearance) = self.appearance_stream(dict) else {
                continue;
            };
            let Some(stream) = appearance.as_stream() else {
                continue;
            };
            let rect = self.rect(dict.get(b"Rect"));
            let bbox = self.rect(stream.dict.get(b"BBox"));
            let (Some(target), Some(source)) = (rect, bbox) else {
                continue;
            };
            let form_matrix = matrix_of(stream.dict.get(b"Matrix")).unwrap_or(IDENTITY);
            let corners = [
                (source[0], source[1]),
                (source[2], source[1]),
                (source[0], source[3]),
                (source[2], source[3]),
            ]
            .map(|(x, y)| {
                (
                    x * form_matrix[0] + y * form_matrix[2] + form_matrix[4],
                    x * form_matrix[1] + y * form_matrix[3] + form_matrix[5],
                )
            });
            let min_x = corners
                .iter()
                .map(|corner| corner.0)
                .fold(f64::INFINITY, f64::min);
            let max_x = corners
                .iter()
                .map(|corner| corner.0)
                .fold(f64::NEG_INFINITY, f64::max);
            let min_y = corners
                .iter()
                .map(|corner| corner.1)
                .fold(f64::INFINITY, f64::min);
            let max_y = corners
                .iter()
                .map(|corner| corner.1)
                .fold(f64::NEG_INFINITY, f64::max);
            let width = max_x - min_x;
            let height = max_y - min_y;
            if width.abs() < f64::EPSILON || height.abs() < f64::EPSILON {
                continue;
            }
            let sx = (target[2] - target[0]) / width;
            let sy = (target[3] - target[1]) / height;
            let placement = [
                sx,
                0.0_f64,
                0.0_f64,
                sy,
                target[0] - min_x * sx,
                target[1] - min_y * sy,
            ];
            let mut state = GState::initial();
            state.ctm = placement;
            self.form(stream, None, &state, frame, 1)?;
        }
        Ok(())
    }

    fn appearance_stream(&self, dict: &Dict) -> Option<Rc<Object>> {
        let appearances = self.document.follow(dict.get(b"AP")?).ok()?;
        let normal = self
            .document
            .follow(appearances.as_dict()?.get(b"N")?)
            .ok()?;
        if normal.as_stream().is_some() {
            return Some(normal);
        }
        let states = normal.as_dict()?;
        let state = dict.get(b"AS").and_then(Object::as_name)?;
        let chosen = self.document.follow(states.get(state)?).ok()?;
        chosen.as_stream().is_some().then_some(chosen)
    }

    fn apply_ext_gstate(&mut self, name: &[u8], frame: &Frame, state: &mut GState) {
        let Some(resolved) = self.resource(frame, b"ExtGState", name) else {
            return;
        };
        let Some(dict) = resolved.as_dict() else {
            return;
        };
        for (key, raw) in &dict.entries {
            let Ok(value) = self.document.follow(raw) else {
                continue;
            };
            let number = value.as_number();
            match key.as_slice() {
                b"LW" => state.line_width = number.unwrap_or(state.line_width),
                b"LC" => {
                    state.cap = number.map_or(state.cap, |cap| {
                        u8::try_from(f64_to_i64(cap).clamp(0, 2)).unwrap_or(0)
                    });
                }
                b"LJ" => {
                    state.join = number.map_or(state.join, |join| {
                        u8::try_from(f64_to_i64(join).clamp(0, 2)).unwrap_or(0)
                    });
                }
                b"ML" => state.miter = number.unwrap_or(state.miter),
                b"CA" => state.stroke_alpha = bounded(number.unwrap_or(1.0_f64), 0.0, 1.0),
                b"ca" => state.fill_alpha = bounded(number.unwrap_or(1.0_f64), 0.0, 1.0),
                b"BM" => {
                    let mode = value
                        .as_name()
                        .or_else(|| value.as_array()?.first()?.as_name())
                        .map_or(0, blend_mode);
                    state.blend = mode;
                }
                b"D" => {
                    if let Some(items) = value.as_array() {
                        let lengths = object_numbers(items.first());
                        let phase = items.get(1).and_then(Object::as_number).unwrap_or(0.0_f64);
                        state.dash = Rc::new((lengths, phase));
                    }
                }
                b"Font" => {
                    if let Some(items) = value.as_array()
                        && let Some(reference) = items.first()
                        && let Ok(font_object) = self.document.follow(reference)
                    {
                        let origin = if let Object::Ref(inner) = reference {
                            Some(*inner)
                        } else {
                            None
                        };
                        state.font = self.load_font(origin, &font_object);
                        state.font_size = items
                            .get(1)
                            .and_then(Object::as_number)
                            .unwrap_or(state.font_size);
                    }
                }
                _ => {}
            }
        }
    }

    fn box_glyph(&mut self) -> u32 {
        if let Some(id) = self.box_glyph {
            return id;
        }
        let id = self.next_glyph;
        self.next_glyph = self.next_glyph.saturating_add(1);
        let mut path = PathData::default();
        path.rect(0.0, BOX_DESCENT, 1.0, BOX_ASCENT - BOX_DESCENT);
        self.list.glyph_define(id, &path);
        self.box_glyph = Some(id);
        id
    }

    fn color_operator(
        &mut self,
        code: &[u8],
        operands: &[Operand<'_>],
        frame: &Frame,
        state: &mut GState,
    ) {
        let stroke = code.first().is_some_and(u8::is_ascii_uppercase);
        let lower: &[u8] = &code.to_ascii_lowercase();
        let mut scratch = Vec::new();
        let values: Vec<f64> = operands.iter().filter_map(Operand::as_number).collect();
        let (space, paint) = match lower {
            b"g" => (Rc::new(ColorSpace::Gray), None),
            b"rg" => (Rc::new(ColorSpace::Rgb), None),
            b"k" => (Rc::new(ColorSpace::Cmyk), None),
            b"cs" => {
                let space = operands
                    .last()
                    .and_then(Operand::as_name)
                    .and_then(|name| self.named_space(name, frame))
                    .unwrap_or_else(|| Rc::new(ColorSpace::Gray));
                let initial = space.initial();
                let rgb = space.rgb(&initial, &mut scratch).map(unit_to_u8);
                if stroke {
                    state.stroke_space = space;
                    state.stroke = Paint::solid(opaque(rgb));
                } else {
                    state.fill_space = space;
                    state.fill = Paint::solid(opaque(rgb));
                }
                return;
            }
            _ => {
                let space = if stroke {
                    Rc::clone(&state.stroke_space)
                } else {
                    Rc::clone(&state.fill_space)
                };
                let pattern = if let ColorSpace::Pattern(_) = &*space {
                    operands
                        .last()
                        .and_then(Operand::as_name)
                        .and_then(|name| self.pattern_paint(name, &values, &space, frame))
                } else {
                    None
                };
                (space, pattern)
            }
        };
        let paint_next = paint.unwrap_or_else(|| {
            Paint::solid(opaque(space.rgb(&values, &mut scratch).map(unit_to_u8)))
        });
        if stroke {
            if matches!(lower, b"g" | b"rg" | b"k") {
                state.stroke_space = space;
            }
            state.stroke = paint_next;
        } else {
            if matches!(lower, b"g" | b"rg" | b"k") {
                state.fill_space = space;
            }
            state.fill = paint_next;
        }
    }

    const fn count_operator(&mut self) -> bool {
        self.operators = self.operators.saturating_add(1);
        if self.operators > self.operator_limit || self.list.ops.len() > MAX_OPS_BYTES {
            self.truncated = true;
        }
        !self.truncated
    }

    fn define_glyph(&mut self, font: &RenderFont, gid: u16) -> Option<u32> {
        let key = (font.id, gid);
        if let Some(found) = self.glyph_ids.get(&key) {
            return *found;
        }
        let outline = if let Some(cached) = self.session.outlines.get(&key) {
            Rc::clone(cached)
        } else {
            let mut path = PathData::default();
            let built = font
                .font
                .program()
                .and_then(|program| program.outline(gid, &mut path, &mut self.outline_work));
            let exhausted = built.is_none() && self.outline_work == 0;
            if built.is_none() {
                path.clear();
            }
            self.truncated |= exhausted;
            let shared = Rc::new(path);
            if !exhausted && self.session.outlines.len() < MAX_CACHED_OUTLINES {
                drop(self.session.outlines.insert(key, Rc::clone(&shared)));
            }
            shared
        };
        let id = if outline.is_empty() {
            None
        } else {
            let id = self.next_glyph;
            self.next_glyph = self.next_glyph.saturating_add(1);
            self.list.glyph_define(id, &outline);
            Some(id)
        };
        let _: Option<Option<u32>> = self.glyph_ids.insert(key, id);
        id
    }

    fn draw_image(
        &mut self,
        reference: Option<ObjRef>,
        dict: &Dict,
        source: &ImageData<'_>,
        frame: &Frame,
        state: &GState,
    ) {
        let fill = opaque(rgb_of(state.fill.color));
        let interpolate = dict_flag(dict, b"Interpolate");
        let [a, b, c, d, _, _] = state.ctm;
        let device = (
            (a * a + b * b).sqrt() * self.scale,
            (c * c + d * d).sqrt() * self.scale,
        );
        let bucket = |extent: f64| {
            f64_to_usize(extent.max(1.0))
                .next_power_of_two()
                .trailing_zeros()
        };
        let key = reference.map(|inner| {
            (
                inner,
                if dict_flag(dict, b"ImageMask") {
                    fill
                } else {
                    [0; 4]
                },
                (bucket(device.0) << 8_u32) | bucket(device.1),
            )
        });
        self.sync_transform(&state.ctm);
        let alpha = unit_to_u8(state.fill_alpha);
        if let Some(found) = key.and_then(|inner| self.images.get(&inner).copied()) {
            self.list.image(&found, alpha);
            return;
        }
        if let Some(inner) = key
            && let Some(cached) = self.session.images.get(&inner).map(Rc::clone)
        {
            let image = self.add_image(&cached, interpolate);
            let _: Option<ImageRef> = self.images.insert(inner, image);
            self.list.image(&image, alpha);
            return;
        }
        let owned;
        let data = match source {
            ImageData::Inline(bytes) => *bytes,
            ImageData::Stream(stream) => {
                owned = self.document.stream_data(stream).unwrap_or_default();
                owned.as_slice()
            }
        };
        let space = self.image_space(dict, frame);
        let (filter, parms) = image_filter(self.document, dict);
        let context = ImageContext {
            device,
            fill,
            max_bytes: self.limits.max_decoded_stream_bytes,
            resolver: self.document,
            space: space.as_deref(),
        };
        let input = ImageInput {
            data,
            dict,
            filter: filter.as_deref(),
            parms: parms.as_ref(),
        };
        let decoded = if self.list.blob_bytes > MAX_BLOB_BYTES {
            None
        } else {
            decode_image(&context, &input)
        };
        let Some(found) = decoded else {
            let mut path = PathData::default();
            path.rect(0.0, 0.0, 1.0, 1.0);
            self.list.path(&path);
            self.list.color(false, PLACEHOLDER);
            self.emitted.fill = Some(PLACEHOLDER);
            self.emitted.fill_gradient = None;
            self.list.op_u8(OP_FILL, RULE_NONZERO);
            return;
        };
        let shared = Rc::new(found);
        let image = self.add_image(&shared, interpolate);
        if let Some(inner) = key {
            let _: Option<ImageRef> = self.images.insert(inner, image);
            let size = decoded_bytes(&shared);
            if self.session.image_bytes.saturating_add(size) <= MAX_CACHED_IMAGE_BYTES {
                self.session.image_bytes = self.session.image_bytes.saturating_add(size);
                drop(self.session.images.insert(inner, shared));
            }
        }
        self.list.image(&image, alpha);
    }

    fn form(
        &mut self,
        stream: &Stream,
        reference: Option<ObjRef>,
        state: &GState,
        frame: &Frame,
        depth: usize,
    ) -> Outcome<()> {
        if depth >= MAX_FORM_DEPTH || !self.count_operator() {
            return Ok(());
        }
        if let Some(inner) = reference {
            if self.active.contains(&inner) {
                return Ok(());
            }
            self.active.push(inner);
        }
        let data = self.stream_bytes(stream, reference);
        let matrix = matrix_of(stream.dict.get(b"Matrix")).unwrap_or(IDENTITY);
        let mut inner_state = state.clone();
        inner_state.ctm = multiply(&matrix, &state.ctm);
        self.save();
        if let Some(bbox) = self.rect(stream.dict.get(b"BBox")) {
            self.sync_transform(&inner_state.ctm);
            let mut path = PathData::default();
            path.rect(bbox[0], bbox[1], bbox[2] - bbox[0], bbox[3] - bbox[1]);
            self.list.path(&path);
            self.list.op_u8(OP_CLIP, RULE_NONZERO);
        }
        let resources = stream
            .dict
            .get(b"Resources")
            .and_then(|value| self.document.follow(value).ok())
            .filter(|value| value.as_dict().is_some())
            .unwrap_or_else(|| Rc::clone(&frame.resources));
        let inner_frame = Frame {
            base: inner_state.ctm,
            resources,
        };
        let outcome = self.run(
            &data,
            &inner_frame,
            &mut inner_state,
            depth.saturating_add(1),
        );
        self.restore();
        if reference.is_some() {
            let _: Option<ObjRef> = self.active.pop();
        }
        outcome
    }

    const fn glyph_modes(state: &GState) -> u8 {
        match state.render_mode {
            0 => GLYPH_FILL,
            1 => GLYPH_STROKE,
            2 => GLYPH_FILL | GLYPH_STROKE,
            4 => GLYPH_FILL | GLYPH_CLIP,
            5 => GLYPH_STROKE | GLYPH_CLIP,
            6 => GLYPH_FILL | GLYPH_STROKE | GLYPH_CLIP,
            7 => GLYPH_CLIP,
            _ => 0,
        }
    }

    fn hidden(&self, entry: &Object) -> bool {
        !self.content.visible(self.document, entry, 0)
    }

    fn image_space(&mut self, dict: &Dict, frame: &Frame) -> Option<Rc<ColorSpace>> {
        let entry = dict.get(b"ColorSpace")?;
        if let Object::Name(name) = entry {
            return self.named_space(name, frame);
        }
        if let Object::Ref(reference) = entry
            && let Some(found) = self.session.spaces.get(reference)
        {
            return Some(Rc::clone(found));
        }
        let named = self.named_color_spaces(frame);
        let named_dict = named.as_deref().and_then(Object::as_dict);
        if let Object::Ref(reference) = entry {
            return self.ref_space(*reference, named_dict);
        }
        ColorSpace::parse(self.document, entry, named_dict).map(Rc::new)
    }

    fn inline_image(&mut self, dict: Dict, data: &[u8], frame: &Frame, state: &GState) {
        let normalized = normalized_inline(dict);
        let mut filters_only = normalized.clone();
        let (filter, _) = image_filter(self.document, &normalized);
        if filter.is_some()
            && let Some(Object::Array(items)) = normalized.get(b"Filter")
        {
            let trimmed: Vec<Object> = items
                .get(..items.len().saturating_sub(1))
                .unwrap_or_default()
                .to_vec();
            filters_only.insert(b"Filter", Object::Array(trimmed));
        } else if filter.is_some() {
            filters_only.insert(b"Filter", Object::Null);
        }
        let decoded = if filters_only
            .get(b"Filter")
            .is_some_and(|value| !matches!(value, Object::Null))
        {
            filters::decode_stream(
                &filters_only,
                data,
                self.limits.max_decoded_stream_bytes,
                None,
            )
            .ok()
        } else {
            Some(data.to_vec())
        };
        let bytes = decoded.unwrap_or_default();
        self.draw_image(None, &normalized, &ImageData::Inline(&bytes), frame, state);
    }

    fn load_font(&mut self, origin: Option<ObjRef>, object: &Object) -> Option<Rc<RenderFont>> {
        if let Some(reference) = origin
            && let Some(found) = self.session.fonts.get(&reference)
        {
            return Some(Rc::clone(found));
        }
        let dict = object.as_dict()?;
        let font = Font::load_for_render(self.document, dict, self.limits).ok()?;
        let subtype = dict.get(b"Subtype").and_then(Object::as_name);
        let face = if subtype == Some(b"Type3") {
            Face::Type3(Box::new(Type3 {
                matrix: matrix_of(dict.get(b"FontMatrix"))
                    .unwrap_or([0.001_f64, 0.0_f64, 0.0_f64, 0.001_f64, 0.0_f64, 0.0_f64]),
                procs: dict
                    .get(b"CharProcs")
                    .and_then(|value| self.document.follow(value).ok()),
                resources: dict
                    .get(b"Resources")
                    .and_then(|value| self.document.follow(value).ok()),
            }))
        } else if font.program().is_some() {
            Face::Outline
        } else {
            let descendant = dict
                .get(b"DescendantFonts")
                .and_then(|value| self.document.follow(value).ok())
                .and_then(|value| {
                    let items = value.as_array()?;
                    items.first().cloned()
                })
                .and_then(|first| self.document.follow(&first).ok());
            let source = descendant
                .as_deref()
                .and_then(Object::as_dict)
                .unwrap_or(dict);
            let mut flags = fallback_flags(source) | fallback_flags(dict);
            if let Some(descriptor) = source
                .get(b"FontDescriptor")
                .and_then(|value| self.document.follow(value).ok())
                && let Some(descriptor_dict) = descriptor.as_dict()
            {
                let bits = descriptor_dict
                    .get(b"Flags")
                    .and_then(Object::as_integer)
                    .unwrap_or(0);
                if bits & 2 != 0 && flags & FALLBACK_MONO == 0 {
                    flags |= FALLBACK_SERIF;
                }
                if bits & 1 != 0 {
                    flags = (flags & !FALLBACK_SERIF) | FALLBACK_MONO;
                }
                if bits & (1 << 18_i32) != 0 {
                    flags |= FALLBACK_BOLD;
                }
                if bits & (1 << 6_i32) != 0 {
                    flags |= FALLBACK_ITALIC;
                }
            }
            Face::Fallback(u32::from(flags))
        };
        let render_font = Rc::new(RenderFont {
            face,
            font,
            id: self.session.next_font,
        });
        self.session.next_font = self.session.next_font.saturating_add(1);
        if let Some(reference) = origin
            && self.session.fonts.len() < MAX_CACHED_FONTS
        {
            drop(
                self.session
                    .fonts
                    .insert(reference, Rc::clone(&render_font)),
            );
        }
        Some(render_font)
    }

    fn marked_hidden(&self, operands: &[Operand<'_>], frame: &Frame) -> bool {
        let start = operands.len().saturating_sub(2);
        let (Some(tag), Some(properties)) =
            (operands.get(start), operands.get(start.saturating_add(1)))
        else {
            return false;
        };
        if tag.as_name() != Some(b"OC") {
            return false;
        }
        match properties {
            Operand::Name(name) => self
                .resource_entry(frame, b"Properties", name)
                .is_some_and(|entry| self.hidden(&entry)),
            Operand::Object(object) => self.hidden(object),
            Operand::Array(_)
            | Operand::Bool(_)
            | Operand::Hex(_)
            | Operand::Integer(_)
            | Operand::Literal(_)
            | Operand::Null
            | Operand::Real(_) => false,
        }
    }

    fn named_color_spaces(&self, frame: &Frame) -> Option<Rc<Object>> {
        let entry = frame.resources.as_dict()?.get(b"ColorSpace")?;
        self.document.follow(entry).ok()
    }

    fn named_space(&mut self, name: &[u8], frame: &Frame) -> Option<Rc<ColorSpace>> {
        if let Some(device) = ColorSpace::parse(self.document, &Object::Name(name.to_vec()), None) {
            return Some(Rc::new(device));
        }
        let key = Rc::as_ptr(&frame.resources).addr();
        if let Some((_, spaces)) = self.named_spaces.get(&key)
            && let Some(found) = spaces.get(name)
        {
            return Some(Rc::clone(found));
        }
        let named = self.named_color_spaces(frame)?;
        let dict = named.as_dict()?;
        let entry = dict.get(name)?;
        let space = if let Object::Ref(reference) = entry {
            self.ref_space(*reference, Some(dict))?
        } else {
            Rc::new(ColorSpace::parse(self.document, entry, Some(dict))?)
        };
        drop(
            self.named_spaces
                .entry(key)
                .or_insert_with(|| (Rc::clone(&frame.resources), HashMap::new()))
                .1
                .insert(name.to_vec(), Rc::clone(&space)),
        );
        Some(space)
    }

    fn paint_path(
        &mut self,
        path: &mut PathData,
        state: &GState,
        fill: Option<u8>,
        stroke: bool,
        clip: Option<u8>,
        visible: bool,
    ) {
        if path.is_empty() {
            return;
        }
        let fill_visible = visible && fill.is_some() && !state.fill_space.is_invisible();
        let stroke_visible = visible && stroke && !state.stroke_space.is_invisible();
        if fill_visible || stroke_visible || clip.is_some() {
            self.sync_transform(&state.ctm);
            self.list.path(path);
            if let Some(rule) = fill
                && fill_visible
            {
                self.sync_paint(state, false);
                self.list.op_u8(OP_FILL, rule);
            }
            if stroke_visible {
                self.sync_paint(state, true);
                self.sync_line(state);
                self.list.op(OP_STROKE);
            }
            if let Some(rule) = clip {
                self.list.op_u8(OP_CLIP, rule);
            }
        }
        path.clear();
    }

    fn path_operator(
        code: &[u8],
        operands: &[Operand<'_>],
        path: &mut PathData,
        current: &mut (f64, f64),
    ) -> bool {
        match code {
            b"m" => {
                if let Some([x, y]) = tail_numbers::<2, _>(operands) {
                    path.move_to(x, y);
                    *current = (x, y);
                }
            }
            b"l" => {
                if let Some([x, y]) = tail_numbers::<2, _>(operands) {
                    if path.is_empty() {
                        path.move_to(current.0, current.1);
                    }
                    path.line(x, y);
                    *current = (x, y);
                }
            }
            b"c" => {
                if let Some(points) = tail_numbers::<6, _>(operands) {
                    if path.is_empty() {
                        path.move_to(current.0, current.1);
                    }
                    path.cubic(points);
                    *current = (points[4], points[5]);
                }
            }
            b"v" => {
                if let Some([x2, y2, x3, y3]) = tail_numbers::<4, _>(operands) {
                    if path.is_empty() {
                        path.move_to(current.0, current.1);
                    }
                    path.cubic([current.0, current.1, x2, y2, x3, y3]);
                    *current = (x3, y3);
                }
            }
            b"y" => {
                if let Some([x1, y1, x3, y3]) = tail_numbers::<4, _>(operands) {
                    if path.is_empty() {
                        path.move_to(current.0, current.1);
                    }
                    path.cubic([x1, y1, x3, y3, x3, y3]);
                    *current = (x3, y3);
                }
            }
            b"h" => path.close(),
            b"re" => {
                if let Some([x, y, width, height]) = tail_numbers::<4, _>(operands) {
                    path.rect(x, y, width, height);
                    *current = (x, y);
                }
            }
            _ => return false,
        }
        true
    }

    fn pattern_paint(
        &self,
        name: &[u8],
        values: &[f64],
        space: &ColorSpace,
        frame: &Frame,
    ) -> Option<Paint> {
        let pattern = self.resource(frame, b"Pattern", name)?;
        let dict = pattern.as_dict()?;
        let kind = dict.get(b"PatternType").and_then(Object::as_integer)?;
        let named = self.named_color_spaces(frame);
        let named_dict = named.as_deref().and_then(Object::as_dict);
        let matrix = multiply(
            &matrix_of(dict.get(b"Matrix")).unwrap_or(IDENTITY),
            &frame.base,
        );
        if kind == 2 {
            return match parse_shading(self.document, dict.get(b"Shading")?, named_dict, 1.0)? {
                Shading::Flat(color) => Some(Paint::solid(color)),
                Shading::Gradient(mut gradient) => {
                    gradient.matrix = matrix;
                    Some(Paint {
                        color: gradient.middle_color(),
                        gradient: Some(Rc::new(gradient)),
                    })
                }
            };
        }
        let paint_type = dict
            .get(b"PaintType")
            .and_then(Object::as_integer)
            .unwrap_or(1);
        let mut scratch = Vec::new();
        if paint_type == 2
            && let ColorSpace::Pattern(Some(base)) = space
        {
            return Some(Paint::solid(opaque(
                base.rgb(values, &mut scratch).map(unit_to_u8),
            )));
        }
        let stream = pattern.as_stream()?;
        let data = self.document.stream_data(stream).ok()?;
        Some(Paint::solid(opaque(tile_color(&data))))
    }

    fn rect(&self, object: Option<&Object>) -> Option<[f64; 4]> {
        let resolved = self.document.follow(object?).ok()?;
        let values = object_numbers(Some(&resolved));
        let [x0, y0, x1, y1]: [f64; 4] = values.get(..4)?.try_into().ok()?;
        Some([x0.min(x1), y0.min(y1), x0.max(x1), y0.max(y1)])
    }

    fn ref_space(&mut self, reference: ObjRef, named: Option<&Dict>) -> Option<Rc<ColorSpace>> {
        if let Some(found) = self.session.spaces.get(&reference) {
            return Some(Rc::clone(found));
        }
        let space = Rc::new(ColorSpace::parse(
            self.document,
            &Object::Ref(reference),
            named,
        )?);
        if self.session.spaces.len() < MAX_CACHED_SPACES {
            drop(self.session.spaces.insert(reference, Rc::clone(&space)));
        }
        Some(space)
    }

    fn resource(&self, frame: &Frame, category: &[u8], name: &[u8]) -> Option<Rc<Object>> {
        self.document
            .follow(&self.resource_entry(frame, category, name)?)
            .ok()
    }

    fn resource_entry(&self, frame: &Frame, category: &[u8], name: &[u8]) -> Option<Object> {
        let entries = self.view(frame.resources.as_dict()?.get(category)?)?;
        entries.as_dict()?.get(name).cloned()
    }

    fn restore(&mut self) {
        self.list.op(OP_RESTORE);
        self.emitted = self.emitted_stack.pop().unwrap_or_default();
    }

    #[expect(
        clippy::too_many_lines,
        clippy::cognitive_complexity,
        reason = "the content-stream operator dispatch is one flat match over the PDF operator set"
    )]
    fn run(&mut self, data: &[u8], frame: &Frame, state: &mut GState, depth: usize) -> Outcome<()> {
        let Some(remaining) = self.budget.checked_sub(data.len()) else {
            self.truncated = true;
            return Ok(());
        };
        self.budget = remaining;
        let mut stack: Vec<GState> = Vec::new();
        let mut overflow = 0_usize;
        let mut operands: Vec<Operand<'_>> = Vec::new();
        let mut path = PathData::default();
        let mut current = (0.0_f64, 0.0_f64);
        let mut clip: Option<u8> = None;
        let mut marked = Marked::default();
        let mut text = TextState {
            clip: false,
            line: IDENTITY,
            matrix: IDENTITY,
        };
        let mut scratch: Vec<u8> = Vec::new();
        let mut lexer = ContentLexer::new(data);
        while let Some(token) = lexer.next() {
            let code = match token {
                Err(_) => break,
                Ok(ContentToken::Operand(operand)) => {
                    if operands.len() >= MAX_OPERANDS {
                        while let Some(stale) = operands.pop() {
                            lexer.recycle(stale);
                        }
                    }
                    operands.push(operand);
                    continue;
                }
                Ok(ContentToken::Operator(name)) => name,
            };
            if !self.count_operator() {
                break;
            }
            let visible = marked.hidden == 0;
            match code {
                b"q" => {
                    if stack.len() >= MAX_STATE_STACK {
                        overflow = overflow.saturating_add(1);
                    } else {
                        stack.push(state.clone());
                        self.save();
                    }
                }
                b"Q" => {
                    if overflow > 0 {
                        overflow = overflow.saturating_sub(1);
                    } else if let Some(previous) = stack.pop() {
                        *state = previous;
                        self.restore();
                    }
                }
                b"cm" => {
                    if let Some(matrix) = tail_numbers::<6, _>(&operands) {
                        state.ctm = multiply(&matrix, &state.ctm);
                    }
                }
                b"w" => {
                    if let Some([width]) = tail_numbers::<1, _>(&operands) {
                        state.line_width = width;
                    }
                }
                b"J" => {
                    if let Some([cap]) = tail_numbers::<1, _>(&operands) {
                        state.cap = u8::try_from(f64_to_i64(cap).clamp(0, 2)).unwrap_or(0);
                    }
                }
                b"j" => {
                    if let Some([join]) = tail_numbers::<1, _>(&operands) {
                        state.join = u8::try_from(f64_to_i64(join).clamp(0, 2)).unwrap_or(0);
                    }
                }
                b"M" => {
                    if let Some([miter]) = tail_numbers::<1, _>(&operands) {
                        state.miter = miter;
                    }
                }
                b"d" => {
                    let phase = operands
                        .last()
                        .and_then(Operand::as_number)
                        .unwrap_or(0.0_f64);
                    let lengths = operands
                        .iter()
                        .find_map(|operand| {
                            if let Operand::Array(items) = operand {
                                Some(
                                    items
                                        .iter()
                                        .filter_map(Operand::as_number)
                                        .collect::<Vec<f64>>(),
                                )
                            } else {
                                None
                            }
                        })
                        .unwrap_or_default();
                    state.dash = Rc::new((lengths, phase));
                }
                b"gs" => {
                    if let Some(name) = operands.last().and_then(Operand::as_name) {
                        self.apply_ext_gstate(name, frame, state);
                    }
                }
                b"g" | b"G" | b"rg" | b"RG" | b"k" | b"K" | b"cs" | b"CS" | b"sc" | b"SC"
                | b"scn" | b"SCN" => {
                    self.color_operator(code, &operands, frame, state);
                }
                b"S" | b"s" | b"f" | b"F" | b"f*" | b"B" | b"B*" | b"b" | b"b*" | b"n" => {
                    if matches!(code, b"s" | b"b" | b"b*") {
                        path.close();
                    }
                    let fill = match code {
                        b"f" | b"F" | b"B" | b"b" => Some(RULE_NONZERO),
                        b"f*" | b"B*" | b"b*" => Some(RULE_EVENODD),
                        _ => None,
                    };
                    let stroke = matches!(code, b"S" | b"s" | b"B" | b"B*" | b"b" | b"b*");
                    let rule = clip.take();
                    self.paint_path(&mut path, state, fill, stroke, rule, visible);
                    path.clear();
                }
                b"BMC" => marked.push(false),
                b"BDC" => {
                    let hide = self.marked_hidden(&operands, frame);
                    marked.push(hide);
                }
                b"EMC" => marked.pop(),
                b"W" => clip = Some(RULE_NONZERO),
                b"W*" => clip = Some(RULE_EVENODD),
                b"BT" => {
                    text.matrix = IDENTITY;
                    text.line = IDENTITY;
                    text.clip = false;
                }
                b"ET" => {
                    if text.clip {
                        self.list.op(OP_TEXT_CLIP);
                        text.clip = false;
                    }
                }
                b"Tc" => {
                    if let Some([value]) = tail_numbers::<1, _>(&operands) {
                        state.char_space = value;
                    }
                }
                b"Tw" => {
                    if let Some([value]) = tail_numbers::<1, _>(&operands) {
                        state.word_space = value;
                    }
                }
                b"Tz" => {
                    if let Some([value]) = tail_numbers::<1, _>(&operands) {
                        state.scale = value / 100.0_f64;
                    }
                }
                b"TL" => {
                    if let Some([value]) = tail_numbers::<1, _>(&operands) {
                        state.leading = value;
                    }
                }
                b"Ts" => {
                    if let Some([value]) = tail_numbers::<1, _>(&operands) {
                        state.rise = value;
                    }
                }
                b"Tr" => {
                    if let Some([value]) = tail_numbers::<1, _>(&operands) {
                        state.render_mode =
                            u8::try_from(f64_to_i64(value).clamp(0, 7)).unwrap_or(0);
                    }
                }
                b"Tf" => {
                    let name = operands
                        .len()
                        .checked_sub(2)
                        .and_then(|index| operands.get(index))
                        .and_then(Operand::as_name);
                    if let Some(size) = operands.last().and_then(Operand::as_number) {
                        state.font_size = size;
                    }
                    if let Some(font_name) = name {
                        let entry = frame
                            .resources
                            .as_dict()
                            .and_then(|dict| dict.get(b"Font"))
                            .and_then(|fonts| self.document.follow(fonts).ok())
                            .and_then(|fonts| {
                                let dict = fonts.as_dict()?;
                                dict.get(font_name).cloned()
                            });
                        state.font = entry.and_then(|value| {
                            let origin = if let Object::Ref(inner) = value {
                                Some(inner)
                            } else {
                                None
                            };
                            let resolved = self.document.follow(&value).ok()?;
                            self.load_font(origin, &resolved)
                        });
                    }
                }
                b"Td" => {
                    if let Some([tx, ty]) = tail_numbers::<2, _>(&operands) {
                        text.line = translate(tx, ty, &text.line);
                        text.matrix = text.line;
                    }
                }
                b"TD" => {
                    if let Some([tx, ty]) = tail_numbers::<2, _>(&operands) {
                        state.leading = -ty;
                        text.line = translate(tx, ty, &text.line);
                        text.matrix = text.line;
                    }
                }
                b"Tm" => {
                    if let Some(matrix) = tail_numbers::<6, _>(&operands) {
                        text.line = matrix;
                        text.matrix = matrix;
                    }
                }
                b"T*" => {
                    text.line = translate(0.0, -state.leading, &text.line);
                    text.matrix = text.line;
                }
                b"Tj" => {
                    if let Some(bytes) = operands
                        .last()
                        .and_then(|operand| operand.string(&mut scratch))
                    {
                        self.show(bytes, frame, state, &mut text, depth, visible)?;
                    }
                }
                b"'" | b"\"" => {
                    if code == b"\""
                        && let Some([word, character, _]) =
                            operands.len().checked_sub(3).and_then(|start| {
                                let word = operands.get(start)?.as_number()?;
                                let character =
                                    operands.get(start.saturating_add(1))?.as_number()?;
                                Some([word, character, 0.0_f64])
                            })
                    {
                        state.word_space = word;
                        state.char_space = character;
                    }
                    text.line = translate(0.0, -state.leading, &text.line);
                    text.matrix = text.line;
                    if let Some(bytes) = operands
                        .last()
                        .and_then(|operand| operand.string(&mut scratch))
                    {
                        self.show(bytes, frame, state, &mut text, depth, visible)?;
                    }
                }
                b"TJ" => {
                    if let Some(Operand::Array(items)) = operands.last() {
                        for item in items {
                            if let Some(adjust) = item.as_number() {
                                let vertical = state
                                    .font
                                    .as_ref()
                                    .is_some_and(|font| font.font.is_vertical());
                                let amount = -adjust / 1_000.0_f64 * state.font_size;
                                text.matrix = if vertical {
                                    translate(0.0, amount, &text.matrix)
                                } else {
                                    translate(amount * state.scale, 0.0, &text.matrix)
                                };
                            } else if let Some(bytes) = item.string(&mut scratch) {
                                self.show(bytes, frame, state, &mut text, depth, visible)?;
                            }
                        }
                    }
                }
                b"Do" => {
                    if visible && let Some(name) = operands.last().and_then(Operand::as_name) {
                        self.xobject(name, frame, state, depth)?;
                    }
                }
                b"sh" => {
                    if visible && let Some(name) = operands.last().and_then(Operand::as_name) {
                        self.shade(name, frame, state);
                    }
                }
                b"EI" => {
                    if let Some((dict, image_data)) = lexer.take_inline_image()
                        && visible
                    {
                        self.inline_image(dict, image_data, frame, state);
                    }
                }
                _ => {
                    let _: bool = Self::path_operator(code, &operands, &mut path, &mut current);
                }
            }
            while let Some(used) = operands.pop() {
                lexer.recycle(used);
            }
        }
        if text.clip {
            self.list.op(OP_TEXT_CLIP);
        }
        for _ in 0..stack.len() {
            self.restore();
        }
        Ok(())
    }

    fn save(&mut self) {
        self.list.op(OP_SAVE);
        self.emitted_stack.push(self.emitted.clone());
    }

    fn shade(&mut self, name: &[u8], frame: &Frame, state: &GState) {
        let Some(object) = self.resource(frame, b"Shading", name) else {
            return;
        };
        let named = self.named_color_spaces(frame);
        let Some(shading) = parse_shading(
            self.document,
            &object,
            named.as_deref().and_then(Object::as_dict),
            state.fill_alpha,
        ) else {
            return;
        };
        self.sync_transform(&state.ctm);
        let flat_stops;
        let gradient = match &shading {
            Shading::Gradient(inner) => inner.as_gradient(),
            Shading::Flat(color) => {
                flat_stops = [(0.0_f64, *color), (1.0_f64, *color)];
                Gradient {
                    coords: [0.0_f64, 0.0_f64, 1.0_f64, 0.0_f64, 0.0_f64, 0.0_f64],
                    extend: (true, true),
                    radial: false,
                    stops: &flat_stops,
                }
            }
        };
        self.list.gradient(OP_SHADE, &gradient, None);
    }

    #[expect(
        clippy::too_many_lines,
        reason = "glyph placement walks the PDF text-showing algorithm step by step"
    )]
    fn show(
        &mut self,
        bytes: &[u8],
        frame: &Frame,
        state: &GState,
        text: &mut TextState,
        depth: usize,
        visible: bool,
    ) -> Outcome<()> {
        let Some(font) = state.font.clone() else {
            return Ok(());
        };
        let mut glyphs = mem::take(&mut self.glyphs);
        let mut decoded = mem::take(&mut self.decoded);
        glyphs.clear();
        decoded.clear();
        font.font.decode(bytes, &mut glyphs, &mut decoded);
        let size = state.font_size;
        let horizontal_scale = state.scale;
        let vertical = font.font.is_vertical();
        let base = [
            size * horizontal_scale,
            0.0_f64,
            0.0_f64,
            size,
            0.0_f64,
            state.rise,
        ];
        let modes = if visible { Self::glyph_modes(state) } else { 0 };
        if modes & GLYPH_CLIP != 0 {
            text.clip = true;
        }
        let start = text.matrix;
        let mut total = 0.0_f64;
        if modes != 0 {
            self.sync_transform(&state.ctm);
        }
        if modes != 0 && !matches!(font.face, Face::Fallback(_)) {
            if modes & GLYPH_FILL != 0 {
                self.sync_paint(state, false);
            }
            if modes & GLYPH_STROKE != 0 {
                self.sync_paint(state, true);
                self.sync_line(state);
            }
        }
        for glyph in &glyphs {
            if self.truncated {
                break;
            }
            let metrics = vertical.then(|| font.font.vertical_metrics(glyph.code));
            let origin = metrics.map_or(text.matrix, |inner| {
                translate(-inner.origin_x * size, -inner.origin_y * size, &text.matrix)
            });
            let placement = multiply(&base, &origin);
            if modes != 0 && size != 0.0_f64 {
                match &font.face {
                    Face::Outline => {
                        if let Some(gid) = font.font.render_gid(glyph.code)
                            && let Some(id) = self.define_glyph(&font, gid)
                            && let Some(program) = font.font.program()
                        {
                            let matrix = multiply(&program.font_matrix(gid), &placement);
                            self.list.glyph(modes, id, &matrix);
                        }
                    }
                    Face::Type3(type3) => {
                        if depth < MAX_FORM_DEPTH
                            && let Some(name) = font.font.render_name(glyph.code)
                            && let Some(procs) = type3.procs.as_deref().and_then(Object::as_dict)
                            && let Some(entry) = procs.get(name)
                            && let Ok(resolved) = self.document.follow(entry)
                            && let Some(stream) = resolved.as_stream()
                        {
                            let mut glyph_state = state.clone();
                            glyph_state.ctm =
                                multiply(&multiply(&type3.matrix, &placement), &state.ctm);
                            let glyph_frame = Frame {
                                base: frame.base,
                                resources: type3
                                    .resources
                                    .clone()
                                    .unwrap_or_else(|| Rc::clone(&frame.resources)),
                            };
                            let reference = if let Object::Ref(inner) = entry {
                                Some(*inner)
                            } else {
                                None
                            };
                            self.form(
                                stream,
                                reference,
                                &glyph_state,
                                &glyph_frame,
                                depth.saturating_add(1),
                            )?;
                        }
                    }
                    Face::Fallback(_) => {
                        if modes & GLYPH_CLIP != 0 && glyph.advance > 0.0_f64 {
                            let id = self.box_glyph();
                            let matrix = multiply(
                                &[glyph.advance, 0.0_f64, 0.0_f64, 1.0_f64, 0.0_f64, 0.0_f64],
                                &placement,
                            );
                            self.list.glyph(GLYPH_CLIP, id, &matrix);
                        }
                    }
                }
            }
            let word = if glyph.is_word_space {
                state.word_space
            } else {
                0.0_f64
            };
            if let Some(inner) = metrics {
                let advance = -(inner.advance * size + state.char_space + word);
                text.matrix = translate(0.0, advance, &text.matrix);
            } else {
                let advance = (glyph.advance * size + state.char_space + word) * horizontal_scale;
                total += advance;
                text.matrix = translate(advance, 0.0, &text.matrix);
            }
        }
        if let Face::Fallback(flags) = font.face
            && modes & (GLYPH_FILL | GLYPH_STROKE) != 0
            && size != 0.0_f64
            && !decoded.trim().is_empty()
            && !vertical
        {
            self.sync_transform(&state.ctm);
            let mut text_flags = u8::try_from(flags).unwrap_or(0);
            if modes & GLYPH_FILL != 0 {
                self.sync_paint(state, false);
                text_flags |= FALLBACK_FILL;
            }
            if modes & GLYPH_STROKE != 0 {
                self.sync_paint(state, true);
                self.sync_line(state);
                text_flags |= FALLBACK_STROKE;
            }
            let matrix = multiply(&base, &start);
            let width = total / (size * horizontal_scale).abs().max(f64::EPSILON);
            self.list.text(text_flags, &matrix, width, &decoded);
        }
        self.glyphs = glyphs;
        self.decoded = decoded;
        Ok(())
    }

    fn stream_bytes(&mut self, stream: &Stream, reference: Option<ObjRef>) -> Rc<[u8]> {
        if let Some(inner) = reference
            && let Some(found) = self.session.streams.get(&inner)
        {
            return Rc::clone(found);
        }
        let data: Rc<[u8]> = Rc::from(self.document.stream_data(stream).unwrap_or_default());
        if let Some(inner) = reference
            && self.session.stream_bytes.saturating_add(data.len()) <= MAX_CACHED_STREAM_BYTES
        {
            self.session.stream_bytes = self.session.stream_bytes.saturating_add(data.len());
            drop(self.session.streams.insert(inner, Rc::clone(&data)));
        }
        data
    }

    fn sync_line(&mut self, state: &GState) {
        if self.emitted.line_width != Some(state.line_width) {
            self.list.op_f32(OP_LINE_WIDTH, state.line_width);
            self.emitted.line_width = Some(state.line_width);
        }
        if self.emitted.cap != Some(state.cap) {
            self.list.op_u8(OP_LINE_CAP, state.cap);
            self.emitted.cap = Some(state.cap);
        }
        if self.emitted.join != Some(state.join) {
            self.list.op_u8(OP_LINE_JOIN, state.join);
            self.emitted.join = Some(state.join);
        }
        if self.emitted.miter != Some(state.miter) {
            self.list.op_f32(OP_MITER, state.miter);
            self.emitted.miter = Some(state.miter);
        }
        let same_dash = self
            .emitted
            .dash
            .as_ref()
            .is_some_and(|dash| Rc::ptr_eq(dash, &state.dash) || **dash == *state.dash);
        if !same_dash {
            self.list.dash(&state.dash.0, state.dash.1);
            self.emitted.dash = Some(Rc::clone(&state.dash));
        }
        if self.emitted.blend != Some(state.blend) {
            self.list.op_u8(OP_BLEND, state.blend);
            self.emitted.blend = Some(state.blend);
        }
    }

    fn sync_paint(&mut self, state: &GState, stroke: bool) {
        if self.emitted.blend != Some(state.blend) {
            self.list.op_u8(OP_BLEND, state.blend);
            self.emitted.blend = Some(state.blend);
        }
        let (paint, alpha) = if stroke {
            (&state.stroke, state.stroke_alpha)
        } else {
            (&state.fill, state.fill_alpha)
        };
        if let Some(gradient) = &paint.gradient {
            let slot = if stroke {
                &mut self.emitted.stroke_gradient
            } else {
                &mut self.emitted.fill_gradient
            };
            if !slot
                .as_ref()
                .is_some_and(|current| Rc::ptr_eq(current, gradient))
            {
                *slot = Some(Rc::clone(gradient));
                let code = if stroke {
                    OP_STROKE_GRADIENT
                } else {
                    OP_FILL_GRADIENT
                };
                self.list
                    .gradient(code, &gradient.as_gradient(), Some(&gradient.matrix));
            }
            if stroke {
                self.emitted.stroke = None;
            } else {
                self.emitted.fill = None;
            }
            return;
        }
        let [red, green, blue, _] = paint.color;
        let rgba = [red, green, blue, unit_to_u8(alpha)];
        let slot = if stroke {
            &mut self.emitted.stroke
        } else {
            &mut self.emitted.fill
        };
        if *slot != Some(rgba) {
            *slot = Some(rgba);
            self.list.color(stroke, rgba);
        }
        if stroke {
            self.emitted.stroke_gradient = None;
        } else {
            self.emitted.fill_gradient = None;
        }
    }

    fn sync_transform(&mut self, ctm: &Matrix) {
        if self.emitted.transform.as_ref() != Some(ctm) {
            self.list.transform(ctm);
            self.emitted.transform = Some(*ctm);
        }
    }

    fn view<'object>(&self, object: &'object Object) -> Option<View<'object>> {
        if matches!(object, Object::Ref(_)) {
            self.document.follow(object).ok().map(View::Shared)
        } else {
            Some(View::Borrowed(object))
        }
    }

    fn xobject(&mut self, name: &[u8], frame: &Frame, state: &GState, depth: usize) -> Outcome<()> {
        let Some(entry) = self.resource_entry(frame, b"XObject", name) else {
            return Ok(());
        };
        let reference = if let Object::Ref(inner) = entry {
            Some(inner)
        } else {
            None
        };
        let Ok(object) = self.document.follow(&entry) else {
            return Ok(());
        };
        let Some(stream) = object.as_stream() else {
            return Ok(());
        };
        if stream
            .dict
            .get(b"OC")
            .is_some_and(|marker| self.hidden(marker))
        {
            return Ok(());
        }
        match stream.dict.get(b"Subtype").and_then(Object::as_name) {
            Some(b"Form") => self.form(stream, reference, state, frame, depth),
            Some(b"Image") => {
                self.draw_image(
                    reference,
                    &stream.dict,
                    &ImageData::Stream(stream),
                    frame,
                    state,
                );
                Ok(())
            }
            _ => Ok(()),
        }
    }
}

fn translate(tx: f64, ty: f64, matrix: &Matrix) -> Matrix {
    multiply(&[1.0, 0.0, 0.0, 1.0, tx, ty], matrix)
}

fn matrix_of(object: Option<&Object>) -> Option<Matrix> {
    let values = object_numbers(object);
    let matrix: Matrix = values.get(..6)?.try_into().ok()?;
    matrix
        .iter()
        .all(|value| value.is_finite())
        .then_some(matrix)
}

fn fallback_flags(dict: &Dict) -> u8 {
    const HINTS: [(&[u8], u8); 15] = [
        (b"courier", FALLBACK_MONO),
        (b"mono", FALLBACK_MONO),
        (b"consol", FALLBACK_MONO),
        (b"times", FALLBACK_SERIF),
        (b"roman", FALLBACK_SERIF),
        (b"garamond", FALLBACK_SERIF),
        (b"georgia", FALLBACK_SERIF),
        (b"cambria", FALLBACK_SERIF),
        (b"bold", FALLBACK_BOLD),
        (b"black", FALLBACK_BOLD),
        (b"heavy", FALLBACK_BOLD),
        (b"semibold", FALLBACK_BOLD),
        (b"demi", FALLBACK_BOLD),
        (b"italic", FALLBACK_ITALIC),
        (b"oblique", FALLBACK_ITALIC),
    ];
    let name = dict
        .get(b"BaseFont")
        .and_then(Object::as_name)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let mut flags = 0_u8;
    for (needle, flag) in HINTS {
        if name.windows(needle.len()).any(|window| window == needle) {
            flags |= flag;
        }
    }
    if flags & FALLBACK_MONO != 0 {
        flags &= !FALLBACK_SERIF;
    }
    flags
}

fn normalized_inline(dict: Dict) -> Dict {
    let mut out = Dict::default();
    for (key, value) in dict.entries {
        let full: &[u8] = match key.as_slice() {
            b"BPC" => b"BitsPerComponent",
            b"CS" => b"ColorSpace",
            b"D" => b"Decode",
            b"DP" => b"DecodeParms",
            b"F" => b"Filter",
            b"H" => b"Height",
            b"IM" => b"ImageMask",
            b"I" => b"Interpolate",
            b"W" => b"Width",
            other => other,
        };
        let fixed = if let Object::Name(name) = value {
            Object::Name(expand_filter(name))
        } else if let Object::Array(items) = value {
            Object::Array(
                items
                    .into_iter()
                    .map(|item| {
                        if let Object::Name(name) = item {
                            Object::Name(expand_filter(name))
                        } else {
                            item
                        }
                    })
                    .collect(),
            )
        } else {
            value
        };
        out.insert(full, fixed);
    }
    out
}

fn expand_filter(name: Vec<u8>) -> Vec<u8> {
    match name.as_slice() {
        b"DCT" => b"DCTDecode".to_vec(),
        b"CCF" => b"CCITTFaxDecode".to_vec(),
        _ => name,
    }
}

const fn blend_mode(name: &[u8]) -> u8 {
    match name {
        b"Multiply" => 1,
        b"Screen" => 2,
        b"Overlay" => 3,
        b"Darken" => 4,
        b"Lighten" => 5,
        b"ColorDodge" => 6,
        b"ColorBurn" => 7,
        b"HardLight" => 8,
        b"SoftLight" => 9,
        b"Difference" => 10,
        b"Exclusion" => 11,
        b"Hue" => 12,
        b"Saturation" => 13,
        b"Color" => 14,
        b"Luminosity" => 15,
        _ => 0,
    }
}

fn visible_box(page: &Page) -> [f64; 4] {
    let [m0, m1, m2, m3] = page.info.media_box;
    let [c0, c1, c2, c3] = page.info.crop_box;
    let x0 = m0.min(m2).max(c0.min(c2));
    let y0 = m1.min(m3).max(c1.min(c3));
    let x1 = m0.max(m2).min(c0.max(c2));
    let y1 = m1.max(m3).min(c1.max(c3));
    if x1 > x0 && y1 > y0 {
        [x0, y0, x1, y1]
    } else {
        [m0.min(m2), m1.min(m3), m0.max(m2), m1.max(m3)]
    }
}

fn decoded_bytes(decoded: &Decoded) -> usize {
    let size = |pixels: &Pixels| match pixels {
        Pixels::Jpeg(raster) | Pixels::Raster(raster) => raster.pixels.len(),
    };
    size(&decoded.image).saturating_add(decoded.mask.as_ref().map_or(0, size))
}

const fn opaque(rgb: [u8; 3]) -> [u8; 4] {
    [rgb[0], rgb[1], rgb[2], 255]
}

const fn rgb_of(rgba: [u8; 4]) -> [u8; 3] {
    [rgba[0], rgba[1], rgba[2]]
}

fn dict_flag(dict: &Dict, key: &[u8]) -> bool {
    matches!(dict.get(key), Some(Object::Bool(true)))
}

fn tile_color(data: &[u8]) -> [u8; 3] {
    let mut lexer = ContentLexer::new(data);
    let mut values: Vec<f64> = Vec::new();
    let mut scratch = Vec::new();
    while let Some(Ok(token)) = lexer.next() {
        match token {
            ContentToken::Operand(operand) => {
                if let Some(number) = operand.as_number() {
                    values.push(number);
                }
            }
            ContentToken::Operator(code) => {
                let space = match code {
                    b"g" => Some(ColorSpace::Gray),
                    b"rg" | b"sc" | b"scn" if values.len() == 3 => Some(ColorSpace::Rgb),
                    b"k" => Some(ColorSpace::Cmyk),
                    _ => None,
                };
                if let Some(found) = space {
                    let count = found.components();
                    let start = values.len().saturating_sub(count);
                    let rgb = found
                        .rgb(values.get(start..).unwrap_or_default(), &mut scratch)
                        .map(unit_to_u8);
                    if rgb != [255, 255, 255] {
                        return rgb;
                    }
                }
                values.clear();
            }
        }
    }
    [191, 191, 191]
}

pub(crate) fn render_pages(
    bytes: &[u8],
    page_indexes: PageRequest<&[u32]>,
    scale: f64,
    limits: &Limits,
) -> Outcome<Vec<RenderedPage>> {
    render_document(
        bytes,
        &PageSelection {
            operator_limit: MAX_OPERATORS,
            page_indexes,
            scale,
        },
        limits,
        &mut RenderSession::default(),
    )
}

fn render_document(
    bytes: &[u8],
    selection: &PageSelection<'_>,
    limits: &Limits,
    session: &mut RenderSession,
) -> Outcome<Vec<RenderedPage>> {
    let scale = selection.scale;
    if bytes.len() > limits.max_pdf_bytes {
        return Err(Failure::limit("pdf exceeds size limit"));
    }
    if !scale.is_finite() || scale <= 0.0_f64 || scale > 64.0_f64 {
        return Err(Failure::invalid("render scale out of range"));
    }
    let document = Document::open(bytes, limits)?;
    let pages = document.selected_page_entries(selection.page_indexes)?;
    render_selected(&document, &borrow_pages(&pages), selection, limits, session)
}

pub(crate) fn opened_render(
    document: &Document<'_>,
    selected: &[(usize, &Page)],
    scale: f64,
    limits: &Limits,
) -> Outcome<Vec<RenderedPage>> {
    if !scale.is_finite() || scale <= 0.0_f64 || scale > 64.0_f64 {
        return Err(Failure::invalid("render scale out of range"));
    }
    render_selected(
        document,
        selected,
        &PageSelection {
            operator_limit: MAX_OPERATORS,
            page_indexes: PageRequest::Indexes(None),
            scale,
        },
        limits,
        &mut RenderSession::default(),
    )
}

#[inline(never)]
fn render_selected(
    document: &Document<'_>,
    selected: &[(usize, &Page)],
    selection: &PageSelection<'_>,
    limits: &Limits,
    session: &mut RenderSession,
) -> Outcome<Vec<RenderedPage>> {
    let scale = selection.scale;
    let content = OptionalContent::load(document);
    let mut rendered = Vec::with_capacity(selected.len());
    for &(position, page) in selected {
        let target = PageTarget {
            content: &content,
            document,
            limits,
            operator_limit: selection.operator_limit,
            page,
            scale,
        };
        let list = render_page(&target, session)?;
        rendered.push(RenderedPage {
            list,
            page_index: u32::try_from(position)
                .ok()
                .ok_or_else(|| Failure::limit("page index out of range"))?,
            rotate: page.info.rotate,
            view: visible_box(page),
        });
    }
    Ok(rendered)
}

fn render_page(target: &PageTarget<'_, '_>, session: &mut RenderSession) -> Outcome<DisplayList> {
    let data = target.document.content(target.page).unwrap_or_default();
    let resources = Rc::clone(&target.page.resources);
    let frame = Frame {
        base: IDENTITY,
        resources,
    };
    let mut renderer = Renderer {
        active: Vec::new(),
        box_glyph: None,
        budget: target.limits.max_decoded_stream_bytes,
        content: target.content,
        decoded: String::new(),
        document: target.document,
        emitted: Emitted::default(),
        emitted_stack: Vec::new(),
        glyph_ids: HashMap::new(),
        glyphs: Vec::new(),
        images: HashMap::new(),
        limits: target.limits,
        list: DisplayList::default(),
        named_spaces: HashMap::new(),
        next_glyph: 0,
        operator_limit: target.operator_limit,
        operators: 0,
        outline_work: MAX_OUTLINE_WORK,
        scale: target.scale,
        session,
        truncated: false,
    };
    let mut state = GState::initial();
    renderer.save();
    renderer.run(&data, &frame, &mut state, 0)?;
    renderer.restore();
    renderer.annotations(target.page, &frame)?;
    Ok(renderer.list)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::display::{
        OP_DASH, OP_FILL_COLOR, OP_GLYPH, OP_GLYPH_DEFINE, OP_IMAGE, OP_PATH, OP_STROKE_COLOR,
        OP_TEXT, OP_TRANSFORM,
    };
    use crate::test_pdf::{build, document, page, stream_object, text};
    use core::iter;

    #[derive(Debug, PartialEq)]
    enum Op {
        Blend(u8),
        Cap(u8),
        Clip(u8),
        Dash(Vec<f32>, f32),
        Fill(u8),
        FillColor([u8; 4]),
        Glyph(u8, u32),
        GlyphDefine(u32, usize),
        Gradient(u8, u8),
        Image(bool, u32, u32, u32),
        ImageMeta(u8, u8),
        Join(u8),
        LineWidth(f32),
        Miter(f32),
        Path(Vec<u8>, Vec<f32>),
        Restore,
        Save,
        Stroke,
        StrokeColor([u8; 4]),
        Text(u8, String),
        TextClip,
        Transform([f32; 6]),
    }

    struct Reader<'data> {
        at: usize,
        data: &'data [u8],
    }

    impl Reader<'_> {
        fn f32(&mut self) -> f32 {
            f32::from_le_bytes(self.take(4).try_into().unwrap())
        }

        fn matrix(&mut self) -> [f32; 6] {
            [
                self.f32(),
                self.f32(),
                self.f32(),
                self.f32(),
                self.f32(),
                self.f32(),
            ]
        }

        fn path(&mut self) -> (Vec<u8>, Vec<f32>) {
            let verbs = self.u32();
            let verb_bytes = self.take(verbs).to_vec();
            let coords = self.u32();
            let values = iter::repeat_with(|| self.f32()).take(coords).collect();
            (verb_bytes, values)
        }

        fn take(&mut self, len: usize) -> &[u8] {
            let end = self.at.saturating_add(len);
            let slice = &self.data[self.at..end];
            self.at = end;
            slice
        }

        fn u32(&mut self) -> usize {
            usize::try_from(u32::from_le_bytes(self.take(4).try_into().unwrap())).unwrap()
        }

        fn u8(&mut self) -> u8 {
            self.take(1)[0]
        }
    }

    fn decode(list: &DisplayList) -> Vec<Op> {
        let mut reader = Reader {
            at: 0,
            data: &list.ops,
        };
        let mut ops = Vec::new();
        while reader.at < reader.data.len() {
            let code = reader.u8();
            let op = match code {
                OP_SAVE => Op::Save,
                OP_RESTORE => Op::Restore,
                OP_TRANSFORM => Op::Transform(reader.matrix()),
                OP_PATH => {
                    let (verbs, coords) = reader.path();
                    Op::Path(verbs, coords)
                }
                OP_FILL => Op::Fill(reader.u8()),
                OP_STROKE => Op::Stroke,
                OP_CLIP => Op::Clip(reader.u8()),
                OP_FILL_COLOR => Op::FillColor(reader.take(4).try_into().unwrap()),
                OP_STROKE_COLOR => Op::StrokeColor(reader.take(4).try_into().unwrap()),
                OP_LINE_WIDTH => Op::LineWidth(reader.f32()),
                OP_LINE_CAP => Op::Cap(reader.u8()),
                OP_LINE_JOIN => Op::Join(reader.u8()),
                OP_MITER => Op::Miter(reader.f32()),
                OP_DASH => {
                    let count = reader.u32();
                    let lengths = iter::repeat_with(|| reader.f32()).take(count).collect();
                    Op::Dash(lengths, reader.f32())
                }
                OP_BLEND => Op::Blend(reader.u8()),
                OP_GLYPH_DEFINE => {
                    let id = u32::try_from(reader.u32()).unwrap();
                    let (verbs, _) = reader.path();
                    Op::GlyphDefine(id, verbs.len())
                }
                OP_GLYPH => {
                    let modes = reader.u8();
                    let id = u32::try_from(reader.u32()).unwrap();
                    let _matrix = reader.matrix();
                    Op::Glyph(modes, id)
                }
                OP_TEXT_CLIP => Op::TextClip,
                OP_TEXT => {
                    let flags = reader.u8();
                    let _matrix = reader.matrix();
                    let _width = reader.f32();
                    let len = reader.u32();
                    Op::Text(flags, String::from_utf8(reader.take(len).to_vec()).unwrap())
                }
                OP_IMAGE => {
                    let flags = reader.u8();
                    let alpha = reader.u8();
                    let blob = u32::try_from(reader.u32()).unwrap();
                    let width = u32::try_from(reader.u32()).unwrap();
                    let height = u32::try_from(reader.u32()).unwrap();
                    let _mask = reader.take(12);
                    let _matte = reader.take(4);
                    ops.push(Op::Image(flags & 1 == 1, blob, width, height));
                    Op::ImageMeta(flags, alpha)
                }
                OP_SHADE | OP_FILL_GRADIENT | OP_STROKE_GRADIENT => {
                    let flags = reader.u8();
                    let _coords = reader.take(24);
                    if code != OP_SHADE {
                        let _matrix = reader.take(24);
                    }
                    let stops = reader.u32();
                    let _stops = reader.take(stops.saturating_mul(8));
                    Op::Gradient(code, flags)
                }
                other => panic!("unknown op {other}"),
            };
            ops.push(op);
        }
        ops
    }

    fn page_pdf(resources: &str, content: &str, extra: &[(u32, String)]) -> Vec<u8> {
        let mut objects = vec![
            (1, "<< /Type /Catalog /Pages 2 0 R >>".to_owned()),
            (2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_owned()),
            (
                3,
                format!(
                    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources {resources} >>"
                ),
            ),
            (4, stream_object("", content)),
        ];
        objects.extend_from_slice(extra);
        build(&objects)
    }

    fn render_one(bytes: &[u8], limits: &Limits) -> Vec<Op> {
        let pages = render_pages(bytes, PageRequest::Indexes(None), 2.0, limits).unwrap();
        assert_eq!(pages.len(), 1);
        decode(&pages[0].list)
    }

    fn render(bytes: &[u8]) -> Vec<Op> {
        render_one(bytes, &Limits::default())
    }

    fn balanced(ops: &[Op]) -> bool {
        let saves = ops.iter().filter(|op| **op == Op::Save).count();
        let restores = ops.iter().filter(|op| **op == Op::Restore).count();
        saves == restores
    }

    #[test]
    fn paths_paint_with_colours_line_styles_and_rules() {
        let ops = render(&page_pdf(
            "<< >>",
            "q 2 w 1 J 2 j [3 1] 0 d 1 0 0 RG 0 0 1 rg 10 20 30 40 re B Q 0.5 g 5 5 m 10 10 l h f* Q Q",
            &[],
        ));
        assert!(balanced(&ops));
        assert!(ops.contains(&Op::FillColor([0, 0, 255, 255])));
        assert!(ops.contains(&Op::StrokeColor([255, 0, 0, 255])));
        assert!(ops.contains(&Op::LineWidth(2.0)));
        assert!(ops.contains(&Op::Cap(1)));
        assert!(ops.contains(&Op::Join(2)));
        assert!(ops.contains(&Op::Dash(vec![3.0, 1.0], 0.0)));
        assert!(ops.contains(&Op::Fill(RULE_NONZERO)));
        assert!(ops.contains(&Op::Fill(RULE_EVENODD)));
        assert!(ops.contains(&Op::FillColor([128, 128, 128, 255])));
        let rectangle = ops
            .iter()
            .find_map(|op| {
                if let Op::Path(verbs, coords) = op
                    && verbs.len() == 5
                {
                    Some(coords.clone())
                } else {
                    None
                }
            })
            .unwrap();
        assert_eq!(
            rectangle,
            vec![10.0, 20.0, 40.0, 20.0, 40.0, 60.0, 10.0, 60.0]
        );
    }

    #[test]
    fn clipping_precedes_painting_and_unbalanced_restores_are_ignored() {
        let ops = render(&page_pdf(
            "<< >>",
            "Q Q 10 10 100 100 re W n q 0 0 1 rg 0 0 500 500 re f",
            &[],
        ));
        assert!(balanced(&ops));
        let clip = ops
            .iter()
            .position(|op| *op == Op::Clip(RULE_NONZERO))
            .unwrap();
        let fill = ops
            .iter()
            .position(|op| *op == Op::Fill(RULE_NONZERO))
            .unwrap();
        assert!(clip < fill);
    }

    #[test]
    fn standard_fonts_fall_back_to_text_runs() {
        let ops = render(&document(&[page(text(72.0, 700.0, 12.0, "Hello"))], &[]));
        let runs: Vec<&Op> = ops.iter().filter(|op| matches!(op, Op::Text(..))).collect();
        assert_eq!(runs.len(), 1);
        let Op::Text(flags, value) = runs[0] else {
            panic!("expected a text run");
        };
        assert_eq!(value, "Hello");
        assert_eq!(flags & FALLBACK_FILL, FALLBACK_FILL);
        assert_eq!(flags & (FALLBACK_SERIF | FALLBACK_MONO), 0);
        let invisible = render(&document(
            &[page(
                "BT /F1 12 Tf 3 Tr 72 700 Td (Hidden) Tj ET".to_owned(),
            )],
            &[],
        ));
        assert!(!invisible.iter().any(|op| matches!(op, Op::Text(..))));
    }

    #[test]
    fn embedded_truetype_glyphs_are_defined_once_and_reused() {
        let bytes = include_bytes!("../../__tests__/fixtures/react-pdf-declaration.pdf");
        let ops = render(bytes);
        let defined = ops
            .iter()
            .filter(|op| matches!(op, Op::GlyphDefine(_, verbs) if *verbs > 0))
            .count();
        let drawn = ops.iter().filter(|op| matches!(op, Op::Glyph(..))).count();
        assert!(defined > 10);
        assert!(drawn > defined);
    }

    #[test]
    fn inline_images_decode_to_rgba_blobs() {
        let pages = render_pages(
            &page_pdf(
                "<< >>",
                "q 20 0 0 10 10 10 cm BI /W 2 /H 1 /CS /RGB /BPC 8 /F /AHx ID ff000000ff00> EI Q",
                &[],
            ),
            PageRequest::Indexes(None),
            1.0,
            &Limits::default(),
        )
        .unwrap();
        let ops = decode(&pages[0].list);
        assert!(ops.contains(&Op::Image(false, 0, 2, 1)));
        assert_eq!(pages[0].list.blobs[0], vec![255, 0, 0, 255, 0, 255, 0, 255]);
    }

    #[test]
    fn image_xobjects_are_cached_and_oversized_images_become_placeholders() {
        let image = stream_object(
            "/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8",
            "\u{7f}",
        );
        let huge = stream_object(
            "/Type /XObject /Subtype /Image /Width 100000 /Height 100000 /ColorSpace /DeviceGray /BitsPerComponent 8",
            "x",
        );
        let ops = render(&page_pdf(
            "<< /XObject << /Im0 5 0 R /Im1 6 0 R >> >>",
            "q 10 0 0 10 0 0 cm /Im0 Do /Im0 Do /Im1 Do Q",
            &[(5, image), (6, huge)],
        ));
        let images: Vec<&Op> = ops
            .iter()
            .filter(|op| matches!(op, Op::Image(..)))
            .collect();
        assert_eq!(images.len(), 2);
        assert_eq!(images[0], images[1]);
        assert!(ops.contains(&Op::FillColor(PLACEHOLDER)));
    }

    #[test]
    fn forms_apply_matrices_clip_to_bbox_and_stop_cycles_and_deep_chains() {
        let form = stream_object(
            "/Type /XObject /Subtype /Form /BBox [0 0 10 10] /Matrix [2 0 0 2 5 5] /Resources << /XObject << /Fm0 5 0 R >> >>",
            "0 0 1 rg 0 0 10 10 re f /Fm0 Do",
        );
        let ops = render(&page_pdf(
            "<< /XObject << /Fm0 5 0 R >> >>",
            "/Fm0 Do",
            &[(5, form)],
        ));
        assert!(balanced(&ops));
        assert!(ops.contains(&Op::Transform([2.0, 0.0, 0.0, 2.0, 5.0, 5.0])));
        assert_eq!(
            ops.iter()
                .filter(|op| **op == Op::Fill(RULE_NONZERO))
                .count(),
            1
        );
        let mut chain = Vec::new();
        for index in 0..60_u32 {
            let next = 5_u32.saturating_add(index).saturating_add(1);
            chain.push((
                5_u32.saturating_add(index),
                stream_object(
                    &format!("/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Resources << /XObject << /Fm0 {next} 0 R >> >>"),
                    "0 g 0 0 1 1 re f /Fm0 Do",
                ),
            ));
        }
        let deep = render(&page_pdf(
            "<< /XObject << /Fm0 5 0 R >> >>",
            "/Fm0 Do",
            &chain,
        ));
        assert!(balanced(&deep));
        let fills = deep
            .iter()
            .filter(|op| **op == Op::Fill(RULE_NONZERO))
            .count();
        assert_eq!(fills, MAX_FORM_DEPTH);
    }

    #[test]
    fn axial_shadings_and_shading_patterns_emit_gradients() {
        let shading = "<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 100 0] /Function << /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1 >> /Extend [true true] >>";
        let ops = render(&page_pdf(
            &format!(
                "<< /Shading << /Sh0 {shading} >> /Pattern << /P0 << /PatternType 2 /Shading {shading} >> >> >>"
            ),
            "/Sh0 sh /Pattern cs /P0 scn 0 0 50 50 re f",
            &[],
        ));
        assert!(ops.contains(&Op::Gradient(OP_SHADE, 6)));
        assert!(ops.contains(&Op::Gradient(OP_FILL_GRADIENT, 6)));
    }

    #[test]
    fn annotation_appearances_are_drawn_unless_hidden() {
        let appearance = stream_object(
            "/Type /XObject /Subtype /Form /BBox [0 0 10 10]",
            "1 0 0 rg 0 0 10 10 re f",
        );
        let bytes = build(&[
            (1, "<< /Type /Catalog /Pages 2 0 R >>".to_owned()),
            (2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_owned()),
            (
                3,
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Annots [5 0 R 6 0 R] >>"
                    .to_owned(),
            ),
            (
                5,
                "<< /Subtype /Square /Rect [20 20 40 60] /AP << /N 7 0 R >> >>".to_owned(),
            ),
            (
                6,
                "<< /Subtype /Square /F 2 /Rect [0 0 10 10] /AP << /N 7 0 R >> >>".to_owned(),
            ),
            (7, appearance),
        ]);
        let ops = render(&bytes);
        assert!(balanced(&ops));
        assert_eq!(
            ops.iter()
                .filter(|op| **op == Op::FillColor([255, 0, 0, 255]))
                .count(),
            1
        );
        assert!(ops.contains(&Op::Transform([2.0, 0.0, 0.0, 4.0, 20.0, 20.0])));
    }

    #[test]
    fn hostile_content_never_panics_and_respects_the_content_budget() {
        let mut garbage = String::new();
        for index in 0..2000_u32 {
            let token = [
                "q", "Q", "cm", "re", "f", "BT", "Tj", "(", "[", "<<", "1e999", "-", "Do", "sh",
                "W", "n", "BI", "ID",
            ][usize::try_from(index.wrapping_mul(7919).rem_euclid(18)).unwrap()];
            garbage.push_str(token);
            garbage.push(' ');
        }
        let ops = render(&page_pdf("<< >>", &garbage, &[]));
        assert!(balanced(&ops));
        let tight = Limits {
            max_decoded_stream_bytes: 16,
            ..Limits::default()
        };
        let truncated = render_one(
            &page_pdf("<< >>", "0 0 1 rg 0 0 10 10 re f 0 0 10 10 re f", &[]),
            &tight,
        );
        assert!(balanced(&truncated));
        assert!(!truncated.contains(&Op::Fill(RULE_NONZERO)));
        let _invalid = render_pages(
            b"%PDF-1.7 garbage",
            PageRequest::Indexes(None),
            1.0,
            &Limits::default(),
        )
        .unwrap_err();
        let _scale = render_pages(
            &page_pdf("<< >>", "", &[]),
            PageRequest::Indexes(None),
            0.0,
            &Limits::default(),
        )
        .unwrap_err();
        let _range = render_pages(
            &page_pdf("<< >>", "", &[]),
            PageRequest::Indexes(Some(&[3])),
            1.0,
            &Limits::default(),
        )
        .unwrap_err();
    }

    #[test]
    fn page_view_intersects_crop_and_media_boxes() {
        let bytes = include_bytes!("../../__tests__/fixtures/rotated-cropped.pdf");
        let pages =
            render_pages(bytes, PageRequest::Indexes(None), 1.0, &Limits::default()).unwrap();
        assert_eq!(pages.len(), 2);
        for rendered in &pages {
            let [x0, y0, x1, y1] = rendered.view;
            assert!(x1 > x0 && y1 > y0);
        }
        assert!(pages.iter().any(|rendered| rendered.rotate != 0_i32));
    }

    fn catalog_pdf(
        catalog: &str,
        resources: &str,
        content: &str,
        extra: &[(u32, String)],
    ) -> Vec<u8> {
        let mut objects = vec![
            (1, format!("<< /Type /Catalog /Pages 2 0 R {catalog} >>")),
            (2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_owned()),
            (
                3,
                format!(
                    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources {resources} >>"
                ),
            ),
            (4, stream_object("", content)),
        ];
        objects.extend_from_slice(extra);
        build(&objects)
    }

    #[test]
    fn stencil_masks_apply_the_fill_alpha_once() {
        let pages = render_pages(
            &page_pdf(
                "<< /ExtGState << /G0 << /ca 0.5 >> >> >>",
                "q /G0 gs 1 0 0 rg 8 0 0 1 0 0 cm BI /W 8 /H 1 /IM true /F /AHx ID 0F> EI Q",
                &[],
            ),
            PageRequest::Indexes(None),
            1.0,
            &Limits::default(),
        )
        .unwrap();
        let ops = decode(&pages[0].list);
        assert!(ops.contains(&Op::ImageMeta(0, 128)), "{ops:?}");
        let alphas: Vec<u8> = pages[0].list.blobs[0]
            .chunks(4)
            .map(|pixel| pixel[3])
            .collect();
        assert_eq!(alphas, vec![255, 255, 255, 255, 0, 0, 0, 0]);
        assert_eq!(&pages[0].list.blobs[0][..3], &[255, 0, 0]);
    }

    #[test]
    fn image_interpolation_is_carried_to_the_display_list() {
        let ops = render(&page_pdf(
            "<< >>",
            "q 50 0 0 50 0 0 cm BI /W 2 /H 1 /CS /G /BPC 8 /I true /F /AHx ID 00ff> EI Q q 50 0 0 50 60 0 cm BI /W 2 /H 1 /CS /G /BPC 8 /F /AHx ID ff00> EI Q",
            &[],
        ));
        let metas: Vec<&Op> = ops
            .iter()
            .filter(|op| matches!(op, Op::ImageMeta(..)))
            .collect();
        assert_eq!(metas, vec![&Op::ImageMeta(8, 255), &Op::ImageMeta(0, 255)]);
    }

    fn optional_content_page(config: &str) -> Vec<Op> {
        let form = stream_object(
            "/Type /XObject /Subtype /Form /BBox [0 0 50 50] /OC 5 0 R",
            "1 1 0 rg 0 0 10 10 re f",
        );
        render(&catalog_pdf(
            &format!("/OCProperties << /OCGs [5 0 R 6 0 R] /D {config} >>"),
            "<< /Properties << /Off 5 0 R /On 6 0 R /Both 7 0 R /Either 8 0 R >> /XObject << /Fm0 9 0 R >> >>",
            "/OC /Off BDC 1 0 0 rg 0 0 10 10 re f EMC /OC /On BDC 0 1 0 rg 0 0 10 10 re f EMC /OC /Both BDC 0 0 1 rg 0 0 10 10 re f EMC /OC /Either BDC 0 1 1 rg 0 0 10 10 re f EMC /Fm0 Do /Span BMC 1 0 1 rg 0 0 10 10 re f EMC",
            &[
                (5, "<< /Type /OCG /Name (Off) >>".to_owned()),
                (6, "<< /Type /OCG /Name (On) >>".to_owned()),
                (
                    7,
                    "<< /Type /OCMD /OCGs [5 0 R 6 0 R] /P /AllOn >>".to_owned(),
                ),
                (
                    8,
                    "<< /Type /OCMD /VE [/Or 5 0 R [/Not 5 0 R]] >>".to_owned(),
                ),
                (9, form),
            ],
        ))
    }

    #[test]
    fn optional_content_that_is_off_is_not_painted() {
        for config in ["<< /OFF [5 0 R] >>", "<< /BaseState /OFF /ON [6 0 R] >>"] {
            let ops = optional_content_page(config);
            assert!(balanced(&ops));
            let fills: Vec<&Op> = ops
                .iter()
                .filter(|op| matches!(op, Op::FillColor(..)))
                .collect();
            assert_eq!(
                fills,
                vec![
                    &Op::FillColor([0, 255, 0, 255]),
                    &Op::FillColor([0, 255, 255, 255]),
                    &Op::FillColor([255, 0, 255, 255]),
                ],
                "{config}"
            );
        }
        let plain = render(&page_pdf(
            "<< /Properties << /Off 5 0 R >> >>",
            "/OC /Off BDC 1 0 0 rg 0 0 10 10 re f EMC",
            &[(5, "<< /Type /OCG /Name (Off) >>".to_owned())],
        ));
        assert!(plain.contains(&Op::FillColor([255, 0, 0, 255])));
    }

    #[test]
    fn clip_render_modes_with_standard_fonts_clip_to_glyph_boxes() {
        let ops = render(&document(
            &[page(
                "BT /F1 12 Tf 7 Tr 10 10 Td (AB) Tj ET 0 0 1 rg 0 0 100 100 re f".to_owned(),
            )],
            &[],
        ));
        let boxes = ops
            .iter()
            .filter(|op| matches!(op, Op::Glyph(GLYPH_CLIP, _)))
            .count();
        assert_eq!(boxes, 2);
        assert!(
            ops.iter()
                .any(|op| matches!(op, Op::GlyphDefine(_, verbs) if *verbs == 5))
        );
        let clip = ops.iter().position(|op| *op == Op::TextClip).unwrap();
        let fill = ops
            .iter()
            .position(|op| *op == Op::Fill(RULE_NONZERO))
            .unwrap();
        assert!(clip < fill);
        assert!(!ops.iter().any(|op| matches!(op, Op::Text(..))));
    }

    #[test]
    fn type3_fan_out_is_bounded_by_the_operator_budget() {
        let fan =
            |next: char| format!("0 0 d0 BT /T 1 Tf ({}) Tj ET", next.to_string().repeat(200));
        let bytes = page_pdf(
            "<< /Font << /T 5 0 R >> >>",
            "BT /T 10 Tf 10 10 Td (a) Tj ET",
            &[
                (
                    5,
                    "<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1000 1000] /FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << /a 6 0 R /b 7 0 R /c 8 0 R /d 9 0 R >> /Encoding << /Type /Encoding /Differences [97 /a /b /c /d] >> /FirstChar 97 /LastChar 100 /Widths [1000 1000 1000 1000] /Resources << /Font << /T 5 0 R >> >> >>".to_owned(),
                ),
                (6, stream_object("", &fan('b'))),
                (7, stream_object("", &fan('c'))),
                (8, stream_object("", &fan('d'))),
                (9, stream_object("", "")),
            ],
        );
        let limit = 50_000;
        let mut session = RenderSession::default();
        let pages = render_document(
            &bytes,
            &PageSelection {
                operator_limit: limit,
                page_indexes: PageRequest::Indexes(None),
                scale: 1.0,
            },
            &Limits::default(),
            &mut session,
        )
        .unwrap();
        let ops = decode(&pages[0].list);
        assert!(balanced(&ops));
        let saves = ops.iter().filter(|op| **op == Op::Save).count();
        assert!(saves > 1000, "{saves}");
        assert!(saves <= limit, "{saves}");
    }

    #[test]
    fn form_streams_and_colour_spaces_are_decoded_once_per_document() {
        let form = stream_object(
            "/Type /XObject /Subtype /Form /BBox [0 0 50 50]",
            "/CS0 cs 1 scn 0 0 10 10 re f",
        );
        let resources = "<< /ColorSpace << /CS0 6 0 R >> /XObject << /Fm0 5 0 R >> >>";
        let bytes = build(&[
            (1, "<< /Type /Catalog /Pages 2 0 R >>".to_owned()),
            (2, "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>".to_owned()),
            (
                3,
                format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 7 0 R /Resources {resources} >>"),
            ),
            (
                4,
                format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 7 0 R /Resources {resources} >>"),
            ),
            (5, form),
            (
                6,
                "[/Separation /Spot /DeviceCMYK << /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [1 0 0 0] /N 1 >>]".to_owned(),
            ),
            (7, stream_object("", "/Fm0 Do /Fm0 Do")),
        ]);
        let mut session = RenderSession::default();
        let pages = render_document(
            &bytes,
            &PageSelection {
                operator_limit: MAX_OPERATORS,
                page_indexes: PageRequest::Indexes(None),
                scale: 1.0,
            },
            &Limits::default(),
            &mut session,
        )
        .unwrap();
        assert_eq!(pages.len(), 2);
        let form_ref = ObjRef {
            number: 5,
            generation: 0,
        };
        let space_ref = ObjRef {
            number: 6,
            generation: 0,
        };
        assert_eq!(session.streams.len(), 1);
        assert!(session.streams.contains_key(&form_ref));
        assert!(session.spaces.contains_key(&space_ref));
        for page in &pages {
            let ops = decode(&page.list);
            assert_eq!(
                ops.iter()
                    .filter(|op| **op == Op::FillColor([0, 255, 255, 255]))
                    .count(),
                2
            );
        }
    }
}
