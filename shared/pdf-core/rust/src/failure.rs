use std::error::Error;
use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FailureCode {
    InvalidPdf,
    EncryptedPdf,
    LimitExceeded,
    UnsupportedFeature,
}

impl From<FailureCode> for u32 {
    fn from(code: FailureCode) -> Self {
        match code {
            FailureCode::InvalidPdf => 1,
            FailureCode::EncryptedPdf => 2,
            FailureCode::LimitExceeded => 3,
            FailureCode::UnsupportedFeature => 4,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Failure {
    pub(crate) code: FailureCode,
    pub(crate) reason: String,
}

impl Failure {
    pub(crate) fn new(code: FailureCode, reason: impl Into<String>) -> Self {
        Self {
            code,
            reason: reason.into(),
        }
    }

    pub(crate) fn invalid(reason: impl Into<String>) -> Self {
        Self::new(FailureCode::InvalidPdf, reason)
    }

    pub(crate) fn limit(reason: impl Into<String>) -> Self {
        Self::new(FailureCode::LimitExceeded, reason)
    }
}

impl fmt::Display for Failure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{:?}: {}", self.code, self.reason)
    }
}

impl Error for Failure {}

pub(crate) type Outcome<T> = Result<T, Failure>;
