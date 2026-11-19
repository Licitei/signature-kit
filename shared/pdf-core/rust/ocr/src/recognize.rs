use crate::model::{Choice, Metrics, Model, coordinate, model};
use crate::raster::Bits;
use crate::segment::Line;

const BEAM_WIDTH: usize = 4;
const EMPTY_PATH: Path = Path {
    cost: f32::INFINITY,
    digest: 0,
    distance: 0.0,
    last: '\0',
    length: 0,
    parent: None,
};

type Beam = [Path; BEAM_WIDTH];

#[derive(Clone, Debug, PartialEq)]
#[non_exhaustive]
pub struct Word {
    pub alternatives: Vec<(String, f32)>,
    pub bbox: [u32; 4],
    pub confidence: f32,
    pub text: String,
}

#[derive(Clone, Copy, Debug)]
struct Column {
    bottom: u32,
    ink: u32,
    top: u32,
}

#[derive(Clone, Copy, Debug)]
struct Cut {
    gap: Option<usize>,
    offset: usize,
    penalty: f32,
    reading: Option<RunReading>,
}

#[derive(Clone, Copy, Debug)]
struct RunReading {
    choices: [Choice; 4],
    confident: bool,
    right: u32,
}

#[derive(Clone, Copy, Debug)]
struct Parent {
    cut: usize,
    rank: usize,
}

#[derive(Clone, Copy, Debug)]
struct Path {
    cost: f32,
    digest: u64,
    distance: f32,
    last: char,
    length: u32,
    parent: Option<Parent>,
}

#[inline]
#[must_use]
#[expect(
    clippy::module_name_repetitions,
    reason = "the line recognizer is the agreed OCR engine seam"
)]
pub fn recognize_line(page: &Bits, line: &Line) -> Vec<Word> {
    model().map_or_else(Vec::new, |weights| {
        recognize_line_with_model(page, line, weights)
    })
}

pub(crate) fn recognize_line_with_model(page: &Bits, line: &Line, model: Model<'_>) -> Vec<Word> {
    let [_, top, _, bottom] = line.bbox;
    let height = coordinate(bottom.saturating_sub(top));
    let metrics = Metrics {
        baseline: if line.baseline.is_finite() {
            line.baseline
        } else {
            coordinate(bottom)
        },
        x_height: if line.x_height.is_finite() && line.x_height > 0.0 {
            line.x_height
        } else {
            height * 0.65
        },
    };
    line.words
        .iter()
        .filter_map(|word| recognize_word(page, word.bbox, metrics, model))
        .collect()
}

fn project(page: &Bits, [left, top, right, bottom]: [u32; 4]) -> Option<Vec<Column>> {
    let width = usize::try_from(right.checked_sub(left)?).ok()?;
    if width == 0 || bottom <= top {
        return None;
    }
    let mut columns = vec![
        Column {
            ink: 0,
            top: bottom,
            bottom: top
        };
        width
    ];
    let first = usize::try_from(left >> 6_u32).ok()?;
    let last = usize::try_from(right.saturating_sub(1) >> 6_u32).ok()?;
    for yy in top..bottom {
        let row = page.row(yy);
        for (index, &word) in row
            .iter()
            .enumerate()
            .take(last.saturating_add(1))
            .skip(first)
        {
            let base = u32::try_from(index).ok()?.saturating_mul(64);
            let mut ink = word & (u64::MAX << left.saturating_sub(base));
            let length = right.saturating_sub(base).min(64);
            ink &= u64::MAX >> 64_u32.saturating_sub(length);
            while ink != 0 {
                let xx = base.saturating_add(ink.trailing_zeros());
                ink &= ink.saturating_sub(1);
                if let Some(column) =
                    columns.get_mut(usize::try_from(xx.saturating_sub(left)).ok()?)
                {
                    column.ink = column.ink.saturating_add(1);
                    column.top = column.top.min(yy);
                    column.bottom = yy.saturating_add(1);
                }
            }
        }
    }
    Some(columns)
}

