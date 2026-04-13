import { Env } from '../types';
import { GeminiProvider } from '../providers/gemini';
import { addCorsHeaders, createErrorResponse } from '../utils/cors';

interface WebSearchRequest {
	query: string;
}

/**
 * Handle web search requests using Gemini's Google Search grounding.
 * Prefers Vertex AI for shorter data retention and enterprise ToS.
 */
export async function handleWebSearch(request: Request, env: Env): Promise<Response> {
	try {
		const body = (await request.json()) as WebSearchRequest;

		if (!body.query || typeof body.query !== 'string' || body.query.trim().length === 0) {
			return addCorsHeaders(createErrorResponse(400, JSON.stringify({
				error: 'invalid_request',
				message: 'Missing or empty "query" field',
			})));
		}

		// Prefer Vertex AI for Gemini (shorter data retention, enterprise ToS)
		let provider: GeminiProvider;
		if (env.VERTEX_SERVICE_ACCOUNT_JSON && env.VERTEX_PROJECT_ID) {
			provider = new GeminiProvider({
				serviceAccountJson: env.VERTEX_SERVICE_ACCOUNT_JSON,
				projectId: env.VERTEX_PROJECT_ID,
				region: 'us-central1',
			});
		} else if (env.GEMINI_API_KEY) {
			provider = new GeminiProvider(env.GEMINI_API_KEY);
		} else {
			return addCorsHeaders(createErrorResponse(500, JSON.stringify({
				error: 'configuration_error',
				message: 'Gemini credentials not configured',
			})));
		}

		const result = await provider.executeWebSearch(body.query.trim());

		return addCorsHeaders(new Response(JSON.stringify({
			query: body.query.trim(),
			content: result.content,
			sources: result.sources,
		}), {
			headers: { 'Content-Type': 'application/json' },
		}));
	} catch (error: any) {
		console.error('Web search error:', error?.message);
		return addCorsHeaders(createErrorResponse(500, JSON.stringify({
			error: 'search_failed',
			message: error?.message || 'Web search failed',
		})));
	}
}
