use crate::num::i64_to_f64;
use std::ops::Range;

use crate::failure::Outcome;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub(crate) struct ObjRef {
    pub number: u32,
    pub generation: u16,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Object {
    Null,
    Bool(bool),
    Integer(i64),
    Real(f64),
    Name(Vec<u8>),
    String(Vec<u8>),
    Array(Vec<Self>),
    Dict(Dict),
    Stream(Stream),
    Ref(ObjRef),
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Dict {
    pub entries: Vec<(Vec<u8>, Object)>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Stream {
    pub dict: Dict,
    pub data: Range<usize>,
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
    pub(crate) const fn as_number(&self) -> Option<f64> {
        match self {
            Self::Integer(value) => Some(i64_to_f64(*value)),
            Self::Real(value) => Some(*value),
            _ => None,
        }
    }

    pub(crate) const fn as_integer(&self) -> Option<i64> {
        match self {
            Self::Integer(value) => Some(*value),
            _ => None,
        }
    }

    pub(crate) fn as_name(&self) -> Option<&[u8]> {
        match self {
            Self::Name(value) => Some(value),
            _ => None,
        }
    }

    pub(crate) fn as_string(&self) -> Option<&[u8]> {
        match self {
            Self::String(value) => Some(value),
            _ => None,
        }
    }

    pub(crate) fn as_array(&self) -> Option<&[Self]> {
        match self {
            Self::Array(value) => Some(value),
            _ => None,
        }
    }

    pub(crate) const fn as_dict(&self) -> Option<&Dict> {
        match self {
            Self::Dict(value) => Some(value),
            Self::Stream(stream) => Some(&stream.dict),
            _ => None,
        }
    }

    pub(crate) const fn as_stream(&self) -> Option<&Stream> {
        match self {
            Self::Stream(value) => Some(value),
            _ => None,
        }
    }
}

pub(crate) trait Resolver {
    fn resolve(&self, object: &Object) -> Outcome<Object>;
    fn stream_data(&self, stream: &Stream) -> Outcome<Vec<u8>>;
}
