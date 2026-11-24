use crate::diagnostics::PageScan;
use crate::display::{Matrix, multiply};
use crate::num::f64_to_i64;
use crate::num::widen;
use alloc::rc::Rc;
use core::mem;
use core::ops::Range;
use std::collections::{HashMap, HashSet};

use crate::document::{Document, Page, Transient};
use crate::failure::{Failure, FailureCode, Outcome};
use crate::font::{Font, Glyph, embedded_style, push_piece};
use crate::fontprog::FontStyle;
use crate::inspection::{Limits, TextItem};
use crate::object::{Dict, ObjRef, Object, Resolver as _};
use crate::syntax::{ContentLexer, ContentToken, Operand};

const IDENTITY: Matrix = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

const MAX_OPERANDS: usize = 512;
const MAX_FORM_DEPTH: usize = 24;
const MAX_CACHED_FONTS: usize = 32;
const FONT_HORIZON: u32 = 2;
const MAX_CACHED_FORM_BYTES: usize = 16 << 20;
const MAX_CACHED_FORM_ENTRY_BYTES: usize = 1 << 20;
const SPACE_GAP: f64 = 0.2;
const MIN_SPACE_GAP: f64 = 0.1;
const SPACE_WIDTH_SHARE: f64 = 0.5;
const BREAK_GAP: f64 = 1.5;
const BACK_GAP: f64 = 0.4;
const BASELINE_TOLERANCE: f64 = 0.3;
const SIZE_TOLERANCE: f64 = 0.1;
const DIRECTION_COSINE: f64 = 0.9999;
const MIN_SCALE: f64 = 1e-9;
const DEFAULT_ASCENT: f64 = 0.945;
const DEFAULT_DESCENT: f64 = 0.224;
const BOLD_ASCENT: f64 = 0.962;
const BOLD_DESCENT: f64 = 0.227;
const OP_SAVE: u32 = op(b"q");

const OP_RESTORE: u32 = op(b"Q");

const OP_CM: u32 = op(b"cm");
const OP_BT: u32 = op(b"BT");
const OP_TC: u32 = op(b"Tc");
const OP_TW: u32 = op(b"Tw");
const OP_TZ: u32 = op(b"Tz");
const OP_TL: u32 = op(b"TL");
const OP_TF: u32 = op(b"Tf");
const OP_TS: u32 = op(b"Ts");
const OP_TR: u32 = op(b"Tr");
const OP_TD: u32 = op(b"Td");
const OP_TD_LEADING: u32 = op(b"TD");
const OP_TM: u32 = op(b"Tm");
const OP_TSTAR: u32 = op(b"T*");
const OP_TJ: u32 = op(b"Tj");
const OP_TJ_ARRAY: u32 = op(b"TJ");
const OP_QUOTE: u32 = op(b"'");
const OP_DQUOTE: u32 = op(b"\"");
const OP_DO: u32 = op(b"Do");
const OP_END_IMAGE: u32 = op(b"EI");
const OP_GS: u32 = op(b"gs");
const OP_LINE_WIDTH: u32 = op(b"w");
const OP_MOVE: u32 = op(b"m");
const OP_LINE: u32 = op(b"l");
const OP_RECT: u32 = op(b"re");
const OP_CLOSE: u32 = op(b"h");
const OP_CURVE: u32 = op(b"c");
const OP_CURVE_V: u32 = op(b"v");
const OP_CURVE_Y: u32 = op(b"y");
const OP_STROKE: u32 = op(b"S");
const OP_CLOSE_STROKE: u32 = op(b"s");
const OP_FILL: u32 = op(b"f");
const OP_FILL_OLD: u32 = op(b"F");
const OP_FILL_EO: u32 = op(b"f*");
const OP_FILL_STROKE: u32 = op(b"B");
const OP_FILL_STROKE_EO: u32 = op(b"B*");
const OP_CLOSE_FILL_STROKE: u32 = op(b"b");
const OP_CLOSE_FILL_STROKE_EO: u32 = op(b"b*");
const OP_NO_PAINT: u32 = op(b"n");
const OP_BMC: u32 = op(b"BMC");
const OP_BDC: u32 = op(b"BDC");
const OP_EMC: u32 = op(b"EMC");
const AXIS_TOLERANCE: f64 = 1.0;
const MIN_RULING: f64 = 2.0;

const THIN_FILL: f64 = 2.0;

const FRAME_FRACTION: f64 = 0.9;

const FORCE_BOLD: i64 = 1 << 18;

const ITALIC_FLAG: i64 = 1 << 6;

const ITALIC_ANGLE: f64 = 4.0;

#[derive(PartialEq, Eq)]
enum Shows {
    Forms,
    Nothing,
    Text,
}

pub(crate) trait Numeric {
    fn number(&self) -> Option<f64>;
}

impl Numeric for Object {
    fn number(&self) -> Option<f64> {
        self.as_number()
    }
}

impl Numeric for Operand<'_> {
    fn number(&self) -> Option<f64> {
        self.as_number()
    }
}
#[derive(Default)]
struct PathBuilder {
    current: Option<(f64, f64)>,
    rects: Vec<[f64; 4]>,
    segments: Vec<[f64; 4]>,
    start: Option<(f64, f64)>,
}
impl PathBuilder {
    fn clear(&mut self) {
        self.segments.clear();
        self.rects.clear();
        self.start = None;
        self.current = None;
    }

    fn close(&mut self, cap: usize) {
        if let (Some(start), Some(current)) = (self.start, self.current)
            && start != current
        {
            self.line_to(start, cap);
        }
        self.current = self.start;
    }

    fn line_to(&mut self, point: (f64, f64), cap: usize) {
        if let Some((x, y)) = self.current
            && self.segments.len() < cap
        {
            self.segments.push([x, y, point.0, point.1]);
        }
        self.current = Some(point);
        if self.start.is_none() {
            self.start = Some(point);
        }
    }

    const fn move_current(&mut self, point: (f64, f64)) {
        self.current = Some(point);
        if self.start.is_none() {
            self.start = Some(point);
        }
    }

    const fn move_to(&mut self, point: (f64, f64)) {
        self.start = Some(point);
        self.current = Some(point);
    }

    fn rect(&mut self, ctm: &Matrix, rect: [f64; 4], cap: usize) {
        let [x, y, width, height] = rect;
        self.move_to(apply(ctm, x, y));
        if self.rects.len() >= cap || !axis_aligned(ctm) {
            return;
        }
        let corner_a = apply(ctm, x, y);
        let corner_b = apply(ctm, x + width, y + height);
        self.rects.push([
            corner_a.0.min(corner_b.0),
            corner_a.1.min(corner_b.1),
            corner_a.0.max(corner_b.0),
            corner_a.1.max(corner_b.1),
        ]);
    }
}
struct Placement {
    direction: (f64, f64),
    effective_size: f64,
    line: [f64; 4],
    linear: [f64; 4],
    usable: bool,
    vertical: bool,
}
impl Placement {
    fn new(entry: &FontEntry, state: &GState, tm: &Matrix) -> Self {
        let [a1, b1, c1, d1, _, _] = *tm;
        let [a2, b2, c2, d2, _, _] = state.ctm;
        let a = a1 * a2 + b1 * c2;
        let b = a1 * b2 + b1 * d2;
        let c = c1 * a2 + d1 * c2;
        let d = c1 * b2 + d1 * d2;
        let vertical = entry.font.is_vertical();
        let (dir_x, dir_y) = if vertical { (-c, -d) } else { (a, b) };
        let dir_length = (dir_x * dir_x + dir_y * dir_y).sqrt();
        let effective_size = (state.size * (c * c + d * d).sqrt()).abs();
        let line = rows(
            &[a, b, c, d, 0.0_f64, 0.0_f64],
            state.rise - entry.descent * state.size,
            state.rise + entry.ascent * state.size,
        );
        Self {
            line,
            linear: [a, b, c, d],
            direction: (dir_x / dir_length, dir_y / dir_length),
            effective_size,
            usable: dir_length > MIN_SCALE
                && effective_size > MIN_SCALE
                && dir_length.is_finite()
                && effective_size.is_finite(),
            vertical,
        }
    }
}
struct FontEntry {
    ascent: f64,
    bold: bool,
    descent: f64,
    font: Font,
    italic: bool,
    space_gap: f64,
}
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum FontKey {
    Indirect(ObjRef),
    Inline(u32, u32),
    Within(ObjRef, u32),
}

#[derive(Clone)]
struct GState {
    char_space: f64,
    ctm: Matrix,
    font: Option<Rc<FontEntry>>,
    invisible_text: bool,
    leading: f64,
    line_width: f64,
    rise: f64,
    scale: f64,
    size: f64,
    stroked_fill: bool,
    word_space: f64,
}

impl GState {
    const fn initial() -> Self {
        Self {
            ctm: IDENTITY,
            font: None,
            size: 0.0,
            char_space: 0.0,
            word_space: 0.0,
            scale: 1.0,
            leading: 0.0,
            rise: 0.0,
            line_width: 1.0,
            stroked_fill: false,
            invisible_text: false,
        }
    }
}

#[derive(Clone, Copy)]
struct TextMatrices {
    tlm: Matrix,
    tm: Matrix,
}

impl TextMatrices {
    fn line_move(&mut self, tx: f64, ty: f64) {
        self.tlm = multiply(&[1.0_f64, 0.0_f64, 0.0_f64, 1.0_f64, tx, ty], &self.tlm);
        self.tm = self.tlm;
    }

    fn translate(&mut self, tx: f64, ty: f64) {
        let [a, b, c, d, e, f] = self.tm;
        self.tm = [a, b, c, d, e + tx * a + ty * c, f + tx * b + ty * d];
    }
}

enum Lazy {
    Found(Rc<Object>),
    Missing,
    Unset,
}

struct Scope {
    ext_gstates: Lazy,
    fonts: Lazy,
    fonts_origin: Option<ObjRef>,
    forms: Option<bool>,
    id: u32,
    origin: Option<ObjRef>,
    resources: Rc<Object>,
    xobjects: Lazy,
}

impl Scope {
    fn category(&mut self, document: &Document<'_>, key: &[u8]) -> Option<Rc<Object>> {
        let slot = if key == b"Font" {
            &mut self.fonts
        } else if key == b"ExtGState" {
            &mut self.ext_gstates
        } else {
            &mut self.xobjects
        };
        if matches!(slot, Lazy::Unset) {
            let entry = self.resources.as_dict().and_then(|dict| dict.get(key));
            if key == b"Font"
                && let Some(Object::Ref(reference)) = entry
            {
                self.fonts_origin = Some(*reference);
            }
            let found = entry
                .and_then(|resolved_entry| document.follow(resolved_entry).ok())
                .filter(|resolved| resolved.as_dict().is_some());
            *slot = found.map_or(Lazy::Missing, Lazy::Found);
        }
        match slot {
            Lazy::Found(resolved) => Some(Rc::clone(resolved)),
            Lazy::Missing | Lazy::Unset => None,
        }
    }

    fn has_forms(&mut self, document: &Document<'_>) -> bool {
        if let Some(known) = self.forms {
            return known;
        }
        let found = self.category(document, b"XObject").is_some_and(|xobjects| {
            xobjects.as_dict().is_some_and(|dict| {
                dict.entries.iter().any(|(_, entry)| {
                    let before = document.pending_reads();
                    let is_form = document.follow(entry).is_ok_and(|resolved| {
                        resolved.as_stream().is_some_and(|stream| {
                            stream
                                .dict
                                .get(b"Subtype")
                                .and_then(Object::as_name)
                                .is_some_and(|subtype| subtype == b"Form")
                        })
                    });
                    is_form || document.pending_reads() != before
                })
            })
        });
        self.forms = Some(found);
        found
    }

    const fn new(id: u32, resources: Rc<Object>, origin: Option<ObjRef>) -> Self {
        Self {
            id,
            resources,
            origin,
            fonts_origin: None,
            fonts: Lazy::Unset,
            xobjects: Lazy::Unset,
            ext_gstates: Lazy::Unset,
            forms: None,
        }
    }
}

struct Shown<'shown> {
    decoded: &'shown mut String,
    entry: &'shown FontEntry,
    glyphs: &'shown mut Vec<Glyph>,
    placement: &'shown Placement,
}

#[derive(Clone, Copy)]
struct ShowContext<'ops, 'data> {
    depth: usize,
    operands: &'ops [Operand<'data>],
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Join {
    Closed,
    Same,
    Spaced,
    Split,
}

struct PendingRun {
    bold: bool,
    bounds: [f64; 4],
    dir: (f64, f64),
    end: (f64, f64),
    ink_end: (f64, f64),
    italic: bool,
    open: bool,
    size: f64,
    text: String,
}

impl Default for PendingRun {
    fn default() -> Self {
        Self {
            open: false,
            text: String::new(),
            bounds: [0.0; 4],
            size: 0.0,
            dir: (1.0, 0.0),
            end: (0.0, 0.0),
            ink_end: (0.0, 0.0),
            bold: false,
            italic: false,
        }
    }
}

