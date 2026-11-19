#![expect(
    unsafe_code,
    reason = "the C ABI boundary hands raw pointers across the WebAssembly import surface"
)]

use alloc::alloc::{alloc, dealloc, realloc};
use core::alloc::Layout;
use core::cell::{Cell, RefCell};
use core::mem;
use core::ptr;
use core::slice;

use crate::deflate::zlib_compress;
use crate::diagnostics::{PageDiagnostics, TextLayer, opened_diagnostics};
use crate::document::{self, pick_pages, select_pages};
use crate::edit::{DocumentInfo, FieldTarget, Slot, document_info, edit};
use crate::failure::{Failure, Outcome};
use crate::font_tables::{Standard14Font, win_ansi_unicode};
use crate::inspection::{InspectOptions, Inspection, Limits};
use crate::layout::{self, TextOptions};
use crate::lazy::{Lazy, Plan, Tuning};
use crate::num::widen;
use crate::ocr;
use crate::png;
use crate::render::{self, RenderedPage};
use crate::revision::{Analysis, Report, analyze, revision_complete};
use crate::table::Table;
use crate::write::{Packing, create, merge};

const MAGIC: u32 = 0x4346_4450;
const VERSION: u32 = 3;
const HEADER_LEN: usize = 32;
const PAGE_RECORD_LEN: usize = 72;
const RESULT_HEADER_LEN: usize = 8;
const FLAG_TEXT: u32 = 1;
const FLAG_LINKS: u32 = 2;
const FLAG_PAGE_INDEXES: u32 = 4;
const FLAG_MARKDOWN: u32 = 8;
const FLAG_DROP_RUNNING: u32 = 16;
const FLAG_RUNS: u32 = 32;
const FLAG_OCR_TABLES: u32 = 64;
const STATUS_OK: u32 = 0;
const TEXT_MAGIC: u32 = 0x5854_4450;
const TEXT_VERSION: u32 = 1;
const TEXT_HEADER_LEN: usize = 16;
const DIAGNOSTICS_MAGIC: u32 = 0x4744_4450;
const DIAGNOSTICS_VERSION: u32 = 1;
const DIAGNOSTICS_HEADER_LEN: usize = 16;
const DIAGNOSTICS_RECORD_LEN: usize = 48;
const TABLES_MAGIC: u32 = 0x4254_4450;
const TABLES_VERSION: u32 = 1;
const TABLES_HEADER_LEN: usize = 16;
const TABLE_RECORD_LEN: usize = 48;
const CELL_RECORD_LEN: usize = 56;
const RENDER_MAGIC: u32 = 0x4C52_4450;
const RENDER_VERSION: u32 = 1;
const RENDER_HEADER_LEN: usize = 16;
const RENDER_PAGE_HEADER_LEN: usize = 56;
const ALIGNMENT: usize = 8;
const SIGNATURES_MAGIC: u32 = 0x4753_4450;
const SIGNATURES_VERSION: u32 = 2;
const SIGNATURE_RECORD_LEN: usize = 80;
const DOCUMENT_MAGIC: u32 = 0x4944_4450;
const DOCUMENT_VERSION: u32 = 2;
const DOCUMENT_PAGE_RECORD_LEN: usize = 80;
const DOCUMENT_ANNOTATION_RECORD_LEN: usize = 72;
const MERGE_DROP_WIDGETS: u32 = 1;
const MERGE_OBJECT_STREAMS: u32 = 2;
const ALL_PAGES: u32 = u32::MAX;
const METRICS_MAGIC: u32 = 0x4d46_4450;
const METRICS_VERSION: u32 = 1;

type MergeRequest<'data> = (Vec<&'data [u8]>, Vec<Option<Vec<u32>>>);

struct Writer {
    capacity: usize,
    data: *mut u8,
    failed: bool,
    len: usize,
}

impl Writer {
    fn align(&mut self) {
        let remainder = self.payload_len() & (ALIGNMENT - 1);
        if remainder != 0 {
            let zeros = [0_u8; ALIGNMENT];
            self.bytes(zeros.get(remainder..).unwrap_or_default());
        }
    }

    fn boxed(&mut self, rect: &[f64; 4]) {
        for value in rect {
            self.f64(*value);
        }
    }

    fn bytes(&mut self, bytes: &[u8]) {
        if self.failed {
            return;
        }
        let Some(needed) = self.len.checked_add(bytes.len()) else {
            self.failed = true;
            return;
        };
        if needed > self.capacity && !self.grow(needed) {
            return;
        }
        let tail = self.data.wrapping_add(self.len);
        // SAFETY: the block holds `capacity >= needed` bytes, so `bytes` fits at `len`, and Rust-owned `bytes` cannot overlap it.
        unsafe { ptr::copy_nonoverlapping(bytes.as_ptr(), tail, bytes.len()) };
        self.len = needed;
    }

    fn done(self) -> Outcome<Self> {
        if self.failed {
            return Err(Failure::limit("result allocation failed"));
        }
        let _: u32 = len32(self.len)?;
        Ok(self)
    }

    fn f64(&mut self, value: f64) {
        self.bytes(&value.to_le_bytes());
    }

    fn grow(&mut self, needed: usize) -> bool {
        let target = needed.max(self.capacity.saturating_mul(2));
        let (Some(current), Some(_)) = (block_layout(self.capacity), block_layout(target)) else {
            self.failed = true;
            return false;
        };
        // SAFETY: `data` was allocated with `current`, and `target` is a valid non-zero size for the same alignment.
        let grown = unsafe { realloc(self.data, current, target) };
        if grown.is_null() {
            self.failed = true;
            return false;
        }
        self.data = grown;
        self.capacity = target;
        true
    }

    fn i32(&mut self, value: i32) {
        self.bytes(&value.to_le_bytes());
    }

    fn patch_u32(&mut self, at: usize, value: u32) {
        if let Some(slot) = at
            .checked_add(4)
            .and_then(|end| self.payload_mut().get_mut(at..end))
        {
            slot.copy_from_slice(&value.to_le_bytes());
        }
    }

    #[cfg(test)]
    fn payload(mut self) -> Vec<u8> {
        self.payload_mut().to_vec()
    }

    const fn payload_len(&self) -> usize {
        self.len.saturating_sub(RESULT_HEADER_LEN)
    }

    const fn payload_mut(&mut self) -> &mut [u8] {
        if self.failed || self.data.is_null() {
            return &mut [];
        }
        let start = self.data.wrapping_add(RESULT_HEADER_LEN);
        // SAFETY: the block holds `len` initialised bytes owned by this writer, and the payload follows the header.
        unsafe { slice::from_raw_parts_mut(start, self.payload_len()) }
    }

