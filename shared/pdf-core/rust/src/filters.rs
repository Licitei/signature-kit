use crate::failure::{Failure, FailureCode, Outcome};
use crate::inflate;
use crate::object::{Dict, Object};

type FilterChain<'a> = (Vec<Vec<u8>>, Vec<Option<&'a Dict>>);

const IMAGE_FILTERS: [&[u8]; 4] = [
    b"DCTDecode",
    b"JPXDecode",
    b"CCITTFaxDecode",
    b"JBIG2Decode",
];

pub(crate) fn decode_stream(dict: &Dict, raw: &[u8], max_output: usize) -> Outcome<Vec<u8>> {
    let (filters, parms) = parse_filter_chain(dict)?;
    if filters.is_empty() {
        if raw.len() > max_output {
            return Err(Failure::limit("decoded stream exceeds limit"));
        }
        return Ok(raw.to_vec());
    }
    let mut data = raw.to_vec();
    for (index, filter) in filters.iter().enumerate() {
        let last = index.saturating_add(1) == filters.len();
        let parms = parms.get(index).copied().flatten();
        data = apply_filter(filter, parms, &data, max_output, last)?;
    }
    Ok(data)
}

fn parse_filter_chain(dict: &Dict) -> Outcome<FilterChain<'_>> {
    let filter_key = dict.get(b"Filter");
    let parms_key = dict.get(b"DecodeParms").or_else(|| dict.get(b"DP"));
    match filter_key {
        None => Ok((Vec::new(), Vec::new())),
        Some(Object::Name(name)) => {
            if matches!(parms_key, Some(Object::Ref(_))) {
                return Err(Failure::invalid("indirect decode parms"));
            }
            let parms = match parms_key {
                None | Some(Object::Null) => vec![None],
                Some(Object::Dict(d)) => vec![Some(d)],
                Some(_) => return Err(Failure::invalid("decode parms shape")),
            };
            Ok((vec![name.clone()], parms))
        }
        Some(Object::Array(items)) => {
            if matches!(parms_key, Some(Object::Ref(_))) {
                return Err(Failure::invalid("indirect decode parms"));
            }
            let mut filters = Vec::with_capacity(items.len());
            for item in items {
                match item {
                    Object::Name(name) => filters.push(name.clone()),
                    Object::Ref(_) => return Err(Failure::invalid("indirect filter name")),
                    _ => return Err(Failure::invalid("filter entry is not a name")),
                }
            }
            let parms = match parms_key {
                None | Some(Object::Null) => vec![None; filters.len()],
                Some(Object::Array(items)) => {
                    if items.len() != filters.len() {
                        return Err(Failure::invalid("decode parms array length"));
                    }
                    let mut out = Vec::with_capacity(items.len());
                    for item in items {
                        match item {
                            Object::Null => out.push(None),
                            Object::Dict(d) => out.push(Some(d)),
                            Object::Ref(_) => {
                                return Err(Failure::invalid("indirect decode parms"));
                            }
                            _ => return Err(Failure::invalid("decode parms entry")),
                        }
                    }
                    out
                }
                Some(Object::Dict(d)) => {
                    if filters.len() != 1 {
                        return Err(Failure::invalid("decode parms dict for multiple filters"));
                    }
                    vec![Some(d)]
                }
                Some(_) => return Err(Failure::invalid("decode parms shape")),
            };
            Ok((filters, parms))
        }
        Some(Object::Ref(_)) => Err(Failure::invalid("indirect filter")),
        Some(_) => Err(Failure::invalid("filter is not a name or array")),
    }
}

