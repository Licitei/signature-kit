use crate::inspection::LinkInfo;
use crate::layout::Band;
use crate::num::{fold_string, sort_total};
use crate::table::{Table, render_markdown};

const WORD_GAP: f64 = 0.12;
const SPACE_EM: f64 = 0.28;
const FLOW_GAP: f64 = 3.0;
const PARAGRAPH_GAP: f64 = 1.45;
const SIZE_STEP: f64 = 0.15;
const INDENT_EM: f64 = 1.0;
const FIT_SLACK: f64 = 0.2;
const LIST_TOLERANCE: f64 = 0.5;
const HEADING_RATIO: f64 = 1.15;
const TITLE_RATIO: f64 = 1.6;
const HEADING_CHARS: usize = 120;
const SHORT_HEADING_CHARS: usize = 80;
const HEADING_LINES: usize = 2;
const MAX_HEADING_LEVEL: usize = 6;
const DEFAULT_BODY: f64 = 10.0;
const DEFAULT_PITCH: f64 = 1.2;
const FLOW_SAMPLES: usize = 3;
const BAND_GAP: f64 = 1.15;
const STYLE_SAMPLE: usize = 500;
const STRAY_BLOCKS: usize = 3;
const STRAY_CHARS: usize = 120;
const NOTE_SIZE: f64 = 0.91;
const MARGINAL_SIZE: f64 = 0.9;
const HEAD_SCAN: usize = 8;
const COMPOUND_LETTERS: usize = 4;
const SHAPE_LENGTHS: usize = 63;
const SHAPE_WORDS: usize = 32;
const SCRIPT_RATIO: f64 = 0.8;
const MARKER_CHARS: usize = 3;
const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0100_0000_01b3;
const CAPTIONS: [&str; 8] = [
    "table",
    "figure",
    "fig.",
    "tabela",
    "figura",
    "quadro",
    "gr\u{e1}fico",
    "listing",
];
const NOTE_MARKS: [char; 6] = ['*', '\u{2217}', '\u{2020}', '\u{2021}', '\u{a7}', '\u{b6}'];

const BULLETS: [char; 22] = [
    '\u{2022}', '\u{25cf}', '\u{25aa}', '\u{25a0}', '\u{25e6}', '\u{25cb}', '\u{25b8}', '\u{25ba}',
    '\u{27a2}', '\u{27a4}', '\u{2713}', '\u{2714}', '\u{b7}', '\u{2023}', '\u{2043}', '*',
    '\u{f0a7}', '\u{f0b7}', '\u{f0d8}', '\u{f076}', '\u{f0fc}', '\u{f06e}',
];
const DASHES: [char; 3] = ['-', '\u{2013}', '\u{2014}'];
const ROMAN: [char; 5] = ['I', 'V', 'X', 'L', 'C'];
const CLITICS: [&str; 20] = [
    "lo", "la", "los", "las", "se", "me", "te", "nos", "vos", "lhe", "lhes", "o", "a", "os", "as",
    "no", "na", "nas", "mo", "ma",
];
const PREFIXES: [&str; 14] = [
    "ex",
    "vice",
    "pr\u{e9}",
    "p\u{f3}s",
    "pr\u{f3}",
    "rec\u{e9}m",
    "al\u{e9}m",
    "aqu\u{e9}m",
    "sem",
    "bem",
    "gr\u{e3}",
    "gr\u{e3}o",
    "sota",
    "soto",
];
const WEEKDAY_TAILS: [&str; 2] = ["feira", "feiras"];
const FUNCTION_WORDS: [&str; 34] = [
    "de",
    "da",
    "do",
    "das",
    "dos",
    "e",
    "em",
    "no",
    "na",
    "nos",
    "nas",
    "para",
    "por",
    "pelo",
    "pela",
    "pelos",
    "pelas",
    "com",
    "sem",
    "ao",
    "aos",
    "\u{e0}",
    "\u{e0}s",
    "um",
    "uma",
    "que",
    "ou",
    "sob",
    "sobre",
    "entre",
    "at\u{e9}",
    "ap\u{f3}s",
    "the",
    "of",
];

const LINK_TRAILERS: [char; 4] = ['.', ',', ';', ')'];

#[derive(Clone, Debug)]
pub(crate) struct MdRun {
    pub bold: bool,
    pub italic: bool,
    pub link: Option<usize>,
    pub size: f64,
    pub text: String,
    pub x0: f64,
    pub x1: f64,
}

#[derive(Clone, Debug)]
pub(crate) struct MdLine {
    pub band: Band,
    pub center: f64,
    pub runs: Vec<MdRun>,
    pub size: f64,
    pub x0: f64,
    pub x1: f64,
}

