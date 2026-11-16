use std::cell::OnceCell;
use std::collections::HashMap;

use crate::cff::CffFont;
use crate::failure::Failure;
use crate::font_tables::{BuiltinEncoding, encoding_glyph_name, lookup_agl};
use crate::inspection::Limits;

const MAX_TABLES: usize = 128;
const MAX_SUBTABLES: usize = 64;
const MAX_GLYPHS: usize = 65_535;
const MAX_REVERSE_CODES: usize = 262_144;
const MAX_LOOKUPS: usize = 128;
const MAX_LOOKUP_SUBTABLES: usize = 64;
const MAX_LIGATURES: usize = 16_384;
const MAX_LIGATURE_PARTS: usize = 16;
const MAX_COMPONENTS: usize = 32;
const MAX_TYPE1_TOKENS: usize = 16_384;
const MAX_TYPE1_SCAN: usize = 1 << 20;
const MAX_AGL_COMPONENTS: usize = 32;
const POST_STANDARD_NAMES: usize = 258;
const SFNT_TRUETYPE: u32 = 0x0001_0000;
const SFNT_OPENTYPE: u32 = 0x4F54_544F;
const SFNT_TRUE: u32 = 0x7472_7565;

static POST_STANDARD_GLYPH_NAMES: [&str; POST_STANDARD_NAMES] = [
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
    "ordfeminine",
    "ordmasculine",
    "Omega",
    "ae",
    "oslash",
    "questiondown",
    "exclamdown",
    "logicalnot",
    "radical",
    "florin",
    "approxequal",
    "Delta",
    "guillemotleft",
    "guillemotright",
    "ellipsis",
    "nonbreakingspace",
    "Agrave",
    "Atilde",
    "Otilde",
    "OE",
    "oe",
    "endash",
    "emdash",
    "quotedblleft",
    "quotedblright",
    "quoteleft",
    "quoteright",
    "divide",
    "lozenge",
    "ydieresis",
    "Ydieresis",
    "fraction",
    "currency",
    "guilsinglleft",
    "guilsinglright",
    "fi",
    "fl",
    "daggerdbl",
    "periodcentered",
    "quotesinglbase",
    "quotedblbase",
    "perthousand",
    "Acircumflex",
    "Ecircumflex",
    "Aacute",
    "Edieresis",
    "Egrave",
    "Iacute",
    "Icircumflex",
    "Idieresis",
    "Igrave",
    "Oacute",
    "Ocircumflex",
    "apple",
    "Ograve",
    "Uacute",
    "Ucircumflex",
    "Ugrave",
    "dotlessi",
    "circumflex",
    "tilde",
    "macron",
    "breve",
    "dotaccent",
    "ring",
    "cedilla",
    "hungarumlaut",
    "ogonek",
    "caron",
    "Lslash",
    "lslash",
    "Scaron",
    "scaron",
    "Zcaron",
    "zcaron",
    "brokenbar",
    "Eth",
    "eth",
    "Yacute",
    "yacute",
    "Thorn",
    "thorn",
    "minus",
    "multiply",
    "onesuperior",
    "twosuperior",
    "threesuperior",
    "onehalf",
    "onequarter",
    "threequarters",
    "franc",
    "Gbreve",
    "gbreve",
    "Idotaccent",
    "Scedilla",
    "scedilla",
    "Cacute",
    "cacute",
    "Ccaron",
    "ccaron",
    "dcroat",
];

#[derive(Clone, Copy)]
struct CmapSubtable {
    platform: u16,
    encoding: u16,
    offset: usize,
    format: u16,
}

#[derive(Clone, Copy, Default)]
struct TrueTypeOutlines {
    glyf: usize,
    glyf_end: usize,
    loca: usize,
    loca_end: usize,
    long_offsets: bool,
    units_per_em: u16,
    hmtx: usize,
    hmtx_end: usize,
    h_metrics: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GlyphMetrics {
    pub units_per_em: u16,
    pub advance: u16,
    pub x_min: i16,
    pub y_min: i16,
    pub x_max: i16,
    pub y_max: i16,
}

enum Outlines {
    None,
    TrueType(TrueTypeOutlines),
    Cff(Box<CffFont>),
    Type1(Type1Encoding),
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Type1Encoding {
    standard: bool,
    entries: Vec<(u8, Vec<u8>)>,
}

pub struct FontProgram {
    data: Vec<u8>,
    cmaps: Vec<CmapSubtable>,
    post: Option<(usize, usize)>,
    gsub: Option<(usize, usize)>,
    outlines: Outlines,
    glyph_count: usize,
    names: OnceCell<Vec<Vec<u8>>>,
    name_index: OnceCell<HashMap<Vec<u8>, u16>>,
    reverse: OnceCell<HashMap<u16, u32>>,
    codes: OnceCell<HashMap<u16, u32>>,
    ligatures: OnceCell<HashMap<u16, Vec<u16>>>,
}

pub fn parse_font_program(bytes: Vec<u8>) -> Option<FontProgram> {
    if bytes.len() < 4 {
        return None;
    }
    let head = read_u32(&bytes, 0)?;
    let mut program = FontProgram {
        data: Vec::new(),
        cmaps: Vec::new(),
        post: None,
        gsub: None,
        outlines: Outlines::None,
        glyph_count: 0,
        names: OnceCell::new(),
        name_index: OnceCell::new(),
        reverse: OnceCell::new(),
        codes: OnceCell::new(),
        ligatures: OnceCell::new(),
    };
    match head {
        SFNT_TRUETYPE | SFNT_OPENTYPE | SFNT_TRUE => parse_sfnt(&bytes, &mut program)?,
        _ if bytes.first() == Some(&1) && bytes.get(1) == Some(&0) => {
            let cff = CffFont::parse(&bytes)?;
            program.glyph_count = cff.glyph_count();
            program.outlines = Outlines::Cff(Box::new(cff));
        }
        _ => {
            let encoding = parse_type1_encoding(&bytes)?;
            program.outlines = Outlines::Type1(encoding);
        }
    }
    program.data = bytes;
    Some(program)
}

fn parse_sfnt(bytes: &[u8], program: &mut FontProgram) -> Option<()> {
    let table_count = usize::from(read_u16(bytes, 4)?);
    if table_count == 0 || table_count > MAX_TABLES {
        return None;
    }
    let mut cmap = None;
    let mut head = None;
    let mut maxp = None;
    let mut loca = None;
    let mut glyf = None;
    let mut cff = None;
    let mut hhea = None;
    let mut hmtx = None;
    for index in 0..table_count {
        let base = 12usize.checked_add(index.checked_mul(16)?)?;
        let tag = [
            *bytes.get(base)?,
            *bytes.get(base + 1)?,
            *bytes.get(base + 2)?,
            *bytes.get(base + 3)?,
        ];
        let offset = usize::try_from(read_u32(bytes, base.checked_add(8)?)?).ok()?;
        let length = usize::try_from(read_u32(bytes, base.checked_add(12)?)?).ok()?;
        let end = offset.checked_add(length)?;
        if end > bytes.len() || length == 0 {
            continue;
        }
        let range = Some((offset, end));
        match &tag {
            b"cmap" => cmap = range,
            b"head" => head = range,
            b"maxp" => maxp = range,
            b"loca" => loca = range,
            b"glyf" => glyf = range,
            b"post" => program.post = range,
            b"GSUB" => program.gsub = range,
            b"CFF " => cff = range,
            b"hhea" => hhea = range,
            b"hmtx" => hmtx = range,
            _ => {}
        }
    }
    if let Some((offset, _)) = maxp {
        program.glyph_count = usize::from(read_u16(bytes, offset.checked_add(4)?)?);
    }
    if let Some((offset, end)) = cmap {
        read_cmap_directory(bytes, offset, end, program);
    }
    if let Some((offset, end)) = cff {
        let cff = CffFont::parse(bytes.get(offset..end)?)?;
        program.glyph_count = program.glyph_count.max(cff.glyph_count());
        program.outlines = Outlines::Cff(Box::new(cff));
    } else if let (Some((loca, loca_end)), Some((glyf, glyf_end)), Some((head, _))) =
        (loca, glyf, head)
    {
        let (hmtx, hmtx_end) = hmtx.unwrap_or_default();
        let h_metrics = hhea
            .and_then(|(offset, _)| read_u16(bytes, offset.checked_add(34)?))
            .map_or(0, usize::from);
        program.outlines = Outlines::TrueType(TrueTypeOutlines {
            glyf,
            glyf_end,
            loca,
            loca_end,
            long_offsets: read_u16(bytes, head.checked_add(50)?)? != 0,
            units_per_em: read_u16(bytes, head.checked_add(18)?).unwrap_or(0),
            hmtx,
            hmtx_end,
            h_metrics,
        });
    }
    Some(())
}

fn read_cmap_directory(bytes: &[u8], offset: usize, end: usize, program: &mut FontProgram) {
    let count = read_u16(bytes, offset.saturating_add(2)).map_or(0, usize::from);
    for index in 0..count.min(MAX_SUBTABLES) {
        let head = offset.saturating_add(4 + index * 8);
        let (Some(platform), Some(encoding), Some(relative)) = (
            read_u16(bytes, head),
            read_u16(bytes, head.saturating_add(2)),
            read_u32(bytes, head.saturating_add(4)),
        ) else {
            return;
        };
        let Some(sub) = usize::try_from(relative)
            .ok()
            .and_then(|relative| offset.checked_add(relative))
        else {
            continue;
        };
        if sub >= end.min(bytes.len()) {
            continue;
        }
        let Some(format) = read_u16(bytes, sub) else {
            continue;
        };
        if matches!(format, 0 | 4 | 6 | 12) {
            program.cmaps.push(CmapSubtable {
                platform,
                encoding,
                offset: sub,
                format,
            });
        }
    }
}

impl FontProgram {
    pub fn glyph_count(&self) -> usize {
        self.glyph_count
    }

