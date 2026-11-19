use crate::lexicon::{self, Lexicon};
use crate::recognize::Word;

const ACRONYM_MAX: u16 = 6;
const ACRONYM_MIN: u16 = 2;
const BIGRAM_BONUS: f32 = 0.25_f32;
const CONFIDENCE_THRESHOLD: f32 = 0.75_f32;
const CONFUSION_BUDGET: u16 = 96;
const COST_SCALE: f32 = 0.003_906_25_f32;
const DIACRITIC_BUDGET: u16 = 160;
const FREQ_SCALE: f32 = 0.062_5_f32;
const GAP: f32 = 0.062_5_f32;
const MARGIN: f32 = 0.125_f32;
const MIN_BUCKET: u8 = 4;
const MIN_CONFUSION_CHARS: usize = 4;
const MIN_DIACRITIC_CHARS: usize = 3;
const MIN_MULTI_CHARS: usize = 5;
const MULTI_COST: u16 = 48;
const MULTI_OCCURRENCES: usize = 2;
const SUB_COST: u16 = 40;

#[cfg(test)]
#[derive(Clone, Debug, Eq, PartialEq)]
#[non_exhaustive]
struct DehyphenHint {
    joined: String,
    line_index: usize,
    word_index: usize,
}

#[derive(Clone, Copy)]
enum CaseKind {
    Empty,
    Lower,
    Mixed,
    Title,
    Upper,
}

enum Plan {
    Keep(Option<u32>),
    Replace(String, u32),
}

struct Hit {
    confidence: f32,
    cost: u16,
    word_id: u32,
}

#[derive(Default)]
struct Scratch {
    chars: Vec<char>,
    folded: String,
    hits: Vec<Hit>,
    stripped: String,
    variant: String,
}

#[inline]
pub(crate) fn correct(words: &mut [Word]) {
    let lexicon = Lexicon::get();
    let mut scratch = Scratch::default();
    let mut previous = None;
    for word in words {
        previous = step(lexicon, &mut scratch, previous, word);
    }
}

#[cfg(test)]
fn correct_lines(lines: &mut [Vec<Word>]) -> Vec<DehyphenHint> {
    let hints = dehyphen_hints(lines);
    let lexicon = Lexicon::get();
    let mut scratch = Scratch::default();
    let mut previous = None;
    for line in lines {
        for word in line {
            previous = step(lexicon, &mut scratch, previous, word);
        }
    }
    hints
}

#[cfg(test)]
fn alphabetic_core(text: &str) -> Option<&str> {
    let (start, end) = peel_range(text);
    let core = text.get(start..end)?;
    (core.chars().all(char::is_alphabetic) && core.chars().next().is_some()).then_some(core)
}

fn apply_case(template: &str, lower: &str) -> String {
    match case_kind(template) {
        CaseKind::Upper => lower.chars().flat_map(char::to_uppercase).collect(),
        CaseKind::Title => title_case(lower),
        CaseKind::Empty | CaseKind::Lower | CaseKind::Mixed => lower.to_owned(),
    }
}

fn apply_multi(source: &str, from: &str, to: &str, occurrence: usize, out: &mut String) -> bool {
    let mut start = 0_usize;
    let mut seen = 0_usize;
    while seen <= occurrence {
        let Some(tail) = source.get(start..) else {
            return false;
        };
        let Some(found) = tail.find(from) else {
            return false;
        };
        if seen == occurrence {
            let at = start.saturating_add(found);
            out.clear();
            if let Some(head) = source.get(..at) {
                out.push_str(head);
            }
            out.push_str(to);
            let next = at.saturating_add(from.len());
            if let Some(rest) = source.get(next..) {
                out.push_str(rest);
            }
            return true;
        }
        seen = seen.saturating_add(1);
        start = start.saturating_add(found).saturating_add(1);
    }
    false
}

