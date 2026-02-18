use clap::ValueEnum;
use clap::{Parser, Subcommand, ValueHint};
use screenpipe_audio::{
    audio_manager::builder::TranscriptionMode,
    core::engine::AudioTranscriptionEngine as CoreAudioTranscriptionEngine,
    vad::{VadEngineEnum, VadSensitivity},
};
use screenpipe_core::Language;
use screenpipe_db::CustomOcrConfig as DBCustomOcrConfig;
use screenpipe_db::OcrEngine as DBOcrEngine;
use screenpipe_vision::{custom_ocr::CustomOcrConfig, utils::OcrEngine as CoreOcrEngine};
use std::sync::Arc;

#[derive(Clone, Debug, ValueEnum, PartialEq)]
pub enum CliAudioTranscriptionEngine {
    #[clap(name = "deepgram")]
    Deepgram,
    #[clap(name = "whisper-tiny")]
    WhisperTiny,
    #[clap(name = "whisper-tiny-quantized")]
    WhisperTinyQuantized,
    #[clap(name = "whisper-large")]
    WhisperLargeV3,
    #[clap(name = "whisper-large-quantized")]
    WhisperLargeV3Quantized,
    #[clap(name = "whisper-large-v3-turbo")]
    WhisperLargeV3Turbo,
    #[clap(name = "whisper-large-v3-turbo-quantized")]
    WhisperLargeV3TurboQuantized,
}

impl From<CliAudioTranscriptionEngine> for CoreAudioTranscriptionEngine {
    fn from(cli_engine: CliAudioTranscriptionEngine) -> Self {
        match cli_engine {
            CliAudioTranscriptionEngine::Deepgram => CoreAudioTranscriptionEngine::Deepgram,
            CliAudioTranscriptionEngine::WhisperTiny => CoreAudioTranscriptionEngine::WhisperTiny,
            CliAudioTranscriptionEngine::WhisperTinyQuantized => {
                CoreAudioTranscriptionEngine::WhisperTinyQuantized
            }
            CliAudioTranscriptionEngine::WhisperLargeV3 => {
                CoreAudioTranscriptionEngine::WhisperLargeV3
            }
            CliAudioTranscriptionEngine::WhisperLargeV3Quantized => {
                CoreAudioTranscriptionEngine::WhisperLargeV3Quantized
            }
            CliAudioTranscriptionEngine::WhisperLargeV3Turbo => {
                CoreAudioTranscriptionEngine::WhisperLargeV3Turbo
            }
            CliAudioTranscriptionEngine::WhisperLargeV3TurboQuantized => {
                CoreAudioTranscriptionEngine::WhisperLargeV3TurboQuantized
            }
        }
    }
}

#[derive(Clone, Debug, ValueEnum, PartialEq)]
pub enum CliOcrEngine {
    Unstructured,
    #[cfg(target_os = "linux")]
    Tesseract,
    #[cfg(target_os = "windows")]
    WindowsNative,
    #[cfg(target_os = "macos")]
    AppleNative,
    Custom,
}

impl From<CliOcrEngine> for Arc<DBOcrEngine> {
    fn from(cli_engine: CliOcrEngine) -> Self {
        match cli_engine {
            CliOcrEngine::Unstructured => Arc::new(DBOcrEngine::Unstructured),
            #[cfg(target_os = "macos")]
            CliOcrEngine::AppleNative => Arc::new(DBOcrEngine::AppleNative),
            #[cfg(target_os = "linux")]
            CliOcrEngine::Tesseract => Arc::new(DBOcrEngine::Tesseract),
            #[cfg(target_os = "windows")]
            CliOcrEngine::WindowsNative => Arc::new(DBOcrEngine::WindowsNative),
            CliOcrEngine::Custom => Arc::new(DBOcrEngine::Custom(DBCustomOcrConfig::default())),
        }
    }
}

