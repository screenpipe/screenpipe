// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

export type VoiceState = { status: "idle" | "connecting" | "listening" | "stopped" | "error"; remaining: number; level?: number; error?: string };
export type VoiceConnection = { sdp: string; call_token: string; expires_at: number };
export type AnswerPatch = { question: string; answer: string; quote: string };
export interface QuestionnaireVoice {
  connect(input: { sdp: string; title: string; questions: string[] }, signal: AbortSignal): Promise<VoiceConnection>;
  disconnect(token: string): Promise<void>;
  fill(input: { questions: string[]; transcript: string; locked: string[] }, signal: AbortSignal): Promise<AnswerPatch[]>;
}

/** Browser media lifecycle; credentials and inference remain in the host adapter. */
export class QuestionnaireVoiceSession {
  private generation = 0;
  private peer?: RTCPeerConnection;
  private stream?: MediaStream;
  private channel?: RTCDataChannel;
  private token?: string;
  private timer?: ReturnType<typeof setInterval>;
  private timeout?: ReturnType<typeof setTimeout>;
  private request?: AbortController;
  private audio?: AudioContext;
  private transcript = "";
  private events = new Set<string>();
  private state: VoiceState = { status: "idle", remaining: 120 };
  constructor(private adapter: QuestionnaireVoice, private onState: (state: VoiceState) => void, private onTranscript: (text: string) => void) {}
  private publish(patch: Partial<VoiceState>) { this.state = { ...this.state, ...patch }; this.onState(this.state); }
  private fail(message: string) { this.stop(); this.publish({ status: "error", error: message }); }
  private hide = () => this.stop();
  async start(title: string, questions: string[]) {
    this.stop(); this.transcript = ""; this.events.clear();
    const generation = this.generation;
    const current = () => generation === this.generation;
    const request = new AbortController(); this.request = request;
    this.publish({ status: "connecting", error: undefined, remaining: 120 });
    window.addEventListener("pagehide", this.hide);
    this.timeout = setTimeout(() => this.fail("Voice could not connect. Please try again."), 25000);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      if (!current()) { stream.getTracks().forEach(t => t.stop()); return; }
      this.stream = stream;
      const peer = new RTCPeerConnection(); this.peer = peer;
      stream.getTracks().forEach(track => { track.onended = () => { if (current()) this.fail("Microphone access ended. Your answers are kept."); }; peer.addTrack(track, stream); });
      // Silent input-only session. No autoplay output or hidden spoken replies.
      peer.onconnectionstatechange = () => { if (current() && ["failed", "disconnected"].includes(peer.connectionState)) this.fail("Voice disconnected. Your words are kept below."); };
      const channel = peer.createDataChannel("oai-events"); this.channel = channel;
      channel.onerror = channel.onclose = () => { if (current()) this.fail("Voice disconnected. Your words are kept below."); };
      channel.onmessage = event => {
        if (!current() || typeof event.data !== "string" || event.data.length > 100000) return;
        let message: any; try { message = JSON.parse(event.data); } catch { return; }
        if (!message || typeof message !== "object") return;
        if (typeof message.event_id === "string") { if (this.events.has(message.event_id)) return; this.events.add(message.event_id); if (this.events.size > 1000) this.events.delete(this.events.values().next().value!); }
        if (message.type === "session.started") { clearTimeout(this.timeout); this.publish({ status: "listening" }); }
        if (message.type === "error") this.fail("Voice was interrupted. Your words are kept below.");
        if (message.type === "session.input_transcript.delta" && typeof message.delta === "string" && this.state.status === "listening") {
          if (this.transcript.length + message.delta.length > 24000) { this.fail("Recording stopped at the transcript limit. Review your answers below."); return; }
          this.transcript += message.delta; this.onTranscript(this.transcript);
        }
      };
      const offer = await peer.createOffer(); if (!current()) return;
      await peer.setLocalDescription(offer); if (!current()) return;
      if (peer.iceGatheringState !== "complete") await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); peer.removeEventListener("icegatheringstatechange", check); request.signal.removeEventListener("abort", done); resolve(); };
        const check = () => { if (peer.iceGatheringState === "complete") done(); };
        const timer = setTimeout(done, 1500); peer.addEventListener("icegatheringstatechange", check); request.signal.addEventListener("abort", done, { once: true });
      });
      if (!current()) return;
      const connection = await this.adapter.connect({ sdp: peer.localDescription?.sdp || offer.sdp || "", title, questions }, request.signal);
      if (!current()) { void this.adapter.disconnect(connection.call_token).catch(() => {}); return; }
      this.token = connection.call_token;
      if (!connection.sdp?.startsWith("v=0") || !connection.call_token || !Number.isFinite(connection.expires_at)) throw new Error("Voice returned an invalid connection. Please retry.");
      const expires = Math.min(connection.expires_at, Date.now() + 120000);
      let analyser: AnalyserNode | undefined; let samples: Uint8Array<ArrayBuffer> | undefined;
      try { const audio = new AudioContext(); this.audio = audio; analyser = audio.createAnalyser(); analyser.fftSize = 256; audio.createMediaStreamSource(stream).connect(analyser); samples = new Uint8Array(analyser.fftSize); void audio.resume().catch(() => {}); } catch { /* Meter unavailable: recording remains usable. */ }
      this.timer = setInterval(() => {
        if (!current()) return;
        const remaining = Math.max(0, Math.ceil((expires - Date.now()) / 1000));
        let level: number | undefined;
        if (analyser && samples) { analyser.getByteTimeDomainData(samples); level = Math.min(1, Math.sqrt(samples.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / samples.length) * 5); }
        this.publish({ remaining, level }); if (!remaining) this.stop();
      }, 150);
      await peer.setRemoteDescription({ type: "answer", sdp: connection.sdp });
    } catch (error) { if (current()) this.fail(error instanceof DOMException && error.name === "NotAllowedError" ? "Allow microphone access to answer with voice. You can still type." : error instanceof Error ? error.message : "Voice could not connect. You can still type."); }
  }
  stop() {
    this.generation++;
    clearTimeout(this.timeout); clearInterval(this.timer);
    window.removeEventListener("pagehide", this.hide);
    if (this.channel) { if (this.channel.readyState === "open") { try { this.channel.send(JSON.stringify({ type: "session.close" })); } catch {} } this.channel.onmessage = this.channel.onclose = this.channel.onerror = null; this.channel.close(); this.channel = undefined; }
    if (this.peer) { this.peer.onconnectionstatechange = null; this.peer.close(); this.peer = undefined; }
    this.stream?.getTracks().forEach(t => { t.onended = null; t.stop(); }); this.stream = undefined;
    if (this.audio) { void this.audio.close().catch(() => {}); this.audio = undefined; }
    this.request?.abort(); this.request = undefined;
    if (this.token) { void this.adapter.disconnect(this.token).catch(() => {}); this.token = undefined; }
    this.publish({ status: "stopped", level: undefined });
  }
}

/** Treat model output as untrusted: allow known unlocked fields and quoted speech only. */
export function parseVoiceAnswers(raw: string, questions: string[], transcript: string, locked: string[]): AnswerPatch[] {
  const result = JSON.parse(raw.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""));
  if (!Array.isArray(result.answers)) throw new Error("Could not fill answers. Your words are kept; try again.");
  const seen = new Set<string>();
  return result.answers.filter((p: any) => {
    if (!p || typeof p.question !== "string" || !questions.includes(p.question) || locked.includes(p.question) || seen.has(p.question) || typeof p.answer !== "string" || !p.answer.trim() || p.answer.length > 4000 || typeof p.quote !== "string" || !p.quote.trim() || !transcript.includes(p.quote)) return false;
    seen.add(p.question); return true;
  });
}
