use alloc::rc::Rc;
use core::fmt::Write as _;
use std::collections::{HashMap, HashSet};

use super::{
    Base, Changes, Dict, Document, Failure, Limits, MAX_ANNOTATIONS, MAX_FIELD_CHARACTERS,
    MAX_FIELD_DEPTH, MAX_FIELD_NAME, MAX_FIELD_NODES, MAX_SIGNATURE_CONTENTS, ObjRef, Object,
    Outcome, Reader, Step, Store, Target, annotation_items, appendable, decode_text_string,
    dict_of, field_title, field_type, next_object_number, qualify, rect_tuple, standard_font,
    widen,
};
use crate::font_tables::win_ansi_unicode;
use crate::num::f64_to_i64;
use crate::pdf_hash::{sha256_parts, sha512_parts};
use crate::png;
use crate::revision::{Analysis, RevisionIndex, analyze, revision_index};
use crate::syntax::find_bytes;
use crate::write::{incremental_update, number_object, rect_object, serialize};

const REQUEST_MAGIC: u32 = 0x5250_5350;
const MAX_APPEARANCE_LINES: u32 = 1024;
const MAX_COORDINATE: f64 = 1_000_000.0;
const RANGE_WIDTH: usize = 10;
const RANGE_START: &[u8] = b"/ByteRange [";
const HOLE_START: &[u8] = b"]/Contents <";
const RANGE_PLACEHOLDER: i64 = 9_999_999_999;

#[derive(Debug)]
#[expect(
    clippy::exhaustive_structs,
    reason = "the internal ABI shares this struct with the WASM crate"
)]
pub struct SignatureFields {
    pub doc_mdp: Option<u32>,
    pub fields: Vec<SignatureField>,
    pub revisions: Vec<usize>,
}

#[derive(Debug)]
#[expect(
    clippy::exhaustive_structs,
    reason = "the internal ABI shares this struct with the WASM crate"
)]
pub struct SignatureField {
    pub lock: Option<FieldLock>,
    pub name: String,
    pub reference: Option<ObjRef>,
    pub signed: bool,
    pub value: Option<SignatureValue>,
    pub widgets: Vec<Widget>,
}

#[derive(Debug)]
#[expect(
    clippy::exhaustive_structs,
    reason = "the internal ABI shares this struct with the WASM crate"
)]
pub struct SignatureValue {
    pub byte_range: Option<[u64; 4]>,
    pub revision_end: Option<usize>,
    pub sub_filter: Option<Vec<u8>>,
}

#[derive(Clone, Debug)]
#[expect(
    clippy::exhaustive_structs,
    reason = "the internal ABI shares this struct with the WASM crate"
)]
pub struct FieldLock {
    pub action: Option<String>,
    pub fields: Vec<String>,
}

#[derive(Clone, Debug)]
#[expect(
    clippy::exhaustive_structs,
    reason = "the internal ABI shares this struct with the WASM crate"
)]
pub struct Widget {
    pub page: Option<u32>,
    pub rect: Option<[f64; 4]>,
    pub reference: Option<ObjRef>,
}

#[derive(Debug)]
#[expect(
    clippy::exhaustive_structs,
    reason = "the internal ABI shares this struct with the WASM crate"
)]
pub struct PreparedSignature {
    pub byte_range: [usize; 4],
    pub contents_end: usize,
    pub contents_start: usize,
    pub pdf: Vec<u8>,
    pub sha256: [u8; 32],
    pub sha512: Option<Vec<u8>>,
}

#[derive(Debug)]
#[expect(
    clippy::exhaustive_structs,
    reason = "the internal ABI shares this struct with the WASM crate"
)]
pub struct PreparedUpdate {
    pub appendix: Vec<u8>,
    pub byte_range: [usize; 4],
    pub contents_end: usize,
    pub contents_start: usize,
}

#[derive(Debug)]
#[expect(
    clippy::exhaustive_structs,
    reason = "the WASM ABI serializes the policy"
)]
pub struct SignaturePolicy {
    pub byte_range: [u64; 4],
    pub doc_mdp: Option<u32>,
    pub field_locks: Vec<FieldLock>,
    pub field_name: String,
}

pub(crate) struct RevisionField {
    pub(crate) name: String,
    pub(crate) references: Vec<ObjRef>,
    pub(crate) signature: bool,
    pub(crate) value: Option<Object>,
}

#[derive(Debug)]
struct Field {
    lock: Option<Object>,
    name: String,
    reference: Option<ObjRef>,
    signature: bool,
    terminal: bool,
    value: Option<Object>,
    widgets: Vec<Widget>,
}

struct FieldTree<'doc, 'data> {
    annotations: HashMap<ObjRef, u32>,
    characters: usize,
    document: &'doc Document<'data>,
    fields: Vec<Field>,
    pages: HashMap<ObjRef, u32>,
    seen: HashSet<ObjRef>,
    work: usize,
}

#[derive(Clone, Copy, Debug)]
struct FieldContext<'field> {
    depth: usize,
    name: &'field str,
    signature: bool,
    value: Option<&'field Object>,
}

#[derive(Debug)]
enum Selection<'data> {
    Create(NewField<'data>),
    Existing(&'data str),
}

#[derive(Debug)]
struct NewField<'data> {
    name: &'data str,
    page: u32,
    rect: [f64; 4],
}

#[derive(Debug)]
struct Request<'data> {
    appearance: Option<Appearance<'data>>,
    capacity: u32,
    certification: u32,
    date: &'data str,
    lock: Option<FieldLock>,
    metadata: [Option<&'data str>; 3],
    selection: Selection<'data>,
    sha512: bool,
    sub_filter: &'static [u8],
}

#[derive(Debug)]
struct Appearance<'data> {
    border: Option<Border>,
    image: Option<Image<'data>>,
    lines: Vec<Line<'data>>,
}

#[derive(Debug)]
struct Border {
    color: Color,
    width: f64,
}

#[derive(Debug)]
struct Image<'data> {
    png: &'data [u8],
    rect: [f64; 4],
}

#[derive(Debug)]
struct Line<'data> {
    bold: bool,
    color: Color,
    position: [f64; 2],
    size: f64,
    text: &'data str,
}

#[derive(Debug)]
enum Color {
    Gray(f64),
    Rgb([f64; 3]),
}

struct Objects(u32);

impl Objects {
    fn reserve(&mut self) -> Outcome<ObjRef> {
        let number = self.0;
        self.0 = number
            .checked_add(1)
            .ok_or_else(|| Failure::limit("signature object number overflow"))?;
        Ok(ObjRef {
            number,
            generation: 0,
        })
    }
}

impl<'data> Request<'data> {
    fn decode(payload: &'data [u8]) -> Outcome<Self> {
        let mut reader = Reader {
            data: payload,
            pos: 0,
        };
        if reader.u32()? != REQUEST_MAGIC || reader.u32()? != 1 {
            return Err(Failure::request(
                "unsupported signature preparation payload",
            ));
        }
        let selector = reader.u32()?;
        let selection = match selector {
            0 => Selection::Existing(read_field_name(&mut reader)?),
            1 => Selection::Create(read_new_field(&mut reader)?),
            _ => return Err(Failure::request("unknown signature field selector")),
        };
        let capacity = reader.u32()?;
        if capacity == 0 || capacity > MAX_SIGNATURE_CONTENTS {
            return Err(Failure::request(
                "signature contents capacity is out of range",
            ));
        }
        let sub_filter: &[u8] = match reader.u32()? {
            0 => b"ETSI.CAdES.detached",
            1 => b"adbe.pkcs7.detached",
            _ => return Err(Failure::request("unsupported signature SubFilter")),
        };
        let sha512 = reader.flag()?;
        let certification = reader.u32()?;
        if certification > 3 {
            return Err(Failure::request("invalid DocMDP permission"));
        }
        let date = reader.text()?;
        if !pdf_date(date) {
            return Err(Failure::request("invalid PDF signature date"));
        }
        let mut metadata = [None; 3];
        for value in &mut metadata {
            if reader.flag()? {
                *value = Some(reader.text()?);
            }
        }
        let lock = read_lock(&mut reader)?;
        let appearance = read_appearance(&mut reader)?;
        if reader.pos != payload.len() {
            return Err(Failure::request(
                "signature preparation payload has trailing bytes",
            ));
        }
        Ok(Self {
            appearance,
            capacity,
            certification,
            date,
            lock,
            metadata,
            selection,
            sha512,
            sub_filter,
        })
    }
}

