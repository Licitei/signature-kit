use alloc::rc::Rc;

use crate::color::ColorSpace;
use crate::diagnostics::{PageScan, intersection};
use crate::document::{Document, Page};
use crate::failure::{FailureCode, Outcome};
use crate::filters;
use crate::image::{
    ImageContext, ImageInput, Pixels, Raster, decode_image, dimensions, image_filter,
    normalized_inline,
};
use crate::inspection::Limits;
use crate::object::{Dict, Object, Resolver as _};
use crate::png;
use crate::text::{Capture, Session, scan_page};

type Rect = [f64; 4];

pub(crate) type PageImage = Result<Extracted, Absent>;
pub(crate) type Placement = [f64; 6];

#[derive(Debug)]
pub(crate) enum ImageSource {
    Inline(Box<(Dict, Vec<u8>)>),
    XObject(Rc<Object>),
}

#[derive(Debug)]
pub(crate) struct Candidate {
    pub coverage: f64,
    pub placement: Placement,
    pub resources: Rc<Object>,
    pub source: ImageSource,
}

#[derive(Debug)]
pub(crate) enum Absent {
    DecodeFailed,
    MaskedJpeg,
    NoDominantImage,
    UnsupportedFilter,
}

#[derive(Debug)]
pub(crate) enum Encoding {
    Gray,
    Jpeg { cmyk: bool, decode: Vec<f64> },
    Png,
}

#[derive(Debug)]
pub(crate) struct Extracted {
    pub bytes: Vec<u8>,
    pub coverage: f64,
    pub dpi_x: f64,
    pub dpi_y: f64,
    pub encoding: Encoding,
    pub height: u32,
    pub placement: Placement,
    pub rotate: i32,
    pub width: u32,
}

#[derive(Debug)]
pub(crate) struct Footprint {
    bounds: Rect,
    polygon: Vec<(f64, f64)>,
}

impl Footprint {
    pub(crate) fn area(&self) -> f64 {
        let [left, bottom, right, top] = self.bounds;
        if self.polygon.is_empty() {
            return (right - left) * (top - bottom);
        }
        let mut last = self.polygon.last().copied().unwrap_or_default();
        let mut twice_area = 0.0_f64;
        for &(x, y) in &self.polygon {
            twice_area += (last.0 - left) * (y - bottom) - (x - left) * (last.1 - bottom);
            last = (x, y);
        }
        twice_area.abs() * 0.5_f64
    }

    #[inline(never)]
    pub(crate) fn boxes(&self, boxes: &mut Vec<Rect>) {
        if self.polygon.is_empty() {
            boxes.push(self.bounds);
            return;
        }
        let mut breaks: Vec<f64> = self.polygon.iter().map(|&(_, y)| y).collect();
        breaks.sort_unstable_by(f64::total_cmp);
        for pair in breaks.windows(2) {
            let [bottom, top] = pair else {
                continue;
            };
            if bottom >= top {
                continue;
            }
            let step = (top - bottom) / 8.0_f64;
            for band in 0..8_u32 {
                let start = bottom + f64::from(band) * step;
                let mid = start + step * 0.5_f64;
                let mut left = f64::INFINITY;
                let mut right = f64::NEG_INFINITY;
                let mut last = self.polygon.last().copied().unwrap_or_default();
                for &(x, y) in &self.polygon {
                    let (x0, y0) = last;
                    last = (x, y);
                    if mid >= y0.min(y) && mid < y0.max(y) {
                        let run = x0 + (x - x0) * ((mid - y0) / (y - y0));
                        left = left.min(run);
                        right = right.max(run);
                    }
                }
                let end = top.min(start + step);
                if left < right && start < end {
                    boxes.push([left, start, right, end]);
                }
            }
        }
    }

    #[inline(never)]
    pub(crate) fn clipped(placement: Placement, clip: Rect) -> Option<Self> {
        let [a, b, c, d, e, f] = placement;
        let corners = [
            (e, f),
            (a + e, b + f),
            (a + c + e, b + d + f),
            (c + e, d + f),
        ];
        if !corners.iter().all(|(x, y)| x.is_finite() && y.is_finite()) {
            return None;
        }
        let [left, bottom, right, top] = clip;
        let bounds = intersection(polygon_bounds(&corners), clip)?;
        if b == 0.0_f64 && c == 0.0_f64 || a == 0.0_f64 && d == 0.0_f64 {
            return Some(Self {
                bounds,
                polygon: Vec::new(),
            });
        }
        let mut polygon = corners.to_vec();
        for (horizontal, boundary, increasing) in [
            (true, left, true),
            (true, right, false),
            (false, bottom, true),
            (false, top, false),
        ] {
            polygon = clip_edge(&polygon, horizontal, boundary, increasing);
        }
        (polygon.len() >= 3).then_some(Self { bounds, polygon })
    }
}

