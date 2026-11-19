use alloc::collections::BTreeMap;
use alloc::rc::Rc;
use core::f64::consts::TAU;
use core::iter;

use crate::jpeg;
use crate::raster::Gray;

const BLACK: Color = [0, 255];
const MAX_PIXELS: usize = 32_000_000;
const CLIP_BUDGET: usize = 128_000_000;

type Matrix = [f64; 6];
type Point = [f64; 2];
type Color = [u8; 2];

#[derive(Clone, Debug, Default)]
struct Path(Vec<Contour>);

#[derive(Clone, Debug)]
struct Contour {
    closed: bool,
    points: Vec<Point>,
}

#[derive(Clone, Copy, Debug)]
enum Segment {
    Close,
    Cubic(Point, Point, Point),
    Line(Point),
    Move(Point),
    Quad(Point, Point),
}

#[derive(Debug)]
pub(crate) struct GrayRaster {
    pub(crate) height: usize,
    pub(crate) pixels: Vec<u8>,
    pub(crate) width: usize,
}

#[derive(Clone, Copy, Debug)]
struct Rect {
    bottom: usize,
    left: usize,
    right: usize,
    top: usize,
}

#[derive(Debug)]
struct Clip {
    bounds: Rect,
    coverage: Coverage,
}

#[derive(Debug)]
enum Coverage {
    Mask(Vec<u8>),
    Rectangle([f64; 4]),
}

#[derive(Clone, Debug)]
struct State {
    cap: u8,
    clip: Option<Rc<Clip>>,
    fill: Color,
    line: f64,
    matrix: Matrix,
    stroke: Color,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct OutlineKey {
    id: u32,
    linear: [u64; 4],
}

#[derive(Debug, Default)]
struct CoverageScratch {
    active: Vec<ActiveEdge>,
    edges: Vec<Edge>,
    hits: Vec<(f64, i32)>,
    row: Vec<f64>,
}

#[derive(Debug)]
struct Painter<'data> {
    base: Matrix,
    blobs: Vec<&'data [u8]>,
    glyphs: BTreeMap<u32, Vec<Segment>>,
    outlines: BTreeMap<OutlineKey, Path>,
    path: Path,
    raster: GrayRaster,
    scratch: CoverageScratch,
    stack: Vec<State>,
    state: State,
    text_clip: Path,
}

#[derive(Debug)]
struct Reader<'data>(&'data [u8]);

#[derive(Debug)]
struct RenderPage<'data> {
    blobs: Vec<&'data [u8]>,
    ops: &'data [u8],
    rotate: i32,
    view: [f64; 4],
}

#[derive(Clone, Copy, Debug)]
struct Edge {
    end: Point,
    start: Point,
}

#[derive(Clone, Copy, Debug)]
struct ActiveEdge {
    end: Point,
    max_y: f64,
    start: Point,
}

#[derive(Debug)]
struct Image {
    blob: usize,
    flags: u8,
    height: usize,
    mask: usize,
    mask_height: usize,
    mask_width: usize,
    matte: [u8; 3],
    opacity: u8,
    width: usize,
}

impl<'data> Reader<'data> {
    fn byte(&mut self) -> Option<u8> {
        self.bytes(1)?.first().copied()
    }

    const fn bytes(&mut self, count: usize) -> Option<&'data [u8]> {
        let Some((taken, remaining)) = self.0.split_at_checked(count) else {
            return None;
        };
        self.0 = remaining;
        Some(taken)
    }

    fn color(&mut self) -> Option<Color> {
        let [red, green, blue, alpha] = self.bytes(4)?.try_into().ok()?;
        Some([gray(red, green, blue), alpha])
    }

    fn float(&mut self) -> Option<f64> {
        let value = f32::from_le_bytes(self.bytes(4)?.try_into().ok()?);
        value.is_finite().then_some(f64::from(value))
    }

    fn matrix(&mut self) -> Option<Matrix> {
        Some([
            self.float()?,
            self.float()?,
            self.float()?,
            self.float()?,
            self.float()?,
            self.float()?,
        ])
    }

    fn path(&mut self) -> Option<Vec<Segment>> {
        let verb_count = self.size()?;
        let verbs = self.bytes(verb_count)?;
        let coordinate_count = self.size()?;
        let mut coords = Self(self.bytes(coordinate_count.checked_mul(4)?)?);
        let mut commands = Vec::with_capacity(verb_count);
        for verb in verbs {
            commands.push(match verb {
                0 => Segment::Move(coords.point()?),
                1 => Segment::Line(coords.point()?),
                2 => Segment::Cubic(coords.point()?, coords.point()?, coords.point()?),
                3 => Segment::Close,
                4 => Segment::Quad(coords.point()?, coords.point()?),
                _ => return None,
            });
        }
        coords.0.is_empty().then_some(commands)
    }

    fn point(&mut self) -> Option<Point> {
        Some([self.float()?, self.float()?])
    }

    fn size(&mut self) -> Option<usize> {
        usize::try_from(self.word()?).ok()
    }

    fn word(&mut self) -> Option<u32> {
        Some(u32::from_le_bytes(self.bytes(4)?.try_into().ok()?))
    }
}

