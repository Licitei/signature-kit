#[cfg(test)]
mod tests {
    use crate::document::{self, Document, Page};
    use crate::failure::FailureCode;
    use crate::font::Font;
    use crate::inspection::{InspectOptions, Inspection, Limits, TextItems};
    use crate::object::{Object, Resolver as _};

    const LINK_PRIMARY: &str = "https://signature-kit.dev/corpus/link-primary";
    const LINK_SECONDARY: &str = "https://signature-kit.dev/corpus/link-secondary";
    const LINK_INDIRECT: &str = "https://signature-kit.dev/corpus/link-indirect";
    const LINK_ROTATED: &str = "https://signature-kit.dev/corpus/rotated-page-link";

    type Expectation = (&'static str, usize, Option<(f64, f64)>);

    fn fixture(name: &str) -> &'static [u8] {
        match name {
            "links.pdf" => include_bytes!("../../__tests__/fixtures/links.pdf"),
            "rotated-cropped.pdf" => include_bytes!("../../__tests__/fixtures/rotated-cropped.pdf"),
            "broken-xref.pdf" => include_bytes!("../../__tests__/fixtures/broken-xref.pdf"),
            "object-streams.pdf" => include_bytes!("../../__tests__/fixtures/object-streams.pdf"),
            "incremental-update.pdf" => {
                include_bytes!("../../__tests__/fixtures/incremental-update.pdf")
            }
            "icp-signed.pdf" => include_bytes!("../../__tests__/fixtures/icp-signed.pdf"),
            "helvetica-winansi.pdf" => {
                include_bytes!("../../__tests__/fixtures/helvetica-winansi.pdf")
            }
            "react-pdf-declaration.pdf" => {
                include_bytes!("../../__tests__/fixtures/react-pdf-declaration.pdf")
            }
            "habilitacao-150.pdf" => include_bytes!("../../__tests__/fixtures/habilitacao-150.pdf"),
            _ => panic!("unknown fixture"),
        }
    }

    fn inspect_full(bytes: &[u8]) -> Inspection {
        document::inspect(
            bytes,
            &InspectOptions {
                text_items: TextItems::Joined,
                text: true,
                links: true,
                page_indexes: None,
            },
            &Limits::default(),
        )
        .expect("inspect")
    }

    fn page_size(media: [f64; 4]) -> (f64, f64) {
        (media[2] - media[0], media[3] - media[1])
    }

    fn approx_eq(left: f64, right: f64) -> bool {
        (left - right).abs() <= 1.0
    }

    #[test]
    fn links_fixture_geometry_links_and_text() {
        let inspection = inspect_full(fixture("links.pdf"));
        assert_eq!(inspection.pages.len(), 1);
        let (width, height) = page_size(inspection.pages[0].media_box);
        assert!(approx_eq(width, 612.0));
        assert!(approx_eq(height, 792.0));
        assert_eq!(inspection.pages[0].rotate, 0_i32);
        assert_eq!(inspection.links.len(), 3);
        let uris: Vec<&str> = inspection
            .links
            .iter()
            .map(|link| link.uri.as_str())
            .collect();
        assert!(uris.contains(&LINK_PRIMARY));
        assert!(uris.contains(&LINK_SECONDARY));
        assert!(uris.contains(&LINK_INDIRECT));
        assert_eq!(inspection.text.len(), 1);
        assert_eq!(inspection.text[0].page_index, 0);
    }

    #[test]
    fn rotated_cropped_pages_links_and_rotation() {
        let inspection = inspect_full(fixture("rotated-cropped.pdf"));
        assert_eq!(inspection.pages.len(), 2);
        assert_eq!(inspection.pages[0].rotate, 90_i32);
        assert_eq!(inspection.pages[1].rotate, 270_i32);
        let media0 = inspection.pages[0].media_box;
        assert!(approx_eq(media0[2] - media0[0], 612.0));
        assert!(approx_eq(media0[3] - media0[1], 792.0));
        assert_eq!(inspection.links.len(), 2);
        assert!(inspection.links.iter().all(|link| link.uri == LINK_ROTATED));
    }

    #[test]
    fn corpus_page_counts_and_liteparse_dims() {
        let expectations: [Expectation; 9] = [
            ("links.pdf", 1, Some((612.0_f64, 792.0_f64))),
            ("helvetica-winansi.pdf", 1, Some((612.0_f64, 792.0_f64))),
            (
                "react-pdf-declaration.pdf",
                1,
                Some((595.28_f64, 841.89_f64)),
            ),
            ("rotated-cropped.pdf", 2, Some((612.0_f64, 792.0_f64))),
            ("object-streams.pdf", 1, Some((612.0_f64, 792.0_f64))),
            ("incremental-update.pdf", 1, Some((612.0_f64, 792.0_f64))),
            ("broken-xref.pdf", 1, Some((612.0_f64, 792.0_f64))),
            ("icp-signed.pdf", 1, Some((300.0_f64, 200.0_f64))),
            ("habilitacao-150.pdf", 150, Some((612.0_f64, 792.0_f64))),
        ];
        for (name, count, dims) in expectations {
            let inspection = inspect_full(fixture(name));
            assert_eq!(inspection.pages.len(), count, "{name} page count");
            if let Some((width, height)) = dims {
                let (page_width, page_height) = page_size(inspection.pages[0].media_box);
                assert!(
                    approx_eq(page_width, width) && approx_eq(page_height, height),
                    "{name} media box"
                );
            }
        }
    }