#[derive(Clone, Debug)]
pub(crate) enum MdItem {
    Break,
    Line(MdLine),
    Table { band: Band, index: usize, top: f64 },
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Span {
    bold: bool,
    italic: bool,
    link: Option<usize>,
    text: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Family {
    Bullet,
    Labeled,
    Ordered,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Kind {
    Heading(usize),
    Item {
        indent: usize,
        marker: String,
        tight: bool,
    },
    Paragraph,
    Table(usize),
}

#[derive(Clone, Debug)]
pub(crate) struct MdBlock {
    band: Band,
    kind: Kind,
    lines: usize,
    plain: String,
    size: f64,
    spans: Vec<Span>,
    top: f64,
    typical: f64,
}

impl MdBlock {
    pub(crate) const fn band(&self) -> Band {
        self.band
    }

    pub(crate) fn plain(&self) -> &str {
        &self.plain
    }

    pub(crate) const fn table_index(&self) -> Option<usize> {
        if let Kind::Table(index) = self.kind {
            return Some(index);
        }
        None
    }

    pub(crate) const fn top(&self) -> f64 {
        self.top
    }

    pub(crate) fn update_table(&mut self, table: &Table) {
        self.plain = render_markdown(table);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LeadKind {
    Bullet,
    Clause(usize),
    Dash,
    Labeled,
    Ordered,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Lead {
    kind: LeadKind,
    label: String,
    len: usize,
}

struct Prepared<'data> {
    content_x: f64,
    lead: Option<Lead>,
    line: &'data MdLine,
    plain: String,
    spans: Vec<Span>,
    typical: f64,
    weight: usize,
}

#[derive(Clone, Copy)]
struct Flow {
    id: usize,
    left: f64,
    pitch: f64,
    right: f64,
}

struct Para {
    band: Band,
    content_x: f64,
    lead: Option<Lead>,
    lines: usize,
    plain: String,
    size: f64,
    sizes: Vec<(f64, usize)>,
    spans: Vec<Span>,
    top: f64,
    x0: f64,
}

#[derive(Clone, Copy)]
struct Level {
    content: f64,
    family: Family,
    indent: usize,
    width: usize,
    x0: f64,
}

#[derive(Default)]
struct ListState {
    open: bool,
    stack: Vec<Level>,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Metrics {
    body: f64,
    bold_body: bool,
    italic_body: bool,
    pitch: f64,
}

enum Glue {
    Direct,
    DropLast,
    Space,
}

#[derive(Debug, Default)]
pub(crate) struct Words {
    repeated: Vec<u64>,
    seen: Vec<u64>,
}

impl Words {
    pub(crate) fn collect<'data>(pages: impl IntoIterator<Item = &'data [MdItem]> + Clone) -> Self {
        let mut words = Self::default();
        let mut wanted: Vec<u64> = Vec::new();
        let mut shapes = [0_u64; SHAPE_WORDS];
        let mut pending: Option<&str> = None;
        for line in md_lines(pages.clone()) {
            if let Some(left) = pending.take() {
                let right = line
                    .runs
                    .iter()
                    .flat_map(|run| run.text.split_ascii_whitespace())
                    .next()
                    .map(word_core)
                    .unwrap_or_default();
                for parts in [&[left, right][..], &[left, "-", right], &[left], &[right]] {
                    wanted.push(word_hash(parts));
                    let length = parts
                        .iter()
                        .fold(0_usize, |sum, part| sum.saturating_add(part.len()));
                    let lead = parts.iter().find_map(|part| part.bytes().next());
                    let bit = shape(length, lead);
                    if let Some(slot) = shapes.get_mut(bit >> 6_u32) {
                        *slot |= 1_u64 << (bit & 63);
                    }
                }
            }
            pending = line
                .runs
                .last()
                .and_then(|run| run.text.split_ascii_whitespace().next_back())
                .filter(|token| hyphen_end(token))
                .map(word_core);
        }
        if wanted.is_empty() {
            return words;
        }
        sort_total(&mut wanted, &Ord::cmp);
        wanted.dedup();
        for line in md_lines(pages) {
            let last = line.runs.len().saturating_sub(1);
            for (position, run) in line.runs.iter().enumerate() {
                let mut tokens = run.text.split_ascii_whitespace().peekable();
                while let Some(token) = tokens.next() {
                    if position == last
                        && tokens.peek().is_none()
                        && token.ends_with(['-', '\u{ad}'])
                    {
                        continue;
                    }
                    let core = word_core(token);
                    let bit = shape(core.len(), core.bytes().next());
                    let fits_length = shapes
                        .get(bit >> 6_u32)
                        .is_some_and(|slot| slot & (1_u64 << (bit & 63)) != 0);
                    if !fits_length {
                        continue;
                    }
                    let hash = word_hash(&[core]);
                    if wanted.binary_search(&hash).is_ok()
                        && core.len() >= 2
                        && core.chars().all(|ch| ch.is_alphabetic() || ch == '-')
                    {
                        words.seen.push(hash);
                    }
                }
            }
        }
        sort_total(&mut words.seen, &Ord::cmp);
        for pair in words.seen.windows(2) {
            if let [first, second] = pair
                && first == second
                && words.repeated.last() != Some(first)
            {
                words.repeated.push(*first);
            }
        }
        words.seen.dedup();
        words
    }

    fn contains(list: &[u64], hash: u64) -> bool {
        list.binary_search(&hash).is_ok()
    }

    fn verdict(&self, left: &str, right: &str) -> Option<bool> {
        if self.seen.is_empty() {
            return None;
        }
        if Self::contains(&self.seen, word_hash(&[left, right])) {
            return Some(true);
        }
        let whole = |part: &str| {
            part.chars().count() >= COMPOUND_LETTERS
                && Self::contains(&self.repeated, word_hash(&[part]))
        };
        (Self::contains(&self.seen, word_hash(&[left, "-", right]))
            || (whole(left) && whole(right)))
        .then_some(false)
    }
}

impl ListState {
    fn place(&mut self, para: &Para, family: Family, marker: &str) -> (usize, bool) {
        let tolerance = LIST_TOLERANCE * para.size;
        let (x0, content) = (para.x0, para.content_x);
        if !self.open {
            self.stack.clear();
        }
        let aligned = |top: &Level| {
            (top.x0 - x0).abs() <= tolerance
                || (top.family == family && (top.content - content).abs() <= tolerance)
        };
        while self
            .stack
            .last()
            .is_some_and(|top| !aligned(top) && top.x0 > x0 + tolerance)
        {
            let _: Option<Level> = self.stack.pop();
        }
        let width = marker.chars().count().saturating_add(1);
        let (indent, restart) = match self.stack.last().copied() {
            Some(top) if aligned(&top) || content <= top.content + tolerance => {
                let _: Option<Level> = self.stack.pop();
                (top.indent, top.family != family && self.stack.is_empty())
            }
            Some(top) => (top.indent.saturating_add(top.width), false),
            None => (0, false),
        };
        self.stack.push(Level {
            content,
            family,
            indent,
            width,
            x0,
        });
        let tight = self.open && !restart;
        self.open = true;
        (indent, tight)
    }
}

fn word_hash(parts: &[&str]) -> u64 {
    let mut hash = FNV_OFFSET;
    for byte in parts.iter().flat_map(|part| part.bytes()) {
        hash ^= u64::from(byte.to_ascii_lowercase());
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

fn shape(length: usize, lead: Option<u8>) -> usize {
    let letter = lead.map_or(0, |byte| usize::from(byte.to_ascii_lowercase() & 31));
    (length.min(SHAPE_LENGTHS) << 5_u32) | letter
}

fn md_lines<'data>(
    pages: impl IntoIterator<Item = &'data [MdItem]>,
) -> impl Iterator<Item = &'data MdLine> {
    pages.into_iter().flatten().filter_map(|item| match item {
        MdItem::Line(line) => Some(line),
        MdItem::Break | MdItem::Table { .. } => None,
    })
}

fn word_core(token: &str) -> &str {
    token.trim_matches(|ch: char| !ch.is_alphabetic())
}

fn line_gap(above: &MdLine, below: &MdLine) -> Option<f64> {
    let gap = above.center - below.center;
    let size = above.size.max(below.size);
    (near_size(above.size, below.size)
        && gap > 0.3 * size
        && gap <= FLOW_GAP * size
        && below.x0 < above.x1
        && below.x1 > above.x0)
        .then(|| gap / size)
}

pub(crate) fn document_metrics<'data>(pages: impl IntoIterator<Item = &'data [MdItem]>) -> Metrics {
    let mut weighted: Vec<(f64, usize)> = Vec::new();
    let mut ratios: Vec<f64> = Vec::new();
    let mut styled = [0_usize; 3];
    for items in pages {
        let mut above: Option<&MdLine> = None;
        for item in items {
            let MdItem::Line(line) = item else {
                above = None;
                continue;
            };
            if let Some(ratio) = above.and_then(|before| line_gap(before, line)) {
                ratios.push(ratio);
            }
            above = Some(line);
            let mut chars = 0_usize;
            for run in &line.runs {
                let count = run.text.len();
                chars = chars.saturating_add(count);
                for (slot, flag) in styled.iter_mut().zip([true, run.bold, run.italic]) {
                    if flag {
                        *slot = slot.saturating_add(count);
                    }
                }
            }
            weighted.push((line.size, chars));
        }
    }
    sort_total(&mut ratios, &f64::total_cmp);
    let pitch = ratios
        .get(ratios.len().checked_div(4).unwrap_or(0))
        .copied()
        .unwrap_or(DEFAULT_PITCH);
    let [total, bold, italic] = styled;
    let dominant =
        |count: usize| total >= STYLE_SAMPLE && count.saturating_mul(10) > total.saturating_mul(6);
    Metrics {
        body: body_size(weighted),
        pitch,
        bold_body: dominant(bold),
        italic_body: dominant(italic),
    }
}

pub(crate) fn body_size(mut weighted: Vec<(f64, usize)>) -> f64 {
    sort_total(&mut weighted, &|left, right| left.0.total_cmp(&right.0));
    let total = weighted
        .iter()
        .map(|entry| entry.1)
        .fold(0_usize, usize::saturating_add);
    let half = total.div_ceil(2);
    let mut seen = 0_usize;
    for (size, chars) in weighted {
        seen = seen.saturating_add(chars);
        if seen >= half && seen > 0 {
            return size;
        }
    }
    DEFAULT_BODY
}

fn note_marker(line: &MdLine) -> bool {
    let (Some(first), Some(second)) = (line.runs.first(), line.runs.get(1)) else {
        return false;
    };
    let mark = first.text.trim();
    let count = mark.chars().count();
    first.size <= SCRIPT_RATIO * second.size
        && (1..=MARKER_CHARS).contains(&count)
        && mark
            .chars()
            .all(|ch| ch.is_ascii_digit() || NOTE_MARKS.contains(&ch))
        && second
            .text
            .trim_start()
            .chars()
            .next()
            .is_some_and(char::is_alphabetic)
}

fn line_spans(line: &MdLine) -> Vec<Span> {
    let mut spans: Vec<Span> = Vec::with_capacity(line.runs.len());
    let mut edge: Option<f64> = None;
    let marked = note_marker(line);
    for (position, run) in line.runs.iter().enumerate() {
        if let (Some(right), Some(last)) = (edge, spans.last_mut()) {
            let boundary = last.text.ends_with(char::is_whitespace)
                || run.text.starts_with(char::is_whitespace);
            let gapped = run.x0 - right > WORD_GAP * run.size || (marked && position == 1);
            if gapped && !boundary {
                last.text.push(' ');
            }
        }
        match spans.last_mut() {
            Some(last)
                if (last.bold, last.italic, last.link) == (run.bold, run.italic, run.link) =>
            {
                last.text.push_str(&run.text);
            }
            _ => spans.push(Span {
                text: run.text.clone(),
                bold: run.bold,
                italic: run.italic,
                link: run.link,
            }),
        }
        edge = Some(edge.map_or(run.x1, |right| right.max(run.x1)));
    }
    spans
}

fn x_after(line: &MdLine, chars: usize) -> f64 {
    let mut remaining = chars;
    for run in &line.runs {
        if remaining == 0 && !run.text.is_empty() {
            return run.x0;
        }
        let count = run.text.chars().count();
        if remaining < count {
            let share = f64::from(u32::try_from(remaining).unwrap_or(u32::MAX))
                / f64::from(u32::try_from(count.max(1)).unwrap_or(u32::MAX));
            return run.x0 + (run.x1 - run.x0) * share;
        }
        remaining = remaining.saturating_sub(count);
    }
    line.x1
}

fn concat(spans: &[Span]) -> String {
    let mut out = String::with_capacity(spans.iter().map(|span| span.text.len()).sum());
    for span in spans {
        out.push_str(&span.text);
    }
    out
}

fn skip_space(text: &str, from: usize) -> Option<usize> {
    let rest = text.get(from..)?;
    let trimmed = rest.trim_start();
    if trimmed.is_empty() || trimmed.len() == rest.len() {
        return None;
    }
    Some(from.saturating_add(rest.len().saturating_sub(trimmed.len())))
}

fn numbered_lead(text: &str) -> Option<(LeadKind, usize)> {
    let bytes = text.as_bytes();
    let mut index = 0_usize;
    let mut groups = 0_usize;
    let mut first_digits = 0_usize;
    loop {
        let start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index = index.saturating_add(1);
        }
        let digits = index.saturating_sub(start);
        if digits == 0 || digits > 3 {
            return None;
        }
        if groups == 0 {
            first_digits = digits;
        }
        groups = groups.saturating_add(1);
        match bytes.get(index) {
            Some(b'.')
                if bytes
                    .get(index.saturating_add(1))
                    .is_some_and(u8::is_ascii_digit) =>
            {
                index = index.saturating_add(1);
            }
            _ => break,
        }
    }
    let after = match bytes.get(index) {
        Some(b'.' | b')') => index.saturating_add(1),
        _ if groups >= 2 => index,
        _ => {
            let spaced = skip_space(text, index)?;
            return matches!(text.get(spaced..)?.chars().next(), Some('-' | '–' | '—'))
                .then(|| {
                    skip_space(text, spaced.saturating_add(1)).map(|end| (LeadKind::Labeled, end))
                })
                .flatten();
        }
    };
    let end = skip_space(text, after)?;
    if groups >= 2 {
        return Some((LeadKind::Clause(groups), end));
    }
    let ordered =
        first_digits > 0 && bytes.get(index) == Some(&b'.') || bytes.get(index) == Some(&b')');
    ordered.then_some((LeadKind::Ordered, end))
}

fn lettered_lead(text: &str) -> Option<(LeadKind, usize)> {
    let mut chars = text.char_indices();
    let (_, first) = chars.next()?;
    let (letter_at, letter) = if first == '(' {
        chars.next()?
    } else {
        (0, first)
    };
    if !letter.is_ascii_alphabetic() {
        return None;
    }
    let (close_at, close) = chars.next()?;
    if close != ')' || letter_at > 1 {
        return None;
    }
    let end = skip_space(text, close_at.saturating_add(1))?;
    Some((LeadKind::Labeled, end))
}

fn roman_lead(text: &str) -> Option<(LeadKind, usize)> {
    let numerals = text.chars().take_while(|ch| ROMAN.contains(ch)).count();
    if numerals == 0 || numerals > 6 {
        return None;
    }
    let mut at = numerals;
    if text.get(at..)?.starts_with(' ') {
        at = at.saturating_add(1);
    }
    let rest = text.get(at..)?;
    let mark = rest.chars().next()?;
    if !matches!(mark, '-' | '–' | '—' | ')' | '.') {
        return None;
    }
    if mark == '.' && at != numerals {
        return None;
    }
    let end = skip_space(text, at.saturating_add(mark.len_utf8()))?;
    Some((LeadKind::Labeled, end))
}

fn lead(plain: &str) -> Option<Lead> {
    let text = plain.trim_start();
    let skipped = plain.len().saturating_sub(text.len());
    let first = text.chars().next()?;
    let found = if BULLETS.contains(&first) {
        let after = first.len_utf8();
        let rest = text.get(after..)?;
        if rest.trim().is_empty() {
            return None;
        }
        Some((
            LeadKind::Bullet,
            after.saturating_add(rest.len().saturating_sub(rest.trim_start().len())),
        ))
    } else if DASHES.contains(&first) {
        skip_space(text, first.len_utf8()).map(|end| (LeadKind::Dash, end))
    } else if first == '\u{a7}' {
        Some((LeadKind::Clause(1), 0))
    } else if first.is_ascii_digit() {
        numbered_lead(text)
    } else if text.starts_with("Art. ") {
        Some((LeadKind::Clause(1), 0))
    } else {
        lettered_lead(text).or_else(|| roman_lead(text))
    };
    let (kind, end) = found?;
    let label = match kind {
        LeadKind::Ordered | LeadKind::Labeled => text.get(..end)?.trim_end().to_owned(),
        LeadKind::Bullet | LeadKind::Dash | LeadKind::Clause(_) => String::new(),
    };
    let len = match kind {
        LeadKind::Clause(_) => 0,
        LeadKind::Bullet | LeadKind::Dash | LeadKind::Ordered | LeadKind::Labeled => {
            skipped.saturating_add(end)
        }
    };
    Some(Lead { kind, label, len })
}

const fn lead_family(kind: LeadKind) -> Option<Family> {
    match kind {
        LeadKind::Bullet | LeadKind::Dash => Some(Family::Bullet),
        LeadKind::Ordered => Some(Family::Ordered),
        LeadKind::Labeled => Some(Family::Labeled),
        LeadKind::Clause(_) => None,
    }
}

fn last_char(text: &str) -> Option<char> {
    text.trim_end()
        .trim_end_matches(['"', '\u{201d}', '\'', '\u{2019}', ')', ']', '*'])
        .chars()
        .next_back()
}

fn ends_terminal(text: &str) -> bool {
    let trimmed = text.trim_end();
    if trimmed.ends_with(['?', '&']) && url_word(left_word(trimmed)) {
        return false;
    }
    last_char(text).is_some_and(|ch| matches!(ch, '.' | '!' | '?' | ':' | ';'))
}

fn url_word(word: &str) -> bool {
    let trimmed_word = word.trim_start_matches(['(', '<', '[']);
    trimmed_word.starts_with("http://")
        || trimmed_word.starts_with("https://")
        || trimmed_word.starts_with("www.")
}

const fn url_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric()
        || matches!(
            ch,
            '/' | '.' | '-' | '_' | '~' | '?' | '&' | '=' | '#' | '%' | '+' | ':' | '@'
        )
}

fn url_continues(left: &str, right: &str) -> bool {
    let word = left_word(left);
    if !url_word(word) {
        return false;
    }
    let next = right
        .split(char::is_whitespace)
        .next()
        .unwrap_or_default()
        .trim_end_matches(LINK_TRAILERS);
    let mut chars = next.chars();
    let (Some(first), Some(_)) = (chars.next(), chars.next()) else {
        return false;
    };
    if !next.chars().all(url_char) {
        return false;
    }
    if matches!(first, '/' | '?' | '&' | '=' | '#' | '%') {
        return true;
    }
    match word.chars().next_back() {
        Some('?' | '&' | '=' | '_' | '#' | '%') => first.is_ascii_alphanumeric(),
        Some('/') => next
            .chars()
            .any(|ch| matches!(ch, '/' | '.' | '=' | '&' | '?' | '_' | '-')),
        _ => false,
    }
}

fn trailer_cut(text: &str) -> usize {
    let mut kept = text.trim_end_matches(LINK_TRAILERS);
    if text.len() > kept.len()
        && text
            .get(kept.len()..)
            .is_some_and(|tail| tail.starts_with(')'))
        && kept.contains('(')
    {
        kept = text.get(..kept.len().saturating_add(1)).unwrap_or(kept);
    }
    kept.len()
}

fn starts_lower(text: &str) -> bool {
    text.trim_start()
        .chars()
        .next()
        .is_some_and(char::is_lowercase)
}

fn hyphen_end(text: &str) -> bool {
    let trimmed = text.trim_end();
    trimmed
        .strip_suffix('-')
        .or_else(|| trimmed.strip_suffix('\u{ad}'))
        .and_then(|stem| stem.chars().next_back())
        .is_some_and(char::is_alphanumeric)
}

fn evident(previous: &str, next: &str) -> bool {
    starts_lower(next) || hyphen_end(previous)
}

fn strong_continuation(previous: &str, next: &str) -> bool {
    if ends_terminal(previous) {
        return false;
    }
    let next_alnum = next
        .trim_start()
        .chars()
        .next()
        .is_some_and(char::is_alphanumeric);
    starts_lower(next)
        || (hyphen_end(previous) && next_alnum)
        || previous.trim_end().ends_with(',')
        || (next_alnum
            && FUNCTION_WORDS.contains(&fold_string(left_word(previous.trim_end())).as_str()))
}

fn first_word_width(line: &Prepared<'_>) -> f64 {
    let Some(run) = line.line.runs.first() else {
        return 0.0;
    };
    let total = run.text.chars().count().max(1);
    let word = line
        .plain
        .trim_start()
        .chars()
        .take_while(|ch| !ch.is_whitespace())
        .count();
    let share = f64::from(u32::try_from(word.min(total)).unwrap_or(u32::MAX))
        / f64::from(u32::try_from(total).unwrap_or(u32::MAX));
    (run.x1 - run.x0) * share
}

fn word_fits(previous: &Prepared<'_>, next: &Prepared<'_>, flow: Flow) -> bool {
    let size = next.line.size;
    previous.line.x1 + SPACE_EM * size + first_word_width(next) <= flow.right - FIT_SLACK * size
}

fn near_size(first: f64, second: f64) -> bool {
    (first - second).abs() <= SIZE_STEP * first.max(second)
}

fn mostly_uppercase(text: &str) -> bool {
    let mut letters = 0_usize;
    let mut upper = 0_usize;
    for ch in text.chars().filter(|ch| ch.is_alphabetic()) {
        letters = letters.saturating_add(1);
        if ch.is_uppercase() {
            upper = upper.saturating_add(1);
        }
    }
    letters >= 4 && upper.saturating_mul(10) >= letters.saturating_mul(9)
}

fn all_bold(spans: &[Span]) -> bool {
    let mut any = false;
    for span in spans {
        if span.text.chars().any(char::is_alphanumeric) {
            if !span.bold {
                return false;
            }
            any = true;
        }
    }
    any
}

fn linked(spans: &[Span]) -> bool {
    spans
        .iter()
        .filter(|span| span.text.chars().any(char::is_alphanumeric))
        .all(|span| span.link.is_some())
}

fn emphatic(line: &Prepared<'_>) -> bool {
    let chars = line.plain.trim().chars().count();
    chars > 0 && chars <= HEADING_CHARS && (all_bold(&line.spans) || mostly_uppercase(&line.plain))
}

fn compute_flows(lines: &[Option<Prepared<'_>>], metrics: Metrics) -> Vec<Flow> {
    let mut flows: Vec<Flow> = Vec::with_capacity(lines.len());
    let mut previous: Option<&Prepared<'_>> = None;
    for line in lines {
        let Some(line_next) = line else {
            previous = None;
            flows.push(Flow {
                id: usize::MAX,
                left: 0.0,
                right: 0.0,
                pitch: 0.0,
            });
            continue;
        };
        let current = line_next.line;
        let joined = previous
            .zip(flows.last().copied())
            .is_some_and(|(before, flow)| {
                let gap = before.line.center - current.center;
                let size = before.line.size.max(current.size);
                gap > 0.3_f64 * size
                    && gap <= FLOW_GAP * size
                    && current.x0 < flow.right
                    && current.x1 > flow.left
            });
        let index = flows.len();
        if joined && let Some(mut flow) = flows.last().copied() {
            flow.left = flow.left.min(current.x0);
            flow.right = flow.right.max(current.x1);
            flows.push(flow);
        } else {
            flows.push(Flow {
                id: index,
                left: current.x0,
                right: current.x1,
                pitch: 0.0,
            });
        }
        previous = Some(line_next);
    }
    let mut gaps = Vec::new();
    for group in flows.chunk_by_mut(|left, right| left.id == right.id) {
        let Some(first) = group.first() else {
            continue;
        };
        let Some(members) = lines.get(first.id..first.id.saturating_add(group.len())) else {
            continue;
        };
        let mut left = f64::INFINITY;
        let mut right = f64::NEG_INFINITY;
        gaps.clear();
        let mut before: Option<&MdLine> = None;
        let mut size = 0.0_f64;
        for line in members.iter().flatten() {
            left = left.min(line.line.x0);
            right = right.max(line.line.x1);
            size = size.max(line.line.size);
            if let Some(above) = before
                && near_size(above.size, line.line.size)
            {
                gaps.push(above.center - line.line.center);
            }
            before = Some(line.line);
        }
        let pitch = if gaps.len() >= FLOW_SAMPLES {
            sort_total(&mut gaps, &f64::total_cmp);
            gaps.get(gaps.len().checked_div(4).unwrap_or(0))
                .copied()
                .unwrap_or(0.0_f64)
        } else {
            metrics.pitch * size
        };
        for flow in group {
            flow.left = left;
            flow.right = right;
            flow.pitch = pitch;
        }
    }
    flows
}

fn breaks_within_flow(
    previous: &Prepared<'_>,
    next: &Prepared<'_>,
    flow: Flow,
    para: &Para,
) -> bool {
    let strong = strong_continuation(&previous.plain, &next.plain);
    let (above, below) = (previous.line, next.line);
    let gap = above.center - below.center;
    if above.band != below.band
        && (gap > BAND_GAP * flow.pitch || !near_size(above.size, below.size))
    {
        return !evident(&previous.plain, &next.plain);
    }
    if !near_size(above.size, below.size) {
        return true;
    }
    if flow.pitch > 0.0_f64 && gap > PARAGRAPH_GAP * flow.pitch && !strong {
        return true;
    }
    if let Some(found) = &next.lead {
        let evidence = ends_terminal(&previous.plain)
            || para.lead.is_some()
            || below.x0 > flow.left + INDENT_EM * below.size
            || word_fits(previous, next, flow);
        if found.kind != LeadKind::Dash || evidence {
            return true;
        }
    }
    if strong {
        return false;
    }
    let shout_above = emphatic(previous);
    let shout_below = emphatic(next);
    if shout_above != shout_below {
        return true;
    }
    if ends_terminal(&previous.plain) && linked(&previous.spans) != linked(&next.spans) {
        return true;
    }
    let sentence_edge = ends_terminal(&previous.plain) || !starts_lower(&next.plain);
    if sentence_edge && word_fits(previous, next, flow) {
        return true;
    }
    ends_terminal(&previous.plain)
        && below.x0 > above.x0 + INDENT_EM * below.size
        && below.x0 > flow.left + INDENT_EM * below.size
}

fn breaks_across_flows(previous: &Prepared<'_>, next: &Prepared<'_>) -> bool {
    let cross_band = previous.line.band != next.line.band && !evident(&previous.plain, &next.plain);
    next.lead.is_some()
        || cross_band
        || !near_size(previous.line.size, next.line.size)
        || !strong_continuation(&previous.plain, &next.plain)
}

fn left_word(text: &str) -> &str {
    text.rsplit(char::is_whitespace).next().unwrap_or_default()
}

fn right_word(text: &str) -> String {
    fold_string(
        text.trim_start()
            .split(char::is_whitespace)
            .next()
            .unwrap_or_default()
            .trim_end_matches(|ch: char| !ch.is_alphanumeric()),
    )
}

fn keeps_hyphen(stem: &str, right: &str) -> bool {
    let left = fold_string(left_word(stem));
    let word = right_word(right);
    left.contains('-')
        || word.contains('-')
        || CLITICS.contains(&word.as_str())
        || PREFIXES.contains(&left.as_str())
        || WEEKDAY_TAILS.contains(&word.as_str())
}

fn soft_break(stem: &str, right: &str, words: &Words) -> bool {
    if keeps_hyphen(stem, right) {
        return false;
    }
    let prefix = word_core(left_word(stem));
    let suffix = word_core(right.split_whitespace().next().unwrap_or_default());
    if prefix.chars().any(|ch| ch.is_ascii_digit()) {
        return false;
    }
    if let Some(join) = words.verdict(prefix, suffix) {
        return join;
    }
    prefix.chars().filter(|ch| ch.is_uppercase()).count() < 2
}

fn glue(left: &str, right: &str, words: &Words) -> Glue {
    if left.is_empty()
        || right.is_empty()
        || left.ends_with(char::is_whitespace)
        || right.starts_with(char::is_whitespace)
        || url_continues(left, right)
    {
        return Glue::Direct;
    }
    if let Some(stem) = left.strip_suffix('\u{ad}')
        && stem.chars().next_back().is_some_and(char::is_alphanumeric)
    {
        return Glue::DropLast;
    }
    let Some(stem) = left.strip_suffix('-') else {
        return Glue::Space;
    };
    let before = stem.chars().next_back();
    let after = right.chars().next();
    match (before, after) {
        (Some(inner_before), Some(inner_after))
            if inner_before.is_alphanumeric() && inner_after.is_alphanumeric() =>
        {
            if inner_before.is_alphabetic()
                && inner_after.is_lowercase()
                && soft_break(stem, right, words)
            {
                Glue::DropLast
            } else {
                Glue::Direct
            }
        }
        _ => Glue::Space,
    }
}

pub(crate) fn reflow_lines<'data>(lines: impl IntoIterator<Item = &'data str>) -> String {
    let mut out = String::new();
    for line in lines {
        let trimmed_line = line.trim();
        if trimmed_line.is_empty() {
            continue;
        }
        match glue(&out, trimmed_line, &Words::default()) {
            Glue::Direct => {}
            Glue::Space => out.push(' '),
            Glue::DropLast => {
                let _: Option<char> = out.pop();
            }
        }
        out.push_str(trimmed_line);
    }
    out
}

fn append_spans(
    spans: &mut Vec<Span>,
    plain: &mut String,
    mut next: Vec<Span>,
    next_plain: &str,
    words: &Words,
) {
    if url_continues(plain, next_plain)
        && let Some(link) = spans
            .iter()
            .rev()
            .find(|span| !span.text.is_empty())
            .and_then(|span| span.link)
    {
        let token = next_plain
            .split(char::is_whitespace)
            .next()
            .unwrap_or_default();
        widen_link(&mut next, link, trailer_cut(token));
    }
    match glue(plain, next_plain, words) {
        Glue::Direct => {}
        Glue::Space => {
            if let Some(last) = spans.last_mut() {
                last.text.push(' ');
            }
            plain.push(' ');
        }
        Glue::DropLast => {
            let _: Option<char> = plain.pop();
            if let Some(last) = spans.iter_mut().rev().find(|span| !span.text.is_empty()) {
                let _: Option<char> = last.text.pop();
            }
        }
    }
    plain.push_str(next_plain);
    for span in next {
        match spans.last_mut() {
            Some(last)
                if (last.bold, last.italic, last.link) == (span.bold, span.italic, span.link) =>
            {
                last.text.push_str(&span.text);
            }
            _ => spans.push(span),
        }
    }
}

fn widen_link(spans: &mut Vec<Span>, link: usize, len: usize) {
    let Some(first) = spans.first_mut() else {
        return;
    };
    if first.link.is_some() {
        return;
    }
    let Some((head, tail)) = first.text.split_at_checked(len.min(first.text.len())) else {
        return;
    };
    let rest = Span {
        text: tail.to_owned(),
        bold: first.bold,
        italic: first.italic,
        link: None,
    };
    first.text = head.to_owned();
    first.link = Some(link);
    if !rest.text.is_empty() {
        spans.insert(1, rest);
    }
}

fn detach_link_trailers(spans: &mut Vec<Span>) {
    let mut index = 0_usize;
    while let Some(span) = spans.get(index) {
        index = index.saturating_add(1);
        let Some(link) = span.link else {
            continue;
        };
        if spans.get(index).is_some_and(|next| next.link == Some(link)) {
            continue;
        }
        let Some(linked) = spans.get_mut(index.saturating_sub(1)) else {
            continue;
        };
        let kept = trailer_cut(linked.text.trim_end());
        if kept == 0 || kept >= linked.text.trim_end().len() {
            continue;
        }
        let rest = Span {
            text: linked.text.split_off(kept),
            bold: linked.bold,
            italic: linked.italic,
            link: None,
        };
        spans.insert(index, rest);
        index = index.saturating_add(1);
    }
}

fn numbering_depth(text: &str) -> Option<usize> {
    let found = lead(text)?;
    match found.kind {
        LeadKind::Ordered => Some(1),
        LeadKind::Clause(depth)
            if text
                .trim_start()
                .starts_with(|ch: char| ch.is_ascii_digit()) =>
        {
            Some(depth)
        }
        LeadKind::Bullet | LeadKind::Dash | LeadKind::Labeled | LeadKind::Clause(_) => None,
    }
}

fn heading_level(para: &Para, body: f64) -> Option<usize> {
    if para.lines > HEADING_LINES {
        return None;
    }
    let text = para.plain.trim();
    let chars = text.chars().count();
    let letters = text.chars().filter(|ch| ch.is_alphabetic()).count();
    if chars > HEADING_CHARS || letters < 2 || starts_lower(text) {
        return None;
    }
    let upper = mostly_uppercase(text);
    let tail = last_char(text);
    if tail.is_some_and(|ch| matches!(ch, ',' | ';')) {
        return None;
    }
    if tail == Some('.') && !(upper && chars <= SHORT_HEADING_CHARS) {
        return None;
    }
    let ratio = para.size / body.max(1e-3);
    let bold = all_bold(&para.spans);
    let depth = numbering_depth(text);
    let big = ratio >= HEADING_RATIO;
    let visible = text.chars().filter(|ch| !ch.is_whitespace()).count();
    let words: Vec<&str> = text.split_whitespace().collect();
    let readable = letters.saturating_mul(10) >= visible.saturating_mul(6)
        && text.chars().next().is_some_and(char::is_alphanumeric)
        && !text.contains('_')
        && !text.contains("...")
        && !text.contains('\u{2026}');
    let paged = depth.is_some()
        && words.len() > 2
        && words
            .last()
            .is_some_and(|word| word.chars().all(|ch| ch.is_ascii_digit()));
    if !readable || paged {
        return None;
    }
    let short = chars <= SHORT_HEADING_CHARS;
    let long_words = words
        .iter()
        .filter(|word| word.chars().count() >= 3)
        .count();
    let accepted = if depth.is_some() {
        (upper || bold || big) && (short || upper)
    } else if big {
        bold || upper || short
    } else {
        upper && bold && tail != Some(':') && long_words.saturating_mul(2) >= words.len()
    };
    if !accepted {
        return None;
    }
    Some(match depth {
        Some(inner_depth) => inner_depth.saturating_add(1).min(MAX_HEADING_LEVEL),
        None if ratio >= TITLE_RATIO => 1,
        None => 2,
    })
}

fn drop_prefix(spans: &mut Vec<Span>, mut count: usize) {
    while count > 0 {
        let Some(first) = spans.first_mut() else {
            return;
        };
        if first.text.len() <= count {
            count = count.saturating_sub(first.text.len());
            drop(spans.remove(0));
        } else {
            first.text = first.text.get(count..).unwrap_or_default().to_owned();
            count = 0;
        }
    }
    if let Some(first) = spans.first_mut() {
        first.text = first.text.trim_start().to_owned();
    }
}

fn finish(para: Para, body: f64, list: &mut ListState, out: &mut Vec<MdBlock>) {
    let typical = para
        .sizes
        .iter()
        .max_by_key(|entry| entry.1)
        .map_or(para.size, |entry| entry.0);
    if let Some(level) = heading_level(&para, body) {
        list.open = false;
        out.push(MdBlock {
            kind: Kind::Heading(level),
            plain: para.plain,
            spans: para.spans,
            band: para.band,
            lines: para.lines,
            size: para.size,
            top: para.top,
            typical,
        });
        return;
    }
    let family = para.lead.as_ref().and_then(|found| lead_family(found.kind));
    if let (Some(found), Some(inner_family)) = (para.lead.clone(), family) {
        let marker = match inner_family {
            Family::Bullet => "-".to_owned(),
            Family::Ordered => found.label.clone(),
            Family::Labeled => {
                let mut marker = String::with_capacity(found.label.len().saturating_add(2));
                marker.push_str("- ");
                marker.push_str(&found.label);
                marker
            }
        };
        let shown = match inner_family {
            Family::Labeled => "-",
            Family::Bullet | Family::Ordered => marker.as_str(),
        };
        let (indent, tight) = list.place(&para, inner_family, shown);
        let mut spans = para.spans;
        drop_prefix(&mut spans, found.len);
        out.push(MdBlock {
            kind: Kind::Item {
                indent,
                marker,
                tight,
            },
            plain: para.plain,
            spans,
            band: para.band,
            lines: para.lines,
            size: para.size,
            top: para.top,
            typical,
        });
        return;
    }
    list.open = false;
    out.push(MdBlock {
        kind: Kind::Paragraph,
        plain: para.plain,
        spans: para.spans,
        band: para.band,
        lines: para.lines,
        size: para.size,
        top: para.top,
        typical,
    });
}

fn start(line: &Prepared<'_>) -> Para {
    Para {
        spans: line.spans.clone(),
        plain: line.plain.clone(),
        lines: 1,
        x0: line.line.x0,
        content_x: line.content_x,
        size: line.line.size,
        band: line.line.band,
        lead: line.lead.clone(),
        top: line.line.center,
        sizes: vec![(line.typical, line.weight)],
    }
}

fn extend(para: &mut Para, line: &Prepared<'_>, words: &Words) {
    append_spans(
        &mut para.spans,
        &mut para.plain,
        line.spans.clone(),
        &line.plain,
        words,
    );
    para.lines = para.lines.saturating_add(1);
    para.size = para.size.max(line.line.size);
    match para
        .sizes
        .iter_mut()
        .find(|entry| (entry.0 - line.typical).abs() <= SIZE_STEP * line.typical)
    {
        Some(entry) => entry.1 = entry.1.saturating_add(line.weight),
        None => para.sizes.push((line.typical, line.weight)),
    }
    if line.line.band == Band::Free {
        para.band = Band::Free;
    }
}

fn unspaced_marker_end(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    let open = usize::from(bytes.first() == Some(&b'('));
    let end = if bytes.get(open).is_some_and(u8::is_ascii_lowercase)
        && bytes.get(open.saturating_add(1)) == Some(&b')')
    {
        open.saturating_add(2)
    } else {
        let mut index = 0_usize;
        loop {
            let start = index;
            while bytes.get(index).is_some_and(u8::is_ascii_digit) {
                index = index.saturating_add(1);
            }
            if !(1..=3).contains(&index.saturating_sub(start)) {
                return None;
            }
            match bytes.get(index) {
                Some(b'.')
                    if bytes
                        .get(index.saturating_add(1))
                        .is_some_and(u8::is_ascii_digit) =>
                {
                    index = index.saturating_add(1);
                }
                Some(b'.' | b')') => break index.saturating_add(1),
                _ => return None,
            }
        }
    };
    text.get(end..)?
        .chars()
        .next()
        .is_some_and(char::is_uppercase)
        .then_some(end)
}

fn space_unspaced_marker(spans: &mut [Span], plain: &mut String) -> bool {
    let offset = plain.len().saturating_sub(plain.trim_start().len());
    let Some(end) = plain.get(offset..).and_then(unspaced_marker_end) else {
        return false;
    };
    let at = offset.saturating_add(end);
    let mut start = 0_usize;
    for span in spans {
        let stop = start.saturating_add(span.text.len());
        if at > start && at <= stop && span.text.is_char_boundary(at.saturating_sub(start)) {
            span.text.insert(at.saturating_sub(start), ' ');
            plain.insert(at, ' ');
            return true;
        }
        start = stop;
    }
    false
}

fn prepare(item: &MdItem, metrics: Metrics) -> Option<Prepared<'_>> {
    let MdItem::Line(line) = item else {
        return None;
    };
    let mut spans = line_spans(line);
    if metrics.bold_body || metrics.italic_body {
        for span in &mut spans {
            span.bold &= !metrics.bold_body;
            span.italic &= !metrics.italic_body;
        }
    }
    let mut plain = concat(&spans);
    if plain.trim().is_empty() {
        return None;
    }
    let spaced = space_unspaced_marker(&mut spans, &mut plain);
    let lead = lead(&plain);
    let skip = lead.as_ref().map_or(0, |found| {
        plain
            .get(..found.len)
            .map_or(0, |prefix| prefix.chars().count())
            .saturating_sub(usize::from(spaced))
    });
    let mut weight = 0_usize;
    let mut typical = (line.size, 0_usize);
    for run in &line.runs {
        let count = run.text.chars().filter(|ch| !ch.is_whitespace()).count();
        weight = weight.saturating_add(count);
        if count > typical.1 {
            typical = (run.size, count);
        }
    }
    Some(Prepared {
        line,
        spans,
        plain,
        lead,
        content_x: x_after(line, skip),
        typical: typical.0,
        weight,
    })
}

pub(crate) fn page_blocks(
    items: &[MdItem],
    tables: Option<&[Table]>,
    metrics: Metrics,
    words: &Words,
) -> Vec<MdBlock> {
    let body = metrics.body;
    let prepared: Vec<Option<Prepared<'_>>> =
        items.iter().map(|item| prepare(item, metrics)).collect();
    let flows = compute_flows(&prepared, metrics);
    let mut out: Vec<MdBlock> = Vec::new();
    let mut list = ListState::default();
    let mut current: Option<(Para, usize)> = None;
    for (index, (item, line)) in items.iter().zip(&prepared).enumerate() {
        let Some(line_next) = line else {
            if let MdItem::Table {
                index: table_index,
                band,
                top,
            } = item
            {
                if let Some((para, _)) = current.take() {
                    finish(para, body, &mut list, &mut out);
                }
                list.open = false;
                out.push(MdBlock {
                    kind: Kind::Table(*table_index),
                    spans: Vec::new(),
                    plain: tables
                        .and_then(|all| all.get(*table_index))
                        .map(render_markdown)
                        .unwrap_or_default(),
                    band: *band,
                    lines: 0,
                    size: 0.0,
                    top: *top,
                    typical: 0.0,
                });
            } else if matches!(item, MdItem::Break)
                && let Some((para, _)) = current.take()
            {
                finish(para, body, &mut list, &mut out);
            }
            continue;
        };
        let flow = flows.get(index).copied().unwrap_or(Flow {
            id: usize::MAX,
            left: 0.0,
            right: 0.0,
            pitch: 0.0,
        });
        let joins = current.as_ref().is_some_and(|(para, last)| {
            let Some(Some(previous)) = prepared.get(*last) else {
                return false;
            };
            let same_flow = flows.get(*last).is_some_and(|before| before.id == flow.id);
            if same_flow {
                !breaks_within_flow(previous, line_next, flow, para)
            } else {
                !breaks_across_flows(previous, line_next)
            }
        });
        if joins && let Some((para, last)) = current.as_mut() {
            extend(para, line_next, words);
            *last = index;
            continue;
        }
        if let Some((para, _)) = current.take() {
            finish(para, body, &mut list, &mut out);
        }
        current = Some((start(line_next), index));
    }
    if let Some((para, _)) = current {
        finish(para, body, &mut list, &mut out);
    }
    out
}

fn stray(block: &MdBlock) -> bool {
    block.band != Band::Free
        || (matches!(block.kind, Kind::Paragraph | Kind::Heading(_))
            && block.lines <= HEADING_LINES
            && block.plain.chars().count() <= STRAY_CHARS
            && !ends_terminal(&block.plain))
}

fn note(block: &MdBlock, local: f64) -> bool {
    block.table_index().is_none() && block.typical < NOTE_SIZE * local
}

fn page_body(blocks: &[MdBlock]) -> f64 {
    body_size(
        blocks
            .iter()
            .filter(|block| block.table_index().is_none())
            .map(|block| (block.typical, block.plain.len()))
            .collect(),
    )
}

fn caption(block: &MdBlock) -> bool {
    let mut words = block.plain.split_whitespace();
    let (Some(label), Some(number)) = (words.next(), words.next()) else {
        return false;
    };
    CAPTIONS.contains(&fold_string(label).as_str())
        && number
            .chars()
            .next()
            .is_some_and(|ch| ch.is_ascii_digit() || ROMAN.contains(&ch))
}

fn floating(block: &MdBlock, local: f64, notes: bool) -> bool {
    note(block, local) != notes || caption(block) || block.table_index().is_some()
}

fn tail_scan(blocks: &[MdBlock], body: f64, local: f64, notes: bool) -> Option<usize> {
    let mut skipped = 0_usize;
    for (index, block) in blocks.iter().enumerate().rev().take(HEAD_SCAN) {
        let float = floating(block, local, notes);
        let marginal = block.band != Band::Free && block.size < MARGINAL_SIZE * body;
        if !float
            && (notes || !marginal)
            && matches!(block.kind, Kind::Paragraph | Kind::Item { .. })
            && !ends_terminal(&block.plain)
        {
            return Some(index);
        }
        if !notes && note(block, local) {
            continue;
        }
        if !stray(block) {
            return None;
        }
        skipped = skipped.saturating_add(1);
        if skipped > STRAY_BLOCKS {
            return None;
        }
    }
    None
}

fn head_scan(blocks: &[MdBlock], tail: &MdBlock, local: f64, notes: bool) -> Option<usize> {
    let mut skipped = 0_usize;
    for (index, block) in blocks.iter().enumerate().take(HEAD_SCAN) {
        let float = floating(block, local, notes);
        let evident = evident(&tail.plain, &block.plain);
        let continues = !float
            && (block.band == Band::Free || evident)
            && block.kind == Kind::Paragraph
            && strong_continuation(&tail.plain, &block.plain);
        if continues && (index == 0 || evident) {
            return Some(index);
        }
        if float {
            continue;
        }
        if !stray(block) {
            return None;
        }
        skipped = skipped.saturating_add(1);
        if skipped > STRAY_BLOCKS {
            return None;
        }
    }
    None
}

fn join_point(left: &[MdBlock], right: &[MdBlock], body: f64) -> Option<(usize, usize)> {
    let (near, far) = (page_body(left), page_body(right));
    [false, true].into_iter().find_map(|notes| {
        let tail = tail_scan(left, body, near, notes)?;
        let head = head_scan(right, left.get(tail)?, far, notes)?;
        Some((tail, head))
    })
}

pub(crate) fn join_pages(pages: &mut [Vec<MdBlock>], metrics: Metrics, words: &Words) {
    let mut tail_page: Option<usize> = None;
    for index in 0..pages.len() {
        if let Some(previous) = tail_page
            && let Some((before, after)) = pages.split_at_mut_checked(index)
            && let (Some(left), Some(right)) = (before.get_mut(previous), after.first_mut())
            && let Some((tail, head)) = join_point(left, right, metrics.body)
        {
            let moved = right.remove(head);
            if let Some(target) = left.get_mut(tail) {
                target.lines = target.lines.saturating_add(moved.lines);
                append_spans(
                    &mut target.spans,
                    &mut target.plain,
                    moved.spans,
                    &moved.plain,
                    words,
                );
            }
        }
        if pages.get(index).is_some_and(|blocks| !blocks.is_empty()) {
            tail_page = Some(index);
        }
    }
}

fn escape_into(text: &str, out: &mut String) {
    let mut start = 0;
    for (index, token) in text.match_indices(['\\', '*', '`', '_', '<', ']', '[']) {
        let tail = text.get(index.saturating_add(1)..).unwrap_or_default();
        let escape = match token {
            "\\" | "*" | "`" => true,
            "_" => {
                let before = text.get(..index).and_then(|head| head.chars().next_back());
                !(before.is_some_and(char::is_alphanumeric)
                    && tail.chars().next().is_some_and(char::is_alphanumeric))
            }
            "<" => tail.as_bytes().first().is_some_and(|next| {
                next.is_ascii_alphabetic() || matches!(next, b'/' | b'!' | b'?')
            }),
            "]" => tail.starts_with('('),
            "[" => tail.starts_with('['),
            _ => false,
        };
        if escape {
            out.push_str(text.get(start..index).unwrap_or_default());
            out.push('\\');
            start = index;
        }
    }
    out.push_str(text.get(start..).unwrap_or_default());
}

fn collapse(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut space = false;
    for ch in text.chars() {
        if ch.is_whitespace() {
            space = true;
        } else {
            if space && !out.is_empty() {
                out.push(' ');
            }
            space = false;
            out.push(ch);
        }
    }
    if space && !out.is_empty() {
        out.push(' ');
    }
    out
}

fn emphasize(span: &Span, out: &mut String) {
    let text = collapse(&span.text);
    let inner = text.trim();
    let lead = text.len().saturating_sub(text.trim_start().len());
    let trail = text.len().saturating_sub(text.trim_end().len());
    if lead > 0 {
        out.push(' ');
    }
    let marker = match (span.bold, span.italic) {
        (false, false) => "",
        _ if !inner.chars().any(char::is_alphanumeric) => "",
        (true, true) => "***",
        (true, false) => "**",
        (false, true) => "*",
    };
    out.push_str(marker);
    escape_into(inner, out);
    out.push_str(marker);
    if trail > 0 && !inner.is_empty() {
        out.push(' ');
    }
}

fn normalized(spans: &[Span]) -> Vec<Span> {
    let mut out: Vec<Span> = Vec::with_capacity(spans.len());
    for (index, span) in spans.iter().enumerate() {
        let style = if span.text.trim().is_empty() {
            let next = spans.get(index.saturating_add(1));
            let keep = out.last().zip(next).is_some_and(|(before, after)| {
                (before.bold, before.italic, before.link) == (after.bold, after.italic, after.link)
            });
            match out.last() {
                Some(before) if keep => (before.bold, before.italic, before.link),
                _ => (false, false, None),
            }
        } else {
            (span.bold, span.italic, span.link)
        };
        if let Some(last) = out.last_mut()
            && (last.bold, last.italic, last.link) == style
        {
            last.text.push_str(&span.text);
        } else {
            let (bold, italic, link) = style;
            out.push(Span {
                bold,
                italic,
                link,
                text: span.text.clone(),
            });
        }
    }
    out
}

fn render_inline(spans: &[Span], links: &[LinkInfo], out: &mut String) {
    if let [span] = spans
        && span.link.is_none()
        && !span.text.trim().is_empty()
    {
        emphasize(span, out);
        return;
    }
    let mut spans_next = normalized(spans);
    detach_link_trailers(&mut spans_next);
    let mut index = 0_usize;
    while let Some(span) = spans_next.get(index) {
        let Some(link) = span.link.and_then(|at| links.get(at)) else {
            emphasize(span, out);
            index = index.saturating_add(1);
            continue;
        };
        let mut end = index;
        while spans_next
            .get(end.saturating_add(1))
            .is_some_and(|next| next.link == span.link)
        {
            end = end.saturating_add(1);
        }
        let group = spans_next.get(index..=end).unwrap_or_default();
        let label = concat(group);
        let bare = label.contains(&link.uri)
            || label.trim_start().starts_with("http")
            || label.trim_start().starts_with("www.")
            || link.uri.is_empty();
        if bare {
            for part in group {
                emphasize(part, out);
            }
        } else {
            let mut inner = String::new();
            for part in group {
                emphasize(part, &mut inner);
            }
            let trimmed = inner.trim();
            if inner.starts_with(' ') {
                out.push(' ');
            }
            out.push('[');
            out.push_str(trimmed);
            out.push_str("](");
            for ch in link.uri.chars() {
                match ch {
                    ' ' => out.push_str("%20"),
                    '(' => out.push_str("%28"),
                    ')' => out.push_str("%29"),
                    _ => out.push(ch),
                }
            }
            out.push(')');
            if inner.ends_with(' ') {
                out.push(' ');
            }
        }
        index = end.saturating_add(1);
    }
}

fn block_start_escape(text: &str) -> bool {
    let trimmed = text.trim_start();
    let mut chars = trimmed.chars();
    let first = chars.next();
    let second = chars.next();
    match first {
        Some('#' | '>' | '|' | '=') => true,
        Some('-' | '+') => second.is_none_or(char::is_whitespace) || trimmed.starts_with("---"),
        Some(digit) if digit.is_ascii_digit() => {
            let digits = trimmed.chars().take_while(char::is_ascii_digit).count();
            let mut rest = trimmed.chars().skip(digits);
            matches!(rest.next(), Some('.' | ')')) && rest.next().is_none_or(char::is_whitespace)
        }
        _ => false,
    }
}

fn escaped_start(rendered: String) -> String {
    if !block_start_escape(&rendered) {
        return rendered;
    }
    let digits = rendered.chars().take_while(char::is_ascii_digit).count();
    let mut out = String::with_capacity(rendered.len().saturating_add(1));
    if digits > 0 {
        for (index, ch) in rendered.chars().enumerate() {
            if index == digits {
                out.push('\\');
            }
            out.push(ch);
        }
    } else {
        out.push('\\');
        out.push_str(&rendered);
    }
    out
}

fn render_block(block: &MdBlock, links: &[LinkInfo], out: &mut String) {
    match &block.kind {
        Kind::Table(_) => out.push_str(&block.plain),
        Kind::Heading(level) => {
            out.push_str(&"#".repeat(*level));
            out.push(' ');
            let mut text = String::new();
            escape_into(collapse(block.plain.trim()).as_str(), &mut text);
            let trimmed = text.trim_end_matches('#').trim_end();
            out.push_str(trimmed);
            if trimmed.len() < text.len() {
                out.push_str(" \\#");
            }
        }
        Kind::Item { indent, marker, .. } => {
            out.push_str(&" ".repeat(*indent));
            out.push_str(marker);
            let mut text = String::new();
            render_inline(&block.spans, links, &mut text);
            let trimmed_text = text.trim();
            if !trimmed_text.is_empty() {
                out.push(' ');
                out.push_str(trimmed_text);
            }
        }
        Kind::Paragraph => {
            let mut text = String::new();
            render_inline(&block.spans, links, &mut text);
            out.push_str(&escaped_start(text.trim().to_owned()));
        }
    }
}

pub(crate) fn render_page(blocks: &[MdBlock], links: &[LinkInfo]) -> String {
    let mut out = String::new();
    let mut rendered = String::new();
    for block in blocks {
        rendered.clear();
        render_block(block, links, &mut rendered);
        if rendered.trim().is_empty() {
            continue;
        }
        if !out.is_empty() {
            let tight = matches!(block.kind, Kind::Item { tight: true, .. });
            out.push_str(if tight { "\n" } else { "\n\n" });
        }
        out.push_str(&rendered);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(text: &str, x0: f64, bold: bool) -> MdRun {
        let width = 5.0_f64 * f64::from(u32::try_from(text.chars().count()).unwrap());
        MdRun {
            text: text.to_owned(),
            x0,
            x1: x0 + width,
            size: 10.0,
            bold,
            italic: false,
            link: None,
        }
    }

    fn line(runs: Vec<MdRun>, center: f64) -> MdItem {
        let x0 = runs.first().unwrap().x0;
        let x1 = runs.last().unwrap().x1;
        MdItem::Line(MdLine {
            runs,
            x0,
            x1,
            center,
            size: 10.0,
            band: Band::Free,
        })
    }

    fn render(items: &[MdItem]) -> String {
        render_page(
            &page_blocks(items, None, document_metrics([items]), &Words::default()),
            &[],
        )
    }

    fn joined(left: &str, right: &str) -> (String, String) {
        let span = |text: &str| Span {
            text: text.to_owned(),
            bold: false,
            italic: false,
            link: None,
        };
        let mut spans = vec![span(left)];
        let mut plain = left.to_owned();
        append_spans(
            &mut spans,
            &mut plain,
            vec![span(right)],
            right,
            &Words::default(),
        );
        (plain, concat(&spans))
    }

    #[test]
    fn hyphenation_keeps_compounds_and_clitics() {
        for (left, right, expected) in [
            ("a m\u{e3}o-", "de-obra", "a m\u{e3}o-de-obra"),
            ("administra-", "tivo", "administrativo"),
            ("apresent\u{e1}-", "lo hoje", "apresent\u{e1}-lo hoje"),
            ("segunda-", "feira", "segunda-feira"),
            ("CEP 84.145-", "000", "CEP 84.145-000"),
            ("Ji-", "Paran\u{e1}", "Ji-Paran\u{e1}"),
            ("valor -", "total", "valor - total"),
            ("guarda", "chuva", "guarda chuva"),
            ("inter\u{ad}", "rup\u{e7}\u{e3}o", "interrup\u{e7}\u{e3}o"),
        ] {
            let (plain, rendered) = joined(left, right);
            assert_eq!(plain, expected);
            assert_eq!(rendered, expected);
        }
    }

    #[test]
    fn hyphenation_follows_document_evidence() {
        let cases = [
            ("the informa-", "tion we need", "the information we need"),
            ("a well-", "known result", "a well-known result"),
            ("the high-", "level view", "the high-level view"),
            ("an experi-", "ence report", "an experience report"),
            ("a GPU-", "based kernel", "a GPU-based kernel"),
            ("the Trace-", "Monkey engine", "the Trace-Monkey engine"),
            ("Instruc-", "tions for", "Instructions for"),
        ];
        let mut texts = vec![
            "the information we need and a well-known result",
            "high level views and a level of high quality",
            "read the instructions twice",
        ];
        for (left, right, _) in cases {
            texts.push(left);
            texts.push(right);
        }
        let items: Vec<MdItem> = texts
            .iter()
            .zip(0_u32..)
            .map(|(text, row)| line(vec![run(text, 0.0, false)], 700.0 - 12.0 * f64::from(row)))
            .collect();
        let words = Words::collect([items.as_slice()]);
        let glued = |left: &str, right: &str| {
            let mut spans = vec![Span {
                text: left.to_owned(),
                bold: false,
                italic: false,
                link: None,
            }];
            let mut plain = left.to_owned();
            append_spans(&mut spans, &mut plain, Vec::new(), right, &words);
            plain
        };
        for (left, right, expected) in cases {
            assert_eq!(glued(left, right), expected);
        }
        assert_eq!(
            Words::collect([[].as_slice()]).verdict("informa", "tion"),
            None
        );
    }

    #[test]
    fn url_continuations_join_without_a_space() {
        for (left, right, expected) in [
            (
                "acesse https://sei.utfpr.edu.br/sei/controlador_externo.php?",
                "acao=documento_conferir&id=1, informando",
                "acesse https://sei.utfpr.edu.br/sei/controlador_externo.php?acao=documento_conferir&id=1, informando",
            ),
            (
                "https://www.gov.br/empresas-e-negocios/pt-br",
                "/empreendedor; e",
                "https://www.gov.br/empresas-e-negocios/pt-br/empreendedor; e",
            ),
            ("verify?code=", "8e1a-febd", "verify?code= 8e1a-febd"),
            (
                "https://x.br/app/verify?code=",
                "8e1a-febd",
                "https://x.br/app/verify?code=8e1a-febd",
            ),
            (
                "https://loja.br/duto_",
                "flexivel/item",
                "https://loja.br/duto_flexivel/item",
            ),
            (
                "www.portaldecompraspubli-",
                "cas.com.br.",
                "www.portaldecompraspublicas.com.br.",
            ),
            (
                "https://sipac.ufrrj.br/documentos/",
                "informando o",
                "https://sipac.ufrrj.br/documentos/ informando o",
            ),
            (
                "acesse www.site.gov.br",
                "e informe",
                "acesse www.site.gov.br e informe",
            ),
            (
                "https://x.br/manual.pdf",
                "% API=(A)xB",
                "https://x.br/manual.pdf % API=(A)xB",
            ),
        ] {
            let (plain, rendered) = joined(left, right);
            assert_eq!(plain, expected);
            assert_eq!(rendered, expected);
        }
        assert!(!ends_terminal("acesse https://x.br/controlador.php?"));
        assert!(ends_terminal("Qual o valor?"));
    }

    #[test]
    fn url_continuation_widens_the_link_and_drops_trailing_punctuation() {
        let link = Span {
            text: "https://www.gov.br/pt-br".to_owned(),
            bold: false,
            italic: false,
            link: Some(0),
        };
        let mut spans = vec![link];
        let mut plain = "https://www.gov.br/pt-br".to_owned();
        let next = Span {
            text: "/empreendedor; ver".to_owned(),
            bold: false,
            italic: false,
            link: None,
        };
        append_spans(
            &mut spans,
            &mut plain,
            vec![next],
            "/empreendedor; ver",
            &Words::default(),
        );
        let links = [LinkInfo {
            page_index: 0,
            rect: [0.0_f64; 4],
            uri: "https://www.gov.br/pt-br/empreendedor".to_owned(),
        }];
        let mut out = String::new();
        render_inline(&spans, &links, &mut out);
        assert_eq!(out, "https://www.gov.br/pt-br/empreendedor; ver");
        let labelled = [Span {
            text: "portal (oficial).".to_owned(),
            bold: false,
            italic: false,
            link: Some(0),
        }];
        let mut rendered = String::new();
        render_inline(&labelled, &links, &mut rendered);
        assert_eq!(
            rendered,
            "[portal (oficial)](https://www.gov.br/pt-br/empreendedor)."
        );
    }

    #[test]
    fn unspaced_markers_get_a_space() {
        for (text, expected) in [
            ("c)Informar o prazo", Some("c) Informar o prazo")),
            ("(b)Prazo", Some("(b) Prazo")),
            ("10.10.Os documentos", Some("10.10. Os documentos")),
            ("2)Entrega", Some("2) Entrega")),
            ("10.10.2026 data", None),
            ("3.2.1.3.https://x.br", None),
            ("a)b", None),
            ("1234.Texto", None),
            ("Texto 1.Ano", None),
        ] {
            let mut spans = vec![
                Span {
                    text: text.get(..2).unwrap().to_owned(),
                    bold: true,
                    italic: false,
                    link: None,
                },
                Span {
                    text: text.get(2..).unwrap().to_owned(),
                    bold: false,
                    italic: false,
                    link: None,
                },
            ];
            let mut plain = text.to_owned();
            let spaced = space_unspaced_marker(&mut spans, &mut plain);
            assert_eq!(spaced, expected.is_some(), "{text}");
            assert_eq!(plain, expected.unwrap_or(text));
            assert_eq!(concat(&spans), plain);
        }
    }

    #[test]
    fn leads_are_classified() {
        let kind = |text: &str| lead(text).map(|found| (found.kind, found.label));
        assert_eq!(
            kind("\u{2022} item"),
            Some((LeadKind::Bullet, String::new()))
        );
        assert_eq!(kind("- item"), Some((LeadKind::Dash, String::new())));
        assert_eq!(kind("1. item"), Some((LeadKind::Ordered, "1.".to_owned())));
        assert_eq!(kind("2) item"), Some((LeadKind::Ordered, "2)".to_owned())));
        assert_eq!(
            kind("1.1. clause"),
            Some((LeadKind::Clause(2), String::new()))
        );
        assert_eq!(
            kind("3.2.1 clause"),
            Some((LeadKind::Clause(3), String::new()))
        );
        assert_eq!(kind("a) item"), Some((LeadKind::Labeled, "a)".to_owned())));
        assert_eq!(
            kind("(b) item"),
            Some((LeadKind::Labeled, "(b)".to_owned()))
        );
        assert_eq!(
            kind("IV - item"),
            Some((LeadKind::Labeled, "IV -".to_owned()))
        );
        assert_eq!(
            kind("1 - item"),
            Some((LeadKind::Labeled, "1 -".to_owned()))
        );
        assert_eq!(kind("I do edital"), None);
        assert_eq!(kind("14.133/2021 disp\u{f5}e"), None);
        assert_eq!(kind("1.000,00 reais"), None);
        assert_eq!(kind("2026 foi"), None);
        assert_eq!(kind("Contrata\u{e7}\u{e3}o"), None);
    }

    #[test]
    fn justified_lines_reflow_into_one_paragraph() {
        let items = [
            line(
                vec![run("O texto segue at\u{e9} a margem", 0.0, false)],
                100.0,
            ),
            line(vec![run("sem pausa e acaba.", 0.0, false)], 88.0),
            line(vec![run("Outro par\u{e1}grafo.", 0.0, false)], 76.0),
        ];
        assert_eq!(
            render(&items),
            "O texto segue at\u{e9} a margem sem pausa e acaba.\n\nOutro par\u{e1}grafo."
        );
    }

    #[test]
    fn bold_runs_merge_and_headings_drop_markers() {
        let items = [
            line(vec![run("1. DO OBJETO", 0.0, true)], 100.0),
            line(
                vec![
                    run("Texto com", 0.0, false),
                    run("dois", 50.0, true),
                    run("negritos", 72.0, true),
                    run("final.", 120.0, false),
                ],
                70.0,
            ),
        ];
        assert_eq!(
            render(&items),
            "## 1. DO OBJETO\n\nTexto com **dois negritos** final."
        );
    }

    #[test]
    fn escapes_markdown_syntax() {
        let mut out = String::new();
        escape_into("a*b_c d_ [[x]] <b> f](g)", &mut out);
        assert_eq!(out, "a\\*b_c d\\_ \\[[x]] \\<b> f\\](g)");
        assert_eq!(escaped_start("2026. Ano".to_owned()), "2026\\. Ano");
        assert_eq!(escaped_start("# x".to_owned()), "\\# x");
    }

    #[test]
    fn lists_nest_by_indentation() {
        let items = [
            line(vec![run("\u{2022} um", 0.0, false)], 100.0),
            line(vec![run("\u{2013} filho", 20.0, false)], 88.0),
            line(vec![run("\u{2022} dois", 0.0, false)], 76.0),
        ];
        assert_eq!(render(&items), "- um\n  - filho\n- dois");
    }

    #[test]
    fn body_size_is_the_weighted_median() {
        let items = [
            line(vec![run("corpo de texto longo", 0.0, false)], 100.0),
            MdItem::Line(MdLine {
                runs: vec![MdRun {
                    size: 20.0,
                    ..run("T", 0.0, true)
                }],
                x0: 0.0,
                x1: 5.0,
                center: 120.0,
                size: 20.0,
                band: Band::Free,
            }),
        ];
        assert!((document_metrics([items.as_slice()]).body - 10.0).abs() < 1e-9_f64);
        let empty = document_metrics([[].as_slice()]);
        assert!((empty.body - DEFAULT_BODY).abs() < 1e-9_f64);
        assert!((empty.pitch - DEFAULT_PITCH).abs() < 1e-9_f64);
    }
}

#[cfg(test)]
mod properties {
    use super::*;
    use proptest::prelude::*;

    const PIECES: [&str; 14] = [
        "a",
        "B",
        "-",
        "\u{ad}",
        " ",
        "\u{e9}",
        "1",
        "/",
        "http://",
        "x.",
        "lo",
        "ex",
        "feira",
        "\u{e7}\u{e3}o",
    ];

    const PLAINS: [&str; 9] = [
        "the change on the",
        "development set, newstest2013.",
        "Table 3: Variations on the model",
        "Figura 2 Planta baixa",
        "4 To illustrate why the products",
        "Upper case start of a sentence.",
        "continues in lowercase here",
        "informa-",
        "tion we need",
    ];

    fn text() -> impl Strategy<Value = String> {
        prop::collection::vec(prop::sample::select(PIECES.as_slice()), 0..16)
            .prop_map(|pieces| pieces.concat())
    }

    fn span(text: &str) -> Span {
        Span {
            text: text.to_owned(),
            bold: false,
            italic: false,
            link: None,
        }
    }

    fn line_item(text: &str, row: u32) -> MdItem {
        MdItem::Line(MdLine {
            band: Band::Free,
            center: 700.0 - 12.0 * f64::from(row),
            runs: vec![MdRun {
                bold: false,
                italic: false,
                link: None,
                size: 10.0,
                text: text.to_owned(),
                x0: 0.0,
                x1: 100.0,
            }],
            size: 10.0,
            x0: 0.0,
            x1: 100.0,
        })
    }

    fn block() -> impl Strategy<Value = MdBlock> {
        (
            0_u8..5,
            0_u8..4,
            prop::sample::select(PLAINS.as_slice()),
            7_u8..12,
        )
            .prop_map(|(kind_pick, band_pick, plain, size)| {
                let kind = match kind_pick {
                    0 => Kind::Heading(1),
                    1 => Kind::Table(0),
                    2 => Kind::Item {
                        indent: 0,
                        marker: "-".to_owned(),
                        tight: false,
                    },
                    _ => Kind::Paragraph,
                };
                let band = match band_pick {
                    0 => Band::Top,
                    1 => Band::Bottom,
                    _ => Band::Free,
                };
                let typical = f64::from(size);
                MdBlock {
                    band,
                    kind,
                    lines: 0,
                    plain: plain.to_owned(),
                    size: typical,
                    spans: vec![span(plain)],
                    top: 0.0,
                    typical,
                }
            })
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(4_000))]

        #[test]
        fn line_joins_only_ever_drop_a_break_hyphen(
            left in text(),
            right in text(),
            evidence in prop::collection::vec(text(), 0..6),
        ) {
            let mut texts = vec![left.clone(), right.clone()];
            texts.extend(evidence);
            let items: Vec<MdItem> = texts
                .iter()
                .filter(|piece| !piece.is_empty())
                .zip(0_u32..)
                .map(|(piece, row)| line_item(piece, row))
                .collect();
            let words = Words::collect([items.as_slice()]);
            let mut spans = vec![span(&left)];
            let mut plain = left.clone();
            append_spans(&mut spans, &mut plain, vec![span(&right)], &right, &words);
            let mut dropped = left.clone();
            let removed = dropped.pop();
            dropped.push_str(&right);
            let hyphen = matches!(removed, Some('-' | '\u{ad}'));
            let direct = format!("{left}{right}");
            let spaced = format!("{left} {right}");
            let allowed = plain == direct || plain == spaced || (hyphen && plain == dropped);
            prop_assert!(allowed);
            prop_assert!(plain.len().abs_diff(left.len().saturating_add(right.len())) <= 2);
            prop_assert_eq!(concat(&spans), plain);
        }

        #[test]
        fn page_joins_conserve_blocks_and_skip_floats(
            generated in prop::collection::vec(prop::collection::vec(block(), 0..8), 1..7),
            body in 7_u8..12,
        ) {
            let mut pages = generated;
            let mut origin: Vec<(usize, MdBlock)> = Vec::new();
            for (page_index, blocks) in pages.iter_mut().enumerate() {
                for block in blocks {
                    block.lines = 1_usize << origin.len();
                    origin.push((page_index, block.clone()));
                }
            }
            let all = (1_usize << origin.len()).saturating_sub(1);
            let metrics = Metrics {
                body: f64::from(body),
                bold_body: false,
                italic_body: false,
                pitch: 1.2,
            };
            join_pages(&mut pages, metrics, &Words::default());
            let total: usize = pages.iter().flatten().map(|block| block.lines).sum();
            let covered = pages.iter().flatten().fold(0_usize, |bits, block| bits | block.lines);
            prop_assert_eq!(total, all);
            prop_assert_eq!(covered, all);
            for (page_index, blocks) in pages.iter().enumerate() {
                for block in blocks {
                    let members: Vec<&(usize, MdBlock)> = origin
                        .iter()
                        .enumerate()
                        .filter(|(bit, _)| block.lines & (1_usize << bit) != 0)
                        .map(|(_, entry)| entry)
                        .collect();
                    let owners: Vec<&&(usize, MdBlock)> =
                        members.iter().filter(|entry| entry.0 == page_index).collect();
                    prop_assert_eq!(owners.len(), 1);
                    let owner = &owners[0].1;
                    for moved in members.iter().filter(|entry| entry.0 != page_index) {
                        prop_assert!(moved.0 > page_index);
                        prop_assert!(!caption(owner) && !caption(&moved.1));
                        prop_assert!(owner.table_index().is_none() && moved.1.table_index().is_none());
                        let flowing = matches!(owner.kind, Kind::Paragraph | Kind::Item { .. });
                        prop_assert!(flowing);
                        prop_assert_eq!(&moved.1.kind, &Kind::Paragraph);
                    }
                }
            }
        }
    }
}

