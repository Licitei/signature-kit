use std::env;
use std::fs;
use std::time::Instant;

use signature_kit_pdf_core::document::Document;
use signature_kit_pdf_core::layout::{page_text, text_limits};
use signature_kit_pdf_core::text::{Session, extract_runs};

fn main() {
    let limits = text_limits();
    for path in env::args().skip(1) {
        let Ok(bytes) = fs::read(&path) else { continue };
        let t0 = Instant::now();
        let Ok(document) = Document::open(&bytes, &limits) else {
            continue;
        };
        let Ok(pages) = document.pages() else {
            continue;
        };
        let open = t0.elapsed();
        let mut extract = std::time::Duration::ZERO;
        let mut layout = std::time::Duration::ZERO;
        let mut runs_total = 0usize;
        let mut content_time = std::time::Duration::ZERO;
        let mut content_bytes = 0usize;
        let mut session = Session::default();
        for page in &pages {
            let t = Instant::now();
            let content = document.content(page).unwrap_or_default();
            content_time += t.elapsed();
            content_bytes += content.len();
            let t = Instant::now();
            let runs =
                extract_runs(&document, page, &limits, true, &mut session).unwrap_or_default();
            extract += t.elapsed();
            runs_total += runs.len();
            let t = Instant::now();
            let text = page_text(&runs, page.info.rotate);
            layout += t.elapsed();
            std::hint::black_box(text);
        }
        println!(
            "{} pages={} runs={} open={:?} content={:?} ({}KB) extract={:?} layout={:?}",
            path.rsplit('/').next().unwrap_or(""),
            pages.len(),
            runs_total,
            open,
            content_time,
            content_bytes / 1024,
            extract,
            layout
        );
    }
}
