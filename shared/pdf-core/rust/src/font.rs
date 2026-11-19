use crate::cmap::text_usable;
use crate::num::{f64_to_i64, widen};
use alloc::rc::Rc;
use core::cell::{OnceCell, RefCell};
use core::iter;
use core::ops::Range;
use std::collections::HashMap;
use std::sync::OnceLock;

use crate::cmap::{CMap, UnicodeMap, covering, disjoint};
use crate::failure::{Failure, Outcome};
use crate::font_tables::{BuiltinEncoding, Standard14Font, encoding_glyph_name};
use crate::fontprog::{
    FontProgram, FontStyle, SFNT_DIRECTORY_LEN, agl_components, load_font_file_bytes,
    load_font_file_prefix, parse_font_program, sfnt_style_extent, sfnt_style_of,
};
use crate::inspection::Limits;
use crate::object::{Dict, Object, Resolver};

const MAX_METRIC_ENTRIES: usize = 0x0004_0000;
const MAX_METRIC_ITEMS: usize = 0x0010_0000;
const MAX_WIDTH_RANGE: u32 = 0x0001_0000;
const MAX_DENSE_WIDTHS: usize = 0x0001_0000;
const MAX_CMAP_DEPTH: usize = 4;
const MAX_PROGRAM_CHECKS: usize = 4096;
const LIGATURES: [&str; 14] = [
    "ff", "fi", "fl", "ffi", "ffl", "ft", "tt", "ti", "tf", "fj", "fb", "fh", "fk", "ffj",
];
const LIGATURE_EDGE_TOLERANCE: f64 = 0.004;
const LIGATURE_ADVANCE_BELOW: f64 = 0.10;
const LIGATURE_ADVANCE_ABOVE: f64 = 0.03;
const DEFAULT_VERTICAL_ORIGIN: f64 = 880.0;
const DEFAULT_VERTICAL_ADVANCE: f64 = 1000.0;
const UNRESOLVED: IdentitySlot = IdentitySlot {
    start: usize::MAX,
    end: usize::MAX,
    advance: 0.0,
};
static BUILTIN_TEXT_TABLES: [OnceLock<Vec<Option<Vec<u32>>>>; BuiltinEncoding::COUNT] =
    [const { OnceLock::new() }; BuiltinEncoding::COUNT];

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Glyph {
    pub advance: f64,
    pub code: u32,
    pub is_word_space: bool,
    pub text: Range<usize>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct VerticalMetrics {
    pub advance: f64,
    pub origin_x: f64,
    pub origin_y: f64,
}

pub(crate) struct Font {
    inner: FontKind,
}

enum FontKind {
    Composite(Box<CompositeFont>),
    Simple(Box<SimpleFont>),
}

struct SimpleFont {
    cache: Vec<OnceCell<Box<[u32]>>>,
    encoding: EncodingState,
    font_scale: Option<f64>,
    program: Option<FontProgram>,
    symbolic: bool,
    to_unicode: UnicodeMap,
    widths: WidthState,
}

struct CompositeFont {
    cache: RefCell<HashMap<u32, Box<[u32]>>>,
    cid_to_gid: CidToGid,
    cmap: CMap,
    gid_to_cid: OnceCell<HashMap<u16, u32>>,
    horizontal: CidWidths,
    identity: RefCell<IdentityTable>,
    program: Option<FontProgram>,
    to_unicode: UnicodeMap,
    vertical: VerticalCidMetrics,
}

#[derive(Clone, Copy)]
struct IdentitySlot {
    advance: f64,
    end: usize,
    start: usize,
}

#[derive(Default)]
struct IdentityTable {
    slots: Vec<IdentitySlot>,
    text: String,
}

enum CidToGid {
    Identity,
    Table(Vec<u8>),
}

struct EncodingState {
    base_explicit: bool,
    builtin: BuiltinEncoding,
    differences: Vec<(u8, Vec<u8>)>,
}

struct WidthState {
    first_char: i64,
    missing: f64,
    standard14: Option<Standard14Font>,
    widths: Vec<f64>,
}

struct CidWidths {
    default_width: f64,
    dense: Vec<f64>,
    entries: Vec<(u32, u32, f64)>,
}

struct VerticalCidMetrics {
    advance: f64,
    entries: Vec<(u32, u32, [f64; 3])>,
    origin_y: f64,
}

impl Font {
    pub(crate) fn decode(&self, bytes: &[u8], glyphs: &mut Vec<Glyph>, text: &mut String) {
        match &self.inner {
            FontKind::Simple(simple) => simple.decode(bytes, glyphs, text),
            FontKind::Composite(composite) => composite.decode(bytes, glyphs, text),
        }
    }

    pub(crate) fn is_vertical(&self) -> bool {
        match &self.inner {
            FontKind::Simple(_) => false,
            FontKind::Composite(composite) => composite.cmap.is_vertical(),
        }
    }

    pub(crate) fn load(resolver: &dyn Resolver, font: &Dict, limits: &Limits) -> Outcome<Self> {
        Self::load_with(resolver, font, limits, false)
    }

    pub(crate) fn load_for_render(
        resolver: &dyn Resolver,
        font: &Dict,
        limits: &Limits,
    ) -> Outcome<Self> {
        Self::load_with(resolver, font, limits, true)
    }

    fn load_with(
        resolver: &dyn Resolver,
        font: &Dict,
        limits: &Limits,
        force_program: bool,
    ) -> Outcome<Self> {
        let subtype = name_bytes(font.get(b"Subtype"));
        let inner = if subtype == Some(b"Type0") {
            FontKind::Composite(Box::new(load_type0(resolver, font, limits, force_program)?))
        } else {
            FontKind::Simple(Box::new(load_simple(
                resolver,
                font,
                limits,
                force_program,
            )?))
        };
        Ok(Self { inner })
    }

    pub(crate) fn maps_to_notdef(&self, code: u32) -> bool {
        match &self.inner {
            FontKind::Simple(simple) => {
                simple.encoding.difference(code) == Some(b".notdef")
                    && simple.to_unicode.usable(code).is_none()
            }
            FontKind::Composite(_) => false,
        }
    }

    pub(crate) fn program(&self) -> Option<&FontProgram> {
        match &self.inner {
            FontKind::Simple(simple) => simple.program.as_ref(),
            FontKind::Composite(composite) => composite.program.as_ref(),
        }
    }

    pub(crate) fn program_style(&self) -> Option<FontStyle> {
        let program = match &self.inner {
            FontKind::Simple(simple) => simple.program.as_ref(),
            FontKind::Composite(composite) => composite.program.as_ref(),
        };
        program.map(FontProgram::style)
    }

    pub(crate) fn render_gid(&self, code: u32) -> Option<u16> {
        match &self.inner {
            FontKind::Simple(simple) => simple.render_gid(code),
            FontKind::Composite(composite) => {
                let program = composite.program.as_ref()?;
                composite.gid_for_cid(program, code)
            }
        }
    }

    pub(crate) fn render_name(&self, code: u32) -> Option<&[u8]> {
        match &self.inner {
            FontKind::Simple(simple) => simple.encoding_name(code),
            FontKind::Composite(_) => None,
        }
    }

    pub(crate) fn vertical_metrics(&self, code: u32) -> VerticalMetrics {
        match &self.inner {
            FontKind::Simple(_) => VerticalMetrics {
                advance: DEFAULT_VERTICAL_ADVANCE / 1000.0,
                origin_x: 0.5,
                origin_y: DEFAULT_VERTICAL_ORIGIN / 1000.0,
            },
            FontKind::Composite(composite) => composite.vertical_metrics(code),
        }
    }
}

impl SimpleFont {
    fn decode(&self, bytes: &[u8], glyphs: &mut Vec<Glyph>, text: &mut String) {
        let table = self.plain_table();
        for byte in bytes {
            let code = u32::from(*byte);
            let advance = self.width_for_code(code);
            let text_start = text.len();
            match table {
                Some(inner_table) => {
                    if let Some(Some(slice)) = inner_table.get(usize::from(*byte)) {
                        push_codepoints(text, slice);
                    }
                }
                None => {
                    if let Some(cell) = self.cache.get(usize::from(*byte)) {
                        push_codepoints(text, cell.get_or_init(|| self.resolve(code)));
                    }
                }
            }
            glyphs.push(Glyph {
                code,
                advance,
                is_word_space: *byte == 32,
                text: text_start..text.len(),
            });
        }
    }

    fn encoding_name(&self, code: u32) -> Option<&[u8]> {
        if let Some(name) = self.encoding.difference(code) {
            return Some(name);
        }
        let byte = u8::try_from(code).ok()?;
        let base = encoding_glyph_name(self.encoding.builtin, byte);
        (!base.is_empty()).then_some(base.as_bytes())
    }

    fn gid_text(&self, program: &FontProgram, gid: u16) -> Option<Vec<u32>> {
        if let Some(text) = program.gid_text(gid) {
            return Some(text);
        }
        compose_parts(program, gid, |part| {
            let code = program.code_for_gid(part)?;
            self.to_unicode
                .usable(code)
                .map(|found| found.as_slice().to_vec())
        })
        .or_else(|| {
            shape_ligature(program, gid, |letter| {
                let code = self.to_unicode.code_for_char(u32::from(letter))?;
                program.code_to_gid(code, self.symbolic)
            })
        })
    }

    fn name_text(&self, name: &[u8]) -> Option<Vec<u32>> {
        agl_components(name).or_else(|| {
            let program = self.program.as_ref()?;
            let gid = program.gid_for_name(name)?;
            self.gid_text(program, gid)
        })
    }

    fn plain_table(&self) -> Option<&'static [Option<Vec<u32>>]> {
        let plain = self.to_unicode.is_empty()
            && self.encoding.differences.is_empty()
            && self.program.is_none()
            && !self.symbolic;
        if !plain {
            return None;
        }
        let builtin = self.encoding.builtin;
        let slot = BUILTIN_TEXT_TABLES.get(builtin.slot()?)?;
        Some(
            slot.get_or_init(|| {
                (0..=255_u8)
                    .map(|code| {
                        let name = encoding_glyph_name(builtin, code);
                        match agl_components(name.as_bytes()) {
                            Some(found) => Some(found),
                            None if name.is_empty() => Some(vec![u32::from(code)]),
                            None => None,
                        }
                    })
                    .collect()
            })
            .as_slice(),
        )
    }

    fn program_text(&self, code: u32) -> Option<Vec<u32>> {
        let program = self.program.as_ref()?;
        if let Ok(byte) = u8::try_from(code)
            && let Some(name) = program.builtin_name(byte)
            && let Some(text) = self.name_text(name)
        {
            return Some(text);
        }
        let gid = program.code_to_gid(code, self.symbolic)?;
        self.gid_text(program, gid)
    }

    fn render_gid(&self, code: u32) -> Option<u16> {
        let program = self.program.as_ref()?;
        let byte = u8::try_from(code).ok()?;
        if program.has_authoritative_names() {
            let name = self
                .encoding
                .difference(code)
                .or_else(|| {
                    self.encoding.base_explicit.then(|| {
                        let base = encoding_glyph_name(self.encoding.builtin, byte);
                        (!base.is_empty()).then_some(base.as_bytes())
                    })?
                })
                .or_else(|| program.builtin_name(byte))
                .or_else(|| {
                    let standard = encoding_glyph_name(BuiltinEncoding::Standard, byte);
                    (!standard.is_empty()).then_some(standard.as_bytes())
                })?;
            return program
                .gid_for_name(name)
                .or_else(|| program.type1_gid(name));
        }
        if !program.has_cmaps() {
            return Some(u16::from(byte));
        }
        if self.symbolic
            && let Some(gid) = program.code_to_gid(code, true)
        {
            return Some(gid);
        }
        if let Some(name) = self.encoding_name(code) {
            if let Some(gid) = agl_components(name)
                .filter(|codepoints| codepoints.len() == 1)
                .and_then(|codepoints| program.code_to_gid(*codepoints.first()?, false))
            {
                return Some(gid);
            }
            if let Some(gid) = program.gid_for_name(name) {
                return Some(gid);
            }
        }
        program.code_to_gid(code, self.symbolic)
    }

    fn resolve(&self, code: u32) -> Box<[u32]> {
        if let Some(found) = self.to_unicode.usable(code) {
            return found.as_slice().into();
        }
        if let Some(name) = self.encoding.difference(code)
            && let Some(text) = self.name_text(name)
        {
            return text.into();
        }
        let base = u8::try_from(code)
            .map(|byte| encoding_glyph_name(self.encoding.builtin, byte))
            .unwrap_or_default();
        if self.encoding.base_explicit
            && let Some(text) = agl_components(base.as_bytes())
        {
            return text.into();
        }
        let authoritative = self
            .program
            .as_ref()
            .is_some_and(FontProgram::has_authoritative_names);
        if authoritative && let Some(text) = self.program_text(code) {
            return text.into();
        }
        if let Some(text) = agl_components(base.as_bytes()) {
            return text.into();
        }
        if !authoritative && let Some(text) = self.program_text(code) {
            return text.into();
        }
        if self.symbolic {
            let mapped = symbolic_fallback(code);
            return if mapped == 0 {
                Box::new([])
            } else {
                Box::new([mapped])
            };
        }
        if base.is_empty() && code <= 0xFF {
            return Box::new([code]);
        }
        Box::new([])
    }

    fn width_for_code(&self, code: u32) -> f64 {
        let width = self.widths.standard14.map_or_else(
            || {
                u32::try_from(self.widths.first_char)
                    .ok()
                    .and_then(|first| code.checked_sub(first))
                    .and_then(|offset| self.widths.widths.get(widen(offset)))
                    .copied()
                    .unwrap_or(self.widths.missing)
            },
            |standard| {
                let index = usize::try_from(code.min(255)).unwrap_or_default();
                standard
                    .widths()
                    .get(index)
                    .copied()
                    .map_or(self.widths.missing, f64::from)
            },
        );
        self.font_scale
            .map_or_else(|| width / 1_000.0_f64, |scale| width * scale)
    }
}