#[cfg(kani)]
mod proofs {
    use super::*;

    fn any_soft_break(_stem: &str, _right: &str, _words: &Words) -> bool {
        kani::any()
    }

    fn any_url_continues(_left: &str, _right: &str) -> bool {
        kani::any()
    }

    fn any_class(_ch: char) -> bool {
        kani::any()
    }

    #[kani::proof]
    #[kani::stub(soft_break, any_soft_break)]
    #[kani::stub(url_continues, any_url_continues)]
    #[kani::stub(char::is_alphanumeric, any_class)]
    #[kani::stub(char::is_alphabetic, any_class)]
    #[kani::stub(char::is_lowercase, any_class)]
    #[kani::stub(char::is_whitespace, any_class)]
    #[kani::unwind(6)]
    fn glue_only_drops_a_trailing_break_hyphen() {
        let left_bytes: [u8; 4] = kani::any();
        let right_bytes: [u8; 2] = kani::any();
        let (Ok(left), Ok(right)) = (
            core::str::from_utf8(&left_bytes),
            core::str::from_utf8(&right_bytes),
        ) else {
            return;
        };
        let decision = glue(left, right, &Words::default());
        if matches!(decision, Glue::DropLast) {
            assert!(left.ends_with('-') || left.ends_with('\u{ad}'));
            let last = left.chars().next_back().map_or(0, char::len_utf8);
            let stem = left.get(..left.len() - last);
            assert!(stem.is_some_and(|kept| !kept.is_empty()));
        }
    }

