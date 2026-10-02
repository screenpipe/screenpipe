// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
let supply, requests, network;
const originalFetch = globalThis.fetch;
mock.module('openai', () => ({ default: class {
  constructor(options) { this.baseURL = options.baseURL; }
  chat = { completions: { create: async params => { requests.push(structuredClone(params)); return supply(); } } };
} }));
mock.module('@sentry/cloudflare', () => ({ captureException() {} }));
globalThis.fetch = async () => { network++; throw Error('External network forbidden'); };
afterAll(() => { globalThis.fetch = originalFetch; });
const { OpenAIProvider } = await import('../../../packages/ai-gateway/src/providers/openai');
const input = () => ({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Synthetic stream check.' }] });
const fault = (status, code) => Object.assign(new Error('Synthetic provider failure'), { status, code });
function iterable(generate) { const value = generate(); value.controller = { abort() {} }; return value; }
beforeEach(() => { requests = []; network = 0; });
afterEach(() => { expect(network).toBe(0); });
async function invoke() {
  const body = input(), snapshot = structuredClone(body);
  const stream = await new OpenAIProvider('synthetic-key').createStreamingCompletion(body);
  expect(body).toEqual(snapshot);
  expect(requests).toHaveLength(1); expect(requests[0]).toMatchObject({ model: body.model, messages: body.messages, stream: true });
  return stream;
}
async function delivered() {
  const text = await new Response(await invoke()).text();
  expect(text.split('data: [DONE]')).toHaveLength(2);
  return text.split('\n\n').filter(l => l.startsWith('data: ') && l !== 'data: [DONE]').map(l => JSON.parse(l.slice(6)));
}
for (const [status, code] of [[429, 'insufficient_quota'], [503, 'service_unavailable']]) test(`initial lazy ${status} rejects before exposing a successful stream`, async () => {
  supply = () => iterable(async function* () { throw fault(status, code); });
  await expect(invoke()).rejects.toMatchObject({ message: 'Synthetic provider failure', status, code });
});
test('SDK creation failure retains error details', async () => {
  supply = () => { throw fault(429, 'insufficient_quota'); };
  await expect(invoke()).rejects.toMatchObject({ message: 'Synthetic provider failure', status: 429, code: 'insufficient_quota' });
});
test('first and later text arrive exactly once in order', async () => {
  supply = () => iterable(async function* () {
    yield { choices: [{ delta: { content: 'first|' } }] };
    yield { choices: [{ delta: { content: 'second' } }] };
    yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
  });
  const events = await delivered();
  expect(events.map(e => e.choices?.[0]?.delta?.content ?? '').join('')).toBe('first|second');
  expect(events.filter(e => e.error)).toHaveLength(0);
  expect(events.filter(e => e.choices?.[0]?.finish_reason).map(e => e.choices[0].finish_reason)).toEqual(['stop']);
});
test('first tool fragment, later arguments, completion reason and usage survive', async () => {
  supply = () => iterable(async function* () {
    yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'synthetic-call', type: 'function', function: { name: 'read', arguments: '{"path":' } }] } }] };
    yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"sample.txt"}' } }] } }] };
    yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] };
    yield { choices: [], usage: { prompt_tokens: 23, completion_tokens: 7, total_tokens: 30, prompt_tokens_details: { cached_tokens: 9 } } };
  });
  const events = await delivered(), calls = events.flatMap(e => e.choices?.[0]?.delta?.tool_calls ?? []);
  expect(calls.filter(c => c.id).map(c => ({ id: c.id, name: c.function?.name }))).toEqual([{ id: 'synthetic-call', name: 'read' }]);
  expect(calls.map(c => c.function?.arguments ?? '').join('')).toBe('{"path":"sample.txt"}');
  expect(events.filter(e => e.choices?.[0]?.finish_reason).map(e => e.choices[0].finish_reason)).toEqual(['tool_calls']);
  expect(events.filter(e => e.usage).map(e => e.usage)).toMatchObject([{ prompt_tokens: 23, completion_tokens: 7, total_tokens: 30, prompt_tokens_details: { cached_tokens: 9 } }]);
});
test('empty upstream completes normally without invented content', async () => {
  supply = () => iterable(async function* () {});
  const events = await delivered();
  expect(events.filter(e => e.error)).toHaveLength(0);
  expect(events.map(e => e.choices?.[0]?.delta?.content ?? '').join('')).toBe('');
  expect(events.flatMap(e => e.choices?.[0]?.delta?.tool_calls ?? [])).toEqual([]);
  expect(events.filter(e => e.choices?.[0]?.finish_reason).map(e => e.choices[0].finish_reason)).toEqual(['stop']);
});
test('failure after delivered content remains an SSE error and closes', async () => {
  supply = () => iterable(async function* () {
    yield { choices: [{ delta: { content: 'partial evidence' } }] };
    throw fault(503, 'service_unavailable');
  });
  const events = await delivered();
  expect(events.map(e => e.choices?.[0]?.delta?.content ?? '').join('')).toBe('partial evidence');
  expect(events.filter(e => e.error).map(e => e.error)).toMatchObject([{ message: 'Synthetic provider failure', code: '503' }]);
  expect(events.at(-1).choices[0].finish_reason).toBe('network_error');
});
