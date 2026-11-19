#![expect(
    unsafe_code,
    reason = "runtime-detected AVX2 processes unaligned sixteen-byte blocks"
)]

use core::arch::x86_64::{
    _mm_loadu_si128, _mm256_add_epi32, _mm256_cvtepi8_epi16, _mm256_madd_epi16,
    _mm256_setzero_si256, _mm256_storeu_si256,
};

use super::scalar_dot;

pub(super) fn dot(input: &[i8], weights: &[u8]) -> i32 {
    // SAFETY: The model selects this function only after an AVX2 feature check.
    unsafe { dot_avx2(input, weights) }
}

#[target_feature(enable = "avx2")]
fn dot_avx2(input: &[i8], weights: &[u8]) -> i32 {
    let (features, feature_tail) = input.as_chunks::<16>();
    let (matrix, weight_tail) = weights.as_chunks::<16>();
    let mut sums = _mm256_setzero_si256();
    for (window, row) in features.iter().zip(matrix) {
        // SAFETY: Each argument points to an initialized array of sixteen bytes.
        let left = unsafe { _mm_loadu_si128(window.as_ptr().cast()) };
        // SAFETY: Each argument points to an initialized array of sixteen bytes.
        let right = unsafe { _mm_loadu_si128(row.as_ptr().cast()) };
        let product = _mm256_madd_epi16(_mm256_cvtepi8_epi16(left), _mm256_cvtepi8_epi16(right));
        sums = _mm256_add_epi32(sums, product);
    }
    let mut lanes = [0_i32; 8];
    // SAFETY: The destination has room for eight i32 results.
    unsafe { _mm256_storeu_si256(lanes.as_mut_ptr().cast(), sums) };
    lanes
        .into_iter()
        .fold(scalar_dot(feature_tail, weight_tail), i32::wrapping_add)
}

#[cfg(test)]
mod tests {
    use core::array;

    use super::{dot, scalar_dot};

    #[test]
    fn vector_kernel_matches_scalar_for_signed_bytes_and_a_tail() {
        if !std::is_x86_feature_detected!("avx2") {
            return;
        }
        let input: [i8; 289] = array::from_fn(|index| {
            let [low, ..] = index.wrapping_mul(137).to_le_bytes();
            i8::from_le_bytes([low])
        });
        let weights: [u8; 289] = array::from_fn(|index| {
            let [low, ..] = index.wrapping_mul(87).to_le_bytes();
            low
        });
        assert_eq!(dot(&input, &weights), scalar_dot(&input, &weights));
    }
}
