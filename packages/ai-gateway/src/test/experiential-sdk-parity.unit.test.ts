// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

// Offline contract tests: real installed SDK serializers and stream parsers,
// synthetic fetch only. These prove neither deployed route nor provider parity.
import { describe, expect, it } from 'bun:test';
import { OpenAIProvider } from '../providers/openai';
import { AnthropicProvider } from '../providers/anthropic';
import { AstraProvider } from '../providers/astra';
import { ScreenpipeGlmProvider, SCREENPIPE_GLM_MODEL } from '../providers/screenpipe-glm';
import { getHostedChatGatewayConnection, hostedChatActorId, type HostedChatGatewayContext } from '../services/cloudflare-ai-gateway';
import { prepareExperientialProbeConnection } from '../../scripts/lib/experiential-adapter';
import { EXPERIENTIAL_ORIGIN } from '../../scripts/lib/experiential-migration';
import type { Env, RequestBody } from '../types';

const key = `xpl_${'0'.repeat(40)}`;
const context: HostedChatGatewayContext = { user_id: 'synthetic-actor', plan: 'business', lane: 'explicit', workload: 'interactive', trial: false };
const env = { CLOUDFLARE_AI_GATEWAY_ID: 'parity', CLOUDFLARE_AI_GATEWAY_BASE_URL: 'https://gateway.ai.cloudflare.com/v1/synthetic/parity', TINFOIL_GLM_API_KEY: 'synthetic-glm-key' } as Env;
const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
const tools = [{ type: 'function', function: { name: 'confirm', parameters: schema } }];
const usage = { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10, prompt_tokens_details: { cached_tokens: 3 } };
const image = { type: 'image', mimeType: 'image/png', data: 'AAAA' };
function body(model: string): RequestBody {
  return { model, max_tokens: 64, messages: [{ role: 'system', content: 'Synthetic fixture.' }, { role: 'user', content: [{ type: 'text', text: 'Confirm.' }, image] }],
    tools, tool_choice: { type: 'function', function: { name: 'confirm' } }, response_format: { type: 'json_schema', json_schema: { name: 'confirmation', strict: true, schema }, schema } } as RequestBody;
}
function completion() {
  return { id: 'chat_fixture', object: 'chat.completion', model: 'gpt-5.4-mini', created: 1,
    choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'confirm', arguments: '{"ok":true}' } }] }, finish_reason: 'tool_calls' }], usage };
}
function sse(events: any[], native = false) {
  const text = events.map(event => `${native ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`).join('') + (native ? '' : 'data: [DONE]\n\n');
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) {
    for (let index = 0; index < bytes.length; index += 11) controller.enqueue(bytes.slice(index, index + 11));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}
