#[path = "signing.rs"]
pub mod signing;

#[path = "validation.rs"]
pub mod validation;

use alloc::rc::Rc;
use core::str;
use std::collections::HashSet;

use crate::deflate::zlib_compress;
use crate::document::{Document, Page, decode_text_string};
use crate::failure::{Failure, FailureCode, Outcome};
use crate::inspection::{Limits, PageInfo};
use crate::num::{f64_to_i64, sort_total, unsigned_decimal, widen};
use crate::object::{Dict, ObjRef, Object, Stream};
use crate::png::{self, Image};
use crate::revision::revision_complete;
use crate::syntax::{Parser, skip_whitespace_at};
use crate::write::{Body, Changes, Packing, incremental, rewrite};

const EDIT_MAGIC: u32 = 0x4445_4450;
const EDIT_VERSION: u32 = 1;
const MODE_MASK: u32 = 3;
const MODE_INCREMENTAL: u32 = 1;
const MODE_REWRITE: u32 = 2;
const FLAG_OBJECT_STREAMS: u32 = 4;
const OP_SET_OBJECT: u32 = 1;
const OP_SET_STREAM: u32 = 2;
const OP_DICT_SET: u32 = 3;
const OP_DICT_REMOVE: u32 = 4;
const OP_ARRAY_APPEND: u32 = 5;
const OP_ARRAY_REMOVE: u32 = 6;
const OP_FLAGS_OR: u32 = 7;
const OP_APPEND_CONTENT: u32 = 8;
const OP_PAGE_RESOURCE: u32 = 9;
const OP_IMAGE: u32 = 10;
const OP_STANDARD_FONT: u32 = 11;
const OP_SIGNATURE: u32 = 12;
const OP_REPAIR_CATALOG: u32 = 13;
const OP_PNG: u32 = 14;
const STREAM_COMPRESS: u32 = 1;
const CONTENT_COMPRESS: u32 = 1;
const IMAGE_ALPHA: u32 = 1;
const MAX_SYNTAX_NESTING: usize = 64;
const MAX_SIGNATURE_CONTENTS: u32 = 16 * 1024 * 1024;
const MAX_IMAGE_PIXELS: u64 = 64 * 1024 * 1024;
const MAX_ANNOTATIONS: usize = 10_000;
const MAX_FIELD_DEPTH: usize = 64;
const MAX_FIELD_NODES: usize = 10_000;
const MAX_FIELD_NAME: usize = 4_096;
const MAX_FIELD_CHARACTERS: usize = 1000 * 1000;
const MAX_PARENT_DEPTH: usize = 100;
const STANDARD_FONTS: [&[u8]; 14] = [
    b"Courier",
    b"Courier-Bold",
    b"Courier-BoldOblique",
    b"Courier-Oblique",
    b"Helvetica",
    b"Helvetica-Bold",
    b"Helvetica-BoldOblique",
    b"Helvetica-Oblique",
    b"Times-Roman",
    b"Times-Bold",
    b"Times-BoldItalic",
    b"Times-Italic",
    b"Symbol",
    b"ZapfDingbats",
];

#[derive(Clone, Debug, PartialEq, Eq)]
enum Step {
    Index(usize),
    Key(Vec<u8>),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Base {
    Catalog,
    Object(ObjRef),
    Page(u32),
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Target {
    base: Base,
    path: Vec<Step>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Probe {
    Missing,
    Present,
    Ref(ObjRef),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[expect(
    clippy::exhaustive_enums,
    reason = "the internal ABI shares these variants with the WASM crate"
)]
pub enum FieldTarget {
    Ref(ObjRef),
    Widget,
    WidgetParent,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[expect(
    clippy::exhaustive_enums,
    reason = "the internal ABI shares these variants with the WASM crate"
)]
pub enum Slot {
    Malformed(u32),
    None,
    Open(FieldTarget),
}

#[derive(Clone, Debug, PartialEq)]
#[expect(
    clippy::exhaustive_structs,
    reason = "the internal ABI shares this struct with the WASM crate"
)]
pub struct AnnotationInfo {
    pub index: u32,
    pub page_index: u32,
    pub rect: Option<[f64; 4]>,
    pub reference: Option<ObjRef>,
    pub slot: Slot,
    pub titled: bool,
    pub uri: Option<String>,
    pub widget: bool,
}

#[derive(Clone, Debug, PartialEq)]
#[expect(
    clippy::exhaustive_structs,
    reason = "the internal ABI shares this struct with the WASM crate"
)]
pub struct PageEntry {
    pub annotation_count: u32,
    pub info: PageInfo,
    pub reference: Option<ObjRef>,
}

#[derive(Clone, Debug, PartialEq)]
#[expect(
    clippy::exhaustive_structs,
    reason = "the internal ABI shares this struct with the WASM crate"
)]
pub struct DocumentInfo {
    pub acro_form: bool,
    pub annotations: Vec<AnnotationInfo>,
    pub field_name: Option<Result<String, u32>>,
    pub next_object_number: u32,
    pub pages: Vec<PageEntry>,
}

struct Reader<'data> {
    data: &'data [u8],
    pos: usize,
}

impl<'data> Reader<'data> {
    fn bytes(&mut self) -> Outcome<&'data [u8]> {
        let length = widen(self.u32()?);
        let end = self
            .pos
            .checked_add(length)
            .ok_or_else(|| Failure::request("edit payload overflow"))?;
        let slice = self
            .data
            .get(self.pos..end)
            .ok_or_else(|| Failure::request("edit payload is truncated"))?;
        self.pos = end;
        Ok(slice)
    }

    fn coordinates<const COUNT: usize>(&mut self, max: f64) -> Outcome<[f64; COUNT]> {
        let mut result = [0.0_f64; COUNT];
        for number in &mut result {
            let end = self.pos.saturating_add(8);
            let bytes = self
                .data
                .get(self.pos..end)
                .and_then(|raw| <[u8; 8]>::try_from(raw).ok())
                .ok_or_else(|| Failure::request("truncated signature coordinate"))?;
            self.pos = end;
            *number = f64::from_le_bytes(bytes);
            if !number.is_finite() || number.abs() > max {
                return Err(Failure::request("signature coordinate is out of range"));
            }
        }
        Ok(result)
    }

    fn flag(&mut self) -> Outcome<bool> {
        match self.u32()? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(Failure::request("invalid signature request flag")),
        }
    }

    fn optional_reference(&mut self) -> Outcome<Option<ObjRef>> {
        let number = self.u32()?;
        let generation = u16::try_from(self.u32()?)
            .ok()
            .ok_or_else(|| Failure::request("object generation out of range"))?;
        Ok((number != 0).then_some(ObjRef { number, generation }))
    }

    fn reference(&mut self) -> Outcome<ObjRef> {
        let number = self.u32()?;
        let generation = u16::try_from(self.u32()?)
            .ok()
            .ok_or_else(|| Failure::request("object generation out of range"))?;
        if number == 0 {
            return Err(Failure::request("object number must be positive"));
        }
        Ok(ObjRef { number, generation })
    }

    fn target(&mut self) -> Outcome<Target> {
        let kind = self.u32()?;
        let first = self.u32()?;
        let second = self.u32()?;
        let base = match kind {
            0 => Base::Catalog,
            1 => Base::Page(first),
            2 => Base::Object(ObjRef {
                number: first,
                generation: u16::try_from(second)
                    .ok()
                    .ok_or_else(|| Failure::request("object generation out of range"))?,
            }),
            _ => return Err(Failure::request("unknown edit target")),
        };
        let count = self.u32()?;
        let mut path = Vec::new();
        for _ in 0..count {
            let step = match self.u32()? {
                0 => Step::Key(self.bytes()?.to_vec()),
                1 => Step::Index(widen(self.u32()?)),
                _ => return Err(Failure::request("unknown edit path step")),
            };
            path.push(step);
        }
        Ok(Target { base, path })
    }

    fn text(&mut self) -> Outcome<&'data str> {
        let bytes = self.bytes()?;
        if bytes.len() > MAX_FIELD_CHARACTERS {
            return Err(Failure::limit("signature text exceeds its size limit"));
        }
        str::from_utf8(bytes).map_err(|_cause| Failure::request("signature text must be UTF-8"))
    }

    fn u32(&mut self) -> Outcome<u32> {
        let end = self.pos.saturating_add(4);
        let raw = self
            .data
            .get(self.pos..end)
            .ok_or_else(|| Failure::request("edit payload is truncated"))?;
        self.pos = end;
        let bytes = <[u8; 4]>::try_from(raw)
            .ok()
            .ok_or_else(|| Failure::request("edit payload is truncated"))?;
        Ok(u32::from_le_bytes(bytes))
    }
}

struct Store<'doc, 'data> {
    changed: Changes,
    document: &'doc Document<'data>,
    pages: Option<Vec<Page>>,
}

