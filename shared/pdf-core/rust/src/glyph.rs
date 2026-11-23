use crate::display::{Matrix, PathData, multiply};
use crate::font_tables::{BuiltinEncoding, encoding_glyph_name};
use crate::num::{f64_to_f32, f64_to_usize, parse_decimal, read_u16, widen};
use core::str;

const MAX_COMPONENT_DEPTH: usize = 8;
const MAX_POINTS: usize = 1 << 16;
const MAX_COMPONENTS: usize = 64;
const MAX_GLYPH_PARTS: usize = 512;
const IDENTITY: Matrix = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
const EEXEC_KEY: u16 = 55665;
const CHARSTRING_KEY: u16 = 4330;
const MAX_TYPE1_GLYPHS: usize = 0xFFFF;
const MAX_TYPE1_DEPTH: usize = 10;
const MAX_TYPE1_STEPS: usize = 50_000;
const MAX_TYPE1_STACK: usize = 48;

#[derive(Clone, Copy)]
struct Point {
    on: bool,
    x: f64,
    y: f64,
}

struct Outline<'run> {
    budget: usize,
    data: &'run [u8],
    locate: &'run dyn Fn(u16) -> Option<(usize, usize)>,
    parts: usize,
    path: &'run mut PathData,
    work: &'run mut usize,
}

