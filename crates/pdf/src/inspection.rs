#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[expect(
    clippy::exhaustive_structs,
    reason = "the internal ABI shares this struct with the WASM crate"
)]
pub struct Limits {
    pub max_decoded_stream_bytes: usize,
    pub max_items: usize,
    pub max_items_per_page: usize,
    pub max_nesting: usize,
    pub max_objects: usize,
    pub max_pages: usize,
    pub max_pdf_bytes: usize,
    pub max_text_bytes: usize,
}

impl Default for Limits {
    #[expect(
        clippy::missing_inline_in_public_items,
        reason = "release LTO chooses inlining across the internal Rust boundary"
    )]
    fn default() -> Self {
        Self {
            max_pdf_bytes: 512 * 1024 * 1024,
            max_pages: 10_000,
            max_items_per_page: 10_000,
            max_items: 100_000,
            max_text_bytes: 4 * 1024 * 1024,
            max_decoded_stream_bytes: 256 * 1024 * 1024,
            max_objects: 8_000_000,
            max_nesting: 64,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
#[expect(
    clippy::exhaustive_structs,
    reason = "the internal ABI shares this struct with the WASM crate"
)]
pub struct InspectOptions {
    pub links: bool,
    pub page_indexes: Option<Vec<u32>>,
    pub runs: bool,
    pub text: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
#[expect(
    clippy::exhaustive_structs,
    reason = "the internal ABI shares this struct with the WASM crate"
)]
pub struct PageInfo {
    pub crop_box: [f64; 4],
    pub media_box: [f64; 4],
    pub rotate: i32,
}

#[derive(Clone, Debug, PartialEq)]
#[expect(
    clippy::exhaustive_structs,
    reason = "the internal ABI shares this struct with the WASM crate"
)]
pub struct LinkInfo {
    pub page_index: u32,
    pub rect: [f64; 4],
    pub uri: String,
}

#[derive(Clone, Debug, PartialEq)]
#[expect(
    clippy::exhaustive_structs,
    reason = "the internal ABI shares this struct with the WASM crate"
)]
pub struct TextItem {
    pub font_size: f64,
    pub rect: [f64; 4],
    pub style: u8,
    pub text: String,
}

#[derive(Clone, Debug, Default, PartialEq)]
#[expect(
    clippy::exhaustive_structs,
    reason = "the internal ABI shares this struct with the WASM crate"
)]
pub struct PageText {
    pub items: Vec<TextItem>,
    pub page_index: u32,
}

#[derive(Clone, Debug, Default, PartialEq)]
#[expect(
    clippy::exhaustive_structs,
    reason = "the internal ABI shares this struct with the WASM crate"
)]
pub struct Inspection {
    pub links: Vec<LinkInfo>,
    pub pages: Vec<PageInfo>,
    pub text: Vec<PageText>,
}