    fn any_terminal(_text: &str) -> bool {
        kani::any()
    }

    fn any_continuation(_previous: &str, _next: &str) -> bool {
        kani::any()
    }

    fn by_lines_caption(block: &MdBlock) -> bool {
        block.lines == 2
    }

    fn first_typical(blocks: &[MdBlock]) -> f64 {
        blocks.first().map_or(0.0, |block| block.typical)
    }

    fn any_block() -> MdBlock {
        let kind = match kani::any::<u8>() {
            0 => Kind::Paragraph,
            1 => Kind::Heading(1),
            2 => Kind::Table(0),
            _ => Kind::Item {
                indent: 0,
                marker: String::new(),
                tight: false,
            },
        };
        let band = match kani::any::<u8>() {
            0 => Band::Top,
            1 => Band::Bottom,
            _ => Band::Free,
        };
        let lines: u8 = kani::any();
        kani::assume(lines <= 3);
        MdBlock {
            band,
            kind,
            lines: usize::from(lines),
            plain: String::new(),
            size: f64::from(kani::any::<i8>()),
            spans: Vec::new(),
            top: 0.0,
            typical: f64::from(kani::any::<i8>()),
        }
    }

    #[kani::proof]
    #[kani::stub(ends_terminal, any_terminal)]
    #[kani::stub(strong_continuation, any_continuation)]
    #[kani::stub(evident, any_continuation)]
    #[kani::stub(caption, by_lines_caption)]
    #[kani::stub(page_body, first_typical)]
    #[kani::unwind(4)]
    fn page_joins_pair_body_with_body_and_notes_with_notes() {
        let left = [any_block(), any_block()];
        let right = [any_block(), any_block()];
        let body = f64::from(kani::any::<i8>());
        if let Some((tail, head)) = join_point(&left, &right, body) {
            let (Some(target), Some(moved)) = (left.get(tail), right.get(head)) else {
                panic!("join point out of bounds");
            };
            assert!(note(target, first_typical(&left)) == note(moved, first_typical(&right)));
            assert!(!by_lines_caption(target) && !by_lines_caption(moved));
            assert!(target.table_index().is_none() && moved.table_index().is_none());
            assert!(matches!(target.kind, Kind::Paragraph | Kind::Item { .. }));
            assert!(moved.kind == Kind::Paragraph);
        }
    }

