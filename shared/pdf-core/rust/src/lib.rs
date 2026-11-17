extern crate alloc;

mod abi;
mod cff;
mod cmap;
mod deflate;
mod document;
mod edit;
mod failure;
mod filters;
mod font;
mod font_tables;
mod fontprog;
mod inflate;
mod inspection;
mod layout;
mod markdown;
mod num;
mod object;
mod png;
mod revision;
mod syntax;
mod table;
mod text;
mod write;

#[cfg(test)]
mod fixture_corpus;
#[cfg(test)]
mod test_pdf;