impl<'doc, 'data> FieldTree<'doc, 'data> {
    fn read(document: &'doc Document<'data>, pages: bool) -> Outcome<Self> {
        let mut tree = Self {
            annotations: HashMap::new(),
            document,
            fields: Vec::new(),
            pages: HashMap::new(),
            seen: HashSet::new(),
            work: 0,
            characters: 0,
        };
        if pages {
            tree.read_pages()?;
        }
        let catalog = document
            .catalog()?
            .ok_or_else(|| Failure::invalid("missing catalog"))?;
        let dict = catalog
            .as_dict()
            .ok_or_else(|| Failure::invalid("invalid catalog"))?;
        if let Some(form) = resolved(document, dict, b"AcroForm")?
            && !matches!(*form, Object::Null)
        {
            let form_dict = form
                .as_dict()
                .ok_or_else(|| Failure::invalid("invalid AcroForm"))?;
            for field in array(document, form_dict, b"Fields")? {
                tree.visit(
                    &field,
                    FieldContext {
                        depth: 0,
                        name: "",
                        signature: false,
                        value: None,
                    },
                )?;
            }
        }
        Ok(tree)
    }

    fn read_pages(&mut self) -> Outcome<()> {
        let mut annotation_count = 0_usize;
        for (index, page) in self.document.pages()?.iter().enumerate() {
            let page_index = u32::try_from(index)
                .map_err(|_cause| Failure::limit("page index exceeds its limit"))?;
            if let Some(reference) = page.obj_ref {
                let _: Option<u32> = self.pages.insert(reference, page_index);
            }
            let items = annotation_items(self.document, page)?.unwrap_or_default();
            annotation_count = annotation_count.saturating_add(items.len());
            if items.len() > MAX_ANNOTATIONS || annotation_count > 200_000 {
                return Err(Failure::limit("too many page annotations"));
            }
            for reference in items.iter().filter_map(Object::as_reference) {
                if let Some(previous) = self.annotations.insert(reference, page_index)
                    && previous != page_index
                {
                    return Err(Failure::invalid("annotation belongs to multiple pages"));
                }
            }
        }
        Ok(())
    }

    fn step(&mut self, object: &Object, depth: usize) -> Outcome<()> {
        self.work = self.work.saturating_add(1);
        if depth > MAX_FIELD_DEPTH || self.work > MAX_FIELD_NODES {
            return Err(Failure::limit("AcroForm tree exceeds its traversal limit"));
        }
        if let Some(reference) = object.as_reference()
            && !self.seen.insert(reference)
        {
            return Err(Failure::invalid("cyclic or repeated AcroForm reference"));
        }
        Ok(())
    }

    fn visit(&mut self, object: &Object, parent: FieldContext<'_>) -> Outcome<()> {
        self.step(object, parent.depth)?;
        let field = self.document.follow(object)?;
        let dict = field
            .as_dict()
            .ok_or_else(|| Failure::invalid("invalid AcroForm field"))?;
        let title = field_title(self.document, dict)?;
        let name = title.as_ref().map_or_else(
            || parent.name.to_owned(),
            |partial| qualify(parent.name, partial),
        );
        let length = name.encode_utf16().count();
        self.characters = self.characters.saturating_add(length);
        if length > MAX_FIELD_NAME || self.characters > MAX_FIELD_CHARACTERS {
            return Err(Failure::limit(
                "AcroForm field names exceed their size limit",
            ));
        }
        let signature =
            field_type(self.document, dict)?.map_or(parent.signature, |kind| kind == b"Sig");
        let value = dict
            .get(b"V")
            .filter(|item| !matches!(item, Object::Null))
            .or(parent.value);
        let mut widgets = Vec::new();
        if named(self.document, dict, b"Subtype", b"Widget")? {
            widgets.push(self.widget(object, dict)?);
        }
        let mut terminal = true;
        let mut widget_value = None;
        for kid in array(self.document, dict, b"Kids")? {
            let child = self.document.follow(&kid)?;
            let child_dict = child
                .as_dict()
                .ok_or_else(|| Failure::invalid("invalid AcroForm kid"))?;
            if child_dict.get(b"T").is_none()
                && child_dict.get(b"FT").is_none()
                && named(self.document, child_dict, b"Subtype", b"Widget")?
            {
                self.step(&kid, parent.depth.saturating_add(1))?;
                widgets.push(self.widget(&kid, child_dict)?);
                if signature {
                    widget_value = widget_value.or_else(|| {
                        child_dict
                            .get(b"V")
                            .filter(|item| !matches!(item, Object::Null))
                            .cloned()
                    });
                }
            } else {
                terminal = false;
                self.visit(
                    &kid,
                    FieldContext {
                        depth: parent.depth.saturating_add(1),
                        name: &name,
                        signature,
                        value,
                    },
                )?;
            }
        }
        self.fields.push(Field {
            lock: dict.get(b"Lock").cloned(),
            name,
            reference: object.as_reference(),
            signature,
            terminal,
            value: value.cloned().or(widget_value),
            widgets,
        });
        Ok(())
    }

    fn widget(&self, object: &Object, dict: &Dict) -> Outcome<Widget> {
        let reference = object.as_reference();
        let page = reference
            .and_then(|key| self.annotations.get(&key).copied())
            .or_else(|| {
                let key = dict.get(b"P").and_then(Object::as_reference)?;
                self.pages.get(&key).copied()
            });
        Ok(Widget {
            page,
            rect: rect_tuple(self.document, dict)?,
            reference,
        })
    }
}

impl Color {
    fn write(&self, contents: &mut Vec<u8>, stroke: bool) {
        let operator: &[u8] = match self {
            Self::Gray(gray) => {
                operands(contents, &[*gray]);
                if stroke { b" G\n" } else { b" g\n" }
            }
            Self::Rgb(rgb) => {
                operands(contents, rgb);
                if stroke { b" RG\n" } else { b" rg\n" }
            }
        };
        contents.extend_from_slice(operator);
    }
}

fn pdf_date(value: &str) -> bool {
    let Some(body) = value.strip_prefix("D:") else {
        return false;
    };
    let digits = body.bytes().take_while(u8::is_ascii_digit).count();
    if !(4..=14).contains(&digits) || !digits.is_multiple_of(2) {
        return false;
    }
    let Some((numbers, zone)) = body.split_at_checked(digits) else {
        return false;
    };
    let valid_parts = numbers
        .as_bytes()
        .get(4..)
        .unwrap_or_default()
        .as_chunks::<2>()
        .0
        .iter()
        .zip([(1, 12), (1, 31), (0, 23), (0, 59), (0, 59)])
        .all(|(pair, (low, high))| (low..=high).contains(&decimal_pair(*pair)));
    let valid_zone = match zone.as_bytes() {
        b"" | b"Z" => true,
        [b'+' | b'-', h1, h2, b'\'', m1, m2, b'\''] => {
            [h1, h2, m1, m2].into_iter().all(u8::is_ascii_digit)
                && decimal_pair([*h1, *h2]) <= 23
                && decimal_pair([*m1, *m2]) <= 59
        }
        _ => false,
    };
    valid_parts && valid_zone
}

const fn decimal_pair([tens, ones]: [u8; 2]) -> u8 {
    tens.saturating_sub(b'0')
        .saturating_mul(10)
        .saturating_add(ones.saturating_sub(b'0'))
}

fn read_field_name<'data>(reader: &mut Reader<'data>) -> Outcome<&'data str> {
    let name = reader.text()?;
    if name.is_empty() || name.encode_utf16().count() > MAX_FIELD_NAME {
        return Err(Failure::request("signature field name is out of range"));
    }
    Ok(name)
}

fn read_new_field<'data>(reader: &mut Reader<'data>) -> Outcome<NewField<'data>> {
    let name = read_field_name(reader)?;
    if name.contains('.') {
        return Err(Failure::request(
            "a new signature field needs a single partial name",
        ));
    }
    Ok(NewField {
        name,
        page: reader.u32()?,
        rect: reader.coordinates(MAX_COORDINATE)?,
    })
}

