use std::ops::Range;
use std::sync::OnceLock;

use crate::failure::{Failure, Outcome};
use crate::font_tables::{
    BuiltinEncoding, STANDARD14_WIDTHS, Standard14Font, encoding_glyph_name, glyph_name_at,
};
use crate::fontprog::{FontProgram, agl_components, load_font_file_bytes, parse_font_program};
use crate::inspection::Limits;
use crate::object::{Dict, Object, Resolver};

#[derive(Clone, Debug, PartialEq)]
pub struct Glyph {
    pub code: u32,
    pub advance: f64,
    pub is_word_space: bool,
    pub text: Range<u32>,
}

pub struct Font {
    inner: FontKind,
}

enum FontKind {
    Simple(SimpleFont),
    Composite(CompositeFont),
}

struct SimpleFont {
    encoding: EncodingState,
    to_unicode: UnicodeMap,
    program: Option<FontProgram>,
    program_map: Vec<(u32, Vec<u32>)>,
    widths: WidthState,
    font_matrix: Option<[f64; 6]>,
    symbolic: bool,
    vertical: bool,
    vertical_default: f64,
    vertical_metrics: VerticalMetrics,
}

struct CompositeFont {
    code_reader: CodeReader,
    to_unicode: UnicodeMap,
    cid_fallback: Vec<(u32, Vec<u32>)>,
    program: Option<FontProgram>,
    horizontal: CidMetrics,
    vertical_metrics: CidMetrics,
    vertical_default_v: f64,
    _vertical_pos_v: f64,
    is_vertical: bool,
}

struct EncodingState {
    builtin: BuiltinEncoding,
    differences: Vec<(u8, u16)>,
    custom_names: Vec<(u8, Vec<u8>)>,
}

struct WidthState {
    first_char: i64,
    widths: Vec<f64>,
    missing: f64,
    standard14: Option<Standard14Font>,
}

struct VerticalMetrics {
    _dw2_pos: f64,
    dw2_adv: f64,
    w2: Vec<(u32, f64, f64)>,
}

struct CidMetrics {
    default_width: f64,
    widths: Vec<(u32, f64)>,
    range_widths: Vec<(u32, u32, f64)>,
}

struct CodeReader {
    codespace: Vec<CodespaceRange>,
    identity: bool,
    bytes_per_code: u8,
}

struct CodespaceRange {
    low: u32,
    high: u32,
    length: u8,
}

static BUILTIN_TEXT_TABLES: [OnceLock<Vec<Option<Vec<u32>>>>; 7] = [const { OnceLock::new() }; 7];

#[derive(Clone, Default)]
struct UnicodeMap {
    char_map: Vec<(u32, Vec<u32>)>,
    range_map: Vec<BfRange>,
}

#[derive(Clone)]
struct BfRange {
    start: u32,
    end: u32,
    dest: Vec<u32>,
    increment_last: bool,
}

impl Font {
    pub fn load(resolver: &dyn Resolver, font: &Dict, limits: &Limits) -> Outcome<Font> {
        let subtype = name_bytes(font.get(b"Subtype"));
        if subtype == Some(b"Type0") {
            return load_type0(resolver, font, limits).map(|inner| Font { inner });
        }
        load_simple(resolver, font, limits).map(|inner| Font {
            inner: FontKind::Simple(inner),
        })
    }

    pub fn decode(&self, bytes: &[u8], glyphs: &mut Vec<Glyph>, text: &mut String) {
        match &self.inner {
            FontKind::Simple(simple) => simple.decode(bytes, glyphs, text),
            FontKind::Composite(composite) => composite.decode(bytes, glyphs, text),
        }
    }

    pub fn is_vertical(&self) -> bool {
        match &self.inner {
            FontKind::Simple(simple) => simple.vertical,
            FontKind::Composite(composite) => composite.is_vertical,
        }
    }

    pub fn vertical_advance(&self, code: u32) -> f64 {
        match &self.inner {
            FontKind::Simple(simple) => simple.vertical_advance(code),
            FontKind::Composite(composite) => composite.vertical_advance(code),
        }
    }
}