    pub fn has_authoritative_names(&self) -> bool {
        matches!(&self.outlines, Outlines::Cff(_) | Outlines::Type1(_))
    }

    pub fn is_cid_keyed(&self) -> bool {
        matches!(&self.outlines, Outlines::Cff(cff) if cff.is_cid_keyed())
    }

    pub fn cid_to_gid(&self, cid: u32) -> Option<u16> {
        let cid = u16::try_from(cid).ok()?;
        match &self.outlines {
            Outlines::Cff(cff) => cff.gid_for_cid(cid),
            _ => Some(cid),
        }
    }

    pub fn gid_to_cid(&self, gid: u16) -> Option<u32> {
        match &self.outlines {
            Outlines::Cff(cff) => cff.cid_for_gid(gid).map(u32::from),
            _ => Some(u32::from(gid)),
        }
    }

    pub fn code_for_gid(&self, gid: u16) -> Option<u32> {
        self.codes
            .get_or_init(|| {
                let mut map = HashMap::new();
                for (platform, encoding) in [(3u16, 0u16), (1, 0), (3, 1)] {
                    for sub in self
                        .cmaps
                        .iter()
                        .filter(|sub| sub.platform == platform && sub.encoding == encoding)
                    {
                        cmap_for_each(&self.data, sub, &mut |code, gid| {
                            let code = if platform == 3 && encoding == 0 && code >= 0xF000 {
                                code & 0xFF
                            } else {
                                code
                            };
                            map.entry(gid).or_insert(code);
                        });
                    }
                }
                map
            })
            .get(&gid)
            .copied()
    }

    pub fn builtin_name(&self, code: u8) -> Option<&[u8]> {
        match &self.outlines {
            Outlines::Cff(cff) if !cff.is_cid_keyed() => cff.builtin_name(code),
            Outlines::Type1(encoding) => encoding.name(code),
            _ => None,
        }
    }

    pub fn code_to_gid(&self, code: u32, symbolic: bool) -> Option<u16> {
        let lookup = |platform: u16, encoding: u16, query: u32| {
            self.cmaps
                .iter()
                .filter(|sub| sub.platform == platform && sub.encoding == encoding)
                .find_map(|sub| cmap_lookup(&self.data, sub, query))
        };
        if symbolic {
            for base in [0u32, 0xF000, 0xF100, 0xF200] {
                if let Some(gid) = lookup(3, 0, base | code) {
                    return Some(gid);
                }
            }
            if let Some(gid) = lookup(1, 0, code) {
                return Some(gid);
            }
        }
        if let Some(gid) = lookup(3, 1, code).or_else(|| lookup(0, 3, code)) {
            return Some(gid);
        }
        if symbolic { None } else { lookup(1, 0, code) }
    }

    pub fn glyph_name(&self, gid: u16) -> Option<&[u8]> {
        if let Outlines::Cff(cff) = &self.outlines {
            return cff.glyph_name(gid);
        }
        self.post_names()
            .get(usize::from(gid))
            .map(Vec::as_slice)
            .filter(|name| !name.is_empty())
    }

    pub fn gid_for_name(&self, name: &[u8]) -> Option<u16> {
        let index = self.name_index.get_or_init(|| {
            let mut map = HashMap::new();
            for gid in 0..self.glyph_count.min(MAX_GLYPHS) {
                let Ok(gid) = u16::try_from(gid) else { break };
                if let Some(glyph) = self.glyph_name(gid) {
                    map.entry(glyph.to_vec()).or_insert(gid);
                }
            }
            map
        });
        index.get(name).copied()
    }

    pub fn gid_text(&self, gid: u16) -> Option<Vec<u32>> {
        if let Some(text) = self.glyph_name(gid).and_then(agl_components) {
            return Some(text);
        }
        self.reverse_cmap()
            .get(&gid)
            .map(|code| vec![*code])
            .filter(|text| text.iter().all(|cp| *cp != 0))
    }

    pub fn gid_parts(&self, gid: u16) -> Option<Vec<u16>> {
        if let Some(parts) = self.ligature_map().get(&gid) {
            return Some(parts.clone());
        }
        self.composite_parts(gid)
    }

    pub fn glyph_metrics(&self, gid: u16) -> Option<GlyphMetrics> {
        let Outlines::TrueType(outlines) = &self.outlines else {
            return None;
        };
        if outlines.units_per_em == 0 || outlines.h_metrics == 0 {
            return None;
        }
        let (start, end) = glyph_range(&self.data, outlines, gid)?;
        let glyph = self.data.get(start..end)?;
        let entry = usize::from(gid).min(outlines.h_metrics - 1);
        let position = outlines.hmtx.checked_add(entry.checked_mul(4)?)?;
        if position.checked_add(2)? > outlines.hmtx_end {
            return None;
        }
        Some(GlyphMetrics {
            units_per_em: outlines.units_per_em,
            advance: read_u16(&self.data, position)?,
            x_min: read_u16(glyph, 2)? as i16,
            y_min: read_u16(glyph, 4)? as i16,
            x_max: read_u16(glyph, 6)? as i16,
            y_max: read_u16(glyph, 8)? as i16,
        })
    }

    fn post_names(&self) -> &[Vec<u8>] {
        self.names.get_or_init(|| self.read_post_names())
    }

