extern crate alloc;

mod abi;
mod ccitt;
mod cff;
mod cmap;
mod color;
mod columns;
mod deflate;
mod diagnostics;
mod display;
mod document;
mod edit;
mod encryption;
mod failure;
mod filters;
mod font;
mod font_tables;
mod fontprog;
mod function;
mod glyph;
mod image;
mod inflate;
mod inspection;
mod layout;
mod lazy;
mod markdown;
mod num;
mod object;
mod pdf_cipher;
mod pdf_hash;
mod png;
mod render;
mod revision;
mod shading;
mod syntax;
mod table;
mod text;
mod write;

#[cfg(test)]
mod fixture_corpus;
#[cfg(test)]
mod test_pdf;

#[cfg(fuzzing)]
pub fn fuzz_markdown(data: &[u8]) {
    let options = layout::TextOptions {
        drop_running: true,
        markdown: true,
        merge_across_pages: data.first().is_some_and(|byte| byte & 1 == 1),
    };
    drop(layout::document_text(
        data,
        document::PageRequest::Indexes(None),
        &layout::text_limits(),
        options,
    ));
}
