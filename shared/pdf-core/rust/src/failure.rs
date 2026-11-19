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
    pub(crate) reason: &'static str,
}

impl Failure {
    pub(crate) const fn invalid(reason: &'static str) -> Self {
        Self::new(FailureCode::InvalidPdf, reason)
    }

    pub(crate) const fn limit(reason: &'static str) -> Self {
        Self::new(FailureCode::LimitExceeded, reason)
    }

    pub(crate) const fn new(code: FailureCode, reason: &'static str) -> Self {
        Self { code, reason }
    }

    pub(crate) const fn request(reason: &'static str) -> Self {
        Self::new(FailureCode::InvalidRequest, reason)
    }
}

pub(crate) type Outcome<T> = Result<T, Failure>;
