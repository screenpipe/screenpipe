import { Env, UserTier } from '../types';
import { createSuccessResponse, createErrorResponse, addCorsHeaders } from '../utils/cors';
import { getTierConfig, isModelAllowed } from '../services/usage-tracker';
import { listAnthropicModels } from '../providers/anthropic-proxy';

/**
 * Handles model listing requests
 * @param env Environment variables
 * @param tier User tier for filtering models
 * @returns Response with list of available AI models
 */
export async function handleModelListing(env: Env, tier: UserTier = 'subscribed'): Promise<Response> {
  try {
    // Fetch Claude models from Anthropic API (dynamic — new models appear automatically)
    // and include Gemini models statically
    const [anthropicModels] = await Promise.all([
      env.ANTHROPIC_API_KEY
        ? listAnthropicModels(env.ANTHROPIC_API_KEY)
        : Promise.resolve([]),
    ]);

    const geminiModels = [
      { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', provider: 'google' },
      { id: 'gemini-3-flash', name: 'Gemini 3 Flash', provider: 'google' },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'google' },
    ];

    let models: { id: string; name: string; provider: string; tier_available?: boolean }[] = [
      ...anthropicModels.map(m => ({
        id: m.id,
        name: m.id, // Anthropic API returns id, display_name handled in listAnthropicModels
        provider: 'anthropic',
      })),
      ...geminiModels,
    ];

    // Filter models based on tier
    if (tier !== 'subscribed') {
      const allowedModels = getTierConfig(env)[tier].allowedModels;
      models = models.filter(model =>
        allowedModels.some(allowed =>
          model.id.toLowerCase().includes(allowed.toLowerCase()) ||
          allowed.toLowerCase().includes(model.id.toLowerCase())
        )
      );

      // Add metadata about tier restrictions
      models = models.map(model => ({
        ...model,
        tier_available: true,
      }));
    }

    // Return in OpenAI-compatible format (data array) with tier info
    return addCorsHeaders(createSuccessResponse({
      data: models,
      models: models, // Also include as 'models' for backwards compatibility
      tier,
      tier_limits: getTierConfig(env)[tier],
    }));
  } catch (error) {
    console.error('Error fetching models:', error);
    return addCorsHeaders(createErrorResponse(
      500,
      `Failed to fetch models: ${error instanceof Error ? error.message : 'Unknown error'}`
    ));
  }
}
