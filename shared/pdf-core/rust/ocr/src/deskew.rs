use crate::raster::{Bits, RasterError, ink_runs};

const MARGIN: usize = 128;
const SAMPLE_X: u32 = 32;
const SAMPLE_Y: u32 = 3;

type Bounds = [u32; 4];

#[derive(Debug, Clone, Copy)]
pub(crate) struct Transform {
    pub(crate) height: u32,
    pub(crate) quarter_turns: u8,
    pub(crate) slope: i32,
    pub(crate) width: u32,
}

impl Transform {
    pub(crate) fn source(self, bbox: Bounds) -> Bounds {
        let [start, top, end, bottom] = bbox;
        let (mut left, mut upper, mut right, mut lower) = (self.width, self.height, 0, 0);
        let oriented_width = if self.quarter_turns == 1 || self.quarter_turns == 3 {
            self.height
        } else {
            self.width
        };
        for (xx, yy) in [(start, top), (end, top), (start, bottom), (end, bottom)] {
            let shifted = to_i32(yy)
                .saturating_add(offset(xx, oriented_width, self.slope))
                .max(0_i32)
                .unsigned_abs();
            let (source_x, source_y) = match self.quarter_turns {
                1 => (shifted, self.height.saturating_sub(xx)),
                2 => (
                    self.width.saturating_sub(xx),
                    self.height.saturating_sub(shifted),
                ),
                3 => (self.width.saturating_sub(shifted), xx),
                _ => (xx, shifted),
            };
            left = left.min(source_x);
            right = right.max(source_x.min(self.width));
            upper = upper.min(source_y);
            lower = lower.max(source_y.min(self.height));
        }
        [left.min(right), upper.min(lower), right, lower]
    }
}

fn to_i32(value: u32) -> i32 {
    i32::try_from(value).unwrap_or(i32::MAX)
}

fn offset(xx: u32, width: u32, slope: i32) -> i32 {
    let centered = to_i32(xx).saturating_sub(to_i32(width >> 1_u32));
    let scaled = centered.saturating_mul(slope);
    let magnitude = scaled.unsigned_abs().saturating_add(2048) >> 12_u32;
    to_i32(magnitude).saturating_mul(scaled.signum())
}

fn projections(page: &Bits) -> (Vec<u32>, Vec<u32>) {
    let mut horizontal = Vec::new();
    let width = usize::try_from(page.width).unwrap_or_default();
    let mut difference = vec![0_i32; width.saturating_add(1)];
    for yy in 0..page.height {
        let mut count = 0_u32;
        ink_runs(page.row(yy), page.width, |left, right| {
            count = count.saturating_add(right.saturating_sub(left));
            if let Ok(start) = usize::try_from(left)
                && let Some(slot) = difference.get_mut(start)
            {
                *slot = slot.saturating_add(1);
            }
            if let Ok(stop) = usize::try_from(right)
                && let Some(slot) = difference.get_mut(stop)
            {
                *slot = slot.saturating_sub(1);
            }
        });
        horizontal.push(count);
    }
    let mut sum = 0_i32;
    let vertical = difference
        .into_iter()
        .take(width)
        .map(|delta| {
            sum = sum.saturating_add(delta);
            sum.unsigned_abs()
        })
        .collect();
    (horizontal, vertical)
}

fn direction_score(profile: &[u32]) -> f64 {
    let begin = profile
        .iter()
        .position(|&mass| mass != 0)
        .unwrap_or_default();
    let end = profile
        .iter()
        .rposition(|&mass| mass != 0)
        .unwrap_or_default();
    let support = end.saturating_sub(begin).saturating_add(1);
    let mut score = 0.0_f64;
    let mut total = 0.0_f64;
    for window in profile.windows(16) {
        let Some((first, second)) = window.split_at_checked(8) else {
            continue;
        };
        let earlier: u32 = first.iter().sum();
        let later: u32 = second.iter().sum();
        let change = f64::from(earlier.abs_diff(later));
        score += change * change;
        total += f64::from(earlier);
    }
    score / (total * total).max(1.0) * f64::from(u32::try_from(support).unwrap_or_default())
}