    fn read_post_names(&self) -> Vec<Vec<u8>> {
        let Some((start, end)) = self.post else {
            return Vec::new();
        };
        let Some(table) = self.data.get(start..end) else {
            return Vec::new();
        };
        match read_u32(table, 0) {
            Some(0x0001_0000) => POST_STANDARD_GLYPH_NAMES
                .iter()
                .map(|name| name.as_bytes().to_vec())
                .collect(),
            Some(0x0002_0000) => {
                let count = read_u16(table, 32).map_or(0, usize::from).min(MAX_GLYPHS);
                let mut strings: Vec<&[u8]> = Vec::new();
                let mut position = 34usize.saturating_add(count.saturating_mul(2));
                while let Some(length) = table.get(position).map(|len| usize::from(*len)) {
                    let Some(text) = table.get(position + 1..position + 1 + length) else {
                        break;
                    };
                    strings.push(text);
                    position += 1 + length;
                    if strings.len() > MAX_GLYPHS {
                        break;
                    }
                }
                (0..count)
                    .map(|gid| {
                        let index = read_u16(table, 34 + gid * 2).map_or(0, usize::from);
                        let name = match index.checked_sub(POST_STANDARD_NAMES) {
                            None => POST_STANDARD_GLYPH_NAMES
                                .get(index)
                                .map(|name| name.as_bytes()),
                            Some(custom) => strings.get(custom).copied(),
                        };
                        name.map(<[u8]>::to_vec).unwrap_or_default()
                    })
                    .collect()
            }
            _ => Vec::new(),
        }
    }

    fn reverse_cmap(&self) -> &HashMap<u16, u32> {
        self.reverse.get_or_init(|| {
            let mut map = HashMap::new();
            let unicode = [
                (3u16, 10u16),
                (3, 1),
                (0, 4),
                (0, 3),
                (0, 2),
                (0, 1),
                (0, 0),
            ];
            for (platform, encoding) in unicode {
                for sub in self
                    .cmaps
                    .iter()
                    .filter(|sub| sub.platform == platform && sub.encoding == encoding)
                {
                    cmap_for_each(&self.data, sub, &mut |code, gid| {
                        map.entry(gid).or_insert(code);
                    });
                }
            }
            map
        })
    }

    fn ligature_map(&self) -> &HashMap<u16, Vec<u16>> {
        self.ligatures.get_or_init(|| {
            let mut map = HashMap::new();
            if let Some((start, end)) = self.gsub
                && let Some(table) = self.data.get(start..end)
            {
                read_gsub_ligatures(table, &mut map);
            }
            map
        })
    }

