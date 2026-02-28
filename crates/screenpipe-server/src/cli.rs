use clap::ValueEnum;
use clap::{Parser, Subcommand, ValueHint};
use screenpipe_audio::{
    audio_manager::builder::TranscriptionMode,
    core::engine::AudioTranscriptionEngine as CoreAudioTranscriptionEngine, vad::VadEngineEnum,
};
use screenpipe_core::Language;
use std::path::PathBuf;

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
    #[clap(name = "qwen3-asr")]
    Qwen3Asr,
    /// Disable transcription (audio capture only, no speech-to-text)
    #[clap(name = "disabled")]
    Disabled,
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
            CliAudioTranscriptionEngine::Qwen3Asr => CoreAudioTranscriptionEngine::Qwen3Asr,
            CliAudioTranscriptionEngine::Disabled => CoreAudioTranscriptionEngine::Disabled,
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
pub enum CliTranscriptionMode {
    /// Transcribe immediately as audio is captured (default)
    #[clap(name = "realtime")]
    Realtime,
    /// Accumulate longer audio batches for better transcription quality
    #[clap(name = "batch", alias = "smart")]
    Batch,
}

impl From<CliTranscriptionMode> for TranscriptionMode {
    fn from(cli_mode: CliTranscriptionMode) -> Self {
        match cli_mode {
            CliTranscriptionMode::Realtime => TranscriptionMode::Realtime,
            CliTranscriptionMode::Batch => TranscriptionMode::Batch,
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

    /// Audio transcription scheduling mode: realtime (default) or batch (longer chunks for quality)
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
}

// =============================================================================
// Commands
// =============================================================================

#[derive(Subcommand)]
#[allow(clippy::large_enum_variant)]
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

    /// Audio transcription scheduling mode: realtime (default) or batch (longer chunks for quality)
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
            audio_chunk_duration: cli.audio_chunk_duration,
            port: cli.port,
            disable_audio: cli.disable_audio,
            audio_device: cli.audio_device.clone(),
            use_system_default_audio: cli.use_system_default_audio,
            data_dir: cli.data_dir.clone(),
            debug: cli.debug,
            audio_transcription_engine: cli.audio_transcription_engine.clone(),
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

    /// Convert RecordArgs into a unified RecordingConfig.
    pub fn into_recording_config(
        self,
        data_dir: PathBuf,
    ) -> crate::recording_config::RecordingConfig {
        let languages = self.unique_languages().unwrap_or_default();
        crate::recording_config::RecordingConfig {
            audio_chunk_duration: self.audio_chunk_duration,
            port: self.port,
            data_dir,
            disable_audio: self.disable_audio,
            disable_vision: self.disable_vision,
            use_pii_removal: self.use_pii_removal,
            enable_input_capture: self.enable_input_capture,
            enable_accessibility: self.enable_accessibility,
            audio_transcription_engine: self.audio_transcription_engine.into(),
            transcription_mode: self.transcription_mode.into(),
            audio_devices: self.audio_device,
            use_system_default_audio: self.use_system_default_audio,
            monitor_ids: self.monitor_id.iter().map(|id| id.to_string()).collect(),
            use_all_monitors: self.use_all_monitors,
            ignored_windows: self.ignored_windows,
            included_windows: self.included_windows,
            ignored_urls: self.ignored_urls,
            languages,
            deepgram_api_key: self.deepgram_api_key,
            user_id: None,
            user_name: None,
            video_quality: self.video_quality,
            use_chinese_mirror: false,
            analytics_enabled: !self.disable_telemetry,
            analytics_id: String::new(),
            vocabulary: vec![],
        }
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
    /// Manage AI model presets
    Models {
        #[command(subcommand)]
        subcommand: ModelCommand,
    },
}

#[derive(Subcommand)]
pub enum ModelCommand {
    /// List available AI presets from settings
    List {
        /// Output as JSON
        #[arg(long, default_value_t = false)]
        json: bool,
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