async function intercept(provider: any, response: () => Response, side?: string, model = 'gpt-5.4-mini', verdict: string | null = 'true') {
  const calls: Array<{ url: string; headers: Headers; body: any }> = [];
  // Replace only SDK fetch, never SDK create() or stream parsing. Destination
  // tests dispatch through the inactive adapter under explicit isolated mode.
  const transport = async (url: any, init: any) => {
    if (init.method === 'GET') {
      const management = new Headers(init.headers).get('authorization') === `Bearer xpl_${'1'.repeat(40)}`;
      if (String(url).endsWith('/api/whoami')) return Response.json({ org_id: '00000000-0000-0000-0000-000000000001',
        ...(management ? {} : { identity_id: 'customer-alice', customer_plan_identity_id: 'customer-alice', is_provisioning: false }) });
      if (String(url).endsWith('/v1/models')) return Response.json({ data: [{ id: model, data_policy: { zdr_on_request: true } }] });
      if (String(url).endsWith('/identities/customer-alice/customer-plan') && !management) return Response.json({ org_id: '00000000-0000-0000-0000-000000000001', identity_id: 'customer-alice', plan_key: 'business', plan_version: 1, revision: 1, pending_plan_key: null, pending_plan_version: null, pending_effective_at: null });
      if (String(url).endsWith('/telemetry-settings') && management) return Response.json({ capture_prompt_content: false });
      if (String(url).endsWith(`/api/models/${model}`) && management) return Response.json({ model: { id: '00000000-0000-0000-0000-000000000004', slug: model } });
      if (String(url).endsWith('/provider-policy') && management) return Response.json({ zdr_entitled: true, policy: { require_no_training: true, zdr_continuation_storage: false } });
      throw new Error('unexpected preflight request');
    }
    calls.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) });
    const result = response();
    if (side === 'experiential-fixture' && verdict !== null) result.headers.set('x-gateway-zdr', verdict);
    return result;
  };
  let sdkFetch: any = transport;
  if (side === 'experiential-fixture') {
    const auth = { isValid: true, tier: 'subscribed', accountPlan: 'business', userId: 'synthetic-user', deviceId: 'synthetic-device' } as const;
    const actorId = await hostedChatActorId(auth);
    const c = await prepareExperientialProbeConnection({ mode: 'isolated-test', auth, sourceModelId: model,
      managementKey: `xpl_${'1'.repeat(40)}`, transport,
      mappings: [{ sourceModelId: model, destinationModelId: model, canonicalModelUuid: '00000000-0000-0000-0000-000000000004', protocol: model === 'gpt-6-astra' ? 'responses' : model.startsWith('claude-') ? 'messages' : 'chat' }],
      lookupBinding: async () => ({ actorId, orgId: '00000000-0000-0000-0000-000000000001', customerIdentityId: 'customer-alice', provisioningIdentityId: 'entitlement-sync', accountPlan: 'business', expectedPlan: { plan_key: 'business', plan_version: 1, revision: 1 }, customerKey: key }),
    });
    sdkFetch = c.fetch;
    expect(c.production_ready).toBe(false);
  }
  provider.client.fetch = sdkFetch;
  if (provider.responsesClient) provider.responsesClient.fetch = sdkFetch;
  return calls;
}
async function connection(side: 'cloudflare' | 'experiential-fixture', provider: 'openai' | 'anthropic') {
  if (side === 'cloudflare') return getHostedChatGatewayConnection(env, provider, context);
  // Documented destination wire shape only, not a production routing selector.
  return { apiKey: key, baseURL: `${EXPERIENTIAL_ORIGIN}${provider === 'openai' ? '/v1' : ''}`, maxRetries: 0,
    defaultHeaders: { Authorization: `Bearer ${key}`, ...(provider === 'anthropic' ? { 'x-api-key': null } : {}) } };
}
function assertWire(call: { url: string; headers: Headers; body: any }, side: string, provider: string, suffix: string) {
  expect(call.url).toBe(side === 'cloudflare'
    ? `https://gateway.ai.cloudflare.com/v1/synthetic/parity/${provider}${suffix}`
    : `${EXPERIENTIAL_ORIGIN}/v1${suffix.replace(/^\/v1/, '')}`);
  expect(call.headers.get('x-api-key')).toBeNull();
  expect(call.headers.get('authorization')).toBe(side === 'cloudflare' ? null : `Bearer ${key}`);
  if (side === 'cloudflare') {
    expect(call.headers.get('cf-aig-collect-log-payload')).toBe('false');
    expect(JSON.parse(call.headers.get('cf-aig-metadata')!)).toEqual(context);
    expect(call.body).not.toHaveProperty('provider');
  } else {
    expect(call.headers.get('cf-aig-metadata')).toBeNull();
    expect(call.body.provider).toEqual({ zdr: true });
  }
}
async function chunks(stream: ReadableStream) {
  const text = await new Response(stream).text();
  expect(text.endsWith('data: [DONE]\n\n')).toBe(true);
  return text.split('\n\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
}

for (const side of ['cloudflare', 'experiential-fixture'] as const) describe(`${side} installed native SDK wire`, () => {
  it('preserves OpenAI tools, images and structured output without provider auth leakage', async () => {
    const c = await connection(side, 'openai');
    const provider = new OpenAIProvider(c.apiKey, c.baseURL, c.defaultHeaders, c.maxRetries);
    const calls = await intercept(provider, () => Response.json(completion()), side);
    const result: any = await (await provider.createCompletion(body('gpt-5.4-mini'))).json();
    expect(calls).toHaveLength(1); assertWire(calls[0], side, 'openai', '/chat/completions');
    expect(calls[0].body.messages[1].content[1]).toMatchObject({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } });
    expect(calls[0].body.tools).toEqual(tools);
    expect(calls[0].body.response_format).toMatchObject({ type: 'json_schema', json_schema: { schema } });
    expect(result.choices[0].finish_reason).toBe('tool_calls');
    expect(result.choices[0].message.tool_calls[0].function.arguments).toBe('{"ok":true}');
    expect(result.usage.prompt_tokens_details.cached_tokens).toBe(3);
  });
  it('parses fragmented OpenAI tool streams and final usage', async () => {
    const c = await connection(side, 'openai');
    const provider = new OpenAIProvider(c.apiKey, c.baseURL, c.defaultHeaders, c.maxRetries);
    const calls = await intercept(provider, () => sse([
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'confirm', arguments: '{"ok":' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'true}' } }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }, { choices: [], usage },
    ]), side);
    const result = await chunks(await provider.createStreamingCompletion(body('gpt-5.4-mini')));
    expect(calls).toHaveLength(1); assertWire(calls[0], side, 'openai', '/chat/completions');
    expect(calls[0].body.stream_options).toEqual({ include_usage: true });
    expect(result.flatMap(c => c.choices[0]?.delta.tool_calls ?? []).map(c => c.function.arguments).join('')).toBe('{"ok":true}');
    expect(result.at(-1).usage).toEqual({ ...usage, cache_creation_input_tokens: 0 });
  });
  it('serializes Anthropic native Messages and translates cache and tool usage', async () => {
    const c = await connection(side, 'anthropic');
    const provider = new AnthropicProvider(c.apiKey, c.baseURL, c.defaultHeaders, c.maxRetries);
    const calls = await intercept(provider, () => Response.json({ id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
      content: [{ type: 'tool_use', id: 'call_1', name: 'confirm', input: { ok: true } }], stop_reason: 'tool_use',
      usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 1 } }), side, 'claude-sonnet-5');
    const result: any = await (await provider.createCompletion(body('claude-sonnet-5'))).json();
    expect(calls).toHaveLength(1); assertWire(calls[0], side, 'anthropic', '/v1/messages');
    expect(calls[0].headers.get('anthropic-version')).toBe('2023-06-01');
    expect(calls[0].body.messages[0].content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' }, cache_control: { type: 'ephemeral' } });
    expect(calls[0].body.tools[0]).toMatchObject({ name: 'confirm', input_schema: schema });
    // Existing provider expresses JSON schema as system instructions, not native
    // constrained decoding. This fixture must not claim stronger guarantees.
    expect(JSON.stringify(calls[0].body.system)).toContain('strictly follows this schema');
    expect(result.choices[0].finish_reason).toBe('tool_calls');
    expect(result.choices[0].message.tool_calls[0]).toEqual({ id: 'call_1', type: 'function', function: { name: 'confirm', arguments: '{"ok":true}' } });
    // Feed the actual first-turn Chat response back into the provider. Dropping
    // its ID would leave a tool_result without the matching Anthropic tool_use.
    const secondCalls = await intercept(provider, () => Response.json({ id: 'msg_second', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', usage: { input_tokens: 9, output_tokens: 1 } }), side, 'claude-sonnet-5');
    const second: any = await (await provider.createCompletion({ model: 'claude-sonnet-5', max_tokens: 64, messages: [
      { role: 'user', content: 'Confirm.' }, result.choices[0].message, { role: 'tool', tool_call_id: 'call_1', content: 'confirmed' },
    ] })).json();
    expect(secondCalls[0].body.messages[1].content[0]).toMatchObject({ type: 'tool_use', id: 'call_1', name: 'confirm', input: { ok: true } });
    expect(secondCalls[0].body.messages[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_1', content: 'confirmed' });
    expect(second.choices[0].finish_reason).toBe('stop');
    expect(result.usage).toMatchObject({ prompt_tokens: 9, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 3 }, cache_creation_input_tokens: 1 });
  });
  it('parses native Anthropic tool stream into Chat SSE with cache usage', async () => {
    const c = await connection(side, 'anthropic');
    const provider = new AnthropicProvider(c.apiKey, c.baseURL, c.defaultHeaders, c.maxRetries);
    const calls = await intercept(provider, () => sse([
      { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-5', usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 3, cache_creation_input_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_1', name: 'confirm', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"ok":' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'true}' } },
      { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } }, { type: 'message_stop' },
    ], true), side, 'claude-sonnet-5');
    const result = await chunks(await provider.createStreamingCompletion(body('claude-sonnet-5')));
    expect(calls).toHaveLength(1); assertWire(calls[0], side, 'anthropic', '/v1/messages');
    expect(result.flatMap(c => c.choices[0]?.delta.tool_calls ?? []).map(c => c.function.arguments).join('')).toBe('{"ok":true}');
    expect(result.at(-2).choices[0].finish_reason).toBe('tool_calls');
    expect(result.at(-1).usage).toMatchObject({ prompt_tokens: 9, completion_tokens: 2, cache_creation_input_tokens: 1 });
  });
  it('keeps Astra Low/Standard/stateless and translates native Responses streams', async () => {
    const c = await connection(side, 'openai');
    const provider = new AstraProvider(c.apiKey, c.baseURL, c.defaultHeaders, c.maxRetries);
    const calls = await intercept(provider, () => sse([
      { type: 'response.created', response: { id: 'resp_fixture', created_at: 1 } },
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'confirm', arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"ok":true}' },
      { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10, input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 1 } } } },
    ], true), side, 'gpt-6-astra');
    const result = await chunks(await provider.createStreamingCompletion({ ...body('gpt-6-astra'), reasoning_effort: 'high', store: true, previous_response_id: 'must-not-forward', service_tier: 'priority' } as any));
    expect(calls).toHaveLength(1); assertWire(calls[0], side, 'openai', '/responses');
    expect(calls[0].body).toMatchObject({ model: 'gpt-6-astra', reasoning: { effort: 'low' }, service_tier: 'default', store: false, stream: true });
    expect(calls[0].body).not.toHaveProperty('previous_response_id');
    expect(calls[0].body.input[1].content[1]).toMatchObject({ type: 'input_image', image_url: 'data:image/png;base64,AAAA' });
    expect(calls[0].body.text.format).toMatchObject({ type: 'json_schema', schema });
    expect(result.at(-2).choices[0].finish_reason).toBe('tool_calls');
    expect(result.at(-1).usage).toMatchObject({ prompt_tokens: 8, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 3 } });
  });
});

