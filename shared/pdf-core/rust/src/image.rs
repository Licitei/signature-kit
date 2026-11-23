use crate::ccitt::{self, CcittParams};
use crate::color::{ColorSpace, cmyk_to_rgb};
use crate::num::{bounded, f64_to_usize, unit_to_u8, usize_to_f64};
use crate::object::{Dict, Object, Resolver, numbers};

const MAX_PIXELS: usize = 1 << 26;
const MAX_OUTPUT_PIXELS: usize = 1 << 24;
const MAX_FACTOR: usize = 1 << 12;
const COLOR_CACHE_SLOTS: usize = 1 << 12;
const NO_KEY: u64 = u64::MAX;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Raster {
    pub height: u32,
    pub pixels: Vec<u8>,
    pub width: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Pixels {
    Jpeg(Raster),
    Raster(Raster),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Decoded {
    pub image: Pixels,
    pub mask: Option<Pixels>,
    pub matte: Option<[u8; 3]>,
}

#[derive(Clone, Copy)]
pub(crate) struct ImageContext<'ctx> {
    pub device: (f64, f64),
    pub fill: [u8; 4],
    pub max_bytes: usize,
    pub resolver: &'ctx dyn Resolver,
    pub space: Option<&'ctx ColorSpace>,
}

pub(crate) struct ImageInput<'input> {
    pub data: &'input [u8],
    pub dict: &'input Dict,
    pub filter: Option<&'input [u8]>,
    pub parms: Option<&'input Dict>,
}

enum Alpha {
    ColorKey(Vec<(u32, u32)>),
    Deferred(Raster),
    Opaque,
    Plane(Raster, Option<[u8; 3]>),
}

enum Converter<'space> {
    Cmyk([Vec<f64>; 4]),
    Generic(Box<Generic<'space>>),
    Gray(Vec<u8>),
    Palette(Vec<[u8; 3]>),
    Rgb([Vec<u8>; 3]),
    Stencil([u8; 4], bool),
}

struct Generic<'space> {
    cache: Vec<(u64, [u8; 3])>,
    decode: Vec<(f64, f64)>,
    packed: bool,
    space: &'space ColorSpace,
    values: Vec<f64>,
}

impl Generic<'_> {
    fn pixel(&mut self, row: &[u8], base: usize, bits: u32, scratch: &mut Vec<f64>) -> [u8; 3] {
        let max = sample_max(bits);
        let mut key = 0_u64;
        self.values.clear();
        for (component, (low, high)) in self.decode.iter().enumerate() {
            let raw = sample(row, base.saturating_add(component), bits);
            key = key.rotate_left(lut_bits(bits)) ^ u64::from(raw);
            self.values.push(low + f64::from(raw) * (high - low) / max);
        }
        let slot = usize::try_from(key.wrapping_mul(0x9E37_79B9_7F4A_7C15) >> 52_u32).unwrap_or(0);
        let cacheable = key != NO_KEY && self.packed;
        if cacheable
            && let Some((stored, rgb)) = self.cache.get(slot)
            && *stored == key
        {
            return *rgb;
        }
        let rgb = self.space.rgb(&self.values, scratch).map(unit_to_u8);
        if cacheable && let Some(entry) = self.cache.get_mut(slot) {
            *entry = (key, rgb);
        }
        rgb
    }
}

struct Layout {
    bits: u32,
    components: usize,
    height: usize,
    row_bytes: usize,
    width: usize,
}

struct Downsampler {
    counts: Vec<u32>,
    factor_x: usize,
    factor_y: usize,
    out: Vec<u8>,
    out_width: usize,
    rows_in_band: usize,
    sums: Vec<u32>,
}

impl Downsampler {
    fn finish_band(&mut self) {
        if self.rows_in_band == 0 {
            return;
        }
        for (column, sums) in self.sums.as_chunks_mut::<4>().0.iter_mut().enumerate() {
            let count = self
                .counts
                .get(column)
                .copied()
                .unwrap_or(1)
                .saturating_mul(u32::try_from(self.rows_in_band).unwrap_or(1))
                .max(1);
            let alpha_sum = sums[3];
            let mut pixel = [0_u8; 4];
            if alpha_sum > 0 {
                for (slot, sum) in pixel.iter_mut().zip(sums.iter()).take(3) {
                    *slot = u8::try_from(sum.div_euclid(alpha_sum)).unwrap_or(u8::MAX);
                }
            }
            pixel[3] = u8::try_from(alpha_sum.div_euclid(count)).unwrap_or(u8::MAX);
            self.out.extend_from_slice(&pixel);
            *sums = [0; 4];
        }
        self.rows_in_band = 0;
    }

    fn new(width: usize, height: usize, factor_x: usize, factor_y: usize) -> Self {
        let out_width = width.div_ceil(factor_x);
        let out_height = height.div_ceil(factor_y);
        let counts = (0..out_width)
            .map(|column| {
                let start = column.saturating_mul(factor_x);
                let end = start.saturating_add(factor_x).min(width);
                u32::try_from(end.saturating_sub(start)).unwrap_or(1)
            })
            .collect();
        Self {
            counts,
            factor_x,
            factor_y,
            out: Vec::with_capacity(out_width.saturating_mul(out_height).saturating_mul(4)),
            out_width,
            rows_in_band: 0,
            sums: vec![0; out_width.saturating_mul(4)],
        }
    }