    fn composite_parts(&self, gid: u16) -> Option<Vec<u16>> {
        let Outlines::TrueType(outlines) = &self.outlines else {
            return None;
        };
        let (start, end) = glyph_range(&self.data, outlines, gid)?;
        let glyph = self.data.get(start..end)?;
        if (read_u16(glyph, 0)? as i16) >= 0 {
            return None;
        }
        let mut position = 10usize;
        let mut parts: Vec<(i32, u16)> = Vec::new();
        loop {
            let flags = read_u16(glyph, position)?;
            let component = read_u16(glyph, position.checked_add(2)?)?;
            position = position.checked_add(4)?;
            let offset = if flags & 0x0001 != 0 {
                let value = i32::from(read_u16(glyph, position)? as i16);
                position = position.checked_add(4)?;
                value
            } else {
                let value = i32::from(*glyph.get(position)? as i8);
                position = position.checked_add(2)?;
                value
            };
            let offset = if flags & 0x0002 != 0 { offset } else { 0 };
            if flags & 0x0008 != 0 {
                position = position.checked_add(2)?;
            } else if flags & 0x0040 != 0 {
                position = position.checked_add(4)?;
            } else if flags & 0x0080 != 0 {
                position = position.checked_add(8)?;
            }
            parts.push((offset, component));
            if flags & 0x0020 == 0 || parts.len() >= MAX_COMPONENTS {
                break;
            }
        }
        parts.sort_by_key(|(offset, _)| *offset);
        Some(parts.into_iter().map(|(_, component)| component).collect())
    }
}

impl Type1Encoding {
    pub fn name(&self, code: u8) -> Option<&[u8]> {
        if self.standard {
            let name = encoding_glyph_name(BuiltinEncoding::Standard, code);
            return (!name.is_empty()).then_some(name.as_bytes());
        }
        self.entries
            .iter()
            .rev()
            .find(|(slot, _)| *slot == code)
            .map(|(_, name)| name.as_slice())
            .filter(|name| *name != b".notdef")
    }
}

fn glyph_range(data: &[u8], outlines: &TrueTypeOutlines, gid: u16) -> Option<(usize, usize)> {
    let index = usize::from(gid);
    let (first, next) = if outlines.long_offsets {
        let position = outlines.loca.checked_add(index.checked_mul(4)?)?;
        if position.checked_add(8)? > outlines.loca_end {
            return None;
        }
        (
            usize::try_from(read_u32(data, position)?).ok()?,
            usize::try_from(read_u32(data, position + 4)?).ok()?,
        )
    } else {
        let position = outlines.loca.checked_add(index.checked_mul(2)?)?;
        if position.checked_add(4)? > outlines.loca_end {
            return None;
        }
        (
            usize::from(read_u16(data, position)?) * 2,
            usize::from(read_u16(data, position + 2)?) * 2,
        )
    };
    if next <= first {
        return None;
    }
    let start = outlines.glyf.checked_add(first)?;
    let end = outlines.glyf.checked_add(next)?;
    (end <= outlines.glyf_end).then_some((start, end))
}

fn cmap_lookup(data: &[u8], sub: &CmapSubtable, code: u32) -> Option<u16> {
    let offset = sub.offset;
    let gid = match sub.format {
        0 => {
            if code > 255 {
                return None;
            }
            u16::from(*data.get(offset.checked_add(6)?.checked_add(code as usize)?)?)
        }
        4 => {
            let code = u16::try_from(code).ok()?;
            let seg_count = usize::from(read_u16(data, offset.checked_add(6)?)?) / 2;
            let ends = offset.checked_add(14)?;
            let starts = ends.checked_add(seg_count * 2)?.checked_add(2)?;
            let deltas = starts.checked_add(seg_count * 2)?;
            let ranges = deltas.checked_add(seg_count * 2)?;
            let mut low = 0usize;
            let mut high = seg_count;
            while low < high {
                let mid = low + (high - low) / 2;
                if read_u16(data, ends.checked_add(mid * 2)?)? < code {
                    low = mid + 1;
                } else {
                    high = mid;
                }
            }
            if low >= seg_count {
                return None;
            }
            let start = read_u16(data, starts.checked_add(low * 2)?)?;
            if start > code {
                return None;
            }
            let delta = read_u16(data, deltas.checked_add(low * 2)?)?;
            let range = read_u16(data, ranges.checked_add(low * 2)?)?;
            if range == 0 {
                code.wrapping_add(delta)
            } else {
                let position = ranges
                    .checked_add(low * 2)?
                    .checked_add(usize::from(range))?
                    .checked_add(usize::from(code - start) * 2)?;
                let glyph = read_u16(data, position)?;
                if glyph == 0 {
                    return None;
                }
                glyph.wrapping_add(delta)
            }
        }
        6 => {
            let first = u32::from(read_u16(data, offset.checked_add(6)?)?);
            let count = u32::from(read_u16(data, offset.checked_add(8)?)?);
            if code < first || code >= first + count {
                return None;
            }
            read_u16(
                data,
                offset
                    .checked_add(10)?
                    .checked_add(usize::try_from(code - first).ok()? * 2)?,
            )?
        }
        12 => {
            let groups = usize::try_from(read_u32(data, offset.checked_add(12)?)?).ok()?;
            let base = offset.checked_add(16)?;
            let mut low = 0usize;
            let mut high = groups.min(MAX_REVERSE_CODES);
            while low < high {
                let mid = low + (high - low) / 2;
                let group = base.checked_add(mid.checked_mul(12)?)?;
                let start = read_u32(data, group)?;
                let end = read_u32(data, group.checked_add(4)?)?;
                if code < start {
                    high = mid;
                } else if code > end {
                    low = mid + 1;
                } else {
                    let first = read_u32(data, group.checked_add(8)?)?;
                    return u16::try_from(first.checked_add(code - start)?)
                        .ok()
                        .filter(|gid| *gid != 0);
                }
            }
            return None;
        }
        _ => return None,
    };
    (gid != 0).then_some(gid)
}

fn cmap_for_each(data: &[u8], sub: &CmapSubtable, visit: &mut dyn FnMut(u32, u16)) {
    let offset = sub.offset;
    let mut budget = MAX_REVERSE_CODES;
    match sub.format {
        0 => {
            for code in 0..256u32 {
                let Some(gid) = data
                    .get(offset.saturating_add(6).saturating_add(code as usize))
                    .map(|gid| u16::from(*gid))
                else {
                    return;
                };
                if gid != 0 {
                    visit(code, gid);
                }
            }
        }
        4 => {
            let Some(seg_count) =
                read_u16(data, offset.saturating_add(6)).map(|value| usize::from(value) / 2)
            else {
                return;
            };
            let ends = offset.saturating_add(14);
            let starts = ends.saturating_add(seg_count * 2).saturating_add(2);
            let deltas = starts.saturating_add(seg_count * 2);
            let ranges = deltas.saturating_add(seg_count * 2);
            for seg in 0..seg_count {
                let (Some(end), Some(start), Some(delta), Some(range)) = (
                    read_u16(data, ends.saturating_add(seg * 2)),
                    read_u16(data, starts.saturating_add(seg * 2)),
                    read_u16(data, deltas.saturating_add(seg * 2)),
                    read_u16(data, ranges.saturating_add(seg * 2)),
                ) else {
                    return;
                };
                if end < start || start == 0xFFFF {
                    continue;
                }
                for code in start..=end {
                    if budget == 0 {
                        return;
                    }
                    budget -= 1;
                    let gid = if range == 0 {
                        code.wrapping_add(delta)
                    } else {
                        let position = ranges
                            .saturating_add(seg * 2)
                            .saturating_add(usize::from(range))
                            .saturating_add(usize::from(code - start) * 2);
                        match read_u16(data, position) {
                            Some(0) | None => continue,
                            Some(glyph) => glyph.wrapping_add(delta),
                        }
                    };
                    if gid != 0 {
                        visit(u32::from(code), gid);
                    }
                }
            }
        }
        6 => {
            let (Some(first), Some(count)) = (
                read_u16(data, offset.saturating_add(6)),
                read_u16(data, offset.saturating_add(8)),
            ) else {
                return;
            };
            for index in 0..usize::from(count) {
                let Some(gid) = read_u16(data, offset.saturating_add(10 + index * 2)) else {
                    return;
                };
                if gid != 0 {
                    visit(u32::from(first) + index as u32, gid);
                }
            }
        }
        12 => {
            let Some(groups) = read_u32(data, offset.saturating_add(12)) else {
                return;
            };
            for index in 0..usize::try_from(groups).unwrap_or(0).min(MAX_REVERSE_CODES) {
                let base = offset.saturating_add(16 + index * 12);
                let (Some(start), Some(end), Some(first)) = (
                    read_u32(data, base),
                    read_u32(data, base.saturating_add(4)),
                    read_u32(data, base.saturating_add(8)),
                ) else {
                    return;
                };
                if end < start {
                    continue;
                }
                for step in 0..=(end - start) {
                    if budget == 0 {
                        return;
                    }
                    budget -= 1;
                    let Ok(gid) = u16::try_from(first.saturating_add(step)) else {
                        break;
                    };
                    if gid != 0 {
                        visit(start.saturating_add(step), gid);
                    }
                }
            }
        }
        _ => {}
    }
}

fn read_gsub_ligatures(table: &[u8], out: &mut HashMap<u16, Vec<u16>>) {
    let Some(lookup_list) = read_u16(table, 8).map(usize::from) else {
        return;
    };
    let lookup_count = read_u16(table, lookup_list).map_or(0, usize::from);
    for index in 0..lookup_count.min(MAX_LOOKUPS) {
        let Some(lookup) = read_u16(table, lookup_list + 2 + index * 2)
            .map(|offset| lookup_list + usize::from(offset))
        else {
            return;
        };
        let (Some(kind), Some(count)) = (read_u16(table, lookup), read_u16(table, lookup + 4))
        else {
            continue;
        };
        for sub in 0..usize::from(count).min(MAX_LOOKUP_SUBTABLES) {
            let Some(mut subtable) =
                read_u16(table, lookup + 6 + sub * 2).map(|offset| lookup + usize::from(offset))
            else {
                break;
            };
            let mut subtable_kind = kind;
            if kind == 7 {
                let (Some(1), Some(inner), Some(relative)) = (
                    read_u16(table, subtable),
                    read_u16(table, subtable + 2),
                    read_u32(table, subtable + 4),
                ) else {
                    continue;
                };
                let Some(target) = usize::try_from(relative)
                    .ok()
                    .and_then(|relative| subtable.checked_add(relative))
                else {
                    continue;
                };
                subtable = target;
                subtable_kind = inner;
            }
            if subtable_kind == 4 {
                read_ligature_subtable(table, subtable, out);
            }
            if out.len() >= MAX_LIGATURES {
                return;
            }
        }
    }
}

fn read_ligature_subtable(table: &[u8], subtable: usize, out: &mut HashMap<u16, Vec<u16>>) {
    if read_u16(table, subtable) != Some(1) {
        return;
    }
    let (Some(coverage), Some(set_count)) = (
        read_u16(table, subtable + 2).map(|offset| subtable + usize::from(offset)),
        read_u16(table, subtable + 4),
    ) else {
        return;
    };
    let Some(firsts) = read_coverage(table, coverage) else {
        return;
    };
    for (set_index, first) in firsts.iter().enumerate().take(usize::from(set_count)) {
        let Some(set) = read_u16(table, subtable + 6 + set_index * 2)
            .map(|offset| subtable + usize::from(offset))
        else {
            return;
        };
        let count = read_u16(table, set).map_or(0, usize::from);
        for ligature_index in 0..count.min(MAX_LIGATURES) {
            let Some(ligature) = read_u16(table, set + 2 + ligature_index * 2)
                .map(|offset| set + usize::from(offset))
            else {
                break;
            };
            let (Some(glyph), Some(component_count)) =
                (read_u16(table, ligature), read_u16(table, ligature + 2))
            else {
                continue;
            };
            let component_count = usize::from(component_count);
            if !(2..=MAX_LIGATURE_PARTS).contains(&component_count) {
                continue;
            }
            let rest: Option<Vec<u16>> = (0..component_count - 1)
                .map(|index| read_u16(table, ligature + 4 + index * 2))
                .collect();
            if let Some(rest) = rest
                && out.len() < MAX_LIGATURES
            {
                let mut parts = vec![*first];
                parts.extend(rest);
                out.entry(glyph).or_insert(parts);
            }
        }
    }
}

fn read_coverage(table: &[u8], coverage: usize) -> Option<Vec<u16>> {
    match read_u16(table, coverage)? {
        1 => {
            let count = usize::from(read_u16(table, coverage.checked_add(2)?)?);
            (0..count)
                .map(|index| read_u16(table, coverage.checked_add(4 + index * 2)?))
                .collect()
        }
        2 => {
            let ranges = usize::from(read_u16(table, coverage.checked_add(2)?)?);
            let mut glyphs: Vec<u16> = Vec::new();
            for index in 0..ranges {
                let record = coverage.checked_add(4 + index * 6)?;
                let start = read_u16(table, record)?;
                let end = read_u16(table, record + 2)?;
                let first_index = usize::from(read_u16(table, record + 4)?);
                if end < start {
                    continue;
                }
                let length = usize::from(end - start) + 1;
                let needed = first_index.checked_add(length)?;
                if needed > MAX_GLYPHS {
                    return None;
                }
                if glyphs.len() < needed {
                    glyphs.resize(needed, 0);
                }
                for step in 0..length {
                    *glyphs.get_mut(first_index + step)? =
                        start.checked_add(u16::try_from(step).ok()?)?;
                }
            }
            Some(glyphs)
        }
        _ => None,
    }
}

fn parse_type1_encoding(bytes: &[u8]) -> Option<Type1Encoding> {
    let window = bytes.get(..bytes.len().min(MAX_TYPE1_SCAN))?;
    if !window.starts_with(b"%!") {
        return None;
    }
    let clear_end = find_subslice(window, b"eexec").unwrap_or(window.len());
    let clear = window.get(..clear_end)?;
    let start = find_subslice(clear, b"/Encoding")?;
    let mut position = start + b"/Encoding".len();
    let mut encoding = Type1Encoding::default();
    let mut depth = 0usize;
    let mut tokens = 0usize;
    let mut pending: Option<u8> = None;
    let mut stage = 0u8;
    while tokens < MAX_TYPE1_TOKENS {
        let Some(token) = next_type1_token(clear, &mut position) else {
            break;
        };
        tokens += 1;
        match token {
            Type1Token::Word(b"StandardEncoding") => {
                encoding.standard = true;
                return Some(encoding);
            }
            Type1Token::Open => depth += 1,
            Type1Token::Close => depth = depth.saturating_sub(1),
            Type1Token::Word(b"dup") if depth == 0 => {
                stage = 1;
                pending = None;
            }
            Type1Token::Word(b"def")
                if depth == 0 && (!encoding.entries.is_empty() || tokens > 4) =>
            {
                break;
            }
            Type1Token::Word(word) if depth == 0 && stage == 1 => {
                pending = parse_type1_int(word).and_then(|value| u8::try_from(value).ok());
                stage = 2;
            }
            Type1Token::Name(name) if depth == 0 && stage == 2 => {
                if let Some(code) = pending.take() {
                    encoding.entries.push((code, name.to_vec()));
                }
                stage = 0;
            }
            _ => {}
        }
    }
    Some(encoding)
}

enum Type1Token<'a> {
    Word(&'a [u8]),
    Name(&'a [u8]),
    Open,
    Close,
}

fn is_type1_delimiter(value: u8) -> bool {
    matches!(
        value,
        b'/' | b'{' | b'}' | b'[' | b']' | b'(' | b')' | b'<' | b'>' | b'%'
    )
}

fn next_type1_token<'a>(bytes: &'a [u8], position: &mut usize) -> Option<Type1Token<'a>> {
    loop {
        let byte = *bytes.get(*position)?;
        if byte == b'%' {
            while let Some(next) = bytes.get(*position) {
                *position += 1;
                if matches!(next, b'\n' | b'\r') {
                    break;
                }
            }
        } else if byte.is_ascii_whitespace() || byte == 0 {
            *position += 1;
        } else {
            break;
        }
    }
    let byte = *bytes.get(*position)?;
    match byte {
        b'{' | b'[' => {
            *position += 1;
            Some(Type1Token::Open)
        }
        b'}' | b']' => {
            *position += 1;
            Some(Type1Token::Close)
        }
        b'/' => {
            let start = *position + 1;
            let mut end = start;
            while let Some(next) = bytes.get(end) {
                if next.is_ascii_whitespace() || is_type1_delimiter(*next) {
                    break;
                }
                end += 1;
            }
            *position = end;
            bytes.get(start..end).map(Type1Token::Name)
        }
        _ => {
            let start = *position;
            let mut end = start + 1;
            while let Some(next) = bytes.get(end) {
                if next.is_ascii_whitespace() || is_type1_delimiter(*next) {
                    break;
                }
                end += 1;
            }
            *position = end;
            bytes.get(start..end).map(Type1Token::Word)
        }
    }
}

fn parse_type1_int(word: &[u8]) -> Option<u32> {
    let text = core::str::from_utf8(word).ok()?;
    match text.split_once('#') {
        Some((radix, digits)) => u32::from_str_radix(digits, radix.parse().ok()?).ok(),
        None => text.parse().ok(),
    }
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

pub fn agl_components(name: &[u8]) -> Option<Vec<u32>> {
    let text = core::str::from_utf8(name).ok()?;
    if let Some(found) = lookup_agl(name) {
        return Some(found.to_vec());
    }
    let base = text.split('.').next().unwrap_or_default();
    if base.is_empty() {
        return None;
    }
    let mut out = Vec::new();
    for (index, part) in base.split('_').enumerate() {
        if index >= MAX_AGL_COMPONENTS {
            return None;
        }
        agl_component(part, &mut out)?;
    }
    (!out.is_empty()).then_some(out)
}

fn agl_component(part: &str, out: &mut Vec<u32>) -> Option<()> {
    if let Some(found) = lookup_agl(part.as_bytes()) {
        out.extend_from_slice(found);
        return Some(());
    }
    if let Some(digits) = part.strip_prefix("uni")
        && digits.len() >= 4
        && digits.len() % 4 == 0
        && digits.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        for chunk in digits.as_bytes().chunks(4) {
            let value = u32::from_str_radix(core::str::from_utf8(chunk).ok()?, 16).ok()?;
            if (0xD800..=0xDFFF).contains(&value) {
                return None;
            }
            out.push(value);
        }
        return Some(());
    }
    if let Some(digits) = part.strip_prefix('u')
        && (4..=6).contains(&digits.len())
        && digits.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        let value = u32::from_str_radix(digits, 16).ok()?;
        if value <= 0x10_FFFF && !(0xD800..=0xDFFF).contains(&value) {
            out.push(value);
            return Some(());
        }
    }
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
    let bytes = resolver.stream_data(&stream)?;
    if bytes.len() > limits.max_decoded_stream_bytes {
        return Err(Failure::limit("font program exceeds limit"));
    }
    Ok(bytes)
}

