use alloc::collections::btree_map::Entry;
use alloc::collections::{BTreeMap, BTreeSet};
use core::fmt::{Result as FmtResult, Write as _};
use core::mem;
use std::collections::HashMap;

use signature_kit_font::{sfnt::Face, subset::GlyphSet};
use signature_kit_pdf_core::{
    deflate::zlib_compress,
    failure::{Failure, Outcome},
    write::Composition,
};

use crate::images::Image;
use crate::layout::{Area, Decoration, Item, NO_COLOR, Page, Paint};
use crate::spec::{PathCommand, TextStyle};
use crate::text::{Line, Symbol, glyph};

#[derive(Debug)]
struct Writer<'data> {
    adjustments: HashMap<u64, String>,
    faces: &'data [Face<'data>],
    fields: BTreeMap<String, u32>,
    glyphs: Vec<GlyphSet>,
    images: &'data [Image<'data>],
    opacities: BTreeMap<u16, u32>,
    pdf: Composition,
}

#[derive(Clone, Copy, Debug)]
struct PageContext {
    height: f64,
    number: usize,
    reference: u32,
    total: usize,
}

impl Writer<'_> {
    fn adjustment(&mut self, out: &mut String, value: f64) {
        let key = value.to_bits();
        if let Some(rendered) = self.adjustments.get(&key) {
            out.push_str(rendered);
        } else if self.adjustments.len() < 1_024 {
            let rendered = format!("{value:.4} ");
            out.push_str(&rendered);
            let _previous = self.adjustments.insert(key, rendered);
        } else {
            let _written: FmtResult = write!(out, "{value:.4} ");
        }
    }

    fn anchor(
        &mut self,
        out: &mut String,
        page: PageContext,
        area: Area,
        name: &str,
        field: bool,
    ) -> Outcome<Option<u32>> {
        let y = page.height - area.y - area.height + 4.0_f64;
        let _written: FmtResult =
            writeln!(out, "BT /F0 8 Tf 3 Tr 1 0 0 1 {:.4} {y:.4} Tm [", area.x);
        let mut hex = false;
        for character in name.chars() {
            let face = self
                .faces
                .first()
                .ok_or_else(|| Failure::request("Missing anchor font"))?;
            push_glyph(
                out,
                &mut hex,
                self.cid(0, character, glyph(face, character)?)?,
            );
        }
        close_glyphs(out, &mut hex);
        out.push_str("] TJ ET\n");
        if !field {
            return Ok(None);
        }
        let encoded = unicode_string(name);
        let rect = pdf_rect(page.height, area);
        let annotation = self.pdf.add(format!(
            "<< /Type /Annot /Subtype /Widget /FT /Sig /F 4 /T {encoded} /P {} 0 R /Rect {rect} >>",
            page.reference
        ));
        if self.fields.insert(String::from(name), annotation).is_some() {
            return Err(Failure::request("Signature field names must be unique"));
        }
        Ok(Some(annotation))
    }

    fn cid(&mut self, font: usize, character: char, glyph: u16) -> Outcome<u16> {
        let set = self
            .glyphs
            .get_mut(font)
            .ok_or_else(|| Failure::request("Unknown glyph set"))?;
        set.cid(character, glyph)
            .ok_or_else(|| Failure::limit("Too many unique glyphs"))
    }

    fn counter_width(&self, style: TextStyle, number: &str) -> Outcome<f64> {
        let face = self
            .faces
            .get(style.face)
            .ok_or_else(|| Failure::request("Unknown page counter font"))?;
        let mut width = style.tracking;
        for character in number.chars() {
            let advance = face
                .width(glyph(face, character)?)
                .ok_or_else(|| Failure::request("Missing page counter width"))?;
            width += advance * style.size / 1_000.0_f64;
        }
        Ok(width)
    }

    fn font(&mut self, index: usize, face: &Face<'_>, glyphs: &GlyphSet) -> Outcome<u32> {
        let major = char::from(b'A'.saturating_add(
            u8::try_from(index.checked_div(26).unwrap_or_default()).unwrap_or_default(),
        ));
        let minor = char::from(b'A'.saturating_add(
            u8::try_from(index.checked_rem(26).unwrap_or_default()).unwrap_or_default(),
        ));
        let base = format!("SKAA{major}{minor}+SignatureKit{index}");
        let subset = glyphs
            .subset(face, &base)
            .ok_or_else(|| Failure::request("Font cannot be subset"))?;
        let filters = if subset.cff {
            String::from("/Filter /FlateDecode /Subtype /CIDFontType0C")
        } else {
            format!("/Filter /FlateDecode /Length1 {}", subset.program.len())
        };
        let program = self.pdf.stream(&filters, &zlib_compress(&subset.program));
        let cmap = self
            .pdf
            .stream("/Filter /FlateDecode", &zlib_compress(&subset.cmap));
        let (subtype, file, gid_map) = if subset.cff {
            ("CIDFontType0", "FontFile3", String::new())
        } else {
            let map = self
                .pdf
                .stream("/Filter /FlateDecode", &zlib_compress(&subset.glyph_map));
            (
                "CIDFontType2",
                "FontFile2",
                format!("/CIDToGIDMap {map} 0 R"),
            )
        };
        let [left, bottom, right, top] = face
            .bounds()
            .ok_or_else(|| Failure::request("Missing font bounds"))?;
        let descriptor = self.pdf.add(format!("<< /Type /FontDescriptor /FontName /{base} /Flags 32 /FontBBox [{left:.3} {bottom:.3} {right:.3} {top:.3}] /ItalicAngle 0 /Ascent {top:.3} /Descent {bottom:.3} /CapHeight 700 /StemV 80 /{file} {program} 0 R >>"));
        let mut widths = String::new();
        for width in subset.widths {
            let _written: FmtResult = write!(widths, "{width:.5} ");
        }
        let descendant = self.pdf.add(format!("<< /Type /Font /Subtype /{subtype} /BaseFont /{base} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor {descriptor} 0 R /W [1 [{widths}]] {gid_map} >>"));
        Ok(self.pdf.add(format!("<< /Type /Font /Subtype /Type0 /BaseFont /{base} /Encoding /Identity-H /DescendantFonts [{descendant} 0 R] /ToUnicode {cmap} 0 R >>")))
    }

    fn item(
        &mut self,
        out: &mut String,
        page: PageContext,
        item: &Item<'_>,
    ) -> Outcome<Option<u32>> {
        let area = item.area;
        out.push_str("q\n");
        if item.opacity < 1.0_f64 {
            let opacity = format!("{:.0}", item.opacity * 1_000.0_f64)
                .parse::<u16>()
                .unwrap_or_default();
            if let Entry::Vacant(entry) = self.opacities.entry(opacity) {
                let alpha = f64::from(opacity) / 1_000.0_f64;
                let object = self.pdf.add(format!(
                    "<< /Type /ExtGState /ca {alpha:.3} /CA {alpha:.3} >>"
                ));
                let _: &mut u32 = entry.insert(object);
            }
            let _written: FmtResult = writeln!(out, "/GS{opacity} gs");
        }
        let annotation = match &item.paint {
            Paint::Shape(fill, commands) => {
                paint_shape(out, page.height, area, *fill, commands);
                None
            }
            Paint::Image(index, cover) => {
                let image = self
                    .images
                    .get(usize::try_from(*index).unwrap_or(usize::MAX))
                    .ok_or_else(|| Failure::request("Unknown image"))?;
                paint_image(out, page.height, area, *index, *cover, image.size);
                None
            }
            Paint::Link(uri) => {
                if !["https://", "http://", "mailto:"]
                    .iter()
                    .any(|prefix| uri.starts_with(prefix))
                    || uri.chars().any(char::is_control)
                {
                    return Err(Failure::request("Unsupported link URI"));
                }
                let rect = pdf_rect(page.height, area);
                let encoded = literal_bytes(uri);
                Some(self.pdf.add(format!("<< /Type /Annot /Subtype /Link /Rect {rect} /Border [0 0 0] /A << /S /URI /URI {encoded} >> >>")))
            }
            Paint::Anchor(name, field) => self.anchor(out, page, area, name, *field)?,
            Paint::Text(line) => {
                self.text(out, page, area, line)?;
                None
            }
        };
        out.push_str("Q\n");
        Ok(annotation)
    }

    fn text(
        &mut self,
        out: &mut String,
        page: PageContext,
        area: Area,
        line: &Line,
    ) -> Outcome<()> {
        let y = page.height - area.y - line.baseline();
        let mut previous: Option<TextStyle> = None;
        let mut hex = false;
        let current = page.number.to_string();
        let total = page.total.to_string();
        let counter = |kind| {
            if kind == 3 {
                current.as_str()
            } else {
                total.as_str()
            }
        };
        let mut reduction = 0.0_f64;
        for letter in &line.letters {
            if let Symbol::Counter(kind) = letter.symbol {
                reduction += letter.advance - self.counter_width(letter.style, counter(kind))?;
            }
        }
        let mut x = area.x
            + match line.alignment {
                1 => reduction * 0.5_f64,
                2 => reduction,
                _ => 0.0_f64,
            };
        for letter in &line.letters {
            let style = letter.style;
            if previous != Some(style) {
                if previous.is_some() {
                    close_glyphs(out, &mut hex);
                    out.push_str("] TJ ET\n");
                }
                let [red, green, blue] = rgb(style.color);
                let _written: FmtResult = writeln!(
                    out,
                    "BT /F{} {:.4} Tf {red:.5} {green:.5} {blue:.5} rg 1 0 0 1 {x:.4} {y:.4} Tm [",
                    style.face, style.size
                );
                previous = Some(style);
            }
            let em = 1_000.0_f64 / style.size;
            if letter.kern.abs() > 0.000_1_f64 {
                close_glyphs(out, &mut hex);
                self.adjustment(out, -letter.kern * em);
            }
            let mut space = 0.0_f64;
            let mut advance = letter.advance;
            match letter.symbol {
                Symbol::Character(character) => {
                    push_glyph(
                        out,
                        &mut hex,
                        self.cid(style.face, character, letter.glyph)?,
                    );
                    if character == ' ' {
                        space = line.stretch;
                    }
                }
                Symbol::Counter(kind) => {
                    advance = style.tracking;
                    for character in counter(kind).chars() {
                        let face = self
                            .faces
                            .get(style.face)
                            .ok_or_else(|| Failure::request("Unknown page counter font"))?;
                        let gid = glyph(face, character)?;
                        advance += face
                            .width(gid)
                            .ok_or_else(|| Failure::request("Missing page counter width"))?
                            / em;
                        push_glyph(out, &mut hex, self.cid(style.face, character, gid)?);
                    }
                }
            }
            x += advance + letter.kern + space;
            if (style.tracking + space).abs() > 0.000_1_f64 {
                close_glyphs(out, &mut hex);
                self.adjustment(out, -(style.tracking + space) * em);
            }
        }
        if previous.is_some() {
            close_glyphs(out, &mut hex);
            out.push_str("] TJ ET\n");
        }
        Ok(())
    }
}

