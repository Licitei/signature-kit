#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FailureCode {
    InvalidPdf = 1,
    EncryptedPdf = 2,
    LimitExceeded = 3,
    UnsupportedFeature = 4,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Failure {
    pub code: FailureCode,
    pub reason: String,
}

impl Failure {
    pub fn new(code: FailureCode, reason: impl Into<String>) -> Self {
        Self {
            code,
            reason: reason.into(),
        }
    }

    pub fn invalid(reason: impl Into<String>) -> Self {
        Self::new(FailureCode::InvalidPdf, reason)
    }

    pub fn limit(reason: impl Into<String>) -> Self {
        Self::new(FailureCode::LimitExceeded, reason)
    }
}

pub type Outcome<T> = Result<T, Failure>;