fn read_lock(reader: &mut Reader<'_>) -> Outcome<Option<FieldLock>> {
    let action = match reader.u32()? {
        0 => return Ok(None),
        1 => "All",
        2 => "Include",
        3 => "Exclude",
        _ => return Err(Failure::request("unknown FieldMDP lock action")),
    };
    let count = read_field_count(reader)?;
    if (action == "All") != (count == 0) {
        return Err(Failure::request(
            "FieldMDP lock fields do not match its action",
        ));
    }
    let mut fields = Vec::new();
    for _ in 0..count {
        let name = reader.text()?;
        if name.is_empty() || name.encode_utf16().count() > MAX_FIELD_NAME {
            return Err(Failure::request("FieldMDP field name is out of range"));
        }
        fields.push(name.to_owned());
    }
    Ok(Some(FieldLock {
        action: Some(action.to_owned()),
        fields,
    }))
}

fn read_field_count(reader: &mut Reader<'_>) -> Outcome<usize> {
    let count = widen(reader.u32()?);
    if count > MAX_FIELD_NODES {
        return Err(Failure::limit("too many FieldMDP lock fields"));
    }
    Ok(count)
}

fn read_color(reader: &mut Reader<'_>) -> Outcome<Color> {
    let color = match reader.u32()? {
        1 => {
            let [gray] = reader.coordinates(MAX_COORDINATE)?;
            Color::Gray(gray)
        }
        3 => Color::Rgb(reader.coordinates(MAX_COORDINATE)?),
        _ => return Err(Failure::request("signature color must be gray or RGB")),
    };
    let valid = match &color {
        Color::Gray(gray) => (0.0_f64..=1.0_f64).contains(gray),
        Color::Rgb(rgb) => rgb.iter().all(|value| (0.0_f64..=1.0_f64).contains(value)),
    };
    if !valid {
        return Err(Failure::request(
            "signature color component is out of range",
        ));
    }
    Ok(color)
}

fn read_appearance<'data>(reader: &mut Reader<'data>) -> Outcome<Option<Appearance<'data>>> {
    if !reader.flag()? {
        return Ok(None);
    }
    let count = reader.u32()?;
    if count > MAX_APPEARANCE_LINES {
        return Err(Failure::limit("too many signature appearance lines"));
    }
    let mut lines = Vec::new();
    for _ in 0..count {
        let bold = reader.flag()?;
        let [size, point_x, point_y] = reader.coordinates(MAX_COORDINATE)?;
        let color = read_color(reader)?;
        let text = reader.text()?;
        if size <= 0.0_f64 {
            return Err(Failure::request("signature font size must be positive"));
        }
        lines.push(Line {
            bold,
            color,
            position: [point_x, point_y],
            size,
            text,
        });
    }
    let border = if reader.flag()? {
        let [width] = reader.coordinates(MAX_COORDINATE)?;
        if width <= 0.0_f64 {
            return Err(Failure::request("signature border width must be positive"));
        }
        Some(Border {
            color: read_color(reader)?,
            width,
        })
    } else {
        None
    };
    let image = if reader.flag()? {
        Some(Image {
            rect: reader.coordinates(MAX_COORDINATE)?,
            png: reader.bytes()?,
        })
    } else {
        None
    };
    Ok(Some(Appearance {
        border,
        image,
        lines,
    }))
}

fn resolved(document: &Document<'_>, dict: &Dict, key: &[u8]) -> Outcome<Option<Rc<Object>>> {
    dict.get(key)
        .map(|value| document.follow(value))
        .transpose()
}

fn array(document: &Document<'_>, dict: &Dict, key: &[u8]) -> Outcome<Vec<Object>> {
    match resolved(document, dict, key)?.as_deref() {
        None | Some(Object::Null) => Ok(Vec::new()),
        Some(Object::Array(items)) => Ok(items.clone()),
        Some(_) => Err(Failure::invalid(
            "expected array in PDF signature structure",
        )),
    }
}

fn named(document: &Document<'_>, dict: &Dict, key: &[u8], name: &[u8]) -> Outcome<bool> {
    Ok(resolved(document, dict, key)?.is_some_and(|value| value.as_name() == Some(name)))
}

fn doc_mdp(document: &Document<'_>) -> Outcome<(bool, Option<u32>)> {
    let catalog = document
        .catalog()?
        .ok_or_else(|| Failure::invalid("missing catalog"))?;
    let catalog_dict = catalog
        .as_dict()
        .ok_or_else(|| Failure::invalid("invalid catalog"))?;
    let Some(perms) = resolved(document, catalog_dict, b"Perms")? else {
        return Ok((false, None));
    };
    let Some(doc_mdp_entry) = perms.as_dict().and_then(|dict| dict.get(b"DocMDP")) else {
        return Ok((false, None));
    };
    let signature = document.follow(doc_mdp_entry)?;
    Ok((true, doc_mdp_permission(document, &signature)?))
}

fn doc_mdp_permission(document: &Document<'_>, signature: &Object) -> Outcome<Option<u32>> {
    let Some(dict) = signature.as_dict() else {
        return Ok(None);
    };
    for entry in array(document, dict, b"Reference")? {
        let reference = document.follow(&entry)?;
        if let Some(reference_dict) = reference.as_dict()
            && named(document, reference_dict, b"TransformMethod", b"DocMDP")?
            && let Some(params) = resolved(document, reference_dict, b"TransformParams")?
            && let Some(params_dict) = params.as_dict()
        {
            let permission = resolved(document, params_dict, b"P")?
                .and_then(|value| value.as_integer())
                .and_then(|number| u32::try_from(number).ok())
                .filter(|number| (1..=3).contains(number));
            return Ok(permission);
        }
    }
    Ok(None)
}

fn read_field_lock(document: &Document<'_>, object: &Object) -> Outcome<FieldLock> {
    let lock = document.follow(object)?;
    let Some(dict) = lock.as_dict() else {
        return Ok(FieldLock {
            action: None,
            fields: Vec::new(),
        });
    };
    let action = resolved(document, dict, b"Action")?.and_then(|value| {
        value
            .as_name()
            .map(|name| String::from_utf8_lossy(name).into_owned())
    });
    let mut fields = Vec::new();
    for item in array(document, dict, b"Fields")? {
        if let Some(text) = document.follow(&item)?.as_string() {
            fields.push(decode_text_string(text));
        }
    }
    Ok(FieldLock { action, fields })
}

