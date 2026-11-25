use super::{
    Base, Changes, Dict, Document, Failure, Limits, ObjRef, Object, Outcome, Reader, Step, Store,
    Target, appendable, next_object_number, widen,
};
use crate::object::Resolver as _;
use crate::revision::revision_index;
use crate::write::incremental_update;

const KEYS: [&[u8]; 3] = [b"Certs", b"OCSPs", b"CRLs"];
const MAX_ENTRIES: usize = 1024;
const MAX_TOTAL_BYTES: usize = 16 * 1024 * 1024;

#[expect(
    clippy::missing_errors_doc,
    clippy::missing_inline_in_public_items,
    reason = "the WASM bindings document the DSS contract"
)]
pub fn add_validation_data(pdf: &[u8], payload: &[u8], limits: &Limits) -> Outcome<Vec<u8>> {
    if payload.len() > MAX_TOTAL_BYTES {
        return Err(Failure::limit("validation data exceeds its size limit"));
    }
    let document = appendable(pdf, limits)?;
    let existing = validation_objects(&document)?;
    let mut reader = Reader {
        data: payload,
        pos: 0,
    };
    let mut store = Store {
        changed: Changes::default(),
        document: &document,
        pages: None,
    };
    let mut next = next_object_number(&document);
    let mut changed = false;
    let target = Target {
        base: Base::Catalog,
        path: vec![Step::Key(b"DSS".to_vec())],
    };
    let mut size = 0_usize;
    for (key, mut items) in KEYS.into_iter().zip(existing) {
        let count = widen(reader.u32()?);
        if count > MAX_ENTRIES {
            return Err(Failure::limit("too many validation data entries"));
        }
        let mut values = Vec::with_capacity(items.len());
        for item in &items {
            values.push(read_stream(&document, item, &mut size)?);
        }
        if count == 0 {
            continue;
        }
        let previous = items.len();
        for _ in 0..count {
            let bytes = reader.bytes()?;
            if bytes.is_empty() {
                return Err(Failure::request(
                    "validation data entries must not be empty",
                ));
            }
            if values.iter().any(|value| value == bytes) {
                continue;
            }
            size = size.saturating_add(bytes.len());
            if size > MAX_TOTAL_BYTES || items.len() >= MAX_ENTRIES {
                return Err(Failure::limit("validation data exceeds its size limit"));
            }
            let reference = ObjRef {
                number: next,
                generation: 0,
            };
            next = next
                .checked_add(1)
                .ok_or_else(|| Failure::limit("too many PDF objects"))?;
            store.set_stream(reference, Dict::default(), bytes.to_vec(), true);
            items.push(Object::Ref(reference));
            values.push(bytes.to_vec());
        }
        if items.len() != previous {
            let (root, path) = store.locate(&target, true)?;
            let dss = store.dict_at(root, &path)?;
            dss.insert(b"Type", Object::Name(b"DSS".to_vec()));
            dss.insert(key, Object::Array(items));
            changed = true;
        }
    }
    if reader.pos != payload.len() {
        return Err(Failure::request(
            "validation data payload has trailing bytes",
        ));
    }
    if !changed {
        return Ok(Vec::new());
    }
    incremental_update(&document, &store.changed, pdf, None).map(|(appendix, _)| appendix)
}

#[expect(
    clippy::missing_errors_doc,
    clippy::missing_inline_in_public_items,
    reason = "the WASM bindings document the DSS contract"
)]
pub fn read_validation_data(pdf: &[u8], limits: &Limits) -> Outcome<[Vec<Vec<u8>>; 3]> {
    let index = revision_index(pdf)?;
    let document = Document::open(index.current(), limits)?;
    let mut lists = [Vec::new(), Vec::new(), Vec::new()];
    let mut size = 0_usize;
    for (entries, list) in validation_objects(&document)?.into_iter().zip(&mut lists) {
        for item in entries {
            list.push(read_stream(&document, &item, &mut size)?);
        }
    }
    Ok(lists)
}

fn read_stream(document: &Document<'_>, item: &Object, size: &mut usize) -> Outcome<Vec<u8>> {
    let resolved = document.follow(item)?;
    let stream = resolved
        .as_stream()
        .ok_or_else(|| Failure::invalid("DSS entry is not a stream"))?;
    let bytes = document.stream_data(stream)?;
    *size = size.saturating_add(bytes.len());
    if *size > MAX_TOTAL_BYTES {
        return Err(Failure::limit("validation data exceeds its size limit"));
    }
    Ok(bytes)
}

fn validation_objects(document: &Document<'_>) -> Outcome<[Vec<Object>; 3]> {
    let mut lists = [Vec::new(), Vec::new(), Vec::new()];
    let catalog = document
        .catalog()?
        .ok_or_else(|| Failure::invalid("missing catalog"))?;
    let Some(dss) = catalog.as_dict().and_then(|dict| dict.get(b"DSS")) else {
        return Ok(lists);
    };
    let resolved = document.follow(dss)?;
    let dict = resolved
        .as_dict()
        .ok_or_else(|| Failure::invalid("invalid DSS dictionary"))?;
    for (key, list) in KEYS.into_iter().zip(&mut lists) {
        let Some(value) = dict.get(key) else { continue };
        let items = document.follow(value)?;
        let array = items
            .as_array()
            .ok_or_else(|| Failure::invalid("invalid DSS evidence array"))?;
        if array.len() > MAX_ENTRIES {
            return Err(Failure::limit("too many validation data entries"));
        }
        list.extend_from_slice(array);
    }
    Ok(lists)
}
