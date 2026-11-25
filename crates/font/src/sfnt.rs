use crate::cmap::{Subtable, lookup, read_cmap_directory};
use crate::gpos::Kerning;
use crate::{read_u16, read_u32};
use core::cmp::Ordering;

#[derive(Debug)]
pub struct Face<'data> {
    advances: &'data [u8],
    pub(crate) bytes: &'data [u8],
    cmaps: Vec<Subtable>,
    pub(crate) glyphs: u16,
    h_metrics: u16,
    kerning: Kerning<'data>,
    legacy: Option<&'data [u8]>,
    pub(crate) units: u16,
}

impl<'data> Face<'data> {
    #[inline]
    #[must_use]
    pub fn bounds(&self) -> Option<[f64; 4]> {
        let head = self.table(*b"head")?;
        let unit = 1000.0_f64 / f64::from(self.units);
        Some([
            f64::from(read_u16(head, 36)?.cast_signed()) * unit,
            f64::from(read_u16(head, 38)?.cast_signed()) * unit,
            f64::from(read_u16(head, 40)?.cast_signed()) * unit,
            f64::from(read_u16(head, 42)?.cast_signed()) * unit,
        ])
    }

    #[inline]
    #[must_use]
    pub fn glyph(&self, character: char) -> Option<u16> {
        self.cmaps
            .iter()
            .filter(|sub| {
                sub.platform == 0 || (sub.platform == 3 && matches!(sub.encoding, 1 | 10))
            })
            .find_map(|sub| lookup(self.bytes, *sub, u32::from(character)))
            .filter(|glyph| *glyph < self.glyphs)
    }

    #[inline]
    #[must_use]
    pub fn kern(&self, left: u16, right: u16) -> f64 {
        let value = if self.kerning.is_empty() {
            self.legacy
                .and_then(|table| legacy_kern(table, left, right))
                .map_or(0_i32, i32::from)
        } else {
            self.kerning.pair(left, right)
        };
        f64::from(value) * 1000.0_f64 / f64::from(self.units)
    }

    #[inline]
    #[must_use]
    pub fn parse(bytes: &'data [u8]) -> Option<Self> {
        if !matches!(read_u32(bytes, 0)?, 0x0001_0000 | 0x4F54_544F | 0x7472_7565) {
            return None;
        }

        let table = |tag| {
            let (_, start, end) = tables(bytes)?.find(|entry| entry.0 == tag)?;
            bytes.get(start..end)
        };
        let (_, start, end) = tables(bytes)?.find(|entry| &entry.0 == b"cmap")?;
        let glyphs = read_u16(table(*b"maxp")?, 4)?;
        let units = read_u16(table(*b"head")?, 18)?;
        let h_metrics = read_u16(table(*b"hhea")?, 34)?;
        if units < 16 || glyphs == 0 || h_metrics == 0 || h_metrics > glyphs {
            return None;
        }
        Some(Self {
            bytes,
            cmaps: read_cmap_directory(bytes, start, end),
            glyphs,
            h_metrics,
            advances: table(*b"hmtx")?,
            legacy: table(*b"kern"),
            kerning: table(*b"GPOS").and_then(Kerning::parse).unwrap_or_default(),
            units,
        })
    }

    pub(crate) fn table(&self, tag: [u8; 4]) -> Option<&'data [u8]> {
        let (_, start, end) = tables(self.bytes)?.find(|entry| entry.0 == tag)?;
        self.bytes.get(start..end)
    }

    #[inline]
    #[must_use]
    pub fn width(&self, glyph: u16) -> Option<f64> {
        let advance = read_u16(
            self.advances,
            usize::from(glyph.min(self.h_metrics.saturating_sub(1))).saturating_mul(4),
        )?;
        Some(f64::from(advance) * 1000.0_f64 / f64::from(self.units))
    }
}
#[inline]
#[must_use]
pub fn tables(bytes: &[u8]) -> Option<impl Iterator<Item = ([u8; 4], usize, usize)> + '_> {
    let count = usize::from(read_u16(bytes, 4)?);
    if count == 0 || count > 128 {
        return None;
    }
    let directory = bytes.get(12..12_usize.checked_add(count.checked_mul(16)?)?)?;
    Some(directory.as_chunks::<16>().0.iter().filter_map(|entry| {
        let tag = entry.first_chunk::<4>().copied()?;
        let start = usize::try_from(read_u32(entry, 8)?).ok()?;
        let size = usize::try_from(read_u32(entry, 12)?).ok()?;
        let end = start.checked_add(size)?;
        (size > 0 && end <= bytes.len()).then_some((tag, start, end))
    }))
}

fn legacy_kern(table: &[u8], left: u16, right: u16) -> Option<i16> {
    if read_u16(table, 0)? != 0 {
        return None;
    }
    let mut position = 4_usize;
    let pair = (u32::from(left) << 16_i32) | u32::from(right);
    for _ in 0..read_u16(table, 2)?.min(128) {
        let end = position.checked_add(usize::from(read_u16(table, position.checked_add(2)?)?))?;
        let part = table.get(position..end)?;
        position = end;
        if read_u16(part, 4)? != 1 {
            continue;
        }
        let count = usize::from(read_u16(part, 6)?);
        let records = part.get(14..14_usize.checked_add(count.checked_mul(6)?)?)?;
        let mut low = 0_usize;
        let mut high = count;
        while low < high {
            let mid = low.midpoint(high);
            let at = mid.saturating_mul(6);
            match read_u32(records, at)?.cmp(&pair) {
                Ordering::Less => low = mid.saturating_add(1),
                Ordering::Greater => high = mid,
                Ordering::Equal => {
                    return Some(read_u16(records, at.checked_add(4)?)?.cast_signed());
                }
            }
        }
    }
    None
}
