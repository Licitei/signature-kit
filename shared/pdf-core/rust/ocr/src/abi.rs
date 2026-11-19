#![expect(
    unsafe_code,
    reason = "the wasm C ABI requires unmangled exported symbols"
)]

use core::ptr;
use core::slice;

use crate::raster_display::rasterize;

#[unsafe(no_mangle)]
pub(crate) const extern "C" fn pdf_core_ocr_version() -> u32 {
    1
}

#[unsafe(no_mangle)]
pub(crate) extern "C" fn pdf_core_ocr_raster_alloc(len: usize) -> *mut u8 {
    let mut bytes = Vec::<u8>::new();
    if len == 0 || bytes.try_reserve_exact(len).is_err() {
        return ptr::null_mut();
    }
    bytes.resize(len, 0);
    Box::into_raw(bytes.into_boxed_slice()).cast()
}

#[unsafe(no_mangle)]
pub(crate) unsafe extern "C" fn pdf_core_ocr_raster_free(data: *mut u8, len: usize) {
    if !data.is_null() && len != 0 {
        // SAFETY: the caller passes the pointer and length of a live allocation from this ABI once.
        drop(unsafe { Box::from_raw(ptr::slice_from_raw_parts_mut(data, len)) });
    }
}

#[unsafe(no_mangle)]
pub(crate) unsafe extern "C" fn pdf_core_ocr_rasterize(
    payload_ptr: *const u8,
    payload_len: usize,
    scale_x1000: u32,
) -> *mut u8 {
    if payload_ptr.is_null() || payload_len == 0 || scale_x1000 == 0 {
        return ptr::null_mut();
    }
    // SAFETY: the caller provides an initialized byte span that remains live for this call.
    let payload = unsafe { slice::from_raw_parts(payload_ptr, payload_len) };
    let Some(raster) = rasterize(payload, scale_x1000) else {
        return ptr::null_mut();
    };
    let (Ok(width), Ok(height)) = (u32::try_from(raster.width), u32::try_from(raster.height))
    else {
        return ptr::null_mut();
    };
    let mut output = Vec::with_capacity(raster.pixels.len().saturating_add(8));
    output.extend_from_slice(&width.to_le_bytes());
    output.extend_from_slice(&height.to_le_bytes());
    output.extend_from_slice(&raster.pixels);
    Box::into_raw(output.into_boxed_slice()).cast()
}