impl<'data> RenderPage<'data> {
    fn parse(payload: &'data [u8]) -> Option<Self> {
        let mut reader = Reader(payload);
        if reader.word()? != 0x4C52_4450 || reader.word()? != 1 || reader.word()? != 1 {
            return None;
        }
        let _header_reserved = reader.word()?;
        let length = reader.0.len();
        let _page_index = reader.word()?;
        let rotate = i32::from_le_bytes(reader.bytes(4)?.try_into().ok()?);
        let ops_length = reader.size()?;
        let blob_count = reader.size()?;
        let mut view = [0.0_f64; 4];
        for value in &mut view {
            *value = f64::from_le_bytes(reader.bytes(8)?.try_into().ok()?);
        }
        if reader.size()? != length || !view.into_iter().all(f64::is_finite) {
            return None;
        }
        let _page_reserved = reader.word()?;
        let mut ops = reader.bytes(align(ops_length)?)?;
        ops = ops.get(..ops_length)?;
        let mut table = Reader(reader.bytes(blob_count.checked_mul(8)?)?);
        let mut blobs = Vec::with_capacity(blob_count);
        for _blob in 0..blob_count {
            let start = table.size()?;
            let size = table.size()?;
            blobs.push(reader.0.get(start..start.checked_add(size)?)?);
        }
        Some(Self {
            blobs,
            ops,
            rotate,
            view,
        })
    }
}

impl Path {
    fn append_edges(&self, edges: &mut Vec<Edge>) {
        for Contour { points, .. } in &self.0 {
            edges.extend(
                points
                    .iter()
                    .copied()
                    .zip(points.iter().copied().skip(1))
                    .map(|(start, end)| Edge { end, start }),
            );
            if let (Some(&start), Some(&end)) = (points.last(), points.first()) {
                edges.push(Edge { end, start });
            }
        }
    }

    fn device(segments: &[Segment], matrix: Matrix) -> Self {
        let mut contours = Vec::new();
        let mut current = None::<Contour>;
        for segment in segments {
            match *segment {
                Segment::Move(point) => {
                    contours.extend(current.take());
                    current = Some(Contour {
                        closed: false,
                        points: vec![transform(matrix, point)],
                    });
                }
                Segment::Close => {
                    if let Some(contour) = current.as_mut() {
                        contour.closed = true;
                    }
                }
                Segment::Line(point) => {
                    if let Some(contour) = current.as_mut() {
                        contour.points.push(transform(matrix, point));
                    }
                }
                Segment::Cubic(first, second, end) => {
                    if let Some(contour) = current.as_mut()
                        && let Some(&start) = contour.points.last()
                    {
                        flatten(
                            &mut contour.points,
                            [
                                start,
                                transform(matrix, first),
                                transform(matrix, second),
                                transform(matrix, end),
                            ],
                            0,
                        );
                    }
                }
                Segment::Quad(control, point) => {
                    if let Some(contour) = current.as_mut()
                        && let Some(&start) = contour.points.last()
                    {
                        let end = transform(matrix, point);
                        let [cx, cy] = transform(matrix, control);
                        let [sx, sy] = start;
                        let [ex, ey] = end;
                        let left = [cx + (sx - cx) / 3.0_f64, cy + (sy - cy) / 3.0_f64];
                        let right = [cx + (ex - cx) / 3.0_f64, cy + (ey - cy) / 3.0_f64];
                        flatten(&mut contour.points, [start, left, right, end], 0);
                    }
                }
            }
        }
        contours.extend(current);
        Self(contours)
    }

    fn rectangle(&self) -> Option<[f64; 4]> {
        let [contour] = self.0.as_slice() else {
            return None;
        };
        let [[ax, ay], [bx, by], [cx, cy], [dx, dy]] = contour.points.as_slice() else {
            return None;
        };
        let horizontal = (ay - by).abs() < f64::EPSILON
            && (bx - cx).abs() < f64::EPSILON
            && (cy - dy).abs() < f64::EPSILON
            && (dx - ax).abs() < f64::EPSILON;
        let vertical = (ax - bx).abs() < f64::EPSILON
            && (by - cy).abs() < f64::EPSILON
            && (cx - dx).abs() < f64::EPSILON
            && (dy - ay).abs() < f64::EPSILON;
        (horizontal || vertical).then_some([ax.min(*cx), ay.min(*cy), ax.max(*cx), ay.max(*cy)])
    }

    fn stroke(&self, radius: f64, cap: u8) -> Self {
        let mut output = Vec::new();
        for Contour { closed, points } in &self.0 {
            let pairs = points.iter().copied().zip(points.iter().copied().skip(1));
            let tail = points
                .last()
                .copied()
                .zip(points.first().copied())
                .filter(|_| *closed);
            let count = points.len().saturating_sub(1);
            for (index, (start, end)) in pairs.chain(tail).enumerate() {
                let [ax, ay] = start;
                let [bx, by] = end;
                let length = distance(start, end);
                if length <= f64::EPSILON {
                    continue;
                }
                let dx = (bx - ax) * radius / length;
                let dy = (by - ay) * radius / length;
                let first = if *closed || index > 0 || cap == 2 {
                    1.0_f64
                } else {
                    0.0_f64
                };
                let last = if *closed || index.saturating_add(1) < count || cap == 2 {
                    1.0_f64
                } else {
                    0.0_f64
                };
                output.push(Contour {
                    closed: true,
                    points: vec![
                        [ax - first * dx - dy, ay - first * dy + dx],
                        [ax - first * dx + dy, ay - first * dy - dx],
                        [bx + last * dx + dy, by + last * dy - dx],
                        [bx + last * dx - dy, by + last * dy + dx],
                    ],
                });
            }
            if cap == 1 && !closed {
                for [x, y] in points.first().into_iter().chain(points.last()).copied() {
                    let circle = (0_u32..12)
                        .map(|step| {
                            let angle = f64::from(step) * TAU / 12.0_f64;
                            [x + radius * angle.cos(), y + radius * angle.sin()]
                        })
                        .collect();
                    output.push(Contour {
                        closed: true,
                        points: circle,
                    });
                }
            }
        }
        Self(output)
    }

