extern crate alloc;

use alloc::collections::{BTreeMap, BTreeSet};
use core::error::Error;
use core::fmt::{self, LowerHex, Write as _};
use std::path::{Path, PathBuf};
use std::{env, fs};

const ENCODING_SIZE: usize = 256;
const NO_GLYPH: u16 = u16::MAX;

type BuildResult<T> = Result<T, Box<dyn Error>>;
type Sections<'text> = Vec<(&'text str, Vec<&'text str>)>;

fn main() -> BuildResult<()> {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR")?);
    let out_dir = PathBuf::from(env::var("OUT_DIR")?);
    println!("cargo::rerun-if-changed=build.rs");
    let glyphlist = read(&manifest, "glyphlist.txt")?;
    let encodings = read(&manifest, "encodings.txt")?;
    let standard14 = read(&manifest, "standard14.txt")?;
    let cff = read(&manifest, "cff.txt")?;

    let font_tables = font_tables(&glyphlist, &sections(&encodings), &sections(&standard14))?;
    fs::write(out_dir.join("font_tables.rs"), font_tables)?;
    let cff_tables = cff_tables(&sections(&cff))?;
    fs::write(out_dir.join("cff_tables.rs"), cff_tables)?;
    Ok(())
}

fn read(manifest: &Path, name: &str) -> BuildResult<String> {
    let path = manifest.join("data").join(name);
    println!("cargo::rerun-if-changed={}", path.display());
    Ok(fs::read_to_string(path)?)
}

fn sections(text: &str) -> Sections<'_> {
    let mut sections: Sections<'_> = Vec::new();
    for line in text.lines().map(str::trim) {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(name) = line
            .strip_prefix('[')
            .and_then(|rest| rest.strip_suffix(']'))
        {
            sections.push((name, Vec::new()));
        } else if let Some((_, lines)) = sections.last_mut() {
            lines.push(line);
        }
    }
    sections
}

fn section<'table>(
    sections: &'table Sections<'_>,
    name: &str,
) -> BuildResult<&'table [&'table str]> {
    sections
        .iter()
        .find(|(found, _)| *found == name)
        .map(|(_, lines)| lines.as_slice())
        .ok_or_else(|| format!("missing section [{name}]").into())
}

fn coded_names<'text>(lines: &[&'text str]) -> BuildResult<Vec<Option<&'text str>>> {
    let mut table = vec![None; ENCODING_SIZE];
    for line in lines {
        let (digits, name) = line
            .split_once(' ')
            .ok_or_else(|| format!("malformed encoding line `{line}`"))?;
        let code: usize = digits.parse()?;
        *table
            .get_mut(code)
            .ok_or_else(|| format!("code out of range in `{line}`"))? = Some(name);
    }
    Ok(table)
}

fn screaming(name: &str) -> String {
    let mut out = String::new();
    let mut previous_lower = false;
    for ch in name.chars() {
        if ch == '-' {
            out.push('_');
            previous_lower = false;
            continue;
        }
        if ch.is_ascii_uppercase() && previous_lower {
            out.push('_');
        }
        previous_lower = ch.is_ascii_lowercase() || ch.is_ascii_digit();
        out.push(ch.to_ascii_uppercase());
    }
    out
}

fn array<T>(items: &[T]) -> Result<String, fmt::Error>
where
    T: LowerHex,
{
    let mut out = String::from("[");
    for (index, item) in items.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        write!(out, "{item:#x}")?;
    }
    out.push(']');
    Ok(out)
}

fn emit<T>(out: &mut String, name: &str, element: &str, values: &[T]) -> Result<(), fmt::Error>
where
    T: LowerHex,
{
    writeln!(
        out,
        "pub(crate) static {name}: [{element}; {}] = {};",
        values.len(),
        array(values)?
    )
}

