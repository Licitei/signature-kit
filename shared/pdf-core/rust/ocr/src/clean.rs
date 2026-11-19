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
            previous.start = previous.start.min(rule.start);
            previous.end = previous.end.max(rule.end);
        } else {
            merged.push(rule);
        }
    }
    merged
}

fn vertical_rules(page: &Bits, minimum: u32) -> Vec<Rule> {
    let width = usize::try_from(page.width).unwrap_or_default();
    let mut active = vec![(0_u32, 0_u32); width];
    let mut rules = Vec::new();
    for yy in 0..page.height {
        let row_number = yy.saturating_add(1);
        ink_runs(page.row(yy), page.width, |start, end| {
            let (Ok(first), Ok(last)) = (usize::try_from(start), usize::try_from(end)) else {
                return;
            };
            if let Some(columns) = active.get_mut(first..last) {
                for (xx, (top, previous)) in (start..end).zip(columns) {
                    if previous.saturating_add(1) != row_number {
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
    let mut rules = vertical_rules(page, vertical);
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
        let rows: Vec<_> = horizontal
            .iter()
            .filter(|candidate| {
                columns
                    .iter()
                    .all(|&column| intersects(**candidate, column))
            })
            .map(|rule| rule.position)
            .collect();
        if rows.len() < 2 {
            continue;
        }
        let positions: Vec<_> = columns.into_iter().map(|rule| rule.position).collect();
        let grid = TableGrid {
            columns: positions,
            rows,
        };
        if !grids.contains(&grid) {
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