    fn translated(&self, dx: f64, dy: f64) -> Self {
        Self(
            self.0
                .iter()
                .map(|contour| Contour {
                    closed: contour.closed,
                    points: contour
                        .points
                        .iter()
                        .copied()
                        .map(|[x, y]| [x + dx, y + dy])
                        .collect(),
                })
                .collect(),
        )
    }
}

impl Rect {
    fn intersect(self, other: Self) -> Self {
        Self {
            bottom: self.bottom.min(other.bottom),
            left: self.left.max(other.left),
            right: self.right.min(other.right),
            top: self.top.max(other.top),
        }
    }

    fn points<Points>(points: Points, raster: &GrayRaster) -> Self
    where
        Points: Iterator<Item = Point>,
    {
        let mut extents = [
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        ];
        for [x, y] in points {
            let [left, top, right, bottom] = extents;
            extents = [left.min(x), top.min(y), right.max(x), bottom.max(y)];
        }
        let [left, top, right, bottom] = extents;
        Self {
            bottom: pixel(bottom.ceil()).min(raster.height),
            left: pixel(left.floor()).min(raster.width),
            right: pixel(right.ceil()).min(raster.width),
            top: pixel(top.floor()).min(raster.height),
        }
    }

    const fn width(self) -> usize {
        self.right.saturating_sub(self.left)
    }
}

impl Clip {
    fn alpha(&self, x: usize, y: usize) -> u8 {
        let Rect {
            bottom,
            left,
            right,
            top,
        } = self.bounds;
        if x < left || x >= right || y < top || y >= bottom {
            return 0;
        }
        match &self.coverage {
            Coverage::Rectangle([x0, y0, x1, y1]) => {
                let px = scalar(x);
                let py = scalar(y);
                let horizontal = ((px + 1.0_f64).min(*x1) - px.max(*x0)).max(0.0_f64);
                let vertical = ((py + 1.0_f64).min(*y1) - py.max(*y0)).max(0.0_f64);
                channel(horizontal * vertical * 255.0_f64)
            }
            Coverage::Mask(pixels) => pixels
                .get(
                    y.saturating_sub(top)
                        .saturating_mul(self.bounds.width())
                        .saturating_add(x.saturating_sub(left)),
                )
                .copied()
                .unwrap_or(0),
        }
    }

    const fn bytes(&self) -> usize {
        match &self.coverage {
            Coverage::Mask(pixels) => pixels.len(),
            Coverage::Rectangle(_) => 0,
        }
    }
}

impl Image {
    fn decode(&self, blobs: &[&[u8]], flag: u8, index: usize) -> Option<Gray> {
        if self.flags & flag == 0 {
            return None;
        }
        jpeg::decode(blobs.get(index)?).ok()
    }

    fn read(reader: &mut Reader<'_>) -> Option<Self> {
        let flags = reader.byte()?;
        let opacity = reader.byte()?;
        let blob = reader.size()?;
        let width = reader.size()?;
        let height = reader.size()?;
        let mask = reader.size()?;
        let mask_width = reader.size()?;
        let mask_height = reader.size()?;
        let [red, green, blue, _reserved] = reader.bytes(4)?.try_into().ok()?;
        Some(Self {
            blob,
            flags,
            height,
            mask,
            mask_height,
            mask_width,
            matte: [red, green, blue],
            opacity,
            width,
        })
    }

    fn sample(
        &self,
        blobs: &[&[u8]],
        decoded: Option<&Gray>,
        decoded_mask: Option<&Gray>,
        image_x: f64,
        image_y: f64,
    ) -> Option<Color> {
        let column = pixel(image_x * scalar(self.width));
        let row = pixel(image_y * scalar(self.height));
        let at = row
            .checked_mul(self.width)?
            .checked_add(column)?
            .checked_mul(4)?;
        let bytes = *blobs.get(self.blob)?;
        let [red, green, blue, source_alpha] = if self.flags & 1 == 0 {
            bytes.get(at..at.checked_add(4)?)?.try_into().ok()?
        } else {
            let tone = decoded
                .and_then(|gray| jpeg_sample(gray, image_x, image_y))
                .unwrap_or(128);
            [tone, tone, tone, 255]
        };
        let mask_alpha = if self.flags & 2 == 0 {
            let mask_at = pixel(image_y * scalar(self.mask_height))
                .saturating_mul(self.mask_width)
                .saturating_add(pixel(image_x * scalar(self.mask_width)));
            blobs
                .get(self.mask)
                .and_then(|mask| mask.get(mask_at))
                .copied()
                .unwrap_or(255)
        } else {
            decoded_mask
                .and_then(|gray| jpeg_sample(gray, image_x, image_y))
                .unwrap_or(255)
        };
        let tone = if self.flags & 4 != 0 && mask_alpha > 0 && mask_alpha < 255 {
            let [mr, mg, mb] = self.matte;
            let undo = |value: u8, base: u8| {
                channel(
                    f64::from(base)
                        + (f64::from(value) - f64::from(base)) * 255.0_f64 / f64::from(mask_alpha),
                )
            };
            gray(undo(red, mr), undo(green, mg), undo(blue, mb))
        } else {
            gray(red, green, blue)
        };
        let opacity = channel(
            f64::from(source_alpha) * f64::from(self.opacity) * f64::from(mask_alpha)
                / 65_025.0_f64,
        );
        Some([tone, opacity])
    }
}

