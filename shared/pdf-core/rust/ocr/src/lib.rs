extern crate alloc;

mod abi;
mod binarize;
pub mod clean;
#[cfg(not(target_arch = "wasm32"))]
mod ctc;
mod deskew;
pub mod engine;
pub mod jpeg;
mod lexicon;
mod model;
mod network;
#[cfg(not(target_arch = "wasm32"))]
mod neural_training;
mod postprocess;
pub mod raster;
mod raster_display;
pub mod recognize;
pub mod segment;
#[cfg(any(not(target_arch = "wasm32"), feature = "ctc-probe"))]
mod sequence;
#[cfg(all(target_arch = "wasm32", feature = "ctc-probe"))]
mod sequence_probe;
#[cfg(not(target_arch = "wasm32"))]
mod sequence_training;
#[cfg(not(target_arch = "wasm32"))]
pub mod training;