fn read_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    let high = u16::from(*bytes.get(offset)?);
    let low = u16::from(*bytes.get(offset.checked_add(1)?)?);
    Some((high << 8) | low)
}

fn read_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    let high = u32::from(read_u16(bytes, offset)?);
    let low = u32::from(read_u16(bytes, offset.checked_add(2)?)?);
    Some((high << 16) | low)
}

#[cfg(test)]
#[allow(clippy::indexing_slicing, clippy::expect_used)]
pub(crate) mod tests {
    use super::*;
    use crate::cff::tests::{Layout, build as build_cff};

    fn be16(value: u16) -> Vec<u8> {
        value.to_be_bytes().to_vec()
    }

    fn be32(value: u32) -> Vec<u8> {
        value.to_be_bytes().to_vec()
    }

    fn sfnt(version: u32, tables: &[(&[u8; 4], Vec<u8>)]) -> Vec<u8> {
        let mut out = be32(version);
        out.extend(be16(tables.len() as u16));
        out.extend([0u8; 6]);
        let mut offset = 12 + tables.len() * 16;
        let mut bodies = Vec::new();
        for (tag, body) in tables {
            out.extend_from_slice(*tag);
            out.extend(be32(0));
            out.extend(be32(offset as u32));
            out.extend(be32(body.len() as u32));
            bodies.extend_from_slice(body);
            let padded = (body.len() + 3) & !3;
            bodies.resize(bodies.len() + padded - body.len(), 0);
            offset += padded;
        }
        out.extend(bodies);
        out
    }

    fn cmap_table(subtables: &[(u16, u16, Vec<u8>)]) -> Vec<u8> {
        let mut out = be16(0);
        out.extend(be16(subtables.len() as u16));
        let mut offset = 4 + subtables.len() * 8;
        for (platform, encoding, body) in subtables {
            out.extend(be16(*platform));
            out.extend(be16(*encoding));
            out.extend(be32(offset as u32));
            offset += body.len();
        }
        for (_, _, body) in subtables {
            out.extend_from_slice(body);
        }
        out
    }