impl Outline<'_> {
    fn contour(&mut self, points: &[Point], matrix: &Matrix) {
        let Some(first_on) = points.iter().position(|point| point.on) else {
            let (Some(first), Some(second)) = (points.first(), points.get(1)) else {
                return;
            };
            let start = Point {
                on: true,
                x: f64::midpoint(first.x, second.x),
                y: f64::midpoint(first.y, second.y),
            };
            let rotated: Vec<Point> = points
                .get(1..)
                .unwrap_or_default()
                .iter()
                .copied()
                .chain(points.first().copied())
                .collect();
            self.emit(start, &rotated, matrix);
            return;
        };
        let start = points.get(first_on).copied().unwrap_or(Point {
            on: true,
            x: 0.0,
            y: 0.0,
        });
        let rotated: Vec<Point> = points
            .get(first_on.saturating_add(1)..)
            .unwrap_or_default()
            .iter()
            .chain(points.get(..=first_on).unwrap_or_default())
            .copied()
            .collect();
        self.emit(start, &rotated, matrix);
    }

    fn emit(&mut self, start: Point, rest: &[Point], matrix: &Matrix) {
        let (sx, sy) = transform(matrix, start.x, start.y);
        self.path.move_to(sx, sy);
        let mut control: Option<Point> = None;
        for point in rest {
            match (control, point.on) {
                (None, true) => {
                    let (x, y) = transform(matrix, point.x, point.y);
                    self.path.line(x, y);
                }
                (None, false) => control = Some(*point),
                (Some(previous), true) => {
                    self.quad(previous, *point, matrix);
                    control = None;
                }
                (Some(previous), false) => {
                    let middle = Point {
                        on: true,
                        x: f64::midpoint(previous.x, point.x),
                        y: f64::midpoint(previous.y, point.y),
                    };
                    self.quad(previous, middle, matrix);
                    control = Some(*point);
                }
            }
        }
        if let Some(previous) = control {
            self.quad(previous, start, matrix);
        }
        self.path.close();
    }

    fn glyph(&mut self, gid: u16, matrix: &Matrix, depth: usize) -> Option<()> {
        if depth > MAX_COMPONENT_DEPTH {
            return None;
        }
        self.parts = self.parts.checked_sub(1)?;
        charge(self.work, 1)?;
        let Some((start, end)) = (self.locate)(gid) else {
            return Some(());
        };
        let data = self.data.get(start..end)?;
        let contours = read_i16(data, 0)?;
        if contours >= 0 {
            return self.simple(data, usize::try_from(contours).ok()?, matrix);
        }
        let mut position = 10_usize;
        for _ in 0..MAX_COMPONENTS {
            let flags = read_u16(data, position)?;
            let component = read_u16(data, position.checked_add(2)?)?;
            position = position.checked_add(4)?;
            let (dx, dy) = if flags & 0x0001 != 0 {
                let pair = (
                    f64::from(read_i16(data, position)?),
                    f64::from(read_i16(data, position.checked_add(2)?)?),
                );
                position = position.checked_add(4)?;
                pair
            } else {
                let pair = (
                    f64::from(data.get(position)?.cast_signed()),
                    f64::from(data.get(position.checked_add(1)?)?.cast_signed()),
                );
                position = position.checked_add(2)?;
                pair
            };
            let (offset_x, offset_y) = if flags & 0x0002 != 0 {
                (dx, dy)
            } else {
                (0.0_f64, 0.0_f64)
            };
            let mut local = [1.0_f64, 0.0_f64, 0.0_f64, 1.0_f64, offset_x, offset_y];
            if flags & 0x0008 != 0 {
                let scale = f2dot14(data, position)?;
                local[0] = scale;
                local[3] = scale;
                position = position.checked_add(2)?;
            } else if flags & 0x0040 != 0 {
                local[0] = f2dot14(data, position)?;
                local[3] = f2dot14(data, position.checked_add(2)?)?;
                position = position.checked_add(4)?;
            } else if flags & 0x0080 != 0 {
                local[0] = f2dot14(data, position)?;
                local[1] = f2dot14(data, position.checked_add(2)?)?;
                local[2] = f2dot14(data, position.checked_add(4)?)?;
                local[3] = f2dot14(data, position.checked_add(6)?)?;
                position = position.checked_add(8)?;
            }
            self.glyph(
                component,
                &multiply(&local, matrix),
                depth.saturating_add(1),
            )?;
            if flags & 0x0020 == 0 {
                break;
            }
        }
        Some(())
    }

    fn quad(&mut self, control: Point, end: Point, matrix: &Matrix) {
        let (cx, cy) = transform(matrix, control.x, control.y);
        let (ex, ey) = transform(matrix, end.x, end.y);
        self.path.quad([cx, cy, ex, ey]);
    }

    fn simple(&mut self, data: &[u8], contours: usize, matrix: &Matrix) -> Option<()> {
        if contours == 0 {
            return Some(());
        }
        let mut ends = Vec::with_capacity(contours);
        for index in 0..contours {
            ends.push(usize::from(read_u16(
                data,
                10_usize.checked_add(index.checked_mul(2)?)?,
            )?));
        }
        let count = ends.last()?.checked_add(1)?;
        self.budget = self.budget.checked_sub(count)?;
        charge(self.work, count)?;
        let instructions_at = 10_usize.checked_add(contours.checked_mul(2)?)?;
        let instructions = usize::from(read_u16(data, instructions_at)?);
        let mut position = instructions_at.checked_add(2)?.checked_add(instructions)?;
        let mut flags = Vec::with_capacity(count);
        while flags.len() < count {
            let flag = *data.get(position)?;
            position = position.checked_add(1)?;
            flags.push(flag);
            if flag & 0x08 != 0 {
                let repeat = *data.get(position)?;
                position = position.checked_add(1)?;
                for _ in 0..repeat {
                    if flags.len() >= count {
                        break;
                    }
                    flags.push(flag);
                }
            }
        }
        let xs = read_coordinates(data, &mut position, &flags, 0x02, 0x10)?;
        let ys = read_coordinates(data, &mut position, &flags, 0x04, 0x20)?;
        let points: Vec<Point> = flags
            .iter()
            .zip(xs.iter().zip(&ys))
            .map(|(flag, (x, y))| Point {
                on: flag & 0x01 != 0,
                x: *x,
                y: *y,
            })
            .collect();
        let mut start = 0_usize;
        for end in ends {
            if let Some(contour) = points.get(start..=end)
                && contour.len() > 1
            {
                self.contour(contour, matrix);
            }
            start = end.saturating_add(1);
        }
        Some(())
    }
}

#[derive(Debug, Default)]
pub(crate) struct Type1Glyphs {
    charstrings: Vec<(Vec<u8>, Vec<u8>)>,
    matrix: Option<Matrix>,
    subrs: Vec<Vec<u8>>,
}

struct Type1Machine<'run> {
    flex: Option<Vec<(f64, f64)>>,
    glyphs: &'run Type1Glyphs,
    open: bool,
    other: Vec<f64>,
    path: &'run mut PathData,
    sbx: f64,
    stack: Vec<f64>,
    steps: usize,
    x: f64,
    y: f64,
}

impl Type1Glyphs {
    pub(crate) fn gid(&self, name: &[u8]) -> Option<u16> {
        let position = self
            .charstrings
            .iter()
            .position(|(entry, _)| entry.as_slice() == name)?;
        u16::try_from(position).ok()
    }

    pub(crate) const fn matrix(&self) -> Option<Matrix> {
        self.matrix
    }

