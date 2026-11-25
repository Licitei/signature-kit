#![cfg_attr(
    test,
    expect(
        dead_code_pub_in_binary,
        reason = "the compose ABI links this crate separately"
    )
)]

extern crate alloc;

mod images;
mod layout;
mod pdf;
mod spec;
mod text;

use signature_kit_font::sfnt::Face;
use signature_kit_pdf_core::failure::{Failure, Outcome};

#[expect(
    clippy::missing_errors_doc,
    reason = "the TypeScript ABI documents compose errors"
)]
#[inline]
pub fn compose(request: &[u8]) -> Outcome<Vec<u8>> {
    let document = spec::parse(request)?;
    let faces: Vec<_> = document
        .fonts
        .iter()
        .map(|bytes| Face::parse(bytes).ok_or_else(|| Failure::request("Invalid OpenType font")))
        .collect::<Outcome<_>>()?;
    let images: Vec<_> = document
        .images
        .iter()
        .map(|bytes| images::Image::parse(bytes))
        .collect::<Outcome<_>>()?;
    let sizes: Vec<_> = images.iter().map(|image| image.size).collect();
    let layout = layout::Layout {
        faces: &faces,
        images: &sizes,
    };
    let mut pages = Vec::new();
    for section in &document.sections {
        pages.extend(layout.section(section)?);
        if pages.len() > 1000 {
            return Err(Failure::limit("Too many composed pages"));
        }
    }
    pdf::write(&pages, &faces, &images, document.metadata)
}
