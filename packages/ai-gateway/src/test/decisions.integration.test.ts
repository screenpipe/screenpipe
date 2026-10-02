// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { afterAll, expect, test } from 'bun:test';
import { LocalGatewayHarness } from './local-gateway-harness';
import { DECISION_MAX_REQUEST_BYTES } from '../handlers/decisions';

const body = { model: 'clef', state: 'synthetic-private-state', questions: {
	meeting: { type: 'noul', instructions: 'Is there a meeting?' },
} };
const harness = await LocalGatewayHarness.start({
	workerEntrypoint: 'src/test/fixtures/decisions-worker.ts',
	sentryDsn: 'https://public@sentry.fixture/1',
	outboundResponse: async (request, input) => {
		if (request.url.startsWith('https://sentry.fixture/')) return Response.json({});
		if (request.url !== 'https://clef.fixture/run') return;
		expect(input.model).toBe(`@cf/cloudflare/${input.body.model}`);
		if (input.body.state === 'synthetic-provider-failure') return Response.json({ code: 3040, message: 'secret-prompt-should-not-leak' }, { status: 503 });
		return Response.json({ model: input.body.model, answers: { meeting: { type: 'noul', noul: 0.99 } }, usage: { input_tokens: 1000, output_tokens: 0 } });
	},
});
afterAll(async () => { harness.assertNoUnexpectedOutboundRequests(); await harness.dispose(); });
const post = (payload: unknown, headers = {}) => harness.fetch('/decisions', {
	method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload),
});

test('requires authentication and rejects malformed/oversized input before inference', async () => {
	const before = harness.outboundRequests.filter((r) => r.url === 'https://clef.fixture/run').length;
	expect((await post(body, { Authorization: '' })).status).toBe(401);
	for (const invalid of [{ ...body, model: 'gpt-5.6-sol' }, { ...body, questions: {} }, { ...body, images: ['https://private.example/image'] }]) {
		expect((await post(invalid)).status).toBe(400);
	}
	expect((await post({ ...body, state: 'a'.repeat(DECISION_MAX_REQUEST_BYTES) })).status).toBe(413);
	expect(harness.outboundRequests.filter((r) => r.url === 'https://clef.fixture/run').length).toBe(before);
});

test('returns native decisions and settles the exact input-token cost for both models', async () => {
	for (const model of ['clef', 'clef-flash']) {
		const response = await post({ ...body, model });
		expect(response.status).toBe(200);
		expect(response.headers.get('Cache-Control')).toBe('no-store');
		expect(await response.json()).toMatchObject({ model, answers: { meeting: { noul: 0.99 } } });
	}
	expect((await harness.readCostState()).dailyCostUsd).toBeCloseTo(0.00033, 8);
	expect((await harness.readCostState()).activeReservations).toBe(0);
	const telemetry = await harness.readInferenceTelemetry();
	expect(telemetry.costs).toEqual(expect.arrayContaining([
		expect.objectContaining({ model: 'clef', input_tokens: 1000, output_tokens: 0, cost: 0.00024 }),
		expect.objectContaining({ model: 'clef-flash', input_tokens: 1000, output_tokens: 0, cost: 0.00009 }),
	]));
});

test('collects the provider cause in the redacted Sentry envelope without prompt content', async () => {
	const response = await post({ ...body, state: 'synthetic-provider-failure' });
	expect(response.status).toBe(500);
	expect(await response.text()).not.toContain('secret-prompt');
	let report = '';
	for (let i = 0; i < 40; i++) {
		report = harness.outboundRequests.filter((r) => r.url.startsWith('https://sentry.fixture/')).map((r) => String(r.body)).join('\n');
		if (report.includes('code=3040')) break;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	expect(report).toContain('Workers AI clef inference failed (code=3040)');
	expect(report).not.toContain('secret-prompt-should-not-leak');
	expect(report).not.toContain('synthetic-provider-failure');
	expect(report).not.toContain('screenpipe-local-e2e-service-token');
	expect((await harness.readCostState()).activeReservations).toBe(0);
});

test('retains spend enforcement across restart and blocks inference when exhausted', async () => {
	await harness.seedDailyCostUsd(104);
	await harness.restart();
	const before = harness.outboundRequests.filter((r) => r.url === 'https://clef.fixture/run').length;
	expect((await post(body)).status).toBe(429);
	expect(harness.outboundRequests.filter((r) => r.url === 'https://clef.fixture/run').length).toBe(before);
});
