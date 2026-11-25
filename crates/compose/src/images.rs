use signature_kit_font::read_u16;
use signature_kit_pdf_core::{
    deflate::zlib_compress,
    failure::{Failure, Outcome},
    png,
    write::Composition,
};

#[derive(Debug)]
pub(crate) struct Image<'data> {
    colors: u32,
    data: Data<'data>,
    pub(crate) size: [u32; 2],
}

#[derive(Debug)]
enum Data<'data> {
    Jpeg(&'data [u8]),
    Png(png::Image),
}

impl<'data> Image<'data> {
    pub(crate) fn parse(bytes: &'data [u8]) -> Outcome<Self> {
        if bytes.starts_with(b"\xFF\xD8") {
            let (size, colors) =
                jpeg_geometry(bytes).ok_or_else(|| Failure::request("Unsupported JPEG frame"))?;
            return Ok(Self {
                size,
                colors,
                data: Data::Jpeg(bytes),
            });
        }
        let image = png::decode(bytes)?;
        Ok(Self {
            size: [image.width, image.height],
            colors: image.components,
            data: Data::Png(image),
        })
    }

    pub(crate) fn write(&self, pdf: &mut Composition) -> u32 {
        let [width, height] = self.size;
        let space = if self.colors == 1 {
            "DeviceGray"
        } else {
            "DeviceRGB"
        };
        let base = format!(
            "/Type /XObject /Subtype /Image /Width {width} /Height {height} /ColorSpace /{space} /BitsPerComponent 8"
        );
        match &self.data {
            Data::Jpeg(bytes) => pdf.stream(&format!("{base} /Filter /DCTDecode"), bytes),
            Data::Png(image) if !image.alpha => pdf.stream(
                &format!("{base} /Filter /FlateDecode"),
                &zlib_compress(&image.samples),
            ),
            Data::Png(image) => {
                let components = usize::try_from(self.colors).unwrap_or(3);
                let mut colors = Vec::new();
                let mut opacity = Vec::new();
                for pixel in image.samples.chunks_exact(components.saturating_add(1)) {
                    if let Some((alpha, samples)) = pixel.split_last() {
                        opacity.push(*alpha);
                        colors.extend_from_slice(samples);
                    }
                }
                let smask = pdf.stream(&format!("/Type /XObject /Subtype /Image /Width {width} /Height {height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode"), &zlib_compress(&opacity));
                pdf.stream(
                    &format!("{base} /SMask {smask} 0 R /Filter /FlateDecode"),
                    &zlib_compress(&colors),
                )
            }
        }
    }
}

fn jpeg_geometry(mut bytes: &[u8]) -> Option<([u32; 2], u32)> {
    bytes = bytes.get(2..)?;
    while let Some((&0xFF, rest)) = bytes.split_first() {
        let (&marker, tail) = rest.split_first()?;
        if marker == 0xFF {
            bytes = rest;
            continue;
        }
        if matches!(marker, 0xD9 | 0xDA) {
            return None;
        }
        let len = usize::from(read_u16(tail, 0)?);
        if len < 2 {
            return None;
        }
        let segment = tail.get(..len)?;
        if matches!(marker, 0xC0..=0xC2) {
            let width = u32::from(read_u16(segment, 5)?);
            let height = u32::from(read_u16(segment, 3)?);
            let colors = u32::from(*segment.get(7)?);
            return (width != 0
                && height != 0
                && matches!(colors, 1 | 3)
                && segment.get(2) == Some(&8))
            .then_some(([width, height], colors));
        }
        bytes = tail.get(len..)?;
    }
    None
}
