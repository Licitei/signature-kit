use crate::num::{read_u16, read_u32, sort_total};
use crate::object::Dict;
use crate::object::Object;
use crate::object::Resolver;
use crate::object::Stream;
use core::cell::OnceCell;
use signature_kit_font::cmap::{Subtable, for_each, lookup as lookup_cmap, read_cmap_directory};
use signature_kit_font::sfnt::tables;
use std::collections::HashMap;

use crate::cff::CffFont;
use crate::display::PathData;
use crate::failure::Failure;
use crate::font_tables::{BuiltinEncoding, encoding_glyph_name, lookup_agl};
use crate::glyph::{Type1Glyphs, parse_type1, truetype_outline};
use crate::inspection::Limits;

const MAX_TABLES: usize = 128;
const MAX_GLYPHS: usize = 0xFFFF;
const MAX_LOOKUPS: usize = 128;
const MAX_LOOKUP_SUBTABLES: usize = 64;
const MAX_LIGATURES: usize = 0x4000;
const MAX_LIGATURE_PARTS: usize = 16;
const MAX_COMPONENTS: usize = 32;
const MAX_TYPE1_TOKENS: usize = 0x4000;
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

pub(crate) const SFNT_DIRECTORY_LEN: usize = 12 + 16 * MAX_TABLES;

