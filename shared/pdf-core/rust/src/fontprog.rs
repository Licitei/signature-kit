use crate::failure::Failure;
use crate::font_tables::{BuiltinEncoding, encoding_glyph_name, lookup_agl};
use crate::inspection::Limits;

const MAX_TABLES: usize = 64;
const MAX_SUBTABLES: usize = 32;
const MAX_GLYPHS: usize = 65536;
const MAX_NAME_BYTES: usize = 256;
const MAX_GSUB_LOOKUPS: usize = 64;
const POST_FORMAT_1_NAMES: usize = 258;
const POST_MAC_NAMES: usize = 164;

type CmapTable = (u16, u16, u16, Vec<(u32, u16)>);

#[derive(Clone, Default)]
pub struct FontProgram {
    code_to_gid: Vec<CmapTable>,
    gid_names: Vec<Vec<u8>>,
    gid_unicode: Vec<Vec<u32>>,
}

#[derive(Clone, Copy, Default)]
struct TableRecord {
    offset: u32,
    length: u32,
}

pub fn parse_font_program(bytes: &[u8], limits: &Limits) -> Option<FontProgram> {
    if bytes.len() < 12 {
        return None;
    }
    let version = read_u32(bytes, 0)?;
    if version != 0x0001_0000 && version != 0x4F54_544F {
        return parse_type1_font(bytes, limits);
    }
    let num_tables = read_u16(bytes, 4)? as usize;
    if num_tables == 0 || num_tables > MAX_TABLES {
        return None;
    }
    if 12usize.saturating_add(num_tables.saturating_mul(16)) > bytes.len() {
        return None;
    }
    let mut records = Vec::new();
    for idx in 0..num_tables {
        let base = 12usize.saturating_add(idx.saturating_mul(16));
        let tag = read_tag(bytes, base)?;
        let offset = read_u32(bytes, base.saturating_add(8))?;
        let length = read_u32(bytes, base.saturating_add(12))?;
        if length == 0
            || usize::try_from(offset)
                .ok()?
                .saturating_add(usize::try_from(length).ok()?)
                > bytes.len()
        {
            continue;
        }
        records.push((tag, TableRecord { offset, length }));
    }
    let mut program = FontProgram::default();
    if let Some((_, rec)) = records.iter().find(|(tag, _)| *tag == *b"cmap") {
        parse_cmap(bytes, rec, limits, &mut program)?;
    }
    if let Some((_, rec)) = records.iter().find(|(tag, _)| *tag == *b"post") {
        parse_post(bytes, rec, limits, &mut program)?;
    }
    if let Some((_, rec)) = records.iter().find(|(tag, _)| *tag == *b"GSUB") {
        let _ = parse_gsub_ligatures(bytes, rec, limits, &mut program);
    }
    if let Some((_, rec)) = records.iter().find(|(tag, _)| *tag == *b"CFF ") {
        parse_cff(bytes, rec, limits, &mut program);
    }
    program.ensure_gid_capacity(limits);
    program.fill_gid_unicode();
    Some(program)
}

impl FontProgram {
    pub fn glyph_count(&self) -> usize {
        self.gid_names.len().max(self.gid_unicode.len())
    }

    pub fn unicode_for_encoded_code(
        &self,
        code: u32,
        symbolic: bool,
        _builtin: BuiltinEncoding,
    ) -> Option<Vec<u32>> {
        let mut query = code;
        if symbolic && query >= 0xF000 {
            query -= 0xF000;
        }
        let gid = self
            .map_code_to_gid(3, if symbolic { 0 } else { 1 }, query)
            .or_else(|| self.map_code_to_gid(3, 0, query))
            .or_else(|| self.map_code_to_gid(1, 0, query))?;
        self.unicode_for_gid(gid)
            .or_else(|| self.glyph_name(gid).and_then(agl_components))
    }

    pub fn unicode_for_gid(&self, gid: u16) -> Option<Vec<u32>> {
        self.gid_unicode.get(usize::from(gid)).and_then(|slice| {
            if slice.is_empty() {
                None
            } else {
                Some(slice.clone())
            }
        })
    }

    pub fn glyph_name(&self, gid: u16) -> Option<&[u8]> {
        self.gid_names.get(usize::from(gid)).map(Vec::as_slice)
    }