    fn format4(segments: &[(u16, u16, u16)]) -> Vec<u8> {
        let count = segments.len() + 1;
        let mut out = be16(4);
        out.extend(be16((16 + count * 8) as u16));
        out.extend(be16(0));
        out.extend(be16((count * 2) as u16));
        out.extend([0u8; 6]);
        for (_, end, _) in segments {
            out.extend(be16(*end));
        }
        out.extend(be16(0xFFFF));
        out.extend(be16(0));
        for (start, _, _) in segments {
            out.extend(be16(*start));
        }
        out.extend(be16(0xFFFF));
        for (start, _, gid) in segments {
            out.extend(be16(gid.wrapping_sub(*start)));
        }
        out.extend(be16(1));
        for _ in 0..count {
            out.extend(be16(0));
        }
        out
    }

    fn format0(map: &[(u8, u8)]) -> Vec<u8> {
        let mut glyphs = [0u8; 256];
        for (code, gid) in map {
            glyphs[usize::from(*code)] = *gid;
        }
        let mut out = be16(0);
        out.extend(be16(262));
        out.extend(be16(0));
        out.extend(glyphs);
        out
    }

    fn format6(first: u16, glyphs: &[u16]) -> Vec<u8> {
        let mut out = be16(6);
        out.extend(be16((10 + glyphs.len() * 2) as u16));
        out.extend(be16(0));
        out.extend(be16(first));
        out.extend(be16(glyphs.len() as u16));
        for glyph in glyphs {
            out.extend(be16(*glyph));
        }
        out
    }

    fn format12(groups: &[(u32, u32, u32)]) -> Vec<u8> {
        let mut out = be16(12);
        out.extend(be16(0));
        out.extend(be32((16 + groups.len() * 12) as u32));
        out.extend(be32(0));
        out.extend(be32(groups.len() as u32));
        for (start, end, gid) in groups {
            out.extend(be32(*start));
            out.extend(be32(*end));
            out.extend(be32(*gid));
        }
        out
    }

    fn post2(names: &[&str]) -> Vec<u8> {
        let mut out = be32(0x0002_0000);
        out.extend([0u8; 28]);
        out.extend(be16(names.len() as u16));
        let mut strings = Vec::new();
        let mut custom = 0u16;
        for name in names {
            if let Some(index) = POST_STANDARD_GLYPH_NAMES.iter().position(|std| std == name) {
                out.extend(be16(index as u16));
            } else {
                out.extend(be16(258 + custom));
                custom += 1;
                strings.push(name.len() as u8);
                strings.extend_from_slice(name.as_bytes());
            }
        }
        out.extend(strings);
        out
    }

    fn maxp(glyphs: u16) -> Vec<u8> {
        let mut out = be32(0x0001_0000);
        out.extend(be16(glyphs));
        out.extend([0u8; 26]);
        out
    }

    fn head(long_loca: bool) -> Vec<u8> {
        let mut out = vec![0u8; 54];
        out[51] = u8::from(long_loca);
        out
    }

    pub(crate) fn ligature_gsub(
        extension: bool,
        first: u16,
        rest: &[u16],
        ligature: u16,
    ) -> Vec<u8> {
        let mut coverage = be16(1);
        coverage.extend(be16(1));
        coverage.extend(be16(first));
        let mut lig = be16(ligature);
        lig.extend(be16(rest.len() as u16 + 1));
        for component in rest {
            lig.extend(be16(*component));
        }
        let mut set = be16(1);
        set.extend(be16(4));
        set.extend(&lig);
        let mut sub = be16(1);
        sub.extend(be16((8 + set.len()) as u16));
        sub.extend(be16(1));
        sub.extend(be16(8));
        sub.extend(&set);
        sub.extend(&coverage);
        let mut kind = 4u16;
        if extension {
            let mut wrapped = be16(1);
            wrapped.extend(be16(4));
            wrapped.extend(be32(8));
            wrapped.extend(&sub);
            sub = wrapped;
            kind = 7;
        }
        let mut lookup = be16(kind);
        lookup.extend(be16(0));
        lookup.extend(be16(1));
        lookup.extend(be16(8));
        lookup.extend(&sub);
        let mut list = be16(1);
        list.extend(be16(4));
        list.extend(&lookup);
        let mut out = be32(0x0001_0000);
        out.extend(be16(0));
        out.extend(be16(0));
        out.extend(be16(10));
        out.extend(&list);
        out
    }

    fn simple_glyph(contours: i16) -> Vec<u8> {
        let mut out = be16(contours as u16);
        out.extend([0u8; 12]);
        out
    }

    fn composite_glyph(parts: &[(u16, i16)], words: bool) -> Vec<u8> {
        let mut out = be16(0xFFFF);
        out.extend([0u8; 8]);
        for (index, (component, dx)) in parts.iter().enumerate() {
            let mut flags = 0x0002u16;
            if words {
                flags |= 0x0001;
            }
            if index + 1 < parts.len() {
                flags |= 0x0020;
            }
            out.extend(be16(flags));
            out.extend(be16(*component));
            if words {
                out.extend(be16(*dx as u16));
                out.extend(be16(0));
            } else {
                out.push(*dx as i8 as u8);
                out.push(0);
            }
        }
        out
    }

    fn glyf_and_loca(glyphs: &[Vec<u8>]) -> (Vec<u8>, Vec<u8>) {
        let mut glyf = Vec::new();
        let mut loca = be32(0);
        for glyph in glyphs {
            glyf.extend_from_slice(glyph);
            while glyf.len() % 4 != 0 {
                glyf.push(0);
            }
            loca.extend(be32(glyf.len() as u32));
        }
        (glyf, loca)
    }

    #[test]
    fn post_names_cover_standard_table() {
        assert_eq!(POST_STANDARD_GLYPH_NAMES.len(), 258);
        assert_eq!(POST_STANDARD_GLYPH_NAMES[3], "space");
        assert_eq!(POST_STANDARD_GLYPH_NAMES[36], "A");
        assert_eq!(POST_STANDARD_GLYPH_NAMES[68], "a");
        assert_eq!(POST_STANDARD_GLYPH_NAMES[98], "Adieresis");
        assert_eq!(POST_STANDARD_GLYPH_NAMES[137], "germandbls");
        assert_eq!(POST_STANDARD_GLYPH_NAMES[192], "fi");
        assert_eq!(POST_STANDARD_GLYPH_NAMES[193], "fl");
        assert_eq!(POST_STANDARD_GLYPH_NAMES[257], "dcroat");
    }

    #[test]
    fn cmap_formats_resolve_codes() {
        let font = sfnt(
            SFNT_TRUETYPE,
            &[
                (
                    b"cmap",
                    cmap_table(&[
                        (3, 1, format4(&[(0x41, 0x43, 1)])),
                        (1, 0, format0(&[(0x61, 9)])),
                        (0, 3, format6(0x30, &[20, 21, 22])),
                        (3, 10, format12(&[(0x1F600, 0x1F601, 30)])),
                    ]),
                ),
                (b"maxp", maxp(40)),
            ],
        );
        let program = parse_font_program(font).expect("program");
        assert_eq!(program.code_to_gid(0x41, false), Some(1));
        assert_eq!(program.code_to_gid(0x43, false), Some(3));
        assert_eq!(program.code_to_gid(0x44, false), None);
        assert_eq!(program.code_to_gid(0x61, false), Some(9));
        assert_eq!(program.glyph_count(), 40);
        assert_eq!(program.gid_text(2), Some(vec![0x42]));
        assert_eq!(program.gid_text(31), Some(vec![0x1F601]));
        let sub6 = program
            .cmaps
            .iter()
            .find(|sub| sub.format == 6)
            .expect("fmt6");
        assert_eq!(cmap_lookup(&program.data, sub6, 0x31), Some(21));
        assert_eq!(cmap_lookup(&program.data, sub6, 0x33), None);
        let sub12 = program
            .cmaps
            .iter()
            .find(|sub| sub.format == 12)
            .expect("fmt12");
        assert_eq!(cmap_lookup(&program.data, sub12, 0x1F601), Some(31));
        assert_eq!(cmap_lookup(&program.data, sub12, 0x1F602), None);
        assert_eq!(cmap_lookup(&program.data, sub12, 0x10), None);
    }