    fn push_row(&mut self, row: &[u8]) {
        if self.factor_x == 1 && self.factor_y == 1 {
            self.out.extend_from_slice(row);
            return;
        }
        let span = self.factor_x.saturating_mul(4);
        for (slot, group) in self
            .sums
            .as_chunks_mut::<4>()
            .0
            .iter_mut()
            .zip(row.chunks(span))
        {
            let mut total = [0_u32; 4];
            for pixel in group.as_chunks::<4>().0 {
                let alpha = u32::from(pixel[3]);
                total[0] = total[0].wrapping_add(u32::from(pixel[0]).wrapping_mul(alpha));
                total[1] = total[1].wrapping_add(u32::from(pixel[1]).wrapping_mul(alpha));
                total[2] = total[2].wrapping_add(u32::from(pixel[2]).wrapping_mul(alpha));
                total[3] = total[3].wrapping_add(alpha);
            }
            for (sum, added) in slot.iter_mut().zip(total) {
                *sum = sum.saturating_add(added);
            }
        }
        self.rows_in_band = self.rows_in_band.saturating_add(1);
        if self.rows_in_band >= self.factor_y {
            self.finish_band();
        }
    }
}

fn integer(resolver: &dyn Resolver, dict: &Dict, key: &[u8]) -> Option<i64> {
    let value = dict
        .get(key)
        .and_then(|value| resolver.resolve(value).ok())?;
    value.as_integer()
}

fn flag(resolver: &dyn Resolver, dict: &Dict, key: &[u8]) -> bool {
    dict.get(key)
        .and_then(|value| resolver.resolve(value).ok())
        .is_some_and(|value| matches!(*value, Object::Bool(true)))
}

pub(crate) fn image_filter(
    resolver: &dyn Resolver,
    dict: &Dict,
) -> (Option<Vec<u8>>, Option<Dict>) {
    let filter = dict
        .get(b"Filter")
        .and_then(|value| resolver.resolve(value).ok());
    let last = match filter.as_deref() {
        Some(Object::Name(name)) => Some(name.clone()),
        Some(Object::Array(items)) => items.last().and_then(Object::as_name).map(<[u8]>::to_vec),
        _ => None,
    };
    let Some(name) = last else {
        return (None, None);
    };
    let normalized: &[u8] = match name.as_slice() {
        b"DCT" => b"DCTDecode",
        b"CCF" => b"CCITTFaxDecode",
        other => other,
    };
    if !matches!(
        normalized,
        b"DCTDecode" | b"JPXDecode" | b"CCITTFaxDecode" | b"JBIG2Decode"
    ) {
        return (None, None);
    }
    let parms = dict
        .get(b"DecodeParms")
        .and_then(|value| resolver.resolve(value).ok())
        .and_then(|value| match &*value {
            Object::Dict(inner) => Some(inner.clone()),
            Object::Array(items) => {
                let target = items
                    .last()
                    .and_then(|last_item| resolver.resolve(last_item).ok())?;
                target.as_dict().cloned()
            }
            Object::Bool(_)
            | Object::Integer(_)
            | Object::Name(_)
            | Object::Null
            | Object::Real(_)
            | Object::Ref(_)
            | Object::Stream(_)
            | Object::String(_) => None,
        });
    (Some(normalized.to_vec()), parms)
}

fn ccitt_params(resolver: &dyn Resolver, parms: Option<&Dict>, height: usize) -> CcittParams {
    let empty = Dict::default();
    let dict = parms.unwrap_or(&empty);
    let rows = integer(resolver, dict, b"Rows")
        .and_then(|value| usize::try_from(value).ok())
        .filter(|value| *value > 0)
        .unwrap_or(height);
    CcittParams {
        black_is_1: flag(resolver, dict, b"BlackIs1"),
        byte_align: flag(resolver, dict, b"EncodedByteAlign"),
        columns: integer(resolver, dict, b"Columns")
            .and_then(|value| usize::try_from(value).ok())
            .unwrap_or(1728),
        end_of_line: flag(resolver, dict, b"EndOfLine"),
        k_factor: integer(resolver, dict, b"K").unwrap_or(0),
        rows: rows.min(height.max(1)),
    }
}

fn sample(row: &[u8], index: usize, bits: u32) -> u32 {
    match bits {
        8 => u32::from(row.get(index).copied().unwrap_or(0)),
        16 => u32::from(row.get(index.saturating_mul(2)).copied().unwrap_or(0)),
        _ => {
            let bit = index.saturating_mul(usize::try_from(bits).unwrap_or(1));
            let byte = u32::from(row.get(bit >> 3_u32).copied().unwrap_or(0));
            let shift = 8_u32
                .saturating_sub(u32::try_from(bit & 7).unwrap_or(0))
                .saturating_sub(bits);
            (byte >> shift) & (1_u32 << bits).wrapping_sub(1)
        }
    }
}

const fn lut_bits(bits: u32) -> u32 {
    if bits == 16 { 8 } else { bits }
}

fn sample_max(bits: u32) -> f64 {
    f64::from((1_u32 << lut_bits(bits).min(16)).wrapping_sub(1)).max(1.0)
}

fn component_lut(decode: &[f64], component: usize, bits: u32) -> Vec<f64> {
    let effective = lut_bits(bits);
    let max = (1_u32 << effective).wrapping_sub(1);
    let low = decode
        .get(component.saturating_mul(2))
        .copied()
        .unwrap_or(0.0_f64);
    let high = decode
        .get(component.saturating_mul(2).saturating_add(1))
        .copied()
        .unwrap_or(1.0_f64);
    (0..=max)
        .map(|raw| low + f64::from(raw) * (high - low) / f64::from(max.max(1)))
        .collect()
}

fn byte_lut(decode: &[f64], component: usize, bits: u32) -> Vec<u8> {
    component_lut(decode, component, bits)
        .into_iter()
        .map(unit_to_u8)
        .collect()
}

