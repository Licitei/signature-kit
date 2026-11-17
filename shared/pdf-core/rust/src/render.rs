use crate::color::ColorSpace;
use crate::display::{
    DisplayList, Gradient, ImageRef, Matrix, NO_BLOB, OP_BLEND, OP_CLIP, OP_FILL, OP_FILL_GRADIENT,
    OP_LINE_CAP, OP_LINE_JOIN, OP_LINE_WIDTH, OP_MITER, OP_RESTORE, OP_SAVE, OP_SHADE, OP_STROKE,
    OP_STROKE_GRADIENT, OP_TEXT_CLIP, PathData,
};
use crate::document::{Document, Page, select_pages};
use crate::failure::{Failure, Outcome};
use crate::filters;
use crate::font::{Font, Glyph};
use crate::image::{Decoded, ImageContext, ImageInput, Pixels, decode_image, image_filter};
use crate::inspection::Limits;
use crate::num::{bounded, f64_to_i64, f64_to_usize, unit_to_u8};
use crate::object::{Dict, ObjRef, Object, Resolver as _, Stream};
use crate::shading::{GradientPaint, Shading, parse_shading};
use crate::syntax::{ContentLexer, ContentToken, Operand};
use alloc::rc::Rc;
use core::mem;
use std::collections::HashMap;

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
}

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

