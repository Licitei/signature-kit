use crate::inspection::LinkInfo;
use crate::num::f64_to_usize;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StyleSpan {
    text: String,
    bold: bool,
    italic: bool,
}

pub(crate) struct ParagraphFinish<'a> {
    pub size: f64,
    pub body_size: f64,
    pub indent_em: f64,
    pub bbox: [f64; 4],
    pub links: &'a [LinkInfo],
}

pub(crate) fn median_body_size(sizes: &[f64]) -> f64 {
    if sizes.is_empty() {
        return 10.0;
    }
    let mut sorted = sizes.to_vec();
    sorted.sort_by(f64::total_cmp);
    let mid = sorted.len().div_ceil(2).saturating_sub(1);
    sorted.get(mid).copied().unwrap_or(10.0)
}

fn escape_markdown(text: &str, out: &mut String) {
    for ch in text.chars() {
        match ch {
            '\\' | '`' | '*' | '_' | '[' | ']' | '(' | ')' | '#' | '|' => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
}

pub(crate) fn spans_from_runs(members: &[(String, f64, f64, f64, bool, bool)]) -> Vec<StyleSpan> {
    let mut spans: Vec<StyleSpan> = Vec::new();
    let mut right_edge: Option<f64> = None;
    for (run_text, x0, x1, size, bold, italic) in members {
        if let Some(edge) = right_edge {
            let gap = x0 - edge;
            let boundary = spans
                .last()
                .and_then(|span| span.text.chars().next_back())
                .is_none_or(char::is_whitespace)
                || run_text.chars().next().is_none_or(char::is_whitespace);
            if gap > 0.12 * size
                && !boundary
                && let Some(last) = spans.last_mut()
                && !last.text.ends_with(' ')
            {
                last.text.push(' ');
            }
        }
        let style = (*bold, *italic);
        if let Some(last) = spans.last_mut()
            && (last.bold, last.italic) == style
        {
            last.text.push_str(run_text);
            right_edge = Some(right_edge.map_or(*x1, |e: f64| e.max(*x1)));
            continue;
        }
        spans.push(StyleSpan {
            text: run_text.clone(),
            bold: *bold,
            italic: *italic,
        });
        right_edge = Some(*x1);
    }
    spans
}

fn spans_to_plain(spans: &[StyleSpan]) -> String {
    spans.iter().fold(String::new(), |mut out, span| {
        out.push_str(&span.text);
        out
    })
}

fn spans_to_markdown(spans: &[StyleSpan]) -> String {
    let mut out = String::new();
    for span in spans {
        let trimmed = span.text.trim();
        if trimmed.is_empty() {
            continue;
        }
        let mut escaped = String::new();
        escape_markdown(trimmed, &mut escaped);
        let decorated = if span.bold && span.italic {
            format!("***{escaped}***")
        } else if span.bold {
            format!("**{escaped}**")
        } else if span.italic {
            format!("*{escaped}*")
        } else {
            escaped
        };
        if !out.is_empty()
            && !out.ends_with(' ')
            && !span.text.starts_with(char::is_whitespace)
            && out.chars().next_back().is_none_or(|ch| !ch.is_whitespace())
        {
            out.push(' ');
        }
        out.push_str(&decorated);
    }
    out.trim().to_owned()
}

const HYPHEN_PARTICLES: [&str; 7] = ["de-", "da-", "do-", "das ", "dos ", "e ", "em-"];

fn continues_with_particle(text: &str) -> bool {
    HYPHEN_PARTICLES
        .iter()
        .any(|particle| text.starts_with(particle) || text.starts_with(particle.trim_end()))
}

pub(crate) fn soft_hyphen_join(left: &str, right: &str) -> String {
    let left_trim = left.trim_end();
    let right_trim = right.trim_start();
    let Some(stem) = left_trim.strip_suffix('-') else {
        return format!("{left_trim} {right_trim}");
    };
    if !right_trim
        .chars()
        .next()
        .is_some_and(|ch| ch.is_lowercase() || ch == 'ç' || ch == 'ã' || ch == 'õ')
    {
        return format!("{left_trim} {right_trim}");
    }
    if stem.contains('-') || continues_with_particle(right_trim) {
        format!("{stem}-{right_trim}")
    } else {
        format!("{stem}{right_trim}")
    }
}

fn ends_sentence(text: &str) -> bool {
    let trimmed = text.trim_end();
    trimmed
        .chars()
        .last()
        .is_some_and(|ch| matches!(ch, '.' | '!' | '?' | ':' | ';'))
}

fn should_reflow_line(prev_plain: &str, next_plain: &str) -> bool {
    if prev_plain.is_empty() || next_plain.is_empty() || ends_sentence(prev_plain) {
        return false;
    }
    if prev_plain.trim_end().ends_with('-') {
        return true;
    }
    next_plain
        .chars()
        .next()
        .is_some_and(|ch| ch.is_lowercase() || matches!(ch, ',' | ';'))
}

fn merge_reflowed_lines(acc: &mut Vec<StyleSpan>, next_line: &[StyleSpan]) {
    let prev_plain = spans_to_plain(acc);
    let next_plain = spans_to_plain(next_line);
    if prev_plain.trim_end().ends_with('-') {
        let joined = soft_hyphen_join(&prev_plain, &next_plain);
        let bold = acc.iter().all(|span| span.bold) && next_line.iter().all(|span| span.bold);
        let italic = acc.iter().all(|span| span.italic) && next_line.iter().all(|span| span.italic);
        *acc = vec![StyleSpan {
            text: joined,
            bold,
            italic,
        }];
        return;
    }
    if let Some(last) = acc.last_mut() {
        if !last.text.ends_with(' ') {
            last.text.push(' ');
        }
        acc.extend_from_slice(next_line);
    } else {
        *acc = next_line.to_vec();
    }
}

pub(crate) fn reflow_spans(mut lines: Vec<Vec<StyleSpan>>) -> Vec<StyleSpan> {
    let Some(mut first) = lines.first_mut().map(std::mem::take) else {
        return Vec::new();
    };
    for next_line in lines.into_iter().skip(1) {
        let prev_plain = spans_to_plain(&first);
        let next_plain = spans_to_plain(&next_line);
        if should_reflow_line(&prev_plain, &next_plain) {
            merge_reflowed_lines(&mut first, &next_line);
        } else if let Some(last) = first.last_mut() {
            last.text.push('\n');
            first.extend(next_line);
        } else {
            first = next_line;
        }
    }
    first
}

fn mostly_uppercase(text: &str) -> bool {
    let mut letters = 0_u32;
    let mut upper = 0_u32;
    for ch in text.chars().filter(|ch| ch.is_alphabetic()) {
        letters = letters.saturating_add(1);
        if ch.is_uppercase() {
            upper = upper.saturating_add(1);
        }
    }
    letters >= 4 && upper.saturating_mul(2) >= letters.saturating_mul(3)
}

fn legal_clause_prefix(text: &str) -> bool {
    let trimmed = text.trim_start();
    let mut digits = 0_usize;
    let mut dots = 0_usize;
    for ch in trimmed.chars() {
        if ch.is_ascii_digit() {
            digits = digits.saturating_add(1);
        } else if ch == '.' {
            dots = dots.saturating_add(1);
        } else {
            break;
        }
    }
    dots >= 2 && digits > 0
}

pub(crate) fn heading_level(text: &str, size: f64, body: f64) -> Option<u8> {
    if legal_clause_prefix(text) {
        return None;
    }
    let ratio = size / body.max(1e-3);
    let numbered = text
        .trim_start()
        .chars()
        .next()
        .is_some_and(|ch| ch.is_ascii_digit());
    if ratio >= 1.5 || (numbered && ratio >= 1.2) {
        return Some(if ratio >= 1.85 {
            1
        } else if ratio >= 1.25 {
            2
        } else {
            3
        });
    }
    if mostly_uppercase(text) && text.chars().count() <= 96 && ratio >= 1.05 {
        return Some(2);
    }
    None
}

const BULLETS: [char; 6] = ['•', '●', '▪', '-', '–', '—'];

fn marker_depth_from_indent(text: &str, trimmed: &str) -> u32 {
    let leading = text.len().saturating_sub(trimmed.len());
    u32::try_from(leading.div_ceil(4).saturating_add(1)).unwrap_or(u32::MAX)
}

fn list_marker(text: &str) -> Option<(u32, char)> {
    let trimmed = text.trim_start();
    if trimmed.is_empty() || legal_clause_prefix(trimmed) {
        return None;
    }
    if let Some(ch) = trimmed.chars().next()
        && BULLETS.contains(&ch)
    {
        return Some((marker_depth_from_indent(text, trimmed), ch));
    }
    let bytes = trimmed.as_bytes();
    let mut index = 0_usize;
    while bytes.get(index).is_some_and(u8::is_ascii_digit) {
        index = index.saturating_add(1);
    }
    if index > 0
        && bytes.get(index) == Some(&b'.')
        && bytes
            .get(index.saturating_add(1))
            .is_some_and(|byte| *byte == b' ')
    {
        return Some((marker_depth_from_indent(text, trimmed), 'n'));
    }
    let first = trimmed.chars().next()?;
    let second = trimmed.chars().nth(1)?;
    let third = trimmed.chars().nth(2)?;
    if third == ' ' && second == ')' && first.is_ascii_alphabetic() {
        return Some((1, 'a'));
    }
    None
}

pub(crate) fn list_line(markdown: &str, indent_em: f64) -> Option<(u32, String)> {
    let (marker_depth, kind) = list_marker(markdown)?;
    let trimmed = markdown.trim_start();
    let content = if kind == 'n' {
        trimmed
            .split_once(". ")
            .map_or(trimmed, |(_, rest)| rest)
            .to_owned()
    } else if BULLETS.contains(&kind) {
        trimmed
            .chars()
            .skip(1)
            .collect::<String>()
            .trim_start()
            .to_owned()
    } else if kind == 'a' {
        trimmed
            .chars()
            .skip(3)
            .collect::<String>()
            .trim_start()
            .to_owned()
    } else {
        trimmed.to_owned()
    };
    let nesting = u32::try_from(f64_to_usize(indent_em.max(0.0).round())).unwrap_or(0);
    let depth = marker_depth.saturating_add(nesting);
    Some((depth, content))
}

pub(crate) fn link_overlays(plain: &str, bbox: [f64; 4], links: &[LinkInfo]) -> String {
    let mut hit: Option<&LinkInfo> = None;
    for link in links {
        if link.uri.is_empty() {
            continue;
        }
        let [lx0, ly0, lx1, ly1] = link.rect;
        let overlap_x = bbox[0].max(lx0) < bbox[2].min(lx1);
        let overlap_y = bbox[1].max(ly0) < bbox[3].min(ly1);
        if overlap_x && overlap_y {
            hit = Some(link);
            break;
        }
    }
    let Some(link) = hit else {
        return plain.to_owned();
    };
    if plain.contains(&link.uri) {
        return plain.to_owned();
    }
    let mut escaped_label = String::new();
    escape_markdown(plain.trim(), &mut escaped_label);
    format!("[{escaped_label}]({})", link.uri)
}

pub(crate) fn finish_paragraph(merged: &[StyleSpan], ctx: &ParagraphFinish<'_>) -> String {
    let plain = spans_to_plain(merged);
    let markdown_body = spans_to_markdown(merged);
    if let Some(level) = heading_level(&plain, ctx.size, ctx.body_size) {
        let hashes = "#".repeat(usize::from(level));
        return format!("{hashes} {markdown_body}");
    }
    if let Some((depth, content)) = list_line(&plain, ctx.indent_em) {
        let indent = "  ".repeat(usize::try_from(depth.saturating_sub(1)).unwrap_or(0));
        return format!("{indent}- {content}");
    }
    link_overlays(&markdown_body, ctx.bbox, ctx.links)
}

pub(crate) fn merge_page_continuation(tail: &str, head: &str) -> Option<String> {
    if tail.is_empty() || head.is_empty() || !should_reflow_line(tail, head) {
        return None;
    }
    let joined = if tail.trim_end().ends_with('-') {
        soft_hyphen_join(tail, head)
    } else {
        format!("{} {}", tail.trim_end(), head.trim_start())
    };
    Some(joined)
}

pub(crate) fn take_continuation_tail(page: &str) -> Option<(String, String)> {
    let (prefix, last) = match page.rsplit_once("\n\n") {
        Some((head, tail)) => (head.to_owned(), tail.trim().to_owned()),
        None => (String::new(), page.trim().to_owned()),
    };
    if last.is_empty() || ends_sentence(&last) {
        return None;
    }
    Some((last, prefix))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn soft_hyphen_joins_syllables_and_compounds() {
        assert_eq!(soft_hyphen_join("administra-", "tivo"), "administrativo");
        assert_eq!(soft_hyphen_join("mão-", "de-obra"), "mão-de-obra");
    }

    #[test]
    fn heading_levels_follow_size() {
        assert_eq!(heading_level("1. INFOS", 14.0, 10.0), Some(2));
        assert_eq!(heading_level("1.1. Cláusula", 10.0, 10.0), None);
    }

    #[test]
    fn escape_markdown_characters() {
        let mut out = String::new();
        escape_markdown("a|b", &mut out);
        assert_eq!(out, "a\\|b");
    }
}