    #[test]
    fn cmap_format4_range_offsets() {
        let mut table = be16(4);
        table.extend(be16(0));
        table.extend(be16(0));
        table.extend(be16(4));
        table.extend([0u8; 6]);
        table.extend(be16(0x42));
        table.extend(be16(0xFFFF));
        table.extend(be16(0));
        table.extend(be16(0x41));
        table.extend(be16(0xFFFF));
        table.extend(be16(0));
        table.extend(be16(1));
        table.extend(be16(4));
        table.extend(be16(0));
        table.extend(be16(7));
        table.extend(be16(8));
        let font = sfnt(
            SFNT_TRUETYPE,
            &[(b"cmap", cmap_table(&[(3, 1, table)])), (b"maxp", maxp(10))],
        );
        let program = parse_font_program(font).expect("program");
        assert_eq!(program.code_to_gid(0x41, false), Some(7));
        assert_eq!(program.code_to_gid(0x42, false), Some(8));
        assert_eq!(program.gid_text(8), Some(vec![0x42]));
    }

    #[test]
    fn symbolic_cmap_30_uses_private_offset() {
        let font = sfnt(
            SFNT_TRUETYPE,
            &[
                (
                    b"cmap",
                    cmap_table(&[(3, 0, format4(&[(0xF020, 0xF022, 1)]))]),
                ),
                (b"maxp", maxp(8)),
            ],
        );
        let program = parse_font_program(font).expect("program");
        assert_eq!(program.code_to_gid(0x20, true), Some(1));
        assert_eq!(program.code_to_gid(0x21, true), Some(2));
        assert_eq!(program.code_to_gid(0x30, true), None);
        assert_eq!(program.code_to_gid(0xF021, true), Some(2));
        let mac = sfnt(
            SFNT_TRUETYPE,
            &[
                (b"cmap", cmap_table(&[(1, 0, format0(&[(0x8E, 5)]))])),
                (b"maxp", maxp(8)),
            ],
        );
        let program = parse_font_program(mac).expect("mac");
        assert_eq!(program.code_to_gid(0x8E, true), Some(5));
        assert_eq!(program.code_to_gid(0x8E, false), Some(5));
        assert_eq!(program.gid_text(5), None);
    }

    #[test]
    fn post_format2_names_recover_ligature() {
        let font = sfnt(
            SFNT_TRUETYPE,
            &[
                (
                    b"post",
                    post2(&[".notdef", "space", "t_i", "f_f_i", "uni00E9", "u1F600"]),
                ),
                (b"maxp", maxp(6)),
            ],
        );
        let program = parse_font_program(font).expect("program");
        assert_eq!(program.glyph_name(2), Some(b"t_i".as_slice()));
        assert_eq!(program.gid_text(2), Some(vec![0x74, 0x69]));
        assert_eq!(program.gid_text(3), Some(vec![0x66, 0x66, 0x69]));
        assert_eq!(program.gid_text(4), Some(vec![0xE9]));
        assert_eq!(program.gid_text(5), Some(vec![0x1F600]));
        assert_eq!(program.gid_for_name(b"t_i"), Some(2));
        assert_eq!(program.gid_text(0), None);
    }

    #[test]
    fn post_format1_uses_standard_order() {
        let mut post = be32(0x0001_0000);
        post.extend([0u8; 28]);
        let font = sfnt(SFNT_TRUETYPE, &[(b"post", post), (b"maxp", maxp(258))]);
        let program = parse_font_program(font).expect("program");
        assert_eq!(program.glyph_name(36), Some(b"A".as_slice()));
        assert_eq!(program.gid_text(192), Some(vec![0xFB01]));
    }

    #[test]
    fn post_format3_has_no_names() {
        let mut post = be32(0x0003_0000);
        post.extend([0u8; 28]);
        let font = sfnt(SFNT_TRUETYPE, &[(b"post", post), (b"maxp", maxp(8))]);
        let program = parse_font_program(font).expect("program");
        assert_eq!(program.glyph_name(3), None);
        assert_eq!(program.gid_text(3), None);
    }

    #[test]
    fn gsub_ligature_lookup_and_extension_recover_components() {
        for extension in [false, true] {
            let font = sfnt(
                SFNT_TRUETYPE,
                &[
                    (b"GSUB", ligature_gsub(extension, 5, &[6], 9)),
                    (b"maxp", maxp(12)),
                    (
                        b"cmap",
                        cmap_table(&[(3, 1, format4(&[(0x69, 0x69, 6), (0x74, 0x74, 5)]))]),
                    ),
                ],
            );
            let program = parse_font_program(font).expect("program");
            assert_eq!(
                program.gid_parts(9),
                Some(vec![5, 6]),
                "extension={extension}"
            );
            assert_eq!(program.gid_text(5), Some(vec![0x74]));
            assert_eq!(program.gid_text(6), Some(vec![0x69]));
            assert_eq!(program.gid_parts(5), None);
        }
    }

    #[test]
    fn composite_glyph_parts_sorted_by_offset() {
        for words in [false, true] {
            let glyphs = vec![
                simple_glyph(0),
                simple_glyph(1),
                simple_glyph(2),
                composite_glyph(&[(2, 60), (1, 0)], words),
            ];
            let (glyf, loca) = glyf_and_loca(&glyphs);
            let font = sfnt(
                SFNT_TRUETYPE,
                &[
                    (b"head", head(true)),
                    (b"maxp", maxp(4)),
                    (b"loca", loca),
                    (b"glyf", glyf),
                ],
            );
            let program = parse_font_program(font).expect("program");
            assert_eq!(program.gid_parts(3), Some(vec![1, 2]));
            assert_eq!(program.gid_parts(1), None);
            assert_eq!(program.gid_parts(99), None);
        }
    }

    #[test]
    fn short_loca_composites() {
        let glyphs = vec![
            simple_glyph(0),
            simple_glyph(1),
            composite_glyph(&[(1, 0), (0, 10)], false),
        ];
        let (glyf, loca_long) = glyf_and_loca(&glyphs);
        let mut loca = Vec::new();
        for chunk in loca_long.chunks(4) {
            let value = u32::from_be_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
            loca.extend(be16((value / 2) as u16));
        }
        let font = sfnt(
            SFNT_TRUETYPE,
            &[
                (b"head", head(false)),
                (b"maxp", maxp(3)),
                (b"loca", loca),
                (b"glyf", glyf),
            ],
        );
        let program = parse_font_program(font).expect("program");
        assert_eq!(program.gid_parts(2), Some(vec![1, 0]));
    }

    #[test]
    fn opentype_cff_names_and_cid_mapping() {
        let mut charset = vec![0u8];
        charset.extend(be16(66));
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
        let font = sfnt(SFNT_OPENTYPE, &[(b"CFF ", cff), (b"maxp", maxp(3))]);
        let program = parse_font_program(font).expect("program");
        assert_eq!(program.glyph_name(1), Some(b"a".as_slice()));
        assert_eq!(program.gid_text(1), Some(vec![0x61]));
        assert_eq!(program.gid_text(2), Some(vec![0x74, 0x69]));
        assert_eq!(program.builtin_name(0x61), Some(b"a".as_slice()));
        assert!(!program.is_cid_keyed());
        assert_eq!(program.cid_to_gid(2), Some(2));
    }

