#![expect(
    unsafe_code,
    reason = "the wasm C ABI requires unmangled exported symbols"
)]

#[unsafe(no_mangle)]
pub(crate) const extern "C" fn pdf_core_ocr_version() -> u32 {
    1
}
