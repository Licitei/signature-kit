use crate::{read_u16, read_u32};

const MAX_REVERSE_CODES: usize = 0x0004_0000;
const MAX_SUBTABLES: usize = 64;

#[derive(Clone, Copy, Debug)]
#[non_exhaustive]
pub struct Subtable {
    pub encoding: u16,
    pub format: u16,
    pub offset: usize,
    pub platform: u16,
}

#[inline]
#[must_use]
pub fn read_cmap_directory(bytes: &[u8], offset: usize, end: usize) -> Vec<Subtable> {
    let mut subtables = Vec::new();
    let count = read_u16(bytes, offset.saturating_add(2)).map_or(0, usize::from);
    for index in 0..count.min(MAX_SUBTABLES) {
        let head = offset.saturating_add((index.saturating_mul(8)).saturating_add(4));
        let (Some(platform), Some(encoding), Some(relative)) = (
            read_u16(bytes, head),
            read_u16(bytes, head.saturating_add(2)),
            read_u32(bytes, head.saturating_add(4)),
        ) else {
            return subtables;
        };
        let Some(sub) = usize::try_from(relative)
            .ok()
            .and_then(|inner_relative| offset.checked_add(inner_relative))
        else {
            continue;
        };
        if sub >= end.min(bytes.len()) {
            continue;
        }
        let Some(format) = read_u16(bytes, sub) else {
            continue;
        };
        if matches!(format, 0 | 4 | 6 | 12) {
            subtables.push(Subtable {
                platform,
                encoding,
                offset: sub,
                format,
            });
        }
    }
    subtables
}

#[inline]
#[must_use]
pub fn lookup(data: &[u8], sub: Subtable, code: u32) -> Option<u16> {
    let gid = match sub.format {
        0 => lookup_format0(data, sub.offset, code),
        4 => lookup_format4(data, sub.offset, code),
        6 => lookup_format6(data, sub.offset, code),
        12 => lookup_format12(data, sub.offset, code),
        _ => None,
    }?;
    (gid != 0).then_some(gid)
}

fn lookup_format0(data: &[u8], offset: usize, code: u32) -> Option<u16> {
    if code > 255 {
        return None;
    }
    let position = offset
        .checked_add(6)?
        .checked_add(usize::try_from(code).ok()?)?;
    data.get(position).copied().map(u16::from)
}

fn lookup_format4(data: &[u8], offset: usize, code: u32) -> Option<u16> {
    let code_u16 = u16::try_from(code).ok()?;
    let seg_count = usize::from(read_u16(data, offset.checked_add(6)?)?) >> 1_i32;
    let ends = offset.checked_add(14)?;
    let starts = ends
        .checked_add(seg_count.saturating_mul(2))?
        .checked_add(2)?;
    let deltas = starts.checked_add(seg_count.saturating_mul(2))?;
    let ranges = deltas.checked_add(seg_count.saturating_mul(2))?;
    let mut low = 0_usize;
    let mut high = seg_count;
    while low < high {
        let mid = low.midpoint(high);
        if read_u16(data, ends.checked_add(mid.saturating_mul(2))?)? < code_u16 {
            low = mid.saturating_add(1);
        } else {
            high = mid;
        }
    }
    if low >= seg_count {
        return None;
    }
    let start = read_u16(data, starts.checked_add(low.saturating_mul(2))?)?;
    if start > code_u16 {
        return None;
    }
    let delta = read_u16(data, deltas.checked_add(low.saturating_mul(2))?)?;
    let range = read_u16(data, ranges.checked_add(low.saturating_mul(2))?)?;
    if range == 0 {
        return Some(code_u16.wrapping_add(delta));
    }
    let position = ranges
        .checked_add(low.saturating_mul(2))?
        .checked_add(usize::from(range))?
        .checked_add(usize::from(code_u16.saturating_sub(start)) * 2)?;
    let glyph = read_u16(data, position)?;
    (glyph != 0).then(|| glyph.wrapping_add(delta))
}

fn lookup_format6(data: &[u8], offset: usize, code: u32) -> Option<u16> {
    let first = u32::from(read_u16(data, offset.checked_add(6)?)?);
    let count = u32::from(read_u16(data, offset.checked_add(8)?)?);
    if code < first || code >= first.saturating_add(count) {
        return None;
    }
    let index = usize::try_from(code.saturating_sub(first)).ok()?;
    read_u16(
        data,
        offset
            .checked_add(10)?
            .checked_add(index.saturating_mul(2))?,
    )
}

