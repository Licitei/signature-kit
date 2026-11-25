macro_rules! sha2 {
    ($name:ident, $word:ty, $length:ty, $block:literal, $size:literal, $rounds:literal,
     $constants:ident, [$s0a:expr, $s0b:expr, $s0c:expr], [$s1a:expr, $s1b:expr, $s1c:expr],
     [$s2a:expr, $s2b:expr, $s2c:expr], [$s3a:expr, $s3b:expr, $s3c:expr]) => {
        fn $name(parts: &[&[u8]], mut hash: [$word; 8]) -> [$word; 8] {
            let mut compress = |block: &[u8; $block]| {
                let mut words = [0; $rounds];
                for (word, chunk) in words.iter_mut().zip(block.as_chunks::<$size>().0) {
                    *word = <$word>::from_be_bytes(*chunk);
                }
                for index in 16_usize..$rounds {
                    let get = |back| words.get(index.saturating_sub(back)).copied().unwrap_or(0);
                    let x = get(15);
                    let y = get(2);
                    let first = x.rotate_right($s0a) ^ x.rotate_right($s0b) ^ (x >> $s0c);
                    let second = y.rotate_right($s1a) ^ y.rotate_right($s1b) ^ (y >> $s1c);
                    let word = get(16)
                        .wrapping_add(first)
                        .wrapping_add(get(7))
                        .wrapping_add(second);
                    if let Some(slot) = words.get_mut(index) {
                        *slot = word;
                    }
                }
                let [
                    mut a,
                    mut b,
                    mut c,
                    mut d,
                    mut e,
                    mut f,
                    mut word_g,
                    mut word_h,
                ] = hash;
                for (word, constant) in words.into_iter().zip($constants) {
                    let choice = (e & f) ^ (!e & word_g);
                    let majority = (a & b) ^ (a & c) ^ (b & c);
                    let first = a.rotate_right($s2a) ^ a.rotate_right($s2b) ^ a.rotate_right($s2c);
                    let second = e.rotate_right($s3a) ^ e.rotate_right($s3b) ^ e.rotate_right($s3c);
                    let temp = word_h
                        .wrapping_add(second)
                        .wrapping_add(choice)
                        .wrapping_add(constant)
                        .wrapping_add(word);
                    [a, b, c, d, e, f, word_g, word_h] = [
                        temp.wrapping_add(first).wrapping_add(majority),
                        a,
                        b,
                        c,
                        d.wrapping_add(temp),
                        e,
                        f,
                        word_g,
                    ];
                }
                for (slot, word) in hash.iter_mut().zip([a, b, c, d, e, f, word_g, word_h]) {
                    *slot = slot.wrapping_add(word);
                }
            };
            let size = parts
                .iter()
                .map(|part| part.len())
                .fold(0_usize, usize::saturating_add);
            let bits = <$length>::try_from(size).unwrap_or(0).wrapping_mul(8);
            let mut tail = [0_u8; $block];
            let mut used = 0_usize;
            for &part in parts {
                let mut next = part;
                if used != 0 {
                    let space = tail.len().saturating_sub(used).min(part.len());
                    if let Some((head, rest)) = part.split_at_checked(space) {
                        if let Some(slot) = tail.get_mut(used..used.saturating_add(space)) {
                            slot.copy_from_slice(head);
                        }
                        used = used.saturating_add(space);
                        if used < $block {
                            continue;
                        }
                        compress(&tail);
                        next = rest;
                    }
                }
                let (blocks, remaining) = next.as_chunks::<$block>();
                for block in blocks {
                    compress(block);
                }
                used = remaining.len();
                if let Some(slot) = tail.get_mut(..used) {
                    slot.copy_from_slice(remaining);
                }
            }
            let padding = padded(
                tail.get(..used).unwrap_or_default(),
                $block,
                &bits.to_be_bytes(),
            );
            for block in padding.as_chunks::<$block>().0 {
                compress(block);
            }
            hash
        }
    };
}

