use crate::inspection::LinkInfo;
use crate::layout::Band;

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
const MARGINAL_SIZE: f64 = 0.9;

const BULLETS: [char; 22] = [
    '•', '●', '▪', '■', '◦', '○', '▸', '►', '➢', '➤', '✓', '✔', '·', '‣', '⁃', '*', '\u{f0a7}',
    '\u{f0b7}', '\u{f0d8}', '\u{f076}', '\u{f0fc}', '\u{f06e}',
];
const DASHES: [char; 3] = ['-', '–', '—'];
const ROMAN: [char; 5] = ['I', 'V', 'X', 'L', 'C'];
const CLITICS: [&str; 20] = [
    "lo", "la", "los", "las", "se", "me", "te", "nos", "vos", "lhe", "lhes", "o", "a", "os", "as",
    "no", "na", "nas", "mo", "ma",
];
const PREFIXES: [&str; 14] = [
    "ex", "vice", "pré", "pós", "pró", "recém", "além", "aquém", "sem", "bem", "grã", "grão",
    "sota", "soto",
];
const WEEKDAY_TAILS: [&str; 2] = ["feira", "feiras"];
const FUNCTION_WORDS: [&str; 34] = [
    "de", "da", "do", "das", "dos", "e", "em", "no", "na", "nos", "nas", "para", "por", "pelo",
    "pela", "pelos", "pelas", "com", "sem", "ao", "aos", "à", "às", "um", "uma", "que", "ou",
    "sob", "sobre", "entre", "até", "após", "the", "of",
];

#[derive(Clone, Debug)]
pub(crate) struct MdRun {
    pub text: String,
    pub x0: f64,
    pub x1: f64,
    pub size: f64,
    pub bold: bool,
    pub italic: bool,
    pub link: Option<usize>,
}

#[derive(Clone, Debug)]
pub(crate) struct MdLine {
    pub runs: Vec<MdRun>,
    pub x0: f64,
    pub x1: f64,
    pub center: f64,
    pub size: f64,
    pub band: Band,
}

