use crate::raster::{Bits, ink_runs};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub struct Rule {
    pub end: u32,
    pub horizontal: bool,
    pub position: u32,
    pub start: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct TableGrid {
    pub columns: Vec<u32>,
    pub rows: Vec<u32>,
}

fn merge_rules(mut rules: Vec<Rule>) -> Vec<Rule> {
    rules.sort_unstable_by_key(|rule| (rule.horizontal, rule.position, rule.start));
    let mut merged = Vec::<Rule>::new();
    for rule in rules {
        if let Some(previous) = merged.last_mut()
            && previous.horizontal == rule.horizontal
            && previous.position.abs_diff(rule.position) <= 2
            && previous.start.abs_diff(rule.start) <= 8
            && previous.end.abs_diff(rule.end) <= 8
        {
            previous.position = u32::midpoint(previous.position, rule.position);
            previous.start = previous.start.min(rule.start);
            previous.end = previous.end.max(rule.end);
        } else {
            merged.push(rule);
        }
    }
    merged
}

fn vertical_rules(page: &Bits, minimum: u32, tolerant: bool) -> Vec<Rule> {
    let width = usize::try_from(page.width).unwrap_or_default();
    let mut active = vec![(0_u32, 0_u32); width];
    let mut rules = Vec::new();
    let dilation = u32::from(tolerant);
    let vertical_gap = if tolerant { 3 } else { 1 };
    for yy in 0..page.height {
        let row_number = yy.saturating_add(1);
        ink_runs(page.row(yy), page.width, |run_start, run_end| {
            let start = run_start.saturating_sub(dilation);
            let end = run_end.saturating_add(dilation).min(page.width);
            let (Ok(first), Ok(last)) = (usize::try_from(start), usize::try_from(end)) else {
                return;
            };
            if let Some(columns) = active.get_mut(first..last) {
                for (xx, (top, previous)) in (start..end).zip(columns) {
                    if *previous == row_number {
                        continue;
                    }
                    if *previous == 0 || previous.saturating_add(vertical_gap) < row_number {
                        if previous.saturating_sub(*top) >= minimum {
                            rules.push(Rule {
                                end: *previous,
                                horizontal: false,
                                position: xx,
                                start: *top,
                            });
                        }
                        *top = yy;
                    }
                    *previous = row_number;
                }
            }
        });
    }
    for (position, (start, end)) in (0..page.width).zip(active) {
        if end.saturating_sub(start) >= minimum {
            rules.push(Rule {
                end,
                horizontal: false,
                position,
                start,
            });
        }
    }
    rules
}

fn remove_isolated(page: &mut Bits) {
    let source = page.clone();
    let stride = page.stride_words;
    for (yy, row) in (0..page.height).zip(page.words.chunks_exact_mut(stride)) {
        let previous = yy
            .checked_sub(1)
            .map(|row_index| source.row(row_index))
            .unwrap_or_default();
        let current = source.row(yy);
        let next = source.row(yy.saturating_add(1));
        let neighbor = |index| {
            previous.get(index).copied().unwrap_or_default()
                | current.get(index).copied().unwrap_or_default()
                | next.get(index).copied().unwrap_or_default()
        };
        let mut left = 0_u64;
        let mut center = neighbor(0);
        for (index, word) in row.iter_mut().enumerate() {
            let right = neighbor(index.saturating_add(1));
            let adjacent = (center << 1_u32)
                | (center >> 1_u32)
                | (left >> 63_u32)
                | (right << 63_u32)
                | previous.get(index).copied().unwrap_or_default()
                | next.get(index).copied().unwrap_or_default();
            *word &= adjacent;
            left = center;
            center = right;
        }
    }
}

fn span_count(row: &[u64], start: u32, end: u32) -> u32 {
    let Ok(first) = usize::try_from(start >> 6_u32) else {
        return 0;
    };
    let Ok(last) = usize::try_from(end.saturating_sub(1) >> 6_u32) else {
        return 0;
    };
    let Some(words) = row.get(first..=last) else {
        return 0;
    };
    let low = u64::MAX.wrapping_shl(start & 63);
    let high = u64::MAX.wrapping_shr(63_u32.saturating_sub(end.saturating_sub(1) & 63));
    words
        .iter()
        .enumerate()
        .map(|(position, &word)| {
            let left = if position == 0 { low } else { u64::MAX };
            let right = if position.saturating_add(1) == words.len() {
                high
            } else {
                u64::MAX
            };
            (word & left & right).count_ones()
        })
        .sum()
}

fn horizontal_rules(page: &Bits, minimum: u32, rules: &mut Vec<Rule>) {
    let mut band = vec![0_u64; page.stride_words];
    for yy in 0..page.height {
        let before = yy
            .checked_sub(1)
            .map(|row| page.row(row))
            .unwrap_or_default();
        let after = page.row(yy.saturating_add(1));
        for (index, (pixel, &current)) in band.iter_mut().zip(page.row(yy)).enumerate() {
            *pixel = current
                | before.get(index).copied().unwrap_or_default()
                | after.get(index).copied().unwrap_or_default();
        }
        let current_row = page.row(yy);
        let mut segment: Option<(u32, u32, u32)> = None;
        let mut push = |start: u32, end: u32, ink: u32| {
            let length = end.saturating_sub(start);
            if length >= minimum
                && ink.saturating_mul(100) >= length.saturating_mul(94)
                && [before, current_row, after].into_iter().any(|row| {
                    span_count(row, start, end).saturating_mul(5) >= length.saturating_mul(3)
                })
            {
                rules.push(Rule {
                    end,
                    horizontal: true,
                    position: yy,
                    start,
                });
            }
        };
        ink_runs(&band, page.width, |left, right| {
            let count = right.saturating_sub(left);
            if let Some((start, end, ink)) = segment {
                if left.saturating_sub(end) <= 2 {
                    segment = Some((start, right, ink.saturating_add(count)));
                    return;
                }
                push(start, end, ink);
            }
            segment = Some((left, right, count));
        });
        if let Some((start, end, ink)) = segment {
            push(start, end, ink);
        }
    }
}

pub(crate) fn clean(page: &mut Bits, dpi: f32) -> Vec<Rule> {
    let nominal = if dpi < 175.0 {
        45
    } else if dpi > 450.0 {
        140
    } else {
        85
    };
    let horizontal = (page.width >> 4_u32).max(nominal);
    let vertical = (page.height >> 5_u32).max(nominal);
    let mut rules = Vec::new();
    for yy in 0..page.height {
        ink_runs(page.row(yy), page.width, |start, end| {
            if end.saturating_sub(start) >= horizontal {
                rules.push(Rule {
                    end,
                    horizontal: true,
                    position: yy,
                    start,
                });
            }
        });
    }
    let first_long_rule = rules
        .iter()
        .find(|rule| rule.end.saturating_sub(rule.start) >= page.width.div_ceil(3));
    let tolerant = first_long_rule.is_some_and(|first| {
        rules.iter().any(|rule| {
            rule.position.saturating_sub(first.position) >= nominal.div_ceil(3)
                && rule.end.saturating_sub(rule.start) >= page.width.div_ceil(3)
        })
    });
    if tolerant {
        rules.clear();
        horizontal_rules(page, horizontal, &mut rules);
    }
    rules.extend(vertical_rules(page, vertical, tolerant));
    for rule in &rules {
        if rule.horizontal {
            page.set_run(rule.position, rule.start, rule.end, false);
        } else {
            for yy in rule.start..rule.end {
                page.set(rule.position, yy, false);
            }
        }
    }
    let margin_x = page.width >> 6_u32;
    let margin_y = page.height >> 6_u32;
    rules.retain(|rule| {
        let (margin, dimension) = if rule.horizontal {
            (margin_y, page.height)
        } else {
            (margin_x, page.width)
        };
        rule.position >= margin && rule.position < dimension.saturating_sub(margin)
    });
    remove_isolated(page);
    merge_rules(rules)
}

fn shared_boundaries(first: &[u32], second: &[u32]) -> usize {
    first
        .iter()
        .filter(|&&boundary| second.iter().any(|&other| boundary.abs_diff(other) <= 5))
        .count()
}

fn merge_boundaries(current: &mut Vec<u32>, incoming: Vec<u32>) {
    current.extend(incoming);
    current.sort_unstable();
    current.dedup_by(|later, earlier| later.abs_diff(*earlier) <= 5);
}

pub(crate) fn grids(rules: &[Rule]) -> Vec<TableGrid> {
    let horizontal: Vec<_> = rules
        .iter()
        .copied()
        .filter(|rule| rule.horizontal)
        .collect();
    let vertical: Vec<_> = rules
        .iter()
        .copied()
        .filter(|rule| !rule.horizontal)
        .collect();
    let mut grids = Vec::<TableGrid>::new();
    for anchor in horizontal.iter().take(256) {
        let mut columns: Vec<_> = vertical
            .iter()
            .copied()
            .filter(|vertical_rule| intersects(*anchor, *vertical_rule))
            .collect();
        if columns.len() < 2 {
            continue;
        }
        columns.sort_unstable_by_key(|rule| rule.position);
        columns.dedup_by(|later, earlier| later.position.abs_diff(earlier.position) <= 5);
        if columns.len() < 2 {
            continue;
        }
        let mut rows: Vec<_> = horizontal
            .iter()
            .filter(|candidate| {
                columns
                    .iter()
                    .all(|&column| intersects(**candidate, column))
            })
            .map(|rule| rule.position)
            .collect();
        rows.dedup_by(|later, earlier| later.abs_diff(*earlier) <= 5);
        if rows.len() < 2 {
            continue;
        }
        let positions: Vec<_> = columns.into_iter().map(|rule| rule.position).collect();
        let grid = TableGrid {
            columns: positions,
            rows,
        };
        if let Some(existing) = grids.iter_mut().find(|existing| {
            shared_boundaries(&existing.columns, &grid.columns) >= 2
                && shared_boundaries(&existing.rows, &grid.rows) >= 2
        }) {
            merge_boundaries(&mut existing.columns, grid.columns);
            merge_boundaries(&mut existing.rows, grid.rows);
        } else {
            grids.push(grid);
        }
    }
    grids
}

const fn intersects(horizontal: Rule, vertical: Rule) -> bool {
    let tolerance = 4;
    horizontal.start <= vertical.position.saturating_add(tolerance)
        && horizontal.end.saturating_add(tolerance) >= vertical.position
        && vertical.start <= horizontal.position.saturating_add(tolerance)
        && vertical.end.saturating_add(tolerance) >= horizontal.position
}

#[cfg(test)]
mod tests {
    use crate::raster::{Bits, RasterError};

    use super::{TableGrid, clean, grids};

    #[test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "assertions report mismatches and raster setup is fallible"
    )]
    fn keeps_grid_geometry_after_clearing_rules() -> Result<(), RasterError> {
        let mut page = Bits::new(400, 300)?;
        for row in [40, 120, 220] {
            page.set_run(row, 40, 340, true);
        }
        for yy in 40..=220 {
            for xx in [40, 180, 339] {
                page.set(xx, yy, true);
            }
        }
        page.set_run(80, 55, 62, true);
        let rules = clean(&mut page, 300.0);
        assert_eq!(
            grids(&rules),
            [TableGrid {
                columns: vec![40, 180, 339],
                rows: vec![40, 120, 220]
            }]
        );
        assert!(page.get(61, 80));
        assert!(!page.get(40, 80));
        assert!(!page.get(45, 120));
        Ok(())
    }
}