fn case_kind(text: &str) -> CaseKind {
    let mut first_upper = false;
    let mut letters: u16 = 0;
    let mut seen_letter = false;
    let mut uppers: u16 = 0;
    for ch in text.chars() {
        if !ch.is_alphabetic() {
            continue;
        }
        let upper = ch.is_uppercase();
        if !seen_letter {
            first_upper = upper;
            seen_letter = true;
        }
        letters = letters.saturating_add(1);
        if upper {
            uppers = uppers.saturating_add(1);
        }
    }
    if letters == 0 {
        CaseKind::Empty
    } else if uppers == letters {
        CaseKind::Upper
    } else if first_upper && uppers == 1 {
        CaseKind::Title
    } else if uppers == 0 {
        CaseKind::Lower
    } else {
        CaseKind::Mixed
    }
}

fn choose(hits: &[Hit], lexicon: &Lexicon, previous: Option<u32>, confidence: f32) -> Option<u32> {
    let mut best_id = 0_u32;
    let mut best_score = 0.0_f32;
    let mut ranked_hits = 0_u32;
    let mut second_score = 0.0_f32;
    for hit in hits {
        let bucket = lexicon.bucket(hit.word_id);
        if bucket < MIN_BUCKET {
            continue;
        }
        let ranked = score(
            hit.confidence,
            bucket,
            hit.cost,
            lexicon.bigram(previous, hit.word_id),
        );
        if ranked_hits == 0 || ranked > best_score {
            if ranked_hits > 0 {
                second_score = best_score;
            }
            best_score = ranked;
            best_id = hit.word_id;
        } else if ranked > second_score {
            second_score = ranked;
        }
        ranked_hits = ranked_hits.saturating_add(1);
    }
    let original = score(confidence, 0, 0, false);
    if ranked_hits == 0 || best_score <= original + MARGIN {
        return None;
    }
    if ranked_hits > 1 && best_score - second_score < GAP {
        return None;
    }
    Some(best_id)
}

fn collect_hits(lexicon: &Lexicon, scratch: &mut Scratch, word: &Word) {
    scratch.chars.clear();
    scratch.chars.extend(scratch.folded.chars());
    scratch.hits.clear();
    if scratch.chars.len() >= MIN_DIACRITIC_CHARS {
        lookup_form(
            lexicon,
            &scratch.folded,
            0,
            DIACRITIC_BUDGET,
            word.confidence,
            &mut scratch.stripped,
            &mut scratch.hits,
        );
    }
    if scratch.chars.len() >= MIN_CONFUSION_CHARS {
        push_substitutions(lexicon, scratch, word.confidence);
    }
    if scratch.chars.len() >= MIN_MULTI_CHARS {
        push_multis(lexicon, scratch, word.confidence);
    }
    for (alternative, confidence) in &word.alternatives {
        lexicon::fold_into(alternative, &mut scratch.variant);
        lookup_form(
            lexicon,
            &scratch.variant,
            0,
            DIACRITIC_BUDGET,
            *confidence,
            &mut scratch.stripped,
            &mut scratch.hits,
        );
    }
}

fn confusion_alts(ch: char) -> &'static [char] {
    match u32::from(ch) {
        0x0030 => &['o'],
        0x0031 | 0x007C => &['l', 'i'],
        0x0035 => &['s'],
        0x0038 => &['b'],
        0x0062 => &['8'],
        0x0063 => &['e'],
        0x0065 => &['c'],
        0x0069 => &['l', '1'],
        0x006C => &['i', '1'],
        0x006F => &['0'],
        0x0073 => &['5'],
        _ => &[],
    }
}

fn consider(hits: &mut Vec<Hit>, word_id: u32, cost: u16, confidence: f32) {
    if let Some(existing) = hits.iter_mut().find(|hit| hit.word_id == word_id) {
        let better_cost = cost < existing.cost;
        let same_cost_higher = cost == existing.cost && confidence > existing.confidence;
        if better_cost || same_cost_higher {
            existing.cost = cost;
            existing.confidence = confidence;
        }
        return;
    }
    hits.push(Hit {
        confidence,
        cost,
        word_id,
    });
}

