//! Vision Manager - Dynamic monitor recording management
//!
//! This module provides automatic detection and recording of all connected monitors,
//! with support for hot-plugging (monitors connecting/disconnecting).

mod manager;
mod monitor_watcher;

pub use manager::{VisionManager, VisionManagerConfig, VisionManagerStatus};
pub use monitor_watcher::{start_monitor_watcher, stop_monitor_watcher};
