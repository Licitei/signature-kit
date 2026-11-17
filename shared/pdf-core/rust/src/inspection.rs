#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[expect(
    clippy::struct_field_names,
    reason = "the max_ prefix names what kind of bound each field is"
)]
pub(crate) struct Limits {
    pub max_pdf_bytes: usize,
    pub max_pages: usize,
    pub max_items_per_page: usize,
    pub max_items: usize,
    pub max_text_bytes: usize,
    pub max_decoded_stream_bytes: usize,
    pub max_objects: usize,
    pub max_nesting: usize,
}

impl Default for Limits {
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
pub(crate) struct InspectOptions {
    pub text: bool,
    pub links: bool,
    pub page_indexes: Option<Vec<u32>>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct PageInfo {
    pub media_box: [f64; 4],
    pub crop_box: [f64; 4],
    pub rotate: i32,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct LinkInfo {
    pub page_index: u32,
    pub rect: [f64; 4],
    pub uri: String,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct TextItem {
    pub rect: [f64; 4],
    pub font_size: f64,
    pub text: String,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct PageText {
    pub page_index: u32,
    pub items: Vec<TextItem>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Inspection {
    pub pages: Vec<PageInfo>,
    pub links: Vec<LinkInfo>,
    pub text: Vec<PageText>,
}