impl Painter<'_> {
    fn available_clip_budget(&self) -> usize {
        let mut bytes = 0_usize;
        let mut held = Vec::<&Rc<Clip>>::new();
        for mask in self
            .stack
            .iter()
            .chain(iter::once(&self.state))
            .filter_map(|state| state.clip.as_ref())
        {
            if mask.bytes() != 0 && !held.iter().any(|earlier| Rc::ptr_eq(earlier, mask)) {
                bytes = bytes.saturating_add(mask.bytes());
                held.push(mask);
            }
        }
        CLIP_BUDGET.saturating_sub(bytes)
    }

    fn drawing(&mut self, code: u8, reader: &mut Reader<'_>) -> Option<()> {
        match code {
            1 => {
                if self.stack.len() >= 256 {
                    return None;
                }
                self.stack.push(self.state.clone());
            }
            2 => {
                if let Some(previous) = self.stack.pop() {
                    self.state = previous;
                }
            }
            3 => self.state.matrix = multiply(reader.matrix()?, self.base),
            4 => self.path = Path::device(&reader.path()?, self.state.matrix),
            5 => {
                let even_odd = reader.byte()? == 1;
                paint(
                    &mut self.raster,
                    &self.path,
                    self.state.clip.as_deref(),
                    self.state.fill,
                    even_odd,
                    &mut self.scratch,
                );
            }
            6 => {
                let outline = self.path.stroke(self.radius(), self.state.cap);
                paint(
                    &mut self.raster,
                    &outline,
                    self.state.clip.as_deref(),
                    self.state.stroke,
                    false,
                    &mut self.scratch,
                );
            }
            7 => {
                let even_odd = reader.byte()? == 1;
                let budget = self.available_clip_budget();
                self.state.clip = Some(clip_path(
                    &self.raster,
                    &self.path,
                    self.state.clip.as_deref(),
                    even_odd,
                    budget,
                    &mut self.scratch,
                )?);
            }
            8 => self.state.fill = reader.color()?,
            9 => self.state.stroke = reader.color()?,
            10 => self.state.line = reader.float()?,
            11 => self.state.cap = reader.byte()?,
            _ => return None,
        }
        Some(())
    }

    fn glyph(&mut self, reader: &mut Reader<'_>) -> Option<()> {
        let modes = reader.byte()?;
        let id = reader.word()?;
        let [a, b, c, d, e, f] = multiply(reader.matrix()?, self.state.matrix);
        let key = OutlineKey {
            id,
            linear: [a.to_bits(), b.to_bits(), c.to_bits(), d.to_bits()],
        };
        if !self.outlines.contains_key(&key) {
            self.store_outline(key, [a, b, c, d, 0.0_f64, 0.0_f64]);
        }
        let Some(path) = self
            .outlines
            .get(&key)
            .map(|cached| cached.translated(e, f))
        else {
            return Some(());
        };
        let clip = self.state.clip.as_deref();
        if modes & 1 != 0 {
            paint(
                &mut self.raster,
                &path,
                clip,
                self.state.fill,
                false,
                &mut self.scratch,
            );
        }
        if modes & 2 != 0 {
            let outline = path.stroke(self.radius(), self.state.cap);
            paint(
                &mut self.raster,
                &outline,
                clip,
                self.state.stroke,
                false,
                &mut self.scratch,
            );
        }
        if modes & 4 != 0 {
            self.text_clip.0.extend(path.0);
        }
        Some(())
    }

    fn gradient(&mut self, code: u8, reader: &mut Reader<'_>) -> Option<()> {
        let _coordinates = reader.bytes(if code == 21 { 25 } else { 49 })?;
        let count = reader.size()?;
        let stops = reader.bytes(count.checked_mul(8)?)?;
        if count != 0 {
            let stop = count.checked_div(2)?.checked_mul(8)?.checked_add(4)?;
            let mut color = Reader(stops.get(stop..)?);
            match code {
                22 => self.state.fill = color.color()?,
                23 => self.state.stroke = color.color()?,
                _ => {}
            }
        }
        Some(())
    }

    fn image(&mut self, image: &Image) {
        let matrix = self.state.matrix;
        let Some(back) = inverse(matrix) else { return };
        let corners = [
            [0.0_f64, 0.0_f64],
            [0.0_f64, 1.0_f64],
            [1.0_f64, 0.0_f64],
            [1.0_f64, 1.0_f64],
        ];
        let bounds = Rect::points(
            corners.into_iter().map(|point| transform(matrix, point)),
            &self.raster,
        );
        let clip = self.state.clip.as_deref();
        let area = clip.map_or(bounds, |mask| bounds.intersect(mask.bounds));
        if area.width() == 0 || area.top >= area.bottom {
            return;
        }
        let decoded = image.decode(&self.blobs, 1, image.blob);
        let decoded_mask = image.decode(&self.blobs, 2, image.mask);
        for y in area.top..area.bottom {
            for x in area.left..area.right {
                let [image_x, pdf_v] = transform(back, [scalar(x) + 0.5_f64, scalar(y) + 0.5_f64]);
                let image_y = 1.0_f64 - pdf_v;
                if (0.0_f64..1.0_f64).contains(&image_x)
                    && (0.0_f64..1.0_f64).contains(&image_y)
                    && let Some(color) = image.sample(
                        &self.blobs,
                        decoded.as_ref(),
                        decoded_mask.as_ref(),
                        image_x,
                        image_y,
                    )
                    && let Some(slot) = self
                        .raster
                        .pixels
                        .get_mut(y.saturating_mul(self.raster.width).saturating_add(x))
                {
                    blend(
                        slot,
                        color,
                        clip.map_or(1.0_f64, |mask| f64::from(mask.alpha(x, y)) / 255.0_f64),
                    );
                }
            }
        }
    }

    fn radius(&self) -> f64 {
        let [a, b, c, d, _, _] = self.state.matrix;
        (self.state.line * (a * d - b * c).abs().sqrt()).max(1.0_f64) * 0.5_f64
    }

    fn run(&mut self, ops: &[u8]) -> Option<()> {
        let mut reader = Reader(ops);
        while let Some(code) = reader.byte() {
            match code {
                1..=11 => self.drawing(code, &mut reader)?,
                12 | 15 => {
                    let _mode = reader.byte()?;
                }
                13 => {
                    let _miter = reader.float()?;
                }
                14 => {
                    let count = reader.size()?;
                    let _dash = reader.bytes(count.checked_add(1)?.checked_mul(4)?)?;
                }
                16 => {
                    let id = reader.word()?;
                    drop(self.glyphs.insert(id, reader.path()?));
                }
                17 => self.glyph(&mut reader)?,
                18 => {
                    if !self.text_clip.0.is_empty() {
                        let budget = self.available_clip_budget();
                        self.state.clip = Some(clip_path(
                            &self.raster,
                            &self.text_clip,
                            self.state.clip.as_deref(),
                            false,
                            budget,
                            &mut self.scratch,
                        )?);
                        self.text_clip.0.clear();
                    }
                }
                19 => {
                    let _fallback = reader.bytes(29)?;
                    let length = reader.size()?;
                    let _text = reader.bytes(length)?;
                }
                20 => self.image(&Image::read(&mut reader)?),
                21..=23 => self.gradient(code, &mut reader)?,
                _ => return None,
            }
        }
        Some(())
    }

    fn store_outline(&mut self, key: OutlineKey, linear: Matrix) {
        let Some(commands) = self.glyphs.get(&key.id).cloned() else {
            return;
        };
        let flat = Path::device(&commands, linear);
        drop(self.outlines.insert(key, flat));
    }
}