    fn map_code_to_gid(&self, platform: u16, encoding: u16, code: u32) -> Option<u16> {
        for (plat, enc, _, map) in &self.code_to_gid {
            if *plat == platform && *enc == encoding {
                if let Some(gid) = map.iter().find(|(c, _)| *c == code).map(|(_, g)| *g) {
                    return Some(gid);
                }
                for (start, gid) in map {
                    if code == *start {
                        return Some(*gid);
                    }
                }
            }
        }
        None
    }

    fn ensure_gid_capacity(&mut self, limits: &Limits) {
        let cap = limits.max_items.min(MAX_GLYPHS);
        if self.gid_names.len() < cap {
            self.gid_names.resize(cap, Vec::new());
        }
        if self.gid_unicode.len() < cap {
            self.gid_unicode.resize(cap, Vec::new());
        }
    }

    fn fill_gid_unicode(&mut self) {
        let name_count = self.gid_names.len();
        for gid in 0..name_count {
            if self
                .gid_unicode
                .get(gid)
                .is_some_and(|slice| !slice.is_empty())
            {
                continue;
            }
            if let Some(name) = self.gid_names.get(gid).filter(|n| !n.is_empty())
                && let Some(cps) = agl_components(name)
                && let Some(slot) = self.gid_unicode.get_mut(gid)
            {
                *slot = cps;
            }
        }
        for (_plat, _enc, _fmt, map) in &self.code_to_gid {
            for (code, gid) in map {
                let idx = usize::from(*gid);
                if self.gid_unicode.get(idx).is_some_and(|s| !s.is_empty()) {
                    continue;
                }
                if let Some(slot) = self.gid_unicode.get_mut(idx)
                    && *code <= 0x10FFFF
                {
                    *slot = vec![*code];
                }
            }
        }
    }

    pub fn build_byte_map(
        &self,
        symbolic: bool,
        builtin: BuiltinEncoding,
        limits: &Limits,
    ) -> Vec<(u32, Vec<u32>)> {
        let mut out = Vec::new();
        for code in 0..=255u32 {
            if let Some(cps) = self.unicode_for_encoded_code(code, symbolic, builtin) {
                if out.len() >= limits.max_items {
                    break;
                }
                out.push((code, cps));
            } else if !symbolic {
                let name = encoding_glyph_name(builtin, code as u8);
                if let Some(cps) = agl_components(name.as_bytes()) {
                    out.push((code, cps));
                }
            }
        }
        out
    }
}

pub fn agl_components(name: &[u8]) -> Option<Vec<u32>> {
    if let Some(found) = lookup_agl(name) {
        return Some(found.to_vec());
    }
    let text = core::str::from_utf8(name).ok()?;
    if let Some(rest) = text.strip_prefix("uni") {
        let mut out = Vec::new();
        let chars: Vec<char> = rest.chars().collect();
        let mut idx = 0usize;
        while idx < chars.len() {
            let end = (idx + 4).min(chars.len());
            let segment: String = chars.get(idx..end)?.iter().collect();
            if let Ok(cp) = u32::from_str_radix(&segment, 16) {
                out.push(cp);
            }
            idx += 4;
        }
        if !out.is_empty() {
            return Some(out);
        }
    }
    if let Some(rest) = text.strip_prefix('u')
        && let Ok(cp) = u32::from_str_radix(rest, 16)
    {
        return Some(vec![cp]);
    }
    if text.contains('_') {
        let mut out = Vec::new();
        for part in text.split('_') {
            if part.is_empty() {
                continue;
            }
            if let Some(found) = lookup_agl(part.as_bytes()) {
                out.extend_from_slice(found);
            } else if part.len() == 1 {
                out.push(u32::from(part.chars().next()?));
            } else {
                out.extend(agl_components(part.as_bytes())?);
            }
        }
        if !out.is_empty() {
            return Some(out);
        }
    }
    if let Some(base) = text.split('.').next() {
        return lookup_agl(base.as_bytes()).map(|slice| slice.to_vec());
    }
    None
}