impl Store<'_, '_> {
    fn append_content(&mut self, reader: &mut Reader<'_>) -> Outcome<()> {
        let page = self.page_ref(reader.u32()?)?;
        let content = reader.reference()?;
        let wrap = reader.optional_reference()?;
        let data = reader.bytes()?;
        let flags = reader.u32()?;
        let existing = self.peek_value(page, &[Step::Key(b"Contents".to_vec())])?;
        let mut items: Vec<Object> = match existing {
            Some(Object::Array(items)) => items,
            Some(Object::Ref(reference)) => match self.peek_value(reference, &[])? {
                Some(Object::Array(items)) => items,
                _ => vec![Object::Ref(reference)],
            },
            _ => Vec::new(),
        };
        let compress = flags & CONTENT_COMPRESS != 0;
        let mut payload: Vec<u8> = Vec::with_capacity(data.len().saturating_add(4));
        if let Some(opener) = wrap
            && !items.is_empty()
        {
            self.set_stream(opener, Dict::default(), b"q\n".to_vec(), false);
            items.insert(0, Object::Ref(opener));
            payload.extend_from_slice(b"\nQ\n");
        }
        payload.extend_from_slice(data);
        self.set_stream(content, Dict::default(), payload, compress);
        let value = if items.is_empty() {
            Object::Ref(content)
        } else {
            items.push(Object::Ref(content));
            Object::Array(items)
        };
        dict_of(self.object_mut(page)?)?.insert(b"Contents", value);
        Ok(())
    }

    fn apply(&mut self, kind: u32, reader: &mut Reader<'_>) -> Outcome<()> {
        match kind {
            OP_SET_OBJECT => {
                let reference = reader.reference()?;
                let object = parse_value(reader.bytes()?)?;
                self.set_body(reference, object, None);
            }
            OP_SET_STREAM => {
                let reference = reader.reference()?;
                let Object::Dict(dict) = parse_value(reader.bytes()?)? else {
                    return Err(Failure::request("stream dictionary expected"));
                };
                let data = reader.bytes()?.to_vec();
                let compress = reader.u32()? & STREAM_COMPRESS != 0;
                self.set_stream(reference, dict, data, compress);
            }
            OP_DICT_SET => self.dict_edit(reader, true)?,
            OP_DICT_REMOVE => self.dict_edit(reader, false)?,
            OP_ARRAY_APPEND => self.array_edit(reader, true)?,
            OP_ARRAY_REMOVE => self.array_edit(reader, false)?,
            OP_FLAGS_OR => self.flags_or(reader)?,
            OP_APPEND_CONTENT => self.append_content(reader)?,
            OP_PAGE_RESOURCE => self.page_resource(reader)?,
            OP_IMAGE => self.image(reader)?,
            OP_STANDARD_FONT => {
                let reference = reader.reference()?;
                let name = reader.bytes()?;
                self.set_body(reference, standard_font(name)?, None);
            }
            OP_SIGNATURE => self.signature(reader)?,
            OP_PNG => {
                let reference = reader.reference()?;
                let mask = reader.optional_reference()?;
                let decoded = png::decode(reader.bytes()?)?;
                self.store_image(reference, mask, decoded)?;
            }
            OP_REPAIR_CATALOG => {
                let root = self.root_ref()?;
                dict_of(self.object_mut(root)?)?.insert(b"Type", Object::Name(b"Catalog".to_vec()));
            }
            _ => return Err(Failure::request("unknown edit operation")),
        }
        Ok(())
    }

    fn array_edit(&mut self, reader: &mut Reader<'_>, append: bool) -> Outcome<()> {
        let target = reader.target()?;
        let key = reader.bytes()?.to_vec();
        let value = parse_value(reader.bytes()?)?;
        self.edit_array(&target, &key, value, append)
    }

    fn dict_at(&mut self, root: ObjRef, path: &[Step]) -> Outcome<&mut Dict> {
        let container = navigate_mut(self.object_mut(root)?, path)
            .ok_or_else(|| Failure::request("edit target does not exist"))?;
        dict_of(container)
    }

    fn dict_edit(&mut self, reader: &mut Reader<'_>, set: bool) -> Outcome<()> {
        let target = reader.target()?;
        let key = reader.bytes()?.to_vec();
        let value = if set {
            Some(parse_value(reader.bytes()?)?)
        } else {
            None
        };
        let (root, inner) = self.locate(&target, set)?;
        let Some(container) = navigate_mut(self.object_mut(root)?, &inner) else {
            return if set {
                Err(Failure::request("edit target does not exist"))
            } else {
                Ok(())
            };
        };
        let dict = dict_of(container)?;
        match value {
            Some(found) => dict.insert(&key, found),
            None => dict
                .entries
                .retain(|(name, _)| name.as_slice() != key.as_slice()),
        }
        Ok(())
    }

    fn edit_array(
        &mut self,
        target: &Target,
        key: &[u8],
        value: Object,
        append: bool,
    ) -> Outcome<()> {
        let (root, inner) = self.locate(target, append)?;
        let current = { self.dict_at(root, &inner)?.get(key).cloned() };
        match current {
            Some(Object::Ref(reference)) => {
                let Object::Array(items) = self.object_mut(reference)? else {
                    return Err(Failure::request("edit target is not an array"));
                };
                apply_array(items, value, append);
            }
            Some(Object::Array(_)) => {
                if let Some(Object::Array(items)) = dict_entry_mut(self.dict_at(root, &inner)?, key)
                {
                    apply_array(items, value, append);
                }
            }
            None if append => {
                self.dict_at(root, &inner)?
                    .insert(key, Object::Array(vec![value]));
            }
            None => {}
            Some(_) => return Err(Failure::request("edit target is not an array")),
        }
        Ok(())
    }

    fn flags_or(&mut self, reader: &mut Reader<'_>) -> Outcome<()> {
        let target = reader.target()?;
        let key = reader.bytes()?.to_vec();
        let bits = reader.u32()?;
        let (root, inner) = self.locate(&target, true)?;
        let current = { self.dict_at(root, &inner)?.get(&key).cloned() };
        let resolved = match current {
            Some(Object::Ref(reference)) => self.peek_value(reference, &[])?,
            other => other,
        };
        let old = resolved
            .as_ref()
            .and_then(Object::as_number)
            .filter(|value| value.is_finite())
            .map_or(0_i64, |value| f64_to_i64(value.trunc()));
        let low = u32::try_from(old.rem_euclid(1_i64 << 32_i32)).unwrap_or(0);
        let combined = i64::from((low | bits).cast_signed());
        self.dict_at(root, &inner)?
            .insert(&key, Object::Integer(combined));
        Ok(())
    }

    fn image(&mut self, reader: &mut Reader<'_>) -> Outcome<()> {
        let reference = reader.reference()?;
        let mask = reader.optional_reference()?;
        let width = reader.u32()?;
        let height = reader.u32()?;
        let components = reader.u32()?;
        let flags = reader.u32()?;
        let samples = reader.bytes()?.to_vec();
        let image = Image {
            alpha: flags & IMAGE_ALPHA != 0,
            components,
            height,
            samples,
            width,
        };
        self.store_image(reference, mask, image)
    }

    fn locate(&mut self, target: &Target, create: bool) -> Outcome<(ObjRef, Vec<Step>)> {
        let mut root = match target.base {
            Base::Catalog => self.root_ref()?,
            Base::Object(reference) => reference,
            Base::Page(index) => self.page_ref(index)?,
        };
        let mut inner: Vec<Step> = Vec::new();
        for step in &target.path {
            inner.push(step.clone());
            match self.probe(root, &inner)? {
                Probe::Ref(reference) => {
                    root = reference;
                    inner.clear();
                }
                Probe::Present => {}
                Probe::Missing => {
                    let Step::Key(key) = step else {
                        return Err(Failure::request("edit path index is out of range"));
                    };
                    if !create {
                        return Ok((root, inner));
                    }
                    let parent = inner
                        .get(..inner.len().saturating_sub(1))
                        .unwrap_or_default();
                    self.dict_at(root, parent)?
                        .insert(key, Object::Dict(Dict::default()));
                }
            }
        }
        Ok((root, inner))
    }

    fn object_mut(&mut self, reference: ObjRef) -> Outcome<&mut Object> {
        if self.changed.get(reference.number).is_none() {
            let loaded = self.document.load(reference)?;
            if matches!(*loaded, Object::Null) {
                return Err(Failure::request("edit target object does not exist"));
            }
            self.changed.insert(
                reference.number,
                Body {
                    data: None,
                    generation: reference.generation,
                    object: (*loaded).clone(),
                },
            );
        }
        self.changed
            .get_mut(reference.number)
            .map(|body| &mut body.object)
            .ok_or_else(|| Failure::request("edit target object does not exist"))
    }

    fn page_ref(&mut self, index: u32) -> Outcome<ObjRef> {
        if self.pages.is_none() {
            self.pages = Some(self.document.pages()?);
        }
        self.pages
            .as_ref()
            .and_then(|pages| pages.get(widen(index)))
            .and_then(|page| page.obj_ref)
            .ok_or_else(|| Failure::request("page index out of range"))
    }

