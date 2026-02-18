// types.ts — Screenpipe JS SDK types
// Auto-aligned with crates/screenpipe-server/src/server.rs

// ─── Content Types ───────────────────────────────────────────────────────────

/**
 * Types of content that can be queried in Screenpipe.
 *
 * - `ocr` — Screen text from screenshots
 * - `audio` — Transcribed speech
 * - `input` — User actions (clicks, keystrokes, clipboard)
 * - `accessibility` — Accessibility tree text
 * - `all` — OCR + Audio + Accessibility
 */
export type ContentType =
  | "all"
  | "ocr"
  | "audio"
  | "input"
  | "accessibility";

// ─── Search / Query ──────────────────────────────────────────────────────────

/**
 * Parameters for querying Screenpipe via `GET /search`.
 */
export interface SearchParams {
  /** Full-text search query */
  q?: string;
  /** Type of content to search for (default: "all") */
  contentType?: ContentType;
  /** Maximum number of results to return (default: 20) */
  limit?: number;
  /** Number of results to skip for pagination */
  offset?: number;
  /** Filter results after this ISO timestamp */
  startTime?: string;
  /** Filter results before this ISO timestamp */
  endTime?: string;
  /** Filter by application name (e.g. "Chrome", "VSCode") */
  appName?: string;
  /** Filter by window title */
  windowName?: string;
  /** Filter by frame name */
  frameName?: string;
  /** Include base64-encoded screenshot frames in results */
  includeFrames?: boolean;
  /** Filter by minimum text length */
  minLength?: number;
  /** Filter by maximum text length */
  maxLength?: number;
  /** Filter by specific speaker IDs (audio) */
  speakerIds?: number[];
  /** Filter by browser URL (for web content) */
  browserUrl?: string;
  /** Filter by whether the window was focused */
  focused?: boolean;
  /** Filter audio transcriptions by speaker name (case-insensitive partial match) */
  speakerName?: string;
  /** Include cloud-synced data in search results */
  includeCloud?: boolean;
}

// ─── Search Response ─────────────────────────────────────────────────────────

/**
 * Union type for content items returned by search.
 *
 * Note: The server uses `"OCR"` as the tag for vision content
 * and may still return `"UI"` for accessibility-based text.
 */
export type ContentItem =
  | { type: "OCR"; content: VisionContent }
  | { type: "Audio"; content: AudioContent }
  | { type: "UI"; content: UiContent }
  | { type: "Input"; content: InputContent };

/**
 * @deprecated UI content (accessibility-based text). Use vision content type instead.
 */
export interface UiContent {
  id: number;
  text: string;
  timestamp: string;
  appName: string;
  windowName: string;
  initialTraversalAt?: string;
  filePath: string;
  offsetIndex: number;
  frameName?: string;
  browserUrl?: string;
}

/**
 * Vision content (OCR / screen capture).
 * Note: The server still returns `type: "OCR"` for backwards compat.
 */
export interface VisionContent {
  frameId: number;
  text: string;
  timestamp: string;
  filePath: string;
  offsetIndex: number;
  appName: string;
  windowName: string;
  tags: string[];
  frame?: string;
  frameName?: string;
  browserUrl?: string;
  focused?: boolean;
  deviceName: string;
}

/**
 * Audio transcription content.
 */
export interface AudioContent {
  chunkId: number;
  transcription: string;
  timestamp: string;
  filePath: string;
  offsetIndex: number;
  tags: string[];
  deviceName: string;
  deviceType: "Input" | "Output";
  speaker?: Speaker;
  startTime?: number;
  endTime?: number;
}

/**
 * User input event content (clicks, keystrokes, clipboard, etc.).
 */