fn parse_cmap(
    bytes: &[u8],
    rec: &TableRecord,
    limits: &Limits,
    program: &mut FontProgram,
) -> Option<()> {
    let base = usize::try_from(rec.offset).ok()?;
    let end = base.saturating_add(usize::try_from(rec.length).ok()?);
    if end > bytes.len() {
        return None;
    }
    let slice = bytes.get(base..end)?;
    let num_sub = read_u16(slice, 2)? as usize;
    if num_sub == 0 || num_sub > MAX_SUBTABLES {
        return None;
    }
    for idx in 0..num_sub {
        let head = 4usize.saturating_add(idx.saturating_mul(8));
        let platform = read_u16(slice, head)?;
        let encoding = read_u16(slice, head.saturating_add(2))?;
        let offset = read_u32(slice, head.saturating_add(4))?;
        let sub_off = base.saturating_add(usize::try_from(offset).ok()?);
        if sub_off >= bytes.len() {
            continue;
        }
        if let Some(map) = parse_cmap_subtable(bytes, sub_off, limits) {
            let fmt = read_u16(bytes, sub_off).unwrap_or(0);
            program.code_to_gid.push((platform, encoding, fmt, map));
        }
    }
    Some(())
}

fn parse_cmap_subtable(bytes: &[u8], offset: usize, limits: &Limits) -> Option<Vec<(u32, u16)>> {
    let format = read_u16(bytes, offset)?;
    match format {
        0 => parse_cmap_format0(bytes, offset, limits),
        4 => parse_cmap_format4(bytes, offset, limits),
        6 => parse_cmap_format6(bytes, offset, limits),
        12 => parse_cmap_format12(bytes, offset, limits),
        _ => None,
    }
}

fn parse_cmap_format0(bytes: &[u8], offset: usize, limits: &Limits) -> Option<Vec<(u32, u16)>> {
    let length = read_u16(bytes, offset.saturating_add(2))? as usize;
    if length < 262 {
        return None;
    }
    let mut out = Vec::new();
    for code in 0..256u32 {
        let gid = bytes
            .get(offset.saturating_add(6).saturating_add(code as usize))
            .copied()? as u16;
        if gid != 0 && out.len() < limits.max_items {
            out.push((code, gid));
        }
    }
    Some(out)
}

fn parse_cmap_format4(bytes: &[u8], offset: usize, limits: &Limits) -> Option<Vec<(u32, u16)>> {
    let seg_count_x2 = read_u16(bytes, offset.saturating_add(6))? as usize;
    let seg_count = seg_count_x2.checked_div(2)?;
    if seg_count == 0 || seg_count > limits.max_items {
        return None;
    }
    let end_base = offset.saturating_add(14);
    let start_base = end_base.saturating_add(seg_count_x2).saturating_add(2);
    let delta_base = start_base.saturating_add(seg_count_x2);
    let range_base = delta_base.saturating_add(seg_count_x2);
    let glyph_base = range_base.saturating_add(seg_count_x2);
    let mut out = Vec::new();
    for seg in 0..seg_count {
        let end_code = read_u16(bytes, end_base.saturating_add(seg.saturating_mul(2)))?;
        let start_code = read_u16(bytes, start_base.saturating_add(seg.saturating_mul(2)))?;
        let id_delta = read_i16(bytes, delta_base.saturating_add(seg.saturating_mul(2)))?;
        let range_off = read_u16(bytes, range_base.saturating_add(seg.saturating_mul(2)))?;
        if end_code < start_code {
            continue;
        }
        for code in u32::from(start_code)..=u32::from(end_code) {
            if out.len() >= limits.max_items {
                return Some(out);
            }
            let gid = if range_off == 0 {
                let value = i64::from(code) + i64::from(id_delta);
                if value < 0 || value > i64::from(u16::MAX) {
                    continue;
                }
                value as u16
            } else {
                let offset_index = usize::from(range_off)
                    .checked_div(2)
                    .and_then(|half| {
                        half.checked_add(code.saturating_sub(u32::from(start_code)) as usize)
                    })
                    .and_then(|sum| sum.checked_add(seg))
                    .and_then(|sum| sum.checked_sub(seg_count));
                let Some(offset_index) = offset_index else {
                    continue;
                };
                let raw = read_u16(
                    bytes,
                    glyph_base.saturating_add(offset_index.saturating_mul(2)),
                )?;
                if raw == 0 {
                    continue;
                }
                let value = i64::from(raw) + i64::from(id_delta);
                if value < 0 || value > i64::from(u16::MAX) {
                    continue;
                }
                value as u16
            };
            if gid != 0 {
                out.push((code, gid));
            }
        }
    }
    Some(out)
}

