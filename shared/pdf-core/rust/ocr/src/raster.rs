#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
use core::arch::wasm32::{
    i8x16_popcnt, u16x8_extadd_pairwise_u8x16, u32x4_extadd_pairwise_u16x8, u32x4_extract_lane,
    v128, v128_any_true, v128_load,
};

use core::{num::TryFromIntError, str};

#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct Gray {
    pub height: u32,
    pub pixels: Vec<u8>,
    pub width: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct Bits {
    pub height: u32,
    pub stride_words: usize,
    pub width: u32,
    pub words: Vec<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
#[expect(
    clippy::module_name_repetitions,
    reason = "the error is also exposed by image decoders"
)]
pub enum RasterError {
    Dimensions,
    Format,
    Length,
}

struct Runs<Visit> {
    offset: u32,
    pending: Option<u32>,
    visit: Visit,
    width: u32,
}

impl Gray {
    /// # Errors
    /// Returns a raster error for invalid dimensions or pixel length.
    #[inline]
    pub fn new(width: u32, height: u32, pixels: Vec<u8>) -> Result<Self, RasterError> {
        if pixel_count(width, height)? != pixels.len() {
            return Err(RasterError::Length);
        }
        Ok(Self {
            height,
            pixels,
            width,
        })
    }
}

impl Bits {
    #[inline]
    #[must_use]
    pub fn get(&self, xx: u32, yy: u32) -> bool {
        let Some((index, mask)) = self.location(xx, yy) else {
            return false;
        };
        self.words.get(index).is_some_and(|word| word & mask != 0)
    }

    #[inline]
    fn location(&self, xx: u32, yy: u32) -> Option<(usize, u64)> {
        if xx >= self.width || yy >= self.height {
            return None;
        }
        let column = usize::try_from(xx).ok()?;
        let row = usize::try_from(yy).ok()?;
        let index = row
            .saturating_mul(self.stride_words)
            .saturating_add(column >> 6);
        Some((index, 1_u64.wrapping_shl(xx & 63)))
    }

    /// # Errors
    /// Returns a raster error for invalid dimensions.
    #[inline]
    pub fn new(width: u32, height: u32) -> Result<Self, RasterError> {
        let _count = pixel_count(width, height)?;
        let stride_words =
            usize::try_from(width.div_ceil(64)).map_err(|_cause| RasterError::Dimensions)?;
        let rows = usize::try_from(height).map_err(|_cause| RasterError::Dimensions)?;
        Ok(Self {
            width,
            height,
            stride_words,
            words: vec![0; stride_words.saturating_mul(rows)],
        })
    }

    #[inline]
    #[must_use]
    pub fn row(&self, yy: u32) -> &[u64] {
        let Ok(row) = usize::try_from(yy) else {
            return &[];
        };
        let start = row.saturating_mul(self.stride_words);
        self.words
            .get(start..start.saturating_add(self.stride_words))
            .unwrap_or_default()
    }

    #[inline]
    pub fn set(&mut self, xx: u32, yy: u32, ink: bool) {
        if let Some((index, mask)) = self.location(xx, yy)
            && let Some(word) = self.words.get_mut(index)
        {
            if ink {
                *word |= mask;
            } else {
                *word &= !mask;
            }
        }
    }

    pub(crate) fn set_run(&mut self, yy: u32, start: u32, end: u32, ink: bool) {
        if end <= start || end > self.width {
            return;
        }
        let Some((first, first_bit)) = self.location(start, yy) else {
            return;
        };
        let Some((last, last_bit)) = self.location(end.saturating_sub(1), yy) else {
            return;
        };
        if let Some(words) = self.words.get_mut(first..=last) {
            let low = 0_u64.wrapping_sub(first_bit);
            let high = last_bit.wrapping_sub(1) | last_bit;
            let count = words.len();
            for (index, word) in words.iter_mut().enumerate() {
                let left = if index == 0 { low } else { u64::MAX };
                let right = if index.saturating_add(1) == count {
                    high
                } else {
                    u64::MAX
                };
                if ink {
                    *word |= left & right;
                } else {
                    *word &= !(left & right);
                }
            }
        }
    }
}