#[inline(never)]
fn field_locked(
    document: &Document<'_>,
    tree: &FieldTree<'_, '_>,
    names: &[&str],
) -> Outcome<bool> {
    let applies = |lock: FieldLock| {
        names.iter().any(|name| {
            let listed = lock.fields.iter().any(|field| {
                *name == field
                    || name
                        .strip_prefix(field)
                        .is_some_and(|tail| tail.starts_with('.'))
            });
            match lock.action.as_deref() {
                Some("Include") => lock.fields.is_empty() || listed,
                Some("Exclude") => !listed,
                _ => true,
            }
        })
    };
    for field in tree.fields.iter().filter(|field| field.signature) {
        let Some(value) = &field.value else { continue };
        if let Some(lock) = &field.lock
            && applies(read_field_lock(document, lock)?)
        {
            return Ok(true);
        }
        let signature = document.follow(value)?;
        let Some(dict) = signature.as_dict() else {
            continue;
        };
        for entry in array(document, dict, b"Reference")? {
            let resolved_entry = document.follow(&entry)?;
            let Some(reference) = resolved_entry.as_dict() else {
                continue;
            };
            if named(document, reference, b"TransformMethod", b"FieldMDP")?
                && match reference.get(b"TransformParams") {
                    Some(params) => applies(read_field_lock(document, params)?),
                    None => true,
                }
            {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

#[inline(never)]
fn check_historical_transforms(
    pdf: &[u8],
    names: &[&str],
    adding_fields: bool,
    limits: &Limits,
) -> Outcome<()> {
    let report = analyze(pdf, Analysis::Verification);
    if report.failure.is_some() {
        return Err(Failure::request(
            "could not verify existing signature revisions",
        ));
    }
    let mut checked = Vec::new();
    for signature in report.dictionaries {
        let Some([_, _, offset, length]) = signature.byte_range_values else {
            continue;
        };
        let end = usize::try_from(f64_to_i64(offset + length))
            .map_err(|_cause| Failure::invalid("invalid signed revision end"))?;
        if end == pdf.len() || checked.contains(&end) {
            continue;
        }
        checked.push(end);
        let bytes = pdf
            .get(..end)
            .ok_or_else(|| Failure::invalid("invalid signed revision end"))?;
        let document = Document::open(bytes, limits)?;
        let (certified, permission) = doc_mdp(&document)?;
        if certified && (adding_fields || !matches!(permission, Some(2 | 3))) {
            return Err(Failure::request("DocMDP forbids signing this document"));
        }
        if field_locked(&document, &FieldTree::read(&document, false)?, names)? {
            return Err(Failure::request(
                "FieldMDP forbids changing the selected field",
            ));
        }
    }
    Ok(())
}

fn signature_value(
    document: &Document<'_>,
    index: &RevisionIndex<'_>,
    object: &Object,
) -> Outcome<Option<SignatureValue>> {
    let signature = document.follow(object)?;
    let Some(dict) = signature.as_dict() else {
        return Ok(None);
    };
    let items = array(document, dict, b"ByteRange")?;
    let byte_range = if let [first, first_len, second, second_len] = items.as_slice() {
        let number = |item: &Object| -> Outcome<Option<u64>> {
            Ok(document
                .follow(item)?
                .as_integer()
                .and_then(|value| u64::try_from(value).ok())
                .filter(|value| *value <= 0x001F_FFFF_FFFF_FFFF))
        };
        match (
            number(first)?,
            number(first_len)?,
            number(second)?,
            number(second_len)?,
        ) {
            (Some(a), Some(b), Some(c), Some(d)) => Some([a, b, c, d]),
            _ => None,
        }
    } else {
        None
    };
    let revision_end = byte_range
        .filter(|[first, length, start, _]| *first == 0 && length < start)
        .and_then(|[_, _, start, count]| usize::try_from(start.checked_add(count)?).ok())
        .filter(|&end| index.contains_end(end));
    let sub_filter = resolved(document, dict, b"SubFilter")?
        .and_then(|value| value.as_name().map(<[u8]>::to_vec));
    Ok(Some(SignatureValue {
        byte_range,
        revision_end,
        sub_filter,
    }))
}

#[expect(
    clippy::missing_errors_doc,
    reason = "the TypeScript bindings document the public error contract"
)]
#[expect(
    clippy::missing_inline_in_public_items,
    reason = "release LTO chooses inlining across the internal Rust boundary"
)]
pub fn signature_fields(pdf: &[u8], limits: &Limits) -> Outcome<SignatureFields> {
    let index = revision_index(pdf)?;
    let document = Document::open(index.current(), limits)?;
    let tree = FieldTree::read(&document, true)?;
    let (_, permission) = doc_mdp(&document)?;
    let mut fields = Vec::new();
    for field in tree.fields.into_iter().filter(|field| field.signature) {
        let signed = field.value.is_some();
        let value = field
            .value
            .as_ref()
            .map(|value| signature_value(&document, &index, value))
            .transpose()?
            .flatten();
        let lock = field
            .lock
            .as_ref()
            .map(|object| read_field_lock(&document, object))
            .transpose()?;
        fields.push(SignatureField {
            lock,
            name: field.name,
            reference: field.reference,
            signed,
            value,
            widgets: field.widgets,
        });
    }
    Ok(SignatureFields {
        doc_mdp: permission,
        fields,
        revisions: index.ends(),
    })
}

fn name(value: &[u8]) -> Object {
    Object::Name(value.to_vec())
}

fn pdf_text(value: &str) -> Object {
    if value.is_ascii() {
        return Object::String(value.as_bytes().to_vec());
    }
    Object::String(
        [0xfe_u8, 0xff]
            .into_iter()
            .chain(value.encode_utf16().flat_map(u16::to_be_bytes))
            .collect(),
    )
}

fn dictionary<const COUNT: usize>(entries: [(&[u8], Object); COUNT]) -> Dict {
    let mut dict = Dict::default();
    for (key, value) in entries {
        dict.insert(key, value);
    }
    dict
}

fn signature_dictionary(request: &Request<'_>, root: ObjRef, lock: Option<&FieldLock>) -> Dict {
    let mut dict = dictionary([
        (
            b"ByteRange",
            Object::Array(vec![Object::Integer(RANGE_PLACEHOLDER); 4]),
        ),
        (
            b"Contents",
            Object::String(vec![0; widen(request.capacity)]),
        ),
        (b"Type", name(b"Sig")),
        (b"Filter", name(b"Adobe.PPKLite")),
        (b"SubFilter", name(request.sub_filter)),
        (b"M", pdf_text(request.date)),
    ]);
    for (key, value) in [b"Reason".as_slice(), b"Location", b"ContactInfo"]
        .into_iter()
        .zip(request.metadata)
    {
        if let Some(text) = value {
            dict.insert(key, pdf_text(text));
        }
    }
    let mut references = Vec::new();
    if request.certification != 0 {
        let params = dictionary([
            (b"Type", name(b"TransformParams")),
            (b"P", Object::Integer(i64::from(request.certification))),
            (b"V", name(b"1.2")),
        ]);
        let reference = dictionary([
            (b"Type", name(b"SigRef")),
            (b"TransformMethod", name(b"DocMDP")),
            (b"TransformParams", Object::Dict(params)),
            (b"Data", Object::Ref(root)),
        ]);
        references.push(Object::Dict(reference));
    }
    if let Some(field_lock) = lock {
        let mut params = lock_dictionary(field_lock);
        params.insert(b"Type", name(b"TransformParams"));
        params.insert(b"V", name(b"1.2"));
        references.push(Object::Dict(dictionary([
            (b"Type", name(b"SigRef")),
            (b"TransformMethod", name(b"FieldMDP")),
            (b"TransformParams", Object::Dict(params)),
            (b"Data", Object::Ref(root)),
        ])));
    }
    if !references.is_empty() {
        dict.insert(b"Reference", Object::Array(references));
    }
    dict
}

fn lock_dictionary(lock: &FieldLock) -> Dict {
    let mut dict = dictionary([(b"Type", name(b"SigFieldLock"))]);
    if let Some(action) = &lock.action {
        dict.insert(b"Action", name(action.as_bytes()));
    }
    if !lock.fields.is_empty() {
        dict.insert(
            b"Fields",
            Object::Array(lock.fields.iter().map(|value| pdf_text(value)).collect()),
        );
    }
    dict
}

const fn widget_for_page(page: u32, rect: [f64; 4], reference: ObjRef) -> Widget {
    Widget {
        page: Some(page),
        rect: Some(rect),
        reference: Some(reference),
    }
}

#[inline(never)]
fn create_field(
    store: &mut Store<'_, '_>,
    field: &NewField<'_>,
    lock: Option<&FieldLock>,
    reference: ObjRef,
) -> Outcome<Widget> {
    let _: [f64; 2] = dimensions(field.rect)?;
    let mut dict = dictionary([
        (b"Type", name(b"Annot")),
        (b"Subtype", name(b"Widget")),
        (b"FT", name(b"Sig")),
        (b"T", pdf_text(field.name)),
        (b"Rect", rect_object(field.rect)),
    ]);
    if let Some(value) = lock {
        dict.insert(b"Lock", Object::Dict(lock_dictionary(value)));
    }
    store.set_body(reference, Object::Dict(dict), None);
    let catalog = store
        .document
        .catalog()?
        .ok_or_else(|| Failure::invalid("missing catalog"))?;
    if let Some(catalog_dict) = catalog.as_dict()
        && matches!(
            resolved(store.document, catalog_dict, b"AcroForm")?.as_deref(),
            Some(Object::Null)
        )
    {
        let root = store.root_ref()?;
        dict_of(store.object_mut(root)?)?.insert(b"AcroForm", Object::Dict(Dict::default()));
    }
    let target = Target {
        base: Base::Catalog,
        path: vec![Step::Key(b"AcroForm".to_vec())],
    };
    store.edit_array(&target, b"Fields", Object::Ref(reference), true)?;
    Ok(widget_for_page(field.page, field.rect, reference))
}