const MD5_CONSTANTS: [u32; 64] = [
    0xd76a_a478,
    0xe8c7_b756,
    0x2420_70db,
    0xc1bd_ceee,
    0xf57c_0faf,
    0x4787_c62a,
    0xa830_4613,
    0xfd46_9501,
    0x6980_98d8,
    0x8b44_f7af,
    0xffff_5bb1,
    0x895c_d7be,
    0x6b90_1122,
    0xfd98_7193,
    0xa679_438e,
    0x49b4_0821,
    0xf61e_2562,
    0xc040_b340,
    0x265e_5a51,
    0xe9b6_c7aa,
    0xd62f_105d,
    0x0244_1453,
    0xd8a1_e681,
    0xe7d3_fbc8,
    0x21e1_cde6,
    0xc337_07d6,
    0xf4d5_0d87,
    0x455a_14ed,
    0xa9e3_e905,
    0xfcef_a3f8,
    0x676f_02d9,
    0x8d2a_4c8a,
    0xfffa_3942,
    0x8771_f681,
    0x6d9d_6122,
    0xfde5_380c,
    0xa4be_ea44,
    0x4bde_cfa9,
    0xf6bb_4b60,
    0xbebf_bc70,
    0x289b_7ec6,
    0xeaa1_27fa,
    0xd4ef_3085,
    0x0488_1d05,
    0xd9d4_d039,
    0xe6db_99e5,
    0x1fa2_7cf8,
    0xc4ac_5665,
    0xf429_2244,
    0x432a_ff97,
    0xab94_23a7,
    0xfc93_a039,
    0x655b_59c3,
    0x8f0c_cc92,
    0xffef_f47d,
    0x8584_5dd1,
    0x6fa8_7e4f,
    0xfe2c_e6e0,
    0xa301_4314,
    0x4e08_11a1,
    0xf753_7e82,
    0xbd3a_f235,
    0x2ad7_d2bb,
    0xeb86_d391,
];

const MD5_SHIFTS: [u32; 64] = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
    14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15,
    21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const SHA256_CONSTANTS: [u32; 64] = [
    0x428a_2f98,
    0x7137_4491,
    0xb5c0_fbcf,
    0xe9b5_dba5,
    0x3956_c25b,
    0x59f1_11f1,
    0x923f_82a4,
    0xab1c_5ed5,
    0xd807_aa98,
    0x1283_5b01,
    0x2431_85be,
    0x550c_7dc3,
    0x72be_5d74,
    0x80de_b1fe,
    0x9bdc_06a7,
    0xc19b_f174,
    0xe49b_69c1,
    0xefbe_4786,
    0x0fc1_9dc6,
    0x240c_a1cc,
    0x2de9_2c6f,
    0x4a74_84aa,
    0x5cb0_a9dc,
    0x76f9_88da,
    0x983e_5152,
    0xa831_c66d,
    0xb003_27c8,
    0xbf59_7fc7,
    0xc6e0_0bf3,
    0xd5a7_9147,
    0x06ca_6351,
    0x1429_2967,
    0x27b7_0a85,
    0x2e1b_2138,
    0x4d2c_6dfc,
    0x5338_0d13,
    0x650a_7354,
    0x766a_0abb,
    0x81c2_c92e,
    0x9272_2c85,
    0xa2bf_e8a1,
    0xa81a_664b,
    0xc24b_8b70,
    0xc76c_51a3,
    0xd192_e819,
    0xd699_0624,
    0xf40e_3585,
    0x106a_a070,
    0x19a4_c116,
    0x1e37_6c08,
    0x2748_774c,
    0x34b0_bcb5,
    0x391c_0cb3,
    0x4ed8_aa4a,
    0x5b9c_ca4f,
    0x682e_6ff3,
    0x748f_82ee,
    0x78a5_636f,
    0x84c8_7814,
    0x8cc7_0208,
    0x90be_fffa,
    0xa450_6ceb,
    0xbef9_a3f7,
    0xc671_78f2,
];

