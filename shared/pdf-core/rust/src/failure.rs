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
    pub(crate) fn new<R>(code: FailureCode, reason: R) -> Self
    where
        R: Into<String>,
    {
        Self {
            code,
            reason: reason.into(),
        }
    }

    pub(crate) fn invalid<R>(reason: R) -> Self
    where
        R: Into<String>,
    {
        Self::new(FailureCode::InvalidPdf, reason)
    }

    pub(crate) fn limit<R>(reason: R) -> Self
    where
        R: Into<String>,
    {
        Self::new(FailureCode::LimitExceeded, reason)
    }
}

impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let label = match self.code {
            FailureCode::InvalidPdf => "invalid_pdf",
            FailureCode::EncryptedPdf => "encrypted_pdf",
            FailureCode::LimitExceeded => "limit_exceeded",
            FailureCode::UnsupportedFeature => "unsupported_feature",
        };
        write!(f, "{label}: {}", self.reason)
    }
}

impl Error for Failure {}

pub(crate) type Outcome<T> = Result<T, Failure>;
