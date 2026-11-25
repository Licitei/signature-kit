use alloc::collections::BTreeMap;
use std::collections::{HashMap, HashSet};

use super::{Entry, MAX_REVISION_WORK, RevisionIndex, SourceKind, Terminal, revision_index};
use crate::document::{Document, Page};
use crate::edit::signing::{RevisionField, SignaturePolicy, revision_fields, signature_policies};
use crate::failure::{Failure, Outcome};
use crate::inspection::Limits;
use crate::object::{Dict, ObjRef, Object};

const PAGE: u16 = 1;
const PAGE_DATA: u16 = 2;
const FIELD: u16 = 4;
const FORM: u16 = 8;
const APPEARANCE: u16 = 16;
const DSS: u16 = 32;
const ANNOTATION: u16 = 64;
const ANNOTATIONS: u16 = 128;
const CATALOG: u16 = 256;
const SIGNATURE: u16 = 512;
const PERMISSIONS: u16 = 1024;
const FIELD_WIDGET: u16 = FIELD | ANNOTATION;
const FORM_FIELDS: u16 = 2048;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[expect(
    clippy::exhaustive_enums,
    reason = "the internal ABI shares these variants with the WASM crate"
)]
pub enum ChangeKind {
    AcroForm,
    Annotation,
    CatalogOther,
    DocTimeStamp,
    Dss,
    FormValue,
    PageContent,
    Signature,
    SignatureField,
    Unknown,
    WidgetAppearance,
}

impl From<ChangeKind> for u32 {
    #[inline]
    fn from(kind: ChangeKind) -> Self {
        match kind {
            ChangeKind::Signature => 0,
            ChangeKind::SignatureField => 1,
            ChangeKind::WidgetAppearance => 2,
            ChangeKind::AcroForm => 3,
            ChangeKind::Dss => 4,
            ChangeKind::DocTimeStamp => 5,
            ChangeKind::Annotation => 6,
            ChangeKind::PageContent => 7,
            ChangeKind::CatalogOther => 8,
            ChangeKind::Unknown => 9,
            ChangeKind::FormValue => 10,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
#[expect(
    clippy::exhaustive_structs,
    reason = "the internal ABI shares this struct with the WASM crate"
)]
pub struct Change {
    pub added: bool,
    pub field_names: Vec<String>,
    pub kind: ChangeKind,
    pub reference: ObjRef,
    pub removed: bool,
    pub revision_end: usize,
}

#[derive(Debug)]
#[expect(
    clippy::exhaustive_structs,
    reason = "the internal ABI shares this struct with the WASM crate"
)]
#[expect(
    clippy::module_name_repetitions,
    reason = "the internal ABI retains the existing PDF operation names"
)]
pub struct RevisionChanges {
    pub changes: Vec<Change>,
    pub from_revision_index: usize,
    pub page_content_changed: bool,
    pub policies: Vec<SignaturePolicy>,
}

struct Graph<'doc, 'data> {
    document: &'doc Document<'data>,
    field_names: HashMap<ObjRef, Vec<String>>,
    pages: Vec<Page>,
    roles: HashMap<ObjRef, u16>,
    signature_fields: HashSet<ObjRef>,
    work: usize,
}

impl<'doc, 'data> Graph<'doc, 'data> {
    fn dictionary(&mut self, dict: &Dict, role: u16, depth: usize) -> Outcome<()> {
        for (key, value) in &dict.entries {
            let child = match (role, key.as_slice()) {
                (CATALOG, b"AcroForm") => FORM,
                (CATALOG, b"DSS") => DSS,
                (CATALOG, b"Perms") => PERMISSIONS,
                (PERMISSIONS, b"DocMDP") => SIGNATURE,
                (DSS | PAGE_DATA | APPEARANCE, _) => role,
                (FORM, b"Fields") | (FIELD, b"Kids") => FORM_FIELDS,
                (FIELD | ANNOTATION, b"AP") => APPEARANCE,
                _ => continue,
            };
            self.walk(value, child, depth)?;
        }
        Ok(())
    }

