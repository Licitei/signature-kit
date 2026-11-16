use std::ops::Range;

use crate::failure::Outcome;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ObjRef {
    pub number: u32,
    pub generation: u16,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Object {
    Null,
    Bool(bool),
    Integer(i64),
    Real(f64),
    Name(Vec<u8>),
    String(Vec<u8>),
    Array(Vec<Object>),
    Dict(Dict),
    Stream(Stream),
    Ref(ObjRef),
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Dict {
    pub entries: Vec<(Vec<u8>, Object)>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Stream {
    pub dict: Dict,
    pub data: Range<usize>,
}

impl Dict {
    pub fn get(&self, key: &[u8]) -> Option<&Object> {
        self.entries
            .iter()
            .find(|(name, _)| name.as_slice() == key)
            .map(|(_, value)| value)
    }

    pub fn insert(&mut self, key: &[u8], value: Object) {
        match self.entries.iter_mut().find(|(name, _)| name.as_slice() == key) {
            Some(entry) => entry.1 = value,
            None => self.entries.push((key.to_vec(), value)),
        }
    }
}

impl Object {
    pub fn as_number(&self) -> Option<f64> {
        match self {
            Object::Integer(value) => Some(*value as f64),
            Object::Real(value) => Some(*value),
            _ => None,
        }
    }

    pub fn as_integer(&self) -> Option<i64> {
        match self {
            Object::Integer(value) => Some(*value),
            _ => None,
        }
    }

    pub fn as_name(&self) -> Option<&[u8]> {
        match self {
            Object::Name(value) => Some(value),
            _ => None,
        }
    }

    pub fn as_string(&self) -> Option<&[u8]> {
        match self {
            Object::String(value) => Some(value),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[Object]> {
        match self {
            Object::Array(value) => Some(value),
            _ => None,
        }
    }

    pub fn as_dict(&self) -> Option<&Dict> {
        match self {
            Object::Dict(value) => Some(value),
            Object::Stream(stream) => Some(&stream.dict),
            _ => None,
        }
    }

    pub fn as_stream(&self) -> Option<&Stream> {
        match self {
            Object::Stream(value) => Some(value),
            _ => None,
        }
    }
}

pub trait Resolver {
    fn resolve(&self, object: &Object) -> Outcome<Object>;
    fn stream_data(&self, stream: &Stream) -> Outcome<Vec<u8>>;
}
