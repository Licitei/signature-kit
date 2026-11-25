use crate::failure::{Failure, Outcome};
use crate::filters::paeth_filter;
use crate::inflate::inflate;
use crate::num::{read_u32, widen};

const SIGNATURE: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];
const MAX_INPUT: usize = 16 * 1024 * 1024;
const MAX_PIXELS: u64 = 16 * 1024 * 1024;
const MAX_INFLATED: u64 = 64 * 1024 * 1024;
const MAX_CHUNKS: usize = 4096;
const ADAM7: [[u32; 4]; 7] = [
    [0, 0, 8, 8],
    [4, 0, 8, 8],
    [0, 4, 4, 8],
    [2, 0, 4, 4],
    [0, 2, 2, 4],
    [1, 0, 2, 2],
    [0, 1, 1, 2],
];

#[derive(Clone, Debug, PartialEq, Eq)]
#[expect(
    clippy::exhaustive_structs,
    reason = "the internal ABI shares this struct with the WASM crate"
)]
pub struct Image {
    pub alpha: bool,
    pub components: u32,
    pub height: u32,
    pub samples: Vec<u8>,
    pub width: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Transparency {
    Gray(u16),
    None,
    Palette,
    Rgb([u16; 3]),
}

struct Header {
    channels: u32,
    color: u8,
    depth: u8,
    height: u32,
    interlaced: bool,
    width: u32,
}

struct Chunks<'data> {
    idat: Vec<&'data [u8]>,
    palette: &'data [u8],
    palette_alpha: &'data [u8],
    transparency: Transparency,
}

struct Raster<'header> {
    alpha: bool,
    components: usize,
    header: &'header Header,
    out: Vec<u8>,
    palette: &'header [u8],
    palette_alpha: &'header [u8],
    stride: usize,
    transparency: Transparency,
}

impl Raster<'_> {
    fn pixel_at(&mut self, x: u32, y: u32, column: u32, row: &[u8]) {
        let samples = self.samples(column, row);
        let (color, alpha) = self.resolve(samples);
        let index = widen(y)
            .saturating_mul(widen(self.header.width))
            .saturating_add(widen(x))
            .saturating_mul(self.stride);
        let Some(slot) = self.out.get_mut(index..index.saturating_add(self.stride)) else {
            return;
        };
        let (color_slot, alpha_slot) = slot.split_at_mut(self.components);
        color_slot.copy_from_slice(color.get(..self.components).unwrap_or_default());
        if let Some(value) = alpha_slot.first_mut() {
            *value = alpha;
        }
    }

    fn resolve(&self, samples: [u16; 4]) -> ([u8; 3], u8) {
        let [first, second, third, fourth] = samples;
        let depth = self.header.depth;
        match self.header.color {
            3 => {
                let index = widen(first).saturating_mul(3);
                let rgb = self
                    .palette
                    .get(index..index.saturating_add(3))
                    .and_then(|entry| <[u8; 3]>::try_from(entry).ok())
                    .unwrap_or_default();
                let alpha = self
                    .palette_alpha
                    .get(widen(first))
                    .copied()
                    .unwrap_or(u8::MAX);
                (rgb, alpha)
            }
            0 | 4 => {
                let gray = scale(first, depth);
                let alpha = if self.header.color == 4 {
                    scale(second, depth)
                } else if self.transparency == Transparency::Gray(first) {
                    0
                } else {
                    u8::MAX
                };
                ([gray, gray, gray], alpha)
            }
            _ => {
                let rgb = [
                    scale(first, depth),
                    scale(second, depth),
                    scale(third, depth),
                ];
                let alpha = if self.header.color == 6 {
                    scale(fourth, depth)
                } else if self.transparency == Transparency::Rgb([first, second, third]) {
                    0
                } else {
                    u8::MAX
                };
                (rgb, alpha)
            }
        }
    }

    fn samples(&self, x: u32, row: &[u8]) -> [u16; 4] {
        let mut samples = [0_u16; 4];
        let depth = u32::from(self.header.depth);
        let first_bit = u64::from(x)
            .saturating_mul(u64::from(self.header.channels))
            .saturating_mul(u64::from(depth));
        for (channel, sample) in samples
            .iter_mut()
            .enumerate()
            .take(widen(self.header.channels))
        {
            let channel_bit = u64::try_from(channel)
                .unwrap_or(0)
                .saturating_mul(u64::from(depth));
            let bit = first_bit.saturating_add(channel_bit);
            let byte = usize::try_from(bit >> 3_u32).unwrap_or(usize::MAX);
            *sample = match depth {
                16 => {
                    let high = row.get(byte).copied().unwrap_or(0);
                    let low = row.get(byte.saturating_add(1)).copied().unwrap_or(0);
                    u16::from_be_bytes([high, low])
                }
                8 => u16::from(row.get(byte).copied().unwrap_or(0)),
                _ => {
                    let value = row.get(byte).copied().unwrap_or(0);
                    let offset = u32::try_from(bit & 7).unwrap_or(0);
                    let shift = 8_u32.saturating_sub(offset).saturating_sub(depth);
                    let mask = u8::MAX >> 8_u32.saturating_sub(depth);
                    u16::from((value >> shift) & mask)
                }
            };
        }
        samples
    }
}