    fn field_dependencies(&mut self, object: &Object, name: &str, depth: usize) -> Outcome<()> {
        self.work = self.work.saturating_add(1);
        if depth > 128 || self.work > MAX_REVISION_WORK {
            return Err(Failure::limit(
                "PDF field dependency graph exceeds its traversal budget",
            ));
        }
        let next = depth.saturating_add(1);
        if let Some(reference) = object.as_reference() {
            let names = self.field_names.entry(reference).or_default();
            if names.iter().any(|field| field == name) {
                return Ok(());
            }
            names.push(name.to_owned());
            return self.field_dependencies(self.document.load(reference)?.as_ref(), name, next);
        }
        if let Some(items) = object.as_array() {
            for item in items {
                self.field_dependencies(item, name, next)?;
            }
        } else if let Some(dict) = object.as_dict() {
            for (key, value) in &dict.entries {
                if !matches!(key.as_slice(), b"P" | b"Parent" | b"Data") {
                    self.field_dependencies(value, name, next)?;
                }
            }
        }
        Ok(())
    }

    fn read(document: &'doc Document<'data>) -> Outcome<Self> {
        let mut graph = Self {
            document,
            pages: Vec::new(),
            roles: HashMap::new(),
            signature_fields: HashSet::new(),
            field_names: HashMap::new(),
            work: 0,
        };
        for RevisionField {
            name,
            references,
            signature,
            value,
        } in revision_fields(document)?
        {
            if signature {
                graph.signature_fields.extend(references.iter().copied());
                if let Some(signature_value) = &value {
                    graph.walk(signature_value, SIGNATURE, 0)?;
                }
            }
            for reference in references {
                let field = document.load(reference)?;
                for key in [b"AP".as_slice(), b"V"] {
                    if let Some(dependency) = field.as_dict().and_then(|dict| dict.get(key)) {
                        graph.field_dependencies(dependency, &name, 0)?;
                    }
                }
                graph
                    .field_names
                    .entry(reference)
                    .or_default()
                    .push(name.clone());
            }
        }
        if let Some(root) = document.trailer().get(b"Root") {
            graph.walk(root, CATALOG, 0)?;
        }
        let pages = document.pages()?;
        for page in &pages {
            if let Some(reference) = page.obj_ref {
                let _: Option<u16> = graph.roles.insert(reference, PAGE);
            }
            if let Some(contents) = page.dict.get(b"Contents") {
                graph.walk(contents, PAGE_DATA, 0)?;
            }
            graph.walk(&page.resources_for_write(), PAGE_DATA, 0)?;
            if let Some(annotations) = page.dict.get(b"Annots") {
                graph.walk(annotations, ANNOTATIONS, 0)?;
            }
        }
        graph.pages = pages;
        Ok(graph)
    }

    fn role(&self, reference: ObjRef) -> u16 {
        self.roles.get(&reference).copied().unwrap_or(0)
    }
    fn walk(&mut self, object: &Object, role: u16, depth: usize) -> Outcome<()> {
        self.work = self.work.saturating_add(1);
        if depth > 128 || self.work > MAX_REVISION_WORK {
            return Err(Failure::limit(
                "PDF revision change graph exceeds its traversal budget",
            ));
        }
        let next = depth.saturating_add(1);
        if let Some(reference) = object.as_reference() {
            let roles = self.roles.entry(reference).or_insert(0);
            if *roles & role != 0 {
                return Ok(());
            }
            *roles |= role;
            let resolved = self.document.load(reference)?;
            return self.walk(&resolved, role, next);
        }
        if let Some(items) = object.as_array() {
            let item_role = match role {
                ANNOTATIONS => ANNOTATION,
                FORM_FIELDS => FIELD,
                _ => role,
            };
            for item in items {
                self.walk(item, item_role, next)?;
            }
        } else if let Some(dict) = object.as_dict() {
            self.dictionary(dict, role, next)?;
        }
        Ok(())
    }
}

struct Pair<'doc, 'data> {
    current: &'doc ActiveEntries,
    index: &'doc RevisionIndex<'data>,
    new: Graph<'doc, 'data>,
    old: Graph<'doc, 'data>,
    previous: &'doc ActiveEntries,
    revision_end: usize,
}

