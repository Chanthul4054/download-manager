//! One error type for the whole backend. It carries the fields the JavaScript code read from its
//! error objects: `code` (ENOSPC, ETIMEDOUT, EAUTH ...), HTTP `status`, `retryAfter` and `realm`.

use std::fmt;

#[derive(Debug, Clone, Default)]
pub struct Error {
    pub message: String,
    pub code: Option<String>,
    pub status: Option<u16>,
    /// Retry-After in milliseconds (0 = none).
    pub retry_after: u64,
    pub realm: Option<String>,
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    pub fn new(message: impl Into<String>) -> Self {
        Error { message: message.into(), ..Default::default() }
    }

    pub fn with_code(message: impl Into<String>, code: &str) -> Self {
        Error { message: message.into(), code: Some(code.to_string()), ..Default::default() }
    }

    pub fn abort() -> Self {
        Error::with_code("Aborted", "ABORT_ERR")
    }

    pub fn code(&self) -> &str {
        self.code.as_deref().unwrap_or("")
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Error {}

/// Node's errno name for an I/O error, so code that checks `err.code` keeps working.
pub fn io_code(e: &std::io::Error) -> &'static str {
    use std::io::ErrorKind as K;
    match e.kind() {
        K::NotFound => "ENOENT",
        K::PermissionDenied => "EACCES",
        K::AlreadyExists => "EEXIST",
        K::StorageFull => "ENOSPC",
        K::ReadOnlyFilesystem => "EROFS",
        K::FileTooLarge => "EFBIG",
        K::CrossesDevices => "EXDEV",
        K::ConnectionRefused => "ECONNREFUSED",
        K::ConnectionReset => "ECONNRESET",
        K::ConnectionAborted => "ECONNABORTED",
        K::TimedOut => "ETIMEDOUT",
        K::BrokenPipe => "EPIPE",
        K::NotADirectory => "ENOTDIR",
        K::IsADirectory => "EISDIR",
        K::DirectoryNotEmpty => "ENOTEMPTY",
        K::InvalidInput => "EINVAL",
        _ => match e.raw_os_error() {
            // ERROR_DISK_FULL / ERROR_HANDLE_DISK_FULL on Windows.
            Some(112) | Some(39) => "ENOSPC",
            Some(5) => "EPERM",
            _ => "EIO",
        },
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        let code = io_code(&e);
        Error::with_code(format!("{}: {}", code, e), code)
    }
}

impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Error::new(e.to_string())
    }
}

impl From<url::ParseError> for Error {
    fn from(_: url::ParseError) -> Self {
        Error::with_code("Invalid URL", "ERR_INVALID_URL")
    }
}

impl From<tauri::Error> for Error {
    fn from(e: tauri::Error) -> Self {
        Error::new(e.to_string())
    }
}
