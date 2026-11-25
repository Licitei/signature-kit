use core::{cell::RefCell, iter::from_fn, mem};
use signature_kit_font::sfnt::Face;
use signature_kit_pdf_core::failure::{Failure, Outcome};
use std::collections::HashMap;

use crate::spec::{Run, Style, TextStyle};

#[derive(Clone, Copy, Debug)]
pub(crate) enum Symbol {
    Character(char),
    Counter(u32),
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Letter {
    pub(crate) advance: f64,
    pub(crate) glyph: u16,
    pub(crate) kern: f64,
    pub(crate) style: TextStyle,
    pub(crate) symbol: Symbol,
}

#[derive(Debug, Default)]
pub(crate) struct Line {
    pub(crate) alignment: u8,
    pub(crate) height: f64,
    pub(crate) letters: Vec<Letter>,
    pub(crate) offset: f64,
    pub(crate) size: f64,
    pub(crate) stretch: f64,
    pub(crate) width: f64,
}

impl Line {
    pub(crate) fn baseline(&self) -> f64 {
        (self.height - self.size) * 0.5_f64 + self.size * 0.81_f64
    }
}

#[derive(Debug)]
pub(crate) struct FontMetrics<'face, 'data> {
    face: &'face Face<'data>,
    glyphs: RefCell<HashMap<char, (u16, f64)>>,
    pairs: RefCell<HashMap<(u16, u16), f64>>,
}

impl<'face, 'data> FontMetrics<'face, 'data> {
    fn character(&self, character: char) -> Outcome<(u16, f64)> {
        let mut glyphs = self.glyphs.borrow_mut();
        if let Some(&metrics) = glyphs.get(&character) {
            return Ok(metrics);
        }
        let index = glyph(self.face, character)?;
        let width = self
            .face
            .width(index)
            .ok_or_else(|| Failure::request("Missing glyph width"))?;
        if glyphs.len() < 8_192 {
            let _previous = glyphs.insert(character, (index, width));
        }
        Ok((index, width))
    }

    fn kern(&self, left: u16, right: u16) -> f64 {
        let mut pairs = self.pairs.borrow_mut();
        if let Some(&kern) = pairs.get(&(left, right)) {
            return kern;
        }
        let kern = self.face.kern(left, right);
        if pairs.len() < 8_192 {
            let _previous = pairs.insert((left, right), kern);
        }
        kern
    }

