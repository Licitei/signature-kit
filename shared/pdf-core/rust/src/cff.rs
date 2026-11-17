use crate::display::PathData;
use crate::font_tables::BuiltinEncoding as FontEncoding;
use crate::font_tables::encoding_glyph_name;
use crate::num::{f64_to_f32, f64_to_i64, parse_decimal};
use core::array;
use core::mem;
include!(concat!(env!("OUT_DIR"), "/cff_tables.rs"));

const MAX_GLYPHS: usize = 0xFFFF;
const MAX_DICT_ENTRIES: usize = 256;
const MAX_OPERANDS: usize = 48;
const MAX_CUSTOM_STRINGS: usize = 0xFFFF;
const ISO_ADOBE_LAST_SID: usize = 228;
const OP_CHARSET: u16 = 15;
const OP_ENCODING: u16 = 16;
const OP_CHARSTRINGS: u16 = 17;
const OP_ROS: u16 = 0x0C1E;
const OP_PRIVATE: u16 = 18;
const OP_SUBRS: u16 = 19;
const OP_FONT_MATRIX: u16 = 0x0C07;
const OP_FD_ARRAY: u16 = 0x0C24;
const OP_FD_SELECT: u16 = 0x0C25;
const MAX_FONT_DICTS: usize = 256;
const MAX_STACK: usize = 48;
const MAX_CALL_DEPTH: usize = 10;
const MAX_STEPS: usize = 50_000;
const MAX_SEAC_DEPTH: usize = 2;
const DEFAULT_MATRIX: [f64; 6] = [0.001, 0.0, 0.0, 0.001, 0.0, 0.0];

#[derive(Clone, Debug, PartialEq, Eq)]
enum BuiltinEncoding {
    Expert,
    Standard,
    Table(Vec<u16>),
}

#[derive(Clone, Debug)]
pub(crate) struct CffFont {
    charset: Vec<u16>,
    charstrings: Index,
    cid_index: Vec<(u16, u16)>,
    cid_keyed: bool,
    custom_strings: Vec<Vec<u8>>,
    encoding: BuiltinEncoding,
    fd_select: Vec<u8>,
    font_matrix: [f64; 6],
    global_subrs: Index,
    glyph_count: usize,
    privates: Vec<PrivateDict>,
}

#[derive(Clone, Copy, Debug)]
struct PrivateDict {
    matrix: Option<[f64; 6]>,
    subrs: Option<Index>,
}

#[derive(Clone, Copy, Debug)]
struct Index {
    count: usize,
    data: usize,
    end: usize,
    off_size: usize,
    offsets: usize,
}

impl Index {
    const fn empty(position: usize) -> Self {
        Self {
            count: 0,
            data: position,
            end: position,
            off_size: 0,
            offsets: position,
        }
    }

    fn get<'data>(&self, bytes: &'data [u8], item: usize) -> Option<&'data [u8]> {
        if item >= self.count {
            return None;
        }
        let first = read_offset(
            bytes,
            self.offsets.checked_add(item.checked_mul(self.off_size)?)?,
            self.off_size,
        )?;
        let next = read_offset(
            bytes,
            self.offsets
                .checked_add(item.checked_add(1)?.checked_mul(self.off_size)?)?,
            self.off_size,
        )?;
        if first == 0 || next < first {
            return None;
        }
        let start = self.data.checked_add(first)?.checked_sub(1)?;
        let stop = self.data.checked_add(next)?.checked_sub(1)?;
        if stop > self.end {
            return None;
        }
        bytes.get(start..stop)
    }

    fn parse(bytes: &[u8], position: usize) -> Option<Self> {
        let count = usize::from(read_u16(bytes, position)?);
        if count == 0 {
            return Some(Self {
                count: 0,
                off_size: 0,
                offsets: position.checked_add(2)?,
                data: position.checked_add(2)?,
                end: position.checked_add(2)?,
            });
        }
        let off_size = usize::from(*bytes.get(position.checked_add(2)?)?);
        if !(1..=4).contains(&off_size) {
            return None;
        }
        let offsets = position.checked_add(3)?;
        let data = offsets.checked_add(count.checked_add(1)?.checked_mul(off_size)?)?;
        let last = read_offset(
            bytes,
            offsets.checked_add(count.checked_mul(off_size)?)?,
            off_size,
        )?;
        let end = data.checked_add(last)?.checked_sub(1)?;
        if end > bytes.len() {
            return None;
        }
        Some(Self {
            count,
            data,
            end,
            off_size,
            offsets,
        })
    }
}

impl CffFont {
    pub(crate) fn builtin_name(&self, code: u8) -> Option<&[u8]> {
        match &self.encoding {
            BuiltinEncoding::Standard => {
                let name = encoding_glyph_name(FontEncoding::Standard, code);
                (!name.is_empty()).then_some(name.as_bytes())
            }
            BuiltinEncoding::Expert => {
                let sid = *CFF_EXPERT_ENCODING.get(usize::from(code))?;
                (sid != 0).then(|| self.sid_name(sid)).flatten()
            }
            BuiltinEncoding::Table(table) => {
                let sid = *table.get(usize::from(code))?;
                (sid != 0).then(|| self.sid_name(sid)).flatten()
            }
        }
    }

    pub(crate) fn cid_for_gid(&self, gid: u16) -> Option<u16> {
        if self.cid_keyed {
            self.charset.get(usize::from(gid)).copied()
        } else {
            (usize::from(gid) < self.glyph_count).then_some(gid)
        }
    }

