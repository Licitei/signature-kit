mod degrade;
mod jpeg;

use core::{array, str};

use std::env;
use std::io::{self, Read as _, Write as _};
use std::process::ExitCode;

use signature_kit_pdf_core_ocr::jpeg as decode_jpeg;

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

#[expect(
    clippy::significant_drop_tightening,
    reason = "keep both stdio locks for the entire training stream"
)]
fn line_stream() -> io::Result<()> {
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    loop {
        let mut header = [0_u8; 83];
        if input.read(
            header
                .get_mut(..1)
                .ok_or_else(|| io::Error::other("empty header"))?,
        )? == 0
        {
            return Ok(());
        }
        input.read_exact(
            header
                .get_mut(1..)
                .ok_or_else(|| io::Error::other("short header"))?,
        )?;
        let (geometry, metadata) = header
            .split_first_chunk::<8>()
            .ok_or_else(|| io::Error::other("invalid raster geometry"))?;
        let (effects, mode) = metadata
            .split_first_chunk::<72>()
            .ok_or_else(|| io::Error::other("invalid degradation parameters"))?;
        let ([width_bytes, height_bytes, seed_low, seed_high], []) = geometry.as_chunks::<2>()
        else {
            return Err(io::Error::other("invalid raster dimensions"));
        };
        let [morph, threshold, quality] = mode else {
            return Err(io::Error::other("invalid mode"));
        };
        let [aa, bb] = *seed_low;
        let [cc, dd] = *seed_high;
        let seed = u32::from_le_bytes([aa, bb, cc, dd]);
        let width = usize::from(u16::from_le_bytes(*width_bytes));
        let height = usize::from(u16::from_le_bytes(*height_bytes));
        if !(1..=8192).contains(&width) || !(1..=1024).contains(&height) {
            return Err(io::Error::other("invalid scan line dimensions"));
        }
        let (encoded_effects, _) = effects.as_chunks::<8>();
        let values = encoded_effects.iter().map(|data| f64::from_le_bytes(*data));
        let mut effects_iter = values.clone();
        let [
            Some(angle),
            Some(warp),
            Some(blur),
            Some(noise),
            Some(impulse),
            Some(brightness),
            Some(contrast),
            Some(gamma),
            Some(shade),
        ] = array::from_fn(|_| effects_iter.next())
        else {
            return Err(io::Error::other("invalid effects"));
        };
        if values.into_iter().any(|value| !value.is_finite()) {
            return Err(io::Error::other("non-finite scan degradation"));
        }
        let params = degrade::Params {
            angle,
            warp,
            blur: blur.clamp(0.0_f64, 4.0_f64),
            noise,
            impulse: impulse.clamp(0.0_f64, 1.0_f64),
            brightness,
            contrast,
            gamma: gamma.clamp(0.1_f64, 5.0_f64),
            shade,
            morph: i8::from_le_bytes([*morph]),
            threshold: *threshold,
            seed,
        };
        let mut pixels = vec![0; width.saturating_mul(height)];
        input.read_exact(&mut pixels)?;
        let mut raster = Raster {
            height,
            pixels,
            width,
        };
        degrade::apply(&mut raster, &params);
        if *quality != 0 {
            let encoded = jpeg::encode(&raster, (*quality).clamp(1, 100));
            let decoded = decode_jpeg::decode(&encoded)
                .map_err(|cause| io::Error::other(format!("{cause:?}")))?;
            output.write_all(&decoded.pixels)?;
        } else {
            output.write_all(&raster.pixels)?;
        }
        output.flush()?;
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
        output.write_all(&jpeg::encode(&raster, quality.clamp(1, 100)))?;
    }
    output.flush()
}

fn main() -> ExitCode {
    let result = if env::args().nth(1).as_deref() == Some("--line-stream") {
        line_stream()
    } else {
        execute()
    };
    if let Err(error) = result {
        drop(writeln!(io::stderr().lock(), "{error}"));
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}
