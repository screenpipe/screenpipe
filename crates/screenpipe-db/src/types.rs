use chrono::{DateTime, Utc};
use oasgen::OaSchema;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use std::error::Error as StdError;
use std::fmt::{self, Display};

/// Data for a single window result to be batch-inserted with its frame.
/// Used by `insert_frames_with_ocr_batch` to reduce write lock contention.
#[derive(Debug, Clone)]
pub struct FrameWindowData {
    pub app_name: Option<String>,
    pub window_name: Option<String>,
    pub browser_url: Option<String>,
    pub focused: bool,
    pub text: String,
    pub text_json: String,
}

#[derive(OaSchema, Debug)]
pub struct DatabaseError(pub String);

impl fmt::Display for DatabaseError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "Database error: {}", self.0)
    }
}

impl StdError for DatabaseError {}

/// Search result variants for different content types.
///
/// Note: `UI` is for accessibility text traversal (ui_monitoring table).
/// `Input` is for user actions like clicks/keystrokes (ui_events table).
#[derive(OaSchema, Debug, Serialize, Deserialize)]
pub enum SearchResult {
    OCR(OCRResult),
    Audio(AudioResult),
    /// Accessibility text traversal (deprecated, use Vision)
    UI(UiContent),
    /// User input actions (clicks, keystrokes, clipboard)
    Input(UiEventRecord),
}

#[derive(FromRow, Debug)]
pub struct Frame {
    pub id: i64,
    pub timestamp: DateTime<Utc>,
    pub browser_url: String,
    pub app_name: String,
    pub window_name: String,
}
#[derive(FromRow, Debug)]
pub struct OCRResultRaw {
    pub frame_id: i64,
    pub ocr_text: String,
    pub text_json: String,
    pub frame_name: String,
    pub timestamp: DateTime<Utc>,
    pub file_path: String,
    pub offset_index: i64,
    pub app_name: String,
    pub ocr_engine: String,
    pub window_name: String,
    pub tags: Option<String>,
    pub browser_url: Option<String>,
    pub focused: Option<bool>,
    pub device_name: String,
}

#[derive(OaSchema, Debug, Serialize, Deserialize)]
pub struct OCRResult {
    pub frame_id: i64,
    pub frame_name: String,
    pub ocr_text: String,
    pub text_json: String,
    pub timestamp: DateTime<Utc>,
    pub file_path: String,
    pub offset_index: i64,
    pub app_name: String,
    pub ocr_engine: String,
    pub window_name: String,
    pub tags: Vec<String>,
    pub browser_url: Option<String>,
    pub focused: Option<bool>,
    pub device_name: String,
}

/// Content type for search queries.
///
/// - `all` - OCR + Audio + Accessibility
/// - `ocr` - Screen text from screenshots
/// - `audio` - Transcribed speech
/// - `input` - User actions (clicks, keystrokes, clipboard)
/// - `accessibility` - Accessibility tree text
#[derive(OaSchema, Debug, Deserialize, PartialEq, Default, Clone)]
#[serde(rename_all = "lowercase")]
pub enum ContentType {
    #[default]
    #[serde(alias = "All")]
    All,
    /// Screen text from screenshots
    OCR,
    /// Audio transcriptions
    Audio,
    /// User input actions: clicks, keystrokes, clipboard, app switches
    Input,
    /// Accessibility tree text
    Accessibility,
}

#[derive(FromRow)]
pub struct AudioResultRaw {
    pub audio_chunk_id: i64,
    pub transcription: String,
    pub timestamp: DateTime<Utc>,
    pub file_path: String,
    pub offset_index: i64,
    pub transcription_engine: String,
    pub tags: Option<String>,
    pub device_name: String,
    pub is_input_device: bool,
    pub speaker_id: Option<i64>,
    pub start_time: Option<f64>,
    pub end_time: Option<f64>,
}

