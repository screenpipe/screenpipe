// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterEach, expect, it, vi } from 'vitest';
import { QuestionnaireVoiceSession, type QuestionnaireVoice } from '../../../../packages/workflows-ui/src/questionnaire-voice';
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
function harness() {
 const track = { stop: vi.fn(), onended: null };
 const stream = { getTracks: () => [track] };
 const media = vi.fn(async () => stream);
 vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: media } });
 const channel = { readyState: 'open', onmessage: null as any, onclose: null as any, onerror: null as any, close: vi.fn(), send: vi.fn() };
 const peer = { iceGatheringState: 'complete', addTrack: vi.fn(), close: vi.fn(), createDataChannel: () => channel, createOffer: async () => ({ type: 'offer', sdp: 'v=0' }), setLocalDescription: vi.fn(), setRemoteDescription: vi.fn() };
 vi.stubGlobal('RTCPeerConnection', class { constructor() { return peer; } });
 const adapter: QuestionnaireVoice = { connect: vi.fn(async () => ({ sdp: 'v=0', call_token: 'opaque', expires_at: Date.now()+120000 })), disconnect: vi.fn(async () => {}), fill: vi.fn() };
 const state = vi.fn(), transcript = vi.fn();
 const session = new QuestionnaireVoiceSession(adapter, state, transcript);
 const emit = (event: unknown) => channel.onmessage({ data: JSON.stringify(event) });
 return { session, adapter, media, stream, track, channel, peer, state, transcript, emit };
}
it('waits for Live readiness, deduplicates transcript events, and releases media on stop', async () => {
 const h = harness(); await h.session.start('Fixture', ['Who?']);
 expect(h.state).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'connecting' }));
 h.emit({ type: 'session.started' });
 h.emit({ type: 'session.input_transcript.delta', event_id: 'one', delta: 'The lead.' });
 h.emit({ type: 'session.input_transcript.delta', event_id: 'one', delta: 'The lead.' });
 expect(h.transcript).toHaveBeenCalledTimes(1);
 h.session.stop(); expect(h.track.stop).toHaveBeenCalled(); expect(h.peer.close).toHaveBeenCalled();
 expect(h.adapter.disconnect).toHaveBeenCalledWith('opaque'); expect(h.channel.onmessage).toBeNull();
});
it('stops a microphone that arrives after cancellation without connecting', async () => {
 const h = harness(); let finish!: (value: any) => void;
 h.media.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
 const start = h.session.start('Fixture', []); h.session.stop(); finish(h.stream); await start;
 expect(h.track.stop).toHaveBeenCalled(); expect(h.adapter.connect).not.toHaveBeenCalled();
});
it('hangs up a connection delivered after stop and closes at its server deadline', async () => {
 const h = harness(); let finish!: (value: any) => void;
 (h.adapter.connect as any).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
 const pending = h.session.start('Fixture', []);
 await vi.waitFor(() => expect(h.adapter.connect).toHaveBeenCalled());
 h.session.stop(); finish({ sdp: 'v=0', call_token: 'late', expires_at: Date.now()+1000 }); await pending;
 expect(h.adapter.disconnect).toHaveBeenCalledWith('late');
 vi.useFakeTimers(); await h.session.start('Fixture', []); h.emit({ type: 'session.started' });
 await vi.advanceTimersByTimeAsync(120100);
 expect(h.state).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'stopped' })); expect(h.adapter.disconnect).toHaveBeenCalledWith('opaque');
});
it('reports permission denial without invoking the gateway', async () => {
 const h = harness(); h.media.mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'));
 await h.session.start('Fixture', []);
 expect(h.state).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'error', error: expect.stringContaining('Allow microphone') })); expect(h.adapter.connect).not.toHaveBeenCalled();
});