    pub(crate) fn font_matrix(&self, gid: u16) -> [f64; 6] {
        match self.private_for(gid).and_then(|private| private.matrix) {
            Some(inner) if self.cid_keyed => multiply(&inner, &self.font_matrix),
            Some(_) | None => self.font_matrix,
        }
    }

    pub(crate) fn gid_for_cid(&self, cid: u16) -> Option<u16> {
        if !self.cid_keyed {
            return (usize::from(cid) < self.glyph_count).then_some(cid);
        }
        let position = self
            .cid_index
            .binary_search_by_key(&cid, |(key, _)| *key)
            .ok()?;
        self.cid_index.get(position).map(|(_, gid)| *gid)
    }

    fn gid_for_standard_code(&self, code: f64) -> Option<u16> {
        let byte = u8::try_from(f64_to_i64(code)).ok()?;
        let name = encoding_glyph_name(FontEncoding::Standard, byte);
        if name.is_empty() || self.cid_keyed {
            return None;
        }
        (0..self.glyph_count)
            .filter_map(|gid| u16::try_from(gid).ok())
            .find(|gid| self.glyph_name(*gid) == Some(name.as_bytes()))
    }

    pub(crate) const fn glyph_count(&self) -> usize {
        self.glyph_count
    }

    pub(crate) fn glyph_name(&self, gid: u16) -> Option<&[u8]> {
        if self.cid_keyed {
            return None;
        }
        self.sid_name(*self.charset.get(usize::from(gid))?)
    }

    pub(crate) const fn is_cid_keyed(&self) -> bool {
        self.cid_keyed
    }

    pub(crate) fn outline(&self, bytes: &[u8], gid: u16, path: &mut PathData) -> Option<()> {
        let mut machine = Type2 {
            bytes,
            font: self,
            local: self.private_for(gid).and_then(|private| private.subrs),
            path,
            open: false,
            stack: Vec::with_capacity(MAX_STACK),
            stems: 0,
            steps: 0,
            width_parsed: false,
            x: 0.0,
            y: 0.0,
        };
        machine.glyph(gid, 0)
    }

    pub(crate) fn parse(bytes: &[u8]) -> Option<Self> {
        if *bytes.first()? != 1 {
            return None;
        }
        let header_size = usize::from(*bytes.get(2)?);
        let names = Index::parse(bytes, header_size)?;
        let top_dicts = Index::parse(bytes, names.end)?;
        let strings = Index::parse(bytes, top_dicts.end)?;
        let top = parse_dict(top_dicts.get(bytes, 0)?);
        let offset = |op: u16| dict_offset(&top, op);
        let charstrings_offset = usize::try_from(offset(OP_CHARSTRINGS)?).ok()?;
        let charstrings = Index::parse(bytes, charstrings_offset)?;
        let glyph_count = charstrings.count;
        if glyph_count == 0 || glyph_count > MAX_GLYPHS {
            return None;
        }
        let cid_keyed = top.iter().any(|(key, _)| *key == OP_ROS);
        let charset_offset = offset(OP_CHARSET).unwrap_or(0_i32);
        let charset = read_charset(bytes, charset_offset, glyph_count, cid_keyed)?;
        let mut custom_strings = Vec::new();
        for item in 0..strings.count.min(MAX_CUSTOM_STRINGS) {
            custom_strings.push(strings.get(bytes, item)?.to_vec());
        }
        let encoding = if cid_keyed {
            BuiltinEncoding::Table(Vec::new())
        } else {
            read_encoding(bytes, offset(OP_ENCODING).unwrap_or(0_i32), &charset)?
        };
        let mut cid_index = Vec::new();
        if cid_keyed {
            cid_index = charset
                .iter()
                .enumerate()
                .filter_map(|(gid, cid)| u16::try_from(gid).ok().map(|inner_gid| (*cid, inner_gid)))
                .collect();
            cid_index.sort_by_key(|(cid, _)| *cid);
        }
        let global_subrs =
            Index::parse(bytes, strings.end).unwrap_or_else(|| Index::empty(strings.end));
        let (privates, fd_select) = if cid_keyed {
            read_font_dicts(bytes, &top, glyph_count)
        } else {
            (vec![read_private(bytes, &top)], Vec::new())
        };
        Some(Self {
            charset,
            charstrings,
            cid_index,
            cid_keyed,
            custom_strings,
            encoding,
            fd_select,
            font_matrix: dict_matrix(&top).unwrap_or(DEFAULT_MATRIX),
            global_subrs,
            glyph_count,
            privates,
        })
    }

    fn private_for(&self, gid: u16) -> Option<&PrivateDict> {
        if self.cid_keyed {
            let fd = self.fd_select.get(usize::from(gid)).copied().unwrap_or(0);
            self.privates.get(usize::from(fd))
        } else {
            self.privates.first()
        }
    }

    fn sid_name(&self, sid: u16) -> Option<&[u8]> {
        let sid_usize = usize::from(sid);
        match CFF_STANDARD_STRINGS.get(sid_usize) {
            Some(name) => Some(name.as_bytes()),
            None => self
                .custom_strings
                .get(sid_usize.checked_sub(CFF_STANDARD_STRINGS.len())?)
                .map(Vec::as_slice),
        }
    }
}

struct Type2<'run> {
    bytes: &'run [u8],
    font: &'run CffFont,
    local: Option<Index>,
    open: bool,
    path: &'run mut PathData,
    stack: Vec<f64>,
    stems: usize,
    steps: usize,
    width_parsed: bool,
    x: f64,
    y: f64,
}