fn push_glyph(out: &mut String, hex: &mut bool, cid: u16) {
    if !*hex {
        out.push('<');
        *hex = true;
    }
    for shift in [12_u32, 8, 4, 0] {
        let digit = u32::from(cid.wrapping_shr(shift) & 0xF);
        out.push(char::from_digit(digit, 16).unwrap_or('0'));
    }
}

fn close_glyphs(out: &mut String, hex: &mut bool) {
    if *hex {
        out.push('>');
        *hex = false;
    }
}

fn rgb(color: u32) -> [f64; 3] {
    let [_, red, green, blue] = color.to_be_bytes();
    [red, green, blue].map(|value| f64::from(value) / 255.0_f64)
}

fn unicode_string(text: &str) -> String {
    let mut output = String::from("<FEFF");
    for unit in text.encode_utf16() {
        let _written: FmtResult = write!(output, "{unit:04X}");
    }
    output.push('>');
    output
}

fn literal_bytes(text: &str) -> String {
    let mut output = String::from("<");
    for byte in text.bytes() {
        let _written: FmtResult = write!(output, "{byte:02X}");
    }
    output.push('>');
    output
}

fn references(values: &[u32]) -> String {
    let mut result = String::new();
    for value in values {
        let _written: FmtResult = write!(result, "{value} 0 R ");
    }
    result
}

