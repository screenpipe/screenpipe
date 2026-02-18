// client.ts — Core Screenpipe API client
// Works in both Node.js and browser environments (uses fetch + WebSocket)

import type {
  SearchParams,
  SearchResponse,
  KeywordSearchParams,
  SearchMatch,
  HealthCheckResponse,
  AudioDevice,
  MonitorInfo,
  TagContentType,
  Speaker,
  UpdateSpeakerParams,
  GetUnnamedSpeakersParams,
  ReassignSpeakerParams,
  ReassignSpeakerResponse,
  MergeSpeakersParams,
  GetSimilarSpeakersParams,
  GetFrameParams,
  NextValidFrameParams,
  NextValidFrameResponse,
  FrameOcrResponse,
  NotificationOptions,
  AddContentRequest,
  RawSqlRequest,
  EventStreamResponse,
  TranscriptionChunk,
  TranscriptionStreamResponse,
  VisionEvent,
  VisionStreamResponse,
} from "./types";
import { toSnakeCase, convertObjectToCamelCase } from "./utils";

// ─── Config ──────────────────────────────────────────────────────────────────

export interface ScreenpipeClientConfig {
  /** Base URL for the screenpipe server (default: http://localhost:3030) */
  baseUrl?: string;
  /** Base URL for the Tauri sidecar (notifications, etc.) (default: http://localhost:11435) */
  notificationUrl?: string;
}

const DEFAULT_BASE_URL = "http://localhost:3030";
const DEFAULT_NOTIFICATION_URL = "http://localhost:11435";

// ─── Helper: coerce object to Record ─────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toRecord(obj: any): Record<string, unknown> {
  return obj as Record<string, unknown>;
}

// ─── Helper: build query string from params object ───────────────────────────

function buildQueryString(params: Record<string, unknown>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    const snakeKey = toSnakeCase(key);
    if (Array.isArray(value)) {
      if (value.length > 0) {
        qs.append(snakeKey, value.join(","));
      }
    } else {
      qs.append(snakeKey, String(value));
    }
  }
  return qs.toString();
}

// ─── Client ──────────────────────────────────────────────────────────────────

export class ScreenpipeClient {
  private baseUrl: string;
  private notificationUrl: string;