impl Pair<'_, '_> {
    fn collect(&self, result: &mut RevisionChanges) -> Outcome<()> {
        result.page_content_changed |= page_dependencies_changed(&self.old.pages, &self.new.pages);
        for (&number, &entry) in self.current {
            self.record(
                result,
                number,
                Some(entry),
                self.previous.get(&number).copied(),
            )?;
        }
        for (&number, &entry) in self.previous {
            if !self.current.contains_key(&number) {
                self.record(result, number, None, Some(entry))?;
            }
        }
        self.record_trailer(result)?;
        if self.new.document.was_repaired() || self.old.document.was_repaired() {
            return Err(Failure::invalid(
                "revision change analysis encountered a damaged object",
            ));
        }
        Ok(())
    }

    fn record(
        &self,
        result: &mut RevisionChanges,
        number: u64,
        new: Option<Entry>,
        old: Option<Entry>,
    ) -> Outcome<()> {
        if same_entry(self.previous, self.current, old, new) {
            return Ok(());
        }
        let before = reference(number, old)?;
        let after = reference(number, new)?;
        if before.is_none() && (after.is_none() || self.index.is_xref(new)) {
            return Ok(());
        }
        let Some(object_ref) = after.or(before) else {
            return Ok(());
        };
        let roles =
            before.map_or(0, |key| self.old.role(key)) | after.map_or(0, |key| self.new.role(key));
        let older = before.map(|key| self.old.document.load(key)).transpose()?;
        let newer = after.map(|key| self.new.document.load(key)).transpose()?;
        if older.as_deref().is_some_and(|object| {
            object.as_stream().is_none() && before == after && newer.as_deref() == Some(object)
        }) {
            return Ok(());
        }
        let kind = match &newer {
            Some(object) => {
                let signature_field = self.old.signature_fields.contains(&object_ref)
                    || self.new.signature_fields.contains(&object_ref);
                classify(
                    older.as_deref(),
                    object,
                    roles,
                    signature_field,
                    &self.old,
                    &self.new,
                )?
            }
            None => ChangeKind::Unknown,
        };
        result.page_content_changed |= roles & PAGE_DATA != 0 || kind == ChangeKind::PageContent;
        let mut field_names: Vec<_> = before
            .and_then(|key| self.old.field_names.get(&key))
            .into_iter()
            .chain(after.and_then(|key| self.new.field_names.get(&key)))
            .flatten()
            .cloned()
            .collect();
        field_names.sort_unstable();
        field_names.dedup();
        let change = Change {
            field_names,
            added: before.is_none(),
            kind,
            reference: object_ref,
            removed: after.is_none(),
            revision_end: self.revision_end,
        };
        result.changes.push(change);
        Ok(())
    }
    fn record_trailer(&self, result: &mut RevisionChanges) -> Outcome<()> {
        let previous = self.old.document.trailer();
        let current = self.new.document.trailer();
        let significant =
            changed_keys(Some(&previous), &current)
                .into_iter()
                .any(|key| match key {
                    b"Size" | b"Prev" | b"XRefStm" => false,
                    b"Type" | b"W" | b"Index" | b"Length" | b"Filter" | b"DecodeParms"
                        if current.get(b"Type").and_then(Object::as_name) == Some(b"XRef") =>
                    {
                        false
                    }
                    b"ID" => permanent_id(&previous) != permanent_id(&current),
                    _ => true,
                });
        if significant {
            let reference = current
                .get(b"Root")
                .and_then(Object::as_reference)
                .ok_or_else(|| Failure::invalid("PDF revision trailer has no catalog reference"))?;
            if !result
                .changes
                .iter()
                .rev()
                .take_while(|change| change.revision_end == self.revision_end)
                .any(|change| {
                    change.reference == reference && change.kind == ChangeKind::CatalogOther
                })
            {
                result.changes.push(Change {
                    added: false,
                    field_names: Vec::new(),
                    kind: ChangeKind::CatalogOther,
                    reference,
                    removed: false,
                    revision_end: self.revision_end,
                });
            }
        }
        Ok(())
    }
}

type ActiveEntries = BTreeMap<u64, Entry>;