impl From<CliOcrEngine> for CoreOcrEngine {
    fn from(cli_engine: CliOcrEngine) -> Self {
        match cli_engine {
            CliOcrEngine::Unstructured => CoreOcrEngine::Unstructured,
            #[cfg(target_os = "linux")]
            CliOcrEngine::Tesseract => CoreOcrEngine::Tesseract,
            #[cfg(target_os = "windows")]
            CliOcrEngine::WindowsNative => CoreOcrEngine::WindowsNative,
            #[cfg(target_os = "macos")]
            CliOcrEngine::AppleNative => CoreOcrEngine::AppleNative,
            CliOcrEngine::Custom => {
                if let Ok(config_str) = std::env::var("SCREENPIPE_CUSTOM_OCR_CONFIG") {
                    match serde_json::from_str(&config_str) {
                        Ok(config) => CoreOcrEngine::Custom(config),
                        Err(e) => {
                            tracing::warn!("failed to parse custom ocr config from env: {}", e);
                            CoreOcrEngine::Custom(CustomOcrConfig::default())
                        }
                    }
                } else {
                    CoreOcrEngine::Custom(CustomOcrConfig::default())
                }
            }
        }
    }
}

#[derive(Clone, Debug, ValueEnum, PartialEq)]
pub enum CliVadEngine {
    #[clap(name = "webrtc")]
    WebRtc,
    #[clap(name = "silero")]
    Silero,
}

impl From<CliVadEngine> for VadEngineEnum {
    fn from(cli_engine: CliVadEngine) -> Self {
        match cli_engine {
            CliVadEngine::WebRtc => VadEngineEnum::WebRtc,
            CliVadEngine::Silero => VadEngineEnum::Silero,
        }
    }
}

#[derive(Clone, Debug, ValueEnum, PartialEq)]
pub enum CliVadSensitivity {
    Low,
    Medium,
    High,
}

impl From<CliVadSensitivity> for VadSensitivity {
    fn from(cli_sensitivity: CliVadSensitivity) -> Self {
        match cli_sensitivity {
            CliVadSensitivity::Low => VadSensitivity::Low,
            CliVadSensitivity::Medium => VadSensitivity::Medium,
            CliVadSensitivity::High => VadSensitivity::High,
        }
    }
}

#[derive(Clone, Debug, ValueEnum, PartialEq)]
pub enum CliTranscriptionMode {
    /// Transcribe immediately as audio is captured (default)
    #[clap(name = "realtime")]
    Realtime,
    /// Defer local Whisper inference to idle periods (CPU < threshold)
    #[clap(name = "smart")]
    Smart,
}

impl From<CliTranscriptionMode> for TranscriptionMode {
    fn from(cli_mode: CliTranscriptionMode) -> Self {
        match cli_mode {
            CliTranscriptionMode::Realtime => TranscriptionMode::Realtime,
            CliTranscriptionMode::Smart => TranscriptionMode::Smart,
        }
    }
}

#[derive(Clone, Debug, ValueEnum, PartialEq)]
pub enum OutputFormat {
    Text,
    Json,
}

// =============================================================================
// Top-level CLI
// =============================================================================

