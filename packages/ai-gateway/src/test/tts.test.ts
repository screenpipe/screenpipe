// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { test, expect } from 'bun:test';
import { handleTts } from '../handlers/tts';
import { LocalGatewayHarness } from './local-gateway-harness';
import type { AuthResult, Env } from '../types';
const auth = { isValid: true, tier: 'subscribed', deviceId: 'synthetic', userId: 'synthetic', accountPlan: 'business_ultra' } as AuthResult;
const request = (text: string) => new Request('https://example.com/v1/tts', { method: 'POST', body: JSON.stringify({ text }) });
test('Business variants pass the entitlement gate but unavailable narration fails closed', async () => {
	for (const accountPlan of ['business', 'business_max', 'business_ultra', 'enterprise'] as const)
		expect((await handleTts(request('Hello'), {} as Env, { ...auth, accountPlan })).status).toBe(503);
	for (const accountPlan of ['free', 'basic', 'unknown'] as const)
		expect((await handleTts(request('Hello'), {} as Env, { ...auth, accountPlan })).status).toBe(403);
});
test('rejects oversized and malformed scripts before contacting a provider', async () => {
	const env = { TTS_ENABLED: 'true', ELEVENLABS_VOICE_ID: 'fictionalVoice123', ELEVENLABS_USD_PER_CHARACTER: '0.0001' } as Env;
	expect((await handleTts(request('x'.repeat(801)), env, auth)).status).toBe(400);
	expect((await handleTts(request('x'.repeat(9000)), env, auth)).status).toBe(413);
	expect((await handleTts(request(''), env, auth)).status).toBe(400);
});
test('uses Cloudflare BYOK, excludes account tokens and bills narration through real D1', async () => {
	const harness = await LocalGatewayHarness.start({ ttsStatus: 200 });
	try {
		const result = await harness.fetch('/tts', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ text: 'Hello' }),
		});
		expect(result.status).toBe(200);
		expect(await result.text()).toBe('synthetic audio');
		const outbound = harness.outboundRequests[0];
		expect(outbound.headers['cf-aig-byok-alias']).toBe('default');
		expect(outbound.headers['cf-aig-collect-log-payload']).toBe('false');
		expect(outbound.headers.authorization).toBeUndefined();
		expect(outbound.headers['xi-api-key']).toBeUndefined();
		expect(outbound.body).toEqual({ text: 'Hello', model_id: 'eleven_multilingual_v2' });
		const cost = await harness.readCostState();
		expect(cost.dailyCostUsd).toBeCloseTo(0.0005, 6);
		expect(cost.activeReservations).toBe(0);
		harness.assertNoUnexpectedOutboundRequests();
	} finally {
		await harness.dispose();
	}
}, 30000);
test('provider failure preserves its cost hold without exposing private errors', async () => {
	const harness = await LocalGatewayHarness.start({ ttsStatus: 429 });
	try {
		const result = await harness.fetch('/tts', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ text: 'Hello' }),
		});
		expect(result.status).toBe(429);
		expect(await result.text()).not.toContain('private provider');
		expect((await harness.readCostState()).dailyCostUsd).toBeGreaterThan(0);
		harness.assertNoUnexpectedOutboundRequests();
	} finally {
		await harness.dispose();
	}
}, 30000);