impl<Visit> Runs<Visit>
where
    Visit: FnMut(u32, u32),
{
    fn word(&mut self, packed: u64) {
        let mut word = packed;
        if let Some(start) = self.pending {
            let ones = word.trailing_ones();
            if ones == 64 {
                self.offset = self.offset.saturating_add(64);
                return;
            }
            (self.visit)(start, self.offset.saturating_add(ones).min(self.width));
            self.pending = None;
            word &= u64::MAX.wrapping_shl(ones);
        }
        while word != 0 {
            let start = word.trailing_zeros();
            let length = word.wrapping_shr(start).trailing_ones();
            let end = start.saturating_add(length);
            let left = self.offset.saturating_add(start);
            if end == 64 {
                self.pending = Some(left);
                break;
            }
            if left < self.width {
                (self.visit)(left, self.offset.saturating_add(end).min(self.width));
            }
            word &= u64::MAX.wrapping_shl(end);
        }
        self.offset = self.offset.saturating_add(64);
    }
}

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
#[expect(
    unsafe_code,
    clippy::cast_ptr_alignment,
    reason = "v128_load accepts unaligned word pairs"
)]
fn load_pair(words: &[u64; 2]) -> v128 {
    // SAFETY: The fixed-size word pair provides 16 readable bytes and the load accepts unaligned addresses.
    unsafe { v128_load(words.as_ptr().cast::<v128>()) }
}

pub(crate) fn ink_counts(row: &[u64], bins: &mut Vec<u32>) {
    bins.clear();
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    let tail_words = {
        let (pairs, tail) = row.as_chunks::<2>();
        for pair in pairs {
            let counts = i8x16_popcnt(load_pair(pair));
            let sums = u32x4_extadd_pairwise_u16x8(u16x8_extadd_pairwise_u8x16(counts));
            bins.extend([
                u32x4_extract_lane::<0>(sums),
                u32x4_extract_lane::<1>(sums),
                u32x4_extract_lane::<2>(sums),
                u32x4_extract_lane::<3>(sums),
            ]);
        }
        tail
    };
    #[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
    let tail_words = row;
    for &word in tail_words {
        bins.extend([
            (word & u64::from(u32::MAX)).count_ones(),
            (word >> 32_u32).count_ones(),
        ]);
    }
}

pub(crate) fn ink_runs<Visit>(row: &[u64], width: u32, visit: Visit)
where
    Visit: FnMut(u32, u32),
{
    let mut runs = Runs {
        offset: 0,
        pending: None,
        visit,
        width,
    };
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    let tail_words = {
        let (pairs, tail) = row.as_chunks::<2>();
        for pair in pairs {
            if runs.pending.is_none() && !v128_any_true(load_pair(pair)) {
                runs.offset = runs.offset.saturating_add(128);
            } else {
                for &word in pair {
                    runs.word(word);
                }
            }
        }
        tail
    };
    #[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
    let tail_words = row;
    for &word in tail_words {
        runs.word(word);
    }
    if let Some(start) = runs.pending
        && start < width
    {
        (runs.visit)(start, width);
    }
}

pub(crate) fn pixel_count(width: u32, height: u32) -> Result<usize, RasterError> {
    let count = u64::from(width).saturating_mul(u64::from(height));
    if count == 0
        || count > 32_000_000
        || width > u32::from(u16::MAX)
        || height > u32::from(u16::MAX)
    {
        return Err(RasterError::Dimensions);
    }
    usize::try_from(count).map_err(|_cause: TryFromIntError| RasterError::Dimensions)
}