fn apply_filter(
    name: &[u8],
    parms: Option<&Dict>,
    data: &[u8],
    max_output: usize,
    last: bool,
) -> Outcome<Vec<u8>> {
    if is_image_filter(name) {
        if last {
            if data.len() > max_output {
                return Err(Failure::limit("decoded stream exceeds limit"));
            }
            return Ok(data.to_vec());
        }
        return Err(Failure::new(
            FailureCode::UnsupportedFeature,
            "image filter before non-image stage",
        ));
    }
    if name_matches(name, b"Crypt") {
        return crypt_identity(parms, data, max_output);
    }
    if name_matches(name, b"FlateDecode") {
        return flate_decode(parms, data, max_output);
    }
    if name_matches(name, b"LZWDecode") {
        return lzw_decode(parms, data, max_output);
    }
    if name_matches(name, b"ASCIIHexDecode") {
        return ascii_hex_decode(data, max_output);
    }
    if name_matches(name, b"ASCII85Decode") {
        return ascii85_decode(data, max_output);
    }
    if name_matches(name, b"RunLengthDecode") {
        return run_length_decode(data, max_output);
    }
    Err(Failure::new(
        FailureCode::UnsupportedFeature,
        "unknown stream filter",
    ))
}

fn name_matches(name: &[u8], full: &[u8]) -> bool {
    name == full || abbrev_matches(name, full)
}

fn abbrev_matches(name: &[u8], full: &[u8]) -> bool {
    match full {
        b"FlateDecode" => name == b"Fl",
        b"ASCIIHexDecode" => name == b"AHx",
        b"ASCII85Decode" => name == b"A85",
        b"LZWDecode" => name == b"LZW",
        b"RunLengthDecode" => name == b"RL",
        _ => false,
    }
}

fn is_image_filter(name: &[u8]) -> bool {
    IMAGE_FILTERS
        .iter()
        .any(|full| name == *full || abbrev_matches(name, full))
}

fn crypt_identity(parms: Option<&Dict>, data: &[u8], max_output: usize) -> Outcome<Vec<u8>> {
    if let Some(dict) = parms
        && let Some(Object::Name(name)) = dict.get(b"Name")
        && name != b"Identity"
    {
        return Err(Failure::new(
            FailureCode::UnsupportedFeature,
            "non-identity crypt filter",
        ));
    }
    if data.len() > max_output {
        return Err(Failure::limit("decoded stream exceeds limit"));
    }
    Ok(data.to_vec())
}

fn flate_decode(parms: Option<&Dict>, data: &[u8], max_output: usize) -> Outcome<Vec<u8>> {
    let mut decoded = inflate::inflate(data, max_output)?;
    apply_predictor(parms, &mut decoded, max_output)?;
    Ok(decoded)
}

fn lzw_decode(parms: Option<&Dict>, data: &[u8], max_output: usize) -> Outcome<Vec<u8>> {
    let early_change = parms
        .and_then(|d| d.get(b"EarlyChange"))
        .and_then(Object::as_integer)
        != Some(0);
    let mut decoded = lzw_expand(data, early_change, max_output)?;
    apply_predictor(parms, &mut decoded, max_output)?;
    Ok(decoded)
}

fn ascii_hex_decode(data: &[u8], max_output: usize) -> Outcome<Vec<u8>> {
    let mut out = Vec::with_capacity(data.len() / 2);
    let mut hi: Option<u8> = None;
    for &byte in data {
        if byte == b'>' {
            break;
        }
        if is_ws(byte) {
            continue;
        }
        let Some(nibble) = hex_digit(byte) else {
            return Err(Failure::invalid("invalid ascii hex digit"));
        };
        match hi {
            None => hi = Some(nibble),
            Some(high) => {
                if out.len() >= max_output {
                    return Err(Failure::limit("decoded stream exceeds limit"));
                }
                out.push(high.saturating_mul(16) | nibble);
                hi = None;
            }
        }
    }
    if let Some(high) = hi {
        if out.len() >= max_output {
            return Err(Failure::limit("decoded stream exceeds limit"));
        }
        out.push(high.saturating_mul(16));
    }
    Ok(out)
}

