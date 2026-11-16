#![expect(
    unsafe_code,
    reason = "the C ABI boundary hands raw pointers across the WebAssembly import surface"
)]

use std::alloc::{Layout, alloc, dealloc};
use std::ptr;

use crate::document;
use crate::failure::{Failure, Outcome};
use crate::inspection::{InspectOptions, Inspection, Limits};
use crate::layout::{self, TextOptions};
use crate::table::Table;

const MAGIC: u32 = 0x4346_4450;
const VERSION: u32 = 1;
const HEADER_LEN: usize = 32;
const PAGE_RECORD_LEN: usize = 72;
const RESULT_HEADER_LEN: usize = 8;
const FLAG_TEXT: u32 = 1;
const FLAG_LINKS: u32 = 2;
const FLAG_PAGE_INDEXES: u32 = 4;
const FLAG_MARKDOWN: u32 = 8;
const FLAG_DROP_RUNNING: u32 = 16;
const STATUS_OK: u32 = 0;
const TEXT_MAGIC: u32 = 0x5854_4450;
const TEXT_VERSION: u32 = 1;
const TEXT_HEADER_LEN: usize = 16;
const TABLES_MAGIC: u32 = 0x4254_4450;
const TABLES_VERSION: u32 = 1;
const TABLES_HEADER_LEN: usize = 16;
const TABLE_RECORD_LEN: usize = 48;
const CELL_RECORD_LEN: usize = 56;
const ALIGNMENT: usize = 8;

fn block_layout(len: usize) -> Option<Layout> {
    Layout::from_size_align(len.max(1), ALIGNMENT).ok()
}

fn len32(value: usize) -> Outcome<u32> {
    u32::try_from(value)
        .ok()
        .ok_or_else(|| Failure::limit("result exceeds the 32-bit size limit"))
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
            self.buf.resize(
                self.buf
                    .len()
                    .saturating_add(ALIGNMENT.saturating_sub(remainder)),
                0,
            );
        }
    }

    fn patch_u32(&mut self, at: usize, value: u32) {
        if let Some(slot) = at.checked_add(4).and_then(|end| self.buf.get_mut(at..end)) {
            slot.copy_from_slice(&value.to_le_bytes());
        }
    }
}

