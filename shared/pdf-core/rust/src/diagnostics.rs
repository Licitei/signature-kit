use crate::document::{Document, Page};
use crate::failure::{Failure, Outcome};
use crate::inspection::Limits;
use crate::text::{Capture, Session, scan_page};

const MAX_BOXES: usize = 100_000;

type Rect = [f64; 4];

#[derive(Clone, Copy, Debug, Default)]
pub(crate) enum TextLayer {
    #[default]
    None,
    Usable,
    Weak,
}

#[derive(Debug, Default)]
pub(crate) struct PageDiagnostics {
    pub glyphs: u32,
    pub image_count: u32,
    pub invisible: u32,
    pub page_index: u32,
    pub raster_coverage: f64,
    pub replacement: u32,
    pub text_area: f64,
    pub text_layer: TextLayer,
    pub unmapped: u32,
    pub visible_chars: u32,
}

pub(crate) struct PageScan {
    crop: Rect,
    diagnostics: PageDiagnostics,
    glyph_boxes: Vec<Rect>,
    image_boxes: Vec<Rect>,
}

impl PageScan {
    fn finish(self, page_index: usize) -> Outcome<PageDiagnostics> {
        let mut diagnostics = self.diagnostics;
        diagnostics.page_index = u32::try_from(page_index)
            .map_err(|_conversion| Failure::limit("page index exceeds 32-bit limit"))?;
        let [x0, y0, x1, y1] = self.crop;
        let page_area = (x1 - x0) * (y1 - y0);
        diagnostics.text_area = fraction(&self.glyph_boxes, page_area);
        diagnostics.raster_coverage = fraction(&self.image_boxes, page_area);
        diagnostics.text_layer = if diagnostics.glyphs == 0 {
            TextLayer::None
        } else if diagnostics.visible_chars == 0
            || diagnostics.invisible >= diagnostics.glyphs.div_ceil(2)
            || diagnostics.unmapped >= diagnostics.glyphs.div_ceil(5)
            || diagnostics.raster_coverage >= 0.75_f64 && diagnostics.visible_chars < 16
        {
            TextLayer::Weak
        } else {
            TextLayer::Usable
        };
        Ok(diagnostics)
    }

    pub(crate) fn glyph(&mut self, text: &str, bounds: Option<Rect>) -> Outcome<()> {
        let clipped = bounds.and_then(|rect| intersection(rect, self.crop));
        let diagnostics = &mut self.diagnostics;
        diagnostics.glyphs = diagnostics.glyphs.saturating_add(1);
        diagnostics.invisible = diagnostics
            .invisible
            .saturating_add(u32::from(clipped.is_none()));
        let mut unmapped = text.is_empty();
        let mut visible = false;
        for ch in text.chars() {
            let code = u32::from(ch);
            let private =
                matches!(code, 0xe000..=0xf8ff | 0xf0000..=0xffffd | 0x0010_0000..=0x0010_fffd);
            let replacement = ch == char::REPLACEMENT_CHARACTER;
            unmapped |= private || replacement || ch.is_control() && !ch.is_whitespace();
            diagnostics.replacement = diagnostics
                .replacement
                .saturating_add(u32::from(replacement));
            if clipped.is_some()
                && !ch.is_whitespace()
                && !ch.is_control()
                && !private
                && !replacement
            {
                diagnostics.visible_chars = diagnostics.visible_chars.saturating_add(1);
                visible = true;
            }
        }
        diagnostics.unmapped = diagnostics.unmapped.saturating_add(u32::from(unmapped));
        if let Some(rect) = clipped.filter(|_| visible) {
            if self.glyph_boxes.len() == MAX_BOXES {
                return Err(Failure::limit("page glyph coverage exceeds box limit"));
            }
            self.glyph_boxes.push(rect);
        }
        Ok(())
    }

    pub(crate) fn image(&mut self, bounds: Rect) -> Outcome<()> {
        self.diagnostics.image_count = self.diagnostics.image_count.saturating_add(1);
        if let Some(rect) = intersection(bounds, self.crop) {
            if self.image_boxes.len() == MAX_BOXES {
                return Err(Failure::limit("page raster coverage exceeds box limit"));
            }
            self.image_boxes.push(rect);
        }
        Ok(())
    }

    pub(crate) fn missing_font(&mut self, bytes: &[u8], visible: bool) {
        let count = u32::try_from(bytes.len()).unwrap_or(u32::MAX);
        self.diagnostics.glyphs = self.diagnostics.glyphs.saturating_add(count);
        self.diagnostics.unmapped = self.diagnostics.unmapped.saturating_add(count);
        if !visible {
            self.diagnostics.invisible = self.diagnostics.invisible.saturating_add(count);
        }
    }

    pub(crate) fn new(crop: Rect) -> Self {
        Self {
            crop,
            glyph_boxes: Vec::new(),
            image_boxes: Vec::new(),
            diagnostics: PageDiagnostics::default(),
        }
    }
}

struct SweepEvent {
    add: bool,
    next: usize,
    span: [usize; 2],
}

#[derive(Clone, Copy, Default)]
struct Span {
    cover: u32,
    width: f64,
}

struct Sweep<'edges> {
    edges: &'edges [f64],
    nodes: Vec<Span>,
}

