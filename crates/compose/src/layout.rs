use alloc::rc::Rc;
use core::mem;
use signature_kit_pdf_core::failure::{Failure, Outcome};

use crate::spec::{Kind, Node, PathCommand, Section, Style};
use crate::text::{FontMetrics, Line, lines};

pub(crate) const NO_COLOR: u32 = u32::MAX;

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Area {
    pub(crate) height: f64,
    pub(crate) width: f64,
    pub(crate) x: f64,
    pub(crate) y: f64,
}

#[derive(Clone, Debug)]
#[cfg_attr(
    target_arch = "wasm32",
    expect(
        variant_size_differences,
        reason = "shape decoration is stored inline to avoid a per-item box allocation in WASM"
    )
)]
pub(crate) enum Paint<'doc> {
    Anchor(&'doc str, bool),
    Image(u32, bool),
    Link(&'doc str),
    Shape(Decoration, &'doc [PathCommand]),
    Text(Rc<Line>),
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Decoration {
    pub(crate) fill: u32,
    pub(crate) radius: f64,
    pub(crate) stroke: u32,
    pub(crate) thickness: f64,
}

#[derive(Clone, Debug)]
pub(crate) struct Item<'doc> {
    pub(crate) area: Area,
    pub(crate) opacity: f64,
    pub(crate) paint: Paint<'doc>,
}

#[derive(Debug, Default)]
struct Block<'doc> {
    height: f64,
    items: Vec<Item<'doc>>,
    width: f64,
}

#[derive(Debug)]
pub(crate) struct Page<'doc> {
    pub(crate) items: Vec<Item<'doc>>,
    pub(crate) size: [f64; 2],
}

#[derive(Debug)]
pub(crate) struct Layout<'faces, 'data> {
    pub(crate) fonts: &'faces [FontMetrics<'faces, 'data>],
    pub(crate) images: &'faces [[u32; 2]],
}

#[derive(Debug)]
struct Flow<'doc> {
    body: Block<'doc>,
    capacity: f64,
    pages: Vec<Block<'doc>>,
    pending_gap: f64,
}

impl<'doc> Block<'doc> {
    fn add(&mut self, block: Self, x: f64, y: f64) {
        self.items.extend(block.items.into_iter().map(|mut item| {
            item.area.x += x;
            item.area.y += y;
            item
        }));
    }

    fn baseline(&self, fallback: f64) -> f64 {
        self.items
            .iter()
            .find_map(|item| match &item.paint {
                Paint::Text(line) => Some(item.area.y + line.baseline()),
                Paint::Anchor(..) | Paint::Image(..) | Paint::Link(_) | Paint::Shape(..) => None,
            })
            .unwrap_or(fallback)
    }

    fn item(&mut self, paint: Paint<'doc>) {
        self.items.push(Item {
            area: Area {
                width: self.width,
                height: self.height,
                ..Area::default()
            },
            opacity: 1.0,
            paint,
        });
    }
}

