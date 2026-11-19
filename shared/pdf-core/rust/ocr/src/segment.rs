#[derive(Debug)]
#[non_exhaustive]
pub struct Line {
    pub baseline: f32,
    pub bbox: [u32; 4],
    pub block: u32,
    pub words: Vec<WordBox>,
    pub x_height: f32,
}

#[derive(Debug)]
#[non_exhaustive]
pub struct WordBox {
    pub bbox: [u32; 4],
}
