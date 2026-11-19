use core::str;
use std::fs::File;
use std::io::{self, BufRead as _, BufReader, Read as _, Write as _};
use std::path::Path;

use crate::binarize::binarize;
use crate::raster::Gray;
use crate::segment::segment;
use crate::sequence_training::Example;
use crate::training::{digest, sequence_geometry};

pub(crate) const MAGIC: &[u8; 8] = b"OCRL\x01\0\0\0";

pub(crate) fn read(
    archive: &Path,
    mut input: BufReader<File>,
    hash: &mut u64,
    samples: &mut Vec<Example>,
) -> io::Result<()> {
    *hash = digest(MAGIC, *hash);
    let initial = samples.len();
    let mut skipped = 0_usize;
    let mut record = Vec::new();
    while !input.fill_buf()?.is_empty() {
        let mut header = [0_u8; 8];
        input.read_exact(&mut header)?;
        let Some((width, height, text_size)) = dimensions(&header) else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "malformed OCRL record header",
            ));
        };
        let pixels = usize::from(width).saturating_mul(usize::from(height));
        record.resize(pixels.saturating_add(text_size), 0);
        input.read_exact(&mut record)?;
        *hash = digest(&record, digest(&header, *hash));
        let (raster, label) = record
            .split_at_checked(pixels)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "malformed OCRL record"))?;
        let text = str::from_utf8(label)
            .ok()
            .filter(|value| !value.trim().is_empty() && !value.chars().any(char::is_control))
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid OCRL transcript"))?;
        let gray = Gray::new(u32::from(width), u32::from(height), raster.to_vec())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid OCRL raster"))?;
        let page = binarize(&gray).map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidData, "could not binarize OCRL raster")
        })?;
        let layout = segment(&page, 200.0);
        let [line] = layout.lines.as_slice() else {
            skipped = skipped.saturating_add(1);
            continue;
        };
        samples.push(Example {
            alignment: Vec::new(),
            geometry: sequence_geometry(line),
            page,
            text: text.chars().collect(),
        });
    }
    if samples.len() == initial {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "no single-line OCRL records",
        ));
    }
    writeln!(
        io::stdout().lock(),
        "lines={} skipped={skipped} archive={}",
        samples.len().saturating_sub(initial),
        archive.display()
    )
}

fn dimensions(header: &[u8; 8]) -> Option<(u16, u16, usize)> {
    let ([width, height, text_low, text_high], []) = header.as_chunks::<2>() else {
        return None;
    };
    let [b0, b1] = *text_low;
    let [b2, b3] = *text_high;
    let width_px = u16::from_le_bytes(*width);
    let height_px = u16::from_le_bytes(*height);
    let bytes = usize::try_from(u32::from_le_bytes([b0, b1, b2, b3])).ok()?;
    ((1..=4096).contains(&width_px)
        && (1..=512).contains(&height_px)
        && (1..=65_536).contains(&bytes))
    .then_some((width_px, height_px, bytes))
}
