// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

export interface NarrationChunk {
  id: string;
  recordingId?: string;
  streamId: string;
  sequence: number;
  start: number;
  end: number;
  audio: Blob;
}
interface Capture {
  stream: MediaStream;
  recorder: MediaRecorder;
  stopped: Promise<void>;
  end?: number;
}

/** A focused microphone lifetime, independent of the background audio recorder.
 * Pause closes tracks instead of merely pausing MediaRecorder with a hot mic.
 * The host persists chunks by id, so retrying a lost save response is safe.
 */
export class FocusedNarration {
  private generation = 0;
  private opening?: Promise<void>;
  private capture?: Capture;
  private closing?: Promise<void>;
  private writing?: Promise<void>;
  private pending: NarrationChunk[] = [];
  constructor(
    private save: (chunk: NarrationChunk) => Promise<void>,
    private publish: (state: { hot: boolean; error?: string }) => void,
  ) {}

  start(recordingId?: string, valid?: () => boolean): Promise<void> {
    if (this.capture) return Promise.resolve();
    if (this.opening) return this.opening;
    const generation = ++this.generation;
    const opening = this.open(generation, recordingId, valid);
    this.opening = opening;
    void opening.finally(() => {
      if (this.opening === opening) this.opening = undefined;
    }).catch(() => {});
    return opening;
  }

  private async open(generation: number, recordingId?: string, valid?: () => boolean) {
    await this.closing;
    await this.flush();
    if (generation !== this.generation) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined")
      throw new Error("Microphone recording is unavailable on this device.");
    let stream: MediaStream | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (generation !== this.generation) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      if (valid && !valid()) throw new Error("Capture is paused. Resume before turning Voice on.");
      const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find(
        type => MediaRecorder.isTypeSupported(type),
      );
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const streamId = crypto.randomUUID();
      let sequence = 0;
      let start = Date.now();
      let finish!: () => void;
      const stopped = new Promise<void>(resolve => { finish = resolve; });
      const capture: Capture = { stream, recorder, stopped };
      recorder.ondataavailable = event => {
        const until = capture.end ?? Date.now();
        if (event.data.size > 0) {
          this.pending.push({
            id: crypto.randomUUID(), recordingId, streamId, sequence: sequence++, start,
            end: Math.max(start, until), audio: event.data,
          });
          start = until;
        }
        void this.flush().catch(error => {
          void this.stop().catch(() => {});
          this.publish({ hot: false, error: error instanceof Error ? error.message : "Could not save voice. Retry saving before continuing." });
        });
      };
      recorder.onstop = finish;
      recorder.onerror = () => {
        void this.stop().catch(() => {});
        this.publish({ hot: false, error: "Voice recording stopped unexpectedly. Your captured audio is kept." });
      };
      stream.getTracks().forEach(track => {
        track.onended = () => {
          void this.stop().catch(() => {});
          this.publish({ hot: false, error: "Microphone disconnected. Your captured audio is kept." });
        };
      });
      this.capture = capture;
      recorder.start(5000);
      this.publish({ hot: true });
    } catch (error) {
      stream?.getTracks().forEach(track => track.stop());
      if (generation !== this.generation) return;
      this.capture = undefined;
      this.publish({ hot: false });
      if (error instanceof DOMException && error.name === "NotAllowedError")
        throw new Error("Allow microphone access to turn Voice on. Screen recording can continue.");
      throw error;
    }
  }

  stop(at = Date.now()): Promise<void> {
    ++this.generation;
    this.opening = undefined;
    const capture = this.capture;
    this.capture = undefined;
    // Release the microphone before awaiting the recorder's last chunk or disk.
    if (capture) capture.end = at;
    capture?.stream.getTracks().forEach(track => { track.onended = null; track.stop(); });
    this.publish({ hot: false });
    if (capture) {
      if (capture.recorder.state !== "inactive") capture.recorder.stop();
      const closing = capture.stopped.then(() => this.flush());
      this.closing = closing;
      void closing.finally(() => {
        if (this.closing === closing) this.closing = undefined;
      }).catch(() => {});
    }
    return this.closing ?? this.flush();
  }

  flush(): Promise<void> {
    if (this.writing) return this.writing;
    const writing = (async () => {
      while (this.pending.length) {
        await this.save(this.pending[0]);
        this.pending.shift();
      }
    })();
    this.writing = writing;
    void writing.finally(() => {
      if (this.writing === writing) this.writing = undefined;
    }).catch(() => {});
    return writing;
  }
}
