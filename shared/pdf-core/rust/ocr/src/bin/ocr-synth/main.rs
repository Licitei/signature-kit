mod degrade;
mod jpeg;

use core::str;

use std::env;
use std::io::{self, Read as _, Write as _};
use std::process::ExitCode;

use signature_kit_pdf_core_ocr as _;

#[derive(Debug)]
struct Raster {
    height: usize,
    pixels: Vec<u8>,
    width: usize,
}

impl Raster {
    fn nearest(&self, x: usize, y: usize) -> u8 {
        let column = x.min(self.width.saturating_sub(1));
        let row = y.min(self.height.saturating_sub(1));
        self.pixels
            .get(row.saturating_mul(self.width).saturating_add(column))
            .copied()
            .unwrap_or(255)
    }

    fn parse(input: &[u8]) -> Option<Self> {
        let mut header = input.splitn(4, |byte| *byte == b'\n');
        if header.next()? != b"P5" {
            return None;
        }
        let dimensions = str::from_utf8(header.next()?).ok()?;
        let (raw_width, raw_height) = dimensions.split_once(' ')?;
        let width = raw_width.parse::<u16>().ok().map(usize::from)?;
        let height = raw_height.parse::<u16>().ok().map(usize::from)?;
        if header.next()? != b"255" || width == 0 || height == 0 {
            return None;
        }
        let pixels = header.next()?;
        if pixels.len() != width.checked_mul(height)? {
            return None;
        }
        Some(Self {
            height,
            pixels: pixels.to_vec(),
            width,
        })
    }
}

fn execute() -> io::Result<()> {
    let args: Vec<String> = env::args().skip(1).collect();
    let [
        seed,
        angle,
        warp,
        blur,
        noise,
        impulse,
        brightness,
        contrast,
        gamma,
        shade,
        morph,
        threshold,
        jpeg_quality,
    ] = args.as_slice()
    else {
        return Err(io::Error::other(
            "expected seed, angle, warp, blur, noise, impulse, brightness, contrast, gamma, shade, morphology, threshold, JPEG quality",
        ));
    };
    let real = |value: &str| {
        value
            .parse::<f64>()
            .ok()
            .filter(|number| number.is_finite())
            .ok_or_else(|| io::Error::other("invalid numeric degradation parameter"))
    };
    let params = degrade::Params {
        angle: real(angle)?,
        blur: real(blur)?.clamp(0.0_f64, 4.0_f64),
        brightness: real(brightness)?,
        contrast: real(contrast)?,
        gamma: real(gamma)?.clamp(0.1_f64, 5.0_f64),
        impulse: real(impulse)?.clamp(0.0_f64, 1.0_f64),
        morph: morph.parse().map_err(io::Error::other)?,
        noise: real(noise)?,
        seed: seed.parse().map_err(io::Error::other)?,
        shade: real(shade)?,
        threshold: threshold.parse().map_err(io::Error::other)?,
        warp: real(warp)?,
    };
    let quality = jpeg_quality.parse::<u8>().map_err(io::Error::other)?;
    let mut input = Vec::new();
    let _count = io::stdin()
        .lock()
        .take(32_000_100)
        .read_to_end(&mut input)?;
    let mut raster =
        Raster::parse(&input).ok_or_else(|| io::Error::other("expected an 8-bit P5 raster"))?;
    degrade::apply(&mut raster, &params);
    let header = format!("P5\n{} {}\n255\n", raster.width, raster.height);
    let len = u32::try_from(header.len().saturating_add(raster.pixels.len()))
        .map_err(io::Error::other)?;
    let mut output = io::stdout().lock();
    output.write_all(&len.to_le_bytes())?;
    output.write_all(header.as_bytes())?;
    output.write_all(&raster.pixels)?;
    if quality != 0 {
        output.write_all(&jpeg::encode(&raster, quality.clamp(30, 90)))?;
    }
    output.flush()
}

fn main() -> ExitCode {
    if let Err(error) = execute() {
        drop(writeln!(io::stderr().lock(), "{error}"));
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}