#[derive(Parser)]
#[command(
    author,
    version,
    about = "screenpipe: build ai apps that have the full context",
    long_about = None,
    name = "screenpipe"
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Command>,

    // =========================================================================
    // Legacy top-level flags (for backward compat with bare `screenpipe`)
    // These are duplicated on RecordArgs. When command is None, these are used.
    // =========================================================================
    /// FPS for continuous recording
    #[cfg_attr(not(target_os = "macos"), arg(short, long, default_value_t = 1.0))]
    #[cfg_attr(target_os = "macos", arg(short, long, default_value_t = 0.5))]
    pub fps: f64,

    #[arg(long, default_value_t = false)]
    pub adaptive_fps: bool,

    #[arg(short = 'd', long, default_value_t = 30)]
    pub audio_chunk_duration: u64,

    #[arg(short = 'p', long, default_value_t = 3030)]
    pub port: u16,

    #[arg(long, default_value_t = false)]
    pub disable_audio: bool,

    #[arg(short = 'i', long)]
    pub audio_device: Vec<String>,

    #[arg(long, default_value_t = true)]
    pub use_system_default_audio: bool,

    #[arg(short = 'r', long, hide = true)]
    pub realtime_audio_device: Vec<String>,

    #[arg(long, value_hint = ValueHint::DirPath)]
    pub data_dir: Option<String>,

    #[arg(long)]
    pub debug: bool,

    #[arg(short = 'a', long, value_enum, default_value_t = CliAudioTranscriptionEngine::WhisperLargeV3TurboQuantized)]
    pub audio_transcription_engine: CliAudioTranscriptionEngine,

    #[cfg_attr(
        target_os = "macos",
        arg(short = 'o', long, value_enum, default_value_t = CliOcrEngine::AppleNative)
    )]
    #[cfg_attr(
        target_os = "windows",
        arg(short = 'o', long, value_enum, default_value_t = CliOcrEngine::WindowsNative)
    )]
    #[cfg_attr(
        not(any(target_os = "macos", target_os = "windows")),
        arg(short = 'o', long, value_enum, default_value_t = CliOcrEngine::Tesseract)
    )]
    pub ocr_engine: CliOcrEngine,

    #[arg(short = 'm', long)]
    pub monitor_id: Vec<u32>,

    #[arg(long, default_value_t = true)]
    pub use_all_monitors: bool,

    #[arg(short = 'l', long, value_enum)]
    pub language: Vec<Language>,

    #[arg(long, default_value_t = true)]
    pub use_pii_removal: bool,

    #[arg(long, default_value_t = false)]
    pub disable_vision: bool,

    #[arg(long, value_enum, default_value_t = CliVadEngine::Silero)]
    pub vad_engine: CliVadEngine,

    #[arg(long)]
    pub ignored_windows: Vec<String>,

    #[arg(long)]
    pub included_windows: Vec<String>,

    #[arg(long)]
    pub ignored_urls: Vec<String>,

    #[arg(long = "deepgram-api-key")]
    pub deepgram_api_key: Option<String>,

    #[arg(long, hide = true)]
    pub auto_destruct_pid: Option<u32>,

    #[arg(long, value_enum, default_value_t = CliVadSensitivity::High)]
    pub vad_sensitivity: CliVadSensitivity,

    /// Audio transcription scheduling mode
    #[arg(long, value_enum, default_value_t = CliTranscriptionMode::Realtime)]
    pub transcription_mode: CliTranscriptionMode,

    #[arg(long, default_value_t = false)]
    pub disable_telemetry: bool,

    #[arg(long, default_value = "balanced")]
    pub video_quality: String,

    /// Enable input event capture (keyboard, mouse, clipboard)
    #[arg(long, default_value_t = false)]
    pub enable_input_capture: bool,

    /// Enable accessibility text capture (AX tree walker)
    #[arg(long, default_value_t = false)]
    pub enable_accessibility: bool,

    #[arg(long, default_value_t = false)]
    pub enable_sync: bool,

    #[arg(long, env = "SCREENPIPE_SYNC_TOKEN")]
    pub sync_token: Option<String>,

    #[arg(long, env = "SCREENPIPE_SYNC_PASSWORD")]
    pub sync_password: Option<String>,

    #[arg(long, default_value_t = 300)]
    pub sync_interval_secs: u64,

    #[arg(long)]
    pub sync_machine_id: Option<String>,
}

impl Cli {
    pub fn unique_languages(&self) -> Result<Vec<Language>, String> {
        let mut unique_langs = std::collections::HashSet::new();
        for lang in &self.language {
            if !unique_langs.insert(lang.clone()) {
                // continue don't care
            }
        }
        Ok(unique_langs.into_iter().collect())
    }

    /// Create UI recorder configuration from CLI arguments
    #[cfg(feature = "ui-events")]
    pub fn to_ui_recorder_config(&self) -> crate::ui_recorder::UiRecorderConfig {
        crate::ui_recorder::UiRecorderConfig {
            enabled: self.enable_input_capture || self.enable_accessibility,
            enable_tree_walker: self.enable_accessibility,
            record_input_events: self.enable_input_capture,
            excluded_windows: self.ignored_windows.clone(),
            ignored_windows: self.ignored_windows.clone(),
            included_windows: self.included_windows.clone(),
            ..Default::default()
        }
    }

    #[cfg(not(feature = "ui-events"))]
    pub fn to_ui_recorder_config(&self) -> crate::ui_recorder::UiRecorderConfig {
        crate::ui_recorder::UiRecorderConfig { enabled: false }
    }
}

// =============================================================================
// Commands
// =============================================================================

#[derive(Subcommand)]
pub enum Command {
    /// Start recording screen, audio, and optionally serve the API
    Record(RecordArgs),