fn select_field(
    store: &mut Store<'_, '_>,
    objects: &mut Objects,
    tree: &FieldTree<'_, '_>,
    request: &Request<'_>,
) -> Outcome<(ObjRef, Vec<Widget>)> {
    match &request.selection {
        Selection::Create(new) => {
            if tree.fields.iter().any(|field| field.name == new.name) {
                return Err(Failure::request("signature field name already exists"));
            }
            let reference = objects.reserve()?;
            let widget = create_field(store, new, request.lock.as_ref(), reference)?;
            Ok((reference, vec![widget]))
        }
        Selection::Existing(title) => {
            let mut selected = tree.fields.iter().filter(|field| field.name == *title);
            let field = selected
                .next()
                .ok_or_else(|| Failure::request("signature field is missing"))?;
            if selected.next().is_some() {
                return Err(Failure::request("signature field name is ambiguous"));
            }
            if !field.signature || !field.terminal {
                return Err(Failure::request(
                    "selected field is not a terminal signature field",
                ));
            }
            if field.value.is_some() {
                return Err(Failure::request("signature field is already signed"));
            }
            if request.lock.is_some() {
                return Err(Failure::request(
                    "a FieldMDP lock can only be supplied for a new field",
                ));
            }
            let reference = field
                .reference
                .ok_or_else(|| Failure::request("signature field must be indirect"))?;
            Ok((reference, field.widgets.clone()))
        }
    }
}

fn dimensions([left, bottom, right, top]: [f64; 4]) -> Outcome<[f64; 2]> {
    let width = right - left;
    let height = top - bottom;
    if !(0.0_f64..=MAX_COORDINATE).contains(&width) || !(0.0_f64..=MAX_COORDINATE).contains(&height)
    {
        return Err(Failure::request("signature rectangle is out of range"));
    }
    Ok([width, height])
}

fn write_widget(
    store: &mut Store<'_, '_>,
    objects: &mut Objects,
    widget: &Widget,
    appearance: Option<&Appearance<'_>>,
    tree: &FieldTree<'_, '_>,
) -> Outcome<()> {
    let reference = widget
        .reference
        .ok_or_else(|| Failure::request("signature widget must be indirect"))?;
    let page = widget
        .page
        .ok_or_else(|| Failure::request("signature widget has no page"))?;
    let page_ref = store.page_ref(page)?;
    let normal = match appearance {
        Some(spec) => {
            let rect = widget
                .rect
                .ok_or_else(|| Failure::request("signature widget has no rectangle"))?;
            Some(write_appearance(store, objects, dimensions(rect)?, spec)?)
        }
        None => None,
    };
    let dict = dict_of(store.object_mut(reference)?)?;
    dict.insert(b"F", Object::Integer(4));
    dict.insert(b"P", Object::Ref(page_ref));
    if let Some(form) = normal {
        dict.insert(b"AP", Object::Dict(dictionary([(b"N", Object::Ref(form))])));
    }
    if !tree.annotations.contains_key(&reference) {
        store.edit_array(
            &Target {
                base: Base::Page(page),
                path: Vec::new(),
            },
            b"Annots",
            Object::Ref(reference),
            true,
        )?;
    }
    Ok(())
}

fn write_appearance(
    store: &mut Store<'_, '_>,
    objects: &mut Objects,
    [width, height]: [f64; 2],
    spec: &Appearance<'_>,
) -> Outcome<ObjRef> {
    if width <= 0.0_f64 || height <= 0.0_f64 {
        return Err(Failure::request(
            "visible signatures need a positive rectangle",
        ));
    }
    let mut resources = Dict::default();
    let mut contents = Vec::new();
    if let Some(image) = &spec.image {
        let [left, bottom, right, top] = image.rect;
        let [image_width, image_height] = dimensions(image.rect)?;
        if left < 0.0_f64
            || bottom < 0.0_f64
            || right > width
            || top > height
            || image_width <= 0.0_f64
            || image_height <= 0.0_f64
        {
            return Err(Failure::request(
                "signature image must fit inside the appearance",
            ));
        }
        let decoded = png::decode(image.png)?;
        let reference = objects.reserve()?;
        let mask = if decoded.alpha {
            Some(objects.reserve()?)
        } else {
            None
        };
        store.store_image(reference, mask, decoded)?;
        resources.insert(
            b"XObject",
            Object::Dict(dictionary([(b"Im", Object::Ref(reference))])),
        );
        contents.extend_from_slice(b"q ");
        operands(
            &mut contents,
            &[image_width, 0.0_f64, 0.0_f64, image_height, left, bottom],
        );
        contents.extend_from_slice(b" cm /Im Do Q\n");
    }
    if let Some(border) = &spec.border {
        let half = border.width * 0.5_f64;
        if border.width > width || border.width > height {
            return Err(Failure::request(
                "signature border is wider than the appearance",
            ));
        }
        border.color.write(&mut contents, true);
        operands(&mut contents, &[border.width]);
        contents.extend_from_slice(b" w ");
        operands(
            &mut contents,
            &[half, half, width - border.width, height - border.width],
        );
        contents.extend_from_slice(b" re S\n");
    }
    write_lines(
        store,
        objects,
        width,
        height,
        &spec.lines,
        &mut resources,
        &mut contents,
    )?;
    let form = objects.reserve()?;
    let dict = dictionary([
        (b"Type", name(b"XObject")),
        (b"Subtype", name(b"Form")),
        (b"BBox", rect_object([0.0_f64, 0.0_f64, width, height])),
        (b"Resources", Object::Dict(resources)),
    ]);
    store.set_stream(form, dict, contents, false);
    Ok(form)
}

