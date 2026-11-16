#![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]

pub(crate) fn stream_object(dict: &str, data: &str) -> String {
    format!(
        "<< /Length {} {} >>\nstream\n{}\nendstream",
        data.len(),
        dict,
        data
    )
}

pub(crate) fn build(objects: &[(u32, String)]) -> Vec<u8> {
    let mut bytes = b"%PDF-1.7\n".to_vec();
    let mut offsets = Vec::new();
    for (number, body) in objects {
        offsets.push((*number, bytes.len()));
        bytes.extend_from_slice(format!("{number} 0 obj\n{body}\nendobj\n").as_bytes());
    }
    let xref = bytes.len();
    let max = objects.iter().map(|(number, _)| *number).max().unwrap_or(0);
    bytes.extend_from_slice(format!("xref\n0 {}\n", max + 1).as_bytes());
    for number in 0..=max {
        match offsets.iter().find(|(n, _)| *n == number) {
            Some((_, offset)) => {
                bytes.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
            }
            None => bytes.extend_from_slice(b"0000000000 65535 f \n"),
        }
    }
    bytes.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            max + 1
        )
        .as_bytes(),
    );
    bytes
}

pub(crate) struct PageSpec {
    pub content: String,
    pub rotate: i32,
}

pub(crate) fn page(content: String) -> PageSpec {
    PageSpec { content, rotate: 0 }
}

pub(crate) fn document(pages: &[PageSpec], extra: &[(u32, String)]) -> Vec<u8> {
    let first_page = 10_u32;
    let kids: Vec<String> = (0..pages.len())
        .map(|index| format!("{} 0 R", first_page + 2 * u32::try_from(index).unwrap()))
        .collect();
    let mut objects = vec![
        (1, "<< /Type /Catalog /Pages 2 0 R >>".to_owned()),
        (
            2,
            format!(
                "<< /Type /Pages /Kids [{}] /Count {} >>",
                kids.join(" "),
                pages.len()
            ),
        ),
        (
            3,
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>".to_owned(),
        ),
        (
            4,
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>".to_owned(),
        ),
    ];
    for (index, spec) in pages.iter().enumerate() {
        let number = first_page + 2 * u32::try_from(index).unwrap();
        objects.push((
            number,
            format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Rotate {} /Contents {} 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> >>",
                spec.rotate,
                number + 1
            ),
        ));
        objects.push((number + 1, stream_object("", &spec.content)));
    }
    objects.extend_from_slice(extra);
    build(&objects)
}

pub(crate) fn text(x: f64, y: f64, size: f64, value: &str) -> String {
    format!("BT /F1 {size} Tf 1 0 0 1 {x} {y} Tm ({value}) Tj ET\n")
}

pub(crate) fn bold(x: f64, y: f64, size: f64, value: &str) -> String {
    format!("BT /F2 {size} Tf 1 0 0 1 {x} {y} Tm ({value}) Tj ET\n")
}

pub(crate) fn rule(x0: f64, y0: f64, x1: f64, y1: f64) -> String {
    format!("0.5 w {x0} {y0} m {x1} {y1} l S\n")
}

pub(crate) fn grid(rows: &[f64], cols: &[f64]) -> String {
    let (left, right) = (cols[0], cols[cols.len() - 1]);
    let (top, bottom) = (rows[0], rows[rows.len() - 1]);
    let mut out = String::new();
    for &y in rows {
        out.push_str(&rule(left, y, right, y));
    }
    for &x in cols {
        out.push_str(&rule(x, bottom, x, top));
    }
    out
}