fn converter<'space>(space: &'space ColorSpace, decode: &[f64], bits: u32) -> Converter<'space> {
    match space {
        ColorSpace::Gray => Converter::Gray(byte_lut(decode, 0, bits)),
        ColorSpace::Rgb => Converter::Rgb([
            byte_lut(decode, 0, bits),
            byte_lut(decode, 1, bits),
            byte_lut(decode, 2, bits),
        ]),
        ColorSpace::Cmyk => Converter::Cmyk([
            component_lut(decode, 0, bits),
            component_lut(decode, 1, bits),
            component_lut(decode, 2, bits),
            component_lut(decode, 3, bits),
        ]),
        ColorSpace::Indexed(_) | ColorSpace::Tinted(_) | ColorSpace::Pattern(_)
            if space.components() == 1 =>
        {
            let mut scratch = Vec::new();
            let palette = component_lut(decode, 0, bits)
                .into_iter()
                .map(|value| {
                    let [red, green, blue] = space.rgb(&[value], &mut scratch);
                    [unit_to_u8(red), unit_to_u8(green), unit_to_u8(blue)]
                })
                .collect();
            Converter::Palette(palette)
        }
        ColorSpace::Indexed(_)
        | ColorSpace::Lab(_)
        | ColorSpace::Pattern(_)
        | ColorSpace::Tinted(_) => {
            let components = space.components().max(1);
            let ranges = (0..components)
                .map(|component| {
                    (
                        decode
                            .get(component.saturating_mul(2))
                            .copied()
                            .unwrap_or(0.0_f64),
                        decode
                            .get(component.saturating_mul(2).saturating_add(1))
                            .copied()
                            .unwrap_or(1.0_f64),
                    )
                })
                .collect();
            let packed = u32::try_from(components)
                .ok()
                .and_then(|count| count.checked_mul(lut_bits(bits)))
                .is_some_and(|total| total <= 64);
            Converter::Generic(Box::new(Generic {
                cache: vec![(NO_KEY, [0; 3]); if packed { COLOR_CACHE_SLOTS } else { 0 }],
                decode: ranges,
                packed,
                space,
                values: Vec::with_capacity(components),
            }))
        }
    }
}

fn convert_bytes(converter: &Converter<'_>, row: &[u8], width: usize, out: &mut [u8]) -> bool {
    let pixels = out.as_chunks_mut::<4>().0;
    match converter {
        Converter::Gray(values) => {
            let Ok(lut) = <&[u8; 256]>::try_from(values.as_slice()) else {
                return false;
            };
            for (pixel, byte) in pixels.iter_mut().zip(row).take(width) {
                let gray = lut.get(usize::from(*byte)).copied().unwrap_or(0);
                *pixel = [gray, gray, gray, 255];
            }
            true
        }
        Converter::Rgb([red_values, green_values, blue_values]) => {
            let (Ok(red), Ok(green), Ok(blue)) = (
                <&[u8; 256]>::try_from(red_values.as_slice()),
                <&[u8; 256]>::try_from(green_values.as_slice()),
                <&[u8; 256]>::try_from(blue_values.as_slice()),
            ) else {
                return false;
            };
            for (pixel, rgb) in pixels.iter_mut().zip(row.as_chunks::<3>().0).take(width) {
                *pixel = [
                    red.get(usize::from(rgb[0])).copied().unwrap_or(0),
                    green.get(usize::from(rgb[1])).copied().unwrap_or(0),
                    blue.get(usize::from(rgb[2])).copied().unwrap_or(0),
                    255,
                ];
            }
            true
        }
        Converter::Palette(entries) => {
            let Ok(palette) = <&[[u8; 3]; 256]>::try_from(entries.as_slice()) else {
                return false;
            };
            for (pixel, byte) in pixels.iter_mut().zip(row).take(width) {
                let [red, green, blue] = palette.get(usize::from(*byte)).copied().unwrap_or([0; 3]);
                *pixel = [red, green, blue, 255];
            }
            true
        }
        Converter::Cmyk(_) | Converter::Generic(_) | Converter::Stencil(..) => false,
    }
}

fn convert_bitmap(converter: &Converter<'_>, row: &[u8], out: &mut [u8]) -> bool {
    let table: [[u8; 4]; 2] = match converter {
        Converter::Gray(lut) => {
            let (Some(zero), Some(one)) = (lut.first(), lut.get(1)) else {
                return false;
            };
            [[*zero, *zero, *zero, 255], [*one, *one, *one, 255]]
        }
        Converter::Palette(palette) => {
            let (Some(zero), Some(one)) = (palette.first(), palette.get(1)) else {
                return false;
            };
            [
                [zero[0], zero[1], zero[2], 255],
                [one[0], one[1], one[2], 255],
            ]
        }
        Converter::Stencil(color, invert) => [
            [
                color[0],
                color[1],
                color[2],
                if *invert { 0 } else { color[3] },
            ],
            [
                color[0],
                color[1],
                color[2],
                if *invert { color[3] } else { 0 },
            ],
        ],
        Converter::Cmyk(_) | Converter::Generic(_) | Converter::Rgb(_) => return false,
    };
    let pixels = out.as_chunks_mut::<4>().0;
    for (group, byte) in pixels.chunks_mut(8).zip(row) {
        for (shift, pixel) in (0_u32..8).rev().zip(group) {
            *pixel = table
                .get(usize::from((*byte >> shift) & 1))
                .copied()
                .unwrap_or_default();
        }
    }
    true
}