impl Layout<'_, '_> {
    fn block<'doc>(
        &self,
        node: &'doc Node<'doc>,
        available_width: f64,
        height: f64,
        force_width: bool,
        flex_height: Option<f64>,
    ) -> Outcome<Block<'doc>> {
        let style = &node.style;
        let [mt, mr, mb, ml] = style.margin;
        let [pt, pr, pb, pl] = style.padding;
        let available = (available_width - ml - mr).max(0.0);
        let outer = if force_width {
            available
        } else {
            length(style.width, available, available)
        };
        let width = constrained(outer, style.min_width, style.max_width, available);
        let inner = (width - pl - pr).max(0.0);
        let fixed = flex_height.unwrap_or_else(|| length(style.height, height, 0.0));
        let mut content = self.content(node, inner, height, (fixed - pt - pb).max(0.0))?;
        let box_height = constrained(
            if flex_height.is_some() || fixed > 0.0 {
                fixed
            } else {
                pt + content.height + pb
            },
            style.min_height,
            style.max_height,
            height,
        );
        content.width = inner;
        let mut box_block = Block {
            width,
            height: box_height,
            items: Vec::new(),
        };
        if (style.background != NO_COLOR || style.border != NO_COLOR)
            && !matches!(&node.kind, Kind::Shape(path) if !path.is_empty())
        {
            box_block.item(Paint::Shape(decoration(style), &[]));
        }
        box_block.add(content, pl, pt);
        if let Kind::Link(uri, _) = &node.kind {
            box_block.item(Paint::Link(uri));
        }
        for item in &mut box_block.items {
            item.opacity *= style.opacity;
        }
        let mut result = Block {
            width: width + ml + mr,
            height: box_height + mt + mb,
            items: Vec::new(),
        };
        result.add(box_block, ml, mt);
        Ok(result)
    }

    fn column<'doc>(
        &self,
        children: &'doc [Node<'doc>],
        style: &Style,
        width: f64,
        height: f64,
        fixed: f64,
    ) -> Outcome<Block<'doc>> {
        if style.wrap() && fixed > 0.0_f64 && !children.is_empty() {
            return self.wrapped_columns(children, style, width, height, fixed);
        }
        self.column_line(children, style, width, height, fixed)
    }

    fn column_line<'doc>(
        &self,
        children: &'doc [Node<'doc>],
        style: &Style,
        width: f64,
        height: f64,
        fixed: f64,
    ) -> Outcome<Block<'doc>> {
        let mut blocks: Vec<_> = children
            .iter()
            .map(|child| self.block(child, width, height, false, None))
            .collect::<Outcome<_>>()?;
        let gaps = style.gap
            * f64::from(u32::try_from(blocks.len().saturating_sub(1)).unwrap_or(u32::MAX));
        if fixed > 0.0_f64 && !children.is_empty() {
            let bases: Vec<_> = children
                .iter()
                .zip(&blocks)
                .map(|(child, block)| {
                    let [top, _, bottom, _] = child.style.margin;
                    let basis = length(child.style.basis, fixed, block.height - top - bottom);
                    constrained(basis, child.style.min_height, child.style.max_height, fixed)
                        + top
                        + bottom
                })
                .collect();
            let delta = fixed - bases.iter().sum::<f64>() - gaps;
            let weight: f64 = children
                .iter()
                .zip(&bases)
                .map(|(child, size)| flex_weight(&child.style, *size, delta))
                .sum();
            for ((child, block), basis) in children.iter().zip(&mut blocks).zip(bases) {
                let [top, _, bottom, _] = child.style.margin;
                let size = flex_size(&child.style, basis, delta, weight);
                if (size - block.height).abs() > 0.001_f64 {
                    *block = self.block(
                        child,
                        width,
                        fixed,
                        false,
                        Some((size - top - bottom).max(0.0)),
                    )?;
                }
            }
        }
        let used = blocks.iter().map(|block| block.height).sum::<f64>() + gaps;
        let (mut y, gap) = distribute(
            style.justify,
            (fixed - used).max(0.0),
            blocks.len(),
            style.gap,
        );
        let mut result = Block {
            width,
            height: used.max(fixed),
            items: Vec::new(),
        };
        for block in blocks {
            let next = y + block.height + gap;
            let x = cross(style.align, (width - block.width).max(0.0));
            result.add(block, x, y);
            y = next;
        }
        Ok(result)
    }

    fn content<'doc>(
        &self,
        node: &'doc Node<'doc>,
        width: f64,
        height: f64,
        fixed: f64,
    ) -> Outcome<Block<'doc>> {
        let style = &node.style;
        match &node.kind {
            Kind::View(children) | Kind::Link(_, children) => {
                if style.column() {
                    self.column(children, style, width, height, fixed)
                } else {
                    self.row(children, style, width, height, fixed)
                }
            }
            Kind::Table(_, rows) => self.column(rows, style, width, height, fixed),
            Kind::Text(runs) => {
                let mut block = Block {
                    width,
                    ..Block::default()
                };
                for line in lines(self.fonts, runs, style, width)? {
                    let line_height = line.height;
                    block.items.push(Item {
                        area: Area {
                            x: line.offset,
                            y: block.height,
                            width,
                            height: line_height,
                        },
                        opacity: 1.0,
                        paint: Paint::Text(Rc::new(line)),
                    });
                    block.height += line_height;
                }
                Ok(block)
            }
            Kind::Shape(path) => {
                let mut block = Block {
                    width,
                    height: fixed.max(1.0),
                    items: Vec::new(),
                };
                if !path.is_empty() {
                    block.item(Paint::Shape(decoration(style), path));
                }
                Ok(block)
            }
            Kind::Anchor(name, field) => {
                let mut block = Block {
                    width,
                    height: fixed.max(12.0),
                    items: Vec::new(),
                };
                block.item(Paint::Anchor(name, *field));
                Ok(block)
            }
            Kind::Image(index, cover) => {
                let size = self
                    .images
                    .get(usize::try_from(*index).unwrap_or(usize::MAX))
                    .ok_or_else(|| Failure::request("Unknown image"))?;
                let &[iw, ih] = size;
                let image_height = if fixed > 0.0 {
                    fixed
                } else {
                    width * f64::from(ih) / f64::from(iw)
                };
                let mut block = Block {
                    width,
                    height: image_height,
                    items: Vec::new(),
                };
                block.item(Paint::Image(*index, *cover));
                Ok(block)
            }
            Kind::Break => Err(Failure::request(
                "Page breaks must be inside a flowing stack",
            )),
        }
    }

    fn flow<'doc>(&self, node: &'doc Node<'doc>, flow: &mut Flow<'doc>) -> Outcome<()> {
        match &node.kind {
            Kind::Break => flow.next(),
            Kind::View(children) if plain_column(&node.style) => {
                for (index, child) in children.iter().enumerate() {
                    if index > 0 {
                        flow.pending_gap += node.style.gap;
                    }
                    self.flow(child, flow)?;
                }
                Ok(())
            }
            Kind::Table(count, rows) if plain_column(&node.style) => {
                let (head, body) = rows
                    .split_at_checked(*count)
                    .ok_or_else(|| Failure::request("Invalid table header count"))?;
                let header = self.column(head, &node.style, flow.body.width, flow.capacity, 0.0)?;
                flow.table(
                    header,
                    body.iter()
                        .map(|row| self.block(row, flow.body.width, flow.capacity, false, None))
                        .collect::<Outcome<_>>()?,
                    node.style.gap,
                )
            }
            Kind::Text(_) if !node.style.keep() => {
                let block = self.block(node, flow.body.width, flow.capacity, false, None)?;
                if block.items.len() > 1
                    && block
                        .items
                        .iter()
                        .all(|item| matches!(item.paint, Paint::Text(_)))
                {
                    flow.text(block, node.style.widow())
                } else {
                    flow.place(block)
                }
            }
            Kind::View(_)
            | Kind::Text(_)
            | Kind::Image(_, _)
            | Kind::Shape(_)
            | Kind::Anchor(_, _)
            | Kind::Table(_, _)
            | Kind::Link(_, _) => {
                flow.place(self.block(node, flow.body.width, flow.capacity, false, None)?)
            }
        }
    }

    fn row<'doc>(
        &self,
        children: &'doc [Node<'doc>],
        style: &Style,
        width: f64,
        height: f64,
        fixed: f64,
    ) -> Outcome<Block<'doc>> {
        let mut result = Block {
            width,
            ..Block::default()
        };
        let count = f64::from(u32::try_from(children.len()).unwrap_or(u32::MAX)).max(1.0);
        let default = ((width - style.gap * (count - 1.0)) / count).max(0.0);
        let widths: Vec<_> = children
            .iter()
            .map(|child| {
                let cs = &child.style;
                constrained(
                    length(cs.basis, width, length(cs.width, width, default)),
                    cs.min_width,
                    cs.max_width,
                    width,
                ) + cs.margin.get(1).copied().unwrap_or_default()
                    + cs.margin.get(3).copied().unwrap_or_default()
            })
            .collect();
        let mut start = 0_usize;
        let mut used = 0.0_f64;
        for (index, &item_width) in widths.iter().enumerate() {
            if style.wrap() && index > start && used + style.gap + item_width > width + 0.001_f64 {
                self.row_line(
                    &mut result,
                    children.get(start..index).unwrap_or_default(),
                    widths.get(start..index).unwrap_or_default(),
                    style,
                    height,
                    0.0,
                )?;
                result.height += style.gap;
                start = index;
                used = 0.0_f64;
            }
            used += item_width + if index > start { style.gap } else { 0.0_f64 };
        }
        self.row_line(
            &mut result,
            children.get(start..).unwrap_or_default(),
            widths.get(start..).unwrap_or_default(),
            style,
            height,
            fixed,
        )?;
        Ok(result)
    }

    fn row_line<'doc>(
        &self,
        row: &mut Block<'doc>,
        children: &'doc [Node<'doc>],
        widths: &[f64],
        style: &Style,
        height: f64,
        fixed: f64,
    ) -> Outcome<()> {
        let gaps = style.gap
            * f64::from(u32::try_from(widths.len().saturating_sub(1)).unwrap_or(u32::MAX));
        let delta = row.width - widths.iter().sum::<f64>() - gaps;
        let weight: f64 = children
            .iter()
            .zip(widths)
            .map(|(node, width)| flex_weight(&node.style, *width, delta))
            .sum();
        let boxes: Vec<_> = children
            .iter()
            .zip(widths)
            .map(|(node, width)| {
                self.block(
                    node,
                    flex_size(&node.style, *width, delta, weight),
                    height,
                    true,
                    None,
                )
            })
            .collect::<Outcome<_>>()?;
        let baselines = if style.align == 4 {
            boxes
                .iter()
                .zip(children)
                .map(|(block, child)| {
                    block.baseline(
                        block.height - child.style.margin.get(2).copied().unwrap_or_default(),
                    )
                })
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        let baseline = baselines.iter().copied().fold(0.0_f64, f64::max);
        let row_height = boxes
            .iter()
            .enumerate()
            .fold(fixed, |value, (index, block)| {
                value.max(
                    block.height
                        + baselines
                            .get(index)
                            .map_or(0.0_f64, |offset| baseline - offset),
                )
            });
        let occupied = boxes.iter().map(|block| block.width).sum::<f64>() + gaps;
        let (mut x, gap) = distribute(
            style.justify,
            (row.width - occupied).max(0.0),
            boxes.len(),
            style.gap,
        );
        for (index, block) in boxes.into_iter().enumerate() {
            let next = x + block.width + gap;
            let offset = baselines.get(index).map_or_else(
                || cross(style.align, (row_height - block.height).max(0.0)),
                |offset| baseline - offset,
            );
            let y = row.height + offset;
            row.add(block, x, y);
            x = next;
        }
        row.height += row_height;
        Ok(())
    }

    pub(crate) fn section<'doc>(&self, section: &'doc Section<'doc>) -> Outcome<Vec<Page<'doc>>> {
        let [page_width, height] = section.size;
        let [top, right, bottom, left] = section.margins;
        let width = page_width - left - right;
        let available = height - top - bottom;
        if width <= 0.0_f64 || available <= 0.0_f64 {
            return Err(Failure::request("Page margins exceed the page size"));
        }
        let header = self.block(&section.header, width, available, false, None)?;
        let footer = self.block(&section.footer, width, available, false, None)?;
        let capacity = available - header.height - footer.height;
        if capacity <= 0.0_f64 {
            return Err(Failure::request("Page bands exceed the page height"));
        }
        let mut flow = Flow {
            body: Block {
                width,
                ..Block::default()
            },
            capacity,
            pages: Vec::new(),
            pending_gap: 0.0,
        };
        self.flow(&section.body, &mut flow)?;
        flow.next()?;
        Ok(flow
            .pages
            .into_iter()
            .map(|body| {
                let mut page = Block::default();
                page.add(
                    Block {
                        items: header.items.clone(),
                        ..Block::default()
                    },
                    left,
                    top,
                );
                page.add(body, left, top + header.height);
                page.add(
                    Block {
                        items: footer.items.clone(),
                        ..Block::default()
                    },
                    left,
                    height - bottom - footer.height,
                );
                Page {
                    size: section.size,
                    items: page.items,
                }
            })
            .collect())
    }

    fn wrapped_columns<'doc>(
        &self,
        children: &'doc [Node<'doc>],
        style: &Style,
        width: f64,
        height: f64,
        fixed: f64,
    ) -> Outcome<Block<'doc>> {
        let mut columns = Vec::new();
        let mut start = 0_usize;
        let mut allocated = 0.0_f64;
        for (index, child) in children.iter().enumerate() {
            let natural = self.block(child, width, fixed, false, None)?.height;
            if index > start && allocated + style.gap + natural > fixed + 0.001_f64 {
                columns.push(children.get(start..index).unwrap_or_default());
                start = index;
                allocated = 0.0_f64;
            }
            allocated += natural + if index == start { 0.0_f64 } else { style.gap };
        }
        columns.push(children.get(start..).unwrap_or_default());
        let count = f64::from(u32::try_from(columns.len()).unwrap_or(u32::MAX));
        let column_width = ((width - (count - 1.0_f64) * style.gap) / count).max(0.0_f64);
        let mut result = Block {
            width,
            height: fixed,
            items: Vec::new(),
        };
        let mut x = 0.0_f64;
        for column in columns {
            let line = self.column_line(column, style, column_width, height, fixed)?;
            result.add(line, x, 0.0);
            x += column_width + style.gap;
        }
        Ok(result)
    }
}

