// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, beforeEach, expect, mock, test } from 'bun:test';
let requests, rejectUsage;
const originalFetch = globalThis.fetch;
const fragment = { index: 0, id: 'synthetic-call', type: 'function', function: { name: 'read_fixture', arguments: '{"key":"sample"}' } };
mock.module('openai', () => ({ default: class {
  constructor(options) { this.baseURL = options.baseURL; }
  chat = { completions: { create: async params => {
    requests.push(structuredClone(params));
    if (rejectUsage && params.stream_options) {
      rejectUsage = false;
      const error = new Error("Unknown parameter: 'stream_options.include_usage'"); error.status = 400; throw error;
    }
    if (!params.stream) return { choices: [{ message: { role: 'assistant', content: 'plain answer' }, finish_reason: 'stop' }] };
    return { controller: { abort() {} }, async *[Symbol.asyncIterator]() {
      yield { choices: [{ delta: { content: 'plain answer' }, finish_reason: null }] };
      yield { choices: [{ delta: { tool_calls: [fragment] }, finish_reason: 'tool_calls' }] };
      yield { choices: [], usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23, prompt_tokens_details: { cached_tokens: 4 } } };
    } };
  } } };
} }));
mock.module('@sentry/cloudflare', () => ({ captureException() { throw Error('Unexpected provider error'); } }));
globalThis.fetch = async () => { throw Error('Network forbidden'); };
afterAll(() => { globalThis.fetch = originalFetch; });
const { OpenAIProvider } = await import('../../../packages/ai-gateway/src/providers/openai');
const tools = [{ type: 'function', function: { name: 'read_fixture', parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } } }];
const named = { type: 'function', function: { name: 'read_fixture' } };
beforeEach(() => { requests = []; rejectUsage = false; });
async function invoke(stream, choice, withTools = true) {
  const body = { model: 'gpt-5.6-luna', messages: [{ role: 'user', content: 'Read the synthetic fixture when permitted.' }], ...(withTools ? { tools: structuredClone(tools) } : {}), ...(choice === undefined ? {} : { tool_choice: structuredClone(choice) }), stream };
  const before = structuredClone(body), provider = new OpenAIProvider('synthetic-key');
  const response = stream ? new Response(await provider.createStreamingCompletion(body)) : await provider.createCompletion(body);
  const output = await response.text();
  expect(body).toEqual(before);
  for (const request of requests) { expect(request.model).toBe(body.model); expect(request.messages).toEqual(body.messages); expect(request.tools).toEqual(body.tools); }
  return output;
}
for (const stream of [false, true]) for (const [name, choice] of [['required', 'required'], ['automatic', 'auto'], ['disabled', 'none'], ['named', named], ['unspecified', undefined]]) {
  test(`${stream ? 'stream' : 'completion'} preserves ${name} tool policy`, async () => {
    await invoke(stream, choice); expect(requests).toHaveLength(1); expect(requests[0].tool_choice).toEqual(choice);
  });
}
test('unsupported usage retry retains the exact tool policy and tools', async () => {
  rejectUsage = true; await invoke(true, named); expect(requests).toHaveLength(2);
  for (const request of requests) expect(request.tool_choice).toEqual(named);
  expect(requests[1].stream_options).toBeUndefined();
});
test('ordinary streams preserve content, native tool fragments, usage and one terminator', async () => {
  const output = await invoke(true, undefined, false); expect(requests).toHaveLength(1); expect(requests[0].tool_choice).toBeUndefined();
  expect(output.split('data: [DONE]').length - 1).toBe(1);
  const events = output.split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]').map(line => JSON.parse(line.slice(6)));
  expect(events.map(e => e.choices?.[0]?.delta?.content || '').join('')).toBe('plain answer');
  expect(events.flatMap(e => e.choices?.[0]?.delta?.tool_calls || [])).toEqual([fragment]);
  expect(events.find(e => e.choices?.[0]?.finish_reason)?.choices[0].finish_reason).toBe('tool_calls');
  expect(events.find(e => e.usage)?.usage).toMatchObject({ prompt_tokens: 20, completion_tokens: 3, total_tokens: 23, prompt_tokens_details: { cached_tokens: 4 } });
});