    pub(crate) fn outline(&self, gid: u16, path: &mut PathData, work: &mut usize) -> Option<()> {
        let (_, code) = self.charstrings.get(usize::from(gid))?;
        let mut machine = Type1Machine {
            flex: None,
            glyphs: self,
            open: false,
            other: Vec::new(),
            path,
            sbx: 0.0,
            stack: Vec::with_capacity(MAX_TYPE1_STACK),
            steps: 0,
            x: 0.0,
            y: 0.0,
        };
        let outcome = machine.run(code, 0);
        charge(work, machine.steps)?;
        let _: bool = outcome?;
        machine.close();
        Some(())
    }
}

impl Type1Machine<'_> {
    fn close(&mut self) {
        if self.open {
            self.path.close();
            self.open = false;
        }
    }

    fn curve(&mut self, deltas: [f64; 6]) {
        let x1 = self.x + deltas[0];
        let y1 = self.y + deltas[1];
        let x2 = x1 + deltas[2];
        let y2 = y1 + deltas[3];
        self.x = x2 + deltas[4];
        self.y = y2 + deltas[5];
        self.path.cubic([x1, y1, x2, y2, self.x, self.y]);
        self.open = true;
    }

    fn escape(&mut self, code: u8, depth: usize) -> Option<bool> {
        let arg = |index: usize| self.stack.get(index).copied().unwrap_or(0.0_f64);
        match code {
            6 => {
                let (asb, adx, ady, base, accent) = (arg(0), arg(1), arg(2), arg(3), arg(4));
                self.stack.clear();
                self.seac(asb, adx, ady, base, accent, depth)?;
                return Some(true);
            }
            7 => {
                self.sbx = arg(0);
                self.x = arg(0);
                self.y = arg(1);
            }
            12 => {
                let divisor = self.stack.pop().unwrap_or(1.0_f64);
                let dividend = self.stack.pop().unwrap_or(0.0_f64);
                self.stack.push(if divisor == 0.0_f64 {
                    0.0_f64
                } else {
                    dividend / divisor
                });
                return Some(false);
            }
            16 => {
                let number = self.stack.pop().unwrap_or(0.0_f64);
                let count = f64_to_usize(self.stack.pop().unwrap_or(0.0_f64)).min(self.stack.len());
                let start = self.stack.len().saturating_sub(count);
                let mut arguments: Vec<f64> = self.stack.drain(start..).collect();
                self.othersubr(number, &mut arguments);
                return Some(false);
            }
            17 => {
                if let Some(value) = self.other.pop()
                    && self.stack.len() < MAX_TYPE1_STACK
                {
                    self.stack.push(value);
                }
                return Some(false);
            }
            33 => {
                self.x = arg(0);
                self.y = arg(1);
            }
            _ => {}
        }
        self.stack.clear();
        Some(false)
    }

    fn line(&mut self, dx: f64, dy: f64) {
        self.x += dx;
        self.y += dy;
        self.path.line(self.x, self.y);
        self.open = true;
    }

    fn move_by(&mut self, dx: f64, dy: f64) {
        if let Some(points) = self.flex.as_mut() {
            self.x += dx;
            self.y += dy;
            points.push((self.x, self.y));
            return;
        }
        self.close();
        self.x += dx;
        self.y += dy;
        self.path.move_to(self.x, self.y);
    }

    fn operator(&mut self, code: u8) {
        let arg = |index: usize| self.stack.get(index).copied().unwrap_or(0.0_f64);
        match code {
            4 => self.move_by(0.0, arg(0)),
            5 => self.line(arg(0), arg(1)),
            6 => self.line(arg(0), 0.0),
            7 => self.line(0.0, arg(0)),
            8 => self.curve([arg(0), arg(1), arg(2), arg(3), arg(4), arg(5)]),
            9 => self.close(),
            13 => {
                self.sbx = arg(0);
                self.x = arg(0);
                self.y = 0.0_f64;
            }
            21 => self.move_by(arg(0), arg(1)),
            22 => self.move_by(arg(0), 0.0),
            30 => self.curve([0.0_f64, arg(0), arg(1), arg(2), arg(3), 0.0_f64]),
            31 => self.curve([arg(0), 0.0_f64, arg(1), arg(2), 0.0_f64, arg(3)]),
            _ => {}
        }
        self.stack.clear();
    }

    fn othersubr(&mut self, number: f64, arguments: &mut Vec<f64>) {
        match f64_to_usize(number) {
            0 => {
                let points = self.flex.take().unwrap_or_default();
                if let [_, first, second, middle, third, fourth, end] = points.as_slice() {
                    self.path
                        .cubic([first.0, first.1, second.0, second.1, middle.0, middle.1]);
                    self.path
                        .cubic([third.0, third.1, fourth.0, fourth.1, end.0, end.1]);
                    self.open = true;
                    self.x = end.0;
                    self.y = end.1;
                }
                self.other.clear();
                self.other.extend([self.y, self.x]);
            }
            1 => {
                self.flex = Some(Vec::with_capacity(7));
                self.other.clear();
            }
            2 => self.other.clear(),
            _ => {
                arguments.reverse();
                self.other.clear();
                self.other.append(arguments);
            }
        }
    }

    fn run(&mut self, code: &[u8], depth: usize) -> Option<bool> {
        if depth > MAX_TYPE1_DEPTH {
            return None;
        }
        let mut position = 0_usize;
        while let Some(&byte) = code.get(position) {
            position = position.saturating_add(1);
            self.steps = self.steps.saturating_add(1);
            if self.steps > MAX_TYPE1_STEPS {
                return None;
            }
            let value = match byte {
                32..=246 => Some(f64::from(i32::from(byte).saturating_sub(139))),
                247..=254 => {
                    let next = i32::from(*code.get(position)?);
                    position = position.saturating_add(1);
                    let magnitude = i32::from(byte)
                        .saturating_sub(if byte < 251 { 247 } else { 251 })
                        .saturating_mul(256)
                        .saturating_add(next)
                        .saturating_add(108);
                    Some(f64::from(if byte < 251 {
                        magnitude
                    } else {
                        magnitude.saturating_neg()
                    }))
                }
                255 => {
                    let bytes = code.get(position..position.checked_add(4)?)?;
                    position = position.saturating_add(4);
                    Some(f64::from(i32::from_be_bytes(bytes.try_into().ok()?)))
                }
                _ => None,
            };
            if let Some(number) = value {
                if self.stack.len() < MAX_TYPE1_STACK {
                    self.stack.push(number);
                }
                continue;
            }
            match byte {
                10 => {
                    let index = f64_to_usize(self.stack.pop()?);
                    let subr = self.glyphs.subrs.get(index)?;
                    if self.run(subr, depth.saturating_add(1))? {
                        return Some(true);
                    }
                }
                11 => return Some(false),
                12 => {
                    let escape = *code.get(position)?;
                    position = position.saturating_add(1);
                    if self.escape(escape, depth)? {
                        return Some(true);
                    }
                }
                14 => {
                    self.close();
                    return Some(true);
                }
                _ => self.operator(byte),
            }
        }
        Some(false)
    }

    fn seac(
        &mut self,
        asb: f64,
        adx: f64,
        ady: f64,
        base: f64,
        accent: f64,
        depth: usize,
    ) -> Option<()> {
        let standard = |code: f64| {
            let name = encoding_glyph_name(
                BuiltinEncoding::Standard,
                u8::try_from(f64_to_usize(code)).ok()?,
            );
            self.glyphs.gid(name.as_bytes())
        };
        let base_gid = standard(base)?;
        let accent_gid = standard(accent)?;
        let base_sbx = self.sbx;
        let (_, base_code) = self.glyphs.charstrings.get(usize::from(base_gid))?;
        self.close();
        let _: bool = self.run(base_code, depth.saturating_add(1))?;
        self.close();
        let start = self.path.coords.len();
        let (_, accent_code) = self.glyphs.charstrings.get(usize::from(accent_gid))?;
        let _: bool = self.run(accent_code, depth.saturating_add(1))?;
        self.close();
        let offsets = [base_sbx + adx - asb, ady];
        for (index, value) in self
            .path
            .coords
            .get_mut(start..)
            .unwrap_or_default()
            .iter_mut()
            .enumerate()
        {
            *value += f64_to_f32(offsets.get(index & 1).copied().unwrap_or(0.0_f64));
        }
        Some(())
    }
}

