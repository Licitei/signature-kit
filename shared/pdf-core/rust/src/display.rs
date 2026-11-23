use crate::num::f64_to_f32;

pub(crate) const OP_SAVE: u8 = 1;
pub(crate) const OP_RESTORE: u8 = 2;
pub(crate) const OP_TRANSFORM: u8 = 3;
pub(crate) const OP_PATH: u8 = 4;
pub(crate) const OP_FILL: u8 = 5;
pub(crate) const OP_STROKE: u8 = 6;
pub(crate) const OP_CLIP: u8 = 7;
pub(crate) const OP_FILL_COLOR: u8 = 8;
pub(crate) const OP_STROKE_COLOR: u8 = 9;
pub(crate) const OP_LINE_WIDTH: u8 = 10;
pub(crate) const OP_LINE_CAP: u8 = 11;
pub(crate) const OP_LINE_JOIN: u8 = 12;
pub(crate) const OP_MITER: u8 = 13;
pub(crate) const OP_DASH: u8 = 14;
pub(crate) const OP_BLEND: u8 = 15;
pub(crate) const OP_GLYPH_DEFINE: u8 = 16;
pub(crate) const OP_GLYPH: u8 = 17;
pub(crate) const OP_TEXT_CLIP: u8 = 18;
pub(crate) const OP_TEXT: u8 = 19;
pub(crate) const OP_IMAGE: u8 = 20;
pub(crate) const OP_SHADE: u8 = 21;
pub(crate) const OP_FILL_GRADIENT: u8 = 22;
pub(crate) const OP_STROKE_GRADIENT: u8 = 23;
pub(crate) const VERB_MOVE: u8 = 0;
pub(crate) const VERB_LINE: u8 = 1;
pub(crate) const VERB_CUBIC: u8 = 2;
pub(crate) const VERB_CLOSE: u8 = 3;
pub(crate) const VERB_QUAD: u8 = 4;
pub(crate) const NO_BLOB: u32 = u32::MAX;

pub(crate) type Matrix = [f64; 6];

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct PathData {
    pub coords: Vec<f32>,
    pub verbs: Vec<u8>,
}

#[derive(Debug)]
pub(crate) struct Pen<'path> {
    pub open: bool,
    pub path: &'path mut PathData,
    pub x: f64,
    pub y: f64,
}

impl PathData {
    pub(crate) fn clear(&mut self) {
        self.verbs.clear();
        self.coords.clear();
    }

    pub(crate) fn close(&mut self) {
        if self.verbs.last().is_some_and(|verb| *verb != VERB_CLOSE) {
            self.verbs.push(VERB_CLOSE);
        }
    }

    pub(crate) fn cubic(&mut self, points: [f64; 6]) {
        self.verbs.push(VERB_CUBIC);
        self.coords.extend(points.map(f64_to_f32));
    }

    pub(crate) const fn is_empty(&self) -> bool {
        self.verbs.is_empty()
    }

    pub(crate) fn line(&mut self, x: f64, y: f64) {
        self.verbs.push(VERB_LINE);
        self.coords.extend([f64_to_f32(x), f64_to_f32(y)]);
    }

    pub(crate) fn move_to(&mut self, x: f64, y: f64) {
        if self.verbs.last() == Some(&VERB_MOVE) {
            let len = self.coords.len();
            if let Some(slot) = self.coords.get_mut(len.saturating_sub(2)..) {
                slot.copy_from_slice(&[f64_to_f32(x), f64_to_f32(y)]);
                return;
            }
        }
        self.verbs.push(VERB_MOVE);
        self.coords.extend([f64_to_f32(x), f64_to_f32(y)]);
    }

    pub(crate) fn quad(&mut self, points: [f64; 4]) {
        self.verbs.push(VERB_QUAD);
        self.coords.extend(points.map(f64_to_f32));
    }

    pub(crate) fn rect(&mut self, x: f64, y: f64, width: f64, height: f64) {
        self.move_to(x, y);
        self.line(x + width, y);
        self.line(x + width, y + height);
        self.line(x, y + height);
        self.verbs.push(VERB_CLOSE);
    }
}

impl<'path> Pen<'path> {
    pub(crate) fn close(&mut self) {
        if self.open {
            self.path.close();
            self.open = false;
        }
    }

    pub(crate) fn curve(&mut self, deltas: [f64; 6]) {
        let x1 = self.x + deltas[0];
        let y1 = self.y + deltas[1];
        let x2 = x1 + deltas[2];
        let y2 = y1 + deltas[3];
        self.x = x2 + deltas[4];
        self.y = y2 + deltas[5];
        self.path.cubic([x1, y1, x2, y2, self.x, self.y]);
        self.open = true;
    }

    pub(crate) fn line(&mut self, dx: f64, dy: f64) {
        self.x += dx;
        self.y += dy;
        self.path.line(self.x, self.y);
        self.open = true;
    }

    pub(crate) fn move_by(&mut self, dx: f64, dy: f64) {
        self.close();
        self.x += dx;
        self.y += dy;
        self.path.move_to(self.x, self.y);
        self.open = true;
    }

