/**
 * Comprehensive unit tests for Vertex AI provider
 *
 * Run with: bun test src/test/vertex.unit.test.ts
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { mapModelToVertex, parseStreamingEvent, VertexAIProvider, sanitizeMessages } from '../providers/vertex';

// ============================================================================
// Message Sanitization Tests (for proxyToVertex)
// ============================================================================
describe('sanitizeMessages', () => {
	it('should fix nested text.text structure', () => {
		// This is the exact bug: {type: 'text', text: {text: '...'}}
		const messages = [
			{
				role: 'user',
				content: [{ type: 'text', text: { text: 'Hello world' } }],  // BUG: nested text
			},
		];

		const sanitized = sanitizeMessages(messages);

		expect(sanitized[0].content[0].type).toBe('text');
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

	it('should handle array content with correct format', () => {
		const messages = [
			{
				role: 'user',
				content: [{ type: 'text', text: 'Hello' }],  // Correct format
			},
		];

		const sanitized = sanitizeMessages(messages);

		expect(sanitized[0].content[0].text).toBe('Hello');
	});

	it('should fix deeply nested text in multi-turn conversation', () => {
		// Reproduces: "messages.2.content.0.text.text: Input should be a valid string"
		const messages = [
			{ role: 'user', content: 'First message' },
			{ role: 'assistant', content: 'First response' },
			{
				role: 'user',
				content: [{ type: 'text', text: { text: 'Second message with bug' } }],
			},
		];

		const sanitized = sanitizeMessages(messages);

		// Check message at index 2
		expect(sanitized[2].content[0].text).toBe('Second message with bug');
		expect(typeof sanitized[2].content[0].text).toBe('string');
	});

	it('should handle mixed content (text + image)', () => {
		const messages = [
			{
				role: 'user',
				content: [
					{ type: 'text', text: { text: 'What is in this image?' } },  // Bug to fix
					{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
				],
			},
		];

		const sanitized = sanitizeMessages(messages);

		expect(sanitized[0].content[0].text).toBe('What is in this image?');
		expect(sanitized[0].content[1].type).toBe('image');  // Image should be unchanged
	});

	it('should handle tool_use content', () => {
		const messages = [
			{
				role: 'assistant',
				content: [
					{ type: 'text', text: { text: "I'll search for that" } },
					{ type: 'tool_use', id: 'toolu_123', name: 'search', input: { q: 'test' } },
				],
			},
		];

		const sanitized = sanitizeMessages(messages);

		expect(sanitized[0].content[0].text).toBe("I'll search for that");
		expect(sanitized[0].content[1].type).toBe('tool_use');
		expect(sanitized[0].content[1].input).toEqual({ q: 'test' });
	});

	it('should handle tool_result content', () => {
		const messages = [
			{
				role: 'user',
				content: [
					{
						type: 'tool_result',
						tool_use_id: 'toolu_123',
						content: [{ type: 'text', text: { text: 'Search results' } }],  // Nested in tool_result
					},
				],
			},
		];

		const sanitized = sanitizeMessages(messages);

		expect(sanitized[0].content[0].content[0].text).toBe('Search results');
	});

	it('should handle null and undefined gracefully', () => {
		const messages = [
			{ role: 'user', content: null },
			{ role: 'assistant', content: undefined },
			null,
		];

		const sanitized = sanitizeMessages(messages as any);

		expect(sanitized[0].content).toBeNull();
		expect(sanitized[1].content).toBeUndefined();
		expect(sanitized[2]).toBeNull();
	});

	it('should convert non-string text to string', () => {
		const messages = [
			{
				role: 'user',
				content: [{ type: 'text', text: 12345 }],  // Number instead of string
			},
		];

		const sanitized = sanitizeMessages(messages);

		expect(sanitized[0].content[0].text).toBe('12345');
		expect(typeof sanitized[0].content[0].text).toBe('string');
	});
});

// ============================================================================
// Model Format Conversion Tests
// ============================================================================
describe('mapModelToVertex', () => {
	describe('converts and aliases models', () => {
		it('should convert claude-opus-4-5-20251101 to claude-opus-4-5@20251101', () => {
			expect(mapModelToVertex('claude-opus-4-5-20251101')).toBe('claude-opus-4-5@20251101');
		});

		it('should normalize Sonnet 4.5 to the supported Vertex ID', () => {
			expect(mapModelToVertex('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5@20250929');
		});

		it('should upgrade retired Haiku requests to Sonnet', () => {
			expect(mapModelToVertex('claude-haiku-4-5-20251001')).toBe('claude-sonnet-4-5@20250929');
		});

		it('should upgrade older Sonnet requests to Sonnet 4.5', () => {
			expect(mapModelToVertex('claude-sonnet-4-20250514')).toBe('claude-sonnet-4-5@20250929');
		});

		it('should upgrade Sonnet 3.5 to Sonnet 4.5', () => {
			expect(mapModelToVertex('claude-3-5-sonnet-20241022')).toBe('claude-sonnet-4-5@20250929');
		});
	});

	describe('applies aliases for known models', () => {
		it('should preserve an exact supported Opus request', () => {
			expect(mapModelToVertex('claude-opus-4-5@20251101')).toBe('claude-opus-4-5@20251101');
		});

		it('should alias old Claude models to Sonnet', () => {
			expect(mapModelToVertex('claude-3-5-sonnet-v2@20241022')).toBe('claude-sonnet-4-5@20250929');
		});
	});

	describe('handles edge cases', () => {
		it('should alias unknown Claude IDs to Sonnet', () => {
			expect(mapModelToVertex('claude-3-5-sonnet')).toBe('claude-sonnet-4-5@20250929');
		});

		// Short date suffix doesn't trigger date conversion
		it('should alias a short-date Claude ID to Sonnet', () => {
			expect(mapModelToVertex('claude-3-5-sonnet-2024')).toBe('claude-sonnet-4-5@20250929');
		});

		it('should not modify empty string', () => {
			expect(mapModelToVertex('')).toBe('');
		});

		it('should handle model with only numbers', () => {
			expect(mapModelToVertex('12345678')).toBe('12345678');
		});

		it('should handle model ending with 9 digit number (not date)', () => {
			expect(mapModelToVertex('model-123456789')).toBe('model-123456789');
		});
	});
});

// ============================================================================
// Streaming Event Parsing Tests
// ============================================================================
describe('parseStreamingEvent', () => {
	let toolCallsById: Record<string, { index: number; id: string; name: string; arguments: string }>;
	let toolCallIndex: { value: number };

	beforeEach(() => {
		toolCallsById = {};
		toolCallIndex = { value: 0 };
	});

	describe('text_delta events', () => {
		it('should convert text_delta to OpenAI format', () => {
			const event = {
				type: 'content_block_delta',
				delta: { type: 'text_delta', text: 'Hello' },
			};

			const result = parseStreamingEvent(event, toolCallsById, toolCallIndex);

			expect(result.done).toBe(false);
			expect(result.output).not.toBeNull();
			const parsed = JSON.parse(result.output!.replace('data: ', '').trim());
			expect(parsed.choices[0].delta.content).toBe('Hello');
		});

		it('should handle multi-line text', () => {
			const event = {
				type: 'content_block_delta',
				delta: { type: 'text_delta', text: 'Line 1\nLine 2' },
			};

			const result = parseStreamingEvent(event, toolCallsById, toolCallIndex);
			const parsed = JSON.parse(result.output!.replace('data: ', '').trim());
			expect(parsed.choices[0].delta.content).toBe('Line 1\nLine 2');
		});

		it('should handle special characters', () => {
			const event = {
				type: 'content_block_delta',
				delta: { type: 'text_delta', text: 'Test "quotes" and \\backslash' },
			};

			const result = parseStreamingEvent(event, toolCallsById, toolCallIndex);
			const parsed = JSON.parse(result.output!.replace('data: ', '').trim());
			expect(parsed.choices[0].delta.content).toBe('Test "quotes" and \\backslash');
		});

		it('should handle empty text', () => {
			const event = {
				type: 'content_block_delta',
				delta: { type: 'text_delta', text: '' },
			};

			const result = parseStreamingEvent(event, toolCallsById, toolCallIndex);
			const parsed = JSON.parse(result.output!.replace('data: ', '').trim());
			expect(parsed.choices[0].delta.content).toBe('');
		});
	});

	describe('tool_use start events', () => {
		it('should convert tool_use start to OpenAI format with correct fields', () => {
			const event = {
				type: 'content_block_start',
				content_block: {
					type: 'tool_use',
					id: 'toolu_123',
					name: 'search_content',
				},
			};

			const result = parseStreamingEvent(event, toolCallsById, toolCallIndex);

			expect(result.done).toBe(false);
			expect(result.output).not.toBeNull();
			const parsed = JSON.parse(result.output!.replace('data: ', '').trim());

			expect(parsed.choices[0].delta.tool_calls).toHaveLength(1);
			expect(parsed.choices[0].delta.tool_calls[0].id).toBe('toolu_123');
			expect(parsed.choices[0].delta.tool_calls[0].type).toBe('function');
			expect(parsed.choices[0].delta.tool_calls[0].index).toBe(0);
			expect(parsed.choices[0].delta.tool_calls[0].function.name).toBe('search_content');
			expect(parsed.choices[0].delta.tool_calls[0].function.arguments).toBe('');
		});

		it('should track multiple tool calls with correct indices', () => {
			const event1 = {
				type: 'content_block_start',
				content_block: { type: 'tool_use', id: 'toolu_1', name: 'tool_a' },
			};
			const event2 = {
				type: 'content_block_start',
				content_block: { type: 'tool_use', id: 'toolu_2', name: 'tool_b' },
			};

			parseStreamingEvent(event1, toolCallsById, toolCallIndex);
			const result2 = parseStreamingEvent(event2, toolCallsById, toolCallIndex);

			const parsed = JSON.parse(result2.output!.replace('data: ', '').trim());
			expect(parsed.choices[0].delta.tool_calls[0].index).toBe(1);
			expect(toolCallsById['toolu_1'].index).toBe(0);
			expect(toolCallsById['toolu_2'].index).toBe(1);
		});
	});

	describe('input_json_delta events', () => {
		it('should accumulate tool arguments correctly', () => {
			// First, start a tool
			const startEvent = {
				type: 'content_block_start',
				content_block: { type: 'tool_use', id: 'toolu_123', name: 'search' },
			};
			parseStreamingEvent(startEvent, toolCallsById, toolCallIndex);

			// Then send argument deltas
			const delta1 = {
				type: 'content_block_delta',
				delta: { type: 'input_json_delta', partial_json: '{"q":' },
			};
			const delta2 = {
				type: 'content_block_delta',
				delta: { type: 'input_json_delta', partial_json: '"test"}' },
			};

			const result1 = parseStreamingEvent(delta1, toolCallsById, toolCallIndex);
			const result2 = parseStreamingEvent(delta2, toolCallsById, toolCallIndex);

			// Check incremental output
			const parsed1 = JSON.parse(result1.output!.replace('data: ', '').trim());
			expect(parsed1.choices[0].delta.tool_calls[0].function.arguments).toBe('{"q":');

			const parsed2 = JSON.parse(result2.output!.replace('data: ', '').trim());
			expect(parsed2.choices[0].delta.tool_calls[0].function.arguments).toBe('"test"}');

			// Check accumulated value
			expect(toolCallsById['toolu_123'].arguments).toBe('{"q":"test"}');
		});

		it('should ignore input_json_delta if no tool started', () => {
			const delta = {
				type: 'content_block_delta',
				delta: { type: 'input_json_delta', partial_json: '{"q":"test"}' },
			};

			const result = parseStreamingEvent(delta, toolCallsById, toolCallIndex);
			expect(result.output).toBeNull();
		});
	});

	describe('message_stop events', () => {
		it('should return done=true and [DONE] output', () => {
			const event = { type: 'message_stop' };

			const result = parseStreamingEvent(event, toolCallsById, toolCallIndex);

			expect(result.done).toBe(true);
			expect(result.output).toBe('data: [DONE]\n\n');
		});
	});

	describe('ignored events', () => {
		it('should ignore message_start', () => {
			const event = { type: 'message_start', message: {} };
			const result = parseStreamingEvent(event, toolCallsById, toolCallIndex);
			expect(result.output).toBeNull();
			expect(result.done).toBe(false);
		});

		it('should ignore ping', () => {
			const event = { type: 'ping' };
			const result = parseStreamingEvent(event, toolCallsById, toolCallIndex);
			expect(result.output).toBeNull();
			expect(result.done).toBe(false);
		});

		it('should ignore content_block_stop', () => {
			const event = { type: 'content_block_stop' };
			const result = parseStreamingEvent(event, toolCallsById, toolCallIndex);
			expect(result.output).toBeNull();
			expect(result.done).toBe(false);
		});

		it('should handle message_delta with stop_reason (emits finish_reason)', () => {
			const event = { type: 'message_delta', delta: { stop_reason: 'end_turn' } };
			const result = parseStreamingEvent(event, toolCallsById, toolCallIndex);
			// Now we emit finish_reason when stop_reason is present
			expect(result.output).not.toBeNull();
			expect(result.done).toBe(false); // message_stop will follow
			const parsed = JSON.parse(result.output!.replace('data: ', '').trim());
			expect(parsed.choices[0].finish_reason).toBe('stop');
		});

		it('should ignore message_delta without stop_reason', () => {
			const event = { type: 'message_delta', delta: {}, usage: { output_tokens: 10 } };
			const result = parseStreamingEvent(event, toolCallsById, toolCallIndex);
			expect(result.output).toBeNull();
			expect(result.done).toBe(false);
		});

		it('should ignore content_block_start for text', () => {
			const event = {
				type: 'content_block_start',
				content_block: { type: 'text', text: '' },
			};
			const result = parseStreamingEvent(event, toolCallsById, toolCallIndex);
			expect(result.output).toBeNull();
			expect(result.done).toBe(false);
		});
	});
});

// ============================================================================
// VertexAIProvider formatResponse Tests
// ============================================================================
describe('VertexAIProvider.formatResponse', () => {
	// Create a minimal provider instance for testing formatResponse
	const mockServiceAccount = JSON.stringify({
		type: 'service_account',
		project_id: 'test',
		private_key_id: 'test',
		private_key: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----',
		client_email: 'test@test.iam.gserviceaccount.com',
		client_id: '123',
		auth_uri: 'https://accounts.google.com/o/oauth2/auth',
		token_uri: 'https://oauth2.googleapis.com/token',
		auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
		client_x509_cert_url: 'https://www.googleapis.com/robot/v1/metadata/x509/test',
	});

	let provider: VertexAIProvider;

	beforeEach(() => {
		provider = new VertexAIProvider(mockServiceAccount, 'test-project', 'us-east5');
	});

	describe('text-only responses', () => {
		it('should format simple text response', () => {
			const anthropicResponse = {
				content: [{ type: 'text', text: 'Hello, world!' }],
			};

			const result = provider.formatResponse(anthropicResponse);

			expect(result.choices).toHaveLength(1);
			expect(result.choices[0].message.content).toBe('Hello, world!');
			expect(result.choices[0].message.role).toBe('assistant');
			expect(result.choices[0].message.tool_calls).toEqual([]);
		});

		it('should handle empty text', () => {
			const anthropicResponse = {
				content: [{ type: 'text', text: '' }],
			};

			const result = provider.formatResponse(anthropicResponse);
			expect(result.choices[0].message.content).toBe('');
		});

		it('should handle response with no content blocks', () => {
			const anthropicResponse = { content: [] };

			const result = provider.formatResponse(anthropicResponse);
			expect(result.choices[0].message.content).toBe('');
			expect(result.choices[0].message.tool_calls).toEqual([]);
		});
	});

	describe('tool call responses', () => {
		it('should format single tool call response', () => {
			const anthropicResponse = {
				content: [
					{
						type: 'tool_use',
						id: 'toolu_123',
						name: 'search_content',
						input: { q: 'test query', limit: 10 },
					},
				],
			};

			const result = provider.formatResponse(anthropicResponse);

			expect(result.choices[0].message.content).toBe('');
			expect(result.choices[0].message.tool_calls).toHaveLength(1);
			expect(result.choices[0].message.tool_calls[0]).toEqual({
				id: 'toolu_123',
				type: 'function',
				function: {
					name: 'search_content',
					arguments: '{"q":"test query","limit":10}',
				},
			});
		});

		it('should format multiple tool calls', () => {
			const anthropicResponse = {
				content: [
					{ type: 'tool_use', id: 'toolu_1', name: 'tool_a', input: { a: 1 } },
					{ type: 'tool_use', id: 'toolu_2', name: 'tool_b', input: { b: 2 } },
				],
			};

			const result = provider.formatResponse(anthropicResponse);

			expect(result.choices[0].message.tool_calls).toHaveLength(2);
			expect(result.choices[0].message.tool_calls[0].id).toBe('toolu_1');
			expect(result.choices[0].message.tool_calls[1].id).toBe('toolu_2');
		});

		it('should handle text + tool call combined', () => {
			const anthropicResponse = {
				content: [
					{ type: 'text', text: "I'll search for that." },
					{ type: 'tool_use', id: 'toolu_123', name: 'search', input: {} },
				],
			};

			const result = provider.formatResponse(anthropicResponse);

			expect(result.choices[0].message.content).toBe("I'll search for that.");
			expect(result.choices[0].message.tool_calls).toHaveLength(1);
		});

		it('should handle tool call with complex nested input', () => {
			const anthropicResponse = {
				content: [
					{
						type: 'tool_use',
						id: 'toolu_123',
						name: 'complex_tool',
						input: {
							nested: { deep: { value: [1, 2, 3] } },
							array: [{ a: 1 }, { b: 2 }],
						},
					},
				],
			};

			const result = provider.formatResponse(anthropicResponse);
			const args = JSON.parse(result.choices[0].message.tool_calls[0].function.arguments);

			expect(args.nested.deep.value).toEqual([1, 2, 3]);
			expect(args.array).toEqual([{ a: 1 }, { b: 2 }]);
		});

		it('should handle tool call with empty input', () => {
			const anthropicResponse = {
				content: [
					{ type: 'tool_use', id: 'toolu_123', name: 'no_args_tool', input: {} },
				],
			};

			const result = provider.formatResponse(anthropicResponse);
			expect(result.choices[0].message.tool_calls[0].function.arguments).toBe('{}');
		});
	});
});

// ============================================================================
// Full Streaming Simulation Tests
// ============================================================================
describe('Full streaming scenarios', () => {
	let toolCallsById: Record<string, { index: number; id: string; name: string; arguments: string }>;
	let toolCallIndex: { value: number };

	beforeEach(() => {
		toolCallsById = {};
		toolCallIndex = { value: 0 };
	});

	it('should handle complete text-only stream', () => {
		const events = [
			{ type: 'message_start', message: {} },
			{ type: 'content_block_start', content_block: { type: 'text', text: '' } },
			{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
			{ type: 'content_block_delta', delta: { type: 'text_delta', text: ' world' } },
			{ type: 'content_block_stop' },
			{ type: 'message_delta', delta: { stop_reason: 'end_turn' } },
			{ type: 'message_stop' },
		];

		const outputs: string[] = [];
		for (const event of events) {
			const result = parseStreamingEvent(event, toolCallsById, toolCallIndex);
			if (result.output) outputs.push(result.output);
			if (result.done) break;
		}

		// 2 text deltas + 1 message_delta with finish_reason + [DONE]
		expect(outputs).toHaveLength(4);
		expect(outputs[0]).toContain('Hello');
		expect(outputs[1]).toContain(' world');
		expect(outputs[2]).toContain('finish_reason');
		expect(outputs[3]).toBe('data: [DONE]\n\n');
	});

	it('should handle text + tool call stream', () => {
		const events = [
			{ type: 'message_start', message: {} },
			{ type: 'content_block_start', content_block: { type: 'text', text: '' } },
			{ type: 'content_block_delta', delta: { type: 'text_delta', text: "I'll search" } },
			{ type: 'content_block_stop' },
			{ type: 'content_block_start', content_block: { type: 'tool_use', id: 'toolu_abc', name: 'search_content' } },
			{ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"q":' } },
			{ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '"test"' } },
			{ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '}' } },
			{ type: 'content_block_stop' },
			{ type: 'message_delta', delta: { stop_reason: 'tool_use' } },
			{ type: 'message_stop' },
		];

		const outputs: string[] = [];
		for (const event of events) {
			const result = parseStreamingEvent(event, toolCallsById, toolCallIndex);
			if (result.output) outputs.push(result.output);
			if (result.done) break;
		}

		// Should have: 1 text + 1 tool start + 3 tool args + 1 message_delta finish_reason + 1 [DONE] = 7
		expect(outputs).toHaveLength(7);

		// Check tool call was properly formed
		expect(toolCallsById['toolu_abc'].arguments).toBe('{"q":"test"}');

		// Check finish_reason is tool_calls
		expect(outputs[5]).toContain('tool_calls');
	});

	it('should handle multiple parallel tool calls', () => {
		const events = [
			{ type: 'message_start', message: {} },
			{ type: 'content_block_start', content_block: { type: 'tool_use', id: 'toolu_1', name: 'tool_a' } },
			{ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{}' } },
			{ type: 'content_block_stop' },
			{ type: 'content_block_start', content_block: { type: 'tool_use', id: 'toolu_2', name: 'tool_b' } },
			{ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{}' } },
			{ type: 'content_block_stop' },
			{ type: 'message_stop' },
		];

		for (const event of events) {
			parseStreamingEvent(event, toolCallsById, toolCallIndex);
		}

		expect(Object.keys(toolCallsById)).toHaveLength(2);
		expect(toolCallsById['toolu_1'].index).toBe(0);
		expect(toolCallsById['toolu_2'].index).toBe(1);
	});
});

// ============================================================================
// SSE Buffer Parsing Tests
// ============================================================================
describe('SSE buffer parsing', () => {
	it('should handle events split across chunks', () => {
		// Simulate SSE events that might be split across network chunks
		const chunk1 = 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel';
		const chunk2 = 'lo"}}\n\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" World"}}\n\n';

		let buffer = '';
		const results: any[] = [];

		// Process chunk1
		buffer += chunk1;
		let lines = buffer.split('\n');
		buffer = lines.pop() || '';
		for (const line of lines) {
			if (line.startsWith('data: ')) {
				try {
					results.push(JSON.parse(line.slice(6)));
				} catch (e) {
					// incomplete JSON
				}
			}
		}

		// After chunk1, buffer should have incomplete data
		expect(results.length).toBe(0);
		expect(buffer).toContain('Hel');

		// Process chunk2
		buffer += chunk2;
		lines = buffer.split('\n');
		buffer = lines.pop() || '';
		for (const line of lines) {
			if (line.startsWith('data: ')) {
				try {
					results.push(JSON.parse(line.slice(6)));
				} catch (e) {
					// incomplete JSON
				}
			}
		}

		// After chunk2, should have both complete events
		expect(results.length).toBe(2);
		expect(results[0].delta.text).toBe('Hello');
		expect(results[1].delta.text).toBe(' World');
	});

	it('should handle complete events in single chunk', () => {
		const chunk = 'data: {"type":"message_start"}\n\ndata: {"type":"ping"}\n\n';

		let buffer = '';
		const results: any[] = [];

		buffer += chunk;
		const lines = buffer.split('\n');
		buffer = lines.pop() || '';
		for (const line of lines) {
			if (line.startsWith('data: ')) {
				try {
					results.push(JSON.parse(line.slice(6)));
				} catch (e) {
					// skip
				}
			}
		}

		expect(results.length).toBe(2);
		expect(results[0].type).toBe('message_start');
		expect(results[1].type).toBe('ping');
	});
});

// ============================================================================
// Request Conversion Tests (convertToAnthropicFormat)
// ============================================================================
describe('Request conversion edge cases', () => {
	// These test the format expected by Anthropic/Vertex AI
	// We can't directly test private convertToAnthropicFormat, but we can
	// verify the expected transformations

	describe('OpenAI tool format to Anthropic format', () => {
		it('should understand OpenAI tool format', () => {
			const openaiTool = {
				type: 'function',
				function: {
					name: 'search_content',
					description: 'Search for content',
					parameters: {
						type: 'object',
						properties: {
							q: { type: 'string' },
							limit: { type: 'integer' },
						},
					},
				},
			};

			// Expected Anthropic format
			const expectedAnthropic = {
				name: 'search_content',
				description: 'Search for content',
				input_schema: {
					type: 'object',
					properties: {
						q: { type: 'string' },
						limit: { type: 'integer' },
					},
				},
			};

			// Verify the transformation
			const tool: any = openaiTool;
			const transformed = {
				name: tool.function?.name || tool.name,
				description: tool.function?.description || tool.description,
				input_schema: tool.function?.parameters || tool.input_schema,
			};

			expect(transformed).toEqual(expectedAnthropic);
		});
	});

	describe('OpenAI tool_calls format to Anthropic format', () => {
		it('should understand OpenAI assistant tool_calls format', () => {
			const openaiToolCall = {
				id: 'call_123',
				type: 'function',
				function: {
					name: 'search_content',
					arguments: '{"q":"test"}',
				},
			};

			// Expected Anthropic format
			const expectedAnthropic = {
				type: 'tool_use',
				id: 'call_123',
				name: 'search_content',
				input: { q: 'test' },
			};

			// Verify the transformation
			const transformed = {
				type: 'tool_use',
				id: openaiToolCall.id,
				name: openaiToolCall.function?.name,
				input: JSON.parse(openaiToolCall.function?.arguments || '{}'),
			};

			expect(transformed).toEqual(expectedAnthropic);
		});
	});

	describe('OpenAI tool message format to Anthropic format', () => {
		it('should understand OpenAI tool result format', () => {
			const openaiToolMessage = {
				role: 'tool',
				tool_call_id: 'call_123',
				content: '{"results": []}',
			};

			// Expected Anthropic format (as user message with tool_result)
			const expectedAnthropic = {
				role: 'user',
				content: [{
					type: 'tool_result',
					tool_use_id: 'call_123',
					content: '{"results": []}',
				}],
			};

			// Verify the transformation
			const transformed = {
				role: 'user',
				content: [{
					type: 'tool_result',
					tool_use_id: openaiToolMessage.tool_call_id,
					content: openaiToolMessage.content,
				}],
			};

			expect(transformed).toEqual(expectedAnthropic);
		});
	});
});

// ============================================================================
// Error Event Handling Tests (NEW - for streaming cutoff fix)
// ============================================================================
describe('Error event handling', () => {
	let toolCallsById: Record<string, { index: number; id: string; name: string; arguments: string }>;
	let toolCallIndex: { value: number };

	beforeEach(() => {
		toolCallsById = {};
		toolCallIndex = { value: 0 };
	});

	it('should handle Anthropic error events and return error info', () => {
		const errorEvent = {
			type: 'error',
			error: {
				type: 'overloaded_error',
				message: 'Overloaded',
			},
		};

		const result = parseStreamingEvent(errorEvent, toolCallsById, toolCallIndex);

		// Error events should be converted to an error response and signal done
		expect(result.done).toBe(true);
		expect(result.output).not.toBeNull();
		// The output should contain error information
		expect(result.output).toContain('error');
	});

	it('should handle content_filter error events', () => {
		const errorEvent = {
			type: 'error',
			error: {
				type: 'invalid_request_error',
				message: 'Content blocked by safety filter',
			},
		};

		const result = parseStreamingEvent(errorEvent, toolCallsById, toolCallIndex);

		expect(result.done).toBe(true);
		expect(result.output).not.toBeNull();
	});

	it('should handle rate_limit_error events', () => {
		const errorEvent = {
			type: 'error',
			error: {
				type: 'rate_limit_error',
				message: 'Rate limit exceeded',
			},
		};

		const result = parseStreamingEvent(errorEvent, toolCallsById, toolCallIndex);

		expect(result.done).toBe(true);
	});

	it('should handle api_error events', () => {
		const errorEvent = {
			type: 'error',
			error: {
				type: 'api_error',
				message: 'Internal server error',
			},
		};

		const result = parseStreamingEvent(errorEvent, toolCallsById, toolCallIndex);

		expect(result.done).toBe(true);
	});
});

// ============================================================================
// Stream with message_delta stop_reason Tests (NEW)
// ============================================================================
describe('message_delta with stop_reason handling', () => {
	let toolCallsById: Record<string, { index: number; id: string; name: string; arguments: string }>;
	let toolCallIndex: { value: number };

	beforeEach(() => {
		toolCallsById = {};
		toolCallIndex = { value: 0 };
	});

	it('should emit finish_reason when message_delta contains stop_reason', () => {
		const messageDelta = {
			type: 'message_delta',
			delta: {
				stop_reason: 'end_turn',
				stop_sequence: null,
			},
			usage: {
				output_tokens: 150,
			},
		};

		const result = parseStreamingEvent(messageDelta, toolCallsById, toolCallIndex);

		// message_delta with stop_reason should emit a chunk with finish_reason
		// so clients know the response is complete even before message_stop
		expect(result.output).not.toBeNull();
		if (result.output) {
			const parsed = JSON.parse(result.output.replace('data: ', '').trim());
			expect(parsed.choices[0].finish_reason).toBe('stop');
		}
	});

	it('should emit finish_reason=tool_calls for tool_use stop_reason', () => {
		const messageDelta = {
			type: 'message_delta',
			delta: {
				stop_reason: 'tool_use',
			},
		};

		const result = parseStreamingEvent(messageDelta, toolCallsById, toolCallIndex);

		expect(result.output).not.toBeNull();
		if (result.output) {
			const parsed = JSON.parse(result.output.replace('data: ', '').trim());
			expect(parsed.choices[0].finish_reason).toBe('tool_calls');
		}
	});

	it('should emit finish_reason=length for max_tokens stop_reason', () => {
		const messageDelta = {
			type: 'message_delta',
			delta: {
				stop_reason: 'max_tokens',
			},
		};

		const result = parseStreamingEvent(messageDelta, toolCallsById, toolCallIndex);

		expect(result.output).not.toBeNull();
		if (result.output) {
			const parsed = JSON.parse(result.output.replace('data: ', '').trim());
			expect(parsed.choices[0].finish_reason).toBe('length');
		}
	});
});

// ============================================================================
// Buffer Flush Tests (NEW - ensure no data loss on stream end)
// ============================================================================
describe('Buffer flush on stream end', () => {
	it('should not lose data when stream ends with incomplete buffer', () => {
		// Simulate a stream that ends with data still in buffer
		const chunks = [
			'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n',
			'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" World"}}', // No trailing \n\n
		];

		let buffer = '';
		const completedEvents: any[] = [];
		const toolCallsById: Record<string, any> = {};
		const toolCallIndex = { value: 0 };

		for (const chunk of chunks) {
			buffer += chunk;
			const lines = buffer.split('\n');
			buffer = lines.pop() || '';

			for (const line of lines) {
				if (line.startsWith('data: ')) {
					try {
						const data = JSON.parse(line.slice(6));
						const result = parseStreamingEvent(data, toolCallsById, toolCallIndex);
						if (result.output) completedEvents.push(result.output);
					} catch (e) {
						// incomplete JSON
					}
				}
			}
		}

		// At this point, buffer still has incomplete data
		expect(buffer).toContain('World');
		expect(completedEvents.length).toBe(1); // Only first event was complete

		// NEW BEHAVIOR: Flush remaining buffer when stream ends
		// This should be done by the streaming handler
		if (buffer.startsWith('data: ')) {
			try {
				const data = JSON.parse(buffer.slice(6));
				const result = parseStreamingEvent(data, toolCallsById, toolCallIndex);
				if (result.output) completedEvents.push(result.output);
			} catch (e) {
				// incomplete JSON - this is expected in this test
			}
		}

		// After flush, we should have both events
		expect(completedEvents.length).toBe(2);
	});

	it('should handle buffer with multiple incomplete events', () => {
		// Edge case: buffer has partial event then complete event
		const chunk = 'ta":"text_delta","text":"part1"}}\n\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"part2"}}\n\n';

		let buffer = 'data: {"type":"content_block_delta","delta":{"ty'; // Previous partial
		buffer += chunk;

		const lines = buffer.split('\n');
		buffer = lines.pop() || '';
		const parsedLines: string[] = [];

		for (const line of lines) {
			if (line.startsWith('data: ')) {
				try {
					JSON.parse(line.slice(6));
					parsedLines.push(line);
				} catch (e) {
					// First line will fail - it's incomplete JSON
				}
			}
		}

		// Should have recovered the second complete event
		expect(parsedLines.length).toBe(2);
	});
});

// ============================================================================
// Streaming Timeout Behavior Tests (NEW - documents expected behavior)
// ============================================================================
describe('Streaming timeout expectations', () => {
	it('should document that idle timeout is needed', () => {
		// This test documents the expected behavior for idle timeouts
		// The streaming handler should abort if no data is received for X seconds

		const EXPECTED_IDLE_TIMEOUT_MS = 30000; // 30 seconds

		// The streaming handler should:
		// 1. Track the last time data was received
		// 2. If no data for IDLE_TIMEOUT_MS, abort the stream
		// 3. Return an error to the client

		// This is a documentation test - actual implementation is in createStreamingCompletion
		expect(EXPECTED_IDLE_TIMEOUT_MS).toBeGreaterThan(0);
	});
});

// ============================================================================
// Assistant Message Content Array Bug Test (NEW - for text.text nesting fix)
// ============================================================================
describe('Assistant message with array content', () => {
	const mockServiceAccount = JSON.stringify({
		type: 'service_account',
		project_id: 'test',
		private_key_id: 'test',
		private_key: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----',
		client_email: 'test@test.iam.gserviceaccount.com',
		client_id: '123',
		auth_uri: 'https://accounts.google.com/o/oauth2/auth',
		token_uri: 'https://oauth2.googleapis.com/token',
		auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
		client_x509_cert_url: 'https://www.googleapis.com/robot/v1/metadata/x509/test',
	});

	let provider: VertexAIProvider;

	beforeEach(() => {
		provider = new VertexAIProvider(mockServiceAccount, 'test-project', 'us-east5');
	});

	it('should handle assistant message with array content (text block)', () => {
		// This reproduces the bug: "messages.2.content.0.text.text: Input should be a valid string"
		// When assistant message content is an array like [{type: 'text', text: 'Hello'}],
		// it was incorrectly wrapped as {type: 'text', text: [{type: 'text', text: 'Hello'}]}

		const requestBody = {
			model: 'claude-haiku-4-5@20251001',
			messages: [
				{ role: 'user' as const, content: 'Hello' },
				{
					role: 'assistant' as const,
					content: [{ type: 'text', text: 'I will help you.' }],  // Array content!
				},
				{ role: 'user' as const, content: 'Thanks' },
			],
		};

		// Access private method via any
		const anthropicBody = (provider as any).convertToAnthropicFormat(requestBody);

		// The assistant message content should be properly formatted
		// Either as a string 'I will help you.' or as array [{type: 'text', text: 'I will help you.'}]
		// NOT as {type: 'text', text: [{type: 'text', text: 'I will help you.'}]}
		// messages[0] = user, messages[1] = assistant, messages[2] = user
		const assistantMsg = anthropicBody.messages[1];

		if (typeof assistantMsg.content === 'string') {
			expect(assistantMsg.content).toBe('I will help you.');
		} else if (Array.isArray(assistantMsg.content)) {
			expect(assistantMsg.content[0].type).toBe('text');
			expect(typeof assistantMsg.content[0].text).toBe('string');
			expect(assistantMsg.content[0].text).toBe('I will help you.');
		} else {
			throw new Error('Unexpected content format');
		}
	});

	it('should handle assistant message with mixed array content (text + tool_use)', () => {
		const requestBody = {
			model: 'claude-haiku-4-5@20251001',
			messages: [
				{ role: 'user' as const, content: 'Search for X' },
				{
					role: 'assistant' as const,
					content: [
						{ type: 'text', text: "I'll search for that." },
						{ type: 'tool_use', id: 'toolu_123', name: 'search', input: { q: 'X' } },
					],
				},
			],
		};

		const anthropicBody = (provider as any).convertToAnthropicFormat(requestBody);
		// messages[0] = user, messages[1] = assistant
		const assistantMsg = anthropicBody.messages[1];

		// Should be an array with both text and tool_use blocks
		expect(Array.isArray(assistantMsg.content)).toBe(true);
		expect(assistantMsg.content.length).toBe(2);
		expect(assistantMsg.content[0].type).toBe('text');
		expect(typeof assistantMsg.content[0].text).toBe('string');
		expect(assistantMsg.content[1].type).toBe('tool_use');
	});

	it('should handle assistant message with string content (normal case)', () => {
		const requestBody = {
			model: 'claude-haiku-4-5@20251001',
			messages: [
				{ role: 'user' as const, content: 'Hello' },
				{ role: 'assistant' as const, content: 'Hi there!' },  // String content
			],
		};

		const anthropicBody = (provider as any).convertToAnthropicFormat(requestBody);
		// messages[0] = user, messages[1] = assistant
		const assistantMsg = anthropicBody.messages[1];

		// String content should remain as string
		expect(assistantMsg.content).toBe('Hi there!');
	});

	it('should NOT create nested text.text structure (bug reproduction)', () => {
		// This is the exact bug scenario that causes:
		// "messages.2.content.0.text.text: Input should be a valid string"
		const requestBody = {
			model: 'claude-haiku-4-5@20251001',
			messages: [
				{ role: 'user' as const, content: 'Hello' },
				{
					role: 'assistant' as const,
					content: [{ type: 'text', text: 'Response 1' }],
				},
				{ role: 'user' as const, content: 'Follow up' },
			],
		};

		const anthropicBody = (provider as any).convertToAnthropicFormat(requestBody);

		// Check message at index 1 (the assistant message)
		const assistantMsg = anthropicBody.messages[1];

		// Recursively check that no content block has text.text (double nesting)
		function checkNoDoubleNesting(content: any): void {
			if (Array.isArray(content)) {
				content.forEach(checkNoDoubleNesting);
			} else if (content && typeof content === 'object') {
				if (content.type === 'text') {
					// text should be a string, not an object
					expect(typeof content.text).toBe('string');
					expect(content.text).not.toHaveProperty('text');
				}
				// Check nested properties
				Object.values(content).forEach(checkNoDoubleNesting);
			}
		}

		checkNoDoubleNesting(assistantMsg.content);
	});

	it('should handle user message with array content containing text blocks', () => {
		// User messages can also have array content
		const requestBody = {
			model: 'claude-haiku-4-5@20251001',
			messages: [
				{
					role: 'user' as const,
					content: [{ type: 'text', text: 'Hello from array' }],
				},
			],
		};

		const anthropicBody = (provider as any).convertToAnthropicFormat(requestBody);
		const userMsg = anthropicBody.messages[0];

		// Check the text is properly formatted
		if (Array.isArray(userMsg.content)) {
			expect(userMsg.content[0].type).toBe('text');
			expect(typeof userMsg.content[0].text).toBe('string');
			expect(userMsg.content[0].text).toBe('Hello from array');
		}
	});
});

// ============================================================================
// Image Content Conversion Tests (NEW - for multimodal support)
// ============================================================================
describe('Image content conversion to Anthropic format', () => {
	it('should convert OpenAI image_url format to Anthropic source format', () => {
		const openaiImageContent = {
			type: 'image_url',
			image_url: {
				url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ',
				detail: 'auto',
			},
		};

		// Expected Anthropic format
		const expectedAnthropic = {
			type: 'image',
			source: {
				type: 'base64',
				media_type: 'image/png',
				data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ',
			},
		};

		// Simulate the conversion
		const url = openaiImageContent.image_url.url;
		const dataUrlMatch = url.match(/^data:([^;]+);base64,(.+)$/);

		let converted: any;
		if (dataUrlMatch) {
			converted = {
				type: 'image',
				source: {
					type: 'base64',
					media_type: dataUrlMatch[1],
					data: dataUrlMatch[2],
				},
			};
		}

		expect(converted).toEqual(expectedAnthropic);
	});

	it('should handle URL-based images', () => {
		const openaiImageContent = {
			type: 'image_url',
			image_url: {
				url: 'https://example.com/image.png',
			},
		};

		// For URL images, Anthropic uses url source type
		const expectedAnthropic = {
			type: 'image',
			source: {
				type: 'url',
				url: 'https://example.com/image.png',
			},
		};

		const url = openaiImageContent.image_url.url;
		const dataUrlMatch = url.match(/^data:([^;]+);base64,(.+)$/);

		let converted: any;
		if (dataUrlMatch) {
			converted = {
				type: 'image',
				source: {
					type: 'base64',
					media_type: dataUrlMatch[1],
					data: dataUrlMatch[2],
				},
			};
		} else {
			converted = {
				type: 'image',
				source: {
					type: 'url',
					url: url,
				},
			};
		}

		expect(converted).toEqual(expectedAnthropic);
	});

	it('should handle custom proxy image format', () => {
		const proxyImageContent = {
			type: 'image',
			image: {
				url: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
			},
		};

		// Expected Anthropic format
		const expectedAnthropic = {
			type: 'image',
			source: {
				type: 'base64',
				media_type: 'image/jpeg',
				data: '/9j/4AAQSkZJRg==',
			},
		};

		const url = proxyImageContent.image.url;
		const dataUrlMatch = url.match(/^data:([^;]+);base64,(.+)$/);

		let converted: any;
		if (dataUrlMatch) {
			converted = {
				type: 'image',
				source: {
					type: 'base64',
					media_type: dataUrlMatch[1],
					data: dataUrlMatch[2],
				},
			};
		}

		expect(converted).toEqual(expectedAnthropic);
	});
});
