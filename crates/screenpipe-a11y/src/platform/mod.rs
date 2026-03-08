//! Platform-specific UI event capture implementations

#[cfg(target_os = "macos")]
pub mod macos;

#[cfg(target_os = "windows")]
pub mod windows;

#[cfg(target_os = "windows")]
pub mod windows_uia;

#[cfg(all(test, target_os = "windows"))]
mod windows_uia_tests;

#[cfg(target_os = "linux")]
pub mod linux;

// Re-export platform-specific types with common names
#[cfg(target_os = "macos")]
pub use macos::{PermissionStatus, RecordingHandle, UiRecorder};

#[cfg(target_os = "windows")]
pub use windows::{PermissionStatus, RecordingHandle, UiRecorder};

#[cfg(target_os = "linux")]
pub use linux::{PermissionStatus, RecordingHandle, UiRecorder};

// Stub for unsupported platforms (not macOS, Windows, or Linux)
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
pub mod stub {
    use crate::activity_feed::ActivityFeed;
    use crate::config::UiCaptureConfig;
    use crate::events::UiEvent;
    use anyhow::Result;
    use crossbeam_channel::{bounded, Receiver};

    #[derive(Debug, Clone)]
    pub struct PermissionStatus {
        pub accessibility: bool,
        pub input_monitoring: bool,
    }

    impl PermissionStatus {
        pub fn all_granted(&self) -> bool {
            false
        }
    }

    pub struct RecordingHandle {
        events_rx: Receiver<UiEvent>,
    }

    impl RecordingHandle {
        pub fn stop(self) {}
        pub fn is_running(&self) -> bool {
            false
        }
        pub fn receiver(&self) -> &Receiver<UiEvent> {
            &self.events_rx
        }
        pub fn try_recv(&self) -> Option<UiEvent> {
            None
        }
        pub fn recv(&self) -> Option<UiEvent> {
            None
        }
        pub fn recv_timeout(&self, _: std::time::Duration) -> Option<UiEvent> {
            None
        }
    }

    pub struct UiRecorder {
        _config: UiCaptureConfig,
    }

    impl UiRecorder {
        pub fn new(config: UiCaptureConfig) -> Self {
            Self { _config: config }
        }

        pub fn with_defaults() -> Self {
            Self::new(UiCaptureConfig::new())
        }

        pub fn check_permissions(&self) -> PermissionStatus {
            PermissionStatus {
                accessibility: false,
                input_monitoring: false,
            }
        }

        pub fn request_permissions(&self) -> PermissionStatus {
            self.check_permissions()
        }

        pub fn start(&self) -> Result<RecordingHandle> {
            anyhow::bail!("UI event capture not supported on this platform")
        }

        pub fn start_with_activity_feed(&self) -> Result<(RecordingHandle, ActivityFeed)> {
            anyhow::bail!("UI event capture not supported on this platform")
        }

        pub fn start_activity_only(&self) -> Result<ActivityFeed> {
            anyhow::bail!("Activity feed not supported on this platform")
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
pub use stub::{PermissionStatus, RecordingHandle, UiRecorder};