fn convert_row(
    converter: &mut Converter<'_>,
    row: &[u8],
    layout: &Layout,
    out: &mut [u8],
    scratch: &mut Vec<f64>,
) {
    let components = layout.components;
    if layout.bits == 8
        && row.len() >= layout.width.saturating_mul(components)
        && convert_bytes(converter, row, layout.width, out)
    {
        return;
    }
    if layout.bits == 1
        && components == 1
        && row.len() >= layout.width.div_ceil(8)
        && convert_bitmap(converter, row, out)
    {
        return;
    }
    let bits = layout.bits;
    for (x, pixel) in out
        .as_chunks_mut::<4>()
        .0
        .iter_mut()
        .enumerate()
        .take(layout.width)
    {
        let base = x.saturating_mul(components);
        let raw = |component: usize| sample(row, base.saturating_add(component), bits);
        let rgb = match converter {
            Converter::Gray(lut) => {
                let gray = lut
                    .get(usize::try_from(raw(0)).unwrap_or(0))
                    .copied()
                    .unwrap_or(0);
                [gray, gray, gray, 255]
            }
            Converter::Rgb(luts) => {
                let channel = |component: usize| {
                    luts.get(component)
                        .and_then(|lut| lut.get(usize::try_from(raw(component)).unwrap_or(0)))
                        .copied()
                        .unwrap_or(0)
                };
                [channel(0), channel(1), channel(2), 255]
            }
            Converter::Cmyk(luts) => {
                let channel = |component: usize| {
                    luts.get(component)
                        .and_then(|lut| lut.get(usize::try_from(raw(component)).unwrap_or(0)))
                        .copied()
                        .map_or(0.0_f64, |value| bounded(value, 0.0, 1.0))
                };
                let [red, green, blue] =
                    cmyk_to_rgb(channel(0), channel(1), channel(2), channel(3));
                [unit_to_u8(red), unit_to_u8(green), unit_to_u8(blue), 255]
            }
            Converter::Palette(palette) => {
                let [red, green, blue] = palette
                    .get(usize::try_from(raw(0)).unwrap_or(0))
                    .copied()
                    .unwrap_or([0, 0, 0]);
                [red, green, blue, 255]
            }
            Converter::Stencil(color, invert) => {
                let painted = (raw(0) == 0) != *invert;
                [
                    color[0],
                    color[1],
                    color[2],
                    if painted { color[3] } else { 0 },
                ]
            }
            Converter::Generic(generic) => {
                let [red, green, blue] = generic.pixel(row, base, bits, scratch);
                [red, green, blue, 255]
            }
        };
        *pixel = rgb;
    }
}

fn apply_plane_value(pixel: &mut [u8; 4], matte: Option<[u8; 3]>, value: u32) {
    if let Some(background) = matte {
        unmatte(pixel, background, value);
    }
    pixel[3] =
        u8::try_from(u32::from(pixel[3]).saturating_mul(value).div_euclid(255)).unwrap_or(u8::MAX);
}

fn apply_alpha(alpha: &Alpha, row: &[u8], y: usize, layout: &Layout, out: &mut [u8]) {
    match alpha {
        Alpha::Opaque | Alpha::Deferred(_) => {}
        Alpha::Plane(plane, matte) => {
            let plane_width = usize::try_from(plane.width).unwrap_or(0);
            let plane_height = usize::try_from(plane.height).unwrap_or(0);
            if plane_width == 0 || plane_height == 0 || layout.width == 0 || layout.height == 0 {
                return;
            }
            let plane_y = y.saturating_mul(plane_height).div_euclid(layout.height);
            let start = plane_y.saturating_mul(plane_width);
            let plane_row = plane
                .pixels
                .get(start..start.saturating_add(plane_width))
                .unwrap_or_default();
            let pixels = out.as_chunks_mut::<4>().0;
            if plane_row.is_empty() {
                return;
            }
            if plane_width == layout.width {
                for (pixel, value) in pixels.iter_mut().zip(plane_row) {
                    apply_plane_value(pixel, *matte, u32::from(*value));
                }
                return;
            }
            let step = plane_width.div_euclid(layout.width);
            let step_rest = plane_width.rem_euclid(layout.width);
            let mut plane_x = 0_usize;
            let mut rest = 0_usize;
            for pixel in pixels.iter_mut().take(layout.width) {
                let value = u32::from(plane_row.get(plane_x).copied().unwrap_or(255));
                apply_plane_value(pixel, *matte, value);
                plane_x = plane_x.saturating_add(step);
                rest = rest.saturating_add(step_rest);
                if rest >= layout.width {
                    rest = rest.saturating_sub(layout.width);
                    plane_x = plane_x.saturating_add(1);
                }
            }
        }
        Alpha::ColorKey(ranges) => {
            for (x, pixel) in out
                .as_chunks_mut::<4>()
                .0
                .iter_mut()
                .enumerate()
                .take(layout.width)
            {
                let base = x.saturating_mul(layout.components);
                let masked = ranges.iter().enumerate().all(|(component, (low, high))| {
                    let value = sample(row, base.saturating_add(component), layout.bits);
                    (*low..=*high).contains(&value)
                });
                if masked {
                    pixel[3] = 0;
                }
            }
        }
    }
}