#[derive(OaSchema, Debug, Serialize, Deserialize, FromRow, Clone)]
pub struct Speaker {
    pub id: i64,
    pub name: String,
    pub metadata: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct ActiveSpeaker {
    pub speaker_id: i64,
    pub speaker_name: String,
    pub is_input_device: bool,
    pub transcription_count: i32,
}

#[derive(OaSchema, Clone, Eq, PartialEq, Hash, Serialize, Debug, Deserialize)]
pub enum DeviceType {
    Input,
    Output,
}

#[derive(OaSchema, Debug, Serialize, Deserialize)]
pub struct AudioResult {
    pub audio_chunk_id: i64,
    pub transcription: String,
    pub timestamp: DateTime<Utc>,
    pub file_path: String,
    pub offset_index: i64,
    pub transcription_engine: String,
    pub tags: Vec<String>,
    pub device_name: String,
    pub device_type: DeviceType,
    pub speaker: Option<Speaker>,
    pub start_time: Option<f64>,
    pub end_time: Option<f64>,
}

#[derive(OaSchema, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TagContentType {
    Vision,
    Audio,
}

#[derive(OaSchema, Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct UiContent {
    pub id: i64,
    #[sqlx(rename = "text_output")]
    pub text: String,
    pub timestamp: DateTime<Utc>,
    #[sqlx(rename = "app_name")]
    pub app_name: String,
    #[sqlx(rename = "window_name")]
    pub window_name: String,
    pub initial_traversal_at: Option<DateTime<Utc>>,
    pub file_path: String,
    pub offset_index: i64,
    pub frame_name: Option<String>,
    pub browser_url: Option<String>,
}

#[derive(OaSchema, Debug, Clone)]
pub struct FrameData {
    pub frame_id: i64,
    pub timestamp: DateTime<Utc>,
    pub offset_index: i64,
    pub fps: f64,
    pub ocr_entries: Vec<OCREntry>,
    pub audio_entries: Vec<AudioEntry>,
}

#[derive(OaSchema, Debug, Clone)]
pub struct OCREntry {
    pub text: String,
    pub app_name: String,
    pub window_name: String,
    pub device_name: String,
    pub video_file_path: String,
    pub browser_url: Option<String>,
}

#[derive(OaSchema, Debug, Clone)]
pub struct AudioEntry {
    pub transcription: String,
    pub device_name: String,
    pub is_input: bool,
    pub audio_file_path: String,
    pub duration_secs: f64,
    pub audio_chunk_id: i64,
    pub speaker_id: Option<i64>,
    pub speaker_name: Option<String>,
    /// Offset in seconds from the start of the audio chunk file where this transcription begins
    pub start_time: Option<f64>,
    /// Offset in seconds from the start of the audio chunk file where this transcription ends
    pub end_time: Option<f64>,
}

#[derive(OaSchema, Debug, Clone)]
pub struct TimeSeriesChunk {
    pub frames: Vec<FrameData>,
    pub start_time: DateTime<Utc>,
    pub end_time: DateTime<Utc>,
}

#[derive(OaSchema, Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContentSource {
    Screen,
    Audio,
}

impl Display for ContentSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ContentSource::Screen => write!(f, "screen"),
            ContentSource::Audio => write!(f, "audio"),
        }
    }
}

#[derive(OaSchema, Debug, FromRow)]
pub struct AudioChunk {
    pub id: i64,
    pub file_path: String,
    pub timestamp: DateTime<Utc>,
}

#[derive(OaSchema, Debug, FromRow)]
pub struct AudioChunksResponse {
    pub audio_chunk_id: i64,
    pub start_time: Option<f64>,
    pub end_time: Option<f64>,
    pub file_path: String,
    pub timestamp: DateTime<Utc>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct OcrTextBlock {
    pub block_num: String,
    pub conf: String,
    pub page_num: String,
    pub left: String,
    pub height: String,
    pub level: String,
    pub text: String,
    pub par_num: String,
    pub top: String,
    pub word_num: String,
    pub width: String,
    pub line_num: String,
}

#[derive(OaSchema, Debug, Serialize, Clone)]
pub struct TextPosition {
    pub text: String,
    pub confidence: f32,
    pub bounds: TextBounds,
}

#[derive(OaSchema, Debug, Serialize, Clone)]
pub struct TextBounds {
    pub left: f32,
    pub top: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(OaSchema, Serialize, Clone)]
pub struct SearchMatch {
    pub frame_id: i64,
    pub timestamp: DateTime<Utc>,
    pub text_positions: Vec<TextPosition>,
    pub app_name: String,
    pub window_name: String,
    pub confidence: f32,
    // pub context: Option<String>,
    pub text: String,
    pub url: String,
}

#[derive(OaSchema, Serialize)]
pub struct SearchMatchGroup {
    pub representative: SearchMatch,
    pub group_size: usize,
    pub start_time: String,
    pub end_time: String,
    pub frame_ids: Vec<i64>,
}

#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct FrameRow {
    pub id: i64,
    pub timestamp: DateTime<Utc>,
    pub url: String,
    pub app_name: String,
    pub window_name: String,
    pub ocr_text: String,
    pub text_json: String,
}

