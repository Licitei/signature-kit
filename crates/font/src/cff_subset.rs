use crate::{
    cff::{Index, dict_values, parse_dict, read_fd_select},
    sfnt::Face,
};
use core::iter::once;

const CHARSTRINGS: u16 = 17;
const PRIVATE: u16 = 18;
const SUBRS: u16 = 19;
const FONT_MATRIX: u16 = 0x0C07;
const ROS: u16 = 0x0C1E;
const FD_ARRAY: u16 = 0x0C24;
const FD_SELECT: u16 = 0x0C25;

#[derive(Debug)]
struct Private<'data> {
    bytes: &'data [u8],
    size: usize,
}

#[derive(Debug)]
struct FontDict<'data> {
    matrix: Option<&'data [u8]>,
    private: Option<Private<'data>>,
}

fn operand(value: f64) -> Option<usize> {
    if !value.is_finite()
        || value < 0.0_f64
        || value > f64::from(i32::MAX)
        || value.fract().abs() > 0.0_f64
    {
        return None;
    }
    format!("{value:.0}").parse().ok()
}

fn offset(dict: &[(u16, Vec<f64>)], operator: u16) -> Option<usize> {
    operand(*dict_values(dict, operator)?.first()?)
}

fn private<'data>(bytes: &'data [u8], fields: &[(u16, Vec<f64>)]) -> Option<Private<'data>> {
    let values = dict_values(fields, PRIVATE)?;
    let size = operand(*values.first()?)?;
    let start = operand(*values.get(1)?)?;
    let end = start.checked_add(size)?;
    let data = bytes.get(start..end)?;
    let dict = parse_dict(data);
    let stop = if let Some(relative) = offset(&dict, SUBRS) {
        Index::parse(bytes, start.checked_add(relative)?)?
            .end()
            .max(end)
    } else {
        end
    };
    Some(Private {
        size,
        bytes: bytes.get(start..stop)?,
    })
}

fn raw_entry(bytes: &[u8], operator: u16) -> Option<&[u8]> {
    let mut start = 0_usize;
    let mut position = 0_usize;
    while let Some(&byte) = bytes.get(position) {
        position = position.checked_add(1)?;
        match byte {
            12 => {
                let op = 0x0C00 | u16::from(*bytes.get(position)?);
                position = position.checked_add(1)?;
                if op == operator {
                    return bytes.get(start..position);
                }
                start = position;
            }
            0..=27 => {
                if u16::from(byte) == operator {
                    return bytes.get(start..position);
                }
                start = position;
            }
            28 => position = position.checked_add(2)?,
            29 => position = position.checked_add(4)?,
            30 => {
                while let Some(&pair) = bytes.get(position) {
                    position = position.checked_add(1)?;
                    if pair & 15 == 15 || pair >> 4_i32 == 15 {
                        break;
                    }
                }
            }
            247..=254 => position = position.checked_add(1)?,
            _ => {}
        }
    }
    None
}

fn index(entries: &[&[u8]]) -> Option<Vec<u8>> {
    let mut bytes = u16::try_from(entries.len()).ok()?.to_be_bytes().to_vec();
    if entries.is_empty() {
        return Some(bytes);
    }
    let mut cursor = 1_u32;
    bytes.push(4);
    bytes.extend_from_slice(&cursor.to_be_bytes());
    for entry in entries {
        cursor = cursor.checked_add(u32::try_from(entry.len()).ok()?)?;
        bytes.extend_from_slice(&cursor.to_be_bytes());
    }
    for entry in entries {
        bytes.extend_from_slice(entry);
    }
    Some(bytes)
}

fn integer(dict: &mut Vec<u8>, value: usize) -> Option<()> {
    dict.push(29);
    dict.extend_from_slice(&i32::try_from(value).ok()?.to_be_bytes());
    Some(())
}

fn top_dict(matrix: &[u8], glyphs: usize, offsets: [usize; 4]) -> Option<Vec<u8>> {
    let [charset, charstrings, select, font_dicts] = offsets;
    let mut dict = Vec::new();
    for sid in [391, 392, 0] {
        integer(&mut dict, sid)?;
    }
    dict.extend_from_slice(&[12, 30]);
    dict.extend_from_slice(matrix);
    integer(&mut dict, glyphs)?;
    dict.extend_from_slice(&[12, 34]);
    integer(&mut dict, charset)?;
    dict.push(15);
    integer(&mut dict, charstrings)?;
    dict.push(17);
    integer(&mut dict, select)?;
    dict.extend_from_slice(&[12, 37]);
    integer(&mut dict, font_dicts)?;
    dict.extend_from_slice(&[12, 36]);
    Some(dict)
}

