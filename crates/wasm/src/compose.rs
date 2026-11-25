#![expect(
    unsafe_code,
    reason = "the C ABI owns byte buffers shared with the host"
)]

use alloc::collections::BTreeMap;
use core::{cell::RefCell, ptr, slice};

#[derive(Debug)]
struct Assets {
    bytes: usize,
    entries: BTreeMap<u32, Box<[u8]>>,
    next: u32,
}

thread_local! {
    static ASSETS: RefCell<Assets> = const { RefCell::new(Assets {
        bytes: 0,
        entries: BTreeMap::new(),
        next: 1,
    }) };
}

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
pub(crate) unsafe extern "C" fn pdf_compose_register_asset(data: *const u8, len: usize) -> u32 {
    if data.is_null() || len == 0 || len > 64 * 1024 * 1024 {
        return 0;
    }
    ASSETS.with_borrow_mut(|assets| {
        let total = assets.bytes.saturating_add(len);
        let id = assets.next;
        let Some(next) = id.checked_add(1) else {
            return 0;
        };
        if assets.entries.len() >= 512 || total > 128 * 1024 * 1024 {
            return 0;
        }
        // SAFETY: the host allocated and initialized the input, which this call copies.
        let bytes = unsafe { slice::from_raw_parts(data, len) };
        let _previous = assets.entries.insert(id, Box::from(bytes));
        assets.bytes = total;
        assets.next = next;
        id
    })
}

#[unsafe(no_mangle)]
pub(crate) unsafe extern "C" fn pdf_compose_run(data: *const u8, len: usize) -> *mut u8 {
    if data.is_null() || len > 128 * 1024 * 1024 {
        return ptr::null_mut();
    }
    // SAFETY: the caller initialized all bytes of the allocation and keeps it alive for this call.
    let input = unsafe { slice::from_raw_parts(data, len) };
    let (status, payload) = match ASSETS.with_borrow(|assets| {
        signature_kit_compose::compose(input, |id| assets.entries.get(&id).map(Box::as_ref))
    }) {
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

#[unsafe(no_mangle)]
pub(crate) extern "C" fn pdf_compose_unregister_asset(id: u32) {
    ASSETS.with_borrow_mut(|assets| {
        if let Some(bytes) = assets.entries.remove(&id) {
            assets.bytes = assets.bytes.saturating_sub(bytes.len());
        }
    });
}
