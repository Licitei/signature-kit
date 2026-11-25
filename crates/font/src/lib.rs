#![cfg_attr(
    test,
    expect(
        dead_code_pub_in_binary,
        reason = "the font crate is shared with the PDF and composition libraries"
    )
)]

extern crate alloc;

pub mod cff;
mod cff_subset;
pub mod cmap;
mod gpos;
pub mod sfnt;
pub mod subset;

#[inline]
#[must_use]
pub fn parse_decimal(text: &[u8]) -> Option<f64> {
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

#[inline]
#[must_use]
pub fn read_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_be_bytes(
        bytes.get(offset..offset.checked_add(2)?)?.try_into().ok()?,
    ))
}

#[inline]
#[must_use]
pub fn read_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_be_bytes(
        bytes.get(offset..offset.checked_add(4)?)?.try_into().ok()?,
    ))
}
