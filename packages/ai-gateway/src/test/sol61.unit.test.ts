// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { describe, expect, it, mock } from 'bun:test';
import { SolProvider } from '../providers/astra';
import { createProvider } from '../providers';
import { getModelCost } from '../services/cost-tracker';
import { isHostedAiModelAllowed } from '../services/hosted-ai-policy';

describe('enterprise Sol 6.1 routing', () => {
  it('uses Responses with tools and retains Low/Standard without leaking request overrides', async () => {
    const p = createProvider('gpt-6.1-sol', { OPENAI_API_KEY: 'synthetic' } as any);
    expect(p).toBeInstanceOf(SolProvider);
    const create = mock(async () => ({ id: 'resp_test', created_at: 1, status: 'completed', output: [
      { type: 'function_call', call_id: 'call_health', name: 'health_check', arguments: '{}' },
    ], usage: { input_tokens: 100, output_tokens: 20 } }));
    (p as any).responsesClient = { responses: { create } };
    const response = await p.createCompletion({ model: 'gpt-6.1-sol', messages: [{ role: 'user', content: 'check' }],
      tools: [{ type: 'function', function: { name: 'health_check', parameters: { type: 'object' } } }],
      reasoning_effort: 'max', temperature: 1, serviceTier: 'flex',
    } as any);
    expect(create.mock.calls[0][0]).toMatchObject({ model: 'gpt-6.1-sol', reasoning: { effort: 'low' }, service_tier: 'default', store: false,
      tools: [{ type: 'function', name: 'health_check' }] });
    expect(create.mock.calls[0][0]).not.toHaveProperty('temperature');
    expect(await response.json()).toMatchObject({ model: 'gpt-6.1-sol', choices: [{ finish_reason: 'tool_calls' }] });
  });
  it('preserves access tiers and prices cache reads, writes, output and long context', () => {
    expect(isHostedAiModelAllowed('gpt-6.1-sol', 'enterprise')).toBe(true);
    expect(isHostedAiModelAllowed('gpt-6.1-sol', 'basic')).toBe(false);
    expect(getModelCost('gpt-6.1-sol', 10000, 1000, { cache_read_tokens: 6000, cache_creation_tokens: 2000 })).toBeCloseTo(0.0196, 6);
    expect(getModelCost('gpt-6.1-sol', 272000, 1000)).toBeCloseTo(0.554, 6);
    expect(getModelCost('gpt-6.1-sol', 272001, 1000)).toBeCloseTo(1.103004, 6);
  });
});
