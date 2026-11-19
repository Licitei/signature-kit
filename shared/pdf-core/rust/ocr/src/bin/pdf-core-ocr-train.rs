#[cfg(not(target_arch = "wasm32"))]
use std::{env, io};

#[cfg(not(target_arch = "wasm32"))]
use signature_kit_pdf_core_ocr::training;

#[cfg(not(target_arch = "wasm32"))]
fn main() -> io::Result<()> {
    let arguments: Vec<_> = env::args_os().skip(1).collect();
    training::run(&arguments)
}

#[cfg(target_arch = "wasm32")]
const fn main() {}