fn parse_cmap_format6(bytes: &[u8], offset: usize, limits: &Limits) -> Option<Vec<(u32, u16)>> {
    let first = read_u16(bytes, offset.saturating_add(6))?;
    let count = read_u16(bytes, offset.saturating_add(8))? as usize;
    if count > limits.max_items {
        return None;
    }
    let mut out = Vec::new();
    for idx in 0..count {
        let gid = read_u16(
            bytes,
            offset
                .saturating_add(10)
                .saturating_add(idx.saturating_mul(2)),
        )?;
        if gid != 0 {
            out.push((u32::from(first).saturating_add(idx as u32), gid));
        }
    }
    Some(out)
}

fn parse_cmap_format12(bytes: &[u8], offset: usize, limits: &Limits) -> Option<Vec<(u32, u16)>> {
    let group_count = read_u32(bytes, offset.saturating_add(12))? as usize;
    if group_count > limits.max_items {
        return None;
    }
    let mut out = Vec::new();
    let base = offset.saturating_add(16);
    for idx in 0..group_count {
        let head = base.saturating_add(idx.saturating_mul(12));
        let start = read_u32(bytes, head)?;
        let end = read_u32(bytes, head.saturating_add(4))?;
        let start_gid = read_u32(bytes, head.saturating_add(8))?;
        if end < start {
            continue;
        }
        let span = end.saturating_sub(start);
        if span > limits.max_items as u32 {
            return Some(out);
        }
        for delta in 0..=span {
            let code = start.saturating_add(delta);
            let gid = start_gid.saturating_add(delta);
            if gid > u32::from(u16::MAX) {
                break;
            }
            out.push((code, gid as u16));
            if out.len() >= limits.max_items {
                return Some(out);
            }
        }
    }
    Some(out)
}

fn parse_post(
    bytes: &[u8],
    rec: &TableRecord,
    limits: &Limits,
    program: &mut FontProgram,
) -> Option<()> {
    let base = usize::try_from(rec.offset).ok()?;
    let end = base.saturating_add(usize::try_from(rec.length).ok()?);
    if end > bytes.len() {
        return None;
    }
    let slice = bytes.get(base..end)?;
    let format = read_u32(slice, 0)?;
    let num_glyphs = read_u16(slice, 4)? as usize;
    let cap = num_glyphs.min(limits.max_items).min(MAX_GLYPHS);
    program.gid_names.resize(cap, Vec::new());
    match format {
        0x00010000 | 0x00010001 => {
            for gid in 0..cap.min(POST_FORMAT_1_NAMES) {
                if let Some(name) = post_mac_standard_name(gid) {
                    program.gid_names[gid] = name.as_bytes().to_vec();
                }
            }
        }
        0x00020000 => {
            let idx = 32usize;
            for gid in 0..cap {
                let name_index =
                    read_u16(slice, idx.saturating_add(gid.saturating_mul(2)))? as usize;
                if name_index < POST_FORMAT_1_NAMES {
                    if let Some(name) = post_mac_standard_name(name_index) {
                        program.gid_names[gid] = name.as_bytes().to_vec();
                    }
                } else {
                    let name_offset = 34usize
                        .saturating_add(cap.saturating_mul(2))
                        .saturating_add((name_index - POST_FORMAT_1_NAMES).saturating_mul(1));
                    let name = read_pascal_string(slice, name_offset, limits)?;
                    if !name.is_empty() {
                        program.gid_names[gid] = name;
                    }
                }
            }
        }
        0x00030000 => {}
        _ => {}
    }
    Some(())
}