fn encode(inspection: &Inspection) -> Outcome<Vec<u8>> {
    let page_count = len32(inspection.pages.len())?;
    let link_count = len32(inspection.links.len())?;
    let text_page_count = len32(inspection.text.len())?;
    let mut out = Writer {
        buf: Vec::with_capacity(
            HEADER_LEN.saturating_add(inspection.pages.len().saturating_mul(PAGE_RECORD_LEN)),
        ),
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

fn encode_text(pages: &[String]) -> Outcome<Vec<u8>> {
    let page_count = len32(pages.len())?;
    let mut text_len: usize = 0;
    for page in pages {
        text_len = text_len
            .checked_add(page.len())
            .ok_or_else(|| Failure::limit("text exceeds the size limit"))?;
    }
    let offsets_len = padded(
        pages
            .len()
            .checked_add(1)
            .and_then(|count| count.checked_mul(4))
            .ok_or_else(|| Failure::limit("result size overflow"))?,
    )?;
    let capacity = TEXT_HEADER_LEN
        .checked_add(offsets_len)
        .and_then(|sum| sum.checked_add(text_len))
        .and_then(|sum| sum.checked_add(ALIGNMENT))
        .ok_or_else(|| Failure::limit("result size overflow"))?;
    let mut out = Writer {
        buf: Vec::with_capacity(capacity),
    };
    out.u32(TEXT_MAGIC);
    out.u32(TEXT_VERSION);
    out.u32(page_count);
    out.u32(len32(text_len)?);
    let mut cursor: u32 = 0;
    out.u32(cursor);
    for page in pages {
        cursor = cursor
            .checked_add(len32(page.len())?)
            .ok_or_else(|| Failure::limit("text exceeds the size limit"))?;
        out.u32(cursor);
    }
    out.align();
    for page in pages {
        out.buf.extend_from_slice(page.as_bytes());
    }
    out.align();
    let total = out
        .buf
        .len()
        .checked_add(RESULT_HEADER_LEN)
        .ok_or_else(|| Failure::limit("result size overflow"))?;
    len32(total)?;
    Ok(out.buf)
}

fn encode_tables(tables: &[Table]) -> Outcome<Vec<u8>> {
    let table_count = len32(tables.len())?;
    let mut cell_count: usize = 0;
    let mut text_len: usize = 0;
    for table in tables {
        cell_count = cell_count
            .checked_add(table.cells.len())
            .ok_or_else(|| Failure::limit("result size overflow"))?;
        for cell in &table.cells {
            text_len = text_len
                .checked_add(cell.text.len())
                .ok_or_else(|| Failure::limit("table text exceeds the size limit"))?;
        }
    }
    let records = tables
        .len()
        .checked_mul(TABLE_RECORD_LEN)
        .and_then(|bytes| {
            cell_count
                .checked_mul(CELL_RECORD_LEN)
                .and_then(|cells| bytes.checked_add(cells))
        })
        .ok_or_else(|| Failure::limit("result size overflow"))?;
    let capacity = TABLES_HEADER_LEN
        .checked_add(records)
        .and_then(|sum| sum.checked_add(text_len))
        .and_then(|sum| sum.checked_add(ALIGNMENT))
        .ok_or_else(|| Failure::limit("result size overflow"))?;
    let mut out = Writer {
        buf: Vec::with_capacity(capacity),
    };
    out.u32(TABLES_MAGIC);
    out.u32(TABLES_VERSION);
    out.u32(table_count);
    out.u32(len32(cell_count)?);
    let mut cursor: u32 = 0;
    for table in tables {
        out.u32(table.page_index);
        out.u32(table.rows);
        out.u32(table.cols);
        out.u32(len32(table.cells.len())?);
        out.boxed(&table.bbox);
        for cell in &table.cells {
            out.u32(cell.row);
            out.u32(cell.col);
            out.u32(cell.row_span);
            out.u32(cell.col_span);
            out.boxed(&cell.bbox);
            out.u32(cursor);
            out.u32(len32(cell.text.len())?);
            cursor = cursor
                .checked_add(len32(cell.text.len())?)
                .ok_or_else(|| Failure::limit("table text exceeds the size limit"))?;
        }
    }
    for table in tables {
        for cell in &table.cells {
            out.buf.extend_from_slice(cell.text.as_bytes());
        }
    }
    out.align();
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
    // SAFETY: `block_layout` never yields a zero-sized layout.
    let block = unsafe { alloc(layout) };
    if block.is_null() {
        return block;
    }
    let mut header = [0_u8; RESULT_HEADER_LEN];
    let (total_field, status_field) = header.split_at_mut(4);
    total_field.copy_from_slice(&total32.to_le_bytes());
    status_field.copy_from_slice(&status.to_le_bytes());
    // SAFETY: `block` holds `total >= RESULT_HEADER_LEN` writable bytes and `header` is a distinct local array.
    unsafe { ptr::copy_nonoverlapping(header.as_ptr(), block, RESULT_HEADER_LEN) };
    let tail = block.wrapping_add(RESULT_HEADER_LEN);
    // SAFETY: `block` holds `total` bytes, so the payload fits after the header and cannot overlap the Rust-owned slice.
    unsafe { ptr::copy_nonoverlapping(payload.as_ptr(), tail, payload.len()) };
    block
}

fn finish(outcome: Outcome<Vec<u8>>) -> *mut u8 {
    match outcome {
        Ok(payload) => publish(STATUS_OK, &payload),
        Err(failure) => publish(u32::from(failure.code), failure.reason.as_bytes()),
    }
}

/// # Safety
///
/// `data` must be null or valid for reads of `len` initialised elements that stay unmodified for `'a`.
unsafe fn view<'a, T>(data: *const T, len: usize) -> Outcome<&'a [T]> {
    if len == 0 || data.is_null() {
        return Ok(&[]);
    }
    if !data.is_aligned() {
        return Err(Failure::invalid("misaligned input buffer"));
    }
    // SAFETY: non-null, aligned, and valid for `len` elements by the caller contract.
    Ok(unsafe { std::slice::from_raw_parts(data, len) })
}

struct Request<'a> {
    pdf: &'a [u8],
    flags: u32,
    pages: Option<&'a [u32]>,
}

impl Request<'_> {
    /// # Safety
    ///
    /// `pdf_ptr` and `pages_ptr` must satisfy [`view`] for `pdf_len` and `pages_len` for the whole call.
    unsafe fn from_raw(
        pdf_ptr: *const u8,
        pdf_len: usize,
        flags: u32,
        pages_ptr: *const u32,
        pages_len: usize,
    ) -> Outcome<Self> {
        // SAFETY: forwarded from this function's contract.
        let pdf = unsafe { view(pdf_ptr, pdf_len) }?;
        let pages = if flags & FLAG_PAGE_INDEXES == 0 {
            None
        } else {
            // SAFETY: forwarded from this function's contract.
            Some(unsafe { view(pages_ptr, pages_len) }?)
        };
        Ok(Self { pdf, flags, pages })
    }

    const fn has(&self, flag: u32) -> bool {
        self.flags & flag != 0
    }
}