impl<'doc> Flow<'doc> {
    fn available(&self) -> f64 {
        self.capacity - self.body.height - self.pending_gap
    }

    fn next(&mut self) -> Outcome<()> {
        if self.pages.len() >= 1000 {
            return Err(Failure::limit("Too many composed pages"));
        }
        let next = Block {
            width: self.body.width,
            ..Block::default()
        };
        self.pages.push(mem::replace(&mut self.body, next));
        self.pending_gap = 0.0_f64;
        Ok(())
    }

    fn place(&mut self, block: Block<'doc>) -> Outcome<()> {
        if block.height > self.capacity + 0.001_f64 {
            return Err(Failure::request(
                "A non-splittable block exceeds the page body",
            ));
        }
        if block.height > self.available() + 0.001_f64 {
            self.next()?;
        }
        let y = self.body.height + self.pending_gap;
        self.body.height = y + block.height;
        self.body.add(block, 0.0, y);
        self.pending_gap = 0.0_f64;
        Ok(())
    }

    fn table(&mut self, head: Block<'doc>, rows: Vec<Block<'doc>>, gap: f64) -> Outcome<()> {
        if rows.is_empty() {
            return self.place(head);
        }
        let mut started = false;
        for row in rows {
            let repeated = head.height + if head.height > 0.0_f64 { gap } else { 0.0_f64 };
            if repeated + row.height > self.capacity + 0.001_f64 {
                return Err(Failure::request(
                    "A table row and its header exceed the page body",
                ));
            }
            let needed = row.height + if started { gap } else { repeated };
            if needed > self.available() + 0.001_f64 {
                self.next()?;
                started = false;
            }
            if !started && head.height > 0.0_f64 {
                self.place(Block {
                    width: head.width,
                    height: head.height,
                    items: head.items.clone(),
                })?;
                self.pending_gap = gap;
            } else if started {
                self.pending_gap = gap;
            }
            self.place(row)?;
            started = true;
        }
        Ok(())
    }

