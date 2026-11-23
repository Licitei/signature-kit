use core::cmp::Ordering;
use core::iter::once;
use core::mem::swap;

use crate::layout::{Frag, Line};
use crate::num::sort_unstable_with;

const GUTTER_EM: f64 = 0.75;
const GUTTER_LINES: usize = 4;
const SIDE_LINES: usize = 3;
const PROSE_HALF_WORDS: usize = 6;
const WORD_LETTERS: usize = 3;
const LIST_LINES: usize = 12;
const LIST_SNAP: f64 = 1.0;
const LIST_LEVELS: usize = 3;
const LIST_HALF_WORDS: usize = 3;
const LIST_GUTTER_EM: f64 = 2.5;
const FLOW_SHARE: usize = 4;
const LEVEL_SHARE: usize = 7;
const LEVEL_REACH_EM: f64 = 4.0;
const EDGE_SLACK: f64 = 0.5;
const MAX_DEPTH: usize = 24;
const BREAK_PITCH: f64 = 1.4;
const SYNC_BREAKS: usize = 3;
const SYNC_REACH: f64 = 0.5;
const HOLE_EM: f64 = 4.0;
const MIN_SIZE: f64 = 1.0;

#[derive(Clone, Copy)]
struct Open {
    first: usize,
    last: usize,
    left: usize,
    right: usize,
    size: f64,
    x0: f64,
    x1: f64,
}

#[derive(Clone, Copy, Debug)]
struct Gutter {
    bottom: f64,
    first: usize,
    last: usize,
    top: f64,
    x0: f64,
    x1: f64,
}

#[derive(Default)]
struct Side {
    centers: Vec<f64>,
    edges: Vec<(char, char, bool)>,
    levels: Vec<f64>,
    lines: usize,
    numeric: usize,
    words: usize,
}

#[derive(Default)]
pub(crate) struct Region {
    pub frags: Vec<usize>,
    pub tables: Vec<usize>,
}

struct Partition<'items, 'data> {
    frags: &'items [Frag<'data>],
    gutters: &'items [Gutter],
    line_of: &'items [usize],
    tables: &'items [[f64; 4]],
}

impl Gutter {
    const fn mid(&self) -> f64 {
        f64::midpoint(self.x0, self.x1)
    }

    const fn span(&self) -> usize {
        self.last.saturating_sub(self.first)
    }
}