fn ascii85_decode(data: &[u8], max_output: usize) -> Outcome<Vec<u8>> {
    let mut out = Vec::with_capacity(data.len());
    let mut group: Vec<u8> = Vec::with_capacity(5);
    for &byte in data {
        if byte == b'~' {
            break;
        }
        if is_ws(byte) {
            continue;
        }
        if byte == b'z' {
            if !group.is_empty() {
                return Err(Failure::invalid("ascii85 z in partial group"));
            }
            if out.len().saturating_add(4) > max_output {
                return Err(Failure::limit("decoded stream exceeds limit"));
            }
            out.extend_from_slice(&[0, 0, 0, 0]);
            continue;
        }
        group.push(byte);
        if group.len() == 5 {
            push_ascii85_group(&mut out, &group, false, max_output)?;
            group.clear();
        }
    }
    if !group.is_empty() {
        push_ascii85_group(&mut out, &group, true, max_output)?;
    }
    Ok(out)
}

fn push_ascii85_group(
    out: &mut Vec<u8>,
    group: &[u8],
    partial: bool,
    max_output: usize,
) -> Outcome<()> {
    let mut chars = [b'u'; 5];
    for (dst, &src) in chars.iter_mut().zip(group.iter()) {
        *dst = src;
    }
    let mut value = 0_u32;
    for i in 0..5 {
        let b = chars
            .get(i)
            .copied()
            .ok_or_else(|| Failure::invalid("ascii85 char"))?;
        if !(0x21..=0x75).contains(&b) {
            return Err(Failure::invalid("ascii85 character out of range"));
        }
        value = value
            .saturating_mul(85)
            .saturating_add(u32::from(b.saturating_sub(0x21)));
    }
    let emit = if partial {
        group.len().saturating_sub(1)
    } else {
        4_usize
    };
    for index in 0..emit {
        if out.len() >= max_output {
            return Err(Failure::limit("decoded stream exceeds limit"));
        }
        let shift = (3_usize.saturating_sub(index)).saturating_mul(8);
        out.push((value >> shift) as u8);
    }
    Ok(())
}

fn run_length_decode(data: &[u8], max_output: usize) -> Outcome<Vec<u8>> {
    let mut out = Vec::with_capacity(data.len().saturating_mul(2));
    let mut index = 0_usize;
    while index < data.len() {
        let byte = *data
            .get(index)
            .ok_or_else(|| Failure::invalid("run length byte"))?;
        index = index.saturating_add(1);
        if byte == 128 {
            break;
        }
        if byte < 128 {
            let run = usize::from(byte.saturating_add(1));
            for _ in 0..run {
                let b = *data
                    .get(index)
                    .ok_or_else(|| Failure::invalid("run length copy"))?;
                if out.len() >= max_output {
                    return Err(Failure::limit("decoded stream exceeds limit"));
                }
                out.push(b);
                index = index.saturating_add(1);
            }
        } else {
            let b = *data
                .get(index)
                .ok_or_else(|| Failure::invalid("run length repeat"))?;
            index = index.saturating_add(1);
            let repeat = usize::from(257_u16.saturating_sub(u16::from(byte)));
            for _ in 0..repeat {
                if out.len() >= max_output {
                    return Err(Failure::limit("decoded stream exceeds limit"));
                }
                out.push(b);
            }
        }
    }
    Ok(out)
}