    fn page_resource(&mut self, reader: &mut Reader<'_>) -> Outcome<()> {
        let index = reader.u32()?;
        let category = reader.bytes()?.to_vec();
        let name = reader.bytes()?.to_vec();
        let value = parse_value(reader.bytes()?)?;
        let page = self.page_ref(index)?;
        if self.probe(page, &[Step::Key(b"Resources".to_vec())])? == Probe::Missing {
            let inherited = self
                .pages
                .as_ref()
                .and_then(|pages| pages.get(widen(index)))
                .map_or_else(|| Object::Dict(Dict::default()), Page::resources_for_write);
            dict_of(self.object_mut(page)?)?.insert(b"Resources", inherited);
        }
        let target = Target {
            base: Base::Page(index),
            path: vec![Step::Key(b"Resources".to_vec()), Step::Key(category)],
        };
        let (root, inner) = self.locate(&target, true)?;
        let resources = self.dict_at(root, &inner)?;
        match resources.get(&name) {
            Some(existing) if *existing != value => Err(Failure::request(
                "page resource name is already bound to another object",
            )),
            Some(_) => Ok(()),
            None => {
                resources.insert(&name, value);
                Ok(())
            }
        }
    }

    fn peek_value(&self, root: ObjRef, path: &[Step]) -> Outcome<Option<Object>> {
        if let Some(body) = self.changed.get(root.number) {
            return Ok(navigate(&body.object, path).cloned());
        }
        let loaded = self.document.load(root)?;
        Ok(navigate(&loaded, path).cloned())
    }

    fn probe(&self, root: ObjRef, path: &[Step]) -> Outcome<Probe> {
        let classify = |found: Option<&Object>| match found {
            None => Probe::Missing,
            Some(Object::Ref(reference)) => Probe::Ref(*reference),
            Some(_) => Probe::Present,
        };
        if let Some(body) = self.changed.get(root.number) {
            return Ok(classify(navigate(&body.object, path)));
        }
        let loaded: Rc<Object> = self.document.load(root)?;
        Ok(classify(navigate(&loaded, path)))
    }

    fn root_ref(&self) -> Outcome<ObjRef> {
        match self.document.trailer().get(b"Root") {
            Some(Object::Ref(reference)) => Ok(*reference),
            _ => Err(Failure::invalid("missing document catalog")),
        }
    }

    fn set_body(&mut self, reference: ObjRef, object: Object, data: Option<Vec<u8>>) {
        self.changed.insert(
            reference.number,
            Body {
                data,
                generation: reference.generation,
                object,
            },
        );
    }

    fn set_stream(&mut self, reference: ObjRef, dict: Dict, data: Vec<u8>, compress: bool) {
        let mut stream_dict = dict;
        let payload = if compress && stream_dict.get(b"Filter").is_none() {
            stream_dict.insert(b"Filter", Object::Name(b"FlateDecode".to_vec()));
            zlib_compress(&data)
        } else {
            data
        };
        self.set_body(
            reference,
            Object::Stream(Stream {
                decrypted: None,
                data: 0..0,
                dict: stream_dict,
            }),
            Some(payload),
        );
    }

    fn signature(&mut self, reader: &mut Reader<'_>) -> Outcome<()> {
        let reference = reader.reference()?;
        let contents = reader.u32()?;
        let Object::Dict(mut dict) = parse_value(reader.bytes()?)? else {
            return Err(Failure::request("signature entries must be a dictionary"));
        };
        if contents == 0 || contents > MAX_SIGNATURE_CONTENTS {
            return Err(Failure::request(
                "signature contents length is out of range",
            ));
        }
        if dict.get(b"Type").is_none() {
            dict.insert(b"Type", Object::Name(b"Sig".to_vec()));
        }
        let placeholder = Object::Name(b"**********".to_vec());
        dict.insert(
            b"ByteRange",
            Object::Array(vec![
                Object::Integer(0),
                placeholder.clone(),
                placeholder.clone(),
                placeholder,
            ]),
        );
        dict.insert(b"Contents", Object::String(vec![0; widen(contents)]));
        self.set_body(reference, Object::Dict(dict), None);
        Ok(())
    }

    fn store_image(
        &mut self,
        reference: ObjRef,
        mask_target: Option<ObjRef>,
        image: Image,
    ) -> Outcome<()> {
        let Image {
            alpha,
            components,
            height,
            samples,
            width,
        } = image;
        let color_space: &[u8] = match components {
            1 => b"DeviceGray",
            3 => b"DeviceRGB",
            _ => return Err(Failure::request("images need 1 or 3 color components")),
        };
        let pixels = u64::from(width).saturating_mul(u64::from(height));
        if width == 0 || height == 0 || pixels > MAX_IMAGE_PIXELS {
            return Err(Failure::request("image dimensions are out of range"));
        }
        let channels = components.saturating_add(u32::from(alpha));
        let expected = pixels.saturating_mul(u64::from(channels));
        if u64::try_from(samples.len()).ok() != Some(expected) {
            return Err(Failure::request(
                "image sample count does not match its dimensions",
            ));
        }
        let mut dict = image_dict(width, height, color_space);
        if alpha {
            let color_width = widen(components);
            let stride = widen(channels);
            let mut color: Vec<u8> = Vec::with_capacity(samples.len());
            let mut mask: Vec<u8> =
                Vec::with_capacity(samples.len().checked_div(stride).unwrap_or(0));
            for pixel in samples.chunks_exact(stride) {
                color.extend_from_slice(pixel.get(..color_width).unwrap_or_default());
                mask.push(pixel.get(color_width).copied().unwrap_or(u8::MAX));
            }
            let mask_ref = mask_target
                .ok_or_else(|| Failure::request("alpha images need a soft-mask object"))?;
            self.set_stream(
                mask_ref,
                image_dict(width, height, b"DeviceGray"),
                mask,
                true,
            );
            dict.insert(b"SMask", Object::Ref(mask_ref));
            self.set_stream(reference, dict, color, true);
        } else {
            self.set_stream(reference, dict, samples, true);
        }
        Ok(())
    }
}

#[expect(
    clippy::missing_errors_doc,
    reason = "the TypeScript bindings document the public error contract"
)]
#[expect(
    clippy::missing_inline_in_public_items,
    reason = "release LTO chooses inlining across the internal Rust boundary"
)]
pub fn edit(pdf: &[u8], payload: &[u8], limits: &Limits) -> Outcome<Vec<u8>> {
    let mut reader = Reader {
        data: payload,
        pos: 0,
    };
    if reader.u32()? != EDIT_MAGIC || reader.u32()? != EDIT_VERSION {
        return Err(Failure::request("unsupported edit payload"));
    }
    let flags = reader.u32()?;
    let count = reader.u32()?;
    let mode = flags & MODE_MASK;
    let document = if mode == MODE_INCREMENTAL {
        appendable(pdf, limits)?
    } else {
        Document::open(pdf, limits)?
    };
    let mut store = Store {
        changed: Changes::default(),
        document: &document,
        pages: None,
    };
    for _ in 0..count {
        let kind = reader.u32()?;
        store.apply(kind, &mut reader)?;
    }
    if reader.pos != payload.len() {
        return Err(Failure::request("edit payload has trailing bytes"));
    }
    if let Ok(root) = store.root_ref()
        && let Some(body) = store.changed.get_mut(root.number)
        && let Object::Dict(catalog) = &mut body.object
        && catalog.get(b"Type").is_none()
    {
        catalog.insert(b"Type", Object::Name(b"Catalog".to_vec()));
    }
    let layout = if flags & FLAG_OBJECT_STREAMS == 0 {
        Packing::Classic
    } else {
        Packing::ObjectStreams
    };
    let intact = !document.is_encrypted() && intact_xref(&document, document.bytes());
    match mode {
        MODE_INCREMENTAL => incremental(&document, &store.changed),
        MODE_REWRITE => rewrite(&document, &store.changed, layout),
        _ if intact && layout == Packing::Classic => incremental(&document, &store.changed),
        _ => rewrite(&document, &store.changed, layout),
    }
}

#[expect(
    clippy::missing_errors_doc,
    reason = "the TypeScript bindings document the public error contract"
)]
#[expect(
    clippy::missing_inline_in_public_items,
    reason = "release LTO chooses inlining across the internal Rust boundary"
)]
pub fn document_info(
    pdf: &[u8],
    annotation_pages: Option<&[u32]>,
    field_prefix: &[u8],
    limits: &Limits,
) -> Outcome<DocumentInfo> {
    let document = Document::open(pdf, limits)?;
    let pages = document.pages()?;
    let mut entries: Vec<PageEntry> = Vec::with_capacity(pages.len());
    for page in &pages {
        let count = annotation_items(&document, page)?.map_or(0, |items| items.len());
        entries.push(PageEntry {
            annotation_count: u32::try_from(count).unwrap_or(u32::MAX),
            info: page.info,
            reference: page.obj_ref,
        });
    }
    let mut annotations: Vec<AnnotationInfo> = Vec::new();
    if let Some(indexes) = annotation_pages {
        for &page_index in indexes {
            let page = pages
                .get(widen(page_index))
                .ok_or_else(|| Failure::request("page index out of range"))?;
            page_annotations(&document, page, page_index, &mut annotations)?;
        }
    }
    let catalog = document.catalog()?;
    let acro_form = match catalog
        .as_deref()
        .and_then(|value| value.as_dict())
        .and_then(|dict| dict.get(b"AcroForm"))
    {
        Some(value) => document.follow(value)?.as_dict().cloned(),
        None => None,
    };
    let field_name = if field_prefix.is_empty() {
        None
    } else {
        let prefix = str::from_utf8(field_prefix)
            .ok()
            .ok_or_else(|| Failure::request("field name prefix must be UTF-8"))?;
        let fields = match acro_form.as_ref().and_then(|dict| dict.get(b"Fields")) {
            Some(value) => document
                .follow(value)?
                .as_array()
                .map(<[Object]>::to_vec)
                .unwrap_or_default(),
            None => Vec::new(),
        };
        Some(first_unused_field_name(&document, &fields, prefix)?)
    };
    Ok(DocumentInfo {
        acro_form: acro_form.is_some(),
        annotations,
        field_name,
        next_object_number: next_object_number(&document),
        pages: entries,
    })
}

