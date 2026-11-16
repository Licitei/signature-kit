use crate::document::{Document, Page};
use crate::failure::Outcome;
use crate::inspection::{Limits, TextItem};

pub fn extract_page(
    document: &Document<'_>,
    page: &Page,
    limits: &Limits,
) -> Outcome<Vec<TextItem>> {
    let _ = (document, page, limits);
    Ok(Vec::new())
}