fn lzw_expand(data: &[u8], early_change: bool, max_output: usize) -> Outcome<Vec<u8>> {
    let mut dict: Vec<Vec<u8>> = Vec::with_capacity(4096);
    for i in 0..256_usize {
        dict.push(vec![i as u8]);
    }
    dict.push(vec![]);
    dict.push(vec![]);
    let mut out = Vec::with_capacity(data.len().saturating_mul(2));
    let mut code_bits = 9_u8;
    let clear_code = 256_u16;
    let eod_code = 257_u16;
    let mut next_code = 258_u16;
    let mut previous: Option<u16> = None;
    let mut bit_buf = 0_u32;
    let mut bit_count = 0_u8;
    let mut pos = 0_usize;
    loop {
        while bit_count < code_bits {
            let Some(byte) = data.get(pos) else {
                return if out.is_empty() {
                    Err(Failure::invalid("truncated lzw stream"))
                } else {
                    Ok(out)
                };
            };
            pos = pos.saturating_add(1);
            bit_buf |= u32::from(*byte) << bit_count;
            bit_count = bit_count.saturating_add(8);
        }
        let mask = (1_u32 << code_bits).wrapping_sub(1);
        let code = (bit_buf & mask) as u16;
        bit_buf >>= code_bits;
        bit_count = bit_count.saturating_sub(code_bits);
        if code == clear_code {
            dict.truncate(258);
            code_bits = 9;
            next_code = 258;
            previous = None;
            continue;
        }
        if code == eod_code {
            break;
        }
        let entry = if usize::from(code) < dict.len() {
            dict.get(usize::from(code)).cloned()
        } else if let Some(prev) = previous {
            let mut base = dict
                .get(usize::from(prev))
                .ok_or_else(|| Failure::invalid("lzw previous"))?
                .clone();
            if let Some(first) = base.first().copied() {
                base.push(first);
                Some(base)
            } else {
                None
            }
        } else {
            None
        };
        let Some(bytes) = entry else {
            return Err(Failure::invalid("lzw code missing"));
        };
        if out.len().saturating_add(bytes.len()) > max_output {
            return Err(Failure::limit("decoded stream exceeds limit"));
        }
        out.extend_from_slice(&bytes);
        if let Some(prev) = previous {
            let prev_entry = dict
                .get(usize::from(prev))
                .ok_or_else(|| Failure::invalid("lzw previous entry"))?;
            let mut next_entry = prev_entry.clone();
            if let Some(first) = bytes.first().copied() {
                next_entry.push(first);
            }
            while dict.len() <= usize::from(next_code) {
                dict.push(Vec::new());
            }
            if let Some(slot) = dict.get_mut(usize::from(next_code)) {
                *slot = next_entry;
            }
            next_code = next_code.saturating_add(1);
            if early_change {
                if next_code == (1_u16 << code_bits).saturating_sub(1) && code_bits < 12 {
                    code_bits = code_bits.saturating_add(1);
                }
            } else if next_code == 1_u16 << code_bits && code_bits < 12 {
                code_bits = code_bits.saturating_add(1);
            }
        }
        previous = Some(code);
    }
    Ok(out)
}

fn predictor_value(parms: Option<&Dict>) -> i64 {
    parms
        .and_then(|d| d.get(b"Predictor"))
        .and_then(Object::as_integer)
        .unwrap_or(1)
}

fn apply_predictor(parms: Option<&Dict>, data: &mut Vec<u8>, max_output: usize) -> Outcome<()> {
    let predictor = predictor_value(parms);
    if predictor <= 1 {
        if data.len() > max_output {
            return Err(Failure::limit("decoded stream exceeds limit"));
        }
        return Ok(());
    }
    let colors = usize_from(parms, b"Colors", 1)?;
    let bpc = usize_from(parms, b"BitsPerComponent", 8)?;
    let columns = usize_from(parms, b"Columns", 1)?;
    let row_bytes = columns
        .saturating_mul(colors)
        .saturating_mul(bpc)
        .saturating_add(7)
        / 8;
    if predictor == 2 {
        tiff_predict(data, row_bytes, max_output)?;
    } else if (10..=15).contains(&predictor) {
        png_predict(data, row_bytes, predictor, max_output)?;
    } else if predictor != 1 {
        return Err(Failure::new(
            FailureCode::UnsupportedFeature,
            "unsupported predictor",
        ));
    }
    if data.len() > max_output {
        return Err(Failure::limit("decoded stream exceeds limit"));
    }
    Ok(())
}