impl Type2<'_> {
    fn arg(&self, index: usize) -> f64 {
        self.stack.get(index).copied().unwrap_or(0.0)
    }

    fn call(&mut self, global: bool, depth: usize) -> Option<bool> {
        let index = if global {
            self.font.global_subrs
        } else {
            self.local?
        };
        let raw = f64_to_i64(self.stack.pop()?);
        let biased =
            usize::try_from(raw.checked_add(i64::try_from(subr_bias(index.count)).ok()?)?).ok()?;
        let code = index.get(self.bytes, biased)?;
        self.run(code, depth.saturating_add(1))
    }

    fn close(&mut self) {
        if self.open {
            self.path.close();
            self.open = false;
        }
    }

    fn curve(&mut self, dxa: f64, dya: f64, dxb: f64, dyb: f64, dxc: f64, dyc: f64) {
        let x1 = self.x + dxa;
        let y1 = self.y + dya;
        let x2 = x1 + dxb;
        let y2 = y1 + dyb;
        self.x = x2 + dxc;
        self.y = y2 + dyc;
        self.path.cubic([x1, y1, x2, y2, self.x, self.y]);
        self.open = true;
    }

    fn curve_at(&mut self, index: usize) {
        let [a, b, c, d, e, f] =
            [0, 1, 2, 3, 4, 5].map(|offset| self.arg(index.saturating_add(offset)));
        self.curve(a, b, c, d, e, f);
    }

    fn escape(&mut self, code: u8) {
        let arg = |index: usize| self.stack.get(index).copied().unwrap_or(0.0_f64);
        match code {
            35 => {
                let values: [f64; 12] = array::from_fn(arg);
                self.curve(
                    values[0], values[1], values[2], values[3], values[4], values[5],
                );
                self.curve(
                    values[6], values[7], values[8], values[9], values[10], values[11],
                );
            }
            34 => {
                let values: [f64; 7] = array::from_fn(arg);
                self.curve(values[0], 0.0, values[1], values[2], values[3], 0.0);
                self.curve(values[4], 0.0, values[5], -values[2], values[6], 0.0);
            }
            36 => {
                let values: [f64; 9] = array::from_fn(arg);
                self.curve(values[0], values[1], values[2], values[3], values[4], 0.0);
                self.curve(
                    values[5],
                    0.0,
                    values[6],
                    values[7],
                    values[8],
                    -(values[1] + values[3] + values[7]),
                );
            }
            37 => {
                let values: [f64; 11] = array::from_fn(arg);
                let dx = values[0] + values[2] + values[4] + values[6] + values[8];
                let dy = values[1] + values[3] + values[5] + values[7] + values[9];
                let (dx6, dy6) = if dx.abs() > dy.abs() {
                    (values[10], -dy)
                } else {
                    (-dx, values[10])
                };
                self.curve(
                    values[0], values[1], values[2], values[3], values[4], values[5],
                );
                self.curve(values[6], values[7], values[8], values[9], dx6, dy6);
            }
            9 | 14 | 26 => {
                if let Some(top) = self.stack.last_mut() {
                    *top = match code {
                        9 => top.abs(),
                        14 => -*top,
                        _ => top.max(0.0).sqrt(),
                    };
                }
                return;
            }
            10 | 11 | 12 | 24 => {
                let right = self.stack.pop().unwrap_or(0.0_f64);
                let left = self.stack.pop().unwrap_or(0.0_f64);
                let value = match code {
                    10 => left + right,
                    11 => left - right,
                    12 if right != 0.0_f64 => left / right,
                    24 => left * right,
                    _ => 0.0_f64,
                };
                self.stack.push(value);
                return;
            }
            18 => {
                let _: Option<f64> = self.stack.pop();
                return;
            }
            27 => {
                if let Some(top) = self.stack.last().copied()
                    && self.stack.len() < MAX_STACK
                {
                    self.stack.push(top);
                }
                return;
            }
            28 => {
                let len = self.stack.len();
                if len >= 2 {
                    self.stack
                        .swap(len.saturating_sub(1), len.saturating_sub(2));
                }
                return;
            }
            _ => {}
        }
        self.stack.clear();
    }

    fn glyph(&mut self, gid: u16, seac: usize) -> Option<()> {
        let code = self.font.charstrings.get(self.bytes, usize::from(gid))?;
        let _: bool = self.run_glyph(code, seac)?;
        self.close();
        Some(())
    }

    fn line(&mut self, dx: f64, dy: f64) {
        self.x += dx;
        self.y += dy;
        self.path.line(self.x, self.y);
        self.open = true;
    }

    fn move_by(&mut self, dx: f64, dy: f64) {
        self.close();
        self.x += dx;
        self.y += dy;
        self.path.move_to(self.x, self.y);
        self.open = true;
    }

    fn number(&mut self, code: &[u8], position: &mut usize, byte: u8) -> Option<()> {
        let value = match byte {
            28 => {
                let value = read_u16(code, *position)?.cast_signed();
                *position = position.checked_add(2)?;
                f64::from(value)
            }
            32..=246 => f64::from(i32::from(byte).saturating_sub(139)),
            247..=250 => {
                let next = i32::from(*code.get(*position)?);
                *position = position.checked_add(1)?;
                f64::from(
                    i32::from(byte)
                        .saturating_sub(247)
                        .saturating_mul(256)
                        .saturating_add(next)
                        .saturating_add(108),
                )
            }
            251..=254 => {
                let next = i32::from(*code.get(*position)?);
                *position = position.checked_add(1)?;
                f64::from(
                    251_i32
                        .saturating_sub(i32::from(byte))
                        .saturating_mul(256)
                        .saturating_sub(next)
                        .saturating_sub(108),
                )
            }
            _ => {
                let value = read_u32(code, *position)?.cast_signed();
                *position = position.checked_add(4)?;
                f64::from(value) / 65_536.0_f64
            }
        };
        if self.stack.len() < MAX_STACK {
            self.stack.push(value);
        }
        Some(())
    }

    fn operator(&mut self, code: u8) {
        let count = self.stack.len();
        match code {
            1 | 3 | 18 | 23 => {
                self.take_width(0);
                self.stems = self.stems.saturating_add(self.stack.len() >> 1_u32);
            }
            21 => {
                self.take_width(0);
                let len = self.stack.len();
                let dx = self.arg(len.saturating_sub(2));
                let dy = self.arg(len.saturating_sub(1));
                self.move_by(dx, dy);
            }
            22 | 4 => {
                self.take_width(1);
                let delta = self.arg(self.stack.len().saturating_sub(1));
                if code == 22 {
                    self.move_by(delta, 0.0);
                } else {
                    self.move_by(0.0, delta);
                }
            }
            5 => {
                let mut index = 0_usize;
                while index.saturating_add(1) < count {
                    self.line(self.arg(index), self.arg(index.saturating_add(1)));
                    index = index.saturating_add(2);
                }
            }
            6 | 7 => {
                for index in 0..count {
                    let horizontal = (index & 1 == 0) == (code == 6);
                    let delta = self.arg(index);
                    if horizontal {
                        self.line(delta, 0.0);
                    } else {
                        self.line(0.0, delta);
                    }
                }
            }
            8 | 24 => {
                let mut index = 0_usize;
                let curve_end = if code == 24 {
                    count.saturating_sub(2)
                } else {
                    count
                };
                while index.saturating_add(6) <= curve_end {
                    self.curve_at(index);
                    index = index.saturating_add(6);
                }
                if code == 24 && index.saturating_add(2) <= count {
                    self.line(self.arg(index), self.arg(index.saturating_add(1)));
                }
            }
            25 => {
                let mut index = 0_usize;
                while index.saturating_add(8) <= count {
                    self.line(self.arg(index), self.arg(index.saturating_add(1)));
                    index = index.saturating_add(2);
                }
                if index.saturating_add(6) <= count {
                    self.curve_at(index);
                }
            }
            26 | 27 => {
                let mut index = count & 1;
                let mut first = if index == 1 { self.arg(0) } else { 0.0_f64 };
                while index.saturating_add(4) <= count {
                    let [a, b, c, d] =
                        [0, 1, 2, 3].map(|offset| self.arg(index.saturating_add(offset)));
                    if code == 27 {
                        self.curve(a, first, b, c, d, 0.0);
                    } else {
                        self.curve(first, a, b, c, 0.0, d);
                    }
                    first = 0.0_f64;
                    index = index.saturating_add(4);
                }
            }
            30 | 31 => {
                let mut index = 0_usize;
                let mut horizontal = code == 31;
                while index.saturating_add(4) <= count {
                    let [a, b, c, d] =
                        [0, 1, 2, 3].map(|offset| self.arg(index.saturating_add(offset)));
                    let last = if count.saturating_sub(index) == 5 {
                        self.arg(index.saturating_add(4))
                    } else {
                        0.0_f64
                    };
                    if horizontal {
                        self.curve(a, 0.0, b, c, last, d);
                    } else {
                        self.curve(0.0, a, b, c, d, last);
                    }
                    horizontal = !horizontal;
                    index = index.saturating_add(4);
                }
            }
            _ => {}
        }
        self.stack.clear();
    }

    fn run(&mut self, code: &[u8], depth: usize) -> Option<bool> {
        if depth > MAX_CALL_DEPTH {
            return None;
        }
        let mut position = 0_usize;
        while let Some(&byte) = code.get(position) {
            position = position.saturating_add(1);
            self.steps = self.steps.saturating_add(1);
            if self.steps > MAX_STEPS {
                return None;
            }
            if byte == 28 || byte >= 32 {
                self.number(code, &mut position, byte)?;
                continue;
            }
            match byte {
                10 | 29 => {
                    if self.call(byte == 29, depth)? {
                        return Some(true);
                    }
                }
                11 => return Some(false),
                14 => {
                    self.take_width(0);
                    if self.stack.len() >= 4 {
                        let accent = self.arg(3);
                        let base = self.arg(2);
                        let dx = self.arg(0);
                        let dy = self.arg(1);
                        self.stack.clear();
                        self.seac(base, accent, dx, dy)?;
                    }
                    self.close();
                    return Some(true);
                }
                12 => {
                    let escape = *code.get(position)?;
                    position = position.saturating_add(1);
                    self.escape(escape);
                }
                19 | 20 => {
                    self.take_width(0);
                    self.stems = self.stems.saturating_add(self.stack.len() >> 1_u32);
                    self.stack.clear();
                    position = position.saturating_add(self.stems.div_ceil(8));
                }
                _ => self.operator(byte),
            }
        }
        Some(false)
    }

    fn run_glyph(&mut self, code: &[u8], seac: usize) -> Option<bool> {
        if seac > MAX_SEAC_DEPTH {
            return None;
        }
        self.run(code, 0)
    }

    fn seac(&mut self, base: f64, accent: f64, dx: f64, dy: f64) -> Option<()> {
        let base_gid = self.font.gid_for_standard_code(base)?;
        let accent_gid = self.font.gid_for_standard_code(accent)?;
        self.close();
        let mut nested = Type2 {
            bytes: self.bytes,
            font: self.font,
            local: self.local,
            open: false,
            path: &mut *self.path,
            stack: Vec::with_capacity(MAX_STACK),
            stems: 0,
            steps: self.steps,
            width_parsed: true,
            x: 0.0,
            y: 0.0,
        };
        nested.glyph(base_gid, 1)?;
        let start = nested.path.coords.len();
        nested.x = 0.0_f64;
        nested.y = 0.0_f64;
        nested.stems = 0;
        nested.glyph(accent_gid, 1)?;
        let offsets = [dx, dy];
        for (index, value) in nested
            .path
            .coords
            .get_mut(start..)
            .unwrap_or_default()
            .iter_mut()
            .enumerate()
        {
            *value += f64_to_f32(offsets.get(index & 1).copied().unwrap_or(0.0_f64));
        }
        self.steps = nested.steps;
        Some(())
    }

    fn take_width(&mut self, normal_odd: usize) {
        if self.width_parsed {
            return;
        }
        self.width_parsed = true;
        if self.stack.len() & 1 != normal_odd & 1 && !self.stack.is_empty() {
            let _: f64 = self.stack.remove(0);
        }
    }
}