  constructor(config?: ScreenpipeClientConfig) {
    this.baseUrl = (config?.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.notificationUrl = (
      config?.notificationUrl ?? DEFAULT_NOTIFICATION_URL
    ).replace(/\/+$/, "");
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  private async get<T>(path: string, query?: Record<string, unknown>): Promise<T> {
    const qs = query ? buildQueryString(query) : "";
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ""}`;
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`GET ${path} failed (${res.status}): ${body}`);
    }
    return res.json();
  }

  private async post<T>(path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`POST ${path} failed (${res.status}): ${text}`);
    }
    return res.json();
  }

  private async del<T>(path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`DELETE ${path} failed (${res.status}): ${text}`);
    }
    return res.json();
  }

  private async getRaw(path: string, query?: Record<string, unknown>): Promise<Response> {
    const qs = query ? buildQueryString(query) : "";
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ""}`;
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`GET ${path} failed (${res.status}): ${body}`);
    }
    return res;
  }

  // ── Search ───────────────────────────────────────────────────────────────

  /**
   * Full-text search across vision, audio, and input data.
   * `GET /search`
   */
  async search(params: SearchParams = {}): Promise<SearchResponse> {
    const raw = await this.get<unknown>("/search", toRecord(params));
    return convertObjectToCamelCase(raw) as SearchResponse;
  }

  /**
   * Keyword search with text positions and bounding boxes.
   * `GET /search/keyword`
   */
  async keywordSearch(params: KeywordSearchParams): Promise<SearchMatch[]> {
    const raw = await this.get<unknown>("/search/keyword", toRecord(params));
    return convertObjectToCamelCase(raw) as SearchMatch[];
  }

  // ── Health ───────────────────────────────────────────────────────────────

  /**
   * Health check.
   * `GET /health`
   */
  async health(): Promise<HealthCheckResponse> {
    const raw = await this.get<unknown>("/health");
    return convertObjectToCamelCase(raw) as HealthCheckResponse;
  }

  // ── Frames ───────────────────────────────────────────────────────────────

  /**
   * Get a frame image by ID. Returns raw Response (image bytes).
   * `GET /frames/:frame_id`
   */
  async getFrame(frameId: number, params?: GetFrameParams): Promise<Response> {
    return this.getRaw(`/frames/${frameId}`, params ? toRecord(params) : undefined);
  }

  /**
   * Get the URL for a frame image (useful for <img src="">).
   */
  getFrameUrl(frameId: number, params?: GetFrameParams): string {
    const qs = params ? buildQueryString(toRecord(params)) : "";
    return `${this.baseUrl}/frames/${frameId}${qs ? `?${qs}` : ""}`;
  }

  /**
   * Get OCR text positions with bounding boxes for a frame.
   * `GET /frames/:frame_id/ocr`
   */
  async getFrameOcr(frameId: number): Promise<FrameOcrResponse> {
    const raw = await this.get<unknown>(`/frames/${frameId}/ocr`);
    return convertObjectToCamelCase(raw) as FrameOcrResponse;
  }

  /**
   * Find the next valid frame (with existing video file).
   * `GET /frames/next-valid`
   */
  async getNextValidFrame(params: NextValidFrameParams): Promise<NextValidFrameResponse> {
    const raw = await this.get<unknown>("/frames/next-valid", toRecord(params));
    return convertObjectToCamelCase(raw) as NextValidFrameResponse;
  }

  // ── Devices ──────────────────────────────────────────────────────────────

  /**
   * List audio devices.
   * `GET /audio/list`
   */
  async listAudioDevices(): Promise<AudioDevice[]> {
    const raw = await this.get<unknown>("/audio/list");
    return convertObjectToCamelCase(raw) as AudioDevice[];
  }

  /**
   * List monitors.
   * `GET /vision/list`
   */
  async listMonitors(): Promise<MonitorInfo[]> {
    const raw = await this.get<unknown>("/vision/list");
    return convertObjectToCamelCase(raw) as MonitorInfo[];
  }

  /**
   * Get vision capture status.
   * `GET /vision/status`
   */
  async visionStatus(): Promise<unknown> {
    return this.get<unknown>("/vision/status");
  }

  // ── Tags ─────────────────────────────────────────────────────────────────

  /**
   * Add tags to a content item.
   * `POST /tags/:content_type/:id`
   */
  async addTags(
    contentType: TagContentType,
    id: number,
    tags: string[]
  ): Promise<{ success: boolean }> {
    return this.post(`/tags/${contentType}/${id}`, { tags });
  }

  /**
   * Remove tags from a content item.
   * `DELETE /tags/:content_type/:id`
   */
  async removeTags(
    contentType: TagContentType,
    id: number,
    tags: string[]
  ): Promise<{ success: boolean }> {
    return this.del(`/tags/${contentType}/${id}`, { tags });
  }

  // ── Speakers ─────────────────────────────────────────────────────────────

  readonly speakers = {
    /**
     * Search speakers by name.
     * `GET /speakers/search`
     */
    search: async (name?: string): Promise<Speaker[]> => {
      const raw = await this.get<unknown>("/speakers/search", { name });
      return convertObjectToCamelCase(raw) as Speaker[];
    },

    /**
     * Get unnamed speakers.
     * `GET /speakers/unnamed`
     */
    unnamed: async (params: GetUnnamedSpeakersParams): Promise<Speaker[]> => {
      const raw = await this.get<unknown>("/speakers/unnamed", toRecord(params));
      return convertObjectToCamelCase(raw) as Speaker[];
    },

    /**
     * Update a speaker's name or metadata.
     * `POST /speakers/update`
     */
    update: async (params: UpdateSpeakerParams): Promise<{ success: boolean }> => {
      return this.post("/speakers/update", {
        id: params.id,
        name: params.name,
        metadata: params.metadata,
      });
    },

    /**
     * Delete a speaker.
     * `POST /speakers/delete`
     */
    delete: async (id: number): Promise<{ success: boolean }> => {
      return this.post("/speakers/delete", { id });
    },

    /**
     * Mark a speaker as hallucination.
     * `POST /speakers/hallucination`
     */
    markHallucination: async (speakerId: number): Promise<{ success: boolean }> => {
      return this.post("/speakers/hallucination", { speaker_id: speakerId });
    },

    /**
     * Merge two speakers into one.
     * `POST /speakers/merge`
     */
    merge: async (params: MergeSpeakersParams): Promise<{ success: boolean }> => {
      return this.post("/speakers/merge", {
        speaker_to_keep_id: params.speakerToKeepId,
        speaker_to_merge_id: params.speakerToMergeId,
      });
    },

    /**
     * Get speakers similar to a given speaker.
     * `GET /speakers/similar`
     */
    similar: async (params: GetSimilarSpeakersParams): Promise<Speaker[]> => {
      const raw = await this.get<unknown>("/speakers/similar", toRecord(params));
      return convertObjectToCamelCase(raw) as Speaker[];
    },

    /**
     * Reassign a speaker on a specific audio chunk.
     * `POST /speakers/reassign`
     */
    reassign: async (params: ReassignSpeakerParams): Promise<ReassignSpeakerResponse> => {
      const raw = await this.post<unknown>("/speakers/reassign", {
        audio_chunk_id: params.audioChunkId,
        new_speaker_name: params.newSpeakerName,
        propagate_similar: params.propagateSimilar ?? true,
      });
      return convertObjectToCamelCase(raw) as ReassignSpeakerResponse;
    },
  };

  // ── Audio Control ────────────────────────────────────────────────────────

  /**
   * Start an audio device.
   * `POST /audio/start`
   */
  async startAudio(
    deviceName: string,
    deviceType: "Input" | "Output"
  ): Promise<{ success: boolean; message: string }> {
    return this.post("/audio/start", {
      device_name: deviceName,
      device_type: deviceType,
    });
  }

  /**
   * Stop an audio device.
   * `POST /audio/stop`
   */
  async stopAudio(
    deviceName: string,
    deviceType: "Input" | "Output"
  ): Promise<{ success: boolean; message: string }> {
    return this.post("/audio/stop", {
      device_name: deviceName,
      device_type: deviceType,
    });
  }

  // ── Notifications (Tauri sidecar) ────────────────────────────────────────

  /**
   * Send a desktop notification via the Tauri sidecar.
   */
  async sendNotification(options: NotificationOptions): Promise<boolean> {
    try {
      const res = await fetch(`${this.notificationUrl}/notify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(options),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // ── Raw SQL ──────────────────────────────────────────────────────────────

  /**
   * Execute a raw SQL query against the screenpipe database.
   * `POST /raw_sql`
   */
  async rawSql(query: string): Promise<unknown> {
    return this.post("/raw_sql", { query } as RawSqlRequest);
  }

  // ── Add Content ──────────────────────────────────────────────────────────

  /**
   * Add content (frames or transcription) to the database.
   * `POST /add`
   */
  async addContent(request: AddContentRequest): Promise<unknown> {
    return this.post("/add", {
      device_name: request.deviceName,
      content: {
        content_type: request.content.contentType,
        data: request.content.data,
      },
    });
  }

  // ── WebSocket Streaming ──────────────────────────────────────────────────

  /**
   * Stream all events (transcriptions + vision) via WebSocket.
   * Returns an async generator that yields events.
   */
  async *streamEvents(
    includeImages: boolean = false
  ): AsyncGenerator<EventStreamResponse, void, unknown> {
    const wsUrl = this.baseUrl.replace(/^http/, "ws");
    const ws = new WebSocket(
      `${wsUrl}/ws/events?images=${includeImages}`
    );

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", (e) => reject(e), { once: true });
    });

    const messageQueue: MessageEvent[] = [];
    let resolveMessage: ((value: MessageEvent) => void) | null = null;

    const messageHandler = (ev: MessageEvent) => {
      if (resolveMessage) {
        resolveMessage(ev);
        resolveMessage = null;
      } else {
        messageQueue.push(ev);
      }
    };

    ws.addEventListener("message", messageHandler);

    try {
      while (ws.readyState === WebSocket.OPEN) {
        const message = await new Promise<MessageEvent>((resolve) => {
          if (messageQueue.length > 0) {
            resolve(messageQueue.shift()!);
          } else {
            resolveMessage = resolve;
          }
        });
        yield JSON.parse(message.data);
      }
    } finally {
      ws.removeEventListener("message", messageHandler);
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }
  }

  /**
   * Stream only transcription events.
   */
  async *streamTranscriptions(): AsyncGenerator<
    TranscriptionStreamResponse,
    void,
    unknown
  > {
    for await (const event of this.streamEvents(false)) {
      if (event.name === "transcription") {
        const chunk = event.data as TranscriptionChunk;
        yield {
          id: crypto.randomUUID(),
          object: "text_completion_chunk",
          created: Date.now(),
          model: "screenpipe-realtime",
          choices: [
            {
              text: chunk.transcription,
              index: 0,
              finish_reason: chunk.is_final ? "stop" : null,
            },
          ],
          metadata: {
            timestamp: chunk.timestamp,
            device: chunk.device,
            isInput: chunk.is_input,
            speaker: chunk.speaker,
          },
        };
      }
    }
  }

  /**
   * Stream only vision events.
   */
  async *streamVision(
    includeImages: boolean = false
  ): AsyncGenerator<VisionStreamResponse, void, unknown> {
    for await (const event of this.streamEvents(includeImages)) {
      if (event.name === "ocr_result" || event.name === "ui_frame") {
        yield {
          type: event.name,
          data: event.data as VisionEvent,
        };
      }
    }
  }
}