export interface InputContent {
  id: number;
  timestamp: string;
  eventType: string;
  appName?: string;
  windowTitle?: string;
  browserUrl?: string;
  /** Text content for text/clipboard events */
  textContent?: string;
  /** X position for mouse events */
  x?: number;
  /** Y position for mouse events */
  y?: number;
  /** Key code for keyboard events */
  keyCode?: number;
  /** Modifier keys bitmask (shift, ctrl, alt, etc.) */
  modifiers?: number;
  /** Element role from accessibility APIs */
  elementRole?: string;
  /** Element name from accessibility APIs */
  elementName?: string;
}

/**
 * Speaker information.
 */
export interface Speaker {
  id: number;
  name: string;
  metadata: string;
}

/**
 * Pagination information.
 */
export interface PaginationInfo {
  limit: number;
  offset: number;
  total: number;
}

/** Cloud sync status */
export type CloudStatus =
  | "Available"
  | "Disabled"
  | "NotInitialized"
  | "Error";

/** Metadata about cloud search availability */
export interface CloudSearchMetadata {
  cloudSearchAvailable: boolean;
  cloudHasRelevantData: boolean;
  cloudQueryHint?: string;
  status: CloudStatus;
}

/**
 * Response from `GET /search`.
 */
export interface SearchResponse {
  data: ContentItem[];
  pagination: PaginationInfo;
  /** Present only when cloud sync is available */
  cloud?: CloudSearchMetadata;
}

// ─── Keyword Search ──────────────────────────────────────────────────────────

/** Parameters for `GET /search/keyword` */
export interface KeywordSearchParams {
  query: string;
  limit?: number;
  offset?: number;
  startTime?: string;
  endTime?: string;
  /** Enable fuzzy matching */
  fuzzyMatch?: boolean;
  /** Result order: "ascending" or "descending" (default) */
  order?: "ascending" | "descending";
  /** Filter by app names (comma-separated) */
  appNames?: string[];
}

/** Text bounding box */
export interface TextBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Text position with bounding box */
export interface TextPosition {
  text: string;
  confidence: number;
  bounds: TextBounds;
}

/** A single match from keyword search */
export interface SearchMatch {
  frameId: number;
  timestamp: string;
  textPositions: TextPosition[];
  appName: string;
  windowName: string;
  confidence: number;
  text: string;
  url: string;
}

// ─── Frames ──────────────────────────────────────────────────────────────────

/** Parameters for getting a frame */
export interface GetFrameParams {
  /** If true, redact detected PII (credit cards, SSNs, emails) */
  redactPii?: boolean;
}

/** Parameters for getting the next valid frame */
export interface NextValidFrameParams {
  frameId: number;
  /** "forward" (default) or "backward" */
  direction?: "forward" | "backward";
  /** Max frames to check (default: 50) */
  limit?: number;
}

/** Response from next-valid-frame endpoint */
export interface NextValidFrameResponse {
  frameId: number;
  timestamp: string;
  skippedCount: number;
}

/** Response from `GET /frames/:frame_id/ocr` */
export interface FrameOcrResponse {
  frameId: number;
  textPositions: TextPosition[];
}

// ─── Health ──────────────────────────────────────────────────────────────────

/** Response from `GET /health` */
export interface HealthCheckResponse {
  status: string;
  statusCode: number;
  lastFrameTimestamp?: string;
  lastAudioTimestamp?: string;
  frameStatus: string;
  audioStatus: string;
  message: string;
  verboseInstructions?: string;
  deviceStatusDetails?: string;
}

// ─── Devices ─────────────────────────────────────────────────────────────────

/** Audio device from `GET /audio/list` */
export interface AudioDevice {
  name: string;
  isDefault: boolean;
}

/** Monitor from `GET /vision/list` */
export interface MonitorInfo {
  id: number;
  name: string;
  width: number;
  height: number;
  isDefault: boolean;
}

// ─── Tags ────────────────────────────────────────────────────────────────────

/** Content type for tag operations */
export type TagContentType = "vision" | "audio";

// ─── Speakers ────────────────────────────────────────────────────────────────