impl EncodingState {
    fn difference(&self, code: u32) -> Option<&[u8]> {
        let code_u8 = u8::try_from(code).ok()?;
        self.differences
            .iter()
            .rev()
            .find(|(slot, _)| *slot == code_u8)
            .map(|(_, name)| name.as_slice())
    }
}

impl CompositeFont {
    fn cid_for_gid(&self, program: &FontProgram, gid: u16) -> Option<u32> {
        if program.is_cid_keyed() {
            return program.gid_to_cid(gid);
        }
        match &self.cid_to_gid {
            CidToGid::Identity => Some(u32::from(gid)),
            CidToGid::Table(table) => self
                .gid_to_cid
                .get_or_init(|| {
                    let mut map = HashMap::new();
                    for (cid, pair) in table.as_chunks::<2>().0.iter().enumerate() {
                        let mapped = (u16::from(pair.first().copied().unwrap_or(0)) << 8_i32)
                            | u16::from(pair.get(1).copied().unwrap_or(0));
                        let _: &mut u32 = map
                            .entry(mapped)
                            .or_insert_with(|| u32::try_from(cid).unwrap_or(u32::MAX));
                    }
                    map
                })
                .get(&gid)
                .copied(),
        }
    }

    fn decode(&self, bytes: &[u8], glyphs: &mut Vec<Glyph>, text: &mut String) {
        if self.cmap.is_identity() {
            self.decode_identity(bytes, glyphs, text);
            return;
        }
        let mut offset = 0_usize;
        while let Some((code, consumed)) = self.cmap.read(bytes, offset) {
            offset = offset.saturating_add(consumed);
            let cid = self.cmap.cid(code, consumed);
            let advance = self.horizontal.width(cid) / 1_000.0_f64;
            let text_start = text.len();
            self.push_text(code, cid, text);
            glyphs.push(Glyph {
                code: cid.unwrap_or(code),
                advance,
                is_word_space: consumed == 1 && code == 32,
                text: text_start..text.len(),
            });
        }
    }

    fn decode_identity(&self, bytes: &[u8], glyphs: &mut Vec<Glyph>, text: &mut String) {
        let mut table = self.identity.borrow_mut();
        for pair in bytes.as_chunks::<2>().0 {
            let short = u16::from_be_bytes(*pair);
            let code = u32::from(short);
            let index = usize::from(short);
            if table.slots.len() <= index {
                table.slots.resize(index.saturating_add(1), UNRESOLVED);
            }
            let mut slot = table.slots.get(index).copied().unwrap_or(UNRESOLVED);
            if slot.start == usize::MAX {
                let start = table.text.len();
                self.push_text(code, Some(code), &mut table.text);
                slot = IdentitySlot {
                    start,
                    end: table.text.len(),
                    advance: self.horizontal.width(Some(code)) / 1000.0,
                };
                if let Some(stored) = table.slots.get_mut(index) {
                    *stored = slot;
                }
            }
            let text_start = text.len();
            text.push_str(table.text.get(slot.start..slot.end).unwrap_or_default());
            glyphs.push(Glyph {
                code,
                advance: slot.advance,
                is_word_space: false,
                text: text_start..text.len(),
            });
        }
    }

    fn gid_for_cid(&self, program: &FontProgram, cid: u32) -> Option<u16> {
        if program.is_cid_keyed() {
            return program.cid_to_gid(cid);
        }
        match &self.cid_to_gid {
            CidToGid::Identity => u16::try_from(cid).ok(),
            CidToGid::Table(table) => {
                let position = usize::try_from(cid).ok()?.checked_mul(2)?;
                let pair = table.get(position..position.checked_add(2)?)?;
                Some((u16::from(*pair.first()?) << 8) | u16::from(*pair.get(1)?))
            }
        }
    }

    fn program_text(&self, cid: u32) -> Option<Vec<u32>> {
        let program = self.program.as_ref()?;
        let gid = self.gid_for_cid(program, cid)?;
        if let Some(text) = program.gid_text(gid) {
            return Some(text);
        }
        compose_parts(program, gid, |part| {
            let part_cid = self.cid_for_gid(program, part)?;
            self.to_unicode
                .usable(part_cid)
                .map(|found| found.as_slice().to_vec())
        })
        .or_else(|| {
            if !self.cmap.is_identity() {
                return None;
            }
            shape_ligature(program, gid, |letter| {
                let code = self.to_unicode.code_for_char(u32::from(letter))?;
                self.gid_for_cid(program, code)
            })
        })
    }

    fn push_text(&self, code: u32, cid: Option<u32>, text: &mut String) {
        if let Some(found) = self.to_unicode.usable(code) {
            push_codepoints(text, found.as_slice());
            return;
        }
        if let Some(direct) = self.cmap.direct_unicode(code) {
            push_codepoints(text, &direct);
            return;
        }
        if self.program.is_none() {
            return;
        }
        let key = cid.unwrap_or(code);
        if let Some(cached) = self.cache.borrow().get(&code) {
            push_codepoints(text, cached);
            return;
        }
        let resolved: Box<[u32]> = self.program_text(key).unwrap_or_default().into();
        push_codepoints(text, &resolved);
        drop(self.cache.borrow_mut().insert(code, resolved));
    }

    fn vertical_metrics(&self, code: u32) -> VerticalMetrics {
        let horizontal = self.horizontal.width(Some(code));
        let found = find_entry(&self.vertical.entries, code);
        let [advance, origin_x, origin_y] = found.unwrap_or([
            self.vertical.advance,
            horizontal / 2.0_f64,
            self.vertical.origin_y,
        ]);
        VerticalMetrics {
            advance: advance.abs() / 1000.0,
            origin_x: origin_x / 1000.0,
            origin_y: origin_y / 1000.0,
        }
    }
}

impl CidWidths {
    fn new(default_width: f64, entries: Vec<(u32, u32, f64)>) -> Self {
        let span = entries
            .last()
            .map_or(0, |entry| widen(entry.1).saturating_add(1));
        let covered = entries.iter().fold(0_usize, |sum, entry| {
            sum.saturating_add(widen(entry.1.saturating_sub(entry.0)).saturating_add(1))
        });
        let mut dense = Vec::new();
        if span <= MAX_DENSE_WIDTHS && span <= covered.saturating_mul(4).saturating_add(4096) {
            dense.resize(span, default_width);
            for &(start, end, width) in &entries {
                if let Some(slots) = dense.get_mut(widen(start)..=widen(end)) {
                    slots.fill(width);
                }
            }
        }
        Self {
            default_width,
            dense,
            entries,
        }
    }

    fn width(&self, cid: Option<u32>) -> f64 {
        let Some(cid_next) = cid else {
            return self.default_width;
        };
        if self.dense.is_empty() {
            return find_entry(&self.entries, cid_next).unwrap_or(self.default_width);
        }
        self.dense
            .get(widen(cid_next))
            .copied()
            .unwrap_or(self.default_width)
    }
}

fn is_mark(codepoint: u32) -> bool {
    matches!(codepoint, 0x5E | 0x60 | 0x7E | 0xA8 | 0xAF | 0xB4 | 0xB8)
        || (0x02C6..=0x02DD).contains(&codepoint)
        || (0x0300..=0x036F).contains(&codepoint)
}

fn compose_parts(
    program: &FontProgram,
    gid: u16,
    outside: impl Fn(u16) -> Option<Vec<u32>>,
) -> Option<Vec<u32>> {
    let parts = program.gid_parts(gid)?;
    let mut text = Vec::new();
    for part in parts {
        let piece = program.gid_text(part).or_else(|| outside(part))?;
        if piece.iter().any(|codepoint| is_mark(*codepoint)) {
            return None;
        }
        text.extend(piece);
    }
    (!text.is_empty()).then_some(text)
}