fn factors(width: usize, height: usize, device: (f64, f64)) -> (usize, usize) {
    let pick = |source: usize, target: f64| {
        let wanted = target.max(1.0);
        let ratio = usize_to_f64(source) / wanted;
        if ratio >= 2.0_f64 {
            f64_to_usize(ratio.floor()).clamp(1, MAX_FACTOR)
        } else {
            1
        }
    };
    let mut factor_x = pick(width, device.0);
    let mut factor_y = pick(height, device.1);
    while width
        .div_ceil(factor_x)
        .saturating_mul(height.div_ceil(factor_y))
        > MAX_OUTPUT_PIXELS
        && factor_x < MAX_FACTOR
    {
        factor_x = factor_x.saturating_mul(2);
        factor_y = factor_y.saturating_mul(2);
    }
    (factor_x, factor_y)
}

fn dimensions(resolver: &dyn Resolver, dict: &Dict) -> Option<(usize, usize)> {
    let width = usize::try_from(integer(resolver, dict, b"Width")?).ok()?;
    let height = usize::try_from(integer(resolver, dict, b"Height")?).ok()?;
    (width > 0 && height > 0 && width.checked_mul(height)? <= MAX_PIXELS).then_some((width, height))
}

fn unmatte(pixel: &mut [u8; 4], background: [u8; 3], alpha: u32) {
    if alpha == 0 || alpha >= 255 {
        return;
    }
    for (channel, base) in pixel.iter_mut().zip(background) {
        let value = i64::from(*channel);
        let matte = i64::from(base);
        let restored = matte.saturating_add(
            value
                .saturating_sub(matte)
                .saturating_mul(255)
                .div_euclid(i64::from(alpha)),
        );
        *channel = u8::try_from(restored.clamp(0, 255)).unwrap_or(0);
    }
}

fn matte_of(ctx: &ImageContext<'_>, object: &Object, space: &ColorSpace) -> Option<[u8; 3]> {
    let resolved = ctx.resolver.resolve(object).ok()?;
    let values = numbers(ctx.resolver, resolved.as_dict()?, b"Matte");
    if values.is_empty() {
        return None;
    }
    Some(space.rgb(&values, &mut Vec::new()).map(unit_to_u8))
}

fn decode_alpha(ctx: &ImageContext<'_>, object: &Object, stencil: bool) -> Option<Pixels> {
    let resolved = ctx.resolver.resolve(object).ok()?;
    let stream = resolved.as_stream()?;
    let dict = &stream.dict;
    let (width, height) = dimensions(ctx.resolver, dict)?;
    let (filter, parms) = image_filter(ctx.resolver, dict);
    let raw = ctx.resolver.stream_data(stream).ok()?;
    let (data, bits) = match filter.as_deref() {
        None => (raw, bits_of(ctx.resolver, dict, stencil)?),
        Some(b"CCITTFaxDecode") => (
            ccitt::decode(
                &raw,
                &ccitt_params(ctx.resolver, parms.as_ref(), height),
                ctx.max_bytes,
            )?,
            1,
        ),
        Some(b"DCTDecode") => {
            return Some(Pixels::Jpeg(Raster {
                height: u32::try_from(height).ok()?,
                pixels: raw,
                width: u32::try_from(width).ok()?,
            }));
        }
        Some(_) => return None,
    };
    let decode = numbers(ctx.resolver, dict, b"Decode");
    let invert = decode.first().is_some_and(|first| *first > 0.5_f64);
    let lut: Vec<u8> = if stencil {
        if invert { vec![0, 255] } else { vec![255, 0] }
    } else {
        byte_lut(
            if decode.len() >= 2 {
                &decode
            } else {
                &[0.0_f64, 1.0_f64]
            },
            0,
            bits,
        )
    };
    let fallback = if stencil { 255 } else { unit_to_u8(1.0_f64) };
    let row_bytes = width.checked_mul(usize::try_from(bits).ok()?)?.div_ceil(8);
    let mut pixels = Vec::with_capacity(width.checked_mul(height)?);
    for y in 0..height {
        let start = y.saturating_mul(row_bytes);
        let row = data
            .get(start..start.saturating_add(row_bytes))
            .unwrap_or_default();
        if bits == 8 && row.len() >= width {
            pixels.extend(
                row.iter()
                    .take(width)
                    .map(|byte| lut.get(usize::from(*byte)).copied().unwrap_or(fallback)),
            );
            continue;
        }
        for x in 0..width {
            let raw_value = sample(row, x, bits);
            pixels.push(
                lut.get(usize::try_from(raw_value).unwrap_or(0))
                    .copied()
                    .unwrap_or(fallback),
            );
        }
    }
    Some(Pixels::Raster(Raster {
        height: u32::try_from(height).ok()?,
        pixels,
        width: u32::try_from(width).ok()?,
    }))
}

fn bits_of(resolver: &dyn Resolver, dict: &Dict, stencil: bool) -> Option<u32> {
    if stencil {
        return Some(1);
    }
    let bits = integer(resolver, dict, b"BitsPerComponent").unwrap_or(8);
    matches!(bits, 1 | 2 | 4 | 8 | 16)
        .then(|| u32::try_from(bits).ok())
        .flatten()
}

