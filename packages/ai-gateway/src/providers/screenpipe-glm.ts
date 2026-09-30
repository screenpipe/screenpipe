// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import type { RequestBody } from '../types';
import { OpenAIProvider } from './openai';

import { SCREENPIPE_GLM_MODEL, normalizeGlmRequest, normalizeGlmToolCallStream, parseGlmToolCallContent } from '../../../../crates/screenpipe-core/assets/extensions/lib/glm-protocol';
export { SCREENPIPE_GLM_MODEL, normalizeGlmRequest, parseGlmToolCallContent } from '../../../../crates/screenpipe-core/assets/extensions/lib/glm-protocol';
const DIRECT_GLM_BASE_URL = 'https://pii.screenpipe.containers.tinfoil.dev/glm/v1';

/**
 * Text-only GLM served beside the privacy filter in Screenpipe's Tinfoil CVM.
 * Requests may go directly to the enclave or through Cloudflare AI Gateway's
 * `custom-tinfoil` provider; both paths use the container-owned bearer secret.
 */
export class ScreenpipeGlmProvider extends OpenAIProvider {
	supportsTools = true;
	supportsVision = false;

	constructor(
		apiKey: string,
		baseURL = DIRECT_GLM_BASE_URL,
		defaultHeaders?: Record<string, string | null | undefined>,
		maxRetries = 0,
	) {
		super(apiKey, baseURL, defaultHeaders, maxRetries);
	}

	protected getChatTemplateKwargs(body: RequestBody): Record<string, unknown> {
		// The deployed GLM template has binary thinking, not graded effort.
		// Pi defaults interactive chats to "medium" and its 32K Day Recap
		// prompt already consumes most of that window. Treat medium and below
		// as the fast/non-thinking path; high+ remains an explicit opt-in.
		return {
			enable_thinking: body.reasoning_effort === 'high'
				|| body.reasoning_effort === 'xhigh'
				|| String(body.reasoning_effort) === 'max',
		};
	}

	async createCompletion(body: RequestBody): Promise<Response> {
		const response = await super.createCompletion(normalizeGlmRequest(body));
		if (!Array.isArray(body.tools) || body.tools.length === 0) return response;
		const payload: any = await response.json();
		const message = payload.choices?.[0]?.message;
		if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
			return new Response(JSON.stringify(payload), response);
		}
		const toolCalls = parseGlmToolCallContent(message?.content, body.tools);
		if (toolCalls.length > 0) {
			message.content = null;
			message.tool_calls = toolCalls;
			payload.choices[0].finish_reason = 'tool_calls';
		}
		return new Response(JSON.stringify(payload), response);
	}

	async createStreamingCompletion(body: RequestBody): Promise<ReadableStream> {
		const stream = await super.createStreamingCompletion(normalizeGlmRequest(body));
		if (!Array.isArray(body.tools) || body.tools.length === 0) return stream;
		return normalizeGlmToolCallStream(stream, body.tools);
	}
}

export function isScreenpipeGlmModel(model: string): boolean {
	return model.toLowerCase() === SCREENPIPE_GLM_MODEL;
}
