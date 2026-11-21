use crate::document::{Document, Page, PageRequest, pick_pages};
use crate::failure::{Failure, Outcome};
use crate::inspection::Limits;
use crate::text::{Session, scan_page};

type Rect = [f64; 4];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TextLayer {
    None,
    Usable,
    Weak,
}

#[derive(Debug)]
pub(crate) struct PageDiagnostics {
    pub glyphs: u32,
    pub image_count: u32,
    pub page_index: u32,
    pub text_layer: TextLayer,
    pub unmapped: u32,
    pub usable_chars: u32,
}

pub(crate) struct PageScan {
    crop: Rect,
    filled_curves: u32,
    glyphs: u32,
    image_count: u32,
    largest_image_fraction: f64,
    nonblank: bool,
    unmapped: u32,
    usable_chars: u32,
    visible_chars: u32,
}

impl PageScan {
    pub(crate) const fn filled_curves(&mut self, curves: u32) {
        self.filled_curves = self.filled_curves.saturating_add(curves);
    }

    fn finish(self, index: usize) -> Outcome<PageDiagnostics> {
        let page_index = u32::try_from(index)
            .map_err(|_conversion| Failure::limit("page index exceeds 32-bit limit"))?;
        let text_layer = if !self.nonblank && self.unmapped == 0 {
            TextLayer::None
        } else if self.usable_chars == 0
            || self.unmapped >= self.glyphs.div_ceil(5)
            || self.usable_chars < 128
                && (self.visible_chars == 0
                    || self.largest_image_fraction >= 0.5_f64
                    || self.filled_curves >= 1024)
        {
            TextLayer::Weak
        } else {
            TextLayer::Usable
        };
        Ok(PageDiagnostics {
            page_index,
            text_layer,
            glyphs: self.glyphs,
            usable_chars: self.usable_chars,
            unmapped: self.unmapped,
            image_count: self.image_count,
        })
    }

    pub(crate) fn glyph(
        &mut self,
        extracted: &str,
        actual_text: bool,
        bounds: Option<Rect>,
        invisible: bool,
    ) {
        self.glyphs = self.glyphs.saturating_add(1);
        self.unmapped = self.unmapped.saturating_add(u32::from(
            !actual_text && extracted.is_empty() || extracted.chars().any(unmapped_character),
        ));
        let on_page = bounds.is_some_and(|rect| area(rect, self.crop) > 0.0_f64);
        for ch in extracted.chars() {
            if !ch.is_whitespace() && !unmapped_character(ch) {
                self.nonblank = true;
                self.usable_chars = self.usable_chars.saturating_add(u32::from(on_page));
                self.visible_chars = self
                    .visible_chars
                    .saturating_add(u32::from(on_page && !invisible));
            }
        }
    }

    pub(crate) fn image(&mut self, bounds: Rect, clip: Option<Rect>) {
        let clipped = clip.map_or(bounds, |rect| intersection(bounds, rect));
        let footprint = area(clipped, self.crop);
        if footprint <= 0.0_f64 {
            return;
        }
        self.image_count = self.image_count.saturating_add(1);
        let page_area = area(self.crop, self.crop);
        if page_area > 0.0_f64 {
            self.largest_image_fraction = self.largest_image_fraction.max(footprint / page_area);
        }
    }

    pub(crate) fn missing_font(&mut self, bytes: usize) {
        let count = u32::try_from(bytes).unwrap_or(u32::MAX);
        self.glyphs = self.glyphs.saturating_add(count);
        self.unmapped = self.unmapped.saturating_add(count);
    }

    const fn new(crop: Rect) -> Self {
        Self {
            crop,
            glyphs: 0,
            nonblank: false,
            usable_chars: 0,
            visible_chars: 0,
            unmapped: 0,
            image_count: 0,
            largest_image_fraction: 0.0_f64,
            filled_curves: 0,
        }
    }
}

const fn intersection([x0, y0, x1, y1]: Rect, [a0, b0, a1, b1]: Rect) -> Rect {
    [x0.max(a0), y0.max(b0), x1.min(a1), y1.min(b1)]
}