#[unsafe(no_mangle)]
pub(crate) extern "C" fn pdf_core_alloc(len: usize) -> *mut u8 {
    block_layout(len).map_or(ptr::null_mut(), |layout| {
        // SAFETY: `block_layout` never yields a zero-sized layout.
        unsafe { alloc(layout) }
    })
}

/// # Safety
///
/// `data` must be null or a block returned by this module with exactly `len` as the length it was requested or published with.
#[unsafe(no_mangle)]
pub(crate) unsafe extern "C" fn pdf_core_free(data: *mut u8, len: usize) {
    if data.is_null() {
        return;
    }
    if let Some(layout) = block_layout(len) {
        // SAFETY: `data` came from `alloc` with the same layout by the caller contract.
        unsafe { dealloc(data, layout) };
    }
}

/// # Safety
///
/// `pdf_ptr` and `pages_ptr` must satisfy [`view`] for their lengths until the call returns.
#[unsafe(no_mangle)]
pub(crate) unsafe extern "C" fn pdf_core_inspect(
    pdf_ptr: *const u8,
    pdf_len: usize,
    flags: u32,
    pages_ptr: *const u32,
    pages_len: usize,
) -> *mut u8 {
    // SAFETY: forwarded from this function's contract.
    let request = unsafe { Request::from_raw(pdf_ptr, pdf_len, flags, pages_ptr, pages_len) };
    finish(request.and_then(|request| {
        let options = InspectOptions {
            text: request.has(FLAG_TEXT),
            links: request.has(FLAG_LINKS),
            page_indexes: request.pages.map(<[u32]>::to_vec),
        };
        let inspection = document::inspect(request.pdf, &options, &Limits::default())?;
        encode(&inspection)
    }))
}

/// # Safety
///
/// `pdf_ptr` and `pages_ptr` must satisfy [`view`] for their lengths until the call returns.
#[unsafe(no_mangle)]
pub(crate) unsafe extern "C" fn pdf_core_text(
    pdf_ptr: *const u8,
    pdf_len: usize,
    flags: u32,
    pages_ptr: *const u32,
    pages_len: usize,
) -> *mut u8 {
    // SAFETY: forwarded from this function's contract.
    let request = unsafe { Request::from_raw(pdf_ptr, pdf_len, flags, pages_ptr, pages_len) };
    finish(request.and_then(|request| {
        let options = TextOptions {
            markdown: request.has(FLAG_MARKDOWN),
            drop_running: request.has(FLAG_DROP_RUNNING),
        };
        let pages =
            layout::document_text(request.pdf, request.pages, &layout::text_limits(), &options)?;
        encode_text(&pages)
    }))
}

