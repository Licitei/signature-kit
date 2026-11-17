use crate::markdown::reflow_lines;
use crate::num::usize_to_f64;
use crate::num::widen;
use std::collections::HashMap;

const LEVEL_TOLERANCE: f64 = 2.0;
const JOIN_GAP: f64 = 3.0;
const TOUCH: f64 = 2.5;
const MAX_LINES: usize = 6000;
const MAX_CELLS: usize = 250_000;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Rule {
    pub x0: f64,
    pub x1: f64,
    pub y0: f64,
    pub y1: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Cell {
    pub bbox: [f64; 4],
    pub col: u32,
    pub col_span: u32,
    pub row: u32,
    pub row_span: u32,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Table {
    pub bbox: [f64; 4],
    pub cells: Vec<Cell>,
    pub cols: u32,
    pub page_index: u32,
    pub rows: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct GridCell {
    pub col: usize,
    pub col_span: usize,
    pub row: usize,
    pub row_span: usize,
}

#[derive(Clone, Debug)]
pub(crate) struct Grid {
    pub(crate) cells: Vec<GridCell>,
    index: Vec<u32>,
    pub(crate) xs: Vec<f64>,
    pub(crate) ys: Vec<f64>,
}

impl Grid {
    pub(crate) fn bounds(&self) -> [f64; 4] {
        let left = self.xs.first().copied().unwrap_or(0.0_f64);
        let right = self.xs.last().copied().unwrap_or(0.0_f64);
        let top = self.ys.first().copied().unwrap_or(0.0_f64);
        let bottom = self.ys.last().copied().unwrap_or(0.0_f64);
        [left, bottom, right, top]
    }

    pub(crate) fn cell_rect(&self, cell: GridCell) -> [f64; 4] {
        let left = self.xs.get(cell.col).copied().unwrap_or(0.0_f64);
        let right = self
            .xs
            .get(cell.col.saturating_add(cell.col_span))
            .copied()
            .unwrap_or(left);
        let top = self.ys.get(cell.row).copied().unwrap_or(0.0_f64);
        let bottom = self
            .ys
            .get(cell.row.saturating_add(cell.row_span))
            .copied()
            .unwrap_or(top);
        [left, bottom, right, top]
    }

    pub(crate) const fn cols(&self) -> usize {
        self.xs.len().saturating_sub(1)
    }

    pub(crate) fn locate(&self, x: f64, y: f64) -> Option<usize> {
        let [left, bottom, right, top] = self.bounds();
        if !(x >= left && x <= right && y >= bottom && y <= top) {
            return None;
        }
        let cols = self.cols();
        let rows = self.rows();
        let col = self
            .xs
            .partition_point(|&edge| edge <= x)
            .saturating_sub(1)
            .min(cols.checked_sub(1)?);
        let row = self
            .ys
            .partition_point(|&edge| edge > y)
            .saturating_sub(1)
            .min(rows.checked_sub(1)?);
        self.index
            .get(row.checked_mul(cols)?.checked_add(col)?)
            .map(|&cell| widen(cell))
    }

    pub(crate) const fn rows(&self) -> usize {
        self.ys.len().saturating_sub(1)
    }
}

struct Edges<'data> {
    h_cover: Vec<Vec<(f64, f64)>>,
    v_cover: Vec<Vec<(f64, f64)>>,
    xs: &'data [f64],
    ys: &'data [f64],
}

impl Edges<'_> {
    fn has_h(&self, level: usize, from: usize, to: usize) -> bool {
        let (Some(spans), Some(&left), Some(&right)) =
            (self.h_cover.get(level), self.xs.get(from), self.xs.get(to))
        else {
            return false;
        };
        covered(spans, left, right)
    }

    fn has_v(&self, level: usize, row: usize) -> bool {
        let (Some(spans), Some(&top), Some(&bottom)) = (
            self.v_cover.get(level),
            self.ys.get(row),
            self.ys.get(row.saturating_add(1)),
        ) else {
            return false;
        };
        covered(spans, bottom, top)
    }

    fn tile(&self, rows: usize, cols: usize) -> Option<(Vec<GridCell>, Vec<u32>)> {
        let mut owned = vec![false; rows.saturating_mul(cols)];
        let mut index = vec![0_u32; rows.saturating_mul(cols)];
        let mut cells: Vec<GridCell> = Vec::new();
        for row in 0..rows {
            for col in 0..cols {
                if owned
                    .get(row.saturating_mul(cols).saturating_add(col))
                    .copied()
                    .unwrap_or(true)
                {
                    continue;
                }
                let mut width = 1;
                while col.saturating_add(width) < cols
                    && !self.has_v(col.saturating_add(width), row)
                    && !owned
                        .get(
                            row.saturating_mul(cols)
                                .saturating_add(col)
                                .saturating_add(width),
                        )
                        .copied()
                        .unwrap_or(true)
                {
                    width = width.saturating_add(1);
                }
                let mut height = 1;
                while row.saturating_add(height) < rows {
                    let edge = (col..col.saturating_add(width))
                        .any(|c| self.has_h(row.saturating_add(height), c, c.saturating_add(1)));
                    let taken = (col..col.saturating_add(width)).any(|c| {
                        owned
                            .get(
                                row.saturating_add(height)
                                    .saturating_mul(cols)
                                    .saturating_add(c),
                            )
                            .copied()
                            .unwrap_or(true)
                    });
                    if edge || taken {
                        break;
                    }
                    height = height.saturating_add(1);
                }
                let id = u32::try_from(cells.len()).ok()?;
                for row_at in row..row.saturating_add(height) {
                    for c in col..col.saturating_add(width) {
                        let slot_index = row_at.saturating_mul(cols).saturating_add(c);
                        if let Some(slot) = owned.get_mut(slot_index) {
                            *slot = true;
                        }
                        if let Some(slot) = index.get_mut(slot_index) {
                            *slot = id;
                        }
                    }
                }
                cells.push(GridCell {
                    row,
                    col,
                    row_span: height,
                    col_span: width,
                });
            }
        }
        Some((cells, index))
    }
}

fn sort_lines_by_major(lines: &mut [[f64; 3]]) {
    lines.sort_unstable_by(|left, right| left[0].total_cmp(&right[0]));
}

fn sort_lines_by_minor(lines: &mut [[f64; 3]]) {
    lines.sort_unstable_by(|left, right| left[1].total_cmp(&right[1]));
}

fn cluster(mut values: Vec<f64>) -> Vec<f64> {
    values.sort_unstable_by(f64::total_cmp);
    let mut levels: Vec<f64> = Vec::new();
    let mut sum = 0.0_f64;
    let mut count = 0_usize;
    let mut last = f64::NEG_INFINITY;
    for value in values {
        if count > 0 && value - last > LEVEL_TOLERANCE {
            levels.push(sum / usize_to_f64(count));
            sum = 0.0_f64;
            count = 0;
        }
        sum += value;
        count = count.saturating_add(1);
        last = value;
    }
    if count > 0 {
        levels.push(sum / usize_to_f64(count));
    }
    levels
}

fn nearest(levels: &[f64], value: f64) -> Option<usize> {
    let after = levels.partition_point(|&level| level < value);
    let before = after.checked_sub(1);
    let pick = [before, Some(after)]
        .into_iter()
        .flatten()
        .filter_map(|index| {
            levels
                .get(index)
                .map(|level| (index, (level - value).abs()))
        })
        .min_by(|a, b| a.1.total_cmp(&b.1))?;
    (pick.1 <= LEVEL_TOLERANCE * 2.0).then_some(pick.0)
}

fn merge_collinear(mut lines: Vec<[f64; 3]>) -> Vec<[f64; 3]> {
    sort_lines_by_major(&mut lines);
    let mut merged: Vec<[f64; 3]> = Vec::with_capacity(lines.len());
    let mut start = 0_usize;
    while start < lines.len() {
        if lines.get(start).is_none() {
            break;
        }
        let mut end = start.saturating_add(1);
        while let Some(next) = lines.get(end) {
            let previous = lines
                .get(end.saturating_sub(1))
                .map_or(next[0], |line| line[0]);
            if next[0] - previous > LEVEL_TOLERANCE {
                break;
            }
            end = end.saturating_add(1);
        }
        let group = lines.get_mut(start..end).unwrap_or_default();
        sort_lines_by_minor(group);
        let Some(&first) = group.first() else { break };
        let position =
            group.iter().map(|line| line[0]).sum::<f64>() / usize_to_f64(group.len().max(1));
        let mut current = [position, first[1], first[2]];
        for line in group.iter() {
            if line[1] <= current[2] + JOIN_GAP {
                current[2] = current[2].max(line[2]);
                current[1] = current[1].min(line[1]);
            } else {
                merged.push(current);
                current = [position, line[1], line[2]];
            }
        }
        merged.push(current);
        start = end;
    }
    merged
}

fn find(parents: &mut [usize], mut node: usize) -> usize {
    while let Some(&parent) = parents.get(node) {
        if parent == node {
            break;
        }
        let grand = parents.get(parent).copied().unwrap_or(parent);
        if let Some(slot) = parents.get_mut(node) {
            *slot = grand;
        }
        node = grand;
    }
    node
}

fn covered(spans: &[(f64, f64)], from: f64, to: f64) -> bool {
    spans
        .iter()
        .any(|&(lo, hi)| lo <= from + TOUCH && hi >= to - TOUCH)
}

pub(crate) fn ruled_grids(lines: &[Rule]) -> Vec<Grid> {
    let mut horizontal: Vec<[f64; 3]> = Vec::new();
    let mut vertical: Vec<[f64; 3]> = Vec::new();
    for line in lines {
        let (width, height) = (line.x1 - line.x0, line.y1 - line.y0);
        if width >= height {
            horizontal.push([f64::midpoint(line.y0, line.y1), line.x0, line.x1]);
        } else {
            vertical.push([f64::midpoint(line.x0, line.x1), line.y0, line.y1]);
        }
    }
    let horizontal_next = merge_collinear(horizontal);
    let mut vertical_next = merge_collinear(vertical);
    if horizontal_next.len() < 2
        || vertical_next.len() < 2
        || horizontal_next.len() > MAX_LINES
        || vertical_next.len() > MAX_LINES
    {
        return Vec::new();
    }
    sort_lines_by_major(&mut vertical_next);
    let total = horizontal_next.len().saturating_add(vertical_next.len());
    let mut parents: Vec<usize> = (0..total).collect();
    for (horizontal_index, line) in horizontal_next.iter().enumerate() {
        let [y, x0, x1] = *line;
        let first = vertical_next.partition_point(|vertical_line| vertical_line[0] < x0 - TOUCH);
        for (offset, vertical_line) in vertical_next.iter().enumerate().skip(first) {
            if vertical_line[0] > x1 + TOUCH {
                break;
            }
            if vertical_line[1] - TOUCH <= y && y <= vertical_line[2] + TOUCH {
                let a = find(&mut parents, horizontal_index);
                let b = find(&mut parents, horizontal_next.len().saturating_add(offset));
                if let Some(slot) = parents.get_mut(a) {
                    *slot = b;
                }
            }
        }
    }
    let mut groups: HashMap<usize, (Vec<usize>, Vec<usize>)> = HashMap::new();
    for index in 0..total {
        let root = find(&mut parents, index);
        let entry = groups.entry(root).or_default();
        if index < horizontal_next.len() {
            entry.0.push(index);
        } else {
            entry.1.push(index.saturating_sub(horizontal_next.len()));
        }
    }
    let mut ordered: Vec<(Vec<usize>, Vec<usize>)> = groups.into_values().collect();
    ordered.sort_unstable_by(|a, b| {
        let key = |group: &(Vec<usize>, Vec<usize>)| {
            group.0.first().copied().unwrap_or(usize::MAX).min(
                group.1.first().map_or(usize::MAX, |&vertical_index| {
                    vertical_index.saturating_add(horizontal_next.len())
                }),
            )
        };
        key(a).cmp(&key(b))
    });
    let mut grids = Vec::new();
    for (hs, vs) in ordered {
        if let Some(grid) = build_grid(&horizontal_next, &vertical_next, &hs, &vs) {
            grids.push(grid);
        }
    }
    grids
}

fn build_grid(
    horizontal: &[[f64; 3]],
    vertical: &[[f64; 3]],
    hs: &[usize],
    vs: &[usize],
) -> Option<Grid> {
    let hor: Vec<[f64; 3]> = hs
        .iter()
        .filter_map(|&index| horizontal.get(index).copied())
        .collect();
    let ver: Vec<[f64; 3]> = vs
        .iter()
        .filter_map(|&index| vertical.get(index).copied())
        .collect();
    if hor.is_empty() || ver.is_empty() {
        return None;
    }
    let (xs, ascending) = grid_axes(&hor, &ver);
    let ys: Vec<f64> = ascending.iter().rev().copied().collect();
    if xs.len() < 3 || ys.len() < 3 {
        return None;
    }
    let rows = ys.len().saturating_sub(1);
    let cols = xs.len().saturating_sub(1);
    if rows.checked_mul(cols)? > MAX_CELLS {
        return None;
    }
    let mut h_cover: Vec<Vec<(f64, f64)>> = vec![Vec::new(); ys.len()];
    for line in &hor {
        let level = ys
            .len()
            .checked_sub(1)?
            .checked_sub(nearest(&ascending, line[0])?)?;
        h_cover.get_mut(level)?.push((line[1], line[2]));
    }
    let mut v_cover: Vec<Vec<(f64, f64)>> = vec![Vec::new(); xs.len()];
    for line in &ver {
        let level = nearest(&xs, line[0])?;
        v_cover.get_mut(level)?.push((line[1], line[2]));
    }
    let edges = Edges {
        h_cover,
        v_cover,
        xs: &xs,
        ys: &ys,
    };
    let (cells, index) = edges.tile(rows, cols)?;
    Some(Grid {
        cells,
        index,
        xs,
        ys,
    })
}

fn grid_axes(hor: &[[f64; 3]], ver: &[[f64; 3]]) -> (Vec<f64>, Vec<f64>) {
    let mut xs: Vec<f64> = ver.iter().map(|line| line[0]).collect();
    xs.push(hor.iter().map(|line| line[1]).fold(f64::INFINITY, f64::min));
    xs.push(
        hor.iter()
            .map(|line| line[2])
            .fold(f64::NEG_INFINITY, f64::max),
    );
    let mut ys: Vec<f64> = hor.iter().map(|line| line[0]).collect();
    ys.push(
        ver.iter()
            .map(|line| line[2])
            .fold(f64::NEG_INFINITY, f64::max),
    );
    ys.push(ver.iter().map(|line| line[1]).fold(f64::INFINITY, f64::min));
    (cluster(xs), cluster(ys))
}

fn overlaps(column: (f64, f64), x0: f64, x1: f64) -> bool {
    if x0 < x1 && column.0 < column.1 {
        column.1 > x0 && column.0 < x1
    } else {
        column.1 >= x0 && column.0 <= x1
    }
}

pub(crate) fn merge_row(columns: &[(f64, f64)], spans: &[(f64, f64)]) -> Option<Vec<(f64, f64)>> {
    let mut next = columns.to_vec();
    let mut used: Vec<usize> = Vec::new();
    for &(x0, x1) in spans {
        let hits: Vec<usize> = next
            .iter()
            .enumerate()
            .filter(|(_, column)| overlaps(**column, x0, x1))
            .map(|(index, _)| index)
            .collect();
        match hits.as_slice() {
            [] => {
                used.push(next.len());
                next.push((x0, x1));
            }
            [index] => {
                if used.contains(index) {
                    return None;
                }
                let column = next.get_mut(*index)?;
                column.0 = column.0.min(x0);
                column.1 = column.1.max(x1);
                used.push(*index);
            }
            _ => return None,
        }
    }
    next.sort_unstable_by(|a, b| a.0.total_cmp(&b.0));
    if next.windows(2).any(|pair| match pair {
        [left, right] => left.1 > right.0,
        _ => false,
    }) {
        return None;
    }
    Some(next)
}

pub(crate) fn column_of(columns: &[(f64, f64)], x0: f64, x1: f64) -> Option<usize> {
    let mut hits = columns
        .iter()
        .enumerate()
        .filter(|(_, column)| overlaps(**column, x0, x1))
        .map(|(index, _)| index);
    match (hits.next(), hits.next()) {
        (Some(index), None) => Some(index),
        _ => None,
    }
}

fn matrix(table: &Table) -> Vec<Vec<Option<&str>>> {
    let rows = widen(table.rows);
    let cols = widen(table.cols);
    let mut grid: Vec<Vec<Option<&str>>> = vec![vec![None; cols]; rows];
    for cell in &table.cells {
        if let Some(slot) = grid
            .get_mut(widen(cell.row))
            .and_then(|row| row.get_mut(widen(cell.col)))
        {
            *slot = Some(cell.text.as_str());
        }
    }
    grid
}

pub(crate) fn render_text(table: &Table) -> String {
    let mut out = String::new();
    for row in matrix(table) {
        let cells: Vec<&str> = row
            .into_iter()
            .flatten()
            .filter(|text| !text.is_empty())
            .collect();
        if cells.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push('\n');
        }
        let multiline = cells.iter().any(|text| text.contains('\n'));
        let separator = if multiline { "\n" } else { " " };
        for (index, text) in cells.iter().enumerate() {
            if index > 0 {
                out.push_str(separator);
            }
            out.push_str(text);
        }
    }
    out
}