#[cfg(test)]
fn dehyphen_hints(lines: &[Vec<Word>]) -> Vec<DehyphenHint> {
    let lexicon = Lexicon::get();
    let mut folded = String::new();
    let mut hints = Vec::new();
    let mut joined = String::new();
    for (line_index, line) in lines.iter().enumerate() {
        let Some(next_line) = lines.get(line_index.saturating_add(1)) else {
            continue;
        };
        let Some((word_index, left)) = hyphen_tail(line) else {
            continue;
        };
        let Some(right) = next_line
            .first()
            .and_then(|word| alphabetic_core(&word.text))
        else {
            continue;
        };
        joined.clear();
        joined.push_str(left);
        joined.push_str(right);
        lexicon::fold_into(&joined, &mut folded);
        let Some(word_id) = lexicon.exact_id(&folded) else {
            continue;
        };
        let Some(surface) = lexicon.word(word_id) else {
            continue;
        };
        hints.push(DehyphenHint {
            joined: apply_case(left, surface),
            line_index,
            word_index,
        });
    }
    hints
}

fn fill_variant(chars: &[char], index: usize, replacement: char, out: &mut String) {
    out.clear();
    for (cursor, ch) in chars.iter().copied().enumerate() {
        if cursor == index {
            out.push(replacement);
        } else {
            out.push(ch);
        }
    }
}

fn has_letter(text: &str) -> bool {
    text.chars().any(char::is_alphabetic)
}

fn has_money(text: &str) -> bool {
    text.contains("R$") || text.contains("r$")
}

fn has_odd_symbol(text: &str) -> bool {
    let mut digits: u8 = 0;
    for ch in text.chars() {
        if ch.is_alphabetic() {
            continue;
        }
        if is_confusable_digit(ch) {
            digits = digits.saturating_add(1);
            if digits > 1 {
                return true;
            }
            continue;
        }
        return true;
    }
    false
}

#[cfg(test)]
fn hyphen_core(text: &str) -> Option<&str> {
    let trimmed = text.trim_end_matches(['.', ',', ';', ':', '!', '?']);
    let stem = trimmed
        .strip_suffix('-')
        .or_else(|| trimmed.strip_suffix('\u{00AD}'))?;
    (stem.chars().all(char::is_alphabetic) && stem.chars().nth(1).is_some()).then_some(stem)
}

#[cfg(test)]
fn hyphen_tail(line: &[Word]) -> Option<(usize, &str)> {
    let word_index = line.len().checked_sub(1)?;
    let word = line.get(word_index)?;
    Some((word_index, hyphen_core(&word.text)?))
}

const fn is_confusable_digit(ch: char) -> bool {
    matches!(ch, '0' | '1' | '5' | '8')
}

fn is_email(text: &str) -> bool {
    let Some(at) = text.find('@') else {
        return false;
    };
    text.get(at.saturating_add(1)..)
        .is_some_and(|rest| rest.contains('.'))
}

fn is_protected(text: &str) -> bool {
    text.is_empty()
        || !has_letter(text)
        || is_roman(text)
        || is_email(text)
        || is_url(text)
        || has_money(text)
        || has_odd_symbol(text)
}

fn is_roman(text: &str) -> bool {
    let mut count: u16 = 0;
    for ch in text.chars() {
        if !"IVXLCDM".contains(ch.to_ascii_uppercase()) {
            return false;
        }
        count = count.saturating_add(1);
    }
    count >= ACRONYM_MIN
}

fn is_short_acronym(text: &str) -> bool {
    let mut letters: u16 = 0;
    for ch in text.chars() {
        if !ch.is_uppercase() {
            return false;
        }
        letters = letters.saturating_add(1);
    }
    (ACRONYM_MIN..=ACRONYM_MAX).contains(&letters)
}