fn paint_shape(out: &mut String, height: f64, area: Area, fill: Decoration, path: &[PathCommand]) {
    let Area {
        x,
        y,
        width,
        height: box_height,
    } = area;
    let upper = height - y;
    let lower = upper - box_height;
    if fill.fill != NO_COLOR {
        let [red, green, blue] = rgb(fill.fill);
        let _written: FmtResult = writeln!(out, "{red:.5} {green:.5} {blue:.5} rg");
    }
    let stroke = fill.stroke != NO_COLOR && fill.thickness > 0.0_f64;
    if stroke {
        let [red, green, blue] = rgb(fill.stroke);
        let _written: FmtResult = writeln!(
            out,
            "{red:.5} {green:.5} {blue:.5} RG {:.4} w",
            fill.thickness
        );
    }
    if path.is_empty() {
        let radius = fill.radius.min(width * 0.5).min(box_height * 0.5).max(0.0);
        if radius <= 0.0_f64 {
            let _written: FmtResult =
                writeln!(out, "{x:.4} {lower:.4} {width:.4} {box_height:.4} re");
        } else {
            rounded(out, x, lower, width, box_height, radius);
        }
    } else {
        for command in path {
            match *command {
                PathCommand::Move([px, py]) => {
                    let _written: FmtResult = writeln!(out, "{:.4} {:.4} m", x + px, upper - py);
                }
                PathCommand::Line([px, py]) => {
                    let _written: FmtResult = writeln!(out, "{:.4} {:.4} l", x + px, upper - py);
                }
                PathCommand::Curve([ax, ay, bx, by, cx, cy]) => {
                    let _written: FmtResult = writeln!(
                        out,
                        "{:.4} {:.4} {:.4} {:.4} {:.4} {:.4} c",
                        x + ax,
                        upper - ay,
                        x + bx,
                        upper - by,
                        x + cx,
                        upper - cy
                    );
                }
                PathCommand::Close => out.push_str("h\n"),
            }
        }
    }
    out.push_str(match (fill.fill != NO_COLOR, stroke) {
        (true, true) => "B\n",
        (true, false) => "f\n",
        (false, true) => "S\n",
        (false, false) => "n\n",
    });
}

