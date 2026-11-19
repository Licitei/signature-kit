use std::io::Write;
use std::path::PathBuf;
use std::time::Instant;
use std::{env, fs, io};

use signature_kit_pdf_core_ocr::engine::{Options, PageResult, PreparedPage, prepare_page};
use signature_kit_pdf_core_ocr::{jpeg, raster};

const USAGE: &str = if cfg!(feature = "ctc-probe") {
    "Usage: pdf-core-ocr <image.pgm|jpg> [--dpi N] [--json out] [--layout-only] [--timings] [--ctc-model path]"
} else {
    "Usage: pdf-core-ocr <image.pgm|jpg> [--dpi N] [--json out] [--layout-only] [--timings]"
};

struct Arguments {
    dpi: f32,
    input: PathBuf,
    layout_only: bool,
    output: Option<PathBuf>,
    #[cfg(feature = "ctc-probe")]
    sequence: Option<PathBuf>,
    timings: bool,
}

fn arguments() -> Result<Arguments, String> {
    let mut values = env::args_os().skip(1);
    let mut parsed = Arguments {
        dpi: 300.0,
        input: values
            .next()
            .map(PathBuf::from)
            .ok_or_else(|| String::from(USAGE))?,
        layout_only: false,
        output: None,
        #[cfg(feature = "ctc-probe")]
        sequence: None,
        timings: false,
    };
    while let Some(flag) = values.next() {
        match flag.to_str() {
            Some("--dpi") => {
                parsed.dpi = values
                    .next()
                    .and_then(|value| value.to_str()?.parse::<f32>().ok())
                    .filter(|dpi| (1.0..=65_535.0).contains(dpi))
                    .ok_or_else(|| String::from("--dpi requires a number between 1 and 65535"))?;
            }
            Some("--json") => {
                parsed.output = Some(
                    values
                        .next()
                        .map(PathBuf::from)
                        .ok_or_else(|| String::from("--json requires a path"))?,
                );
            }
            #[cfg(feature = "ctc-probe")]
            Some("--ctc-model") => {
                parsed.sequence = Some(
                    values
                        .next()
                        .map(PathBuf::from)
                        .ok_or_else(|| String::from("--ctc-model requires a path"))?,
                );
            }
            Some("--layout-only") => parsed.layout_only = true,
            Some("--timings") => parsed.timings = true,
            _ => {
                return Err(format!(
                    "Unknown option: {}\n{USAGE}",
                    flag.to_string_lossy()
                ));
            }
        }
    }
    Ok(parsed)
}

fn json_string(output: &mut dyn Write, text: &str) -> io::Result<()> {
    output.write_all(b"\"")?;
    for character in text.chars() {
        match character {
            '"' => output.write_all(b"\\\"")?,
            '\\' => output.write_all(b"\\\\")?,
            '\n' => output.write_all(b"\\n")?,
            '\r' => output.write_all(b"\\r")?,
            '\t' => output.write_all(b"\\t")?,
            control if control <= '\u{1f}' => write!(output, "\\u{:04x}", u32::from(control))?,
            _ => write!(output, "{character}")?,
        }
    }
    output.write_all(b"\"")
}

fn write_numbers(output: &mut dyn Write, values: &[u32]) -> io::Result<()> {
    output.write_all(b"[")?;
    for (index, value) in values.iter().enumerate() {
        if index != 0 {
            output.write_all(b",")?;
        }
        write!(output, "{value}")?;
    }
    output.write_all(b"]")
}

fn write_recognition(output: &mut dyn Write, result: &PageResult) -> io::Result<()> {
    write!(
        output,
        "{{\"width\":{},\"height\":{},\"words\":[",
        result.width, result.height
    )?;
    for (index, word) in result.words.iter().enumerate() {
        if index != 0 {
            output.write_all(b",")?;
        }
        output.write_all(b"{\"box\":")?;
        write_numbers(output, &word.bbox)?;
        write!(
            output,
            ",\"confidence\":{},\"line\":{},\"text\":",
            word.confidence, word.line
        )?;
        json_string(output, &word.text)?;
        output.write_all(b"}")?;
    }
    output.write_all(b"],\"text\":")?;
    json_string(output, &result.text)?;
    output.write_all(b"}\n")
}

