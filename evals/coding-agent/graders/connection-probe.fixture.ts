// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterEach, expect, test, vi } from 'vitest';
import { testAiPresetConnection } from './lib/utils/ai-preset-connection';
vi.mock('@/lib/http/tauri-fetch', () => ({ tauriFetchWithDeadline: () => { throw new Error('unexpected native network'); } }));
afterEach(() => vi.unstubAllGlobals());
const presets = [
  { provider: 'custom', url: 'https://gateway.example.test/v1', model: 'custom-model', apiKey: 'synthetic-key' },
  { provider: 'openai', model: 'openai-model', apiKey: 'synthetic-key' },
  { provider: 'native-ollama', url: 'http://localhost:11434/v1', model: 'local-model' },
  { provider: 'anthropic', model: 'anthropic-model', apiKey: 'synthetic-key' },
] as const;
function json(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } }); }
function reply(anthropic: boolean, text: string) { return anthropic ? { content: [{ type: 'text', text }] } : { choices: [{ message: { role: 'assistant', content: text } }] }; }
function gateway(preset: typeof presets[number], text: string, streamingDefault = true) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)), headers = new Headers(init?.headers);
    const anthropic = preset.provider === 'anthropic';
    const endpoint = preset.provider === 'openai' ? 'https://api.openai.com/v1/chat/completions'
      : anthropic ? 'https://api.anthropic.com/v1/messages' : `${preset.url}/chat/completions`;
    // A synthetic provider rejects misrouted or unauthenticated requests, rather
    // than accepting a canned result unrelated to the configured connection.
    if (url !== endpoint || init?.method !== 'POST' || body.model !== preset.model || !body.messages?.some((m: any) => m.role === 'user' && m.content)) return json({ error: { message: 'wrong connection request' } }, 400);
    if ('apiKey' in preset && (anthropic ? headers.get('x-api-key') !== preset.apiKey : headers.get('authorization') !== `Bearer ${preset.apiKey}`)) return json({ error: { message: 'wrong provider identity' } }, 401);
    if (!streamingDefault || body.stream === false) return json(reply(anthropic, text));
    const records = [text.slice(0, 4), text.slice(4)].map(part => anthropic
      ? `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: part } })}\n\n`
      : `data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`);
    return new Response(records.join('') + (anthropic ? 'event: message_stop\ndata: {"type":"message_stop"}\n\n' : 'data: [DONE]\n\n'), { headers: { 'content-type': 'text/event-stream' } });
  });
}
for (const preset of presets) test(`returns the actual reply from a streaming-default ${preset.provider} gateway`, async () => {
  vi.stubGlobal('fetch', () => { throw new Error('live network forbidden'); });
  const expected = `${preset.provider}-reply-37`, request = gateway(preset, expected);
  const pending = testAiPresetConnection(preset, { fetch: request });
  await expect(pending).resolves.toMatchObject({ reply: expected });
  const result = await pending;
  expect(result.reply).toBe(expected); expect(request.mock.calls.length).toBeGreaterThan(0);
  expect(Number.isFinite(result.latencyMs)).toBe(true); expect(result.latencyMs).toBeGreaterThanOrEqual(0);
});
test('token-parameter recovery returns a streaming-default gateway reply', async () => {
  const preset = presets[0], good = gateway(preset, 'retry-reply-92');
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (body.max_tokens !== undefined || body.max_completion_tokens === undefined) return json({ error: { message: 'Unsupported parameter: use max_completion_tokens' } }, 400);
    return good(url, init);
  });
  await expect(testAiPresetConnection(preset, { fetch: request })).resolves.toMatchObject({ reply: 'retry-reply-92' });
  expect(good).toHaveBeenCalled();
});
for (const preset of [presets[0], presets[3]]) {
  test(`preserves ordinary JSON replies for ${preset.provider}`, async () => {
    expect((await testAiPresetConnection(preset, { fetch: gateway(preset, 'plain-reply-53', false) })).reply).toBe('plain-reply-53');
  });
  test(`rejects a missing message for ${preset.provider}`, async () => {
    await expect(testAiPresetConnection(preset, { fetch: async () => json({}) })).rejects.toThrow();
  });
  test(`preserves valid empty-text message compatibility for ${preset.provider}`, async () => {
    const result = await testAiPresetConnection(preset, { fetch: async () => json(reply(preset.provider === 'anthropic', '')) });
    expect(typeof result.reply).toBe('string'); expect(result.reply.trim().length).toBeGreaterThan(0);
  });
}
test('surfaces array-shaped provider error details', async () => {
  await expect(testAiPresetConnection(presets[0], { fetch: async () => json([{ error: { message: 'synthetic project disabled', status: 'PERMISSION_DENIED' } }], 403) })).rejects.toThrow(/synthetic project disabled/);
});
test('does not turn an authorization refusal into success', async () => {
  const request = vi.fn(async () => json({ error: { message: 'synthetic credential rejected' } }, 401));
  await expect(testAiPresetConnection(presets[3], { fetch: request })).rejects.toThrow(/401.*synthetic credential rejected/);
});
test('preserves transport failure', async () => {
  await expect(testAiPresetConnection(presets[0], { fetch: async () => { throw new Error('synthetic transport refused'); } })).rejects.toThrow('synthetic transport refused');
});
test('bounds the displayed reply to 100 characters', async () => {
  const text = '0123456789'.repeat(14);
  expect((await testAiPresetConnection(presets[0], { fetch: gateway(presets[0], text, false) })).reply).toBe(text.slice(0, 100));
});
test('forwards caller cancellation to the provider port', async () => {
  const controller = new AbortController(); controller.abort();
  const request = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.signal?.aborted) throw new Error('synthetic request aborted');
    return json(reply(false, 'must not succeed'));
  });
  await expect(testAiPresetConnection(presets[0], { fetch: request, signal: controller.signal })).rejects.toThrow('synthetic request aborted');
});