fn usize_from(parms: Option<&Dict>, key: &[u8], default: usize) -> Outcome<usize> {
    let value = match parms.and_then(|d| d.get(key)) {
        None => return Ok(default),
        Some(o) => o
            .as_integer()
            .ok_or_else(|| Failure::invalid("predictor integer"))?,
    };
    if value < 0 {
        return Err(Failure::invalid("negative predictor parameter"));
    }
    usize::try_from(value).map_err(|_| Failure::invalid("predictor parameter overflow"))
}

fn tiff_predict(data: &mut [u8], row_bytes: usize, max_output: usize) -> Outcome<()> {
    if row_bytes == 0 || data.is_empty() {
        return Ok(());
    }
    let mut index = 0_usize;
    while index < data.len() {
        for col in 1..row_bytes {
            let cur_idx = index.saturating_add(col);
            if cur_idx >= max_output {
                return Err(Failure::limit("decoded stream exceeds limit"));
            }
            let left = data.get(cur_idx.saturating_sub(1)).copied().unwrap_or(0);
            let cur = data.get(cur_idx).copied().unwrap_or(0);
            if let Some(slot) = data.get_mut(cur_idx) {
                *slot = cur.wrapping_add(left);
            }
        }
        index = index.saturating_add(row_bytes);
    }
    Ok(())
}

fn png_predict(
    data: &mut Vec<u8>,
    row_bytes: usize,
    predictor: i64,
    max_output: usize,
) -> Outcome<()> {
    if row_bytes == 0 {
        data.clear();
        return Ok(());
    }
    let mut out = Vec::with_capacity(data.len());
    let mut pos = 0_usize;
    while pos < data.len() {
        let filter = *data
            .get(pos)
            .ok_or_else(|| Failure::invalid("png filter byte"))?;
        pos = pos.saturating_add(1);
        let row_end = pos.saturating_add(row_bytes);
        if row_end > data.len() {
            return if out.is_empty() {
                Err(Failure::invalid("truncated png predictor row"))
            } else if out.len() > max_output {
                Err(Failure::limit("decoded stream exceeds limit"))
            } else {
                *data = out;
                Ok(())
            };
        }
        let row = data
            .get(pos..row_end)
            .ok_or_else(|| Failure::invalid("png row"))?;
        let prev_start = out.len().saturating_sub(row_bytes);
        for (col, &raw) in row.iter().enumerate() {
            let up = if prev_start + col < out.len() {
                out.get(prev_start.saturating_add(col))
                    .copied()
                    .unwrap_or(0)
            } else {
                0
            };
            let left = if col > 0 {
                out.last().copied().unwrap_or(0)
            } else {
                0
            };
            let up_left = if col > 0 && prev_start + col > prev_start {
                out.get(prev_start.saturating_add(col).saturating_sub(1))
                    .copied()
                    .unwrap_or(0)
            } else {
                0
            };
            let filter_type = if predictor == 15 {
                filter
            } else {
                (predictor - 10) as u8
            };
            let value = paeth_filter(filter_type, raw, left, up, up_left);
            if out.len() >= max_output {
                return Err(Failure::limit("decoded stream exceeds limit"));
            }
            out.push(value);
        }
        pos = row_end;
    }
    if out.len() > max_output {
        return Err(Failure::limit("decoded stream exceeds limit"));
    }
    *data = out;
    Ok(())
}

fn paeth_filter(filter: u8, raw: u8, left: u8, up: u8, up_left: u8) -> u8 {
    let pred = match filter {
        0 => 0_u8,
        1 => left,
        2 => up,
        3 => avg(left, up),
        4 => paeth(left, up, up_left),
        _ => 0,
    };
    raw.wrapping_add(pred)
}

fn avg(left: u8, up: u8) -> u8 {
    let sum = u16::from(left).saturating_add(u16::from(up));
    (sum / 2) as u8
}