    fn publish(mut self, status: u32) -> *mut u8 {
        let Ok(total) = u32::try_from(self.len) else {
            return ptr::null_mut();
        };
        if self.failed {
            return ptr::null_mut();
        }
        if self.capacity != self.len {
            let Some(current) = block_layout(self.capacity) else {
                return ptr::null_mut();
            };
            // SAFETY: `data` was allocated with `current`, and `len >= RESULT_HEADER_LEN` is non-zero.
            let shrunk = unsafe { realloc(self.data, current, self.len) };
            if shrunk.is_null() {
                return ptr::null_mut();
            }
            self.data = shrunk;
            self.capacity = self.len;
        }
        let mut header = [0_u8; RESULT_HEADER_LEN];
        let (total_field, status_field) = header.split_at_mut(4);
        total_field.copy_from_slice(&total.to_le_bytes());
        status_field.copy_from_slice(&status.to_le_bytes());
        // SAFETY: the block holds at least `RESULT_HEADER_LEN` bytes, and `header` is a distinct local array.
        unsafe { ptr::copy_nonoverlapping(header.as_ptr(), self.data, RESULT_HEADER_LEN) };
        mem::replace(&mut self.data, ptr::null_mut())
    }

    fn u32(&mut self, value: u32) {
        self.bytes(&value.to_le_bytes());
    }

    fn with_capacity(payload: usize) -> Self {
        let capacity = payload.saturating_add(RESULT_HEADER_LEN);
        let data = block_layout(capacity).map_or(ptr::null_mut(), |layout| {
            // SAFETY: `block_layout` never yields a zero-sized layout.
            unsafe { alloc(layout) }
        });
        Self {
            data,
            len: RESULT_HEADER_LEN,
            capacity,
            failed: data.is_null(),
        }
    }
}

impl Drop for Writer {
    fn drop(&mut self) {
        if self.data.is_null() {
            return;
        }
        if let Some(layout) = block_layout(self.capacity) {
            // SAFETY: `data` is still owned by this writer and was allocated with this layout.
            unsafe { dealloc(self.data, layout) };
        }
    }
}

struct Request<'data> {
    flags: u32,
    pages: Option<&'data [u32]>,
    pdf: &'data [u8],
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
        Ok(Self { flags, pages, pdf })
    }

    const fn has(&self, flag: u32) -> bool {
        self.flags & flag != 0
    }
}

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

fn encode(inspection: &Inspection) -> Outcome<Writer> {
    let page_count = len32(inspection.pages.len())?;
    let link_count = len32(inspection.links.len())?;
    let text_page_count = len32(inspection.text.len())?;
    let mut out = Writer::with_capacity(
        HEADER_LEN.saturating_add(inspection.pages.len().saturating_mul(PAGE_RECORD_LEN)),
    );
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

    let links_offset = len32(out.payload_len())?;
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
        out.bytes(link.uri.as_bytes());
    }
    out.align();

    let text_offset = len32(out.payload_len())?;
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
                .checked_add(len32(item.text.encode_utf16().count())?)
                .ok_or_else(|| Failure::limit("page text exceeds the size limit"))?;
            out.u32(cursor);
        }
        out.align();
        for item in &page.items {
            out.bytes(&[item.style]);
        }
        out.align();
        for item in &page.items {
            out.bytes(item.text.as_bytes());
        }
        out.align();
    }

    let _: usize = padded(out.payload_len())?;
    out.done()
}

fn encode_text(pages: &[String]) -> Outcome<Writer> {
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
    let mut out = Writer::with_capacity(capacity);
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
        out.bytes(page.as_bytes());
    }
    out.align();
    out.done()
}

fn encode_diagnostics(pages: &[PageDiagnostics]) -> Outcome<Writer> {
    let mut out = Writer::with_capacity(
        DIAGNOSTICS_HEADER_LEN.saturating_add(pages.len().saturating_mul(DIAGNOSTICS_RECORD_LEN)),
    );
    out.u32(DIAGNOSTICS_MAGIC);
    out.u32(DIAGNOSTICS_VERSION);
    out.u32(len32(pages.len())?);
    out.u32(0);
    for page in pages {
        out.u32(page.page_index);
        out.u32(page.glyphs);
        out.u32(page.unmapped);
        out.u32(page.replacement);
        out.u32(page.invisible);
        out.u32(page.visible_chars);
        out.u32(page.image_count);
        out.u32(match page.text_layer {
            TextLayer::None => 0,
            TextLayer::Weak => 1,
            TextLayer::Usable => 2,
        });
        out.f64(page.text_area);
        out.f64(page.raster_coverage);
    }
    out.done()
}

fn encode_tables(tables: &[Table]) -> Outcome<Writer> {
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
            let cells = cell_count.checked_mul(CELL_RECORD_LEN)?;
            bytes.checked_add(cells)
        })
        .ok_or_else(|| Failure::limit("result size overflow"))?;
    let capacity = TABLES_HEADER_LEN
        .checked_add(records)
        .and_then(|sum| sum.checked_add(text_len))
        .and_then(|sum| sum.checked_add(ALIGNMENT))
        .ok_or_else(|| Failure::limit("result size overflow"))?;
    let mut out = Writer::with_capacity(capacity);
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
            out.bytes(cell.text.as_bytes());
        }
    }
    out.align();
    out.done()
}

fn encode_render(pages: &[RenderedPage]) -> Outcome<Writer> {
    let mut capacity = RENDER_HEADER_LEN;
    for page in pages {
        capacity = capacity
            .saturating_add(RENDER_PAGE_HEADER_LEN)
            .saturating_add(padded(page.list.ops.len())?)
            .saturating_add(padded(page.list.blobs.len().saturating_mul(8))?)
            .saturating_add(page.list.blob_bytes)
            .saturating_add(page.list.blobs.len().saturating_mul(ALIGNMENT));
    }
    let mut out = Writer::with_capacity(capacity);
    out.u32(RENDER_MAGIC);
    out.u32(RENDER_VERSION);
    out.u32(len32(pages.len())?);
    out.u32(0);
    for page in pages {
        let start = out.payload_len();
        out.u32(page.page_index);
        out.i32(page.rotate);
        out.u32(len32(page.list.ops.len())?);
        out.u32(len32(page.list.blobs.len())?);
        out.boxed(&page.view);
        out.u32(0);
        out.u32(0);
        out.bytes(&page.list.ops);
        out.align();
        let mut cursor = 0_usize;
        for blob in &page.list.blobs {
            out.u32(len32(cursor)?);
            out.u32(len32(blob.len())?);
            cursor = cursor.saturating_add(padded(blob.len())?);
        }
        out.align();
        for blob in &page.list.blobs {
            out.bytes(blob);
            out.align();
        }
        let section = len32(out.payload_len().saturating_sub(start))?;
        out.patch_u32(start.saturating_add(48), section);
    }
    out.done()
}

fn finish(outcome: Outcome<Writer>) -> *mut u8 {
    match outcome {
        Ok(writer) => writer.publish(STATUS_OK),
        Err(failure) => {
            let mut writer = Writer::with_capacity(failure.reason.len());
            writer.bytes(failure.reason.as_bytes());
            writer.publish(u32::from(failure.code))
        }
    }
}