fn next_object_number(document: &Document<'_>) -> u32 {
    let declared = document
        .trailer()
        .get(b"Size")
        .and_then(Object::as_integer)
        .and_then(|value| u32::try_from(value).ok())
        .unwrap_or(0);
    declared
        .max(u32::try_from(document.object_count()).unwrap_or(u32::MAX))
        .max(1)
}

fn annotation_items(document: &Document<'_>, page: &Page) -> Outcome<Option<Vec<Object>>> {
    let Some(annots) = page.dict.get(b"Annots") else {
        return Ok(None);
    };
    Ok(document.follow(annots)?.as_array().map(<[Object]>::to_vec))
}

fn apply_array(items: &mut Vec<Object>, value: Object, append: bool) {
    if append {
        items.push(value);
    } else {
        items.retain(|item| *item != value);
    }
}

fn dict_entry_mut<'object>(dict: &'object mut Dict, key: &[u8]) -> Option<&'object mut Object> {
    dict.entries
        .iter_mut()
        .rev()
        .find(|(name, _)| name.as_slice() == key)
        .map(|(_, value)| value)
}

fn dict_of(object: &mut Object) -> Outcome<&mut Dict> {
    object
        .as_dict_mut()
        .ok_or_else(|| Failure::request("edit target is not a dictionary"))
}

fn first_unused_field_name(
    document: &Document<'_>,
    fields: &[Object],
    prefix: &str,
) -> Outcome<Result<String, u32>> {
    let mut taken: Vec<[u64; 4]> = Vec::new();
    let mut seen: HashSet<u32> = HashSet::new();
    let mut pending: Vec<(Object, String, usize)> = Vec::new();
    let mut queued = 0_usize;
    let mut characters = 0_usize;
    let mut enqueue = |queue: &mut Vec<(Object, String, usize)>,
                       object: Object,
                       parent: String,
                       depth: usize|
     -> Result<(), u32> {
        if depth > MAX_FIELD_DEPTH {
            return Err(1);
        }
        if queued >= MAX_FIELD_NODES {
            return Err(2);
        }
        queued = queued.saturating_add(1);
        queue.push((object, parent, depth));
        Ok(())
    };
    for field in fields {
        if let Err(code) = enqueue(&mut pending, field.clone(), String::new(), 0) {
            return Ok(Err(code));
        }
    }
    while let Some((object, parent, depth)) = pending.pop() {
        if let Object::Ref(reference) = object
            && !seen.insert(reference.number)
        {
            return Ok(Err(3));
        }
        let resolved = document.follow(&object)?;
        let Some(dict) = resolved.as_dict() else {
            continue;
        };
        let mut full_name = parent.clone();
        let title = field_title(document, dict)?;
        if let Some(name) = title {
            let name_length = name.encode_utf16().count();
            if name_length > MAX_FIELD_NAME {
                return Ok(Err(4));
            }
            let parent_length = parent.encode_utf16().count();
            let full_length = parent_length
                .saturating_add(usize::from(!parent.is_empty()))
                .saturating_add(name_length);
            if full_length > MAX_FIELD_NAME {
                return Ok(Err(5));
            }
            let processed = name_length.saturating_add(full_length);
            if characters > MAX_FIELD_CHARACTERS.saturating_sub(processed) {
                return Ok(Err(6));
            }
            characters = characters.saturating_add(processed);
            taken.extend(numbered_suffix(&name, prefix).map(|value| [value, 0, 0, 0]));
            full_name = qualify(&parent, &name);
            taken.extend(numbered_suffix(&full_name, prefix).map(|value| [value, 0, 0, 0]));
        }
        let kids = match dict.get(b"Kids") {
            Some(value) => document.follow(value)?.as_array().map(<[Object]>::to_vec),
            None => None,
        };
        for kid in kids.unwrap_or_default() {
            if let Err(code) = enqueue(
                &mut pending,
                kid,
                full_name.clone(),
                depth.saturating_add(1),
            ) {
                return Ok(Err(code));
            }
        }
    }
    sort_total(&mut taken, &Ord::cmp);
    let mut suffix = 1_u64;
    for [value, ..] in taken {
        if value == suffix {
            suffix = suffix.saturating_add(1);
        } else if value > suffix {
            break;
        }
    }
    let mut out = String::with_capacity(prefix.len().saturating_add(20));
    out.push_str(prefix);
    out.push_str(&unsigned_decimal(suffix));
    Ok(Ok(out))
}

fn field_title(document: &Document<'_>, dict: &Dict) -> Outcome<Option<String>> {
    match dict.get(b"T") {
        Some(value) => Ok(document.follow(value)?.as_string().map(decode_text_string)),
        None => Ok(None),
    }
}

fn field_type(document: &Document<'_>, dict: &Dict) -> Outcome<Option<Vec<u8>>> {
    match dict.get(b"FT") {
        Some(value) => Ok(document.follow(value)?.as_name().map(<[u8]>::to_vec)),
        None => Ok(None),
    }
}

fn qualify(parent: &str, title: &str) -> String {
    if parent.is_empty() {
        return title.to_owned();
    }
    let mut joined =
        String::with_capacity(parent.len().saturating_add(title.len()).saturating_add(1));
    joined.push_str(parent);
    joined.push('.');
    joined.push_str(title);
    joined
}

fn numbered_suffix(name: &str, prefix: &str) -> Option<u64> {
    let digits = name.strip_prefix(prefix)?;
    if digits.is_empty()
        || digits.starts_with('0')
        || !digits.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    digits.parse().ok()
}

fn image_dict(width: u32, height: u32, color_space: &[u8]) -> Dict {
    let mut dict = Dict::default();
    dict.insert(b"Type", Object::Name(b"XObject".to_vec()));
    dict.insert(b"Subtype", Object::Name(b"Image".to_vec()));
    dict.insert(b"Width", Object::Integer(i64::from(width)));
    dict.insert(b"Height", Object::Integer(i64::from(height)));
    dict.insert(b"ColorSpace", Object::Name(color_space.to_vec()));
    dict.insert(b"BitsPerComponent", Object::Integer(8));
    dict
}

fn appendable<'data>(pdf: &'data [u8], limits: &Limits) -> Outcome<Document<'data>> {
    let document = Document::open(pdf, limits)?;
    if document.is_encrypted() {
        return Err(Failure::new(
            FailureCode::EncryptedPdf,
            "incremental editing of encrypted PDFs is not supported",
        ));
    }
    if intact_xref(&document, pdf) {
        return Ok(document);
    }
    if let Some(end) = final_eof_end(pdf)
        && end < pdf.len()
        && let Some(prefix) = pdf.get(..end)
        && let Ok(trimmed) = Document::open(prefix, limits)
        && !trimmed.is_encrypted()
        && intact_xref(&trimmed, prefix)
    {
        return Ok(trimmed);
    }
    let reason = if document.shift() > 0 {
        "incremental update needs an intact cross-reference chain: the file has bytes before the %PDF header"
    } else if document.startxref().is_none() {
        "incremental update needs an intact cross-reference chain: the file has no startxref"
    } else if document.was_repaired() {
        "incremental update needs an intact cross-reference chain: the cross-reference table does not match the file and had to be rebuilt"
    } else {
        "incremental update needs an intact cross-reference chain: a revision of the file is incomplete"
    };
    Err(Failure::new(FailureCode::DamagedXref, reason))
}

pub(crate) fn final_eof_end(pdf: &[u8]) -> Option<usize> {
    let marker = b"%%EOF";
    let start = pdf
        .windows(marker.len())
        .rposition(|window| window == marker)?;
    let mut end = start.checked_add(marker.len())?;
    if pdf.get(end) == Some(&b'\r') {
        end = end.saturating_add(1);
    }
    if pdf.get(end) == Some(&b'\n') {
        end = end.saturating_add(1);
    }
    Some(end)
}

fn intact_xref(document: &Document<'_>, pdf: &[u8]) -> bool {
    !document.was_repaired()
        && document.shift() == 0
        && document.startxref().is_some()
        && revision_complete(pdf, pdf.len())
}

