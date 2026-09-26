// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterEach, expect, it } from 'bun:test';
import { WorkflowVoiceState } from './workflow-voice';
import type { Env } from '../types';
const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });
function harness() {
 const data = new Map<string, unknown>(); let alarm = 0; let starts = 0; let closes = 0; let failClose = false;
 const storage = { get: async (key: string) => structuredClone(data.get(key)), put: async (key: string, value: unknown) => { data.set(key, structuredClone(value)); }, setAlarm: async (time: number) => { alarm = time; }, deleteAlarm: async () => { alarm = 0; } };
 globalThis.fetch = (async (input: string, init: RequestInit) => {
  expect(input).toStartWith('https://api.openai.com/v1/live/sessions');
  if (input.endsWith('/hangup')) { closes++; return new Response(null, { status: failClose ? 503 : 204 }); }
  starts++; const body = JSON.parse(init.body as string);
  expect(body.session.model).toBe('gpt-live-1'); expect(body.session.store).toBe(false); expect(body.session.tools).toBeUndefined();
  return Response.json({ session: { id: `call-${starts}` }, transport: { type: 'webrtc', sdp: 'v=0\r\nanswer' } });
 }) as typeof fetch;
 const owner = new WorkflowVoiceState(storage as unknown as DurableObjectStorage, { ADMIN_SECRET: 'test', OPENAI_API_KEY: 'test' } as Env);
 const request = (body: unknown, method = 'POST') => owner.fetch(new Request('https://internal/workflow-voice', { method, headers: { 'x-voice-account': 'fixture-owner' }, body: JSON.stringify(body) }));
 const input = { sdp: 'v=0\r\noffer', title: 'Fixture workflow', questions: ['Who reviews it?'] };
 return { owner, request, input, data, get alarm() { return alarm; }, get starts() { return starts; }, get closes() { return closes; }, failClose: () => { failClose = true; } };
}
it('creates only one concurrent call, persists no answers, and rejects stale close tokens', async () => {
 const h = harness();
 const results = await Promise.all([h.request(h.input), h.request(h.input)]);
 expect(results.map(r => r.status)).toEqual([201, 409]); expect(h.starts).toBe(1);
 const call = await results[0].json() as any;
 expect(h.alarm).toBeGreaterThan(Date.now());
 expect(JSON.stringify([...h.data.values()])).not.toContain('Fixture workflow');
 await h.request({ call_token: 'wrong' }, 'DELETE'); expect(h.closes).toBe(0);
 await h.request({ call_token: call.call_token }, 'DELETE'); expect(h.closes).toBe(1); expect(h.alarm).toBe(0);
});
it('enforces the same six-start hourly cap as web and retains quota across reconnects', async () => {
 const h = harness();
 for (let i = 0; i < 6; i++) { const r = await h.request(h.input); const call = await r.json() as any; expect(r.status).toBe(201); await h.request({ call_token: call.call_token }, 'DELETE'); }
 expect((await h.request(h.input)).status).toBe(429); expect(h.starts).toBe(6);
});
it('expires calls even when the client disappears and retries failed cleanup', async () => {
 const h = harness(); await h.request(h.input);
 const record = h.data.get('workflow-voice') as any; record.call.expires = 1;
 h.failClose(); await expect(h.owner.alarm()).rejects.toThrow('cleanup');
 expect(h.alarm).toBeGreaterThan(Date.now()); expect(h.closes).toBe(1);
 expect((h.data.get('workflow-voice') as any).call).toBeDefined();
});
it('rejects oversized and malformed requests before touching the provider', async () => {
 const h = harness();
 expect((await h.request({ ...h.input, title: 'x'.repeat(70000) })).status).toBe(413);
 expect((await h.request({ ...h.input, sdp: 'bad' })).status).toBe(400);
 expect((await h.request({ ...h.input, questions: [null] })).status).toBe(400);
 expect(h.starts).toBe(0);
});