pub(crate) fn subset(face: &Face<'_>, entries: &[(char, u16)], name: &str) -> Option<Vec<u8>> {
    let cff = face.table(*b"CFF ")?;
    if cff.first() != Some(&1) {
        return None;
    }
    let names = Index::parse(cff, usize::from(*cff.get(2)?))?;
    let tops = Index::parse(cff, names.end())?;
    let strings = Index::parse(cff, tops.end())?;
    let globals = Index::parse(cff, strings.end())?;
    let raw_top = tops.get(cff, 0)?;
    let parsed = parse_dict(raw_top);
    let chars = Index::parse(cff, offset(&parsed, CHARSTRINGS)?)?;
    let is_cid = dict_values(&parsed, ROS).is_some();
    let matrix = raw_entry(raw_top, FONT_MATRIX).unwrap_or_default();
    let (dicts, selection) = if is_cid {
        let fds = Index::parse(cff, offset(&parsed, FD_ARRAY)?)?;
        let dicts = (0..fds.count())
            .map(|slot| {
                let dict = fds.get(cff, slot)?;
                Some(FontDict {
                    matrix: raw_entry(dict, FONT_MATRIX),
                    private: private(cff, &parse_dict(dict)),
                })
            })
            .collect::<Option<Vec<_>>>()?;
        (
            dicts,
            read_fd_select(cff, offset(&parsed, FD_SELECT)?, chars.count())?,
        )
    } else {
        (
            vec![FontDict {
                matrix: None,
                private: private(cff, &parsed),
            }],
            vec![0; chars.count()],
        )
    };
    let selected: Vec<_> = once(0_u16)
        .chain(entries.iter().map(|entry| entry.1))
        .collect();
    let charstrings = index(
        &selected
            .iter()
            .map(|glyph| chars.get(cff, usize::from(*glyph)))
            .collect::<Option<Vec<_>>>()?,
    )?;
    let mut fd_select = vec![0_u8];
    for glyph in &selected {
        fd_select.push(*selection.get(usize::from(*glyph))?);
    }
    let mut charset = vec![0_u8];
    for cid in 1..selected.len() {
        charset.extend_from_slice(&u16::try_from(cid).ok()?.to_be_bytes());
    }
    let name_index = index(&[name.as_bytes()])?;
    let strings_out = index(&[b"Adobe", b"Identity"])?;
    let globals_out = cff.get(strings.end()..globals.end())?;
    let placeholder = index(&[&top_dict(matrix, selected.len(), [0; 4])?])?;
    let charset_at = 4_usize
        .checked_add(name_index.len())?
        .checked_add(placeholder.len())?
        .checked_add(strings_out.len())?
        .checked_add(globals_out.len())?;
    let charstrings_at = charset_at.checked_add(charset.len())?;
    let select_at = charstrings_at.checked_add(charstrings.len())?;
    let private_at = select_at.checked_add(fd_select.len())?;
    let mut private_data = Vec::new();
    let mut fd_dicts = Vec::new();
    for dict in &dicts {
        let mut result = dict.matrix.unwrap_or_default().to_vec();
        if let Some(data) = &dict.private {
            integer(&mut result, data.size)?;
            integer(&mut result, private_at.checked_add(private_data.len())?)?;
            result.push(18);
            private_data.extend_from_slice(data.bytes);
        }
        fd_dicts.push(result);
    }
    let font_dicts_at = private_at.checked_add(private_data.len())?;
    let encoded_fds = index(&fd_dicts.iter().map(Vec::as_slice).collect::<Vec<_>>())?;
    let top = index(&[&top_dict(
        matrix,
        selected.len(),
        [charset_at, charstrings_at, select_at, font_dicts_at],
    )?])?;
    Some(
        [
            [1_u8, 0, 4, 4].as_slice(),
            &name_index,
            &top,
            &strings_out,
            globals_out,
            &charset,
            &charstrings,
            &fd_select,
            &private_data,
            &encoded_fds,
        ]
        .concat(),
    )
}