impl RevisionIndex<'_> {
    fn entries(&self, terminal: Terminal) -> Outcome<ActiveEntries> {
        let mut entries = BTreeMap::new();
        let mut offset = terminal.xref_offset;
        loop {
            let source = usize::try_from(offset)
                .ok()
                .and_then(|at| self.structure.usable(at, terminal))
                .ok_or_else(|| Failure::invalid("missing cross-reference section"))?;
            for &(number, entry) in &source.entries.0 {
                if number != 0 {
                    let _: &mut Entry = entries.entry(number).or_insert(entry);
                }
            }
            let Some(previous) = source.previous else {
                break;
            };
            offset = u64::try_from(previous)
                .map_err(|_cause| Failure::invalid("invalid previous cross-reference offset"))?;
        }
        Ok(entries)
    }

    fn is_xref(&self, entry: Option<Entry>) -> bool {
        let Some(Entry::Uncompressed { offset, .. }) = entry else {
            return false;
        };
        usize::try_from(offset)
            .ok()
            .and_then(|at| self.structure.source(at))
            .is_some_and(|source| source.kind == SourceKind::Stream)
    }
}

fn reference(number: u64, entry: Option<Entry>) -> Outcome<Option<ObjRef>> {
    let generation = match entry {
        Some(Entry::Uncompressed { generation, .. }) => generation,
        Some(Entry::Compressed { .. }) => 0,
        None | Some(Entry::Free { .. }) => return Ok(None),
    };
    Ok(Some(ObjRef {
        number: u32::try_from(number)
            .map_err(|_cause| Failure::limit("PDF object number is out of range"))?,
        generation: u16::try_from(generation)
            .map_err(|_cause| Failure::invalid("PDF object generation is out of range"))?,
    }))
}

fn same_entry(
    previous: &ActiveEntries,
    current: &ActiveEntries,
    old: Option<Entry>,
    new: Option<Entry>,
) -> bool {
    if old != new {
        return false;
    }
    if let Some(Entry::Compressed { stream, .. }) = new {
        return previous.get(&stream) == current.get(&stream);
    }
    true
}

fn changed_keys<'dict>(before: Option<&'dict Dict>, after: &'dict Dict) -> Vec<&'dict [u8]> {
    let old_items = before.map_or(&[][..], |dict| dict.entries.as_slice());
    old_items
        .iter()
        .chain(&after.entries)
        .filter(|(key, _)| before.and_then(|dict| dict.get(key)) != after.get(key))
        .map(|(key, _)| key.as_slice())
        .collect()
}

fn recognized(keys: &[&[u8]], accepted: &[&[u8]]) -> bool {
    keys.iter().all(|key| accepted.contains(key))
}

fn signature_kind(dict: &Dict) -> Option<ChangeKind> {
    if dict.get(b"ByteRange").is_none() || dict.get(b"Contents").is_none() {
        return None;
    }
    match dict.get(b"Type").and_then(Object::as_name) {
        Some(b"DocTimeStamp") => Some(ChangeKind::DocTimeStamp),
        Some(b"Sig") | None => Some(ChangeKind::Signature),
        Some(_) => None,
    }
}

fn annotation_kind(object: &Object, graph: &Graph<'_, '_>) -> Outcome<ChangeKind> {
    let annotation = graph.document.follow(object)?;
    let Some(dict) = annotation.as_dict() else {
        return Ok(ChangeKind::Unknown);
    };
    match dict.get(b"Subtype").and_then(Object::as_name) {
        Some(b"Widget")
            if object
                .as_reference()
                .is_some_and(|reference| graph.signature_fields.contains(&reference)) =>
        {
            Ok(ChangeKind::SignatureField)
        }
        Some(b"Widget") | None => Ok(ChangeKind::Unknown),
        Some(_) => Ok(ChangeKind::Annotation),
    }
}

fn annotation_changes(
    before: Option<&Object>,
    after: &Object,
    old: &Graph<'_, '_>,
    new: &Graph<'_, '_>,
) -> Outcome<ChangeKind> {
    let existing = before.map(|value| old.document.follow(value)).transpose()?;
    let added = new.document.follow(after)?;
    let Some(items) = added.as_array() else {
        return Ok(ChangeKind::Unknown);
    };
    let old_items = existing
        .as_deref()
        .and_then(Object::as_array)
        .unwrap_or_default();
    if !items.starts_with(old_items) {
        return Ok(ChangeKind::Unknown);
    }
    let mut kind = None;
    for item in items.get(old_items.len()..).unwrap_or_default() {
        let found = annotation_kind(item, new)?;
        if kind.is_some_and(|previous| previous != found) {
            return Ok(ChangeKind::Unknown);
        }
        kind = Some(found);
    }
    Ok(kind.unwrap_or(ChangeKind::Unknown))
}