    fn ascii_word<const N: usize>(lowercase: bool) -> [u8; N] {
        let bytes: [u8; N] = kani::any();
        for byte in bytes {
            if lowercase {
                kani::assume(byte.is_ascii_lowercase());
            } else {
                kani::assume(byte.is_ascii_alphanumeric());
            }
        }
        bytes
    }

    #[kani::proof]
    #[kani::unwind(8)]
    fn hyphen_keeps_portuguese_clitics_prefixes_and_weekdays() {
        let stem: [u8; 2] = ascii_word(true);
        let stem = core::str::from_utf8(&stem).unwrap();
        for word in CLITICS.iter().chain(WEEKDAY_TAILS.iter()) {
            assert!(keeps_hyphen(stem, word));
        }
        for prefix in ["ex", "vice", "sem", "bem", "sota", "soto"] {
            assert!(keeps_hyphen(prefix, stem));
        }
    }

    #[kani::proof]
    #[kani::stub(soft_break, any_soft_break)]
    #[kani::stub(url_continues, any_url_continues)]
    #[kani::unwind(8)]
    fn hyphen_keeps_digit_groups_and_capitalised_continuations() {
        let stem: [u8; 3] = ascii_word(false);
        let mut left = [b'-'; 4];
        left[..3].copy_from_slice(&stem);
        let left = core::str::from_utf8(&left).unwrap();
        let first: u8 = kani::any();
        kani::assume(first.is_ascii_digit() || first.is_ascii_uppercase());
        let right_bytes = [first, b'a'];
        let right = core::str::from_utf8(&right_bytes).unwrap();
        assert!(!matches!(
            glue(left, right, &Words::default()),
            Glue::DropLast
        ));
    }