impl Candidate {
    #[inline(never)]
    fn decode(
        self,
        document: &Document<'_>,
        page: &Page,
        limits: &Limits,
        gray: bool,
    ) -> Outcome<PageImage> {
        let inline;
        let shared;
        let (dict, stream, inline_bytes) = match self.source {
            ImageSource::Inline(source) => {
                let (raw, bytes) = *source;
                inline = (normalized_inline(raw), bytes);
                (&inline.0, None, inline.1.as_slice())
            }
            ImageSource::XObject(object) => {
                shared = object;
                let Some(stream) = shared.as_stream() else {
                    return Ok(Err(Absent::DecodeFailed));
                };
                (&stream.dict, Some(stream), &[][..])
            }
        };
        let (filter, parms) = image_filter(document, dict);
        if matches!(filter.as_deref(), Some(b"JBIG2Decode" | b"JPXDecode")) {
            return Ok(Err(Absent::UnsupportedFilter));
        }
        let data = stream.map_or_else(
            || filters::decode_stream(dict, inline_bytes, limits.max_decoded_stream_bytes, None),
            |reference| document.stream_data(reference),
        );
        let bytes = match data {
            Ok(contents) => contents,
            Err(failure) if failure.code == FailureCode::LimitExceeded => return Err(failure),
            Err(failure) if failure.code == FailureCode::UnsupportedFeature => {
                return Ok(Err(Absent::UnsupportedFilter));
            }
            Err(_) => return Ok(Err(Absent::DecodeFailed)),
        };
        let named = self
            .resources
            .as_dict()
            .and_then(|resources| resources.get(b"ColorSpace"))
            .and_then(|entry| document.follow(entry).ok());
        let space = dict.get(b"ColorSpace").and_then(|entry| {
            ColorSpace::parse(document, entry, named.as_deref().and_then(Object::as_dict))
        });
        let (raster, encoding) = if filter.as_deref() == Some(b"DCTDecode") {
            match jpeg(document, dict, space.as_ref(), bytes) {
                Ok(result) => result,
                Err(reason) => return Ok(Err(reason)),
            }
        } else {
            let context = ImageContext {
                device: (f64::INFINITY, f64::INFINITY),
                fill: [0, 0, 0, 255],
                max_bytes: limits.max_decoded_stream_bytes,
                resolver: document,
                space: space.as_ref(),
            };
            let input = ImageInput {
                data: &bytes,
                dict,
                filter: filter.as_deref(),
                parms: parms.as_ref(),
            };
            let Some(decoded) = decode_image(&context, &input) else {
                return Ok(Err(Absent::DecodeFailed));
            };
            let Pixels::Raster(mut raster) = decoded.image else {
                return Ok(Err(Absent::DecodeFailed));
            };
            if decoded.mask.is_some() {
                return Ok(Err(Absent::DecodeFailed));
            }
            let encoding = if gray {
                raster.pixels = raster
                    .pixels
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .copied()
                    .map(gray_pixel)
                    .collect();
                Encoding::Gray
            } else {
                raster.pixels = png::encode_rgba(raster.width, raster.height, &raster.pixels)?;
                Encoding::Png
            };
            (raster, encoding)
        };
        let unit = page
            .dict
            .get(b"UserUnit")
            .and_then(|entry| document.follow(entry).ok())
            .and_then(|value| value.as_number())
            .filter(|value| value.is_finite() && *value > 0.0_f64)
            .unwrap_or(1.0_f64);
        let [a, b, c, d, _, _] = self.placement;
        let Raster {
            width,
            height,
            pixels,
        } = raster;
        let dpi_x = 72.0_f64 * f64::from(width) / ((a * a + b * b).sqrt() * unit);
        let dpi_y = 72.0_f64 * f64::from(height) / ((c * c + d * d).sqrt() * unit);
        if !dpi_x.is_finite() || !dpi_y.is_finite() || dpi_x <= 0.0_f64 || dpi_y <= 0.0_f64 {
            return Ok(Err(Absent::DecodeFailed));
        }
        Ok(Ok(Extracted {
            bytes: pixels,
            coverage: self.coverage,
            dpi_x,
            dpi_y,
            encoding,
            height,
            placement: self.placement,
            rotate: page.info.rotate,
            width,
        }))
    }
}