    /// Show screenpipe status (running state, data stats)
    Status {
        /// Output format
        #[arg(long, default_value_t = false)]
        json: bool,
        /// Data directory. Default to $HOME/.screenpipe
        #[arg(long, value_hint = ValueHint::DirPath)]
        data_dir: Option<String>,
        /// Port to check for running server
        #[arg(short = 'p', long, default_value_t = 3030)]
        port: u16,
    },

    /// Manage pipes (scheduled agents on screen data)
    Pipe {
        #[command(subcommand)]
        subcommand: PipeCommand,
    },

    /// Audio device management commands
    Audio {
        #[command(subcommand)]
        subcommand: AudioCommand,
    },

    /// Vision device management commands
    Vision {
        #[command(subcommand)]
        subcommand: VisionCommand,
    },

    /// Cloud sync management commands
    Sync {
        #[command(subcommand)]
        subcommand: SyncCommand,
    },

    /// MCP Server management commands
    Mcp {
        #[command(subcommand)]
        subcommand: McpCommand,
    },
}

// =============================================================================
// Record args (all the flags that were previously top-level)
// =============================================================================

#[derive(Parser, Clone)]
pub struct RecordArgs {
    /// FPS for continuous recording
    /// 1 FPS = 30 GB / month, 5 FPS = 150 GB / month
    #[cfg_attr(not(target_os = "macos"), arg(short, long, default_value_t = 1.0))]
    #[cfg_attr(target_os = "macos", arg(short, long, default_value_t = 0.5))]
    pub fps: f64,

    /// Enable adaptive FPS based on input activity
    #[arg(long, default_value_t = false)]
    pub adaptive_fps: bool,

    /// Audio chunk duration in seconds
    #[arg(short = 'd', long, default_value_t = 30)]
    pub audio_chunk_duration: u64,

    /// Port to run the server on
    #[arg(short = 'p', long, default_value_t = 3030)]
    pub port: u16,

    /// Disable audio recording
    #[arg(long, default_value_t = false)]
    pub disable_audio: bool,

    /// Audio devices to use (can be specified multiple times)
    #[arg(short = 'i', long)]
    pub audio_device: Vec<String>,

    /// Follow system default audio devices
    #[arg(long, default_value_t = true)]
    pub use_system_default_audio: bool,

    /// Data directory. Default to $HOME/.screenpipe
    #[arg(long, value_hint = ValueHint::DirPath)]
    pub data_dir: Option<String>,

    /// Enable debug logging for screenpipe modules
    #[arg(long)]
    pub debug: bool,

    /// Audio transcription engine to use
    #[arg(short = 'a', long, value_enum, default_value_t = CliAudioTranscriptionEngine::WhisperLargeV3TurboQuantized)]
    pub audio_transcription_engine: CliAudioTranscriptionEngine,

