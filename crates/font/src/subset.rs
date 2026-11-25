use crate::cff_subset;
use alloc::collections::{BTreeMap, BTreeSet};
use core::fmt::Write as _;

use crate::{read_u16, read_u32, sfnt::Face};

#[derive(Debug, Default)]
pub struct GlyphSet {
    chars: BTreeMap<char, u16>,
    entries: Vec<(char, u16)>,
}

#[derive(Debug)]
#[non_exhaustive]
pub struct Subset {
    pub cff: bool,
    pub cmap: Vec<u8>,
    pub glyph_map: Vec<u8>,
    pub program: Vec<u8>,
    pub widths: Vec<f64>,
}

impl GlyphSet {
    #[inline]
    pub fn cid(&mut self, character: char, glyph: u16) -> Option<u16> {
        if let Some(cid) = self.chars.get(&character) {
            return Some(*cid);
        }

        let cid = u16::try_from(self.entries.len().checked_add(1)?).ok()?;
        let _previous: Option<u16> = self.chars.insert(character, cid);
        self.entries.push((character, glyph));
        Some(cid)
    }

    #[inline]
    #[must_use]
    pub const fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    #[inline]
    #[must_use]
    pub fn subset(&self, face: &Face<'_>, name: &str) -> Option<Subset> {
        let mut glyph_map = vec![0_u8; 2];
        let mut widths = Vec::with_capacity(self.entries.len());
        for &(_, glyph) in &self.entries {
            glyph_map.extend_from_slice(&glyph.to_be_bytes());
            widths.push(face.width(glyph)?);
        }
        let cff = face.table(*b"CFF ").is_some();
        let program = if cff {
            cff_subset::subset(face, &self.entries, name)?
        } else {
            subset_glyf(face, &self.entries, name)?
        };
        Some(Subset {
            cff,
            cmap: to_unicode(&self.entries)?.into_bytes(),
            glyph_map,
            program,
            widths,
        })
    }
}

fn to_unicode(entries: &[(char, u16)]) -> Option<String> {
    let mut result = String::from(
        "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /SignatureKit-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n",
    );
    for (index, chunk) in entries.chunks(100).enumerate() {
        writeln!(result, "{} beginbfchar", chunk.len()).ok()?;
        for (offset, &(character, _)) in chunk.iter().enumerate() {
            let cid = index
                .saturating_mul(100)
                .saturating_add(offset)
                .saturating_add(1);
            write!(result, "<{cid:04X}> <").ok()?;
            for unit in character.encode_utf16(&mut [0_u16; 2]) {
                write!(result, "{unit:04X}").ok()?;
            }
            result.push_str(">\n");
        }
        result.push_str("endbfchar\n");
    }
    result.push_str("endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n");
    Some(result)
}

