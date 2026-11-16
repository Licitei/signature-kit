use std::alloc::{Layout, alloc, dealloc};
use std::ptr;

use crate::document;
use crate::failure::{Failure, Outcome};
use crate::inspection::{InspectOptions, Inspection, Limits};

pub const MAGIC: u32 = 0x4346_4450;
pub const VERSION: u32 = 1;
pub const HEADER_LEN: usize = 32;
pub const PAGE_RECORD_LEN: usize = 72;
pub const LINK_RECORD_LEN: usize = 48;
pub const TEXT_PAGE_HEADER_LEN: usize = 16;
pub const TEXT_RECT_STRIDE: usize = 40;
pub const RESULT_HEADER_LEN: usize = 8;
pub const FLAG_TEXT: u32 = 1;
pub const FLAG_LINKS: u32 = 2;
pub const FLAG_PAGE_INDEXES: u32 = 4;
pub const STATUS_OK: u32 = 0;
const ALIGNMENT: usize = 8;

fn block_layout(len: usize) -> Option<Layout> {
    Layout::from_size_align(len.max(1), ALIGNMENT).ok()
}

fn len32(value: usize) -> Outcome<u32> {
    u32::try_from(value).map_err(|_| Failure::limit("result exceeds the 32-bit size limit"))
}

fn padded(value: usize) -> Outcome<usize> {
    value
        .checked_add(ALIGNMENT - 1)
        .map(|sum| sum & !(ALIGNMENT - 1))
        .ok_or_else(|| Failure::limit("result size overflow"))
}

struct Writer {
    buf: Vec<u8>,
}

impl Writer {
    fn u32(&mut self, value: u32) {
        self.buf.extend_from_slice(&value.to_le_bytes());
    }

    fn i32(&mut self, value: i32) {
        self.buf.extend_from_slice(&value.to_le_bytes());
    }

    fn f64(&mut self, value: f64) {
        self.buf.extend_from_slice(&value.to_le_bytes());
    }

    fn boxed(&mut self, rect: &[f64; 4]) {
        for value in rect {
            self.f64(*value);
        }
    }

    fn align(&mut self) {
        let remainder = self.buf.len() % ALIGNMENT;
        if remainder != 0 {
            self.buf.resize(self.buf.len() + (ALIGNMENT - remainder), 0);
        }
    }

    fn patch_u32(&mut self, at: usize, value: u32) {
        if let Some(slot) = at.checked_add(4).and_then(|end| self.buf.get_mut(at..end)) {
            slot.copy_from_slice(&value.to_le_bytes());
        }
    }
}

pub fn encode(inspection: &Inspection) -> Outcome<Vec<u8>> {
    let page_count = len32(inspection.pages.len())?;
    let link_count = len32(inspection.links.len())?;
    let text_page_count = len32(inspection.text.len())?;
    let mut out = Writer {
        buf: Vec::with_capacity(HEADER_LEN + inspection.pages.len() * PAGE_RECORD_LEN),
    };
    out.u32(MAGIC);
    out.u32(VERSION);
    out.u32(page_count);
    out.u32(link_count);
    out.u32(text_page_count);
    out.u32(len32(HEADER_LEN)?);
    out.u32(0);
    out.u32(0);

    for page in &inspection.pages {
        out.boxed(&page.media_box);
        out.boxed(&page.crop_box);
        out.i32(page.rotate);
        out.u32(0);
    }

    let links_offset = len32(out.buf.len())?;
    out.patch_u32(24, links_offset);
    let mut uri_cursor: u32 = 0;
    for link in &inspection.links {
        out.boxed(&link.rect);
        out.u32(link.page_index);
        out.u32(uri_cursor);
        let uri_len = len32(link.uri.len())?;
        out.u32(uri_len);
        out.u32(0);
        uri_cursor = uri_cursor
            .checked_add(uri_len)
            .ok_or_else(|| Failure::limit("link text exceeds the 32-bit size limit"))?;
    }
    for link in &inspection.links {
        out.buf.extend_from_slice(link.uri.as_bytes());
    }
    out.align();

    let text_offset = len32(out.buf.len())?;
    out.patch_u32(28, text_offset);
    for page in &inspection.text {
        let item_count = len32(page.items.len())?;
        let mut text_len: usize = 0;
        for item in &page.items {
            text_len = text_len
                .checked_add(item.text.len())
                .ok_or_else(|| Failure::limit("page text exceeds the size limit"))?;
        }
        out.u32(page.page_index);
        out.u32(item_count);
        out.u32(len32(text_len)?);
        out.u32(0);
        for item in &page.items {
            out.boxed(&item.rect);
            out.f64(item.font_size);
        }
        let mut cursor: u32 = 0;
        out.u32(cursor);
        for item in &page.items {
            cursor = cursor
                .checked_add(len32(item.text.len())?)
                .ok_or_else(|| Failure::limit("page text exceeds the size limit"))?;
            out.u32(cursor);
        }
        out.align();
        for item in &page.items {
            out.buf.extend_from_slice(item.text.as_bytes());
        }
        out.align();
    }

    padded(out.buf.len())?;
    let total = out
        .buf
        .len()
        .checked_add(RESULT_HEADER_LEN)
        .ok_or_else(|| Failure::limit("result size overflow"))?;
    len32(total)?;
    Ok(out.buf)
}

