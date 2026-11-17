use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt::{Display, Write as _};
use std::path::{Path, PathBuf};
use std::{env, fs};

const ENCODING_SIZE: usize = 256;
const NO_GLYPH: u16 = u16::MAX;

type BuildResult<T> = Result<T, Box<dyn Error>>;
type Sections<'a> = Vec<(&'a str, Vec<&'a str>)>;

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

fn section<'a>(sections: &'a Sections<'_>, name: &str) -> BuildResult<&'a [&'a str]> {
    sections
        .iter()
        .find(|(found, _)| *found == name)
        .map(|(_, lines)| lines.as_slice())
        .ok_or_else(|| format!("missing section [{name}]").into())
}

fn coded_names<'a>(lines: &[&'a str]) -> BuildResult<Vec<Option<&'a str>>> {
    let mut table = vec![None; ENCODING_SIZE];
    for line in lines {
        let (code, name) = line
            .split_once(' ')
            .ok_or_else(|| format!("malformed encoding line `{line}`"))?;
        let code: usize = code.parse()?;
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

fn array<T>(items: &[T]) -> String
where
    T: Display,
{
    let mut out = String::from("[");
    for (index, item) in items.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push_str(&item.to_string());
    }
    out.push(']');
    out
}

fn emit<T>(out: &mut String, name: &str, element: &str, values: &[T]) -> Result<(), std::fmt::Error>
where
    T: Display,
{
    writeln!(
        out,
        "pub(crate) static {name}: [{element}; {}] = {};",
        values.len(),
        array(values)
    )
}

fn glyph_list(text: &str) -> BuildResult<BTreeMap<&str, Vec<u32>>> {
    let mut agl = BTreeMap::new();
    for line in text.lines().map(str::trim) {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (name, codes) = line
            .split_once(';')
            .ok_or_else(|| format!("malformed glyph list line `{line}`"))?;
        let codes = codes
            .split_whitespace()
            .map(|code| u32::from_str_radix(code, 16))
            .collect::<Result<Vec<_>, _>>()?;
        agl.insert(name, codes);
    }
    Ok(agl)
}

#[expect(
    clippy::use_debug,
    reason = "generated Rust uses Debug quoting for embeddable string literals"
)]
fn font_tables(
    glyphlist: &str,
    encodings: &Sections<'_>,
    standard14: &Sections<'_>,
) -> BuildResult<String> {
    let agl = glyph_list(glyphlist)?;
    let mut tables = Vec::new();
    let mut names: BTreeSet<&str> = agl.keys().copied().collect();
    for (name, lines) in encodings {
        let table = coded_names(lines)?;
        names.extend(table.iter().flatten().copied());
        tables.push((*name, table));
    }
    let names: Vec<&str> = names.into_iter().collect();
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
    emit(&mut out, "AGL_CODEPOINTS", "u32", &codepoints)?;

    let mut win_ansi: &[Option<&str>] = &[];
    for (name, table) in &tables {
        let row = table
            .iter()
            .map(|glyph| {
                glyph
                    .and_then(|glyph| index.get(glyph))
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

    for (font, lines) in standard14 {
        let mut widths: BTreeMap<&str, u16> = BTreeMap::new();
        for line in lines {
            let (glyph, width) = line
                .split_once(' ')
                .ok_or_else(|| format!("malformed width line `{line}`"))?;
            widths.insert(glyph, width.parse()?);
        }
        let row: Vec<u16> = win_ansi
            .iter()
            .map(|glyph| {
                glyph
                    .and_then(|glyph| widths.get(glyph))
                    .copied()
                    .unwrap_or(0)
            })
            .collect();
        emit(
            &mut out,
            &format!("STANDARD14_{}", screaming(font)),
            "u16",
            &row,
        )?;
    }
    Ok(out)
}

#[expect(
    clippy::use_debug,
    reason = "generated Rust uses Debug formatting for static string slice tables"
)]
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
    for (code, glyph) in coded_names(section(cff, "ExpertEncoding")?)?
        .into_iter()
        .enumerate()
    {
        if let (Some(glyph), Some(slot)) = (glyph, expert.get_mut(code)) {
            *slot = sid(glyph)?;
        }
    }
    let mut out = String::new();
    writeln!(
        out,
        "pub(crate) static CFF_STANDARD_STRINGS: [&str; {}] = {strings:?};",
        strings.len()
    )?;
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
