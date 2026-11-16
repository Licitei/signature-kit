use crate::failure::{Failure, Outcome};
use crate::inspection::{
    InspectOptions, Inspection, Limits, LinkInfo, PageInfo, PageText, TextItem,
};

pub fn inspect(bytes: &[u8], options: &InspectOptions, limits: &Limits) -> Outcome<Inspection> {
    if bytes.len() > limits.max_pdf_bytes {
        return Err(Failure::limit("PDF exceeds the byte limit"));
    }
    if !bytes.starts_with(b"%PDF-") {
        return Err(Failure::invalid("missing PDF header"));
    }
    let wanted = |index: u32| {
        options
            .page_indexes
            .as_ref()
            .is_none_or(|indexes| indexes.contains(&index))
    };
    let links = if options.links {
        vec![LinkInfo {
            page_index: 0,
            rect: [10.0, 10.0, 110.0, 30.0],
            uri: "https://example.com".to_owned(),
        }]
    } else {
        Vec::new()
    };
    let text = if options.text && wanted(0) {
        vec![PageText {
            page_index: 0,
            items: vec![TextItem {
                rect: [10.0, 10.0, 60.0, 22.0],
                font_size: 12.0,
                text: "stub".to_owned(),
            }],
        }]
    } else {
        Vec::new()
    };
    Ok(Inspection {
        pages: vec![PageInfo {
            media_box: [0.0, 0.0, 612.0, 792.0],
            crop_box: [0.0, 0.0, 612.0, 792.0],
            rotate: 0,
        }],
        links,
        text,
    })
}
