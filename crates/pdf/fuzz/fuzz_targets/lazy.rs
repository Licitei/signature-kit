#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    signature_kit_pdf_core::fuzzing::lazy(data);
});