fn shape_ligature(
    program: &FontProgram,
    gid: u16,
    letter_gid: impl Fn(char) -> Option<u16>,
) -> Option<Vec<u32>> {
    let ligature = program.glyph_metrics(gid)?;
    let em = f64::from(ligature.units_per_em);
    let mut found: Option<&str> = None;
    for candidate in LIGATURES {
        let mut advance = 0.0_f64;
        let mut x_min = f64::MAX;
        let mut y_min = f64::MAX;
        let mut y_max = f64::MIN;
        let mut complete = true;
        for (index, letter) in candidate.chars().enumerate() {
            let Some(metrics) =
                letter_gid(letter).and_then(|inner_letter| program.glyph_metrics(inner_letter))
            else {
                complete = false;
                break;
            };
            if index == 0 {
                x_min = f64::from(metrics.x_min);
            }
            advance += f64::from(metrics.advance);
            y_min = y_min.min(f64::from(metrics.y_min));
            y_max = y_max.max(f64::from(metrics.y_max));
        }
        if !complete {
            continue;
        }
        let tolerance = LIGATURE_EDGE_TOLERANCE * em;
        let drift = f64::from(ligature.advance) - advance;
        let matches = (f64::from(ligature.x_min) - x_min).abs() <= tolerance
            && (f64::from(ligature.y_min) - y_min).abs() <= tolerance
            && (f64::from(ligature.y_max) - y_max).abs() <= tolerance
            && drift >= -LIGATURE_ADVANCE_BELOW * em
            && drift <= LIGATURE_ADVANCE_ABOVE * em;
        if matches {
            if found.is_some() {
                return None;
            }
            found = Some(candidate);
        }
    }
    found.map(|text| text.chars().map(u32::from).collect())
}

fn find_entry<T>(entries: &[(u32, u32, T)], cid: u32) -> Option<T>
where
    T: Copy,
{
    covering(entries, cid).map(|(_, _, value)| *value)
}

fn resolve_entries<T>(entries: &[(u32, u32, T)]) -> Vec<(u32, u32, T)>
where
    T: Copy,
{
    let spans: Vec<(u32, u32)> = entries
        .iter()
        .map(|(start, end, _)| (*start, *end))
        .collect();
    disjoint(&spans)
        .into_iter()
        .filter_map(|(start, end, index)| entries.get(index).map(|entry| (start, end, entry.2)))
        .collect()
}

fn deref(resolver: &dyn Resolver, value: Option<&Object>) -> Option<Rc<Object>> {
    resolver.resolve(value?).ok()
}

fn deref_dict(resolver: &dyn Resolver, value: Option<&Object>) -> Option<Dict> {
    deref(resolver, value)?.as_dict().cloned()
}

fn load_simple(
    resolver: &dyn Resolver,
    font: &Dict,
    limits: &Limits,
    force_program: bool,
) -> Outcome<SimpleFont> {
    let subtype = name_bytes(font.get(b"Subtype"));
    let descriptor = deref_dict(resolver, font.get(b"FontDescriptor"));
    let flags = descriptor
        .as_ref()
        .and_then(|dict| read_integer(dict.get(b"Flags")))
        .unwrap_or(0);
    let symbolic = flags & 4 != 0 && flags & 32 == 0;
    let encoding = load_encoding(font, resolver, limits)?;
    let to_unicode = load_to_unicode(font, resolver, limits);
    let widths = load_widths(
        resolver,
        font,
        descriptor.as_ref(),
        subtype == Some(b"Type3"),
    );
    let font_scale = read_font_matrix(resolver, font)
        .map(|matrix| (matrix[0] * matrix[0] + matrix[1] * matrix[1]).sqrt())
        .filter(|scale| *scale > 0.0_f64);
    let needs_program =
        force_program || simple_needs_program(&encoding, &to_unicode, &widths, symbolic);
    let program = descriptor
        .as_ref()
        .filter(|_| needs_program && subtype != Some(b"Type3"))
        .and_then(|dict| read_font_program(dict, resolver, limits));
    let mut simple = SimpleFont {
        encoding,
        to_unicode,
        program,
        widths,
        font_scale,
        symbolic,
        cache: Vec::new(),
    };
    if simple.plain_table().is_none() {
        simple.cache = iter::repeat_with(OnceCell::new).take(256).collect();
    }
    Ok(simple)
}

fn simple_needs_program(
    encoding: &EncodingState,
    to_unicode: &UnicodeMap,
    widths: &WidthState,
    symbolic: bool,
) -> bool {
    let (first, last) = if widths.widths.is_empty() {
        (0_u32, 255_u32)
    } else {
        let first = u32::try_from(widths.first_char.clamp(0, 255)).unwrap_or(u32::MAX);
        let last = first
            .saturating_add(u32::try_from(widths.widths.len()).unwrap_or(u32::MAX))
            .saturating_sub(1)
            .min(255);
        (first, last)
    };
    for code in first..=last {
        if let Some(found) = to_unicode.lookup(code) {
            if text_usable(found.as_slice()) {
                continue;
            }
            return true;
        }
        if let Some(name) = encoding.difference(code) {
            if agl_components(name).is_some() {
                continue;
            }
            return true;
        }
        if encoding.base_explicit {
            let name = u8::try_from(code)
                .map(|byte| encoding_glyph_name(encoding.builtin, byte))
                .unwrap_or_default();
            if name.is_empty() || agl_components(name.as_bytes()).is_some() {
                continue;
            }
            return true;
        }
        if symbolic {
            return true;
        }
    }
    false
}

fn load_type0(
    resolver: &dyn Resolver,
    font: &Dict,
    limits: &Limits,
    force_program: bool,
) -> Outcome<CompositeFont> {
    let descendant = resolve_descendant(resolver, font)?;
    let to_unicode = load_to_unicode(font, resolver, limits);
    let cmap = load_cmap(resolver, font.get(b"Encoding"), limits, 0);
    let horizontal = load_cid_widths(resolver, &descendant);
    let vertical = load_vertical_metrics(resolver, &descendant);
    let needs_program = force_program
        || !cmap.is_unicode_keyed()
            && (to_unicode.is_empty()
                || to_unicode.has_unusable()
                || (cmap.is_identity()
                    && horizontal
                        .entries
                        .iter()
                        .take(MAX_PROGRAM_CHECKS)
                        .any(|(start, _, _)| to_unicode.usable(*start).is_none())));
    let descriptor = deref_dict(resolver, descendant.get(b"FontDescriptor"));
    let program = descriptor
        .as_ref()
        .filter(|_| needs_program)
        .and_then(|dict| read_font_program(dict, resolver, limits));
    let cid_to_gid = if program.is_some() {
        load_cid_to_gid(resolver, &descendant, limits)
    } else {
        CidToGid::Identity
    };
    Ok(CompositeFont {
        cmap,
        to_unicode,
        program,
        cid_to_gid,
        gid_to_cid: OnceCell::new(),
        horizontal,
        vertical,
        cache: RefCell::new(HashMap::new()),
        identity: RefCell::new(IdentityTable::default()),
    })
}

fn load_cid_to_gid(resolver: &dyn Resolver, descendant: &Dict, limits: &Limits) -> CidToGid {
    match deref(resolver, descendant.get(b"CIDToGIDMap")).as_deref() {
        Some(Object::Stream(stream)) => match resolver.stream_data(stream) {
            Ok(data) if data.len() <= limits.max_decoded_stream_bytes => CidToGid::Table(data),
            _ => CidToGid::Identity,
        },
        _ => CidToGid::Identity,
    }
}

fn load_cmap(
    resolver: &dyn Resolver,
    encoding: Option<&Object>,
    limits: &Limits,
    depth: usize,
) -> CMap {
    let predefined = |name: &[u8]| {
        CMap::predefined(name).unwrap_or_else(|| CMap::identity(name.ends_with(b"-V")))
    };
    match deref(resolver, encoding).as_deref() {
        Some(Object::Name(name)) => predefined(name),
        Some(Object::Stream(stream)) => {
            let Ok(data) = resolver.stream_data(stream) else {
                return CMap::identity(false);
            };
            if data.len() > limits.max_decoded_stream_bytes {
                return CMap::identity(false);
            }
            let parsed = CMap::parse(&data, limits);
            let mut cmap = parsed.cmap;
            if depth < MAX_CMAP_DEPTH {
                let parent = match stream.dict.get(b"UseCMap") {
                    Some(use_cmap) => Some(load_cmap(
                        resolver,
                        Some(use_cmap),
                        limits,
                        depth.saturating_add(1),
                    )),
                    None => parsed.parent.as_deref().map(predefined),
                };
                if let Some(inner_parent) = parent {
                    cmap = cmap.with_parent(inner_parent);
                }
            }
            if let Some(Object::Integer(mode)) = stream.dict.get(b"WMode") {
                cmap = cmap.with_vertical(*mode == 1);
            }
            if cmap.is_empty_table() {
                CMap::identity(cmap.is_vertical())
            } else {
                cmap
            }
        }
        _ => CMap::identity(false),
    }
}

pub(crate) fn embedded_style(
    descriptor: &Dict,
    resolver: &dyn Resolver,
    limits: &Limits,
) -> Option<FontStyle> {
    let prefix = SFNT_DIRECTORY_LEN.min(limits.max_decoded_stream_bytes);
    let directory = load_font_file_prefix(b"FontFile2", descriptor, resolver, prefix).ok()?;
    let extent = sfnt_style_extent(&directory)?;
    if extent <= directory.len() {
        return sfnt_style_of(&directory);
    }
    let bytes = load_font_file_prefix(
        b"FontFile2",
        descriptor,
        resolver,
        extent.min(limits.max_decoded_stream_bytes),
    )
    .ok()?;
    sfnt_style_of(&bytes)
}

fn read_font_program(
    descriptor: &Dict,
    resolver: &dyn Resolver,
    limits: &Limits,
) -> Option<FontProgram> {
    for key in [b"FontFile2".as_slice(), b"FontFile3", b"FontFile"] {
        if descriptor.get(key).is_none() {
            continue;
        }
        if let Ok(bytes) = load_font_file_bytes(key, descriptor, resolver, limits)
            && let Some(program) = parse_font_program(bytes)
        {
            return Some(program);
        }
    }
    None
}

fn load_encoding(font: &Dict, resolver: &dyn Resolver, limits: &Limits) -> Outcome<EncodingState> {
    let subtype = name_bytes(font.get(b"Subtype"));
    let implied = match standard_symbol_font(font.get(b"BaseFont")) {
        Some(builtin) => builtin,
        None if subtype == Some(b"TrueType") => BuiltinEncoding::WinAnsi,
        None => BuiltinEncoding::Standard,
    };
    let mut state = EncodingState {
        builtin: implied,
        base_explicit: false,
        differences: Vec::new(),
    };
    match deref(resolver, font.get(b"Encoding")).as_deref() {
        None => {}
        Some(Object::Name(name)) => {
            state.builtin = builtin_from_name(name);
            state.base_explicit = true;
        }
        Some(Object::Stream(stream)) => {
            let data = resolver.stream_data(stream)?;
            if data.len() > limits.max_decoded_stream_bytes {
                return Err(Failure::limit("encoding stream exceeds limit"));
            }
            state.builtin = BuiltinEncoding::Custom;
        }
        Some(Object::Dict(dict)) => {
            if let Some(Object::Name(name)) = deref(resolver, dict.get(b"BaseEncoding")).as_deref()
            {
                state.builtin = builtin_from_name(name);
                state.base_explicit = true;
            }
            if let Some(Object::Array(entries)) =
                deref(resolver, dict.get(b"Differences")).as_deref()
            {
                load_differences(entries, &mut state);
            }
        }
        Some(_) => {
            state.builtin = BuiltinEncoding::PdfDoc;
            state.base_explicit = true;
        }
    }
    Ok(state)
}