impl Side {
    fn add(&mut self, frags: &[Frag<'_>], members: &[usize], center: f64) {
        let Some(start) = members.first().and_then(|&index| frags.get(index)) else {
            return;
        };
        self.lines = self.lines.saturating_add(1);
        self.centers.push(center);
        self.levels.push(start.x0);
        let mut words = 0_usize;
        let mut letters = false;
        for frag in members.iter().filter_map(|&index| frags.get(index)) {
            words = words.saturating_add(
                frag.text
                    .split_whitespace()
                    .filter(|word| {
                        word.chars().filter(|ch| ch.is_alphabetic()).count() >= WORD_LETTERS
                    })
                    .count(),
            );
            letters |= frag.text.chars().any(char::is_alphabetic);
        }
        self.words = self.words.saturating_add(words);
        if !letters {
            self.numeric = self.numeric.saturating_add(1);
        }
        let first = members
            .iter()
            .filter_map(|&index| frags.get(index))
            .find_map(|frag| frag.text.trim_start().chars().next());
        let mut tail = members
            .iter()
            .rev()
            .filter_map(|&index| frags.get(index))
            .find_map(|frag| {
                let trimmed = frag.text.trim_end();
                (!trimmed.is_empty()).then_some(trimmed)
            })
            .unwrap_or_default()
            .chars()
            .rev();
        if let (Some(head), Some(last)) = (first, tail.next()) {
            let hyphen = last == '-' && tail.next().is_some_and(char::is_alphabetic);
            self.edges.push((head, last, hyphen));
        }
    }

    fn breaks(&self) -> (Vec<f64>, f64) {
        let mut gaps: Vec<f64> = self
            .centers
            .iter()
            .zip(self.centers.iter().skip(1))
            .map(|(upper, lower)| upper - lower)
            .collect();
        let found = |pitch: f64| {
            self.centers
                .iter()
                .zip(self.centers.iter().skip(1))
                .filter(|(upper, lower)| *upper - *lower > BREAK_PITCH * pitch)
                .map(|(_, lower)| *lower)
                .collect()
        };
        sort_unstable_with(&mut gaps, &f64::total_cmp);
        let pitch = gaps
            .get(gaps.len().checked_div(2).unwrap_or(0))
            .copied()
            .unwrap_or(0.0_f64);
        (found(pitch), pitch)
    }

    fn flowing(&self) -> bool {
        let mut pairs = 0_usize;
        let mut joins = 0_usize;
        for (upper, lower) in self.edges.iter().zip(self.edges.iter().skip(1)) {
            pairs = pairs.saturating_add(1);
            let open = upper.1.is_alphabetic() || upper.1 == ',';
            if upper.2 || (open && lower.0.is_lowercase()) {
                joins = joins.saturating_add(1);
            }
        }
        pairs >= SIDE_LINES && joins.saturating_mul(FLOW_SHARE) >= pairs
    }

    fn list(&mut self, size: f64) -> bool {
        if self.lines < LIST_LINES
            || self.words.saturating_mul(2) < self.lines.saturating_mul(LIST_HALF_WORDS)
        {
            return false;
        }
        let mut groups = self.snapped(LIST_SNAP);
        let mut top: Vec<(f64, usize)> = Vec::with_capacity(LIST_LEVELS);
        for _ in 0..LIST_LEVELS {
            let Some(best) = groups
                .iter()
                .enumerate()
                .max_by_key(|entry| entry.1.1)
                .map(|entry| entry.0)
            else {
                break;
            };
            top.push(groups.swap_remove(best));
        }
        let covered = top
            .iter()
            .fold(0_usize, |sum, group| sum.saturating_add(group.1));
        let (low, high) = top
            .iter()
            .fold((f64::INFINITY, f64::NEG_INFINITY), |(low, high), group| {
                (low.min(group.0), high.max(group.0))
            });
        let levels = top
            .iter()
            .filter(|group| group.1.saturating_mul(LEVEL_SHARE) >= self.lines)
            .count();
        covered.saturating_mul(20) >= self.lines.saturating_mul(17)
            && high - low <= LEVEL_REACH_EM * size
            && levels >= 2
    }
    fn prose(&self) -> bool {
        self.lines >= SIDE_LINES
            && self.words.saturating_mul(2) >= self.lines.saturating_mul(PROSE_HALF_WORDS)
            && self.flowing()
    }

    fn snapped(&mut self, tolerance: f64) -> Vec<(f64, usize)> {
        sort_unstable_with(&mut self.levels, &f64::total_cmp);
        let mut groups: Vec<(f64, usize)> = Vec::new();
        for &x in &self.levels {
            match groups.last_mut() {
                Some((anchor, count)) if x - *anchor <= tolerance => {
                    *count = count.saturating_add(1);
                }
                _ => groups.push((x, 1)),
            }
        }
        groups
    }

    const fn textual(&self) -> bool {
        self.numeric.saturating_mul(2) < self.lines
    }
}

impl Partition<'_, '_> {
    fn divide(&self, region: Region, gutter: &Gutter) -> [Region; 4] {
        let mut parts: [Region; 4] = Default::default();
        for index in region.frags {
            let (Some(&line), Some(frag)) = (self.line_of.get(index), self.frags.get(index)) else {
                continue;
            };
            let slot = slot_of(line, gutter, side_of(gutter, frag));
            if let Some(part) = parts.get_mut(slot) {
                part.frags.push(index);
            }
        }
        for index in region.tables {
            let Some(&[x0, y0, x1, y1]) = self.tables.get(index) else {
                continue;
            };
            let center = f64::midpoint(y0, y1);
            let slot = if center > gutter.top {
                0
            } else if center < gutter.bottom {
                3
            } else if f64::midpoint(x0, x1) < gutter.mid() {
                1
            } else {
                2
            };
            if let Some(part) = parts.get_mut(slot) {
                part.tables.push(index);
            }
        }
        parts
    }

    fn divides(&self, region: &Region, gutter: &Gutter) -> bool {
        let mut sides = (false, false);
        for &index in &region.frags {
            let (Some(&line), Some(frag)) = (self.line_of.get(index), self.frags.get(index)) else {
                continue;
            };
            if line < gutter.first || line > gutter.last {
                continue;
            }
            match side_of(gutter, frag) {
                Ordering::Less => sides.0 = true,
                Ordering::Equal | Ordering::Greater => sides.1 = true,
            }
            if sides.0 && sides.1 {
                return true;
            }
        }
        false
    }