#[derive(Clone, Debug)]
pub(crate) enum MdItem {
    Line(MdLine),
    Table { text: String, band: Band },
    Break,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Span {
    text: String,
    bold: bool,
    italic: bool,
    link: Option<usize>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Family {
    Bullet,
    Ordered,
    Labeled,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Kind {
    Paragraph,
    Heading(usize),
    Item {
        indent: usize,
        marker: String,
        tight: bool,
    },
    Table,
}

#[derive(Clone, Debug)]
pub(crate) struct MdBlock {
    kind: Kind,
    spans: Vec<Span>,
    plain: String,
    band: Band,
    lines: usize,
    size: f64,
}

impl MdBlock {
    pub(crate) const fn band(&self) -> Band {
        self.band
    }

    pub(crate) fn plain(&self) -> &str {
        &self.plain
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LeadKind {
    Bullet,
    Dash,
    Ordered,
    Labeled,
    Clause(usize),
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Lead {
    kind: LeadKind,
    len: usize,
    label: String,
}

struct Prepared<'a> {
    line: &'a MdLine,
    spans: Vec<Span>,
    plain: String,
    lead: Option<Lead>,
    content_x: f64,
}

#[derive(Clone, Copy)]
struct Flow {
    id: usize,
    left: f64,
    right: f64,
    pitch: f64,
}

struct Para {
    spans: Vec<Span>,
    plain: String,
    lines: usize,
    x0: f64,
    content_x: f64,
    size: f64,
    band: Band,
    lead: Option<Lead>,
}

#[derive(Clone, Copy)]
struct Level {
    x0: f64,
    content: f64,
    indent: usize,
    width: usize,
    family: Family,
}

#[derive(Default)]
struct ListState {
    stack: Vec<Level>,
    open: bool,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Metrics {
    body: f64,
    pitch: f64,
    bold_body: bool,
    italic_body: bool,
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

pub(crate) fn document_metrics<'a>(pages: impl IntoIterator<Item = &'a [MdItem]>) -> Metrics {
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
                let count = run.text.chars().filter(|ch| !ch.is_whitespace()).count();
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
    ratios.sort_by(f64::total_cmp);
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

fn body_size(mut weighted: Vec<(f64, usize)>) -> f64 {
    weighted.sort_by(|left, right| left.0.total_cmp(&right.0));
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

fn line_spans(line: &MdLine) -> Vec<Span> {
    let mut spans: Vec<Span> = Vec::with_capacity(line.runs.len());
    let mut edge: Option<f64> = None;
    for run in &line.runs {
        if let (Some(right), Some(last)) = (edge, spans.last_mut()) {
            let boundary = last.text.ends_with(char::is_whitespace)
                || run.text.starts_with(char::is_whitespace);
            if run.x0 - right > WORD_GAP * run.size && !boundary {
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
    } else if first == '§' {
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
    Some(Lead { kind, len, label })
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
        .trim_end_matches(['"', '”', '\'', '’', ')', ']', '*'])
        .chars()
        .next_back()
}

fn ends_terminal(text: &str) -> bool {
    last_char(text).is_some_and(|ch| matches!(ch, '.' | '!' | '?' | ':' | ';'))
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
            && FUNCTION_WORDS.contains(&left_word(previous.trim_end()).to_lowercase().as_str()))
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
    let mut members: Vec<Vec<usize>> = Vec::new();
    let mut previous: Option<&Prepared<'_>> = None;
    for line in lines {
        let Some(line) = line else {
            previous = None;
            flows.push(Flow {
                id: usize::MAX,
                left: 0.0,
                right: 0.0,
                pitch: 0.0,
            });
            continue;
        };
        let current = line.line;
        let joined = previous
            .zip(flows.last().copied())
            .is_some_and(|(before, flow)| {
                let gap = before.line.center - current.center;
                let size = before.line.size.max(current.size);
                gap > 0.3 * size
                    && gap <= FLOW_GAP * size
                    && current.x0 < flow.right
                    && current.x1 > flow.left
            });
        let index = flows.len();
        if joined && let Some(mut flow) = flows.last().copied() {
            flow.left = flow.left.min(current.x0);
            flow.right = flow.right.max(current.x1);
            flows.push(flow);
            if let Some(group) = members.last_mut() {
                group.push(index);
            }
        } else {
            flows.push(Flow {
                id: members.len(),
                left: current.x0,
                right: current.x1,
                pitch: 0.0,
            });
            members.push(vec![index]);
        }
        previous = Some(line);
    }
    for group in &members {
        let mut left = f64::INFINITY;
        let mut right = f64::NEG_INFINITY;
        let mut gaps: Vec<f64> = Vec::with_capacity(group.len());
        let mut before: Option<&MdLine> = None;
        let mut size = 0.0_f64;
        for &index in group {
            let Some(Some(line)) = lines.get(index) else {
                continue;
            };
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
        gaps.sort_by(f64::total_cmp);
        let pitch = if gaps.len() >= FLOW_SAMPLES {
            gaps.get(gaps.len().checked_div(4).unwrap_or(0))
                .copied()
                .unwrap_or(0.0)
        } else {
            metrics.pitch * size
        };
        for &index in group {
            if let Some(flow) = flows.get_mut(index) {
                flow.left = left;
                flow.right = right;
                flow.pitch = pitch;
            }
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
    if flow.pitch > 0.0 && gap > PARAGRAPH_GAP * flow.pitch && !strong {
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
    text.trim_start()
        .split(char::is_whitespace)
        .next()
        .unwrap_or_default()
        .trim_end_matches(|ch: char| !ch.is_alphanumeric())
        .to_lowercase()
}

fn keeps_hyphen(stem: &str, right: &str) -> bool {
    let left = left_word(stem).to_lowercase();
    let word = right_word(right);
    left.contains('-')
        || word.contains('-')
        || CLITICS.contains(&word.as_str())
        || PREFIXES.contains(&left.as_str())
        || WEEKDAY_TAILS.contains(&word.as_str())
}

enum Glue {
    Space,
    Direct,
    DropLast,
}

fn glue(left: &str, right: &str) -> Glue {
    if left.is_empty()
        || right.is_empty()
        || left.ends_with(char::is_whitespace)
        || right.starts_with(char::is_whitespace)
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
        (Some(before), Some(after)) if before.is_alphanumeric() && after.is_alphanumeric() => {
            if before.is_alphabetic() && after.is_lowercase() && !keeps_hyphen(stem, right) {
                Glue::DropLast
            } else {
                Glue::Direct
            }
        }
        _ => Glue::Space,
    }
}

pub(crate) fn reflow_lines<'a>(lines: impl IntoIterator<Item = &'a str>) -> String {
    let mut out = String::new();
    for line in lines {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        match glue(&out, line) {
            Glue::Direct => {}
            Glue::Space => out.push(' '),
            Glue::DropLast => {
                out.pop();
            }
        }
        out.push_str(line);
    }
    out
}

fn append_spans(spans: &mut Vec<Span>, plain: &mut String, next: Vec<Span>, next_plain: &str) {
    match glue(plain, next_plain) {
        Glue::Direct => {}
        Glue::Space => {
            if let Some(last) = spans.last_mut() {
                last.text.push(' ');
            }
            plain.push(' ');
        }
        Glue::DropLast => {
            plain.pop();
            if let Some(last) = spans.iter_mut().rev().find(|span| !span.text.is_empty()) {
                last.text.pop();
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
        && !text.contains('…');
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
        Some(depth) => depth.saturating_add(1).min(MAX_HEADING_LEVEL),
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
            spans.remove(0);
        } else {
            first.text = first.text.get(count..).unwrap_or_default().to_owned();
            count = 0;
        }
    }
    if let Some(first) = spans.first_mut() {
        first.text = first.text.trim_start().to_owned();
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
            self.stack.pop();
        }
        let width = marker.chars().count().saturating_add(1);
        let (indent, restart) = match self.stack.last().copied() {
            Some(top) if aligned(&top) || content <= top.content + tolerance => {
                self.stack.pop();
                (top.indent, top.family != family && self.stack.is_empty())
            }
            Some(top) => (top.indent.saturating_add(top.width), false),
            None => (0, false),
        };
        self.stack.push(Level {
            x0,
            content,
            indent,
            width,
            family,
        });
        let tight = self.open && !restart;
        self.open = true;
        (indent, tight)
    }
}

fn finish(para: Para, body: f64, list: &mut ListState, out: &mut Vec<MdBlock>) {
    if let Some(level) = heading_level(&para, body) {
        list.open = false;
        out.push(MdBlock {
            kind: Kind::Heading(level),
            plain: para.plain,
            spans: para.spans,
            band: para.band,
            lines: para.lines,
            size: para.size,
        });
        return;
    }
    let family = para.lead.as_ref().and_then(|found| lead_family(found.kind));
    if let (Some(found), Some(family)) = (para.lead.clone(), family) {
        let marker = match family {
            Family::Bullet => "-".to_owned(),
            Family::Ordered => found.label.clone(),
            Family::Labeled => format!("- {}", found.label),
        };
        let shown = match family {
            Family::Labeled => "-",
            Family::Bullet | Family::Ordered => marker.as_str(),
        };
        let (indent, tight) = list.place(&para, family, shown);
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
    }
}

fn extend(para: &mut Para, line: &Prepared<'_>) {
    append_spans(
        &mut para.spans,
        &mut para.plain,
        line.spans.clone(),
        &line.plain,
    );
    para.lines = para.lines.saturating_add(1);
    para.size = para.size.max(line.line.size);
    if line.line.band == Band::Free {
        para.band = Band::Free;
    }
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
    let plain = concat(&spans);
    if plain.trim().is_empty() {
        return None;
    }
    let lead = lead(&plain);
    let skip = lead.as_ref().map_or(0, |found| {
        plain
            .get(..found.len)
            .map_or(0, |prefix| prefix.chars().count())
    });
    Some(Prepared {
        line,
        spans,
        plain,
        lead,
        content_x: x_after(line, skip),
    })
}

pub(crate) fn page_blocks(items: &[MdItem], metrics: Metrics) -> Vec<MdBlock> {
    let body = metrics.body;
    let prepared: Vec<Option<Prepared<'_>>> =
        items.iter().map(|item| prepare(item, metrics)).collect();
    let flows = compute_flows(&prepared, metrics);
    let mut out: Vec<MdBlock> = Vec::new();
    let mut list = ListState::default();
    let mut current: Option<(Para, usize)> = None;
    for (index, (item, line)) in items.iter().zip(&prepared).enumerate() {
        let Some(line) = line else {
            if let MdItem::Table { text, band } = item {
                if let Some((para, _)) = current.take() {
                    finish(para, body, &mut list, &mut out);
                }
                list.open = false;
                out.push(MdBlock {
                    kind: Kind::Table,
                    spans: Vec::new(),
                    plain: text.clone(),
                    band: *band,
                    lines: 0,
                    size: 0.0,
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
                !breaks_within_flow(previous, line, flow, para)
            } else {
                !breaks_across_flows(previous, line)
            }
        });
        if joins && let Some((para, last)) = current.as_mut() {
            extend(para, line);
            *last = index;
            continue;
        }
        if let Some((para, _)) = current.take() {
            finish(para, body, &mut list, &mut out);
        }
        current = Some((start(line), index));
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

fn tail_candidate(blocks: &[MdBlock], body: f64) -> Option<usize> {
    let mut skipped = 0_usize;
    for (index, block) in blocks.iter().enumerate().rev() {
        let marginal = block.band != Band::Free && block.size < MARGINAL_SIZE * body;
        if !marginal
            && matches!(block.kind, Kind::Paragraph | Kind::Item { .. })
            && !ends_terminal(&block.plain)
        {
            return Some(index);
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

fn head_candidate(blocks: &[MdBlock], tail: &MdBlock) -> Option<usize> {
    for (index, block) in blocks
        .iter()
        .enumerate()
        .take(STRAY_BLOCKS.saturating_add(1))
    {
        let evident = evident(&tail.plain, &block.plain);
        let continues = (block.band == Band::Free || evident)
            && block.kind == Kind::Paragraph
            && strong_continuation(&tail.plain, &block.plain);
        if continues && (index == 0 || evident) {
            return Some(index);
        }
        if !stray(block) {
            return None;
        }
    }
    None
}

pub(crate) fn join_pages(pages: &mut [Vec<MdBlock>], metrics: Metrics) {
    let mut tail_page: Option<usize> = None;
    for index in 0..pages.len() {
        if let Some(previous) = tail_page
            && let Some((before, after)) = pages.split_at_mut_checked(index)
            && let (Some(left), Some(right)) = (before.get_mut(previous), after.first_mut())
            && let Some(tail) = tail_candidate(left, metrics.body)
            && let Some(head) = left
                .get(tail)
                .and_then(|block| head_candidate(right, block))
        {
            let moved = right.remove(head);
            if let Some(target) = left.get_mut(tail) {
                target.lines = target.lines.saturating_add(moved.lines);
                append_spans(
                    &mut target.spans,
                    &mut target.plain,
                    moved.spans,
                    &moved.plain,
                );
            }
        }
        if pages.get(index).is_some_and(|blocks| !blocks.is_empty()) {
            tail_page = Some(index);
        }
    }
}

fn escape_into(text: &str, out: &mut String) {
    let chars: Vec<char> = text.chars().collect();
    for (index, &ch) in chars.iter().enumerate() {
        let before = index.checked_sub(1).and_then(|at| chars.get(at)).copied();
        let after = chars.get(index.saturating_add(1)).copied();
        let escape = match ch {
            '\\' | '*' | '`' => true,
            '_' => {
                !(before.is_some_and(char::is_alphanumeric)
                    && after.is_some_and(char::is_alphanumeric))
            }
            '<' => after
                .is_some_and(|next| next.is_ascii_alphabetic() || matches!(next, '/' | '!' | '?')),
            ']' => after == Some('('),
            '[' => after == Some('['),
            _ => false,
        };
        if escape {
            out.push('\\');
        }
        out.push(ch);
    }
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
        _ if !inner.chars().any(char::is_alphanumeric) => "",
        (true, true) => "***",
        (true, false) => "**",
        (false, true) => "*",
        (false, false) => "",
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
        let mut span = span.clone();
        if span.text.trim().is_empty() {
            let next = spans.get(index.saturating_add(1));
            let keep = out.last().zip(next).is_some_and(|(before, after)| {
                (before.bold, before.italic, before.link) == (after.bold, after.italic, after.link)
            });
            match out.last() {
                Some(before) if keep => {
                    span.bold = before.bold;
                    span.italic = before.italic;
                    span.link = before.link;
                }
                _ => {
                    span.bold = false;
                    span.italic = false;
                    span.link = span.link.filter(|_| keep);
                }
            }
        }
        match out.last_mut() {
            Some(last)
                if (last.bold, last.italic, last.link) == (span.bold, span.italic, span.link) =>
            {
                last.text.push_str(&span.text);
            }
            _ => out.push(span),
        }
    }
    out
}

fn render_inline(spans: &[Span], links: &[LinkInfo], out: &mut String) {
    let spans = normalized(spans);
    let mut index = 0_usize;
    while let Some(span) = spans.get(index) {
        let Some(link) = span.link.and_then(|at| links.get(at)) else {
            emphasize(span, out);
            index = index.saturating_add(1);
            continue;
        };
        let mut end = index;
        while spans
            .get(end.saturating_add(1))
            .is_some_and(|next| next.link == span.link)
        {
            end = end.saturating_add(1);
        }
        let group = spans.get(index..=end).unwrap_or_default();
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
            let rest = trimmed.chars().skip(digits);
            let mut rest = rest;
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
        Kind::Table => out.push_str(&block.plain),
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
            let text = text.trim();
            if !text.is_empty() {
                out.push(' ');
                out.push_str(text);
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
    for block in blocks {
        let mut rendered = String::new();
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
        let width = 5.0 * f64::from(u32::try_from(text.chars().count()).unwrap());
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
        render_page(&page_blocks(items, document_metrics([items])), &[])
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
        append_spans(&mut spans, &mut plain, vec![span(right)], right);
        (plain, concat(&spans))
    }

    #[test]
    fn hyphenation_keeps_compounds_and_clitics() {
        for (left, right, expected) in [
            ("a mão-", "de-obra", "a mão-de-obra"),
            ("administra-", "tivo", "administrativo"),
            ("apresentá-", "lo hoje", "apresentá-lo hoje"),
            ("segunda-", "feira", "segunda-feira"),
            ("CEP 84.145-", "000", "CEP 84.145-000"),
            ("Ji-", "Paraná", "Ji-Paraná"),
            ("valor -", "total", "valor - total"),
            ("guarda", "chuva", "guarda chuva"),
            ("inter\u{ad}", "rupção", "interrupção"),
        ] {
            let (plain, rendered) = joined(left, right);
            assert_eq!(plain, expected);
            assert_eq!(rendered, expected);
        }
    }

    #[test]
    fn leads_are_classified() {
        let kind = |text: &str| lead(text).map(|found| (found.kind, found.label));
        assert_eq!(kind("• item"), Some((LeadKind::Bullet, String::new())));
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
        assert_eq!(kind("14.133/2021 dispõe"), None);
        assert_eq!(kind("1.000,00 reais"), None);
        assert_eq!(kind("2026 foi"), None);
        assert_eq!(kind("Contratação"), None);
    }

    #[test]
    fn justified_lines_reflow_into_one_paragraph() {
        let items = [
            line(vec![run("O texto segue até a margem", 0.0, false)], 100.0),
            line(vec![run("sem pausa e acaba.", 0.0, false)], 88.0),
            line(vec![run("Outro parágrafo.", 0.0, false)], 76.0),
        ];
        assert_eq!(
            render(&items),
            "O texto segue até a margem sem pausa e acaba.\n\nOutro parágrafo."
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
            line(vec![run("• um", 0.0, false)], 100.0),
            line(vec![run("– filho", 20.0, false)], 88.0),
            line(vec![run("• dois", 0.0, false)], 76.0),
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
        assert!((document_metrics([items.as_slice()]).body - 10.0).abs() < 1e-9);
        let empty = document_metrics([[].as_slice()]);
        assert!((empty.body - DEFAULT_BODY).abs() < 1e-9);
        assert!((empty.pitch - DEFAULT_PITCH).abs() < 1e-9);
    }
}