    fn text(&mut self, block: Block<'doc>, widow: bool) -> Outcome<()> {
        if block.height <= self.available() {
            return self.place(block);
        }
        let mut items = block.items.as_slice();
        let first = items.first().map_or(0.0_f64, |item| item.area.y);
        let last = items
            .last()
            .map_or(0.0_f64, |item| item.area.y + item.area.height);
        let bottom = (block.height - last).max(0.0);
        let mut top = first;
        while let Some(head) = items.first() {
            let available = self.available() - top;
            let end = head.area.y;
            let fit = items
                .iter()
                .take_while(|item| {
                    let tail = if (item.area.y + item.area.height - last).abs() < 0.001_f64 {
                        bottom
                    } else {
                        0.0_f64
                    };
                    item.area.y + item.area.height - end + tail <= available + 0.001_f64
                })
                .count();
            let adjusted = if widow && items.len().saturating_sub(fit) == 1 && fit > 2 {
                fit.saturating_sub(1)
            } else {
                fit
            };
            if adjusted == 0
                || (widow && adjusted == 1 && items.len() > 1 && self.body.height > 0.0_f64)
            {
                if self.body.height <= 0.0_f64 {
                    return Err(Failure::request("A text line exceeds the page body"));
                }
                self.next()?;
                continue;
            }
            let (part, rest) = items
                .split_at_checked(adjusted)
                .ok_or_else(|| Failure::request("Invalid line split"))?;
            let line_end = part
                .last()
                .map_or(end, |item| item.area.y + item.area.height);
            let height = line_end - end + top + if rest.is_empty() { bottom } else { 0.0_f64 };
            let mut fragment = Block {
                width: block.width,
                height,
                items: part.to_vec(),
            };
            for item in &mut fragment.items {
                item.area.y += top - end;
            }
            self.place(fragment)?;
            items = rest;
            top = 0.0_f64;
            if !items.is_empty() {
                self.next()?;
            }
        }
        Ok(())
    }
}