fn post_mac_standard_name(index: usize) -> Option<&'static str> {
    static NAMES: [&str; POST_MAC_NAMES] = [
        ".notdef",
        ".null",
        "nonmarkingreturn",
        "space",
        "exclam",
        "quotedbl",
        "numbersign",
        "dollar",
        "percent",
        "ampersand",
        "quotesingle",
        "parenleft",
        "parenright",
        "asterisk",
        "plus",
        "comma",
        "hyphen",
        "period",
        "slash",
        "zero",
        "one",
        "two",
        "three",
        "four",
        "five",
        "six",
        "seven",
        "eight",
        "nine",
        "colon",
        "semicolon",
        "less",
        "equal",
        "greater",
        "question",
        "at",
        "A",
        "B",
        "C",
        "D",
        "E",
        "F",
        "G",
        "H",
        "I",
        "J",
        "K",
        "L",
        "M",
        "N",
        "O",
        "P",
        "Q",
        "R",
        "S",
        "T",
        "U",
        "V",
        "W",
        "X",
        "Y",
        "Z",
        "bracketleft",
        "backslash",
        "bracketright",
        "asciicircum",
        "underscore",
        "grave",
        "a",
        "b",
        "c",
        "d",
        "e",
        "f",
        "g",
        "h",
        "i",
        "j",
        "k",
        "l",
        "m",
        "n",
        "o",
        "p",
        "q",
        "r",
        "s",
        "t",
        "u",
        "v",
        "w",
        "x",
        "y",
        "z",
        "braceleft",
        "bar",
        "braceright",
        "asciitilde",
        "Adieresis",
        "Aring",
        "Ccedilla",
        "Eacute",
        "Ntilde",
        "Odieresis",
        "Udieresis",
        "aacute",
        "agrave",
        "acircumflex",
        "adieresis",
        "atilde",
        "aring",
        "ccedilla",
        "eacute",
        "egrave",
        "ecircumflex",
        "edieresis",
        "iacute",
        "igrave",
        "icircumflex",
        "idieresis",
        "ntilde",
        "oacute",
        "ograve",
        "ocircumflex",
        "odieresis",
        "otilde",
        "uacute",
        "ugrave",
        "ucircumflex",
        "udieresis",
        "dagger",
        "degree",
        "cent",
        "sterling",
        "section",
        "bullet",
        "paragraph",
        "germandbls",
        "registered",
        "copyright",
        "trademark",
        "acute",
        "dieresis",
        "notequal",
        "AE",
        "Oslash",
        "infinity",
        "plusminus",
        "lessequal",
        "greaterequal",
        "yen",
        "mu",
        "partialdiff",
        "summation",
        "product",
        "pi",
        "integral",
        "Omega",
        "approxequal",
        "Delta",
        "lozenge",
        "Euro",
        "fi",
        "fl",
    ];
    if index >= POST_FORMAT_1_NAMES {
        return None;
    }
    NAMES.get(index).copied()
}

fn parse_gsub_ligatures(
    bytes: &[u8],
    rec: &TableRecord,
    limits: &Limits,
    program: &mut FontProgram,
) -> Option<()> {
    let base = usize::try_from(rec.offset).ok()?;
    let end = base.saturating_add(usize::try_from(rec.length).ok()?);
    if end > bytes.len() {
        return None;
    }
    let lookup_list_offset = read_u16(bytes, base.saturating_add(6))? as usize;
    let lookup_base = base.saturating_add(lookup_list_offset);
    let lookup_count = read_u16(bytes, lookup_base)? as usize;
    if lookup_count > MAX_GSUB_LOOKUPS {
        return None;
    }
    for lookup_idx in 0..lookup_count.min(MAX_GSUB_LOOKUPS) {
        let lookup_offset = read_u16(
            bytes,
            lookup_base
                .saturating_add(2)
                .saturating_add(lookup_idx.saturating_mul(2)),
        )? as usize;
        let lookup_addr = lookup_base.saturating_add(lookup_offset);
        let lookup_type = read_u16(bytes, lookup_addr)?;
        if lookup_type != 4 {
            continue;
        }
        let sub_count = read_u16(bytes, lookup_addr.saturating_add(4))? as usize;
        for sub in 0..sub_count.min(8) {
            let sub_off = read_u16(
                bytes,
                lookup_addr
                    .saturating_add(6)
                    .saturating_add(sub.saturating_mul(2)),
            )? as usize;
            parse_ligature_subtable(bytes, lookup_addr.saturating_add(sub_off), limits, program);
        }
    }
    Some(())
}