fn zlib_compress_bytes(input: &[u8]) -> BuildResult<Vec<u8>> {
    use std::io::Write as _;
    use std::process::{Command, Stdio};

    let mut child = Command::new("python3")
        .args([
            "-c",
            "import sys, zlib; sys.stdout.buffer.write(zlib.compress(sys.stdin.buffer.read(), 9))",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| String::from("python3 stdin unavailable"))?;
    stdin.write_all(input)?;
    drop(stdin);
    let output = child.wait_with_output()?;
    if !output.status.success() {
        return Err(format!(
            "python3 zlib failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )
        .into());
    }
    Ok(output.stdout)
}

fn glyph_list(text: &str) -> BuildResult<BTreeMap<&str, Vec<u32>>> {
    let mut agl = BTreeMap::new();
    for line in text.lines().map(str::trim) {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (name, hex) = line
            .split_once(';')
            .ok_or_else(|| format!("malformed glyph list line `{line}`"))?;
        let codes = hex
            .split_whitespace()
            .map(|code| u32::from_str_radix(code, 16))
            .collect::<Result<Vec<_>, _>>()?;
        if agl.insert(name, codes).is_some() {
            return Err(format!("duplicate glyph list entry `{name}`").into());
        }
    }
    Ok(agl)
}

fn font_tables(
    glyphlist: &str,
    encodings: &Sections<'_>,
    standard14: &Sections<'_>,
) -> BuildResult<String> {
    let agl = glyph_list(glyphlist)?;
    let mut tables = Vec::new();
    let mut known: BTreeSet<&str> = agl.keys().copied().collect();
    for (name, lines) in encodings {
        let table = coded_names(lines)?;
        known.extend(table.iter().flatten().copied());
        tables.push((*name, table));
    }
    let names: Vec<&str> = known.into_iter().collect();
    let index: BTreeMap<&str, usize> = names
        .iter()
        .enumerate()
        .map(|(position, name)| (*name, position))
        .collect();

    let mut out = String::new();
    writeln!(
        out,
        "pub(crate) static GLYPH_NAME_TEXT: &str = {:?};",
        names.concat()
    )?;
    let mut end = 0_usize;
    let mut ends = Vec::with_capacity(names.len());
    for name in &names {
        end = end.saturating_add(name.len());
        ends.push(u16::try_from(end)?);
    }
    emit(&mut out, "GLYPH_NAME_ENDS", "u16", &ends)?;

    let mut starts = Vec::with_capacity(names.len().saturating_add(1));
    let mut codepoints: Vec<u32> = Vec::new();
    for name in &names {
        starts.push(u16::try_from(codepoints.len())?);
        if let Some(found) = agl.get(name) {
            codepoints.extend_from_slice(found);
        }
    }
    starts.push(u16::try_from(codepoints.len())?);
    emit(&mut out, "AGL_STARTS", "u16", &starts)?;
    let codepoints_u16 = codepoints
        .iter()
        .map(|code| u16::try_from(*code))
        .collect::<Result<Vec<_>, _>>()?;
    emit(&mut out, "AGL_CODEPOINTS", "u16", &codepoints_u16)?;

    let mut win_ansi: &[Option<&str>] = &[];
    for (name, table) in &tables {
        let row = table
            .iter()
            .map(|slot| {
                slot.and_then(|glyph| index.get(glyph))
                    .map_or(Ok(NO_GLYPH), |found| u16::try_from(*found))
            })
            .collect::<Result<Vec<_>, _>>()?;
        emit(
            &mut out,
            &format!("ENCODING_{}", screaming(name)),
            "u16",
            &row,
        )?;
        if *name == "WinAnsi" {
            win_ansi = table;
        }
    }
    if win_ansi.is_empty() {
        return Err("missing section [WinAnsi]".into());
    }

    let mut width_tables: Vec<(String, Vec<u16>)> = Vec::new();
    for (font, lines) in standard14 {
        let mut widths: BTreeMap<&str, u16> = BTreeMap::new();
        for line in lines {
            let (glyph, width) = line
                .split_once(' ')
                .ok_or_else(|| format!("malformed width line `{line}`"))?;
            if widths.insert(glyph, width.parse()?).is_some() {
                return Err(format!("duplicate width for `{glyph}` in [{font}]").into());
            }
        }
        let row: Vec<u16> = win_ansi
            .iter()
            .map(|slot| {
                slot.and_then(|glyph| widths.get(glyph))
                    .copied()
                    .unwrap_or(0)
            })
            .collect();
        let symbol = format!("STANDARD14_{}", screaming(font));
        if width_tables.iter().any(|(_, existing)| *existing == row) {
            continue;
        }
        width_tables.push((symbol, row));
    }
    for (name, row) in &width_tables {
        emit(&mut out, name, "u16", row)?;
    }
    Ok(out)
}

fn cff_tables(cff: &Sections<'_>) -> BuildResult<String> {
    let strings = section(cff, "StandardStrings")?;
    let sid = |name: &str| -> BuildResult<u16> {
        let position = strings
            .iter()
            .position(|candidate| *candidate == name)
            .ok_or_else(|| format!("unknown CFF standard string `{name}`"))?;
        Ok(u16::try_from(position)?)
    };
    let charset = |name: &str| -> BuildResult<Vec<u16>> {
        section(cff, name)?.iter().map(|glyph| sid(glyph)).collect()
    };
    let mut expert = vec![0_u16; ENCODING_SIZE];
    for (code, entry) in coded_names(section(cff, "ExpertEncoding")?)?
        .into_iter()
        .enumerate()
    {
        if let (Some(glyph), Some(slot)) = (entry, expert.get_mut(code)) {
            *slot = sid(glyph)?;
        }
    }
    let mut out = String::new();
    let string_text = strings.concat();
    let string_zlib = zlib_compress_bytes(string_text.as_bytes())?;
    writeln!(
        out,
        "pub(crate) const CFF_STANDARD_STRING_COUNT: usize = {};",
        strings.len()
    )?;
    writeln!(
        out,
        "pub(crate) const CFF_STANDARD_STRING_TEXT_LEN: usize = {};",
        string_text.len()
    )?;
    emit(
        &mut out,
        "CFF_STANDARD_STRING_TEXT_ZLIB",
        "u8",
        &string_zlib,
    )?;
    let mut end = 0_usize;
    let mut ends = Vec::with_capacity(strings.len());
    for name in strings {
        end = end.saturating_add(name.len());
        ends.push(u16::try_from(end)?);
    }
    emit(&mut out, "CFF_STANDARD_STRING_ENDS", "u16", &ends)?;
    emit(
        &mut out,
        "CFF_EXPERT_CHARSET",
        "u16",
        &charset("ExpertCharset")?,
    )?;
    emit(
        &mut out,
        "CFF_EXPERT_SUBSET_CHARSET",
        "u16",
        &charset("ExpertSubsetCharset")?,
    )?;
    emit(&mut out, "CFF_EXPERT_ENCODING", "u16", &expert)?;
    Ok(out)
}
