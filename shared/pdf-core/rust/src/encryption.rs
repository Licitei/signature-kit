use alloc::rc::Rc;

use crate::failure::{Failure, FailureCode, Outcome};
use crate::object::{Dict, ObjRef, Object, Stream};
use crate::pdf_cipher::{aes_cbc, rc4};
use crate::pdf_hash::{md5, sha256, sha512};

const PASSWORD_PADDING: [u8; 32] = [
    0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
    0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
];

#[derive(Clone, Copy)]
enum Cipher {
    Aes128,
    Aes256,
    Identity,
    Rc4,
}

pub(crate) struct Encryption {
    dictionary: Option<Dict>,
    embedded_file: Cipher,
    encrypt_metadata: bool,
    key: Vec<u8>,
    reference: Option<ObjRef>,
    stream: Cipher,
    string: Cipher,
    version: i64,
}

impl Encryption {
    pub(crate) fn authenticate(
        dict: &Dict,
        trailer: &Dict,
        reference: Option<ObjRef>,
    ) -> Option<Self> {
        if dict.get(b"Filter")?.as_name()? != b"Standard" {
            return None;
        }
        let version = dict.get(b"V")?.as_integer()?;
        let revision = dict.get(b"R")?.as_integer()?;
        let flags = dict.get(b"P")?.as_integer()?;
        let permissions = i32::try_from(flags)
            .or_else(|_| u32::try_from(flags).map(u32::cast_signed))
            .ok()?;
        let encrypt_metadata = !matches!(dict.get(b"EncryptMetadata"), Some(Object::Bool(false)));
        let key = match (version, revision) {
            (1 | 2, 2 | 3) | (4, 4) => {
                let id = trailer.get(b"ID")?.as_array()?.first()?.as_string()?;
                let len = if version == 1 || revision == 2 {
                    5
                } else {
                    legacy_key_length(dict, version)?
                };
                legacy_key(dict, id, revision, len, permissions, encrypt_metadata)?
            }
            (5, 5 | 6) => aes256_key(dict, revision, permissions, encrypt_metadata)?.to_vec(),
            _ => return None,
        };
        let stream = default_cipher(dict, b"StmF", version)?;
        let embedded_file = if version >= 4 && dict.get(b"EFF").is_some() {
            default_cipher(dict, b"EFF", version)?
        } else {
            stream
        };
        Some(Self {
            dictionary: dict.get(b"CF").and_then(Object::as_dict).cloned(),
            embedded_file,
            encrypt_metadata,
            key,
            reference,
            stream,
            string: default_cipher(dict, b"StrF", version)?,
            version,
        })
    }

    fn decrypt_bytes(&self, data: &mut Vec<u8>, cipher: Cipher, reference: ObjRef) {
        match cipher {
            Cipher::Identity => (),
            Cipher::Rc4 => rc4(data, &self.object_key(reference, false)),
            Cipher::Aes128 => decrypt_aes(data, &self.object_key(reference, true)),
            Cipher::Aes256 => decrypt_aes(data, &self.key),
        }
    }

    pub(crate) fn decrypt_object(
        &self,
        object: &mut Object,
        reference: ObjRef,
        bytes: &[u8],
    ) -> Outcome<()> {
        if Some(reference) == self.reference {
            return Ok(());
        }
        if let Object::Stream(stream) = object {
            if name_is(&stream.dict, b"Type", b"XRef") {
                return Ok(());
            }
            self.decrypt_stream(stream, reference, bytes)?;
            self.decrypt_strings(&mut stream.dict, reference);
        } else {
            self.decrypt_value(object, reference);
        }
        Ok(())
    }

    fn decrypt_stream(&self, stream: &mut Stream, reference: ObjRef, bytes: &[u8]) -> Outcome<()> {
        let cipher = if let Some(name) = remove_crypt_filter(&mut stream.dict) {
            crypt_filter(self.dictionary.as_ref(), &name, self.version).ok_or_else(|| {
                Failure::new(FailureCode::EncryptedPdf, "unsupported PDF crypt filter")
            })?
        } else if name_is(&stream.dict, b"Type", b"Metadata") && !self.encrypt_metadata {
            Cipher::Identity
        } else if name_is(&stream.dict, b"Type", b"EmbeddedFile") {
            self.embedded_file
        } else {
            self.stream
        };
        if matches!(cipher, Cipher::Identity) {
            return Ok(());
        }
        let mut data = bytes
            .get(stream.data.clone())
            .ok_or_else(|| Failure::invalid("stream data out of range"))?
            .to_vec();
        self.decrypt_bytes(&mut data, cipher, reference);
        stream.decrypted = Some(Rc::from(data));
        Ok(())
    }

