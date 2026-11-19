use crate::binarize::binarize;
use crate::clean::{Rule, TableGrid, clean, grids};
use crate::deskew::{Transform, straighten};
use crate::postprocess::correct;
use crate::raster::{Bits, Gray, RasterError};
use crate::recognize::recognize_line;
use crate::segment::{PageLayout, segment};

#[derive(Debug, Clone, Copy)]
#[non_exhaustive]
pub struct Options {
    pub detect_orientation: bool,
}

impl Default for Options {
    #[inline]
    fn default() -> Self {
        Self {
            detect_orientation: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub struct Word {
    pub bbox: [u32; 4],
    pub confidence: f32,
    pub line: u32,
    pub text: String,
}

#[derive(Debug, Clone, Default, PartialEq)]
#[non_exhaustive]
pub struct PageResult {
    pub height: u32,
    pub text: String,
    pub width: u32,
    pub words: Vec<Word>,
}

#[derive(Debug)]
#[non_exhaustive]
#[expect(
    clippy::partial_pub_fields,
    reason = "the inverse transform is private to word projection"
)]
pub struct PreparedPage {
    pub layout: PageLayout,
    pub page: Bits,
    pub rules: Vec<Rule>,
    pub tables: Vec<TableGrid>,
    transform: Transform,
}

#[derive(Debug, Clone, Copy)]
#[non_exhaustive]
pub enum Stage {
    Binarize,
    Clean,
    Deskew,
    Segment,
}

impl PreparedPage {
    #[inline]
    #[must_use]
    pub fn recognize(&self) -> PageResult {
        let mut words = Vec::new();
        let mut text = String::new();
        for (index, line) in self.layout.lines.iter().enumerate() {
            let mut recognized = recognize_line(&self.page, line);
            correct(&mut recognized);
            if !text.is_empty() && !recognized.is_empty() {
                text.push('\n');
            }
            let line_number = u32::try_from(index).unwrap_or(u32::MAX);
            for (word_index, word) in recognized.into_iter().enumerate() {
                if word_index != 0 {
                    text.push(' ');
                }
                text.push_str(&word.text);
                words.push(Word {
                    bbox: self.transform.source(word.bbox),
                    confidence: word.confidence,
                    line: line_number,
                    text: word.text,
                });
            }
        }
        PageResult {
            height: self.transform.height,
            text,
            width: self.transform.width,
            words,
        }
    }
}

/// # Errors
/// Returns a raster error for invalid image dimensions or pixel length.
#[inline]
pub fn prepare_page<Observe>(
    gray: &Gray,
    dpi: f32,
    options: &Options,
    mut stage_complete: Observe,
) -> Result<PreparedPage, RasterError>
where
    Observe: FnMut(Stage),
{
    let page = binarize(gray)?;
    stage_complete(Stage::Binarize);
    let (mut cleaned, transform) = straighten(page, options.detect_orientation)?;
    stage_complete(Stage::Deskew);
    let rules = clean(&mut cleaned, dpi);
    stage_complete(Stage::Clean);
    let layout = segment(&cleaned, dpi);
    let tables = grids(&rules);
    stage_complete(Stage::Segment);
    Ok(PreparedPage {
        layout,
        page: cleaned,
        rules,
        tables,
        transform,
    })
}

/// # Errors
/// Returns a raster error for invalid image dimensions or pixel length.
#[inline]
pub fn recognize_page(gray: &Gray, dpi: f32, options: &Options) -> Result<PageResult, RasterError> {
    Ok(prepare_page(gray, dpi, options, |_| ())?.recognize())
}

#[cfg(test)]
mod tests {
    use crate::jpeg;

    use super::{Options, prepare_page};

    type AnnotatedScan = (&'static [u8], &'static [(u32, u32)]);

    #[test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "assertions measure layout accuracy from fallible fixtures"
    )]
    fn finds_manually_marked_scan_lines() -> Result<(), String> {
        let cases: &[AnnotatedScan] = &[
            (
                include_bytes!("../tests/fixtures/scan-dates.jpg"),
                &[(4, 19), (19, 34), (34, 49), (49, 64), (64, 79)],
            ),
            (
                include_bytes!("../tests/fixtures/scan-title.jpg"),
                &[(9, 34), (39, 65), (70, 94)],
            ),
        ];
        for &(jpeg_bytes, expected) in cases {
            let gray = jpeg::decode(jpeg_bytes).map_err(|cause| format!("{cause:?}"))?;
            let prepared = prepare_page(
                &gray,
                85.0,
                &Options {
                    detect_orientation: false,
                },
                |_| (),
            )
            .map_err(|cause| format!("{cause:?}"))?;
            let observed: Vec<_> = prepared
                .layout
                .lines
                .iter()
                .map(|line| {
                    let [_, top, _, bottom] = line.bbox;
                    u32::midpoint(top, bottom)
                })
                .collect();
            assert_eq!(observed.len(), expected.len(), "{observed:?}");
            for (&center, &(top, bottom)) in observed.iter().zip(expected) {
                assert!(
                    (top..bottom).contains(&center),
                    "line {center}, expected {top}..{bottom}"
                );
            }
        }
        Ok(())
    }
}