const fn align(value: usize) -> Option<usize> {
    match value.checked_add(7) {
        Some(padded) => Some(padded & !7_usize),
        None => None,
    }
}

#[expect(
    clippy::as_conversions,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "sample and pixel coordinates saturate at unsigned bounds"
)]
const fn pixel_index(value: f64) -> u32 {
    value as u32
}

fn pixel(value: f64) -> usize {
    usize::try_from(pixel_index(value)).unwrap_or(usize::MAX)
}

fn channel(value: f64) -> u8 {
    u8::try_from(pixel_index(value.round()).min(255)).unwrap_or(255)
}

fn jpeg_sample(gray: &Gray, x: f64, y: f64) -> Option<u8> {
    let width = usize::try_from(gray.width).ok()?;
    let row = pixel(y * f64::from(gray.height));
    let column = pixel(x * f64::from(gray.width));
    gray.pixels
        .get(row.checked_mul(width)?.checked_add(column)?)
        .copied()
}

fn scalar(value: usize) -> f64 {
    f64::from(u32::try_from(value).unwrap_or(u32::MAX))
}

fn gray(red: u8, green: u8, blue: u8) -> u8 {
    channel(
        0.2126_f64 * f64::from(red) + 0.7152_f64 * f64::from(green) + 0.0722_f64 * f64::from(blue),
    )
}

fn transform([a, b, c, d, e, f]: Matrix, [x, y]: Point) -> Point {
    [a * x + c * y + e, b * x + d * y + f]
}

fn multiply([a, b, c, d, e, f]: Matrix, [oa, ob, oc, od, oe, of]: Matrix) -> Matrix {
    [
        a * oa + b * oc,
        a * ob + b * od,
        c * oa + d * oc,
        c * ob + d * od,
        e * oa + f * oc + oe,
        e * ob + f * od + of,
    ]
}

fn viewport([x0, y0, x1, y1]: [f64; 4], rotate: i32, scale: f64) -> Option<(Matrix, usize, usize)> {
    let width = pixel(((x1 - x0) * scale).ceil());
    let height = pixel(((y1 - y0) * scale).ceil());
    let result = match rotate.rem_euclid(360) {
        90_i32 => (
            [0.0_f64, scale, scale, 0.0_f64, -y0 * scale, -x0 * scale],
            height,
            width,
        ),
        180_i32 => (
            [-scale, 0.0_f64, 0.0_f64, scale, x1 * scale, -y0 * scale],
            width,
            height,
        ),
        270_i32 => (
            [0.0_f64, -scale, -scale, 0.0_f64, y1 * scale, x1 * scale],
            height,
            width,
        ),
        _ => (
            [scale, 0.0_f64, 0.0_f64, -scale, -x0 * scale, y1 * scale],
            width,
            height,
        ),
    };
    (width > 0 && height > 0 && width.checked_mul(height)? <= MAX_PIXELS).then_some(result)
}