struct Renderer<'doc, 'data> {
    active: Vec<ObjRef>,
    budget: usize,
    decoded: String,
    document: &'doc Document<'data>,
    emitted: Emitted,
    emitted_stack: Vec<Emitted>,
    glyph_ids: HashMap<(u32, u16), Option<u32>>,
    glyphs: Vec<Glyph>,
    images: HashMap<ImageKey, ImageRef>,
    limits: &'doc Limits,
    list: DisplayList,
    next_glyph: u32,
    operators: usize,
    scale: f64,
    session: &'doc mut RenderSession,
    truncated: bool,
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
    fn add_image(&mut self, decoded: &Decoded) -> ImageRef {
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

    fn color_operator(
        &self,
        code: &[u8],
        operands: &[Operand<'_>],
        frame: &Frame,
        state: &mut GState,
    ) {
        let stroke = code.first().is_some_and(u8::is_ascii_uppercase);
        let lower: &[u8] = &code.to_ascii_lowercase();
        let named = self.named_color_spaces(frame);
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
                    .and_then(|name| {
                        ColorSpace::parse(
                            self.document,
                            &Object::Name(name.to_vec()),
                            named.as_deref().and_then(Object::as_dict),
                        )
                    })
                    .unwrap_or(ColorSpace::Gray);
                let initial = space.initial();
                let rgb = space.rgb(&initial, &mut scratch).map(unit_to_u8);
                let rc = Rc::new(space);
                if stroke {
                    state.stroke_space = Rc::clone(&rc);
                    state.stroke = Paint::solid(opaque(rgb));
                } else {
                    state.fill_space = Rc::clone(&rc);
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
                .and_then(|program| program.outline(gid, &mut path));
            if built.is_none() {
                path.clear();
            }
            let shared = Rc::new(path);
            if self.session.outlines.len() < MAX_CACHED_OUTLINES {
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
        let fill = Self::fill_rgba(state);
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
            let image = self.add_image(&cached);
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
        let named = self.named_color_spaces(frame);
        let (filter, parms) = image_filter(self.document, dict);
        let context = ImageContext {
            device,
            fill,
            max_bytes: self.limits.max_decoded_stream_bytes,
            named: named.as_deref().and_then(Object::as_dict),
            resolver: self.document,
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
        let image = self.add_image(&shared);
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

    const fn fill_rgba(state: &GState) -> [u8; 4] {
        let [red, green, blue, _] = state.fill.color;
        [red, green, blue, unit_to_u8(state.fill_alpha)]
    }

    fn form(
        &mut self,
        stream: &Stream,
        reference: Option<ObjRef>,
        state: &GState,
        frame: &Frame,
        depth: usize,
    ) -> Outcome<()> {
        if depth >= MAX_FORM_DEPTH {
            return Ok(());
        }
        if let Some(inner) = reference {
            if self.active.contains(&inner) {
                return Ok(());
            }
            self.active.push(inner);
        }
        let data = self.document.stream_data(stream).unwrap_or_default();
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

    fn named_color_spaces(&self, frame: &Frame) -> Option<Rc<Object>> {
        let entry = frame.resources.as_dict()?.get(b"ColorSpace")?;
        self.document.follow(entry).ok()
    }

    fn paint_path(
        &mut self,
        path: &mut PathData,
        state: &GState,
        fill: Option<u8>,
        stroke: bool,
        clip: Option<u8>,
    ) {
        if path.is_empty() {
            return;
        }
        let fill_visible = fill.is_some() && !state.fill_space.is_invisible();
        let stroke_visible = stroke && !state.stroke_space.is_invisible();
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
                if let Some([x, y]) = numbers::<2>(operands) {
                    path.move_to(x, y);
                    *current = (x, y);
                }
            }
            b"l" => {
                if let Some([x, y]) = numbers::<2>(operands) {
                    if path.is_empty() {
                        path.move_to(current.0, current.1);
                    }
                    path.line(x, y);
                    *current = (x, y);
                }
            }
            b"c" => {
                if let Some(points) = numbers::<6>(operands) {
                    if path.is_empty() {
                        path.move_to(current.0, current.1);
                    }
                    path.cubic(points);
                    *current = (points[4], points[5]);
                }
            }
            b"v" => {
                if let Some([x2, y2, x3, y3]) = numbers::<4>(operands) {
                    if path.is_empty() {
                        path.move_to(current.0, current.1);
                    }
                    path.cubic([current.0, current.1, x2, y2, x3, y3]);
                    *current = (x3, y3);
                }
            }
            b"y" => {
                if let Some([x1, y1, x3, y3]) = numbers::<4>(operands) {
                    if path.is_empty() {
                        path.move_to(current.0, current.1);
                    }
                    path.cubic([x1, y1, x3, y3, x3, y3]);
                    *current = (x3, y3);
                }
            }
            b"h" => path.close(),
            b"re" => {
                if let Some([x, y, width, height]) = numbers::<4>(operands) {
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

    fn resource(&self, frame: &Frame, category: &[u8], name: &[u8]) -> Option<Rc<Object>> {
        let entries = self
            .document
            .follow(frame.resources.as_dict()?.get(category)?)
            .ok()?;
        self.document.follow(entries.as_dict()?.get(name)?).ok()
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
            self.operators = self.operators.saturating_add(1);
            if self.operators > MAX_OPERATORS || self.list.ops.len() > MAX_OPS_BYTES {
                self.truncated = true;
                break;
            }
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
                    if let Some(matrix) = numbers::<6>(&operands) {
                        state.ctm = multiply(&matrix, &state.ctm);
                    }
                }
                b"w" => {
                    if let Some([width]) = numbers::<1>(&operands) {
                        state.line_width = width;
                    }
                }
                b"J" => {
                    if let Some([cap]) = numbers::<1>(&operands) {
                        state.cap = u8::try_from(f64_to_i64(cap).clamp(0, 2)).unwrap_or(0);
                    }
                }
                b"j" => {
                    if let Some([join]) = numbers::<1>(&operands) {
                        state.join = u8::try_from(f64_to_i64(join).clamp(0, 2)).unwrap_or(0);
                    }
                }
                b"M" => {
                    if let Some([miter]) = numbers::<1>(&operands) {
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
                b"S" => self.paint_path(&mut path, state, None, true, clip.take()),
                b"s" => {
                    path.close();
                    self.paint_path(&mut path, state, None, true, clip.take());
                }
                b"f" | b"F" => {
                    self.paint_path(&mut path, state, Some(RULE_NONZERO), false, clip.take());
                }
                b"f*" => self.paint_path(&mut path, state, Some(RULE_EVENODD), false, clip.take()),
                b"B" => self.paint_path(&mut path, state, Some(RULE_NONZERO), true, clip.take()),
                b"B*" => self.paint_path(&mut path, state, Some(RULE_EVENODD), true, clip.take()),
                b"b" => {
                    path.close();
                    self.paint_path(&mut path, state, Some(RULE_NONZERO), true, clip.take());
                }
                b"b*" => {
                    path.close();
                    self.paint_path(&mut path, state, Some(RULE_EVENODD), true, clip.take());
                }
                b"n" => {
                    let rule = clip.take();
                    self.paint_path(&mut path, state, None, false, rule);
                    path.clear();
                }
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
                    if let Some([value]) = numbers::<1>(&operands) {
                        state.char_space = value;
                    }
                }
                b"Tw" => {
                    if let Some([value]) = numbers::<1>(&operands) {
                        state.word_space = value;
                    }
                }
                b"Tz" => {
                    if let Some([value]) = numbers::<1>(&operands) {
                        state.scale = value / 100.0_f64;
                    }
                }
                b"TL" => {
                    if let Some([value]) = numbers::<1>(&operands) {
                        state.leading = value;
                    }
                }
                b"Ts" => {
                    if let Some([value]) = numbers::<1>(&operands) {
                        state.rise = value;
                    }
                }
                b"Tr" => {
                    if let Some([value]) = numbers::<1>(&operands) {
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
                    if let Some([tx, ty]) = numbers::<2>(&operands) {
                        text.line = translate(tx, ty, &text.line);
                        text.matrix = text.line;
                    }
                }
                b"TD" => {
                    if let Some([tx, ty]) = numbers::<2>(&operands) {
                        state.leading = -ty;
                        text.line = translate(tx, ty, &text.line);
                        text.matrix = text.line;
                    }
                }
                b"Tm" => {
                    if let Some(matrix) = numbers::<6>(&operands) {
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
                        let owned = bytes.to_vec();
                        self.show(&owned, frame, state, &mut text, depth)?;
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
                        let owned = bytes.to_vec();
                        self.show(&owned, frame, state, &mut text, depth)?;
                    }
                }
                b"TJ" => {
                    if let Some(Operand::Array(items)) = operands.last() {
                        let parts: Vec<Result<Vec<u8>, f64>> = items
                            .iter()
                            .filter_map(|item| {
                                item.as_number().map(Err).or_else(|| {
                                    let mut buffer = Vec::new();
                                    item.string(&mut buffer).map(|bytes| Ok(bytes.to_vec()))
                                })
                            })
                            .collect();
                        for part in parts {
                            match part {
                                Ok(bytes) => self.show(&bytes, frame, state, &mut text, depth)?,
                                Err(adjust) => {
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
                                }
                            }
                        }
                    }
                }
                b"Do" => {
                    if let Some(name) = operands.last().and_then(Operand::as_name) {
                        let owned = name.to_vec();
                        self.xobject(&owned, frame, state, depth)?;
                    }
                }
                b"sh" => {
                    if let Some(name) = operands.last().and_then(Operand::as_name) {
                        let owned = name.to_vec();
                        self.shade(&owned, frame, state);
                    }
                }
                b"EI" => {
                    if let Some((dict, image_data)) = lexer.take_inline_image() {
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
        let modes = Self::glyph_modes(state);
        if modes & GLYPH_CLIP != 0 {
            text.clip = true;
        }
        let start = text.matrix;
        let mut total = 0.0_f64;
        if modes != 0 && !matches!(font.face, Face::Fallback(_)) {
            self.sync_transform(&state.ctm);
            if modes & GLYPH_FILL != 0 {
                self.sync_paint(state, false);
            }
            if modes & GLYPH_STROKE != 0 {
                self.sync_paint(state, true);
                self.sync_line(state);
            }
        }
        for glyph in &glyphs {
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
                    Face::Fallback(_) => {}
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

    fn xobject(&mut self, name: &[u8], frame: &Frame, state: &GState, depth: usize) -> Outcome<()> {
        let Some(entries) = frame
            .resources
            .as_dict()
            .and_then(|dict| dict.get(b"XObject"))
            .and_then(|value| self.document.follow(value).ok())
        else {
            return Ok(());
        };
        let Some(entry) = entries.as_dict().and_then(|dict| dict.get(name)).cloned() else {
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

fn multiply(first: &Matrix, second: &Matrix) -> Matrix {
    let [a1, b1, c1, d1, e1, f1] = *first;
    let [a2, b2, c2, d2, e2, f2] = *second;
    [
        a1 * a2 + b1 * c2,
        a1 * b2 + b1 * d2,
        c1 * a2 + d1 * c2,
        c1 * b2 + d1 * d2,
        e1 * a2 + f1 * c2 + e2,
        e1 * b2 + f1 * d2 + f2,
    ]
}

fn translate(tx: f64, ty: f64, matrix: &Matrix) -> Matrix {
    multiply(&[1.0, 0.0, 0.0, 1.0, tx, ty], matrix)
}

fn numbers<const N: usize>(operands: &[Operand<'_>]) -> Option<[f64; N]> {
    let start = operands.len().checked_sub(N)?;
    let mut out = [0.0_f64; N];
    for (slot, operand) in out.iter_mut().zip(operands.get(start..)?) {
        *slot = operand.as_number()?;
    }
    Some(out)
}

fn object_numbers(object: Option<&Object>) -> Vec<f64> {
    object
        .and_then(Object::as_array)
        .map(|items| items.iter().filter_map(Object::as_number).collect())
        .unwrap_or_default()
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
    page_indexes: Option<&[u32]>,
    scale: f64,
    limits: &Limits,
) -> Outcome<Vec<RenderedPage>> {
    if bytes.len() > limits.max_pdf_bytes {
        return Err(Failure::limit("pdf exceeds size limit"));
    }
    if !scale.is_finite() || scale <= 0.0_f64 || scale > 64.0_f64 {
        return Err(Failure::invalid("render scale out of range"));
    }
    let document = Document::open(bytes, limits)?;
    let pages = document.pages()?;
    let selected = select_pages(pages.len(), page_indexes)?;
    let mut session = RenderSession::default();
    let mut rendered = Vec::with_capacity(selected.len());
    for position in selected {
        let Some(page) = pages.get(position) else {
            continue;
        };
        let list = render_page(&document, page, scale, limits, &mut session)?;
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

fn render_page(
    document: &Document<'_>,
    page: &Page,
    scale: f64,
    limits: &Limits,
    session: &mut RenderSession,
) -> Outcome<DisplayList> {
    let content = document.content(page).unwrap_or_default();
    let resources = Rc::new(Object::Dict(page.resources.clone()));
    let frame = Frame {
        base: IDENTITY,
        resources,
    };
    let mut renderer = Renderer {
        active: Vec::new(),
        budget: limits.max_decoded_stream_bytes,
        decoded: String::new(),
        document,
        emitted: Emitted::default(),
        emitted_stack: Vec::new(),
        glyph_ids: HashMap::new(),
        glyphs: Vec::new(),
        images: HashMap::new(),
        limits,
        list: DisplayList::default(),
        next_glyph: 0,
        operators: 0,
        scale,
        session,
        truncated: false,
    };
    let mut state = GState::initial();
    renderer.save();
    renderer.run(&content, &frame, &mut state, 0)?;
    renderer.restore();
    renderer.annotations(page, &frame)?;
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
                    let _alpha = reader.u8();
                    let blob = u32::try_from(reader.u32()).unwrap();
                    let width = u32::try_from(reader.u32()).unwrap();
                    let height = u32::try_from(reader.u32()).unwrap();
                    let _mask = reader.take(12);
                    let _matte = reader.take(4);
                    Op::Image(flags & 1 == 1, blob, width, height)
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
        let pages = render_pages(bytes, None, 2.0, limits).unwrap();
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
            None,
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
        let _invalid =
            render_pages(b"%PDF-1.7 garbage", None, 1.0, &Limits::default()).unwrap_err();
        let _scale =
            render_pages(&page_pdf("<< >>", "", &[]), None, 0.0, &Limits::default()).unwrap_err();
        let _range = render_pages(
            &page_pdf("<< >>", "", &[]),
            Some(&[3]),
            1.0,
            &Limits::default(),
        )
        .unwrap_err();
    }

    #[test]
    fn page_view_intersects_crop_and_media_boxes() {
        let bytes = include_bytes!("../../__tests__/fixtures/rotated-cropped.pdf");
        let pages = render_pages(bytes, None, 1.0, &Limits::default()).unwrap();
        assert_eq!(pages.len(), 2);
        for rendered in &pages {
            let [x0, y0, x1, y1] = rendered.view;
            assert!(x1 > x0 && y1 > y0);
        }
        assert!(pages.iter().any(|rendered| rendered.rotate != 0_i32));
    }
}