fn write_lines(
    store: &mut Store<'_, '_>,
    objects: &mut Objects,
    width: f64,
    height: f64,
    lines: &[Line<'_>],
    resources: &mut Dict,
    contents: &mut Vec<u8>,
) -> Outcome<()> {
    let mut fonts = Dict::default();
    for (bold, key, font) in [
        (false, b"FR".as_slice(), b"Helvetica".as_slice()),
        (true, b"FB", b"Helvetica-Bold"),
    ] {
        if lines.iter().any(|line| line.bold == bold) {
            let reference = objects.reserve()?;
            store.set_body(reference, standard_font(font)?, None);
            fonts.insert(key, Object::Ref(reference));
        }
    }
    if !lines.is_empty() {
        resources.insert(b"Font", Object::Dict(fonts));
    }
    for line in lines {
        let [point_x, point_y] = line.position;
        if !(0.0_f64..=width).contains(&point_x) || !(0.0_f64..=height).contains(&point_y) {
            return Err(Failure::request(
                "signature text position must be inside the appearance",
            ));
        }
        let text = line
            .text
            .chars()
            .map(|character| {
                let unicode = u16::try_from(u32::from(character)).unwrap_or(0);
                if matches!(unicode, 0x20..=0x7E | 0xA0..=0xFF) {
                    return u8::try_from(unicode).ok();
                }
                (0x80_u8..=0x9F).find(|&code| unicode != 0 && win_ansi_unicode(code) == unicode)
            })
            .collect::<Option<Vec<u8>>>()
            .ok_or_else(|| Failure::request("signature text is outside WinAnsiEncoding"))?;
        line.color.write(contents, false);
        contents.extend_from_slice(if line.bold { b"BT /FB " } else { b"BT /FR " });
        operands(contents, &[line.size]);
        contents.extend_from_slice(b" Tf ");
        operands(contents, &line.position);
        contents.extend_from_slice(b" Td ");
        serialize(contents, &Object::String(text), &Object::Ref);
        contents.extend_from_slice(b" Tj ET\n");
    }
    Ok(())
}

fn operands(contents: &mut Vec<u8>, numbers: &[f64]) {
    for &number in numbers {
        serialize(contents, &number_object(number), &Object::Ref);
    }
}

fn ensure_first_signature(
    document: &Document<'_>,
    tree: &FieldTree<'_, '_>,
    certified: bool,
) -> Outcome<()> {
    if certified
        || tree
            .fields
            .iter()
            .any(|field| field.signature && field.value.is_some())
    {
        return Err(Failure::request(
            "DocMDP certification must be the first signature",
        ));
    }
    let report = analyze(document.bytes(), Analysis::Verification);
    if report.failure.is_some() || !report.dictionaries.is_empty() {
        return Err(Failure::request(
            "DocMDP certification requires a document without previous signatures",
        ));
    }
    Ok(())
}

pub(crate) fn signature_policies(
    document: &Document<'_>,
    index: &RevisionIndex<'_>,
) -> Outcome<Vec<SignaturePolicy>> {
    let catalog = document.catalog()?;
    let perms = match catalog.as_deref().and_then(Object::as_dict) {
        Some(dict) => resolved(document, dict, b"Perms")?,
        None => None,
    };
    let certification = perms
        .as_deref()
        .and_then(Object::as_dict)
        .and_then(|dict| dict.get(b"DocMDP"));
    let mut policies = Vec::new();
    for field in FieldTree::read(document, false)?.fields {
        let Some(value) = field.value.filter(|_| field.signature && field.terminal) else {
            continue;
        };
        let Some(byte_range) =
            signature_value(document, index, &value)?.and_then(|signature| signature.byte_range)
        else {
            continue;
        };
        let signature = document.follow(&value)?;
        let mut field_locks = Vec::new();
        if let Some(dict) = signature.as_dict() {
            for item in array(document, dict, b"Reference")? {
                let resolved_item = document.follow(&item)?;
                if let Some(reference) = resolved_item.as_dict()
                    && named(document, reference, b"TransformMethod", b"FieldMDP")?
                {
                    field_locks.push(match reference.get(b"TransformParams") {
                        Some(params) => read_field_lock(document, params)?,
                        None => FieldLock {
                            action: None,
                            fields: Vec::new(),
                        },
                    });
                }
            }
        }
        policies.push(SignaturePolicy {
            byte_range,
            doc_mdp: if certification == Some(&value) {
                Some(doc_mdp_permission(document, &signature)?.unwrap_or(1))
            } else {
                None
            },
            field_locks,
            field_name: field.name,
        });
    }
    Ok(policies)
}

pub(crate) fn revision_fields(document: &Document<'_>) -> Outcome<Vec<RevisionField>> {
    Ok(FieldTree::read(document, false)?
        .fields
        .into_iter()
        .map(|field| {
            let mut references: Vec<_> = field.reference.into_iter().collect();
            references.extend(field.widgets.iter().filter_map(|widget| widget.reference));
            RevisionField {
                name: field.name,
                references,
                signature: field.signature,
                value: field.value,
            }
        })
        .collect())
}

#[expect(
    clippy::missing_errors_doc,
    reason = "the TypeScript bindings document the public error contract"
)]
#[expect(
    clippy::missing_inline_in_public_items,
    reason = "release LTO chooses inlining across the internal Rust boundary"
)]
pub fn prepare_signature(
    pdf: &[u8],
    payload: &[u8],
    limits: &Limits,
) -> Outcome<PreparedSignature> {
    let request = Request::decode(payload)?;
    let update = prepare_update(pdf, &request, limits)?;
    let [_, first, second, _] = update.byte_range;
    let first_tail = first.saturating_sub(pdf.len());
    let second_tail = second.saturating_sub(pdf.len());
    let parts = [
        pdf,
        update.appendix.get(..first_tail).unwrap_or_default(),
        update.appendix.get(second_tail..).unwrap_or_default(),
    ];
    let sha256 = sha256_parts(&parts);
    let sha512 = request.sha512.then(|| sha512_parts(&parts, false));
    let mut bytes = Vec::with_capacity(pdf.len().saturating_add(update.appendix.len()));
    bytes.extend_from_slice(pdf);
    bytes.extend_from_slice(&update.appendix);
    Ok(PreparedSignature {
        byte_range: update.byte_range,
        contents_end: update.contents_end,
        contents_start: update.contents_start,
        pdf: bytes,
        sha256,
        sha512,
    })
}

#[expect(
    clippy::missing_errors_doc,
    reason = "the TypeScript bindings document the public error contract"
)]
#[expect(
    clippy::missing_inline_in_public_items,
    reason = "release LTO chooses inlining across the internal Rust boundary"
)]
pub fn prepare_signature_update(
    pdf: &[u8],
    payload: &[u8],
    limits: &Limits,
) -> Outcome<PreparedUpdate> {
    prepare_update(pdf, &Request::decode(payload)?, limits)
}

#[expect(
    clippy::missing_errors_doc,
    reason = "the TypeScript bindings document the public error contract"
)]
#[expect(
    clippy::missing_inline_in_public_items,
    reason = "release LTO chooses inlining across the internal Rust boundary"
)]
pub fn add_signature_fields(pdf: &[u8], payload: &[u8], limits: &Limits) -> Outcome<Vec<u8>> {
    let mut reader = Reader {
        data: payload,
        pos: 0,
    };
    let count = read_field_count(&mut reader)?;
    if count == 0 {
        return Err(Failure::request("no signature fields supplied"));
    }
    let document = appendable(pdf, limits)?;
    let (certified, _) = doc_mdp(&document)?;
    if certified {
        return Err(Failure::request("DocMDP forbids creating signature fields"));
    }
    let tree = FieldTree::read(&document, true)?;
    let mut names = Vec::with_capacity(tree.fields.len().saturating_add(count));
    for field in &tree.fields {
        let name = field.name.as_str();
        if let Err(index) = names.binary_search(&name) {
            names.insert(index, name);
        }
    }
    let mut objects = Objects(next_object_number(&document));
    let mut store = Store {
        changed: Changes::default(),
        document: &document,
        pages: None,
    };
    let mut selected_names = Vec::with_capacity(count);
    for _ in 0..count {
        let field = read_new_field(&mut reader)?;
        let [left, bottom, right, top] = field.rect;
        if right <= left || top <= bottom {
            return Err(Failure::request("signature rectangle is empty"));
        }
        let Err(index) = names.binary_search(&field.name) else {
            return Err(Failure::request("signature field name already exists"));
        };
        names.insert(index, field.name);
        selected_names.push(field.name);
        let lock = read_lock(&mut reader)?;
        let widget = create_field(&mut store, &field, lock.as_ref(), objects.reserve()?)?;
        write_widget(&mut store, &mut objects, &widget, None, &tree)?;
    }
    if reader.pos != payload.len() {
        return Err(Failure::request(
            "signature fields payload has trailing bytes",
        ));
    }
    if field_locked(&document, &tree, &selected_names)? {
        return Err(Failure::request(
            "FieldMDP forbids changing the selected field",
        ));
    }
    check_historical_transforms(pdf, &selected_names, true, limits)?;
    incremental_update(&document, &store.changed, pdf, None).map(|(appendix, _)| appendix)
}

