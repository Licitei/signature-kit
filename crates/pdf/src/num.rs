use core::cmp::Ordering;

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
pub(crate) fn fold_char(ch: char) -> char {
    if ch.is_ascii() {
        return ch.to_ascii_lowercase();
    }
    let code = u32::from(ch);
    match code {
        0x00C0..=0x00D6 | 0x00D8..=0x00DE => {
            char::from_u32(code.saturating_add(0x20)).unwrap_or(ch)
        }
        _ => ch,
    }
}

pub(crate) fn fold_string(text: &str) -> String {
    text.chars().map(fold_char).collect()
}

pub(crate) fn unsigned_decimal(value: u64) -> String {
    use core::str;
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
    str::from_utf8(digits.get(cursor..).unwrap_or_default())
        .map_or_else(|_| String::from("0"), String::from)
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

pub(crate) fn read_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    let high = u16::from(*bytes.get(offset)?);
    let low = u16::from(*bytes.get(offset.checked_add(1)?)?);
    Some((high << 8) | low)
}

pub(crate) fn read_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    let high = u32::from(read_u16(bytes, offset)?);
    let low = u32::from(read_u16(bytes, offset.checked_add(2)?)?);
    Some((high << 16) | low)
}

#[inline(never)]
pub(crate) fn sort_total<T>(items: &mut [T], compare: &dyn Fn(&T, &T) -> Ordering) {
    let len = items.len();
    for root in (0..len >> 1_u32).rev() {
        sift_down(items, root, len, compare);
    }
    for end in (1..len).rev() {
        items.swap(0, end);
        sift_down(items, 0, end, compare);
    }
}

fn sift_down<T>(
    items: &mut [T],
    mut root: usize,
    end: usize,
    compare: &dyn Fn(&T, &T) -> Ordering,
) {
    loop {
        let left = root.saturating_mul(2).saturating_add(1);
        if left >= end {
            return;
        }
        let right = left.saturating_add(1);
        let child = match (items.get(left), items.get(right)) {
            (Some(low), Some(high)) if right < end && compare(high, low).is_gt() => right,
            _ => left,
        };
        let Some((parent, larger)) = items.get(root).zip(items.get(child)) else {
            return;
        };
        if !compare(larger, parent).is_gt() {
            return;
        }
        items.swap(root, child);
        root = child;
    }
}

#[inline(never)]
pub(crate) fn sort_unstable_with<T>(items: &mut [T], compare: &dyn Fn(&T, &T) -> Ordering) {
    items.sort_unstable_by(|left, right| compare(left, right));
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

#[cfg(test)]
mod tests {
    use super::*;
    use core::iter;

    #[test]
    fn sort_total_matches_the_standard_sort() {
        let mut state = 0x9e37_79b9_u32;
        for len in 0..200_usize {
            let mut values: Vec<u32> = iter::repeat_with(|| {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                state >> 24_u32
            })
            .take(len)
            .collect();
            let mut expected = values.clone();
            expected.sort_unstable();
            sort_total(&mut values, &Ord::cmp);
            assert_eq!(values, expected);
        }
    }
}