fn is_url(text: &str) -> bool {
    starts_with_ignore_ascii(text, "http://")
        || starts_with_ignore_ascii(text, "https://")
        || starts_with_ignore_ascii(text, "www.")
}

fn lookup_form(
    lexicon: &Lexicon,
    form: &str,
    base_cost: u16,
    budget: u16,
    confidence: f32,
    stripped: &mut String,
    hits: &mut Vec<Hit>,
) {
    if let Some(word_id) = lexicon.exact_id(form) {
        consider(hits, word_id, base_cost, confidence);
        return;
    }
    lexicon::strip_into(form, stripped);
    for word_id in lexicon.stripped_ids(stripped) {
        let Some(extra) = lexicon.diacritic_cost(form, *word_id) else {
            continue;
        };
        let cost = base_cost.saturating_add(extra);
        if cost <= budget {
            consider(hits, *word_id, cost, confidence);
        }
    }
}

fn peel_range(text: &str) -> (usize, usize) {
    let bytes = text.as_bytes();
    let mut end = text.len();
    let mut start = 0_usize;
    while start < end {
        let Some(byte) = bytes.get(start).copied() else {
            break;
        };
        if is_leading_punct(byte) {
            start = start.saturating_add(1);
        } else {
            break;
        }
    }
    while end > start {
        let Some(byte) = bytes.get(end.saturating_sub(1)).copied() else {
            break;
        };
        if is_trailing_punct(byte) {
            end = end.saturating_sub(1);
        } else {
            break;
        }
    }
    (start, end)
}

const fn is_leading_punct(byte: u8) -> bool {
    matches!(byte, b'(' | b'[' | b'{' | b'"' | b'\'')
}

const fn is_trailing_punct(byte: u8) -> bool {
    matches!(
        byte,
        b'.' | b',' | b';' | b':' | b'!' | b'?' | b')' | b']' | b'}' | b'"' | b'\''
    )
}

fn plan(
    lexicon: &Lexicon,
    scratch: &mut Scratch,
    previous: Option<u32>,
    word: &Word,
    start: usize,
    end: usize,
) -> Plan {
    let Some(core) = word.text.get(start..end) else {
        return Plan::Keep(previous);
    };
    if core.is_empty() {
        return Plan::Keep(None);
    }
    lexicon::fold_into(core, &mut scratch.folded);
    let known = lexicon.exact_id(&scratch.folded);
    if is_protected(core) || word.confidence >= CONFIDENCE_THRESHOLD || known.is_some() {
        return Plan::Keep(known);
    }
    if is_short_acronym(core) {
        return Plan::Keep(None);
    }
    collect_hits(lexicon, scratch, word);
    let Some(chosen) = choose(&scratch.hits, lexicon, previous, word.confidence) else {
        return Plan::Keep(None);
    };
    let Some(surface) = lexicon.word(chosen) else {
        return Plan::Keep(None);
    };
    Plan::Replace(apply_case(core, surface), chosen)
}

fn push_multis(lexicon: &Lexicon, scratch: &mut Scratch, confidence: f32) {
    const PAIRS: &[(&str, &str)] = &[
        ("cl", "d"),
        ("d", "cl"),
        ("fi", "fl"),
        ("fl", "fi"),
        ("m", "rn"),
        ("rn", "m"),
    ];
    for (from, to) in PAIRS {
        let mut occurrence = 0_usize;
        while occurrence < MULTI_OCCURRENCES {
            let replaced = apply_multi(&scratch.folded, from, to, occurrence, &mut scratch.variant);
            if !replaced {
                break;
            }
            lookup_form(
                lexicon,
                &scratch.variant,
                MULTI_COST,
                CONFUSION_BUDGET,
                confidence,
                &mut scratch.stripped,
                &mut scratch.hits,
            );
            occurrence = occurrence.saturating_add(1);
        }
    }
    if replace_char(&scratch.folded, '\u{FB01}', "fi", &mut scratch.variant) {
        lookup_form(
            lexicon,
            &scratch.variant,
            MULTI_COST,
            CONFUSION_BUDGET,
            confidence,
            &mut scratch.stripped,
            &mut scratch.hits,
        );
    }
    if replace_char(&scratch.folded, '\u{FB02}', "fl", &mut scratch.variant) {
        lookup_form(
            lexicon,
            &scratch.variant,
            MULTI_COST,
            CONFUSION_BUDGET,
            confidence,
            &mut scratch.stripped,
            &mut scratch.hits,
        );
    }
}