fn alpha_source(ctx: &ImageContext<'_>, dict: &Dict, space: &ColorSpace) -> Alpha {
    let components = space.components().max(1);
    if let Some(smask) = dict.get(b"SMask") {
        match decode_alpha(ctx, smask, false) {
            Some(Pixels::Raster(plane)) => return Alpha::Plane(plane, matte_of(ctx, smask, space)),
            Some(Pixels::Jpeg(jpeg)) => return Alpha::Deferred(jpeg),
            None => {}
        }
    }
    let Some(mask) = dict.get(b"Mask") else {
        return Alpha::Opaque;
    };
    let Ok(resolved) = ctx.resolver.resolve(mask) else {
        return Alpha::Opaque;
    };
    match &*resolved {
        Object::Array(items) => {
            let values: Vec<u32> = items
                .iter()
                .filter_map(Object::as_number)
                .map(|value| u32::try_from(f64_to_usize(value)).unwrap_or(u32::MAX))
                .collect();
            if values.len() < components.saturating_mul(2) {
                return Alpha::Opaque;
            }
            Alpha::ColorKey(
                values
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|pair| (*pair).into())
                    .collect(),
            )
        }
        Object::Stream(_) => match decode_alpha(ctx, mask, true) {
            Some(Pixels::Raster(plane)) => Alpha::Plane(plane, None),
            Some(Pixels::Jpeg(_)) | None => Alpha::Opaque,
        },
        Object::Bool(_)
        | Object::Dict(_)
        | Object::Integer(_)
        | Object::Name(_)
        | Object::Null
        | Object::Real(_)
        | Object::Ref(_)
        | Object::String(_) => Alpha::Opaque,
    }
}