/// # Safety
///
/// `data` must be null or valid for reads of `len` initialised elements that stay unmodified for `'data`.
unsafe fn view<'data, T>(data: *const T, len: usize) -> Outcome<&'data [T]> {
    if len == 0 || data.is_null() {
        return Ok(&[]);
    }
    if !data.is_aligned() {
        return Err(Failure::invalid("misaligned input buffer"));
    }
    // SAFETY: non-null, aligned, and valid for `len` elements by the caller contract.
    Ok(unsafe { slice::from_raw_parts(data, len) })
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
    finish(request.and_then(|inner_request| {
        let options = InspectOptions {
            text: inner_request.has(FLAG_TEXT),
            links: inner_request.has(FLAG_LINKS),
            page_indexes: inner_request.pages.map(<[u32]>::to_vec),
            runs: inner_request.has(FLAG_RUNS),
        };
        let inspection = document::inspect(inner_request.pdf, &options, &layout::text_limits())?;
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
    finish(request.and_then(|inner_request| {
        let options = TextOptions {
            markdown: inner_request.has(FLAG_MARKDOWN),
            drop_running: inner_request.has(FLAG_DROP_RUNNING),
        };
        let pages = layout::document_text(
            inner_request.pdf,
            inner_request.pages,
            &layout::text_limits(),
            options,
            None,
        )?;
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
    finish(request.and_then(|inner_request| {
        let tables = layout::document_tables(
            inner_request.pdf,
            inner_request.pages,
            &layout::text_limits(),
            None,
        )?;
        encode_tables(&tables)
    }))
}

#[unsafe(no_mangle)]
pub(crate) unsafe extern "C" fn pdf_core_page_diagnostics(
    pdf_ptr: *const u8,
    pdf_len: usize,
    flags: u32,
    pages_ptr: *const u32,
    pages_len: usize,
) -> *mut u8 {
    // SAFETY: forwarded from this function's contract.
    let request = unsafe { Request::from_raw(pdf_ptr, pdf_len, flags, pages_ptr, pages_len) };
    finish(request.and_then(|inner_request| {
        let limits = layout::text_limits();
        let document = document::Document::open(inner_request.pdf, &limits)?;
        let pages = document.pages()?;
        let selected = select_pages(pages.len(), inner_request.pages)?;
        encode_diagnostics(&opened_diagnostics(
            &document,
            &pick_pages(&pages, selected),
            &limits,
        )?)
    }))
}

/// # Safety
///
/// The PDF, page indexes and OCR payload must remain readable for the duration of the call.
#[unsafe(no_mangle)]
pub(crate) unsafe extern "C" fn pdf_core_extract_ocr(
    pdf_ptr: *const u8,
    pdf_len: usize,
    flags: u32,
    pages_ptr: *const u32,
    pages_len: usize,
    ocr_ptr: *const u8,
    ocr_len: usize,
) -> *mut u8 {
    // SAFETY: the caller supplies valid readable buffers for this call.
    let input = unsafe { Request::from_raw(pdf_ptr, pdf_len, flags, pages_ptr, pages_len) };
    // SAFETY: the caller supplies a valid readable payload for this call.
    let payload = unsafe { view(ocr_ptr, ocr_len) };
    finish(input.and_then(|request| {
        let limits = layout::text_limits();
        let replacements = ocr::decode(payload?, &limits)?;
        if request.has(FLAG_OCR_TABLES) {
            return encode_tables(&layout::document_tables(
                request.pdf,
                request.pages,
                &limits,
                Some(&replacements),
            )?);
        }
        encode_text(&layout::document_text(
            request.pdf,
            request.pages,
            &limits,
            TextOptions {
                markdown: request.has(FLAG_MARKDOWN),
                drop_running: request.has(FLAG_DROP_RUNNING),
            },
            Some(&replacements),
        )?)
    }))
}

fn bytes_result(bytes: &[u8]) -> Outcome<Writer> {
    let mut out = Writer::with_capacity(bytes.len());
    out.bytes(bytes);
    out.done()
}

fn encode_document(info: &DocumentInfo) -> Outcome<Writer> {
    let (name_flags, failure, name): (u32, u32, &[u8]) = match &info.field_name {
        None => (0, 0, &[]),
        Some(Ok(found)) => (2, 0, found.as_bytes()),
        Some(Err(code)) => (4, *code, &[]),
    };
    let uri_total = info
        .annotations
        .iter()
        .filter_map(|annotation| annotation.uri.as_ref())
        .fold(0_usize, |total, uri| total.saturating_add(uri.len()));
    let mut out = Writer::with_capacity(
        HEADER_LEN
            .saturating_add(info.pages.len().saturating_mul(DOCUMENT_PAGE_RECORD_LEN))
            .saturating_add(
                info.annotations
                    .len()
                    .saturating_mul(DOCUMENT_ANNOTATION_RECORD_LEN),
            )
            .saturating_add(uri_total)
            .saturating_add(name.len())
            .saturating_add(ALIGNMENT),
    );
    out.u32(DOCUMENT_MAGIC);
    out.u32(DOCUMENT_VERSION);
    out.u32(len32(info.pages.len())?);
    out.u32(len32(info.annotations.len())?);
    out.u32(info.next_object_number);
    out.u32(u32::from(info.acro_form) | name_flags);
    out.u32(failure);
    out.u32(len32(name.len())?);
    for page in &info.pages {
        out.boxed(&page.info.media_box);
        out.boxed(&page.info.crop_box);
        out.i32(page.info.rotate);
        out.u32(page.reference.map_or(0, |found| found.number));
        out.u32(
            page.reference
                .map_or(0, |found| u32::from(found.generation)),
        );
        out.u32(page.annotation_count);
    }
    let mut uri_offset = 0_usize;
    for annotation in &info.annotations {
        let (slot, first, second) = match annotation.slot {
            Slot::None => (0, 0, 0),
            Slot::Open(FieldTarget::Widget) => (1, 0, 0),
            Slot::Open(FieldTarget::Ref(found)) => (2, found.number, u32::from(found.generation)),
            Slot::Open(FieldTarget::WidgetParent) => (3, 0, 0),
            Slot::Malformed(code) => (4, code, 0),
        };
        out.u32(annotation.page_index);
        out.u32(annotation.index);
        out.u32(annotation.reference.map_or(0, |found| found.number));
        out.u32(
            annotation
                .reference
                .map_or(0, |found| u32::from(found.generation)),
        );
        out.u32(
            u32::from(annotation.widget)
                | (u32::from(annotation.rect.is_some()) << 1_i32)
                | (u32::from(annotation.titled) << 2_i32)
                | (u32::from(annotation.uri.is_some()) << 3_i32),
        );
        out.u32(slot);
        out.u32(first);
        out.u32(second);
        out.boxed(&annotation.rect.unwrap_or_default());
        let uri_len = annotation.uri.as_ref().map_or(0, String::len);
        out.u32(len32(uri_offset)?);
        out.u32(len32(uri_len)?);
        uri_offset = uri_offset.saturating_add(uri_len);
    }
    for uri in info
        .annotations
        .iter()
        .filter_map(|annotation| annotation.uri.as_ref())
    {
        out.bytes(uri.as_bytes());
    }
    out.bytes(name);
    out.align();
    out.done()
}

fn encode_signatures(report: &Report) -> Outcome<Writer> {
    let flags = u32::from(report.flags.parse_failed)
        | (u32::from(report.flags.stream_failed) << 1_i32)
        | (u32::from(report.flags.stream_uncertain) << 2_i32)
        | (u32::from(report.flags.limit) << 3_i32);
    let mut sub_filter_offset = 24_usize.saturating_add(
        report
            .dictionaries
            .len()
            .saturating_mul(SIGNATURE_RECORD_LEN),
    );
    let mut out = Writer::with_capacity(sub_filter_offset);
    out.u32(SIGNATURES_MAGIC);
    out.u32(SIGNATURES_VERSION);
    out.u32(report.failure.map_or(0, u32::from));
    out.u32(flags);
    out.u32(len32(report.dictionaries.len())?);
    out.u32(0);
    let saturate = |value: usize| u32::try_from(value).unwrap_or(u32::MAX);
    for dictionary in &report.dictionaries {
        let byte_range = dictionary.byte_range;
        let contents = dictionary.contents;
        let record_flags = u32::from(dictionary.timestamp)
            | (u32::from(byte_range.is_some()) << 1_i32)
            | (u32::from(contents.is_some()) << 2_i32)
            | (u32::from(dictionary.byte_range_values.is_some()) << 3_i32)
            | (u32::from(dictionary.unsigned_placeholder) << 4_i32);
        out.u32(u32::try_from(dictionary.number).unwrap_or(u32::MAX));
        out.u32(u32::try_from(dictionary.generation).unwrap_or(u32::MAX));
        out.u32(saturate(dictionary.object_start));
        out.u32(record_flags);
        for span in [byte_range, contents] {
            out.u32(span.map_or(0, |found| saturate(found.key_start)));
            out.u32(span.map_or(0, |found| saturate(found.value_start)));
            out.u32(span.map_or(0, |found| saturate(found.value_end)));
        }
        out.boxed(&dictionary.byte_range_values.unwrap_or_default());
        if let Some(name) = &dictionary.sub_filter {
            out.u32(len32(sub_filter_offset)?);
            out.u32(len32(name.len())?);
            sub_filter_offset = sub_filter_offset.saturating_add(name.len());
        } else {
            out.u32(0);
            out.u32(0);
        }
    }
    for name in report
        .dictionaries
        .iter()
        .filter_map(|dictionary| dictionary.sub_filter.as_ref())
    {
        out.bytes(name.as_bytes());
    }
    out.align();
    out.done()
}

fn merge_request(payload: &[u8]) -> Outcome<MergeRequest<'_>> {
    let mut cursor = 0_usize;
    let next = |position: &mut usize| -> Outcome<u32> {
        let end = position.saturating_add(4);
        let raw = payload
            .get(*position..end)
            .and_then(|slice| <[u8; 4]>::try_from(slice).ok())
            .ok_or_else(|| Failure::request("merge payload is truncated"))?;
        *position = end;
        Ok(u32::from_le_bytes(raw))
    };
    let count = next(&mut cursor)?;
    let mut lengths: Vec<usize> = Vec::new();
    let mut selections: Vec<Option<Vec<u32>>> = Vec::new();
    for _ in 0..count {
        lengths.push(widen(next(&mut cursor)?));
        let pages = next(&mut cursor)?;
        if pages == ALL_PAGES {
            selections.push(None);
            continue;
        }
        let mut chosen = Vec::new();
        for _ in 0..pages {
            chosen.push(next(&mut cursor)?);
        }
        selections.push(Some(chosen));
    }
    let mut sources: Vec<&[u8]> = Vec::with_capacity(lengths.len());
    for length in lengths {
        let end = cursor
            .checked_add(length)
            .ok_or_else(|| Failure::request("merge payload overflow"))?;
        sources.push(
            payload
                .get(cursor..end)
                .ok_or_else(|| Failure::request("merge payload is truncated"))?,
        );
        cursor = end;
    }
    if cursor != payload.len() {
        return Err(Failure::request("merge payload has trailing bytes"));
    }
    Ok((sources, selections))
}

/// # Safety
///
/// `data_ptr` must satisfy [`view`] for `data_len` until the call returns.
#[unsafe(no_mangle)]
pub(crate) unsafe extern "C" fn pdf_core_deflate(data_ptr: *const u8, data_len: usize) -> *mut u8 {
    // SAFETY: forwarded from this function's contract.
    let data = unsafe { view(data_ptr, data_len) };
    finish(data.and_then(|bytes| bytes_result(&zlib_compress(bytes))))
}

/// # Safety
///
/// `sizes_ptr` must satisfy [`view`] for `sizes_len` `f64` values until the call returns.
#[unsafe(no_mangle)]
pub(crate) unsafe extern "C" fn pdf_core_create(
    sizes_ptr: *const f64,
    sizes_len: usize,
) -> *mut u8 {
    // SAFETY: forwarded from this function's contract.
    let sizes = unsafe { view(sizes_ptr, sizes_len) };
    finish(sizes.and_then(|values| {
        let (pairs, rest) = values.as_chunks::<2>();
        if !rest.is_empty() {
            return Err(Failure::request(
                "page sizes come in width and height pairs",
            ));
        }
        bytes_result(&create(pairs)?)
    }))
}

/// # Safety
///
/// `name_ptr` must satisfy [`view`] for `name_len` until the call returns.
#[unsafe(no_mangle)]
pub(crate) unsafe extern "C" fn pdf_core_font_metrics(
    name_ptr: *const u8,
    name_len: usize,
) -> *mut u8 {
    // SAFETY: forwarded from this function's contract.
    let name = unsafe { view(name_ptr, name_len) };
    finish(name.and_then(|base_font| {
        let font = Standard14Font::named(base_font)
            .ok_or_else(|| Failure::request("not a standard 14 font with WinAnsi encoding"))?;
        let mut out = Writer::with_capacity(1032);
        out.u32(METRICS_MAGIC);
        out.u32(METRICS_VERSION);
        for (code, width) in (0_u8..=u8::MAX).zip(font.widths()) {
            let unicode = win_ansi_unicode(code);
            out.bytes(&unicode.to_le_bytes());
            out.bytes(&if unicode == 0 { 0 } else { *width }.to_le_bytes());
        }
        out.done()
    }))
}

/// # Safety
///
/// `png_ptr` must satisfy [`view`] for `png_len` until the call returns.
#[unsafe(no_mangle)]
pub(crate) unsafe extern "C" fn pdf_core_png_size(png_ptr: *const u8, png_len: usize) -> *mut u8 {
    // SAFETY: forwarded from this function's contract.
    let png = unsafe { view(png_ptr, png_len) };
    finish(png.and_then(|bytes| {
        let image = png::decode(bytes)?;
        let mut out = Writer::with_capacity(8);
        out.u32(image.width);
        out.u32(image.height);
        out.done()
    }))
}

/// # Safety
///
/// `pdf_ptr`, `pages_ptr` and `prefix_ptr` must satisfy [`view`] for their lengths until the call returns.
#[unsafe(no_mangle)]
pub(crate) unsafe extern "C" fn pdf_core_document(
    pdf_ptr: *const u8,
    pdf_len: usize,
    flags: u32,
    pages_ptr: *const u32,
    pages_len: usize,
    prefix_ptr: *const u8,
    prefix_len: usize,
) -> *mut u8 {
    // SAFETY: forwarded from this function's contract.
    let request = unsafe { Request::from_raw(pdf_ptr, pdf_len, flags, pages_ptr, pages_len) };
    // SAFETY: forwarded from this function's contract.
    let prefix = unsafe { view(prefix_ptr, prefix_len) };
    finish(request.and_then(|inner_request| {
        let info = document_info(
            inner_request.pdf,
            inner_request.pages,
            prefix?,
            &Limits::default(),
        )?;
        encode_document(&info)
    }))
}

/// # Safety
///
/// `pdf_ptr` and `ops_ptr` must satisfy [`view`] for their lengths until the call returns.
#[unsafe(no_mangle)]
pub(crate) unsafe extern "C" fn pdf_core_edit(
    pdf_ptr: *const u8,
    pdf_len: usize,
    ops_ptr: *const u8,
    ops_len: usize,
) -> *mut u8 {
    // SAFETY: forwarded from this function's contract.
    let pdf = unsafe { view(pdf_ptr, pdf_len) };
    // SAFETY: forwarded from this function's contract.
    let ops = unsafe { view(ops_ptr, ops_len) };
    finish(pdf.and_then(|document| {
        let output = edit(document, ops?, &Limits::default())?;
        bytes_result(&output)
    }))
}

/// # Safety
///
/// `payload_ptr` must satisfy [`view`] for `payload_len` until the call returns.
#[unsafe(no_mangle)]
pub(crate) unsafe extern "C" fn pdf_core_merge(
    payload_ptr: *const u8,
    payload_len: usize,
    flags: u32,
) -> *mut u8 {
    // SAFETY: forwarded from this function's contract.
    let payload = unsafe { view(payload_ptr, payload_len) };
    finish(payload.and_then(|bytes| {
        let (sources, selections) = merge_request(bytes)?;
        let layout = if flags & MERGE_OBJECT_STREAMS == 0 {
            Packing::Classic
        } else {
            Packing::ObjectStreams
        };
        let output = merge(
            &sources,
            &selections,
            flags & MERGE_DROP_WIDGETS != 0,
            layout,
            &Limits::default(),
        )?;
        bytes_result(&output)
    }))
}

/// # Safety
///
/// `pdf_ptr` must satisfy [`view`] for `pdf_len` until the call returns.
#[unsafe(no_mangle)]
pub(crate) unsafe extern "C" fn pdf_core_revision_complete(
    pdf_ptr: *const u8,
    pdf_len: usize,
    end: usize,
) -> u32 {
    // SAFETY: forwarded from this function's contract.
    let pdf = unsafe { view(pdf_ptr, pdf_len) };
    pdf.map_or(0, |bytes| u32::from(revision_complete(bytes, end)))
}

/// # Safety
///
/// `pdf_ptr` must satisfy [`view`] for `pdf_len` until the call returns.
#[unsafe(no_mangle)]
pub(crate) unsafe extern "C" fn pdf_core_signatures(
    pdf_ptr: *const u8,
    pdf_len: usize,
    mode: u32,
) -> *mut u8 {
    // SAFETY: forwarded from this function's contract.
    let pdf = unsafe { view(pdf_ptr, pdf_len) };
    finish(pdf.and_then(|bytes| {
        let analysis = match mode {
            0 => Analysis::Scan,
            1 => Analysis::Dictionaries,
            2 => Analysis::Verification,
            _ => return Err(Failure::request("unknown signature analysis mode")),
        };
        encode_signatures(&analyze(bytes, analysis))
    }))
}

/// # Safety
///
/// `pdf_ptr` and `pages_ptr` must satisfy [`view`] for their lengths until the call returns.
#[unsafe(no_mangle)]
pub(crate) unsafe extern "C" fn pdf_core_render(
    pdf_ptr: *const u8,
    pdf_len: usize,
    flags: u32,
    pages_ptr: *const u32,
    pages_len: usize,
    scale: f64,
) -> *mut u8 {
    // SAFETY: forwarded from this function's contract.
    let request = unsafe { Request::from_raw(pdf_ptr, pdf_len, flags, pages_ptr, pages_len) };
    finish(request.and_then(|inner_request| {
        let pages = render::render_pages(
            inner_request.pdf,
            inner_request.pages,
            scale,
            &Limits::default(),
        )?;
        encode_render(&pages)
    }))
}

std::thread_local! {
    static LAZY_DOCUMENTS: RefCell<Vec<(u32, Lazy)>> = const { RefCell::new(Vec::new()) };
    static NEXT_LAZY_HANDLE: Cell<u32> = const { Cell::new(1) };
}

#[unsafe(no_mangle)]
pub(crate) extern "C" fn pdf_core_lazy_open(
    size: usize,
    probe: usize,
    gap: usize,
    round_bytes: usize,
) -> u32 {
    if size > Limits::default().max_pdf_bytes {
        return 0;
    }
    NEXT_LAZY_HANDLE.with(|next| {
        let handle = next.get();
        if handle != 0 {
            next.set(handle.checked_add(1).unwrap_or(0));
            LAZY_DOCUMENTS.with(|documents| {
                documents.borrow_mut().push((
                    handle,
                    Lazy::new(
                        size,
                        Tuning {
                            gap,
                            probe,
                            round_bytes,
                        },
                    ),
                ));
            });
        }
        handle
    })
}

#[unsafe(no_mangle)]
pub(crate) extern "C" fn pdf_core_lazy_close(handle: u32) {
    LAZY_DOCUMENTS.with(|documents| {
        let mut all = documents.borrow_mut();
        if let Some(position) = all.iter().position(|(id, _)| *id == handle) {
            drop(all.swap_remove(position));
        }
    });
}

/// # Safety
///
/// `data` must satisfy [`view`] for `length` until the call returns.
#[unsafe(no_mangle)]
pub(crate) unsafe extern "C" fn pdf_core_lazy_feed(
    handle: u32,
    offset: usize,
    data: *const u8,
    length: usize,
) -> u32 {
    // SAFETY: forwarded from this function's contract.
    let supplied = unsafe { view(data, length) };
    LAZY_DOCUMENTS.with(|documents| {
        let mut all = documents.borrow_mut();
        match (
            all.iter_mut()
                .find(|(id, _)| *id == handle)
                .map(|(_, document)| document),
            supplied,
        ) {
            (Some(document), Ok(bytes)) => u32::from(document.feed(offset, bytes)),
            (None, _) | (Some(_), Err(_)) => 0,
        }
    })
}

fn encode_plan(plan: Plan) -> Outcome<Writer> {
    let mut out = Writer::with_capacity(4);
    match plan {
        Plan::Ready => out.u32(0),
        Plan::Fallback => out.u32(2),
        Plan::Need(ranges) => {
            out.u32(1);
            for range in ranges {
                out.u32(len32(range.start)?);
                out.u32(len32(range.end.saturating_sub(range.start))?);
            }
        }
    }
    out.done()
}

/// # Safety
///
/// `pages_ptr` must satisfy [`view`] for `pages_len` until the call returns.
#[unsafe(no_mangle)]
pub(crate) unsafe extern "C" fn pdf_core_lazy_plan(
    handle: u32,
    flags: u32,
    pages_ptr: *const u32,
    pages_len: usize,
    profile: u32,
) -> *mut u8 {
    // SAFETY: forwarded from this function's contract.
    let pages = unsafe { view(pages_ptr, pages_len) };
    finish(pages.and_then(|indexes| {
        LAZY_DOCUMENTS.with(|documents| {
            let mut all = documents.borrow_mut();
            let document = all
                .iter_mut()
                .find(|(id, _)| *id == handle)
                .map(|(_, document)| document)
                .ok_or_else(|| Failure::invalid("invalid lazy handle"))?;
            let limits = lazy_limits(profile);
            let plan = document.plan(
                (flags & FLAG_PAGE_INDEXES != 0).then_some(indexes),
                profile == 2,
                &limits,
            );
            encode_plan(plan)
        })
    }))
}

fn lazy_limits(profile: u32) -> Limits {
    if profile == 2 {
        Limits::default()
    } else {
        layout::text_limits()
    }
}

#[unsafe(no_mangle)]
pub(crate) extern "C" fn pdf_core_lazy_run(
    handle: u32,
    profile: u32,
    flags: u32,
    scale: f64,
) -> *mut u8 {
    finish(lazy_run(handle, profile, flags, scale, None))
}

/// # Safety
///
/// The OCR payload must remain readable for the duration of the call.
#[unsafe(no_mangle)]
pub(crate) unsafe extern "C" fn pdf_core_lazy_run_ocr(
    handle: u32,
    profile: u32,
    flags: u32,
    ocr_ptr: *const u8,
    ocr_len: usize,
) -> *mut u8 {
    // SAFETY: the caller supplies a valid readable payload for this call.
    let replacements = unsafe { view(ocr_ptr, ocr_len) }
        .and_then(|bytes| ocr::decode(bytes, &layout::text_limits()));
    finish(replacements.and_then(|pages| lazy_run(handle, profile, flags, 1.0, Some(&pages))))
}

#[inline(never)]
fn lazy_run(
    handle: u32,
    profile: u32,
    flags: u32,
    scale: f64,
    ocr: Option<&layout::OcrPages>,
) -> Outcome<Writer> {
    LAZY_DOCUMENTS.with(|documents| {
        let all = documents.borrow();
        let lazy = all
            .iter()
            .find(|(id, _)| *id == handle)
            .map(|(_, document)| document)
            .ok_or_else(|| Failure::invalid("invalid lazy handle"))?;
        let limits = lazy_limits(profile);
        let payload = lazy.execute(&limits, |document, pages| match profile {
            0 => encode_text(&layout::opened_text(
                document,
                pages,
                &limits,
                TextOptions {
                    markdown: flags & FLAG_MARKDOWN != 0,
                    drop_running: flags & FLAG_DROP_RUNNING != 0,
                },
                ocr,
            )?),
            1 => encode_tables(&layout::opened_tables(document, pages, &limits, ocr)?),
            2 => encode_render(&render::opened_render(document, pages, scale, &limits)?),
            3 => encode_diagnostics(&opened_diagnostics(document, pages, &limits)?),
            _ => Err(Failure::invalid("invalid lazy profile")),
        })?;
        payload.map_or_else(
            || {
                if lazy.needs_ranges() {
                    bytes_result(&1_u32.to_le_bytes())
                } else {
                    bytes_result(&[])
                }
            },
            Ok,
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::failure::FailureCode;
    use crate::inspection::{LinkInfo, PageInfo, PageText, TextItem};
    use crate::test_pdf::assert_exact;
    use crate::test_pdf::document;
    use crate::test_pdf::page;
    use core::fmt::Write as _;
    use core::iter;

    const LINKS_PDF: &[u8] = include_bytes!("../../__tests__/fixtures/links.pdf");

    const ROTATED_PDF: &[u8] = include_bytes!("../../__tests__/fixtures/rotated-cropped.pdf");

    struct Reader<'data> {
        at: usize,
        data: &'data [u8],
    }

    impl<'data> Reader<'data> {
        fn align(&mut self) {
            self.at = (self.at.saturating_add(7)) & !7;
        }

        fn f64(&mut self) -> f64 {
            f64::from_le_bytes(self.take(8).try_into().unwrap_or([0; 8]))
        }

        fn i32(&mut self) -> i32 {
            i32::from_le_bytes(self.take(4).try_into().unwrap_or([0; 4]))
        }

        fn rect(&mut self) -> [f64; 4] {
            [self.f64(), self.f64(), self.f64(), self.f64()]
        }

        fn take(&mut self, len: usize) -> &'data [u8] {
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
    }

    struct Block {
        payload: Vec<u8>,
        ptr: *mut u8,
        status: u32,
        total: usize,
    }

    type Entry = unsafe extern "C" fn(*const u8, usize, u32, *const u32, usize) -> *mut u8;

    struct DecodedCell {
        bbox: [f64; 4],
        col: u32,
        row: u32,
        spans: (u32, u32),
        text: String,
    }

    struct DecodedTable {
        bbox: [f64; 4],
        cells: Vec<DecodedCell>,
        cols: u32,
        page_index: u32,
        rows: u32,
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
        assert_eq!(pages_offset & 7, 0);
        assert_eq!(links_offset & 7, 0);
        assert_eq!(text_offset & 7, 0);
        assert_eq!(
            links_offset,
            pages_offset.saturating_add((widen(page_count)).saturating_mul(PAGE_RECORD_LEN))
        );
        let pages = iter::repeat_with(|| {
            let media_box = reader.rect();
            let crop_box = reader.rect();
            let rotate = reader.i32();
            let _: u32 = reader.u32();
            PageInfo {
                crop_box,
                media_box,
                rotate,
            }
        })
        .take(widen(page_count))
        .collect();
        assert_eq!(reader.at, links_offset);
        let records: Vec<_> = iter::repeat_with(|| {
            let rect = reader.rect();
            let page_index = reader.u32();
            let start = widen(reader.u32());
            let len = widen(reader.u32());
            let _: u32 = reader.u32();
            (rect, page_index, start, len)
        })
        .take(widen(link_count))
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
        let text = iter::repeat_with(|| {
            let page_index = reader.u32();
            let item_count = widen(reader.u32());
            let text_len = widen(reader.u32());
            let _: u32 = reader.u32();
            let rects: Vec<([f64; 4], f64)> = iter::repeat_with(|| {
                let rect = reader.rect();
                (rect, reader.f64())
            })
            .take(item_count)
            .collect();
            let offsets: Vec<usize> = iter::repeat_with(|| widen(reader.u32()))
                .take(item_count.saturating_add(1))
                .collect();
            reader.align();
            let styles = reader.take(item_count).to_vec();
            reader.align();
            let strings = reader.take(text_len);
            reader.align();
            let units: Vec<u16> = str::from_utf8(strings).unwrap().encode_utf16().collect();
            assert_eq!(offsets.last().copied(), Some(units.len()));
            let items = rects
                .iter()
                .enumerate()
                .map(|(index, (rect, font_size))| TextItem {
                    rect: *rect,
                    font_size: *font_size,
                    style: styles[index],
                    text: String::from_utf16(
                        &units[offsets[index]..offsets[index.saturating_add(1)]],
                    )
                    .unwrap(),
                })
                .collect();
            PageText { items, page_index }
        })
        .take(widen(text_count))
        .collect();
        assert_eq!(reader.at, payload.len());
        Inspection { links, pages, text }
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
                    uri: "mailto:\u{fc}n\u{ef}@example.com".to_owned(),
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
                            style: 1,
                            text: "Hello".to_owned(),
                        },
                        TextItem {
                            rect: [5.0, 6.0, 7.0, 8.0],
                            font_size: 9.5,
                            style: 2,
                            text: "mundo \u{2014} a\u{e7}\u{e3}o \u{1d11e}".to_owned(),
                        },
                        TextItem {
                            rect: [0.0; 4],
                            font_size: 0.0,
                            style: 0,
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
        let payload = encode(&inspection).map(Writer::payload).unwrap_or_default();
        assert_eq!(decode(&payload), inspection);
    }

    #[test]
    fn empty_inspection_is_header_only() {
        let payload = encode(&Inspection::default())
            .map(Writer::payload)
            .unwrap_or_default();
        assert_eq!(payload.len(), HEADER_LEN);
        assert_eq!(decode(&payload), Inspection::default());
    }
    #[test]
    fn payload_length_is_eight_byte_aligned() {
        let payload = encode(&sample()).map(Writer::payload).unwrap_or_default();
        assert_eq!(payload.len() & 7, 0);
    }

    #[test]
    fn float_sections_are_aligned_inside_the_payload() {
        let payload = encode(&sample()).map(Writer::payload).unwrap_or_default();
        let mut reader = Reader {
            data: &payload,
            at: 0,
        };
        let _: &[u8] = reader.take(20);
        let pages_offset = widen(reader.u32());
        let links_offset = widen(reader.u32());
        let text_offset = widen(reader.u32());
        assert_eq!(pages_offset & 7, 0);
        assert_eq!(links_offset & 7, 0);
        assert_eq!(text_offset & 7, 0);
    }

    fn call(bytes: &[u8], flags: u32, pages: &[u32]) -> Block {
        call_entry(pdf_core_inspect, bytes, flags, pages)
    }

    fn release(block: &Block) {
        // SAFETY: the block was published by this module with exactly `total` bytes.
        unsafe { pdf_core_free(block.ptr, block.total) };
    }

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
        assert_eq!(result.addr() & 7, 0);
        // SAFETY: every published block starts with an `RESULT_HEADER_LEN` byte header.
        let header = unsafe { slice::from_raw_parts(result, RESULT_HEADER_LEN) };
        let [t0, t1, t2, t3, s0, s1, s2, s3] = <[u8; RESULT_HEADER_LEN]>::try_from(header).unwrap();
        let total = widen(u32::from_le_bytes([t0, t1, t2, t3]));
        let status = u32::from_le_bytes([s0, s1, s2, s3]);
        let tail = result.wrapping_add(RESULT_HEADER_LEN);
        // SAFETY: the header declares `total` bytes, and the payload is everything after the header.
        let payload =
            unsafe { slice::from_raw_parts(tail, total.saturating_sub(RESULT_HEADER_LEN)) }
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
        assert_eq!(blob_at & 7, 0);
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
        use crate::test_pdf::{grid, text};
        let mut pages = Vec::new();
        for (index, shift) in [0.0_f64, 40.0_f64, 80.0_f64].into_iter().enumerate() {
            let mut content = grid(
                &[700.0_f64 - shift, 680.0_f64 - shift, 660.0_f64 - shift],
                &[50.0_f64, 200.0_f64, 350.0_f64],
            );
            content.push_str(&text(55.0, 688.0 - shift, 10.0, "Item | x"));
            content.push_str(&text(205.0, 688.0 - shift, 10.0, "Valor"));
            content.push_str(&text(55.0, 668.0 - shift, 10.0, "Cimento"));
            content.push_str(&text(205.0, 668.0 - shift, 10.0, "12,50"));
            content.push_str(&text(50.0, 770.0, 9.0, "Prefeitura de Marilac"));
            content.push_str(&text(50.0, 500.0 - shift, 10.0, &format!("Corpo {index}")));
            pages.push(page(content));
        }
        document(&pages, &[])
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
        assert_eq!(blob & 7, 0);
        assert_eq!(payload.len() & 7, 0);
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
        assert_exact(&first.bbox, &[50.0_f64, 660.0_f64, 350.0_f64, 700.0_f64]);
        assert_eq!(first.cells.len(), 4);
        let header = &first.cells[0];
        assert_eq!((header.row, header.col, header.spans), (0, 0, (1, 1)));
        assert_eq!(header.text, "Item | x");
        assert_exact(&header.bbox, &[50.0_f64, 680.0_f64, 200.0_f64, 700.0_f64]);
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
        let payload = encode_tables(&[]).unwrap().payload();
        assert_eq!(payload.len(), TABLES_HEADER_LEN);
        assert_eq!(payload.len() & 7, 0);
    }

    #[test]
    fn text_returns_reading_order_pages() {
        let block = call_text(LINKS_PDF, 0, &[]);
        assert_eq!(block.status, STATUS_OK);
        let pages = decode_text(&block.payload);
        assert_eq!(pages.len(), 1);
        assert_ne!(pages[0].trim(), "");
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
        let _: &str = str::from_utf8(&block.payload).unwrap();
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
        assert_eq!(decoded.links, []);
        assert_eq!(decoded.text, []);
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
    fn inspect_uses_extraction_limits_for_large_documents() {
        let mut content = String::from("BT /F1 10 Tf\n");
        for column in 0..18_u32 {
            for row in 0..700_u32 {
                if column.saturating_mul(700).saturating_add(row) < 12_000 {
                    let (x, y) = (column.saturating_mul(30), row.saturating_add(20));
                    writeln!(content, "1 0 0 1 {x} {y} Tm (a) Tj").unwrap();
                }
            }
        }
        content.push_str("ET\n");
        let pages: Vec<_> = iter::repeat_with(|| page(content.clone()))
            .take(9)
            .collect();
        let pdf = document(&pages, &[]);
        let block = call(&pdf, FLAG_TEXT, &[]);
        assert_eq!(block.status, STATUS_OK);
        let decoded = decode(&block.payload);
        assert_eq!(decoded.text.len(), 9);
        assert!(decoded.text.iter().all(|page| page.items.len() == 12_000));
        release(&block);
    }

    #[test]
    fn create_writes_blank_pages_that_reopen() {
        let sizes = [595.0_f64, 842.0_f64, 200.5_f64, 100.0_f64];
        // SAFETY: `sizes` lives for the whole call.
        let block = adopt(unsafe { pdf_core_create(sizes.as_ptr(), sizes.len()) });
        assert_eq!(block.status, STATUS_OK);
        let reopened = document::Document::open(&block.payload, &Limits::default()).unwrap();
        let pages = reopened.pages().unwrap();
        assert_eq!(pages.len(), 2);
        assert_eq!(
            pages[1].info.media_box,
            [0.0_f64, 0.0_f64, 200.5_f64, 100.0_f64]
        );
        release(&block);
        for invalid in [
            &[1.0_f64][..],
            &[],
            &[0.0_f64, 10.0_f64],
            &[f64::NAN, 1.0_f64],
            &[20_000.0_f64, 1.0_f64],
        ] {
            // SAFETY: `invalid` lives for the whole call.
            let rejected = adopt(unsafe { pdf_core_create(invalid.as_ptr(), invalid.len()) });
            assert_eq!(rejected.status, u32::from(FailureCode::InvalidRequest));
            release(&rejected);
        }
    }

    #[test]
    fn font_metrics_map_win_ansi_codes_to_unicode_and_widths() {
        let name = b"Helvetica-Bold";
        // SAFETY: `name` lives for the whole call.
        let block = adopt(unsafe { pdf_core_font_metrics(name.as_ptr(), name.len()) });
        assert_eq!(block.status, STATUS_OK);
        let mut reader = Reader {
            data: &block.payload,
            at: 0,
        };
        assert_eq!(reader.u32(), METRICS_MAGIC);
        assert_eq!(reader.u32(), METRICS_VERSION);
        let entries: Vec<(u16, u16)> = reader
            .take(1024)
            .as_chunks::<4>()
            .0
            .iter()
            .map(|&[low, high, width_low, width_high]| {
                (
                    u16::from_le_bytes([low, high]),
                    u16::from_le_bytes([width_low, width_high]),
                )
            })
            .collect();
        assert_eq!(entries[usize::from(b'A')], (0x41, 722));
        assert_eq!(entries[0x80], (0x20AC, 556));
        assert_eq!(entries[0xE3], (0xE3, 556));
        assert_eq!(entries[0x81], (0, 0));
        assert_eq!(entries[0x7F], (0, 0));
        assert_eq!(entries[0x10], (0, 0));
        release(&block);
        for rejected_name in [&b"Symbol"[..], b"Arial"] {
            // SAFETY: `rejected_name` lives for the whole call.
            let rejected = adopt(unsafe {
                pdf_core_font_metrics(rejected_name.as_ptr(), rejected_name.len())
            });
            assert_eq!(rejected.status, u32::from(FailureCode::InvalidRequest));
            release(&rejected);
        }
    }

    #[test]
    fn png_size_decodes_the_whole_image() {
        let mut png = vec![137, 80, 78, 71, 13, 10, 26, 10];
        let mut chunk = |kind: &[u8; 4], data: &[u8]| {
            png.extend_from_slice(&u32::try_from(data.len()).unwrap().to_be_bytes());
            png.extend_from_slice(kind);
            png.extend_from_slice(data);
            png.extend_from_slice(&[0, 0, 0, 0]);
        };
        chunk(b"IHDR", &[0, 0, 0, 2, 0, 0, 0, 1, 8, 0, 0, 0, 0]);
        chunk(b"IDAT", &zlib_compress(&[0, 1, 2]));
        chunk(b"IEND", &[]);
        // SAFETY: `png` lives for the whole call.
        let block = adopt(unsafe { pdf_core_png_size(png.as_ptr(), png.len()) });
        assert_eq!(block.status, STATUS_OK);
        let mut reader = Reader {
            data: &block.payload,
            at: 0,
        };
        assert_eq!((reader.u32(), reader.u32()), (2, 1));
        release(&block);
        png.push(0);
        // SAFETY: `png` lives for the whole call.
        let rejected = adopt(unsafe { pdf_core_png_size(png.as_ptr(), png.len()) });
        assert_eq!(rejected.status, u32::from(FailureCode::InvalidRequest));
        release(&rejected);
    }

    #[test]
    fn failures_carry_code_and_reason() {
        let block = call(b"not a pdf", 0, &[]);
        assert_eq!(block.status, u32::from(FailureCode::InvalidPdf));
        assert_ne!(block.payload, []);
        let _: &str = str::from_utf8(&block.payload).unwrap();
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
            assert_eq!(block.addr() & 7, 0);
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
        for _ in 0_i32..200_i32 {
            let block = call(LINKS_PDF, FLAG_TEXT | FLAG_LINKS, &[]);
            assert_eq!(block.status, STATUS_OK);
            release(&block);
        }
    }

    /// # Safety
    ///
    /// Same contract as [`pdf_core_render`].
    unsafe extern "C" fn render_at_two(
        pdf_ptr: *const u8,
        pdf_len: usize,
        flags: u32,
        pages_ptr: *const u32,
        pages_len: usize,
    ) -> *mut u8 {
        // SAFETY: forwarded from this function's contract.
        unsafe { pdf_core_render(pdf_ptr, pdf_len, flags, pages_ptr, pages_len, 2.0) }
    }

    fn read_u32(payload: &[u8], at: usize) -> u32 {
        u32::from_le_bytes(payload[at..at.saturating_add(4)].try_into().unwrap())
    }

    fn read_f64(payload: &[u8], at: usize) -> f64 {
        f64::from_le_bytes(payload[at..at.saturating_add(8)].try_into().unwrap())
    }

    #[test]
    fn render_payload_carries_views_ops_and_blobs() {
        let bytes = document(
            &[
                page("0 0 1 rg 10 10 20 20 re f".to_owned()),
                page(
                    "q 20 0 0 10 10 10 cm BI /W 1 /H 1 /CS /G /BPC 8 /F /AHx ID 80> EI Q"
                        .to_owned(),
                ),
            ],
            &[],
        );
        let block = call_entry(render_at_two, &bytes, FLAG_PAGE_INDEXES, &[1]);
        assert_eq!(block.status, STATUS_OK);
        let payload = &block.payload;
        assert_eq!(read_u32(payload, 0), RENDER_MAGIC);
        assert_eq!(read_u32(payload, 4), RENDER_VERSION);
        assert_eq!(read_u32(payload, 8), 1);
        let page_at = RENDER_HEADER_LEN;
        assert_eq!(read_u32(payload, page_at), 1);
        let ops_len = widen(read_u32(payload, page_at + 8));
        assert!(ops_len > 0);
        assert_eq!(read_u32(payload, page_at + 12), 1);
        assert_exact(
            &[
                read_f64(payload, page_at + 16),
                read_f64(payload, page_at + 24),
                read_f64(payload, page_at + 32),
                read_f64(payload, page_at + 40),
            ],
            &[0.0_f64, 0.0_f64, 600.0_f64, 800.0_f64],
        );
        let section = widen(read_u32(payload, page_at + 48));
        assert_eq!(section, payload.len() - RENDER_HEADER_LEN);
        assert_eq!(section & (ALIGNMENT - 1), 0);
        let table_at = (page_at + RENDER_PAGE_HEADER_LEN + ops_len + 7) & !7;
        let blobs_at = (table_at + 8 + 7) & !7;
        let blob_offset = widen(read_u32(payload, table_at));
        let blob_len = widen(read_u32(payload, table_at + 4));
        assert_eq!(
            &payload[blobs_at + blob_offset..blobs_at + blob_offset + blob_len],
            &[128, 128, 128, 255]
        );
        release(&block);
        let failed = call_entry(render_at_two, &bytes, FLAG_PAGE_INDEXES, &[7]);
        assert_eq!(failed.status, u32::from(FailureCode::InvalidPdf));
        release(&failed);
    }
}