fn load_differences(entries: &[Object], state: &mut EncodingState) {
    let mut code = 0_i64;
    for entry in entries {
        if let Object::Integer(value) = entry {
            code = *value;
        } else if let Object::Name(name) = entry {
            if let Ok(slot) = u8::try_from(code) {
                state.differences.push((slot, name.clone()));
            }
            code = code.saturating_add(1);
        }
    }
}

fn resolved_items(
    resolver: &dyn Resolver,
    value: Option<&Object>,
    limit: usize,
) -> Option<Vec<Object>> {
    let array = deref(resolver, value)?;
    let Object::Array(items) = &*array else {
        return None;
    };
    let resolve_one =
        |item: &Object| deref(resolver, Some(item)).map_or(Object::Null, |found| (*found).clone());
    Some(
        items
            .iter()
            .take(limit)
            .map(|item| match resolve_one(item) {
                Object::Array(inner) => {
                    Object::Array(inner.iter().take(limit).map(resolve_one).collect())
                }
                other @ (Object::Null
                | Object::Bool(_)
                | Object::Integer(_)
                | Object::Real(_)
                | Object::Name(_)
                | Object::String(_)
                | Object::Dict(_)
                | Object::Stream(_)
                | Object::Ref(_)) => other,
            })
            .collect(),
    )
}

fn deref_number(resolver: &dyn Resolver, value: Option<&Object>) -> Option<f64> {
    deref(resolver, value)?.as_number()
}

fn load_widths(
    resolver: &dyn Resolver,
    font: &Dict,
    descriptor: Option<&Dict>,
    type3: bool,
) -> WidthState {
    let first_char = deref(resolver, font.get(b"FirstChar"))
        .as_deref()
        .and_then(Object::as_integer)
        .unwrap_or(0);
    let widths = resolved_items(resolver, font.get(b"Widths"), MAX_METRIC_ENTRIES)
        .unwrap_or_default()
        .iter()
        .map(|item| item.as_number().unwrap_or(0.0_f64))
        .collect();
    let missing = descriptor
        .and_then(|dict| deref_number(resolver, dict.get(b"MissingWidth")))
        .unwrap_or(0.0_f64);
    WidthState {
        first_char,
        widths,
        missing: if type3 {
            0.0
        } else if missing > 0.0 {
            missing
        } else {
            1000.0
        },
        standard14: standard14_from_base_font(font.get(b"BaseFont")),
    }
}

fn load_cid_widths(resolver: &dyn Resolver, descendant: &Dict) -> CidWidths {
    let default_width = deref_number(resolver, descendant.get(b"DW")).unwrap_or(1_000.0_f64);
    let mut entries: Vec<(u32, u32, f64)> = Vec::new();
    if let Some(items) = resolved_items(resolver, descendant.get(b"W"), MAX_METRIC_ITEMS) {
        let mut index = 0_usize;
        while index < items.len() && entries.len() < MAX_METRIC_ENTRIES {
            let start = items
                .get(index)
                .and_then(Object::as_integer)
                .and_then(|value| u32::try_from(value).ok());
            index = index.saturating_add(1);
            match items.get(index) {
                Some(Object::Array(inner)) => {
                    index = index.saturating_add(1);
                    let Some(start_next) = start else { continue };
                    for (step, item) in inner.iter().enumerate() {
                        if let Some(width) = item.as_number() {
                            let cid =
                                start_next.saturating_add(u32::try_from(step).unwrap_or(u32::MAX));
                            entries.push((cid, cid, width));
                        }
                    }
                }
                Some(Object::Integer(end)) => {
                    let width = items
                        .get(index.saturating_add(1))
                        .and_then(Object::as_number);
                    index = index.saturating_add(2);
                    if let (Some(start_u32), Ok(end_u32), Some(width_u32)) =
                        (start, u32::try_from(*end), width)
                        && start_u32 <= end_u32
                    {
                        entries.push((
                            start_u32,
                            end_u32.min(start_u32.saturating_add(MAX_WIDTH_RANGE)),
                            width_u32,
                        ));
                    }
                }
                _ => index = index.saturating_add(1),
            }
        }
    }
    CidWidths::new(default_width, resolve_entries(&entries))
}

fn load_vertical_metrics(resolver: &dyn Resolver, descendant: &Dict) -> VerticalCidMetrics {
    let (origin_y, advance) = match deref(resolver, descendant.get(b"DW2")).as_deref() {
        Some(Object::Array(items)) => (
            items
                .first()
                .and_then(Object::as_number)
                .unwrap_or(DEFAULT_VERTICAL_ORIGIN),
            items
                .get(1)
                .and_then(Object::as_number)
                .unwrap_or(-DEFAULT_VERTICAL_ADVANCE),
        ),
        _ => (DEFAULT_VERTICAL_ORIGIN, -DEFAULT_VERTICAL_ADVANCE),
    };
    let mut entries: Vec<(u32, u32, [f64; 3])> = Vec::new();
    if let Some(items) = resolved_items(resolver, descendant.get(b"W2"), MAX_METRIC_ITEMS) {
        let mut index = 0_usize;
        while index < items.len() && entries.len() < MAX_METRIC_ENTRIES {
            let start = items
                .get(index)
                .and_then(Object::as_integer)
                .and_then(|value| u32::try_from(value).ok());
            index = index.saturating_add(1);
            match items.get(index) {
                Some(Object::Array(inner)) => {
                    index = index.saturating_add(1);
                    let Some(start_next) = start else { continue };
                    for (step, triple) in inner.as_chunks::<3>().0.iter().enumerate() {
                        let values: Vec<f64> =
                            triple.iter().filter_map(Object::as_number).collect();
                        if let [vertical_advance, origin_x, shift_y] = values.as_slice() {
                            let cid =
                                start_next.saturating_add(u32::try_from(step).unwrap_or(u32::MAX));
                            entries.push((cid, cid, [*vertical_advance, *origin_x, *shift_y]));
                        }
                    }
                }
                Some(Object::Integer(end)) => {
                    let values: Vec<f64> = (1..=3)
                        .filter_map(|offset| {
                            items
                                .get(index.saturating_add(offset))
                                .and_then(Object::as_number)
                        })
                        .collect();
                    let end_u32 = u32::try_from(*end).ok();
                    index = index.saturating_add(4);
                    if let (
                        Some(inner_start),
                        Some(inner_end),
                        [vertical_advance, origin_x, shift_y],
                    ) = (start, end_u32, values.as_slice())
                        && inner_start <= inner_end
                    {
                        entries.push((
                            inner_start,
                            inner_end.min(inner_start.saturating_add(MAX_WIDTH_RANGE)),
                            [*vertical_advance, *origin_x, *shift_y],
                        ));
                    }
                }
                _ => index = index.saturating_add(1),
            }
        }
    }
    VerticalCidMetrics {
        origin_y,
        advance,
        entries: resolve_entries(&entries),
    }
}

fn load_to_unicode(font: &Dict, resolver: &dyn Resolver, limits: &Limits) -> UnicodeMap {
    let program = deref(resolver, font.get(b"ToUnicode"));
    let Some(Object::Stream(stream)) = program.as_deref() else {
        return UnicodeMap::default();
    };
    match resolver.stream_data(stream) {
        Ok(data) if data.len() <= limits.max_decoded_stream_bytes => {
            UnicodeMap::parse(&data, limits)
        }
        _ => UnicodeMap::default(),
    }
}

fn resolve_descendant(resolver: &dyn Resolver, font: &Dict) -> Outcome<Dict> {
    let descendants = deref(resolver, font.get(b"DescendantFonts"));
    let Some(Object::Array(children)) = descendants.as_deref() else {
        return Err(Failure::invalid("Type0 font missing DescendantFonts"));
    };
    let first = children
        .first()
        .ok_or_else(|| Failure::invalid("Type0 font has empty DescendantFonts"))?;
    deref_dict(resolver, Some(first))
        .ok_or_else(|| Failure::invalid("Type0 descendant is not a font dictionary"))
}

fn read_font_matrix(resolver: &dyn Resolver, font: &Dict) -> Option<[f64; 6]> {
    let matrix_array = deref(resolver, font.get(b"FontMatrix"))?;
    let Object::Array(items) = &*matrix_array else {
        return None;
    };
    let mut matrix = [0.0_f64; 6];
    for (slot, item) in matrix.iter_mut().zip(items.iter()) {
        *slot = item.as_number()?;
    }
    (items.len() >= 6).then_some(matrix)
}

fn standard_symbol_font(name: Option<&Object>) -> Option<BuiltinEncoding> {
    match strip_subset_prefix(name_bytes(name)?) {
        b"Symbol" => Some(BuiltinEncoding::Symbol),
        b"ZapfDingbats" => Some(BuiltinEncoding::ZapfDingbats),
        _ => None,
    }
}

fn standard14_from_base_font(name: Option<&Object>) -> Option<Standard14Font> {
    let Object::Name(bytes) = name? else {
        return None;
    };
    match strip_subset_prefix(bytes) {
        b"Helvetica-Bold" | b"Arial,Bold" | b"Arial-Bold" => Some(Standard14Font::HelveticaBold),
        b"Helvetica-Oblique" => Some(Standard14Font::HelveticaOblique),
        b"Helvetica-BoldOblique" => Some(Standard14Font::HelveticaBoldOblique),
        b"Times-Roman" | b"TimesNewRoman" => Some(Standard14Font::TimesRoman),
        b"Times-Bold" => Some(Standard14Font::TimesBold),
        b"Times-Italic" => Some(Standard14Font::TimesItalic),
        b"Times-BoldItalic" => Some(Standard14Font::TimesBoldItalic),
        b"Courier" | b"CourierNew" => Some(Standard14Font::Courier),
        b"Courier-Bold" => Some(Standard14Font::CourierBold),
        b"Courier-Oblique" => Some(Standard14Font::CourierOblique),
        b"Courier-BoldOblique" => Some(Standard14Font::CourierBoldOblique),
        b"Symbol" => Some(Standard14Font::Symbol),
        b"ZapfDingbats" => Some(Standard14Font::ZapfDingbats),
        b"Helvetica" | b"Arial" => Some(Standard14Font::Helvetica),
        _ => None,
    }
}

fn strip_subset_prefix(name: &[u8]) -> &[u8] {
    name.iter()
        .position(|byte| *byte == b'+')
        .map_or(name, |index| {
            name.get(index.saturating_add(1)..).unwrap_or(name)
        })
}

const fn builtin_from_name(name: &[u8]) -> BuiltinEncoding {
    match name {
        b"WinAnsiEncoding" => BuiltinEncoding::WinAnsi,
        b"StandardEncoding" => BuiltinEncoding::Standard,
        b"MacRomanEncoding" => BuiltinEncoding::MacRoman,
        b"MacExpertEncoding" => BuiltinEncoding::MacExpert,
        _ => BuiltinEncoding::PdfDoc,
    }
}

fn name_bytes(value: Option<&Object>) -> Option<&[u8]> {
    match value {
        Some(Object::Name(bytes)) => Some(bytes),
        _ => None,
    }
}