fn read_charset(
    bytes: &[u8],
    offset: i32,
    glyph_count: usize,
    cid_keyed: bool,
) -> Option<Vec<u16>> {
    let mut charset = vec![0_u16; glyph_count];
    if offset <= 2_i32 {
        let predefined: Option<&[u16]> = match offset {
            1 => Some(&CFF_EXPERT_CHARSET),
            2 => Some(&CFF_EXPERT_SUBSET_CHARSET),
            _ => None,
        };
        for (gid, slot) in charset.iter_mut().enumerate() {
            let value = match predefined {
                Some(table) => table.get(gid).copied().unwrap_or(0),
                None if cid_keyed || gid <= ISO_ADOBE_LAST_SID => u16::try_from(gid).ok()?,
                None => 0,
            };
            *slot = value;
        }
        return Some(charset);
    }
    let mut position = usize::try_from(offset).ok()?;
    let format = *bytes.get(position)?;
    position = position.checked_add(1)?;
    let mut gid = 1_usize;
    match format {
        0 => {
            while gid < glyph_count {
                *charset.get_mut(gid)? = read_u16(bytes, position)?;
                position = position.checked_add(2)?;
                gid = gid.saturating_add(1);
            }
        }
        1 | 2 => {
            while gid < glyph_count {
                let first = read_u16(bytes, position)?;
                position = position.checked_add(2)?;
                let left = if format == 1 {
                    let value = usize::from(*bytes.get(position)?);
                    position = position.checked_add(1)?;
                    value
                } else {
                    let value = usize::from(read_u16(bytes, position)?);
                    position = position.checked_add(2)?;
                    value
                };
                for step in 0..=left {
                    if gid >= glyph_count {
                        break;
                    }
                    *charset.get_mut(gid)? = first.wrapping_add(u16::try_from(step).ok()?);
                    gid = gid.saturating_add(1);
                }
            }
        }
        _ => return None,
    }
    Some(charset)
}