const fn area(bounds: Rect, crop: Rect) -> f64 {
    let [left, bottom, right, top] = intersection(bounds, crop);
    let coverage = (right - left).max(0.0_f64) * (top - bottom).max(0.0_f64);
    if coverage.is_finite() {
        coverage
    } else {
        0.0_f64
    }
}

fn unmapped_character(ch: char) -> bool {
    ch == char::REPLACEMENT_CHARACTER
        || ch.is_control() && !ch.is_whitespace()
        || matches!(
            u32::from(ch),
            0xe000..=0xf8ff | 0xf0000..=0xffffd | 0x0010_0000..=0x0010_fffd
        )
}

pub(crate) fn document_diagnostics(
    bytes: &[u8],
    selection: PageRequest<&[u32]>,
    limits: &Limits,
) -> Outcome<Vec<PageDiagnostics>> {
    if bytes.len() > limits.max_pdf_bytes {
        return Err(Failure::limit("pdf exceeds size limit"));
    }
    let document = Document::open(bytes, limits)?;
    let pages = document.pages()?;
    let selected = selection.select(pages.len())?;
    opened_diagnostics(&document, &pick_pages(&pages, selected), limits)
}

#[inline(never)]
pub(crate) fn opened_diagnostics(
    document: &Document<'_>,
    selected: &[(usize, &Page)],
    limits: &Limits,
) -> Outcome<Vec<PageDiagnostics>> {
    let mut session = Session::default();
    let mut diagnostics = Vec::with_capacity(selected.len());
    for &(index, page) in selected {
        let mut scan = PageScan::new(page.info.crop_box);
        scan_page(document, page, limits, &mut session, &mut scan)?;
        diagnostics.push(scan.finish(index)?);
    }
    Ok(diagnostics)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_pdf::{document, page, text};

    #[test]
    fn distinguishes_native_text_blank_pages_and_missing_fonts() {
        let bytes = document(
            &[
                page(text(30.0, 700.0, 12.0, "Native text")),
                page(String::new()),
                page("BT /Missing 12 Tf 30 700 Td (Unknown) Tj ET".to_owned()),
            ],
            &[],
        );
        let diagnostics =
            document_diagnostics(&bytes, PageRequest::Indexes(None), &Limits::default()).unwrap();
        assert_eq!(diagnostics[0].text_layer, TextLayer::Usable);
        assert_eq!(diagnostics[0].usable_chars, 10);
        assert_eq!(diagnostics[1].text_layer, TextLayer::None);
        assert_eq!(diagnostics[2].text_layer, TextLayer::Weak);
        assert_eq!(diagnostics[2].unmapped, 7);
    }

    #[test]
    fn distinguishes_inline_image_with_sparse_text_from_native_text() {
        let picture = "q 590 0 0 790 0 0 cm BI /W 1 /H 1 /CS /G /BPC 8 ID X EI Q";
        let bytes = document(
            &[
                page(picture.to_owned()),
                page(format!("{picture}\n{}", text(50.0, 35.0, 10.0, "Stamp"))),
            ],
            &[],
        );
        let diagnostics =
            document_diagnostics(&bytes, PageRequest::Indexes(None), &Limits::default()).unwrap();
        assert_eq!(diagnostics[0].text_layer, TextLayer::None);
        assert_eq!(diagnostics[1].text_layer, TextLayer::Weak);
        assert_eq!(diagnostics[0].image_count, 1);
        assert_eq!(diagnostics[1].image_count, 1);
    }

    #[test]
    fn substantial_hidden_text_only_counts_inside_the_crop_box() {
        let phrase = "Mapped searchable content ".repeat(10);
        let group = format!("3 Tr\n{}", text(30.0, 700.0, 1.0, &phrase));
        let off_page = text(30.0, 1000.0, 1.0, &phrase);
        let bytes = document(&[page(group), page(off_page)], &[]);
        let diagnostics =
            document_diagnostics(&bytes, PageRequest::Indexes(None), &Limits::default()).unwrap();
        assert_eq!(diagnostics[0].text_layer, TextLayer::Usable);
        assert_eq!(diagnostics[1].text_layer, TextLayer::Weak);
        assert_eq!(diagnostics[1].usable_chars, 0);
    }
}
