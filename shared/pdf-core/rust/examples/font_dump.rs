use std::env;
use std::fs;

use signature_kit_pdf_core::document::Document;
use signature_kit_pdf_core::font::Font;
use signature_kit_pdf_core::fontprog::{load_font_file_bytes, parse_font_program};
use signature_kit_pdf_core::inspection::Limits;
use signature_kit_pdf_core::object::{Dict, ObjRef, Object, Resolver};

fn describe(object: &Object) -> String {
    match object {
        Object::Name(name) => format!("/{}", String::from_utf8_lossy(name)),
        Object::Ref(reference) => format!("{} R", reference.number),
        Object::Integer(value) => value.to_string(),
        Object::Array(items) => format!("[{} items]", items.len()),
        Object::Dict(_) => "<<dict>>".to_owned(),
        Object::Stream(_) => "<<stream>>".to_owned(),
        other => format!("{other:?}"),
    }
}

fn dump_font(document: &Document, number: u32, font: &Dict, limits: &Limits) {
    let get = |key: &[u8]| {
        font.get(key)
            .map(describe)
            .unwrap_or_else(|| "-".to_owned())
    };
    println!(
        "obj {number}: Subtype={} BaseFont={} Encoding={} ToUnicode={} Descendants={}",
        get(b"Subtype"),
        get(b"BaseFont"),
        get(b"Encoding"),
        get(b"ToUnicode"),
        get(b"DescendantFonts"),
    );
    let mut descriptors = Vec::new();
    if let Some(descriptor) = font.get(b"FontDescriptor") {
        descriptors.push(descriptor.clone());
    }
    if let Some(Ok(listing)) = font.get(b"DescendantFonts").map(|o| document.resolve(o))
        && let Some(first) = listing.as_array().and_then(|items| items.first())
        && let Ok(child) = document.resolve(first)
        && let Some(dict) = child.as_dict()
    {
        println!(
            "  descendant Subtype={} CIDToGIDMap={} CIDSystemInfo={}",
            dict.get(b"Subtype").map(describe).unwrap_or_default(),
            dict.get(b"CIDToGIDMap").map(describe).unwrap_or_default(),
            dict.get(b"CIDSystemInfo").map(describe).unwrap_or_default(),
        );
        if let Some(descriptor) = dict.get(b"FontDescriptor") {
            descriptors.push(descriptor.clone());
        }
    }
    for descriptor in descriptors {
        let Ok(resolved) = document.resolve(&descriptor) else {
            continue;
        };
        let Some(dict) = resolved.as_dict() else {
            continue;
        };
        for key in [b"FontFile".as_slice(), b"FontFile2", b"FontFile3"] {
            if dict.get(key).is_some() {
                let loaded = load_font_file_bytes(key, dict, document, limits);
                match loaded {
                    Ok(bytes) => println!(
                        "  {} {} bytes head={:02x?}",
                        String::from_utf8_lossy(key),
                        bytes.len(),
                        bytes.get(..4).unwrap_or_default()
                    ),
                    Err(failure) => {
                        println!("  {} unreadable {failure:?}", String::from_utf8_lossy(key))
                    }
                }
            }
        }
        println!(
            "  Flags={}",
            dict.get(b"Flags").map(describe).unwrap_or_default()
        );
    }
}

fn decode_object(path: &str, number: u32, hex: &str) {
    let limits = Limits::default();
    let Ok(bytes) = fs::read(path) else { return };
    let Ok(document) = Document::open(&bytes, &limits) else {
        return;
    };
    let Ok(object) = document.load(ObjRef {
        number,
        generation: 0,
    }) else {
        return;
    };
    let Some(dict) = object.as_dict() else { return };
    let Ok(font) = Font::load(&document, dict, &limits) else {
        println!("font load failed");
        return;
    };
    let data: Vec<u8> = (0..hex.len() / 2)
        .filter_map(|index| u8::from_str_radix(hex.get(index * 2..index * 2 + 2)?, 16).ok())
        .collect();
    let mut glyphs = Vec::new();
    let mut text = String::new();
    font.decode(&data, &mut glyphs, &mut text);
    println!("text={text:?} glyphs={glyphs:?}");
}

fn probe_program(path: &str, number: u32, codes: &[u32]) {
    let limits = Limits::default();
    let Ok(bytes) = fs::read(path) else { return };
    let Ok(document) = Document::open(&bytes, &limits) else {
        return;
    };
    let Ok(object) = document.load(ObjRef {
        number,
        generation: 0,
    }) else {
        return;
    };
    let Some(font) = object.as_dict() else { return };
    let Some(Ok(descriptor)) = font.get(b"FontDescriptor").map(|d| document.resolve(d)) else {
        return;
    };
    let Some(dict) = descriptor.as_dict() else {
        return;
    };
    for key in [b"FontFile2".as_slice(), b"FontFile3", b"FontFile"] {
        let Ok(data) = load_font_file_bytes(key, dict, &document, &limits) else {
            continue;
        };
        let Some(program) = parse_font_program(data) else {
            println!("program unparsable");
            continue;
        };
        for code in codes {
            let gid = program.code_to_gid(*code, true);
            println!(
                "code {code:#x} gid {gid:?} name {:?} text {:?} parts {:?}",
                gid.and_then(|g| program.glyph_name(g))
                    .map(String::from_utf8_lossy),
                gid.and_then(|g| program.gid_text(g)),
                gid.and_then(|g| program.gid_parts(g)),
            );
        }
    }
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    if let [flag, path, number, rest @ ..] = args.as_slice()
        && flag == "--program"
    {
        let codes: Vec<u32> = rest
            .iter()
            .filter_map(|value| u32::from_str_radix(value, 16).ok())
            .collect();
        probe_program(path, number.parse().unwrap_or(0), &codes);
        return;
    }
    if let [flag, path, number, hex] = args.as_slice()
        && flag == "--decode"
    {
        decode_object(path, number.parse().unwrap_or(0), hex);
        return;
    }
    let limits = Limits::default();
    for path in args {
        let Ok(bytes) = fs::read(&path) else {
            eprintln!("{path}: unreadable");
            continue;
        };
        let Ok(document) = Document::open(&bytes, &limits) else {
            eprintln!("{path}: open failed");
            continue;
        };
        for number in 1..200_000u32 {
            let Ok(object) = document.load(ObjRef {
                number,
                generation: 0,
            }) else {
                continue;
            };
            let Some(dict) = object.as_dict() else {
                continue;
            };
            if dict.get(b"Type").and_then(Object::as_name) == Some(b"Font") {
                dump_font(&document, number, dict, &limits);
            }
        }
    }
}