fn paeth(a: u8, b: u8, c: u8) -> u8 {
    let p = i16::from(a)
        .saturating_add(i16::from(b))
        .saturating_sub(i16::from(c));
    let pa = (p - i16::from(a)).abs();
    let pb = (p - i16::from(b)).abs();
    let pc = (p - i16::from(c)).abs();
    if pa <= pb && pa <= pc {
        a
    } else if pb <= pc {
        b
    } else {
        c
    }
}

const fn hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte.saturating_sub(b'0')),
        b'a'..=b'f' => Some(byte.saturating_sub(b'a').saturating_add(10)),
        b'A'..=b'F' => Some(byte.saturating_sub(b'A').saturating_add(10)),
        _ => None,
    }
}

const fn is_ws(byte: u8) -> bool {
    matches!(byte, 0 | 9 | 10 | 12 | 13 | 32)
}

#[cfg(test)]
#[expect(clippy::expect_used)]
mod tests {
    use super::*;
    use crate::object::Object;
    fn dict_filter(filter: &[u8], parms: Option<Object>) -> Dict {
        let mut dict = Dict::default();
        dict.insert(b"Filter", Object::Name(filter.to_vec()));
        if let Some(p) = parms {
            dict.insert(b"DecodeParms", p);
        }
        dict
    }

    fn dict_filter_chain(filters: Vec<&[u8]>, parms: Vec<Object>) -> Dict {
        let mut dict = Dict::default();
        dict.insert(
            b"Filter",
            Object::Array(
                filters
                    .into_iter()
                    .map(|f| Object::Name(f.to_vec()))
                    .collect(),
            ),
        );
        dict.insert(b"DecodeParms", Object::Array(parms));
        dict
    }

    #[test]
    fn flate_roundtrip() {
        let zlib = [
            0x78_u8, 0x9c, 0xcb, 0x48, 0xcd, 0xc9, 0xc9, 0x57, 0x28, 0xcf, 0x2f, 0xca, 0x49, 0x01,
            0x00, 0x1a, 0x0b, 0x04, 0x5d,
        ];
        let dict = dict_filter(b"FlateDecode", None);
        let out = decode_stream(&dict, &zlib, 1024).expect("flate");
        assert_eq!(out, b"hello world");
    }

    #[test]
    fn ascii_hex_roundtrip() {
        let hex = b"41 42 43>";
        let dict = dict_filter(b"AHx", None);
        let out = decode_stream(&dict, hex, 1024).expect("hex");
        assert_eq!(out, b"ABC");
    }

    #[test]
    fn ascii85_roundtrip() {
        let data = b"E,9)oF*2M7/c";
        let dict = dict_filter(b"A85", None);
        let out = decode_stream(&dict, data, 1024).expect("a85");
        assert_eq!(out, b"pleasure.");
    }

    #[test]
    fn run_length_roundtrip() {
        let raw = [3_u8, 97, 98, 99, 100, 254, 97, 128];
        let dict = dict_filter(b"RL", None);
        let out = decode_stream(&dict, &raw, 1024).expect("rl");
        assert_eq!(out, b"abcdaaa");
    }

    #[test]
    fn filter_chain_a85_flate() {
        let encoded = b"GaurJc,n(/.*jQh8HAf0$Ns`~>";
        let mut parms = Dict::default();
        parms.insert(b"Predictor", Object::Integer(1));
        let dict = dict_filter_chain(
            vec![b"ASCII85Decode", b"FlateDecode"],
            vec![Object::Null, Object::Dict(parms)],
        );
        let out = decode_stream(&dict, encoded, 1024).expect("chain");
        assert_eq!(out, b"hello world");
    }