    /// OCR engine to use
    #[cfg_attr(
        target_os = "macos",
        arg(short = 'o', long, value_enum, default_value_t = CliOcrEngine::AppleNative)
    )]
    #[cfg_attr(
        target_os = "windows",
        arg(short = 'o', long, value_enum, default_value_t = CliOcrEngine::WindowsNative)
    )]
    #[cfg_attr(
        not(any(target_os = "macos", target_os = "windows")),
        arg(short = 'o', long, value_enum, default_value_t = CliOcrEngine::Tesseract)
    )]
    pub ocr_engine: CliOcrEngine,

    /// Monitor IDs to use
    #[arg(short = 'm', long)]
    pub monitor_id: Vec<u32>,

    /// Automatically record all monitors
    #[arg(long, default_value_t = true)]
    pub use_all_monitors: bool,

    /// Languages for OCR/transcription
    #[arg(short = 'l', long, value_enum)]
    pub language: Vec<Language>,

    /// Enable PII removal
    #[arg(long, default_value_t = true)]
    pub use_pii_removal: bool,

    /// Disable vision recording
    #[arg(long, default_value_t = false)]
    pub disable_vision: bool,

    /// VAD engine to use for speech detection
    #[arg(long, value_enum, default_value_t = CliVadEngine::Silero)]
    pub vad_engine: CliVadEngine,

    /// Windows to ignore (by title, uses contains matching)
    #[arg(long)]
    pub ignored_windows: Vec<String>,

    /// Windows to include (by title, uses contains matching)
    #[arg(long)]
    pub included_windows: Vec<String>,

    /// URLs to ignore for browser privacy filtering
    #[arg(long)]
    pub ignored_urls: Vec<String>,

    /// Deepgram API Key for audio transcription
    #[arg(long = "deepgram-api-key")]
    pub deepgram_api_key: Option<String>,

    /// PID to watch for auto-destruction
    #[arg(long, hide = true)]
    pub auto_destruct_pid: Option<u32>,

    /// Voice activity detection sensitivity level
    #[arg(long, value_enum, default_value_t = CliVadSensitivity::High)]
    pub vad_sensitivity: CliVadSensitivity,

    /// Audio transcription scheduling mode: realtime (default) or smart (defer to idle)
    #[arg(long, value_enum, default_value_t = CliTranscriptionMode::Realtime)]
    pub transcription_mode: CliTranscriptionMode,

    /// Disable telemetry
    #[arg(long, default_value_t = false)]
    pub disable_telemetry: bool,

    /// Video quality preset: low, balanced, high, max
    #[arg(long, default_value = "balanced")]
    pub video_quality: String,

    /// Enable input event capture (keyboard, mouse, clipboard)
    #[arg(long, default_value_t = false)]
    pub enable_input_capture: bool,

    /// Enable accessibility text capture (AX tree walker)
    #[arg(long, default_value_t = false)]
    pub enable_accessibility: bool,

    /// Enable cloud sync
    #[arg(long, default_value_t = false)]
    pub enable_sync: bool,

    /// API token for cloud sync
    #[arg(long, env = "SCREENPIPE_SYNC_TOKEN")]
    pub sync_token: Option<String>,

    /// Password for encrypting synced data
    #[arg(long, env = "SCREENPIPE_SYNC_PASSWORD")]
    pub sync_password: Option<String>,

    /// Interval between sync cycles in seconds
    #[arg(long, default_value_t = 300)]
    pub sync_interval_secs: u64,

    /// Override the machine ID for this device
    #[arg(long)]
    pub sync_machine_id: Option<String>,
}

impl RecordArgs {
    /// Convert legacy top-level Cli flags into RecordArgs
    pub fn from_cli(cli: &Cli) -> Self {
        RecordArgs {
            fps: cli.fps,
            adaptive_fps: cli.adaptive_fps,
            audio_chunk_duration: cli.audio_chunk_duration,
            port: cli.port,
            disable_audio: cli.disable_audio,
            audio_device: cli.audio_device.clone(),
            use_system_default_audio: cli.use_system_default_audio,
            data_dir: cli.data_dir.clone(),
            debug: cli.debug,
            audio_transcription_engine: cli.audio_transcription_engine.clone(),
            ocr_engine: cli.ocr_engine.clone(),
            monitor_id: cli.monitor_id.clone(),
            use_all_monitors: cli.use_all_monitors,
            language: cli.language.clone(),
            use_pii_removal: cli.use_pii_removal,
            disable_vision: cli.disable_vision,
            vad_engine: cli.vad_engine.clone(),
            ignored_windows: cli.ignored_windows.clone(),
            included_windows: cli.included_windows.clone(),
            ignored_urls: cli.ignored_urls.clone(),
            deepgram_api_key: cli.deepgram_api_key.clone(),
            auto_destruct_pid: cli.auto_destruct_pid,
            vad_sensitivity: cli.vad_sensitivity.clone(),
            transcription_mode: cli.transcription_mode.clone(),
            disable_telemetry: cli.disable_telemetry,
            video_quality: cli.video_quality.clone(),
            enable_input_capture: cli.enable_input_capture,
            enable_accessibility: cli.enable_accessibility,
            enable_sync: cli.enable_sync,
            sync_token: cli.sync_token.clone(),
            sync_password: cli.sync_password.clone(),
            sync_interval_secs: cli.sync_interval_secs,
            sync_machine_id: cli.sync_machine_id.clone(),
        }
    }

    pub fn unique_languages(&self) -> Result<Vec<Language>, String> {
        let mut unique_langs = std::collections::HashSet::new();
        for lang in &self.language {
            if !unique_langs.insert(lang.clone()) {
                // continue don't care
            }
        }
        Ok(unique_langs.into_iter().collect())
    }