fn rounded(out: &mut String, x: f64, y: f64, width: f64, height: f64, radius: f64) {
    let mx = x + width;
    let my = y + height;
    let slope = radius * 0.552_284_75_f64;
    let left = x + radius;
    let right = mx - radius;
    let lower = y + radius;
    let upper = my - radius;
    let _move: FmtResult = writeln!(out, "{left:.4} {y:.4} m {right:.4} {y:.4} l");
    let _lower_right: FmtResult = writeln!(
        out,
        "{:.4} {y:.4} {mx:.4} {:.4} {mx:.4} {lower:.4} c",
        right + slope,
        lower - slope
    );
    let _upper_right: FmtResult = writeln!(
        out,
        "{mx:.4} {upper:.4} l {mx:.4} {:.4} {:.4} {my:.4} {right:.4} {my:.4} c",
        upper + slope,
        right + slope
    );
    let _upper_left: FmtResult = writeln!(
        out,
        "{left:.4} {my:.4} l {:.4} {my:.4} {x:.4} {:.4} {x:.4} {upper:.4} c",
        left - slope,
        upper + slope
    );
    let _lower_left: FmtResult = writeln!(
        out,
        "{x:.4} {lower:.4} l {x:.4} {:.4} {:.4} {y:.4} {left:.4} {y:.4} c h",
        lower - slope,
        left - slope
    );
}

fn paint_image(
    out: &mut String,
    height: f64,
    area: Area,
    index: u32,
    cover: bool,
    pixels: [u32; 2],
) {
    let Area {
        x,
        y,
        width,
        height: box_height,
    } = area;
    let lower = height - y - box_height;
    let [pw, ph] = pixels.map(f64::from);
    let factor = if cover {
        (width / pw).max(box_height / ph)
    } else {
        (width / pw).min(box_height / ph)
    };
    let sw = pw * factor;
    let sh = ph * factor;
    let tx = x + (width - sw) * 0.5_f64;
    let ty = lower + (box_height - sh) * 0.5_f64;
    let _written: FmtResult = writeln!(
        out,
        "{x:.4} {lower:.4} {width:.4} {box_height:.4} re W n {sw:.4} 0 0 {sh:.4} {tx:.4} {ty:.4} cm /Im{index} Do"
    );
}