fn push_substitutions(lexicon: &Lexicon, scratch: &mut Scratch, confidence: f32) {
    let mut index = 0_usize;
    while index < scratch.chars.len() {
        let Some(ch) = scratch.chars.get(index).copied() else {
            break;
        };
        for replacement in confusion_alts(ch) {
            fill_variant(&scratch.chars, index, *replacement, &mut scratch.variant);
            lookup_form(
                lexicon,
                &scratch.variant,
                SUB_COST,
                CONFUSION_BUDGET,
                confidence,
                &mut scratch.stripped,
                &mut scratch.hits,
            );
        }
        index = index.saturating_add(1);
    }
}

fn replace_char(source: &str, target: char, to: &str, out: &mut String) -> bool {
    if !source.contains(target) {
        return false;
    }
    out.clear();
    for ch in source.chars() {
        if ch == target {
            out.push_str(to);
        } else {
            out.push(ch);
        }
    }
    true
}

fn replace_span(text: &mut String, start: usize, end: usize, middle: &str) {
    let mut rebuilt = String::new();
    if let Some(prefix) = text.get(..start) {
        rebuilt.push_str(prefix);
    }
    rebuilt.push_str(middle);
    if let Some(suffix) = text.get(end..) {
        rebuilt.push_str(suffix);
    }
    *text = rebuilt;
}

fn score(confidence: f32, bucket: u8, cost: u16, bigram: bool) -> f32 {
    let context = if bigram { BIGRAM_BONUS } else { 0.0_f32 };
    let frequency = f32::from(bucket) * FREQ_SCALE;
    let penalty = f32::from(cost) * COST_SCALE;
    confidence + frequency + context - penalty
}

fn starts_with_ignore_ascii(text: &str, prefix: &str) -> bool {
    let mut chars = text.chars();
    for expected in prefix.chars() {
        let Some(found) = chars.next() else {
            return false;
        };
        if found.to_ascii_lowercase() != expected {
            return false;
        }
    }
    true
}

fn step(
    lexicon: &Lexicon,
    scratch: &mut Scratch,
    previous: Option<u32>,
    word: &mut Word,
) -> Option<u32> {
    let (start, end) = peel_range(&word.text);
    match plan(lexicon, scratch, previous, word, start, end) {
        Plan::Keep(word_id) => word_id,
        Plan::Replace(styled, word_id) => {
            replace_span(&mut word.text, start, end, &styled);
            Some(word_id)
        }
    }
}

fn title_case(lower: &str) -> String {
    let mut chars = lower.chars();
    let Some(first) = chars.next() else {
        return String::new();
    };
    let mut out = String::new();
    for ch in first.to_uppercase() {
        out.push(ch);
    }
    out.extend(chars);
    out
}

#[cfg(test)]
mod tests {
    use core::time::Duration;
    use std::fs;
    use std::time::Instant;

    use super::{
        CONFIDENCE_THRESHOLD, DehyphenHint, apply_case, correct, correct_lines, is_protected,
    };
    use crate::lexicon::{self, Lexicon};
    use crate::recognize::Word;

    const CLEAN_CONFIDENCE: f32 = 0.875_f32;
    const LOW_CONFIDENCE: f32 = 0.375_f32;
    const PAGE_WORDS: usize = 400;

