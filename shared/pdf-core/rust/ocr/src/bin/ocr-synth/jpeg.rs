use core::array;
use core::f64::consts::{FRAC_1_SQRT_2, PI};

use super::Raster;

const ZIGZAG: [usize; 64] = [
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20,
    13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59,
    52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

const QUANT: [u16; 64] = [
    16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56,
    14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113,
    92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];

struct Entropy {
    bytes: Vec<u8>,
    bits: u32,
    used: u32,
}

impl Entropy {
    fn block(&mut self, coefficients: &[i16; 64], previous: &mut i16) {
        let dc = coefficients.first().copied().unwrap_or(0);
        let difference = dc.saturating_sub(*previous);
        *previous = dc;
        let dc_size = category(difference);
        self.write(dc_size, 4);
        self.value(difference, dc_size);
        let mut run = 0_u32;
        for &ac in coefficients.iter().skip(1) {
            if ac == 0 {
                run = run.saturating_add(1);
                continue;
            }
            while run >= 16 {
                self.write(1, 8);
                run = run.saturating_sub(16);
            }
            let size = category(ac);
            self.write(
                run.saturating_mul(10)
                    .saturating_add(size)
                    .saturating_add(1),
                8,
            );
            self.value(ac, size);
            run = 0;
        }
        if run != 0 {
            self.write(0, 8);
        }
    }
    fn value(&mut self, value: i16, count: u32) {
        if count != 0 {
            let limit = 1_u32.wrapping_shl(count).saturating_sub(1);
            let magnitude = u32::from(value.unsigned_abs());
            self.write(
                if value < 0 {
                    limit.saturating_sub(magnitude)
                } else {
                    magnitude
                },
                count,
            );
        }
    }

    fn write(&mut self, value: u32, count: u32) {
        self.bits = self.bits.wrapping_shl(count) | value;
        self.used = self.used.saturating_add(count);
        while self.used >= 8 {
            self.used = self.used.saturating_sub(8);
            let byte = self
                .bits
                .wrapping_shr(self.used)
                .to_le_bytes()
                .first()
                .copied()
                .unwrap_or(0);
            self.bytes.push(byte);
            if byte == 255 {
                self.bytes.push(0);
            }
        }
    }
}

const fn category(value: i16) -> u32 {
    i16::BITS.saturating_sub(value.unsigned_abs().leading_zeros())
}

#[expect(
    clippy::as_conversions,
    clippy::cast_possible_truncation,
    reason = "baseline coefficients are rounded and clamped to their category ranges"
)]
fn coefficient(value: f64, limit: f64) -> i16 {
    value.round().clamp(-limit, limit) as i16
}

fn basis() -> [[f64; 8]; 8] {
    array::from_fn(|frequency| {
        let scale = if frequency == 0 {
            FRAC_1_SQRT_2 * 0.5_f64
        } else {
            0.5_f64
        };
        let band = f64::from(u32::try_from(frequency).unwrap_or(0));
        array::from_fn(|sample| {
            let at = f64::from(u32::try_from(sample).unwrap_or(0));
            scale * ((2.0_f64 * at + 1.0_f64) * band * PI / 16.0_f64).cos()
        })
    })
}

fn dct(
    raster: &Raster,
    left: usize,
    top: usize,
    basis: &[[f64; 8]; 8],
    quant: &[u8; 64],
) -> [i16; 64] {
    let horizontal: [[f64; 8]; 8] = array::from_fn(|row| {
        basis.map(|filter| {
            filter
                .into_iter()
                .enumerate()
                .map(|(column, weight)| {
                    (f64::from(
                        raster.nearest(left.saturating_add(column), top.saturating_add(row)),
                    ) - 128.0_f64)
                        * weight
                })
                .sum()
        })
    });
    array::from_fn(|at| {
        let natural = ZIGZAG.get(at).copied().unwrap_or(0);
        let row = natural >> 3_u8;
        let column = natural & 7_usize;
        let Some(filter) = basis.get(row) else {
            return 0;
        };
        let result: f64 = horizontal
            .iter()
            .zip(filter)
            .map(|(line, weight)| line.get(column).copied().unwrap_or(0.0_f64) * weight)
            .sum();
        let divisor = f64::from(quant.get(at).copied().unwrap_or(1));
        coefficient(
            result / divisor,
            if at == 0 { 1_024.0_f64 } else { 1_023.0_f64 },
        )
    })
}

fn marker(output: &mut Vec<u8>, code: u8, body: &[u8]) {
    let length = u16::try_from(body.len().saturating_add(2)).unwrap_or(u16::MAX);
    output.extend_from_slice(&[255, code]);
    output.extend_from_slice(&length.to_be_bytes());
    output.extend_from_slice(body);
}

fn huffman(output: &mut Vec<u8>) {
    let mut dc = vec![0, 0, 0, 0, 12];
    dc.resize(17, 0);
    dc.extend(0_u8..12);
    marker(output, 0xC4, &dc);
    let mut ac = vec![0x10];
    ac.resize(8, 0);
    ac.push(162);
    ac.resize(17, 0);
    ac.extend([0, 0xF0]);
    for run in 0_u8..16 {
        ac.extend((1_u8..=10).map(|size| (run << 4_u8) | size));
    }
    marker(output, 0xC4, &ac);
}

pub(super) fn encode(raster: &Raster, quality: u8) -> Vec<u8> {
    let scale = if quality < 50 {
        5_000_u16.checked_div(u16::from(quality)).unwrap_or(100)
    } else {
        200_u16.saturating_sub(2_u16.saturating_mul(u16::from(quality)))
    };
    let quant = ZIGZAG.map(|index| {
        let value = QUANT.get(index).copied().unwrap_or(16);
        let scaled = value
            .saturating_mul(scale)
            .saturating_add(50)
            .checked_div(100)
            .unwrap_or(1);
        u8::try_from(scaled.clamp(1, 255)).unwrap_or(255)
    });
    let mut entropy = Entropy {
        bytes: vec![255, 0xD8],
        bits: 0,
        used: 0,
    };
    let mut table = vec![0];
    table.extend(quant);
    marker(&mut entropy.bytes, 0xDB, &table);
    let mut frame = vec![8];
    frame.extend(
        u16::try_from(raster.height)
            .unwrap_or(u16::MAX)
            .to_be_bytes(),
    );
    frame.extend(
        u16::try_from(raster.width)
            .unwrap_or(u16::MAX)
            .to_be_bytes(),
    );
    frame.extend([1, 1, 0x11, 0]);
    marker(&mut entropy.bytes, 0xC0, &frame);
    huffman(&mut entropy.bytes);
    marker(&mut entropy.bytes, 0xDA, &[1, 1, 0, 0, 63, 0]);
    let basis = basis();
    let mut previous = 0;
    for y in (0..raster.height).step_by(8) {
        for x in (0..raster.width).step_by(8) {
            entropy.block(&dct(raster, x, y, &basis, &quant), &mut previous);
        }
    }
    if entropy.used != 0 {
        let remaining = 8_u32.saturating_sub(entropy.used);
        entropy.write(1_u32.wrapping_shl(remaining).saturating_sub(1), remaining);
    }
    entropy.bytes.extend_from_slice(&[255, 0xD9]);
    entropy.bytes
}