pub(crate) const fn charge(work: &mut usize, amount: usize) -> Option<()> {
    let Some(left) = work.checked_sub(amount) else {
        *work = 0;
        return None;
    };
    *work = left;
    Some(())
}

fn read_i16(data: &[u8], at: usize) -> Option<i16> {
    read_u16(data, at).map(u16::cast_signed)
}

fn f2dot14(data: &[u8], at: usize) -> Option<f64> {
    read_i16(data, at).map(|value| f64::from(value) / 16_384.0_f64)
}

fn transform(matrix: &Matrix, x: f64, y: f64) -> (f64, f64) {
    (
        x * matrix[0] + y * matrix[2] + matrix[4],
        x * matrix[1] + y * matrix[3] + matrix[5],
    )
}

fn read_coordinates(
    data: &[u8],
    position: &mut usize,
    flags: &[u8],
    short: u8,
    same: u8,
) -> Option<Vec<f64>> {
    let mut values = Vec::with_capacity(flags.len());
    let mut current = 0_i32;
    for flag in flags {
        if flag & short != 0 {
            let delta = i32::from(*data.get(*position)?);
            *position = position.checked_add(1)?;
            current = if flag & same != 0 {
                current.saturating_add(delta)
            } else {
                current.saturating_sub(delta)
            };
        } else if flag & same == 0 {
            current = current.saturating_add(i32::from(read_i16(data, *position)?));
            *position = position.checked_add(2)?;
        }
        values.push(f64::from(current));
    }
    Some(values)
}