const fn midpoint([ax, ay]: Point, [bx, by]: Point) -> Point {
    [ax.midpoint(bx), ay.midpoint(by)]
}

fn distance([ax, ay]: Point, [bx, by]: Point) -> f64 {
    let dx = bx - ax;
    let dy = by - ay;
    (dx * dx + dy * dy).sqrt()
}

fn flatten(points: &mut Vec<Point>, curve: [Point; 4], depth: u8) {
    let [start, first, second, end] = curve;
    let polygon = distance(start, first) + distance(first, second) + distance(second, end);
    if depth == 8 || polygon - distance(start, end) < 0.08_f64 {
        points.push(end);
        return;
    }

    let left = midpoint(start, first);
    let middle = midpoint(first, second);
    let right = midpoint(second, end);
    let inner_left = midpoint(left, middle);
    let inner_right = midpoint(middle, right);
    let center = midpoint(inner_left, inner_right);
    let next = depth.saturating_add(1);
    flatten(points, [start, left, inner_left, center], next);
    flatten(points, [center, inner_right, right, end], next);
}

const fn edge_min_y(edge: &Edge) -> f64 {
    let [_, ay] = edge.start;
    let [_, by] = edge.end;
    ay.min(by)
}

fn sort_edges(edges: &mut [Edge]) {
    edges.sort_unstable_by(|left, right| edge_min_y(left).total_cmp(&edge_min_y(right)));
}

fn activate(edges: &[Edge], cursor: &mut usize, height: f64, active: &mut Vec<ActiveEdge>) {
    let mut index = 0_usize;
    while index < active.len() {
        let expired = active.get(index).is_some_and(|edge| edge.max_y <= height);
        if expired {
            let _expired = active.swap_remove(index);
        } else {
            index = index.saturating_add(1);
        }
    }
    while let Some(edge) = edges.get(*cursor) {
        if edge_min_y(edge) > height {
            break;
        }
        *cursor = cursor.saturating_add(1);
        let [_, ay] = edge.start;
        let [_, by] = edge.end;
        let max_y = ay.max(by);
        if max_y > height {
            active.push(ActiveEdge {
                end: edge.end,
                max_y,
                start: edge.start,
            });
        }
    }
}

fn collect_hits(active: &[ActiveEdge], height: f64, hits: &mut Vec<(f64, i32)>) {
    hits.clear();
    for edge in active {
        let [ax, ay] = edge.start;
        let [bx, by] = edge.end;
        let x = ax + (height - ay) * (bx - ax) / (by - ay);
        hits.push((x, if ay < by { 1_i32 } else { -1_i32 }));
    }
    hits.sort_unstable_by(|left, right| left.0.total_cmp(&right.0));
}

const fn span_inside(winding: i32, even_odd: bool) -> bool {
    if even_odd {
        winding & 1_i32 != 0_i32
    } else {
        winding != 0_i32
    }
}

fn cover_partial(row: &mut [f64], origin: usize, left: usize, right: usize, start: f64, end: f64) {
    for x in left..right {
        if let Some(coverage) = row.get_mut(x.saturating_sub(origin)) {
            let px = scalar(x);
            *coverage += ((px + 1.0_f64).min(end) - px.max(start)).max(0.0_f64) * 0.25_f64;
        }
    }
}

fn cover_span(
    row: &mut [f64],
    origin: usize,
    start: f64,
    end: f64,
    left_bound: usize,
    right_bound: usize,
) {
    let left = pixel(start.floor()).max(left_bound);
    let right = pixel(end.ceil()).min(right_bound);
    if left >= right {
        return;
    }
    let full_left = pixel(start.ceil()).max(left);
    let full_right = pixel(end.floor()).min(right);
    if full_left >= full_right {
        cover_partial(row, origin, left, right, start, end);
        return;
    }
    cover_partial(row, origin, left, full_left, start, end);
    for x in full_left..full_right {
        if let Some(coverage) = row.get_mut(x.saturating_sub(origin)) {
            *coverage += 0.25_f64;
        }
    }
    cover_partial(row, origin, full_right, right, start, end);
}

fn accumulate_hits(row: &mut [f64], hits: &[(f64, i32)], bounds: Rect, even_odd: bool) {
    let mut winding = 0_i32;
    let mut start = 0.0_f64;
    for &(end, direction) in hits {
        if span_inside(winding, even_odd) {
            cover_span(row, bounds.left, start, end, bounds.left, bounds.right);
        }
        start = end;
        winding = winding.saturating_add(direction);
    }
}

fn scan<Write>(scratch: &mut CoverageScratch, bounds: Rect, even_odd: bool, mut write: Write)
where
    Write: FnMut(usize, usize, f64),
{
    let width = bounds.width();
    if width == 0 {
        return;
    }
    sort_edges(&mut scratch.edges);
    scratch.active.clear();
    let mut cursor = 0_usize;
    if scratch.row.len() < width {
        scratch.row.resize(width, 0.0_f64);
    }
    for y in bounds.top..bounds.bottom {
        for sample in scratch.row.iter_mut().take(width) {
            *sample = 0.0_f64;
        }
        for offset in [0.125_f64, 0.375_f64, 0.625_f64, 0.875_f64] {
            let height = scalar(y) + offset;
            activate(&scratch.edges, &mut cursor, height, &mut scratch.active);
            collect_hits(&scratch.active, height, &mut scratch.hits);
            accumulate_hits(&mut scratch.row, &scratch.hits, bounds, even_odd);
        }
        for (index, &coverage) in scratch.row.iter().take(width).enumerate() {
            if coverage > 0.0_f64 {
                write(bounds.left.saturating_add(index), y, coverage);
            }
        }
    }
}