describe('OpenAI nonstream terminal reasons', () => {
  it.each(['stop', 'tool_calls', 'length', 'content_filter', null, undefined])('preserves upstream %s without manufacturing success', finish_reason => {
    const native = completion();
    native.choices[0].finish_reason = finish_reason as any;
    const result = new OpenAIProvider('synthetic-key').formatResponse(native);
    expect(result.choices[0].finish_reason).toBe(finish_reason);
  });
});

describe('Anthropic nonstream terminal reasons', () => {
  it.each([['end_turn', 'stop'], ['stop_sequence', 'stop'], ['tool_use', 'tool_calls'], ['max_tokens', 'length'], ['refusal', 'content_filter']] as const)('maps %s to %s', (stop_reason, finish_reason) => {
    const result = new AnthropicProvider('synthetic-key').formatResponse({ id: 'msg_fixture', role: 'assistant', type: 'message', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'Synthetic.' }], stop_reason, usage: { input_tokens: 1, output_tokens: 1 } } as any);
    expect(result.choices[0].finish_reason).toBe(finish_reason);
  });
});

describe('ordinary GLM stays on the existing Cloudflare route', () => {
  it('retains container bearer, fixed path and request normalization', async () => {
    const c = await getHostedChatGatewayConnection(env, 'custom-tinfoil', context);
    const provider = new ScreenpipeGlmProvider(c.apiKey, c.baseURL, c.defaultHeaders, c.maxRetries);
    const calls = await intercept(provider, () => Response.json(completion()));
    await provider.createCompletion({ model: SCREENPIPE_GLM_MODEL, messages: [{ role: 'user', content: 'Synthetic text only.' }], tools, reasoning_effort: 'medium' } as RequestBody);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://gateway.ai.cloudflare.com/v1/synthetic/parity/custom-tinfoil/glm/v1/chat/completions');
    expect(calls[0].headers.get('authorization')).toBe('Bearer synthetic-glm-key');
    expect(calls[0].headers.get('cf-aig-byok-alias')).toBeNull();
    expect(calls[0].body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(calls[0].body.model).toBe(SCREENPIPE_GLM_MODEL);
  });
});


describe('installed SDKs cannot bypass an unconfirmed ZDR response', () => {
  it.each(['chat-json', 'chat-stream', 'messages-json', 'messages-stream', 'responses-stream'])('%s cancels before parsing and does not retry', async protocol => {
    const anthropic = protocol.startsWith('messages');
    const model = anthropic ? 'claude-sonnet-5' : protocol.startsWith('responses') ? 'gpt-6-astra' : 'gpt-5.4-mini';
    const c = await connection('experiential-fixture', anthropic ? 'anthropic' : 'openai');
    const Provider = anthropic ? AnthropicProvider : protocol.startsWith('responses') ? AstraProvider : OpenAIProvider;
    const provider = new Provider(c.apiKey, c.baseURL, c.defaultHeaders, c.maxRetries);
    let cancelled = false;
    let reads = 0;
    const calls = await intercept(provider, () => new Response(new ReadableStream({
      pull() { reads++; }, cancel() { cancelled = true; },
    }, { highWaterMark: 0 })), 'experiential-fixture', model, null);
    const result = protocol.endsWith('stream') ? provider.createStreamingCompletion(body(model)) : provider.createCompletion(body(model));
    await expect(result).rejects.toBeDefined();
    expect(calls).toHaveLength(1);
    expect(cancelled).toBe(true); expect(reads).toBe(0);
    expect(calls[0].body.provider).toEqual({ zdr: true });
  });
});