fn lookup_format12(data: &[u8], offset: usize, code: u32) -> Option<u16> {
    let groups = usize::try_from(read_u32(data, offset.checked_add(12)?)?).ok()?;
    let base = offset.checked_add(16)?;
    let mut low = 0_usize;
    let mut high = groups.min(MAX_REVERSE_CODES);
    while low < high {
        let mid = low.midpoint(high);
        let group = base.checked_add(mid.checked_mul(12)?)?;
        let start = read_u32(data, group)?;
        let end = read_u32(data, group.checked_add(4)?)?;
        if code < start {
            high = mid;
        } else if code > end {
            low = mid.saturating_add(1);
        } else {
            let first = read_u32(data, group.checked_add(8)?)?;
            return u16::try_from(first.checked_add(code.saturating_sub(start))?).ok();
        }
    }
    None
}

#[inline]
pub fn for_each(data: &[u8], sub: Subtable, visit: &mut dyn FnMut(u32, u16)) {
    let mut budget = MAX_REVERSE_CODES;
    match sub.format {
        0 => each_format0(data, sub.offset, visit),
        4 => each_format4(data, sub.offset, &mut budget, visit),
        6 => each_format6(data, sub.offset, visit),
        12 => each_format12(data, sub.offset, &mut budget, visit),
        _ => {}
    }
}

const fn spend(budget: &mut usize) -> bool {
    if *budget == 0 {
        return false;
    }
    *budget = budget.saturating_sub(1);
    true
}

fn each_format0(data: &[u8], offset: usize, visit: &mut dyn FnMut(u32, u16)) {
    for code in 0..256_u32 {
        let Some(gid) = data
            .get(
                offset
                    .saturating_add(6)
                    .saturating_add(usize::try_from(code).unwrap_or(usize::MAX)),
            )
            .map(|gid| u16::from(*gid))
        else {
            return;
        };
        if gid != 0 {
            visit(code, gid);
        }
    }
}

fn each_format4(data: &[u8], offset: usize, budget: &mut usize, visit: &mut dyn FnMut(u32, u16)) {
    let Some(seg_count) =
        read_u16(data, offset.saturating_add(6)).map(|value| usize::from(value) >> 1_i32)
    else {
        return;
    };
    let ends = offset.saturating_add(14);
    let starts = ends
        .saturating_add(seg_count.saturating_mul(2))
        .saturating_add(2);
    let deltas = starts.saturating_add(seg_count.saturating_mul(2));
    let ranges = deltas.saturating_add(seg_count.saturating_mul(2));
    for seg in 0..seg_count {
        let (Some(end), Some(start), Some(delta), Some(range)) = (
            read_u16(data, ends.saturating_add(seg.saturating_mul(2))),
            read_u16(data, starts.saturating_add(seg.saturating_mul(2))),
            read_u16(data, deltas.saturating_add(seg.saturating_mul(2))),
            read_u16(data, ranges.saturating_add(seg.saturating_mul(2))),
        ) else {
            return;
        };
        if end < start || start == 0xFFFF {
            continue;
        }
        for code in start..=end {
            if !spend(budget) {
                return;
            }
            let gid = if range == 0 {
                code.wrapping_add(delta)
            } else {
                let position = ranges
                    .saturating_add(seg.saturating_mul(2))
                    .saturating_add(usize::from(range))
                    .saturating_add(usize::from(code.saturating_sub(start)) * 2);
                match read_u16(data, position) {
                    Some(0) | None => continue,
                    Some(glyph) => glyph.wrapping_add(delta),
                }
            };
            if gid != 0 {
                visit(u32::from(code), gid);
            }
        }
    }
}

fn each_format6(data: &[u8], offset: usize, visit: &mut dyn FnMut(u32, u16)) {
    let (Some(first), Some(count)) = (
        read_u16(data, offset.saturating_add(6)),
        read_u16(data, offset.saturating_add(8)),
    ) else {
        return;
    };
    for index in 0..usize::from(count) {
        let Some(gid) = read_u16(
            data,
            offset.saturating_add(index.saturating_mul(2).saturating_add(10)),
        ) else {
            return;
        };
        if gid != 0 {
            visit(
                u32::from(first).saturating_add(u32::try_from(index).unwrap_or(u32::MAX)),
                gid,
            );
        }
    }
}

fn each_format12(data: &[u8], offset: usize, budget: &mut usize, visit: &mut dyn FnMut(u32, u16)) {
    let Some(groups) = read_u32(data, offset.saturating_add(12)) else {
        return;
    };
    for index in 0..usize::try_from(groups).unwrap_or(0).min(MAX_REVERSE_CODES) {
        let base = offset.saturating_add(index.saturating_mul(12).saturating_add(16));
        let (Some(start), Some(end), Some(first)) = (
            read_u32(data, base),
            read_u32(data, base.saturating_add(4)),
            read_u32(data, base.saturating_add(8)),
        ) else {
            return;
        };
        if end < start {
            continue;
        }
        for step in 0..=end.saturating_sub(start) {
            if !spend(budget) {
                return;
            }
            let Ok(gid) = u16::try_from(first.saturating_add(step)) else {
                break;
            };
            if gid != 0 {
                visit(start.saturating_add(step), gid);
            }
        }
    }
}
