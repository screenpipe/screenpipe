/**
 * Comprehensive unit tests for Anthropic API proxy
 *
 * Tests the migration from Vertex AI to direct Anthropic API for Claude models.
 * Covers: proxy function, model listing, message sanitization, provider routing,
 * edge cases with tool calls, system messages, streaming, and error handling.
 *
 * Run with: bun test src/test/anthropic-proxy.unit.test.ts
 */

import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { proxyToAnthropic, listAnthropicModels } from '../providers/anthropic-proxy';
import { sanitizeMessages } from '../providers/vertex';
import { createProvider } from '../providers';
import { isModelAllowed } from '../services/usage-tracker';
import { AnthropicProvider } from '../providers/anthropic';

// ============================================================================
// proxyToAnthropic — request forwarding
// ============================================================================
describe('proxyToAnthropic', () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it('should forward non-streaming request to api.anthropic.com', async () => {
		let capturedUrl = '';
		let capturedHeaders: Record<string, string> = {};
		let capturedBody: any = null;

		globalThis.fetch = async (url: any, init: any) => {
			capturedUrl = url.toString();
			capturedHeaders = Object.fromEntries(new Headers(init.headers).entries());
			capturedBody = JSON.parse(init.body);
			return new Response(JSON.stringify({
				id: 'msg_123',
				type: 'message',
				role: 'assistant',
				content: [{ type: 'text', text: 'Hello!' }],
				model: 'claude-opus-4-6',
				stop_reason: 'end_turn',
			}), { status: 200, headers: { 'Content-Type': 'application/json' } });
		};

		const request = new Request('http://localhost/v1/messages', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'claude-opus-4-6',
				max_tokens: 1024,
				messages: [{ role: 'user', content: 'Hello' }],
			}),
		});

		const response = await proxyToAnthropic(request, 'sk-ant-test-key');
		const data: any = await response.json();

		// Verify it hit the Anthropic API
		expect(capturedUrl).toBe('https://api.anthropic.com/v1/messages');
		expect(capturedHeaders['x-api-key']).toBe('sk-ant-test-key');
		expect(capturedHeaders['anthropic-version']).toBe('2023-06-01');
		expect(capturedHeaders['content-type']).toBe('application/json');

		// Verify model is kept in body (unlike Vertex which removes it)
		expect(capturedBody.model).toBe('claude-opus-4-6');
		expect(capturedBody.max_tokens).toBe(1024);

		// Verify response passthrough
		expect(data.content[0].text).toBe('Hello!');
		expect(data.model).toBe('claude-opus-4-6');
	});

	it('should forward streaming request and return SSE response', async () => {
		globalThis.fetch = async (url: any, init: any) => {
			const body = JSON.parse(init.body);
			expect(body.stream).toBe(true);

			// Simulate Anthropic SSE stream
			const stream = new ReadableStream({
				start(controller) {
					const encoder = new TextEncoder();
					controller.enqueue(encoder.encode('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-opus-4-6"}}\n\n'));
					controller.enqueue(encoder.encode('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'));
					controller.enqueue(encoder.encode('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n'));
					controller.enqueue(encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
					controller.close();
				},
			});

			return new Response(stream, {
				status: 200,
				headers: { 'Content-Type': 'text/event-stream' },
			});
		};

		const request = new Request('http://localhost/v1/messages', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'claude-opus-4-6',
				max_tokens: 100,
				stream: true,
				messages: [{ role: 'user', content: 'Hi' }],
			}),
		});

		const response = await proxyToAnthropic(request, 'sk-ant-test-key');

		expect(response.headers.get('Content-Type')).toBe('text/event-stream');

		// Read the stream
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let fullText = '';
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			fullText += decoder.decode(value, { stream: true });
		}

		expect(fullText).toContain('message_start');
		expect(fullText).toContain('text_delta');
		expect(fullText).toContain('Hi');
		expect(fullText).toContain('message_stop');
	});

	it('should sanitize nested text.text bug in messages', async () => {
		let capturedBody: any = null;

		globalThis.fetch = async (_url: any, init: any) => {
			capturedBody = JSON.parse(init.body);
			return new Response(JSON.stringify({
				type: 'message', content: [{ type: 'text', text: 'ok' }],
			}), { status: 200 });
		};

		const request = new Request('http://localhost/v1/messages', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'claude-haiku-4-5-20251001',
				max_tokens: 100,
				messages: [{
					role: 'user',
					content: [{ type: 'text', text: { text: 'nested bug' } }],
				}],
			}),
		});

		await proxyToAnthropic(request, 'sk-ant-test-key');

		// The sanitization should have fixed the nested text
		expect(capturedBody.messages[0].content[0].text).toBe('nested bug');
		expect(typeof capturedBody.messages[0].content[0].text).toBe('string');
	});

	it('should pass through Anthropic error format on non-200', async () => {
		globalThis.fetch = async () => {
			return new Response(JSON.stringify({
				type: 'error',
				error: {
					type: 'invalid_request_error',
					message: 'max_tokens: must be at least 1',
				},
			}), { status: 400, headers: { 'Content-Type': 'application/json' } });
		};

		const request = new Request('http://localhost/v1/messages', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'claude-opus-4-6',
				max_tokens: 0,
				messages: [{ role: 'user', content: 'test' }],
			}),
		});

		const response = await proxyToAnthropic(request, 'sk-ant-test-key');
		expect(response.status).toBe(400);

		const data: any = await response.json();
		expect(data.type).toBe('error');
		expect(data.error.type).toBe('invalid_request_error');
	});

	it('should return 503 for spending limit errors instead of raw 400', async () => {
		globalThis.fetch = async () => {
			return new Response(JSON.stringify({
				type: 'error',
				error: {
					type: 'invalid_request_error',
					message: 'You have reached your specified monthly spending limit for this API key.',
				},
			}), { status: 400, headers: { 'Content-Type': 'application/json' } });
		};

		const request = new Request('http://localhost/v1/messages', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'claude-opus-4-6',
				max_tokens: 100,
				messages: [{ role: 'user', content: 'test' }],
			}),
		});

		const response = await proxyToAnthropic(request, 'sk-ant-test-key');
		expect(response.status).toBe(503);
		expect(response.headers.get('Retry-After')).toBe('60');

		const data: any = await response.json();
		expect(data.error.type).toBe('overloaded_error');
		expect(data.error.message).toContain('temporarily at capacity');
	});

	it('should return 429 for rate limit errors', async () => {
		globalThis.fetch = async () => {
			return new Response(JSON.stringify({
				type: 'error',
				error: {
					type: 'rate_limit_error',
					message: 'Rate limited',
				},
			}), { status: 429, headers: { 'Content-Type': 'application/json' } });
		};

		const request = new Request('http://localhost/v1/messages', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'claude-opus-4-6',
				max_tokens: 100,
				messages: [{ role: 'user', content: 'test' }],
			}),
		});

		const response = await proxyToAnthropic(request, 'sk-ant-test-key');
		expect(response.status).toBe(429);
		expect(response.headers.get('Retry-After')).toBe('30');
	});

	it('should handle network/fetch errors gracefully', async () => {
		globalThis.fetch = async () => {
			throw new Error('Network timeout');
		};

		const request = new Request('http://localhost/v1/messages', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'claude-opus-4-6',
				max_tokens: 100,
				messages: [{ role: 'user', content: 'test' }],
			}),
		});

		const response = await proxyToAnthropic(request, 'sk-ant-test-key');
		expect(response.status).toBe(500);

		const data: any = await response.json();
		expect(data.type).toBe('error');
		expect(data.error.message).toContain('Network timeout');
	});

	it('should not add anthropic_version in body (Vertex did this, direct API uses header)', async () => {
		let capturedBody: any = null;

		globalThis.fetch = async (_url: any, init: any) => {
			capturedBody = JSON.parse(init.body);
			return new Response(JSON.stringify({ type: 'message', content: [] }), { status: 200 });
		};

		const request = new Request('http://localhost/v1/messages', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'claude-opus-4-6',
				max_tokens: 100,
				messages: [{ role: 'user', content: 'test' }],
			}),
		});

		await proxyToAnthropic(request, 'sk-ant-test-key');

		// Vertex added anthropic_version to body — direct API should NOT
		expect(capturedBody.anthropic_version).toBeUndefined();
	});

	it('should keep model in request body (Vertex removed it)', async () => {
		let capturedBody: any = null;

		globalThis.fetch = async (_url: any, init: any) => {
			capturedBody = JSON.parse(init.body);
			return new Response(JSON.stringify({ type: 'message', content: [] }), { status: 200 });
		};

		const request = new Request('http://localhost/v1/messages', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'claude-opus-4-6',
				max_tokens: 100,
				messages: [{ role: 'user', content: 'test' }],
			}),
		});

		await proxyToAnthropic(request, 'sk-ant-test-key');

		// Vertex deleted model from body — direct API must keep it
		expect(capturedBody.model).toBe('claude-opus-4-6');
	});

	it('should handle tool use messages correctly', async () => {
		let capturedBody: any = null;

		globalThis.fetch = async (_url: any, init: any) => {
			capturedBody = JSON.parse(init.body);
			return new Response(JSON.stringify({ type: 'message', content: [] }), { status: 200 });
		};

		const request = new Request('http://localhost/v1/messages', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'claude-opus-4-6',
				max_tokens: 1024,
				messages: [
					{ role: 'user', content: 'Search for info' },
					{
						role: 'assistant',
						content: [
							{ type: 'text', text: 'Let me search.' },
							{ type: 'tool_use', id: 'toolu_1', name: 'search', input: { query: 'test' } },
						],
					},
					{
						role: 'user',
						content: [
							{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Found: results' },
						],
					},
				],
			}),
		});

		await proxyToAnthropic(request, 'sk-ant-test-key');

		// Tool messages should pass through as-is (Anthropic format → Anthropic API)
		expect(capturedBody.messages[1].content[1].type).toBe('tool_use');
		expect(capturedBody.messages[2].content[0].type).toBe('tool_result');
	});

	it('should pass through system parameter', async () => {
		let capturedBody: any = null;

		globalThis.fetch = async (_url: any, init: any) => {
			capturedBody = JSON.parse(init.body);
			return new Response(JSON.stringify({ type: 'message', content: [] }), { status: 200 });
		};

		const request = new Request('http://localhost/v1/messages', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'claude-opus-4-6',
				max_tokens: 100,
				system: 'You are a helpful assistant.',
				messages: [{ role: 'user', content: 'Hello' }],
			}),
		});

		await proxyToAnthropic(request, 'sk-ant-test-key');

		// System parameter should be passed through as-is
		expect(capturedBody.system).toBe('You are a helpful assistant.');
	});
});