impl Header {
    fn bits_per_pixel(&self) -> u64 {
        u64::from(self.channels).saturating_mul(u64::from(self.depth))
    }

    fn filtered_len(&self, width: u32, height: u32) -> u64 {
        if width == 0 || height == 0 {
            return 0;
        }
        row_bytes(width, self.bits_per_pixel())
            .saturating_add(1)
            .saturating_mul(u64::from(height))
    }

    fn inflated_len(&self) -> u64 {
        if !self.interlaced {
            return self.filtered_len(self.width, self.height);
        }
        ADAM7.iter().fold(0_u64, |total, pass| {
            let [start_x, start_y, step_x, step_y] = *pass;
            total.saturating_add(self.filtered_len(
                extent(self.width, start_x, step_x),
                extent(self.height, start_y, step_y),
            ))
        })
    }
}

#[expect(
    clippy::missing_errors_doc,
    reason = "the TypeScript bindings document the public error contract"
)]
#[expect(
    clippy::missing_inline_in_public_items,
    reason = "release LTO chooses inlining across the internal Rust boundary"
)]
pub fn decode(png: &[u8]) -> Outcome<Image> {
    if png.len() > MAX_INPUT || png.get(..8) != Some(SIGNATURE.as_slice()) {
        return Err(Failure::request("not a PNG image"));
    }
    let header = header(png)?;
    let chunks = chunks(png, &header)?;
    let expected = header.inflated_len();
    if expected > MAX_INFLATED {
        return Err(Failure::limit("PNG image exceeds the decoded size limit"));
    }
    let expected_len = usize::try_from(expected)
        .ok()
        .ok_or_else(|| Failure::limit("PNG image exceeds the decoded size limit"))?;
    let joined;
    let compressed: &[u8] = match chunks.idat.as_slice() {
        [single] => single,
        [] => return Err(Failure::request("PNG image has no data")),
        parts => {
            joined = parts.concat();
            &joined
        }
    };
    let mut data = inflate(compressed, expected_len).map_err(|_inflate_failure| {
        Failure::request("PNG image data is corrupt or exceeds its scanlines")
    })?;
    if data.len() != expected_len {
        return Err(Failure::request("PNG image data is truncated"));
    }
    let gray = matches!(header.color, 0 | 4);
    let components: usize = if gray { 1 } else { 3 };
    let alpha = matches!(header.color, 4 | 6) || chunks.transparency != Transparency::None;
    let stride = components.saturating_add(usize::from(alpha));
    let pixels = widen(header.width).saturating_mul(widen(header.height));
    let mut raster = Raster {
        alpha,
        components,
        header: &header,
        out: vec![0; pixels.saturating_mul(stride)],
        palette: chunks.palette,
        palette_alpha: chunks.palette_alpha,
        stride,
        transparency: chunks.transparency,
    };
    if header.interlaced {
        let mut offset = 0_usize;
        for pass in ADAM7 {
            let [start_x, start_y, step_x, step_y] = pass;
            let width = extent(header.width, start_x, step_x);
            let height = extent(header.height, start_y, step_y);
            let len = usize::try_from(header.filtered_len(width, height)).unwrap_or(usize::MAX);
            let end = offset.saturating_add(len);
            let pass_data = data
                .get_mut(offset..end)
                .ok_or_else(|| Failure::request("PNG image data is truncated"))?;
            unfilter(pass_data, width, &header)?;
            let row_len = usize::try_from(row_bytes(width, header.bits_per_pixel()))
                .unwrap_or(usize::MAX)
                .saturating_add(1);
            for (row_index, row) in pass_data.chunks_exact(row_len.max(1)).enumerate() {
                let y = u32::try_from(row_index)
                    .unwrap_or(u32::MAX)
                    .saturating_mul(step_y)
                    .saturating_add(start_y);
                let samples = row.get(1..).unwrap_or_default();
                for column in 0..width {
                    let x = column.saturating_mul(step_x).saturating_add(start_x);
                    raster.pixel_at(x, y, column, samples);
                }
            }
            offset = end;
        }
    } else {
        unfilter(&mut data, header.width, &header)?;
        let row_len = usize::try_from(row_bytes(header.width, header.bits_per_pixel()))
            .unwrap_or(usize::MAX)
            .saturating_add(1);
        for (row_index, row) in data.chunks_exact(row_len).enumerate() {
            let y = u32::try_from(row_index).unwrap_or(u32::MAX);
            let samples = row.get(1..).unwrap_or_default();
            for x in 0..header.width {
                raster.pixel_at(x, y, x, samples);
            }
        }
    }
    let mut samples = raster.out;
    let mut has_alpha = raster.alpha;
    if has_alpha
        && samples
            .chunks_exact(stride)
            .all(|pixel| pixel.last() == Some(&u8::MAX))
    {
        has_alpha = false;
        samples = samples
            .chunks_exact(stride)
            .flat_map(|pixel| pixel.get(..components).unwrap_or_default().iter().copied())
            .collect();
    }
    Ok(Image {
        alpha: has_alpha,
        components: u32::try_from(components).unwrap_or(3),
        height: header.height,
        samples,
        width: header.width,
    })
}