struct Interpreter<'doc, 'data, 'scan> {
    active: Vec<ObjRef>,
    actual: Option<String>,
    actual_emitted: bool,
    budget: usize,
    capture: Capture,
    clip: Option<[f64; 4]>,
    decoded: String,
    document: &'doc Document<'data>,
    fonts: FontCache,
    forms: FormCache,
    generation: u32,
    glyphs: Vec<Glyph>,
    items: Vec<Run>,
    limits: &'doc Limits,
    max_depth: usize,
    page_extent: (f64, f64),
    pending: PendingRun,
    repositioned: bool,
    ruling_cap: usize,
    rulings: Vec<Ruling>,
    scan: Option<&'scan mut PageScan>,
    scopes: u32,
    skipped: HashSet<ObjRef>,
    text: String,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Run {
    pub bold: bool,
    pub direction: (f64, f64),
    pub font_size: f64,
    pub italic: bool,
    pub rect: [f64; 4],
    pub text: Range<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Ruling {
    pub width: f64,
    pub x0: f64,
    pub x1: f64,
    pub y0: f64,
    pub y1: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum Reposition {
    #[default]
    Join,
    Split,
    SplitGapped,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Capture {
    pub reposition: Reposition,
    pub split_style: bool,
    pub structure: bool,
}

#[derive(Debug, Default)]
pub(crate) struct PageContent {
    pub rulings: Vec<Ruling>,
    pub runs: Vec<Run>,
    pub text: String,
}

impl PageContent {
    pub(crate) fn items(&self) -> Vec<TextItem> {
        self.runs
            .iter()
            .map(|run| TextItem {
                rect: run.rect,
                font_size: run.font_size,
                style: u8::from(run.bold) | (u8::from(run.italic) << 1_u8),
                text: self.text_of(run).to_owned(),
            })
            .collect()
    }

    pub(crate) fn text_of(&self, run: &Run) -> &str {
        self.text
            .get(widen(run.text.start)..widen(run.text.end))
            .unwrap_or_default()
    }
}

type FontCache = HashMap<FontKey, (Option<Rc<FontEntry>>, u32)>;

#[derive(Default)]
struct FormCache {
    bytes: usize,
    entries: HashMap<ObjRef, (Rc<[u8]>, u32)>,
}

impl FormCache {
    fn get(&mut self, reference: ObjRef, generation: u32) -> Option<Rc<[u8]>> {
        let (data, used) = self.entries.get_mut(&reference)?;
        *used = generation;
        Some(Rc::clone(data))
    }

    fn insert(&mut self, reference: ObjRef, data: &Rc<[u8]>, generation: u32) {
        let fits = |bytes: usize| bytes.saturating_add(data.len()) <= MAX_CACHED_FORM_BYTES;
        if !fits(self.bytes) {
            let previous = generation.wrapping_sub(1);
            self.entries
                .retain(|_, (_, used)| *used == generation || *used == previous);
            self.bytes = self
                .entries
                .values()
                .fold(0, |sum, (cached, _)| sum.saturating_add(cached.len()));
        }
        if fits(self.bytes) {
            self.bytes = self.bytes.saturating_add(data.len());
            drop(
                self.entries
                    .insert(reference, (Rc::clone(data), generation)),
            );
        }
    }
}

#[derive(Default)]
pub(crate) struct Session {
    fonts: FontCache,
    forms: FormCache,
    generation: u32,
    scopes: u32,
    skipped: HashSet<ObjRef>,
}

impl Interpreter<'_, '_, '_> {
    fn apply_ext_gstate(
        &mut self,
        operands: &[Operand<'_>],
        scope: &mut Scope,
        state: &mut GState,
    ) {
        let Some(key) = operands.last().and_then(Operand::as_name) else {
            return;
        };
        let Some(ext) = scope.category(self.document, b"ExtGState") else {
            return;
        };
        let Some(dict) = ext.as_dict() else {
            return;
        };
        let Some(entry) = dict.entries.iter().find(|(name, _)| name.as_slice() == key) else {
            return;
        };
        let Ok(resolved) = self.document.follow(&entry.1) else {
            return;
        };
        let Some(gs) = resolved.as_dict() else {
            return;
        };
        if let Some(Object::Array(items)) = gs.get(b"Font") {
            let name = items
                .len()
                .checked_sub(2)
                .and_then(|index| items.get(index))
                .and_then(Object::as_name);
            let size = items.last().and_then(Object::as_number);
            self.set_font(name, size, scope, state);
        }
    }

    fn begin(
        &mut self,
        text: &str,
        bounds: [f64; 4],
        size: f64,
        direction: (f64, f64),
        end: (f64, f64),
        style: (bool, bool),
    ) {
        self.pending.open = true;
        self.pending.bold = style.0;
        self.pending.italic = style.1;
        self.pending.text.clear();
        push_piece(&mut self.pending.text, text);
        self.pending.bounds = bounds;
        self.pending.size = size;
        self.pending.dir = direction;
        self.pending.end = end;
        self.pending.ink_end = end;
    }

    fn descendant(&self, font: &Dict) -> Option<Rc<Object>> {
        let array = self
            .document
            .follow_transient(font.get(b"DescendantFonts")?)
            .ok()?;
        let first = array.as_array()?.first()?;
        self.document.follow_transient(first).ok()
    }

    fn descriptor_metrics(&self, descriptor: &Object) -> Option<(f64, f64)> {
        let resolved = self.document.follow_transient(descriptor).ok()?;
        let dict = resolved.as_dict()?;
        let ascent = dict.get(b"Ascent").and_then(Object::as_number)? / 1_000.0_f64;
        let descent = dict.get(b"Descent").and_then(Object::as_number)?.abs() / 1_000.0_f64;
        ((0.2..=2.0).contains(&ascent) && (0.0..=1.0).contains(&descent))
            .then_some((ascent, descent))
    }

    fn descriptor_style(&self, font: &Dict) -> FontStyle {
        let Some(descriptor) = font
            .get(b"FontDescriptor")
            .and_then(|descriptor| self.document.follow_transient(descriptor).ok())
        else {
            return FontStyle::default();
        };
        let Some(dict) = descriptor.as_dict() else {
            return FontStyle::default();
        };
        let flags = dict
            .get(b"Flags")
            .and_then(Object::as_number)
            .map_or(0, f64_to_i64);
        let heavy = dict
            .get(b"FontWeight")
            .and_then(Object::as_number)
            .is_some_and(|weight| weight >= 600.0_f64);
        let slanted = dict
            .get(b"ItalicAngle")
            .and_then(Object::as_number)
            .is_some_and(|angle| angle.abs() >= ITALIC_ANGLE);
        FontStyle {
            bold: flags & FORCE_BOLD != 0 || heavy,
            italic: flags & ITALIC_FLAG != 0 || slanted,
        }
    }

    fn diagnose_glyph(
        &mut self,
        extracted: &str,
        spanned: bool,
        bounds: Option<[f64; 4]>,
        invisible: bool,
    ) {
        if let Some(scan) = self.scan.as_deref_mut() {
            scan.glyph(extracted, spanned, bounds, invisible);
        }
    }

    fn do_xobject(
        &mut self,
        name: &[u8],
        scope: &mut Scope,
        state: &GState,
        matrices: &TextMatrices,
        depth: usize,
    ) -> Outcome<()> {
        if depth >= self.max_depth {
            return Ok(());
        }
        let Some(xobjects) = scope.category(self.document, b"XObject") else {
            return Ok(());
        };
        let Some(entry) = xobjects.as_dict().and_then(|dict| dict.get(name)) else {
            return Ok(());
        };
        let reference = if let Object::Ref(reference) = entry {
            Some(*reference)
        } else {
            None
        };
        if let Some(inner_reference) = reference
            && (self.skipped.contains(&inner_reference) || self.active.contains(&inner_reference))
        {
            return Ok(());
        }
        let Ok(resolved) = self.document.follow_transient(entry) else {
            return Ok(());
        };
        let Object::Stream(stream) = &*resolved else {
            return Ok(());
        };
        let subtype = stream.dict.get(b"Subtype").and_then(Object::as_name);
        if subtype != Some(b"Form") {
            match (self.scan.as_deref_mut(), reference) {
                (Some(scan), _) if subtype == Some(b"Image") => {
                    scan.image(
                        transformed_bounds(&state.ctm, 0.0_f64, 0.0_f64, 1.0_f64, 1.0_f64),
                        self.clip,
                    );
                }
                (None, Some(inner_reference)) => {
                    let _: bool = self.skipped.insert(inner_reference);
                }
                _ => {}
            }
            return Ok(());
        }
        let cached = reference.and_then(|known| self.forms.get(known, self.generation));
        let (shared, owned): (Option<Rc<[u8]>>, Vec<u8>) = match cached {
            Some(data) => (Some(data), Vec::new()),
            None => match self.document.stream_data(stream) {
                Ok(data) => match reference {
                    Some(known) if self.scan.is_none() && scan_shows(&data) == Shows::Nothing => {
                        let _: bool = self.skipped.insert(known);
                        (None, data)
                    }
                    Some(known) if data.len() <= MAX_CACHED_FORM_ENTRY_BYTES => {
                        let shared_data: Rc<[u8]> = data.into();
                        self.forms.insert(known, &shared_data, self.generation);
                        (Some(shared_data), Vec::new())
                    }
                    Some(_) | None => (None, data),
                },
                Err(failure) if failure.code == FailureCode::LimitExceeded => return Err(failure),
                Err(_) => return Ok(()),
            },
        };
        let data: &[u8] = shared.as_deref().unwrap_or(&owned);
        let form_matrix = matrix_from(stream.dict.get(b"Matrix")).unwrap_or(IDENTITY);
        let own = stream.dict.get(b"Resources");
        let (resources, origin) = match own
            .and_then(|object| self.document.follow(object).ok())
            .filter(|object| object.as_dict().is_some())
        {
            Some(resources) => (
                resources,
                match own {
                    Some(Object::Ref(own_ref)) => Some(*own_ref),
                    _ => None,
                },
            ),
            None => (Rc::clone(&scope.resources), scope.origin),
        };
        let mut inner_scope = Scope::new(self.next_scope(), resources, origin);
        let mut inner_state = state.clone();
        inner_state.ctm = multiply(&form_matrix, &state.ctm);
        let outer_clip = self.clip;
        if self.capture.structure
            && let Some(bounds) = stream
                .dict
                .get(b"BBox")
                .and_then(Object::as_array)
                .filter(|items| items.len() == 4)
                .and_then(tail_numbers::<4, _>)
                .map(|[x0, y0, x1, y1]| [x0.min(x1), y0.min(y1), x0.max(x1), y0.max(y1)])
                .filter(|[x0, y0, x1, y1]| x1 - x0 > 0.0_f64 && y1 - y0 > 0.0_f64)
        {
            let [x0, y0, x1, y1] =
                transformed_bounds(&inner_state.ctm, bounds[0], bounds[1], bounds[2], bounds[3]);
            self.clip = Some(outer_clip.map_or([x0, y0, x1, y1], |outer| {
                [
                    outer[0].max(x0),
                    outer[1].max(y0),
                    outer[2].min(x1),
                    outer[3].min(y1),
                ]
            }));
        }
        let mut inner_matrices = *matrices;
        if let Some(inner_reference) = reference {
            self.active.push(inner_reference);
        }
        let result = self.run(
            data,
            &mut inner_scope,
            &mut inner_state,
            &mut inner_matrices,
            depth.saturating_add(1),
        );
        if reference.is_some() {
            let _: Option<ObjRef> = self.active.pop();
        }
        self.clip = outer_clip;
        result
    }

    fn extend(&mut self, text: &str, visible: bool, spaced: bool) {
        if spaced && visible {
            let tail_space = self
                .pending
                .text
                .chars()
                .next_back()
                .is_none_or(char::is_whitespace);
            let head_space = text.chars().next().is_none_or(char::is_whitespace);
            if !tail_space && !head_space {
                self.pending.text.push(' ');
            }
        }
        push_piece(&mut self.pending.text, text);
    }

    fn flush(&mut self) -> Outcome<()> {
        if !self.pending.open {
            return Ok(());
        }
        self.pending.open = false;
        let trimmed = self.pending.text.trim();
        if trimmed.is_empty() {
            self.pending.text.clear();
            return Ok(());
        }
        if self.items.len() >= self.limits.max_items_per_page {
            return Err(Failure::limit("page text items exceed limit"));
        }
        let start = self.text.len();
        let end = start.saturating_add(trimmed.len());
        if end > self.limits.max_text_bytes {
            return Err(Failure::limit("page text bytes exceed limit"));
        }
        let (Ok(from), Ok(to)) = (u32::try_from(start), u32::try_from(end)) else {
            return Err(Failure::limit("page text exceeds 32-bit offsets"));
        };
        self.text.push_str(trimmed);
        self.pending.text.clear();
        self.items.push(Run {
            rect: self.pending.bounds,
            font_size: self.pending.size,
            text: from..to,
            direction: self.pending.dir,
            bold: self.pending.bold,
            italic: self.pending.italic,
        });
        Ok(())
    }

    fn font_style(&self, font: &Dict, loaded: &Font) -> FontStyle {
        let descendant = self.descendant(font);
        let nested = descendant.as_deref().and_then(Object::as_dict);
        let names = [Some(font), nested]
            .into_iter()
            .flatten()
            .filter_map(|dict| dict.get(b"BaseFont").and_then(Object::as_name));
        let mut style = loaded.program_style().unwrap_or_else(|| {
            if !self.capture.split_style {
                return FontStyle::default();
            }
            [nested, Some(font)]
                .into_iter()
                .flatten()
                .filter_map(|dict| dict.get(b"FontDescriptor"))
                .filter_map(|descriptor| self.document.follow_transient(descriptor).ok())
                .find_map(|descriptor| {
                    let dict = descriptor.as_dict()?;
                    embedded_style(dict, &Transient(self.document), self.limits)
                })
                .unwrap_or_default()
        });
        for name in names {
            style.bold |= is_bold_name(name);
            style.italic |= is_italic_name(name);
        }
        for dict in [Some(font), nested].into_iter().flatten() {
            let described = self.descriptor_style(dict);
            style.bold |= described.bold;
            style.italic |= described.italic;
        }
        style
    }

    fn join(&self, origin: (f64, f64), direction: (f64, f64), size: f64, space_gap: f64) -> Join {
        if !self.pending.open {
            return Join::Closed;
        }
        let dx = origin.0 - self.pending.end.0;
        let dy = origin.1 - self.pending.end.1;
        let (ux, uy) = self.pending.dir;
        let along = dx * ux + dy * uy;
        let across = dy * ux - dx * uy;
        let aligned = direction.0 * ux + direction.1 * uy > DIRECTION_COSINE;
        let similar =
            (size - self.pending.size).abs() <= SIZE_TOLERANCE * self.pending.size.max(size);
        let on_line = across.abs() <= BASELINE_TOLERANCE * size;
        let near = along >= -BACK_GAP * size && along <= BREAK_GAP * size;
        if aligned && similar && on_line && near {
            if along > space_gap * size {
                Join::Spaced
            } else {
                Join::Same
            }
        } else {
            Join::Split
        }
    }

    fn load_font(&self, object: &Object) -> Option<Rc<FontEntry>> {
        let resolved = self.document.follow_transient(object).ok()?;
        let dict = resolved.as_dict()?;
        let font = Font::load(&Transient(self.document), dict, self.limits).ok()?;
        let (ascent, descent) = self.vertical_metrics(dict);
        let FontStyle { bold, italic } = self.font_style(dict, &font);
        let space_gap = space_gap(&font);
        Some(Rc::new(FontEntry {
            ascent,
            bold,
            descent,
            font,
            italic,
            space_gap,
        }))
    }

    fn lookup_font(&mut self, scope: &mut Scope, name: &[u8]) -> Option<Rc<FontEntry>> {
        let fonts = scope.category(self.document, b"Font")?;
        let dict = fonts.as_dict()?;
        let (index, (_, entry)) = dict
            .entries
            .iter()
            .enumerate()
            .find(|(_, (key, _))| key.as_slice() == name)?;
        let index_u32 = u32::try_from(index).ok()?;
        let key = match (entry, scope.fonts_origin.or(scope.origin)) {
            (Object::Ref(reference), _) => FontKey::Indirect(*reference),
            (_, Some(origin)) => FontKey::Within(origin, index_u32),
            (_, None) => FontKey::Inline(scope.id, index_u32),
        };
        if let Some((hit, used)) = self.fonts.get_mut(&key) {
            *used = self.generation;
            return hit.clone();
        }
        let loaded = self.load_font(entry);
        drop(self.fonts.insert(key, (loaded.clone(), self.generation)));
        loaded
    }

    fn marked_content(
        &mut self,
        code: u32,
        operands: &[Operand<'_>],
        marked: &mut Vec<bool>,
        max_stack: usize,
    ) {
        if !self.capture.structure {
            return;
        }
        match code {
            OP_BMC if marked.len() < max_stack => marked.push(false),
            OP_BDC => {
                let replacement = if self.actual.is_none() {
                    actual_text(operands)
                } else {
                    None
                };
                if marked.len() < max_stack {
                    marked.push(replacement.is_some());
                    if replacement.is_some() {
                        self.actual = replacement;
                        self.actual_emitted = false;
                    }
                }
            }
            OP_EMC if marked.pop() == Some(true) => self.actual = None,
            _ => {}
        }
    }

    const fn merge_bounds(&mut self, bounds: [f64; 4]) {
        let [x0, y0, x1, y1] = bounds;
        let [ox0, oy0, ox1, oy1] = &mut self.pending.bounds;
        *ox0 = ox0.min(x0);
        *oy0 = oy0.min(y0);
        *ox1 = ox1.max(x1);
        *oy1 = oy1.max(y1);
    }

    const fn next_scope(&mut self) -> u32 {
        self.scopes = self.scopes.wrapping_add(1);
        self.scopes
    }

    fn paint(&mut self, path: &mut PathBuilder, state: &GState, stroke: bool) {
        let [a, b, c, d, _, _] = state.ctm;
        let width = state.line_width.abs() * (a * d - b * c).abs().sqrt();
        let (page_width, page_height) = self.page_extent;
        for rect in &path.rects {
            let [x0, y0, x1, y1] = *rect;
            let frame =
                x1 - x0 >= FRAME_FRACTION * page_width && y1 - y0 >= FRAME_FRACTION * page_height;
            if frame {
                continue;
            }
            if stroke {
                self.push_ruling([x0, y0, x1, y0], width);
                self.push_ruling([x0, y1, x1, y1], width);
                self.push_ruling([x0, y0, x0, y1], width);
                self.push_ruling([x1, y0, x1, y1], width);
            } else {
                let (span_x, span_y) = (x1 - x0, y1 - y0);
                let thin = span_x.min(span_y) <= THIN_FILL && span_x.max(span_y) >= MIN_RULING;
                if thin && span_x >= span_y {
                    self.push_ruling(
                        [x0, f64::midpoint(y0, y1), x1, f64::midpoint(y0, y1)],
                        span_y,
                    );
                } else if thin {
                    self.push_ruling(
                        [f64::midpoint(x0, x1), y0, f64::midpoint(x0, x1), y1],
                        span_x,
                    );
                }
            }
        }
        if stroke {
            for segment in &path.segments {
                self.push_ruling(*segment, width);
            }
        }
        path.clear();
    }

    fn paint_operator(
        &mut self,
        code: u32,
        operands: &[Operand<'_>],
        state: &GState,
        path: &mut PathBuilder,
        curves: &mut u32,
    ) -> bool {
        let Some(scan) = self.scan.as_deref_mut() else {
            return self.path_operator(code, operands, state, path);
        };
        graphics(scan, code, curves)
    }

    fn path_operator(
        &mut self,
        code: u32,
        operands: &[Operand<'_>],
        state: &GState,
        path: &mut PathBuilder,
    ) -> bool {
        if !self.capture.structure {
            return false;
        }
        match code {
            OP_MOVE => {
                if let Some([x, y]) = tail_numbers::<2, _>(operands) {
                    path.move_to(apply(&state.ctm, x, y));
                }
            }
            OP_LINE => {
                if let Some([x, y]) = tail_numbers::<2, _>(operands) {
                    path.line_to(apply(&state.ctm, x, y), self.ruling_cap);
                }
            }
            OP_CURVE | OP_CURVE_V | OP_CURVE_Y => {
                if let Some([x, y]) = tail_numbers::<2, _>(operands) {
                    path.move_current(apply(&state.ctm, x, y));
                }
            }
            OP_RECT => {
                if let Some([x, y, width, height]) = tail_numbers::<4, _>(operands) {
                    path.rect(&state.ctm, [x, y, width, height], self.ruling_cap);
                }
            }
            OP_CLOSE => path.close(self.ruling_cap),
            OP_NO_PAINT => path.clear(),
            OP_STROKE | OP_FILL_STROKE | OP_FILL_STROKE_EO => self.paint(path, state, true),
            OP_CLOSE_STROKE | OP_CLOSE_FILL_STROKE | OP_CLOSE_FILL_STROKE_EO => {
                path.close(self.ruling_cap);
                self.paint(path, state, true);
            }
            OP_FILL | OP_FILL_OLD | OP_FILL_EO => self.paint(path, state, false),
            _ => return false,
        }
        true
    }

    fn place<const DIAGNOSTICS: bool>(
        &mut self,
        entry: &FontEntry,
        placement: &Placement,
        state: &GState,
        matrices: &mut TextMatrices,
        glyphs: &[Glyph],
        decoded: &str,
    ) -> Outcome<()> {
        let mut repositioned = mem::take(&mut self.repositioned);
        let [a, b, c, d] = placement.linear;
        let [_, _, _, _, e1, f1] = matrices.tm;
        let [a2, b2, c2, d2, e2, f2] = state.ctm;
        let e = e1 * a2 + f1 * c2 + e2;
        let f = e1 * b2 + f1 * d2 + f2;
        let mapping = [a, b, c, d, e, f];
        let size = state.size;
        let scale = state.scale;
        let vertical = placement.vertical;
        let usable = placement.usable;
        let direction = placement.direction;
        let effective_size = placement.effective_size;
        let mut pen_x = 0.0_f64;
        let mut pen_y = 0.0_f64;
        let rise = state.rise;
        let at = |x: f64, y: f64| (x * a + (y + rise) * c + e, x * b + (y + rise) * d + f);
        let mut origin = at(pen_x, pen_y);
        let line = placement.line;
        let style = (entry.bold || state.stroked_fill, entry.italic);
        for glyph in glyphs {
            let replacement = match self.actual.as_ref() {
                Some(text) if !self.actual_emitted => Some(text.clone()),
                _ => None,
            };
            if replacement.is_some() {
                self.actual_emitted = true;
            }
            let spanned = self.actual.is_some();
            let glyph_text = match replacement.as_deref() {
                Some(text) => text,
                None if spanned => "",
                None => decoded.get(glyph.text.clone()).unwrap_or_default(),
            };
            let spacing = state.char_space
                + if glyph.is_word_space {
                    state.word_space
                } else {
                    0.0_f64
                };
            let (bounds, step_x, step_y);
            if vertical {
                let metrics = entry.font.vertical_metrics(glyph.code);
                let span = metrics.advance * size;
                let em = size.abs() * scale;
                let x0 = pen_x - metrics.origin_x * em;
                let y1 = pen_y + rise;
                bounds = spans(
                    &mapping,
                    x0,
                    x0 + glyph.advance * em,
                    rows(&mapping, y1 - span, y1),
                );
                step_x = 0.0_f64;
                step_y = -span + spacing;
            } else {
                let width = glyph.advance * size * scale;
                bounds = spans(&mapping, pen_x, pen_x + width, line);
                step_x = width + spacing * scale;
                step_y = 0.0_f64;
            }
            let end = at(pen_x + step_x, pen_y + step_y);
            let in_form = usable && !self.clip.is_some_and(|clip| outside(bounds, clip));
            if DIAGNOSTICS {
                self.diagnose_glyph(
                    glyph_text,
                    spanned,
                    in_form.then_some(bounds),
                    state.invisible_text,
                );
            } else if in_form {
                let visible = spanned || glyph_text.chars().any(|ch| !ch.is_whitespace());
                let mut join = self.join(origin, direction, effective_size, entry.space_gap);
                if repositioned
                    && matches!(join, Join::Same | Join::Spaced)
                    && match self.capture.reposition {
                        Reposition::Join => false,
                        Reposition::Split => true,
                        Reposition::SplitGapped => !self.touches_ink(origin, effective_size),
                    }
                {
                    join = Join::Split;
                }
                repositioned = false;
                if self.capture.split_style
                    && visible
                    && matches!(join, Join::Same | Join::Spaced)
                    && (self.pending.bold, self.pending.italic) != style
                {
                    join = Join::Split;
                }
                if matches!(join, Join::Same | Join::Spaced) {
                    self.extend(glyph_text, visible, join == Join::Spaced);
                    if visible {
                        self.merge_bounds(bounds);
                        self.pending.bold &= style.0;
                        self.pending.italic &= style.1;
                        self.pending.ink_end = end;
                    }
                    self.pending.end = end;
                } else {
                    if join == Join::Split {
                        self.flush()?;
                    }
                    if visible {
                        self.begin(glyph_text, bounds, effective_size, direction, end, style);
                    }
                }
            }
            pen_x += step_x;
            pen_y += step_y;
            origin = end;
        }
        matrices.translate(pen_x, pen_y);
        Ok(())
    }

    fn push_ruling(&mut self, segment: [f64; 4], width: f64) {
        if self.rulings.len() >= self.ruling_cap {
            return;
        }
        let [x0, y0, x1, y1] = segment;
        let (dx, dy) = ((x1 - x0).abs(), (y1 - y0).abs());
        let ruling = if dy <= AXIS_TOLERANCE && dx >= MIN_RULING {
            let y = f64::midpoint(y0, y1);
            Ruling {
                x0: x0.min(x1),
                y0: y,
                x1: x0.max(x1),
                y1: y,
                width,
            }
        } else if dx <= AXIS_TOLERANCE && dy >= MIN_RULING {
            let x = f64::midpoint(x0, x1);
            Ruling {
                x0: x,
                y0: y0.min(y1),
                x1: x,
                y1: y0.max(y1),
                width,
            }
        } else {
            return;
        };
        if ruling.x0.is_finite()
            && ruling.y0.is_finite()
            && ruling.x1.is_finite()
            && ruling.y1.is_finite()
        {
            self.rulings.push(ruling);
        }
    }

    fn run(
        &mut self,
        data: &[u8],
        scope: &mut Scope,
        state: &mut GState,
        matrices: &mut TextMatrices,
        depth: usize,
    ) -> Outcome<()> {
        self.budget = self
            .budget
            .checked_sub(data.len())
            .ok_or_else(|| Failure::limit("content streams exceed limit"))?;
        if self.scan.is_none() {
            match scan_shows(data) {
                Shows::Text => {}
                Shows::Forms if scope.has_forms(self.document) => {}
                Shows::Forms | Shows::Nothing => return Ok(()),
            }
        }
        let max_stack = self.limits.max_nesting.saturating_mul(4);
        let mut stack: Vec<GState> = Vec::new();
        let mut overflow = 0_usize;
        let mut operands: Vec<Operand<'_>> = Vec::new();
        let mut path = PathBuilder::default();
        let mut curves = 0_u32;
        let mut marked: Vec<bool> = Vec::new();
        let mut scratch: Vec<u8> = Vec::new();
        let mut lexer = ContentLexer::new(data);
        while let Some(token) = lexer.next() {
            let name = match token {
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
            let code = op(name);
            match code {
                OP_END_IMAGE if self.scan.is_some() => {
                    if lexer.take_inline_image().is_some()
                        && let Some(scan) = self.scan.as_deref_mut()
                    {
                        scan.image(
                            transformed_bounds(&state.ctm, 0.0_f64, 0.0_f64, 1.0_f64, 1.0_f64),
                            self.clip,
                        );
                    }
                }
                OP_SAVE => {
                    if stack.len() >= max_stack {
                        overflow = overflow.saturating_add(1);
                    } else {
                        stack.push(state.clone());
                    }
                }
                OP_RESTORE => {
                    if overflow > 0 {
                        overflow = overflow.saturating_sub(1);
                    } else if let Some(previous) = stack.pop() {
                        *state = previous;
                    }
                }
                OP_BMC | OP_BDC | OP_EMC => {
                    self.marked_content(code, &operands, &mut marked, max_stack);
                }
                _ => {
                    if !self.state_operator(code, &operands, scope, state, matrices)
                        && !self.paint_operator(code, &operands, state, &mut path, &mut curves)
                    {
                        let shown = ShowContext {
                            operands: &operands,
                            depth,
                        };
                        self.show_operator(code, shown, scope, state, matrices, &mut scratch)?;
                    }
                }
            }
            while let Some(used) = operands.pop() {
                lexer.recycle(used);
            }
        }
        if marked.contains(&true) {
            self.actual = None;
        }
        Ok(())
    }

    fn set_font(
        &mut self,
        name: Option<&[u8]>,
        size: Option<f64>,
        scope: &mut Scope,
        state: &mut GState,
    ) {
        let (Some(name_next), Some(size_next)) = (name, size) else {
            return;
        };
        state.size = size_next;
        state.font = self.lookup_font(scope, name_next);
    }

    fn show(&mut self, state: &GState, matrices: &mut TextMatrices, bytes: &[u8]) -> Outcome<()> {
        let Some(entry) = state.font.clone() else {
            if let Some(scan) = self.scan.as_deref_mut() {
                scan.missing_font(bytes.len());
            }
            return Ok(());
        };
        let placement = Placement::new(&entry, state, &matrices.tm);
        self.show_with(&entry, &placement, state, matrices, bytes)
    }

    fn show_array(
        &mut self,
        state: &GState,
        matrices: &mut TextMatrices,
        items: &[Operand<'_>],
        scratch: &mut Vec<u8>,
    ) -> Outcome<()> {
        let Some(entry) = state.font.clone() else {
            for item in items {
                if let Some(bytes) = item.string(scratch) {
                    if let Some(scan) = self.scan.as_deref_mut() {
                        scan.missing_font(bytes.len());
                    }
                } else if let Some(amount) = item.as_number() {
                    matrices.translate(-amount / 1_000.0_f64 * state.size * state.scale, 0.0);
                }
            }
            return Ok(());
        };
        let placement = Placement::new(&entry, state, &matrices.tm);
        let mut glyphs = mem::take(&mut self.glyphs);
        let mut decoded = mem::take(&mut self.decoded);
        let mut shown = Shown {
            entry: &entry,
            placement: &placement,
            glyphs: &mut glyphs,
            decoded: &mut decoded,
        };
        let result = if self.scan.is_some() {
            self.show_items::<true>(&mut shown, state, matrices, items, scratch)
        } else {
            self.show_items::<false>(&mut shown, state, matrices, items, scratch)
        };
        self.glyphs = glyphs;
        self.decoded = decoded;
        result
    }

    fn show_items<const DIAGNOSTICS: bool>(
        &mut self,
        shown: &mut Shown<'_>,
        state: &GState,
        matrices: &mut TextMatrices,
        items: &[Operand<'_>],
        scratch: &mut Vec<u8>,
    ) -> Outcome<()> {
        for item in items {
            if let Some(bytes) = item.string(scratch) {
                shown.glyphs.clear();
                shown.decoded.clear();
                shown.entry.font.decode(bytes, shown.glyphs, shown.decoded);
                self.place::<DIAGNOSTICS>(
                    shown.entry,
                    shown.placement,
                    state,
                    matrices,
                    shown.glyphs,
                    shown.decoded,
                )?;
            } else if let Some(amount) = item.as_number() {
                let shift = -amount / 1_000.0_f64 * state.size;
                if shown.placement.vertical {
                    matrices.translate(0.0, shift);
                } else {
                    matrices.translate(shift * state.scale, 0.0);
                }
            }
        }
        Ok(())
    }

    fn show_operator(
        &mut self,
        code: u32,
        shown: ShowContext<'_, '_>,
        scope: &mut Scope,
        state: &mut GState,
        matrices: &mut TextMatrices,
        scratch: &mut Vec<u8>,
    ) -> Outcome<()> {
        let ShowContext { operands, depth } = shown;
        match code {
            OP_TJ => {
                if let Some(bytes) = operands.last().and_then(|last| last.string(scratch)) {
                    self.show(state, matrices, bytes)?;
                }
            }
            OP_QUOTE => {
                self.repositioned = true;
                matrices.line_move(0.0, -state.leading);
                if let Some(bytes) = operands.last().and_then(|last| last.string(scratch)) {
                    self.show(state, matrices, bytes)?;
                }
            }
            OP_DQUOTE => {
                self.repositioned = true;
                if let Some([word, character]) = operands
                    .len()
                    .checked_sub(3)
                    .and_then(|start| operands.get(start..start.saturating_add(2)))
                    .and_then(tail_numbers::<2, _>)
                {
                    state.word_space = word;
                    state.char_space = character;
                }
                matrices.line_move(0.0, -state.leading);
                if let Some(bytes) = operands.last().and_then(|last| last.string(scratch)) {
                    self.show(state, matrices, bytes)?;
                }
            }
            OP_TJ_ARRAY => {
                if let Some(Operand::Array(items)) = operands.last() {
                    self.show_array(state, matrices, items, scratch)?;
                }
            }
            OP_DO => {
                if let Some(xobject) = operands.last().and_then(Operand::as_name) {
                    self.do_xobject(xobject, scope, state, matrices, depth)?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn show_with(
        &mut self,
        entry: &FontEntry,
        placement: &Placement,
        state: &GState,
        matrices: &mut TextMatrices,
        bytes: &[u8],
    ) -> Outcome<()> {
        let mut glyphs = mem::take(&mut self.glyphs);
        let mut decoded = mem::take(&mut self.decoded);
        glyphs.clear();
        decoded.clear();
        entry.font.decode(bytes, &mut glyphs, &mut decoded);
        let result = if self.scan.is_some() {
            self.place::<true>(entry, placement, state, matrices, &glyphs, &decoded)
        } else {
            self.place::<false>(entry, placement, state, matrices, &glyphs, &decoded)
        };
        self.glyphs = glyphs;
        self.decoded = decoded;
        result
    }

    fn state_operator(
        &mut self,
        code: u32,
        operands: &[Operand<'_>],
        scope: &mut Scope,
        state: &mut GState,
        matrices: &mut TextMatrices,
    ) -> bool {
        match code {
            OP_CM => {
                if let Some(matrix) = tail_numbers::<6, _>(operands) {
                    state.ctm = multiply(&matrix, &state.ctm);
                }
            }
            OP_BT => {
                self.repositioned = true;
                matrices.tm = IDENTITY;
                matrices.tlm = IDENTITY;
            }
            OP_TC => {
                if let Some([value]) = tail_numbers::<1, _>(operands) {
                    state.char_space = value;
                }
            }
            OP_TW => {
                if let Some([value]) = tail_numbers::<1, _>(operands) {
                    state.word_space = value;
                }
            }
            OP_TZ => {
                if let Some([value]) = tail_numbers::<1, _>(operands) {
                    state.scale = value / 100.0_f64;
                }
            }
            OP_TL => {
                if let Some([value]) = tail_numbers::<1, _>(operands) {
                    state.leading = value;
                }
            }
            OP_TS => {
                if let Some([value]) = tail_numbers::<1, _>(operands) {
                    state.rise = value;
                }
            }
            OP_TR => {
                if let Some([value]) = tail_numbers::<1, _>(operands) {
                    state.stroked_fill = (value - 2.0).abs() < 0.5_f64;
                    if self.scan.is_some() {
                        state.invisible_text =
                            (value - 3.0_f64).abs() < 0.5_f64 || (value - 7.0_f64).abs() < 0.5_f64;
                    }
                }
            }
            OP_TF => {
                let name = operands
                    .len()
                    .checked_sub(2)
                    .and_then(|index| operands.get(index))
                    .and_then(Operand::as_name);
                let size = operands.last().and_then(Operand::as_number);
                self.set_font(name, size, scope, state);
            }
            OP_GS => self.apply_ext_gstate(operands, scope, state),
            OP_TD => {
                self.repositioned = true;
                if let Some([tx, ty]) = tail_numbers::<2, _>(operands) {
                    matrices.line_move(tx, ty);
                }
            }
            OP_TD_LEADING => {
                self.repositioned = true;
                if let Some([tx, ty]) = tail_numbers::<2, _>(operands) {
                    state.leading = -ty;
                    matrices.line_move(tx, ty);
                }
            }
            OP_TM => {
                self.repositioned = true;
                if let Some(matrix) = tail_numbers::<6, _>(operands) {
                    matrices.tm = matrix;
                    matrices.tlm = matrix;
                }
            }
            OP_TSTAR => {
                self.repositioned = true;
                matrices.line_move(0.0, -state.leading);
            }
            OP_LINE_WIDTH => {
                if let Some([width]) = tail_numbers::<1, _>(operands) {
                    state.line_width = width;
                }
            }
            _ => return false,
        }
        true
    }

    fn touches_ink(&self, origin: (f64, f64), size: f64) -> bool {
        let (ux, uy) = self.pending.dir;
        let along =
            (origin.0 - self.pending.ink_end.0) * ux + (origin.1 - self.pending.ink_end.1) * uy;
        along >= -BACK_GAP * size && along <= SPACE_GAP * size
    }

    fn vertical_metrics(&self, font: &Dict) -> (f64, f64) {
        let direct = font
            .get(b"FontDescriptor")
            .and_then(|descriptor| self.descriptor_metrics(descriptor));
        if let Some(metrics) = direct {
            return metrics;
        }
        let descendant = font
            .get(b"DescendantFonts")
            .and_then(|object| self.document.follow_transient(object).ok())
            .and_then(|resolved| {
                let first = resolved.as_array().and_then(|items| items.first())?;
                self.document.follow_transient(first).ok()
            });
        let nested = descendant
            .as_deref()
            .and_then(Object::as_dict)
            .and_then(|dict| dict.get(b"FontDescriptor"))
            .and_then(|descriptor| self.descriptor_metrics(descriptor));
        if let Some(metrics) = nested {
            return metrics;
        }
        let bold = font
            .get(b"BaseFont")
            .and_then(Object::as_name)
            .is_some_and(|name| name.windows(4).any(|window| window == b"Bold"));
        if bold {
            (BOLD_ASCENT, BOLD_DESCENT)
        } else {
            (DEFAULT_ASCENT, DEFAULT_DESCENT)
        }
    }
}

fn graphics(scan: &mut PageScan, code: u32, curves: &mut u32) -> bool {
    match code {
        OP_CURVE | OP_CURVE_V | OP_CURVE_Y => *curves = curves.saturating_add(1),
        OP_FILL
        | OP_FILL_OLD
        | OP_FILL_EO
        | OP_FILL_STROKE
        | OP_FILL_STROKE_EO
        | OP_CLOSE_FILL_STROKE
        | OP_CLOSE_FILL_STROKE_EO => {
            scan.filled_curves(mem::take(curves));
        }
        OP_STROKE | OP_CLOSE_STROKE | OP_NO_PAINT => *curves = 0,
        _ => return false,
    }
    true
}

const fn outside(bounds: [f64; 4], clip: [f64; 4]) -> bool {
    bounds[2] < clip[0] || bounds[0] > clip[2] || bounds[3] < clip[1] || bounds[1] > clip[3]
}

fn space_gap(font: &Font) -> f64 {
    let mut glyphs = Vec::with_capacity(1);
    let mut text = String::with_capacity(1);
    for probe in [" ", ".", ","] {
        glyphs.clear();
        text.clear();
        font.decode(probe.as_bytes(), &mut glyphs, &mut text);
        let [glyph] = glyphs.as_slice() else {
            return SPACE_GAP;
        };
        if text != probe {
            return SPACE_GAP;
        }
        if glyph.advance > 0.0_f64 {
            return (glyph.advance * SPACE_WIDTH_SHARE).clamp(MIN_SPACE_GAP, SPACE_GAP);
        }
    }
    SPACE_GAP
}

const fn op(name: &[u8]) -> u32 {
    match name {
        [a] => u32::from_be_bytes([0, 0, 0, *a]),
        [a, b] => u32::from_be_bytes([0, 0, *a, *b]),
        [a, b, c] => u32::from_be_bytes([0, *a, *b, *c]),
        _ => 0,
    }
}

fn scan_shows(data: &[u8]) -> Shows {
    let mut forms = false;
    let mut at = 0_usize;
    while let Some(offset) = data.get(at..).and_then(|rest| {
        rest.iter()
            .position(|byte| matches!(byte, b'T' | b'D' | b'\'' | b'"'))
    }) {
        let index = at.saturating_add(offset);
        match data.get(index) {
            Some(b'\'' | b'"') => return Shows::Text,
            Some(b'T') if matches!(data.get(index.saturating_add(1)), Some(b'j' | b'J')) => {
                return Shows::Text;
            }
            Some(b'D') if data.get(index.saturating_add(1)) == Some(&b'o') => forms = true,
            _ => {}
        }
        at = index.saturating_add(1);
    }
    if forms { Shows::Forms } else { Shows::Nothing }
}

pub(crate) fn tail_numbers<const N: usize, T>(operands: &[T]) -> Option<[f64; N]>
where
    T: Numeric,
{
    let start = operands.len().checked_sub(N)?;
    let mut out = [0.0_f64; N];
    for (slot, object) in out.iter_mut().zip(operands.get(start..)?) {
        *slot = object.number()?;
    }
    Some(out)
}

fn matrix_from(object: Option<&Object>) -> Option<Matrix> {
    let items = object?.as_array()?;
    if items.len() != 6 {
        return None;
    }
    tail_numbers::<6, _>(items)
}

fn transformed_bounds(matrix: &Matrix, x0: f64, y0: f64, x1: f64, y1: f64) -> [f64; 4] {
    spans(matrix, x0, x1, rows(matrix, y0, y1))
}

fn rows(matrix: &Matrix, y0: f64, y1: f64) -> [f64; 4] {
    let [_, _, c, d, _, _] = *matrix;
    let (c0, c1) = ordered(y0 * c, y1 * c);
    let (d0, d1) = ordered(y0 * d, y1 * d);
    [c0, d0, c1, d1]
}

fn spans(matrix: &Matrix, x0: f64, x1: f64, rows: [f64; 4]) -> [f64; 4] {
    let [a, b, _, _, e, f] = *matrix;
    let (a0, a1) = ordered(x0 * a, x1 * a);
    let (b0, b1) = ordered(x0 * b, x1 * b);
    let [c0, d0, c1, d1] = rows;
    [a0 + c0 + e, b0 + d0 + f, a1 + c1 + e, b1 + d1 + f]
}

fn ordered(first: f64, second: f64) -> (f64, f64) {
    if second < first {
        (second, first)
    } else {
        (first, second)
    }
}

fn apply(matrix: &Matrix, x: f64, y: f64) -> (f64, f64) {
    let [a, b, c, d, e, f] = *matrix;
    (x * a + y * c + e, x * b + y * d + f)
}

fn axis_aligned(matrix: &Matrix) -> bool {
    let [a, b, c, d, _, _] = *matrix;
    let straight = a.abs() + d.abs();
    let turned = b.abs() + c.abs();
    straight > MIN_SCALE && turned <= 1e-3 * straight
        || turned > MIN_SCALE && straight <= 1e-3 * turned
}

fn text_string(bytes: &[u8]) -> String {
    match bytes {
        [0xFE, 0xFF, rest @ ..] => decode_utf16(rest, u16::from_be_bytes),
        [0xFF, 0xFE, rest @ ..] => decode_utf16(rest, u16::from_le_bytes),
        [0xEF, 0xBB, 0xBF, rest @ ..] => String::from_utf8_lossy(rest).into_owned(),
        _ => bytes.iter().map(|&byte| char::from(byte)).collect(),
    }
}

fn decode_utf16(bytes: &[u8], read: fn([u8; 2]) -> u16) -> String {
    let units = bytes.as_chunks::<2>().0.iter().map(|pair| read(*pair));
    char::decode_utf16(units)
        .map(|unit| unit.unwrap_or(char::REPLACEMENT_CHARACTER))
        .collect()
}

fn actual_text(operands: &[Operand<'_>]) -> Option<String> {
    let properties = operands.last()?.as_dict()?;
    let Object::String(bytes) = properties.get(b"ActualText")? else {
        return None;
    };
    Some(text_string(bytes))
}

fn is_bold_name(name: &[u8]) -> bool {
    [&b"Bold"[..], b"bold", b"Black", b"Heavy", b"BOLD"]
        .iter()
        .any(|needle| name.windows(needle.len()).any(|window| window == *needle))
}

fn is_italic_name(name: &[u8]) -> bool {
    [
        &b"Italic"[..],
        b"italic",
        b"Oblique",
        b"oblique",
        b"Ital",
        b"ITAL",
    ]
    .iter()
    .any(|needle| name.windows(needle.len()).any(|window| window == *needle))
}

pub(crate) fn extract_content(
    document: &Document<'_>,
    page: &Page,
    limits: &Limits,
    capture: Capture,
    session: &mut Session,
) -> Outcome<PageContent> {
    extract_page(document, page, limits, capture, session, None)
}

pub(crate) fn scan_page(
    document: &Document<'_>,
    page: &Page,
    limits: &Limits,
    session: &mut Session,
    scan: &mut PageScan,
) -> Outcome<()> {
    let capture = Capture {
        structure: true,
        ..Capture::default()
    };
    extract_page(document, page, limits, capture, session, Some(scan)).map(drop)
}

fn extract_page(
    document: &Document<'_>,
    page: &Page,
    limits: &Limits,
    capture: Capture,
    session: &mut Session,
    scan: Option<&mut PageScan>,
) -> Outcome<PageContent> {
    let content = document.content(page)?;
    if content.is_empty() {
        return Ok(PageContent::default());
    }
    let [mx0, my0, mx1, my1] = page.info.crop_box;
    let previous = session.generation;
    session.generation = previous.wrapping_add(1);
    if session.fonts.len() > MAX_CACHED_FONTS {
        session
            .fonts
            .retain(|_, (_, used)| previous.wrapping_sub(*used) <= FONT_HORIZON);
    }
    let mut interpreter = Interpreter {
        document,
        limits,
        fonts: mem::take(&mut session.fonts),
        forms: mem::take(&mut session.forms),
        generation: session.generation,
        skipped: mem::take(&mut session.skipped),
        active: Vec::new(),
        scopes: session.scopes,
        budget: limits.max_decoded_stream_bytes,
        max_depth: limits.max_nesting.min(MAX_FORM_DEPTH),
        items: Vec::new(),
        text: String::new(),
        glyphs: Vec::new(),
        decoded: String::new(),
        pending: PendingRun::default(),
        capture,
        repositioned: false,
        rulings: Vec::new(),
        scan,
        ruling_cap: limits.max_items_per_page,
        page_extent: ((mx1 - mx0).abs(), (my1 - my0).abs()),
        clip: None,
        actual: None,
        actual_emitted: false,
    };
    let mut scope = Scope::new(
        interpreter.next_scope(),
        Rc::clone(&page.resources),
        page.resources_ref,
    );
    let mut state = GState::initial();
    let mut matrices = TextMatrices {
        tm: IDENTITY,
        tlm: IDENTITY,
    };
    let outcome = interpreter
        .run(&content, &mut scope, &mut state, &mut matrices, 0)
        .and_then(|()| interpreter.flush());
    session.fonts = mem::take(&mut interpreter.fonts);
    session.forms = mem::take(&mut interpreter.forms);
    session.skipped = mem::take(&mut interpreter.skipped);
    session.scopes = interpreter.scopes;
    outcome?;
    Ok(PageContent {
        runs: interpreter.items,
        text: interpreter.text,
        rulings: interpreter.rulings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::inspect;
    use crate::inspection::{InspectOptions, Inspection};
    use core::fmt::Write as _;
    use core::hint::black_box;
    use core::iter;

    macro_rules! fixture {
        ($name:literal) => {
            (
                include_bytes!(concat!("../../__tests__/fixtures/", $name, ".pdf")).as_slice(),
                include_str!(concat!(
                    "../../__tests__/fixtures/",
                    $name,
                    ".liteparse.json"
                )),
            )
        };
    }

    const HELVETICA: &str =
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";

    const HELLO_WIDTH: f64 = 2.278;

    const HELVETICA_BOLD: &str =
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";

    struct Json;

    #[derive(Debug, Clone, PartialEq)]
    enum Value {
        Bool(bool),
        List(Vec<Self>),
        Map(Vec<(String, Self)>),
        Null,
        Number(f64),
        Text(String),
    }

    impl Value {
        fn get(&self, key: &str) -> Option<&Self> {
            if let Self::Map(entries) = self {
                entries
                    .iter()
                    .find(|(entry_key, _)| entry_key == key)
                    .map(|(_, value)| value)
            } else {
                None
            }
        }

        fn list(&self, key: &str) -> &[Self] {
            match self.get(key) {
                Some(Self::List(items)) => items,
                _ => &[],
            }
        }

        fn number(&self, key: &str) -> f64 {
            match self.get(key) {
                Some(Self::Number(value)) => *value,
                other => panic!("missing number {key}: {other:?}"),
            }
        }

        fn text(&self, key: &str) -> &str {
            match self.get(key) {
                Some(Self::Text(text)) => text,
                other => panic!("missing text {key}: {other:?}"),
            }
        }
    }

    impl Json {
        fn parse(source: &str) -> Value {
            let bytes = source.as_bytes();
            let mut pos = 0;
            Self::value(bytes, &mut pos)
        }

        fn skip(bytes: &[u8], pos: &mut usize) {
            while bytes.get(*pos).is_some_and(u8::is_ascii_whitespace) {
                *pos = (*pos).saturating_add(1);
            }
        }

        fn value(bytes: &[u8], pos: &mut usize) -> Value {
            Self::skip(bytes, pos);
            match bytes[*pos] {
                b'{' => {
                    *pos = (*pos).saturating_add(1);
                    let mut entries = Vec::new();
                    loop {
                        Self::skip(bytes, pos);
                        if bytes[*pos] == b'}' {
                            *pos = (*pos).saturating_add(1);
                            return Value::Map(entries);
                        }
                        if bytes[*pos] == b',' {
                            *pos = (*pos).saturating_add(1);
                            continue;
                        }
                        let Value::Text(key) = Self::value(bytes, pos) else {
                            panic!("key");
                        };
                        Self::skip(bytes, pos);
                        *pos = (*pos).saturating_add(1);
                        entries.push((key, Self::value(bytes, pos)));
                    }
                }
                b'[' => {
                    *pos = (*pos).saturating_add(1);
                    let mut items = Vec::new();
                    loop {
                        Self::skip(bytes, pos);
                        if bytes[*pos] == b']' {
                            *pos = (*pos).saturating_add(1);
                            return Value::List(items);
                        }
                        if bytes[*pos] == b',' {
                            *pos = (*pos).saturating_add(1);
                            continue;
                        }
                        items.push(Self::value(bytes, pos));
                    }
                }
                b'"' => {
                    *pos = (*pos).saturating_add(1);
                    let mut out = Vec::new();
                    while bytes[*pos] != b'"' {
                        if bytes[*pos] == b'\\' {
                            *pos = (*pos).saturating_add(1);
                            match bytes[*pos] {
                                b'n' => out.push(b'\n'),
                                b't' => out.push(b'\t'),
                                b'u' => {
                                    let code = str::from_utf8(
                                        &bytes[(*pos).saturating_add(1)..(*pos).saturating_add(5)],
                                    )
                                    .unwrap();
                                    let ch = char::from_u32(u32::from_str_radix(code, 16).unwrap())
                                        .unwrap();
                                    let mut buffer = [0_u8; 4];
                                    out.extend_from_slice(ch.encode_utf8(&mut buffer).as_bytes());
                                    *pos = (*pos).saturating_add(4);
                                }
                                other => out.push(other),
                            }
                        } else {
                            out.push(bytes[*pos]);
                        }
                        *pos = (*pos).saturating_add(1);
                    }
                    *pos = (*pos).saturating_add(1);
                    Value::Text(String::from_utf8(out).unwrap())
                }
                b't' => {
                    *pos = (*pos).saturating_add(4);
                    Value::Bool(true)
                }
                b'f' => {
                    *pos = (*pos).saturating_add(5);
                    Value::Bool(false)
                }
                b'n' => {
                    *pos = (*pos).saturating_add(4);
                    Value::Null
                }
                _ => {
                    let start = *pos;
                    while bytes
                        .get(*pos)
                        .is_some_and(|b| b.is_ascii_digit() || b"+-.eE".contains(b))
                    {
                        *pos = (*pos).saturating_add(1);
                    }
                    Value::Number(
                        str::from_utf8(&bytes[start..*pos])
                            .unwrap()
                            .parse()
                            .unwrap(),
                    )
                }
            }
        }
    }

    #[derive(Debug)]
    struct Golden {
        height: f64,
        text: String,
        width: f64,
        x: f64,
        y: f64,
    }

    fn stream_object(dict: &str, data: &str) -> String {
        format!(
            "<< /Length {} {} >>\nstream\n{}\nendstream",
            data.len(),
            dict,
            data
        )
    }

    fn build(objects: &[(u32, String)]) -> Vec<u8> {
        let mut bytes = b"%PDF-1.7\n".to_vec();
        let mut offsets = Vec::new();
        for (number, body) in objects {
            offsets.push((*number, bytes.len()));
            bytes.extend_from_slice(format!("{number} 0 obj\n{body}\nendobj\n").as_bytes());
        }
        let xref = bytes.len();
        let max = objects.iter().map(|(number, _)| *number).max().unwrap_or(0);
        bytes.extend_from_slice(format!("xref\n0 {}\n", max.saturating_add(1)).as_bytes());
        for number in 0..=max {
            match offsets.iter().find(|(found, _)| *found == number) {
                Some((_, offset)) => {
                    bytes.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
                }
                None => bytes.extend_from_slice(b"0000000000 65535 f \n"),
            }
        }
        bytes.extend_from_slice(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
                max.saturating_add(1)
            )
            .as_bytes(),
        );
        bytes
    }

    fn page_pdf(resources: &str, content: &str, extra: &[(u32, String)]) -> Vec<u8> {
        let mut objects = vec![
            (1, "<< /Type /Catalog /Pages 2 0 R >>".to_owned()),
            (2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_owned()),
            (
                3,
                format!(
                    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents 4 0 R /Resources {resources} >>"
                ),
            ),
            (4, stream_object("", content)),
        ];
        objects.extend_from_slice(extra);
        build(&objects)
    }

    fn simple_pdf(content: &str) -> Vec<u8> {
        page_pdf(
            "<< /Font << /F1 5 0 R >> >>",
            content,
            &[(5, HELVETICA.to_owned())],
        )
    }

    fn extract_runs(
        document: &Document<'_>,
        page: &Page,
        limits: &Limits,
        split_repositioned: bool,
        session: &mut Session,
    ) -> Outcome<PageContent> {
        let capture = Capture {
            reposition: if split_repositioned {
                Reposition::Split
            } else {
                Reposition::Join
            },
            structure: false,
            split_style: false,
        };
        extract_content(document, page, limits, capture, session)
    }

    fn extract_with(bytes: &[u8], limits: &Limits) -> Outcome<Vec<TextItem>> {
        let document = Document::open(bytes, limits)?;
        let pages = document.pages()?;
        extract_runs(
            &document,
            pages.first().unwrap(),
            limits,
            false,
            &mut Session::default(),
        )
        .map(|content| content.items())
    }

    fn extract(bytes: &[u8]) -> Vec<TextItem> {
        extract_with(bytes, &Limits::default()).unwrap()
    }

    fn texts(items: &[TextItem]) -> Vec<&str> {
        items.iter().map(|item| item.text.as_str()).collect()
    }

    fn close(left: f64, right: f64) -> bool {
        (left - right).abs() < 0.01
    }

    fn assert_rect(item: &TextItem, expected: [f64; 4]) {
        for (actual, wanted) in item.rect.iter().zip(expected) {
            assert!(
                close(*actual, wanted),
                "rect {:?} != {expected:?}",
                item.rect
            );
        }
    }

    #[test]
    fn positions_a_simple_run() {
        let items = extract(&simple_pdf("BT /F1 12 Tf 100 700 Td (Hello) Tj ET"));
        assert_eq!(texts(&items), ["Hello"]);
        let item = items.first().unwrap();
        assert_rect(
            item,
            [
                100.0_f64,
                700.0_f64 - DEFAULT_DESCENT * 12.0_f64,
                100.0_f64 + HELLO_WIDTH * 12.0_f64,
                700.0_f64 + DEFAULT_ASCENT * 12.0_f64,
            ],
        );
        assert!(close(item.font_size, 12.0));
    }

    #[test]
    fn merges_adjacent_operators_on_one_line() {
        let items = extract(&simple_pdf(
            "BT /F1 12 Tf 100 700 Td (Hel) Tj (lo) Tj ET BT /F1 12 Tf 1 0 0 1 127.336 700 Tm ( there) Tj ET",
        ));
        assert_eq!(texts(&items), ["Hello there"]);
    }

    #[test]
    fn small_kerning_keeps_words_together_and_large_inserts_space() {
        let items = extract(&simple_pdf(
            "BT /F1 12 Tf 100 700 Td [(Hel) 30 (lo) -400 (World)] TJ ET",
        ));
        assert_eq!(texts(&items), ["Hello World"]);
        let item = items.first().unwrap();
        let expected_right = 100.0_f64 + (2.278_f64 + 0.4_f64 - 0.03_f64 + 2.611_f64) * 12.0_f64;
        assert!(close(item.rect[2], expected_right), "{:?}", item.rect);
    }

    #[test]
    fn huge_kerning_splits_items() {
        let items = extract(&simple_pdf(
            "BT /F1 12 Tf 100 700 Td [(Left) -3000 (Right)] TJ ET",
        ));
        assert_eq!(texts(&items), ["Left", "Right"]);
    }

    #[test]
    fn explicit_spaces_and_word_spacing() {
        let items = extract(&simple_pdf("BT /F1 10 Tf 5 Tw 0 700 Td (a b) Tj ET"));
        assert_eq!(texts(&items), ["a b"]);
        assert!(close(
            items[0].rect[2],
            (0.556 + 0.278 + 0.556) * 10.0 + 5.0
        ));
    }

    #[test]
    fn character_spacing_does_not_insert_spaces() {
        let items = extract(&simple_pdf("BT /F1 10 Tf 3 Tc 0 700 Td (abc) Tj ET"));
        assert_eq!(texts(&items), ["abc"]);
    }

    #[test]
    fn horizontal_scaling_stretches_advance() {
        let plain = extract(&simple_pdf("BT /F1 10 Tf 0 700 Td (Hello) Tj ET"));
        let wide = extract(&simple_pdf("BT /F1 10 Tf 200 Tz 0 700 Td (Hello) Tj ET"));
        let plain_width = plain[0].rect[2] - plain[0].rect[0];
        let wide_width = wide[0].rect[2] - wide[0].rect[0];
        assert!(close(wide_width, plain_width * 2.0));
    }

    #[test]
    fn rise_shifts_vertically() {
        let items = extract(&simple_pdf("BT /F1 10 Tf 0 700 Td 4 Ts (Hi) Tj ET"));
        assert!(close(items[0].rect[1], 704.0 - DEFAULT_DESCENT * 10.0));
    }

    #[test]
    fn rotated_text_matrix_produces_tall_narrow_box() {
        let items = extract(&simple_pdf(
            "BT /F1 10 Tf 0 1 -1 0 300 400 Tm (Hello) Tj ET",
        ));
        assert_eq!(texts(&items), ["Hello"]);
        let item = &items[0];
        assert!(close(item.rect[3] - item.rect[1], 22.78));
        assert!(close(
            item.rect[2] - item.rect[0],
            (DEFAULT_ASCENT + DEFAULT_DESCENT) * 10.0
        ));
        assert!(close(item.rect[0], 300.0 - DEFAULT_ASCENT * 10.0));
        assert!(close(item.rect[1], 400.0));
    }

    #[test]
    fn concatenation_matrix_scales_and_translates() {
        let items = extract(&simple_pdf(
            "q 2 0 0 2 10 20 cm BT /F1 10 Tf 5 5 Td (Hi) Tj ET Q",
        ));
        let item = &items[0];
        assert!(close(item.rect[0], 20.0));
        assert!(close(item.font_size, 20.0));
        assert!(close(item.rect[1], 30.0 - DEFAULT_DESCENT * 20.0));
        assert!(close(item.rect[2], 20.0 + 0.722 * 20.0 + 0.222 * 20.0));
    }

    #[test]
    fn restore_brings_back_text_state() {
        let items = extract(&simple_pdf("BT /F1 10 Tf 0 700 Td q /F1 20 Tf Q (a) Tj ET"));
        assert!(close(items[0].font_size, 10.0));
    }

    #[test]
    fn line_operators_move_to_next_lines() {
        let items = extract(&simple_pdf(
            "BT /F1 10 Tf 14 TL 50 700 Td (one) Tj T* (two) Tj (x) ' 1 2 (y) \" 0 -30 TD (z) Tj ET",
        ));
        assert_eq!(texts(&items), ["one", "two", "x", "y", "z"]);
        assert!(close(items[1].rect[1], 686.0 - DEFAULT_DESCENT * 10.0));
        assert!(close(items[2].rect[1], 672.0 - DEFAULT_DESCENT * 10.0));
        assert!(close(items[3].rect[1], 658.0 - DEFAULT_DESCENT * 10.0));
        assert!(close(items[4].rect[1], 628.0 - DEFAULT_DESCENT * 10.0));
    }

    #[test]
    fn double_quote_sets_spacing() {
        let items = extract(&simple_pdf("BT /F1 10 Tf 12 TL 50 700 Td 4 1 (a b) \" ET"));
        assert_eq!(texts(&items), ["a b"]);
        assert!(close(
            items[0].rect[2],
            50.0 + (0.556 + 0.278 + 0.556) * 10.0 + 2.0 + 4.0
        ));
    }

    #[test]
    fn invisible_render_mode_is_still_extracted() {
        let items = extract(&simple_pdf(
            "BT /F1 4 Tf 3 Tr 1 1 1 rg 72 600 Td ([[licitei-assinatura]]) Tj ET",
        ));
        assert_eq!(texts(&items), ["[[licitei-assinatura]]"]);
        assert!(close(items[0].font_size, 4.0));
    }

    #[test]
    fn whitespace_only_runs_are_dropped() {
        let items = extract(&simple_pdf(
            "BT /F1 10 Tf 0 700 Td (   ) Tj 0 -20 Td ( a ) Tj ET",
        ));
        assert_eq!(texts(&items), ["a"]);
    }

    #[test]
    fn baseline_change_and_size_change_break_items() {
        let items = extract(&simple_pdf(
            "BT /F1 10 Tf 0 700 Td (one) Tj 0 -12 Td (two) Tj ET BT /F1 10 Tf 300 700 Td (a) Tj /F1 20 Tf (b) Tj ET",
        ));
        assert_eq!(texts(&items), ["one", "two", "a", "b"]);
    }

    #[test]
    fn form_xobject_applies_matrix_and_own_resources() {
        let form = "<< /Type /XObject /Subtype /Form /BBox [0 0 100 100] /Matrix [1 0 0 1 50 60] /Resources << /Font << /G 7 0 R >> >> /Length 31 >>\nstream\nBT /G 10 Tf 10 10 Td (Inside) Tj ET\nendstream".to_owned();
        let bytes = page_pdf(
            "<< /Font << /F1 5 0 R >> /XObject << /X 6 0 R /I 8 0 R >> >>",
            "BT /F1 10 Tf 0 700 Td (Outer) Tj ET /X Do /I Do",
            &[
                (5, HELVETICA.to_owned()),
                (6, form),
                (7, HELVETICA.to_owned()),
                (
                    8,
                    "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n\u{1}\nendstream".to_owned(),
                ),
            ],
        );
        let items = extract(&bytes);
        assert_eq!(texts(&items), ["Outer", "Inside"]);
        assert!(close(items[1].rect[0], 60.0));
        assert!(close(items[1].rect[1], 70.0 - DEFAULT_DESCENT * 10.0));
    }

    #[test]
    fn form_inherits_page_resources_and_cycles_terminate() {
        let form = "<< /Type /XObject /Subtype /Form /BBox [0 0 100 100] /Length 38 >>\nstream\nBT /F1 10 Tf (Loop) Tj ET /X Do\nendstream".to_owned();
        let bytes = page_pdf(
            "<< /Font << /F1 5 0 R >> /XObject << /X 6 0 R >> >>",
            "/X Do",
            &[(5, HELVETICA.to_owned()), (6, form)],
        );
        let items = extract(&bytes);
        assert_eq!(texts(&items), ["Loop"]);
    }

    #[test]
    fn graphics_state_pushes_past_the_cap_are_ignored() {
        let content = format!(
            "{}BT /F1 10 Tf 1 0 0 1 10 700 Tm (deep) Tj ET {}BT /F1 10 Tf 1 0 0 1 10 600 Tm (shallow) Tj ET",
            "q 1 0 0 1 0 0 cm ".repeat(1000),
            "Q ".repeat(1000)
        );
        let items = extract_with(&simple_pdf(&content), &Limits::default()).unwrap();
        assert_eq!(texts(&items), ["deep", "shallow"]);
        let mut nesting = String::with_capacity(8_000);
        nesting.extend(iter::repeat_n("q ", 1000));
        nesting.extend(iter::repeat_n("Q ", 1000));
        let shifted =
            format!("q 1 0 0 1 100 0 cm {nesting}Q BT /F1 10 Tf 1 0 0 1 10 700 Tm (base) Tj ET");
        let restored = extract_with(&simple_pdf(&shifted), &Limits::default()).unwrap();
        assert_eq!(texts(&restored), ["base"]);
        assert!(restored[0].rect[0] < 20.0_f64);
    }

    #[test]
    fn deeply_nested_content_arrays_end_the_stream_without_failing() {
        let content = format!(
            "BT /F1 10 Tf 1 0 0 1 10 700 Tm (kept) Tj {} (lost) Tj ET",
            "[".repeat(100)
        );
        let items = extract_with(&simple_pdf(&content), &Limits::default()).unwrap();
        assert_eq!(texts(&items), ["kept"]);
    }

    #[test]
    fn repositioned_pieces_stay_separate_when_requested() {
        let bytes = simple_pdf(
            "BT /F1 10 Tf 1 0 0 1 100 700 Tm (abc) Tj ET BT /F1 10 Tf 1 0 0 1 120 700 Tm (def) Tj ET",
        );
        let limits = Limits::default();
        let document = Document::open(&bytes, &limits).unwrap();
        let pages = document.pages().unwrap();
        let page = pages.first().unwrap();
        let merged =
            extract_runs(&document, page, &limits, false, &mut Session::default()).unwrap();
        assert_eq!(run_texts(&merged), ["abc def"]);
        let split = extract_runs(&document, page, &limits, true, &mut Session::default()).unwrap();
        assert_eq!(run_texts(&split), ["abc", "def"]);
        assert_eq!(split.runs[0].direction, (1.0_f64, 0.0_f64));
    }

    fn structured(bytes: &[u8]) -> PageContent {
        let limits = Limits::default();
        let document = Document::open(bytes, &limits).unwrap();
        let pages = document.pages().unwrap();
        let capture = Capture {
            reposition: Reposition::Split,
            structure: true,
            split_style: false,
        };
        extract_content(
            &document,
            pages.first().unwrap(),
            &limits,
            capture,
            &mut Session::default(),
        )
        .unwrap()
    }

    fn run_texts(content: &PageContent) -> Vec<&str> {
        content
            .runs
            .iter()
            .map(|run| content.text_of(run))
            .collect()
    }

    #[test]
    fn clip_render_modes_still_extract_text() {
        for mode in 4_i32..=7_i32 {
            let bytes = simple_pdf(&format!(
                "BT /F1 12 Tf {mode} Tr 50 700 Td (clipped {mode}) Tj ET"
            ));
            assert_eq!(texts(&extract(&bytes)), [format!("clipped {mode}")]);
            assert_eq!(run_texts(&structured(&bytes)), [format!("clipped {mode}")]);
        }
    }

    fn form_pdf(content: &str, form_body: &str, bbox: &str) -> Vec<u8> {
        let form = format!(
            "<< /Type /XObject /Subtype /Form /BBox {bbox} /Length {} >>\nstream\n{form_body}\nendstream",
            form_body.len()
        );
        page_pdf(
            "<< /Font << /F1 5 0 R >> /XObject << /X 6 0 R >> >>",
            content,
            &[(5, HELVETICA.to_owned()), (6, form)],
        )
    }

    #[test]
    fn form_bbox_drops_glyphs_outside_in_structured_mode() {
        let body =
            "BT /F1 10 Tf 10 10 Td (inside) Tj ET BT /F1 10 Tf 1 0 0 1 300 300 Tm (outside) Tj ET";
        let bytes = form_pdf("q 1 0 0 1 50 50 cm /X Do Q", body, "[0 0 100 100]");
        assert_eq!(texts(&extract(&bytes)), ["inside", "outside"]);
        assert_eq!(run_texts(&structured(&bytes)), ["inside"]);
    }

    #[test]
    fn form_bbox_clip_follows_matrix_and_nesting() {
        let body = "BT /F1 10 Tf 1 0 0 1 150 10 Tm (right) Tj ET BT /F1 10 Tf 1 0 0 1 10 10 Tm (left) Tj ET";
        let bytes = form_pdf("q 2 0 0 2 0 0 cm /X Do Q", body, "[0 0 100 100]");
        assert_eq!(run_texts(&structured(&bytes)), ["left"]);
        let degenerate = form_pdf("/X Do", body, "[0 0 0 0]");
        assert_eq!(run_texts(&structured(&degenerate)), ["right", "left"]);
    }

    #[test]
    fn actual_text_replaces_span_text() {
        let bytes = simple_pdf(
            "/Span << /ActualText (Real text) >> BDC BT /F1 10 Tf 50 700 Td (fake) Tj 0 -14 Td (more) Tj ET EMC BT /F1 10 Tf 50 600 Td (after) Tj ET",
        );
        assert_eq!(texts(&extract(&bytes)), ["fake", "more", "after"]);
        let content = structured(&bytes);
        assert_eq!(run_texts(&content), ["Real text", "after"]);
    }

    #[test]
    fn actual_text_decodes_utf16_and_survives_nesting() {
        let bytes = simple_pdf(
            "/Span << /ActualText <FEFF00520065006100E7> >> BDC /P BMC BT /F1 10 Tf 50 700 Td (x) Tj ET EMC /Span << /ActualText (inner) >> BDC BT /F1 10 Tf 50 680 Td (y) Tj ET EMC EMC",
        );
        assert_eq!(run_texts(&structured(&bytes)), ["Rea\u{e7}"]);
    }

    #[test]
    fn unterminated_actual_text_does_not_leak_into_the_next_form() {
        let bytes =
            simple_pdf("/Span << /ActualText (Only) >> BDC BT /F1 10 Tf 50 700 Td (a) Tj ET");
        assert_eq!(run_texts(&structured(&bytes)), ["Only"]);
    }

    #[test]
    fn stroked_segments_become_rulings() {
        let bytes = simple_pdf(
            "BT /F1 10 Tf 50 700 Td (x) Tj ET 1 w 100 500 m 300 500 l S 200 400 m 200 600.4 l S 100 300 m 200 400 l S",
        );
        let content = structured(&bytes);
        assert_eq!(content.rulings.len(), 2);
        let horizontal = content.rulings[0];
        assert_eq!(
            (horizontal.x0, horizontal.y0, horizontal.x1, horizontal.y1),
            (100.0_f64, 500.0_f64, 300.0_f64, 500.0_f64)
        );
        let vertical = content.rulings[1];
        assert_eq!((vertical.x0, vertical.x1), (200.0_f64, 200.0_f64));
        assert!((vertical.y1 - 600.4).abs() < 1e-9_f64);
        assert!(extract_runs_rulings_empty(&bytes));
    }

    fn extract_runs_rulings_empty(bytes: &[u8]) -> bool {
        let limits = Limits::default();
        let document = Document::open(bytes, &limits).unwrap();
        let pages = document.pages().unwrap();
        let capture = Capture {
            reposition: Reposition::Split,
            structure: false,
            split_style: false,
        };
        extract_content(
            &document,
            pages.first().unwrap(),
            &limits,
            capture,
            &mut Session::default(),
        )
        .unwrap()
        .rulings
        .is_empty()
    }

    #[test]
    fn rectangles_apply_the_ctm_and_respect_paint_operators() {
        let bytes = simple_pdf(
            "BT /F1 10 Tf 50 700 Td (x) Tj ET q 2 0 0 2 0 0 cm 10 10 50 20 re S Q 100 100 80 0.5 re f 300 300 40 40 re f 0 0 600 800 re S 10 10 580 780 re S 20 20 100 100 re W n",
        );
        let content = structured(&bytes);
        let lines: Vec<(f64, f64, f64, f64)> = content
            .rulings
            .iter()
            .map(|ruling| (ruling.x0, ruling.y0, ruling.x1, ruling.y1))
            .collect();
        assert!(lines.contains(&(20.0_f64, 20.0_f64, 120.0_f64, 20.0_f64)));
        assert!(lines.contains(&(20.0_f64, 60.0_f64, 120.0_f64, 60.0_f64)));
        assert!(lines.contains(&(20.0_f64, 20.0_f64, 20.0_f64, 60.0_f64)));
        assert!(lines.contains(&(120.0_f64, 20.0_f64, 120.0_f64, 60.0_f64)));
        assert!(lines.contains(&(100.0_f64, 100.25_f64, 180.0_f64, 100.25_f64)));
        assert_eq!(lines.len(), 5);
    }

    #[test]
    fn rotated_ctm_rectangles_and_polylines_are_axis_checked() {
        let bytes = simple_pdf(
            "BT /F1 10 Tf 50 700 Td (x) Tj ET q 0 1 -1 0 0 0 cm 10 10 50 20 re S Q q 0.7 0.7 -0.7 0.7 0 0 cm 10 10 50 20 re S Q 400 400 m 500 400 l 500 500 l 400 500 l h S",
        );
        let content = structured(&bytes);
        assert_eq!(content.rulings.len(), 4 + 4);
    }

    #[test]
    fn bold_fonts_mark_runs() {
        let bytes = page_pdf(
            "<< /Font << /F1 5 0 R /F2 6 0 R >> >>",
            "BT /F1 10 Tf 50 700 Td (plain) Tj ET BT /F2 10 Tf 50 680 Td (heavy) Tj ET BT /F1 10 Tf 50 660 Td (mix ) Tj /F2 10 Tf (bold) Tj ET",
            &[(5, HELVETICA.to_owned()), (6, HELVETICA_BOLD.to_owned())],
        );
        let content = structured(&bytes);
        let flags: Vec<(&str, bool)> = content
            .runs
            .iter()
            .map(|run| (content.text_of(run), run.bold))
            .collect();
        assert_eq!(
            flags,
            [("plain", false), ("heavy", true), ("mix bold", false)]
        );
    }

    #[test]
    fn path_capture_is_bounded_by_the_item_limit() {
        let mut content = String::from("BT /F1 10 Tf 50 700 Td (x) Tj ET ");
        for index in 0_i32..50_i32 {
            write!(
                content,
                "{} 10 m {} 10 l S ",
                index * 5_i32,
                index * 5_i32 + 20_i32
            )
            .unwrap();
        }
        let bytes = simple_pdf(&content);
        let limits = Limits {
            max_items_per_page: 8,
            ..Limits::default()
        };
        let document = Document::open(&bytes, &limits).unwrap();
        let pages = document.pages().unwrap();
        let capture = Capture {
            reposition: Reposition::Split,
            structure: true,
            split_style: false,
        };
        let result = extract_content(
            &document,
            pages.first().unwrap(),
            &limits,
            capture,
            &mut Session::default(),
        )
        .unwrap();
        assert_eq!(result.rulings.len(), 8);
    }

    #[test]
    fn session_reuses_fonts_across_pages() {
        let bytes = simple_pdf("BT /F1 10 Tf 20 100 Td (Again) Tj ET");
        let limits = Limits::default();
        let document = Document::open(&bytes, &limits).unwrap();
        let pages = document.pages().unwrap();
        let page = pages.first().unwrap();
        let mut session = Session::default();
        for _ in 0_i32..3_i32 {
            let runs = extract_runs(&document, page, &limits, true, &mut session).unwrap();
            assert_eq!(run_texts(&runs), ["Again"]);
        }
        assert_eq!(session.fonts.len(), 1);
    }

    fn shared_inline_font_pdf() -> Vec<u8> {
        let content = "BT /F1 10 Tf 20 100 Td (Shared) Tj ET";
        let form = stream_object(
            "/Type /XObject /Subtype /Form /BBox [0 0 600 800] /Resources 5 0 R",
            "BT /F1 10 Tf 20 200 Td (Form) Tj ET",
        );
        build(&[
            (1, "<< /Type /Catalog /Pages 2 0 R >>".to_owned()),
            (
                2,
                "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 /Resources 5 0 R >>".to_owned(),
            ),
            (
                3,
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents 4 0 R >>"
                    .to_owned(),
            ),
            (4, stream_object("", &format!("{content} /X Do"))),
            (
                5,
                format!("<< /Font << /F1 {HELVETICA} >> /XObject << /X 8 0 R >> >>"),
            ),
            (
                6,
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents 7 0 R >>"
                    .to_owned(),
            ),
            (7, stream_object("", content)),
            (8, form),
        ])
    }

    #[test]
    fn inline_fonts_in_shared_resources_load_once() {
        let bytes = shared_inline_font_pdf();
        let limits = Limits::default();
        let document = Document::open(&bytes, &limits).unwrap();
        let pages = document.pages().unwrap();
        let mut session = Session::default();
        let first = extract_runs(&document, &pages[0], &limits, true, &mut session).unwrap();
        let second = extract_runs(&document, &pages[1], &limits, true, &mut session).unwrap();
        assert_eq!(run_texts(&first), ["Shared", "Form"]);
        assert_eq!(run_texts(&second), ["Shared"]);
        assert_eq!(session.fonts.len(), 1);
        assert!(matches!(
            session.fonts.keys().next(),
            Some(FontKey::Within(_, 0))
        ));
    }

    #[test]
    fn forms_are_decoded_once_per_session_and_text_free_forms_are_skipped() {
        let bytes = shared_inline_font_pdf();
        let limits = Limits::default();
        let document = Document::open(&bytes, &limits).unwrap();
        let pages = document.pages().unwrap();
        let mut session = Session::default();
        for _ in 0_i32..3_i32 {
            let content = extract_runs(&document, &pages[0], &limits, true, &mut session).unwrap();
            assert_eq!(run_texts(&content), ["Shared", "Form"]);
        }
        assert_eq!(session.forms.entries.len(), 1);
        assert!(session.skipped.is_empty());

        let drawing = page_pdf(
            "<< /Font << /F1 5 0 R >> /XObject << /X 6 0 R >> >>",
            "/X Do BT /F1 10 Tf 20 100 Td (After) Tj ET",
            &[
                (5, HELVETICA.to_owned()),
                (
                    6,
                    stream_object(
                        "/Type /XObject /Subtype /Form /BBox [0 0 10 10]",
                        "0 0 m 10 10 l S",
                    ),
                ),
            ],
        );
        let drawn = Document::open(&drawing, &limits).unwrap();
        let drawn_pages = drawn.pages().unwrap();
        let mut fresh = Session::default();
        for _ in 0_i32..2_i32 {
            let content = extract_runs(&drawn, &drawn_pages[0], &limits, true, &mut fresh).unwrap();
            assert_eq!(run_texts(&content), ["After"]);
        }
        assert_eq!(fresh.forms.entries.len(), 0);
        assert!(fresh.skipped.contains(&ObjRef {
            number: 6,
            generation: 0
        }));
    }

    #[test]
    fn form_cache_stays_within_its_byte_budget() {
        let chunk = (MAX_CACHED_FORM_BYTES >> 1_i32) + 1;
        let block = |byte: u8| -> Rc<[u8]> { vec![byte; chunk].into() };
        let key = |number: u32| ObjRef {
            number,
            generation: 0,
        };
        let mut cache = FormCache::default();
        cache.insert(key(1), &block(1), 1);
        cache.insert(key(2), &block(2), 3);
        assert!(cache.get(key(1), 3).is_none());
        assert!(cache.get(key(2), 3).is_some());
        cache.insert(key(3), &block(3), 3);
        assert!(cache.get(key(3), 3).is_none());
        assert_eq!(cache.bytes, chunk);
        cache.insert(key(4), &vec![0; MAX_CACHED_FORM_BYTES + 1].into(), 9);
        assert!(cache.get(key(4), 9).is_none());
        assert!(cache.bytes <= MAX_CACHED_FORM_BYTES);
    }

    #[test]
    fn font_cache_eviction_keeps_fonts_of_the_previous_page() {
        let bytes = simple_pdf("BT /F1 10 Tf 20 100 Td (Hot) Tj ET");
        let limits = Limits::default();
        let document = Document::open(&bytes, &limits).unwrap();
        let pages = document.pages().unwrap();
        let mut session = Session::default();
        drop(extract_runs(&document, &pages[0], &limits, true, &mut session).unwrap());
        let (&hot_key, (hot, _)) = session.fonts.iter().next().unwrap();
        let shared_hot = Rc::clone(hot.as_ref().unwrap());
        session.generation = 100;
        session.fonts.get_mut(&hot_key).unwrap().1 = 100;
        for index in 0..=u32::try_from(MAX_CACHED_FONTS).unwrap() {
            drop(
                session
                    .fonts
                    .insert(FontKey::Inline(u32::MAX, index), (None, 0)),
            );
        }
        let runs = extract_runs(&document, &pages[0], &limits, true, &mut session).unwrap();
        assert_eq!(run_texts(&runs), ["Hot"]);
        assert_eq!(session.fonts.len(), 1);
        let (kept, _) = &session.fonts[&hot_key];
        assert!(Rc::ptr_eq(kept.as_ref().unwrap(), &shared_hot));
    }

    #[test]
    fn font_cache_eviction_keeps_fonts_inside_the_horizon() {
        let bytes = simple_pdf("BT /F1 10 Tf 20 100 Td (Hot) Tj ET");
        let limits = Limits::default();
        let document = Document::open(&bytes, &limits).unwrap();
        let pages = document.pages().unwrap();
        let mut session = Session::default();
        drop(extract_runs(&document, &pages[0], &limits, true, &mut session).unwrap());
        session.generation = 100;
        for (age, index) in (0..=FONT_HORIZON + 1).zip(0_u32..) {
            drop(session.fonts.insert(
                FontKey::Inline(u32::MAX, index),
                (None, 100_u32.wrapping_sub(age)),
            ));
        }
        for index in 0..=u32::try_from(MAX_CACHED_FONTS).unwrap() {
            drop(
                session
                    .fonts
                    .insert(FontKey::Inline(u32::MAX - 1, index), (None, 0)),
            );
        }
        drop(extract_runs(&document, &pages[0], &limits, true, &mut session).unwrap());
        let survivors = session
            .fonts
            .keys()
            .filter(|key| matches!(key, FontKey::Inline(id, _) if *id == u32::MAX))
            .count();
        assert_eq!(survivors, usize::try_from(FONT_HORIZON).unwrap() + 1);
        assert!(
            !session
                .fonts
                .keys()
                .any(|key| matches!(key, FontKey::Inline(id, _) if *id == u32::MAX - 1))
        );
    }

    #[test]
    fn streams_without_show_operators_are_skipped() {
        assert!(scan_shows(b"q 1 0 0 1 0 0 cm 0 0 m 10 10 l S Q") == Shows::Nothing);
        assert!(scan_shows(b"BT /F1 10 Tf 10 10 Td ET") == Shows::Nothing);
        assert!(scan_shows(b"BT (a)Tj ET") == Shows::Text);
        assert!(scan_shows(b"[(a) 1]TJ") == Shows::Text);
        assert!(scan_shows(b"(a)'") == Shows::Text);
        assert!(scan_shows(b"1 2 (a)\"") == Shows::Text);
        assert!(scan_shows(b"/X Do") == Shows::Forms);
        let content = "q ".repeat(1000);
        assert_eq!(
            extract_with(&simple_pdf(&content), &Limits::default()).unwrap(),
            []
        );
    }

    #[test]
    fn item_count_limit_is_enforced() {
        let content = "BT /F1 10 Tf 0 700 Td (a) Tj 0 -20 Td (b) Tj 0 -20 Td (c) Tj ET";
        let limits = Limits {
            max_items_per_page: 2,
            ..Limits::default()
        };
        let error = extract_with(&simple_pdf(content), &limits).unwrap_err();
        assert_eq!(error.code, FailureCode::LimitExceeded);
    }

    #[test]
    fn text_byte_limit_is_enforced() {
        let content = "BT /F1 10 Tf 0 700 Td (abcdefgh) Tj ET";
        let limits = Limits {
            max_text_bytes: 4,
            ..Limits::default()
        };
        let error = extract_with(&simple_pdf(content), &limits).unwrap_err();
        assert_eq!(error.code, FailureCode::LimitExceeded);
    }

    #[test]
    fn missing_font_and_malformed_content_degrade_gracefully() {
        let items = extract(&simple_pdf(
            "BT /Nope 10 Tf (lost) Tj /F1 10 Tf 0 700 Td (kept) Tj ET 1 2 3 foo ] > ( unterminated",
        ));
        assert_eq!(texts(&items), ["kept"]);
    }

    fn type0_pdf(content: &str) -> Vec<u8> {
        let cmap = "/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Adobe-Identity-UCS def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange 3 beginbfchar <0001> <0041> <0002> <0042> <0003> <0020> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end";
        page_pdf(
            "<< /Font << /F1 5 0 R >> >>",
            content,
            &[
                (
                    5,
                    "<< /Type /Font /Subtype /Type0 /BaseFont /Sample /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>".to_owned(),
                ),
                (
                    6,
                    "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Sample /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 500 /W [1 [600 700]] /FontDescriptor 8 0 R >>".to_owned(),
                ),
                (7, stream_object("", cmap)),
                (
                    8,
                    "<< /Type /FontDescriptor /FontName /Sample /Flags 4 /Ascent 800 /Descent -200 /CapHeight 700 /ItalicAngle 0 /StemV 80 /FontBBox [0 -200 1000 800] >>".to_owned(),
                ),
            ],
        )
    }

    #[test]
    fn type0_identity_with_to_unicode() {
        let items = extract(&type0_pdf(
            "BT /F1 10 Tf 20 100 Td <0001000300020001> Tj ET",
        ));
        assert_eq!(texts(&items), ["A BA"]);
        let item = &items[0];
        assert_rect(
            item,
            [
                20.0_f64,
                100.0_f64 - 2.0_f64,
                20.0_f64 + (0.6_f64 + 0.5_f64 + 0.7_f64 + 0.6_f64) * 10.0_f64,
                100.0_f64 + 8.0_f64,
            ],
        );
    }

    #[test]
    fn type0_descendant_fonts_as_indirect_array() {
        let cmap = "/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Adobe-Identity-UCS def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange 2 beginbfchar <0001> <0041> <0002> <0042> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end";
        let bytes = page_pdf(
            "<< /Font << /F1 5 0 R >> >>",
            "BT /F1 10 Tf 20 100 Td <00010002> Tj ET",
            &[
                (
                    5,
                    "<< /Type /Font /Subtype /Type0 /BaseFont /Sample /Encoding /Identity-H /DescendantFonts 9 0 R /ToUnicode 7 0 R >>".to_owned(),
                ),
                (9, "[6 0 R]".to_owned()),
                (
                    6,
                    "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Sample /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 500 >>".to_owned(),
                ),
                (7, stream_object("", cmap)),
            ],
        );
        assert_eq!(texts(&extract(&bytes)), ["AB"]);
    }

    #[test]
    fn truetype_without_encoding_falls_back_to_win_ansi() {
        let cmap = "/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Adobe-Identity-UCS def /CMapType 2 def 1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfrange <41> <5A> <0041> endbfrange endcmap CMapName currentdict /CMap defineresource pop end end";
        let bytes = page_pdf(
            "<< /Font << /F1 5 0 R >> >>",
            "BT /F1 10 Tf 20 100 Td (CONCORR\\312NCIA \\307\\303O) Tj ET",
            &[
                (
                    5,
                    "<< /Type /Font /Subtype /TrueType /BaseFont /AAAAMF+Custom /FirstChar 32 /LastChar 32 /Widths [250] /ToUnicode 7 0 R /FontDescriptor 8 0 R >>".to_owned(),
                ),
                (7, stream_object("", cmap)),
                (
                    8,
                    "<< /Type /FontDescriptor /FontName /AAAAMF+Custom /Flags 4 /Ascent 800 /Descent -200 /CapHeight 700 /ItalicAngle 0 /StemV 80 /FontBBox [0 -200 1000 800] >>".to_owned(),
                ),
            ],
        );
        assert_eq!(texts(&extract(&bytes)), ["CONCORR\u{ca}NCIA \u{c7}\u{c3}O"]);
    }

    #[test]
    fn indirect_encoding_dictionary_applies_differences() {
        let bytes = page_pdf(
            "<< /Font << /F1 5 0 R >> >>",
            "BT /F1 10 Tf 20 100 Td (A\\001) Tj ET",
            &[
                (
                    5,
                    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding 9 0 R >>"
                        .to_owned(),
                ),
                (
                    9,
                    "<< /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [1 /eacute] >>"
                        .to_owned(),
                ),
            ],
        );
        assert_eq!(texts(&extract(&bytes)), ["A\u{e9}"]);
    }

    #[test]
    fn fonts_are_cached_across_forms() {
        let form = "<< /Type /XObject /Subtype /Form /BBox [0 0 10 10] /Length 30 >>\nstream\nBT /F1 10 Tf (Form) Tj ET\nendstream".to_owned();
        let bytes = page_pdf(
            "<< /Font << /F1 5 0 R >> /XObject << /X 6 0 R >> >>",
            "BT /F1 10 Tf 0 700 Td (Page) Tj ET q 1 0 0 1 0 -50 cm /X Do Q q 1 0 0 1 0 -100 cm /X Do Q",
            &[(5, HELVETICA.to_owned()), (6, form)],
        );
        let items = extract(&bytes);
        assert_eq!(texts(&items), ["Page", "Form", "Form"]);
    }

    fn goldens(source: &str) -> Vec<Vec<Golden>> {
        let parsed = Json::parse(source);
        parsed
            .list("pages")
            .iter()
            .map(|page| {
                page.list("textItems")
                    .iter()
                    .map(|item| Golden {
                        text: item.text("text").to_owned(),
                        x: item.number("x"),
                        y: item.number("y"),
                        width: item.number("width"),
                        height: item.number("height"),
                    })
                    .collect()
            })
            .collect()
    }

    fn top_left(rect: [f64; 4], crop: [f64; 4], rotate: i32) -> [f64; 4] {
        let [left, bottom, right, top] = rect;
        let (cx, cy, cw, ch) = (crop[0], crop[1], crop[2] - crop[0], crop[3] - crop[1]);
        match rotate.rem_euclid(360) {
            90 => [bottom - cy, left - cx, top - bottom, right - left],
            180 => [cx + cw - right, bottom - cy, right - left, top - bottom],
            270 => [cy + ch - top, cx + cw - right, top - bottom, right - left],
            _ => [left - cx, cy + ch - top, right - left, top - bottom],
        }
    }

    fn inspect_text(bytes: &[u8]) -> Inspection {
        inspect(
            bytes,
            &InspectOptions {
                runs: false,
                text: true,
                links: false,
                page_indexes: None,
            },
            &Limits::default(),
        )
        .unwrap()
    }

    fn fixtures() -> Vec<(&'static str, &'static [u8], &'static str)> {
        let all = [
            ("helvetica-winansi", fixture!("helvetica-winansi")),
            ("react-pdf-declaration", fixture!("react-pdf-declaration")),
            ("rotated-cropped", fixture!("rotated-cropped")),
            ("links", fixture!("links")),
            ("habilitacao-150", fixture!("habilitacao-150")),
            ("object-streams", fixture!("object-streams")),
            ("incremental-update", fixture!("incremental-update")),
            ("icp-signed", fixture!("icp-signed")),
            ("broken-xref", fixture!("broken-xref")),
        ];
        all.into_iter()
            .map(|(name, (bytes, golden))| (name, bytes, golden))
            .collect()
    }

    fn normalized(text: &str) -> String {
        text.chars()
            .filter(|ch| !ch.is_whitespace())
            .map(|ch| if ch == '\u{2014}' { '-' } else { ch })
            .collect()
    }

    #[test]
    fn fixtures_match_liteparse_goldens() {
        let mut compared = 0_usize;
        for (name, bytes, golden) in fixtures() {
            let inspection = inspect_text(bytes);
            let golden_next = goldens(golden);
            assert_eq!(
                inspection.text.len(),
                golden_next.len(),
                "{name} page count"
            );
            for (page_index, expected_items) in golden_next.iter().enumerate() {
                let page = inspection.pages[page_index];
                let items = &inspection.text[page_index].items;
                assert_eq!(
                    items.len(),
                    expected_items.len(),
                    "{name} page {page_index} item count"
                );
                for (item, expected) in items.iter().zip(expected_items) {
                    assert_eq!(
                        normalized(&item.text),
                        normalized(&expected.text),
                        "{name} page {page_index}"
                    );
                    let actual = top_left(item.rect, page.crop_box, page.rotate);
                    let wanted = [expected.x, expected.y, expected.width, expected.height];
                    for (value, target) in actual.iter().zip(wanted) {
                        assert!(
                            (value - target).abs() <= 0.5_f64,
                            "{name} page {page_index} {:?}: {actual:?} vs {wanted:?}",
                            expected.text
                        );
                    }
                    compared += 1;
                }
            }
        }
        assert!(compared > 400);
    }

    fn flatten(items: &[TextItem]) -> Vec<String> {
        items.iter().map(|item| item.text.clone()).collect()
    }

    #[test]
    fn anchor_tokens_are_found_on_expected_pages() {
        let find = |name: &str, needle: &str| -> Vec<usize> {
            let (_, bytes, _) = fixtures()
                .into_iter()
                .find(|(candidate, _, _)| *candidate == name)
                .unwrap();
            let inspection = inspect_text(bytes);
            inspection
                .text
                .iter()
                .filter(|page| {
                    flatten(&page.items)
                        .iter()
                        .any(|text| text.contains(needle))
                })
                .map(|page| widen(page.page_index))
                .collect()
        };
        assert_eq!(find("helvetica-winansi", "[[licitei-assinatura]]"), [0]);
        assert_eq!(find("helvetica-winansi", "{{signature}}"), [0]);
        assert_eq!(find("helvetica-winansi", "123.456.789-09"), [0]);
        assert_eq!(find("helvetica-winansi", "12.345.678/0001-95"), [0]);
        assert_eq!(find("react-pdf-declaration", "[[licitei-assinatura]]"), [0]);
        assert_eq!(find("habilitacao-150", "[[licitei-assinatura]]"), [149]);
    }

    #[test]
    fn invisible_anchor_keeps_its_own_item_in_react_pdf_fixture() {
        let (_, bytes, _) = fixtures()
            .into_iter()
            .find(|(name, _, _)| *name == "react-pdf-declaration")
            .unwrap();
        let inspection = inspect_text(bytes);
        let anchor = inspection.text[0]
            .items
            .iter()
            .find(|item| item.text == "[[licitei-assinatura]]")
            .unwrap();
        assert!(close(anchor.font_size, 4.0));
    }

    #[test]
    fn extraction_survives_random_content_streams() {
        let mut state = 0x2545_f491_4f6c_dd1d_u64;
        let mut next = || {
            state ^= state << 13_i32;
            state ^= state >> 7_i32;
            state ^= state << 17_i32;
            state
        };
        let tokens = [
            "BT",
            "ET",
            "q",
            "Q",
            "cm",
            "Tf",
            "Td",
            "TD",
            "Tm",
            "T*",
            "Tj",
            "TJ",
            "'",
            "\"",
            "Do",
            "/F1",
            "/X",
            "12",
            "-3.5",
            "0",
            "1e9",
            "(abc)",
            "<4142>",
            "[(a) -300 (b)]",
            "Tz",
            "Tc",
            "Tw",
            "TL",
            "Ts",
            "Tr",
            "0",
            "1",
            "]",
            ">",
            "(",
            "<<",
            "BI",
            "ID",
            "EI",
        ];
        for _ in 0_i32..300_i32 {
            let mut content = String::new();
            for _ in 0_i32..200_i32 {
                content.push_str(
                    tokens[usize::try_from(
                        next().rem_euclid(u64::try_from(tokens.len()).unwrap()),
                    )
                    .unwrap()],
                );
                content.push(' ');
            }
            let bytes = page_pdf(
                "<< /Font << /F1 5 0 R >> /XObject << /X 6 0 R >> >>",
                &content,
                &[
                    (5, HELVETICA.to_owned()),
                    (
                        6,
                        "<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] /Length 25 >>\nstream\nBT /F1 9 Tf (x) Tj ET /X Do\nendstream".to_owned(),
                    ),
                ],
            );
            drop(black_box(extract_with(&bytes, &Limits::default())));
        }
    }

    #[test]
    fn identity_v_text_flows_top_to_bottom_around_the_vertical_origin() {
        let to_unicode = stream_object(
            "",
            "1 begincodespacerange <0000> <ffff> endcodespacerange 1 beginbfrange <0001> <0003> <0041> endbfrange",
        );
        let bytes = page_pdf(
            "<< /Font << /F1 5 0 R >> >>",
            "BT /F1 10 Tf 100 700 Td <000100020003> Tj ET",
            &[
                (
                    5,
                    "<< /Type /Font /Subtype /Type0 /BaseFont /Test /Encoding /Identity-V /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>".to_owned(),
                ),
                (
                    6,
                    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /Test /DW 800 /DW2 [900 -1200] /W2 [2 [-600 100 800]] >>".to_owned(),
                ),
                (7, to_unicode),
            ],
        );
        let items = extract(&bytes);
        assert_eq!(texts(&items), ["ABC"]);
        let item = items.first().unwrap();
        assert!(close(item.rect[0], 100.0 - 4.0), "{:?}", item.rect);
        assert!(close(item.rect[2], 99.0 + 8.0), "{:?}", item.rect);
        assert!(close(item.rect[3], 700.0), "{:?}", item.rect);
        assert!(
            close(item.rect[3] - item.rect[1], 12.0 + 6.0 + 12.0),
            "{:?}",
            item.rect
        );
    }
}