    pub(crate) const fn new(path: &'path mut PathData) -> Self {
        Self {
            open: false,
            path,
            x: 0.0,
            y: 0.0,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Gradient<'stops> {
    pub coords: [f64; 6],
    pub extend: (bool, bool),
    pub radial: bool,
    pub stops: &'stops [(f64, [u8; 4])],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ImageRef {
    pub blob: u32,
    pub height: u32,
    pub interpolate: bool,
    pub jpeg: bool,
    pub mask: u32,
    pub mask_height: u32,
    pub mask_jpeg: bool,
    pub mask_width: u32,
    pub matte: Option<[u8; 3]>,
    pub width: u32,
}

#[derive(Debug, Default)]
pub(crate) struct DisplayList {
    pub blob_bytes: usize,
    pub blobs: Vec<Vec<u8>>,
    pub ops: Vec<u8>,
}

impl DisplayList {
    pub(crate) fn blob(&mut self, data: Vec<u8>) -> u32 {
        self.blob_bytes = self.blob_bytes.saturating_add(data.len());
        let index = u32::try_from(self.blobs.len()).unwrap_or(NO_BLOB);
        self.blobs.push(data);
        index
    }

    pub(crate) fn color(&mut self, stroke: bool, rgba: [u8; 4]) {
        self.ops.push(if stroke {
            OP_STROKE_COLOR
        } else {
            OP_FILL_COLOR
        });
        self.ops.extend_from_slice(&rgba);
    }

    pub(crate) fn dash(&mut self, lengths: &[f64], phase: f64) {
        self.ops.push(OP_DASH);
        self.u32(u32::try_from(lengths.len()).unwrap_or(0));
        for length in lengths {
            self.f32(*length);
        }
        self.f32(phase);
    }

    pub(crate) fn f32(&mut self, value: f64) {
        self.ops.extend_from_slice(&f64_to_f32(value).to_le_bytes());
    }

    pub(crate) fn glyph(&mut self, modes: u8, id: u32, matrix: &Matrix) {
        self.ops.push(OP_GLYPH);
        self.ops.push(modes);
        self.u32(id);
        self.matrix(matrix);
    }

    pub(crate) fn glyph_define(&mut self, id: u32, path: &PathData) {
        self.ops.push(OP_GLYPH_DEFINE);
        self.u32(id);
        self.path_payload(path);
    }

    pub(crate) fn gradient(&mut self, code: u8, gradient: &Gradient<'_>, matrix: Option<&Matrix>) {
        self.ops.push(code);
        self.ops.push(
            u8::from(gradient.radial)
                | (u8::from(gradient.extend.0) << 1_u8)
                | (u8::from(gradient.extend.1) << 2_u8),
        );
        for value in gradient.coords {
            self.f32(value);
        }
        if let Some(inner) = matrix {
            self.matrix(inner);
        }
        self.u32(u32::try_from(gradient.stops.len()).unwrap_or(0));
        for (offset, rgba) in gradient.stops {
            self.f32(*offset);
            self.ops.extend_from_slice(rgba);
        }
    }

    pub(crate) fn image(&mut self, image: &ImageRef, alpha: u8) {
        self.ops.push(OP_IMAGE);
        self.ops.push(
            u8::from(image.jpeg)
                | (u8::from(image.mask_jpeg) << 1_u8)
                | (u8::from(image.matte.is_some()) << 2_u8)
                | (u8::from(image.interpolate) << 3_u8),
        );
        self.ops.push(alpha);
        for value in [
            image.blob,
            image.width,
            image.height,
            image.mask,
            image.mask_width,
            image.mask_height,
        ] {
            self.u32(value);
        }
        let [red, green, blue] = image.matte.unwrap_or_default();
        self.ops.extend_from_slice(&[red, green, blue, 0]);
    }

    pub(crate) fn matrix(&mut self, matrix: &Matrix) {
        for value in matrix {
            self.f32(*value);
        }
    }

    pub(crate) fn op(&mut self, code: u8) {
        self.ops.push(code);
    }

    pub(crate) fn op_f32(&mut self, code: u8, value: f64) {
        self.ops.push(code);
        self.f32(value);
    }

    pub(crate) fn op_u8(&mut self, code: u8, value: u8) {
        self.ops.push(code);
        self.ops.push(value);
    }

    pub(crate) fn path(&mut self, path: &PathData) {
        self.ops.push(OP_PATH);
        self.path_payload(path);
    }

    fn path_payload(&mut self, path: &PathData) {
        self.u32(u32::try_from(path.verbs.len()).unwrap_or(0));
        self.ops.extend_from_slice(&path.verbs);
        self.u32(u32::try_from(path.coords.len()).unwrap_or(0));
        self.ops.reserve(path.coords.len().saturating_mul(4));
        for value in &path.coords {
            self.ops.extend_from_slice(&value.to_le_bytes());
        }
    }

    pub(crate) fn text(&mut self, flags: u8, matrix: &Matrix, width: f64, text: &str) {
        self.ops.push(OP_TEXT);
        self.ops.push(flags);
        self.matrix(matrix);
        self.f32(width);
        self.u32(u32::try_from(text.len()).unwrap_or(0));
        self.ops.extend_from_slice(text.as_bytes());
    }

    pub(crate) fn transform(&mut self, matrix: &Matrix) {
        self.ops.push(OP_TRANSFORM);
        self.matrix(matrix);
    }

    pub(crate) fn u32(&mut self, value: u32) {
        self.ops.extend_from_slice(&value.to_le_bytes());
    }
}

pub(crate) fn multiply(first: &Matrix, second: &Matrix) -> Matrix {
    let [a1, b1, c1, d1, e1, f1] = *first;
    let [a2, b2, c2, d2, e2, f2] = *second;
    [
        a1 * a2 + b1 * c2,
        a1 * b2 + b1 * d2,
        c1 * a2 + d1 * c2,
        c1 * b2 + d1 * d2,
        e1 * a2 + f1 * c2 + e2,
        e1 * b2 + f1 * d2 + f2,
    ]
}
