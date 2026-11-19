use core::array;

use crate::raster::Bits;

const GRID: u32 = 16;
const HEADER: usize = 24;
pub(crate) const PROTOTYPE_BYTES: usize = 48;
pub(crate) const TRANSITION_BYTES: usize = 12;
pub(crate) const MAGIC: &[u8; 4] = b"OCR1";

const UNCLASSIFIED: Choice = Choice {
    distance: f32::INFINITY,
    label: '\0',
};

static MODEL: &[u8] = include_bytes!("../data/recognition.bin");

#[derive(Clone, Copy, Debug)]
pub(crate) struct Features {
    pub(crate) geometry: [f32; 3],
    pub(crate) shape: [u64; 4],
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Metrics {
    pub(crate) baseline: f32,
    pub(crate) x_height: f32,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Choice {
    pub(crate) distance: f32,
    pub(crate) label: char,
}

fn sample_axis(low: u32, high: u32) -> [u32; 16] {
    let extent = high.saturating_sub(low);
    array::from_fn(|index| {
        let slot = u32::try_from(index).unwrap_or(0);
        let center = extent.saturating_mul(slot.saturating_mul(2).saturating_add(1));
        low.saturating_add(center >> 5)
    })
}

pub(crate) fn coordinate(value: u32) -> f32 {
    f32::from(u16::try_from(value).unwrap_or(u16::MAX))
}

fn pixel(row: &[u64], x: u32) -> bool {
    let index = usize::try_from(x >> 6_u32).unwrap_or(usize::MAX);
    row.get(index)
        .is_some_and(|word| word & (1_u64 << (x & 63)) != 0)
}

pub(crate) fn features(
    page: &Bits,
    [left, top, right, bottom]: [u32; 4],
    metrics: Metrics,
) -> Features {
    let mut shape = [0_u64; 4];
    let samples = sample_axis(left, right);
    let rows = sample_axis(top, bottom).into_iter().map(|yy| {
        let source = page.row(yy);
        samples.iter().fold(0_u64, |packed, &xx| {
            (packed << 1_u32) | u64::from(pixel(source, xx))
        })
    });
    for (index, row) in rows.enumerate() {
        if let Some(word) = shape.get_mut(index >> 2_u32) {
            *word = (*word << GRID) | row;
        }
    }
    let height = coordinate(bottom.saturating_sub(top));
    let width = coordinate(right.saturating_sub(left));
    let scale = metrics.x_height.max(1.0);
    Features {
        geometry: [
            width / height.max(1.0),
            height / scale,
            (coordinate(bottom) - metrics.baseline) / scale,
        ],
        shape,
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn distance(sample: &Features, prototype: &Features) -> f32 {
    geometry_distance(sample, prototype) + shape_distance(sample, prototype)
}

fn geometry_distance(sample: &Features, prototype: &Features) -> f32 {
    let [sw, sh, sb] = sample.geometry;
    let [pw, ph, pb] = prototype.geometry;
    54.0 * (sw - pw).abs() + 80.0 * (sh - ph).abs() + 45.0 * (sb - pb).abs()
}

fn shape_distance(sample: &Features, prototype: &Features) -> f32 {
    let [sa, sc, se, sg] = sample.shape;
    let [pa, pc, pe, pg] = prototype.shape;
    let ink = (sa ^ pa)
        .count_ones()
        .saturating_add((sc ^ pc).count_ones())
        .saturating_add((se ^ pe).count_ones())
        .saturating_add((sg ^ pg).count_ones());
    coordinate(ink)
}

fn decode_prototype(record: &[u8; PROTOTYPE_BYTES]) -> Option<(char, Features)> {
    let (shape, tail) = record.split_first_chunk::<32>()?;
    let ([first, second, third, fourth], []) = shape.as_chunks::<8>() else {
        return None;
    };
    let ([width, height, base, label], []) = tail.as_chunks::<4>() else {
        return None;
    };
    Some((
        char::from_u32(u32::from_le_bytes(*label))?,
        Features {
            geometry: [
                f32::from_le_bytes(*width),
                f32::from_le_bytes(*height),
                f32::from_le_bytes(*base),
            ],
            shape: [
                u64::from_le_bytes(*first),
                u64::from_le_bytes(*second),
                u64::from_le_bytes(*third),
                u64::from_le_bytes(*fourth),
            ],
        },
    ))
}

fn tables() -> (
    &'static [[u8; PROTOTYPE_BYTES]],
    &'static [[u8; TRANSITION_BYTES]],
) {
    if !MODEL.starts_with(MAGIC) {
        return (&[], &[]);
    }
    let count = MODEL
        .get(20..HEADER)
        .and_then(<[u8]>::first_chunk::<4>)
        .map_or(0, |bytes| u32::from_le_bytes(*bytes));
    let offset = usize::try_from(count)
        .unwrap_or(0)
        .saturating_mul(PROTOTYPE_BYTES);
    let Some((prototypes, transitions)) = MODEL
        .get(HEADER..)
        .and_then(|data| data.split_at_checked(offset))
    else {
        return (&[], &[]);
    };
    (prototypes.as_chunks().0, transitions.as_chunks().0)
}

pub(crate) fn classify(sample: &Features) -> [Choice; 4] {
    let (records, _) = tables();
    let mut choices = [UNCLASSIFIED; 4];
    let mut best = UNCLASSIFIED;
    let mut threshold = f32::INFINITY;
    for (label, prototype) in records.iter().filter_map(decode_prototype) {
        if label != best.label {
            retain_choice(&mut choices, best);
            threshold = choices
                .last()
                .map_or(f32::INFINITY, |choice| choice.distance);
            best = Choice {
                distance: f32::INFINITY,
                label,
            };
        }
        let geometry = geometry_distance(sample, &prototype);
        if geometry < best.distance.min(threshold) {
            best.distance = best
                .distance
                .min(geometry + shape_distance(sample, &prototype));
        }
    }
    retain_choice(&mut choices, best);
    choices
}

fn retain_choice(choices: &mut [Choice], candidate: Choice) {
    if let Some(index) = choices
        .iter()
        .position(|choice| candidate.distance < choice.distance)
        && let Some(tail) = choices.get_mut(index..)
    {
        tail.rotate_right(1);
        if let Some(first) = tail.first_mut() {
            *first = candidate;
        }
    }
}

pub(crate) fn transition(previous: char, next: char) -> f32 {
    let (_, transitions) = tables();
    let key = (u32::from(previous), u32::from(next));
    let found = transitions.binary_search_by_key(&key, |record| {
        let [a0, a1, a2, a3, b0, b1, b2, b3, _, _, _, _] = *record;
        (
            u32::from_le_bytes([a0, a1, a2, a3]),
            u32::from_le_bytes([b0, b1, b2, b3]),
        )
    });
    found
        .ok()
        .and_then(|index| transitions.get(index))
        .map_or(0.0, |record| {
            let [_, _, _, _, _, _, _, _, s0, s1, s2, s3] = *record;
            f32::from_le_bytes([s0, s1, s2, s3])
        })
}
