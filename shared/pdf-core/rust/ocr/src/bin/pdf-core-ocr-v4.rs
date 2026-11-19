#[cfg(not(target_arch = "wasm32"))]
use core::hint::black_box;
#[cfg(not(target_arch = "wasm32"))]
use std::env;
#[cfg(not(target_arch = "wasm32"))]
use std::fs;
#[cfg(not(target_arch = "wasm32"))]
use std::io::{self, Write as _};
#[cfg(not(target_arch = "wasm32"))]
use std::process::ExitCode;
#[cfg(not(target_arch = "wasm32"))]
use std::time::Instant;

#[cfg(not(target_arch = "wasm32"))]
use signature_kit_pdf_core_ocr::sequence_v4::Probe;

#[cfg(not(target_arch = "wasm32"))]
fn run() -> io::Result<()> {
    let mut args = env::args().skip(1);
    let mode = args.next();
    let path = args
        .next()
        .ok_or_else(|| io::Error::other("expected an OCR v4 probe packet"))?;
    let bytes = fs::read(path)?;
    let mut probe =
        Probe::decode(&bytes).ok_or_else(|| io::Error::other("invalid OCR v4 probe packet"))?;
    match mode.as_deref() {
        Some("fixture") => io::stdout().lock().write_all(&probe.fixture()),
        Some("text") => {
            let mut text = String::new();
            probe.transcript(|character| text.push(character));
            io::stdout().lock().write_all(text.as_bytes())
        }
        Some("bench") => {
            let repeats = args
                .next()
                .and_then(|arg| arg.parse::<u32>().ok())
                .filter(|&count| count != 0)
                .ok_or_else(|| io::Error::other("expected a positive repetition count"))?;
            let mut text = String::new();
            for _iteration in 0..8 {
                text.clear();
                probe.transcript(|char| text.push(char));
            }
            let start = Instant::now();
            for _iteration in 0..repeats {
                text.clear();
                probe.transcript(|char| text.push(char));
                let _observed = black_box(&text);
            }
            let mean = start.elapsed().as_secs_f64() * 1000.0 / f64::from(repeats);
            writeln!(io::stdout().lock(), "{mean:.6} ms/line, repeats={repeats}")
        }
        _ => Err(io::Error::other("expected fixture, text or bench")),
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(cause) => {
            let _written = writeln!(io::stderr().lock(), "{cause}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(target_arch = "wasm32")]
fn main() {}
