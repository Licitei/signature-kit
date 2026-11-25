use core::{iter::repeat_with, str};
use signature_kit_pdf_core::failure::{Failure, Outcome};

#[derive(Debug)]
pub(crate) struct Document<'data> {
    pub(crate) fonts: Vec<u32>,
    pub(crate) images: Vec<u32>,
    pub(crate) metadata: [&'data str; 3],
    pub(crate) sections: Vec<Section<'data>>,
}

#[derive(Debug)]
pub(crate) struct Section<'data> {
    pub(crate) body: Node<'data>,
    pub(crate) footer: Node<'data>,
    pub(crate) header: Node<'data>,
    pub(crate) margins: [f64; 4],
    pub(crate) size: [f64; 2],
}

#[derive(Debug)]
pub(crate) struct Node<'data> {
    pub(crate) kind: Kind<'data>,
    pub(crate) style: Style,
}

#[derive(Debug)]
pub(crate) enum Kind<'data> {
    Anchor(&'data str, bool),
    Break,
    Image(u32, bool),
    Link(&'data str, Vec<Node<'data>>),
    Shape(Vec<PathCommand>),
    Table(usize, Vec<Node<'data>>),
    Text(Vec<Run<'data>>),
    View(Vec<Node<'data>>),
}

#[derive(Debug)]
pub(crate) enum PathCommand {
    Close,
    Curve([f64; 6]),
    Line([f64; 2]),
    Move([f64; 2]),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct TextStyle {
    pub(crate) color: u32,
    pub(crate) face: usize,
    pub(crate) size: f64,
    pub(crate) tracking: f64,
}

#[derive(Debug)]
pub(crate) struct Run<'data> {
    pub(crate) kind: u8,
    pub(crate) style: TextStyle,
    pub(crate) text: &'data str,
}

#[derive(Debug)]
pub(crate) struct Style {
    pub(crate) align: u8,
    pub(crate) background: u32,
    pub(crate) basis: f64,
    pub(crate) border: u32,
    pub(crate) border_width: f64,
    pub(crate) flags: u8,
    pub(crate) gap: f64,
    pub(crate) grow: f64,
    pub(crate) height: f64,
    pub(crate) justify: u8,
    pub(crate) line_height: f64,
    pub(crate) margin: [f64; 4],
    pub(crate) max_height: f64,
    pub(crate) max_width: f64,
    pub(crate) min_height: f64,
    pub(crate) min_width: f64,
    pub(crate) opacity: f64,
    pub(crate) padding: [f64; 4],
    pub(crate) radius: f64,
    pub(crate) shrink: f64,
    pub(crate) text_align: u8,
    pub(crate) width: f64,
}

#[derive(Debug)]
struct Reader<'data> {
    bytes: &'data [u8],
    nodes: usize,
}

impl Style {
    pub(crate) const fn column(&self) -> bool {
        self.flags & 1 != 0
    }
    pub(crate) const fn keep(&self) -> bool {
        self.flags & 4 != 0
    }
    pub(crate) const fn widow(&self) -> bool {
        self.flags & 8 != 0
    }
    pub(crate) const fn wrap(&self) -> bool {
        self.flags & 2 != 0
    }
}

impl<'data> Reader<'data> {
    fn blob(&mut self) -> Option<&'data [u8]> {
        let length = self.count(64 * 1024 * 1024)?;
        self.take(length)
    }

    fn byte(&mut self) -> Option<u8> {
        self.take(1)?.first().copied()
    }

    fn children(&mut self, depth: usize) -> Option<Vec<Node<'data>>> {
        {
            let count = self.count(10_000)?;
            repeat_with(|| self.node(depth)).take(count)
        }
        .collect()
    }

    fn count(&mut self, maximum: usize) -> Option<usize> {
        let count = usize::try_from(self.word()?).ok()?;
        (count <= maximum).then_some(count)
    }

    fn document(&mut self) -> Option<Document<'data>> {
        if self.take(4)? != b"SKC2" {
            return None;
        }
        let font_count = self.count(64)?;
        let image_count = self.count(256)?;
        let fonts = repeat_with(|| self.word())
            .take(font_count)
            .collect::<Option<_>>()?;
        let images = repeat_with(|| self.word())
            .take(image_count)
            .collect::<Option<_>>()?;
        let metadata = [self.string()?, self.string()?, self.string()?];
        let sections = {
            let count = self.count(1000)?;
            repeat_with(|| self.section()).take(count)
        }
        .collect::<Option<Vec<_>>>()?;
        (!sections.is_empty() && self.bytes.is_empty()).then_some(Document {
            fonts,
            images,
            metadata,
            sections,
        })
    }

    fn edges(&mut self) -> Option<[f64; 4]> {
        Some([
            self.number()?,
            self.number()?,
            self.number()?,
            self.number()?,
        ])
    }

    fn node(&mut self, depth: usize) -> Option<Node<'data>> {
        self.nodes = self.nodes.checked_add(1)?;
        if depth > 48 || self.nodes > 50_000 {
            return None;
        }
        let next = depth.saturating_add(1);
        let tag = self.byte()?;
        let style = self.style()?;
        let kind = match tag {
            0 => Kind::View(self.children(next)?),
            1 => Kind::Text(
                {
                    let count = self.count(10_000)?;
                    repeat_with(|| self.run()).take(count)
                }
                .collect::<Option<_>>()?,
            ),
            2 => Kind::Image(self.word()?, self.byte()? != 0),
            3 => Kind::Shape(
                {
                    let count = self.count(10_000)?;
                    repeat_with(|| self.path_command()).take(count)
                }
                .collect::<Option<_>>()?,
            ),
            4 => Kind::Anchor(self.string()?, self.byte()? != 0),
            5 => Kind::Break,
            6 => Kind::Table(self.count(128)?, self.children(next)?),
            7 => Kind::Link(self.string()?, self.children(next)?),
            _ => return None,
        };
        Some(Node { kind, style })
    }

    fn number(&mut self) -> Option<f64> {
        let value = f64::from_le_bytes(self.take(8)?.try_into().ok()?);
        (value.is_finite() && value.abs() <= 14400.0).then_some(value)
    }

    fn path_command(&mut self) -> Option<PathCommand> {
        match self.byte()? {
            0 => Some(PathCommand::Move(self.point()?)),
            1 => Some(PathCommand::Line(self.point()?)),
            2 => Some(PathCommand::Curve([
                self.number()?,
                self.number()?,
                self.number()?,
                self.number()?,
                self.number()?,
                self.number()?,
            ])),
            3 => Some(PathCommand::Close),
            _ => None,
        }
    }

    fn point(&mut self) -> Option<[f64; 2]> {
        Some([self.number()?, self.number()?])
    }

    fn run(&mut self) -> Option<Run<'data>> {
        Some(Run {
            kind: self.byte()?,
            style: TextStyle {
                face: self.count(63)?,
                size: self.number()?,
                tracking: self.number()?,
                color: self.word()?,
            },
            text: self.string()?,
        })
    }

    fn section(&mut self) -> Option<Section<'data>> {
        Some(Section {
            size: self.point()?,
            margins: self.edges()?,
            header: self.node(0)?,
            footer: self.node(0)?,
            body: self.node(0)?,
        })
    }

    fn string(&mut self) -> Option<&'data str> {
        str::from_utf8(self.blob()?).ok()
    }

    fn style(&mut self) -> Option<Style> {
        let flags = self.byte()?;
        Some(Style {
            flags,
            justify: self.byte()?,
            align: self.byte()?,
            text_align: self.byte()?,
            background: self.word()?,
            border: self.word()?,
            width: self.number()?,
            height: self.number()?,
            min_width: self.number()?,
            max_width: self.number()?,
            min_height: self.number()?,
            max_height: self.number()?,
            margin: self.edges()?,
            padding: self.edges()?,
            gap: self.number()?,
            radius: self.number()?,
            border_width: self.number()?,
            opacity: self.number()?,
            grow: self.number()?,
            shrink: self.number()?,
            basis: self.number()?,
            line_height: self.number()?,
        })
    }

    fn take(&mut self, size: usize) -> Option<&'data [u8]> {
        let (head, tail) = self.bytes.split_at_checked(size)?;
        self.bytes = tail;
        Some(head)
    }

    fn word(&mut self) -> Option<u32> {
        Some(u32::from_le_bytes(self.take(4)?.try_into().ok()?))
    }
}

pub(crate) fn parse(bytes: &[u8]) -> Outcome<Document<'_>> {
    Reader { bytes, nodes: 0 }
        .document()
        .ok_or_else(|| Failure::request("Invalid compose request"))
}