fn header(png: &[u8]) -> Outcome<Header> {
    let ihdr = png
        .get(8..33)
        .ok_or_else(|| Failure::request("PNG header is truncated"))?;
    if ihdr.get(..8) != Some(&[0, 0, 0, 13, b'I', b'H', b'D', b'R'][..]) {
        return Err(Failure::request("PNG header is missing"));
    }
    let width = be_u32(ihdr, 8);
    let height = be_u32(ihdr, 12);
    let field = |at: usize| ihdr.get(at).copied().unwrap_or(u8::MAX);
    let (depth, color, compression, filter, interlace) =
        (field(16), field(17), field(18), field(19), field(20));
    let channels = match (color, depth) {
        (0, 1 | 2 | 4 | 8 | 16) | (3, 1 | 2 | 4 | 8) => 1,
        (2, 8 | 16) => 3,
        (4, 8 | 16) => 2,
        (6, 8 | 16) => 4,
        _ => return Err(Failure::request("unsupported PNG color type or bit depth")),
    };
    if compression != 0 || filter != 0 || interlace > 1 {
        return Err(Failure::request(
            "unsupported PNG compression, filter or interlace",
        ));
    }
    if width == 0 || height == 0 || u64::from(width).saturating_mul(u64::from(height)) > MAX_PIXELS
    {
        return Err(Failure::limit("PNG image dimensions are out of range"));
    }
    Ok(Header {
        channels,
        color,
        depth,
        height,
        interlaced: interlace == 1,
        width,
    })
}

fn chunks<'data>(png: &'data [u8], header: &Header) -> Outcome<Chunks<'data>> {
    let mut found = Chunks {
        idat: Vec::new(),
        palette: &[],
        palette_alpha: &[],
        transparency: Transparency::None,
    };
    let mut offset = 33_usize;
    for _ in 0..MAX_CHUNKS {
        let length = widen(be_u32(png, offset));
        let kind = png
            .get(offset.saturating_add(4)..offset.saturating_add(8))
            .ok_or_else(|| Failure::request("PNG chunk is truncated"))?;
        let start = offset.saturating_add(8);
        let end = start.saturating_add(length);
        let data = png
            .get(start..end)
            .ok_or_else(|| Failure::request("PNG chunk is truncated"))?;
        match kind {
            b"IDAT" => found.idat.push(data),
            b"PLTE" => found.palette = data,
            b"tRNS" => {
                found.transparency = match header.color {
                    3 => {
                        found.palette_alpha = data;
                        Transparency::Palette
                    }
                    0 => Transparency::Gray(be_u16(data, 0)),
                    2 => Transparency::Rgb([be_u16(data, 0), be_u16(data, 2), be_u16(data, 4)]),
                    _ => Transparency::None,
                };
            }
            b"acTL" | b"fcTL" | b"fdAT" => {
                return Err(Failure::request("animated PNG images are not supported"));
            }
            b"IEND" => {
                if length != 0 || end.saturating_add(4) != png.len() {
                    return Err(Failure::request("PNG image has bytes after its end chunk"));
                }
                if header.color == 3 && found.palette.is_empty() {
                    return Err(Failure::request("PNG palette is missing"));
                }
                return Ok(found);
            }
            _ => {}
        }
        offset = end.saturating_add(4);
    }
    Err(Failure::limit("PNG image has too many chunks"))
}

