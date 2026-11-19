#![expect(
    unsafe_code,
    reason = "the benchmark shares initialized wasm buffers with its driver"
)]

use core::{ptr, slice};

use crate::engine::{Options, prepare_page};
use crate::model::Metrics;
use crate::raster::Gray;
use crate::sequence::{Geometry, Scratch, Sequence};

#[unsafe(no_mangle)]
pub(crate) unsafe extern "C" fn pdf_core_ocr_ctc_probe(data: *const u8, length: usize) -> *mut u8 {
    if data.is_null() || length == 0 || length > 32_100_000 {
        return ptr::null_mut();
    }
    // SAFETY: The caller initializes this allocation and keeps it live during the call.
    let input = unsafe { slice::from_raw_parts(data, length) };
    recognize(input).map_or_else(ptr::null_mut, |output| Box::into_raw(output).cast())
}

fn recognize(input: &[u8]) -> Option<Box<[u8]>> {
    let (header, bytes) = input.split_first_chunk::<16>()?;
    let ([width_bytes, height_bytes, dpi_bytes, table_bytes], []) = header.as_chunks::<4>() else {
        return None;
    };
    let width = u32::from_le_bytes(*width_bytes);
    let height = u32::from_le_bytes(*height_bytes);
    let dpi = f32::from_le_bytes(*dpi_bytes);
    if !dpi.is_finite() || dpi <= 0.0 {
        return None;
    }
    let table_length = usize::try_from(u32::from_le_bytes(*table_bytes)).ok()?;
    let (model, pixels) = bytes.split_at_checked(table_length)?;
    let sequence = Sequence::decode(model)?;
    let gray = Gray::new(width, height, pixels.to_vec()).ok()?;
    let prepared = prepare_page(&gray, dpi, &Options::default(), |_| ()).ok()?;
    let mut scratch = Scratch::for_page(prepared.page.width);
    let mut text = String::new();
    for line in prepared.layout.lines {
        if !text.is_empty() {
            text.push('\n');
        }
        let metrics = Metrics {
            baseline: line.baseline,
            x_height: line.x_height,
        };
        let geometry = Geometry {
            bbox: line.bbox,
            metrics,
        };
        sequence.predict(&prepared.page, geometry, &mut scratch, |_, label, _| {
            text.push(label);
        });
    }
    let length = u32::try_from(text.len().saturating_add(4)).ok()?;
    let mut output = Vec::with_capacity(usize::try_from(length).ok()?);
    output.extend(length.to_le_bytes());
    output.extend(text.bytes());
    Some(output.into_boxed_slice())
}