fn edge_energy(profile: &[u32]) -> (f64, f64) {
    let (mut rises, mut falls) = (0.0_f64, 0.0_f64);
    for pair in profile.windows(3) {
        let upper = pair.first().copied().unwrap_or_default();
        let lower = pair.last().copied().unwrap_or_default();
        let rise = f64::from(lower.saturating_sub(upper));
        let fall = f64::from(upper.saturating_sub(lower));
        rises += rise * rise;
        falls += fall * fall;
    }
    (rises, falls)
}

fn axis_score(profile: &[u32], rises: f64, falls: f64) -> f64 {
    let asymmetry = (rises - falls).abs() / (rises + falls).max(1.0);
    direction_score(profile) * (1.0_f64 + 2.0_f64 * asymmetry)
}

#[expect(
    clippy::arithmetic_side_effects,
    reason = "the slope units and tested values are bounded"
)]
fn estimate(page: &Bits) -> i32 {
    let columns = usize::try_from(page.width.div_ceil(SAMPLE_X)).unwrap_or_default();
    let row_step = usize::try_from(SAMPLE_Y).unwrap_or(1);
    let mut bins = vec![0_u32; columns];
    let mut samples = Vec::new();
    for yy in (0..page.height).step_by(row_step) {
        bins.fill(0);
        ink_runs(page.row(yy), page.width, |left, right| {
            let center = u32::midpoint(left, right);
            if let Ok(index) = usize::try_from(center >> 5_u32)
                && let Some(bin) = bins.get_mut(index)
            {
                *bin += (right - left).min(SAMPLE_X);
            }
        });
        samples.extend(bins.iter().enumerate().filter_map(|(index, &count)| {
            let xx = u32::try_from(index).ok()? * SAMPLE_X + (SAMPLE_X >> 1_u32);
            (count > 0).then_some((xx, yy, count))
        }));
    }
    if samples.len() < 30 {
        return 0;
    }
    let height = usize::try_from(page.height).unwrap_or_default();
    let mut profile = vec![0_u32; height + MARGIN * 2];
    let margin = i32::try_from(MARGIN).unwrap_or_default();
    let mut evaluate = |slope| {
        profile.fill(0);
        for &(xx, yy, weight) in &samples {
            let row = to_i32(yy) + margin - offset(xx, page.width, slope);
            if let Ok(index) = usize::try_from(row)
                && let Some(slot) = profile.get_mut(index)
            {
                *slot += weight;
            }
        }
        profile.windows(3).fold(0_u64, |score, neighborhood| {
            let mass = u64::from(neighborhood.iter().sum::<u32>());
            score.saturating_add(mass.saturating_mul(mass))
        })
    };
    let reference = evaluate(0_i32);
    let mut best = (reference, 0_i32);
    for slope in (-384_i32..=384_i32).step_by(32) {
        let score = evaluate(slope);
        if score > best.0 {
            best = (score, slope);
        }
    }
    for slope in (best.1 - 24_i32..=best.1 + 24_i32).step_by(8) {
        let score = evaluate(slope);
        if score > best.0 {
            best = (score, slope);
        }
    }
    if best.1.abs() >= 15 && best.0.saturating_mul(100) > reference.saturating_mul(102) {
        best.1
    } else {
        0
    }
}

fn orient(page: &Bits, turns: u8) -> Result<Bits, RasterError> {
    let sideways = turns == 1 || turns == 3;
    let (width, height) = if sideways {
        (page.height, page.width)
    } else {
        (page.width, page.height)
    };
    let mut output = Bits::new(width, height)?;
    for yy in 0..page.height {
        ink_runs(page.row(yy), page.width, |start, end| match turns {
            1 => {
                for xx in start..end {
                    output.set(page.height.saturating_sub(1).saturating_sub(yy), xx, true);
                }
            }
            2 => output.set_run(
                page.height.saturating_sub(1).saturating_sub(yy),
                page.width.saturating_sub(end),
                page.width.saturating_sub(start),
                true,
            ),
            3 => {
                for xx in start..end {
                    output.set(yy, page.width.saturating_sub(1).saturating_sub(xx), true);
                }
            }
            _ => output.set_run(yy, start, end, true),
        });
    }
    Ok(output)
}

