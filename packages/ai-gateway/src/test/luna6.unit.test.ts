// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { describe, expect, it, mock } from 'bun:test';
import { OpenAIProvider } from '../providers/openai';
import { AUTO_WATERFALL, AUTO_WATERFALL_BACKGROUND, AUTO_WATERFALL_VISION, FREE_PREVIEW_WATERFALL, efficientModelChain } from '../handlers/chat';
import { getModelCost, getCostReservationMicroUsd, isFrontierModel } from '../services/cost-tracker';
import { isHostedAiModelAllowed } from '../services/hosted-ai-policy';
import { handleModelListing } from '../handlers/models';
import { gatewayProviderForModel } from '../services/cloudflare-ai-gateway';

describe('GPT-6 Luna Auto default', () => {
  it('starts every Auto lane on Luna 6 while preserving cross-provider fallback and plan restrictions', () => {
    for (const chain of [AUTO_WATERFALL, AUTO_WATERFALL_BACKGROUND, AUTO_WATERFALL_VISION]) {
      expect(chain).toEqual(['gpt-6-luna', 'claude-sonnet-5', 'gpt-5.4-mini']);
      expect(efficientModelChain(chain)).toEqual(['gpt-6-luna', 'gpt-5.4-mini']);
    }
    expect(FREE_PREVIEW_WATERFALL).toEqual(['gpt-6-luna', 'gpt-5.4-mini']);
    expect(isHostedAiModelAllowed('gpt-6-luna', 'basic')).toBe(true);
    expect(isHostedAiModelAllowed('gpt-6-luna', 'business')).toBe(true);
    expect(isHostedAiModelAllowed('gpt-6-luna', 'free')).toBe(false);
    expect(isHostedAiModelAllowed('gpt-6-luna-preview', 'basic')).toBe(false);
    expect(isHostedAiModelAllowed('gpt-5.6-luna', 'basic')).toBe(true);
    expect(gatewayProviderForModel('gpt-6-luna')).toBe('openai');
    expect(isFrontierModel('gpt-6-luna')).toBe(false);
  });

  it('prices uncached input, cache reads, cache writes and the long-context boundary', () => {
    expect(getModelCost('gpt-6-luna', 10_000, 2_000)).toBeCloseTo(0.002, 9);
    expect(getModelCost('gpt-6-luna', 10_000, 1_000,
      { cache_read_tokens: 6_000, cache_creation_tokens: 2_000 })).toBeCloseTo(0.00101, 9);
    expect(getModelCost('gpt-6-luna', 272_000, 1_000)).toBeCloseTo(0.0277, 9);
    expect(getModelCost('gpt-6-luna', 272_001, 1_000)).toBeCloseTo(0.0551502, 9);
    expect(getModelCost('gpt-6-luna', 300_000, 1_000,
      { cache_read_tokens: 200_000, cache_creation_tokens: 50_000 })).toBeCloseTo(0.02725, 9);
    const shape = { inputTokens: 300_000, maxOutputTokens: 4_096 };
    expect(getCostReservationMicroUsd('gpt-5.4-mini', shape))
      .toBeGreaterThanOrEqual(getCostReservationMicroUsd('gpt-6-luna', shape));
  });

  it('lists Luna 6 for Basic while keeping Auto first and legacy Luna selectable', async () => {
    const statement = { bind: () => statement, all: async () => ({ results: [] }) };
    const env: any = { OPENAI_API_KEY: 'test', DB: { prepare: () => statement } };
    const listing: any = await (await handleModelListing(env, 'logged_in', false, 'basic')).json();
    expect(listing.data[0].id).toBe('auto');
    expect(listing.data.find((m: any) => m.id === 'gpt-6-luna')).toMatchObject({
      name: 'GPT-6 Luna', context_window: 1_050_000, max_output_tokens: 128_000,
    });
    expect(listing.data.find((m: any) => m.id === 'gpt-6-luna').locked).not.toBe(true);
    expect(listing.data.some((m: any) => m.id === 'gpt-5.6-luna')).toBe(true);
  });

  for (const streaming of [false, true]) {
    it(`preserves tool calls, output limits and explicit caching in ${streaming ? 'streaming' : 'nonstreaming'} requests`, async () => {
      const usage = { prompt_tokens: 10_000, completion_tokens: 1_000,
        prompt_tokens_details: { cached_tokens: 6_000, cache_write_tokens: 2_000 } };
      const create = mock(async () => streaming ? {
        controller: new AbortController(),
        async *[Symbol.asyncIterator]() {
          yield { id: 'synthetic', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] };
          yield { id: 'synthetic', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage };
        },
      } : { id: 'synthetic', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage });
      const provider = new OpenAIProvider('synthetic');
      (provider as any).client = { chat: { completions: { create } } };
      const body: any = {
        model: 'gpt-6-luna', temperature: 0.5, reasoning_effort: 'high', max_tokens: 4_096,
        messages: [{ role: 'system', content: 'synthetic instructions' }, { role: 'user', content: 'call lookup' }],
        tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
        tool_choice: 'required',
      };
      const response = streaming ? new Response(await provider.createStreamingCompletion(body)) : await provider.createCompletion(body);
      const text = await response.text();
      const params: any = create.mock.calls[0][0];
      expect(params).toMatchObject({ model: 'gpt-6-luna', max_completion_tokens: 4_096,
        reasoning_effort: 'none', tool_choice: 'required', prompt_cache_options: { mode: 'explicit' } });
      expect(params).not.toHaveProperty('max_tokens');
      expect(params).not.toHaveProperty('temperature');
      expect(params.prompt_cache_key).toMatch(/^sp:[a-f0-9]{48}$/);
      expect(params.messages[0].content[0].prompt_cache_breakpoint).toEqual({ mode: 'explicit' });
      expect(text).toContain('cache_creation_input_tokens');
      expect(text).toContain('2000');
    });
  }
});
