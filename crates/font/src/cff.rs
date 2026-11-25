use crate::{parse_decimal, read_u16, read_u32};
use core::mem;

const MAX_DICT_ENTRIES: usize = 256;
const MAX_OPERANDS: usize = 48;

#[derive(Clone, Copy, Debug)]
pub struct Index {
    count: usize,
    data: usize,
    end: usize,
    off_size: usize,
    offsets: usize,
}

impl Index {
    #[inline]
    #[must_use]
    pub const fn count(&self) -> usize {
        self.count
    }

    #[inline]
    #[must_use]
    pub const fn empty(position: usize) -> Self {
        Self {
            count: 0,
            data: position,
            end: position,
            off_size: 0,
            offsets: position,
        }
    }

    #[inline]
    #[must_use]
    pub const fn end(&self) -> usize {
        self.end
    }

    #[inline]
    #[must_use]
    pub fn get<'data>(&self, bytes: &'data [u8], item: usize) -> Option<&'data [u8]> {
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

    #[inline]
    #[must_use]
    pub fn parse(bytes: &[u8], position: usize) -> Option<Self> {
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

#[inline]
#[must_use]
pub fn parse_dict(bytes: &[u8]) -> Vec<(u16, Vec<f64>)> {
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

#[inline]
#[must_use]
pub fn dict_values(dict: &[(u16, Vec<f64>)], op: u16) -> Option<&[f64]> {
    dict.iter()
        .find(|(key, _)| *key == op)
        .map(|(_, values)| values.as_slice())
}

#[inline]
#[must_use]
pub fn read_fd_select(bytes: &[u8], offset: usize, glyph_count: usize) -> Option<Vec<u8>> {
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
