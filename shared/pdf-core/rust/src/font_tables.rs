use core::cmp::Ordering;

include!(concat!(env!("OUT_DIR"), "/font_tables.rs"));

const UNDEFINED_WIN_ANSI: [u8; 5] = [0x81, 0x8D, 0x8F, 0x90, 0x9D];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BuiltinEncoding {
    Custom,
    MacExpert,
    MacRoman,
    PdfDoc,
    Standard,
    Symbol,
    WinAnsi,
    ZapfDingbats,
}

impl BuiltinEncoding {
    pub(crate) const COUNT: usize = 7;

    pub(crate) const fn slot(self) -> Option<usize> {
        match self {
            Self::WinAnsi => Some(0),
            Self::Standard => Some(1),
            Self::MacRoman => Some(2),
            Self::MacExpert => Some(3),
            Self::Symbol => Some(4),
            Self::ZapfDingbats => Some(5),
            Self::PdfDoc => Some(6),
            Self::Custom => None,
        }
    }

    const fn table(self) -> Option<&'static [u16; 256]> {
        match self {
            Self::WinAnsi => Some(&ENCODING_WIN_ANSI),
            Self::Standard => Some(&ENCODING_STANDARD),
            Self::MacRoman => Some(&ENCODING_MAC_ROMAN),
            Self::MacExpert => Some(&ENCODING_MAC_EXPERT),
            Self::Symbol => Some(&ENCODING_SYMBOL),
            Self::ZapfDingbats => Some(&ENCODING_ZAPF_DINGBATS),
            Self::PdfDoc => Some(&ENCODING_PDF_DOC),
            Self::Custom => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Standard14Font {
    Courier,
    CourierBold,
    CourierBoldOblique,
    CourierOblique,
    Helvetica,
    HelveticaBold,
    HelveticaBoldOblique,
    HelveticaOblique,
    Symbol,
    TimesBold,
    TimesBoldItalic,
    TimesItalic,
    TimesRoman,
    ZapfDingbats,
}

impl Standard14Font {
    pub(crate) const fn named(name: &[u8]) -> Option<Self> {
        match name {
            b"Courier" => Some(Self::Courier),
            b"Courier-Bold" => Some(Self::CourierBold),
            b"Courier-BoldOblique" => Some(Self::CourierBoldOblique),
            b"Courier-Oblique" => Some(Self::CourierOblique),
            b"Helvetica" => Some(Self::Helvetica),
            b"Helvetica-Bold" => Some(Self::HelveticaBold),
            b"Helvetica-BoldOblique" => Some(Self::HelveticaBoldOblique),
            b"Helvetica-Oblique" => Some(Self::HelveticaOblique),
            b"Times-Bold" => Some(Self::TimesBold),
            b"Times-BoldItalic" => Some(Self::TimesBoldItalic),
            b"Times-Italic" => Some(Self::TimesItalic),
            b"Times-Roman" => Some(Self::TimesRoman),
            _ => None,
        }
    }

    pub(crate) const fn widths(self) -> &'static [u16; 256] {
        match self {
            Self::Courier | Self::CourierBold | Self::CourierBoldOblique | Self::CourierOblique => {
                &STANDARD14_COURIER
            }
            Self::Helvetica | Self::HelveticaOblique => &STANDARD14_HELVETICA,
            Self::HelveticaBold | Self::HelveticaBoldOblique => &STANDARD14_HELVETICA_BOLD,
            Self::Symbol => &STANDARD14_SYMBOL,
            Self::TimesBold => &STANDARD14_TIMES_BOLD,
            Self::TimesBoldItalic => &STANDARD14_TIMES_BOLD_ITALIC,
            Self::TimesItalic => &STANDARD14_TIMES_ITALIC,
            Self::TimesRoman => &STANDARD14_TIMES_ROMAN,
            Self::ZapfDingbats => &STANDARD14_ZAPF_DINGBATS,
        }
    }
}

fn name_at(index: usize) -> Option<&'static str> {
    let end = usize::from(*GLYPH_NAME_ENDS.get(index)?);
    let start = index
        .checked_sub(1)
        .and_then(|previous| GLYPH_NAME_ENDS.get(previous))
        .map_or(0, |start| usize::from(*start));
    GLYPH_NAME_TEXT.get(start..end)
}