fn write_layout(output: &mut dyn Write, result: &PreparedPage) -> io::Result<()> {
    write!(
        output,
        "{{\"width\":{},\"height\":{},\"skewDegrees\":{},\"lines\":[",
        result.page.width,
        result.page.height,
        result.skew_degrees()
    )?;
    for (index, line) in result.layout.lines.iter().enumerate() {
        if index != 0 {
            output.write_all(b",")?;
        }
        output.write_all(b"{\"box\":")?;
        write_numbers(output, &line.bbox)?;
        output.write_all(b",\"sourceBox\":")?;
        write_numbers(output, &result.source_box(line.bbox))?;
        write!(
            output,
            ",\"baseline\":{},\"xHeight\":{},\"block\":{},\"words\":[",
            line.baseline, line.x_height, line.block
        )?;
        for (word_index, word) in line.words.iter().enumerate() {
            if word_index != 0 {
                output.write_all(b",")?;
            }
            output.write_all(b"{\"box\":")?;
            write_numbers(output, &word.bbox)?;
            output.write_all(b"}")?;
        }
        output.write_all(b"]}")?;
    }
    output.write_all(b"],\"tables\":[")?;
    for (index, grid) in result.tables.iter().enumerate() {
        if index != 0 {
            output.write_all(b",")?;
        }
        output.write_all(b"{\"columns\":")?;
        write_numbers(output, &grid.columns)?;
        output.write_all(b",\"rows\":")?;
        write_numbers(output, &grid.rows)?;
        output.write_all(b"}")?;
    }
    output.write_all(b"]}\n")
}

fn run() -> Result<(), String> {
    let args = arguments()?;
    let bytes =
        fs::read(&args.input).map_err(|cause| format!("{}: {cause}", args.input.display()))?;
    let started = Instant::now();
    let gray = if bytes.starts_with(b"P5") {
        raster::read_pgm(&bytes).map_err(|cause| format!("PGM: {cause:?}"))
    } else {
        jpeg::decode(&bytes).map_err(|cause| format!("JPEG: {cause:?}"))
    }?;
    let mut timing = vec![(String::from("Decode"), started.elapsed())];
    let mut checkpoint = Instant::now();
    let prepared = prepare_page(&gray, args.dpi, &Options::default(), |stage| {
        timing.push((format!("{stage:?}"), checkpoint.elapsed()));
        checkpoint = Instant::now();
    })
    .map_err(|cause| format!("Layout: {cause:?}"))?;
    let mut output: Box<dyn Write> = if let Some(path) = args.output {
        Box::new(io::BufWriter::new(
            fs::File::create(path).map_err(|cause| cause.to_string())?,
        ))
    } else {
        Box::new(io::stdout().lock())
    };
    if args.layout_only {
        write_layout(&mut output, &prepared)
    } else {
        let start = Instant::now();
        #[cfg(feature = "ctc-probe")]
        let result = if let Some(path) = args.sequence {
            let table = fs::read(&path).map_err(|cause| format!("{}: {cause}", path.display()))?;
            prepared
                .recognize_sequence(&table)
                .ok_or_else(|| String::from("Invalid CTC table for this build"))?
        } else {
            prepared.recognize()
        };
        #[cfg(not(feature = "ctc-probe"))]
        let result = prepared.recognize();
        timing.push((String::from("Recognize"), start.elapsed()));
        write_recognition(&mut output, &result)
    }
    .and_then(|()| output.flush())
    .map_err(|cause| cause.to_string())?;

    if args.timings {
        let mut stderr = io::stderr().lock();
        for (stage, elapsed) in timing {
            writeln!(
                stderr,
                "{stage} {:.3} ms",
                elapsed.as_secs_f64() * 1000.0_f64
            )
            .map_err(|cause| cause.to_string())?;
        }
    }
    Ok(())
}

fn main() -> Result<(), String> {
    run()
}
