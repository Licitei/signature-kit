include!(concat!(env!("OUT_DIR"), "/cff_tables.rs"));

const MAX_GLYPHS: usize = 65_535;
const MAX_DICT_ENTRIES: usize = 256;
const MAX_OPERANDS: usize = 48;
const MAX_CUSTOM_STRINGS: usize = 65_535;
const ISO_ADOBE_LAST_SID: usize = 228;
const OP_CHARSET: u16 = 15;
const OP_ENCODING: u16 = 16;
const OP_CHARSTRINGS: u16 = 17;
const OP_ROS: u16 = 0x0C1E;

#[derive(Clone, Debug, PartialEq, Eq)]
enum BuiltinEncoding {
    Standard,
    Expert,
    Table(Vec<u16>),
}

#[derive(Clone, Debug)]
pub(crate) struct CffFont {
    glyph_count: usize,
    cid_keyed: bool,
    charset: Vec<u16>,
    custom_strings: Vec<Vec<u8>>,
    encoding: BuiltinEncoding,
    cid_index: Vec<(u16, u16)>,
}

struct Index {
    count: usize,
    off_size: usize,
    offsets: usize,
    data: usize,
    end: usize,
}

impl Index {
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
            off_size,
            offsets,
            data,
            end,
        })
    }

    fn get<'a>(&self, bytes: &'a [u8], item: usize) -> Option<&'a [u8]> {
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
}

impl CffFont {
    pub(crate) fn parse(bytes: &[u8]) -> Option<Self> {
        if *bytes.first()? != 1 {
            return None;
        }
        let header_size = usize::from(*bytes.get(2)?);
        let names = Index::parse(bytes, header_size)?;
        let top_dicts = Index::parse(bytes, names.end)?;
        let strings = Index::parse(bytes, top_dicts.end)?;
        let top = parse_dict(top_dicts.get(bytes, 0)?);
        let operand = |op: u16| {
            top.iter()
                .find(|(key, _)| *key == op)
                .and_then(|(_, values)| values.first().copied())
        };
        let charstrings = usize::try_from(operand(OP_CHARSTRINGS)?).ok()?;
        let glyph_count = Index::parse(bytes, charstrings)?.count;
        if glyph_count == 0 || glyph_count > MAX_GLYPHS {
            return None;
        }
        let cid_keyed = top.iter().any(|(key, _)| *key == OP_ROS);
        let charset_offset = operand(OP_CHARSET).unwrap_or(0);
        let charset = read_charset(bytes, charset_offset, glyph_count, cid_keyed)?;
        let mut custom_strings = Vec::new();
        for item in 0..strings.count.min(MAX_CUSTOM_STRINGS) {
            custom_strings.push(strings.get(bytes, item)?.to_vec());
        }
        let encoding = if cid_keyed {
            BuiltinEncoding::Table(Vec::new())
        } else {
            read_encoding(bytes, operand(OP_ENCODING).unwrap_or(0), &charset)?
        };
        let mut cid_index = Vec::new();
        if cid_keyed {
            cid_index = charset
                .iter()
                .enumerate()
                .filter_map(|(gid, cid)| u16::try_from(gid).ok().map(|gid| (*cid, gid)))
                .collect();
            cid_index.sort_by_key(|(cid, _)| *cid);
        }
        Some(Self {
            glyph_count,
            cid_keyed,
            charset,
            custom_strings,
            encoding,
            cid_index,
        })
    }

    pub(crate) const fn glyph_count(&self) -> usize {
        self.glyph_count
    }

    pub(crate) const fn is_cid_keyed(&self) -> bool {
        self.cid_keyed
    }

