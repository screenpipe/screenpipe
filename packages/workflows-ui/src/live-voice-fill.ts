// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

/** One inference at a time, coalescing speech while respecting the shared 12/minute budget. */
export class LiveVoiceFill {
  private latest = "";
  private attempted = "";
  private running = false;
  private disposed = false;
  private lastStarted = -Infinity;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private run: (transcript: string) => Promise<unknown>, private pending: (value: boolean) => void) {}

  enqueue(transcript: string, flush = false, retry = false) {
    if (this.disposed || !transcript.trim()) return;
    this.latest = transcript;
    if (retry) this.attempted = "";
    if (this.running) return;
    if (this.latest === this.attempted) return;
    this.pending(true);
    if (this.timer && !flush) return;
    clearTimeout(this.timer);
    // A final flush may use the spare minute-budget slot. Streaming never
    // starts more than ten requests per minute, even during continuous speech.
    const delay = flush ? 0 : Math.max(750, 6000 - (Date.now() - this.lastStarted));
    this.timer = setTimeout(() => void this.drain(), delay);
  }

  private async drain() {
    this.timer = undefined;
    if (this.disposed) return;
    const transcript = this.latest;
    this.attempted = transcript;
    this.running = true;
    this.lastStarted = Date.now();
    try { await this.run(transcript); }
    catch { /* The form exposes the error and an explicit retry; never loop on a failure. */ }
    finally {
      this.running = false;
      if (!this.disposed) {
        if (this.latest !== transcript) this.enqueue(this.latest);
        else this.pending(false);
      }
    }
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
  }
}
