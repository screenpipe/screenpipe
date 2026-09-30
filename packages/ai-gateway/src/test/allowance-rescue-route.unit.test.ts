// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { describe, expect, it, spyOn } from 'bun:test';
import { handleRequest } from '../index';
import type { Env, RequestBody } from '../types';
import { OpenAIProvider } from '../providers/openai';


describe('allowance rescue through the chat route', () => {
	for (const model of ['auto', 'gpt-6-luna']) {
		for (const stream of [false, true]) {
			it(`rescues ${model} (${stream ? 'SSE' : 'JSON'}) once and retains cost writes after the response`, async () => {
				const calls: Array<{ url: string; body: any; headers: Headers }> = [];
				const health: unknown[][] = [];
				const costs: unknown[][] = [];
				const lifetime: Promise<unknown>[] = [];
				let releaseWrite!: () => void;
				const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
				const info = spyOn(console, 'info').mockImplementation(() => {});
				const warn = spyOn(console, 'warn').mockImplementation(() => {});
				const toolCall = { id: 'synthetic-call', type: 'function', function: { name: 'lookup', arguments: '{"query":"synthetic"}' } };
				const usage = { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } };
				const reply = async (provider: OpenAIProvider, body: RequestBody) => {
					const client = (provider as any).client;
					calls.push({ url: client.baseURL, body, headers: new Headers(client._options.defaultHeaders) });
					if (client.baseURL.startsWith('https://gateway.ai.cloudflare.com/')) throw Object.assign(new Error('Spend limit exceeded'), { status: 429 });
					if (client.baseURL !== 'https://api.openai.com/v1') throw new Error('unexpected provider');
					const json = { model: body.model, choices: [{ message: { role: 'assistant', content: null, tool_calls: [toolCall] }, finish_reason: 'tool_calls' }], usage };
					const sse = [
						{ choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, ...toolCall }] }, finish_reason: null }] },
						{ choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
						{ choices: [], usage },
					].map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
					return stream ? new Response(sse, { headers: { 'content-type': 'text/event-stream' } }) : Response.json(json);
				};
				const jsonSpy = spyOn(OpenAIProvider.prototype, 'createCompletion').mockImplementation(function (body) { return reply(this, body); });
				const streamSpy = spyOn(OpenAIProvider.prototype, 'createStreamingCompletion').mockImplementation(async function (body) { return (await reply(this, body)).body!; });
				const env = {
					AI_GATEWAY_SERVICE_TOKEN: 'synthetic-service-token', OPENAI_API_KEY: 'synthetic-openai-key',
					CLOUDFLARE_AI_GATEWAY_ID: 'synthetic', CLOUDFLARE_AI_GATEWAY_TOKEN: 'synthetic-gateway-key',
					CLOUDFLARE_AI_GATEWAY_BASE_URL: 'https://gateway.ai.cloudflare.com/v1/00000000000000000000000000000000/synthetic/compat/chat/completions',
					RATE_LIMITER: { idFromName: (name: string) => name, get: () => ({ fetch: async () => Response.json({ allowed: true, standing: 'good' }) }) },
					DB: { prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({
						first: async () => null,
						run: async () => {
							if (sql.includes('INSERT INTO model_health_window')) health.push(values);
							if (sql.includes('INSERT INTO cost_daily')) { await writeGate; costs.push(values); }
							return { success: true };
						},
					}) }) },
				} as unknown as Env;
				try {
					const response = await handleRequest(new Request('https://gateway.test/v1/chat/completions', {
						method: 'POST', headers: { authorization: 'Bearer synthetic-service-token', 'content-type': 'application/json', 'x-screenpipe-workload': 'pipe', 'x-screenpipe-latency': 'background' },
						body: JSON.stringify({ model, stream, messages: [{ role: 'user', content: 'Synthetic lookup' }], tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { query: { type: 'string' } } } } }], max_completion_tokens: 64 }),
					}), env, { waitUntil: (task: Promise<unknown>) => lifetime.push(task), passThroughOnException() {} } as unknown as ExecutionContext);
					expect(response.status).toBe(200);
					expect(response.headers.get('x-screenpipe-background-fallback')).toBe('gpt-6-luna');
					expect(await response.text()).toContain('synthetic-call');
					expect(calls.map((call) => call.body.model)).toEqual(['gpt-6-luna', 'gpt-6-luna']);
					expect(calls[0].headers.has('cf-aig-metadata')).toBe(true);
					expect(calls[1].headers.has('cf-aig-metadata')).toBe(false);
					expect(calls[1].body.tools[0].function.name).toBe('lookup');
					expect(health.some((values) => values[1] === 'rate_limited')).toBe(false);
					const route = info.mock.calls.map((args) => String(args[0])).find((line) => line.startsWith('screenpipe.ai-gateway-route '));
					expect(JSON.parse(route!.slice('screenpipe.ai-gateway-route '.length))).toMatchObject({ gateway_mode: 'direct', fallback_model: 'gpt-6-luna', fallback_reason: 'account_allowance', status_code: 200 });
					expect(costs).toHaveLength(0);
					// Cost I/O is deliberately unfinished after the body is delivered.
					// It must be attached to the request lifetime, not fire-and-forget.
					expect(lifetime.length).toBeGreaterThan(0);
					releaseWrite();
					await Promise.all(lifetime);
					expect(costs).toHaveLength(1);
					expect(costs[0][3]).toBe('gpt-6-luna');
					expect(costs[0].slice(7, 10)).toEqual([100, 20, 40]);
				} finally { releaseWrite(); await Promise.allSettled(lifetime); info.mockRestore(); warn.mockRestore(); jsonSpy.mockRestore(); streamSpy.mockRestore(); }
			});
		}
	}
});