fn classify(
    before: Option<&Object>,
    after: &Object,
    roles: u16,
    signature_field: bool,
    old: &Graph<'_, '_>,
    new: &Graph<'_, '_>,
) -> Outcome<ChangeKind> {
    if roles & PAGE_DATA != 0 {
        return Ok(ChangeKind::PageContent);
    }
    if roles == ANNOTATIONS && after.as_array().is_some() {
        return annotation_changes(before, after, old, new);
    }
    let Some(dict) = after.as_dict() else {
        return Ok(match roles {
            APPEARANCE => ChangeKind::WidgetAppearance,
            DSS => ChangeKind::Dss,
            FORM_FIELDS if after.as_array().is_some() => ChangeKind::AcroForm,
            _ => ChangeKind::Unknown,
        });
    };
    let old_dict = before.and_then(Object::as_dict);
    let keys = changed_keys(old_dict, dict);
    if roles == PAGE {
        if keys.contains(&b"Contents".as_slice()) || keys.contains(&b"Resources".as_slice()) {
            return Ok(ChangeKind::PageContent);
        }
        if recognized(&keys, &[b"Annots"])
            && let Some(annots) = dict.get(b"Annots")
        {
            return annotation_changes(
                old_dict.and_then(|value| value.get(b"Annots")),
                annots,
                old,
                new,
            );
        }
    }
    if matches!(roles, FIELD | FIELD_WIDGET)
        && !signature_field
        && before.is_some()
        && recognized(&keys, &[b"V", b"AS", b"AP", b"I", b"TI"])
    {
        return Ok(ChangeKind::FormValue);
    }
    if roles == CATALOG {
        return Ok(classify_catalog(old_dict, dict, &keys));
    }
    if let Some(kind) = signature_kind(dict)
        && roles == SIGNATURE
        && recognized(
            &keys,
            &[
                b"Type",
                b"Filter",
                b"SubFilter",
                b"ByteRange",
                b"Contents",
                b"M",
                b"Reason",
                b"Location",
                b"ContactInfo",
                b"Name",
                b"Reference",
                b"Cert",
                b"Prop_Build",
                b"Prop_AuthTime",
                b"Prop_AuthType",
            ],
        )
    {
        return Ok(kind);
    }
    Ok(classify_role(dict, &keys, roles, signature_field))
}

fn classify_catalog(before: Option<&Dict>, after: &Dict, keys: &[&[u8]]) -> ChangeKind {
    if keys.contains(&b"Pages".as_slice()) {
        return ChangeKind::CatalogOther;
    }
    if keys.contains(&b"AcroForm".as_slice()) && recognized(keys, &[b"AcroForm", b"Perms"]) {
        let form_keys = if let Some(Object::Dict(form)) = after.get(b"AcroForm") {
            changed_keys(
                before
                    .and_then(|dict| dict.get(b"AcroForm"))
                    .and_then(Object::as_dict),
                form,
            )
        } else {
            Vec::new()
        };
        if recognized(&form_keys, &[b"Fields", b"SigFlags"]) && valid_permissions(before, after) {
            return ChangeKind::AcroForm;
        }
    }
    if keys.contains(&b"Perms".as_slice())
        && recognized(keys, &[b"Perms"])
        && valid_permissions(before, after)
    {
        return ChangeKind::Signature;
    }
    if keys.contains(&b"DSS".as_slice()) && recognized(keys, &[b"DSS"]) {
        return ChangeKind::Dss;
    }
    ChangeKind::CatalogOther
}

fn valid_permissions(before: Option<&Dict>, after: &Dict) -> bool {
    let previous = before.and_then(|dict| dict.get(b"Perms"));
    let current = after.get(b"Perms");
    if previous == current {
        return true;
    }
    current.and_then(Object::as_dict).is_some_and(|dict| {
        recognized(
            &changed_keys(previous.and_then(Object::as_dict), dict),
            &[b"DocMDP"],
        )
    })
}