fn navigate<'object>(object: &'object Object, path: &[Step]) -> Option<&'object Object> {
    let mut current = object;
    for step in path {
        current = match step {
            Step::Key(key) => current.as_dict()?.get(key)?,
            Step::Index(index) => current.as_array()?.get(*index)?,
        };
    }
    Some(current)
}

fn navigate_mut<'object>(
    object: &'object mut Object,
    path: &[Step],
) -> Option<&'object mut Object> {
    let mut current = object;
    for step in path {
        current = match step {
            Step::Key(key) => dict_entry_mut(current.as_dict_mut()?, key)?,
            Step::Index(index) => current.as_array_mut()?.get_mut(*index)?,
        };
    }
    Some(current)
}

fn page_annotations(
    document: &Document<'_>,
    page: &Page,
    page_index: u32,
    annotations: &mut Vec<AnnotationInfo>,
) -> Outcome<()> {
    let Some(items) = annotation_items(document, page)? else {
        return Ok(());
    };
    if items.len() > MAX_ANNOTATIONS {
        return Ok(());
    }
    for (position, item) in items.iter().enumerate() {
        let resolved = document.follow(item)?;
        let reference = item.as_reference();
        let index = u32::try_from(position).unwrap_or(u32::MAX);
        let Some(dict) = resolved.as_dict() else {
            annotations.push(AnnotationInfo {
                index,
                page_index,
                rect: None,
                reference,
                slot: Slot::None,
                titled: false,
                uri: None,
                widget: false,
            });
            continue;
        };
        let widget = match dict.get(b"Subtype") {
            Some(value) => document.follow(value)?.as_name() == Some(b"Widget".as_slice()),
            None => false,
        };
        let rect = rect_tuple(document, dict)?;
        let visible = rect.is_some_and(|[left, bottom, right, top]| left < right && bottom < top);
        let slot = if widget && visible {
            signature_slot(document, item, dict)?
        } else {
            Slot::None
        };
        annotations.push(AnnotationInfo {
            index,
            page_index,
            rect,
            reference,
            slot,
            titled: dict.get(b"T").is_some(),
            uri: document.link_uri(dict)?,
            widget,
        });
    }
    Ok(())
}

fn parse_value(syntax: &[u8]) -> Outcome<Object> {
    let mut parser = Parser::new(syntax, 0, MAX_SYNTAX_NESTING, true);
    let object = parser
        .parse_object()
        .map_err(|failure| Failure::request(failure.reason))?;
    if skip_whitespace_at(syntax, parser.position()) != syntax.len() {
        return Err(Failure::request(
            "edit value must be exactly one PDF object",
        ));
    }
    Ok(object)
}

fn rect_tuple(document: &Document<'_>, dict: &Dict) -> Outcome<Option<[f64; 4]>> {
    let Some(value) = dict.get(b"Rect") else {
        return Ok(None);
    };
    let resolved = document.follow(value)?;
    let Some(items) = resolved.as_array() else {
        return Ok(None);
    };
    if items.len() != 4 {
        return Ok(None);
    }
    let mut rect = [0.0_f64; 4];
    for (slot, item) in rect.iter_mut().zip(items) {
        match document.follow(item)?.as_number() {
            Some(number) if number.is_finite() => *slot = number,
            _ => return Ok(None),
        }
    }
    Ok(Some(rect))
}

fn signature_slot(document: &Document<'_>, widget_object: &Object, widget: &Dict) -> Outcome<Slot> {
    let mut seen: HashSet<u32> = HashSet::new();
    if let Object::Ref(reference) = widget_object {
        let _: bool = seen.insert(reference.number);
    }
    let mut current = widget.clone();
    let mut inherited: Option<Vec<u8>> = None;
    let mut field = FieldTarget::Widget;
    let mut has_value = false;
    let signature = |kind: &Option<Vec<u8>>| kind.as_deref() == Some(b"Sig".as_slice());
    for depth in 0..MAX_PARENT_DEPTH {
        let field_type = field_type(document, &current)?;
        if inherited.is_none() && field_type.is_some() {
            inherited.clone_from(&field_type);
        }
        if current.get(b"V").is_some() {
            has_value = true;
        }
        let Some(parent_object) = current.get(b"Parent").cloned() else {
            if !signature(&inherited) || has_value {
                return Ok(Slot::None);
            }
            return Ok(Slot::Open(field));
        };
        if let Object::Ref(reference) = parent_object
            && !seen.insert(reference.number)
        {
            return Ok(if signature(&inherited) {
                Slot::Malformed(1)
            } else {
                Slot::None
            });
        }
        let parent = document.follow(&parent_object)?;
        let Some(parent_dict) = parent.as_dict() else {
            return Ok(if signature(&inherited) {
                Slot::Malformed(2)
            } else {
                Slot::None
            });
        };
        if depth == 0 && field_type.is_none() && current.get(b"T").is_none() {
            field = parent_object
                .as_reference()
                .map_or(FieldTarget::WidgetParent, FieldTarget::Ref);
        }
        current = parent_dict.clone();
    }
    Ok(if signature(&inherited) {
        Slot::Malformed(3)
    } else {
        Slot::None
    })
}

fn standard_font(name: &[u8]) -> Outcome<Object> {
    if !STANDARD_FONTS.contains(&name) {
        return Err(Failure::request("not a standard 14 font"));
    }
    let mut dict = Dict::default();
    dict.insert(b"Type", Object::Name(b"Font".to_vec()));
    dict.insert(b"Subtype", Object::Name(b"Type1".to_vec()));
    dict.insert(b"BaseFont", Object::Name(name.to_vec()));
    if name != b"Symbol" && name != b"ZapfDingbats" {
        dict.insert(b"Encoding", Object::Name(b"WinAnsiEncoding".to_vec()));
    }
    Ok(Object::Dict(dict))
}

#[cfg(test)]
#[expect(
    unused_results,
    reason = "payload builder calls return the builder for chaining"
)]
mod tests {
    use super::*;
    use crate::document::PageRequest;
    use crate::layout::{TextOptions, document_text, text_limits};
    use crate::object::Resolver;
    use crate::revision::{Analysis, analyze};
    use crate::test_pdf::{build, document, page, stream_object, text};
    use crate::write::merge;

    #[derive(Default)]
    struct Ops {
        bytes: Vec<u8>,
        count: u32,
    }

    impl Ops {
        fn bytes(&mut self, value: &[u8]) -> &mut Self {
            self.u32(u32::try_from(value.len()).unwrap());
            self.bytes.extend_from_slice(value);
            self
        }

        fn finish(&self, flags: u32) -> Vec<u8> {
            let mut out = Vec::new();
            for value in [EDIT_MAGIC, EDIT_VERSION, flags, self.count] {
                out.extend_from_slice(&value.to_le_bytes());
            }
            out.extend_from_slice(&self.bytes);
            out
        }

        fn op(&mut self, kind: u32) -> &mut Self {
            self.count = self.count.saturating_add(1);
            self.u32(kind)
        }

        fn target(&mut self, kind: u32, first: u32, second: u32, path: &[&str]) -> &mut Self {
            self.u32(kind).u32(first).u32(second);
            self.u32(u32::try_from(path.len()).unwrap());
            for step in path {
                if let Ok(index) = step.parse::<u32>() {
                    self.u32(1).u32(index);
                } else {
                    self.u32(0).bytes(step.as_bytes());
                }
            }
            self
        }

        fn u32(&mut self, value: u32) -> &mut Self {
            self.bytes.extend_from_slice(&value.to_le_bytes());
            self
        }
    }

    fn limits() -> Limits {
        Limits::default()
    }

    fn sample() -> Vec<u8> {
        document(
            &[
                page(text(72.0, 700.0, 12.0, "Hello")),
                page(text(72.0, 700.0, 12.0, "World")),
            ],
            &[],
        )
    }

    fn page_text(pdf: &[u8]) -> Vec<String> {
        document_text(
            pdf,
            PageRequest::Indexes(None),
            &text_limits(),
            TextOptions {
                drop_running: false,
                markdown: false,
                merge_across_pages: false,
            },
        )
        .unwrap()
    }