    pub(crate) fn glyph_name(&self, gid: u16) -> Option<&[u8]> {
        if self.cid_keyed {
            return None;
        }
        self.sid_name(*self.charset.get(usize::from(gid))?)
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

    pub(crate) fn cid_for_gid(&self, gid: u16) -> Option<u16> {
        if self.cid_keyed {
            self.charset.get(usize::from(gid)).copied()
        } else {
            (usize::from(gid) < self.glyph_count).then_some(gid)
        }
    }

    pub(crate) fn builtin_name(&self, code: u8) -> Option<&[u8]> {
        match &self.encoding {
            BuiltinEncoding::Standard => {
                let name = crate::font_tables::encoding_glyph_name(
                    crate::font_tables::BuiltinEncoding::Standard,
                    code,
                );
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

    fn sid_name(&self, sid: u16) -> Option<&[u8]> {
        let sid = usize::from(sid);
        match CFF_STANDARD_STRINGS.get(sid) {
            Some(name) => Some(name.as_bytes()),
            None => self
                .custom_strings
                .get(sid.checked_sub(CFF_STANDARD_STRINGS.len())?)
                .map(Vec::as_slice),
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
    if offset <= 2 {
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
                gid += 1;
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
                    gid += 1;
                }
            }
        }
        _ => return None,
    }
    Some(charset)
}

fn read_encoding(bytes: &[u8], offset: i32, charset: &[u16]) -> Option<BuiltinEncoding> {
    match offset {
        0 => return Some(BuiltinEncoding::Standard),
        1 => return Some(BuiltinEncoding::Expert),
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

fn parse_dict(bytes: &[u8]) -> Vec<(u16, Vec<i32>)> {
    let mut entries: Vec<(u16, Vec<i32>)> = Vec::new();
    let mut operands: Vec<i32> = Vec::new();
    let mut position = 0_usize;
    while let Some(&byte) = bytes.get(position) {
        position += 1;
        match byte {
            0..=21 => {
                let op = if byte == 12 {
                    let next = bytes.get(position).copied().unwrap_or(0);
                    position += 1;
                    0x0C00 | u16::from(next)
                } else {
                    u16::from(byte)
                };
                if entries.len() >= MAX_DICT_ENTRIES {
                    break;
                }
                entries.push((op, std::mem::take(&mut operands)));
            }
            28 => {
                let value = read_u16(bytes, position).map(|value| i32::from(value as i16));
                position += 2;
                push_operand(&mut operands, value.unwrap_or(0));
            }
            29 => {
                let value = read_u32(bytes, position).map(|value| value as i32);
                position += 4;
                push_operand(&mut operands, value.unwrap_or(0));
            }
            30 => {
                while let Some(&pair) = bytes.get(position) {
                    position += 1;
                    if pair & 0x0F == 0x0F || pair >> 4 == 0x0F {
                        break;
                    }
                }
                push_operand(&mut operands, 0);
            }
            32..=246 => push_operand(&mut operands, i32::from(byte) - 139),
            247..=250 => {
                let next = i32::from(bytes.get(position).copied().unwrap_or(0));
                position += 1;
                push_operand(&mut operands, (i32::from(byte) - 247) * 256 + next + 108);
            }
            251..=254 => {
                let next = i32::from(bytes.get(position).copied().unwrap_or(0));
                position += 1;
                push_operand(&mut operands, -(i32::from(byte) - 251) * 256 - next - 108);
            }
            _ => {}
        }
    }
    entries
}

fn push_operand(operands: &mut Vec<i32>, value: i32) {
    if operands.len() < MAX_OPERANDS {
        operands.push(value);
    }
}

fn read_offset(bytes: &[u8], position: usize, size: usize) -> Option<usize> {
    let mut value = 0_usize;
    for step in 0..size {
        value = (value << 8) | usize::from(*bytes.get(position.checked_add(step)?)?);
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
#[expect(clippy::indexing_slicing, clippy::expect_used)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn index(items: &[&[u8]]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&(items.len() as u16).to_be_bytes());
        if items.is_empty() {
            return out;
        }
        out.push(2);
        let mut offset = 1_u16;
        out.extend_from_slice(&offset.to_be_bytes());
        for item in items {
            offset += item.len() as u16;
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

    pub(crate) struct Layout {
        pub names: Vec<&'static str>,
        pub charset: Vec<u8>,
        pub charset_id: i32,
        pub encoding: Vec<u8>,
        pub encoding_id: i32,
        pub cid_keyed: bool,
        pub glyphs: usize,
    }

    pub(crate) fn build(layout: &Layout) -> Vec<u8> {
        let mut customs: Vec<Vec<u8>> = Vec::new();
        for name in &layout.names {
            customs.push(name.as_bytes().to_vec());
        }
        let custom_refs: Vec<&[u8]> = customs.iter().map(Vec::as_slice).collect();
        let strings = index(&custom_refs);
        let charstring_items: Vec<&[u8]> = (0..layout.glyphs).map(|_| [14_u8].as_slice()).collect();
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
        let probe = index(&[&dict_len(0, 0, 0)]);
        let base = header.len() + name_index.len() + probe.len() + strings.len() + 2;
        let charset_off = if layout.charset.is_empty() {
            layout.charset_id
        } else {
            base as i32
        };
        let enc_off = if layout.encoding.is_empty() {
            layout.encoding_id
        } else {
            (base + layout.charset.len()) as i32
        };
        let cs_off = (base + layout.charset.len() + layout.encoding.len()) as i32;
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
            let len = 8 + round % 96;
            let mut data = vec![0_u8; len];
            for slot in &mut data {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                *slot = (seed >> 24) as u8;
            }
            if let Some(first) = data.first_mut() {
                *first = 1;
            }
            let _ = CffFont::parse(&data);
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
                let _ = CffFont::parse(&data);
            }
        }
        for cut in 0..valid.len() {
            let _ = CffFont::parse(&valid[..cut]);
        }
    }
}