/** Parameters for `POST /speakers/update` */
export interface UpdateSpeakerParams {
  id: number;
  name?: string;
  metadata?: string;
}

/** Parameters for `GET /speakers/unnamed` */
export interface GetUnnamedSpeakersParams {
  limit: number;
  offset: number;
  speakerIds?: number[];
}

/** Parameters for `POST /speakers/reassign` */
export interface ReassignSpeakerParams {
  audioChunkId: number;
  newSpeakerName: string;
  /** Whether to propagate to similar transcriptions (default: true) */
  propagateSimilar?: boolean;
}

/** Response from `POST /speakers/reassign` */
export interface ReassignSpeakerResponse {
  newSpeakerId: number;
  newSpeakerName: string;
  transcriptionsUpdated: number;
  embeddingsMoved: number;
}

/** Parameters for `POST /speakers/merge` */
export interface MergeSpeakersParams {
  speakerToKeepId: number;
  speakerToMergeId: number;
}

/** Parameters for `GET /speakers/similar` */
export interface GetSimilarSpeakersParams {
  speakerId: number;
  limit: number;
}

// ─── UI Events (Input Events) ────────────────────────────────────────────────

/** UI event types */
export type UiEventType =
  | "click"
  | "move"
  | "scroll"
  | "key"
  | "text"
  | "app_switch"
  | "window_focus"
  | "clipboard";

/** Element context from accessibility APIs */
export interface UiElementContext {
  role?: string;
  name?: string;
  value?: string;
  description?: string;
  automationId?: string;
  bounds?: string;
}

/** A UI event record */
export interface UiEventRecord {
  id: number;
  timestamp: string;
  sessionId?: string;
  relativeMs: number;
  eventType: UiEventType;
  x?: number;
  y?: number;
  deltaX?: number;
  deltaY?: number;
  button?: number;
  clickCount?: number;
  keyCode?: number;
  modifiers?: number;
  textContent?: string;
  textLength?: number;
  appName?: string;
  appPid?: number;
  windowTitle?: string;
  browserUrl?: string;
  element?: UiElementContext;
  frameId?: number;
}


// ─── Streaming / WebSocket ───────────────────────────────────────────────────

export interface TranscriptionChunk {
  transcription: string;
  timestamp: string;
  device: string;
  is_input: boolean;
  is_final: boolean;
  speaker?: string;
}

export interface TranscriptionStreamResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    text: string;
    index: number;
    finish_reason: string | null;
  }>;
  metadata?: {
    timestamp: string;
    device: string;
    isInput: boolean;
    speaker?: string;
  };
}

export interface VisionEvent {
  image?: string;
  text: string;
  timestamp: string;
  app_name?: string;
  window_name?: string;
  browser_url?: string;
}

export interface VisionStreamResponse {
  type: string;
  data: VisionEvent;
}

export interface EventStreamResponse {
  name: string;
  data: VisionEvent | TranscriptionChunk | unknown;
}

// ─── Notifications (via Tauri sidecar at :11435) ─────────────────────────────

export interface NotificationOptions {
  title: string;
  body: string;
  actions?: NotificationAction[];
  timeout?: number;
  persistent?: boolean;
}

export interface NotificationAction {
  id: string;
  label: string;
}

// ─── Add Content ─────────────────────────────────────────────────────────────

export interface AddContentRequest {
  deviceName: string;
  content: AddContentData;
}

export interface AddContentData {
  contentType: string;
  data: FrameContent[] | AudioTranscription;
}

export interface FrameContent {
  filePath: string;
  timestamp?: string;
  appName?: string;
  windowName?: string;
  ocrResults?: { text: string; textJson?: string; ocrEngine?: string; focused?: boolean }[];
  tags?: string[];
}

export interface AudioTranscription {
  transcription: string;
  transcriptionEngine: string;
}

// ─── Raw SQL ─────────────────────────────────────────────────────────────────

export interface RawSqlRequest {
  query: string;
}