const fn read_integer(value: Option<&Object>) -> Option<i64> {
    match value {
        Some(Object::Integer(inner_value)) => Some(*inner_value),
        Some(Object::Real(inner_value)) => Some(f64_to_i64(*inner_value)),
        _ => None,
    }
}

const fn symbolic_fallback(code: u32) -> u32 {
    if code >= 0xF000 {
        return code.saturating_sub(0xF000);
    }
    if code <= 0xFF {
        return code;
    }
    0
}

fn push_codepoints(text: &mut String, codepoints: &[u32]) {
    for cp in codepoints {
        if *cp == 0 || *cp == 0xFEFF {
            continue;
        }
        if let Some(ch) = char::from_u32(*cp)
            && (!ch.is_control() || matches!(ch, '\t' | '\n' | '\r'))
        {
            text.push(ch);
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::fontprog::tests::ligature_gsub;
    use alloc::collections::BTreeMap;

    use super::*;
    use crate::cff::tests::{Layout, build as build_cff};
    use crate::object::{ObjRef, Stream};
    use crate::test_pdf::assert_exact;
    use core::hint::black_box;

    #[derive(Default)]
    struct TestResolver {
        data: Vec<u8>,
        next: u32,
        objects: BTreeMap<u32, Object>,
    }

    impl TestResolver {
        fn add(&mut self, object: Object) -> Object {
            self.next = self.next.saturating_add(1);
            drop(self.objects.insert(self.next, object));
            Object::Ref(ObjRef {
                number: self.next,
                generation: 0,
            })
        }

        fn add_stream(&mut self, dict: Dict, bytes: &[u8]) -> Object {
            let start = self.data.len();
            self.data.extend_from_slice(bytes);
            let stream = Stream {
                decrypted: None,
                dict,
                data: start..self.data.len(),
            };
            self.add(Object::Stream(stream))
        }
    }

    impl Resolver for TestResolver {
        fn resolve(&self, object: &Object) -> Outcome<Rc<Object>> {
            if let Object::Ref(reference) = object {
                self.objects
                    .get(&reference.number)
                    .map(|found| Rc::new(found.clone()))
                    .ok_or_else(|| Failure::invalid("missing object"))
            } else {
                Ok(Rc::new(object.clone()))
            }
        }

        fn stream_data(&self, stream: &Stream) -> Outcome<Vec<u8>> {
            self.data
                .get(stream.data.clone())
                .map(<[u8]>::to_vec)
                .ok_or_else(|| Failure::invalid("stream bytes missing"))
        }
    }

    fn dict(entries: Vec<(&str, Object)>) -> Dict {
        let mut dict = Dict::default();
        for (key, value) in entries {
            dict.insert(key.as_bytes(), value);
        }
        dict
    }

    fn name(value: &str) -> Object {
        Object::Name(value.as_bytes().to_vec())
    }

    fn numbers(values: &[f64]) -> Object {
        Object::Array(values.iter().map(|value| Object::Real(*value)).collect())
    }

    fn decode(font: &Font, bytes: &[u8]) -> (String, Vec<Glyph>) {
        let mut glyphs = Vec::new();
        let mut text = String::new();
        font.decode(bytes, &mut glyphs, &mut text);
        (text, glyphs)
    }

    fn load(resolver: &TestResolver, font: &Dict) -> Font {
        Font::load(resolver, font, &Limits::default()).expect("font")
    }

    fn be16(value: u16) -> Vec<u8> {
        value.to_be_bytes().to_vec()
    }

    fn be32(value: u32) -> Vec<u8> {
        value.to_be_bytes().to_vec()
    }

    fn sfnt(tables: &[(&[u8; 4], Vec<u8>)]) -> Vec<u8> {
        let mut out = be32(0x0001_0000);
        out.extend(be16(u16::try_from(tables.len()).unwrap()));
        out.extend([0_u8; 6]);
        let mut offset = (tables.len().saturating_mul(16)).saturating_add(12);
        let mut bodies = Vec::new();
        for (tag, body) in tables {
            out.extend_from_slice(*tag);
            out.extend(be32(0));
            out.extend(be32(u32::try_from(offset).unwrap()));
            out.extend(be32(u32::try_from(body.len()).unwrap()));
            bodies.extend_from_slice(body);
            let padded = (body.len().saturating_add(3)) & !3;
            bodies.resize(
                (bodies.len().saturating_add(padded)).saturating_sub(body.len()),
                0,
            );
            offset = offset.saturating_add(padded);
        }
        out.extend(bodies);
        out
    }

    fn maxp(glyphs: u16) -> Vec<u8> {
        let mut out = be32(0x0001_0000);
        out.extend(be16(glyphs));
        out.extend([0_u8; 26]);
        out
    }

    fn format0_cmap(platform: u16, encoding: u16, map: &[(u8, u8)]) -> Vec<u8> {
        let mut glyphs = [0_u8; 256];
        for (code, gid) in map {
            glyphs[usize::from(*code)] = *gid;
        }
        let mut sub = be16(0);
        sub.extend(be16(262));
        sub.extend(be16(0));
        sub.extend(glyphs);
        let mut out = be16(0);
        out.extend(be16(1));
        out.extend(be16(platform));
        out.extend(be16(encoding));
        out.extend(be32(12));
        out.extend(sub);
        out
    }

    fn post2(names: &[&str]) -> Vec<u8> {
        let mut out = be32(0x0002_0000);
        out.extend([0_u8; 28]);
        out.extend(be16(u16::try_from(names.len()).unwrap()));
        let standard = ["A", "B", "space"];
        let mut strings = Vec::new();
        let mut custom = 0_u16;
        for entry in names {
            if let Some(index) = standard.iter().position(|std| std == entry) {
                out.extend(be16([36_u16, 37, 3][index]));
            } else if *entry == ".notdef" {
                out.extend(be16(0));
            } else {
                out.extend(be16(custom.saturating_add(258)));
                custom = custom.saturating_add(1);
                strings.push(u8::try_from(entry.len()).unwrap());
                strings.extend_from_slice(entry.as_bytes());
            }
        }
        out.extend(strings);
        out
    }

    fn truetype_ligature_font(extra: Vec<(&'static [u8; 4], Vec<u8>)>) -> Vec<u8> {
        let mut glyf = Vec::new();
        let mut loca = be32(0);
        let simple = |contours: u16| {
            let mut glyph = be16(contours);
            glyph.extend([0_u8; 12]);
            glyph
        };
        let mut composite = be16(0xFFFF);
        composite.extend([0_u8; 8]);
        composite.extend(be16(0x0022));
        composite.extend(be16(1));
        composite.extend([0, 0]);
        composite.extend(be16(0x0002));
        composite.extend(be16(2));
        composite.extend([40, 0]);
        for glyph in [simple(0), simple(1), simple(2), composite] {
            glyf.extend_from_slice(&glyph);
            while !glyf.len().is_multiple_of(4) {
                glyf.push(0);
            }
            loca.extend(be32(u32::try_from(glyf.len()).unwrap()));
        }
        let mut head = vec![0_u8; 54];
        head[51] = 1;
        let mut tables: Vec<(&[u8; 4], Vec<u8>)> = vec![
            (b"head", head),
            (b"maxp", maxp(4)),
            (b"loca", loca),
            (b"glyf", glyf),
        ];
        tables.extend(extra);
        sfnt(&tables)
    }

    fn type0_with_program(
        resolver: &mut TestResolver,
        program: &[u8],
        to_unicode: Option<&str>,
        cid_to_gid: Option<Vec<u8>>,
    ) -> Dict {
        let file = resolver.add_stream(Dict::default(), program);
        let descriptor = resolver.add(Object::Dict(dict(vec![
            ("Type", name("FontDescriptor")),
            ("FontFile2", file),
        ])));
        let mut descendant = dict(vec![
            ("Type", name("Font")),
            ("Subtype", name("CIDFontType2")),
            ("FontDescriptor", descriptor),
            ("DW", Object::Integer(500)),
        ]);
        if let Some(map) = cid_to_gid {
            let stream = resolver.add_stream(Dict::default(), &map);
            descendant.insert(b"CIDToGIDMap", stream);
        }
        let descendant_next = resolver.add(Object::Dict(descendant));
        let mut font = dict(vec![
            ("Type", name("Font")),
            ("Subtype", name("Type0")),
            ("Encoding", name("Identity-H")),
            ("DescendantFonts", Object::Array(vec![descendant_next])),
        ]);
        if let Some(cmap) = to_unicode {
            let stream = resolver.add_stream(Dict::default(), cmap.as_bytes());
            font.insert(b"ToUnicode", stream);
        }
        font
    }

    #[test]
    fn nul_mapped_ligature_cid_is_recovered_from_composite_glyph() {
        let mut resolver = TestResolver::default();
        let cmap = "1 begincodespacerange <0000> <ffff> endcodespacerange\n3 beginbfrange\n<0010> <0010> <0074>\n<0020> <0020> <0069>\n<0030> <0030> <0000>\nendbfrange";
        let mut map = vec![0_u8; 0x31 * 2];
        for (cid, gid) in [(0x10_usize, 1_u16), (0x20, 2), (0x30, 3)] {
            map[cid * 2] = u8::try_from(gid >> 8_i32).unwrap();
            map[cid * 2 + 1] = u8::try_from(gid).unwrap();
        }
        let font = type0_with_program(
            &mut resolver,
            &truetype_ligature_font(Vec::new()),
            Some(cmap),
            Some(map),
        );
        let font_next = load(&resolver, &font);
        let (text, glyphs) = decode(&font_next, &[0x00, 0x10, 0x00, 0x30, 0x00, 0x20]);
        assert_eq!(text, "ttii");
        assert_eq!(glyphs.len(), 3);
        assert!((glyphs[0].advance - 0.5).abs() < 1e-9_f64);
    }

    fn metric_font(glyphs: &[(i16, i16, i16, i16, u16)]) -> Vec<u8> {
        let mut glyf = Vec::new();
        let mut loca = be32(0);
        let mut hmtx = Vec::new();
        for (x_min, y_min, x_max, y_max, advance) in glyphs {
            glyf.extend(be16(1));
            for value in [x_min, y_min, x_max, y_max] {
                glyf.extend(be16((*value).cast_unsigned()));
            }
            glyf.extend([0_u8; 4]);
            loca.extend(be32(u32::try_from(glyf.len()).unwrap()));
            hmtx.extend(be16(*advance));
            hmtx.extend(be16((*x_min).cast_unsigned()));
        }
        let mut head = vec![0_u8; 54];
        head[18..20].copy_from_slice(&1000_u16.to_be_bytes());
        head[51] = 1;
        let mut hhea = vec![0_u8; 36];
        hhea[34..36].copy_from_slice(&(u16::try_from(glyphs.len()).unwrap()).to_be_bytes());
        sfnt(&[
            (b"head", head),
            (b"hhea", hhea),
            (b"maxp", maxp(u16::try_from(glyphs.len()).unwrap())),
            (b"hmtx", hmtx),
            (b"loca", loca),
            (b"glyf", glyf),
        ])
    }

    #[test]
    fn anonymous_ligature_glyph_is_recovered_from_letter_shapes() {
        let mut resolver = TestResolver::default();
        let program = metric_font(&[
            (0, 0, 0, 0, 500),
            (16, -8, 303, 584, 335),
            (65, -3, 164, 648, 229),
            (18, -3, 315, 684, 305),
            (75, -3, 155, 680, 229),
            (16, -8, 490, 648, 557),
            (18, -3, 520, 684, 529),
            (200, -3, 520, 684, 529),
        ]);
        let cmap = "beginbfrange <0001> <0001> <0074> <0002> <0002> <0069> <0003> <0003> <0066> <0004> <0004> <006c> <0005> <0007> <0000> endbfrange";
        let font = type0_with_program(&mut resolver, &program, Some(cmap), None);
        let font_next = load(&resolver, &font);
        assert_eq!(decode(&font_next, &[0, 5]).0, "ti");
        assert_eq!(decode(&font_next, &[0, 6]).0, "");
        assert_eq!(decode(&font_next, &[0, 7]).0, "");
        assert_eq!(decode(&font_next, &[0, 1, 0, 5, 0, 2]).0, "ttii");
    }

    #[test]
    fn ligature_shape_match_applies_to_simple_symbolic_fonts() {
        let mut resolver = TestResolver::default();
        let program = metric_font(&[
            (0, 0, 0, 0, 500),
            (16, -8, 303, 584, 335),
            (65, -3, 164, 648, 229),
            (16, -8, 490, 648, 557),
        ]);
        let cmap = sfnt_with_cmap(&program, format0_cmap(1, 0, &[(1, 1), (2, 2), (3, 3)]));
        let file = resolver.add_stream(Dict::default(), &cmap);
        let descriptor = resolver.add(Object::Dict(dict(vec![
            ("Flags", Object::Integer(4)),
            ("FontFile2", file),
        ])));
        let tu = resolver.add_stream(
            Dict::default(),
            b"beginbfchar <01> <0074> <02> <0069> <03> <0000> endbfchar",
        );
        let font = load(
            &resolver,
            &dict(vec![
                ("Subtype", name("TrueType")),
                ("FontDescriptor", descriptor),
                ("FirstChar", Object::Integer(1)),
                ("Widths", numbers(&[500.0_f64; 3])),
                ("ToUnicode", tu),
            ]),
        );
        assert_eq!(decode(&font, &[3]).0, "ti");
    }

    fn sfnt_with_cmap(base: &[u8], cmap: Vec<u8>) -> Vec<u8> {
        let count = usize::from(u16::from_be_bytes(base[4..6].try_into().unwrap()));
        let mut tables: Vec<(Vec<u8>, Vec<u8>)> = Vec::new();
        for index in 0..count {
            let start = index.saturating_mul(16).saturating_add(12);
            let record: [u8; 16] = base[start..start.saturating_add(16)].try_into().unwrap();
            let [t0, t1, t2, t3, _, _, _, _, o0, o1, o2, o3, l0, l1, l2, l3] = record;
            let offset = widen(u32::from_be_bytes([o0, o1, o2, o3]));
            let length = widen(u32::from_be_bytes([l0, l1, l2, l3]));
            tables.push((
                vec![t0, t1, t2, t3],
                base[offset..offset.saturating_add(length)].to_vec(),
            ));
        }
        tables.push((b"cmap".to_vec(), cmap));
        let borrowed: Vec<(&[u8; 4], Vec<u8>)> = tables
            .iter()
            .map(|(tag, body)| {
                let tag_next: &[u8; 4] = tag.as_slice().try_into().expect("tag");
                (tag_next, body.clone())
            })
            .collect();
        sfnt(&borrowed)
    }

    #[test]
    fn gsub_ligature_lookup_parts_resolve_through_to_unicode() {
        for extension in [false, true] {
            let mut resolver = TestResolver::default();
            let program = sfnt(&[
                (b"GSUB", ligature_gsub(extension, 1, &[2], 3)),
                (b"maxp", maxp(4)),
            ]);
            let cmap = "beginbfrange <0001> <0001> <0066> <0002> <0002> <0069> <0003> <0003> <0000> endbfrange";
            let font = type0_with_program(&mut resolver, &program, Some(cmap), None);
            let font_next = load(&resolver, &font);
            assert_eq!(
                decode(&font_next, &[0, 1, 0, 3]).0,
                "ffi",
                "extension={extension}"
            );
        }
    }

    #[test]
    fn program_is_not_loaded_when_to_unicode_is_complete() {
        let mut resolver = TestResolver::default();
        let cmap = "beginbfrange <0001> <0003> <0041> endbfrange";
        let mut font = type0_with_program(
            &mut resolver,
            &truetype_ligature_font(Vec::new()),
            Some(cmap),
            None,
        );
        font.insert(
            b"W",
            Object::Array(vec![
                Object::Integer(1),
                Object::Array(vec![Object::Integer(500)]),
            ]),
        );
        let font_next = load(&resolver, &font);
        match &font_next.inner {
            FontKind::Composite(composite) => assert!(composite.program.is_none()),
            FontKind::Simple(_) => panic!("composite expected"),
        }
        assert_eq!(decode(&font_next, &[0, 2]).0, "B");
    }

    #[test]
    fn valid_to_unicode_wins_over_program() {
        let mut resolver = TestResolver::default();
        let cmap = "beginbfrange <0010> <0010> <0058> <0030> <0030> <0000> endbfrange";
        let mut map = vec![0_u8; 0x31 * 2];
        map[0x30 * 2 + 1] = 3;
        map[0x10 * 2 + 1] = 1;
        let program = {
            let mut table = be32(0x0002_0000);
            table.extend([0_u8; 28]);
            table.extend(be16(4));
            for index in [0_u16, 36, 37, 258] {
                table.extend(be16(index));
            }
            table.push(3);
            table.extend(b"t_i");
            sfnt(&[(b"post", table), (b"maxp", maxp(4))])
        };
        let font = type0_with_program(&mut resolver, &program, Some(cmap), Some(map));
        let font_next = load(&resolver, &font);
        assert_eq!(decode(&font_next, &[0, 0x10]).0, "X");
        assert_eq!(decode(&font_next, &[0, 0x30]).0, "ti");
    }

    #[test]
    fn simple_symbolic_font_uses_cmap_and_post_names() {
        let mut resolver = TestResolver::default();
        let program = sfnt(&[
            (b"cmap", format0_cmap(1, 0, &[(1, 1), (2, 2), (3, 3)])),
            (b"post", post2(&[".notdef", "A", "t_i", "B"])),
            (b"maxp", maxp(4)),
        ]);
        let file = resolver.add_stream(Dict::default(), &program);
        let descriptor = resolver.add(Object::Dict(dict(vec![
            ("Flags", Object::Integer(4)),
            ("FontFile2", file),
        ])));
        let tu = resolver.add_stream(Dict::default(), b"beginbfchar <03> <0043> endbfchar");
        let font = load(
            &resolver,
            &dict(vec![
                ("Subtype", name("TrueType")),
                ("FontDescriptor", descriptor),
                ("FirstChar", Object::Integer(1)),
                ("Widths", numbers(&[500.0_f64, 500.0_f64, 500.0_f64])),
                ("ToUnicode", tu),
            ]),
        );
        let (text, glyphs) = decode(&font, &[1, 2, 3]);
        assert_eq!(text, "AtiC");
        assert_eq!(glyphs[1].text, 1..3);
    }

    #[test]
    fn composite_glyph_in_simple_font_resolves_parts_through_to_unicode() {
        let mut resolver = TestResolver::default();
        let program = truetype_ligature_font(vec![(
            b"cmap",
            format0_cmap(1, 0, &[(1, 1), (2, 2), (3, 3)]),
        )]);
        let file = resolver.add_stream(Dict::default(), &program);
        let descriptor = resolver.add(Object::Dict(dict(vec![
            ("Flags", Object::Integer(4)),
            ("FontFile2", file),
        ])));
        let tu = resolver.add_stream(
            Dict::default(),
            b"beginbfchar <01> <0066> <02> <0069> endbfchar",
        );
        let font = load(
            &resolver,
            &dict(vec![
                ("Subtype", name("TrueType")),
                ("FontDescriptor", descriptor),
                ("FirstChar", Object::Integer(1)),
                ("Widths", numbers(&[500.0_f64, 500.0_f64, 500.0_f64])),
                ("ToUnicode", tu),
            ]),
        );
        assert_eq!(decode(&font, &[3]).0, "fi");
    }

    #[test]
    fn cff_builtin_encoding_names_drive_simple_text() {
        let mut resolver = TestResolver::default();
        let mut charset = vec![0_u8];
        charset.extend(be16(34));
        charset.extend(be16(391));
        let cff = build_cff(&Layout {
            names: vec!["f_i"],
            charset,
            charset_id: 0,
            encoding: vec![0, 2, 0x41, 0x42],
            encoding_id: 0,
            cid_keyed: false,
            glyphs: 3,
        });
        let file = resolver.add_stream(dict(vec![("Subtype", name("Type1C"))]), &cff);
        let descriptor = resolver.add(Object::Dict(dict(vec![
            ("Flags", Object::Integer(4)),
            ("FontFile3", file),
        ])));
        let font = load(
            &resolver,
            &dict(vec![
                ("Subtype", name("Type1")),
                ("FontDescriptor", descriptor),
                ("FirstChar", Object::Integer(0x41)),
                ("Widths", numbers(&[600.0_f64, 600.0_f64])),
            ]),
        );
        assert_eq!(decode(&font, b"AB").0, "Afi");
    }

    #[test]
    fn type1_cleartext_encoding_drives_simple_text() {
        let mut resolver = TestResolver::default();
        let program = b"%!PS-AdobeFont-1.0: X\n/Encoding 256 array\ndup 1 /fi put\ndup 2 /uni0416 put\nreadonly def\ncurrentfile eexec";
        let file = resolver.add_stream(Dict::default(), program);
        let descriptor = resolver.add(Object::Dict(dict(vec![
            ("Flags", Object::Integer(4)),
            ("FontFile", file),
        ])));
        let font = load(
            &resolver,
            &dict(vec![
                ("Subtype", name("Type1")),
                ("FontDescriptor", descriptor),
                ("FirstChar", Object::Integer(1)),
                ("Widths", numbers(&[500.0_f64, 500.0_f64])),
            ]),
        );
        assert_eq!(decode(&font, &[1, 2]).0, "\u{fb01}\u{0416}");
    }

    #[test]
    fn opentype_cff_name_keyed_type0_maps_cid_through_names() {
        let mut resolver = TestResolver::default();
        let mut charset = vec![0_u8];
        charset.extend(be16(34));
        charset.extend(be16(391));
        let cff = build_cff(&Layout {
            names: vec!["t_i"],
            charset,
            charset_id: 0,
            encoding: vec![],
            encoding_id: 0,
            cid_keyed: false,
            glyphs: 3,
        });
        let mut otf = be32(0x4F54_544F);
        otf.extend(be16(1));
        otf.extend([0_u8; 6]);
        otf.extend(b"CFF ");
        otf.extend(be32(0));
        otf.extend(be32(28));
        otf.extend(be32(u32::try_from(cff.len()).unwrap()));
        otf.extend(&cff);
        let file = resolver.add_stream(Dict::default(), &otf);
        let descriptor = resolver.add(Object::Dict(dict(vec![("FontFile3", file)])));
        let descendant = resolver.add(Object::Dict(dict(vec![
            ("Subtype", name("CIDFontType0")),
            ("FontDescriptor", descriptor),
        ])));
        let font = load(
            &resolver,
            &dict(vec![
                ("Subtype", name("Type0")),
                ("Encoding", name("Identity-H")),
                ("DescendantFonts", Object::Array(vec![descendant])),
            ]),
        );
        assert_eq!(decode(&font, &[0, 1, 0, 2]).0, "Ati");
    }

    #[test]
    fn identity_decode_table_matches_on_repeat_and_ignores_odd_tail() {
        let mut resolver = TestResolver::default();
        let tu = resolver.add_stream(
            Dict::default(),
            b"beginbfchar <0003> <0020> <0005> <0000> endbfchar beginbfrange <0010> <0012> <0041> <0100> <0100> <00660069> endbfrange",
        );
        let descendant = resolver.add(Object::Dict(dict(vec![
            ("Subtype", name("CIDFontType2")),
            ("DW", Object::Integer(500)),
            (
                "W",
                Object::Array(vec![
                    Object::Integer(16),
                    Object::Array(vec![Object::Integer(250), Object::Integer(300)]),
                ]),
            ),
        ])));
        let font = load(
            &resolver,
            &dict(vec![
                ("Subtype", name("Type0")),
                ("Encoding", name("Identity-H")),
                ("ToUnicode", tu),
                ("DescendantFonts", Object::Array(vec![descendant])),
            ]),
        );
        let bytes = [0, 0x10, 0, 3, 0, 0x11, 1, 0, 0, 5, 0, 0x12, 0x10];
        let (first, first_glyphs) = decode(&font, &bytes);
        let (second, second_glyphs) = decode(&font, &bytes);
        assert_eq!(first, "A BfiC");
        assert_eq!(first, second);
        assert_eq!(first_glyphs, second_glyphs);
        let codes: Vec<u32> = first_glyphs.iter().map(|glyph| glyph.code).collect();
        assert_eq!(codes, [0x10, 3, 0x11, 0x100, 5, 0x12]);
        let advances: Vec<f64> = first_glyphs.iter().map(|glyph| glyph.advance).collect();
        assert_exact(
            &advances,
            &[0.25_f64, 0.5_f64, 0.3_f64, 0.5_f64, 0.5_f64, 0.5_f64],
        );
        let spans: Vec<&str> = first_glyphs
            .iter()
            .map(|glyph| first.get(glyph.text.clone()).unwrap())
            .collect();
        assert_eq!(spans, ["A", " ", "B", "fi", "", "C"]);
    }

    #[test]
    fn embedded_cmap_maps_codes_to_cids_for_widths_and_to_unicode_by_code() {
        let mut resolver = TestResolver::default();
        let cmap = b"1 begincodespacerange <00> <ff> endcodespacerange 1 begincidrange <41> <5a> 100 endcidrange";
        let stream = resolver.add_stream(dict(vec![("Type", name("CMap"))]), cmap);
        let tu = resolver.add_stream(Dict::default(), b"beginbfrange <41> <5a> <0061> endbfrange");
        let descendant = resolver.add(Object::Dict(dict(vec![
            ("Subtype", name("CIDFontType0")),
            ("DW", Object::Integer(1000)),
            (
                "W",
                Object::Array(vec![
                    Object::Integer(100),
                    Object::Array(vec![Object::Integer(250), Object::Integer(300)]),
                ]),
            ),
        ])));
        let font = load(
            &resolver,
            &dict(vec![
                ("Subtype", name("Type0")),
                ("Encoding", stream),
                ("ToUnicode", tu),
                ("DescendantFonts", Object::Array(vec![descendant])),
            ]),
        );
        let (text, glyphs) = decode(&font, b"ABC");
        assert_eq!(text, "abc");
        assert_eq!(glyphs[0].code, 100);
        assert!((glyphs[0].advance - 0.25).abs() < 1e-9_f64);
        assert!((glyphs[1].advance - 0.3).abs() < 1e-9_f64);
        assert!((glyphs[2].advance - 1.0).abs() < 1e-9_f64);
    }

    #[test]
    fn usecmap_stream_parent_provides_codespace_and_cids() {
        let mut resolver = TestResolver::default();
        let parent = resolver.add_stream(
            Dict::default(),
            b"1 begincodespacerange <0000> <ffff> endcodespacerange 1 begincidrange <0000> <00ff> 0 endcidrange",
        );
        let child = resolver.add_stream(
            dict(vec![("UseCMap", parent), ("WMode", Object::Integer(1))]),
            b"1 begincidrange <0100> <01ff> 500 endcidrange",
        );
        let descendant = resolver.add(Object::Dict(dict(vec![
            ("Subtype", name("CIDFontType0")),
            (
                "W",
                Object::Array(vec![
                    Object::Integer(500),
                    Object::Integer(510),
                    Object::Integer(400),
                ]),
            ),
        ])));
        let font = load(
            &resolver,
            &dict(vec![
                ("Subtype", name("Type0")),
                ("Encoding", child),
                ("DescendantFonts", Object::Array(vec![descendant])),
            ]),
        );
        assert!(font.is_vertical());
        let (_, glyphs) = decode(&font, &[0x01, 0x05, 0x00, 0x41]);
        assert_eq!(glyphs[0].code, 505);
        assert!((glyphs[0].advance - 0.4).abs() < 1e-9_f64);
        assert_eq!(glyphs[1].code, 0x41);
    }

    #[test]
    fn ucs2_predefined_cmap_decodes_unicode_without_to_unicode() {
        let mut resolver = TestResolver::default();
        let descendant = resolver.add(Object::Dict(dict(vec![
            ("Subtype", name("CIDFontType0")),
            ("DW", Object::Integer(1000)),
        ])));
        for (cmap, bytes, expected) in [
            (
                "UniGB-UCS2-H",
                vec![0x4E, 0x2D, 0x65, 0x87],
                "\u{4e2d}\u{6587}",
            ),
            (
                "UniJIS-UTF16-H",
                vec![0xD8, 0x40, 0xDC, 0x0B, 0x00, 0x41],
                "\u{2000B}A",
            ),
        ] {
            let font = load(
                &resolver,
                &dict(vec![
                    ("Subtype", name("Type0")),
                    ("Encoding", name(cmap)),
                    ("DescendantFonts", Object::Array(vec![descendant.clone()])),
                ]),
            );
            let (text, glyphs) = decode(&font, &bytes);
            assert_eq!(text, expected);
            assert!(
                glyphs
                    .iter()
                    .all(|glyph| (glyph.advance - 1.0).abs() < 1e-9_f64)
            );
        }
    }

    #[test]
    fn identity_v_uses_w2_and_dw2() {
        let mut resolver = TestResolver::default();
        let descendant = resolver.add(Object::Dict(dict(vec![
            ("Subtype", name("CIDFontType0")),
            ("DW", Object::Integer(800)),
            ("DW2", numbers(&[900.0_f64, -1_100.0_f64])),
            (
                "W2",
                Object::Array(vec![
                    Object::Integer(10),
                    Object::Array(vec![
                        Object::Integer(-500),
                        Object::Integer(300),
                        Object::Integer(700),
                    ]),
                    Object::Integer(20),
                    Object::Integer(22),
                    Object::Integer(-600),
                    Object::Integer(100),
                    Object::Integer(200),
                ]),
            ),
        ])));
        let font = load(
            &resolver,
            &dict(vec![
                ("Subtype", name("Type0")),
                ("Encoding", name("Identity-V")),
                ("DescendantFonts", Object::Array(vec![descendant])),
            ]),
        );
        assert!(font.is_vertical());
        let metrics = font.vertical_metrics(10);
        assert!((metrics.advance - 0.5).abs() < 1e-9_f64);
        assert!((metrics.origin_x - 0.3).abs() < 1e-9_f64);
        assert!((metrics.origin_y - 0.7).abs() < 1e-9_f64);
        let ranged = font.vertical_metrics(21);
        assert!((ranged.advance - 0.6).abs() < 1e-9_f64);
        assert!((ranged.origin_x - 0.1).abs() < 1e-9_f64);
        let default = font.vertical_metrics(99);
        assert!((default.advance - 1.1).abs() < 1e-9_f64);
        assert!((default.origin_x - 0.4).abs() < 1e-9_f64);
        assert!((default.origin_y - 0.9).abs() < 1e-9_f64);
    }

    #[test]
    fn identity_h_is_horizontal_by_default() {
        let mut resolver = TestResolver::default();
        let descendant = resolver.add(Object::Dict(dict(vec![("Subtype", name("CIDFontType2"))])));
        let font = load(
            &resolver,
            &dict(vec![
                ("Subtype", name("Type0")),
                ("Encoding", name("Identity-H")),
                ("DescendantFonts", Object::Array(vec![descendant])),
            ]),
        );
        assert!(!font.is_vertical());
    }

    #[test]
    fn type3_advance_uses_widths_and_font_matrix() {
        let mut resolver = TestResolver::default();
        let tu = resolver.add_stream(Dict::default(), b"beginbfchar <41> <0058> endbfchar");
        for (matrix, expected) in [
            (
                vec![0.001_f64, 0.0_f64, 0.0_f64, 0.001_f64, 0.0_f64, 0.0_f64],
                0.5_f64,
            ),
            (
                vec![0.01_f64, 0.0_f64, 0.0_f64, 0.01_f64, 0.0_f64, 0.0_f64],
                5.0_f64,
            ),
            (
                vec![0.0_f64, 0.002_f64, -0.002_f64, 0.0_f64, 0.0_f64, 0.0_f64],
                1.0_f64,
            ),
        ] {
            let font = load(
                &resolver,
                &dict(vec![
                    ("Subtype", name("Type3")),
                    ("FontMatrix", numbers(&matrix)),
                    ("FirstChar", Object::Integer(0x41)),
                    ("Widths", numbers(&[500.0_f64])),
                    ("ToUnicode", tu.clone()),
                ]),
            );
            let (text, glyphs) = decode(&font, b"AB");
            assert_eq!(text, "XB");
            assert!(
                (glyphs[0].advance - expected).abs() < 1e-9_f64,
                "{matrix:?}"
            );
            assert_exact(&[glyphs[1].advance], &[0.0_f64]);
        }
    }

    #[test]
    fn type3_differences_names_resolve_via_agl() {
        let resolver = TestResolver::default();
        let font = load(
            &resolver,
            &dict(vec![
                ("Subtype", name("Type3")),
                (
                    "Encoding",
                    Object::Dict(dict(vec![(
                        "Differences",
                        Object::Array(vec![Object::Integer(1), name("fi"), name("a1")]),
                    )])),
                ),
                (
                    "FontMatrix",
                    numbers(&[0.001_f64, 0.0_f64, 0.0_f64, 0.001_f64, 0.0_f64, 0.0_f64]),
                ),
            ]),
        );
        assert_eq!(decode(&font, &[1, 2]).0, "\u{fb01}");
    }

    #[test]
    fn plain_fonts_share_cached_tables_and_match_slow_path() {
        let resolver = TestResolver::default();
        for encoding in [
            "WinAnsiEncoding",
            "StandardEncoding",
            "MacRomanEncoding",
            "MacExpertEncoding",
        ] {
            let font = load(
                &resolver,
                &dict(vec![
                    ("Subtype", name("Type1")),
                    ("Encoding", name(encoding)),
                ]),
            );
            let FontKind::Simple(simple) = &font.inner else {
                panic!("simple expected");
            };
            assert!(simple.plain_table().is_some());
            let all: Vec<u8> = (0..=255).collect();
            let (fast, glyphs) = decode(&font, &all);
            assert_eq!(glyphs.len(), 256);
            let mut slow = String::new();
            for code in 0..=255_u32 {
                push_codepoints(&mut slow, &simple.resolve(code));
            }
            assert_eq!(fast, slow, "{encoding}");
        }
    }

    #[test]
    fn symbol_font_uses_symbol_encoding_names() {
        let resolver = TestResolver::default();
        let font = load(
            &resolver,
            &dict(vec![
                ("Subtype", name("Type1")),
                ("BaseFont", name("Symbol")),
            ]),
        );
        assert_eq!(decode(&font, b"a").0, "\u{3b1}");
    }

    #[test]
    fn differences_override_base_encoding() {
        let resolver = TestResolver::default();
        let font = load(
            &resolver,
            &dict(vec![
                ("Subtype", name("TrueType")),
                (
                    "Encoding",
                    Object::Dict(dict(vec![
                        ("BaseEncoding", name("WinAnsiEncoding")),
                        (
                            "Differences",
                            Object::Array(vec![Object::Integer(65), name("Euro"), name("uni0416")]),
                        ),
                    ])),
                ),
            ]),
        );
        assert_eq!(decode(&font, b"ABC").0, "\u{20ac}\u{416}C");
    }

    #[test]
    fn standard14_widths_spot_check() {
        let helvetica = Standard14Font::Helvetica.widths();
        assert_eq!(helvetica[widen(b'A')], 667);
        assert_eq!(helvetica[widen(b' ')], 278);
        let times = Standard14Font::TimesRoman.widths();
        assert_eq!(times[widen(b' ')], 250);
        let courier = Standard14Font::Courier.widths();
        assert_eq!(courier[widen(b'A')], 600);
    }

    #[test]
    fn subset_prefix_standard14() {
        let base = Object::Name(b"ABCDEF+Helvetica".to_vec());
        assert_eq!(
            standard14_from_base_font(Some(&base)),
            Some(Standard14Font::Helvetica)
        );
    }

    #[test]
    fn word_space_flag_only_for_single_byte_space() {
        let resolver = TestResolver::default();
        let font = load(&resolver, &dict(vec![("Subtype", name("Type1"))]));
        let (_, glyphs) = decode(&font, b"a b");
        assert!(!glyphs[0].is_word_space);
        assert!(glyphs[1].is_word_space);
    }

    #[test]
    fn width_arrays_support_ranges_and_lists() {
        let widths = Object::Array(vec![
            Object::Integer(1),
            Object::Array(vec![Object::Integer(100), Object::Integer(200)]),
            Object::Integer(10),
            Object::Integer(20),
            Object::Integer(300),
        ]);
        let descendant = dict(vec![("W", widths), ("DW", Object::Integer(700))]);
        let metrics = load_cid_widths(&TestResolver::default(), &descendant);
        assert_exact(&[metrics.width(Some(1))], &[100.0_f64]);
        assert_exact(&[metrics.width(Some(2))], &[200.0_f64]);
        assert_exact(&[metrics.width(Some(3))], &[700.0_f64]);
        assert_exact(&[metrics.width(Some(15))], &[300.0_f64]);
        assert_exact(&[metrics.width(Some(21))], &[700.0_f64]);
        assert_exact(&[metrics.width(None)], &[700.0_f64]);
    }

    #[test]
    fn overlapping_width_entries_resolve_to_the_latest_definition() {
        let mut items = vec![
            Object::Integer(0),
            Object::Integer(400),
            Object::Integer(900),
        ];
        for cid in 1..=40 {
            items.push(Object::Integer(cid * 10));
            items.push(Object::Array(vec![Object::Integer(cid)]));
        }
        items.extend([
            Object::Integer(1),
            Object::Array(vec![Object::Integer(100), Object::Integer(200)]),
            Object::Integer(2),
            Object::Integer(5),
            Object::Integer(300),
        ]);
        let descendant = dict(vec![
            ("W", Object::Array(items)),
            ("DW", Object::Integer(700)),
        ]);
        let metrics = load_cid_widths(&TestResolver::default(), &descendant);
        let widths: Vec<f64> = [1, 2, 5, 6, 395, 401]
            .into_iter()
            .map(|cid| metrics.width(Some(cid)))
            .collect();
        assert_exact(
            &widths,
            &[
                100.0_f64, 300.0_f64, 300.0_f64, 900.0_f64, 900.0_f64, 700.0_f64,
            ],
        );
        assert_exact(&[metrics.width(Some(30))], &[3.0_f64]);
        assert!(
            metrics
                .entries
                .windows(2)
                .all(|pair| matches!(pair, [left, right] if left.1 < right.0))
        );
    }

    #[test]
    fn dense_and_sparse_width_tables_agree() {
        let dense = CidWidths::new(
            700.0,
            vec![(1, 1, 100.0_f64), (2, 5, 300.0_f64), (10, 10, 50.0_f64)],
        );
        let sparse = CidWidths::new(700.0, vec![(1, 1, 100.0_f64), (60_000, 60_000, 50.0_f64)]);
        let huge = CidWidths::new(700.0, vec![(70_000, 70_010, 20.0_f64)]);
        assert_eq!(dense.dense.len(), 11);
        assert_eq!(sparse.dense.len(), 0);
        assert_eq!(huge.dense.len(), 0);
        for table in [&dense, &sparse, &huge] {
            for cid in [0, 1, 2, 5, 6, 10, 11, 60_000, 70_005, 70_011, u32::MAX] {
                let expected = find_entry(&table.entries, cid).unwrap_or(700.0_f64);
                assert_exact(&[table.width(Some(cid))], &[expected]);
            }
            assert_exact(&[table.width(None)], &[700.0_f64]);
        }
    }

    #[test]
    fn indirect_simple_widths_are_resolved() {
        let mut resolver = TestResolver::default();
        let width = resolver.add(Object::Integer(250));
        let widths = resolver.add(Object::Array(vec![width, Object::Integer(300)]));
        let first = resolver.add(Object::Integer(65));
        let font = load(
            &resolver,
            &dict(vec![
                ("Subtype", name("Type1")),
                ("FirstChar", first),
                ("Widths", widths),
            ]),
        );
        let (_, glyphs) = decode(&font, b"AB");
        assert_exact(
            &[glyphs[0].advance, glyphs[1].advance],
            &[0.25_f64, 0.3_f64],
        );
    }

    #[test]
    fn indirect_cid_widths_are_resolved() {
        let mut resolver = TestResolver::default();
        let width = resolver.add(Object::Integer(100));
        let list = resolver.add(Object::Array(vec![width, Object::Integer(200)]));
        let start = resolver.add(Object::Integer(1));
        let ranges = resolver.add(Object::Array(vec![start, list]));
        let default_width = resolver.add(Object::Integer(700));
        let descendant = dict(vec![("W", ranges), ("DW", default_width)]);
        let metrics = load_cid_widths(&resolver, &descendant);
        assert_exact(
            &[
                metrics.width(Some(1)),
                metrics.width(Some(2)),
                metrics.width(Some(3)),
            ],
            &[100.0_f64, 200.0_f64, 700.0_f64],
        );
    }

    #[test]
    fn missing_descendant_is_an_error() {
        let resolver = TestResolver::default();
        let result = Font::load(
            &resolver,
            &dict(vec![("Subtype", name("Type0"))]),
            &Limits::default(),
        );
        assert!(result.is_err());
    }

    #[test]
    fn fonts_decode_arbitrary_bytes_without_panicking() {
        let mut resolver = TestResolver::default();
        let cmap = "begincodespacerange <00> <80> <8140> <9ffc> endcodespacerange begincidrange <8140> <817e> 633 endcidrange beginbfchar <8140> <0041> endbfchar";
        let stream = resolver.add_stream(Dict::default(), cmap.as_bytes());
        let mut fonts = Vec::new();
        let program = truetype_ligature_font(Vec::new());
        let ligature =
            type0_with_program(&mut resolver, &program, None, Some(vec![0, 1, 0, 2, 0, 3]));
        fonts.push(load(&resolver, &ligature));
        let descendant = resolver.add(Object::Dict(dict(vec![("Subtype", name("CIDFontType0"))])));
        fonts.push(load(
            &resolver,
            &dict(vec![
                ("Subtype", name("Type0")),
                ("Encoding", stream.clone()),
                ("ToUnicode", stream),
                ("DescendantFonts", Object::Array(vec![descendant])),
            ]),
        ));
        fonts.push(load(&resolver, &dict(vec![("Subtype", name("Type1"))])));
        let mut seed = 0x1234_5678_u32;
        for _ in 0_i32..200_i32 {
            let mut bytes = Vec::new();
            for _ in 0_i32..32_i32 {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                bytes.push(u8::try_from(seed >> 24_i32).unwrap());
            }
            for font in &fonts {
                drop(black_box(decode(font, &bytes)));
                let _: VerticalMetrics = black_box(font.vertical_metrics(seed));
            }
        }
    }

    #[test]
    fn hostile_font_dictionaries_do_not_panic() {
        let mut resolver = TestResolver::default();
        let garbage = resolver.add_stream(Dict::default(), &[0xFF_u8; 64]);
        for subtype in ["Type1", "TrueType", "Type0", "Type3", "MMType1"] {
            let descriptor = resolver.add(Object::Dict(dict(vec![
                ("FontFile", garbage.clone()),
                ("FontFile2", garbage.clone()),
                ("FontFile3", garbage.clone()),
                ("Flags", Object::Integer(4)),
            ])));
            let descendant = resolver.add(Object::Dict(dict(vec![
                ("FontDescriptor", descriptor.clone()),
                (
                    "W",
                    Object::Array(vec![Object::Integer(-1), Object::Integer(5)]),
                ),
                ("W2", Object::Array(vec![Object::Real(f64::NAN)])),
                ("CIDToGIDMap", garbage.clone()),
            ])));
            let font = dict(vec![
                ("Subtype", name(subtype)),
                ("FontDescriptor", descriptor),
                ("DescendantFonts", Object::Array(vec![descendant])),
                ("Encoding", garbage.clone()),
                ("ToUnicode", garbage.clone()),
                ("Widths", Object::Array(vec![Object::Null])),
                ("FontMatrix", Object::Array(vec![Object::Null])),
            ]);
            if let Ok(inner_font) = Font::load(&resolver, &font, &Limits::default()) {
                drop(black_box(decode(&inner_font, &[0, 1, 2, 3, 255])));
            }
        }
    }
}
