/**
 * Direct Anthropic API Proxy for Claude models
 *
 * Replaces the Vertex AI proxy for Claude requests. Instead of going through
 * Google Cloud Vertex AI (which requires service account auth, model mapping,
 * and has delayed availability of new models), this proxies directly to the
 * Anthropic Messages API.
 *
 * The Agent SDK and OpenCode send Anthropic-format requests and expect
 * Anthropic-format responses — this is a thin passthrough with sanitization.
 */

import { sanitizeMessages } from './vertex';

const ANTHROPIC_API_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Proxy an Anthropic Messages API request directly to api.anthropic.com
 *
 * This replaces proxyToVertex() for Claude models. The request format is
 * identical (Anthropic Messages API), so we just forward with auth headers.
 */
export async function proxyToAnthropic(
	request: Request,
	apiKey: string,
): Promise<Response> {
	try {
		const body = await request.json() as {
			model?: string;
			stream?: boolean;
			max_tokens?: number;
			messages?: any[];
			system?: string;
			temperature?: number;
			[key: string]: any;
		};

		// Normalize Vertex-style @YYYYMMDD model IDs to Anthropic-style -YYYYMMDD
		// Old app versions send e.g. "claude-haiku-4-5@20251001" which Anthropic API won't accept
		if (body.model && body.model.includes('@')) {
			const original = body.model;
			body.model = body.model.replace('@', '-');
			console.log('proxyToAnthropic: normalized model', original, '->', body.model);
		}

		console.log('proxyToAnthropic: model=', body.model, 'stream=', body.stream, 'messages count=', body.messages?.length);

		// Sanitize messages to fix common formatting issues (e.g. nested {text: {text: '...'}})
		// This is a client-side bug workaround, not provider-specific
		if (body.messages) {
			body.messages = sanitizeMessages(body.messages);
		}

		const isStreaming = body.stream === true;

		// Forward directly to Anthropic API
		// Unlike Vertex, the model stays in the body and auth is via x-api-key header
		const response = await fetch(`${ANTHROPIC_API_URL}/v1/messages`, {
			method: 'POST',
			headers: {
				'x-api-key': apiKey,
				'anthropic-version': ANTHROPIC_VERSION,
				'content-type': 'application/json',
			},
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			const error = await response.text();
			console.error('Anthropic API error:', response.status, error);

			// Detect spending/rate limit errors and return 503 so clients know to retry
			// instead of surfacing a confusing 400 "invalid_request_error"
			const isSpendingLimit = error.includes('reached your specifi') || error.includes('spending limit');
			const isRateLimit = error.includes('rate_limit') || response.status === 429;

			if (isSpendingLimit) {
				return new Response(JSON.stringify({
					type: 'error',
					error: {
						type: 'overloaded_error',
						message: 'AI service is temporarily at capacity. Please try again in a few minutes.',
					},
				}), {
					status: 503,
					headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
				});
			}

			if (isRateLimit) {
				return new Response(error, {
					status: 429,
					headers: { 'Content-Type': 'application/json', 'Retry-After': '30' },
				});
			}

			return new Response(error, {
				status: response.status,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		// For streaming, pass through the SSE stream as-is
		// Anthropic SSE format is identical whether from Vertex or direct API
		if (isStreaming) {
			return new Response(response.body, {
				headers: {
					'Content-Type': 'text/event-stream',
					'Cache-Control': 'no-cache',
					'Connection': 'keep-alive',
				},
			});
		}

		// For non-streaming, pass through the JSON response
		const result = await response.json();
		return new Response(JSON.stringify(result), {
			headers: { 'Content-Type': 'application/json' },
		});
	} catch (error: any) {
		console.error('proxyToAnthropic error:', error.message, error.stack);
		return new Response(JSON.stringify({
			type: 'error',
			error: {
				type: 'api_error',
				message: error.message,
			},
		}), {
			status: 500,
			headers: { 'Content-Type': 'application/json' },
		});
	}
}

/**
 * List available Claude models from the Anthropic API
 *
 * Unlike the hardcoded Vertex model list, this dynamically fetches
 * available models so new releases (like Opus 4.6) appear automatically.
 */
export async function listAnthropicModels(
	apiKey: string,
): Promise<{ id: string; object: string; created: number; owned_by: string }[]> {
	try {
		const response = await fetch(`${ANTHROPIC_API_URL}/v1/models`, {
			headers: {
				'x-api-key': apiKey,
				'anthropic-version': ANTHROPIC_VERSION,
			},
		});

		if (!response.ok) {
			console.error('Failed to list Anthropic models:', response.status);
			return getFallbackModels();
		}

		const data = await response.json() as {
			data: Array<{ id: string; display_name: string; created_at: string; type: string }>;
		};

		return data.data.map((model) => ({
			id: model.id,
			object: 'model',
			created: Math.floor(new Date(model.created_at).getTime() / 1000),
			owned_by: 'anthropic',
		}));
	} catch (error) {
		console.error('Error listing Anthropic models:', error);
		return getFallbackModels();
	}
}

/**
 * Fallback model list in case the API is unreachable
 */
function getFallbackModels(): { id: string; object: string; created: number; owned_by: string }[] {
	return [
		{ id: 'claude-opus-4-6', object: 'model', created: 1738800000, owned_by: 'anthropic' },
		{ id: 'claude-sonnet-4-5-20250929', object: 'model', created: 1727568000, owned_by: 'anthropic' },
		{ id: 'claude-haiku-4-5-20251001', object: 'model', created: 1727740800, owned_by: 'anthropic' },
		{ id: 'claude-opus-4-5-20251101', object: 'model', created: 1730419200, owned_by: 'anthropic' },
	];
}