fn subset_glyf(face: &Face<'_>, entries: &[(char, u16)], name: &str) -> Option<Vec<u8>> {
    let mut head = face.table(*b"head")?.to_vec();
    let long = read_u16(&head, 50)? != 0;
    let old_loca = face.table(*b"loca")?;
    let old_glyf = face.table(*b"glyf")?;
    let glyph_data = |glyph: u16| {
        let at = usize::from(glyph);
        let start = loca_offset(old_loca, long, at)?;
        let end = loca_offset(old_loca, long, at.checked_add(1)?)?;
        old_glyf.get(start..end)
    };
    let mut selected: BTreeSet<u16> = entries.iter().map(|entry| entry.1).chain([0]).collect();
    let mut pending: Vec<u16> = selected.iter().copied().collect();
    while let Some(glyph) = pending.pop() {
        if glyph >= face.glyphs {
            return None;
        }
        visit_components(glyph_data(glyph)?, &mut |component| {
            if selected.insert(component) {
                pending.push(component);
            }
        })?;
    }
    let mut glyf = Vec::new();
    let mut loca = Vec::new();
    for glyph in 0..face.glyphs {
        loca.extend_from_slice(&u32::try_from(glyf.len()).ok()?.to_be_bytes());
        if selected.contains(&glyph) {
            glyf.extend_from_slice(glyph_data(glyph)?);
            if glyf.len() & 1 != 0 {
                glyf.push(0);
            }
        }
    }
    loca.extend_from_slice(&u32::try_from(glyf.len()).ok()?.to_be_bytes());
    head.get_mut(8..12)?.fill(0);
    head.get_mut(50..52)?.copy_from_slice(&1_u16.to_be_bytes());
    let mut tables = BTreeMap::from([(*b"glyf", glyf), (*b"head", head), (*b"loca", loca)]);
    for tag in [
        b"OS/2", b"cvt ", b"fpgm", b"gasp", b"hhea", b"hmtx", b"maxp", b"prep",
    ] {
        if let Some(data) = face.table(*tag) {
            drop(tables.insert(*tag, data.to_vec()));
        }
    }
    drop(tables.insert(*b"cmap", subset_cmap(entries)?));
    drop(tables.insert(*b"name", subset_name(name)?));
    let mut post = face.table(*b"post")?.get(..32)?.to_vec();
    post.get_mut(..4)?
        .copy_from_slice(&0x0003_0000_u32.to_be_bytes());
    drop(tables.insert(*b"post", post));
    encode_sfnt(&tables)
}

fn subset_cmap(entries: &[(char, u16)]) -> Option<Vec<u8>> {
    let mut groups = entries.to_vec();
    groups.sort_unstable();
    let count = u32::try_from(groups.len()).ok()?;
    let mut bytes = Vec::new();
    for word in [0_u16, 1, 3, 10] {
        bytes.extend_from_slice(&word.to_be_bytes());
    }
    bytes.extend_from_slice(&12_u32.to_be_bytes());
    bytes.extend_from_slice(&12_u16.to_be_bytes());
    bytes.extend_from_slice(&0_u16.to_be_bytes());
    for word in [16_u32.checked_add(count.checked_mul(12)?)?, 0, count] {
        bytes.extend_from_slice(&word.to_be_bytes());
    }
    for (character, glyph) in groups {
        let code = u32::from(character);
        for word in [code, code, u32::from(glyph)] {
            bytes.extend_from_slice(&word.to_be_bytes());
        }
    }
    Some(bytes)
}

fn subset_name(name: &str) -> Option<Vec<u8>> {
    let names = [(1_u16, name), (2, "Regular"), (4, name), (6, name)];
    let count = u16::try_from(names.len()).ok()?;
    let mut storage = Vec::new();
    let mut bytes = Vec::new();
    for word in [0_u16, count, count.checked_mul(12)?.checked_add(6)?] {
        bytes.extend_from_slice(&word.to_be_bytes());
    }
    for (id, value) in names {
        let start = u16::try_from(storage.len()).ok()?;
        for unit in value.encode_utf16() {
            storage.extend_from_slice(&unit.to_be_bytes());
        }
        let length = u16::try_from(storage.len()).ok()?.checked_sub(start)?;
        for word in [3_u16, 1, 0x0409, id, length, start] {
            bytes.extend_from_slice(&word.to_be_bytes());
        }
    }
    bytes.extend_from_slice(&storage);
    Some(bytes)
}

fn loca_offset(bytes: &[u8], long: bool, index: usize) -> Option<usize> {
    if long {
        return usize::try_from(read_u32(bytes, index.checked_mul(4)?)?).ok();
    }
    usize::from(read_u16(bytes, index.checked_mul(2)?)?).checked_mul(2)
}

