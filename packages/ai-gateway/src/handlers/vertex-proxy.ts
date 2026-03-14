/**
 * Proxy Handler for Claude (Anthropic API) and Gemini (Vertex AI)
 *
 * Claude models are proxied directly to the Anthropic Messages API.
 * Gemini models remain on Vertex AI.
 *
 * The Agent SDK and OpenCode send Anthropic-format requests to:
 *   /v1/messages and /anthropic/v1/messages
 */

import { Env } from '../types';
import { proxyToVertex } from '../providers/vertex';
import { proxyToAnthropic, listAnthropicModels } from '../providers/anthropic-proxy';
import { addCorsHeaders } from '../utils/cors';

/**
 * Handle proxy requests for the Agent SDK and OpenCode
 * Routes Claude models to Anthropic API, Gemini to Vertex AI
 */
export async function handleVertexProxy(request: Request, env: Env): Promise<Response> {
	// For /v1/messages, requests are always Anthropic-format (Claude models)
	// Use direct Anthropic API — simpler auth, no model mapping, new models available immediately
	if (!env.ANTHROPIC_API_KEY) {
		return addCorsHeaders(new Response(JSON.stringify({
			type: 'error',
			error: { type: 'configuration_error', message: 'Anthropic API key not configured' },
		}), {
			status: 500,
			headers: { 'Content-Type': 'application/json' },
		}));
	}

	try {
		const response = await proxyToAnthropic(request, env.ANTHROPIC_API_KEY);
		return addCorsHeaders(response);
	} catch (error: any) {
		console.error('Anthropic proxy error:', error);
		return addCorsHeaders(new Response(JSON.stringify({
			type: 'error',
			error: { type: 'api_error', message: error.message },
		}), {
			status: 500,
			headers: { 'Content-Type': 'application/json' },
		}));
	}
}

/**
 * Handle model listing for /anthropic/v1/models
 * Combines dynamic Anthropic models with Gemini models
 */
export async function handleVertexModels(env: Env): Promise<Response> {
	// Gemini models (still on Vertex)
	const geminiModels = [
		{ id: 'gemini-3.1-pro', object: 'model', created: 1747180800, owned_by: 'google' },
		{ id: 'gemini-3-flash', object: 'model', created: 1747180800, owned_by: 'google' },
	];

	// Claude models — fetch dynamically from Anthropic API
	let claudeModels: { id: string; object: string; created: number; owned_by: string }[] = [];
	if (env.ANTHROPIC_API_KEY) {
		claudeModels = await listAnthropicModels(env.ANTHROPIC_API_KEY);
	}

	const allModels = [...claudeModels, ...geminiModels];

	return addCorsHeaders(
		new Response(
			JSON.stringify({
				object: 'list',
				data: allModels,
			}),
			{
				headers: { 'Content-Type': 'application/json' },
			}
		)
	);
}
