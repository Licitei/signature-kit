use crate::failure::{Failure, FailureCode, Outcome};
use crate::object::Dict;

pub fn decode_stream(dict: &Dict, raw: &[u8], max_output: usize) -> Outcome<Vec<u8>> {
    match dict.get(b"Filter") {
        None if raw.len() <= max_output => Ok(raw.to_vec()),
        None => Err(Failure::limit("decoded stream exceeds limit")),
        Some(_) => Err(Failure::new(FailureCode::UnsupportedFeature, "filters pending")),
    }
}