// ============================================================================
// listAnthropicModels
// ============================================================================
describe('listAnthropicModels', () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it('should return models from API response', async () => {
		globalThis.fetch = async (url: any, init: any) => {
			expect(url.toString()).toBe('https://api.anthropic.com/v1/models');
			expect(new Headers(init.headers).get('x-api-key')).toBe('sk-test');

			return new Response(JSON.stringify({
				data: [
					{ id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6', created_at: '2026-02-05T00:00:00Z', type: 'model' },
					{ id: 'claude-sonnet-4-5-20250929', display_name: 'Claude Sonnet 4.5', created_at: '2025-09-29T00:00:00Z', type: 'model' },
					{ id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5', created_at: '2025-10-01T00:00:00Z', type: 'model' },
				],
			}), { status: 200 });
		};

		const models = await listAnthropicModels('sk-test');

		expect(models.length).toBe(3);
		expect(models[0].id).toBe('claude-opus-4-6');
		expect(models[0].owned_by).toBe('anthropic');
		expect(models[0].object).toBe('model');
	});

	it('should return fallback models on API error', async () => {
		globalThis.fetch = async () => new Response('Unauthorized', { status: 401 });

		const models = await listAnthropicModels('bad-key');

		// Should return fallback list
		expect(models.length).toBeGreaterThan(0);
		expect(models.some(m => m.id.includes('opus-4-6'))).toBe(true);
		expect(models.some(m => m.id.includes('haiku'))).toBe(true);
	});

	it('should return fallback models on network error', async () => {
		globalThis.fetch = async () => { throw new Error('DNS fail'); };

		const models = await listAnthropicModels('sk-test');
		expect(models.length).toBeGreaterThan(0);
	});
});

// ============================================================================
// createProvider routing
// ============================================================================
describe('createProvider routing', () => {
	it('should route claude models to AnthropicProvider', () => {
		const env = {
			ANTHROPIC_API_KEY: 'sk-ant-test',
			VERTEX_SERVICE_ACCOUNT_JSON: '{}',
			VERTEX_PROJECT_ID: 'test',
		} as any;

		const provider = createProvider('claude-opus-4-6', env);
		expect(provider).toBeInstanceOf(AnthropicProvider);
	});

	it('should route claude-haiku to AnthropicProvider', () => {
		const env = { ANTHROPIC_API_KEY: 'sk-ant-test' } as any;
		const provider = createProvider('claude-haiku-4-5-20251001', env);
		expect(provider).toBeInstanceOf(AnthropicProvider);
	});

	it('should throw if ANTHROPIC_API_KEY missing for claude', () => {
		const env = {} as any;
		expect(() => createProvider('claude-opus-4-6', env)).toThrow('Anthropic API key not configured');
	});

	it('should route gemini models to GeminiProvider (not AnthropicProvider)', () => {
		const env = {
			ANTHROPIC_API_KEY: 'sk-ant-test',
			VERTEX_SERVICE_ACCOUNT_JSON: '{"type":"service_account","private_key":"-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBg...\\n-----END PRIVATE KEY-----\\n","client_email":"test@test.iam.gserviceaccount.com","token_uri":"https://oauth2.googleapis.com/token"}',
			VERTEX_PROJECT_ID: 'test-project',
		} as any;

		const provider = createProvider('gemini-3-flash', env);
		// Should NOT be AnthropicProvider
		expect(provider).not.toBeInstanceOf(AnthropicProvider);
	});
});

// ============================================================================
// AnthropicProvider.formatMessages — OpenAI ↔ Anthropic conversion
// ============================================================================
describe('AnthropicProvider.formatMessages', () => {
	const provider = new AnthropicProvider('sk-test');

	it('should skip system messages (they go to system parameter)', () => {
		const result = provider.formatMessages([
			{ role: 'system', content: 'You are helpful.' },
			{ role: 'user', content: 'Hi' },
		]);

		expect(result.length).toBe(1);
		expect(result[0].role).toBe('user');
	});

	it('should convert tool results from OpenAI to Anthropic format', () => {
		const result = provider.formatMessages([
			{ role: 'user', content: 'Search' },
			{
				role: 'assistant',
				content: 'Searching...',
				tool_calls: [{
					id: 'call_1',
					type: 'function' as const,
					function: { name: 'search', arguments: '{"q":"test"}' },
				}],
			},
			{
				role: 'tool',
				content: 'Found: result',
				tool_call_id: 'call_1',
			} as any,
		]);

		expect(result.length).toBe(3);

		// Assistant with tool_use
		expect(result[1].role).toBe('assistant');
		const assistantContent = result[1].content as any[];
		expect(assistantContent.some((c: any) => c.type === 'tool_use')).toBe(true);
		const toolUse = assistantContent.find((c: any) => c.type === 'tool_use');
		expect(toolUse.name).toBe('search');
		expect(toolUse.input).toEqual({ q: 'test' });

		// Tool result as user message
		expect(result[2].role).toBe('user');
		const toolResult = (result[2].content as any[])[0];
		expect(toolResult.type).toBe('tool_result');
		expect(toolResult.tool_use_id).toBe('call_1');
		expect(toolResult.content).toBe('Found: result');
	});

	it('should handle image_url content parts', () => {
		const result = provider.formatMessages([{
			role: 'user',
			content: [
				{ type: 'text', text: 'What is this?' },
				{
					type: 'image_url',
					image_url: { url: 'data:image/png;base64,iVBOR...' },
				},
			] as any,
		}]);

		expect(result.length).toBe(1);
		const content = result[0].content as any[];
		expect(content[0].type).toBe('text');
		expect(content[1].type).toBe('image');
		expect(content[1].source.type).toBe('base64');
		expect(content[1].source.media_type).toBe('image/png');
	});

	it('should handle string content messages', () => {
		const result = provider.formatMessages([
			{ role: 'user', content: 'Hello world' },
		]);

		expect(result.length).toBe(1);
		const content = result[0].content as any[];
		expect(content[0].type).toBe('text');
		expect(content[0].text).toBe('Hello world');
	});
});

// ============================================================================
// isModelAllowed — tier-based model access
// ============================================================================
describe('isModelAllowed with Anthropic model IDs', () => {
	it('should allow haiku for anonymous users', () => {
		expect(isModelAllowed('claude-haiku-4-5-20251001', 'anonymous')).toBe(true);
	});

	it('should deny opus for anonymous users', () => {
		expect(isModelAllowed('claude-opus-4-6', 'anonymous')).toBe(false);
	});

	it('should deny opus for logged_in users', () => {
		expect(isModelAllowed('claude-opus-4-6', 'logged_in')).toBe(false);
	});

	it('should allow opus for subscribed users', () => {
		expect(isModelAllowed('claude-opus-4-6', 'subscribed')).toBe(true);
	});

	it('should allow sonnet for logged_in users', () => {
		expect(isModelAllowed('claude-sonnet-4-5-20250929', 'logged_in')).toBe(true);
	});

	it('should allow any model for subscribed (wildcard)', () => {
		expect(isModelAllowed('claude-opus-4-6', 'subscribed')).toBe(true);
		expect(isModelAllowed('some-random-model', 'subscribed')).toBe(true);
	});

	it('should allow gemini flash for anonymous', () => {
		expect(isModelAllowed('gemini-2.5-flash', 'anonymous')).toBe(true);
	});
});

// ============================================================================
// Model ID format — no more @YYYYMMDD
// ============================================================================
describe('Model ID format consistency', () => {
	it('Opus 4.6 has no date suffix', () => {
		// The Anthropic API uses 'claude-opus-4-6' with no date suffix
		// This verifies our code doesn't break on models without dates
		const model = 'claude-opus-4-6';
		expect(model).not.toContain('@');
		expect(isModelAllowed(model, 'subscribed')).toBe(true);
	});

	it('Haiku still works with date suffix (dash format)', () => {
		const model = 'claude-haiku-4-5-20251001';
		expect(model).not.toContain('@');
		expect(isModelAllowed(model, 'anonymous')).toBe(true);
	});
});

// ============================================================================
// Backwards compatibility: old app sends @YYYYMMDD model IDs
// ============================================================================
describe('Backwards compatibility with @YYYYMMDD model IDs', () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it('proxyToAnthropic should normalize @ to - in model ID', async () => {
		let capturedBody: any = null;

		globalThis.fetch = async (_url: any, init: any) => {
			capturedBody = JSON.parse(init.body);
			return new Response(JSON.stringify({ type: 'message', content: [] }), { status: 200 });
		};

		const request = new Request('http://localhost/v1/messages', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'claude-haiku-4-5@20251001',
				max_tokens: 100,
				messages: [{ role: 'user', content: 'test' }],
			}),
		});

		await proxyToAnthropic(request, 'sk-ant-test-key');

		// The @ should be converted to - before sending to Anthropic API
		expect(capturedBody.model).toBe('claude-haiku-4-5-20251001');
	});

	it('proxyToAnthropic should not modify model IDs without @', async () => {
		let capturedBody: any = null;

		globalThis.fetch = async (_url: any, init: any) => {
			capturedBody = JSON.parse(init.body);
			return new Response(JSON.stringify({ type: 'message', content: [] }), { status: 200 });
		};

		const request = new Request('http://localhost/v1/messages', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'claude-opus-4-6',
				max_tokens: 100,
				messages: [{ role: 'user', content: 'test' }],
			}),
		});

		await proxyToAnthropic(request, 'sk-ant-test-key');

		expect(capturedBody.model).toBe('claude-opus-4-6');
	});

	it('proxyToAnthropic should handle opus @YYYYMMDD format', async () => {
		let capturedBody: any = null;

		globalThis.fetch = async (_url: any, init: any) => {
			capturedBody = JSON.parse(init.body);
			return new Response(JSON.stringify({ type: 'message', content: [] }), { status: 200 });
		};

		const request = new Request('http://localhost/v1/messages', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'claude-opus-4-5@20251101',
				max_tokens: 100,
				messages: [{ role: 'user', content: 'test' }],
			}),
		});

		await proxyToAnthropic(request, 'sk-ant-test-key');

		expect(capturedBody.model).toBe('claude-opus-4-5-20251101');
	});
});

// ============================================================================
// Regression: sanitizeMessages still works (from vertex.ts, shared)
// ============================================================================
describe('sanitizeMessages (shared)', () => {
	it('should fix nested text.text structure', () => {
		const messages = [
			{ role: 'user', content: [{ type: 'text', text: { text: 'Hello world' } }] },
		];
		const sanitized = sanitizeMessages(messages);
		expect(sanitized[0].content[0].text).toBe('Hello world');
		expect(typeof sanitized[0].content[0].text).toBe('string');
	});

	it('should not modify correctly formatted messages', () => {
		const messages = [
			{ role: 'user', content: 'Hello' },
			{ role: 'assistant', content: 'Hi there!' },
		];
		const sanitized = sanitizeMessages(messages);
		expect(sanitized[0].content).toBe('Hello');
		expect(sanitized[1].content).toBe('Hi there!');
	});

	it('should handle deeply nested text', () => {
		const messages = [
			{ role: 'user', content: [{ type: 'text', text: { text: { text: 'deep' } } }] },
		];
		const sanitized = sanitizeMessages(messages);
		expect(sanitized[0].content[0].text).toBe('deep');
	});
});