fn shear(page: &Bits, slope: i32) -> Result<Bits, RasterError> {
    let mut output = Bits::new(page.width, page.height)?;
    let shifts: Vec<_> = (0..page.width)
        .map(|xx| offset(xx, page.width, slope))
        .collect();
    for yy in 0..page.height {
        ink_runs(page.row(yy), page.width, |start, end| {
            let (Ok(first), Ok(last)) = (usize::try_from(start), usize::try_from(end)) else {
                return;
            };
            let Some(span) = shifts.get(first..last) else {
                return;
            };
            let mut left = start;
            for group in span.chunk_by(|first_shift, second_shift| first_shift == second_shift) {
                let right = left.saturating_add(u32::try_from(group.len()).unwrap_or_default());
                if let Some(&shift) = group.first()
                    && let Ok(row) = u32::try_from(to_i32(yy).saturating_sub(shift))
                {
                    output.set_run(row, left, right, true);
                }
                left = right;
            }
        });
    }
    Ok(output)
}

pub(crate) fn straighten(
    mut page: Bits,
    detect_orientation: bool,
) -> Result<(Bits, Transform), RasterError> {
    let mut transform = Transform {
        height: page.height,
        quarter_turns: 0,
        slope: 0,
        width: page.width,
    };
    if detect_orientation {
        let (horizontal, vertical) = projections(&page);
        let (rise_y, fall_y) = edge_energy(&horizontal);
        let (rise_x, fall_x) = edge_energy(&vertical);
        let horizontal_score = axis_score(&horizontal, rise_y, fall_y);
        let vertical_score = axis_score(&vertical, rise_x, fall_x);
        if vertical_score > horizontal_score * 1.15_f64 {
            transform.quarter_turns = if rise_x > fall_x * 1.2_f64 { 3 } else { 1 };
        } else if rise_y > fall_y * 1.2_f64 {
            transform.quarter_turns = 2;
        }
        if transform.quarter_turns != 0 {
            page = orient(&page, transform.quarter_turns)?;
        }
    }
    transform.slope = estimate(&page);
    if transform.slope != 0_i32 {
        page = shear(&page, transform.slope)?;
    }
    Ok((page, transform))
}

#[cfg(test)]
mod tests {
    use crate::raster::{Bits, RasterError};

    use super::{estimate, offset, orient, straighten, to_i32};

    #[test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "assertions report mismatches and raster setup is fallible"
    )]
    fn estimates_skew_across_range() -> Result<(), RasterError> {
        let slopes: [i32; 11] = [-358, -286, -215, -143, -72, 0, 72, 143, 215, 286, 358];
        for slope in slopes {
            let mut page = Bits::new(1000, 600)?;
            for baseline in (100..500_u32).step_by(31) {
                for left in (50..950_u32).step_by(19) {
                    for xx in left..left.saturating_add(10) {
                        let center = to_i32(baseline).saturating_add(offset(xx, page.width, slope));
                        for yy in center..center.saturating_add(13) {
                            if let Ok(row) = u32::try_from(yy) {
                                page.set(xx, row, true);
                            }
                        }
                    }
                }
            }
            let measured = estimate(&page);
            assert!(
                measured.abs_diff(slope) <= 12,
                "slope {slope}, measured {measured}"
            );
        }
        Ok(())
    }

    #[test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "assertions report mismatches and raster setup is fallible"
    )]
    fn orients_asymmetric_text() -> Result<(), RasterError> {
        let mut page = Bits::new(720, 900)?;
        for top in (100..800_u32).step_by(43) {
            for left in (100..600_u32).step_by(19) {
                for yy in top..top.saturating_add(19) {
                    if left & 1 == 0 || yy >= top.saturating_add(7) {
                        page.set_run(yy, left, left.saturating_add(9), true);
                    }
                }
            }
        }
        for turns in 0..4_u8 {
            let oriented = orient(&page, turns)?;
            let (restored, transform) = straighten(oriented, true)?;
            assert!(
                restored == page,
                "input turns {turns}, applied {transform:?}"
            );
        }
        Ok(())
    }
}