    fn reopen(pdf: &[u8]) -> Document<'_> {
        let opened = Document::open(pdf, &limits()).unwrap();
        assert!(!opened.was_repaired());
        opened
    }

    fn placeholder_ops(next: u32, page_number: u32, name: &str) -> Ops {
        let mut ops = Ops::default();
        ops.op(OP_SIGNATURE).u32(next).u32(0).u32(64).bytes(
            b"<< /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /M (D:20260102030405Z) >>",
        );
        let widget = format!(
            "<< /Type /Annot /Subtype /Widget /FT /Sig /Rect [0 0 0 0] /V {next} 0 R /T ({name}) /F 4 /P {page_number} 0 R >>"
        );
        ops.op(OP_SET_OBJECT)
            .u32(next.saturating_add(1))
            .u32(0)
            .bytes(widget.as_bytes());
        let widget_ref = format!("{} 0 R", next.saturating_add(1));
        ops.op(OP_ARRAY_APPEND)
            .target(1, 0, 0, &[])
            .bytes(b"Annots")
            .bytes(widget_ref.as_bytes());
        ops.op(OP_SET_OBJECT)
            .u32(next.saturating_add(2))
            .u32(0)
            .bytes(b"<< /Fields [] >>");
        let form_ref = format!("{} 0 R", next.saturating_add(2));
        ops.op(OP_DICT_SET)
            .target(0, 0, 0, &[])
            .bytes(b"AcroForm")
            .bytes(form_ref.as_bytes());
        ops.op(OP_ARRAY_APPEND)
            .target(0, 0, 0, &["AcroForm"])
            .bytes(b"Fields")
            .bytes(widget_ref.as_bytes());
        ops.op(OP_FLAGS_OR)
            .target(0, 0, 0, &["AcroForm"])
            .bytes(b"SigFlags")
            .u32(3);
        ops
    }

    fn fill_signature(pdf: &mut [u8]) {
        let report = analyze(pdf, Analysis::Dictionaries);
        let dictionary = report
            .dictionaries
            .iter()
            .rev()
            .find(|item| item.unsigned_placeholder)
            .unwrap()
            .clone();
        let contents = dictionary.contents.unwrap();
        let byte_range = dictionary.byte_range.unwrap();
        let ranges = [
            0,
            contents.value_start,
            contents.value_end,
            pdf.len().saturating_sub(contents.value_end),
        ];
        let text = format!(
            "/ByteRange [{} {} {} {}]",
            ranges[0], ranges[1], ranges[2], ranges[3]
        );
        let span = &mut pdf[byte_range.key_start..byte_range.value_end];
        span.fill(b' ');
        span[..text.len()].copy_from_slice(text.as_bytes());
        pdf[contents.value_start.saturating_add(1)..contents.value_start.saturating_add(9)]
            .copy_from_slice(b"30820101");
    }

    fn last_position(haystack: &[u8], needle: &[u8]) -> usize {
        haystack
            .windows(needle.len())
            .rposition(|window| window == needle)
            .unwrap()
    }

    fn self_looping_prev() -> Vec<u8> {
        let source = sample();
        let start = last_position(&source, b"startxref").saturating_add(9);
        let offset = String::from_utf8_lossy(&source[start..])
            .split_whitespace()
            .next()
            .unwrap()
            .to_owned();
        let trailer = last_position(&source, b"trailer");
        let open = trailer
            .saturating_add(last_position(&source[trailer..], b"<<"))
            .saturating_add(2);
        let mut out = source[..open].to_vec();
        out.extend_from_slice(format!(" /Prev {offset}").as_bytes());
        out.extend_from_slice(&source[open..]);
        out
    }

    fn forward_prev() -> Vec<u8> {
        let source = sample();
        let start = last_position(&source, b"startxref");
        let table = last_position(&source[..start], b"xref");
        let trailer = last_position(&source, b"trailer");
        let dict_open = trailer.saturating_add(last_position(&source[trailer..], b"<<"));
        let dict_close = last_position(&source[..start], b">>").saturating_add(2);
        let entries = String::from_utf8_lossy(
            &source[dict_open.saturating_add(2)..dict_close.saturating_sub(2)],
        )
        .into_owned();
        let head = format!("xref\n0 0\ntrailer\n<<{entries} /Prev ");
        let mut probe = head.clone();
        probe.push_str(&table.to_string());
        probe.push_str(" >>\n");
        let mut width = probe.len();
        let mut section = String::new();
        for _ in 0_u8..3 {
            section = format!("{head}{} >>\n", table.saturating_add(width));
            width = section.len();
        }
        let mut out = source[..table].to_vec();
        out.extend_from_slice(section.as_bytes());
        out.extend_from_slice(&source[table..start]);
        out.extend_from_slice(format!("startxref\n{table}\n%%EOF\n").as_bytes());
        out
    }

    #[test]
    fn forward_prev_chains_like_linearized_files_stay_incremental() {
        let source = forward_prev();
        assert!(revision_complete(&source, source.len()));
        assert!(!Document::open(&source, &limits()).unwrap().was_repaired());
        let info = document_info(&source, None, b"Sig", &limits()).unwrap();
        let page_number = info.pages[0].reference.unwrap().number;
        let ops = placeholder_ops(info.next_object_number, page_number, "Sig1");
        let placed = edit(&source, &ops.finish(MODE_INCREMENTAL), &limits()).unwrap();
        assert!(placed.starts_with(&source));
        assert!(revision_complete(&placed, source.len()));
        assert!(revision_complete(&placed, placed.len()));
        let scan = analyze(&placed, Analysis::Dictionaries);
        assert_eq!(scan.dictionaries.len(), 1);
    }

    #[test]
    fn incremental_update_drops_bytes_after_the_final_eof() {
        let source = sample();
        let mut padded = source.clone();
        padded.extend_from_slice(b"<html>download footer</html>\n");
        let info = document_info(&padded, None, b"Sig", &limits()).unwrap();
        let page_number = info.pages[0].reference.unwrap().number;
        let ops = placeholder_ops(info.next_object_number, page_number, "Sig1");
        let placed = edit(&padded, &ops.finish(MODE_INCREMENTAL), &limits()).unwrap();
        assert!(placed.starts_with(&source));
        assert!(!placed.windows(6).any(|window| window == b"<html>"));
        assert!(revision_complete(&placed, source.len()));
        assert!(revision_complete(&placed, placed.len()));
    }

    #[test]
    fn incremental_update_reports_damaged_cross_reference_chains() {
        let mut shifted = b"JUNK\n".to_vec();
        shifted.extend_from_slice(&sample());
        let looping = self_looping_prev();
        for source in [shifted, looping] {
            let info = document_info(&source, None, b"Sig", &limits()).unwrap();
            let page_number = info.pages[0].reference.unwrap().number;
            let ops = placeholder_ops(info.next_object_number, page_number, "Sig1");
            let failure = edit(&source, &ops.finish(MODE_INCREMENTAL), &limits()).unwrap_err();
            assert_eq!(failure.code, FailureCode::DamagedXref);
        }
    }

    #[test]
    fn auto_mode_rewrites_chains_the_verifier_rejects() {
        let source = self_looping_prev();
        assert!(!revision_complete(&source, source.len()));
        let info = document_info(&source, None, b"Sig", &limits()).unwrap();
        let page_number = info.pages[0].reference.unwrap().number;
        let ops = placeholder_ops(info.next_object_number, page_number, "Sig1");
        edit(&source, &ops.finish(MODE_INCREMENTAL), &limits()).unwrap_err();
        let placed = edit(&source, &ops.finish(0), &limits()).unwrap();
        assert!(!placed.starts_with(&source));
        assert!(revision_complete(&placed, placed.len()));
        let scan = analyze(&placed, Analysis::Dictionaries);
        assert_eq!(scan.dictionaries.len(), 1);
        assert!(scan.dictionaries[0].unsigned_placeholder);
    }

    #[test]
    fn object_stream_rewrite_keeps_signature_dictionary_uncompressed() {
        let source = sample();
        let info = document_info(&source, None, b"Sig", &limits()).unwrap();
        let page_number = info.pages[0].reference.unwrap().number;
        let ops = placeholder_ops(info.next_object_number, page_number, "Sig1");
        let placed = edit(
            &source,
            &ops.finish(MODE_REWRITE | FLAG_OBJECT_STREAMS),
            &limits(),
        )
        .unwrap();
        let scan = analyze(&placed, Analysis::Dictionaries);
        assert_eq!(scan.dictionaries.len(), 1);
        assert!(scan.dictionaries[0].unsigned_placeholder);
    }

    #[test]
    fn incremental_placeholder_appends_and_keeps_prior_revision() {
        let source = sample();
        let info = document_info(&source, None, b"Sig", &limits()).unwrap();
        assert_eq!(info.field_name, Some(Ok("Sig1".to_owned())));
        assert!(!info.acro_form);
        let page_number = info.pages[0].reference.unwrap().number;
        let ops = placeholder_ops(info.next_object_number, page_number, "Sig1");
        let first = edit(&source, &ops.finish(0), &limits()).unwrap();
        assert!(first.starts_with(&source));
        let opened = reopen(&first);
        assert_eq!(opened.pages().unwrap().len(), 2);
        assert!(revision_complete(&first, source.len()));
        assert!(revision_complete(&first, first.len()));
        let scan = analyze(&first, Analysis::Dictionaries);
        assert_eq!(scan.dictionaries.len(), 1);
        assert!(scan.dictionaries[0].unsigned_placeholder);
        assert_eq!(page_text(&first), page_text(&source));

        let mut signed = first.clone();
        fill_signature(&mut signed);
        let second_info = document_info(&signed, Some(&[0]), b"Sig", &limits()).unwrap();
        assert!(second_info.acro_form);
        assert_eq!(second_info.field_name, Some(Ok("Sig2".to_owned())));
        assert_eq!(second_info.annotations.len(), 1);
        assert_eq!(second_info.annotations[0].slot, Slot::None);
        let mut second_ops = Ops::default();
        second_ops
            .op(OP_SIGNATURE)
            .u32(second_info.next_object_number)
            .u32(0)
            .u32(64)
            .bytes(b"<< >>");
        let widget = format!(
            "<< /Type /Annot /Subtype /Widget /FT /Sig /Rect [0 0 0 0] /V {} 0 R /T (Sig2) /F 4 /P {page_number} 0 R >>",
            second_info.next_object_number
        );
        let widget_number = second_info.next_object_number.saturating_add(1);
        second_ops
            .op(OP_SET_OBJECT)
            .u32(widget_number)
            .u32(0)
            .bytes(widget.as_bytes());
        let widget_ref = format!("{widget_number} 0 R");
        second_ops
            .op(OP_ARRAY_APPEND)
            .target(1, 0, 0, &[])
            .bytes(b"Annots")
            .bytes(widget_ref.as_bytes());
        second_ops
            .op(OP_ARRAY_APPEND)
            .target(0, 0, 0, &["AcroForm"])
            .bytes(b"Fields")
            .bytes(widget_ref.as_bytes());
        let mut second = edit(&signed, &second_ops.finish(1), &limits()).unwrap();
        assert!(second.starts_with(&signed));
        fill_signature(&mut second);
        let verification = analyze(&second, Analysis::Verification);
        assert_eq!(verification.failure, None);
        assert_eq!(verification.dictionaries.len(), 2);
        assert!(revision_complete(&second, signed.len()));
        assert!(revision_complete(&second, second.len()));
    }

    #[test]
    fn incremental_update_follows_xref_streams() {
        let source = sample();
        let rewritten = edit(
            &source,
            &Ops::default().finish(MODE_REWRITE | FLAG_OBJECT_STREAMS),
            &limits(),
        )
        .unwrap();
        reopen(&rewritten);
        assert_eq!(page_text(&rewritten), page_text(&source));
        let mut ops = Ops::default();
        ops.op(OP_DICT_SET)
            .target(0, 0, 0, &[])
            .bytes(b"Lang")
            .bytes(b"(pt-BR)");
        let updated = edit(&rewritten, &ops.finish(MODE_INCREMENTAL), &limits()).unwrap();
        assert!(updated.starts_with(&rewritten));
        let tail = &updated[rewritten.len()..];
        assert!(tail.windows(11).any(|window| window == b"/Type /XRef"));
        let opened = reopen(&updated);
        let catalog = opened.catalog().unwrap().unwrap();
        assert_eq!(
            catalog.as_dict().unwrap().get(b"Lang"),
            Some(&Object::String(b"pt-BR".to_vec()))
        );
        assert!(revision_complete(&updated, updated.len()));
        assert!(revision_complete(&updated, rewritten.len()));
    }

    #[test]
    fn rewrite_drops_unreachable_objects_and_repairs_the_catalog() {
        let source = document(
            &[page(text(72.0, 700.0, 12.0, "Kept"))],
            &[(40, "<< /Orphan true >>".to_owned())],
        );
        let mut ops = Ops::default();
        ops.op(OP_REPAIR_CATALOG);
        let rewritten = edit(&source, &ops.finish(MODE_REWRITE), &limits()).unwrap();
        assert!(rewritten.starts_with(b"%PDF-1.7"));
        assert!(!rewritten.windows(7).any(|window| window == b"/Orphan"));
        let opened = reopen(&rewritten);
        assert!(opened.object_count() < 10);
        assert_eq!(page_text(&rewritten), vec!["Kept".to_owned()]);
    }

    #[test]
    fn append_content_wraps_existing_streams_and_adds_resources() {
        let source = sample();
        let next = document_info(&source, None, b"", &limits())
            .unwrap()
            .next_object_number;
        let mut ops = Ops::default();
        ops.op(OP_STANDARD_FONT)
            .u32(next)
            .u32(0)
            .bytes(b"Helvetica-Bold");
        let font_ref = format!("{next} 0 R");
        ops.op(OP_PAGE_RESOURCE)
            .u32(1)
            .bytes(b"Font")
            .bytes(b"FSK")
            .bytes(font_ref.as_bytes());
        ops.op(OP_APPEND_CONTENT)
            .u32(1)
            .u32(next.saturating_add(1))
            .u32(0)
            .u32(next.saturating_add(2))
            .u32(0)
            .bytes(b"1 0 0 1 0 0 cm BT /FSK 12 Tf 1 0 0 1 72 600 Tm (Stamped) Tj ET")
            .u32(CONTENT_COMPRESS);
        let updated = edit(&source, &ops.finish(0), &limits()).unwrap();
        let opened = reopen(&updated);
        let pages = opened.pages().unwrap();
        let content = opened.content(&pages[1]).unwrap();
        let rendered = String::from_utf8_lossy(&content).into_owned();
        assert!(rendered.starts_with("q\n"), "{rendered}");
        assert!(rendered.contains("\nQ\n1 0 0 1 0 0 cm"), "{rendered}");
        assert!(
            pages[1]
                .resources
                .as_dict()
                .unwrap()
                .get(b"Font")
                .and_then(Object::as_dict)
                .unwrap()
                .get(b"FSK")
                .is_some()
        );
        let text_pages = page_text(&updated);
        assert!(text_pages[1].contains("Stamped"), "{text_pages:?}");
        assert!(text_pages[1].contains("World"));
        assert_eq!(text_pages[0], "Hello");
    }

    #[test]
    fn page_resources_refuse_to_rebind_an_existing_name() {
        let source = sample();
        let next = document_info(&source, None, b"", &limits())
            .unwrap()
            .next_object_number;
        let bind = |pdf: &[u8], reference: &str| {
            let mut ops = Ops::default();
            ops.op(OP_PAGE_RESOURCE)
                .u32(1)
                .bytes(b"XObject")
                .bytes(b"Stamp")
                .bytes(reference.as_bytes());
            edit(pdf, &ops.finish(MODE_INCREMENTAL), &limits())
        };
        let first = format!("{next} 0 R");
        let bound = bind(&source, &first).unwrap();
        let same = bind(&bound, &first).unwrap();
        let rebound = bind(&same, &format!("{} 0 R", next.saturating_add(1)));
        let failure = rebound.unwrap_err();
        assert_eq!(failure.code, FailureCode::InvalidRequest);
        assert!(
            failure.reason.contains("already bound"),
            "{}",
            failure.reason
        );
        let pages = reopen(&same).pages().unwrap();
        assert_eq!(
            pages[1]
                .resources
                .as_dict()
                .unwrap()
                .get(b"XObject")
                .and_then(Object::as_dict)
                .and_then(|dict| dict.get(b"Stamp")),
            Some(&Object::Ref(ObjRef {
                number: next,
                generation: 0
            }))
        );
    }

    #[test]
    fn images_split_alpha_into_soft_masks() {
        let source = sample();
        let next = document_info(&source, None, b"", &limits())
            .unwrap()
            .next_object_number;
        let rgba: Vec<u8> = (0..4_u8)
            .flat_map(|value| [value, 10, 20, value.saturating_add(200)])
            .collect();
        let mut ops = Ops::default();
        ops.op(OP_IMAGE)
            .u32(next)
            .u32(0)
            .u32(next.saturating_add(1))
            .u32(0)
            .u32(2)
            .u32(2)
            .u32(3)
            .u32(IMAGE_ALPHA)
            .bytes(&rgba);
        let updated = edit(&source, &ops.finish(0), &limits()).unwrap();
        let opened = reopen(&updated);
        let image = opened
            .load(ObjRef {
                generation: 0,
                number: next,
            })
            .unwrap();
        let Object::Stream(stream) = &*image else {
            panic!("image stream expected")
        };
        let color = Resolver::stream_data(&opened, stream).unwrap();
        assert_eq!(color, vec![0, 10, 20, 1, 10, 20, 2, 10, 20, 3, 10, 20]);
        let mask = opened
            .load(ObjRef {
                generation: 0,
                number: next.saturating_add(1),
            })
            .unwrap();
        let Object::Stream(mask_stream) = &*mask else {
            panic!("mask stream expected")
        };
        assert_eq!(
            Resolver::stream_data(&opened, mask_stream).unwrap(),
            vec![200, 201, 202, 203]
        );
        let mut wrong = Ops::default();
        wrong
            .op(OP_IMAGE)
            .u32(next)
            .u32(0)
            .u32(0)
            .u32(0)
            .u32(2)
            .u32(2)
            .u32(3)
            .u32(0)
            .bytes(&rgba);
        assert_eq!(
            edit(&source, &wrong.finish(0), &limits()).unwrap_err().code,
            FailureCode::InvalidRequest
        );
    }

    #[test]
    fn png_images_decode_into_image_objects_with_soft_masks() {
        let mut png = vec![137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13];
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&[0, 0, 0, 2, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0, 0, 0, 0]);
        let data = zlib_compress(&[0, 10, 20, 30, 0, 40, 50, 60, 255]);
        png.extend_from_slice(&u32::try_from(data.len()).unwrap().to_be_bytes());
        png.extend_from_slice(b"IDAT");
        png.extend_from_slice(&data);
        png.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 0]);
        png.extend_from_slice(b"IEND");
        png.extend_from_slice(&[0, 0, 0, 0]);
        let source = sample();
        let next = document_info(&source, None, b"", &limits())
            .unwrap()
            .next_object_number;
        let mut ops = Ops::default();
        ops.op(OP_PNG)
            .u32(next)
            .u32(0)
            .u32(next.saturating_add(1))
            .u32(0)
            .bytes(&png);
        let updated = edit(&source, &ops.finish(MODE_INCREMENTAL), &limits()).unwrap();
        let opened = reopen(&updated);
        let image = opened
            .load(ObjRef {
                generation: 0,
                number: next,
            })
            .unwrap();
        let Object::Stream(stream) = &*image else {
            panic!("image stream expected")
        };
        assert_eq!(stream.dict.get(b"Width"), Some(&Object::Integer(2)));
        assert_eq!(
            Resolver::stream_data(&opened, stream).unwrap(),
            vec![10, 20, 30, 40, 50, 60]
        );
        let mask = opened
            .load(ObjRef {
                generation: 0,
                number: next.saturating_add(1),
            })
            .unwrap();
        let Object::Stream(mask_stream) = &*mask else {
            panic!("mask stream expected")
        };
        assert_eq!(
            Resolver::stream_data(&opened, mask_stream).unwrap(),
            vec![0, 255]
        );
        let mut broken = Ops::default();
        broken
            .op(OP_PNG)
            .u32(next)
            .u32(0)
            .u32(0)
            .u32(0)
            .bytes(b"nope");
        assert_eq!(
            edit(&source, &broken.finish(MODE_INCREMENTAL), &limits())
                .unwrap_err()
                .code,
            FailureCode::InvalidRequest
        );
    }

    #[test]
    fn rejects_malformed_payloads() {
        let source = sample();
        let mut font = Ops::default();
        font.op(OP_STANDARD_FONT).u32(9).u32(0).bytes(b"Comic");
        let mut syntax = Ops::default();
        syntax
            .op(OP_SET_OBJECT)
            .u32(9)
            .u32(0)
            .bytes(b"<< /A 1 >> extra");
        let mut unknown = Ops::default();
        unknown.op(99);
        for payload in [
            font.finish(0),
            syntax.finish(0),
            unknown.finish(0),
            b"nope".to_vec(),
        ] {
            assert_eq!(
                edit(&source, &payload, &limits()).unwrap_err().code,
                FailureCode::InvalidRequest
            );
        }
        let mut trailing = Ops::default().finish(0);
        trailing.push(0);
        assert_eq!(
            edit(&source, &trailing, &limits()).unwrap_err().code,
            FailureCode::InvalidRequest
        );
    }

    #[test]
    fn document_info_reports_signature_slots_and_field_names() {
        let objects = vec![
            (1, "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [6 0 R 8 0 R] >> >>".to_owned()),
            (2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_owned()),
            (3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Annots [5 0 R 7 0 R << /Subtype /Link /Rect [1 1 5 5] /A << /S /URI /URI (https://a.test/x) >> >> 10 0 R] >>".to_owned()),
            (5, "<< /Type /Annot /Subtype /Widget /FT /Sig /T (Empty) /Rect [10 10 110 60] >>".to_owned()),
            (6, "<< /FT /Sig /T (Parent) /Kids [7 0 R] >>".to_owned()),
            (7, "<< /Type /Annot /Subtype /Widget /Parent 6 0 R /Rect [120 10 220 60] >>".to_owned()),
            (8, "<< /T (Sig1) /Kids [9 0 R] >>".to_owned()),
            (9, "<< /T (Sig2) >>".to_owned()),
            (10, "<< /Subtype /Link /Rect [2 2 6 6] /A 11 0 R >>".to_owned()),
            (11, "<< /S /URI /URI <FEFF0068> >>".to_owned()),
        ];
        let pdf = build(&objects);
        let info = document_info(&pdf, Some(&[0]), b"Sig", &limits()).unwrap();
        assert_eq!(info.pages[0].annotation_count, 4);
        assert_eq!(info.annotations[0].uri, None);
        assert_eq!(info.annotations[2].uri.as_deref(), Some("https://a.test/x"));
        assert_eq!(info.annotations[3].uri.as_deref(), Some("h"));
        assert_eq!(info.annotations[0].slot, Slot::Open(FieldTarget::Widget));
        assert_eq!(
            info.annotations[1].slot,
            Slot::Open(FieldTarget::Ref(ObjRef {
                generation: 0,
                number: 6
            }))
        );
        assert_eq!(info.annotations[2].slot, Slot::None);
        assert_eq!(
            info.annotations[2].rect,
            Some([1.0_f64, 1.0_f64, 5.0_f64, 5.0_f64])
        );
        assert!(!info.annotations[2].widget);
        assert_eq!(info.field_name, Some(Ok("Sig3".to_owned())));

        let cyclic = build(&[
            (
                1,
                "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R] >> >>".to_owned(),
            ),
            (2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_owned()),
            (
                3,
                "<< /Type /Page /Parent 2 0 R /Annots [5 0 R] >>".to_owned(),
            ),
            (4, "<< /T (root) /Kids [4 0 R] >>".to_owned()),
            (
                5,
                "<< /Subtype /Widget /FT /Sig /Parent 6 0 R /Rect [0 0 10 10] >>".to_owned(),
            ),
            (6, "<< /Parent 6 0 R >>".to_owned()),
        ]);
        let cyclic_info = document_info(&cyclic, Some(&[0]), b"Sig", &limits()).unwrap();
        assert_eq!(cyclic_info.field_name, Some(Err(3)));
        assert_eq!(cyclic_info.annotations[0].slot, Slot::Malformed(1));
    }

    #[test]
    fn field_name_search_enforces_depth_and_budget() {
        let mut objects = vec![
            (
                1,
                "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [10 0 R] >> >>".to_owned(),
            ),
            (2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_owned()),
            (3, "<< /Type /Page /Parent 2 0 R >>".to_owned()),
        ];
        for depth in 0..66_u32 {
            objects.push((
                depth.saturating_add(10),
                format!(
                    "<< /T (f{depth}) /Kids [{} 0 R] >>",
                    depth.saturating_add(11)
                ),
            ));
        }
        objects.push((76, "<< /T (leaf) >>".to_owned()));
        let deep = build(&objects);
        assert_eq!(
            document_info(&deep, None, b"Sig", &limits())
                .unwrap()
                .field_name,
            Some(Err(1))
        );
        let long_name = "n".repeat(4097);
        let long = build(&[
            (
                1,
                "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R] >> >>".to_owned(),
            ),
            (2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_owned()),
            (3, "<< /Type /Page /Parent 2 0 R >>".to_owned()),
            (4, format!("<< /T ({long_name}) >>")),
        ]);
        assert_eq!(
            document_info(&long, None, b"Sig", &limits())
                .unwrap()
                .field_name,
            Some(Err(4))
        );
    }

    #[test]
    fn merge_copies_pages_and_rewrites_page_references() {
        let first = build(&[
            (1, "<< /Type /Catalog /Pages 2 0 R >>".to_owned()),
            (2, "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 /Resources << /Font << /F1 7 0 R >> >> /MediaBox [0 0 200 100] >>".to_owned()),
            (3, "<< /Type /Page /Parent 2 0 R /Contents 5 0 R /Annots [6 0 R 8 0 R] >>".to_owned()),
            (4, "<< /Type /Page /Parent 2 0 R /Contents 5 0 R >>".to_owned()),
            (5, stream_object("", "BT /F1 12 Tf 10 50 Td (Merged) Tj ET")),
            (6, "<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] /P 3 0 R /Dest [4 0 R /Fit] >>".to_owned()),
            (7, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_owned()),
            (8, "<< /Type /Annot /Subtype /Widget /FT /Sig /Rect [0 0 10 10] /P 3 0 R >>".to_owned()),
        ]);
        let second = sample();
        let merged = merge(
            &[&first, &second],
            &[Some(vec![0]), None],
            true,
            Packing::Classic,
            &limits(),
        )
        .unwrap();
        let opened = reopen(&merged);
        let pages = opened.pages().unwrap();
        assert_eq!(pages.len(), 3);
        assert_eq!(
            pages[0].info.media_box,
            [0.0_f64, 0.0_f64, 200.0_f64, 100.0_f64]
        );
        let annots = opened
            .follow(pages[0].dict.get(b"Annots").unwrap())
            .unwrap();
        let items = annots.as_array().unwrap();
        assert_eq!(items.len(), 1);
        let link = opened.follow(&items[0]).unwrap();
        let link_dict = link.as_dict().unwrap();
        assert_eq!(
            link_dict.get(b"P"),
            Some(&Object::Ref(pages[0].obj_ref.unwrap()))
        );
        assert_eq!(
            link_dict.get(b"Dest").and_then(Object::as_array).unwrap()[0],
            Object::Null
        );
        let text_pages = page_text(&merged);
        assert_eq!(
            text_pages,
            vec!["Merged".to_owned(), "Hello".to_owned(), "World".to_owned()]
        );
        let packed = merge(
            &[&second],
            &[Some(vec![1])],
            false,
            Packing::ObjectStreams,
            &limits(),
        )
        .unwrap();
        reopen(&packed);
        assert_eq!(page_text(&packed), vec!["World".to_owned()]);
    }
}
