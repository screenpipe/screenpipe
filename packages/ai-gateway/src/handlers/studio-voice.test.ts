// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterEach, describe, expect, test } from 'bun:test';
import { handleStudioVoice } from './studio-voice';
import type { Env } from '../types';
const originalFetch = globalThis.fetch;
const env = { OPENAI_API_KEY: 'synthetic-provider', ADMIN_SECRET: 'synthetic-admin', CLOUDFLARE_AI_GATEWAY_ID: 'synthetic', CLOUDFLARE_AI_GATEWAY_TOKEN: 'synthetic-cf', AI: { gateway: () => ({ getUrl: async () => 'https://gateway.ai.cloudflare.com/v1/account/synthetic/openai' }) } } as unknown as Env;
const body = { session: { model: 'gpt-live-1', store: false, delegation: { type: 'client' }, instructions: 'Synthetic test', tools: [{ type: 'unsafe-tool' }] }, transport: { type: 'webrtc', sdp: 'v=0\r\n' } };
function request(value: unknown = body, auth = 'synthetic-admin', method = 'POST') { return new Request('https://api.screenpi.pe/v1/admin/studio-voice', { method, headers: { Authorization: `Bearer ${auth}`, 'OpenAI-Safety-Identifier': 'a'.repeat(64) }, body: JSON.stringify(value) }); }
afterEach(() => { globalThis.fetch = originalFetch; });
describe('Studio voice gateway', () => {
 test('rejects missing/wrong backend credentials before reaching a provider', async () => {
  let calls = 0; globalThis.fetch = (async () => { calls++; throw new Error(); }) as typeof fetch;
  expect((await handleStudioVoice(request(body, 'wrong'), env)).status).toBe(401);
  expect((await handleStudioVoice(request(), { ...env, ADMIN_SECRET: '' })).status).toBe(401);
  expect(calls).toBe(0);
 });
 test('keeps the provider key in Screenpipe gateway and only forwards reviewed Live fields', async () => {
  globalThis.fetch = (async (url, options) => {
   expect(String(url)).toBe('https://api.openai.com/v1/live/sessions');
   const headers = new Headers(options?.headers);
   expect(headers.get('Authorization')).toBe('Bearer synthetic-provider');
   const outgoing = JSON.parse(String(options?.body));
   expect(outgoing.session.tools).toBeUndefined();
   expect(outgoing.session.model).toBe('gpt-live-1');
   return Response.json({ session: { id: 'live_synthetic', private: 'hidden' }, transport: { type: 'webrtc', sdp: 'v=0\r\n' }, secret: 'hidden' });
  }) as typeof fetch;
  const result = await handleStudioVoice(request(), env);
  expect(result.status).toBe(201); expect(await result.text()).not.toContain('hidden');
 });
 test('rejects unbounded payloads and invalid model, storage, SDP and actor', async () => {
  globalThis.fetch = (async () => { throw new Error('must not fetch'); }) as typeof fetch;
  for (const value of [{ ...body, session: { ...body.session, model: 'other' } }, { ...body, session: { ...body.session, store: true } }, { ...body, session: { ...body.session, instructions: 'x'.repeat(70000) } }, { ...body, transport: { type: 'webrtc', sdp: 'invalid' } }]) expect((await handleStudioVoice(request(value), env)).status).toBe(400);
  const invalid = request(); invalid.headers.delete('OpenAI-Safety-Identifier');
  expect((await handleStudioVoice(invalid, env)).status).toBe(400);
 });
 test('does not retry or expose private provider errors', async () => {
  let calls = 0; globalThis.fetch = (async () => { calls++; return new Response('private error', { status: 429 }); }) as typeof fetch;
  const result = await handleStudioVoice(request(), env);
  expect(result.status).toBe(429); expect(await result.text()).not.toContain('private'); expect(calls).toBe(1);
 });
 test('cleans up a created session when its SDP is malformed', async () => {
  let calls = 0; globalThis.fetch = (async (url) => { calls++; if (calls === 1) return Response.json({ session: { id: 'live_synthetic' }, transport: { type: 'webrtc', sdp: 'invalid' } }); expect(String(url)).toEndWith('/live_synthetic/hangup'); return new Response(null, { status: 200 }); }) as typeof fetch;
  expect((await handleStudioVoice(request(), env)).status).toBe(502); expect(calls).toBe(2);
 });
 test('hangup is restricted to an opaque ID and accepts an already closed session', async () => {
  globalThis.fetch = (async (url, options) => { expect(String(url)).toEndWith('/live/sessions/live_synthetic/hangup'); expect(options?.method).toBe('POST'); return new Response(null, { status: 404 }); }) as typeof fetch;
  expect((await handleStudioVoice(request({ call_id: '../other' }, undefined, 'DELETE'), env)).status).toBe(400);
  expect((await handleStudioVoice(request({ call_id: 'live_synthetic' }, undefined, 'DELETE'), env)).status).toBe(204);
 });
});
