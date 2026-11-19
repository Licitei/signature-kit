#![expect(
    unsafe_code,
    reason = "the wasm C ABI uses allocated linear-memory pointers"
)]

use core::{ptr, slice};

use crate::engine::{Options, PageResult, recognize_page};
use crate::jpeg;
use crate::raster::Gray;

const MAGIC: u32 = 0x5243_4f50;
const VERSION: u32 = 1;
const MAX_INPUT: usize = 32_000_000;

fn number(bytes: &mut Vec<u8>, value: u32) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

fn string(bytes: &mut Vec<u8>, text: &str) -> Option<()> {
    number(bytes, u32::try_from(text.len()).ok()?);
    bytes.extend_from_slice(text.as_bytes());
    Some(())
}

fn payload(result: &PageResult) -> Option<Box<[u8]>> {
    let mut bytes = vec![0; 4];
    number(&mut bytes, MAGIC);
    number(&mut bytes, VERSION);
    number(&mut bytes, result.width);
    number(&mut bytes, result.height);
    number(&mut bytes, u32::try_from(result.words.len()).ok()?);
    for word in &result.words {
        for coordinate in word.bbox {
            number(&mut bytes, coordinate);
        }
        number(&mut bytes, word.confidence.to_bits());
        number(&mut bytes, word.line);
        string(&mut bytes, &word.text)?;
    }
    string(&mut bytes, &result.text)?;
    let length = u32::try_from(bytes.len()).ok()?;
    bytes.get_mut(..4)?.copy_from_slice(&length.to_le_bytes());
    Some(bytes.into_boxed_slice())
}

#[unsafe(no_mangle)]
pub(crate) extern "C" fn pdf_core_ocr_alloc(length: usize) -> *mut u8 {
    if length == 0 || length > MAX_INPUT {
        return ptr::null_mut();
    }
    Box::into_raw(vec![0_u8; length].into_boxed_slice()).cast::<u8>()
}

#[unsafe(no_mangle)]
pub(crate) unsafe extern "C" fn pdf_core_ocr_free(data: *mut u8, length: usize) {
    if !data.is_null() && length != 0 {
        let buffer = ptr::slice_from_raw_parts_mut(data, length);
        // SAFETY: The caller relinquishes a live allocation and supplies its original byte length.
        drop(unsafe { Box::from_raw(buffer) });
    }
}

#[unsafe(no_mangle)]
pub(crate) unsafe extern "C" fn pdf_core_ocr_recognize(
    data: *const u8,
    length: usize,
    kind: u32,
    width: u32,
    height: u32,
    dpi_x1000: u32,
    options: u32,
) -> *mut u8 {
    if data.is_null() || length == 0 || length > MAX_INPUT || options & !1 != 0 {
        return ptr::null_mut();
    }
    // SAFETY: The caller retains ownership of an initialized input allocation for this call.
    let input = unsafe { slice::from_raw_parts(data, length) };
    let image = match kind {
        0 => Gray::new(width, height, input.to_vec()).ok(),
        1 => jpeg::decode(input).ok(),
        _ => None,
    };
    let Some(gray) = image else {
        return ptr::null_mut();
    };
    if width != gray.width || height != gray.height {
        return ptr::null_mut();
    }
    let dpi = f32::from(
        u16::try_from(dpi_x1000.checked_div(1000).unwrap_or_default()).unwrap_or(u16::MAX),
    );
    let settings = Options {
        detect_orientation: options & 1 == 0,
    };
    recognize_page(&gray, dpi, &settings)
        .ok()
        .and_then(|result| payload(&result))
        .map_or_else(ptr::null_mut, |buffer| Box::into_raw(buffer).cast::<u8>())
}

#[unsafe(no_mangle)]
pub(crate) const extern "C" fn pdf_core_ocr_version() -> u32 {
    VERSION
}
