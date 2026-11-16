use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::path::PathBuf;
use std::{env, fs};

const ENCODING_SIZE: usize = 256;
const NO_GLYPH: u16 = u16::MAX;

type Sections<'a> = Vec<(&'a str, Vec<&'a str>)>;

fn main() -> Result<(), String> {
    let manifest =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").map_err(|error| error.to_string())?);
    let out_dir = PathBuf::from(env::var("OUT_DIR").map_err(|error| error.to_string())?);
    let read = |name: &str| {
        let path = manifest.join("data").join(name);
        println!("cargo::rerun-if-changed={}", path.display());
        fs::read_to_string(&path).map_err(|error| format!("{}: {error}", path.display()))
    };
    let glyphlist = read("glyphlist.txt")?;
    let encodings = read("encodings.txt")?;
    let standard14 = read("standard14.txt")?;
    let cff = read("cff.txt")?;
    println!("cargo::rerun-if-changed=build.rs");

    let encodings = sections(&encodings);
    let font_tables = font_tables(&glyphlist, &encodings, &sections(&standard14))?;
    fs::write(out_dir.join("font_tables.rs"), font_tables).map_err(|error| error.to_string())?;
    let cff_tables = cff_tables(&sections(&cff))?;
    fs::write(out_dir.join("cff_tables.rs"), cff_tables).map_err(|error| error.to_string())
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

fn section<'a>(sections: &'a Sections<'_>, name: &str) -> Result<&'a [&'a str], String> {
    sections
        .iter()
        .find(|(found, _)| *found == name)
        .map(|(_, lines)| lines.as_slice())
        .ok_or_else(|| format!("missing section [{name}]"))
}

fn coded_names<'a>(lines: &[&'a str]) -> Result<Vec<Option<&'a str>>, String> {
    let mut table = vec![None; ENCODING_SIZE];
    for line in lines {
        let (code, name) = line
            .split_once(' ')
            .ok_or_else(|| format!("malformed encoding line `{line}`"))?;
        let code: usize = code.parse().map_err(|_| format!("bad code in `{line}`"))?;
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

fn array<T: std::fmt::Display>(items: impl IntoIterator<Item = T>) -> String {
    let mut out = String::from("[");
    for (index, item) in items.into_iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        let _ = write!(out, "{item}");
    }
    out.push(']');
    out
}

fn to_u16(value: usize, what: &str) -> Result<u16, String> {
    u16::try_from(value).map_err(|_| format!("{what} exceeds u16"))
}

fn font_tables(
    glyphlist: &str,
    encodings: &Sections<'_>,
    standard14: &Sections<'_>,
) -> Result<String, String> {
    let mut agl: BTreeMap<&str, Vec<u32>> = BTreeMap::new();
    for line in glyphlist.lines().map(str::trim) {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (name, codes) = line
            .split_once(';')
            .ok_or_else(|| format!("malformed glyph list line `{line}`"))?;
        let codes = codes
            .split_whitespace()
            .map(|code| u32::from_str_radix(code, 16).map_err(|_| format!("bad code in `{line}`")))
            .collect::<Result<Vec<_>, _>>()?;
        agl.insert(name, codes);
    }

    let mut tables = Vec::new();
    let mut names: BTreeSet<&str> = agl.keys().copied().collect();
    for (name, lines) in encodings {
        let table = coded_names(lines)?;
        names.extend(table.iter().flatten().copied());
        tables.push((*name, table));
    }
    let names: Vec<&str> = names.into_iter().collect();
    let index: BTreeMap<&str, usize> = names.iter().enumerate().map(|(i, n)| (*n, i)).collect();

    let mut out = String::new();
    let text: String = names.concat();
    let mut end = 0_usize;
    let mut ends = Vec::with_capacity(names.len());
    for name in &names {
        end += name.len();
        ends.push(to_u16(end, "glyph name text")?);
    }
    let _ = writeln!(out, "pub(crate) static GLYPH_NAME_TEXT: &str = {text:?};");
    let _ = writeln!(
        out,
        "pub(crate) static GLYPH_NAME_ENDS: [u16; {}] = {};",
        ends.len(),
        array(&ends)
    );

    let mut starts = Vec::with_capacity(names.len() + 1);
    let mut codepoints: Vec<u32> = Vec::new();
    for name in &names {
        starts.push(to_u16(codepoints.len(), "glyph list")?);
        if let Some(found) = agl.get(name) {
            codepoints.extend_from_slice(found);
        }
    }
    starts.push(to_u16(codepoints.len(), "glyph list")?);
    let _ = writeln!(
        out,
        "pub(crate) static AGL_STARTS: [u16; {}] = {};",
        starts.len(),
        array(&starts)
    );
    let _ = writeln!(
        out,
        "pub(crate) static AGL_CODEPOINTS: [u32; {}] = {};",
        codepoints.len(),
        array(&codepoints)
    );

    let mut win_ansi: &[Option<&str>] = &[];
    for (name, table) in &tables {
        let row: Vec<u16> = table
            .iter()
            .map(|glyph| match glyph.and_then(|glyph| index.get(glyph)) {
                Some(found) => to_u16(*found, "glyph index"),
                None => Ok(NO_GLYPH),
            })
            .collect::<Result<_, _>>()?;
        let _ = writeln!(
            out,
            "pub(crate) static ENCODING_{}: [u16; {ENCODING_SIZE}] = {};",
            screaming(name),
            array(&row)
        );
        if *name == "WinAnsi" {
            win_ansi = table;
        }
    }
    if win_ansi.is_empty() {
        return Err("missing section [WinAnsi]".to_owned());
    }

    for (font, lines) in standard14 {
        let mut widths: BTreeMap<&str, u16> = BTreeMap::new();
        for line in lines {
            let (glyph, width) = line
                .split_once(' ')
                .ok_or_else(|| format!("malformed width line `{line}`"))?;
            widths.insert(
                glyph,
                width
                    .parse()
                    .map_err(|_| format!("bad width in `{line}`"))?,
            );
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
        let _ = writeln!(
            out,
            "pub(crate) static STANDARD14_{}: [u16; {ENCODING_SIZE}] = {};",
            screaming(font),
            array(&row)
        );
    }
    Ok(out)
}

fn cff_tables(cff: &Sections<'_>) -> Result<String, String> {
    let strings = section(cff, "StandardStrings")?;
    let sid = |name: &str| -> Result<u16, String> {
        let position = strings
            .iter()
            .position(|candidate| *candidate == name)
            .ok_or_else(|| format!("unknown CFF standard string `{name}`"))?;
        to_u16(position, "SID")
    };
    let charset = |name: &str| -> Result<Vec<u16>, String> {
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
    let _ = writeln!(
        out,
        "pub(crate) static CFF_STANDARD_STRINGS: [&str; {}] = {:?};",
        strings.len(),
        strings
    );
    for (constant, section_name) in [
        ("CFF_EXPERT_CHARSET", "ExpertCharset"),
        ("CFF_EXPERT_SUBSET_CHARSET", "ExpertSubsetCharset"),
    ] {
        let sids = charset(section_name)?;
        let _ = writeln!(
            out,
            "pub(crate) static {constant}: [u16; {}] = {};",
            sids.len(),
            array(&sids)
        );
    }
    let _ = writeln!(
        out,
        "pub(crate) static CFF_EXPERT_ENCODING: [u16; {ENCODING_SIZE}] = {};",
        array(&expert)
    );
    Ok(out)
}