fn name_index(name: &str) -> Option<usize> {
    let mut low = 0;
    let mut high = GLYPH_NAME_ENDS.len();
    while low < high {
        let middle = low.midpoint(high);
        match name_at(middle)?.cmp(name) {
            Ordering::Equal => return Some(middle),
            Ordering::Less => low = middle.checked_add(1)?,
            Ordering::Greater => high = middle,
        }
    }
    None
}

pub(crate) fn encoding_glyph_name(encoding: BuiltinEncoding, code: u8) -> &'static str {
    encoding
        .table()
        .and_then(|table| table.get(usize::from(code)))
        .and_then(|index| name_at(usize::from(*index)))
        .unwrap_or_default()
}

pub(crate) fn win_ansi_unicode(code: u8) -> u16 {
    if matches!(code, 0x20..=0x7E | 0xA0..=0xFF) {
        return u16::from(code);
    }
    if !matches!(code, 0x80..=0x9F) || UNDEFINED_WIN_ANSI.contains(&code) {
        return 0;
    }
    lookup_agl(encoding_glyph_name(BuiltinEncoding::WinAnsi, code).as_bytes())
        .and_then(|codepoints| codepoints.first())
        .copied()
        .unwrap_or(0)
}

pub(crate) fn lookup_agl(name: &[u8]) -> Option<&'static [u16]> {
    let index = name_index(str::from_utf8(name).ok()?)?;
    let start = usize::from(*AGL_STARTS.get(index)?);
    let end = usize::from(*AGL_STARTS.get(index.checked_add(1)?)?);
    AGL_CODEPOINTS
        .get(start..end)
        .filter(|codepoints| !codepoints.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glyph_names_are_sorted_and_unique() {
        let names: Vec<_> = (0..GLYPH_NAME_ENDS.len()).filter_map(name_at).collect();
        assert_eq!(names.len(), GLYPH_NAME_ENDS.len());
        assert!(names.windows(2).all(|pair| matches!(pair, [a, b] if a < b)));
    }

    #[test]
    fn agl_lookup_resolves_known_names() {
        assert_eq!(lookup_agl(b"A"), Some(&[0x41_u16][..]));
        assert_eq!(lookup_agl(b"Euro"), Some(&[0x20AC_u16][..]));
        assert_eq!(lookup_agl(b"fi"), Some(&[0xFB01_u16][..]));
        assert_eq!(lookup_agl(b"nonexistentglyph"), None);
        assert_eq!(lookup_agl(&[0xFF, 0xFE]), None);
    }

    #[test]
    fn encodings_resolve_glyph_names() {
        assert_eq!(encoding_glyph_name(BuiltinEncoding::WinAnsi, b'A'), "A");
        assert_eq!(encoding_glyph_name(BuiltinEncoding::WinAnsi, 0x80), "Euro");
        assert_eq!(encoding_glyph_name(BuiltinEncoding::Standard, 0xAE), "fi");
        assert_eq!(encoding_glyph_name(BuiltinEncoding::WinAnsi, 0x00), "");
        assert_eq!(encoding_glyph_name(BuiltinEncoding::Custom, b'A'), "");
    }

    #[test]
    fn standard14_rows_follow_win_ansi_codes() {
        assert_eq!(Standard14Font::Helvetica.widths()[usize::from(b'A')], 667);
        assert_eq!(Standard14Font::TimesRoman.widths()[usize::from(b' ')], 250);
        assert_eq!(Standard14Font::Courier.widths()[usize::from(b'A')], 600);
    }
}