    fn decrypt_strings(&self, dict: &mut Dict, reference: ObjRef) {
        let signature = name_is(dict, b"Type", b"Sig")
            || name_is(dict, b"Type", b"DocTimeStamp")
            || dict.get(b"ByteRange").is_some();
        for (key, value) in &mut dict.entries {
            if !signature || key != b"Contents" {
                self.decrypt_value(value, reference);
            }
        }
    }

    fn decrypt_value(&self, object: &mut Object, reference: ObjRef) {
        match object {
            Object::Array(items) => {
                for item in items {
                    self.decrypt_value(item, reference);
                }
            }
            Object::Dict(dict) => self.decrypt_strings(dict, reference),
            Object::String(data) => self.decrypt_bytes(data, self.string, reference),
            Object::Bool(_)
            | Object::Integer(_)
            | Object::Name(_)
            | Object::Null
            | Object::Real(_)
            | Object::Ref(_)
            | Object::Stream(_) => (),
        }
    }

    fn object_key(&self, reference: ObjRef, aes: bool) -> Vec<u8> {
        let [low, middle, high, _] = reference.number.to_le_bytes();
        let mut input = self.key.clone();
        input.extend([low, middle, high]);
        input.extend(reference.generation.to_le_bytes());
        if aes {
            input.extend(b"sAlT");
        }
        md5(&input)
            .into_iter()
            .take(self.key.len().saturating_add(5))
            .collect()
    }
}

fn crypt_filter(filters: Option<&Dict>, name: &[u8], version: i64) -> Option<Cipher> {
    if name == b"Identity" {
        return Some(Cipher::Identity);
    }
    let filter = filters?.get(name)?.as_dict()?;
    let method = filter
        .get(b"CFM")
        .and_then(Object::as_name)
        .unwrap_or(b"None");
    match (method, version) {
        (b"None", _) => Some(Cipher::Identity),
        (b"V2", 4) => Some(Cipher::Rc4),
        (b"AESV2", 4) => Some(Cipher::Aes128),
        (b"AESV3", 5) => Some(Cipher::Aes256),
        _ => None,
    }
}

fn decrypt_aes(data: &mut Vec<u8>, key: &[u8]) {
    let Some((iv, ciphertext)) = data.split_first_chunk_mut::<16>() else {
        return;
    };
    if aes_cbc(ciphertext, key, *iv, true).is_none() {
        return;
    }
    let len = ciphertext.len();
    let pad = usize::from(ciphertext.last().copied().unwrap_or_default());
    let end = len.saturating_sub(pad);
    let valid_pad = (1..=16).contains(&pad)
        && ciphertext.get(end..).is_some_and(|tail| {
            tail.len() == pad && tail.iter().all(|&byte| usize::from(byte) == pad)
        });
    let decrypted_len = if valid_pad { end } else { len };
    data.copy_within(16..decrypted_len.saturating_add(16), 0);
    data.truncate(decrypted_len);
}

fn default_cipher(dict: &Dict, key: &[u8], version: i64) -> Option<Cipher> {
    if version < 4 {
        return Some(Cipher::Rc4);
    }
    let name = match dict.get(key) {
        Some(object) => object.as_name()?,
        None => b"Identity",
    };
    crypt_filter(dict.get(b"CF").and_then(Object::as_dict), name, version)
}

fn legacy_key_length(dict: &Dict, version: i64) -> Option<usize> {
    let bits = match dict.get(b"Length") {
        Some(length) => length.as_integer()?,
        None if version == 4 => {
            let length = dict
                .get(b"StmF")
                .and_then(Object::as_name)
                .and_then(|name| {
                    dict.get(b"CF")?
                        .as_dict()?
                        .get(name)?
                        .as_dict()?
                        .get(b"Length")
                });
            match length {
                Some(value) => {
                    let length_value = value.as_integer()?;
                    if length_value <= 16 {
                        length_value.checked_mul(8)?
                    } else {
                        length_value
                    }
                }
                None => 128,
            }
        }
        None => 40,
    };
    if !(40..=128).contains(&bits) || bits & 7 != 0 {
        return None;
    }
    usize::try_from(bits >> 3_i32).ok()
}