fn pdf_rect(height: f64, area: Area) -> String {
    format!(
        "[{:.4} {:.4} {:.4} {:.4}]",
        area.x,
        height - area.y - area.height,
        area.x + area.width,
        height - area.y
    )
}

pub(crate) fn write(
    pages: &[Page<'_>],
    faces: &[Face<'_>],
    images: &[Image<'_>],
    metadata: [&str; 3],
) -> Outcome<Vec<u8>> {
    let mut writer = Writer {
        adjustments: HashMap::new(),
        faces,
        fields: BTreeMap::new(),
        glyphs: faces.iter().map(|_| GlyphSet::default()).collect(),
        images,
        opacities: BTreeMap::new(),
        pdf: Composition::default(),
    };
    let root = writer.pdf.reserve();
    let parent = writer.pdf.reserve();
    let resources = writer.pdf.reserve();
    let mut kids = Vec::new();
    let mut used_images = BTreeSet::new();
    for (index, page) in pages.iter().enumerate() {
        let [width, height] = page.size;
        let reference = writer.pdf.reserve();
        kids.push(reference);
        let ctx = PageContext {
            height,
            number: index.saturating_add(1),
            reference,
            total: pages.len(),
        };
        let mut contents = String::new();
        let mut annotations = Vec::new();
        for item in &page.items {
            if let Paint::Image(image, _) = item.paint {
                let _used: bool = used_images.insert(image);
            }
            if let Some(annotation) = writer.item(&mut contents, ctx, item)? {
                annotations.push(annotation);
            }
        }
        let content = writer
            .pdf
            .stream("/Filter /FlateDecode", &zlib_compress(contents.as_bytes()));
        let annots = references(&annotations);
        writer.pdf.set(reference, format!("<< /Type /Page /Parent {parent} 0 R /MediaBox [0 0 {width:.4} {height:.4}] /Resources {resources} 0 R /Contents {content} 0 R /Annots [{annots}] >>"));
    }
    let used = mem::take(&mut writer.glyphs);
    let mut fonts = String::new();
    for (index, (face, glyphs)) in faces.iter().zip(&used).enumerate() {
        if !glyphs.is_empty() {
            let font = writer.font(index, face, glyphs)?;
            let _written: FmtResult = write!(fonts, "/F{index} {font} 0 R ");
        }
    }
    let mut xobjects = String::new();
    for image in used_images {
        if let Some(asset) = images.get(usize::try_from(image).unwrap_or(usize::MAX)) {
            let reference = asset.write(&mut writer.pdf);
            let _written: FmtResult = write!(xobjects, "/Im{image} {reference} 0 R ");
        }
    }
    let mut opacities = String::new();
    for (opacity, reference) in &writer.opacities {
        let _written: FmtResult = write!(opacities, "/GS{opacity} {reference} 0 R ");
    }
    writer.pdf.set(
        resources,
        format!("<< /Font << {fonts} >> /XObject << {xobjects} >> /ExtGState << {opacities} >> >>"),
    );
    let count = kids.len();
    let page_refs = references(&kids);
    writer.pdf.set(
        parent,
        format!("<< /Type /Pages /Count {count} /Kids [{page_refs}] >>"),
    );
    let fields = references(&writer.fields.values().copied().collect::<Vec<_>>());
    writer.pdf.set(root, format!("<< /Type /Catalog /Pages {parent} 0 R /AcroForm << /SigFlags 3 /Fields [{fields}] >> >>"));
    let [title, author, created] = metadata;
    let date = if created.is_empty() {
        String::new()
    } else {
        format!("/CreationDate {}", literal_bytes(created))
    };
    let info = writer.pdf.add(format!(
        "<< /Title {} /Author {} {date} /Producer (SignatureKit) >>",
        unicode_string(title),
        unicode_string(author)
    ));
    Ok(writer.pdf.finish(root, info))
}
