#![forbid(unsafe_op_in_unsafe_fn)]

pub mod abi;
pub mod cff;
pub mod cff_tables;
pub mod cmap;
pub mod document;
pub mod failure;
pub mod filters;
pub mod font;
pub mod font_tables;
pub mod fontprog;
pub mod inflate;
pub mod inspection;
pub mod layout;
pub mod object;
pub mod syntax;
pub mod text;

#[cfg(test)]
mod fixture_corpus;