fn prepare_update(pdf: &[u8], request: &Request<'_>, limits: &Limits) -> Outcome<PreparedUpdate> {
    let document = appendable(pdf, limits)?;
    let (certified, permission) = doc_mdp(&document)?;
    if certified && !matches!(permission, Some(2 | 3)) {
        return Err(Failure::request("DocMDP forbids signing this document"));
    }
    let tree = FieldTree::read(
        &document,
        matches!(request.selection, Selection::Existing(_)),
    )?;
    if request.certification != 0 {
        ensure_first_signature(&document, &tree, certified)?;
    }
    let title = match &request.selection {
        Selection::Create(field) => field.name,
        Selection::Existing(name) => name,
    };
    if field_locked(&document, &tree, &[title])? {
        return Err(Failure::request(
            "FieldMDP forbids changing the selected field",
        ));
    }
    check_historical_transforms(pdf, &[title], false, limits)?;
    let lock = match &request.selection {
        Selection::Create(_) => request.lock.clone(),
        Selection::Existing(_) => tree
            .fields
            .iter()
            .find(|field| field.name == title)
            .and_then(|field| field.lock.as_ref())
            .map(|object| read_field_lock(&document, object))
            .transpose()?,
    };
    let mut objects = Objects(next_object_number(&document));
    let mut store = Store {
        changed: Changes::default(),
        document: &document,
        pages: None,
    };
    let signature = objects.reserve()?;
    let (field, widgets) = select_field(&mut store, &mut objects, &tree, request)?;
    if request.appearance.is_some() && widgets.is_empty() {
        return Err(Failure::request("visible signature field has no widget"));
    }
    for widget in &widgets {
        write_widget(
            &mut store,
            &mut objects,
            widget,
            request.appearance.as_ref(),
            &tree,
        )?;
    }
    dict_of(store.object_mut(field)?)?.insert(b"V", Object::Ref(signature));
    let root = store.root_ref()?;
    let target = Target {
        base: Base::Catalog,
        path: vec![Step::Key(b"AcroForm".to_vec())],
    };
    let (form_root, form_path) = store.locate(&target, true)?;
    store
        .dict_at(form_root, &form_path)?
        .insert(b"SigFlags", Object::Integer(3));
    if request.certification != 0 {
        let perms = Target {
            base: Base::Catalog,
            path: vec![Step::Key(b"Perms".to_vec())],
        };
        let (perms_root, perms_path) = store.locate(&perms, true)?;
        store
            .dict_at(perms_root, &perms_path)?
            .insert(b"DocMDP", Object::Ref(signature));
    }
    store.set_body(
        signature,
        Object::Dict(signature_dictionary(request, root, lock.as_ref())),
        None,
    );
    let (bytes, offset) = incremental_update(&document, &store.changed, pdf, Some(signature))?;
    let start = offset.ok_or_else(|| Failure::invalid("missing prepared signature object"))?;
    patch(bytes, pdf.len(), start, request.capacity)
}

#[expect(
    clippy::missing_errors_doc,
    clippy::missing_inline_in_public_items,
    reason = "the WASM bindings document the timestamp preparation contract"
)]
pub fn prepare_document_timestamp(pdf: &[u8], limits: &Limits) -> Outcome<PreparedUpdate> {
    let document = appendable(pdf, limits)?;
    let tree = FieldTree::read(&document, false)?;
    let mut objects = Objects(next_object_number(&document));
    let signature = objects.reserve()?;
    let field = objects.reserve()?;
    let mut title = format!("DocTimeStamp-{}", field.number);
    while tree.fields.iter().any(|entry| entry.name == title) {
        title.push('_');
    }
    let capacity = 0x4000;
    let mut store = Store {
        changed: Changes::default(),
        document: &document,
        pages: None,
    };
    let page = store.page_ref(0)?;
    store.set_body(
        field,
        Object::Dict(dictionary([
            (b"Type", name(b"Annot")),
            (b"Subtype", name(b"Widget")),
            (b"FT", name(b"Sig")),
            (b"T", pdf_text(&title)),
            (b"V", Object::Ref(signature)),
            (b"Rect", rect_object([0.0_f64; 4])),
            (b"F", Object::Integer(132)),
            (b"P", Object::Ref(page)),
        ])),
        None,
    );
    store.edit_array(
        &Target {
            base: Base::Page(0),
            path: Vec::new(),
        },
        b"Annots",
        Object::Ref(field),
        true,
    )?;
    let target = Target {
        base: Base::Catalog,
        path: vec![Step::Key(b"AcroForm".to_vec())],
    };
    store.edit_array(&target, b"Fields", Object::Ref(field), true)?;
    let (form_root, form_path) = store.locate(&target, false)?;
    store
        .dict_at(form_root, &form_path)?
        .insert(b"SigFlags", Object::Integer(3));
    let signature_dict = dictionary([
        (
            b"ByteRange",
            Object::Array(vec![Object::Integer(RANGE_PLACEHOLDER); 4]),
        ),
        (b"Contents", Object::String(vec![0; widen(capacity)])),
        (b"Filter", name(b"Adobe.PPKLite")),
        (b"SubFilter", name(b"ETSI.RFC3161")),
        (b"Type", name(b"DocTimeStamp")),
    ]);
    store.set_body(signature, Object::Dict(signature_dict), None);
    let (bytes, offset) = incremental_update(&document, &store.changed, pdf, Some(signature))?;
    let start = offset.ok_or_else(|| Failure::invalid("missing document timestamp object"))?;
    patch(bytes, pdf.len(), start, capacity)
}

#[expect(
    clippy::missing_errors_doc,
    clippy::missing_inline_in_public_items,
    reason = "the WASM bindings document the timestamp write contract"
)]
pub fn add_document_timestamp(pdf: &[u8], token: &[u8], limits: &Limits) -> Outcome<Vec<u8>> {
    let prepared = prepare_document_timestamp(pdf, limits)?;
    let mut appendix = prepared.appendix;
    let start = prepared.contents_start.saturating_sub(pdf.len());
    let end = prepared.contents_end.saturating_sub(pdf.len());
    let hex = appendix
        .get_mut(start..end)
        .ok_or_else(|| Failure::invalid("invalid timestamp hole"))?;
    if token.is_empty() || token.len().saturating_mul(2) > hex.len() {
        return Err(Failure::request(
            "timestamp token does not fit its reserved contents",
        ));
    }
    let digit = |nibble: u8| {
        if nibble < 10 {
            b'0'.saturating_add(nibble)
        } else {
            b'a'.saturating_add(nibble.saturating_sub(10))
        }
    };
    for (byte, [high, low]) in token.iter().zip(hex.as_chunks_mut::<2>().0) {
        *high = digit(*byte >> 4_u32);
        *low = digit(*byte & 15);
    }
    Ok(appendix)
}

