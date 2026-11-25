use core::cmp::Ordering;

use crate::{read_u16, read_u32};

#[derive(Debug, Default)]
pub(crate) struct Kerning<'data> {
    bytes: &'data [u8],
    lookups: Vec<usize>,
}

impl<'data> Kerning<'data> {
    pub(crate) const fn is_empty(&self) -> bool {
        self.lookups.is_empty()
    }

    fn lookup(&self, base: usize, left: u16, right: u16) -> Option<i32> {
        let lookup = self.bytes.get(base..)?;
        let kind = read_u16(lookup, 0)?;
        for index in 0..usize::from(read_u16(lookup, 4)?).min(128) {
            let at = relative(lookup, 0, 6_usize.checked_add(index.checked_mul(2)?)?)?;
            let sub = lookup.get(at..)?;
            let pair = match kind {
                2 => sub,
                9 if read_u16(sub, 2)? == 2 => {
                    sub.get(usize::try_from(read_u32(sub, 4)?).ok()?..)?
                }
                _ => continue,
            };
            if let Some(value) = adjustment(pair, left, right) {
                return Some(value);
            }
        }
        None
    }

    pub(crate) fn pair(&self, left: u16, right: u16) -> i32 {
        self.lookups
            .iter()
            .filter_map(|base| self.lookup(*base, left, right))
            .fold(0_i32, i32::saturating_add)
    }

    pub(crate) fn parse(bytes: &'data [u8]) -> Option<Self> {
        if read_u16(bytes, 0)? != 1 {
            return None;
        }
        let feature_at = relative(bytes, 0, 6)?;
        let lookup_at = relative(bytes, 0, 8)?;
        let mut ids = Vec::new();
        for index in 0..usize::from(read_u16(bytes, feature_at)?).min(512) {
            let slot = feature_at
                .checked_add(2)?
                .checked_add(index.checked_mul(6)?)?;
            if bytes.get(slot..slot.checked_add(4)?)? != b"kern" {
                continue;
            }
            let feature = relative(bytes, feature_at, slot.checked_add(4)?)?;
            for entry in 0..usize::from(read_u16(bytes, feature.checked_add(2)?)?).min(128) {
                let lookup = read_u16(
                    bytes,
                    feature.checked_add(4)?.checked_add(entry.checked_mul(2)?)?,
                )?;
                if !ids.contains(&lookup) {
                    ids.push(lookup);
                }
            }
        }
        let count = read_u16(bytes, lookup_at)?;
        let lookups = ids
            .into_iter()
            .filter(|slot| *slot < count)
            .filter_map(|slot| {
                relative(
                    bytes,
                    lookup_at,
                    lookup_at
                        .checked_add(2)?
                        .checked_add(usize::from(slot).checked_mul(2)?)?,
                )
            })
            .collect();
        Some(Self { bytes, lookups })
    }
}

fn relative(data: &[u8], base: usize, slot: usize) -> Option<usize> {
    base.checked_add(usize::from(read_u16(data, slot)?))
}

fn record(data: &[u8], base: usize, index: usize, stride: usize) -> Option<&[u8]> {
    let offset = base.checked_add(index.checked_mul(stride)?)?;
    data.get(offset..offset.checked_add(stride)?)
}

fn coverage(data: &[u8], glyph: u16) -> Option<usize> {
    let count = usize::from(read_u16(data, 2)?);
    match read_u16(data, 0)? {
        1 => {
            let target = glyph.to_be_bytes();
            let records = data.get(4..4_usize.checked_add(count.checked_mul(2)?)?)?;
            records.as_chunks::<2>().0.binary_search(&target).ok()
        }
        2 => {
            let range = matching_range(data, 4, count, glyph)?;
            let start = read_u16(range, 0)?;
            let index = read_u16(range, 4)?;
            Some(usize::from(index.checked_add(glyph.checked_sub(start)?)?))
        }
        _ => None,
    }
}

fn matching_range(data: &[u8], base: usize, count: usize, glyph: u16) -> Option<&[u8]> {
    let mut low = 0_usize;
    let mut high = count;
    while low < high {
        let mid = low.midpoint(high);
        let row = record(data, base, mid, 6)?;
        if glyph < read_u16(row, 0)? {
            high = mid;
        } else if glyph > read_u16(row, 2)? {
            low = mid.saturating_add(1);
        } else {
            return Some(row);
        }
    }
    None
}

fn class(data: &[u8], glyph: u16) -> Option<usize> {
    match read_u16(data, 0)? {
        1 => {
            let first = read_u16(data, 2)?;
            let count = read_u16(data, 4)?;
            let Some(index) = glyph.checked_sub(first).filter(|index| *index < count) else {
                return Some(0);
            };
            Some(usize::from(read_u16(
                data,
                6_usize.checked_add(usize::from(index).checked_mul(2)?)?,
            )?))
        }
        2 => {
            let count = usize::from(read_u16(data, 2)?);
            Some(
                matching_range(data, 4, count, glyph)
                    .and_then(|range| read_u16(range, 4))
                    .map_or(0, usize::from),
            )
        }
        _ => None,
    }
}

fn pair_record(data: &[u8], count: usize, stride: usize, right: u16) -> Option<&[u8]> {
    let mut low = 0_usize;
    let mut high = count;
    while low < high {
        let mid = low.midpoint(high);
        let row = record(data, 2, mid, stride)?;
        let glyph = read_u16(row, 0)?;
        match right.cmp(&glyph) {
            Ordering::Less => high = mid,
            Ordering::Greater => low = mid.saturating_add(1),
            Ordering::Equal => return row.get(2..),
        }
    }
    None
}

fn adjustment(data: &[u8], left: u16, right: u16) -> Option<i32> {
    let cover = data.get(relative(data, 0, 2)?..)?;
    let covered = coverage(cover, left)?;
    let first = read_u16(data, 4)?;
    let second = read_u16(data, 6)?;
    let bytes = |format: u16| usize::try_from(format.count_ones()).ok()?.checked_mul(2);
    let stride = bytes(first)?.checked_add(bytes(second)?)?;
    let row = match read_u16(data, 0)? {
        1 => {
            if covered >= usize::from(read_u16(data, 8)?) {
                return None;
            }
            let set =
                data.get(relative(data, 0, 10_usize.checked_add(covered.checked_mul(2)?)?)?..)?;
            pair_record(
                set,
                usize::from(read_u16(set, 0)?),
                stride.checked_add(2)?,
                right,
            )?
        }
        2 => {
            let left_class = class(data.get(relative(data, 0, 8)?..)?, left)?;
            let right_class = class(data.get(relative(data, 0, 10)?..)?, right)?;
            let columns = usize::from(read_u16(data, 14)?);
            if left_class >= usize::from(read_u16(data, 12)?) || right_class >= columns {
                return None;
            }
            record(
                data,
                16,
                left_class.checked_mul(columns)?.checked_add(right_class)?,
                stride,
            )?
        }
        _ => return None,
    };
    if first & 4 == 0 {
        return Some(0);
    }
    let advance = read_u16(row, bytes(first & 3)?)?.cast_signed();
    Some(i32::from(advance))
}