    struct Lcg {
        state: u32,
    }

    impl Lcg {
        const fn new(seed: u32) -> Self {
            Self { state: seed }
        }

        fn next(&mut self) -> u32 {
            self.state = self
                .state
                .wrapping_mul(1_664_525)
                .wrapping_add(1_013_904_223);
            self.state
        }
    }

    fn confuse(text: &str) -> String {
        let mut changed = false;
        let mut out = String::new();
        for ch in text.chars() {
            if changed {
                out.push(ch);
                continue;
            }
            match u32::from(ch) {
                0x0042 | 0x0062 => {
                    out.push('8');
                    changed = true;
                }
                0x0045 | 0x0065 => {
                    out.push('c');
                    changed = true;
                }
                0x0049 | 0x0069 | 0x004C | 0x006C => {
                    out.push('1');
                    changed = true;
                }
                0x004D | 0x006D => {
                    out.push_str("rn");
                    changed = true;
                }
                0x004F | 0x006F => {
                    out.push('0');
                    changed = true;
                }
                0x0053 | 0x0073 => {
                    out.push('5');
                    changed = true;
                }
                _ => out.push(ch),
            }
        }
        if changed { out } else { text.to_owned() }
    }

    fn deaccent(text: &str) -> String {
        let mut folded = String::new();
        let mut stripped = String::new();
        lexicon::fold_into(text, &mut folded);
        lexicon::strip_into(&folded, &mut stripped);
        apply_case(text, &stripped)
    }

    fn long_word() -> Option<String> {
        let lexicon = Lexicon::get();
        let mut index = 0_usize;
        while index < lexicon.len() {
            let word_id = u32::try_from(index).unwrap_or(u32::MAX);
            let Some(surface) = lexicon.word(word_id) else {
                break;
            };
            if surface.chars().nth(7).is_some() && lexicon.bucket(word_id) >= 4 {
                return Some(surface.to_owned());
            }
            index = index.saturating_add(1);
        }
        None
    }

    fn sample(text: &str, confidence: f32) -> Word {
        Word {
            alternatives: Vec::new(),
            bbox: [0, 0, 10, 10],
            confidence,
            text: text.to_owned(),
        }
    }

    fn wrap_index(index: usize, len: usize) -> usize {
        if len == 0 {
            return 0;
        }
        let mut cursor = index;
        while cursor >= len {
            cursor = cursor.saturating_sub(len);
        }
        cursor
    }

    #[test]
    fn clean_high_confidence_text_is_unchanged() {
        let lexicon = Lexicon::get();
        assert!(
            lexicon.len() > 1_000,
            "lexicon.bin is still the sample table; run build-lexicon.ts"
        );
        let heldout = include_str!("../data/lexicon-heldout.txt");
        let mut changed = 0_u32;
        let mut total = 0_u32;
        for line in heldout
            .lines()
            .filter(|line| !line.is_empty() && *line != "placeholder")
        {
            let originals: Vec<&str> = line.split_whitespace().collect();
            let mut words: Vec<Word> = originals
                .iter()
                .map(|token| sample(token, CLEAN_CONFIDENCE))
                .collect();
            correct(&mut words);
            for (before, after) in originals.iter().zip(words.iter()) {
                total = total.saturating_add(1);
                if before != &after.text {
                    changed = changed.saturating_add(1);
                }
            }
        }
        assert!(total > 0, "held-out sentences were not generated");
        assert_eq!(
            changed, 0,
            "false corrections at high confidence: {changed}/{total}"
        );
    }