    #[test]
    fn raw_cff_cid_keyed_and_builtin_encoding() {
        let mut charset = vec![0u8];
        charset.extend(be16(700));
        charset.extend(be16(701));
        let cff = build_cff(&Layout {
            names: vec![],
            charset,
            charset_id: 0,
            encoding: vec![],
            encoding_id: 0,
            cid_keyed: true,
            glyphs: 3,
        });
        let program = parse_font_program(cff).expect("cid cff");
        assert!(program.is_cid_keyed());
        assert_eq!(program.cid_to_gid(700), Some(1));
        assert_eq!(program.cid_to_gid(701), Some(2));
        assert_eq!(program.cid_to_gid(5), None);
        assert_eq!(program.builtin_name(0x41), None);
        let mut charset = vec![0u8];
        charset.extend(be16(66));
        let cff = build_cff(&Layout {
            names: vec![],
            charset,
            charset_id: 0,
            encoding: vec![0, 1, 0x7A],
            encoding_id: 0,
            cid_keyed: false,
            glyphs: 2,
        });
        let program = parse_font_program(cff).expect("name cff");
        assert_eq!(program.builtin_name(0x7A), Some(b"a".as_slice()));
        assert_eq!(program.builtin_name(0x41), None);
        assert_eq!(program.gid_text(1), Some(vec![0x61]));
    }

    #[test]
    fn type1_cleartext_custom_encoding() {
        let font = b"%!PS-AdobeFont-1.0: Test 1.0\n/FontName /Test def\n/Encoding 256 array\n0 1 255 {1 index exch /.notdef put} for\ndup 65 /A put\ndup 8#102 /Bsmall put\ndup 16#43/fi put\nreadonly def\ncurrentfile eexec \x01\x02\x03";
        let program = parse_font_program(font.to_vec()).expect("type1");
        assert_eq!(program.builtin_name(65), Some(b"A".as_slice()));
        assert_eq!(program.builtin_name(66), Some(b"Bsmall".as_slice()));
        assert_eq!(program.builtin_name(67), Some(b"fi".as_slice()));
        assert_eq!(program.builtin_name(68), None);
    }

    #[test]
    fn type1_standard_encoding() {
        let font = b"%!PS-AdobeFont-1.0: Test\n/Encoding StandardEncoding def\ncurrentfile eexec";
        let program = parse_font_program(font.to_vec()).expect("type1");
        assert_eq!(program.builtin_name(0x41), Some(b"A".as_slice()));
        assert_eq!(program.builtin_name(0x01), None);
    }

    #[test]
    fn type1_without_encoding_is_rejected() {
        assert!(parse_font_program(b"%!PS-AdobeFont-1.0\n/FontName /X def\n".to_vec()).is_none());
        assert!(parse_font_program(b"not a font program".to_vec()).is_none());
    }

    #[test]
    fn agl_name_forms() {
        assert_eq!(agl_components(b"t_i"), Some(vec![0x74, 0x69]));
        assert_eq!(agl_components(b"f_f_i"), Some(vec![0x66, 0x66, 0x69]));
        assert_eq!(agl_components(b"a.sc"), Some(vec![0x61]));
        assert_eq!(agl_components(b"uni00410042"), Some(vec![0x41, 0x42]));
        assert_eq!(agl_components(b"uni004"), None);
        assert_eq!(agl_components(b"uniD800"), None);
        assert_eq!(agl_components(b"u1F600"), Some(vec![0x1F600]));
        assert_eq!(agl_components(b"g1234"), None);
        assert_eq!(agl_components(b"fi"), Some(vec![0xFB01]));
        assert_eq!(agl_components(b""), None);
        assert_eq!(agl_components(b".notdef"), None);
        assert_eq!(agl_components(b"t_unknownglyph"), None);
    }

    #[test]
    fn rejects_unknown_and_truncated_programs() {
        assert!(parse_font_program(Vec::new()).is_none());
        assert!(parse_font_program(vec![0, 1, 0, 0]).is_none());
        assert!(parse_font_program(vec![0xFF; 64]).is_none());
    }

    fn valid_corpus() -> Vec<Vec<u8>> {
        let glyphs = vec![
            simple_glyph(0),
            simple_glyph(1),
            composite_glyph(&[(1, 0), (0, 10)], false),
        ];
        let (glyf, loca) = glyf_and_loca(&glyphs);
        let truetype = sfnt(
            SFNT_TRUETYPE,
            &[
                (
                    b"cmap",
                    cmap_table(&[
                        (3, 1, format4(&[(0x41, 0x43, 1)])),
                        (1, 0, format0(&[(0x61, 2)])),
                        (3, 10, format12(&[(0x41, 0x43, 1)])),
                        (0, 3, format6(0x30, &[1, 2])),
                    ]),
                ),
                (b"post", post2(&[".notdef", "t_i", "A"])),
                (b"GSUB", ligature_gsub(true, 1, &[2], 2)),
                (b"head", head(true)),
                (b"maxp", maxp(3)),
                (b"loca", loca),
                (b"glyf", glyf),
            ],
        );
        let mut charset = vec![0u8];
        charset.extend(be16(66));
        charset.extend(be16(391));
        let cff = build_cff(&Layout {
            names: vec!["t_i"],
            charset,
            charset_id: 0,
            encoding: vec![0, 1, 0x61],
            encoding_id: 0,
            cid_keyed: false,
            glyphs: 3,
        });
        let type1 = b"%!PS-AdobeFont-1.0\n/Encoding 256 array\ndup 65 /A put\nreadonly def\ncurrentfile eexec".to_vec();
        vec![truetype, cff, type1]
    }

    fn exercise(program: &FontProgram) {
        for gid in [0u16, 1, 2, 3, 9, 100, 65535] {
            let _ = program.gid_text(gid);
            let _ = program.gid_parts(gid);
            let _ = program.glyph_name(gid);
        }
        for code in [0u32, 0x41, 0x61, 0xF041, 0xFFFF, 0x1F600] {
            let _ = program.code_to_gid(code, true);
            let _ = program.code_to_gid(code, false);
        }
        for cid in [0u32, 1, 700, 70000] {
            let _ = program.cid_to_gid(cid);
        }
        let _ = program.gid_for_name(b"t_i");
        for code in 0..=255u8 {
            let _ = program.builtin_name(code);
        }
    }

    #[test]
    fn mutated_programs_never_panic() {
        for valid in valid_corpus() {
            if let Some(program) = parse_font_program(valid.clone()) {
                exercise(&program);
            }
            for cut in 0..valid.len() {
                if let Some(program) = parse_font_program(valid[..cut].to_vec()) {
                    exercise(&program);
                }
            }
            for position in 0..valid.len() {
                for value in [0u8, 0x01, 0x7F, 0x80, 0xFF] {
                    let mut data = valid.clone();
                    data[position] = value;
                    if let Some(program) = parse_font_program(data) {
                        exercise(&program);
                    }
                }
            }
        }
    }

    #[test]
    fn random_bytes_never_panic() {
        let mut seed = 0x5165_3729u32;
        for round in 0..1024usize {
            let len = 16 + round % 300;
            let mut data = vec![0u8; len];
            for slot in data.iter_mut() {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                *slot = (seed >> 24) as u8;
            }
            match round % 4 {
                0 => data[..4].copy_from_slice(&[0, 1, 0, 0]),
                1 => data[..4].copy_from_slice(b"OTTO"),
                2 => data[..2].copy_from_slice(&[1, 0]),
                _ => data[..2].copy_from_slice(b"%!"),
            }
            if let Some(program) = parse_font_program(data) {
                exercise(&program);
            }
        }
    }
}
