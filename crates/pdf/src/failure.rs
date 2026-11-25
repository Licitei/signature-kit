#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[expect(
    clippy::module_name_repetitions,
    reason = "the internal ABI retains the existing PDF operation names"
)]
#[expect(
    clippy::exhaustive_enums,
    reason = "the internal ABI shares these variants with the WASM crate"
)]
pub enum FailureCode {
    DamagedXref,
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
            FailureCode::DamagedXref => 6,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[expect(
    clippy::exhaustive_structs,
    reason = "the internal ABI shares this struct with the WASM crate"
)]
pub struct Failure {
    pub code: FailureCode,
    pub reason: String,
}

impl Failure {
    #[expect(
        clippy::missing_inline_in_public_items,
        reason = "release LTO chooses inlining across the internal Rust boundary"
    )]
    pub fn invalid<R>(reason: R) -> Self
    where
        R: Into<String>,
    {
        Self::new(FailureCode::InvalidPdf, reason)
    }

    #[expect(
        clippy::missing_inline_in_public_items,
        reason = "release LTO chooses inlining across the internal Rust boundary"
    )]
    pub fn limit<R>(reason: R) -> Self
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

    #[expect(
        clippy::missing_inline_in_public_items,
        reason = "release LTO chooses inlining across the internal Rust boundary"
    )]
    pub fn request<R>(reason: R) -> Self
    where
        R: Into<String>,
    {
        Self::new(FailureCode::InvalidRequest, reason)
    }
}

pub type Outcome<T> = Result<T, Failure>;