pub(crate) fn truetype_outline(
    data: &[u8],
    locate: &dyn Fn(u16) -> Option<(usize, usize)>,
    gid: u16,
    path: &mut PathData,
    work: &mut usize,
) -> Option<()> {
    let mut outline = Outline {
        budget: MAX_POINTS,
        data,
        locate,
        parts: MAX_GLYPH_PARTS,
        path,
        work,
    };
    outline.glyph(gid, &IDENTITY, 0)
}

fn decrypt(data: &[u8], key: u16, skip: usize) -> Vec<u8> {
    let mut state = key;
    let mut out = Vec::with_capacity(data.len());
    for &cipher in data {
        let plain = cipher ^ u8::try_from(state >> 8_u32).unwrap_or(0);
        state = u16::from(cipher)
            .wrapping_add(state)
            .wrapping_mul(52845)
            .wrapping_add(22719);
        out.push(plain);
    }
    out.split_off(skip.min(out.len()))
}

fn strip_pfb(bytes: &[u8]) -> Vec<u8> {
    if bytes.first() != Some(&0x80) {
        return bytes.to_vec();
    }
    let mut out = Vec::with_capacity(bytes.len());
    let mut position = 0_usize;
    while bytes.get(position) == Some(&0x80) {
        let kind = bytes.get(position.saturating_add(1)).copied().unwrap_or(3);
        if kind == 3 {
            break;
        }
        let length = bytes
            .get(position.saturating_add(2)..position.saturating_add(6))
            .and_then(|slice| <[u8; 4]>::try_from(slice).ok())
            .map_or(0, |raw| widen(u32::from_le_bytes(raw)));
        let start = position.saturating_add(6);
        let end = start.saturating_add(length).min(bytes.len());
        out.extend_from_slice(bytes.get(start..end).unwrap_or_default());
        position = end;
    }
    out
}

fn type1_token(data: &[u8], position: &mut usize) -> Option<(usize, usize)> {
    while data.get(*position).is_some_and(u8::is_ascii_whitespace) {
        *position = position.saturating_add(1);
    }
    let start = *position;
    while data.get(*position).is_some_and(|byte| {
        !byte.is_ascii_whitespace() && !matches!(byte, b'[' | b']' | b'{' | b'}')
    }) {
        *position = position.saturating_add(1);
    }
    if *position == start {
        *position = position.saturating_add(1);
    }
    (start < data.len()).then_some((start, *position))
}

fn type1_binary(
    data: &[u8],
    position: &mut usize,
    length: usize,
    len_iv: usize,
) -> Option<Vec<u8>> {
    let (start, end) = type1_token(data, position)?;
    if !matches!(data.get(start..end)?, b"RD" | b"-|") {
        return None;
    }
    let begin = end.checked_add(1)?;
    let finish = begin.checked_add(length)?;
    *position = finish;
    Some(decrypt(data.get(begin..finish)?, CHARSTRING_KEY, len_iv))
}

fn type1_int(data: &[u8], position: &mut usize) -> Option<usize> {
    let (start, end) = type1_token(data, position)?;
    str::from_utf8(data.get(start..end)?).ok()?.parse().ok()
}