fn cuts(
    page: &Bits,
    columns: &[Column],
    left: u32,
    metrics: Metrics,
    model: Model<'_>,
) -> Vec<Cut> {
    let x_height = metrics.x_height;
    let mut cuts = vec![Cut {
        gap: None,
        offset: 0,
        penalty: 0.0,
        reading: None,
    }];
    let mut run = 0_usize;
    let mut gap = 0_usize;
    while let Some(first) = columns.get(run) {
        let length = if first.ink == 0 {
            gap = columns
                .iter()
                .skip(run)
                .take_while(|column| column.ink == 0)
                .count();
            gap
        } else {
            let length = columns
                .iter()
                .skip(run)
                .take_while(|column| column.ink != 0)
                .count();
            if run > 0 {
                cuts.push(Cut {
                    gap: Some(gap),
                    offset: run,
                    penalty: 0.0,
                    reading: None,
                });
            }
            if let Some(region) = columns.get(run..run.saturating_add(length)) {
                let reading = u32::try_from(run)
                    .ok()
                    .and_then(|offset| left.checked_add(offset))
                    .and_then(|x0| inspect_run(page, region, x0, metrics, model));
                if let Some(start) = cuts.last_mut() {
                    start.reading = reading;
                }
                if reading.is_none_or(|guess| !guess.confident) {
                    soft_cuts(region, run, x_height, model.learned(), &mut cuts);
                }
            }
            length
        };
        run = run.saturating_add(length);
    }
    cuts.push(Cut {
        gap: None,
        offset: columns.len(),
        penalty: 0.0,
        reading: None,
    });
    cuts
}

fn inspect_run(
    page: &Bits,
    region: &[Column],
    left: u32,
    metrics: Metrics,
    model: Model<'_>,
) -> Option<RunReading> {
    if !model.learned() || coordinate(u32::try_from(region.len()).ok()?) > metrics.x_height * 1.15 {
        return None;
    }
    let [x0, top, right, bottom] = tight_box(region, left)?;
    let choices = model.classify(page, [x0, top, right, bottom], metrics);
    let [best, next, _, _] = choices;
    let confident = best.distance < 1.0 && next.distance - best.distance > 32.0;
    Some(RunReading {
        choices,
        confident,
        right,
    })
}

fn soft_cuts(region: &[Column], start: usize, x_height: f32, learned: bool, cuts: &mut Vec<Cut>) {
    if coordinate(u32::try_from(region.len()).unwrap_or(u32::MAX)) < x_height * 0.7 {
        return;
    }
    let mut last_cut = 0_usize;
    for (index, triple) in region.windows(3).enumerate() {
        let [before, center, after] = triple else {
            continue;
        };
        let offset = index.saturating_add(1);
        let spacing =
            coordinate(u32::try_from(offset.saturating_sub(last_cut)).unwrap_or(u32::MAX));
        if spacing < x_height * 0.19 {
            continue;
        }
        if center.ink <= before.ink
            && center.ink < after.ink
            && (learned || coordinate(center.ink) <= x_height * 0.37 || spacing >= x_height * 1.1)
        {
            cuts.push(Cut {
                gap: None,
                offset: start.saturating_add(offset),
                penalty: if learned {
                    1.5 + 4.0 * coordinate(center.ink) / x_height.max(1.0)
                } else {
                    5.0 + coordinate(center.ink) * 0.9
                },
                reading: None,
            });
            last_cut = offset;
        }
    }
}