    /// Create UI recorder configuration from record arguments
    #[cfg(feature = "ui-events")]
    pub fn to_ui_recorder_config(&self) -> crate::ui_recorder::UiRecorderConfig {
        crate::ui_recorder::UiRecorderConfig {
            enabled: self.enable_input_capture || self.enable_accessibility,
            enable_tree_walker: self.enable_accessibility,
            record_input_events: self.enable_input_capture,
            excluded_windows: self.ignored_windows.clone(),
            ignored_windows: self.ignored_windows.clone(),
            included_windows: self.included_windows.clone(),
            ..Default::default()
        }
    }

    #[cfg(not(feature = "ui-events"))]
    pub fn to_ui_recorder_config(&self) -> crate::ui_recorder::UiRecorderConfig {
        crate::ui_recorder::UiRecorderConfig { enabled: false }
    }
}

// =============================================================================
// Pipe commands (unimplemented — will be built by pipes agent, see #2213)
// =============================================================================

#[derive(Subcommand)]
pub enum PipeCommand {
    /// List all pipes
    List {
        /// Output format
        #[arg(long, default_value_t = false)]
        json: bool,
    },
    /// Install a pipe from a local path or URL
    Install {
        /// Source: local file/dir path or URL
        source: String,
    },
    /// Enable a pipe
    Enable {
        /// Pipe name
        name: String,
    },
    /// Disable a pipe
    Disable {
        /// Pipe name
        name: String,
    },
    /// Run a pipe once immediately
    Run {
        /// Pipe name
        name: String,
    },
    /// Show pipe logs
    Logs {
        /// Pipe name
        name: String,
        /// Follow log output
        #[arg(short, long, default_value_t = false)]
        follow: bool,
    },
    /// Delete a pipe
    Delete {
        /// Pipe name
        name: String,
    },
}

// =============================================================================
// Existing subcommands (unchanged)
// =============================================================================

#[derive(Subcommand)]
pub enum AudioCommand {
    /// List available audio devices
    List {
        /// Output format
        #[arg(short, long, value_enum, default_value_t = OutputFormat::Text)]
        output: OutputFormat,
    },
}

#[derive(Subcommand)]
pub enum VisionCommand {
    /// List available monitors and vision devices
    List {
        /// Output format
        #[arg(short, long, value_enum, default_value_t = OutputFormat::Text)]
        output: OutputFormat,
    },
}

#[derive(Subcommand)]
pub enum McpCommand {
    /// Setup MCP server configuration
    Setup {
        /// Directory to save MCP files (default: $HOME/.screenpipe/mcp)
        #[arg(long, value_hint = ValueHint::DirPath)]
        directory: Option<String>,
        /// Output format
        #[arg(short, long, value_enum, default_value_t = OutputFormat::Text)]
        output: OutputFormat,
        /// Server port
        #[arg(short = 'p', long, default_value_t = 3030)]
        port: u16,
        /// Force update existing files
        #[arg(long)]
        update: bool,
        /// Purge existing MCP directory before setup
        #[arg(long)]
        purge: bool,
    },
}

#[derive(Subcommand)]
pub enum SyncCommand {
    /// Show sync status
    Status {
        /// Output format
        #[arg(short, long, value_enum, default_value_t = OutputFormat::Text)]
        output: OutputFormat,
        /// Server port
        #[arg(short = 'p', long, default_value_t = 3030)]
        port: u16,
    },
    /// Trigger an immediate sync
    Now {
        /// Server port
        #[arg(short = 'p', long, default_value_t = 3030)]
        port: u16,
    },
    /// Download data from other devices
    Download {
        /// Time range in hours to download (default: 24)
        #[arg(long, default_value_t = 24)]
        hours: u32,
        /// Server port
        #[arg(short = 'p', long, default_value_t = 3030)]
        port: u16,
    },
}

// =============================================================================
// Helpers
// =============================================================================

/// Get or create a persistent machine ID for sync
pub fn get_or_create_machine_id(override_id: Option<String>) -> String {
    if let Some(id) = override_id {
        return id;
    }

    if let Ok(hostname) = hostname::get() {
        let hostname_str = hostname.to_string_lossy();
        format!("{:x}", md5::compute(hostname_str.as_bytes()))
    } else {
        uuid::Uuid::new_v4().to_string()
    }
}