fn unfilter(data: &mut [u8], width: u32, header: &Header) -> Outcome<()> {
    let bits = header.bits_per_pixel();
    let row_len = usize::try_from(row_bytes(width, bits)).unwrap_or(usize::MAX);
    let pixel = usize::try_from(bits.div_ceil(8)).unwrap_or(1).max(1);
    let line = row_len.saturating_add(1);
    if row_len == 0 {
        return Ok(());
    }
    let mut previous: Option<usize> = None;
    let mut start = 0_usize;
    while start < data.len() {
        let filter = data.get(start).copied().unwrap_or(0);
        if filter > 4 {
            return Err(Failure::request("PNG row filter is invalid"));
        }
        let first = start.saturating_add(1);
        for column in 0..row_len {
            let at = first.saturating_add(column);
            let left = if column >= pixel {
                data.get(at.saturating_sub(pixel)).copied().unwrap_or(0)
            } else {
                0
            };
            let (up, up_left) = previous.map_or((0, 0), |above| {
                let above_at = above.saturating_add(1).saturating_add(column);
                let up_value = data.get(above_at).copied().unwrap_or(0);
                let corner = if column >= pixel {
                    data.get(above_at.saturating_sub(pixel))
                        .copied()
                        .unwrap_or(0)
                } else {
                    0
                };
                (up_value, corner)
            });
            if let Some(value) = data.get_mut(at) {
                *value = paeth_filter(filter, *value, left, up, up_left);
            }
        }
        previous = Some(start);
        start = start.saturating_add(line);
    }
    Ok(())
}

fn be_u16(data: &[u8], at: usize) -> u16 {
    let high = data.get(at).copied().unwrap_or(0);
    let low = data.get(at.saturating_add(1)).copied().unwrap_or(0);
    u16::from_be_bytes([high, low])
}

fn be_u32(data: &[u8], at: usize) -> u32 {
    read_u32(data, at).unwrap_or(0)
}

fn extent(length: u32, start: u32, step: u32) -> u32 {
    if length <= start {
        return 0;
    }
    length.saturating_sub(start).div_ceil(step.max(1))
}

fn row_bytes(width: u32, bits_per_pixel: u64) -> u64 {
    u64::from(width).saturating_mul(bits_per_pixel).div_ceil(8)
}