fn blend(slot: &mut u8, [tone, opacity]: Color, coverage: f64) {
    if opacity == 255 && coverage.to_bits() == 1.0_f64.to_bits() {
        *slot = tone;
        return;
    }
    let alpha = f64::from(opacity) * coverage / 255.0_f64;
    *slot = channel(f64::from(*slot) + (f64::from(tone) - f64::from(*slot)) * alpha);
}

fn paint(
    raster: &mut GrayRaster,
    path: &Path,
    clip: Option<&Clip>,
    color: Color,
    even_odd: bool,
    scratch: &mut CoverageScratch,
) {
    scratch.edges.clear();
    path.append_edges(&mut scratch.edges);
    let bounds = Rect::points(
        scratch.edges.iter().flat_map(|edge| [edge.start, edge.end]),
        raster,
    );
    let area = clip.map_or(bounds, |mask| bounds.intersect(mask.bounds));
    let width = raster.width;
    scan(scratch, area, even_odd, |x, y, coverage| {
        if let Some(slot) = raster
            .pixels
            .get_mut(y.saturating_mul(width).saturating_add(x))
        {
            let scoped = clip.map_or(1.0_f64, |mask| f64::from(mask.alpha(x, y)) / 255.0_f64);
            blend(slot, color, coverage * scoped);
        }
    });
}

fn clip_path(
    raster: &GrayRaster,
    path: &Path,
    clip: Option<&Clip>,
    even_odd: bool,
    budget: usize,
    scratch: &mut CoverageScratch,
) -> Option<Rc<Clip>> {
    scratch.edges.clear();
    path.append_edges(&mut scratch.edges);
    let bounds = Rect::points(
        scratch.edges.iter().flat_map(|edge| [edge.start, edge.end]),
        raster,
    );
    let area = clip.map_or(bounds, |mask| bounds.intersect(mask.bounds));
    if let Some([x0, y0, x1, y1]) = path.rectangle() {
        let rectangle = match clip.map(|mask| &mask.coverage) {
            None => Some([x0, y0, x1, y1]),
            Some(Coverage::Rectangle([left, top, right, bottom])) => {
                Some([x0.max(*left), y0.max(*top), x1.min(*right), y1.min(*bottom)])
            }
            Some(Coverage::Mask(_)) => None,
        };
        if let Some(coordinates) = rectangle {
            return Some(Rc::new(Clip {
                bounds: area,
                coverage: Coverage::Rectangle(coordinates),
            }));
        }
    }
    let len = area
        .width()
        .checked_mul(area.bottom.saturating_sub(area.top))?;
    if len > budget {
        return None;
    }
    let mut pixels = vec![0; len];
    scan(scratch, area, even_odd, |x, y, coverage| {
        let at = y
            .saturating_sub(area.top)
            .saturating_mul(area.width())
            .saturating_add(x.saturating_sub(area.left));
        if let Some(slot) = pixels.get_mut(at) {
            *slot = channel(coverage * f64::from(clip.map_or(255, |mask| mask.alpha(x, y))));
        }
    });
    Some(Rc::new(Clip {
        bounds: area,
        coverage: Coverage::Mask(pixels),
    }))
}

fn inverse([a, b, c, d, e, f]: Matrix) -> Option<Matrix> {
    let determinant = a * d - b * c;
    if !determinant.is_finite() || determinant.abs() < f64::MIN_POSITIVE {
        return None;
    }
    Some([
        d / determinant,
        -b / determinant,
        -c / determinant,
        a / determinant,
        (c * f - d * e) / determinant,
        (b * e - a * f) / determinant,
    ])
}

