use alloc::rc::Rc;
use core::ops::Range;

use crate::failure::{Failure, Outcome};
use crate::num::i64_to_f64;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[expect(
    clippy::arbitrary_source_item_ordering,
    reason = "derived Ord must compare the object number before the generation"
)]
pub(crate) struct ObjRef {
    pub number: u32,
    pub generation: u16,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Object {
    Array(Vec<Self>),
    Bool(bool),
    Dict(Dict),
    Integer(i64),
    Name(Vec<u8>),
    Null,
    Real(f64),
    Ref(ObjRef),
    Stream(Stream),
    String(Vec<u8>),
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Dict {
    pub entries: Vec<(Vec<u8>, Object)>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Stream {
    pub data: Range<usize>,
    pub decrypted: Option<Rc<[u8]>>,
    pub dict: Dict,
}

impl Stream {
    pub(crate) fn encoded_bytes<'data>(&'data self, pdf: &'data [u8]) -> Outcome<&'data [u8]> {
        if let Some(bytes) = &self.decrypted {
            return Ok(bytes);
        }
        pdf.get(self.data.clone())
            .ok_or_else(|| Failure::invalid("stream data out of range"))
    }
}

impl Dict {
    pub(crate) fn get(&self, key: &[u8]) -> Option<&Object> {
        self.entries
            .iter()
            .find(|(name, _)| name.as_slice() == key)
            .map(|(_, value)| value)
    }

    pub(crate) fn insert(&mut self, key: &[u8], value: Object) {
        match self
            .entries
            .iter_mut()
            .find(|(name, _)| name.as_slice() == key)
        {
            Some(entry) => entry.1 = value,
            None => self.entries.push((key.to_vec(), value)),
        }
    }
}

impl Object {
    pub(crate) fn as_array(&self) -> Option<&[Self]> {
        if let Self::Array(value) = self {
            Some(value)
        } else {
            None
        }
    }

    pub(crate) const fn as_dict(&self) -> Option<&Dict> {
        match self {
            Self::Dict(value) => Some(value),
            Self::Stream(stream) => Some(&stream.dict),
            Self::Null
            | Self::Bool(_)
            | Self::Integer(_)
            | Self::Real(_)
            | Self::Name(_)
            | Self::String(_)
            | Self::Array(_)
            | Self::Ref(_) => None,
        }
    }

    pub(crate) const fn as_integer(&self) -> Option<i64> {
        if let Self::Integer(value) = self {
            Some(*value)
        } else {
            None
        }
    }

    pub(crate) fn as_matrix(&self) -> Option<[f64; 6]> {
        let items: &[Self; 6] = self.as_array()?.try_into().ok()?;
        let mut matrix = [0.0_f64; 6];
        for (slot, item) in matrix.iter_mut().zip(items) {
            *slot = item.as_number().filter(|number| number.is_finite())?;
        }
        Some(matrix)
    }

    pub(crate) fn as_name(&self) -> Option<&[u8]> {
        if let Self::Name(value) = self {
            Some(value)
        } else {
            None
        }
    }

    pub(crate) const fn as_number(&self) -> Option<f64> {
        match self {
            Self::Integer(value) => Some(i64_to_f64(*value)),
            Self::Real(value) => Some(*value),
            Self::Null
            | Self::Bool(_)
            | Self::Name(_)
            | Self::String(_)
            | Self::Array(_)
            | Self::Dict(_)
            | Self::Stream(_)
            | Self::Ref(_) => None,
        }
    }

    pub(crate) const fn as_stream(&self) -> Option<&Stream> {
        if let Self::Stream(value) = self {
            Some(value)
        } else {
            None
        }
    }

    pub(crate) fn as_string(&self) -> Option<&[u8]> {
        if let Self::String(value) = self {
            Some(value)
        } else {
            None
        }
    }

    pub(crate) const fn is_ref(&self) -> bool {
        matches!(self, Self::Ref(_))
    }
}

pub(crate) trait Resolver {
    fn resolve(&self, object: &Object) -> Outcome<Rc<Object>>;
    fn stream_data(&self, stream: &Stream) -> Outcome<Vec<u8>>;
    fn stream_prefix(&self, stream: &Stream, _len: usize) -> Outcome<Vec<u8>> {
        self.stream_data(stream)
    }
}