pub(crate) fn decode_image(ctx: &ImageContext<'_>, input: &ImageInput<'_>) -> Option<Decoded> {
    let resolver = ctx.resolver;
    let dict = input.dict;
    let (width, height) = dimensions(resolver, dict)?;
    let stencil = flag(resolver, dict, b"ImageMask");
    let fallback = if ctx.space.is_none() && !stencil {
        dict.get(b"ColorSpace")
            .and_then(|value| ColorSpace::parse(resolver, value, None))
            .unwrap_or(ColorSpace::Gray)
    } else {
        ColorSpace::Gray
    };
    let space = if stencil {
        &fallback
    } else {
        ctx.space.unwrap_or(&fallback)
    };
    if input.filter == Some(b"DCTDecode") {
        let smask = dict.get(b"SMask");
        return Some(Decoded {
            image: Pixels::Jpeg(Raster {
                height: u32::try_from(height).ok()?,
                pixels: input.data.to_vec(),
                width: u32::try_from(width).ok()?,
            }),
            mask: smask.and_then(|object| decode_alpha(ctx, object, false)),
            matte: smask.and_then(|object| matte_of(ctx, object, space)),
        });
    }
    let ccitt_data;
    let (data, bits) = match input.filter {
        None => (input.data, bits_of(resolver, dict, stencil)?),
        Some(b"CCITTFaxDecode") => {
            ccitt_data = ccitt::decode(
                input.data,
                &ccitt_params(resolver, input.parms, height),
                ctx.max_bytes,
            )?;
            (ccitt_data.as_slice(), 1)
        }
        Some(_) => return None,
    };
    let components = if stencil {
        1
    } else {
        space.components().max(1)
    };
    let decode_array = numbers(resolver, dict, b"Decode");
    let decode = if decode_array.len() >= components.saturating_mul(2) {
        decode_array
    } else {
        space.default_decode(bits)
    };
    let mut converter = if stencil {
        Converter::Stencil(
            ctx.fill,
            decode.first().is_some_and(|first| *first > 0.5_f64),
        )
    } else {
        converter(space, &decode, bits)
    };
    let layout = Layout {
        bits,
        components,
        height,
        row_bytes: width
            .checked_mul(components)?
            .checked_mul(usize::try_from(bits).ok()?)?
            .div_ceil(8),
        width,
    };
    let alpha = if stencil {
        Alpha::Opaque
    } else {
        alpha_source(ctx, dict, space)
    };
    let (factor_x, factor_y) = factors(width, height, ctx.device);
    let mut sampler = Downsampler::new(width, height, factor_x, factor_y);
    let mut row_pixels = vec![0_u8; width.checked_mul(4)?];
    let mut scratch = Vec::new();
    for y in 0..height {
        let start = y.saturating_mul(layout.row_bytes);
        let row = data
            .get(start..start.saturating_add(layout.row_bytes))
            .unwrap_or_default();
        convert_row(&mut converter, row, &layout, &mut row_pixels, &mut scratch);
        apply_alpha(&alpha, row, y, &layout, &mut row_pixels);
        sampler.push_row(&row_pixels);
    }
    sampler.finish_band();
    let out_height = height.div_ceil(factor_y);
    let (mask, matte) = match alpha {
        Alpha::Deferred(jpeg) => (
            Some(Pixels::Jpeg(jpeg)),
            dict.get(b"SMask")
                .and_then(|object| matte_of(ctx, object, space)),
        ),
        Alpha::ColorKey(_) | Alpha::Opaque | Alpha::Plane(..) => (None, None),
    };
    Some(Decoded {
        image: Pixels::Raster(Raster {
            height: u32::try_from(out_height).ok()?,
            pixels: sampler.out,
            width: u32::try_from(sampler.out_width).ok()?,
        }),
        mask,
        matte,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::failure::Outcome;
    use crate::object::Stream;
    use alloc::rc::Rc;

    struct Data(Vec<u8>);

    impl Resolver for Data {
        fn resolve(&self, object: &Object) -> Outcome<Rc<Object>> {
            Ok(Rc::new(object.clone()))
        }

        fn stream_data(&self, stream: &Stream) -> Outcome<Vec<u8>> {
            Ok(self.0.get(stream.data.clone()).unwrap_or_default().to_vec())
        }
    }

    fn dict(entries: Vec<(&str, Object)>) -> Dict {
        Dict {
            entries: entries
                .into_iter()
                .map(|(key, value)| (key.as_bytes().to_vec(), value))
                .collect(),
        }
    }

    fn name(value: &str) -> Object {
        Object::Name(value.as_bytes().to_vec())
    }

    fn context(resolver: &dyn Resolver, device: (f64, f64)) -> ImageContext<'_> {
        ImageContext {
            device,
            fill: [255, 0, 0, 255],
            max_bytes: 1 << 24,
            resolver,
            space: None,
        }
    }

    fn mask_alphas(mask_entries: Vec<(&str, Object)>) -> Vec<u8> {
        let resolver = Data(vec![0b0101_0101]);
        let mut entries = vec![
            ("Width", Object::Integer(8)),
            ("Height", Object::Integer(1)),
            ("ImageMask", Object::Bool(true)),
        ];
        entries.extend(mask_entries);
        let mask = Object::Stream(Stream {
            decrypted: None,
            data: 0..1,
            dict: dict(entries),
        });
        let image = dict(vec![
            ("Width", Object::Integer(8)),
            ("Height", Object::Integer(1)),
            ("BitsPerComponent", Object::Integer(8)),
            ("ColorSpace", name("DeviceGray")),
            ("Mask", mask),
        ]);
        let input = ImageInput {
            data: &[0; 8],
            dict: &image,
            filter: None,
            parms: None,
        };
        let raster = rgba(decode_image(
            &context(&resolver, (8.0_f64, 1.0_f64)),
            &input,
        ));
        raster.pixels.chunks(4).map(|pixel| pixel[3]).collect()
    }

    #[test]
    fn explicit_masks_paint_where_samples_are_zero_with_or_without_bits_per_component() {
        let expected = vec![255, 0, 255, 0, 255, 0, 255, 0];
        assert_eq!(mask_alphas(Vec::new()), expected);
        assert_eq!(
            mask_alphas(vec![("BitsPerComponent", Object::Integer(1))]),
            expected
        );
        assert_eq!(
            mask_alphas(vec![(
                "Decode",
                Object::Array(vec![Object::Integer(1), Object::Integer(0)])
            )]),
            vec![0, 255, 0, 255, 0, 255, 0, 255]
        );
    }

    #[test]
    fn stencil_masks_keep_the_fill_colour_opaque() {
        let resolver = Data(Vec::new());
        let mask = dict(vec![
            ("Width", Object::Integer(2)),
            ("Height", Object::Integer(1)),
            ("ImageMask", Object::Bool(true)),
        ]);
        let input = ImageInput {
            data: &[0b0100_0000],
            dict: &mask,
            filter: None,
            parms: None,
        };
        let mut ctx = context(&resolver, (2.0_f64, 1.0_f64));
        ctx.fill = [0, 0, 255, 255];
        let raster = rgba(decode_image(&ctx, &input));
        assert_eq!(raster.pixels, vec![0, 0, 255, 255, 0, 0, 255, 0]);
    }

    #[test]
    fn device_n_images_convert_through_the_tint_cache() {
        let resolver = Data(Vec::new());
        let tint = Object::Dict(dict(vec![
            ("FunctionType", Object::Integer(2)),
            (
                "Domain",
                Object::Array(vec![Object::Integer(0), Object::Integer(1)]),
            ),
            ("C0", Object::Array(vec![Object::Integer(0); 4])),
            (
                "C1",
                Object::Array(vec![
                    Object::Integer(1),
                    Object::Integer(0),
                    Object::Integer(0),
                    Object::Integer(0),
                ]),
            ),
            ("N", Object::Integer(1)),
        ]));
        let space = ColorSpace::parse(
            &resolver,
            &Object::Array(vec![
                name("DeviceN"),
                Object::Array(vec![name("Cyan"), name("Spot")]),
                name("DeviceCMYK"),
                tint,
            ]),
            None,
        )
        .unwrap();
        let image = dict(vec![
            ("Width", Object::Integer(3)),
            ("Height", Object::Integer(1)),
            ("BitsPerComponent", Object::Integer(8)),
        ]);
        let input = ImageInput {
            data: &[255, 0, 0, 0, 255, 0],
            dict: &image,
            filter: None,
            parms: None,
        };
        let mut ctx = context(&resolver, (3.0_f64, 1.0_f64));
        ctx.space = Some(&space);
        let raster = rgba(decode_image(&ctx, &input));
        assert_eq!(
            raster.pixels,
            vec![0, 255, 255, 255, 255, 255, 255, 255, 0, 255, 255, 255]
        );
    }

    fn rgba(decoded: Option<Decoded>) -> Raster {
        match decoded.unwrap().image {
            Pixels::Raster(raster) => raster,
            Pixels::Jpeg(_) => panic!("expected raster"),
        }
    }

    #[test]
    fn gray_and_rgb_samples_convert_with_decode_arrays() {
        let resolver = Data(Vec::new());
        let gray = dict(vec![
            ("Width", Object::Integer(2)),
            ("Height", Object::Integer(1)),
            ("BitsPerComponent", Object::Integer(8)),
            ("ColorSpace", name("DeviceGray")),
            (
                "Decode",
                Object::Array(vec![Object::Integer(1), Object::Integer(0)]),
            ),
        ]);
        let input = ImageInput {
            data: &[0, 255],
            dict: &gray,
            filter: None,
            parms: None,
        };
        let raster = rgba(decode_image(
            &context(&resolver, (2.0_f64, 1.0_f64)),
            &input,
        ));
        assert_eq!(raster.pixels, vec![255, 255, 255, 255, 0, 0, 0, 255]);
        let rgb = dict(vec![
            ("Width", Object::Integer(1)),
            ("Height", Object::Integer(1)),
            ("BitsPerComponent", Object::Integer(4)),
            ("ColorSpace", name("DeviceRGB")),
        ]);
        let input_rgb = ImageInput {
            data: &[0xF0, 0x80],
            dict: &rgb,
            filter: None,
            parms: None,
        };
        let raster_rgb = rgba(decode_image(
            &context(&resolver, (1.0_f64, 1.0_f64)),
            &input_rgb,
        ));
        assert_eq!(raster_rgb.pixels, vec![255, 0, 136, 255]);
    }

    #[test]
    fn stencil_masks_paint_the_fill_colour() {
        let resolver = Data(Vec::new());
        let mask = dict(vec![
            ("Width", Object::Integer(8)),
            ("Height", Object::Integer(1)),
            ("ImageMask", Object::Bool(true)),
        ]);
        let input = ImageInput {
            data: &[0b1010_0000],
            dict: &mask,
            filter: None,
            parms: None,
        };
        let raster = rgba(decode_image(
            &context(&resolver, (8.0_f64, 1.0_f64)),
            &input,
        ));
        let alphas: Vec<u8> = raster.pixels.chunks(4).map(|pixel| pixel[3]).collect();
        assert_eq!(alphas, vec![0, 255, 0, 255, 255, 255, 255, 255]);
        assert_eq!(&raster.pixels[4..7], &[255, 0, 0]);
    }

    #[test]
    fn large_images_are_box_filtered_to_device_size() {
        let resolver = Data(Vec::new());
        let gray = dict(vec![
            ("Width", Object::Integer(4)),
            ("Height", Object::Integer(4)),
            ("BitsPerComponent", Object::Integer(8)),
            ("ColorSpace", name("DeviceGray")),
        ]);
        let data: Vec<u8> = [0, 255, 0, 255].repeat(4);
        let input = ImageInput {
            data: &data,
            dict: &gray,
            filter: None,
            parms: None,
        };
        let raster = rgba(decode_image(
            &context(&resolver, (2.0_f64, 2.0_f64)),
            &input,
        ));
        assert_eq!((raster.width, raster.height), (2, 2));
        assert!(
            raster
                .pixels
                .as_chunks::<4>()
                .0
                .iter()
                .all(|pixel| pixel[0] == 127 && pixel[3] == 255)
        );
    }

    #[test]
    fn soft_masks_and_color_keys_set_alpha() {
        let resolver = Data(vec![0, 128]);
        let smask = Object::Stream(Stream {
            decrypted: None,
            data: 0..2,
            dict: dict(vec![
                ("Width", Object::Integer(2)),
                ("Height", Object::Integer(1)),
                ("BitsPerComponent", Object::Integer(8)),
                ("ColorSpace", name("DeviceGray")),
            ]),
        });
        let image = dict(vec![
            ("Width", Object::Integer(2)),
            ("Height", Object::Integer(1)),
            ("BitsPerComponent", Object::Integer(8)),
            ("ColorSpace", name("DeviceGray")),
            ("SMask", smask),
        ]);
        let input = ImageInput {
            data: &[10, 20],
            dict: &image,
            filter: None,
            parms: None,
        };
        let raster = rgba(decode_image(
            &context(&resolver, (2.0_f64, 1.0_f64)),
            &input,
        ));
        assert_eq!(raster.pixels.get(3), Some(&0));
        assert_eq!(raster.pixels.get(7), Some(&128));
        let keyed = dict(vec![
            ("Width", Object::Integer(2)),
            ("Height", Object::Integer(1)),
            ("BitsPerComponent", Object::Integer(8)),
            ("ColorSpace", name("DeviceGray")),
            (
                "Mask",
                Object::Array(vec![Object::Integer(5), Object::Integer(15)]),
            ),
        ]);
        let input_keyed = ImageInput {
            data: &[10, 20],
            dict: &keyed,
            filter: None,
            parms: None,
        };
        let raster_keyed = rgba(decode_image(
            &context(&resolver, (2.0_f64, 1.0_f64)),
            &input_keyed,
        ));
        assert_eq!(raster_keyed.pixels.get(3), Some(&0));
        assert_eq!(raster_keyed.pixels.get(7), Some(&255));
    }

    #[test]
    fn hostile_dimensions_are_rejected_and_short_data_is_padded() {
        let resolver = Data(Vec::new());
        let huge = dict(vec![
            ("Width", Object::Integer(1 << 20)),
            ("Height", Object::Integer(1 << 20)),
            ("ColorSpace", name("DeviceGray")),
        ]);
        let input = ImageInput {
            data: &[],
            dict: &huge,
            filter: None,
            parms: None,
        };
        assert!(decode_image(&context(&resolver, (10.0_f64, 10.0_f64)), &input).is_none());
        let short = dict(vec![
            ("Width", Object::Integer(3)),
            ("Height", Object::Integer(3)),
            ("ColorSpace", name("DeviceRGB")),
            ("BitsPerComponent", Object::Integer(16)),
        ]);
        let input_short = ImageInput {
            data: &[1, 2, 3],
            dict: &short,
            filter: None,
            parms: None,
        };
        let raster = rgba(decode_image(
            &context(&resolver, (3.0_f64, 3.0_f64)),
            &input_short,
        ));
        assert_eq!(raster.pixels.len(), 36);
        let jpeg = dict(vec![
            ("Width", Object::Integer(5)),
            ("Height", Object::Integer(5)),
        ]);
        let input_jpeg = ImageInput {
            data: &[0xFF, 0xD8],
            dict: &jpeg,
            filter: Some(b"DCTDecode"),
            parms: None,
        };
        assert!(matches!(
            decode_image(&context(&resolver, (5.0_f64, 5.0_f64)), &input_jpeg)
                .map(|decoded| decoded.image),
            Some(Pixels::Jpeg(_))
        ));
    }
}
