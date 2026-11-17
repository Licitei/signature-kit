use alloc::fmt;
use core::error::Error;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FailureCode {
    EncryptedPdf,
    InvalidPdf,
    InvalidRequest,
    LimitExceeded,
    UnsupportedFeature,
}

impl From<FailureCode> for u32 {
    #[inline]
    fn from(code: FailureCode) -> Self {
        match code {
            FailureCode::InvalidPdf => 1,
            FailureCode::EncryptedPdf => 2,
            FailureCode::LimitExceeded => 3,
            FailureCode::UnsupportedFeature => 4,
            FailureCode::InvalidRequest => 5,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Failure {
    pub(crate) code: FailureCode,
    pub(crate) reason: String,
}

impl Failure {
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

    pub(crate) fn new<R>(code: FailureCode, reason: R) -> Self
    where
        R: Into<String>,
    {
        Self {
            code,
            reason: reason.into(),
        }
    }

    pub(crate) fn request<R>(reason: R) -> Self
    where
        R: Into<String>,
    {
        Self::new(FailureCode::InvalidRequest, reason)
    }
}

impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let label = match self.code {
            FailureCode::InvalidPdf => "invalid_pdf",
            FailureCode::EncryptedPdf => "encrypted_pdf",
            FailureCode::LimitExceeded => "limit_exceeded",
            FailureCode::UnsupportedFeature => "unsupported_feature",
            FailureCode::InvalidRequest => "invalid_request",
        };
        write!(f, "{label}: {}", self.reason)
    }
}

impl Error for Failure {}

pub(crate) type Outcome<T> = Result<T, Failure>;
