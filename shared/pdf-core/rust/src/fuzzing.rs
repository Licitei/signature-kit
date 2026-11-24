use alloc::rc::Rc;

use crate::ccitt::{self, CcittParams};
use crate::cmap::{CMap, UnicodeMap};
use crate::diagnostics;
use crate::display::PathData;
use crate::document::{self, Document, PageRequest};
use crate::edit::{document_info, edit};
use crate::failure::Outcome;
use crate::filters::decode_stream;
use crate::fontprog::{GlyphMetrics, parse_font_program};
use crate::function::Function;
use crate::glyph::parse_type1;
use crate::inflate::{inflate, inflate_prefix};
use crate::inspection::{InspectOptions, Limits};
use crate::layout::{self, TextOptions};
use crate::lazy::{Lazy, Plan, Tuning};
use crate::object::{Object, Resolver, Stream};
use crate::pdf_cipher::{aes_cbc, rc4};
use crate::png;
use crate::render;
use crate::revision::{Analysis, analyze, revision_complete};
use crate::syntax::{ContentLexer, Parser, find_bytes, parse_indirect_object};
use crate::write::{Packing, merge};

const EDIT_MAGIC: u32 = 0x4445_4450;
const EDIT_VERSION: u32 = 1;
const MAX_DECODED: usize = 1 << 22_u32;

struct InputResolver<'data> {
    data: &'data [u8],
}

impl Resolver for InputResolver<'_> {
    fn resolve(&self, object: &Object) -> Outcome<Rc<Object>> {
        Ok(Rc::new(object.clone()))
    }

    fn stream_data(&self, stream: &Stream) -> Outcome<Vec<u8>> {
        let raw = self.data.get(stream.data.clone()).unwrap_or_default();
        decode_stream(&stream.dict, raw, MAX_DECODED, None)
    }
}

fn selector(data: &[u8]) -> u8 {
    data.last().copied().unwrap_or_default()
}

const fn text_options(bits: u8) -> TextOptions {
    TextOptions {
        drop_running: bits & 1 == 1,
        markdown: bits & 2 == 2,
        merge_across_pages: bits & 4 == 4,
    }
}

fn reopens(output: &[u8]) {
    let reopened = Document::open(output, &Limits::default());
    assert!(reopened.is_ok(), "written PDF does not reopen");
}

#[inline]
pub fn markdown(data: &[u8]) {
    let options = TextOptions {
        drop_running: true,
        markdown: true,
        merge_across_pages: data.first().is_some_and(|byte| byte & 1 == 1),
    };
    drop(layout::document_text(
        data,
        PageRequest::Indexes(None),
        &layout::text_limits(),
        options,
    ));
}

#[inline]
pub fn inspect(data: &[u8]) {
    let bits = selector(data);
    let options = InspectOptions {
        links: bits & 1 == 1,
        page_indexes: (bits & 8 == 8).then(|| vec![0, 1, 7]),
        runs: bits & 2 == 2,
        text: bits & 4 == 4,
    };
    drop(document::inspect(data, &options, &layout::text_limits()));
    drop(diagnostics::document_diagnostics(
        data,
        PageRequest::First(2),
        &layout::text_limits(),
    ));
    drop(document_info(data, None, b"Sig", &Limits::default()));
}

#[inline]
pub fn tables(data: &[u8]) {
    let bits = selector(data);
    drop(layout::document_tables(
        data,
        PageRequest::Indexes(None),
        &layout::text_limits(),
        bits & 1 == 1,
        bits & 2 == 2,
    ));
}

#[inline]
pub fn render(data: &[u8]) {
    let scale = if selector(data) & 1 == 1 {
        0.5_f64
    } else {
        0.125_f64
    };
    drop(render::render_pages(
        data,
        PageRequest::First(1),
        scale,
        &Limits::default(),
    ));
}

#[inline]
pub fn signatures(data: &[u8]) {
    scan_signatures(data);
}

fn scan_signatures(data: &[u8]) {
    for analysis in [
        Analysis::Scan,
        Analysis::Dictionaries,
        Analysis::Verification,
    ] {
        drop(analyze(data, analysis));
    }
    for end in [data.len(), data.len() >> 1_u32] {
        if revision_complete(data, end) {
            let prefix = data.get(..end).unwrap_or_default();
            assert!(
                find_bytes(prefix, 0, b"%%EOF").is_some(),
                "a complete revision has no end-of-file marker"
            );
        }
    }
}

#[inline]
pub fn edit_and_merge(data: &[u8]) {
    let bits = selector(data);
    let mut payload = Vec::with_capacity(16);
    for word in [EDIT_MAGIC, EDIT_VERSION, u32::from(bits & 7), 0] {
        payload.extend_from_slice(&word.to_le_bytes());
    }
    if let Ok(output) = edit(data, &payload, &Limits::default()) {
        reopens(&output);
    }
    let packing = if bits & 8 == 8 {
        Packing::ObjectStreams
    } else {
        Packing::Classic
    };
    let selections = [None, Some(vec![0])];
    if let Ok(output) = merge(
        &[data, data],
        &selections,
        bits & 16 == 16,
        packing,
        &Limits::default(),
    ) {
        reopens(&output);
    }
}

#[inline]
pub fn lazy(data: &[u8]) {
    lazy_matches_eager(data);
}

