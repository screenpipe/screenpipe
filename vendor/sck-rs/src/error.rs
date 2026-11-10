//! Error types for xcap-sck

use std::fmt;

/// Error type for xcap-sck operations
#[derive(Debug)]
pub struct XCapError {
    message: String,
    source: Option<Box<dyn std::error::Error + Send + Sync>>,
}

impl XCapError {
    /// Create a new error with a message
    pub fn new<S: Into<String>>(message: S) -> Self {
        Self {
            message: message.into(),
            source: None,
        }
    }

    /// Create a new error with a message and source error
    pub fn with_source<S, E>(message: S, source: E) -> Self
    where
        S: Into<String>,
        E: std::error::Error + Send + Sync + 'static,
    {
        Self {
            message: message.into(),
            source: Some(Box::new(source)),
        }
    }

    /// Create an error for when no windows are found
    pub fn no_windows() -> Self {
        Self::new("No windows found")
    }

    /// Create an error for when no monitors are found
    pub fn no_monitors() -> Self {
        Self::new("No monitors found")
    }

    /// Create an error for permission denied
    pub fn permission_denied() -> Self {
        Self::new("Screen recording permission not granted. Grant access in System Settings > Privacy & Security > Screen Recording")
    }

    /// Create an error for capture failure
    pub fn capture_failed<S: Into<String>>(details: S) -> Self {
        Self::new(format!("Capture failed: {}", details.into()))
    }

    /// Create an error for window not found
    pub fn window_not_found(window_id: u32) -> Self {
        Self::new(format!("Window with id {} not found", window_id))
    }

    /// Create an error for monitor not found
    pub fn monitor_not_found(monitor_id: u32) -> Self {
        Self::new(format!("Monitor with id {} not found", monitor_id))
    }
}

impl fmt::Display for XCapError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)?;
        if let Some(ref source) = self.source {
            write!(f, ": {}", source)?;
        }
        Ok(())
    }
}

impl std::error::Error for XCapError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.source
            .as_ref()
            .map(|e| e.as_ref() as &(dyn std::error::Error + 'static))
    }
}

impl From<String> for XCapError {
    fn from(s: String) -> Self {
        Self::new(s)
    }
}

impl From<&str> for XCapError {
    fn from(s: &str) -> Self {
        Self::new(s)
    }
}

impl From<std::io::Error> for XCapError {
    fn from(e: std::io::Error) -> Self {
        Self::with_source("IO error", e)
    }
}

/// Result type for xcap-sck operations
pub type XCapResult<T> = Result<T, XCapError>;

#[cfg(test)]
mod tests {
    use super::*;
    use std::error::Error;

    #[test]
    fn test_error_display() {
        let err = XCapError::new("test error");
        assert_eq!(format!("{}", err), "test error");
    }

    #[test]
    fn test_error_with_source() {
        let io_err = std::io::Error::new(std::io::ErrorKind::NotFound, "file not found");
        let err = XCapError::with_source("failed to read", io_err);
        assert!(format!("{}", err).contains("failed to read"));
        assert!(err.source().is_some());
    }

    #[test]
    fn test_permission_denied() {
        let err = XCapError::permission_denied();
        assert!(format!("{}", err).contains("permission"));
    }

    #[test]
    fn test_from_string() {
        let err: XCapError = "test error".into();
        assert_eq!(format!("{}", err), "test error");
    }
}