const SHA512_CONSTANTS: [u64; 80] = [
    0x428a_2f98_d728_ae22,
    0x7137_4491_23ef_65cd,
    0xb5c0_fbcf_ec4d_3b2f,
    0xe9b5_dba5_8189_dbbc,
    0x3956_c25b_f348_b538,
    0x59f1_11f1_b605_d019,
    0x923f_82a4_af19_4f9b,
    0xab1c_5ed5_da6d_8118,
    0xd807_aa98_a303_0242,
    0x1283_5b01_4570_6fbe,
    0x2431_85be_4ee4_b28c,
    0x550c_7dc3_d5ff_b4e2,
    0x72be_5d74_f27b_896f,
    0x80de_b1fe_3b16_96b1,
    0x9bdc_06a7_25c7_1235,
    0xc19b_f174_cf69_2694,
    0xe49b_69c1_9ef1_4ad2,
    0xefbe_4786_384f_25e3,
    0x0fc1_9dc6_8b8c_d5b5,
    0x240c_a1cc_77ac_9c65,
    0x2de9_2c6f_592b_0275,
    0x4a74_84aa_6ea6_e483,
    0x5cb0_a9dc_bd41_fbd4,
    0x76f9_88da_8311_53b5,
    0x983e_5152_ee66_dfab,
    0xa831_c66d_2db4_3210,
    0xb003_27c8_98fb_213f,
    0xbf59_7fc7_beef_0ee4,
    0xc6e0_0bf3_3da8_8fc2,
    0xd5a7_9147_930a_a725,
    0x06ca_6351_e003_826f,
    0x1429_2967_0a0e_6e70,
    0x27b7_0a85_46d2_2ffc,
    0x2e1b_2138_5c26_c926,
    0x4d2c_6dfc_5ac4_2aed,
    0x5338_0d13_9d95_b3df,
    0x650a_7354_8baf_63de,
    0x766a_0abb_3c77_b2a8,
    0x81c2_c92e_47ed_aee6,
    0x9272_2c85_1482_353b,
    0xa2bf_e8a1_4cf1_0364,
    0xa81a_664b_bc42_3001,
    0xc24b_8b70_d0f8_9791,
    0xc76c_51a3_0654_be30,
    0xd192_e819_d6ef_5218,
    0xd699_0624_5565_a910,
    0xf40e_3585_5771_202a,
    0x106a_a070_32bb_d1b8,
    0x19a4_c116_b8d2_d0c8,
    0x1e37_6c08_5141_ab53,
    0x2748_774c_df8e_eb99,
    0x34b0_bcb5_e19b_48a8,
    0x391c_0cb3_c5c9_5a63,
    0x4ed8_aa4a_e341_8acb,
    0x5b9c_ca4f_7763_e373,
    0x682e_6ff3_d6b2_b8a3,
    0x748f_82ee_5def_b2fc,
    0x78a5_636f_4317_2f60,
    0x84c8_7814_a1f0_ab72,
    0x8cc7_0208_1a64_39ec,
    0x90be_fffa_2363_1e28,
    0xa450_6ceb_de82_bde9,
    0xbef9_a3f7_b2c6_7915,
    0xc671_78f2_e372_532b,
    0xca27_3ece_ea26_619c,
    0xd186_b8c7_21c0_c207,
    0xeada_7dd6_cde0_eb1e,
    0xf57d_4f7f_ee6e_d178,
    0x06f0_67aa_7217_6fba,
    0x0a63_7dc5_a2c8_98a6,
    0x113f_9804_bef9_0dae,
    0x1b71_0b35_131c_471b,
    0x28db_77f5_2304_7d84,
    0x32ca_ab7b_40c7_2493,
    0x3c9e_be0a_15c9_bebc,
    0x431d_67c4_9c10_0d4c,
    0x4cc5_d4be_cb3e_42b6,
    0x597f_299c_fc65_7e2a,
    0x5fcb_6fab_3ad6_faec,
    0x6c44_198c_4a47_5817,
];

fn padded(data: &[u8], block: usize, length: &[u8]) -> Vec<u8> {
    let end = data.len().saturating_add(1).saturating_add(length.len());
    let zeros = end.wrapping_neg() & block.saturating_sub(1);
    let mut input = Vec::with_capacity(end.saturating_add(zeros));
    input.extend_from_slice(data);
    input.push(0x80);
    input.resize(input.len().saturating_add(zeros), 0);
    input.extend_from_slice(length);
    input
}

