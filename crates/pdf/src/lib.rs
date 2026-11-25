#![cfg_attr(
    test,
    expect(
        dead_code_pub_in_binary,
        reason = "the WASM ABI tests link a separate crate"
    )
)]

extern crate alloc;

mod ccitt;
mod cff;
mod cmap;
mod color;
mod columns;
pub mod deflate;
pub mod diagnostics;
pub mod display;
pub mod document;
pub mod edit;
mod encryption;
pub mod failure;
mod filters;
mod font;
pub mod font_tables;
mod fontprog;
mod function;
mod glyph;
mod image;
mod inflate;
pub mod inspection;
pub mod layout;
pub mod lazy;
mod markdown;
pub mod num;
pub mod object;
mod pdf_cipher;
pub mod pdf_hash;
pub mod png;
pub mod render;
pub mod revision;
mod shading;
mod syntax;
pub mod table;
mod text;
pub mod write;

#[cfg(test)]
mod fixture_corpus;
#[cfg(test)]
mod test_pdf;

#[cfg(fuzzing)]
pub mod fuzzing;