fn legacy_key(
    dict: &Dict,
    id: &[u8],
    revision: i64,
    len: usize,
    permissions: i32,
    encrypt_metadata: bool,
) -> Option<Vec<u8>> {
    let owner: &[u8; 32] = dict.get(b"O")?.as_string()?.try_into().ok()?;
    let user: &[u8; 32] = dict.get(b"U")?.as_string()?.try_into().ok()?;
    let mut input = PASSWORD_PADDING.to_vec();
    input.extend(owner);
    input.extend(permissions.to_le_bytes());
    input.extend(id);
    if revision >= 4 && !encrypt_metadata {
        input.extend([0xff; 4]);
    }
    let mut digest = md5(&input);
    if revision >= 3 {
        for _ in 0_u8..50 {
            digest = md5(digest.get(..len)?);
        }
    }
    let key = digest.get(..len)?;
    if revision == 2 {
        let mut expected = PASSWORD_PADDING;
        rc4(&mut expected, key);
        return (&expected == user).then(|| key.to_vec());
    }
    input.clear();
    input.extend(PASSWORD_PADDING);
    input.extend(id);
    let mut expected = md5(&input);
    for round in 0_u8..20 {
        let iteration_key: Vec<_> = key.iter().map(|byte| byte ^ round).collect();
        rc4(&mut expected, &iteration_key);
    }
    user.starts_with(&expected).then(|| key.to_vec())
}

fn name_is(dict: &Dict, key: &[u8], expected: &[u8]) -> bool {
    dict.get(key).and_then(Object::as_name) == Some(expected)
}

fn remove_crypt_filter(dict: &mut Dict) -> Option<Vec<u8>> {
    let filter = dict.get(b"Filter")?;
    let array = filter.as_array();
    let first = array.and_then(<[Object]>::first).unwrap_or(filter);
    if first.as_name()? != b"Crypt" {
        return None;
    }
    let parms = dict.get(b"DecodeParms").or_else(|| dict.get(b"DP"));
    let first_parms = if array.is_some() {
        parms.and_then(Object::as_array).and_then(<[Object]>::first)
    } else {
        parms
    };
    let name = first_parms
        .and_then(Object::as_dict)
        .and_then(|parameters| parameters.get(b"Name"))
        .and_then(Object::as_name)
        .unwrap_or(b"Identity")
        .to_vec();
    let remaining_filters = array
        .and_then(|items| items.get(1..))
        .unwrap_or_default()
        .to_vec();
    let remaining_parms = parms
        .and_then(Object::as_array)
        .and_then(|items| items.get(1..))
        .unwrap_or_default()
        .to_vec();
    dict.entries
        .retain(|(key, _)| !matches!(key.as_slice(), b"Filter" | b"DecodeParms" | b"DP"));
    if !remaining_filters.is_empty() {
        dict.insert(b"Filter", Object::Array(remaining_filters));
        if !remaining_parms.is_empty() {
            dict.insert(b"DecodeParms", Object::Array(remaining_parms));
        }
    }
    Some(name)
}

fn revision_six_hash(salt: [u8; 8]) -> Option<[u8; 32]> {
    let mut hash = sha256(&salt).to_vec();
    let mut cipher = Vec::with_capacity(64 * 64);
    for round in 1_u16..=287 {
        let (key, rest) = hash.split_first_chunk::<16>()?;
        let (iv, _) = rest.split_first_chunk::<16>()?;
        cipher.clear();
        for _ in 0_u8..64 {
            cipher.extend(&hash);
        }
        aes_cbc(&mut cipher, key, *iv, false)?;
        let head = cipher.first_chunk::<16>()?;
        let sum: u16 = head.iter().map(|&byte| u16::from(byte)).sum();
        hash = match sum.checked_rem(3)? {
            0 => sha256(&cipher).to_vec(),
            1 => sha512(&cipher, true),
            _ => sha512(&cipher, false),
        };
        if round >= 64 && u16::from(*cipher.last()?) <= round.saturating_sub(32) {
            return hash.first_chunk().copied();
        }
    }
    None
}

fn aes256_key(
    dict: &Dict,
    revision: i64,
    permissions: i32,
    encrypt_metadata: bool,
) -> Option<[u8; 32]> {
    let user = dict.get(b"U")?.as_string()?;
    let (expected, salts) = user.split_first_chunk::<32>()?;
    let (validation_salt, rest) = salts.split_first_chunk::<8>()?;
    let key_salt = rest.first_chunk::<8>()?;
    let hash = |salt: [u8; 8]| {
        if revision == 5 {
            Some(sha256(&salt))
        } else {
            revision_six_hash(salt)
        }
    };
    if &hash(*validation_salt)? != expected {
        return None;
    }
    let mut key: [u8; 32] = dict.get(b"UE")?.as_string()?.try_into().ok()?;
    aes_cbc(&mut key, &hash(*key_salt)?, [0; 16], true)?;
    let mut perms: [u8; 16] = dict.get(b"Perms")?.as_string()?.try_into().ok()?;
    aes_cbc(&mut perms, &key, [0; 16], true)?;
    let metadata_flag = if encrypt_metadata { b'T' } else { b'F' };
    (perms.starts_with(&permissions.to_le_bytes())
        && perms.get(4..12) == Some(&[0xff, 0xff, 0xff, 0xff, metadata_flag, b'a', b'd', b'b']))
    .then_some(key)
}