    fn any_bool_text(_text: &str) -> bool {
        kani::any()
    }

    fn any_bool_pair(_previous: &str, _next: &str) -> bool {
        kani::any()
    }

    fn by_top_caption(block: &MdBlock) -> bool {
        block.top > 0.0
    }

    fn first_size(blocks: &[MdBlock]) -> f64 {
        blocks.first().map_or(0.0, |block| block.typical)
    }

    fn appended(
        _spans: &mut Vec<Span>,
        _plain: &mut String,
        _next: Vec<Span>,
        _next_plain: &str,
        _words: &Words,
    ) {
    }

    fn token_block(lines: u8) -> MdBlock {
        let kind = match kani::any::<u8>() {
            0 => Kind::Heading(1),
            1 => Kind::Table(0),
            2 => Kind::Item {
                indent: 0,
                marker: String::new(),
                tight: false,
            },
            _ => Kind::Paragraph,
        };
        let band = match kani::any::<u8>() {
            0 => Band::Top,
            1 => Band::Bottom,
            _ => Band::Free,
        };
        MdBlock {
            band,
            kind,
            lines: usize::from(lines),
            plain: String::new(),
            size: f64::from(kani::any::<i8>()),
            spans: Vec::new(),
            top: f64::from(kani::any::<i8>()),
            typical: f64::from(kani::any::<i8>()),
        }
    }

    #[kani::proof]
    #[kani::stub(ends_terminal, any_bool_text)]
    #[kani::stub(starts_lower, any_bool_text)]
    #[kani::stub(strong_continuation, any_bool_pair)]
    #[kani::stub(evident, any_bool_pair)]
    #[kani::stub(caption, by_top_caption)]
    #[kani::stub(page_body, first_size)]
    #[kani::stub(append_spans, appended)]
    #[kani::unwind(5)]
    fn page_joins_conserve_every_block() {
        let mut pages = [vec![token_block(1), token_block(2)], vec![token_block(4)]];
        let body = f64::from(kani::any::<i8>());
        let metrics = Metrics {
            body,
            bold_body: false,
            italic_body: false,
            pitch: 1.0,
        };
        join_pages(&mut pages, metrics, &Words::default());
        let total: usize = pages.iter().flatten().map(|block| block.lines).sum();
        let covered = pages
            .iter()
            .flatten()
            .fold(0_usize, |bits, block| bits | block.lines);
        assert_eq!(total, 7);
        assert_eq!(covered, 7);
        let remaining: usize = pages.iter().map(Vec::len).sum();
        assert!((2..=3).contains(&remaining));
        assert!(pages.iter().flatten().all(|block| block.lines != 0));
    }
}