fn parse_ligature_subtable(
    bytes: &[u8],
    offset: usize,
    limits: &Limits,
    program: &mut FontProgram,
) {
    let count = read_u16(bytes, offset).unwrap_or(0) as usize;
    for idx in 0..count.min(32) {
        let lig_off = read_u16(
            bytes,
            offset
                .saturating_add(2)
                .saturating_add(idx.saturating_mul(2)),
        )
        .map(|value| offset.saturating_add(value as usize));
        let Some(addr) = lig_off else { continue };
        let lig_gid = read_u16(bytes, addr).unwrap_or(0);
        let comp_len = bytes.get(addr.saturating_add(2)).copied().unwrap_or(0) as usize;
        if !(2..=8).contains(&comp_len) {
            continue;
        }
        let mut components = Vec::new();
        for comp in 0..comp_len.saturating_sub(1) {
            let gid = read_u16(
                bytes,
                addr.saturating_add(3)
                    .saturating_add(comp.saturating_mul(2)),
            )
            .unwrap_or(0);
            components.push(gid);
        }
        if components.is_empty() {
            continue;
        }
        let mut cps = Vec::new();
        for gid in components {
            if let Some(name) = program.glyph_name(gid)
                && let Some(part) = agl_components(name)
            {
                cps.extend(part);
            }
        }
        if cps.is_empty() || lig_gid == 0 {
            continue;
        }
        let slot = usize::from(lig_gid);
        if slot < program.gid_unicode.len()
            && program.gid_unicode[slot].is_empty()
            && cps.len() <= limits.max_items
        {
            program.gid_unicode[slot] = cps;
        }
    }
}

fn parse_cff(bytes: &[u8], rec: &TableRecord, limits: &Limits, program: &mut FontProgram) {
    let Some(base) = usize::try_from(rec.offset).ok() else {
        return;
    };
    let Some(length) = usize::try_from(rec.length).ok() else {
        return;
    };
    let end = base.saturating_add(length);
    if end > bytes.len() || end.saturating_sub(base) < 4 {
        return;
    }
    let Some(slice) = bytes.get(base..end) else {
        return;
    };
    if slice.first() != Some(&1) {
        return;
    }
    let hdr_size = usize::from(slice.get(1).copied().unwrap_or(4));
    let off_size = slice.get(2).copied().unwrap_or(1);
    let name_size = read_cff_size(slice, 3, off_size).unwrap_or(0);
    let name_end = hdr_size.saturating_add(name_size as usize);
    let offset_count = read_cff_size(slice, name_end, off_size).unwrap_or(0);
    if offset_count < 2 {
        return;
    }
    let glyph_count = offset_count.saturating_sub(1).min(limits.max_items as u32) as usize;
    if glyph_count == 0 || glyph_count > MAX_GLYPHS {
        return;
    }
    program.gid_names.resize(glyph_count, Vec::new());
    for gid in 0..glyph_count {
        if let Some(name) = post_mac_standard_name(gid) {
            program.gid_names[gid] = name.as_bytes().to_vec();
        }
    }
}

fn read_cff_size(bytes: &[u8], offset: usize, size: u8) -> Option<u32> {
    match size {
        1 => Some(u32::from(*bytes.get(offset)?)),
        2 => {
            let hi = u32::from(*bytes.get(offset)?);
            let lo = u32::from(*bytes.get(offset.saturating_add(1))?);
            Some((hi << 8) | lo)
        }
        3 => {
            let a = u32::from(*bytes.get(offset)?);
            let b = u32::from(*bytes.get(offset.saturating_add(1))?);
            let c = u32::from(*bytes.get(offset.saturating_add(2))?);
            Some((a << 16) | (b << 8) | c)
        }
        4 => read_u32(bytes, offset),
        _ => None,
    }
}

fn read_pascal_string(bytes: &[u8], offset: usize, limits: &Limits) -> Option<Vec<u8>> {
    let len = usize::from(*bytes.get(offset)?);
    if len > MAX_NAME_BYTES || len > limits.max_decoded_stream_bytes {
        return None;
    }
    let end = offset.saturating_add(1).saturating_add(len);
    Some(bytes.get(offset.saturating_add(1)..end)?.to_vec())
}

fn read_tag(bytes: &[u8], offset: usize) -> Option<[u8; 4]> {
    let mut tag = [0u8; 4];
    for (idx, slot) in tag.iter_mut().enumerate() {
        *slot = *bytes.get(offset.saturating_add(idx))?;
    }
    Some(tag)
}

fn read_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    let hi = u16::from(*bytes.get(offset)?);
    let lo = u16::from(*bytes.get(offset.saturating_add(1))?);
    Some((hi << 8) | lo)
}

fn read_i16(bytes: &[u8], offset: usize) -> Option<i16> {
    read_u16(bytes, offset).map(|value| value as i16)
}