fn read_encoding(bytes: &[u8], offset: i32, charset: &[u16]) -> Option<BuiltinEncoding> {
    match offset {
        0_i32 => return Some(BuiltinEncoding::Standard),
        1_i32 => return Some(BuiltinEncoding::Expert),
        _ => {}
    }
    let mut position = usize::try_from(offset).ok()?;
    let format = *bytes.get(position)?;
    position = position.checked_add(1)?;
    let mut table = vec![0_u16; 256];
    let mut assign = |code: usize, gid: usize| {
        if let (Some(slot), Some(sid)) = (table.get_mut(code), charset.get(gid)) {
            *slot = *sid;
        }
    };
    match format & 0x7F {
        0 => {
            let count = usize::from(*bytes.get(position)?);
            position = position.checked_add(1)?;
            for index in 0..count {
                let code = usize::from(*bytes.get(position)?);
                position = position.checked_add(1)?;
                assign(code, index.checked_add(1)?);
            }
        }
        1 => {
            let ranges = usize::from(*bytes.get(position)?);
            position = position.checked_add(1)?;
            let mut gid = 1_usize;
            for _ in 0..ranges {
                let first = usize::from(*bytes.get(position)?);
                let left = usize::from(*bytes.get(position.checked_add(1)?)?);
                position = position.checked_add(2)?;
                for step in 0..=left {
                    assign(first.checked_add(step)?, gid);
                    gid = gid.checked_add(1)?;
                }
            }
        }
        _ => return None,
    }
    if format & 0x80 != 0 {
        let supplements = usize::from(*bytes.get(position)?);
        position = position.checked_add(1)?;
        for _ in 0..supplements {
            let code = usize::from(*bytes.get(position)?);
            let sid = read_u16(bytes, position.checked_add(1)?)?;
            position = position.checked_add(3)?;
            if let Some(slot) = table.get_mut(code) {
                *slot = sid;
            }
        }
    }
    Some(BuiltinEncoding::Table(table))
}