    #[test]
    fn broken_xref_opens_via_repair() {
        let document =
            Document::open(fixture("broken-xref.pdf"), &Limits::default()).expect("open");
        assert!(document.was_repaired());
        assert_eq!(document.pages().expect("pages").len(), 1);
    }

    #[test]
    fn object_streams_end_to_end() {
        let document =
            Document::open(fixture("object-streams.pdf"), &Limits::default()).expect("open");
        let pages = document.pages().expect("pages");
        assert_eq!(pages.len(), 1);
        let content = document.content(&pages[0]).expect("content");
        assert_ne!(content, []);
        let inspection = inspect_full(fixture("object-streams.pdf"));
        assert_eq!(inspection.pages.len(), 1);
        assert_eq!(inspection.text.len(), 1);
    }

    #[test]
    fn icp_signed_opens() {
        let inspection = inspect_full(fixture("icp-signed.pdf"));
        assert_eq!(inspection.pages.len(), 1);
        let (width, height) = page_size(inspection.pages[0].media_box);
        assert!(approx_eq(width, 300.0));
        assert!(approx_eq(height, 200.0));
    }

    fn load_page_fonts(document: &Document<'_>, page: &Page) -> Vec<Font> {
        let Some(fonts_value) = page.resources.get(b"Font") else {
            return Vec::new();
        };
        let Ok(resolved_table) = document.resolve(fonts_value) else {
            return Vec::new();
        };
        let Object::Dict(font_table) = &*resolved_table else {
            return Vec::new();
        };
        let mut fonts = Vec::new();
        for (_, entry) in &font_table.entries {
            let Ok(resolved) = document.resolve(entry) else {
                continue;
            };
            let Object::Dict(font_dict) = &*resolved else {
                continue;
            };
            if let Ok(font) = Font::load(document, font_dict, &Limits::default()) {
                fonts.push(font);
            }
        }
        fonts
    }

    #[test]
    fn helvetica_winansi_fonts_decode_portuguese() {
        let document =
            Document::open(fixture("helvetica-winansi.pdf"), &Limits::default()).expect("open");
        let pages = document.pages().expect("pages");
        let page = pages.first().expect("first page");
        let fonts = load_page_fonts(&document, page);
        assert!(fonts.len() >= 2);
        let content = document.content(page).expect("content");
        let sample = content
            .windows(3)
            .find_map(|window| match *window {
                [b'(', byte, _] if byte != b'\\' => Some(byte),
                _ => None,
            })
            .unwrap_or(b'A');
        let mut decoded_any = false;
        for font in &fonts {
            let mut glyphs = Vec::new();
            let mut text = String::new();
            font.decode(&[sample], &mut glyphs, &mut text);
            decoded_any |= !text.is_empty();
        }
        assert!(decoded_any);
    }

    #[test]
    fn react_pdf_declaration_loads_every_font() {
        let document =
            Document::open(fixture("react-pdf-declaration.pdf"), &Limits::default()).expect("open");
        let pages = document.pages().expect("pages");
        assert_eq!(pages.len(), 1);
        let fonts = load_page_fonts(&document, &pages[0]);
        assert!(fonts.len() >= 2);
    }

    #[test]
    fn rotated_page_indexes_filter_text_pages() {
        let bytes = fixture("rotated-cropped.pdf");
        let all = document::inspect(
            bytes,
            &InspectOptions {
                text_items: TextItems::Joined,
                text: true,
                links: false,
                page_indexes: None,
            },
            &Limits::default(),
        )
        .expect("all text pages");
        assert_eq!(all.text.len(), 2);
        let filtered = document::inspect(
            bytes,
            &InspectOptions {
                text_items: TextItems::Joined,
                text: true,
                links: false,
                page_indexes: Some(vec![0]),
            },
            &Limits::default(),
        )
        .expect("filtered text");
        assert_eq!(filtered.text.len(), 1);
        assert_eq!(filtered.text[0].page_index, 0);
        let missing = document::inspect(
            bytes,
            &InspectOptions {
                text_items: TextItems::Joined,
                text: true,
                links: false,
                page_indexes: Some(vec![5]),
            },
            &Limits::default(),
        )
        .expect_err("missing page");
        assert_eq!(missing.code, FailureCode::InvalidPdf);
    }

    #[test]
    fn encrypted_corpus_rejected() {
        let objects = [
            (1_u32, "<< /Type /Catalog /Pages 2 0 R >>".to_owned()),
            (
                2_u32,
                "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_owned(),
            ),
            (3_u32, "<< /Type /Page /Parent 2 0 R >>".to_owned()),
        ];
        let mut bytes = b"%PDF-1.7\n".to_vec();
        for (number, body) in &objects {
            bytes.extend_from_slice(format!("{number} 0 obj\n{body}\nendobj\n").as_bytes());
        }
        let xref = bytes.len();
        bytes.extend_from_slice(b"xref\n0 4\n0000000000 65535 f \n");
        bytes.extend_from_slice(
            b"trailer\n<< /Size 4 /Root 1 0 R /Encrypt << /Filter /Standard >> >>\nstartxref\n",
        );
        bytes.extend_from_slice(format!("{xref}\n%%EOF\n").as_bytes());
        let error = document::inspect(&bytes, &InspectOptions::default(), &Limits::default())
            .expect_err("encrypted");
        assert_eq!(error.code, FailureCode::EncryptedPdf);
    }
}