fn flex_size(style: &Style, basis: f64, delta: f64, total: f64) -> f64 {
    if total <= 0.0_f64 {
        return basis;
    }
    (basis + delta * flex_weight(style, basis, delta) / total).max(0.0)
}

fn flex_weight(style: &Style, basis: f64, delta: f64) -> f64 {
    if delta >= 0.0 {
        style.grow
    } else {
        style.shrink * basis
    }
}

fn plain_column(style: &Style) -> bool {
    style.column()
        && !style.keep()
        && style.justify == 0
        && style.align == 0
        && style.background == NO_COLOR
        && style.border == NO_COLOR
        && [
            style.width,
            style.height,
            style.min_width,
            style.max_width,
            style.min_height,
            style.max_height,
        ]
        .into_iter()
        .chain(style.margin)
        .chain(style.padding)
        .all(|value| value.abs() < f64::EPSILON)
        && (style.opacity - 1.0).abs() < f64::EPSILON
}

fn length(value: f64, available: f64, fallback: f64) -> f64 {
    if value > 0.0 {
        value
    } else if value < 0.0 {
        available * value.abs() / 100.0
    } else {
        fallback
    }
}

fn constrained(value: f64, min: f64, max: f64, available: f64) -> f64 {
    value
        .min(length(max, available, 14400.0))
        .max(length(min, available, 0.0))
}