fn publish(status: u32, payload: &[u8]) -> *mut u8 {
    let Some(total) = payload.len().checked_add(RESULT_HEADER_LEN) else {
        return ptr::null_mut();
    };
    let Ok(total32) = u32::try_from(total) else {
        return ptr::null_mut();
    };
    let Some(layout) = block_layout(total) else {
        return ptr::null_mut();
    };
    let block = unsafe { alloc(layout) };
    if block.is_null() {
        return block;
    }
    let mut header = [0u8; RESULT_HEADER_LEN];
    header[..4].copy_from_slice(&total32.to_le_bytes());
    header[4..].copy_from_slice(&status.to_le_bytes());
    unsafe {
        ptr::copy_nonoverlapping(header.as_ptr(), block, RESULT_HEADER_LEN);
        ptr::copy_nonoverlapping(
            payload.as_ptr(),
            block.add(RESULT_HEADER_LEN),
            payload.len(),
        );
    }
    block
}

fn run(bytes: &[u8], options: &InspectOptions) -> Outcome<Vec<u8>> {
    let inspection = document::inspect(bytes, options, &Limits::default())?;
    encode(&inspection)
}

fn finish(outcome: Outcome<Vec<u8>>) -> *mut u8 {
    match outcome {
        Ok(payload) => publish(STATUS_OK, &payload),
        Err(failure) => publish(failure.code as u32, failure.reason.as_bytes()),
    }
}

unsafe fn view<'a, T>(data: *const T, len: usize) -> Outcome<&'a [T]> {
    if len == 0 || data.is_null() {
        return Ok(&[]);
    }
    if !data.is_aligned() {
        return Err(Failure::invalid("misaligned input buffer"));
    }
    Ok(unsafe { std::slice::from_raw_parts(data, len) })
}

#[unsafe(no_mangle)]
pub extern "C" fn pdf_core_alloc(len: usize) -> *mut u8 {
    match block_layout(len) {
        Some(layout) => unsafe { alloc(layout) },
        None => ptr::null_mut(),
    }
}

#[allow(clippy::missing_safety_doc)]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pdf_core_free(data: *mut u8, len: usize) {
    if data.is_null() {
        return;
    }
    if let Some(layout) = block_layout(len) {
        unsafe { dealloc(data, layout) };
    }
}

#[allow(clippy::missing_safety_doc)]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pdf_core_inspect(
    pdf_ptr: *const u8,
    pdf_len: usize,
    flags: u32,
    pages_ptr: *const u32,
    pages_len: usize,
) -> *mut u8 {
    let outcome = (|| {
        let bytes = unsafe { view(pdf_ptr, pdf_len) }?;
        let page_indexes = if flags & FLAG_PAGE_INDEXES != 0 {
            Some(unsafe { view(pages_ptr, pages_len) }?.to_vec())
        } else {
            None
        };
        let options = InspectOptions {
            text: flags & FLAG_TEXT != 0,
            links: flags & FLAG_LINKS != 0,
            page_indexes,
        };
        run(bytes, &options)
    })();
    finish(outcome)
}