pub(crate) fn md5(data: &[u8]) -> [u8; 16] {
    let bits = u64::try_from(data.len()).unwrap_or(0).wrapping_mul(8);
    let mut hash = [0x6745_2301_u32, 0xefcd_ab89, 0x98ba_dcfe, 0x1032_5476];
    for block in padded(data, 64, &bits.to_le_bytes()).as_chunks::<64>().0 {
        let mut words = [0_u32; 16];
        for (word, chunk) in words.iter_mut().zip(block.as_chunks::<4>().0) {
            *word = u32::from_le_bytes(*chunk);
        }
        let [mut a, mut b, mut c, mut d] = hash;
        for (index, (&constant, &shift)) in MD5_CONSTANTS.iter().zip(&MD5_SHIFTS).enumerate() {
            let (value, position) = match index {
                0..=15 => ((b & c) | (!b & d), index),
                16..=31 => ((d & b) | (!d & c), index.wrapping_mul(5).wrapping_add(1)),
                32..=47 => (b ^ c ^ d, index.wrapping_mul(3).wrapping_add(5)),
                _ => (c ^ (b | !d), index.wrapping_mul(7)),
            };
            let next = a
                .wrapping_add(value)
                .wrapping_add(constant)
                .wrapping_add(words.get(position & 15).copied().unwrap_or_default())
                .rotate_left(shift)
                .wrapping_add(b);
            [a, b, c, d] = [d, next, b, c];
        }
        for (slot, word) in hash.iter_mut().zip([a, b, c, d]) {
            *slot = slot.wrapping_add(word);
        }
    }
    let mut out = [0_u8; 16];
    for (bytes, word) in out.as_chunks_mut::<4>().0.iter_mut().zip(hash) {
        bytes.copy_from_slice(&word.to_le_bytes());
    }
    out
}

sha2!(
    sha256_words,
    u32,
    u64,
    64,
    4,
    64,
    SHA256_CONSTANTS,
    [7, 18, 3_u32],
    [17, 19, 10_u32],
    [2, 13, 22_u32],
    [6, 11, 25_u32]
);
sha2!(
    sha512_words,
    u64,
    u128,
    128,
    8,
    80,
    SHA512_CONSTANTS,
    [1, 8, 7_u32],
    [19, 61, 6_u32],
    [28, 34, 39_u32],
    [14, 18, 41_u32]
);

pub(crate) fn sha256(data: &[u8]) -> [u8; 32] {
    sha256_parts(&[data])
}

pub(crate) fn sha256_parts(parts: &[&[u8]]) -> [u8; 32] {
    let words = sha256_words(
        parts,
        [
            0x6a09_e667,
            0xbb67_ae85,
            0x3c6e_f372,
            0xa54f_f53a,
            0x510e_527f,
            0x9b05_688c,
            0x1f83_d9ab,
            0x5be0_cd19,
        ],
    );
    let mut digest = [0_u8; 32];
    for (slot, word) in digest.as_chunks_mut::<4>().0.iter_mut().zip(words) {
        slot.copy_from_slice(&word.to_be_bytes());
    }
    digest
}

pub(crate) fn sha512(data: &[u8], truncated: bool) -> Vec<u8> {
    sha512_parts(&[data], truncated)
}

pub(crate) fn sha512_parts(parts: &[&[u8]], truncated: bool) -> Vec<u8> {
    let initial = if truncated {
        [
            0xcbbb_9d5d_c105_9ed8,
            0x629a_292a_367c_d507,
            0x9159_015a_3070_dd17,
            0x152f_ecd8_f70e_5939,
            0x6733_2667_ffc0_0b31,
            0x8eb4_4a87_6858_1511,
            0xdb0c_2e0d_64f9_8fa7,
            0x47b5_481d_befa_4fa4,
        ]
    } else {
        [
            0x6a09_e667_f3bc_c908,
            0xbb67_ae85_84ca_a73b,
            0x3c6e_f372_fe94_f82b,
            0xa54f_f53a_5f1d_36f1,
            0x510e_527f_ade6_82d1,
            0x9b05_688c_2b3e_6c1f,
            0x1f83_d9ab_fb41_bd6b,
            0x5be0_cd19_137e_2179,
        ]
    };
    sha512_words(parts, initial)
        .into_iter()
        .take(if truncated { 6 } else { 8 })
        .flat_map(u64::to_be_bytes)
        .collect()
}