fn type1_matrix(clear: &[u8]) -> Option<Matrix> {
    let at = find(clear, b"/FontMatrix")?;
    let open = at.checked_add(clear.get(at..)?.iter().position(|byte| *byte == b'[')?)?;
    let close = open.checked_add(clear.get(open..)?.iter().position(|byte| *byte == b']')?)?;
    let values: Vec<f64> = clear
        .get(open.saturating_add(1)..close)?
        .split(u8::is_ascii_whitespace)
        .filter(|token| !token.is_empty())
        .filter_map(parse_decimal)
        .collect();
    let matrix: Matrix = values.get(..6)?.try_into().ok()?;
    matrix
        .iter()
        .all(|value| value.is_finite())
        .then_some(matrix)
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

pub(crate) fn parse_type1(raw: &[u8]) -> Option<Type1Glyphs> {
    let bytes = strip_pfb(raw);
    let marker = find(&bytes, b"eexec")?;
    let clear = bytes.get(..marker)?;
    let mut start = marker.checked_add(5)?;
    while bytes.get(start).is_some_and(u8::is_ascii_whitespace) {
        start = start.saturating_add(1);
    }
    let encrypted = bytes.get(start..)?;
    let hex = encrypted
        .get(..4)
        .is_some_and(|head| head.iter().all(u8::is_ascii_hexdigit));
    let cipher = if hex {
        let digits: Vec<u8> = encrypted
            .iter()
            .copied()
            .filter(u8::is_ascii_hexdigit)
            .collect();
        digits
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| {
                let high = char::from(pair[0]).to_digit(16).unwrap_or(0);
                let low = char::from(pair[1]).to_digit(16).unwrap_or(0);
                u8::try_from((high << 4_u32) | low).unwrap_or(0)
            })
            .collect()
    } else {
        encrypted.to_vec()
    };
    let private = decrypt(&cipher, EEXEC_KEY, 4);
    let len_iv = find(&private, b"/lenIV")
        .and_then(|at| {
            let mut position = at.saturating_add(6);
            type1_int(&private, &mut position)
        })
        .unwrap_or(4);
    let mut glyphs = Type1Glyphs {
        matrix: type1_matrix(clear),
        ..Type1Glyphs::default()
    };
    if let Some(at) = find(&private, b"/Subrs") {
        let mut position = at.saturating_add(6);
        let count = type1_int(&private, &mut position)
            .unwrap_or(0)
            .min(MAX_TYPE1_GLYPHS);
        glyphs.subrs = vec![Vec::new(); count];
        let mut parsed = 0_usize;
        let mut tokens = 0_usize;
        while parsed < count && tokens < count.saturating_mul(8).saturating_add(16) {
            tokens = tokens.saturating_add(1);
            let Some((start_token, end_token)) = type1_token(&private, &mut position) else {
                break;
            };
            let token = private.get(start_token..end_token).unwrap_or_default();
            if token == b"/CharStrings" {
                break;
            }
            if token != b"dup" {
                continue;
            }
            let (Some(index), Some(length)) = (
                type1_int(&private, &mut position),
                type1_int(&private, &mut position),
            ) else {
                break;
            };
            let Some(data) = type1_binary(&private, &mut position, length, len_iv) else {
                break;
            };
            if let Some(slot) = glyphs.subrs.get_mut(index) {
                *slot = data;
            }
            parsed = parsed.saturating_add(1);
        }
    }
    let at = find(&private, b"/CharStrings")?;
    let mut position = at.saturating_add(12);
    while glyphs.charstrings.len() < MAX_TYPE1_GLYPHS {
        let Some((start_token, end_token)) = type1_token(&private, &mut position) else {
            break;
        };
        let token = private.get(start_token..end_token).unwrap_or_default();
        if token == b"end" {
            break;
        }
        let Some(name) = token.strip_prefix(b"/") else {
            continue;
        };
        let name_owned = name.to_vec();
        let Some(length) = type1_int(&private, &mut position) else {
            break;
        };
        let Some(data) = type1_binary(&private, &mut position, length, len_iv) else {
            break;
        };
        glyphs.charstrings.push((name_owned, data));
        let _: Option<(usize, usize)> = type1_token(&private, &mut position);
    }
    (!glyphs.charstrings.is_empty()).then_some(glyphs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::display::{VERB_CLOSE, VERB_LINE, VERB_MOVE, VERB_QUAD};

    const fn unlimited() -> usize {
        usize::MAX
    }

    fn pack(glyphs: &[Vec<u8>]) -> (Vec<u8>, Vec<(usize, usize)>) {
        let mut data = Vec::new();
        let mut ranges = Vec::new();
        for glyph in glyphs {
            ranges.push((data.len(), data.len().saturating_add(glyph.len())));
            data.extend_from_slice(glyph);
        }
        (data, ranges)
    }

    fn simple_glyph(points: &[(i16, i16, bool)], ends: &[u16]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&i16::try_from(ends.len()).unwrap().to_be_bytes());
        out.extend_from_slice(&[0; 8]);
        for end in ends {
            out.extend_from_slice(&end.to_be_bytes());
        }
        out.extend_from_slice(&0_u16.to_be_bytes());
        for (_, _, on) in points {
            out.push(u8::from(*on));
        }
        let mut previous = 0_i16;
        for (x, _, _) in points {
            out.extend_from_slice(&x.wrapping_sub(previous).to_be_bytes());
            previous = *x;
        }
        previous = 0;
        for (_, y, _) in points {
            out.extend_from_slice(&y.wrapping_sub(previous).to_be_bytes());
            previous = *y;
        }
        out
    }

    #[test]
    fn simple_glyph_emits_lines_and_implied_quads() {
        let square = simple_glyph(
            &[
                (0, 0, true),
                (100, 0, true),
                (100, 100, false),
                (0, 100, false),
            ],
            &[3],
        );
        let (data, ranges) = pack(&[square]);
        let locate = |gid: u16| ranges.get(usize::from(gid)).copied();
        let mut path = PathData::default();
        truetype_outline(&data, &locate, 0, &mut path, &mut unlimited()).unwrap();
        assert_eq!(
            path.verbs,
            vec![VERB_MOVE, VERB_LINE, VERB_QUAD, VERB_QUAD, VERB_CLOSE]
        );
        assert_eq!(&path.coords[4..8], &[100.0, 100.0, 50.0, 100.0]);
    }

    #[test]
    fn composite_glyphs_apply_offsets_and_scales_with_bounded_recursion() {
        let base = simple_glyph(&[(0, 0, true), (10, 0, true), (10, 10, true)], &[2]);
        let mut composite = vec![0xFF, 0xFF, 0, 0, 0, 0, 0, 0, 0, 0];
        composite.extend_from_slice(&(0x0001_u16 | 0x0002 | 0x0008).to_be_bytes());
        composite.extend_from_slice(&0_u16.to_be_bytes());
        composite.extend_from_slice(&50_i16.to_be_bytes());
        composite.extend_from_slice(&7_i16.to_be_bytes());
        composite.extend_from_slice(&0x4000_i16.to_be_bytes());
        let mut looping = vec![0xFF, 0xFF, 0, 0, 0, 0, 0, 0, 0, 0];
        looping.extend_from_slice(&0x0002_u16.to_be_bytes());
        looping.extend_from_slice(&2_u16.to_be_bytes());
        looping.extend_from_slice(&[0, 0]);
        let (data, ranges) = pack(&[base, composite, looping]);
        let locate = |gid: u16| ranges.get(usize::from(gid)).copied();
        let mut path = PathData::default();
        truetype_outline(&data, &locate, 1, &mut path, &mut unlimited()).unwrap();
        assert_eq!(&path.coords[..2], &[50.0, 7.0]);
        let mut cyclic = PathData::default();
        assert!(truetype_outline(&data, &locate, 2, &mut cyclic, &mut unlimited()).is_none());
        let mut truncated = PathData::default();
        let (short, short_ranges) = pack(&[vec![0, 1, 0]]);
        let locate_short = |gid: u16| short_ranges.get(usize::from(gid)).copied();
        assert!(
            truetype_outline(&short, &locate_short, 0, &mut truncated, &mut unlimited()).is_none()
        );
    }

    fn fan_out(child: u16) -> Vec<u8> {
        let mut glyph = vec![0xFF, 0xFF, 0, 0, 0, 0, 0, 0, 0, 0];
        for index in 0..MAX_COMPONENTS {
            let more = if index.saturating_add(1) < MAX_COMPONENTS {
                0x0020_u16
            } else {
                0
            };
            glyph.extend_from_slice(&(0x0002_u16 | more).to_be_bytes());
            glyph.extend_from_slice(&child.to_be_bytes());
            glyph.extend_from_slice(&[0, 0]);
        }
        glyph
    }

    #[test]
    fn composite_fan_out_is_bounded_per_glyph_and_per_page() {
        let mut glyphs: Vec<Vec<u8>> = (1..=8_u16).map(fan_out).collect();
        glyphs.push(Vec::new());
        let (data, ranges) = pack(&glyphs);
        let locate = |gid: u16| {
            let (start, end) = ranges.get(usize::from(gid)).copied()?;
            (end > start).then_some((start, end))
        };
        let mut work = usize::MAX;
        let mut path = PathData::default();
        assert!(truetype_outline(&data, &locate, 0, &mut path, &mut work).is_none());
        assert!(usize::MAX.saturating_sub(work) <= MAX_GLYPH_PARTS);
        let base = simple_glyph(&[(0, 0, true), (10, 0, true), (10, 10, true)], &[2]);
        let (single, single_ranges) = pack(&[base]);
        let locate_single = |gid: u16| single_ranges.get(usize::from(gid)).copied();
        let mut page = 7_usize;
        let mut first = PathData::default();
        truetype_outline(&single, &locate_single, 0, &mut first, &mut page).unwrap();
        assert_eq!(page, 3);
        let mut second = PathData::default();
        assert!(truetype_outline(&single, &locate_single, 0, &mut second, &mut page).is_none());
    }

    fn encrypt(plain: &[u8], key: u16) -> Vec<u8> {
        let mut state = key;
        plain
            .iter()
            .map(|byte| {
                let cipher = byte ^ u8::try_from(state >> 8_u32).unwrap();
                state = u16::from(cipher)
                    .wrapping_add(state)
                    .wrapping_mul(52845)
                    .wrapping_add(22719);
                cipher
            })
            .collect()
    }

    fn type1_font(hex: bool) -> Vec<u8> {
        let charstring = |body: &[u8]| {
            let mut plain = vec![1_u8, 2, 3, 4];
            plain.extend_from_slice(body);
            encrypt(&plain, CHARSTRING_KEY)
        };
        let subr = charstring(&[247, 192, 6, 11]);
        let square = charstring(&[
            139, 247, 144, 13, 239, 239, 21, 139, 10, 247, 192, 7, 251, 192, 6, 9, 14,
        ]);
        let notdef = charstring(&[139, 247, 144, 13, 14]);
        let mut private = b"dup /Private 8 dict dup begin /lenIV 4 def /Subrs 1 array\n".to_vec();
        private.extend_from_slice(format!("dup 0 {} RD ", subr.len()).as_bytes());
        private.extend_from_slice(&subr);
        private.extend_from_slice(b" NP\nND\n/CharStrings 2 dict dup begin\n");
        private.extend_from_slice(format!("/square {} -| ", square.len()).as_bytes());
        private.extend_from_slice(&square);
        private.extend_from_slice(b" |-\n");
        private.extend_from_slice(format!("/.notdef {} RD ", notdef.len()).as_bytes());
        private.extend_from_slice(&notdef);
        private.extend_from_slice(b" ND\nend end\n");
        let mut plain = vec![9_u8, 8, 7, 6];
        plain.extend_from_slice(&private);
        let cipher = encrypt(&plain, EEXEC_KEY);
        let mut font = b"%!PS-AdobeFont-1.0: Test\n/FontMatrix [0.002 0 0 0.002 0 0] readonly def\ncurrentfile eexec\r\n".to_vec();
        if hex {
            for byte in cipher {
                font.extend_from_slice(format!("{byte:02x}").as_bytes());
            }
        } else {
            font.extend_from_slice(&cipher);
        }
        font
    }

    #[test]
    fn type1_charstrings_decrypt_call_subrs_and_draw() {
        for hex in [false, true] {
            let glyphs = parse_type1(&type1_font(hex)).unwrap();
            assert_eq!(
                glyphs.matrix(),
                Some([0.002_f64, 0.0_f64, 0.0_f64, 0.002_f64, 0.0_f64, 0.0_f64])
            );
            let gid = glyphs.gid(b"square").unwrap();
            assert!(glyphs.gid(b"missing").is_none());
            let mut path = PathData::default();
            let mut work = usize::MAX;
            glyphs.outline(gid, &mut path, &mut work).unwrap();
            assert!(work < usize::MAX);
            assert_eq!(
                path.verbs,
                vec![VERB_MOVE, VERB_LINE, VERB_LINE, VERB_LINE, VERB_CLOSE],
                "{:?}",
                path.coords
            );
            assert_eq!(
                path.coords,
                vec![100.0, 100.0, 400.0, 100.0, 400.0, 400.0, 100.0, 400.0]
            );
        }
    }

    #[test]
    fn hostile_type1_programs_are_rejected_or_bounded() {
        assert!(parse_type1(b"%!PS no eexec here").is_none());
        let mut truncated = type1_font(false);
        truncated.truncate(truncated.len() >> 1_u32);
        let _parsed = parse_type1(&truncated);
        let looping = Type1Glyphs {
            charstrings: vec![(b"loop".to_vec(), vec![139, 10])],
            matrix: None,
            subrs: vec![vec![139, 10]],
        };
        let mut path = PathData::default();
        let mut work = usize::MAX;
        assert!(looping.outline(0, &mut path, &mut work).is_none());
        assert!(usize::MAX.saturating_sub(work) <= MAX_TYPE1_STEPS.saturating_add(1));
        let mut exhausted = 0_usize;
        assert!(
            looping
                .outline(0, &mut PathData::default(), &mut exhausted)
                .is_none()
        );
    }
}
