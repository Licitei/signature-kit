use crate::raster::Bits;
use crate::segment::Line;

#[derive(Debug)]
pub(crate) struct Word {
    pub(crate) alternatives: Vec<(String, f32)>,
    pub(crate) bbox: [u32; 4],
    pub(crate) confidence: f32,
    pub(crate) text: String,
}

pub(crate) fn recognize_line(_page: &Bits, line: &Line) -> Vec<Word> {
    line.words
        .iter()
        .map(|word| Word {
            alternatives: Vec::new(),
            bbox: word.bbox,
            confidence: 0.0,
            text: String::from("?"),
        })
        .collect()
}