#[cfg(test)]
#[allow(clippy::indexing_slicing)]
mod tests {
    use super::*;
    use crate::failure::FailureCode;
    use crate::inspection::{LinkInfo, PageInfo, PageText, TextItem};

    struct Reader<'a> {
        data: &'a [u8],
        at: usize,
    }

    impl<'a> Reader<'a> {
        fn take(&mut self, len: usize) -> &'a [u8] {
            let slice = self.data.get(self.at..self.at + len).unwrap_or(&[]);
            assert_eq!(slice.len(), len, "read past the end");
            self.at += len;
            slice
        }

        fn u32(&mut self) -> u32 {
            u32::from_le_bytes(self.take(4).try_into().unwrap_or([0; 4]))
        }

        fn i32(&mut self) -> i32 {
            i32::from_le_bytes(self.take(4).try_into().unwrap_or([0; 4]))
        }

        fn f64(&mut self) -> f64 {
            f64::from_le_bytes(self.take(8).try_into().unwrap_or([0; 8]))
        }

        fn rect(&mut self) -> [f64; 4] {
            [self.f64(), self.f64(), self.f64(), self.f64()]
        }

        fn align(&mut self) {
            self.at = (self.at + 7) & !7;
        }
    }

    fn decode(payload: &[u8]) -> Inspection {
        let mut reader = Reader {
            data: payload,
            at: 0,
        };
        assert_eq!(reader.u32(), MAGIC);
        assert_eq!(reader.u32(), VERSION);
        let page_count = reader.u32();
        let link_count = reader.u32();
        let text_count = reader.u32();
        let pages_offset = reader.u32() as usize;
        let links_offset = reader.u32() as usize;
        let text_offset = reader.u32() as usize;
        assert_eq!(pages_offset, HEADER_LEN);
        assert_eq!(pages_offset % 8, 0);
        assert_eq!(links_offset % 8, 0);
        assert_eq!(text_offset % 8, 0);
        assert_eq!(
            links_offset,
            pages_offset + page_count as usize * PAGE_RECORD_LEN
        );
        let pages = (0..page_count)
            .map(|_| {
                let media_box = reader.rect();
                let crop_box = reader.rect();
                let rotate = reader.i32();
                reader.u32();
                PageInfo {
                    media_box,
                    crop_box,
                    rotate,
                }
            })
            .collect();
        assert_eq!(reader.at, links_offset);
        let records: Vec<_> = (0..link_count)
            .map(|_| {
                let rect = reader.rect();
                let page_index = reader.u32();
                let start = reader.u32() as usize;
                let len = reader.u32() as usize;
                reader.u32();
                (rect, page_index, start, len)
            })
            .collect();
        let blob_len: usize = records.iter().map(|record| record.3).sum();
        let blob = reader.take(blob_len);
        let links = records
            .iter()
            .map(|(rect, page_index, start, len)| LinkInfo {
                page_index: *page_index,
                rect: *rect,
                uri: String::from_utf8_lossy(&blob[*start..*start + *len]).into_owned(),
            })
            .collect();
        reader.align();
        assert_eq!(reader.at, text_offset);
        let text = (0..text_count)
            .map(|_| {
                let page_index = reader.u32();
                let item_count = reader.u32() as usize;
                let text_len = reader.u32() as usize;
                reader.u32();
                let rects: Vec<([f64; 4], f64)> = (0..item_count)
                    .map(|_| {
                        let rect = reader.rect();
                        (rect, reader.f64())
                    })
                    .collect();
                let offsets: Vec<usize> = (0..=item_count).map(|_| reader.u32() as usize).collect();
                reader.align();
                let blob = reader.take(text_len);
                reader.align();
                let items = rects
                    .iter()
                    .enumerate()
                    .map(|(index, (rect, font_size))| TextItem {
                        rect: *rect,
                        font_size: *font_size,
                        text: String::from_utf8_lossy(&blob[offsets[index]..offsets[index + 1]])
                            .into_owned(),
                    })
                    .collect();
                PageText { page_index, items }
            })
            .collect();
        assert_eq!(reader.at, payload.len());
        Inspection { pages, links, text }
    }

    fn sample() -> Inspection {
        Inspection {
            pages: vec![
                PageInfo {
                    media_box: [0.0, 0.0, 612.0, 792.0],
                    crop_box: [10.5, 20.25, 600.0, 780.0],
                    rotate: 90,
                },
                PageInfo {
                    media_box: [-1.0, -2.0, 3.0, 4.0],
                    crop_box: [-1.0, -2.0, 3.0, 4.0],
                    rotate: -270,
                },
            ],
            links: vec![
                LinkInfo {
                    page_index: 1,
                    rect: [1.0, 2.0, 3.0, 4.0],
                    uri: "https://example.com/a".to_owned(),
                },
                LinkInfo {
                    page_index: 0,
                    rect: [5.0, 6.0, 7.0, 8.0],
                    uri: "mailto:ünï@example.com".to_owned(),
                },
                LinkInfo {
                    page_index: 0,
                    rect: [0.0; 4],
                    uri: String::new(),
                },
            ],
            text: vec![
                PageText {
                    page_index: 0,
                    items: vec![
                        TextItem {
                            rect: [1.0, 2.0, 3.0, 4.0],
                            font_size: 11.0,
                            text: "Hello".to_owned(),
                        },
                        TextItem {
                            rect: [5.0, 6.0, 7.0, 8.0],
                            font_size: 9.5,
                            text: "mundo — ação".to_owned(),
                        },
                        TextItem {
                            rect: [0.0; 4],
                            font_size: 0.0,
                            text: String::new(),
                        },
                    ],
                },
                PageText {
                    page_index: 1,
                    items: Vec::new(),
                },
            ],
        }
    }

    #[test]
    fn round_trips_every_section() {
        let inspection = sample();
        let payload = encode(&inspection).unwrap_or_default();
        assert_eq!(decode(&payload), inspection);
    }

    #[test]
    fn empty_inspection_is_header_only() {
        let payload = encode(&Inspection::default()).unwrap_or_default();
        assert_eq!(payload.len(), HEADER_LEN);
        assert_eq!(decode(&payload), Inspection::default());
    }

    #[test]
    fn payload_length_is_eight_byte_aligned() {
        let payload = encode(&sample()).unwrap_or_default();
        assert_eq!(payload.len() % 8, 0);
    }

    #[test]
    fn float_sections_are_aligned_inside_the_payload() {
        let payload = encode(&sample()).unwrap_or_default();
        let mut reader = Reader {
            data: &payload,
            at: 0,
        };
        reader.take(20);
        let pages_offset = reader.u32() as usize;
        let links_offset = reader.u32() as usize;
        let text_offset = reader.u32() as usize;
        assert_eq!(pages_offset % 8, 0);
        assert_eq!(links_offset % 8, 0);
        assert_eq!(text_offset % 8, 0);
    }

    struct Block {
        ptr: *mut u8,
        total: usize,
        status: u32,
        payload: Vec<u8>,
    }

    fn call(bytes: &[u8], flags: u32, pages: &[u32]) -> Block {
        let input = pdf_core_alloc(bytes.len());
        assert!(!input.is_null());
        unsafe { ptr::copy_nonoverlapping(bytes.as_ptr(), input, bytes.len()) };
        let indexes = pdf_core_alloc(pages.len() * 4).cast::<u32>();
        assert!(!indexes.is_null());
        unsafe { ptr::copy_nonoverlapping(pages.as_ptr(), indexes, pages.len()) };
        let result = unsafe { pdf_core_inspect(input, bytes.len(), flags, indexes, pages.len()) };
        unsafe {
            pdf_core_free(input, bytes.len());
            pdf_core_free(indexes.cast::<u8>(), pages.len() * 4);
        }
        assert!(!result.is_null());
        assert_eq!(result as usize % 8, 0);
        let header = unsafe { std::slice::from_raw_parts(result, RESULT_HEADER_LEN) };
        let total = u32::from_le_bytes([header[0], header[1], header[2], header[3]]) as usize;
        let status = u32::from_le_bytes([header[4], header[5], header[6], header[7]]);
        let payload =
            unsafe { std::slice::from_raw_parts(result.add(RESULT_HEADER_LEN), total - 8) }
                .to_vec();
        Block {
            ptr: result,
            total,
            status,
            payload,
        }
    }

    fn release(block: &Block) {
        unsafe { pdf_core_free(block.ptr, block.total) };
    }

    #[test]
    fn inspect_returns_a_decodable_block() {
        let block = call(b"%PDF-1.7\n", FLAG_TEXT | FLAG_LINKS, &[]);
        assert_eq!(block.status, STATUS_OK);
        let decoded = decode(&block.payload);
        assert_eq!(decoded.pages.len(), 1);
        assert_eq!(decoded.links.len(), 1);
        assert_eq!(decoded.text.len(), 1);
        release(&block);
    }

    #[test]
    fn inspect_honours_flags() {
        let block = call(b"%PDF-1.7\n", 0, &[]);
        assert_eq!(block.status, STATUS_OK);
        let decoded = decode(&block.payload);
        assert_eq!(decoded.pages.len(), 1);
        assert!(decoded.links.is_empty());
        assert!(decoded.text.is_empty());
        release(&block);
    }

    #[test]
    fn inspect_forwards_page_indexes() {
        let wanted = call(b"%PDF-1.7\n", FLAG_TEXT | FLAG_PAGE_INDEXES, &[0]);
        assert_eq!(decode(&wanted.payload).text.len(), 1);
        release(&wanted);
        let skipped = call(b"%PDF-1.7\n", FLAG_TEXT | FLAG_PAGE_INDEXES, &[5]);
        assert!(decode(&skipped.payload).text.is_empty());
        release(&skipped);
    }

    #[test]
    fn failures_carry_code_and_reason() {
        let block = call(b"not a pdf", 0, &[]);
        assert_eq!(block.status, FailureCode::InvalidPdf as u32);
        assert!(!block.payload.is_empty());
        assert!(std::str::from_utf8(&block.payload).is_ok());
        release(&block);
    }

    #[test]
    fn empty_input_is_a_failure_not_a_crash() {
        let block = call(b"", 0, &[]);
        assert_eq!(block.status, FailureCode::InvalidPdf as u32);
        release(&block);
    }

    #[test]
    fn null_input_is_treated_as_empty() {
        let result = unsafe { pdf_core_inspect(ptr::null(), 10, 0, ptr::null(), 0) };
        assert!(!result.is_null());
        let status = unsafe {
            u32::from_le_bytes([
                *result.add(4),
                *result.add(5),
                *result.add(6),
                *result.add(7),
            ])
        };
        assert_eq!(status, FailureCode::InvalidPdf as u32);
        let total = unsafe {
            u32::from_le_bytes([*result, *result.add(1), *result.add(2), *result.add(3)])
        } as usize;
        unsafe { pdf_core_free(result, total) };
    }

    #[test]
    fn misaligned_page_indexes_are_rejected() {
        let backing = pdf_core_alloc(16);
        let skewed = unsafe { backing.add(1) }.cast::<u32>();
        let input = b"%PDF-1.7\n";
        let result =
            unsafe { pdf_core_inspect(input.as_ptr(), input.len(), FLAG_PAGE_INDEXES, skewed, 1) };
        assert!(!result.is_null());
        let status = unsafe {
            u32::from_le_bytes([
                *result.add(4),
                *result.add(5),
                *result.add(6),
                *result.add(7),
            ])
        };
        assert_eq!(status, FailureCode::InvalidPdf as u32);
        let total = unsafe {
            u32::from_le_bytes([*result, *result.add(1), *result.add(2), *result.add(3)])
        } as usize;
        unsafe {
            pdf_core_free(result, total);
            pdf_core_free(backing, 16);
        }
    }

    #[test]
    fn alloc_is_eight_byte_aligned_and_zero_len_safe() {
        for len in [0usize, 1, 7, 8, 9, 1000] {
            let block = pdf_core_alloc(len);
            assert!(!block.is_null());
            assert_eq!(block as usize % 8, 0);
            unsafe { pdf_core_free(block, len) };
        }
        unsafe { pdf_core_free(ptr::null_mut(), 0) };
    }

    #[test]
    fn alloc_rejects_impossible_sizes() {
        assert!(pdf_core_alloc(usize::MAX).is_null());
    }

    #[test]
    fn repeated_calls_do_not_leak_or_corrupt() {
        for _ in 0..200 {
            let block = call(b"%PDF-1.7\n", FLAG_TEXT | FLAG_LINKS, &[]);
            assert_eq!(block.status, STATUS_OK);
            release(&block);
        }
    }
}
