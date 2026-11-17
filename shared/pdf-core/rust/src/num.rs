const _: () = assert!(usize::BITS >= u32::BITS);

#[expect(
    clippy::as_conversions,
    reason = "usize is at least 32 bits wide, asserted at compile time above"
)]
pub(crate) fn widen<T: Into<u32>>(value: T) -> usize {
    value.into() as usize
}

#[expect(
    clippy::as_conversions,
    clippy::cast_precision_loss,
    reason = "counts and offsets stay far below 2^52, where f64 is exact"
)]
pub(crate) const fn usize_to_f64(value: usize) -> f64 {
    value as f64
}

#[expect(
    clippy::as_conversions,
    clippy::cast_precision_loss,
    reason = "PDF numbers beyond 2^53 are approximations by definition"
)]
pub(crate) const fn u64_to_f64(value: u64) -> f64 {
    value as f64
}

#[expect(
    clippy::as_conversions,
    clippy::cast_precision_loss,
    reason = "PDF numbers beyond 2^53 are approximations by definition"
)]
pub(crate) const fn i64_to_f64(value: i64) -> f64 {
    value as f64
}

#[expect(
    clippy::as_conversions,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "float to integer casts saturate and map NaN to zero, which is the wanted behaviour for untrusted numbers"
)]
pub(crate) const fn f64_to_usize(value: f64) -> usize {
    value as usize
}

#[expect(
    clippy::as_conversions,
    clippy::cast_possible_truncation,
    reason = "float to integer casts saturate and map NaN to zero, which is the wanted behaviour for untrusted numbers"
)]
pub(crate) const fn f64_to_i64(value: f64) -> i64 {
    value as i64
}