fn distribute(mode: u8, free: f64, count: usize, gap: f64) -> (f64, f64) {
    let total = f64::from(u32::try_from(count).unwrap_or(u32::MAX));
    match mode {
        1 => (free * 0.5, gap),
        2 => (free, gap),
        3 if count > 1 => (0.0, gap + free / (total - 1.0)),
        4 if count > 0 => (free / (total * 2.0), gap + free / total),
        _ => (0.0, gap),
    }
}

fn cross(mode: u8, free: f64) -> f64 {
    match mode {
        2 => free * 0.5,
        3 => free,
        _ => 0.0,
    }
}

const fn decoration(style: &Style) -> Decoration {
    Decoration {
        fill: style.background,
        stroke: style.border,
        thickness: style.border_width,
        radius: style.radius,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distributes_gaps_and_starts_a_new_page_for_a_whole_block() {
        let (offset, gap) = distribute(3, 20.0, 3, 5.0);
        assert!((offset - 0.0).abs() < f64::EPSILON);
        assert!((gap - 15.0).abs() < f64::EPSILON);
        let mut flow = Flow {
            body: Block::default(),
            capacity: 44.0,
            pages: Vec::new(),
            pending_gap: 0.0,
        };
        let first = flow.place(Block {
            height: 30.0,
            ..Block::default()
        });
        let second = flow.place(Block {
            height: 20.0,
            ..Block::default()
        });
        assert!(first.is_ok() && second.is_ok());
        assert_eq!(flow.pages.len(), 1);
        assert!((flow.body.height - 20.0).abs() < f64::EPSILON);
    }
}