fn classify_role(dict: &Dict, keys: &[&[u8]], roles: u16, signature_field: bool) -> ChangeKind {
    match roles {
        FIELD | FIELD_WIDGET
            if signature_field
                && recognized(
                    keys,
                    &[
                        b"Type", b"Subtype", b"FT", b"T", b"Kids", b"Parent", b"V", b"F", b"P",
                        b"Rect", b"AP", b"Ff", b"Lock", b"TU", b"TM", b"SV", b"MK", b"BS",
                        b"Border", b"AS",
                    ],
                ) =>
        {
            ChangeKind::SignatureField
        }
        FORM if recognized(keys, &[b"Fields", b"SigFlags"]) => ChangeKind::AcroForm,
        APPEARANCE => ChangeKind::WidgetAppearance,
        DSS => ChangeKind::Dss,
        PERMISSIONS if recognized(keys, &[b"DocMDP"]) => ChangeKind::Signature,
        ANNOTATION
            if dict
                .get(b"Subtype")
                .and_then(Object::as_name)
                .is_some_and(|name| name != b"Widget") =>
        {
            ChangeKind::Annotation
        }
        _ => ChangeKind::Unknown,
    }
}

fn permanent_id(trailer: &Dict) -> Option<&Object> {
    trailer.get(b"ID")?.as_array()?.first()
}