fn patch(
    mut appendix: Vec<u8>,
    source_length: usize,
    start: usize,
    capacity: u32,
) -> Outcome<PreparedUpdate> {
    let header_end = start.saturating_add(128).min(appendix.len());
    let header = appendix.get(start..header_end).unwrap_or_default();
    let range = find_bytes(header, 0, RANGE_START)
        .and_then(|offset| start.checked_add(offset))
        .and_then(|offset| offset.checked_add(RANGE_START.len()))
        .ok_or_else(|| Failure::invalid("missing prepared ByteRange"))?;
    let digits_end = range
        .saturating_add(RANGE_WIDTH.saturating_mul(4))
        .saturating_add(3);
    let contents_start = digits_end.saturating_add(HOLE_START.len());
    let contents_end = contents_start.saturating_add(widen(capacity).saturating_mul(2));
    if appendix.get(digits_end..contents_start) != Some(HOLE_START)
        || appendix.get(contents_end) != Some(&b'>')
    {
        return Err(Failure::invalid("missing prepared Contents hole"));
    }
    let after_hole = contents_end.saturating_add(1);
    let byte_range = [
        0,
        source_length.saturating_add(contents_start.saturating_sub(1)),
        source_length.saturating_add(after_hole),
        appendix.len().saturating_sub(after_hole),
    ];
    for (index, value) in byte_range.into_iter().enumerate() {
        let mut digits = String::new();
        write!(digits, "{value:010}")
            .map_err(|_cause| Failure::limit("signature ByteRange exceeds its width"))?;
        let offset = range.saturating_add(index.saturating_mul(RANGE_WIDTH.saturating_add(1)));
        let slot = appendix
            .get_mut(offset..offset.saturating_add(RANGE_WIDTH))
            .ok_or_else(|| Failure::invalid("invalid prepared ByteRange position"))?;
        if digits.len() != RANGE_WIDTH {
            return Err(Failure::limit("signature ByteRange exceeds its width"));
        }
        slot.copy_from_slice(digits.as_bytes());
    }
    Ok(PreparedUpdate {
        byte_range,
        contents_end: source_length.saturating_add(contents_end),
        contents_start: source_length.saturating_add(contents_start),
        appendix,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::failure::FailureCode;
    use crate::num::u64_to_f64;
    use crate::pdf_hash::{sha256, sha512};
    use crate::test_pdf::build;

    fn fixture(namesake: bool) -> Vec<u8> {
        let second_title = if namesake { "Group.Child" } else { "Second" };
        build(&[
            (
                1,
                "<< /Type /Catalog /Pages 2 0 R /AcroForm 4 0 R >>".to_owned(),
            ),
            (2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_owned()),
            (
                3,
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 400] /Annots [7 0 R 8 0 R] >>"
                    .to_owned(),
            ),
            (4, "<< /Fields [5 0 R 8 0 R] >>".to_owned()),
            (5, "<< /T (Group) /FT /Sig /Kids [6 0 R] >>".to_owned()),
            (6, "<< /T (Child) /Parent 5 0 R /Kids [7 0 R] >>".to_owned()),
            (
                7,
                "<< /Type /Annot /Subtype /Widget /Parent 6 0 R /Rect [10 10 130 50] >>".to_owned(),
            ),
            (
                8,
                format!(
                    "<< /Type /Annot /Subtype /Widget /FT /Sig /T ({second_title}) /Rect [0 0 0 0] >>"
                ),
            ),
        ])
    }

    fn number(payload: &mut Vec<u8>, value: u32) {
        payload.extend_from_slice(&value.to_le_bytes());
    }

    fn string(payload: &mut Vec<u8>, value: &[u8]) {
        number(payload, u32::try_from(value.len()).unwrap());
        payload.extend_from_slice(value);
    }

    fn request(title: &str, create: bool, permission: u32, sha512: bool) -> Vec<u8> {
        let mut payload = Vec::new();
        for value in [REQUEST_MAGIC, 1, u32::from(create)] {
            number(&mut payload, value);
        }
        string(&mut payload, title.as_bytes());
        if create {
            number(&mut payload, 0);
            for _ in 0..4_u32 {
                payload.extend_from_slice(&0.0_f64.to_le_bytes());
            }
        }
        for value in [64, 0, u32::from(sha512), permission] {
            number(&mut payload, value);
        }
        string(&mut payload, b"D:20261125155500Z");
        for _ in 0..5_u32 {
            number(&mut payload, 0);
        }
        payload
    }

    fn fill_contents(prepared: &mut PreparedSignature) {
        let contents = &mut prepared.pdf[prepared.contents_start..prepared.contents_end];
        contents[..10].copy_from_slice(b"3003020101");
        let report = analyze(&prepared.pdf, Analysis::Verification);
        assert_eq!(report.failure, None);
        let covered_end = u64::try_from(prepared.pdf.len()).unwrap();
        assert!(report.dictionaries.iter().any(|signature| {
            signature
                .byte_range_values
                .is_some_and(|[first, _, start, length]| {
                    first.total_cmp(&0.0_f64).is_eq()
                        && (start + length).total_cmp(&u64_to_f64(covered_end)).is_eq()
                })
        }));
    }

    #[test]
    fn signs_inherited_field_by_fully_qualified_name_without_modifying_other_widget() {
        let pdf = fixture(false);
        let limits = Limits::default();
        let report = signature_fields(&pdf, &limits).unwrap();
        let child = report
            .fields
            .iter()
            .find(|field| field.name == "Group.Child")
            .unwrap();
        assert_eq!(child.reference.unwrap().number, 6);
        assert_eq!(child.widgets.first().unwrap().reference.unwrap().number, 7);
        assert_eq!(child.widgets.first().unwrap().page, Some(0));
        assert!(report.fields.iter().any(|field| field.name == "Second"));
        let payload = request("Group.Child", false, 0, true);
        let mut prepared = prepare_signature(&pdf, &payload, &limits).unwrap();
        assert!(prepared.pdf.starts_with(&pdf));
        let [_, first_length, second, _] = prepared.byte_range;
        let mut covered = prepared.pdf[..first_length].to_vec();
        covered.extend_from_slice(&prepared.pdf[second..]);
        assert_eq!(prepared.sha256, sha256(&covered));
        assert_eq!(prepared.sha512, Some(sha512(&covered, false)));
        fill_contents(&mut prepared);
        let signed = signature_fields(&prepared.pdf, &limits).unwrap();
        assert_eq!(signed.revisions, [pdf.len(), prepared.pdf.len()]);
        let signed_child = signed
            .fields
            .iter()
            .find(|field| field.name == "Group.Child")
            .unwrap();
        assert!(signed_child.signed);
        assert_eq!(
            signed_child.value.as_ref().unwrap().revision_end,
            Some(prepared.pdf.len())
        );
        assert!(
            !signed
                .fields
                .iter()
                .find(|field| field.name == "Second")
                .unwrap()
                .signed
        );
        assert_eq!(
            prepare_signature(&prepared.pdf, &payload, &limits)
                .unwrap_err()
                .reason,
            "signature field is already signed"
        );
    }

    #[test]
    fn rejects_certification_after_signing_and_doc_mdp_with_no_changes() {
        let pdf = fixture(false);
        let limits = Limits::default();
        let mut prepared =
            prepare_signature(&pdf, &request("Group.Child", false, 1, false), &limits).unwrap();
        fill_contents(&mut prepared);
        let fields = signature_fields(&prepared.pdf, &limits).unwrap();
        assert_eq!(fields.doc_mdp, Some(1));
        let blocked =
            prepare_signature(&prepared.pdf, &request("Second", false, 0, false), &limits)
                .unwrap_err();
        assert_eq!(blocked.code, FailureCode::InvalidRequest);
        assert_eq!(blocked.reason, "DocMDP forbids signing this document");
        let signed = prepare_signature(&pdf, &request("Second", false, 0, false), &limits).unwrap();
        let second =
            prepare_signature(&signed.pdf, &request("Third", true, 2, false), &limits).unwrap_err();
        assert_eq!(
            second.reason,
            "DocMDP certification must be the first signature"
        );
    }

    #[test]
    fn appends_invisible_co_signature_to_xref_stream_pdf_with_trailing_garbage() {
        let pdf = include_bytes!("../tests/fixtures/pdf/object-streams.pdf");
        let limits = Limits::default();
        let mut first = prepare_signature(pdf, &request("First", true, 0, false), &limits).unwrap();
        assert!(first.pdf.starts_with(pdf));
        fill_contents(&mut first);
        let first_range = first.byte_range;
        let first_end = first.pdf.len();
        assert_eq!(
            signature_fields(&first.pdf, &limits)
                .unwrap()
                .fields
                .first()
                .unwrap()
                .widgets
                .first()
                .unwrap()
                .rect,
            Some([0.0_f64, 0.0_f64, 0.0_f64, 0.0_f64])
        );
        first
            .pdf
            .extend_from_slice(&b"trailing garbage".repeat(320));
        let mut second =
            prepare_signature(&first.pdf, &request("Second", true, 0, false), &limits).unwrap();
        assert!(second.pdf.starts_with(&first.pdf));
        fill_contents(&mut second);
        let report = analyze(&second.pdf, Analysis::Verification);
        assert_eq!(report.dictionaries.len(), 2);
        let fields = signature_fields(&second.pdf, &limits).unwrap();
        let previous = fields
            .fields
            .iter()
            .find(|field| field.name == "First")
            .unwrap()
            .value
            .as_ref()
            .unwrap();
        assert_eq!(previous.revision_end, Some(first_end));
        assert_eq!(
            previous.byte_range,
            Some(first_range.map(|value| u64::try_from(value).unwrap()))
        );
    }

    #[test]
    fn rejects_bad_selectors_and_malformed_requests() {
        let pdf = fixture(false);
        let limits = Limits::default();
        for (title, create, reason) in [
            ("Missing", false, "signature field is missing"),
            ("Second", true, "signature field name already exists"),
            (
                "Group",
                false,
                "selected field is not a terminal signature field",
            ),
        ] {
            let fault =
                prepare_signature(&pdf, &request(title, create, 0, false), &limits).unwrap_err();
            assert_eq!(fault.reason, reason);
        }
        let ambiguous = prepare_signature(
            &fixture(true),
            &request("Group.Child", false, 0, false),
            &limits,
        )
        .unwrap_err();
        assert_eq!(ambiguous.reason, "signature field name is ambiguous");
        let mut payload = request("Second", false, 0, false);
        assert!(payload.pop().is_some());
        assert_eq!(
            prepare_signature(&pdf, &payload, &limits).unwrap_err().code,
            FailureCode::InvalidRequest
        );
        payload.extend_from_slice(&[0, 0]);
        assert_eq!(
            prepare_signature(&pdf, &payload, &limits)
                .unwrap_err()
                .reason,
            "signature preparation payload has trailing bytes"
        );
    }
}