impl SimpleFont {
    fn builtin_text_table(&self) -> Option<&'static [Option<Vec<u32>>]> {
        let plain = self.to_unicode.is_empty()
            && self.encoding.differences.is_empty()
            && self.encoding.custom_names.is_empty()
            && !self.symbolic;
        if !plain {
            return None;
        }
        let slot = BUILTIN_TEXT_TABLES.get(self.encoding.builtin as usize)?;
        Some(
            slot.get_or_init(|| {
                (0..=255u8)
                    .map(|code| {
                        let name = encoding_glyph_name(self.encoding.builtin, code);
                        match agl_lookup_extended(name.as_bytes()) {
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

    fn decode(&self, bytes: &[u8], glyphs: &mut Vec<Glyph>, text: &mut String) {
        let table = self.builtin_text_table();
        for byte in bytes {
            let code = u32::from(*byte);
            let advance = self.width_for_code(code);
            let text_start = text.len() as u32;
            if let Some(table) = table {
                if let Some(Some(slice)) = table.get(usize::from(*byte)) {
                    push_codepoints(text, slice);
                }
            } else {
                self.decode_code_slow(code, text);
            }
            let text_end = text.len() as u32;
            glyphs.push(Glyph {
                code,
                advance,
                is_word_space: *byte == 32,
                text: text_start..text_end,
            });
        }
    }

    fn decode_code_slow(&self, code: u32, text: &mut String) {
        let from_program = self.program.as_ref().and_then(|program| {
            program.unicode_for_encoded_code(code, self.symbolic, self.encoding.builtin)
        });
        let from_map = program_map_lookup(&self.program_map, code).map(|slice| slice.to_vec());
        let from_tounicode = self
            .to_unicode
            .lookup(code)
            .filter(|slice| unicode_slice_usable(slice))
            .map(|slice| slice.to_vec());
        if let Some(cps) = prefer_unicode_mapping(from_tounicode, from_map, from_program) {
            push_codepoints(text, &cps);
            return;
        }
        let glyph_name = self.glyph_name(code);
        if let Some(agl) = agl_lookup_extended(glyph_name.as_bytes()) {
            push_codepoints(text, &agl);
        } else if self.symbolic {
            let mapped = symbolic_fallback(code);
            if mapped != 0 {
                push_codepoint(text, mapped);
            }
        } else if glyph_name.is_empty() && code <= 0xff {
            push_codepoint(text, code);
        }
    }

    fn width_for_code(&self, code: u32) -> f64 {
        let width = if let Some(standard) = self.widths.standard14 {
            let idx = code.min(255) as usize;
            let table = STANDARD14_WIDTHS.get(standard as usize);
            table
                .and_then(|row| row.get(idx).copied())
                .map(f64::from)
                .unwrap_or(self.widths.missing)
        } else if code >= self.widths.first_char as u32 {
            let offset = code.saturating_sub(self.widths.first_char as u32) as usize;
            self.widths
                .widths
                .get(offset)
                .copied()
                .unwrap_or(self.widths.missing)
        } else {
            self.widths.missing
        };
        if let Some(matrix) = self.font_matrix {
            let scale = matrix[0].abs().max(matrix[3].abs());
            if scale > 0.0 {
                return (width / 1000.0) * scale * 1000.0;
            }
        }
        width / 1000.0
    }

    fn glyph_name(&self, code: u32) -> String {
        if let Some((_, name_index)) = self
            .encoding
            .differences
            .iter()
            .find(|(slot, _)| u32::from(*slot) == code)
        {
            return glyph_name_at(*name_index).to_owned();
        }
        if let Some((_, name)) = self
            .encoding
            .custom_names
            .iter()
            .find(|(slot, _)| u32::from(*slot) == code)
        {
            return String::from_utf8_lossy(name).into_owned();
        }
        if self.encoding.builtin != BuiltinEncoding::Custom {
            return encoding_glyph_name(self.encoding.builtin, code as u8).to_owned();
        }
        String::new()
    }

    fn vertical_advance(&self, code: u32) -> f64 {
        for (cid, _, adv) in &self.vertical_metrics.w2 {
            if *cid == code {
                return *adv / 1000.0;
            }
        }
        if self.vertical_metrics.dw2_adv > 0.0 {
            return self.vertical_metrics.dw2_adv / 1000.0;
        }
        self.vertical_default / 1000.0
    }
}

impl CompositeFont {
    fn decode(&self, bytes: &[u8], glyphs: &mut Vec<Glyph>, text: &mut String) {
        let mut offset = 0usize;
        while offset < bytes.len() {
            let Some((code, consumed)) = self.code_reader.read(bytes, offset) else {
                break;
            };
            offset = offset.saturating_add(consumed);
            let cid = code;
            let advance = self.horizontal.width(cid) / 1000.0;
            let text_start = text.len() as u32;
            let gid = cid.min(u16::MAX as u32) as u16;
            let from_program = self
                .program
                .as_ref()
                .and_then(|program| program.unicode_for_gid(gid));
            let from_map = program_map_lookup(&self.cid_fallback, cid).map(|slice| slice.to_vec());
            let from_tounicode = self
                .to_unicode
                .lookup(cid)
                .filter(|slice| unicode_slice_usable(slice))
                .map(|slice| slice.to_vec());
            if let Some(cps) = prefer_unicode_mapping(from_tounicode, from_map, from_program) {
                push_codepoints(text, &cps);
            }
            let text_end = text.len() as u32;
            glyphs.push(Glyph {
                code: cid,
                advance,
                is_word_space: false,
                text: text_start..text_end,
            });
        }
    }

    fn vertical_advance(&self, code: u32) -> f64 {
        let measured = self.vertical_metrics.width(code);
        if measured > 0.0 {
            return measured / 1000.0;
        }
        self.vertical_default_v / 1000.0
    }
}

impl CidMetrics {
    fn width(&self, cid: u32) -> f64 {
        for (start, end, width) in &self.range_widths {
            if cid >= *start && cid <= *end {
                return *width;
            }
        }
        for (id, width) in &self.widths {
            if *id == cid {
                return *width;
            }
        }
        self.default_width
    }
}

impl CodeReader {
    fn read(&self, bytes: &[u8], offset: usize) -> Option<(u32, usize)> {
        if self.identity {
            let len = usize::from(self.bytes_per_code.max(2));
            if offset.saturating_add(len) > bytes.len() {
                return None;
            }
            let mut code = 0u32;
            for idx in 0..len {
                let byte = bytes.get(offset + idx)?;
                code = (code << 8) | u32::from(*byte);
            }
            return Some((code, len));
        }
        for range in &self.codespace {
            let len = usize::from(range.length);
            if offset.saturating_add(len) > bytes.len() {
                continue;
            }
            let mut code = 0u32;
            for idx in 0..len {
                let byte = bytes.get(offset + idx)?;
                code = (code << 8) | u32::from(*byte);
            }
            if code >= range.low && code <= range.high {
                return Some((code, len));
            }
        }
        let byte = bytes.get(offset)?;
        Some((u32::from(*byte), 1))
    }
}

impl UnicodeMap {
    fn is_empty(&self) -> bool {
        self.char_map.is_empty() && self.range_map.is_empty()
    }

    fn finish(&mut self) {
        self.char_map.sort_by_key(|(source, _)| *source);
        self.char_map.dedup_by_key(|(source, _)| *source);
    }

    fn lookup(&self, code: u32) -> Option<&[u32]> {
        if let Ok(position) = self
            .char_map
            .binary_search_by_key(&code, |(source, _)| *source)
            && let Some((_, dest)) = self.char_map.get(position)
        {
            return Some(dest.as_slice());
        }
        for range in &self.range_map {
            if code >= range.start && code <= range.end {
                if range.increment_last && range.dest.len() == 1 {
                    return None;
                }
                if range.start == range.end && range.dest.len() > 1 {
                    return Some(range.dest.as_slice());
                }
                let idx = code.saturating_sub(range.start) as usize;
                if let Some(cp) = range.dest.get(idx) {
                    if range.start == range.end {
                        return Some(range.dest.as_slice());
                    }
                    return Some(core::slice::from_ref(cp));
                }
                if range.dest.len() == 1 {
                    return Some(range.dest.as_slice());
                }
            }
        }
        None
    }
}

fn load_simple(resolver: &dyn Resolver, font: &Dict, limits: &Limits) -> Outcome<SimpleFont> {
    let encoding = load_encoding(font, resolver, limits)?;
    let to_unicode = load_to_unicode(font, resolver, limits)?;
    let program = load_embedded_program(font, resolver, limits);
    let widths = load_widths(font, resolver)?;
    let font_matrix = read_font_matrix(font);
    let flags = font_descriptor_flags(font, resolver)?;
    let symbolic = flags.map(|value| (value & 4) != 0).unwrap_or(false);
    let vertical = encoding_name_is_vertical(font.get(b"Encoding"));
    let vertical_default = read_number(font.get(b"DW")).unwrap_or(1000.0);
    let vertical_metrics = load_vertical_metrics(font);
    let program_map = program
        .as_ref()
        .map(|value| value.build_byte_map(symbolic, encoding.builtin, limits))
        .unwrap_or_default();
    Ok(SimpleFont {
        encoding,
        to_unicode,
        program,
        program_map,
        widths,
        font_matrix,
        symbolic,
        vertical,
        vertical_default,
        vertical_metrics,
    })
}

fn load_type0(resolver: &dyn Resolver, font: &Dict, limits: &Limits) -> Outcome<FontKind> {
    let descendant = resolve_descendant(resolver, font)?;
    let to_unicode = load_to_unicode(font, resolver, limits)?;
    let encoding = font.get(b"Encoding");
    let code_reader = load_type0_codespace(encoding, font, resolver, limits)?;
    let is_vertical = code_reader.identity && encoding_name_is_vertical(encoding)
        || matches!(name_bytes(encoding), Some(b"Identity-V"));
    let horizontal = load_cid_metrics(&descendant, b"DW", b"W")?;
    let vertical_widths = load_cid_metrics(&descendant, b"DW2", b"W2").unwrap_or(CidMetrics {
        default_width: horizontal.default_width,
        widths: Vec::new(),
        range_widths: Vec::new(),
    });
    let (vertical_pos_v, vertical_default_v) = read_dw2(&descendant);
    let program = load_embedded_program(font, resolver, limits)
        .or_else(|| load_embedded_program_descendant(&descendant, resolver, limits));
    let cid_fallback = program
        .as_ref()
        .map(|value| build_cid_fallback(value, limits))
        .unwrap_or_default();
    Ok(FontKind::Composite(CompositeFont {
        code_reader,
        to_unicode,
        cid_fallback,
        program,
        horizontal,
        vertical_metrics: vertical_widths,
        vertical_default_v,
        _vertical_pos_v: vertical_pos_v,
        is_vertical,
    }))
}

fn load_embedded_program(
    font: &Dict,
    resolver: &dyn Resolver,
    limits: &Limits,
) -> Option<FontProgram> {
    let descriptor = font.get(b"FontDescriptor")?;
    let resolved = resolver.resolve(descriptor).ok()?;
    let dict = resolved.as_dict()?;
    read_font_program(dict, resolver, limits)
}

fn load_embedded_program_descendant(
    font: &Dict,
    resolver: &dyn Resolver,
    limits: &Limits,
) -> Option<FontProgram> {
    let descriptor = font.get(b"FontDescriptor")?;
    let resolved = resolver.resolve(descriptor).ok()?;
    let dict = resolved.as_dict()?;
    read_font_program(dict, resolver, limits)
}

fn read_font_program(
    descriptor: &Dict,
    resolver: &dyn Resolver,
    limits: &Limits,
) -> Option<FontProgram> {
    for key in [b"FontFile2".as_slice(), b"FontFile3", b"FontFile"] {
        if let Ok(bytes) = load_font_file_bytes(key, descriptor, resolver, limits)
            && let Some(program) = parse_font_program(&bytes, limits)
        {
            return Some(program);
        }
    }
    None
}

fn build_cid_fallback(program: &FontProgram, limits: &Limits) -> Vec<(u32, Vec<u32>)> {
    let mut out = Vec::new();
    let cap = program.glyph_count().min(limits.max_items);
    for gid in 0..cap {
        if let Some(cps) = program.unicode_for_gid(gid as u16) {
            out.push((gid as u32, cps));
        }
    }
    out
}

fn prefer_unicode_mapping(
    to_unicode: Option<Vec<u32>>,
    program_map: Option<Vec<u32>>,
    program_direct: Option<Vec<u32>>,
) -> Option<Vec<u32>> {
    if let Some(cps) = program_direct.filter(|cps| !cps.is_empty()) {
        return Some(cps);
    }
    if let Some(cps) = program_map.filter(|cps| !cps.is_empty()) {
        return Some(cps);
    }
    to_unicode.filter(|cps| !cps.is_empty())
}

fn program_map_lookup(map: &[(u32, Vec<u32>)], code: u32) -> Option<&[u32]> {
    map.iter()
        .find(|(source, _)| *source == code)
        .map(|(_, dest)| dest.as_slice())
}

fn load_encoding(font: &Dict, resolver: &dyn Resolver, limits: &Limits) -> Outcome<EncodingState> {
    let mut state = EncodingState {
        builtin: BuiltinEncoding::PdfDoc,
        differences: Vec::new(),
        custom_names: Vec::new(),
    };
    let resolved = match font.get(b"Encoding") {
        Some(reference @ Object::Ref(_)) => Some(resolver.resolve(reference)?),
        Some(other) => Some(other.clone()),
        None => None,
    };
    match resolved {
        None => {
            state.builtin = if name_bytes(font.get(b"Subtype")) == Some(b"TrueType") {
                BuiltinEncoding::WinAnsi
            } else {
                BuiltinEncoding::Standard
            };
        }
        Some(Object::Name(name)) => {
            state.builtin = builtin_from_name(&name);
        }
        Some(Object::Stream(stream)) => {
            let data = resolver.stream_data(&stream)?;
            if data.len() > limits.max_decoded_stream_bytes {
                return Err(Failure::limit("encoding stream exceeds limit"));
            }
            state.builtin = BuiltinEncoding::Custom;
        }
        Some(Object::Dict(dict)) => {
            if let Some(Object::Name(name)) = dict.get(b"BaseEncoding") {
                state.builtin = builtin_from_name(name);
            } else if name_bytes(font.get(b"Subtype")) == Some(b"TrueType") {
                state.builtin = BuiltinEncoding::WinAnsi;
            } else {
                state.builtin = BuiltinEncoding::Standard;
            }
            load_differences(&dict, &mut state)?;
        }
        Some(_) => {
            state.builtin = BuiltinEncoding::PdfDoc;
        }
    }
    Ok(state)
}

fn load_differences(dict: &Dict, state: &mut EncodingState) -> Outcome<()> {
    let Some(Object::Array(entries)) = dict.get(b"Differences") else {
        return Ok(());
    };
    let mut code = 0u8;
    for entry in entries {
        match entry {
            Object::Integer(value) if (0..=255).contains(value) => {
                code = *value as u8;
            }
            Object::Name(name) => {
                if let Some(index) = glyph_name_index(name) {
                    state.differences.push((code, index));
                } else {
                    state.custom_names.push((code, name.clone()));
                }
                code = code.saturating_add(1);
            }
            _ => {}
        }
    }
    Ok(())
}

fn load_widths(font: &Dict, resolver: &dyn Resolver) -> Outcome<WidthState> {
    let first_char = read_integer(font.get(b"FirstChar")).unwrap_or(0);
    let mut widths = Vec::new();
    if let Some(Object::Array(items)) = font.get(b"Widths") {
        for item in items {
            widths.push(read_number(Some(item)).unwrap_or(0.0));
        }
    }
    let missing = read_missing_width(font, resolver).unwrap_or(0.0);
    let standard14 = standard14_from_base_font(font.get(b"BaseFont"));
    Ok(WidthState {
        first_char,
        widths,
        missing: if missing > 0.0 { missing } else { 1000.0 },
        standard14,
    })
}

fn load_vertical_metrics(font: &Dict) -> VerticalMetrics {
    let (dw2_pos, dw2_adv) = read_dw2(font);
    let mut w2 = Vec::new();
    if let Some(Object::Array(items)) = font.get(b"W2") {
        let mut idx = 0usize;
        while idx < items.len() {
            let cid = items
                .get(idx)
                .and_then(|item| read_integer(Some(item)))
                .unwrap_or(0) as u32;
            idx += 1;
            if let Some(Object::Array(widths)) = items.get(idx) {
                if let (Some(pos), Some(adv)) = (
                    widths.first().and_then(|item| read_number(Some(item))),
                    widths.get(1).and_then(|item| read_number(Some(item))),
                ) {
                    w2.push((cid, pos, adv));
                }
                idx += 1;
                continue;
            }
            let end_cid = items
                .get(idx)
                .and_then(|item| read_integer(Some(item)))
                .unwrap_or(i64::from(cid)) as u32;
            idx += 1;
            if let (Some(pos), Some(adv)) = (
                items.get(idx).and_then(|item| read_number(Some(item))),
                items.get(idx + 1).and_then(|item| read_number(Some(item))),
            ) {
                w2.push((cid, pos, adv));
                for extra in cid..=end_cid {
                    if extra != cid {
                        w2.push((extra, pos, adv));
                    }
                }
            }
            idx = idx.saturating_add(2);
        }
    }
    VerticalMetrics {
        _dw2_pos: dw2_pos,
        dw2_adv,
        w2,
    }
}

fn load_cid_metrics(dict: &Dict, dw_key: &[u8], w_key: &[u8]) -> Outcome<CidMetrics> {
    let default_width = read_number(dict.get(dw_key)).unwrap_or(1000.0);
    let mut metrics = CidMetrics {
        default_width,
        widths: Vec::new(),
        range_widths: Vec::new(),
    };
    let Some(Object::Array(items)) = dict.get(w_key) else {
        return Ok(metrics);
    };
    let mut idx = 0usize;
    while idx < items.len() {
        let start = items
            .get(idx)
            .and_then(|item| read_integer(Some(item)))
            .unwrap_or(0) as u32;
        idx += 1;
        if let Some(Object::Array(inner)) = items.get(idx) {
            for (offset, item) in inner.iter().enumerate() {
                let width = read_number(Some(item)).unwrap_or(default_width);
                metrics
                    .widths
                    .push((start.saturating_add(offset as u32), width));
            }
            idx += 1;
            continue;
        }
        let end = items
            .get(idx)
            .and_then(|item| read_integer(Some(item)))
            .unwrap_or(i64::from(start)) as u32;
        idx += 1;
        let width = items
            .get(idx)
            .and_then(|item| read_number(Some(item)))
            .unwrap_or(default_width);
        metrics.range_widths.push((start, end, width));
        idx += 1;
    }
    Ok(metrics)
}

fn load_to_unicode(font: &Dict, resolver: &dyn Resolver, limits: &Limits) -> Outcome<UnicodeMap> {
    let Some(Object::Ref(reference)) = font.get(b"ToUnicode") else {
        return Ok(UnicodeMap::default());
    };
    let resolved = resolver.resolve(&Object::Ref(*reference))?;
    let Object::Stream(stream) = resolved else {
        return Ok(UnicodeMap::default());
    };
    let data = resolver.stream_data(&stream)?;
    if data.len() > limits.max_decoded_stream_bytes {
        return Err(Failure::limit("ToUnicode stream exceeds limit"));
    }
    Ok(parse_cmap_to_unicode(&data, limits))
}

fn load_type0_codespace(
    encoding: Option<&Object>,
    font: &Dict,
    resolver: &dyn Resolver,
    limits: &Limits,
) -> Outcome<CodeReader> {
    if let Some(Object::Name(name)) = encoding {
        if name == b"Identity-H" {
            return Ok(CodeReader {
                codespace: Vec::new(),
                identity: true,
                bytes_per_code: 2,
            });
        }
        if name == b"Identity-V" {
            return Ok(CodeReader {
                codespace: Vec::new(),
                identity: true,
                bytes_per_code: 2,
            });
        }
    }
    if let Some(Object::Ref(reference)) = encoding {
        let resolved = resolver.resolve(&Object::Ref(*reference))?;
        if let Object::Stream(stream) = resolved {
            let data = resolver.stream_data(&stream)?;
            if data.len() > limits.max_decoded_stream_bytes {
                return Err(Failure::limit("CMap stream exceeds limit"));
            }
            return Ok(parse_cmap_codespace(&data, limits));
        }
    }
    if let Some(Object::Ref(reference)) = font.get(b"Encoding") {
        let resolved = resolver.resolve(&Object::Ref(*reference))?;
        if let Object::Stream(stream) = resolved {
            let data = resolver.stream_data(&stream)?;
            if data.len() > limits.max_decoded_stream_bytes {
                return Err(Failure::limit("CMap stream exceeds limit"));
            }
            return Ok(parse_cmap_codespace(&data, limits));
        }
    }
    Ok(CodeReader {
        codespace: Vec::new(),
        identity: true,
        bytes_per_code: 2,
    })
}

#[allow(clippy::indexing_slicing)]
fn parse_cmap_codespace(data: &[u8], limits: &Limits) -> CodeReader {
    let mut reader = CodeReader {
        codespace: Vec::new(),
        identity: false,
        bytes_per_code: 2,
    };
    let tokens = tokenize_cmap(data, limits);
    let mut idx = 0usize;
    while idx < tokens.len() {
        if tokens.get(idx) == Some(&CmapToken::Keyword(b"begincodespacerange".to_vec())) {
            idx += 1;
            if matches!(tokens.get(idx), Some(CmapToken::Integer(_))) {
                idx += 1;
            }
            while matches!(tokens.get(idx), Some(CmapToken::Hex(_))) {
                let (low, high, length) = read_codespace_entry(&tokens, &mut idx);
                if let (Some(low), Some(high)) = (low, high) {
                    reader.codespace.push(CodespaceRange {
                        low,
                        high,
                        length: length.unwrap_or(1),
                    });
                }
            }
        }
        idx += 1;
    }
    if reader.codespace.is_empty() {
        reader.identity = true;
        reader.bytes_per_code = 2;
    } else {
        reader.bytes_per_code = reader
            .codespace
            .iter()
            .map(|range| range.length)
            .max()
            .unwrap_or(2);
    }
    reader
}

#[allow(clippy::indexing_slicing)]
fn parse_cmap_to_unicode(data: &[u8], limits: &Limits) -> UnicodeMap {
    let mut map = UnicodeMap::default();
    let tokens = tokenize_cmap(data, limits);
    let mut idx = 0usize;
    while idx < tokens.len() {
        match tokens.get(idx) {
            Some(CmapToken::Keyword(keyword)) if keyword == b"beginbfchar" => {
                idx += 1;
                if matches!(tokens.get(idx), Some(CmapToken::Integer(_))) {
                    idx += 1;
                }
                while matches!(tokens.get(idx), Some(CmapToken::Hex(_))) {
                    let (src, dest) = read_bf_entry(&tokens, &mut idx);
                    if let (Some(source), Some(destination)) = (src, dest) {
                        map.char_map.push((source, destination));
                    }
                }
            }
            Some(CmapToken::Keyword(keyword)) if keyword == b"begincidchar" => {
                idx += 1;
                if matches!(tokens.get(idx), Some(CmapToken::Integer(_))) {
                    idx += 1;
                }
                while matches!(tokens.get(idx), Some(CmapToken::Hex(_))) {
                    let (src, dest) = read_bf_entry(&tokens, &mut idx);
                    if let (Some(source), Some(destination)) = (src, dest) {
                        map.char_map.push((source, destination));
                    }
                }
            }
            Some(CmapToken::Keyword(keyword)) if keyword == b"begincidrange" => {
                idx += 1;
                if matches!(tokens.get(idx), Some(CmapToken::Integer(_))) {
                    idx += 1;
                }
                while matches!(tokens.get(idx), Some(CmapToken::Hex(_))) {
                    let (start, end, dest, increment) = read_bf_range(&tokens, &mut idx);
                    if let (Some(start), Some(end), Some(destination)) = (start, end, dest) {
                        if increment && destination.len() == 1 {
                            let base = destination.first().copied().unwrap_or(0);
                            let mut code = start;
                            while code <= end {
                                map.char_map
                                    .push((code, vec![base.saturating_add(code - start)]));
                                code = code.saturating_add(1);
                            }
                        } else {
                            map.range_map.push(BfRange {
                                start,
                                end,
                                dest: destination,
                                increment_last: increment,
                            });
                        }
                    }
                }
            }
            Some(CmapToken::Keyword(keyword)) if keyword == b"beginbfrange" => {
                idx += 1;
                if matches!(tokens.get(idx), Some(CmapToken::Integer(_))) {
                    idx += 1;
                }
                while matches!(tokens.get(idx), Some(CmapToken::Hex(_))) {
                    let (start, end, dest, increment) = read_bf_range(&tokens, &mut idx);
                    if let (Some(start), Some(end), Some(destination)) = (start, end, dest) {
                        if increment && destination.len() == 1 {
                            let base = destination.first().copied().unwrap_or(0);
                            let mut code = start;
                            while code <= end {
                                map.char_map
                                    .push((code, vec![base.saturating_add(code - start)]));
                                code = code.saturating_add(1);
                            }
                        } else {
                            map.range_map.push(BfRange {
                                start,
                                end,
                                dest: destination,
                                increment_last: increment,
                            });
                        }
                    }
                }
            }
            _ => {
                idx += 1;
            }
        }
    }
    map.finish();
    map
}

#[derive(Clone, Debug, PartialEq)]
enum CmapToken {
    Keyword(Vec<u8>),
    Integer(i64),
    Hex(Vec<u8>),
    Array(Vec<CmapToken>),
    String(Vec<u8>),
}

#[allow(clippy::indexing_slicing)]
fn tokenize_cmap(data: &[u8], limits: &Limits) -> Vec<CmapToken> {
    let mut tokens = Vec::new();
    let mut idx = 0usize;
    let max_tokens = limits.max_items.min(limits.max_decoded_stream_bytes);
    while idx < data.len() && tokens.len() < max_tokens {
        skip_ws(data, &mut idx);
        if idx >= data.len() {
            break;
        }
        let byte = data[idx];
        match byte {
            b'/' => {
                idx += 1;
                let start = idx;
                while idx < data.len() && !is_delim(data[idx]) {
                    idx += 1;
                }
                tokens.push(CmapToken::Keyword(data[start..idx].to_vec()));
            }
            b'<' => {
                idx += 1;
                if data.get(idx) == Some(&b'<') {
                    idx += 1;
                    while idx < data.len() {
                        if data.get(idx) == Some(&b'>') && data.get(idx + 1) == Some(&b'>') {
                            idx += 2;
                            break;
                        }
                        idx += 1;
                    }
                } else {
                    let hex = read_hex(data, &mut idx);
                    tokens.push(CmapToken::Hex(hex));
                }
            }
            b'(' => {
                let string = read_literal_string(data, &mut idx);
                tokens.push(CmapToken::String(string));
            }
            b'[' => {
                idx += 1;
                let array = read_bracket_array(data, &mut idx, limits, max_tokens);
                tokens.push(CmapToken::Array(array));
            }
            b'0'..=b'9' | b'+' | b'-' | b'.' => {
                let number = read_number_token(data, &mut idx);
                if let Ok(value) = number.parse::<i64>() {
                    tokens.push(CmapToken::Integer(value));
                }
            }
            _ => {
                let start = idx;
                while idx < data.len() && !is_whitespace(data[idx]) {
                    idx += 1;
                }
                if start < idx {
                    tokens.push(CmapToken::Keyword(data[start..idx].to_vec()));
                } else {
                    idx += 1;
                }
            }
        }
    }
    tokens
}

fn read_bracket_array(
    data: &[u8],
    idx: &mut usize,
    limits: &Limits,
    max_tokens: usize,
) -> Vec<CmapToken> {
    let _ = limits;
    let mut items = Vec::new();
    while *idx < data.len() && items.len() < max_tokens {
        skip_ws(data, idx);
        if data.get(*idx) == Some(&b']') {
            *idx += 1;
            break;
        }
        if data.get(*idx) == Some(&b'<') {
            *idx += 1;
            let hex = read_hex(data, idx);
            items.push(CmapToken::Hex(hex));
            continue;
        }
        break;
    }
    items
}

fn read_codespace_entry(
    tokens: &[CmapToken],
    idx: &mut usize,
) -> (Option<u32>, Option<u32>, Option<u8>) {
    let low_token = tokens.get(*idx);
    let low = low_token.and_then(hex_token_to_u32);
    *idx += 1;
    let high = tokens.get(*idx).and_then(hex_token_to_u32);
    *idx += 1;
    let length = match low_token {
        Some(CmapToken::Hex(bytes)) => u8::try_from(bytes.len().clamp(1, 4)).ok(),
        _ => None,
    };
    (low, high, length)
}

fn read_bf_entry(tokens: &[CmapToken], idx: &mut usize) -> (Option<u32>, Option<Vec<u32>>) {
    let source = tokens.get(*idx).and_then(hex_token_to_u32);
    *idx += 1;
    let dest = tokens.get(*idx).map(decode_utf16_dest);
    *idx += 1;
    (source, dest)
}

fn read_bf_range(
    tokens: &[CmapToken],
    idx: &mut usize,
) -> (Option<u32>, Option<u32>, Option<Vec<u32>>, bool) {
    let start = tokens.get(*idx).and_then(hex_token_to_u32);
    *idx += 1;
    let end = tokens.get(*idx).and_then(hex_token_to_u32);
    *idx += 1;
    let token = tokens.get(*idx);
    *idx += 1;
    let increment = matches!(token, Some(CmapToken::Hex(bytes)) if bytes.len() <= 2);
    let dest = token.map(decode_utf16_dest);
    (start, end, dest, increment)
}

fn decode_utf16_dest(token: &CmapToken) -> Vec<u32> {
    match token {
        CmapToken::Hex(bytes) => decode_utf16_be(bytes),
        CmapToken::Array(items) => items
            .iter()
            .flat_map(|item| {
                if let CmapToken::Hex(bytes) = item {
                    decode_utf16_be(bytes)
                } else {
                    Vec::new()
                }
            })
            .collect(),
        CmapToken::String(bytes) => bytes.iter().map(|b| u32::from(*b)).collect(),
        _ => Vec::new(),
    }
}

#[allow(clippy::indexing_slicing)]
fn decode_utf16_be(bytes: &[u8]) -> Vec<u32> {
    let mut out = Vec::new();
    let mut idx = 0usize;
    while idx.saturating_add(1) < bytes.len() {
        let high = u32::from(bytes[idx]);
        let low = u32::from(bytes[idx + 1]);
        let unit = (high << 8) | low;
        idx += 2;
        if (0xd800..=0xdbff).contains(&unit) && idx.saturating_add(1) < bytes.len() {
            let trail_high = u32::from(bytes[idx]);
            let trail_low = u32::from(bytes[idx + 1]);
            let trail = (trail_high << 8) | trail_low;
            idx += 2;
            if (0xdc00..=0xdfff).contains(&trail) {
                let combined = 0x1_0000 + ((unit - 0xd800) << 10) + (trail - 0xdc00);
                out.push(combined);
                continue;
            }
        }
        out.push(unit);
    }
    out
}

fn hex_token_to_u32(token: &CmapToken) -> Option<u32> {
    match token {
        CmapToken::Hex(bytes) => {
            let mut value = 0u32;
            for byte in bytes {
                value = (value << 8) | u32::from(*byte);
            }
            Some(value)
        }
        CmapToken::Integer(value) => Some(*value as u32),
        _ => None,
    }
}

fn ascii_hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    }
}

#[allow(clippy::indexing_slicing)]
fn skip_ws(data: &[u8], idx: &mut usize) {
    while *idx < data.len() && is_whitespace(data[*idx]) {
        *idx += 1;
    }
}

fn is_whitespace(byte: u8) -> bool {
    matches!(byte, 0x00 | 0x09 | 0x0a | 0x0c | 0x0d | 0x20)
}

fn is_delim(byte: u8) -> bool {
    is_whitespace(byte)
        || matches!(
            byte,
            b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%'
        )
}

#[allow(clippy::indexing_slicing)]
fn read_hex(data: &[u8], idx: &mut usize) -> Vec<u8> {
    let mut nibbles = Vec::new();
    while *idx < data.len() {
        let byte = data[*idx];
        if byte == b'>' {
            *idx += 1;
            break;
        }
        if is_whitespace(byte) {
            *idx += 1;
            continue;
        }
        if let Some(nibble) = ascii_hex_nibble(byte) {
            nibbles.push(nibble);
        }
        *idx += 1;
    }
    if nibbles.len() % 2 == 1 {
        nibbles.push(0);
    }
    let mut out = Vec::new();
    for pair in nibbles.chunks(2) {
        let high = pair.first().copied().unwrap_or(0);
        let low = pair.get(1).copied().unwrap_or(0);
        out.push((high << 4) | low);
    }
    out
}

#[allow(clippy::indexing_slicing)]
fn read_literal_string(data: &[u8], idx: &mut usize) -> Vec<u8> {
    let mut out = Vec::new();
    if data.get(*idx) != Some(&b'(') {
        return out;
    }
    *idx += 1;
    let mut depth = 1i32;
    while *idx < data.len() && depth > 0 {
        let byte = data[*idx];
        if byte == b'(' {
            depth += 1;
        } else if byte == b')' {
            depth -= 1;
            if depth == 0 {
                *idx += 1;
                break;
            }
        } else if byte == b'\\' {
            *idx += 1;
            if let Some(next) = data.get(*idx) {
                out.push(*next);
            }
        } else {
            out.push(byte);
        }
        *idx += 1;
    }
    out
}

#[allow(clippy::indexing_slicing)]
fn read_number_token(data: &[u8], idx: &mut usize) -> String {
    let start = *idx;
    while *idx < data.len() && matches!(data[*idx], b'0'..=b'9' | b'+' | b'-' | b'.') {
        *idx += 1;
    }
    String::from_utf8_lossy(&data[start..*idx]).into_owned()
}

fn resolve_descendant(resolver: &dyn Resolver, font: &Dict) -> Outcome<Dict> {
    let listing = font
        .get(b"DescendantFonts")
        .ok_or_else(|| Failure::invalid("Type0 font missing DescendantFonts"))?;
    let Object::Array(children) = resolver.resolve(listing)? else {
        return Err(Failure::invalid("Type0 font missing DescendantFonts"));
    };
    let first = children
        .first()
        .ok_or_else(|| Failure::invalid("Type0 font has empty DescendantFonts"))?;
    let resolved = resolver.resolve(first)?;
    match resolved {
        Object::Dict(dict) => Ok(dict),
        Object::Stream(stream) => Ok(stream.dict),
        _ => Err(Failure::invalid(
            "Type0 descendant is not a font dictionary",
        )),
    }
}

fn read_font_matrix(font: &Dict) -> Option<[f64; 6]> {
    let Object::Array(items) = font.get(b"FontMatrix")? else {
        return None;
    };
    let mut matrix = [0.0; 6];
    for (idx, slot) in matrix.iter_mut().enumerate() {
        *slot = items
            .get(idx)
            .and_then(|item| read_number(Some(item)))
            .unwrap_or(0.0);
    }
    Some(matrix)
}

fn read_dw2(font: &Dict) -> (f64, f64) {
    if let Some(Object::Array(items)) = font.get(b"DW2") {
        let pos = items
            .first()
            .and_then(|item| read_number(Some(item)))
            .unwrap_or(880.0);
        let adv = items
            .get(1)
            .and_then(|item| read_number(Some(item)))
            .unwrap_or(1000.0);
        return (pos, adv);
    }
    (880.0, 1000.0)
}

fn read_missing_width(font: &Dict, resolver: &dyn Resolver) -> Option<f64> {
    let Some(Object::Ref(reference)) = font.get(b"FontDescriptor") else {
        return None;
    };
    let resolved = resolver.resolve(&Object::Ref(*reference)).ok()?;
    let dict = resolved.as_dict()?;
    read_number(dict.get(b"MissingWidth"))
}

fn font_descriptor_flags(font: &Dict, resolver: &dyn Resolver) -> Outcome<Option<i64>> {
    let Some(Object::Ref(reference)) = font.get(b"FontDescriptor") else {
        return Ok(None);
    };
    let resolved = resolver.resolve(&Object::Ref(*reference))?;
    let dict = resolved
        .as_dict()
        .ok_or_else(|| Failure::invalid("FontDescriptor is not a dictionary"))?;
    Ok(read_integer(dict.get(b"Flags")))
}

fn standard14_from_base_font(name: Option<&Object>) -> Option<Standard14Font> {
    let Object::Name(bytes) = name? else {
        return None;
    };
    let base = strip_subset_prefix(bytes);
    match base {
        b"Helvetica" => Some(Standard14Font::Helvetica),
        b"Helvetica-Bold" => Some(Standard14Font::Helvetica_Bold),
        b"Helvetica-Oblique" => Some(Standard14Font::Helvetica_Oblique),
        b"Helvetica-BoldOblique" => Some(Standard14Font::Helvetica_BoldOblique),
        b"Times-Roman" => Some(Standard14Font::Times_Roman),
        b"Times-Bold" => Some(Standard14Font::Times_Bold),
        b"Times-Italic" => Some(Standard14Font::Times_Italic),
        b"Times-BoldItalic" => Some(Standard14Font::Times_BoldItalic),
        b"Courier" => Some(Standard14Font::Courier),
        b"Courier-Bold" => Some(Standard14Font::Courier_Bold),
        b"Courier-Oblique" => Some(Standard14Font::Courier_Oblique),
        b"Courier-BoldOblique" => Some(Standard14Font::Courier_BoldOblique),
        b"Symbol" => Some(Standard14Font::Symbol),
        b"ZapfDingbats" => Some(Standard14Font::ZapfDingbats),
        b"Arial" => Some(Standard14Font::Helvetica),
        b"Arial,Bold" | b"Arial-Bold" => Some(Standard14Font::Helvetica_Bold),
        b"TimesNewRoman" => Some(Standard14Font::Times_Roman),
        b"CourierNew" => Some(Standard14Font::Courier),
        _ => None,
    }
}

fn strip_subset_prefix(name: &[u8]) -> &[u8] {
    if let Some(idx) = name.iter().position(|byte| *byte == b'+') {
        name.get(idx + 1..).unwrap_or(name)
    } else {
        name
    }
}

fn builtin_from_name(name: &[u8]) -> BuiltinEncoding {
    match name {
        b"WinAnsiEncoding" => BuiltinEncoding::WinAnsi,
        b"StandardEncoding" => BuiltinEncoding::Standard,
        b"MacRomanEncoding" => BuiltinEncoding::MacRoman,
        b"MacExpertEncoding" => BuiltinEncoding::MacExpert,
        b"PDFDocEncoding" => BuiltinEncoding::PdfDoc,
        _ => BuiltinEncoding::PdfDoc,
    }
}

fn encoding_name_is_vertical(encoding: Option<&Object>) -> bool {
    matches!(name_bytes(encoding), Some(b"Identity-V"))
}

fn glyph_name_index(name: &[u8]) -> Option<u16> {
    let text = core::str::from_utf8(name).ok()?;
    for (idx, (glyph, _)) in crate::font_tables::GLYPH_NAME_INDEX.iter().enumerate() {
        if *glyph == text {
            return Some(idx as u16);
        }
    }
    None
}

fn name_bytes(value: Option<&Object>) -> Option<&[u8]> {
    match value {
        Some(Object::Name(bytes)) => Some(bytes),
        _ => None,
    }
}

fn read_integer(value: Option<&Object>) -> Option<i64> {
    match value {
        Some(Object::Integer(v)) => Some(*v),
        Some(Object::Real(v)) => Some(*v as i64),
        _ => None,
    }
}

fn read_number(value: Option<&Object>) -> Option<f64> {
    value.and_then(Object::as_number)
}

fn symbolic_fallback(code: u32) -> u32 {
    if code >= 0xf000 {
        return code - 0xf000;
    }
    if code <= 0xff {
        return code;
    }
    0
}

fn unicode_slice_usable(codepoints: &[u32]) -> bool {
    !codepoints.is_empty()
        && codepoints.iter().all(|cp| {
            *cp != 0
                && *cp != 0xFEFF
                && char::from_u32(*cp)
                    .is_some_and(|ch| !ch.is_control() || matches!(ch, '\t' | '\n' | '\r'))
        })
}

fn push_codepoints(text: &mut String, codepoints: &[u32]) {
    for cp in codepoints {
        push_codepoint(text, *cp);
    }
}

fn push_codepoint(text: &mut String, codepoint: u32) {
    if codepoint == 0 || codepoint == 0xFEFF {
        return;
    }
    if let Some(ch) = char::from_u32(codepoint) {
        if ch.is_control() && !matches!(ch, '\t' | '\n' | '\r') {
            return;
        }
        text.push(ch);
    }
}

fn agl_lookup_extended(name: &[u8]) -> Option<Vec<u32>> {
    agl_components(name)
}

#[cfg(test)]
#[allow(dead_code, clippy::expect_used, clippy::indexing_slicing)]
mod tests {
    use std::collections::BTreeMap;
    use std::ops::Range;

    use super::*;
    use crate::failure::Outcome;
    use crate::inspection::Limits;
    use crate::object::{Dict, ObjRef, Object, Stream};

    struct MapResolver {
        objects: BTreeMap<ObjRef, Object>,
        streams: BTreeMap<(u32, u16), Vec<u8>>,
        data: Vec<u8>,
    }

    impl MapResolver {
        fn stream_from(dict: Dict, data: &[u8]) -> (Stream, Range<usize>) {
            let start = 0usize;
            let end = data.len();
            (
                Stream {
                    dict,
                    data: start..end,
                },
                start..end,
            )
        }

        fn insert_bytes(&mut self, reference: ObjRef, dict: Dict, data: &[u8]) {
            let (stream, _) = Self::stream_from(dict, data);
            self.streams
                .insert((reference.number, reference.generation), data.to_vec());
            self.objects.insert(reference, Object::Stream(stream));
        }
    }

    impl Resolver for MapResolver {
        fn resolve(&self, object: &Object) -> Outcome<Object> {
            match object {
                Object::Ref(reference) => self
                    .objects
                    .get(reference)
                    .cloned()
                    .ok_or_else(|| Failure::invalid("missing object")),
                _ => Ok(object.clone()),
            }
        }

        fn stream_data(&self, stream: &Stream) -> Outcome<Vec<u8>> {
            if stream.data.end <= self.data.len() {
                Ok(self.data[stream.data.clone()].to_vec())
            } else {
                Err(Failure::invalid("stream bytes missing"))
            }
        }
    }

    fn dict_with(entries: Vec<(&[u8], Object)>) -> Dict {
        let mut dict = Dict::default();
        for (key, value) in entries {
            dict.insert(key, value);
        }
        dict
    }

    #[test]
    fn cached_builtin_tables_match_the_name_lookup_path() {
        for builtin in [
            BuiltinEncoding::WinAnsi,
            BuiltinEncoding::Standard,
            BuiltinEncoding::MacRoman,
            BuiltinEncoding::MacExpert,
            BuiltinEncoding::PdfDoc,
        ] {
            let font = SimpleFont {
                encoding: EncodingState {
                    builtin,
                    differences: Vec::new(),
                    custom_names: Vec::new(),
                },
                to_unicode: UnicodeMap::default(),
                program: None,
                program_map: Vec::new(),
                widths: WidthState {
                    first_char: 0,
                    widths: Vec::new(),
                    missing: 500.0,
                    standard14: None,
                },
                font_matrix: None,
                symbolic: false,
                vertical: false,
                vertical_default: 1000.0,
                vertical_metrics: VerticalMetrics {
                    _dw2_pos: 0.0,
                    dw2_adv: 0.0,
                    w2: Vec::new(),
                },
            };
            assert!(font.builtin_text_table().is_some());
            let all: Vec<u8> = (0..=255).collect();
            let mut glyphs = Vec::new();
            let mut fast = String::new();
            font.decode(&all, &mut glyphs, &mut fast);
            let mut slow = String::new();
            for code in 0..=255u32 {
                font.decode_code_slow(code, &mut slow);
            }
            assert_eq!(fast, slow, "{builtin:?}");
            assert_eq!(glyphs.len(), 256);
        }
    }

    #[test]
    fn win_ansi_maps_space() {
        let font = SimpleFont {
            encoding: EncodingState {
                builtin: BuiltinEncoding::WinAnsi,
                differences: Vec::new(),
                custom_names: Vec::new(),
            },
            to_unicode: UnicodeMap::default(),
            program: None,
            program_map: Vec::new(),
            widths: WidthState {
                first_char: 0,
                widths: Vec::new(),
                missing: 1000.0,
                standard14: Some(Standard14Font::Helvetica),
            },
            font_matrix: None,
            symbolic: false,
            vertical: false,
            vertical_default: 1000.0,
            vertical_metrics: VerticalMetrics {
                _dw2_pos: 0.0,
                dw2_adv: 0.0,
                w2: Vec::new(),
            },
        };
        let mut glyphs = Vec::new();
        let mut text = String::new();
        font.decode(b" ", &mut glyphs, &mut text);
        assert_eq!(text, " ");
        assert_eq!(glyphs.len(), 1);
    }

    #[test]
    fn standard14_widths_spot_check() {
        let helvetica = STANDARD14_WIDTHS[Standard14Font::Helvetica as usize];
        assert_eq!(helvetica[b'A' as usize], 667);
        assert_eq!(helvetica[b' ' as usize], 278);
        assert_eq!(helvetica[b'a' as usize], 556);
        let times = STANDARD14_WIDTHS[Standard14Font::Times_Roman as usize];
        assert_eq!(times[b' ' as usize], 250);
        let courier = STANDARD14_WIDTHS[Standard14Font::Courier as usize];
        assert_eq!(courier[b'A' as usize], 600);
    }

    #[test]
    fn to_unicode_bfchar() {
        let cmap = b"begincmap beginbfchar 1 <41> <0041> endbfchar endcmap";
        let map = parse_cmap_to_unicode(cmap, &Limits::default());
        let result = map.lookup(0x41).expect("mapping");
        assert_eq!(result, &[0x0041]);
    }

    #[test]
    fn to_unicode_count_before_keyword() {
        let cmap = b"1 begincodespacerange <0000> <FFFF> endcodespacerange\n2 beginbfchar\n<0001> <0041>\n<0002> <0042>\nendbfchar\n1 beginbfrange\n<0010> <0012> <0061>\nendbfrange";
        let map = parse_cmap_to_unicode(cmap, &Limits::default());
        assert_eq!(map.lookup(1), Some([0x41].as_slice()));
        assert_eq!(map.lookup(2), Some([0x42].as_slice()));
        assert_eq!(map.lookup(0x11), Some([0x62].as_slice()));
        assert_eq!(map.lookup(3), None);
        let reader = parse_cmap_codespace(cmap, &Limits::default());
        assert_eq!(reader.bytes_per_code, 2);
        assert_eq!(reader.read(&[0, 1, 0, 2], 0), Some((1, 2)));
    }

    #[test]
    fn to_unicode_bfrange_surrogate() {
        let cmap = b"begincmap beginbfrange 1 <0000> <0000> <d800dc00> endbfrange endcmap";
        let map = parse_cmap_to_unicode(cmap, &Limits::default());
        let result = map.lookup(0).expect("mapping");
        assert_eq!(result[0], 0x1_0000);
    }

    #[test]
    fn to_unicode_bfrange_ligature_array() {
        let cmap = b"begincmap beginbfrange 1 <0001> <0001> [<0066><0069>] endbfrange endcmap";
        let map = parse_cmap_to_unicode(cmap, &Limits::default());
        let result = map.lookup(1).expect("mapping");
        assert_eq!(result, &[0x0066, 0x0069]);
    }

    #[test]
    fn type0_identity_widths() {
        let metrics = CidMetrics {
            default_width: 1000.0,
            widths: vec![(65, 500.0)],
            range_widths: Vec::new(),
        };
        assert_eq!(metrics.width(65), 500.0);
        assert_eq!(metrics.width(66), 1000.0);
    }

    #[test]
    fn cmap_fuzz_no_panic() {
        let limits = Limits::default();
        let mut seed = 0x9e37_79b9u32;
        for _ in 0..256 {
            seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
            let len = (seed % 128) as usize + 8;
            let mut data = Vec::with_capacity(len);
            for idx in 0..len {
                let byte = ((seed >> (idx % 16)) & 0xff) as u8;
                data.push(byte);
            }
            let _ = parse_cmap_to_unicode(&data, &limits);
            let _ = parse_cmap_codespace(&data, &limits);
        }
    }

    #[test]
    fn subset_prefix_standard14() {
        let name = Object::Name(b"ABCDEF+Helvetica".to_vec());
        assert_eq!(
            standard14_from_base_font(Some(&name)),
            Some(Standard14Font::Helvetica)
        );
    }

    #[test]
    fn type3_font_matrix_scales_width() {
        let font = SimpleFont {
            encoding: EncodingState {
                builtin: BuiltinEncoding::Standard,
                differences: Vec::new(),
                custom_names: Vec::new(),
            },
            to_unicode: UnicodeMap::default(),
            program: None,
            program_map: Vec::new(),
            widths: WidthState {
                first_char: 65,
                widths: vec![1000.0],
                missing: 1000.0,
                standard14: None,
            },
            font_matrix: Some([0.001, 0.0, 0.0, 0.001, 0.0, 0.0]),
            symbolic: false,
            vertical: false,
            vertical_default: 1000.0,
            vertical_metrics: VerticalMetrics {
                _dw2_pos: 0.0,
                dw2_adv: 0.0,
                w2: Vec::new(),
            },
        };
        let width = font.width_for_code(65);
        assert!((width - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn agl_fi_ligature_name() {
        let mapped = agl_lookup_extended(b"fi");
        assert_eq!(mapped, Some(vec![0xfb01]));
    }

    #[test]
    fn garbage_cmap_does_not_panic() {
        let map = parse_cmap_to_unicode(b"not a cmap %%%%", &Limits::default());
        assert!(map.char_map.is_empty());
    }
}