fn tight_box(columns: &[Column], left: u32) -> Option<[u32; 4]> {
    let start = columns.iter().position(|column| column.ink != 0)?;
    let end = columns.iter().rposition(|column| column.ink != 0)?;
    let ink = columns.iter().filter(|column| column.ink != 0);
    let top = ink.clone().map(|column| column.top).min()?;
    let bottom = ink.map(|column| column.bottom).max()?;
    let x0 = left.checked_add(u32::try_from(start).ok()?)?;
    let x1 = left.checked_add(u32::try_from(end).ok()?.checked_add(1)?)?;
    Some([x0, top, x1, bottom])
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn ink_box(page: &Bits, bbox: [u32; 4]) -> Option<[u32; 4]> {
    let [left, _, _, _] = bbox;
    tight_box(&project(page, bbox)?, left)
}

fn recognize_word(page: &Bits, bbox: [u32; 4], metrics: Metrics, model: Model<'_>) -> Option<Word> {
    let [left, top, right, bottom] = bbox;
    let columns = project(
        page,
        [left, top, right.min(page.width), bottom.min(page.height)],
    )?;
    let ink_start = columns.iter().position(|column| column.ink != 0)?;
    let ink_end = columns.iter().rposition(|column| column.ink != 0)?;
    let left_edge = left.checked_add(u32::try_from(ink_start).ok()?)?;
    let active = columns.get(ink_start..=ink_end)?;
    let cuts = cuts(page, active, left_edge, metrics, model);
    let mut beams = vec![[EMPTY_PATH; BEAM_WIDTH]; cuts.len()];
    *beams.first_mut()?.first_mut()? = Path {
        cost: 0.0,
        ..EMPTY_PATH
    };
    for (end, &cut) in cuts.iter().enumerate().skip(1) {
        let mut paths = [EMPTY_PATH; BEAM_WIDTH];
        for (start, &origin) in cuts.iter().enumerate().take(end).rev().take(8) {
            let beam = beams.get(start)?;
            if beam.first().is_none_or(|path| !path.cost.is_finite()) {
                continue;
            }
            let ink = active.get(origin.offset..cut.offset)?;
            let x0 = left_edge.checked_add(u32::try_from(origin.offset).ok()?)?;
            let Some(bounds) = tight_box(ink, x0) else {
                continue;
            };
            let [glyph_left, _, glyph_right, _] = bounds;
            if coordinate(glyph_right.saturating_sub(glyph_left)) > metrics.x_height * 2.15
                && start.saturating_add(1) != end
            {
                break;
            }
            let middle = cuts.get(start.saturating_add(1)..end)?;
            let penalty =
                if let Some(extra) = merge_penalty(middle, left_edge, bounds, metrics.x_height) {
                    cut.penalty + extra
                } else {
                    break;
                };
            let cached = origin
                .reading
                .filter(|reading| reading.right == glyph_right);
            let choices = cached.map_or_else(
                || model.classify(page, bounds, metrics),
                |reading| reading.choices,
            );
            extend_paths(choices, start, &beams, penalty, model, &mut paths);
            if cached.is_some_and(|reading| reading.confident) {
                break;
            }
        }
        *beams.get_mut(end)? = paths;
    }
    finish_word(&beams, bbox)
}

fn merge_penalty(
    middle: &[Cut],
    left: u32,
    [glyph_left, _, glyph_right, _]: [u32; 4],
    x_height: f32,
) -> Option<f32> {
    let mut gaps = middle
        .iter()
        .filter_map(|cut| cut.gap.map(|gap| (gap, cut.offset)));
    let Some((gap, offset)) = gaps.next() else {
        return Some(0.0);
    };
    if gaps.next().is_some() || coordinate(u32::try_from(gap).ok()?) > x_height * 0.24 {
        return None;
    }
    let right_start = left.checked_add(u32::try_from(offset).ok()?)?;
    let left_end = right_start.checked_sub(u32::try_from(gap).ok()?)?;
    let left_width = left_end.saturating_sub(glyph_left);
    let right_width = glyph_right.saturating_sub(right_start);
    if coordinate(left_width.min(right_width)) <= x_height * 0.23 {
        return Some(18.0);
    }
    None
}

fn extend_paths(
    choices: [Choice; 4],
    start: usize,
    beams: &[Beam],
    penalty: f32,
    model: Model<'_>,
    paths: &mut Beam,
) {
    let Some(prefixes) = beams.get(start) else {
        return;
    };
    let character_cost = if model.learned() { 6.0 } else { 21.0 };
    for candidate in choices.iter().filter(|choice| choice.distance.is_finite()) {
        for (rank, prefix) in prefixes
            .iter()
            .enumerate()
            .take_while(|(_, path)| path.cost.is_finite())
        {
            let cost = prefix.cost + candidate.distance + character_cost + penalty
                - model.transition(prefix.last, candidate.label);
            if paths.last().is_some_and(|last| last.cost <= cost) {
                continue;
            }
            insert_path(
                paths,
                beams,
                Path {
                    cost,
                    digest: prefix.digest.wrapping_mul(0x0100_0000_01b3)
                        ^ u64::from(u32::from(candidate.label)),
                    distance: prefix.distance + candidate.distance,
                    last: candidate.label,
                    length: prefix.length.saturating_add(1),
                    parent: Some(Parent { cut: start, rank }),
                },
            );
        }
    }
}

fn insert_path(paths: &mut Beam, beams: &[Beam], candidate: Path) {
    if let Some(existing) = paths
        .iter()
        .position(|path| same_reading(beams, *path, candidate))
        && let Some(tail) = paths.get_mut(existing..)
    {
        if tail.first().is_some_and(|path| path.cost <= candidate.cost) {
            return;
        }
        tail.rotate_left(1);
        if let Some(last) = tail.last_mut() {
            *last = EMPTY_PATH;
        }
    }
    if let Some(index) = paths.iter().position(|path| path.cost > candidate.cost)
        && let Some(tail) = paths.get_mut(index..)
    {
        tail.rotate_right(1);
        if let Some(first) = tail.first_mut() {
            *first = candidate;
        }
    }
}

fn predecessor(beams: &[Beam], parent: Option<Parent>) -> Option<Path> {
    let Parent { cut, rank } = parent?;
    beams.get(cut)?.get(rank).copied()
}

fn same_reading(beams: &[Beam], mut left: Path, mut right: Path) -> bool {
    if left.digest != right.digest || left.length != right.length {
        return false;
    }
    loop {
        if left.last != right.last {
            return false;
        }
        match (
            predecessor(beams, left.parent),
            predecessor(beams, right.parent),
        ) {
            (Some(before_left), Some(before_right)) => {
                left = before_left;
                right = before_right;
            }
            (None, None) => return true,
            _ => return false,
        }
    }
}

fn reading(beams: &[Beam], mut path: Path) -> String {
    let mut letters = Vec::with_capacity(usize::try_from(path.length).unwrap_or_default());
    while let Some(before) = predecessor(beams, path.parent) {
        letters.push(path.last);
        path = before;
    }
    letters.into_iter().rev().collect()
}

fn finish_word(beams: &[Beam], bbox: [u32; 4]) -> Option<Word> {
    let mut ranked = beams
        .last()?
        .iter()
        .copied()
        .take_while(|path| path.cost.is_finite());
    let best = ranked.next()?;
    let length = coordinate(best.length).max(1.0);
    let alternatives: Vec<_> = ranked
        .map(|path| {
            (
                reading(beams, path),
                (-(path.cost - best.cost) / 14.0).exp(),
            )
        })
        .collect();
    let fit = (1.0 - best.distance / (length * 125.0)).clamp(0.0, 1.0);
    let ambiguity = alternatives.first().map_or(0.0, |(_, score)| *score);
    Some(Word {
        alternatives,
        bbox,
        confidence: fit * (1.0 - ambiguity * 0.5),
        text: reading(beams, best),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::segment::WordBox;

    #[test]
    fn recognizes_a_printed_plus() {
        let mut page = Bits::new(24, 25).unwrap();
        for delta in 0..16_u32 {
            page.set(10, 2_u32.saturating_add(delta), true);
            page.set(11, 2_u32.saturating_add(delta), true);
            page.set(3_u32.saturating_add(delta), 9, true);
            page.set(3_u32.saturating_add(delta), 10, true);
        }
        let bbox = [2, 1, 20, 20];
        let line = Line {
            baseline: 21.0,
            bbox,
            block: 0,
            words: vec![WordBox { bbox }],
            x_height: 16.0,
        };
        let words = recognize_line(&page, &line);
        assert_eq!(words.first().map(|word| word.text.as_str()), Some("+"));
    }

    #[test]
    fn preserves_word_geometry_and_exposes_distinct_ranked_readings() {
        let mut page = Bits::new(130, 24).unwrap();
        for row in 5..19 {
            page.set(62, row, true);
            page.set(63, row, true);
            page.set(66, row, true);
            page.set(67, row, true);
        }
        let bbox = [60, 4, 70, 20];
        let line = Line {
            baseline: 19.0,
            bbox,
            block: 0,
            words: vec![
                WordBox { bbox },
                WordBox {
                    bbox: [120, 0, 180, 24],
                },
            ],
            x_height: 10.0,
        };
        let words = recognize_line(&page, &line);
        let [word] = words.as_slice() else {
            panic!("expected one word crossing the packed row boundary");
        };
        assert_eq!(word.bbox, bbox);
        assert_ne!(word.text, "");
        assert!((0.0..=1.0).contains(&word.confidence));
        assert!(
            word.alternatives
                .iter()
                .all(|(text, score)| { text != &word.text && (0.0..=1.0).contains(score) })
        );
        assert!(
            word.alternatives
                .windows(2)
                .all(|pair| matches!(pair, [(first, higher), (second, lower)] if first != second && higher >= lower))
        );
    }
}