fn token<'data>(remaining: &mut &'data [u8]) -> Option<&'data [u8]> {
    loop {
        *remaining = remaining.trim_ascii_start();
        if !remaining.starts_with(b"#") {
            break;
        }
        let end = remaining.iter().position(|&byte| byte == b'\n')?;
        *remaining = remaining.get(end..)?;
    }
    let end = remaining.iter().position(u8::is_ascii_whitespace)?;
    let (head, tail) = remaining.split_at_checked(end)?;
    *remaining = tail;
    Some(head)
}

/// # Errors
/// Returns a raster error for invalid or unsupported P5 data.
#[inline]
pub fn read_pgm(bytes: &[u8]) -> Result<Gray, RasterError> {
    let mut remaining = bytes;
    if token(&mut remaining) != Some(b"P5") {
        return Err(RasterError::Format);
    }
    let mut number = || {
        token(&mut remaining)
            .and_then(|part| str::from_utf8(part).ok())
            .and_then(|part| part.parse::<u32>().ok())
            .ok_or(RasterError::Format)
    };
    let width = number()?;
    let height = number()?;
    let max = number()?;
    let count = pixel_count(width, height)?;
    let separator = if remaining.starts_with(b"\r\n") && remaining.len() == count.saturating_add(2)
    {
        2
    } else {
        1
    };
    let pixels = remaining.get(separator..).ok_or(RasterError::Format)?;
    if pixels.len() != count {
        return Err(RasterError::Length);
    }
    if max == 255 {
        return Gray::new(width, height, pixels.to_vec());
    }
    if !(1..255).contains(&max) || pixels.iter().any(|&pixel| u32::from(pixel) > max) {
        return Err(RasterError::Format);
    }
    let scaled = pixels
        .iter()
        .map(|&pixel| {
            u8::try_from(
                u32::from(pixel)
                    .saturating_mul(255)
                    .checked_div(max)
                    .unwrap_or_default(),
            )
            .unwrap_or_default()
        })
        .collect();
    Gray::new(width, height, scaled)
}

#[inline]
#[must_use]
pub fn write_pgm(gray: &Gray) -> Vec<u8> {
    let mut bytes = format!("P5\n{} {}\n255\n", gray.width, gray.height).into_bytes();
    bytes.extend_from_slice(&gray.pixels);
    bytes
}

#[cfg(test)]
mod tests {
    use super::{Bits, RasterError, ink_runs, read_pgm, write_pgm};

    #[test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "assertions report test mismatches and setup uses Result"
    )]
    fn pgm_keeps_binary_whitespace() -> Result<(), RasterError> {
        let gray = read_pgm(b"P5\n# scan\n2 2\n255\n\n \x00\xff")?;
        assert_eq!(gray.pixels, [10, 32, 0, 255]);
        assert_eq!(read_pgm(&write_pgm(&gray))?, gray);
        assert_eq!(read_pgm(b"P5\n2 2\n255\n\x00"), Err(RasterError::Length));
        Ok(())
    }

    #[test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "assertions report test mismatches and setup uses Result"
    )]
    fn packed_rows_keep_padding_clear() -> Result<(), RasterError> {
        let mut bits = Bits::new(65, 2)?;
        bits.set(63, 0, true);
        bits.set(64, 0, true);
        bits.set(65, 0, true);
        bits.set(0, 1, true);
        assert_eq!(bits.row(0), [1_u64 << 63_u32, 1]);
        assert_eq!(bits.row(1), [1, 0]);
        assert!(!bits.get(65, 0));
        bits.set(64, 0, false);
        assert!(!bits.get(64, 0));
        Ok(())
    }

    #[test]
    fn ink_runs_join_packed_words_and_stop_at_the_row_width() {
        let mut bits = Bits::new(129, 1).unwrap();
        bits.set_run(0, 62, 67, true);
        bits.set_run(0, 126, 129, true);
        let mut spans = Vec::new();
        ink_runs(bits.row(0), bits.width, |start, end| {
            spans.push((start, end));
        });
        assert_eq!(spans, [(62, 67), (126, 129)]);
    }
}