#[inline(never)]
fn clip_edge(
    polygon: &[(f64, f64)],
    horizontal: bool,
    boundary: f64,
    increasing: bool,
) -> Vec<(f64, f64)> {
    let coord = |(x, y)| if horizontal { x } else { y };
    let inside = |value| {
        if increasing {
            value >= boundary
        } else {
            value <= boundary
        }
    };
    let mut next = Vec::with_capacity(8);
    let Some(mut last) = polygon.last().copied() else {
        return next;
    };
    for &point in polygon {
        let before = inside(coord(last));
        let after = inside(coord(point));
        if before != after {
            let fraction = (boundary - coord(last)) / (coord(point) - coord(last));
            let (x, y) = (
                last.0 + fraction * (point.0 - last.0),
                last.1 + fraction * (point.1 - last.1),
            );
            next.push(if horizontal {
                (boundary, y)
            } else {
                (x, boundary)
            });
        }
        if after {
            next.push(point);
        }
        last = point;
    }
    next
}

fn gray_pixel([red, green, blue, alpha]: [u8; 4]) -> u8 {
    let luma = (77_u32
        .saturating_mul(u32::from(red))
        .saturating_add(150_u32.saturating_mul(u32::from(green)))
        .saturating_add(29_u32.saturating_mul(u32::from(blue)))
        .saturating_add(128))
        >> 8_u32;
    let opacity = u32::from(alpha);
    let composite = luma
        .saturating_mul(opacity)
        .saturating_add(255_u32.saturating_mul(255_u32.saturating_sub(opacity)))
        .saturating_add(127)
        .checked_div(255)
        .unwrap_or_default();
    u8::try_from(composite).unwrap_or(u8::MAX)
}

fn jpeg(
    document: &Document<'_>,
    dict: &Dict,
    space: Option<&ColorSpace>,
    bytes: Vec<u8>,
) -> Result<(Raster, Encoding), Absent> {
    let masked = dict
        .get(b"SMask")
        .is_some_and(|entry| !matches!(entry, Object::Name(name) if name == b"None"))
        || dict.get(b"Mask").is_some();
    if masked {
        return Err(Absent::MaskedJpeg);
    }
    let (width, height) = dimensions(document, dict).ok_or(Absent::DecodeFailed)?;
    if !bytes.starts_with(&[0xff, 0xd8]) {
        return Err(Absent::DecodeFailed);
    }
    let decode = dict
        .get(b"Decode")
        .and_then(|entry| document.follow(entry).ok())
        .and_then(|value| {
            let items = value.as_array()?;
            if items.len() > 8 {
                return None;
            }
            items
                .iter()
                .map(|item| item.as_number().filter(|number| number.is_finite()))
                .collect()
        })
        .unwrap_or_default();
    let raster = Raster {
        width: u32::try_from(width).map_err(|_conversion| Absent::DecodeFailed)?,
        height: u32::try_from(height).map_err(|_conversion| Absent::DecodeFailed)?,
        pixels: bytes,
    };
    Ok((
        raster,
        Encoding::Jpeg {
            cmyk: space.is_some_and(|color| color.components() == 4),
            decode,
        },
    ))
}

#[inline(never)]
pub(crate) fn extract_image(
    document: &Document<'_>,
    page: &Page,
    limits: &Limits,
    session: &mut Session,
    gray: bool,
) -> Outcome<PageImage> {
    let mut scan = PageScan::for_images(page.info.crop_box);
    drop(scan_page(
        document,
        page,
        limits,
        Capture::default(),
        session,
        Some(&mut scan),
    )?);
    scan.dominant()
        .map_or(Ok(Err(Absent::NoDominantImage)), |candidate| {
            candidate.decode(document, page, limits, gray)
        })
}

fn polygon_bounds(points: &[(f64, f64)]) -> Rect {
    points.iter().fold(
        [
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        ],
        |[left, bottom, right, top], &(x, y)| {
            [left.min(x), bottom.min(y), right.max(x), top.max(y)]
        },
    )
}