#[derive(Clone, Copy, Default)]
struct TrueTypeOutlines {
    glyf: usize,
    glyf_end: usize,
    h_metrics: usize,
    hmtx: usize,
    hmtx_end: usize,
    loca: usize,
    loca_end: usize,
    long_offsets: bool,
    units_per_em: u16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct GlyphMetrics {
    pub advance: u16,
    pub units_per_em: u16,
    pub x_max: i16,
    pub x_min: i16,
    pub y_max: i16,
    pub y_min: i16,
}

enum Outlines {
    Cff(Box<CffFont>),
    None,
    TrueType(TrueTypeOutlines),
    Type1(Type1Encoding),
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Type1Encoding {
    entries: Vec<(u8, Vec<u8>)>,
    standard: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct FontStyle {
    pub bold: bool,
    pub italic: bool,
}

pub(crate) struct FontProgram {
    cff_start: usize,
    cmaps: Vec<Subtable>,
    codes: OnceCell<HashMap<u16, u32>>,
    data: Vec<u8>,
    glyph_count: usize,
    gsub: Option<(usize, usize)>,
    ligatures: OnceCell<HashMap<u16, Vec<u16>>>,
    name_index: OnceCell<HashMap<Vec<u8>, u16>>,
    names: OnceCell<Vec<Vec<u8>>>,
    outlines: Outlines,
    post: Option<(usize, usize)>,
    reverse: OnceCell<HashMap<u16, u32>>,
    style: FontStyle,
    type1: OnceCell<Option<Type1Glyphs>>,
}

type TableRange = Option<(usize, usize)>;

impl FontProgram {
    pub(crate) fn builtin_name(&self, code: u8) -> Option<&[u8]> {
        match &self.outlines {
            Outlines::Cff(cff) if !cff.is_cid_keyed() => cff.builtin_name(code),
            Outlines::Type1(encoding) => encoding.name(code),
            Outlines::Cff(_) | Outlines::None | Outlines::TrueType(_) => None,
        }
    }

    pub(crate) fn cid_to_gid(&self, cid: u32) -> Option<u16> {
        let cid_u16 = u16::try_from(cid).ok()?;
        match &self.outlines {
            Outlines::Cff(cff) => cff.gid_for_cid(cid_u16),
            Outlines::None | Outlines::TrueType(_) | Outlines::Type1(_) => Some(cid_u16),
        }
    }

    pub(crate) fn code_for_gid(&self, gid: u16) -> Option<u32> {
        self.codes
            .get_or_init(|| {
                let mut map = HashMap::new();
                for (platform, encoding) in [(3_u16, 0_u16), (1, 0), (3, 1)] {
                    for sub in self
                        .cmaps
                        .iter()
                        .filter(|sub| sub.platform == platform && sub.encoding == encoding)
                    {
                        for_each(&self.data, *sub, &mut |code, glyph| {
                            let code_next = if platform == 3 && encoding == 0 && code >= 0xF000 {
                                code & 0xFF
                            } else {
                                code
                            };
                            let _: &mut u32 = map.entry(glyph).or_insert(code_next);
                        });
                    }
                }
                map
            })
            .get(&gid)
            .copied()
    }

    pub(crate) fn code_to_gid(&self, code: u32, symbolic: bool) -> Option<u16> {
        let lookup = |platform: u16, encoding: u16, query: u32| {
            self.cmaps
                .iter()
                .filter(|sub| sub.platform == platform && sub.encoding == encoding)
                .find_map(|sub| lookup_cmap(&self.data, *sub, query))
        };
        if symbolic {
            for base in [0_u32, 0xF000, 0xF100, 0xF200] {
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

    fn composite_parts(&self, gid: u16) -> Option<Vec<u16>> {
        let Outlines::TrueType(outlines) = &self.outlines else {
            return None;
        };
        let (start, end) = glyph_range(&self.data, outlines, gid)?;
        let glyph = self.data.get(start..end)?;
        if ((read_u16(glyph, 0)?).cast_signed()) >= 0 {
            return None;
        }
        let mut position = 10_usize;
        let mut parts: Vec<(i32, usize, u16)> = Vec::new();
        loop {
            let flags = read_u16(glyph, position)?;
            let component = read_u16(glyph, position.checked_add(2)?)?;
            position = position.checked_add(4)?;
            let offset = if flags & 0x0001 != 0 {
                let value = i32::from((read_u16(glyph, position)?).cast_signed());
                position = position.checked_add(4)?;
                value
            } else {
                let value = i32::from((*glyph.get(position)?).cast_signed());
                position = position.checked_add(2)?;
                value
            };
            let offset_next = if flags & 0x0002 != 0 { offset } else { 0_i32 };
            if flags & 0x0008 != 0 {
                position = position.checked_add(2)?;
            } else if flags & 0x0040 != 0 {
                position = position.checked_add(4)?;
            } else if flags & 0x0080 != 0 {
                position = position.checked_add(8)?;
            }
            parts.push((offset_next, parts.len(), component));
            if flags & 0x0020 == 0 || parts.len() >= MAX_COMPONENTS {
                break;
            }
        }
        sort_total(&mut parts, &Ord::cmp);
        Some(
            parts
                .into_iter()
                .map(|(_, _, component)| component)
                .collect(),
        )
    }

    pub(crate) fn font_matrix(&self, gid: u16) -> [f64; 6] {
        match &self.outlines {
            Outlines::Cff(cff) => cff.font_matrix(gid),
            Outlines::TrueType(outlines) => {
                let scale = 1.0 / f64::from(outlines.units_per_em.max(16));
                [scale, 0.0, 0.0, scale, 0.0, 0.0]
            }
            Outlines::Type1(_) => self
                .type1_glyphs()
                .and_then(Type1Glyphs::matrix)
                .unwrap_or([0.001, 0.0, 0.0, 0.001, 0.0, 0.0]),
            Outlines::None => [0.001, 0.0, 0.0, 0.001, 0.0, 0.0],
        }
    }

    pub(crate) fn gid_for_name(&self, name: &[u8]) -> Option<u16> {
        let index = self.name_index.get_or_init(|| {
            let mut map = HashMap::new();
            for gid in 0..self.glyph_count.min(MAX_GLYPHS) {
                let Ok(gid_u16) = u16::try_from(gid) else {
                    break;
                };
                if let Some(glyph) = self.glyph_name(gid_u16) {
                    let _: &mut u16 = map.entry(glyph.to_vec()).or_insert(gid_u16);
                }
            }
            map
        });
        index.get(name).copied()
    }

    pub(crate) fn gid_parts(&self, gid: u16) -> Option<Vec<u16>> {
        if let Some(parts) = self.ligature_map().get(&gid) {
            return Some(parts.clone());
        }
        self.composite_parts(gid)
    }

    pub(crate) fn gid_text(&self, gid: u16) -> Option<Vec<u32>> {
        if let Some(text) = self.glyph_name(gid).and_then(agl_components) {
            return Some(text);
        }
        self.reverse_cmap()
            .get(&gid)
            .map(|code| vec![*code])
            .filter(|text| text.iter().all(|cp| *cp != 0))
    }

    pub(crate) fn gid_to_cid(&self, gid: u16) -> Option<u32> {
        match &self.outlines {
            Outlines::Cff(cff) => cff.cid_for_gid(gid).map(u32::from),
            Outlines::None | Outlines::TrueType(_) | Outlines::Type1(_) => Some(u32::from(gid)),
        }
    }

    #[cfg(test)]
    pub(crate) const fn glyph_count(&self) -> usize {
        self.glyph_count
    }

    pub(crate) fn glyph_metrics(&self, gid: u16) -> Option<GlyphMetrics> {
        let Outlines::TrueType(outlines) = &self.outlines else {
            return None;
        };
        if outlines.units_per_em == 0 || outlines.h_metrics == 0 {
            return None;
        }
        let (start, end) = glyph_range(&self.data, outlines, gid)?;
        let glyph = self.data.get(start..end)?;
        let entry = usize::from(gid).min(outlines.h_metrics.saturating_sub(1));
        let position = outlines.hmtx.checked_add(entry.checked_mul(4)?)?;
        if position.checked_add(2)? > outlines.hmtx_end {
            return None;
        }
        Some(GlyphMetrics {
            units_per_em: outlines.units_per_em,
            advance: read_u16(&self.data, position)?,
            x_min: (read_u16(glyph, 2)?).cast_signed(),
            y_min: (read_u16(glyph, 4)?).cast_signed(),
            x_max: (read_u16(glyph, 6)?).cast_signed(),
            y_max: (read_u16(glyph, 8)?).cast_signed(),
        })
    }

    pub(crate) fn glyph_name(&self, gid: u16) -> Option<&[u8]> {
        if let Outlines::Cff(cff) = &self.outlines {
            return cff.glyph_name(gid);
        }
        self.post_names()
            .get(usize::from(gid))
            .map(Vec::as_slice)
            .filter(|name| !name.is_empty())
    }

    pub(crate) const fn has_authoritative_names(&self) -> bool {
        matches!(&self.outlines, Outlines::Cff(_) | Outlines::Type1(_))
    }

    pub(crate) const fn has_cmaps(&self) -> bool {
        !self.cmaps.is_empty()
    }

    pub(crate) fn is_cid_keyed(&self) -> bool {
        matches!(&self.outlines, Outlines::Cff(cff) if cff.is_cid_keyed())
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

    pub(crate) fn outline(&self, gid: u16, path: &mut PathData, work: &mut usize) -> Option<()> {
        match &self.outlines {
            Outlines::TrueType(outlines) => {
                let locate = |glyph: u16| glyph_range(&self.data, outlines, glyph);
                truetype_outline(&self.data, &locate, gid, path, work)
            }
            Outlines::Cff(cff) => cff.outline(self.data.get(self.cff_start..)?, gid, path, work),
            Outlines::Type1(_) => self.type1_glyphs()?.outline(gid, path, work),
            Outlines::None => None,
        }
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
                let mut position = 34_usize.saturating_add(count.saturating_mul(2));
                while let Some(length) = table.get(position).map(|len| usize::from(*len)) {
                    let Some(text) = table.get(
                        position.saturating_add(1)
                            ..(position.saturating_add(1)).saturating_add(length),
                    ) else {
                        break;
                    };
                    strings.push(text);
                    position = position.saturating_add(length.saturating_add(1));
                    if strings.len() > MAX_GLYPHS {
                        break;
                    }
                }
                (0..count)
                    .map(|gid| {
                        let index = read_u16(table, (gid.saturating_mul(2)).saturating_add(34))
                            .map_or(0, usize::from);
                        let name = index.checked_sub(POST_STANDARD_NAMES).map_or_else(
                            || {
                                POST_STANDARD_GLYPH_NAMES
                                    .get(index)
                                    .map(|name| name.as_bytes())
                            },
                            |custom| strings.get(custom).copied(),
                        );
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
                (3_u16, 10_u16),
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
                    for_each(&self.data, *sub, &mut |code, gid| {
                        let _: &mut u32 = map.entry(gid).or_insert(code);
                    });
                }
            }
            map
        })
    }

    pub(crate) const fn style(&self) -> FontStyle {
        self.style
    }

    pub(crate) fn type1_gid(&self, name: &[u8]) -> Option<u16> {
        self.type1_glyphs()?.gid(name)
    }

    fn type1_glyphs(&self) -> Option<&Type1Glyphs> {
        if !matches!(self.outlines, Outlines::Type1(_)) {
            return None;
        }
        self.type1.get_or_init(|| parse_type1(&self.data)).as_ref()
    }
}

impl Type1Encoding {
    pub(crate) fn name(&self, code: u8) -> Option<&[u8]> {
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

enum Type1Token<'data> {
    Close,
    Name(&'data [u8]),
    Open,
    Word(&'data [u8]),
}

pub(crate) fn parse_font_program(bytes: Vec<u8>) -> Option<FontProgram> {
    if bytes.len() < 4 {
        return None;
    }
    let head = read_u32(&bytes, 0)?;
    let mut program = FontProgram {
        cff_start: 0,
        data: Vec::new(),
        style: FontStyle::default(),
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
        type1: OnceCell::new(),
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
    let mut cmap = None;
    let mut head = None;
    let mut maxp = None;
    let mut loca = None;
    let mut glyf = None;
    let mut cff = None;
    let mut hhea = None;
    let mut hmtx = None;
    let mut os2 = None;
    for (tag, offset, end) in tables(bytes)? {
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
            b"OS/2" => os2 = range,
            _ => {}
        }
    }
    program.style = sfnt_style(bytes, head, os2);
    if let Some((offset, _)) = maxp {
        program.glyph_count = usize::from(read_u16(bytes, offset.checked_add(4)?)?);
    }
    if let Some((offset, end)) = cmap {
        program.cmaps = read_cmap_directory(bytes, offset, end);
    }
    if let Some((offset, end)) = cff {
        let font = CffFont::parse(bytes.get(offset..end)?)?;
        program.cff_start = offset;
        program.glyph_count = program.glyph_count.max(font.glyph_count());
        program.outlines = Outlines::Cff(Box::new(font));
    } else if let (
        Some((inner_loca, loca_end)),
        Some((inner_glyf, glyf_end)),
        Some((inner_head, _)),
    ) = (loca, glyf, head)
    {
        let (hmtx_next, hmtx_end) = hmtx.unwrap_or_default();
        let h_metrics = hhea
            .and_then(|(offset, _)| read_u16(bytes, offset.checked_add(34)?))
            .map_or(0, usize::from);
        program.outlines = Outlines::TrueType(TrueTypeOutlines {
            glyf: inner_glyf,
            glyf_end,
            loca: inner_loca,
            loca_end,
            long_offsets: read_u16(bytes, inner_head.checked_add(50)?)? != 0,
            units_per_em: read_u16(bytes, inner_head.checked_add(18)?).unwrap_or(0),
            hmtx: hmtx_next,
            hmtx_end,
            h_metrics,
        });
    }
    Some(())
}

pub(crate) fn sfnt_style_of(bytes: &[u8]) -> Option<FontStyle> {
    let (head, os2) = style_tables(bytes)?;
    (head.is_some() || os2.is_some()).then(|| sfnt_style(bytes, head, os2))
}

pub(crate) fn sfnt_style_extent(bytes: &[u8]) -> Option<usize> {
    let (head, os2) = style_tables(bytes)?;
    let head_end = head.and_then(|(offset, _)| offset.checked_add(46));
    let os2_end = os2.and_then(|(offset, _)| offset.checked_add(64));
    Some(head_end.unwrap_or(0).max(os2_end.unwrap_or(0)))
}

fn style_tables(bytes: &[u8]) -> Option<(TableRange, TableRange)> {
    let head = read_u32(bytes, 0)?;
    if !matches!(head, SFNT_TRUETYPE | SFNT_OPENTYPE | SFNT_TRUE) {
        return None;
    }
    let table_count = usize::from(read_u16(bytes, 4)?).min(MAX_TABLES);
    let mut found = (None, None);
    for index in 0..table_count {
        let base = 12_usize.checked_add(index.checked_mul(16)?)?;
        let tag = bytes.get(base..base.checked_add(4)?)?;
        let offset = usize::try_from(read_u32(bytes, base.checked_add(8)?)?).ok()?;
        let length = usize::try_from(read_u32(bytes, base.checked_add(12)?)?).ok()?;
        let range = Some((offset, offset.checked_add(length)?));
        match tag {
            b"head" => found.0 = range,
            b"OS/2" => found.1 = range,
            _ => {}
        }
    }
    Some(found)
}

fn sfnt_style(
    bytes: &[u8],
    head: Option<(usize, usize)>,
    os2: Option<(usize, usize)>,
) -> FontStyle {
    let weight = os2.and_then(|(offset, _)| read_u16(bytes, offset.checked_add(4)?));
    let selection = os2.and_then(|(offset, _)| read_u16(bytes, offset.checked_add(62)?));
    if let (Some(inner_weight), Some(inner_selection)) = (weight, selection) {
        return FontStyle {
            bold: inner_selection & 0x20 != 0 || inner_weight >= 600,
            italic: inner_selection & 0x201 != 0,
        };
    }
    let mac_style = head
        .and_then(|(offset, _)| read_u16(bytes, offset.checked_add(44)?))
        .unwrap_or(0);
    FontStyle {
        bold: mac_style & 1 != 0,
        italic: mac_style & 2 != 0,
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
            usize::try_from(read_u32(data, position.saturating_add(4))?).ok()?,
        )
    } else {
        let position = outlines.loca.checked_add(index.checked_mul(2)?)?;
        if position.checked_add(4)? > outlines.loca_end {
            return None;
        }
        (
            usize::from(read_u16(data, position)?) * 2,
            usize::from(read_u16(data, position.saturating_add(2))?) * 2,
        )
    };
    if next <= first {
        return None;
    }
    let start = outlines.glyf.checked_add(first)?;
    let end = outlines.glyf.checked_add(next)?;
    (end <= outlines.glyf_end).then_some((start, end))
}

fn read_gsub_ligatures(table: &[u8], out: &mut HashMap<u16, Vec<u16>>) {
    let Some(lookup_list) = read_u16(table, 8).map(usize::from) else {
        return;
    };
    let lookup_count = read_u16(table, lookup_list).map_or(0, usize::from);
    for index in 0..lookup_count.min(MAX_LOOKUPS) {
        let Some(lookup) = relative_offset(
            table,
            lookup_list,
            (lookup_list.saturating_add(2)).saturating_add(index.saturating_mul(2)),
        ) else {
            return;
        };
        let (Some(kind), Some(count)) = (
            read_u16(table, lookup),
            read_u16(table, lookup.saturating_add(4)),
        ) else {
            continue;
        };
        for sub in 0..usize::from(count).min(MAX_LOOKUP_SUBTABLES) {
            let Some(mut subtable) = relative_offset(
                table,
                lookup,
                (lookup.saturating_add(6)).saturating_add(sub.saturating_mul(2)),
            ) else {
                break;
            };
            let subtable_kind = if kind == 7 {
                let (Some(1), Some(inner), Some(relative)) = (
                    read_u16(table, subtable),
                    read_u16(table, subtable.saturating_add(2)),
                    read_u32(table, subtable.saturating_add(4)),
                ) else {
                    continue;
                };
                let Some(target) = usize::try_from(relative)
                    .ok()
                    .and_then(|inner_relative| subtable.checked_add(inner_relative))
                else {
                    continue;
                };
                subtable = target;
                inner
            } else {
                kind
            };
            if subtable_kind == 4 {
                read_ligature_subtable(table, subtable, out);
            }
            if out.len() >= MAX_LIGATURES {
                return;
            }
        }
    }
}

fn relative_offset(table: &[u8], base: usize, slot: usize) -> Option<usize> {
    read_u16(table, slot).map(|offset| base.saturating_add(usize::from(offset)))
}

fn read_ligature_subtable(table: &[u8], subtable: usize, out: &mut HashMap<u16, Vec<u16>>) {
    if read_u16(table, subtable) != Some(1) {
        return;
    }
    let (Some(coverage), Some(set_count)) = (
        relative_offset(table, subtable, subtable.saturating_add(2)),
        read_u16(table, subtable.saturating_add(4)),
    ) else {
        return;
    };
    let Some(firsts) = read_coverage(table, coverage) else {
        return;
    };
    for (set_index, first) in firsts.iter().enumerate().take(usize::from(set_count)) {
        let Some(set) = relative_offset(
            table,
            subtable,
            (subtable.saturating_add(6)).saturating_add(set_index.saturating_mul(2)),
        ) else {
            return;
        };
        let count = read_u16(table, set).map_or(0, usize::from);
        for ligature_index in 0..count.min(MAX_LIGATURES) {
            let Some(ligature) = relative_offset(
                table,
                set,
                (set.saturating_add(2)).saturating_add(ligature_index.saturating_mul(2)),
            ) else {
                break;
            };
            let (Some(glyph), Some(component_count)) = (
                read_u16(table, ligature),
                read_u16(table, ligature.saturating_add(2)),
            ) else {
                continue;
            };
            let component_count_usize = usize::from(component_count);
            if !(2..=MAX_LIGATURE_PARTS).contains(&component_count_usize) {
                continue;
            }
            let rest: Option<Vec<u16>> = (0..component_count_usize.saturating_sub(1))
                .map(|index| {
                    read_u16(
                        table,
                        (ligature.saturating_add(4)).saturating_add(index.saturating_mul(2)),
                    )
                })
                .collect();
            if let Some(inner_rest) = rest
                && out.len() < MAX_LIGATURES
            {
                let mut parts = vec![*first];
                parts.extend(inner_rest);
                let _: &mut Vec<u16> = out.entry(glyph).or_insert(parts);
            }
        }
    }
}

fn read_coverage(table: &[u8], coverage: usize) -> Option<Vec<u16>> {
    match read_u16(table, coverage)? {
        1 => {
            let count = usize::from(read_u16(table, coverage.checked_add(2)?)?);
            (0..count)
                .map(|index| {
                    read_u16(
                        table,
                        coverage.checked_add((index.saturating_mul(2)).saturating_add(4))?,
                    )
                })
                .collect()
        }
        2 => {
            let ranges = usize::from(read_u16(table, coverage.checked_add(2)?)?);
            let mut glyphs: Vec<u16> = Vec::new();
            for index in 0..ranges {
                let record = coverage.checked_add((index.saturating_mul(6)).saturating_add(4))?;
                let start = read_u16(table, record)?;
                let end = read_u16(table, record.saturating_add(2))?;
                let first_index = usize::from(read_u16(table, record.saturating_add(4))?);
                if end < start {
                    continue;
                }
                let length = usize::from(end.saturating_sub(start)) + 1;
                let needed = first_index.checked_add(length)?;
                if needed > MAX_GLYPHS {
                    return None;
                }
                if glyphs.len() < needed {
                    glyphs.resize(needed, 0);
                }
                for step in 0..length {
                    *glyphs.get_mut(first_index.saturating_add(step))? =
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
    let mut position = start.saturating_add(b"/Encoding".len());
    let mut encoding = Type1Encoding::default();
    let mut depth = 0_usize;
    let mut tokens = 0_usize;
    let mut pending: Option<u8> = None;
    let mut stage = 0_u8;
    while tokens < MAX_TYPE1_TOKENS {
        let Some(token) = next_type1_token(clear, &mut position) else {
            break;
        };
        tokens = tokens.saturating_add(1);
        match token {
            Type1Token::Word(b"StandardEncoding") => {
                encoding.standard = true;
                return Some(encoding);
            }
            Type1Token::Open => depth = depth.saturating_add(1),
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
            Type1Token::Word(_) | Type1Token::Name(_) => {}
        }
    }
    Some(encoding)
}

const fn is_type1_delimiter(value: u8) -> bool {
    matches!(
        value,
        b'/' | b'{' | b'}' | b'[' | b']' | b'(' | b')' | b'<' | b'>' | b'%'
    )
}

fn next_type1_token<'data>(bytes: &'data [u8], position: &mut usize) -> Option<Type1Token<'data>> {
    loop {
        let byte = *bytes.get(*position)?;
        if byte == b'%' {
            while let Some(next) = bytes.get(*position) {
                *position = (*position).saturating_add(1);
                if matches!(next, b'\n' | b'\r') {
                    break;
                }
            }
        } else if byte.is_ascii_whitespace() || byte == 0 {
            *position = (*position).saturating_add(1);
        } else {
            break;
        }
    }
    let byte = *bytes.get(*position)?;
    match byte {
        b'{' | b'[' => {
            *position = (*position).saturating_add(1);
            Some(Type1Token::Open)
        }
        b'}' | b']' => {
            *position = (*position).saturating_add(1);
            Some(Type1Token::Close)
        }
        b'/' => {
            let start = (*position).saturating_add(1);
            let mut end = start;
            while let Some(next) = bytes.get(end) {
                if next.is_ascii_whitespace() || is_type1_delimiter(*next) {
                    break;
                }
                end = end.saturating_add(1);
            }
            *position = end;
            bytes.get(start..end).map(Type1Token::Name)
        }
        _ => {
            let start = *position;
            let mut end = start.saturating_add(1);
            while let Some(next) = bytes.get(end) {
                if next.is_ascii_whitespace() || is_type1_delimiter(*next) {
                    break;
                }
                end = end.saturating_add(1);
            }
            *position = end;
            bytes.get(start..end).map(Type1Token::Word)
        }
    }
}

fn parse_type1_int(word: &[u8]) -> Option<u32> {
    let text = str::from_utf8(word).ok()?;
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

pub(crate) fn agl_components(name: &[u8]) -> Option<Vec<u32>> {
    let text = str::from_utf8(name).ok()?;
    if let Some(found) = lookup_agl(name) {
        return Some(found.iter().map(|code| u32::from(*code)).collect());
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
        out.extend(found.iter().map(|code| u32::from(*code)));
        return Some(());
    }
    if let Some(digits) = part.strip_prefix("uni")
        && digits.len() >= 4
        && digits.len().is_multiple_of(4)
        && digits.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        for chunk in digits.as_bytes().chunks(4) {
            let value = u32::from_str_radix(str::from_utf8(chunk).ok()?, 16).ok()?;
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

pub(crate) fn load_font_file_bytes(
    key: &[u8],
    descriptor: &Dict,
    resolver: &dyn Resolver,
    limits: &Limits,
) -> Result<Vec<u8>, Failure> {
    let bytes = font_stream(key, descriptor, resolver, |stream| {
        resolver.stream_data(stream)
    })?;
    if bytes.len() > limits.max_decoded_stream_bytes {
        return Err(Failure::limit("font program exceeds limit"));
    }
    Ok(bytes)
}

pub(crate) fn load_font_file_prefix(
    key: &[u8],
    descriptor: &Dict,
    resolver: &dyn Resolver,
    len: usize,
) -> Result<Vec<u8>, Failure> {
    font_stream(key, descriptor, resolver, |stream| {
        resolver.stream_prefix(stream, len)
    })
}

fn font_stream(
    key: &[u8],
    descriptor: &Dict,
    resolver: &dyn Resolver,
    read: impl FnOnce(&Stream) -> Result<Vec<u8>, Failure>,
) -> Result<Vec<u8>, Failure> {
    let Some(stream_obj) = descriptor.get(key) else {
        return Err(Failure::invalid("missing font program stream"));
    };
    let object = resolver.resolve(stream_obj)?;
    let Object::Stream(stream) = &*object else {
        return Err(Failure::invalid("font program is not a stream"));
    };
    read(stream)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::cff::tests::{Layout, build as build_cff};
    use core::hint::black_box;

    fn be16(value: u16) -> Vec<u8> {
        value.to_be_bytes().to_vec()
    }

    fn be32(value: u32) -> Vec<u8> {
        value.to_be_bytes().to_vec()
    }

    fn sfnt(version: u32, tables: &[(&[u8; 4], Vec<u8>)]) -> Vec<u8> {
        let mut out = be32(version);
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

    fn cmap_table(subtables: &[(u16, u16, Vec<u8>)]) -> Vec<u8> {
        let mut out = be16(0);
        out.extend(be16(u16::try_from(subtables.len()).unwrap()));
        let mut offset = (subtables.len().saturating_mul(8)).saturating_add(4);
        for (platform, encoding, body) in subtables {
            out.extend(be16(*platform));
            out.extend(be16(*encoding));
            out.extend(be32(u32::try_from(offset).unwrap()));
            offset = offset.saturating_add(body.len());
        }
        for (_, _, body) in subtables {
            out.extend_from_slice(body);
        }
        out
    }

    fn format4(segments: &[(u16, u16, u16)]) -> Vec<u8> {
        let count = segments.len().saturating_add(1);
        let mut out = be16(4);
        out.extend(be16(
            u16::try_from((count.saturating_mul(8)).saturating_add(16)).unwrap(),
        ));
        out.extend(be16(0));
        out.extend(be16(u16::try_from(count.saturating_mul(2)).unwrap()));
        out.extend([0_u8; 6]);
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
        let mut glyphs = [0_u8; 256];
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
        out.extend(be16(
            u16::try_from((glyphs.len().saturating_mul(2)).saturating_add(10)).unwrap(),
        ));
        out.extend(be16(0));
        out.extend(be16(first));
        out.extend(be16(u16::try_from(glyphs.len()).unwrap()));
        for glyph in glyphs {
            out.extend(be16(*glyph));
        }
        out
    }

    fn format12(groups: &[(u32, u32, u32)]) -> Vec<u8> {
        let mut out = be16(12);
        out.extend(be16(0));
        out.extend(be32(
            u32::try_from((groups.len().saturating_mul(12)).saturating_add(16)).unwrap(),
        ));
        out.extend(be32(0));
        out.extend(be32(u32::try_from(groups.len()).unwrap()));
        for (start, end, gid) in groups {
            out.extend(be32(*start));
            out.extend(be32(*end));
            out.extend(be32(*gid));
        }
        out
    }

    fn post2(names: &[&str]) -> Vec<u8> {
        let mut out = be32(0x0002_0000);
        out.extend([0_u8; 28]);
        out.extend(be16(u16::try_from(names.len()).unwrap()));
        let mut strings = Vec::new();
        let mut custom = 0_u16;
        for name in names {
            if let Some(index) = POST_STANDARD_GLYPH_NAMES.iter().position(|std| std == name) {
                out.extend(be16(u16::try_from(index).unwrap()));
            } else {
                out.extend(be16(custom.saturating_add(258)));
                custom = custom.saturating_add(1);
                strings.push(u8::try_from(name.len()).unwrap());
                strings.extend_from_slice(name.as_bytes());
            }
        }
        out.extend(strings);
        out
    }

    fn maxp(glyphs: u16) -> Vec<u8> {
        let mut out = be32(0x0001_0000);
        out.extend(be16(glyphs));
        out.extend([0_u8; 26]);
        out
    }

    fn head(long_loca: bool) -> Vec<u8> {
        let mut out = vec![0_u8; 54];
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
        lig.extend(be16((u16::try_from(rest.len()).unwrap()).saturating_add(1)));
        for component in rest {
            lig.extend(be16(*component));
        }
        let mut set = be16(1);
        set.extend(be16(4));
        set.extend(&lig);
        let mut sub = be16(1);
        sub.extend(be16(u16::try_from(set.len().saturating_add(8)).unwrap()));
        sub.extend(be16(1));
        sub.extend(be16(8));
        sub.extend(&set);
        sub.extend(&coverage);
        let kind = if extension {
            let mut wrapped = be16(1);
            wrapped.extend(be16(4));
            wrapped.extend(be32(8));
            wrapped.extend(&sub);
            sub = wrapped;
            7
        } else {
            4_u16
        };
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
        let mut out = be16(contours.cast_unsigned());
        out.extend([0_u8; 12]);
        out
    }

    fn composite_glyph(parts: &[(u16, i16)], words: bool) -> Vec<u8> {
        let mut out = be16(0xFFFF);
        out.extend([0_u8; 8]);
        for (index, (component, dx)) in parts.iter().enumerate() {
            let mut flags = 0x0002_u16;
            if words {
                flags |= 0x0001;
            }
            if index.saturating_add(1) < parts.len() {
                flags |= 0x0020;
            }
            out.extend(be16(flags));
            out.extend(be16(*component));
            if words {
                out.extend(be16((*dx).cast_unsigned()));
                out.extend(be16(0));
            } else {
                out.push(i8::try_from(*dx).unwrap().cast_unsigned());
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
            while !glyf.len().is_multiple_of(4) {
                glyf.push(0);
            }
            loca.extend(be32(u32::try_from(glyf.len()).unwrap()));
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
        assert_eq!(lookup_cmap(&program.data, *sub6, 0x31), Some(21));
        assert_eq!(lookup_cmap(&program.data, *sub6, 0x33), None);
        let sub12 = program
            .cmaps
            .iter()
            .find(|sub| sub.format == 12)
            .expect("fmt12");
        assert_eq!(lookup_cmap(&program.data, *sub12, 0x1F601), Some(31));
        assert_eq!(lookup_cmap(&program.data, *sub12, 0x1F602), None);
        assert_eq!(lookup_cmap(&program.data, *sub12, 0x10), None);
    }

    #[test]
    fn cmap_format4_range_offsets() {
        let mut table = be16(4);
        table.extend(be16(0));
        table.extend(be16(0));
        table.extend(be16(4));
        table.extend([0_u8; 6]);
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
        let program_2 = parse_font_program(mac).expect("mac");
        assert_eq!(program_2.code_to_gid(0x8E, true), Some(5));
        assert_eq!(program_2.code_to_gid(0x8E, false), Some(5));
        assert_eq!(program_2.gid_text(5), None);
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
        post.extend([0_u8; 28]);
        let font = sfnt(SFNT_TRUETYPE, &[(b"post", post), (b"maxp", maxp(258))]);
        let program = parse_font_program(font).expect("program");
        assert_eq!(program.glyph_name(36), Some(b"A".as_slice()));
        assert_eq!(program.gid_text(192), Some(vec![0xFB01]));
    }

    #[test]
    fn post_format3_has_no_names() {
        let mut post = be32(0x0003_0000);
        post.extend([0_u8; 28]);
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
            let value = u32::from_be_bytes(chunk.try_into().unwrap());
            loca.extend(be16(u16::try_from(value >> 1_i32).unwrap()));
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
        let mut charset = vec![0_u8];
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
        let mut charset = vec![0_u8];
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
        let mut charset_2 = vec![0_u8];
        charset_2.extend(be16(66));
        let cff_2 = build_cff(&Layout {
            names: vec![],
            charset: charset_2,
            charset_id: 0,
            encoding: vec![0, 1, 0x7A],
            encoding_id: 0,
            cid_keyed: false,
            glyphs: 2,
        });
        let program_3 = parse_font_program(cff_2).expect("name cff");
        assert_eq!(program_3.builtin_name(0x7A), Some(b"a".as_slice()));
        assert_eq!(program_3.builtin_name(0x41), None);
        assert_eq!(program_3.gid_text(1), Some(vec![0x61]));
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
        let mut charset = vec![0_u8];
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
        for gid in [0_u16, 1, 2, 3, 9, 100, 0xFFFF] {
            drop(black_box(program.gid_text(gid)));
            drop(black_box(program.gid_parts(gid)));
            let _: Option<&[u8]> = black_box(program.glyph_name(gid));
        }
        for code in [0_u32, 0x41, 0x61, 0xF041, 0xFFFF, 0x1F600] {
            let _: Option<u16> = black_box(program.code_to_gid(code, true));
            let _: Option<u16> = black_box(program.code_to_gid(code, false));
        }
        for cid in [0_u32, 1, 700, 70000] {
            let _: Option<u16> = black_box(program.cid_to_gid(cid));
        }
        let _: Option<u16> = black_box(program.gid_for_name(b"t_i"));
        for code in 0..=255_u8 {
            let _: Option<&[u8]> = black_box(program.builtin_name(code));
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
                for value in [0_u8, 0x01, 0x7F, 0x80, 0xFF] {
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
        let mut seed = 0x5165_3729_u32;
        for round in 0..1024_usize {
            let len = 16 + round.rem_euclid(300);
            let mut data = vec![0_u8; len];
            for slot in &mut data {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                *slot = u8::try_from(seed >> 24_i32).unwrap();
            }
            match round & 3 {
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
