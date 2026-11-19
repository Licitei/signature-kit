use crate::raster::{Bits, Gray, RasterError, pixel_count};

const TILE: usize = 32;

#[derive(Clone, Copy)]
struct Tone {
    darkest: u8,
    lightest: u8,
}

impl Tone {
    const fn empty() -> Self {
        Self {
            darkest: 255,
            lightest: 0,
        }
    }

    fn include(&mut self, value: u8) {
        self.darkest = self.darkest.min(value);
        self.lightest = self.lightest.max(value);
    }

    const fn threshold(self) -> u8 {
        let contrast = self.lightest.saturating_sub(self.darkest);
        if contrast < 22 {
            return self.darkest.saturating_sub(12);
        }
        self.lightest
            .saturating_sub(contrast.div_ceil(3))
            .saturating_sub(4)
    }
}

#[expect(
    clippy::arithmetic_side_effects,
    reason = "the validated pixel count bounds tile addressing"
)]
fn thresholds(gray: &Gray, width: usize, height: usize) -> Vec<u8> {
    let columns = width.div_ceil(TILE);
    let rows = height.div_ceil(TILE);
    let mut tiles = vec![Tone::empty(); columns * rows];
    for (yy, row) in gray.pixels.chunks_exact(width).enumerate().step_by(2) {
        let start = (yy >> 5_u32) * columns;
        if let Some(row_tiles) = tiles.get_mut(start..start + columns) {
            for (tile, pixels) in row_tiles.iter_mut().zip(row.chunks(TILE)) {
                for &pixel in pixels {
                    tile.include(pixel);
                }
            }
        }
    }
    let mut output = Vec::with_capacity(tiles.len());
    for yy in 0..rows {
        for xx in 0..columns {
            let mut tone = Tone::empty();
            let first = xx.saturating_sub(1);
            let end = (xx + 2).min(columns);
            for neighbor in yy.saturating_sub(1)..(yy + 2).min(rows) {
                let start = neighbor * columns;
                if let Some(neighbors) = tiles.get(start + first..start + end) {
                    for tile in neighbors {
                        tone.include(tile.darkest);
                        tone.include(tile.lightest);
                    }
                }
            }
            if let Some(local) = tiles.get(yy * columns + xx) {
                tone.lightest = local.lightest.max(tone.lightest.saturating_sub(100));
            }
            output.push(tone.threshold());
        }
    }
    output
}

#[expect(
    clippy::arithmetic_side_effects,
    reason = "at most 64 pixels with two 32-pixel tiles are packed into each word"
)]
fn pack(row: &[u8], thresholds: &[u8]) -> u64 {
    let mut word = 0_u64;
    for (index, (tile, &threshold)) in row.chunks(TILE).zip(thresholds).enumerate() {
        let mut bits = 0_u32;
        for (bit, &value) in (0_u32..32).zip(tile) {
            bits |= u32::from(value < threshold) << bit;
        }
        word |= u64::from(bits) << (TILE * index);
    }
    word
}

pub(crate) fn binarize(gray: &Gray) -> Result<Bits, RasterError> {
    if pixel_count(gray.width, gray.height)? != gray.pixels.len() {
        return Err(RasterError::Length);
    }
    let mut page = Bits::new(gray.width, gray.height)?;
    let width = usize::try_from(gray.width).map_err(|_cause| RasterError::Dimensions)?;
    let height = usize::try_from(gray.height).map_err(|_cause| RasterError::Dimensions)?;
    let columns = width.div_ceil(TILE);
    let cutoffs = thresholds(gray, width, height);
    for (yy, (row, words)) in gray
        .pixels
        .chunks_exact(width)
        .zip(page.words.chunks_exact_mut(page.stride_words))
        .enumerate()
    {
        let start = (yy >> 5_u32).saturating_mul(columns);
        if let Some(row_thresholds) = cutoffs.get(start..start.saturating_add(columns)) {
            for ((word, pixels), local) in words
                .iter_mut()
                .zip(row.chunks(64))
                .zip(row_thresholds.chunks(2))
            {
                *word = pack(pixels, local);
            }
        }
    }
    Ok(page)
}

#[cfg(test)]
mod tests {
    use crate::raster::{Gray, RasterError};

    use super::binarize;

    #[test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "assertions report mismatches and raster setup is fallible"
    )]
    fn shadow_and_bilevel() -> Result<(), RasterError> {
        let pixels = (0..8_u32)
            .flat_map(|yy| {
                (0..128_u32).map(move |xx| {
                    let background = if xx < 64 { 170_u8 } else { 255_u8 };
                    if (2..6).contains(&yy) && (15..110).contains(&xx) {
                        background.saturating_sub(100)
                    } else {
                        background
                    }
                })
            })
            .collect();
        let gray = Gray::new(128, 8, pixels)?;
        let page = binarize(&gray)?;
        assert!(!page.get(24, 0));
        assert!(page.get(24, 3));
        assert!(!page.get(121, 3));
        assert!(page.get(90, 4));
        let bilevel = binarize(&Gray::new(2, 1, vec![0, 255])?)?;
        assert_eq!(bilevel.words, [1]);
        Ok(())
    }
}