    #[test]
    fn png_predictor_sub() {
        let mut dict = Dict::default();
        dict.insert(b"Filter", Object::Name(b"FlateDecode".to_vec()));
        let mut parms = Dict::default();
        parms.insert(b"Predictor", Object::Integer(11));
        parms.insert(b"Colors", Object::Integer(1));
        parms.insert(b"BitsPerComponent", Object::Integer(8));
        parms.insert(b"Columns", Object::Integer(2));
        dict.insert(b"DecodeParms", Object::Dict(parms));
        let stored = [
            0x78_u8, 0x01, 0x01, 0x03, 0x00, 0xfc, 0xff, 0x01, 0x01, 0x02, 0x00, 0x0a, 0x00, 0x05,
        ];
        let out = decode_stream(&dict, &stored, 1024).expect("png sub");
        assert_eq!(out, vec![1_u8, 3]);
    }

    #[test]
    fn tiff_predictor() {
        let mut dict = Dict::default();
        dict.insert(b"Filter", Object::Name(b"FlateDecode".to_vec()));
        let mut parms = Dict::default();
        parms.insert(b"Predictor", Object::Integer(2));
        parms.insert(b"Colors", Object::Integer(1));
        parms.insert(b"BitsPerComponent", Object::Integer(8));
        parms.insert(b"Columns", Object::Integer(2));
        dict.insert(b"DecodeParms", Object::Dict(parms));
        let stored = [
            0x78_u8, 0x01, 0x01, 0x04, 0x00, 0xfb, 0xff, 0x0a, 0x05, 0x0a, 0x0a, 0x00, 0x59, 0x00,
            0x24,
        ];
        let out = decode_stream(&dict, &stored, 1024).expect("tiff");
        assert_eq!(out, vec![10_u8, 15, 10, 20]);
    }

    #[test]
    fn limit_enforced() {
        let dict = dict_filter(b"FlateDecode", None);
        let big = [
            0x78_u8, 0x9c, 0xcb, 0x48, 0xcd, 0xc9, 0xc9, 0x57, 0x28, 0xcf, 0x2f, 0xca, 0x49, 0x01,
            0x00, 0x1a, 0x0b, 0x04, 0x5d,
        ];
        let err = decode_stream(&dict, &big, 4).expect_err("limit");
        assert_eq!(err.code, FailureCode::LimitExceeded);
    }

    #[test]
    fn truncated_returns_partial_flate() {
        let dict = dict_filter(b"Fl", None);
        let partial = [
            0x78_u8, 0x9c, 0xcb, 0x48, 0xcd, 0xc9, 0xc9, 0x57, 0x28, 0xcf, 0x2f, 0xca, 0x49,
        ];
        let out = decode_stream(&dict, &partial, 1024).expect("partial");
        assert!(!out.is_empty());
    }

    #[test]
    fn image_last_passthrough() {
        let dict = dict_filter(b"DCTDecode", None);
        let raw = b"jpeg-bytes";
        let out = decode_stream(&dict, raw, 1024).expect("jpeg pass");
        assert_eq!(out, raw.to_vec());
    }

    #[test]
    fn lzw_roundtrip() {
        let mut dict = Dict::default();
        dict.insert(b"Filter", Object::Name(b"LZWDecode".to_vec()));
        let data = [0x00_u8, 0x83, 0x08, 0x09, 0x08];
        let out = decode_stream(&dict, &data, 1024).expect("lzw");
        assert_eq!(out, b"AB");
    }

    fn png_decode_stored(stored: &[u8], predictor: i64) -> Vec<u8> {
        let mut dict = Dict::default();
        dict.insert(b"Filter", Object::Name(b"FlateDecode".to_vec()));
        let mut parms = Dict::default();
        parms.insert(b"Predictor", Object::Integer(predictor));
        parms.insert(b"Colors", Object::Integer(1));
        parms.insert(b"BitsPerComponent", Object::Integer(8));
        parms.insert(b"Columns", Object::Integer(2));
        dict.insert(b"DecodeParms", Object::Dict(parms));
        decode_stream(&dict, stored, 1024).expect("png decode")
    }