fn read_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    let a = u32::from(*bytes.get(offset)?);
    let b = u32::from(*bytes.get(offset.saturating_add(1))?);
    let c = u32::from(*bytes.get(offset.saturating_add(2))?);
    let d = u32::from(*bytes.get(offset.saturating_add(3))?);
    Some((a << 24) | (b << 16) | (c << 8) | d)
}

fn parse_type1_font(bytes: &[u8], limits: &Limits) -> Option<FontProgram> {
    let text = core::str::from_utf8(bytes).ok()?;
    if !text.contains("/FontType 1") {
        return None;
    }
    let _ = limits;
    None
}

pub fn load_font_file_bytes(
    key: &[u8],
    descriptor: &crate::object::Dict,
    resolver: &dyn crate::object::Resolver,
    limits: &Limits,
) -> Result<Vec<u8>, Failure> {
    let Some(stream_obj) = descriptor.get(key) else {
        return Err(Failure::invalid("missing font program stream"));
    };
    let resolved = resolver.resolve(stream_obj)?;
    let crate::object::Object::Stream(stream) = resolved else {
        return Err(Failure::invalid("font program is not a stream"));
    };
    let raw = resolver.stream_data(&stream)?;
    crate::filters::decode_stream(&stream.dict, &raw, limits.max_decoded_stream_bytes)
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    fn be16(value: u16) -> [u8; 2] {
        value.to_be_bytes()
    }

    fn be32(value: u32) -> [u8; 4] {
        value.to_be_bytes()
    }

    fn minimal_ttf_ti_ligature() -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&be32(0x0001_0000));
        out.extend_from_slice(&be16(2));
        out.extend_from_slice(&be16(0));
        out.extend_from_slice(&be16(0));
        out.extend_from_slice(&be16(0));
        let cmap_offset = 12 + 2 * 16;
        let post_offset = cmap_offset + 64;
        for (tag, off, len) in [
            (*b"cmap", cmap_offset as u32, 64u32),
            (*b"post", post_offset as u32, 128u32),
        ] {
            out.extend_from_slice(&tag);
            out.extend_from_slice(&be32(0));
            out.extend_from_slice(&be32(off));
            out.extend_from_slice(&be32(len));
        }
        out.resize(cmap_offset, 0);
        out.extend_from_slice(&be16(0));
        out.extend_from_slice(&be16(1));
        out.extend_from_slice(&be16(3));
        out.extend_from_slice(&be16(1));
        out.extend_from_slice(&be32(4));
        out.extend_from_slice(&be16(4));
        out.extend_from_slice(&be16(32));
        out.extend_from_slice(&be16(0));
        out.extend_from_slice(&be16(4));
        out.extend_from_slice(&be16(2));
        out.extend_from_slice(&be16(0xFFFF));
        out.extend_from_slice(&be16(0x00FD));
        out.extend_from_slice(&be16(0));
        out.extend_from_slice(&be16(0xFFFF));
        out.extend_from_slice(&be16(0));
        out.extend_from_slice(&be16(0));
        out.resize(post_offset, 0);
        out.extend_from_slice(&be32(0x0002_0000));
        out.extend_from_slice(&be16(3));
        out.extend_from_slice(&be32(0));
        out.extend_from_slice(&be32(0));
        out.extend_from_slice(&be16(0));
        out.extend_from_slice(&be16(2));
        out.extend_from_slice(&be16(258));
        out.push(3);
        out.extend_from_slice(b"t_i");
        out
    }

    #[test]
    fn ttf_ligature_name_maps_to_ti() {
        let data = minimal_ttf_ti_ligature();
        let _program = parse_font_program(&data, &Limits::default());
        let cps = agl_components(b"t_i").expect("agl");
        assert_eq!(cps, vec![b't' as u32, b'i' as u32]);
    }

    #[test]
    fn agl_splits_underscore_ligatures() {
        assert_eq!(agl_components(b"t_i"), Some(vec![b't' as u32, b'i' as u32]));
    }

    #[test]
    fn fontprog_fuzz_no_panic() {
        let limits = Limits::default();
        let mut seed = 0x5165_3729u32;
        for _ in 0..512 {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let len = (seed % 256) as usize + 16;
            let mut data = vec![0u8; len];
            for (idx, slot) in data.iter_mut().enumerate() {
                *slot = ((seed >> (idx % 16)) & 0xff) as u8;
            }
            let _ = parse_font_program(&data, &limits);
            let _ = agl_components(&data);
        }
    }
}
