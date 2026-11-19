#![expect(
    unsafe_code,
    reason = "runtime-detected AVX2 processes full eight-float chunks"
)]

use super::Kernels;
use core::arch::x86_64::{
    __m256, _mm256_fmadd_ps, _mm256_loadu_ps, _mm256_set1_ps, _mm256_setzero_ps, _mm256_storeu_ps,
};

pub(super) fn kernels() -> Kernels {
    Kernels {
        // SAFETY: The dispatcher checked AVX2 and FMA on this host.
        accumulate: |deltas, updates, window, kernel, signal| unsafe {
            accumulate(deltas, updates, window, kernel, signal);
        },
        // SAFETY: The dispatcher checked AVX2 and FMA on this host.
        dot: |left, right| unsafe { dot(left, right) },
    }
}

#[target_feature(enable = "avx2,fma")]
fn dot(left: &[f32], right: &[f32]) -> f32 {
    let (lhs, left_tail) = left.as_chunks::<8>();
    let (rhs, right_tail) = right.as_chunks::<8>();
    let mut sums = _mm256_setzero_ps();
    for (features, weights) in lhs.iter().zip(rhs) {
        // SAFETY: The arrays each contain eight initialized floats.
        let feature_vector = unsafe { _mm256_loadu_ps(features.as_ptr()) };
        // SAFETY: The arrays each contain eight initialized floats.
        let weight_vector = unsafe { _mm256_loadu_ps(weights.as_ptr()) };
        sums = _mm256_fmadd_ps(feature_vector, weight_vector, sums);
    }
    let mut lanes = [0.0_f32; 8];
    // SAFETY: The result array has room for eight floats.
    unsafe { _mm256_storeu_ps(lanes.as_mut_ptr(), sums) };
    lanes.into_iter().sum::<f32>() + super::dot(left_tail, right_tail)
}

#[target_feature(enable = "avx2,fma")]
fn accumulate(
    deltas: &mut [f32],
    updates: &mut [f32],
    window: &[f32],
    kernel: &[f32],
    signal: f32,
) {
    let (delta_chunks, delta_tail) = deltas.as_chunks_mut::<8>();
    let (update_chunks, update_tail) = updates.as_chunks_mut::<8>();
    let (windows, window_tail) = window.as_chunks::<8>();
    let (weights, weight_tail) = kernel.as_chunks::<8>();
    let values = _mm256_set1_ps(signal);
    for (((delta, update), feature), weight) in delta_chunks
        .iter_mut()
        .zip(update_chunks)
        .zip(windows)
        .zip(weights)
    {
        add_scaled(delta, weight, values);
        add_scaled(update, feature, values);
    }
    super::accumulate(delta_tail, update_tail, window_tail, weight_tail, signal);
}

#[target_feature(enable = "avx2,fma")]
fn add_scaled(target: &mut [f32; 8], source: &[f32; 8], scale: __m256) {
    // SAFETY: Each array contains eight initialized floats.
    let total = unsafe { _mm256_loadu_ps(target.as_ptr()) };
    // SAFETY: Each array contains eight initialized floats.
    let input = unsafe { _mm256_loadu_ps(source.as_ptr()) };
    let value = _mm256_fmadd_ps(input, scale, total);
    // SAFETY: The target array has room for eight floats.
    unsafe { _mm256_storeu_ps(target.as_mut_ptr(), value) };
}
