use core::str;

use crate::failure::{Failure, Outcome};
use crate::inspection::Limits;
use crate::layout::OcrPage;
use crate::num::widen;
use crate::text::{PageContent, Run};

struct Payload<'data>(&'data [u8]);

impl<'data> Payload<'data> {
    fn finite(&mut self) -> Outcome<f64> {
        let value = f64::from_le_bytes(self.number()?);
        if value.is_finite() {
            Ok(value)
        } else {
            Err(Failure::request("non-finite OCR geometry"))
        }
    }

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
        for _ in 0..count {
            let rect = [
                self.finite()?,
                self.finite()?,
                self.finite()?,
                self.finite()?,
            ];
            let direction = (self.finite()?, self.finite()?);
            let font_size = self.finite()?;
            let text = self.text(remaining)?;
            let start = u32::try_from(content.text.len())
                .map_err(|_overflow| Failure::limit("OCR text exceeds the size limit"))?;
            content.text.push_str(text);
            let end = u32::try_from(content.text.len())
                .map_err(|_overflow| Failure::limit("OCR text exceeds the size limit"))?;
            content.runs.push(Run {
                bold: false,
                direction,
                font_size,
                italic: false,
                rect,
                text: start..end,
            });
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