/// # Safety
///
/// `pdf_ptr` and `pages_ptr` must satisfy [`view`] for their lengths until the call returns.
#[unsafe(no_mangle)]
pub(crate) unsafe extern "C" fn pdf_core_tables(
    pdf_ptr: *const u8,
    pdf_len: usize,
    flags: u32,
    pages_ptr: *const u32,
    pages_len: usize,
) -> *mut u8 {
    // SAFETY: forwarded from this function's contract.
    let request = unsafe { Request::from_raw(pdf_ptr, pdf_len, flags, pages_ptr, pages_len) };
    finish(request.and_then(|request| {
        let tables = layout::document_tables(request.pdf, request.pages, &layout::text_limits())?;
        encode_tables(&tables)
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::failure::FailureCode;
    use crate::inspection::{LinkInfo, PageInfo, PageText, TextItem};
    use crate::num::widen;

    struct Reader<'a> {
        data: &'a [u8],
        at: usize,
    }

    impl<'a> Reader<'a> {
        fn take(&mut self, len: usize) -> &'a [u8] {
            let slice = self
                .data
                .get(self.at..self.at.saturating_add(len))
                .unwrap_or(&[]);
            assert_eq!(slice.len(), len, "read past the end");
            self.at = self.at.saturating_add(len);
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
            self.at = (self.at.saturating_add(7)) & !7;
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
        let pages_offset = widen(reader.u32());
        let links_offset = widen(reader.u32());
        let text_offset = widen(reader.u32());
        assert_eq!(pages_offset, HEADER_LEN);
        assert_eq!(pages_offset % 8, 0);
        assert_eq!(links_offset % 8, 0);
        assert_eq!(text_offset % 8, 0);
        assert_eq!(
            links_offset,
            pages_offset.saturating_add((widen(page_count)).saturating_mul(PAGE_RECORD_LEN))
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
                let start = widen(reader.u32());
                let len = widen(reader.u32());
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
                uri: String::from_utf8_lossy(&blob[*start..(*start).saturating_add(*len)])
                    .into_owned(),
            })
            .collect();
        reader.align();
        assert_eq!(reader.at, text_offset);
        let text = (0..text_count)
            .map(|_| {
                let page_index = reader.u32();
                let item_count = widen(reader.u32());
                let text_len = widen(reader.u32());
                reader.u32();
                let rects: Vec<([f64; 4], f64)> = (0..item_count)
                    .map(|_| {
                        let rect = reader.rect();
                        (rect, reader.f64())
                    })
                    .collect();
                let offsets: Vec<usize> = (0..=item_count).map(|_| widen(reader.u32())).collect();
                reader.align();
                let strings = reader.take(text_len);
                reader.align();
                let items = rects
                    .iter()
                    .enumerate()
                    .map(|(index, (rect, font_size))| TextItem {
                        rect: *rect,
                        font_size: *font_size,
                        text: String::from_utf8_lossy(
                            &strings[offsets[index]..offsets[index.saturating_add(1)]],
                        )
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
        let pages_offset = widen(reader.u32());
        let links_offset = widen(reader.u32());
        let text_offset = widen(reader.u32());
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
        call_entry(pdf_core_inspect, bytes, flags, pages)
    }

    fn release(block: &Block) {
        // SAFETY: the block was published by this module with exactly `total` bytes.
        unsafe { pdf_core_free(block.ptr, block.total) };
    }

    const LINKS_PDF: &[u8] = include_bytes!("../../__tests__/fixtures/links.pdf");
    const ROTATED_PDF: &[u8] = include_bytes!("../../__tests__/fixtures/rotated-cropped.pdf");

    type Entry = unsafe extern "C" fn(*const u8, usize, u32, *const u32, usize) -> *mut u8;

    fn call_text(bytes: &[u8], flags: u32, pages: &[u32]) -> Block {
        call_entry(pdf_core_text, bytes, flags, pages)
    }

    fn call_tables(bytes: &[u8], flags: u32, pages: &[u32]) -> Block {
        call_entry(pdf_core_tables, bytes, flags, pages)
    }

    #[expect(
        clippy::cast_ptr_alignment,
        reason = "pdf_core_alloc returns 8-byte aligned blocks, which satisfies u32"
    )]
    fn call_entry(entry: Entry, bytes: &[u8], flags: u32, pages: &[u32]) -> Block {
        let input = pdf_core_alloc(bytes.len());
        assert!(!input.is_null());
        // SAFETY: `input` holds `bytes.len()` writable bytes and does not overlap `bytes`.
        unsafe { ptr::copy_nonoverlapping(bytes.as_ptr(), input, bytes.len()) };
        let page_bytes = pages.len().saturating_mul(4);
        let indexes = pdf_core_alloc(page_bytes).cast::<u32>();
        assert!(!indexes.is_null());
        // SAFETY: `indexes` holds `page_bytes` writable bytes and does not overlap `pages`.
        unsafe { ptr::copy_nonoverlapping(pages.as_ptr(), indexes, pages.len()) };
        // SAFETY: both buffers were allocated above with the lengths passed here.
        let result = unsafe { entry(input, bytes.len(), flags, indexes, pages.len()) };
        // SAFETY: both blocks came from `pdf_core_alloc` with these exact lengths and are no longer used.
        unsafe { pdf_core_free(input, bytes.len()) };
        // SAFETY: as above.
        unsafe { pdf_core_free(indexes.cast::<u8>(), page_bytes) };
        adopt(result)
    }

    fn adopt(result: *mut u8) -> Block {
        assert!(!result.is_null());
        assert_eq!(result.addr() % 8, 0);
        // SAFETY: every published block starts with an `RESULT_HEADER_LEN` byte header.
        let header = unsafe { std::slice::from_raw_parts(result, RESULT_HEADER_LEN) };
        let [t0, t1, t2, t3, s0, s1, s2, s3] = <[u8; RESULT_HEADER_LEN]>::try_from(header).unwrap();
        let total = widen(u32::from_le_bytes([t0, t1, t2, t3]));
        let status = u32::from_le_bytes([s0, s1, s2, s3]);
        let tail = result.wrapping_add(RESULT_HEADER_LEN);
        // SAFETY: the header declares `total` bytes, and the payload is everything after the header.
        let payload =
            unsafe { std::slice::from_raw_parts(tail, total.saturating_sub(RESULT_HEADER_LEN)) }
                .to_vec();
        Block {
            ptr: result,
            total,
            status,
            payload,
        }
    }

    fn decode_text(payload: &[u8]) -> Vec<String> {
        let word = |at: usize| {
            widen(u32::from_le_bytes([
                payload[at],
                payload[at.saturating_add(1)],
                payload[at.saturating_add(2)],
                payload[at.saturating_add(3)],
            ]))
        };
        assert_eq!(u32::try_from(word(0)).unwrap(), TEXT_MAGIC);
        assert_eq!(u32::try_from(word(4)).unwrap(), TEXT_VERSION);
        let count = word(8);
        let text_len = word(12);
        let offsets_at = TEXT_HEADER_LEN;
        let blob_at = offsets_at
            .saturating_add((((count.saturating_add(1)).saturating_mul(4)).saturating_add(7)) & !7);
        assert_eq!(blob_at % 8, 0);
        assert_eq!(
            payload.len(),
            ((blob_at.saturating_add(text_len)).saturating_add(7)) & !7
        );
        (0..count)
            .map(|index| {
                let start = word(offsets_at.saturating_add(index.saturating_mul(4)));
                let end =
                    word(offsets_at.saturating_add((index.saturating_add(1)).saturating_mul(4)));
                String::from_utf8_lossy(
                    &payload[blob_at.saturating_add(start)..blob_at.saturating_add(end)],
                )
                .into_owned()
            })
            .collect()
    }

    fn table_pdf() -> Vec<u8> {
        use crate::test_pdf::{document, grid, page, text};
        let mut pages = Vec::new();
        for index in 0..3 {
            let mut content = grid(&[700.0, 680.0, 660.0], &[50.0, 200.0, 350.0]);
            content.push_str(&text(55.0, 688.0, 10.0, "Item | x"));
            content.push_str(&text(205.0, 688.0, 10.0, "Valor"));
            content.push_str(&text(55.0, 668.0, 10.0, "Cimento"));
            content.push_str(&text(205.0, 668.0, 10.0, "12,50"));
            content.push_str(&text(50.0, 770.0, 9.0, "Prefeitura de Marilac"));
            content.push_str(&text(50.0, 500.0, 10.0, &format!("Corpo {index}")));
            pages.push(page(content));
        }
        document(&pages, &[])
    }

    struct DecodedCell {
        row: u32,
        col: u32,
        spans: (u32, u32),
        bbox: [f64; 4],
        text: String,
    }

    struct DecodedTable {
        page_index: u32,
        rows: u32,
        cols: u32,
        bbox: [f64; 4],
        cells: Vec<DecodedCell>,
    }

    fn decode_tables(payload: &[u8]) -> Vec<DecodedTable> {
        let word = |at: usize| {
            u32::from_le_bytes([
                payload[at],
                payload[at.saturating_add(1)],
                payload[at.saturating_add(2)],
                payload[at.saturating_add(3)],
            ])
        };
        let float =
            |at: usize| f64::from_le_bytes(payload[at..at.saturating_add(8)].try_into().unwrap());
        let boxed = |at: usize| {
            [
                float(at),
                float(at.saturating_add(8)),
                float(at.saturating_add(16)),
                float(at.saturating_add(24)),
            ]
        };
        assert_eq!(word(0), TABLES_MAGIC);
        assert_eq!(word(4), TABLES_VERSION);
        let tables = widen(word(8));
        let cells = widen(word(12));
        let blob = (TABLES_HEADER_LEN.saturating_add(tables.saturating_mul(TABLE_RECORD_LEN)))
            .saturating_add(cells.saturating_mul(CELL_RECORD_LEN));
        assert_eq!(blob % 8, 0);
        assert_eq!(payload.len() % 8, 0);
        let mut at = TABLES_HEADER_LEN;
        let mut out = Vec::new();
        for _ in 0..tables {
            let count = widen(word(at.saturating_add(12)));
            let header = at;
            at = at.saturating_add(TABLE_RECORD_LEN);
            let mut decoded = Vec::new();
            for _ in 0..count {
                let start = blob.saturating_add(widen(word(at.saturating_add(48))));
                let len = widen(word(at.saturating_add(52)));
                decoded.push(DecodedCell {
                    row: word(at),
                    col: word(at.saturating_add(4)),
                    spans: (word(at.saturating_add(8)), word(at.saturating_add(12))),
                    bbox: boxed(at.saturating_add(16)),
                    text: String::from_utf8_lossy(&payload[start..start.saturating_add(len)])
                        .into_owned(),
                });
                at = at.saturating_add(CELL_RECORD_LEN);
            }
            out.push(DecodedTable {
                page_index: word(header),
                rows: word(header.saturating_add(4)),
                cols: word(header.saturating_add(8)),
                bbox: boxed(header.saturating_add(16)),
                cells: decoded,
            });
        }
        assert_eq!(at, blob);
        out
    }

    #[test]
    fn tables_round_trip_every_field() {
        let block = call_tables(&table_pdf(), 0, &[]);
        assert_eq!(block.status, STATUS_OK);
        let tables = decode_tables(&block.payload);
        assert_eq!(tables.len(), 3);
        let first = &tables[0];
        assert_eq!((first.page_index, first.rows, first.cols), (0, 2, 2));
        assert_eq!(first.bbox, [50.0, 660.0, 350.0, 700.0]);
        assert_eq!(first.cells.len(), 4);
        let header = &first.cells[0];
        assert_eq!((header.row, header.col, header.spans), (0, 0, (1, 1)));
        assert_eq!(header.text, "Item | x");
        assert_eq!(header.bbox, [50.0, 680.0, 200.0, 700.0]);
        assert_eq!(first.cells[3].text, "12,50");
        release(&block);
    }

    #[test]
    fn tables_honour_page_indexes_and_report_failures() {
        let pdf = table_pdf();
        let picked = call_tables(&pdf, FLAG_PAGE_INDEXES, &[2]);
        let tables = decode_tables(&picked.payload);
        assert_eq!(tables.len(), 1);
        assert_eq!(tables[0].page_index, 2);
        release(&picked);
        let missing = call_tables(&pdf, FLAG_PAGE_INDEXES, &[9]);
        assert_eq!(missing.status, u32::from(FailureCode::InvalidPdf));
        release(&missing);
        let broken = call_tables(b"not a pdf", 0, &[]);
        assert_ne!(broken.status, STATUS_OK);
        release(&broken);
        let none = call_tables(LINKS_PDF, 0, &[]);
        assert_eq!(none.status, STATUS_OK);
        assert!(decode_tables(&none.payload).is_empty());
        release(&none);
    }

    #[test]
    fn text_flags_select_markdown_and_running_header_dropping() {
        let pdf = table_pdf();
        let plain = call_text(&pdf, 0, &[]);
        let plain_pages = decode_text(&plain.payload);
        assert_eq!(
            plain_pages[1],
            "Prefeitura de Marilac\n\nItem | x Valor\nCimento 12,50\n\nCorpo 1"
        );
        release(&plain);
        let dropped = call_text(&pdf, FLAG_DROP_RUNNING, &[]);
        let dropped_pages = decode_text(&dropped.payload);
        assert!(dropped_pages[0].starts_with("Prefeitura de Marilac"));
        assert!(!dropped_pages[1].contains("Prefeitura"));
        release(&dropped);
        let markdown = call_text(&pdf, FLAG_MARKDOWN | FLAG_DROP_RUNNING, &[]);
        let markdown_pages = decode_text(&markdown.payload);
        assert_eq!(
            markdown_pages[2],
            "| Item \\| x | Valor |\n| --- | --- |\n| Cimento | 12,50 |\n\nCorpo 2"
        );
        release(&markdown);
    }

    #[test]
    fn empty_tables_payload_is_header_only() {
        let payload = encode_tables(&[]).unwrap();
        assert_eq!(payload.len(), TABLES_HEADER_LEN);
        assert_eq!(payload.len() % 8, 0);
    }

    #[test]
    fn text_returns_reading_order_pages() {
        let block = call_text(LINKS_PDF, 0, &[]);
        assert_eq!(block.status, STATUS_OK);
        let pages = decode_text(&block.payload);
        assert_eq!(pages.len(), 1);
        assert!(!pages[0].trim().is_empty());
        release(&block);
    }

    #[test]
    fn text_honours_page_indexes() {
        let all = call_text(LINKS_PDF, 0, &[]);
        let picked = call_text(LINKS_PDF, FLAG_PAGE_INDEXES, &[0, 0]);
        assert_eq!(picked.status, STATUS_OK);
        assert_eq!(decode_text(&picked.payload), decode_text(&all.payload));
        release(&all);
        release(&picked);
        let missing = call_text(LINKS_PDF, FLAG_PAGE_INDEXES, &[9]);
        assert_eq!(missing.status, u32::from(FailureCode::InvalidPdf));
        release(&missing);
    }

    #[test]
    fn text_failures_carry_code_and_reason() {
        let block = call_text(b"not a pdf", 0, &[]);
        assert_eq!(block.status, u32::from(FailureCode::InvalidPdf));
        assert!(std::str::from_utf8(&block.payload).is_ok());
        release(&block);
        let empty = call_text(b"", 0, &[]);
        assert_eq!(empty.status, u32::from(FailureCode::InvalidPdf));
        release(&empty);
    }

    #[test]
    fn text_covers_rotated_pages() {
        let block = call_text(ROTATED_PDF, 0, &[]);
        assert_eq!(block.status, STATUS_OK);
        assert!(
            decode_text(&block.payload)
                .iter()
                .any(|page| !page.is_empty())
        );
        release(&block);
    }

    #[test]
    fn inspect_returns_a_decodable_block() {
        let block = call(LINKS_PDF, FLAG_TEXT | FLAG_LINKS, &[]);
        assert_eq!(block.status, STATUS_OK);
        let decoded = decode(&block.payload);
        assert_eq!(decoded.pages.len(), 1);
        assert_eq!(decoded.links.len(), 3);
        assert_eq!(decoded.text.len(), 1);
        assert_eq!(decoded.text[0].page_index, 0);
        release(&block);
    }

    #[test]
    fn inspect_honours_flags() {
        let block = call(LINKS_PDF, 0, &[]);
        assert_eq!(block.status, STATUS_OK);
        let decoded = decode(&block.payload);
        assert_eq!(decoded.pages.len(), 1);
        assert!(decoded.links.is_empty());
        assert!(decoded.text.is_empty());
        release(&block);
    }

    #[test]
    fn inspect_forwards_page_indexes() {
        let wanted = call(ROTATED_PDF, FLAG_TEXT | FLAG_PAGE_INDEXES, &[0]);
        assert_eq!(wanted.status, STATUS_OK);
        let wanted_decoded = decode(&wanted.payload);
        assert_eq!(wanted_decoded.text.len(), 1);
        assert_eq!(wanted_decoded.text[0].page_index, 0);
        release(&wanted);
        let skipped = call(ROTATED_PDF, FLAG_TEXT | FLAG_PAGE_INDEXES, &[5]);
        assert_ne!(skipped.status, STATUS_OK);
        release(&skipped);
    }

    #[test]
    fn failures_carry_code_and_reason() {
        let block = call(b"not a pdf", 0, &[]);
        assert_eq!(block.status, u32::from(FailureCode::InvalidPdf));
        assert!(!block.payload.is_empty());
        assert!(std::str::from_utf8(&block.payload).is_ok());
        release(&block);
    }

    #[test]
    fn empty_input_is_a_failure_not_a_crash() {
        let block = call(b"", 0, &[]);
        assert_eq!(block.status, u32::from(FailureCode::InvalidPdf));
        release(&block);
    }

    #[test]
    fn null_input_is_treated_as_empty() {
        // SAFETY: a null input pointer is documented as an empty buffer.
        let result = unsafe { pdf_core_inspect(ptr::null(), 10, 0, ptr::null(), 0) };
        let block = adopt(result);
        assert_eq!(block.status, u32::from(FailureCode::InvalidPdf));
        release(&block);
    }

    #[test]
    #[expect(
        clippy::cast_ptr_alignment,
        reason = "the test hands the ABI a deliberately misaligned page index pointer"
    )]
    fn misaligned_page_indexes_are_rejected() {
        let backing = pdf_core_alloc(16);
        let skewed = backing.wrapping_add(1).cast::<u32>();
        let input = b"%PDF-1.7\n";
        // SAFETY: the PDF pointer is valid; the page pointer is checked for alignment before it is read.
        let result =
            unsafe { pdf_core_inspect(input.as_ptr(), input.len(), FLAG_PAGE_INDEXES, skewed, 1) };
        let block = adopt(result);
        assert_eq!(block.status, u32::from(FailureCode::InvalidPdf));
        release(&block);
        // SAFETY: `backing` came from `pdf_core_alloc(16)`.
        unsafe { pdf_core_free(backing, 16) };
    }

    #[test]
    fn alloc_is_eight_byte_aligned_and_zero_len_safe() {
        for len in [0_usize, 1, 7, 8, 9, 1000] {
            let block = pdf_core_alloc(len);
            assert!(!block.is_null());
            assert_eq!(block.addr() % 8, 0);
            // SAFETY: `block` came from `pdf_core_alloc(len)`.
            unsafe { pdf_core_free(block, len) };
        }
        // SAFETY: freeing a null pointer is a documented no-op.
        unsafe { pdf_core_free(ptr::null_mut(), 0) };
    }

    #[test]
    fn alloc_rejects_impossible_sizes() {
        assert!(pdf_core_alloc(usize::MAX).is_null());
    }

    #[test]
    fn repeated_calls_do_not_leak_or_corrupt() {
        for _ in 0..200 {
            let block = call(LINKS_PDF, FLAG_TEXT | FLAG_LINKS, &[]);
            assert_eq!(block.status, STATUS_OK);
            release(&block);
        }
    }
}