pub(crate) fn rasterize(payload: &[u8], scale_x1000: u32) -> Option<GrayRaster> {
    let RenderPage {
        blobs,
        ops,
        rotate,
        view,
    } = RenderPage::parse(payload)?;
    let (base, width, height) = viewport(view, rotate, f64::from(scale_x1000) / 1_000.0_f64)?;
    let mut painter = Painter {
        base,
        blobs,
        glyphs: BTreeMap::new(),
        outlines: BTreeMap::new(),
        path: Path::default(),
        raster: GrayRaster {
            height,
            pixels: vec![255; width.checked_mul(height)?],
            width,
        },
        scratch: CoverageScratch::default(),
        stack: Vec::new(),
        state: State {
            cap: 0,
            clip: None,
            fill: BLACK,
            line: 1.0_f64,
            matrix: base,
            stroke: BLACK,
        },
        text_clip: Path::default(),
    };
    painter.run(ops)?;
    Some(painter.raster)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rectangle(ops: &mut Vec<u8>, [left, bottom, right, top]: [f32; 4]) {
        ops.extend([4, 5, 0, 0, 0, 0, 1, 1, 1, 3, 8, 0, 0, 0]);
        for value in [left, bottom, right, bottom, right, top, left, top] {
            ops.extend(value.to_le_bytes());
        }
    }

    fn payload(rot: i32, ops: &[u8], blobs: &[&[u8]]) -> Vec<u8> {
        let aligned = align(ops.len()).unwrap();
        let header_size = 56_usize;
        let table_size = blobs.len().saturating_mul(8);
        let blob_size: usize = blobs.iter().map(|blob| align(blob.len()).unwrap()).sum();
        let record_size = header_size
            .saturating_add(aligned)
            .saturating_add(table_size)
            .saturating_add(blob_size);
        let mut bytes = Vec::new();
        for word in [0x4C52_4450_u32, 1, 1, 0, 0] {
            bytes.extend(word.to_le_bytes());
        }
        bytes.extend(rot.to_le_bytes());
        bytes.extend(u32::try_from(ops.len()).unwrap().to_le_bytes());
        bytes.extend(u32::try_from(blobs.len()).unwrap().to_le_bytes());
        for number in [10.0_f64, 20.0_f64, 14.0_f64, 22.0_f64] {
            bytes.extend(number.to_le_bytes());
        }
        bytes.extend(u32::try_from(record_size).unwrap().to_le_bytes());
        bytes.extend(0_u32.to_le_bytes());
        bytes.extend_from_slice(ops);
        bytes.resize(
            16_usize.saturating_add(header_size).saturating_add(aligned),
            0,
        );
        let mut offset = 0_usize;
        for blob in blobs {
            bytes.extend(u32::try_from(offset).unwrap().to_le_bytes());
            bytes.extend(u32::try_from(blob.len()).unwrap().to_le_bytes());
            offset = offset.saturating_add(align(blob.len()).unwrap());
        }
        for blob in blobs {
            bytes.extend_from_slice(blob);
            bytes.resize(align(bytes.len()).unwrap(), 0);
        }
        bytes
    }

    #[test]
    fn rotates_cropped_page_and_restores_clip() {
        let mut ops = vec![1];
        rectangle(&mut ops, [10.0_f32, 20.0_f32, 12.0_f32, 22.0_f32]);
        ops.extend([7, 0]);
        rectangle(&mut ops, [10.0_f32, 20.0_f32, 14.0_f32, 22.0_f32]);
        ops.extend([5, 0, 2, 8, 128, 128, 128, 255]);
        rectangle(&mut ops, [13.0_f32, 20.0_f32, 14.0_f32, 22.0_f32]);
        ops.extend([5, 0]);
        let bytes = payload(90, &ops, &[]);
        let raster = rasterize(&bytes, 1000).unwrap();
        assert_eq!((raster.width, raster.height), (2, 4));
        assert_eq!(raster.pixels, [0, 0, 0, 0, 255, 255, 128, 128]);
        assert!(rasterize(&bytes[..bytes.len().saturating_sub(1)], 1000).is_none());
    }

    #[test]
    fn samples_progressive_jpeg_images() {
        let mut ops = vec![3];
        for value in [4.0_f32, 0.0_f32, 0.0_f32, 2.0_f32, 10.0_f32, 20.0_f32] {
            ops.extend(value.to_le_bytes());
        }
        ops.extend([20, 1, 255]);
        let bytes = include_bytes!("../tests/fixtures/progressive.jpg");
        let gray = jpeg::decode(bytes).unwrap();
        for word in [0_u32, gray.width, gray.height, u32::MAX, 0, 0, 0] {
            ops.extend(word.to_le_bytes());
        }
        let encoded = payload(0, &ops, &[bytes]);
        let raster = rasterize(&encoded, 1000).unwrap();
        assert_eq!(raster.pixels.len(), 8);
        assert!(raster.pixels.iter().any(|&value| value != 128));
    }

    #[test]
    fn samples_rgba_images_with_pdf_upward_y_axis() {
        let mut ops = vec![3];
        for value in [4.0_f32, 0.0_f32, 0.0_f32, 2.0_f32, 10.0_f32, 20.0_f32] {
            ops.extend(value.to_le_bytes());
        }
        ops.extend([20, 0, 255]);
        for word in [0_u32, 1, 2, u32::MAX, 0, 0, 0] {
            ops.extend(word.to_le_bytes());
        }
        let bytes = payload(0, &ops, &[&[0, 0, 0, 255, 127, 127, 127, 255]]);
        let raster = rasterize(&bytes, 1000).unwrap();
        assert_eq!(raster.pixels, [0, 0, 0, 0, 127, 127, 127, 127]);
    }

    #[test]
    fn translated_outline_matches_device_flatten() {
        let commands = [
            Segment::Move([0.1_f64, 0.2_f64]),
            Segment::Cubic([0.4_f64, 1.5_f64], [1.2_f64, -0.3_f64], [1.8_f64, 0.6_f64]),
            Segment::Line([2.0_f64, 0.1_f64]),
            Segment::Close,
        ];
        let matrix = [12.5_f64, -0.35_f64, 0.2_f64, 9.75_f64, 40.125_f64, -6.5_f64];
        let [a, b, c, d, e, f] = matrix;
        let direct = Path::device(&commands, matrix);
        let shifted = Path::device(&commands, [a, b, c, d, 0.0_f64, 0.0_f64]).translated(e, f);
        assert_eq!(direct.0.len(), shifted.0.len());
        for (left, right) in direct.0.iter().zip(&shifted.0) {
            assert_eq!(left.closed, right.closed);
            assert_eq!(left.points.len(), right.points.len());
            for ([lx, ly], [rx, ry]) in left
                .points
                .iter()
                .copied()
                .zip(right.points.iter().copied())
            {
                assert!((lx - rx).abs() <= 1e-6_f64, "{lx} vs {rx}");
                assert!((ly - ry).abs() <= 1e-6_f64, "{ly} vs {ry}");
            }
        }
    }
}