/// Lightweight frame row for grouped search — skips text/text_json columns.
#[derive(Debug, FromRow)]
pub struct FrameRowLight {
    pub id: i64,
    pub timestamp: DateTime<Utc>,
    pub url: String,
    pub app_name: String,
    pub window_name: String,
}

#[derive(Deserialize, OaSchema, PartialEq, Default)]
pub enum Order {
    #[serde(rename = "ascending")]
    Ascending,
    #[serde(rename = "descending")]
    #[default]
    Descending,
}

#[derive(OaSchema, Debug, Clone, Serialize, Deserialize)]
pub struct VideoMetadata {
    pub creation_time: DateTime<Utc>,
    pub fps: f64,
    pub duration: f64,
    pub device_name: Option<String>,
    pub name: Option<String>,
}

#[derive(OaSchema, Clone, Eq, PartialEq, Hash, Serialize, Debug, Deserialize)]
pub struct AudioDevice {
    pub name: String,
    pub device_type: DeviceType,
}

#[derive(OaSchema, Clone, Debug, Default, Serialize, Deserialize)]
pub enum OcrEngine {
    Unstructured,
    #[default]
    Tesseract,
    WindowsNative,
    AppleNative,
    Custom(CustomOcrConfig),
}

#[derive(OaSchema, Debug, Clone, Serialize, Deserialize)]
pub struct CustomOcrConfig {
    pub api_url: String,
    pub api_key: String,
    pub timeout_ms: u64,
}

impl Default for CustomOcrConfig {
    fn default() -> Self {
        CustomOcrConfig {
            api_url: "http://localhost:8000/ocr".to_string(),
            api_key: "".to_string(),
            timeout_ms: 5000,
        }
    }
}

// ============================================================================
// UI Events Types (Input Capture Modality)
// ============================================================================

/// Types of UI input events
#[derive(OaSchema, Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum UiEventType {
    Click,
    Move,
    Scroll,
    Key,
    Text,
    AppSwitch,
    WindowFocus,
    Clipboard,
}

impl Display for UiEventType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            UiEventType::Click => write!(f, "click"),
            UiEventType::Move => write!(f, "move"),
            UiEventType::Scroll => write!(f, "scroll"),
            UiEventType::Key => write!(f, "key"),
            UiEventType::Text => write!(f, "text"),
            UiEventType::AppSwitch => write!(f, "app_switch"),
            UiEventType::WindowFocus => write!(f, "window_focus"),
            UiEventType::Clipboard => write!(f, "clipboard"),
        }
    }
}

impl std::str::FromStr for UiEventType {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "click" => Ok(UiEventType::Click),
            "move" => Ok(UiEventType::Move),
            "scroll" => Ok(UiEventType::Scroll),
            "key" => Ok(UiEventType::Key),
            "text" => Ok(UiEventType::Text),
            "app_switch" => Ok(UiEventType::AppSwitch),
            "window_focus" => Ok(UiEventType::WindowFocus),
            "clipboard" => Ok(UiEventType::Clipboard),
            _ => Err(format!("Unknown UI event type: {}", s)),
        }
    }
}

/// Element context from accessibility APIs
#[derive(OaSchema, Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct UiElementContext {
    pub role: Option<String>,
    pub name: Option<String>,
    pub value: Option<String>,
    pub description: Option<String>,
    pub automation_id: Option<String>,
    pub bounds: Option<String>, // JSON: {"x":0,"y":0,"width":100,"height":50}
}