fn visit_components(glyph: &[u8], visit: &mut dyn FnMut(u16)) -> Option<()> {
    if glyph.is_empty() || read_u16(glyph, 0)?.cast_signed() >= 0 {
        return Some(());
    }
    let mut position = 10_usize;
    for _ in 0_u16..256 {
        let flags = read_u16(glyph, position)?;
        visit(read_u16(glyph, position.checked_add(2)?)?);
        let args = if flags & 1 == 0 { 2 } else { 4 };
        let scale = match flags & 0xC8 {
            8 => 2,
            0x40 => 4,
            0x80 => 8,
            _ => 0,
        };
        position = position
            .checked_add(4)?
            .checked_add(args)?
            .checked_add(scale)?;
        if flags & 0x20 == 0 {
            return Some(());
        }
    }
    None
}

fn encode_sfnt(tables: &BTreeMap<[u8; 4], Vec<u8>>) -> Option<Vec<u8>> {
    let count = u16::try_from(tables.len()).ok()?;
    let power = count.checked_next_power_of_two()?;
    let floor = if power == count {
        power
    } else {
        power >> 1_i32
    };
    let search_range = floor.checked_mul(16)?;
    let mut output = 0x0001_0000_u32.to_be_bytes().to_vec();
    for value in [
        count,
        search_range,
        u16::try_from(floor.ilog2()).ok()?,
        count.checked_mul(16)?.checked_sub(search_range)?,
    ] {
        output.extend_from_slice(&value.to_be_bytes());
    }
    let mut offset = 12_usize.checked_add(usize::from(count).checked_mul(16)?)?;
    let mut adjustment = 0_usize;
    for (tag, data) in tables {
        output.extend_from_slice(tag);
        for value in [
            checksum(data),
            u32::try_from(offset).ok()?,
            u32::try_from(data.len()).ok()?,
        ] {
            output.extend_from_slice(&value.to_be_bytes());
        }
        if tag == b"head" {
            adjustment = offset.checked_add(8)?;
        }
        offset = offset.checked_add(data.len().checked_next_multiple_of(4)?)?;
    }
    for data in tables.values() {
        output.extend_from_slice(data);
        output.resize(output.len().checked_next_multiple_of(4)?, 0);
    }
    let adjustment_value = 0xB1B0_AFBA_u32.wrapping_sub(checksum(&output));
    output
        .get_mut(adjustment..adjustment.checked_add(4)?)?
        .copy_from_slice(&adjustment_value.to_be_bytes());
    Some(output)
}

fn checksum(data: &[u8]) -> u32 {
    data.chunks(4).fold(0_u32, |sum, chunk| {
        let mut word = [0_u8; 4];
        if let Some(prefix) = word.get_mut(..chunk.len()) {
            prefix.copy_from_slice(chunk);
        }
        sum.wrapping_add(u32::from_be_bytes(word))
    })
}

#[cfg(test)]
mod tests {
    use core::str;

    use super::*;

    #[test]
    fn preserves_composite_glyph_metrics_and_unicode() {
        let round_trip = || {
            let bytes =
                include_bytes!("../../../packages/engine/assets/fonts/IBMPlexSans-Regular.ttf");
            let face = Face::parse(bytes)?;
            let mut glyphs = GlyphSet::default();
            let glyph = face.glyph('\u{e7}')?;
            let cid = glyphs.cid('\u{e7}', glyph)?;
            let supplementary = glyphs.cid('\u{1F642}', glyph)?;
            let subset = glyphs.subset(&face, "SIGKIT+Test")?;
            let smaller = Face::parse(&subset.program)?;
            let cmap = str::from_utf8(&subset.cmap).ok()?;
            Some((
                cid,
                supplementary,
                smaller.glyph('\u{e7}') == Some(glyph),
                smaller.width(glyph).map(f64::to_bits) == face.width(glyph).map(f64::to_bits),
                cmap.contains("<0001> <00E7>"),
                cmap.contains("<0002> <D83DDE42>"),
                subset.program.len() < bytes.len(),
            ))
        };
        assert_eq!(round_trip(), Some((1, 2, true, true, true, true, true)));
    }
}
