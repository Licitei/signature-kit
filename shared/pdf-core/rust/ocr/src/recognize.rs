#[derive(Clone, Debug, PartialEq)]
#[non_exhaustive]
#[expect(
    clippy::arbitrary_source_item_ordering,
    reason = "field order is the recognizer contract shared with the other engine crates"
)]
#[expect(
    unreachable_pub,
    reason = "recognizer contract consumed by the engine CLI once that crate lands"
)]
pub struct Word {
    pub text: String,
    pub bbox: [u32; 4],
    pub confidence: f32,
    pub alternatives: Vec<(String, f32)>,
}