/// A UI input event stored in the database
#[derive(OaSchema, Debug, Clone, Serialize, Deserialize)]
pub struct UiEventRecord {
    pub id: i64,
    pub timestamp: DateTime<Utc>,
    pub session_id: Option<String>,
    pub relative_ms: i64,
    pub event_type: UiEventType,
    // Position
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub delta_x: Option<i16>,
    pub delta_y: Option<i16>,
    // Mouse/key
    pub button: Option<u8>,
    pub click_count: Option<u8>,
    pub key_code: Option<u16>,
    pub modifiers: Option<u8>,
    // Text
    pub text_content: Option<String>,
    pub text_length: Option<i32>,
    // App context
    pub app_name: Option<String>,
    pub app_pid: Option<i32>,
    pub window_title: Option<String>,
    pub browser_url: Option<String>,
    // Element context
    pub element: Option<UiElementContext>,
    // Frame correlation
    pub frame_id: Option<i64>,
}

/// Raw row from ui_events table
#[derive(Debug, FromRow)]
pub struct UiEventRow {
    pub id: i64,
    pub timestamp: DateTime<Utc>,
    pub session_id: Option<String>,
    pub relative_ms: i64,
    pub event_type: String,
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub delta_x: Option<i32>,
    pub delta_y: Option<i32>,
    pub button: Option<i32>,
    pub click_count: Option<i32>,
    pub key_code: Option<i32>,
    pub modifiers: Option<i32>,
    pub text_content: Option<String>,
    pub text_length: Option<i32>,
    pub app_name: Option<String>,
    pub app_pid: Option<i32>,
    pub window_title: Option<String>,
    pub browser_url: Option<String>,
    pub element_role: Option<String>,
    pub element_name: Option<String>,
    pub element_value: Option<String>,
    pub element_description: Option<String>,
    pub element_automation_id: Option<String>,
    pub element_bounds: Option<String>,
    pub frame_id: Option<i64>,
}

impl From<UiEventRow> for UiEventRecord {
    fn from(row: UiEventRow) -> Self {
        let element = if row.element_role.is_some()
            || row.element_name.is_some()
            || row.element_value.is_some()
        {
            Some(UiElementContext {
                role: row.element_role,
                name: row.element_name,
                value: row.element_value,
                description: row.element_description,
                automation_id: row.element_automation_id,
                bounds: row.element_bounds,
            })
        } else {
            None
        };

        UiEventRecord {
            id: row.id,
            timestamp: row.timestamp,
            session_id: row.session_id,
            relative_ms: row.relative_ms,
            event_type: row.event_type.parse().unwrap_or(UiEventType::Click),
            x: row.x,
            y: row.y,
            delta_x: row.delta_x.map(|v| v as i16),
            delta_y: row.delta_y.map(|v| v as i16),
            button: row.button.map(|v| v as u8),
            click_count: row.click_count.map(|v| v as u8),
            key_code: row.key_code.map(|v| v as u16),
            modifiers: row.modifiers.map(|v| v as u8),
            text_content: row.text_content,
            text_length: row.text_length,
            app_name: row.app_name,
            app_pid: row.app_pid,
            window_title: row.window_title,
            browser_url: row.browser_url,
            element,
            frame_id: row.frame_id,
        }
    }
}

/// Parameters for inserting a UI event
#[derive(Debug, Clone)]
pub struct InsertUiEvent {
    pub timestamp: DateTime<Utc>,
    pub session_id: Option<String>,
    pub relative_ms: i64,
    pub event_type: UiEventType,
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub delta_x: Option<i16>,
    pub delta_y: Option<i16>,
    pub button: Option<u8>,
    pub click_count: Option<u8>,
    pub key_code: Option<u16>,
    pub modifiers: Option<u8>,
    pub text_content: Option<String>,
    pub app_name: Option<String>,
    pub app_pid: Option<i32>,
    pub window_title: Option<String>,
    pub browser_url: Option<String>,
    pub element_role: Option<String>,
    pub element_name: Option<String>,
    pub element_value: Option<String>,
    pub element_description: Option<String>,
    pub element_automation_id: Option<String>,
    pub element_bounds: Option<String>,
    pub frame_id: Option<i64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_content_type_deserialization() {
        assert_eq!(ContentType::All, serde_json::from_str(r#""all""#).unwrap());
        assert_eq!(ContentType::OCR, serde_json::from_str(r#""ocr""#).unwrap());
        assert_eq!(
            ContentType::Audio,
            serde_json::from_str(r#""audio""#).unwrap()
        );
        assert_eq!(
            ContentType::Input,
            serde_json::from_str(r#""input""#).unwrap()
        );
        assert_eq!(
            ContentType::Accessibility,
            serde_json::from_str(r#""accessibility""#).unwrap()
        );
    }
}