fn page_dependencies_changed(old: &[Page], new: &[Page]) -> bool {
    old.len() != new.len()
        || old.iter().zip(new).any(|(before, after)| {
            before.resources_ref != after.resources_ref
                || before.resources != after.resources
                || before.dict.get(b"Contents") != after.dict.get(b"Contents")
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
#[expect(
    clippy::module_name_repetitions,
    reason = "the internal ABI retains the existing PDF operation names"
)]
pub fn revision_changes(pdf: &[u8], from: usize, limits: &Limits) -> Outcome<RevisionChanges> {
    let index = revision_index(pdf)?;
    let terminal = index
        .structure
        .terminal_for_range(pdf, from)
        .ok_or_else(|| {
            Failure::request("fromRevisionEnd does not identify a complete PDF revision")
        })?;
    let from_revision_index = index
        .structure
        .terminals
        .iter()
        .position(|candidate| candidate.eof_end == terminal.eof_end)
        .ok_or_else(|| Failure::invalid("missing PDF revision terminal"))?;
    let signed = Document::open(pdf.get(..from).unwrap_or_default(), limits)?;
    let mut result = RevisionChanges {
        changes: Vec::new(),
        from_revision_index,
        page_content_changed: false,
        policies: signature_policies(&signed, &index)?,
    };
    for pair in index.structure.terminals.windows(2) {
        let [previous, current] = pair else { continue };
        if current.eof_end <= from {
            continue;
        }
        let previous_end = previous.end(index.pdf);
        let revision_end = current.end(index.pdf);
        let old = Document::open(pdf.get(..previous_end).unwrap_or_default(), limits)?;
        let new = Document::open(pdf.get(..revision_end).unwrap_or_default(), limits)?;
        let previous_entries = index.entries(*previous)?;
        let current_entries = index.entries(*current)?;
        let comparison = Pair {
            current: &current_entries,
            previous: &previous_entries,
            index: &index,
            new: Graph::read(&new)?,
            old: Graph::read(&old)?,
            revision_end,
        };
        comparison.collect(&mut result)?;
        if result.changes.len() > MAX_REVISION_WORK {
            return Err(Failure::limit("too many PDF revision changes"));
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::failure::FailureCode;
    use crate::syntax::Parser;
    use crate::test_pdf::{build, document, page};
    use crate::write::{Body, Changes, incremental};

    #[test]
    fn identifies_timestamps_dss_annotations_and_inherited_page_resources() {
        let limits = Limits::default();
        let pdf = build(&[
            (1, "<< /Type /Catalog /Pages 2 0 R >>".to_owned()),
            (
                2,
                "<< /Type /Pages /Kids [3 0 R] /Count 1 /Resources << >> >>".to_owned(),
            ),
            (
                3,
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>".to_owned(),
            ),
        ]);
        let base = Document::open(&pdf, &limits).unwrap();
        let mut updates = Changes::default();
        for (number, syntax) in [
            (
                1,
                "<< /Type /Catalog /Pages 2 0 R /DSS 4 0 R /AcroForm << /Fields [7 0 R] /SigFlags 3 >> >>",
            ),
            (
                2,
                "<< /Type /Pages /Kids [3 0 R] /Count 1 /Resources << /Font << /F1 10 0 R >> >> >>",
            ),
            (
                3,
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Annots [11 0 R] >>",
            ),
            (4, "<< /Type /DSS /VRI 5 0 R >>"),
            (5, "<< /123456 6 0 R >>"),
            (6, "<< /Cert [9 0 R] >>"),
            (7, "<< /T (Timestamp) /FT /Sig /V 8 0 R >>"),
            (
                8,
                "<< /Type /DocTimeStamp /SubFilter /ETSI.RFC3161 /ByteRange [0 0 0 0] /Contents <00> >>",
            ),
            (9, "<ABCD>"),
            (10, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
            (
                11,
                "<< /Type /Annot /Subtype /Text /Rect [10 10 20 20] /Contents (Note) >>",
            ),
        ] {
            let object = Parser::new(syntax.as_bytes(), 0, 32, true)
                .parse_object()
                .unwrap();
            updates.insert(
                number,
                Body {
                    data: None,
                    generation: 0,
                    object,
                },
            );
        }
        let output = incremental(&base, &updates).unwrap();
        let report = revision_changes(&output, pdf.len(), &limits).unwrap();
        assert!(report.page_content_changed);
        for (number, kind) in [
            (1, ChangeKind::CatalogOther),
            (3, ChangeKind::Annotation),
            (4, ChangeKind::Dss),
            (5, ChangeKind::Dss),
            (6, ChangeKind::Dss),
            (7, ChangeKind::SignatureField),
            (8, ChangeKind::DocTimeStamp),
            (9, ChangeKind::Dss),
            (10, ChangeKind::PageContent),
            (11, ChangeKind::Annotation),
        ] {
            let found = report
                .changes
                .iter()
                .find(|change| change.reference.number == number)
                .unwrap();
            assert_eq!(found.kind, kind, "object {number}");
        }
    }

    #[test]
    fn finds_intermediate_page_changes_and_unclassified_added_objects() {
        let limits = Limits::default();
        let pdf = document(&[page("q Q".to_owned())], &[]);
        let first = Document::open(&pdf, &limits).unwrap();
        let mut changes = Changes::default();
        let contents = first
            .load(ObjRef {
                number: 11,
                generation: 0,
            })
            .unwrap();
        changes.insert(
            11,
            Body {
                data: Some(b"q 0 0 20 10 re f Q".to_vec()),
                object: (*contents).clone(),
                generation: 0,
            },
        );
        changes.insert(
            12,
            Body {
                data: None,
                object: Object::Integer(42),
                generation: 0,
            },
        );
        let second = incremental(&first, &changes).unwrap();
        let updated = Document::open(&second, &limits).unwrap();
        let mut other = Changes::default();
        other.insert(
            12,
            Body {
                data: None,
                object: Object::Integer(43),
                generation: 0,
            },
        );
        let third = incremental(&updated, &other).unwrap();
        let result = revision_changes(&third, pdf.len(), &limits).unwrap();
        assert!(result.page_content_changed);
        assert_eq!(result.changes.len(), 3);
        assert!(
            result
                .changes
                .iter()
                .any(|change| change.reference.number == 11
                    && change.kind == ChangeKind::PageContent)
        );
        assert!(
            result
                .changes
                .iter()
                .any(|change| change.reference.number == 12
                    && change.kind == ChangeKind::Unknown
                    && change.added
                    && change.revision_end == second.len())
        );
        assert!(
            !revision_changes(&third, second.len(), &limits)
                .unwrap()
                .page_content_changed
        );
        assert_eq!(
            revision_changes(&third, 100, &limits).unwrap_err().code,
            FailureCode::InvalidRequest
        );
        assert_eq!(
            revision_changes(&third, third.len(), &limits)
                .unwrap()
                .changes,
            Vec::<Change>::new()
        );
    }
}
