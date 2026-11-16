use std::env;
use std::fs;
use std::io::Write;

use signature_kit_pdf_core::layout::document_text;

fn main() {
    let limits = signature_kit_pdf_core::layout::text_limits();
    let mut stdout = std::io::stdout().lock();
    for path in env::args().skip(1) {
        let Ok(bytes) = fs::read(&path) else {
            eprintln!("{path}: unreadable");
            continue;
        };
        match document_text(&bytes, None, &limits) {
            Ok(pages) => {
                let _ = stdout.write_all(pages.join("\n\n").as_bytes());
            }
            Err(failure) => eprintln!("{path}: {failure:?}"),
        }
    }
}