    fn split(&self, region: Region, depth: usize, out: &mut Vec<Region>) {
        let chosen = (depth < MAX_DEPTH)
            .then(|| {
                self.gutters
                    .iter()
                    .filter(|gutter| self.divides(&region, gutter))
                    .max_by(|left, right| {
                        left.span()
                            .cmp(&right.span())
                            .then(right.x0.total_cmp(&left.x0))
                    })
            })
            .flatten();
        let Some(gutter) = chosen else {
            out.push(region);
            return;
        };
        let parts = self.divide(region, gutter);
        for part in parts {
            if !part.frags.is_empty() || !part.tables.is_empty() {
                self.split(part, depth.saturating_add(1), out);
            }
        }
    }
}

fn merged_spans(frags: &[Frag<'_>], members: &[usize], reach: f64, out: &mut Vec<(f64, f64)>) {
    out.clear();
    for frag in members.iter().filter_map(|&index| frags.get(index)) {
        match out.last_mut() {
            Some(span) if frag.x0 - span.1 < reach => span.1 = span.1.max(frag.x1),
            _ => out.push((frag.x0, frag.x1)),
        }
    }
}

fn widest_free(spans: &[(f64, f64)], open: &Open) -> Option<(f64, f64)> {
    let mut best: Option<(f64, f64)> = None;
    let mut left = f64::NEG_INFINITY;
    for &(start, end) in spans.iter().chain(once(&(f64::INFINITY, f64::INFINITY))) {
        let low = open.x0.max(left);
        let high = open.x1.min(start);
        if high > low && best.is_none_or(|(x0, x1)| high - low > x1 - x0) {
            best = Some((low, high));
        }
        left = left.max(end);
    }
    best
}

fn line_extent(frags: &[Frag<'_>], line: &Line) -> (f64, f64) {
    line.members
        .iter()
        .filter_map(|&index| frags.get(index))
        .fold((f64::NEG_INFINITY, f64::INFINITY), |(top, bottom), frag| {
            (top.max(frag.y1), bottom.min(frag.y0))
        })
}

fn close(open: Open, frags: &[Frag<'_>], lines: &[Line], out: &mut Vec<Gutter>) {
    let accepted = open.left >= SIDE_LINES
        && open.right >= SIDE_LINES
        && open.last.saturating_sub(open.first) >= GUTTER_LINES.saturating_sub(1);
    if !accepted {
        return;
    }
    let (Some(first), Some(last)) = (lines.get(open.first), lines.get(open.last)) else {
        return;
    };
    out.push(Gutter {
        x0: open.x0,
        x1: open.x1,
        first: open.first,
        last: open.last,
        top: line_extent(frags, first).0,
        bottom: line_extent(frags, last).1,
    });
}

fn candidates(frags: &[Frag<'_>], lines: &[Line], ordered: &[&[usize]]) -> Vec<Gutter> {
    let mut found: Vec<Gutter> = Vec::new();
    let mut open: Vec<Open> = Vec::new();
    let mut next: Vec<Open> = Vec::new();
    let mut spans: Vec<(f64, f64)> = Vec::new();
    for (index, (line, members)) in lines.iter().zip(ordered).enumerate() {
        merged_spans(frags, members, GUTTER_EM * line.size, &mut spans);
        next.clear();
        for mut candidate in open.iter().copied() {
            let width = GUTTER_EM * candidate.size.min(line.size);
            match widest_free(&spans, &candidate) {
                Some((low, high)) if high - low >= width => {
                    candidate.x0 = low;
                    candidate.x1 = high;
                    candidate.last = index;
                    if spans.iter().any(|span| span.1 <= low) {
                        candidate.left = candidate.left.saturating_add(1);
                    }
                    if spans.iter().any(|span| span.0 >= high) {
                        candidate.right = candidate.right.saturating_add(1);
                    }
                    let duplicate = next
                        .iter()
                        .any(|kept| kept.x0 < candidate.x1 && candidate.x0 < kept.x1);
                    if !duplicate {
                        next.push(candidate);
                    }
                }
                _ => close(candidate, frags, lines, &mut found),
            }
        }
        for pair in spans.windows(2) {
            let (Some(&(_, low)), Some(&(high, _))) = (pair.first(), pair.get(1)) else {
                continue;
            };
            let fresh = high - low >= GUTTER_EM * line.size
                && !next.iter().any(|kept| kept.x0 < high && low < kept.x1);
            if fresh {
                next.push(Open {
                    first: index,
                    last: index,
                    left: 1,
                    right: 1,
                    size: line.size,
                    x0: low,
                    x1: high,
                });
            }
        }
        swap(&mut open, &mut next);
    }
    for candidate in open {
        close(candidate, frags, lines, &mut found);
    }
    found
}

fn chunk<'list>(
    frags: &[Frag<'_>],
    members: &'list [usize],
    low: f64,
    high: f64,
) -> &'list [usize] {
    let start =
        members.partition_point(|&index| frags.get(index).is_some_and(|frag| frag.x0 < low));
    let end = members.partition_point(|&index| frags.get(index).is_some_and(|frag| frag.x0 < high));
    let mut stop = start.max(end);
    while stop > start
        && members
            .get(stop.saturating_sub(1))
            .and_then(|&index| frags.get(index))
            .is_some_and(|frag| frag.x1 > high)
    {
        stop = stop.saturating_sub(1);
    }
    members.get(start..stop).unwrap_or_default()
}

fn columnar(
    gutter: &Gutter,
    all: &[Gutter],
    frags: &[Frag<'_>],
    lines: &[Line],
    ordered: &[&[usize]],
) -> bool {
    let (mut left, mut right) = (Side::default(), Side::default());
    let mut size = 0.0_f64;
    let mut holes: Vec<f64> = Vec::new();
    for index in gutter.first..=gutter.last {
        let (Some(line), Some(members)) = (lines.get(index), ordered.get(index)) else {
            continue;
        };
        size = size.max(line.size);
        let slack = EDGE_SLACK * line.size;
        let active = || {
            all.iter()
                .filter(|other| other.first <= index && index <= other.last)
        };
        let floor = active()
            .filter(|other| other.x1 <= gutter.x0)
            .fold(f64::NEG_INFINITY, |edge, other| edge.max(other.mid()));
        let ceiling = active()
            .filter(|other| other.x0 >= gutter.x1)
            .fold(f64::INFINITY, |edge, other| edge.min(other.mid()));
        let before = chunk(frags, members, floor, gutter.x0 + slack);
        let after = chunk(frags, members, gutter.x1 - slack, ceiling);
        let end = before
            .iter()
            .filter_map(|&member| frags.get(member))
            .fold(f64::NEG_INFINITY, |edge, frag| edge.max(frag.x1));
        let start = after
            .iter()
            .filter_map(|&member| frags.get(member))
            .fold(f64::INFINITY, |edge, frag| edge.min(frag.x0));
        if end.is_finite() && start.is_finite() {
            holes.push((start - end) / line.size.max(MIN_SIZE));
        }
        left.add(frags, before, line.center);
        right.add(frags, after, line.center);
    }
    sort_unstable_with(&mut holes, &f64::total_cmp);
    let tight = holes
        .get(holes.len().checked_div(4).unwrap_or(0))
        .is_some_and(|&hole| hole <= HOLE_EM);
    let narrow = gutter.x1 - gutter.x0 <= LIST_GUTTER_EM * size;
    let textual = left.textual() && right.textual() && !synchronized(&left, &right);
    let left_ok = (tight && left.prose()) || (narrow && left.list(size));
    let right_ok = (tight && right.prose()) || (narrow && right.list(size));
    textual && left_ok && right_ok
}

fn synchronized(left: &Side, right: &Side) -> bool {
    let (left_breaks, left_pitch) = left.breaks();
    let (right_breaks, right_pitch) = right.breaks();
    let fewer = left_breaks.len().min(right_breaks.len());
    if fewer < SYNC_BREAKS {
        return false;
    }
    let reach = SYNC_REACH * left_pitch.max(right_pitch);
    let common = left_breaks
        .iter()
        .filter(|&&upper| {
            right_breaks
                .iter()
                .any(|&lower| (upper - lower).abs() <= reach)
        })
        .count()
        .min(fewer);
    common >= SYNC_BREAKS && common.saturating_mul(5) >= fewer.saturating_mul(3)
}

const fn slot_of(line: usize, gutter: &Gutter, side: Ordering) -> usize {
    if line < gutter.first {
        0
    } else if line > gutter.last {
        3
    } else if matches!(side, Ordering::Less) {
        1
    } else {
        2
    }
}

fn side_of(gutter: &Gutter, frag: &Frag<'_>) -> Ordering {
    f64::midpoint(frag.x0, frag.x1).total_cmp(&gutter.mid())
}

pub(crate) fn regions(
    frags: &[Frag<'_>],
    lines: &[Line],
    tables: &[[f64; 4]],
) -> Option<Vec<Region>> {
    if lines.len() < GUTTER_LINES {
        return None;
    }
    let ordered: Vec<&[usize]> = lines.iter().map(|line| line.members.as_slice()).collect();
    let found = candidates(frags, lines, &ordered);
    if found.is_empty() {
        return None;
    }
    let gutters: Vec<Gutter> = found
        .iter()
        .filter(|gutter| columnar(gutter, &found, frags, lines, &ordered))
        .copied()
        .collect();
    if gutters.is_empty() {
        return None;
    }
    let mut line_of = vec![0_usize; frags.len()];
    for (index, line) in lines.iter().enumerate() {
        for &member in &line.members {
            if let Some(slot) = line_of.get_mut(member) {
                *slot = index;
            }
        }
    }
    let partition = Partition {
        gutters: &gutters,
        line_of: &line_of,
        frags,
        tables,
    };
    let whole = Region {
        frags: (0..frags.len()).collect(),
        tables: (0..tables.len()).collect(),
    };
    let mut out = Vec::new();
    partition.split(whole, 0, &mut out);
    (out.len() > 1).then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn frag() -> impl Strategy<Value = Frag<'static>> {
        (0_u16..600, 0_u16..800, 1_u16..120).prop_map(|(x, y, width)| Frag {
            bold: false,
            italic: false,
            size: 10.0,
            text: "word",
            x0: f64::from(x),
            x1: f64::from(x) + f64::from(width),
            y0: f64::from(y),
            y1: f64::from(y) + 10.0,
        })
    }

    fn gutter() -> impl Strategy<Value = Gutter> {
        (
            0_u16..600,
            0_u16..40,
            0_usize..30,
            0_usize..30,
            0_u16..800,
            0_u16..800,
        )
            .prop_map(|(x, width, first, span, top, bottom)| Gutter {
                bottom: f64::from(bottom),
                first,
                last: first.saturating_add(span),
                top: f64::from(top),
                x0: f64::from(x),
                x1: f64::from(x) + f64::from(width),
            })
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(2_000))]

        #[test]
        fn partitions_keep_every_item_exactly_once(
            frags in prop::collection::vec(frag(), 0..48),
            lines in prop::collection::vec(0_usize..40, 48),
            gutters in prop::collection::vec(gutter(), 0..6),
            corners in prop::collection::vec((0_u16..600, 0_u16..800), 0..4),
        ) {
            let tables: Vec<[f64; 4]> = corners
                .iter()
                .map(|&(x, y)| {
                    [f64::from(x), f64::from(y), f64::from(x) + 50.0_f64, f64::from(y) + 50.0_f64]
                })
                .collect();
            let partition = Partition {
                frags: &frags,
                gutters: &gutters,
                line_of: &lines,
                tables: &tables,
            };
            let mut out = Vec::new();
            partition.split(
                Region {
                    frags: (0..frags.len()).collect(),
                    tables: (0..tables.len()).collect(),
                },
                0,
                &mut out,
            );
            let mut seen: Vec<usize> = out.iter().flat_map(|region| region.frags.clone()).collect();
            seen.sort_unstable();
            prop_assert_eq!(seen, (0..frags.len()).collect::<Vec<_>>());
            let mut placed: Vec<usize> = out.iter().flat_map(|region| region.tables.clone()).collect();
            placed.sort_unstable();
            prop_assert_eq!(placed, (0..tables.len()).collect::<Vec<_>>());
        }
    }
}

#[cfg(kani)]
mod proofs {
    use super::*;

    #[kani::proof]
    fn column_slots_cover_every_item_and_split_both_sides() {
        let gutter = Gutter {
            bottom: 0.0,
            first: kani::any(),
            last: kani::any(),
            top: 0.0,
            x0: 0.0,
            x1: 0.0,
        };
        let line: usize = kani::any();
        let side: Ordering = kani::any::<i8>().cmp(&0);
        let slot = slot_of(line, &gutter, side);
        assert!(slot < 4);
        let other: usize = kani::any();
        if (gutter.first..=gutter.last).contains(&line)
            && (gutter.first..=gutter.last).contains(&other)
        {
            assert_eq!(slot_of(line, &gutter, Ordering::Less), 1);
            assert_eq!(slot_of(other, &gutter, Ordering::Greater), 2);
            assert_eq!(slot_of(other, &gutter, Ordering::Equal), 2);
        } else {
            assert!(slot == 0 || slot == 3 || (gutter.first..=gutter.last).contains(&line));
        }
    }
}