fn parse_dict(bytes: &[u8]) -> Vec<(u16, Vec<f64>)> {
    let mut entries: Vec<(u16, Vec<f64>)> = Vec::new();
    let mut operands: Vec<f64> = Vec::new();
    let mut position = 0_usize;
    while let Some(&byte) = bytes.get(position) {
        position = position.saturating_add(1);
        match byte {
            0..=21 => {
                let op = if byte == 12 {
                    let next = bytes.get(position).copied().unwrap_or(0);
                    position = position.saturating_add(1);
                    0x0C00 | u16::from(next)
                } else {
                    u16::from(byte)
                };
                if entries.len() >= MAX_DICT_ENTRIES {
                    break;
                }
                entries.push((op, mem::take(&mut operands)));
            }
            28 => {
                let value = read_u16(bytes, position).map(|value| i32::from(value.cast_signed()));
                position = position.saturating_add(2);
                push_operand(&mut operands, f64::from(value.unwrap_or(0_i32)));
            }
            29 => {
                let value = read_u32(bytes, position).map(u32::cast_signed);
                position = position.saturating_add(4);
                push_operand(&mut operands, f64::from(value.unwrap_or(0_i32)));
            }
            30 => {
                let mut text: Vec<u8> = Vec::new();
                'nibbles: while let Some(&pair) = bytes.get(position) {
                    position = position.saturating_add(1);
                    for nibble in [pair >> 4_i32, pair & 0x0F] {
                        match nibble {
                            0..=9 => text.push(b'0'.saturating_add(nibble)),
                            0x0A => text.push(b'.'),
                            0x0B => text.push(b'E'),
                            0x0C => text.extend_from_slice(b"E-"),
                            0x0E => text.push(b'-'),
                            0x0F => break 'nibbles,
                            _ => {}
                        }
                    }
                }
                push_operand(&mut operands, parse_decimal(&text).unwrap_or(0.0_f64));
            }
            32..=246 => push_operand(
                &mut operands,
                f64::from(i32::from(byte).saturating_sub(139)),
            ),
            247..=250 => {
                let next = i32::from(bytes.get(position).copied().unwrap_or(0));
                position = position.saturating_add(1);
                push_operand(
                    &mut operands,
                    f64::from(
                        (((i32::from(byte).saturating_sub(247)).saturating_mul(256))
                            .saturating_add(next))
                        .saturating_add(108),
                    ),
                );
            }
            251..=254 => {
                let next = i32::from(bytes.get(position).copied().unwrap_or(0));
                position = position.saturating_add(1);
                push_operand(
                    &mut operands,
                    f64::from(
                        251_i32
                            .saturating_sub(i32::from(byte))
                            .saturating_mul(256)
                            .saturating_sub(next)
                            .saturating_sub(108),
                    ),
                );
            }
            _ => {}
        }
    }
    entries
}

fn dict_values(dict: &[(u16, Vec<f64>)], op: u16) -> Option<&[f64]> {
    dict.iter()
        .find(|(key, _)| *key == op)
        .map(|(_, values)| values.as_slice())
}

fn dict_offset(dict: &[(u16, Vec<f64>)], op: u16) -> Option<i32> {
    let value = *dict_values(dict, op)?.first()?;
    i32::try_from(f64_to_i64(value)).ok()
}

fn dict_matrix(dict: &[(u16, Vec<f64>)]) -> Option<[f64; 6]> {
    let values = dict_values(dict, OP_FONT_MATRIX)?;
    let matrix: [f64; 6] = values.get(..6)?.try_into().ok()?;
    matrix
        .iter()
        .all(|value| value.is_finite())
        .then_some(matrix)
}

fn read_private(bytes: &[u8], dict: &[(u16, Vec<f64>)]) -> PrivateDict {
    let matrix = dict_matrix(dict);
    let subrs = dict_values(dict, OP_PRIVATE).and_then(|values| {
        let size = usize::try_from(f64_to_i64(*values.first()?)).ok()?;
        let offset = usize::try_from(f64_to_i64(*values.get(1)?)).ok()?;
        let private = parse_dict(bytes.get(offset..offset.checked_add(size)?)?);
        let relative = usize::try_from(dict_offset(&private, OP_SUBRS)?).ok()?;
        Index::parse(bytes, offset.checked_add(relative)?)
    });
    PrivateDict { matrix, subrs }
}

fn read_font_dicts(
    bytes: &[u8],
    top: &[(u16, Vec<f64>)],
    glyph_count: usize,
) -> (Vec<PrivateDict>, Vec<u8>) {
    let mut privates = Vec::new();
    if let Some(array) = dict_offset(top, OP_FD_ARRAY)
        .and_then(|offset| usize::try_from(offset).ok())
        .and_then(|offset| Index::parse(bytes, offset))
    {
        for item in 0..array.count.min(MAX_FONT_DICTS) {
            let dict = array.get(bytes, item).map(parse_dict).unwrap_or_default();
            privates.push(read_private(bytes, &dict));
        }
    }
    let select = dict_offset(top, OP_FD_SELECT)
        .and_then(|offset| usize::try_from(offset).ok())
        .and_then(|offset| read_fd_select(bytes, offset, glyph_count))
        .unwrap_or_default();
    (privates, select)
}

fn read_fd_select(bytes: &[u8], offset: usize, glyph_count: usize) -> Option<Vec<u8>> {
    let format = *bytes.get(offset)?;
    let start = offset.checked_add(1)?;
    match format {
        0 => Some(bytes.get(start..start.checked_add(glyph_count)?)?.to_vec()),
        3 => {
            let ranges = usize::from(read_u16(bytes, start)?);
            let mut select = vec![0_u8; glyph_count];
            let mut position = start.checked_add(2)?;
            for _ in 0..ranges {
                let first = usize::from(read_u16(bytes, position)?);
                let fd = *bytes.get(position.checked_add(2)?)?;
                let next = usize::from(read_u16(bytes, position.checked_add(3)?)?);
                if let Some(slots) = select.get_mut(first..next.min(glyph_count)) {
                    slots.fill(fd);
                }
                position = position.checked_add(3)?;
            }
            Some(select)
        }
        _ => None,
    }
}

