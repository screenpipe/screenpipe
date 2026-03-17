import { OpenAIProvider } from './openai';
import { AnthropicProvider } from './anthropic';
import { VertexAIProvider } from './vertex';
import { GeminiProvider } from './gemini';
import { MiniMaxProvider } from './minimax';
import { AIProvider } from './base';
import { Env } from '../types';

export function createProvider(model: string, env: Env): AIProvider {
	if (model.toLowerCase().includes('claude')) {
		// Use direct Anthropic API for Claude models
		// This gives us: dynamic model availability (Opus 4.6 etc.), simpler auth,
		// no model ID mapping, and no silent fallback to wrong models
		if (!env.ANTHROPIC_API_KEY) {
			throw new Error('Anthropic API key not configured');
		}
		return new AnthropicProvider(env.ANTHROPIC_API_KEY);
	}
	if (model.toLowerCase().includes('gemini')) {
		// Use Vertex AI for Gemini models
		if (!env.VERTEX_SERVICE_ACCOUNT_JSON || !env.VERTEX_PROJECT_ID) {
			throw new Error('Vertex AI credentials not configured for Gemini');
		}
		return new GeminiProvider(
			env.VERTEX_SERVICE_ACCOUNT_JSON,
			env.VERTEX_PROJECT_ID,
			'us-central1' // Gemini uses us-central1 region
		);
	}
	if (model.toLowerCase().includes('minimax')) {
		if (!env.MINIMAX_API_KEY) {
			throw new Error('MiniMax API key not configured');
		}
		return new MiniMaxProvider(env.MINIMAX_API_KEY);
	}
	return new OpenAIProvider(env.OPENAI_API_KEY);
}

export type { AIProvider };