    #[test]
    fn correction_beats_five_milliseconds_per_page_in_release() {
        let lexicon = Lexicon::get();
        assert!(
            lexicon.len() > 1_000,
            "lexicon.bin is still the sample table"
        );
        let mut warmup = page(PAGE_WORDS);
        correct(&mut warmup);
        let mut words = page(PAGE_WORDS);
        let started = Instant::now();
        correct(&mut words);
        let elapsed = started.elapsed();
        let speed_path = if cfg!(debug_assertions) {
            "/tmp/ocr-lexicon-speed-debug.txt"
        } else {
            "/tmp/ocr-lexicon-speed.txt"
        };
        fs::write(
            speed_path,
            format!(
                "elapsed_us={} words={PAGE_WORDS} debug={}\n",
                elapsed.as_micros(),
                cfg!(debug_assertions)
            ),
        )
        .unwrap();
        let limit = if cfg!(debug_assertions) {
            Duration::from_millis(50)
        } else {
            Duration::from_millis(5)
        };
        assert!(
            elapsed < limit,
            "page of {PAGE_WORDS} words took {elapsed:?}, limit {limit:?}"
        );
    }

    #[test]
    fn dehyphenates_when_the_joined_word_is_known() {
        let Some(surface) = long_word() else {
            panic!("lexicon has no long word");
        };
        let mut left = String::new();
        let mut right = String::new();
        for (index, ch) in surface.chars().enumerate() {
            if index < 4 {
                left.push(ch);
            } else {
                right.push(ch);
            }
        }
        left.push('-');
        let mut lines = vec![
            vec![sample(&left, CLEAN_CONFIDENCE)],
            vec![sample(&right, CLEAN_CONFIDENCE)],
        ];
        let hints = correct_lines(&mut lines);
        assert_eq!(
            hints,
            vec![DehyphenHint {
                joined: surface,
                line_index: 0,
                word_index: 0,
            }]
        );
        assert!(lines[0][0].text.ends_with('-'));
    }

    #[test]
    fn injected_errors_drop_and_clean_low_confidence_stays_rare() {
        let lexicon = Lexicon::get();
        assert!(
            lexicon.len() > 1_000,
            "lexicon.bin is still the sample table"
        );
        let heldout = include_str!("../data/lexicon-heldout.txt");
        let mut rng = Lcg::new(0x0C04_u32);
        let mut clean_changes = 0_u32;
        let mut clean_total = 0_u32;
        let mut injected = 0_u32;
        let mut injected_left = 0_u32;
        let mut tokens = 0_u32;
        for line in heldout
            .lines()
            .filter(|line| !line.is_empty() && *line != "placeholder")
        {
            let originals: Vec<&str> = line.split_whitespace().collect();
            let mut noisy = Vec::new();
            let mut clean = Vec::new();
            let mut noisy_flags = Vec::new();
            for token in &originals {
                clean.push(sample(token, LOW_CONFIDENCE));
                let corrupt = eligible(token) && rng.next().trailing_zeros() >= 3;
                if !corrupt {
                    noisy.push(sample(token, CLEAN_CONFIDENCE));
                    noisy_flags.push(false);
                    continue;
                }
                let mode_accent = rng.next() & 1 == 0;
                let edited = if mode_accent {
                    deaccent(token)
                } else {
                    confuse(token)
                };
                let changed = edited != *token;
                noisy.push(sample(
                    &edited,
                    if changed {
                        LOW_CONFIDENCE
                    } else {
                        CLEAN_CONFIDENCE
                    },
                ));
                noisy_flags.push(changed);
            }
            correct(&mut clean);
            for (before, after) in originals.iter().zip(clean.iter()) {
                clean_total = clean_total.saturating_add(1);
                if before != &after.text {
                    clean_changes = clean_changes.saturating_add(1);
                }
            }
            correct(&mut noisy);
            for ((before, after), flag) in originals.iter().zip(noisy.iter()).zip(noisy_flags) {
                tokens = tokens.saturating_add(1);
                if !flag {
                    continue;
                }
                injected = injected.saturating_add(1);
                if before != &after.text {
                    injected_left = injected_left.saturating_add(1);
                }
            }
        }
        assert!(tokens > 0, "held-out sentences were not generated");
        let false_rate = f64::from(clean_changes) / f64::from(clean_total.max(1));
        let before_rate = f64::from(injected) / f64::from(tokens.max(1));
        let after_rate = f64::from(injected_left) / f64::from(tokens.max(1));
        let report = format!(
            "tokens={tokens} injected={injected} injected_left={injected_left} wer_before={before_rate:.6} wer_after={after_rate:.6} clean_low_changes={clean_changes} clean_low_total={clean_total} false_rate={false_rate:.6} threshold={CONFIDENCE_THRESHOLD}\n"
        );
        fs::write("/tmp/ocr-lexicon-metrics.txt", report).unwrap();
        assert!(
            injected > 20,
            "not enough injected errors to measure WER: {injected}"
        );
        assert!(
            injected_left < injected,
            "correction did not reduce injected errors: {injected_left}/{injected}"
        );
        assert!(
            false_rate < 0.02_f64,
            "low-confidence false-correction rate {false_rate} on clean held-out text"
        );
    }

