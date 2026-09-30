// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { beforeEach, afterEach, expect, mock, test } from 'bun:test';
let requests, unexpected;
mock.module('openai', () => ({ default: class {
  constructor(options) { this.baseURL = options.baseURL; }
  chat = { completions: { create: async params => {
    requests.push(structuredClone(params));
    if (!params.stream) return { choices: [{ message: { role: 'assistant', content: 'synthetic answer' }, finish_reason: 'stop' }] };
    return { controller: { abort() {} }, async *[Symbol.asyncIterator]() {
      yield { choices: [{ delta: { content: 'synthetic answer' }, finish_reason: null }] };
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
    } };
  } } };
} }));
mock.module('@sentry/cloudflare', () => ({ captureException: () => { unexpected.push('sentry'); } }));
globalThis.fetch = async () => { unexpected.push('network'); throw Error('Network forbidden'); };
const { ScreenpipeGlmProvider } = await import('../../../packages/ai-gateway/src/providers/screenpipe-glm');
const { OpenAIProvider } = await import('../../../packages/ai-gateway/src/providers/openai');
const catalog = '<available_skills><skill><name>screenpipe-api</name></skill><skill><name>unrelated-synthetic-skill</name></skill></available_skills>';
const readTool = { type: 'function', function: { name: 'read', parameters: { type: 'object', properties: {} } } };
const subagent = { type: 'function', function: { name: 'subagent', parameters: { type: 'object', properties: {} } } };
function body(trigger = 'system', length = 40000) {
  const prefix = 'BEGIN_EVIDENCE_'.repeat(10), suffix = 'END_EVIDENCE'.repeat(10) + 'TAIL_LAST!';
  const content = length < prefix.length + suffix.length ? 'x'.repeat(length) : prefix + 'e'.repeat(length - prefix.length - suffix.length) + suffix;
  expect(content.length).toBe(length);
  return {
    model: 'glm-5.3-flash-reap50-iq3m', max_completion_tokens: 1, tool_choice: 'auto',
    tools: trigger === 'subagent' ? [readTool, subagent] : [readTool],
    messages: [
      { role: trigger === 'developer-array' ? 'developer' : 'system', content: trigger === 'developer-array' ? [{ type: 'text', text: 'Keep policy. ' + catalog }] : 'Keep policy. ' + (trigger === 'system' ? catalog : '') },
      { role: 'user', content: 'Summarize synthetic evidence.' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call-large', type: 'function', function: { name: 'read', arguments: '{"path":"synthetic.log"}' } }] },
      { role: 'tool', tool_call_id: 'call-large', content },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call-small', type: 'function', function: { name: 'read', arguments: '{"path":"small.log"}' } }] },
      { role: 'tool', tool_call_id: 'call-small', content: 'small result' },
    ],
  };
}
beforeEach(() => { requests = []; unexpected = []; });
afterEach(() => expect(unexpected).toEqual([]));
async function invoke(input, streaming, provider = new ScreenpipeGlmProvider('synthetic-key')) {
  const original = structuredClone(input);
  if (streaming) {
    const stream = await provider.createStreamingCompletion(input);
    const text = await new Response(stream).text(); expect(text).toContain('synthetic answer'); expect(text).toContain('[DONE]');
  } else {
    const response = await provider.createCompletion(input); expect(response.status).toBe(200); expect(JSON.stringify(await response.json())).toContain('synthetic answer');
  }
  expect(input).toEqual(original); expect(requests).toHaveLength(1);
  const request = requests[0]; expect(request.stream).toBe(streaming); expect(request.tool_choice).toBe('auto');
  expect(request.messages.filter(m => m.role === 'assistant').map(m => m.tool_calls)).toEqual(input.messages.filter(m => m.role === 'assistant').map(m => m.tool_calls));
  expect(request.messages.find(m => m.tool_call_id === 'call-small')).toMatchObject({ role: 'tool', content: 'small result' });
  return request;
}
function compacted(request, original) {
  const result = request.messages.find(m => m.tool_call_id === 'call-large');
  expect(result.role).toBe('tool'); expect(result.content.length).toBeLessThanOrEqual(8000);
  expect(result.content.startsWith(original.slice(0, 128))).toBe(true);
  expect(result.content.endsWith(original.slice(-128))).toBe(true);
  expect(result.content).toMatch(/compact|truncat|omitt/i); expect(result.content).toMatch(/narrow|reread|re-read/i);
  expect(request.tools).toEqual([readTool]); expect(request.max_completion_tokens).toBeGreaterThanOrEqual(4096);
  expect(request.model).toBe('glm-5.3-flash-reap50-iq3m');
}
for (const streaming of [false, true]) {
  for (const trigger of ['system', 'developer-array', 'subagent']) for (const length of [8001, 40000]) test(`${streaming ? 'stream' : 'completion'}: ${trigger} compacts ${length} characters at the provider boundary`, async () => {
    const input = body(trigger, length); compacted(await invoke(input, streaming), input.messages[3].content);
  });
  for (const length of [0, 7999, 8000]) test(`${streaming ? 'stream' : 'completion'}: ${length}-character tool result stays intact`, async () => {
    const input = body('system', length), request = await invoke(input, streaming); expect(request.messages.find(m => m.tool_call_id === 'call-large').content).toBe(input.messages[3].content);
  });
  test(`${streaming ? 'stream' : 'completion'}: ordinary client retains large history and intentional small output`, async () => {
    const input = body('none'), request = await invoke(input, streaming); expect(request.messages.find(m => m.tool_call_id === 'call-large').content).toBe(input.messages[3].content); expect(request.max_completion_tokens).toBe(1);
  });
  test(`${streaming ? 'stream' : 'completion'}: user text cannot activate Pi compaction`, async () => {
    const input = body('none'); input.messages[1].content = catalog; const request = await invoke(input, streaming); expect(request.messages.find(m => m.tool_call_id === 'call-large').content).toBe(input.messages[3].content); expect(request.max_completion_tokens).toBe(1);
  });
  test(`${streaming ? 'stream' : 'completion'}: user and assistant prose survive active compaction`, async () => {
    const input = body(); input.messages[1].content = 'user '.repeat(3000); input.messages[2].content = 'assistant '.repeat(2000); const request = await invoke(input, streaming); expect(request.messages[1].content).toBe(input.messages[1].content); expect(request.messages[2].content).toBe(input.messages[2].content);
  });
  test(`${streaming ? 'stream' : 'completion'}: ordinary OpenAI provider retains complete context`, async () => {
    const input = body('subagent'); input.model = 'gpt-4o'; const request = await invoke(input, streaming, new OpenAIProvider('synthetic-key')); expect(request.messages.find(m => m.tool_call_id === 'call-large').content).toBe(input.messages[3].content); expect(request.tools).toEqual(input.tools); expect(request.max_completion_tokens).toBe(1); expect(request.model).toBe('gpt-4o');
  });
}
