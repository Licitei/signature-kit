use core::str;

use crate::failure::{Failure, Outcome};
use crate::inspection::Limits;
use crate::layout::OcrPage;
use crate::num::widen;
use crate::text::{PageContent, Run};

struct Payload<'data>(&'data [u8]);

impl<'data> Payload<'data> {
    fn integer(&mut self) -> Outcome<usize> {
        self.number().map(u32::from_le_bytes).map(widen)
    }

    fn number<const N: usize>(&mut self) -> Outcome<[u8; N]> {
        let (value, rest) = self
            .0
            .split_first_chunk::<N>()
            .ok_or_else(|| Failure::request("truncated OCR payload"))?;
        self.0 = rest;
        Ok(*value)
    }

    fn text(&mut self, remaining: &mut usize) -> Outcome<&'data str> {
        let length = self.integer()?;
        *remaining = remaining
            .checked_sub(length)
            .ok_or_else(|| Failure::limit("OCR text exceeds the size limit"))?;
        let (bytes, rest) = self
            .0
            .split_at_checked(length)
            .ok_or_else(|| Failure::request("truncated OCR text"))?;
        self.0 = rest;
        str::from_utf8(bytes).map_err(|_invalid_utf8| Failure::request("invalid OCR text encoding"))
    }

    fn words(&mut self, limits: &Limits, remaining: &mut usize) -> Outcome<PageContent> {
        let count = self.integer()?;
        if count > limits.max_items_per_page {
            return Err(Failure::limit("OCR page exceeds the word limit"));
        }
        let mut content = PageContent::default();
        let mut start = 0;
        for _ in 0..count {
            let raw = self.number::<56>()?;
            let (chunks, _) = raw.as_chunks::<8>();
            let fields = <[[u8; 8]; 7]>::try_from(chunks)
                .map_err(|_shape| Failure::request("invalid OCR geometry record"))?
                .map(f64::from_le_bytes);
            if !fields.iter().all(|value| value.is_finite()) {
                return Err(Failure::request("non-finite OCR geometry"));
            }
            let [x0, y0, x1, y1, dx, dy, font_size] = fields;
            content.text.push_str(self.text(remaining)?);
            let end = u32::try_from(content.text.len())
                .map_err(|_overflow| Failure::limit("OCR text exceeds the size limit"))?;
            content.runs.push(Run {
                bold: false,
                direction: (dx, dy),
                font_size,
                italic: false,
                rect: [x0, y0, x1, y1],
                text: start..end,
            });
            start = end;
        }
        Ok(content)
    }
}

#[inline(never)]
pub(crate) fn decode(bytes: &[u8], limits: &Limits) -> Outcome<Vec<(usize, OcrPage)>> {
    let mut pages = Vec::new();
    let mut payload = Payload(bytes);
    let mut remaining = limits.max_text_bytes;
    while !payload.0.is_empty() {
        let index = payload.integer()?;
        if pages.last().is_some_and(|(previous, _)| *previous >= index) {
            return Err(Failure::request("OCR page indexes must increase"));
        }
        let page = match payload.integer()? {
            0 => OcrPage::Text(payload.text(&mut remaining)?.to_owned()),
            1 => OcrPage::Words(payload.words(limits, &mut remaining)?),
            _ => return Err(Failure::request("invalid OCR page kind")),
        };
        pages.push((index, page));
    }
    Ok(pages)
}