    #[test]
    fn protected_tokens_and_short_acronyms_stay() {
        let samples = [
            "12.345.678/0001-95",
            "123.456.789-09",
            "01310-100",
            "31/12/2024",
            "2024-12-31",
            "R$1.234,56",
            "1.234,56",
            "1.2.3",
            "XIV",
            "MMXXVI",
            "user@example.com",
            "https://example.com/edital",
            "www.licitei.com",
            "PNCP",
            "TRT",
        ];
        let mut words: Vec<Word> = samples
            .into_iter()
            .map(|token| sample(token, 0.062_5_f32))
            .collect();
        correct(&mut words);
        for (before, after) in samples.into_iter().zip(words.iter()) {
            assert_eq!(before, after.text);
        }
        let protected = include_str!("../data/lexicon-protected.txt");
        for token in protected.lines().filter(|line| !line.is_empty()) {
            assert!(
                is_protected(token)
                    || token.chars().all(char::is_uppercase) && token.chars().count() <= 6,
                "{token}"
            );
            let mut token_words = [sample(token, 0.062_5_f32)];
            correct(&mut token_words);
            assert_eq!(token_words[0].text, token);
        }
    }

    #[test]
    fn restores_a_frequent_accented_word() {
        let lexicon = Lexicon::get();
        let mut index = 0_usize;
        let mut restored = false;
        while index < lexicon.len() {
            let word_id = u32::try_from(index).unwrap_or(u32::MAX);
            let Some(surface) = lexicon.word(word_id) else {
                break;
            };
            let owned = surface.to_owned();
            index = index.saturating_add(1);
            if lexicon.bucket(word_id) < 4 || owned.is_ascii() {
                continue;
            }
            let broken = deaccent(&owned);
            if broken == owned {
                continue;
            }
            let mut words = [sample(&broken, LOW_CONFIDENCE)];
            correct(&mut words);
            if words[0].text == owned {
                restored = true;
                break;
            }
        }
        assert!(restored, "no frequent accented lexicon word was restored");
    }

    fn eligible(token: &str) -> bool {
        !is_protected(token)
            && token.chars().nth(3).is_some()
            && token.chars().all(char::is_alphabetic)
    }

    fn page(count: usize) -> Vec<Word> {
        let lexicon = Lexicon::get();
        let mut words = Vec::new();
        let mut index = 0_usize;
        while words.len() < count {
            let word_id = u32::try_from(wrap_index(index, lexicon.len())).unwrap_or(0);
            let Some(surface) = lexicon.word(word_id) else {
                break;
            };
            if index.trailing_zeros() >= 2 {
                words.push(sample(&deaccent(surface), LOW_CONFIDENCE));
            } else {
                words.push(sample(surface, CLEAN_CONFIDENCE));
            }
            index = index.saturating_add(1);
        }
        words
    }
}