impl Sweep<'_> {
    fn update(
        &mut self,
        node: usize,
        start: usize,
        end: usize,
        range: [usize; 2],
        add: bool,
    ) -> f64 {
        let [left, right] = range;
        let children = node.saturating_mul(2);
        let mut child_width = 0.0_f64;
        if left > start || right < end {
            let mid = start.midpoint(end);
            if left < mid {
                let _: f64 = self.update(children, start, mid, range, add);
            }
            if right > mid {
                let _: f64 = self.update(children.saturating_add(1), mid, end, range, add);
            }
        }
        if end.saturating_sub(start) > 1 {
            child_width = self
                .nodes
                .get(children)
                .map_or(0.0_f64, |child| child.width)
                + self
                    .nodes
                    .get(children.saturating_add(1))
                    .map_or(0.0_f64, |child| child.width);
        }
        let Some(current) = self.nodes.get_mut(node) else {
            return 0.0_f64;
        };
        if left <= start && end <= right {
            current.cover = if add {
                current.cover.saturating_add(1)
            } else {
                current.cover.saturating_sub(1)
            };
        }
        current.width = if current.cover > 0 {
            match (self.edges.get(start), self.edges.get(end)) {
                (Some(a), Some(b)) => b - a,
                _ => 0.0_f64,
            }
        } else {
            child_width
        };
        current.width
    }
}

#[inline(never)]
fn fraction(boxes: &[Rect], area: f64) -> f64 {
    if area.is_finite() && area > 0.0_f64 {
        (union_area(boxes) / area).min(1.0_f64)
    } else {
        0.0_f64
    }
}

pub(crate) fn intersection([x0, y0, x1, y1]: Rect, [a0, b0, a1, b1]: Rect) -> Option<Rect> {
    let rect = [x0.max(a0), y0.max(b0), x1.min(a1), y1.min(b1)];
    let [left, bottom, right, top] = rect;
    (left < right && bottom < top && rect.iter().all(|value| value.is_finite())).then_some(rect)
}

#[inline(never)]
fn sorted_edges(boxes: &[Rect], horizontal: bool) -> Vec<f64> {
    let mut edges = Vec::with_capacity(boxes.len().saturating_mul(2));
    for &[x0, y0, x1, y1] in boxes {
        edges.extend_from_slice(&if horizontal { [x0, x1] } else { [y0, y1] });
    }
    edges.sort_unstable_by(f64::total_cmp);
    edges.dedup_by(|left, right| left.total_cmp(right).is_eq());
    edges
}

fn edge_index(edges: &[f64], target: f64) -> Option<usize> {
    edges.binary_search_by(|edge| edge.total_cmp(&target)).ok()
}

fn union_area(boxes: &[Rect]) -> f64 {
    if let [[x0, y0, x1, y1]] = boxes {
        return (x1 - x0) * (y1 - y0);
    }
    let horizontal = sorted_edges(boxes, true);
    let vertical = sorted_edges(boxes, false);
    let mut heads = vec![usize::MAX; vertical.len()];
    let mut events = Vec::with_capacity(boxes.len().saturating_mul(2));
    for &[x0, y0, x1, y1] in boxes {
        let (Some(left), Some(right)) = (edge_index(&horizontal, x0), edge_index(&horizontal, x1))
        else {
            continue;
        };
        for (y, add) in [(y0, true), (y1, false)] {
            if let Some(head) = edge_index(&vertical, y).and_then(|index| heads.get_mut(index)) {
                let next = *head;
                *head = events.len();
                events.push(SweepEvent {
                    add,
                    next,
                    span: [left, right],
                });
            }
        }
    }
    let mut sweep = Sweep {
        edges: &horizontal,
        nodes: vec![Span::default(); horizontal.len().saturating_mul(4)],
    };
    let mut last = 0.0_f64;
    let mut width = 0.0_f64;
    let mut area = 0.0_f64;
    for (&y, first) in vertical.iter().zip(heads) {
        area += (y - last) * width;
        last = y;
        let mut cursor = first;
        while let Some(event) = events.get(cursor) {
            width = sweep.update(
                1,
                0,
                horizontal.len().saturating_sub(1),
                event.span,
                event.add,
            );
            cursor = event.next;
        }
    }
    area
}

pub(crate) fn opened_diagnostics(
    document: &Document<'_>,
    selected: &[(usize, &Page)],
    limits: &Limits,
) -> Outcome<Vec<PageDiagnostics>> {
    let mut session = Session::default();
    let mut diagnostics = Vec::with_capacity(selected.len());
    for &(index, page) in selected {
        let mut scan = PageScan::new(page.info.crop_box);
        drop(scan_page(
            document,
            page,
            limits,
            Capture::default(),
            &mut session,
            Some(&mut scan),
        )?);
        diagnostics.push(scan.finish(index)?);
    }
    Ok(diagnostics)
}

#[cfg(test)]
mod tests {
    use super::union_area;

    #[test]
    fn coverage_counts_overlaps_once() {
        let boxes = [
            [0.0_f64, 0.0_f64, 4.0_f64, 4.0_f64],
            [1.0_f64, 1.0_f64, 3.0_f64, 3.0_f64],
            [2.0_f64, 2.0_f64, 6.0_f64, 6.0_f64],
            [7.0_f64, 7.0_f64, 8.0_f64, 8.0_f64],
        ];
        assert!((union_area(&boxes) - 29.0_f64).abs() < f64::EPSILON);
    }
}