fn push_markdown_cell(out: &mut String, text: &str) {
    for ch in reflow_lines(text.lines()).chars() {
        if ch == '|' {
            out.push('\\');
        }
        out.push(ch);
    }
}

pub(crate) fn render_markdown(table: &Table) -> String {
    let mut out = String::new();
    for (index, row) in matrix(table).into_iter().enumerate() {
        if index > 0 {
            out.push('\n');
        }
        out.push('|');
        for text in &row {
            out.push(' ');
            push_markdown_cell(&mut out, text.unwrap_or(""));
            out.push_str(" |");
        }
        if index == 0 {
            out.push_str("\n|");
            for _ in &row {
                out.push_str(" --- |");
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn horizontal(y: f64, x0: f64, x1: f64) -> Rule {
        Rule {
            x0,
            y0: y,
            x1,
            y1: y,
        }
    }

    fn vertical(x: f64, y0: f64, y1: f64) -> Rule {
        Rule {
            x0: x,
            y0,
            x1: x,
            y1,
        }
    }

    fn frame(rows: &[f64], cols: &[f64]) -> Vec<Rule> {
        let mut lines = Vec::new();
        let (left, right) = (cols[0], cols[cols.len().saturating_sub(1)]);
        let (top, bottom) = (rows[0], rows[rows.len().saturating_sub(1)]);
        for &y in rows {
            lines.push(horizontal(y, left, right));
        }
        for &x in cols {
            lines.push(vertical(x, bottom, top));
        }
        lines
    }

    #[test]
    fn plain_grid_has_one_cell_per_slot() {
        let grids = ruled_grids(&frame(
            &[700.0_f64, 680.0_f64, 660.0_f64],
            &[50.0_f64, 150.0_f64, 250.0_f64],
        ));
        assert_eq!(grids.len(), 1);
        let grid = &grids[0];
        assert_eq!((grid.rows(), grid.cols()), (2, 2));
        assert_eq!(grid.cells.len(), 4);
        assert!(
            grid.cells
                .iter()
                .all(|cell| cell.row_span == 1 && cell.col_span == 1)
        );
        assert_eq!(grid.locate(60.0, 690.0), Some(0));
        assert_eq!(grid.locate(200.0, 670.0), Some(3));
        assert_eq!(grid.locate(10.0, 670.0), None);
        assert_eq!(grid.locate(250.0, 660.0), Some(3));
        assert_eq!(grid.locate(50.0, 700.0), Some(0));
        assert_eq!(grid.locate(250.1, 670.0), None);
    }

    #[test]
    fn missing_inner_edges_merge_cells() {
        let mut lines = vec![
            horizontal(700.0, 50.0, 250.0),
            horizontal(680.0, 50.0, 250.0),
            horizontal(660.0, 50.0, 250.0),
            horizontal(640.0, 50.0, 250.0),
        ];
        lines.push(vertical(50.0, 640.0, 700.0));
        lines.push(vertical(250.0, 640.0, 700.0));
        lines.push(vertical(150.0, 640.0, 680.0));
        let grids = ruled_grids(&lines);
        assert_eq!(grids.len(), 1);
        let grid = &grids[0];
        assert_eq!((grid.rows(), grid.cols()), (3, 2));
        let first = grid.cells[0];
        assert_eq!((first.row, first.col, first.col_span), (0, 0, 2));
        assert_eq!(grid.cells.len(), 5);
        assert_eq!(grid.locate(200.0, 690.0), Some(0));
    }

    #[test]
    fn vertical_merge_spans_rows() {
        let mut lines = frame(
            &[700.0_f64, 680.0_f64, 660.0_f64, 640.0_f64],
            &[50.0_f64, 150.0_f64, 250.0_f64],
        );
        lines.retain(|line| {
            !(line.y0.total_cmp(&660.0_f64).is_eq() && line.y1.total_cmp(&660.0_f64).is_eq())
        });
        lines.push(horizontal(660.0, 150.0, 250.0));
        let grids = ruled_grids(&lines);
        let grid = &grids[0];
        let spanning = grid
            .cells
            .iter()
            .find(|cell| cell.col == 0 && cell.row == 1)
            .unwrap();
        assert_eq!(spanning.row_span, 2);
    }

    #[test]
    fn collinear_pieces_and_double_strokes_merge() {
        let mut lines = vec![
            horizontal(700.0, 50.0, 100.0),
            horizontal(700.2, 99.0, 150.0),
            horizontal(680.0, 50.0, 150.0),
            horizontal(660.0, 50.0, 150.0),
            vertical(50.0, 660.0, 700.0),
            vertical(100.0, 660.0, 700.0),
            vertical(150.0, 660.0, 700.0),
            vertical(150.1, 660.0, 700.0),
        ];
        lines.push(horizontal(700.0, 50.0, 150.0));
        let grids = ruled_grids(&lines);
        assert_eq!(grids.len(), 1);
        assert_eq!((grids[0].rows(), grids[0].cols()), (2, 2));
    }

    #[test]
    fn disjoint_lines_without_crossings_are_ignored() {
        let lines = vec![
            horizontal(700.0, 50.0, 150.0),
            horizontal(600.0, 50.0, 150.0),
            vertical(300.0, 600.0, 700.0),
            vertical(400.0, 600.0, 700.0),
        ];
        assert!(ruled_grids(&lines).is_empty());
        assert!(ruled_grids(&[]).is_empty());
        assert!(ruled_grids(&[horizontal(700.0, 50.0, 150.0)]).is_empty());
    }

    #[test]
    fn two_separate_grids_are_reported_separately() {
        let mut lines = frame(
            &[700.0_f64, 680.0_f64, 660.0_f64],
            &[50.0_f64, 150.0_f64, 250.0_f64],
        );
        lines.extend(frame(
            &[400.0_f64, 380.0_f64, 360.0_f64],
            &[50.0_f64, 150.0_f64, 250.0_f64],
        ));
        assert_eq!(ruled_grids(&lines).len(), 2);
    }

    #[test]
    fn single_boxes_are_not_tables() {
        assert!(ruled_grids(&frame(&[700.0_f64, 600.0_f64], &[50.0_f64, 250.0_f64])).is_empty());
        assert!(
            ruled_grids(&frame(
                &[700.0_f64, 650.0_f64, 600.0_f64],
                &[50.0_f64, 250.0_f64]
            ))
            .is_empty()
        );
    }

    #[test]
    fn column_merging_rejects_conflicts() {
        let first = merge_row(&[], &[(10.0_f64, 50.0_f64), (100.0_f64, 160.0_f64)]).unwrap();
        assert_eq!(first.len(), 2);
        let widened = merge_row(&first, &[(5.0_f64, 40.0_f64), (110.0_f64, 190.0_f64)]).unwrap();
        assert_eq!(widened, vec![(5.0_f64, 50.0_f64), (100.0_f64, 190.0_f64)]);
        assert!(merge_row(&first, &[(30.0_f64, 120.0_f64)]).is_none());
        assert!(merge_row(&first, &[(10.0_f64, 20.0_f64), (30.0_f64, 40.0_f64)]).is_none());
        assert_eq!(
            merge_row(&first, &[(200.0_f64, 240.0_f64)]).unwrap().len(),
            3
        );
        assert_eq!(column_of(&first, 12.0, 30.0), Some(0));
        assert_eq!(column_of(&first, 60.0, 90.0), None);
        assert_eq!(column_of(&first, 20.0, 120.0), None);
    }

    fn sample() -> Table {
        let cell = |row, col, text: &str| Cell {
            row,
            col,
            row_span: 1,
            col_span: 1,
            bbox: [0.0_f64; 4],
            text: text.to_owned(),
        };
        Table {
            page_index: 0,
            bbox: [0.0; 4],
            rows: 2,
            cols: 2,
            cells: vec![
                cell(0, 0, "Item"),
                cell(0, 1, "Valor | R$"),
                cell(1, 0, "Linha\nquebrada"),
                cell(1, 1, "10"),
            ],
        }
    }

    #[test]
    fn markdown_escapes_pipes_and_joins_lines() {
        assert_eq!(
            render_markdown(&sample()),
            "| Item | Valor \\| R$ |\n| --- | --- |\n| Linha quebrada | 10 |"
        );
    }

    #[test]
    fn text_rendering_is_row_major() {
        assert_eq!(
            render_text(&sample()),
            "Item Valor | R$\nLinha\nquebrada\n10"
        );
        let mut table = sample();
        table.cells.truncate(2);
        assert_eq!(render_text(&table), "Item Valor | R$");
    }

    #[test]
    fn hostile_line_counts_are_bounded() {
        let mut lines = Vec::new();
        for index in 0..(MAX_LINES + 10) {
            let y = usize_to_f64(index) * 5.0_f64;
            lines.push(horizontal(y, 0.0, 100.0));
            lines.push(vertical(usize_to_f64(index) * 7.0, 0.0, 100.0));
        }
        assert!(ruled_grids(&lines).is_empty());
    }
}
