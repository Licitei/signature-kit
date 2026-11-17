const _: () = assert!(
    usize::BITS >= u32::BITS,
    "usize must be at least 32 bits wide"
);

#[expect(
    clippy::as_conversions,
    reason = "usize is at least 32 bits wide, asserted at compile time above"
)]
pub(crate) fn widen<T>(value: T) -> usize
where
    T: Into<u32>,
{
    value.into() as usize
}

/// Decimal digits for `value` without pulling in `core::fmt`.
pub(crate) fn unsigned_decimal(value: u64) -> String {
    let mut digits = [b'0'; 20];
    let mut cursor = digits.len();
    let mut remaining = value;
    loop {
        cursor = cursor.saturating_sub(1);
        if let Some(slot) = digits.get_mut(cursor) {
            *slot = b'0'.saturating_add(u8::try_from(remaining.rem_euclid(10)).unwrap_or(0));
        }
        remaining = remaining.checked_div(10).unwrap_or(0);
        if remaining == 0 {
            break;
        }
    }
    match core::str::from_utf8(digits.get(cursor..).unwrap_or_default()) {
        Ok(text) => String::from(text),
        Err(_) => String::from("0"),
    }
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

#[expect(
    clippy::as_conversions,
    clippy::cast_possible_truncation,
    reason = "display lists store coordinates in single precision on purpose; out-of-range values saturate to infinity"
)]
pub(crate) const fn f64_to_f32(value: f64) -> f32 {
    value as f32
}

#[expect(
    clippy::as_conversions,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "float to integer casts saturate and map NaN to zero, which is the wanted behaviour for colour channels"
)]
pub(crate) const fn unit_to_u8(value: f64) -> u8 {
    (value * 255.0 + 0.5) as u8
}

pub(crate) const fn bounded(value: f64, low: f64, high: f64) -> f64 {
    value.max(low).min(high)
}

pub(crate) fn parse_decimal(text: &[u8]) -> Option<f64> {
    let (negative, body) = match text.split_first() {
        Some((b'-', rest)) => (true, rest),
        Some((b'+', rest)) => (false, rest),
        _ => (false, text),
    };
    let mut value = 0.0_f64;
    let mut scale = 0_i32;
    let mut digits = 0_usize;
    let mut fraction = false;
    let mut position = 0_usize;
    while let Some(&byte) = body.get(position) {
        match byte {
            b'0'..=b'9' => {
                value = value * 10.0_f64 + f64::from(byte.wrapping_sub(b'0'));
                digits = digits.saturating_add(1);
                if fraction {
                    scale = scale.saturating_sub(1);
                }
            }
            b'.' if !fraction => fraction = true,
            b'e' | b'E' => break,
            _ => return None,
        }
        position = position.saturating_add(1);
    }
    if digits == 0 {
        return None;
    }
    if let Some(exponent_text) = body.get(position.saturating_add(1)..)
        && position < body.len()
    {
        let (exponent_negative, exponent_digits) = match exponent_text.split_first() {
            Some((b'-', rest)) => (true, rest),
            Some((b'+', rest)) => (false, rest),
            _ => (false, exponent_text),
        };
        if exponent_digits.is_empty() {
            return None;
        }
        let mut exponent = 0_i32;
        for byte in exponent_digits {
            if !byte.is_ascii_digit() {
                return None;
            }
            exponent = exponent
                .saturating_mul(10)
                .saturating_add(i32::from(byte.wrapping_sub(b'0')));
        }
        scale = if exponent_negative {
            scale.saturating_sub(exponent)
        } else {
            scale.saturating_add(exponent)
        };
    }
    let mut steps = scale.clamp(-400_i32, 400_i32);
    while steps > 0_i32 {
        value *= 10.0_f64;
        steps = steps.saturating_sub(1);
    }
    while steps < 0_i32 {
        value /= 10.0_f64;
        steps = steps.saturating_add(1);
    }
    Some(if negative { -value } else { value })
}
