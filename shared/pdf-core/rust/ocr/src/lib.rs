extern crate alloc;

mod abi;
mod binarize;
pub mod clean;
mod deskew;
pub mod engine;
pub mod jpeg;
mod model;
mod network;
#[cfg(not(target_arch = "wasm32"))]
mod neural_training;
mod postprocess;
pub mod raster;
mod raster_display;
pub mod recognize;
pub mod segment;
#[cfg(not(target_arch = "wasm32"))]
pub mod training;
