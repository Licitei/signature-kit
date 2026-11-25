#[cfg(feature = "pdf")]
extern crate alloc;

#[cfg(feature = "pdf")]
mod abi;

#[cfg(feature = "pdf")]
#[cfg(test)]
#[expect(
    dead_code,
    reason = "the ABI tests use a subset of the shared PDF fixture helpers"
)]
#[path = "../../pdf/src/test_pdf.rs"]
mod test_pdf;
