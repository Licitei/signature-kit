#![expect(
    unsafe_code,
    reason = "the C ABI owns byte buffers shared with the host"
)]

use core::{ptr, slice};

#[unsafe(no_mangle)]
pub(crate) extern "C" fn pdf_compose_alloc(len: usize) -> *mut u8 {
    Box::into_raw(vec![0_u8; len].into_boxed_slice()).cast::<u8>()
}

#[unsafe(no_mangle)]
pub(crate) unsafe extern "C" fn pdf_compose_free(data: *mut u8, len: usize) {
    if !data.is_null() {
        // SAFETY: the caller returns a block allocated by this ABI with its original length.
        unsafe { drop(Box::from_raw(ptr::slice_from_raw_parts_mut(data, len))) };
    }
}

#[unsafe(no_mangle)]
pub(crate) unsafe extern "C" fn pdf_compose_run(data: *const u8, len: usize) -> *mut u8 {
    if data.is_null() || len > 128 * 1024 * 1024 {
        return ptr::null_mut();
    }
    // SAFETY: the caller initialized all bytes of the allocation and keeps it alive for this call.
    let input = unsafe { slice::from_raw_parts(data, len) };
    let (status, payload) = match signature_kit_compose::compose(input) {
        Ok(pdf) => (0_u32, pdf),
        Err(failure) => (u32::from(failure.code), failure.reason.into_bytes()),
    };
    let Ok(size) = u32::try_from(payload.len()) else {
        return ptr::null_mut();
    };
    let mut result = Vec::with_capacity(payload.len().saturating_add(8));
    result.extend_from_slice(&status.to_le_bytes());
    result.extend_from_slice(&size.to_le_bytes());
    result.extend_from_slice(&payload);
    Box::into_raw(result.into_boxed_slice()).cast::<u8>()
}