fn scale(value: u16, depth: u8) -> u8 {
    match depth {
        16 => u8::try_from(value >> 8_u32).unwrap_or(u8::MAX),
        8 => u8::try_from(value).unwrap_or(u8::MAX),
        _ => {
            let max = (1_u16 << u32::from(depth)).saturating_sub(1).max(1);
            u8::try_from(value.saturating_mul(255).checked_div(max).unwrap_or(0)).unwrap_or(u8::MAX)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deflate::zlib_compress;
    use crate::failure::FailureCode;

    fn chunk(out: &mut Vec<u8>, kind: [u8; 4], data: &[u8]) {
        out.extend_from_slice(&u32::try_from(data.len()).unwrap().to_be_bytes());
        out.extend_from_slice(&kind);
        out.extend_from_slice(data);
        out.extend_from_slice(&[0, 0, 0, 0]);
    }

    fn filter_row(kind: u8, row: &[u8], above: &[u8], pixel: usize) -> Vec<u8> {
        let mut out = vec![kind];
        for (index, &value) in row.iter().enumerate() {
            let left = if index >= pixel {
                row[index.saturating_sub(pixel)]
            } else {
                0
            };
            let up = above.get(index).copied().unwrap_or(0);
            let corner = if index >= pixel {
                above.get(index.saturating_sub(pixel)).copied().unwrap_or(0)
            } else {
                0
            };
            let prediction = match kind {
                1 => left,
                2 => up,
                3 => u8::try_from(u16::midpoint(u16::from(left), u16::from(up))).unwrap(),
                4 => paeth_reference(left, up, corner),
                _ => 0,
            };
            out.push(value.wrapping_sub(prediction));
        }
        out
    }

    fn paeth_reference(a: u8, b: u8, c: u8) -> u8 {
        let estimate = i16::from(a)
            .saturating_add(i16::from(b))
            .saturating_sub(i16::from(c));
        let (pa, pb, pc) = (
            estimate.saturating_sub(i16::from(a)).abs(),
            estimate.saturating_sub(i16::from(b)).abs(),
            estimate.saturating_sub(i16::from(c)).abs(),
        );
        if pa <= pb && pa <= pc {
            a
        } else if pb <= pc {
            b
        } else {
            c
        }
    }

    fn filtered(rows: &[Vec<u8>], pixel: usize) -> Vec<u8> {
        let mut out = Vec::new();
        let empty = Vec::new();
        for (index, row) in rows.iter().enumerate() {
            let above = if index == 0 {
                &empty
            } else {
                &rows[index.saturating_sub(1)]
            };
            let kind = u8::try_from(index.rem_euclid(5)).unwrap();
            out.extend(filter_row(kind, row, above, pixel));
        }
        out
    }

    fn png(
        size: (u32, u32),
        color: u8,
        depth: u8,
        interlace: u8,
        extra: &[(&[u8; 4], Vec<u8>)],
        data: &[u8],
    ) -> Vec<u8> {
        let mut out = SIGNATURE.to_vec();
        let mut ihdr = Vec::new();
        ihdr.extend_from_slice(&size.0.to_be_bytes());
        ihdr.extend_from_slice(&size.1.to_be_bytes());
        ihdr.extend_from_slice(&[depth, color, 0, 0, interlace]);
        chunk(&mut out, *b"IHDR", &ihdr);
        for (kind, payload) in extra {
            chunk(&mut out, **kind, payload);
        }
        let compressed = zlib_compress(data);
        let (first, second) = compressed.split_at(compressed.len().div_ceil(2));
        chunk(&mut out, *b"IDAT", first);
        chunk(&mut out, *b"IDAT", second);
        chunk(&mut out, *b"IEND", &[]);
        out
    }

    #[test]
    fn decodes_rgba_with_every_filter() {
        let rows: Vec<Vec<u8>> = (0..7_u8)
            .map(|y| {
                (0..5_u8)
                    .flat_map(|x| [x * 40, y * 30, x ^ y, if x == 2 { 10 } else { 255 }])
                    .collect()
            })
            .collect();
        let image = decode(&png((5, 7), 6, 8, 0, &[], &filtered(&rows, 4))).unwrap();
        assert_eq!((image.width, image.height, image.components), (5, 7, 3));
        assert!(image.alpha);
        assert_eq!(image.samples, rows.concat());
    }

    #[test]
    fn opaque_alpha_is_dropped_and_gray_stays_gray() {
        let rows: Vec<Vec<u8>> = (0..4_u8)
            .map(|y| (0..3_u8).flat_map(|x| [x * 9 + y, 255]).collect())
            .collect();
        let image = decode(&png((3, 4), 4, 8, 0, &[], &filtered(&rows, 2))).unwrap();
        assert!(!image.alpha);
        assert_eq!(image.components, 1);
        assert_eq!(
            image.samples,
            vec![0, 9, 18, 1, 10, 19, 2, 11, 20, 3, 12, 21]
        );
    }

    #[test]
    fn sixteen_bit_rgb_keeps_high_bytes_and_honours_trns() {
        let rows = vec![vec![0x12, 0x34, 0, 1, 0xFF, 0xFF, 0, 0, 0, 0, 0, 0]];
        let trns = vec![0, 0, 0, 0, 0, 0];
        let image = decode(&png(
            (2, 1),
            2,
            16,
            0,
            &[(b"tRNS", trns)],
            &filtered(&rows, 6),
        ))
        .unwrap();
        assert!(image.alpha);
        assert_eq!(image.samples, vec![0x12, 0, 0xFF, 255, 0, 0, 0, 0]);
    }

    #[test]
    fn palette_with_transparency_and_low_bit_depths() {
        let palette = vec![255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9];
        let rows = vec![vec![0b0001_1011], vec![0b1110_0100]];
        let source = png(
            (4, 2),
            3,
            2,
            0,
            &[(b"PLTE", palette), (b"tRNS", vec![255, 0])],
            &filtered(&rows, 1),
        );
        let image = decode(&source).unwrap();
        assert!(image.alpha);
        assert_eq!(
            image.samples,
            vec![
                255, 0, 0, 255, 0, 255, 0, 0, 0, 0, 255, 255, 9, 9, 9, 255, 9, 9, 9, 255, 0, 0,
                255, 255, 0, 255, 0, 0, 255, 0, 0, 255,
            ]
        );
        let gray = decode(&png((8, 1), 0, 1, 0, &[], &[0, 0b1010_0000])).unwrap();
        assert_eq!(gray.samples, vec![255, 0, 255, 0, 0, 0, 0, 0]);
        let four = decode(&png((2, 1), 0, 4, 0, &[(b"tRNS", vec![0, 15])], &[0, 0xF7])).unwrap();
        assert_eq!(four.samples, vec![255, 0, 119, 255]);
    }

    #[test]
    fn adam7_interlace_places_every_pass() {
        let width = 9_u32;
        let height = 10_u32;
        let value = |x: u32, y: u32| u8::try_from((x * 17 + y * 5).rem_euclid(256)).unwrap();
        let mut data = Vec::new();
        for [start_x, start_y, step_x, step_y] in ADAM7 {
            let pass_width = extent(width, start_x, step_x);
            let pass_height = extent(height, start_y, step_y);
            if pass_width == 0 {
                continue;
            }
            let rows: Vec<Vec<u8>> = (0..pass_height)
                .map(|row| {
                    (0..pass_width)
                        .map(|column| value(start_x + column * step_x, start_y + row * step_y))
                        .collect()
                })
                .collect();
            data.extend(filtered(&rows, 1));
        }
        let image = decode(&png((width, height), 0, 8, 1, &[], &data)).unwrap();
        let expected: Vec<u8> = (0..height)
            .flat_map(|y| (0..width).map(move |x| value(x, y)))
            .collect();
        assert_eq!(image.samples, expected);
    }

    #[test]
    fn rejects_hostile_images() {
        let ok = png((1, 1), 0, 8, 0, &[], &[0, 7]);
        assert_eq!(decode(&ok).unwrap().samples, vec![7]);
        let reject = |bytes: &[u8]| decode(bytes).unwrap_err().code;
        assert_eq!(reject(b"not a png"), FailureCode::InvalidRequest);
        assert_eq!(reject(&ok[..20]), FailureCode::InvalidRequest);
        assert_eq!(
            reject(&png((1, 1), 0, 8, 0, &[], &[0])),
            FailureCode::InvalidRequest
        );
        assert_eq!(
            reject(&png((1, 1), 0, 8, 0, &[], &[9, 7])),
            FailureCode::InvalidRequest
        );
        assert_eq!(
            reject(&png((1, 1), 2, 4, 0, &[], &[0, 7])),
            FailureCode::InvalidRequest
        );
        assert_eq!(
            reject(&png((1, 1), 3, 8, 0, &[], &[0, 0])),
            FailureCode::InvalidRequest
        );
        assert_eq!(
            reject(&png((1_000_000, 1_000_000), 0, 8, 0, &[], &[0])),
            FailureCode::LimitExceeded
        );
        let mut endless = ok[..33].to_vec();
        for _ in 0..=MAX_CHUNKS {
            chunk(&mut endless, *b"tEXt", &[]);
        }
        assert_eq!(reject(&endless), FailureCode::LimitExceeded);
        let mut trailing = ok.clone();
        trailing.push(0);
        assert_eq!(reject(&trailing), FailureCode::InvalidRequest);
        assert_eq!(
            reject(&ok[..ok.len().saturating_sub(2)]),
            FailureCode::InvalidRequest
        );
        for kind in [b"acTL", b"fcTL", b"fdAT"] {
            assert_eq!(
                reject(&png((1, 1), 0, 8, 0, &[(kind, vec![0; 8])], &[0, 7])),
                FailureCode::InvalidRequest
            );
        }
        assert_eq!(
            reject(&png((1, 1), 6, 8, 0, &[], &vec![0; 1024 * 1024])),
            FailureCode::InvalidRequest
        );
        let mut interlace = ok;
        interlace[28] = 2;
        assert_eq!(reject(&interlace), FailureCode::InvalidRequest);
    }
}