    #[test]
    fn png_predictor_up_average_paeth_and_mixed() {
        let up = [
            0x78_u8, 0x9c, 0x63, 0xe0, 0x12, 0x61, 0x62, 0x66, 0x05, 0x00, 0x00, 0x99, 0x00, 0x29,
        ];
        assert_eq!(png_decode_stored(&up, 12), vec![10_u8, 20, 13, 25]);
        let average = [
            0x78_u8, 0x9c, 0x63, 0xe0, 0x12, 0x61, 0xe6, 0xe2, 0x00, 0x00, 0x00, 0xad, 0x00, 0x34,
        ];
        assert_eq!(png_decode_stored(&average, 13), vec![10_u8, 25, 15, 28]);
        let paeth = [
            0x78_u8, 0x9c, 0x63, 0xe0, 0x12, 0x61, 0xe1, 0xe2, 0x06, 0x00, 0x00, 0xb3, 0x00, 0x38,
        ];
        assert_eq!(png_decode_stored(&paeth, 14), vec![10_u8, 20, 20, 31]);
        let mixed = [
            0x78_u8, 0x9c, 0x63, 0xe0, 0x12, 0x61, 0x64, 0xe2, 0x60, 0x62, 0x64, 0x03, 0x00, 0x01,
            0x23, 0x00, 0x33,
        ];
        let mixed_out = png_decode_stored(&mixed, 15);
        assert_eq!(mixed_out, vec![10_u8, 20, 2, 10, 3, 16]);
    }

    #[test]
    fn lzw_early_change_and_code_width_transitions() {
        let decode = |early: i64, data: &[u8]| -> Vec<u8> {
            let mut dict = Dict::default();
            dict.insert(b"Filter", Object::Name(b"LZWDecode".to_vec()));
            let mut parms = Dict::default();
            parms.insert(b"EarlyChange", Object::Integer(early));
            dict.insert(b"DecodeParms", Object::Dict(parms));
            decode_stream(&dict, data, 1024).expect("lzw")
        };
        let short = [0x00_u8, 0x83, 0x08, 0x09, 0x08];
        assert_eq!(decode(1, &short), b"AB");
        assert_eq!(decode(0, &short), b"AB");
    }

    #[test]
    fn corruption_loop_no_panic() {
        let dict = dict_filter(b"FlateDecode", None);
        let seed = [0x78_u8, 0x9c, 0xcb, 0x48, 0xcd, 0xc9, 0xc9];
        let mut state = 0xA5A5_1234_u32;
        for _ in 0..4096 {
            let mut input = seed;
            for byte in &mut input {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                *byte ^= state as u8;
            }
            let _ = decode_stream(&dict, &input, 65536);
        }
    }

    #[test]
    #[ignore]
    fn inflate_throughput_benchmark() {
        let payload = repetitive_deflate_mb();
        let dict = dict_filter(b"FlateDecode", None);
        let start = std::time::Instant::now();
        let _ = decode_stream(&dict, &payload, 8 * 1024 * 1024).expect("bench");
        let elapsed = start.elapsed().as_secs_f64();
        let mb = payload.len() as f64 / (1024.0 * 1024.0);
        println!("inflate {:.1} MB/s", mb / elapsed);
    }

    fn stored_bytes(raw: &[u8]) -> Vec<u8> {
        let len = raw.len() as u16;
        let nlen = len ^ 0xffff;
        let mut block = Vec::new();
        block.push(0x01);
        block.extend_from_slice(&[0, 0]);
        block.extend_from_slice(&len.to_le_bytes());
        block.extend_from_slice(&nlen.to_le_bytes());
        block.extend_from_slice(raw);
        let mut out = vec![0x78_u8, 0x01];
        out.extend_from_slice(&block);
        out.extend_from_slice(&[0, 0, 0, 0]);
        out
    }

    fn repetitive_deflate_mb() -> Vec<u8> {
        let mut raw = Vec::with_capacity(1_048_576);
        for _ in 0..(1_048_576 / 4) {
            raw.extend_from_slice(b"ABCD");
        }
        stored_bytes(&raw)
    }
}
