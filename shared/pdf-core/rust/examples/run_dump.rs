use std::env;
use std::fs;

use signature_kit_pdf_core::document::Document;
use signature_kit_pdf_core::layout::text_limits;
use signature_kit_pdf_core::text::{Session, extract_runs};

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let [path, page_index, filter] = args.as_slice() else {
        return;
    };
    let limits = text_limits();
    let Ok(bytes) = fs::read(path) else { return };
    let Ok(document) = Document::open(&bytes, &limits) else {
        return;
    };
    let Ok(pages) = document.pages() else { return };
    let Some(page) = pages.get(page_index.parse().unwrap_or(0)) else {
        return;
    };
    let mut session = Session::default();
    let Ok(runs) = extract_runs(&document, page, &limits, true, &mut session) else {
        return;
    };
    for run in runs {
        if run.item.text.contains(filter.as_str()) {
            println!(
                "{:?} rect={:?} size={:.2} dir={:?}",
                run.item.text, run.item.rect, run.item.font_size, run.direction
            );
        }
    }
}