fn lazy_matches_eager(data: &[u8]) {
    let bits = selector(data);
    let limits = layout::text_limits();
    let options = text_options(bits);
    let mut lazy = Lazy::new(
        data.len(),
        Tuning {
            gap: usize::from(bits & 0x30).saturating_mul(4),
            probe: 64_usize << u32::from(bits >> 6_u32),
            round_bytes: 4096,
        },
    );
    let request = PageRequest::First(2);
    let bound = lazy
        .round_cap()
        .saturating_add(data.len().div_ceil(4096))
        .saturating_add(8);
    let settled =
        (0..bound).any(
            |_| match lazy.plan_with_recovery(request, false, &limits, false) {
                Plan::Need(ranges) | Plan::Full(ranges) if !ranges.is_empty() => {
                    for range in ranges {
                        let slice = data.get(range.clone());
                        assert!(slice.is_some(), "lazy planned an out-of-bounds range");
                        let fed = slice.is_some_and(|bytes| lazy.feed(range.start, bytes));
                        assert!(fed, "lazy rejected its own planned range");
                    }
                    false
                }
                Plan::Ready => match lazy.execute(&limits, |opened, pages| {
                    layout::opened_text(opened, pages, &limits, options)
                }) {
                    Ok(Some(pages)) => {
                        let eager = layout::document_text(data, request, &limits, options);
                        assert_eq!(eager.ok(), Some(pages), "lazy text differs from eager text");
                        true
                    }
                    Ok(None) => false,
                    Err(_) => true,
                },
                Plan::Need(_) | Plan::Full(_) | Plan::Failed(_) | Plan::Fallback => true,
            },
        );
    assert!(settled, "lazy planner did not settle within its round cap");
}

fn indirect_object(data: &[u8]) {
    let Ok(parsed) = parse_indirect_object(data, 0, 64, &|_| None) else {
        return;
    };
    let resolver = InputResolver { data };
    if let Object::Stream(stream) = &parsed.object {
        let raw = data.get(stream.data.clone()).unwrap_or_default();
        let full = decode_stream(&stream.dict, raw, MAX_DECODED, None);
        let prefix = decode_stream(&stream.dict, raw, MAX_DECODED, Some(64));
        if let (Ok(whole), Ok(head)) = (&full, &prefix) {
            assert!(
                head.len() <= whole.len().max(64),
                "prefix decoded past the stream"
            );
        }
    }
    if let Some(function) = Function::parse(&resolver, &parsed.object) {
        let mut out = Vec::new();
        for input in [0.0_f64, 0.5_f64, 1.0_f64, -1.0_f64, f64::NAN, 1e300_f64] {
            function.eval(&[input, input, input, input], &mut out);
        }
    }
}

fn font_program(data: &[u8]) {
    let Some(program) = parse_font_program(data.to_vec()) else {
        return;
    };
    let mut path = PathData::default();
    let mut work = 0_usize;
    for gid in 0..32_u16 {
        let _: Option<GlyphMetrics> = program.glyph_metrics(gid);
        drop(program.gid_text(gid));
        let _: Option<&[u8]> = program.glyph_name(gid);
        path.clear();
        let _: Option<()> = program.outline(gid, &mut path, &mut work);
    }
    for code in 0..=u8::MAX {
        let _: Option<&[u8]> = program.builtin_name(code);
        let _: Option<u16> = program.code_to_gid(u32::from(code), code & 1 == 1);
    }
}

fn cmaps(data: &[u8]) {
    let limits = Limits::default();
    let parsed = CMap::parse(data, &limits);
    let unicode = UnicodeMap::parse(data, &limits);
    let mut offset = 0_usize;
    for _ in 0..64_u32 {
        let Some((code, length)) = parsed.cmap.read(data, offset) else {
            break;
        };
        assert!(
            (1..=4).contains(&length),
            "cmap read a code of invalid length"
        );
        let _: Option<u32> = parsed.cmap.cid(code, length);
        drop(unicode.lookup(code));
        drop(unicode.usable(code));
        offset = offset.saturating_add(length);
    }
}

fn ccitt_image(data: &[u8]) {
    let Some((&[flags, k_factor, columns, rows], body)) = data.split_first_chunk::<4>() else {
        return;
    };
    let params = CcittParams {
        black_is_1: flags & 1 == 1,
        byte_align: flags & 2 == 2,
        end_of_line: flags & 4 == 4,
        k_factor: i64::from(i8::from_le_bytes([k_factor])),
        columns: usize::from(columns).saturating_add(1),
        rows: usize::from(rows),
    };
    drop(ccitt::decode(body, &params, MAX_DECODED));
}

fn ciphers(data: &[u8]) {
    let Some((key, body)) = data.split_first_chunk::<16>() else {
        return;
    };
    let mut stream = body.to_vec();
    rc4(&mut stream, key);
    let mut blocks = body.to_vec();
    let _: Option<()> = aes_cbc(&mut blocks, key, *key, true);
}

fn content(data: &[u8]) {
    let mut lexer = ContentLexer::new(data);
    let mut operands = Vec::new();
    let mut tokens = 0_usize;
    while lexer.operator(&mut operands, usize::MAX).is_some() {
        tokens = tokens.saturating_add(operands.len()).saturating_add(1);
        assert!(
            tokens <= data.len().saturating_add(1),
            "content lexer did not advance"
        );
    }
}

#[inline]
pub fn decoders(data: &[u8]) {
    let Some((&mode, rest)) = data.split_first() else {
        return;
    };
    match mode & 15 {
        0 => indirect_object(rest),
        1 => {
            drop(inflate(rest, MAX_DECODED));
            drop(inflate_prefix(rest, 100));
        }
        2 => ccitt_image(rest),
        3 => drop(png::decode(rest)),
        4 => cmaps(rest),
        5 => font_program(rest),
        6 => drop(parse_type1(rest)),
        7 => ciphers(rest),
        8 => content(rest),
        _ => drop(Parser::new(rest, 0, 64, true).parse_object()),
    }
}