    pub(crate) fn new(face: &'face Face<'data>) -> Self {
        Self {
            face,
            glyphs: RefCell::default(),
            pairs: RefCell::default(),
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum Token {
    Break,
    Letter(TextStyle, Symbol),
    Soft,
}

fn tokens<'run>(runs: &'run [Run<'run>]) -> impl Iterator<Item = Token> + 'run {
    runs.iter().flat_map(|run| {
        let mut chars = run.text.chars().peekable();
        let mut control = (run.kind != 0).then_some(run.kind);
        from_fn(move || {
            if let Some(kind) = control.take() {
                return Some(match kind {
                    1 => Token::Break,
                    2 => Token::Soft,
                    _ => Token::Letter(run.style, Symbol::Counter(u32::from(kind))),
                });
            }
            chars.next().map(|character| match character {
                '\r' => {
                    if chars.peek() == Some(&'\n') {
                        let _next: Option<char> = chars.next();
                    }
                    Token::Break
                }
                '\n' => Token::Break,
                '\u{200B}' | '\u{00AD}' => Token::Soft,
                _ => Token::Letter(run.style, Symbol::Character(character)),
            })
        })
    })
}

pub(crate) fn glyph(face: &Face<'_>, character: char) -> Outcome<u16> {
    face.glyph(character).ok_or_else(|| {
        Failure::request(format!(
            "Font has no glyph for U+{:04X}",
            u32::from(character)
        ))
    })
}

fn add_letter(
    line: &mut Line,
    fonts: &[FontMetrics<'_, '_>],
    style: TextStyle,
    symbol: Symbol,
) -> Outcome<()> {
    let font = fonts
        .get(style.face)
        .ok_or_else(|| Failure::request("Unknown font face"))?;
    let (glyph, width) = match symbol {
        Symbol::Character(character) => font.character(character)?,
        Symbol::Counter(_) => {
            let (glyph, width) = font.character('0')?;
            (glyph, width * 4.0_f64)
        }
    };
    let kern = line.letters.last().map_or(0.0_f64, |previous| {
        if previous.style == style
            && matches!(previous.symbol, Symbol::Character(_))
            && matches!(symbol, Symbol::Character(_))
        {
            font.kern(previous.glyph, glyph) * style.size / 1_000.0_f64
        } else {
            0.0_f64
        }
    });
    let advance = width * style.size / 1_000.0_f64 + style.tracking;
    line.width += advance + kern;
    line.size = line.size.max(style.size);
    line.letters.push(Letter {
        advance,
        glyph,
        kern,
        style,
        symbol,
    });
    Ok(())
}

fn split_at(line: &mut Line, index: usize) -> Vec<Letter> {
    let rest = line.letters.split_off(index.min(line.letters.len()));
    while line
        .letters
        .last()
        .is_some_and(|letter| matches!(letter.symbol, Symbol::Character(' ')))
    {
        let _removed: Option<Letter> = line.letters.pop();
    }
    line.width = line
        .letters
        .iter()
        .map(|letter| letter.advance + letter.kern)
        .sum();
    line.size = line
        .letters
        .iter()
        .fold(0.0_f64, |size, letter| size.max(letter.style.size));
    rest
}

fn finish(mut line: Line, style: &Style, width: f64, wrapped: bool) -> Line {
    line.alignment = style.text_align;
    line.height = line.size.max(11.0) * style.line_height;
    let free = (width - line.width).max(0.0);
    match style.text_align {
        1 => line.offset = free * 0.5_f64,
        2 => line.offset = free,
        3 if wrapped => {
            let spaces = line
                .letters
                .iter()
                .filter(|letter| matches!(letter.symbol, Symbol::Character(' ')))
                .count();
            if let Ok(count) = u32::try_from(spaces)
                && count > 0
            {
                line.stretch = free / f64::from(count);
            }
        }
        _ => {}
    }
    line
}

pub(crate) fn lines(
    fonts: &[FontMetrics<'_, '_>],
    runs: &[Run<'_>],
    style: &Style,
    width: f64,
) -> Outcome<Vec<Line>> {
    let mut lines = Vec::new();
    let mut line = Line::default();
    let mut edge = 0_usize;
    for token in tokens(runs) {
        match token {
            Token::Break => {
                drop(split_at(&mut line, usize::MAX));
                lines.push(finish(mem::take(&mut line), style, width, false));
                edge = 0;
            }
            Token::Soft => edge = line.letters.len(),
            Token::Letter(text_style, symbol) => {
                if line.letters.is_empty() && matches!(symbol, Symbol::Character(' ')) {
                    continue;
                }
                add_letter(&mut line, fonts, text_style, symbol)?;
                if matches!(symbol, Symbol::Character(' ' | '-' | '\u{2010}' | '/')) {
                    edge = line.letters.len();
                }
                if line.width > width && line.letters.len() > 1 {
                    if edge == 0 {
                        edge = line.letters.len().saturating_sub(1);
                    }
                    let rest = split_at(&mut line, edge);
                    lines.push(finish(mem::take(&mut line), style, width, true));
                    edge = 0;
                    for letter in rest {
                        add_letter(&mut line, fonts, letter.style, letter.symbol)?;
                    }
                }
            }
        }
    }
    if !line.letters.is_empty()
        || lines.is_empty()
        || runs
            .last()
            .is_some_and(|run| run.kind == 1 || run.text.ends_with('\n'))
    {
        drop(split_at(&mut line, usize::MAX));
        lines.push(finish(line, style, width, false));
    }
    Ok(lines)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_preserve_nonbreaking_spaces_and_explicit_breaks() {
        let style = TextStyle {
            color: 0,
            face: 0,
            size: 11.0,
            tracking: 0.0,
        };
        let runs = [Run {
            kind: 0,
            style,
            text: "a\u{A0}b\u{AD}c\nd",
        }];
        assert!(matches!(
            tokens(&runs).nth(1),
            Some(Token::Letter(_, Symbol::Character('\u{A0}')))
        ));
        assert!(matches!(tokens(&runs).nth(3), Some(Token::Soft)));
        assert!(matches!(tokens(&runs).nth(5), Some(Token::Break)));
    }
}