fn multiply(first: &[f64; 6], second: &[f64; 6]) -> [f64; 6] {
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

const fn subr_bias(count: usize) -> usize {
    if count < 1240 {
        107
    } else if count < 33900 {
        1131
    } else {
        0x8000
    }
}

fn push_operand(operands: &mut Vec<f64>, value: f64) {
    if operands.len() < MAX_OPERANDS {
        operands.push(value);
    }
}

fn read_offset(bytes: &[u8], position: usize, size: usize) -> Option<usize> {
    let mut value = 0_usize;
    for step in 0..size {
        value = (value << 8_i32) | usize::from(*bytes.get(position.checked_add(step)?)?);
    }
    Some(value)
}

fn read_u16(bytes: &[u8], position: usize) -> Option<u16> {
    let high = u16::from(*bytes.get(position)?);
    let low = u16::from(*bytes.get(position.checked_add(1)?)?);
    Some((high << 8) | low)
}

fn read_u32(bytes: &[u8], position: usize) -> Option<u32> {
    let high = u32::from(read_u16(bytes, position)?);
    let low = u32::from(read_u16(bytes, position.checked_add(2)?)?);
    Some((high << 16) | low)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use core::hint::black_box;
    use core::iter;

    pub(crate) struct Layout {
        pub charset: Vec<u8>,
        pub charset_id: i32,
        pub cid_keyed: bool,
        pub encoding: Vec<u8>,
        pub encoding_id: i32,
        pub glyphs: usize,
        pub names: Vec<&'static str>,
    }

    pub(crate) fn index(items: &[&[u8]]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&(u16::try_from(items.len()).unwrap()).to_be_bytes());
        if items.is_empty() {
            return out;
        }
        out.push(2);
        let mut offset = 1_u16;
        out.extend_from_slice(&offset.to_be_bytes());
        for item in items {
            offset = offset.saturating_add(u16::try_from(item.len()).unwrap());
            out.extend_from_slice(&offset.to_be_bytes());
        }
        for item in items {
            out.extend_from_slice(item);
        }
        out
    }

    fn int(value: i32) -> Vec<u8> {
        let mut out = vec![29];
        out.extend_from_slice(&value.to_be_bytes());
        out
    }

    pub(crate) fn build(layout: &Layout) -> Vec<u8> {
        let mut customs: Vec<Vec<u8>> = Vec::new();
        for name in &layout.names {
            customs.push(name.as_bytes().to_vec());
        }
        let custom_refs: Vec<&[u8]> = customs.iter().map(Vec::as_slice).collect();
        let strings = index(&custom_refs);
        let charstring_items: Vec<&[u8]> = iter::repeat_with(|| [14_u8].as_slice())
            .take(layout.glyphs)
            .collect();
        let charstrings = index(&charstring_items);
        let header = [1_u8, 0, 4, 2];
        let name_index = index(&[b"T"]);
        let dict_len = |charset_off: i32, enc_off: i32, cs_off: i32| {
            let mut dict = Vec::new();
            if layout.cid_keyed {
                dict.extend_from_slice(&int(391));
                dict.extend_from_slice(&int(391));
                dict.extend_from_slice(&int(0));
                dict.extend_from_slice(&[12, 30]);
            }
            dict.extend_from_slice(&int(charset_off));
            dict.push(15);
            dict.extend_from_slice(&int(enc_off));
            dict.push(16);
            dict.extend_from_slice(&int(cs_off));
            dict.push(17);
            dict
        };
        let probe = index(&[&dict_len(0_i32, 0_i32, 0_i32)]);
        let base = (((header.len().saturating_add(name_index.len())).saturating_add(probe.len()))
            .saturating_add(strings.len()))
        .saturating_add(2);
        let charset_off = if layout.charset.is_empty() {
            layout.charset_id
        } else {
            i32::try_from(base).unwrap()
        };
        let enc_off = if layout.encoding.is_empty() {
            layout.encoding_id
        } else {
            i32::try_from(base.saturating_add(layout.charset.len())).unwrap()
        };
        let cs_off = i32::try_from(
            (base.saturating_add(layout.charset.len())).saturating_add(layout.encoding.len()),
        )
        .unwrap();
        let top = index(&[&dict_len(charset_off, enc_off, cs_off)]);
        let mut out = Vec::new();
        out.extend_from_slice(&header);
        out.extend_from_slice(&name_index);
        out.extend_from_slice(&top);
        out.extend_from_slice(&strings);
        out.extend_from_slice(&index(&[]));
        out.extend_from_slice(&layout.charset);
        out.extend_from_slice(&layout.encoding);
        out.extend_from_slice(&charstrings);
        out
    }

    fn sid(value: u16) -> [u8; 2] {
        value.to_be_bytes()
    }

    #[test]
    fn expert_tables_have_expected_sizes() {
        assert_eq!(CFF_EXPERT_CHARSET.len(), 166);
        assert_eq!(CFF_EXPERT_SUBSET_CHARSET.len(), 87);
    }

    #[test]
    fn charset_format0_names_and_custom_strings() {
        let mut charset = vec![0_u8];
        charset.extend_from_slice(&sid(34));
        charset.extend_from_slice(&sid(391));
        let font = CffFont::parse(&build(&Layout {
            names: vec!["t_i"],
            charset,
            charset_id: 0,
            encoding: vec![0, 1, 0x41],
            encoding_id: 0,
            cid_keyed: false,
            glyphs: 3,
        }))
        .expect("cff");
        assert_eq!(font.glyph_count(), 3);
        assert_eq!(font.glyph_name(0), Some(b".notdef".as_slice()));
        assert_eq!(font.glyph_name(1), Some(b"A".as_slice()));
        assert_eq!(font.glyph_name(2), Some(b"t_i".as_slice()));
        assert_eq!(font.glyph_name(9), None);
        assert_eq!(font.builtin_name(0x41), Some(b"A".as_slice()));
        assert_eq!(font.builtin_name(0x42), None);
    }

    #[test]
    fn charset_format1_and_format2_ranges() {
        for format in [1_u8, 2] {
            let mut charset = vec![format];
            charset.extend_from_slice(&sid(34));
            if format == 1 {
                charset.push(2);
            } else {
                charset.extend_from_slice(&2_u16.to_be_bytes());
            }
            let font = CffFont::parse(&build(&Layout {
                names: vec![],
                charset,
                charset_id: 0,
                encoding: vec![1, 1, 1, 2],
                encoding_id: 0,
                cid_keyed: false,
                glyphs: 4,
            }))
            .expect("cff");
            assert_eq!(font.glyph_name(1), Some(b"A".as_slice()));
            assert_eq!(font.glyph_name(2), Some(b"B".as_slice()));
            assert_eq!(font.glyph_name(3), Some(b"C".as_slice()));
            assert_eq!(font.builtin_name(1), Some(b"A".as_slice()));
            assert_eq!(font.builtin_name(2), Some(b"B".as_slice()));
            assert_eq!(font.builtin_name(3), Some(b"C".as_slice()));
            assert_eq!(font.builtin_name(4), None);
        }
    }

    #[test]
    fn encoding_supplement_overrides_code() {
        let mut charset = vec![0_u8];
        charset.extend_from_slice(&sid(34));
        let font = CffFont::parse(&build(&Layout {
            names: vec![],
            charset,
            charset_id: 0,
            encoding: vec![0x80, 1, 0x41, 1, 0x7A, 0, 52],
            encoding_id: 0,
            cid_keyed: false,
            glyphs: 2,
        }))
        .expect("cff");
        assert_eq!(font.builtin_name(0x41), Some(b"A".as_slice()));
        assert_eq!(font.builtin_name(0x7A), Some(b"S".as_slice()));
    }

    #[test]
    fn predefined_standard_and_expert_encodings() {
        let standard = CffFont::parse(&build(&Layout {
            names: vec![],
            charset: vec![],
            charset_id: 0,
            encoding: vec![],
            encoding_id: 0,
            cid_keyed: false,
            glyphs: 3,
        }))
        .expect("cff");
        assert_eq!(standard.glyph_name(1), Some(b"space".as_slice()));
        assert_eq!(standard.glyph_name(2), Some(b"exclam".as_slice()));
        assert_eq!(standard.builtin_name(0x41), Some(b"A".as_slice()));
        assert_eq!(standard.builtin_name(0x01), None);
        let expert = CffFont::parse(&build(&Layout {
            names: vec![],
            charset: vec![],
            charset_id: 1,
            encoding: vec![],
            encoding_id: 1,
            cid_keyed: false,
            glyphs: 4,
        }))
        .expect("cff");
        assert_eq!(expert.glyph_name(2), Some(b"exclamsmall".as_slice()));
        assert_eq!(expert.builtin_name(0x21), Some(b"exclamsmall".as_slice()));
        assert_eq!(expert.builtin_name(0x01), None);
        let subset = CffFont::parse(&build(&Layout {
            names: vec![],
            charset: vec![],
            charset_id: 2,
            encoding: vec![],
            encoding_id: 0,
            cid_keyed: false,
            glyphs: 4,
        }))
        .expect("cff");
        assert_eq!(subset.glyph_name(2), Some(b"dollaroldstyle".as_slice()));
    }

    #[test]
    fn cid_keyed_charset_maps_cid_to_gid() {
        let mut charset = vec![0_u8];
        charset.extend_from_slice(&sid(500));
        charset.extend_from_slice(&sid(20));
        let font = CffFont::parse(&build(&Layout {
            names: vec![],
            charset,
            charset_id: 0,
            encoding: vec![],
            encoding_id: 0,
            cid_keyed: true,
            glyphs: 3,
        }))
        .expect("cff");
        assert!(font.is_cid_keyed());
        assert_eq!(font.gid_for_cid(500), Some(1));
        assert_eq!(font.gid_for_cid(20), Some(2));
        assert_eq!(font.gid_for_cid(21), None);
        assert_eq!(font.glyph_name(1), None);
    }

    #[test]
    fn rejects_garbage_without_panicking() {
        assert!(CffFont::parse(&[]).is_none());
        assert!(CffFont::parse(&[1, 0, 4, 2]).is_none());
        assert!(CffFont::parse(&[2, 0, 4, 2, 0, 0]).is_none());
        let mut seed = 0x1234_5678_u32;
        for round in 0..2000_usize {
            let len = 8 + round.rem_euclid(96);
            let mut data = vec![0_u8; len];
            for slot in &mut data {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                *slot = u8::try_from(seed >> 24_i32).unwrap();
            }
            if let Some(first) = data.first_mut() {
                *first = 1;
            }
            drop(black_box(CffFont::parse(&data)));
        }
    }

    #[test]
    fn mutated_valid_font_does_not_panic() {
        let mut charset = vec![0_u8];
        charset.extend_from_slice(&sid(34));
        charset.extend_from_slice(&sid(391));
        let valid = build(&Layout {
            names: vec!["t_i"],
            charset,
            charset_id: 0,
            encoding: vec![0, 1, 0x41],
            encoding_id: 0,
            cid_keyed: false,
            glyphs: 3,
        });
        for position in 0..valid.len() {
            for value in [0_u8, 1, 0x7F, 0xFF] {
                let mut data = valid.clone();
                data[position] = value;
                drop(black_box(CffFont::parse(&data)));
            }
        }
        for cut in 0..valid.len() {
            drop(black_box(CffFont::parse(&valid[..cut])));
        }
    }
}
