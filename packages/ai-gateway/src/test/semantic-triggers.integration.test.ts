// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { LocalGatewayHarness } from './local-gateway-harness';
const endpoint = 'https://api.typesafe.ai/v1/systemone';
const harness = await LocalGatewayHarness.start({
	workerEntrypoint: 'src/test/fixtures/semantic-triggers-worker.ts',
	sentryDsn: 'https://public@sentry.fixture/1',
	outboundResponse: async (request, body) => {
		if (request.url.startsWith('https://sentry.fixture/')) return Response.json({});
		if (request.url !== endpoint) return;
		expect(request.headers.get('authorization')).toBe('Bearer test-jev-key');
		if (body.state.fail) return Response.json({ error: 'private-provider-content' }, { status: 503 });
		return Response.json({
			model: 'jev-1.13.0',
			answers: Object.fromEntries(
				Object.keys(body.questions).map((id) => [
					id,
					{ type: 'choice', choice: 'supported', confidence: 1, probabilities: { supported: 1, contradicted: 0, unknown: 0 } },
				]),
			),
			usage: { input_tokens: 1000, output_tokens: 90 },
		});
	},
});
afterAll(async () => {
	harness.assertNoUnexpectedOutboundRequests();
	await harness.dispose();
});
const post = (body: unknown, headers = {}) =>
	harness.fetch('/semantic-triggers', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...headers },
		body: JSON.stringify(body),
	});
test('three conditions share one inference call; a fourth account trigger is rejected across devices', async () => {
	const before = harness.outboundRequests.filter((r) => r.url === endpoint).length;
	const response = await post({
		op: 'evaluate',
		conditions: { a: 'Customer reports an error', b: 'Someone proposes a meeting', c: 'A review is complete' },
		state: { by_trigger: Object.fromEntries(['a', 'b', 'c'].map((id) => [id, { current_records: [{ text: 'fixture' }] }])) },
	});
	expect(response.status).toBe(200);
	const calls = harness.outboundRequests.filter((r) => r.url === endpoint);
	expect(calls.length - before).toBe(1);
	expect(Object.keys((calls.at(-1)!.body as any).questions)).toEqual(['a', 'b', 'c']);
	expect((await post({ op: 'register', ids: ['d'] }, { 'X-Device-Id': 'second-device' })).status).toBe(409);
	expect((await post({ op: 'register', ids: ['a', 'b', 'c'] }, { 'X-Device-Id': 'second-device' })).status).toBe(200);
	expect((await post({ op: 'register', ids: ['d'] }, { 'X-Test-Account': 'another-account' })).status).toBe(200);
	expect((await post({ op: 'release', ids: ['b'] })).status).toBe(200);
	expect((await post({ op: 'register', ids: ['d'] })).status).toBe(200);
});
test('quota persists across restart, concurrent admission stays bounded, and failed groups do not partially register', async () => {
	await harness.restart();
	expect((await post({ op: 'register', ids: ['e'] })).status).toBe(409);
	const account = { 'X-Test-Account': 'concurrent-account' };
	const results = await Promise.all([
		post({ op: 'register', ids: ['x', 'y'] }, account),
		post({ op: 'register', ids: ['z', 'w'] }, account),
	]);
	expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
	expect((await post({ op: 'register', ids: ['last'] }, account)).status).toBe(200);
	expect((await post({ op: 'register', ids: ['extra'] }, account)).status).toBe(409);
});
test('errors yield no decisions and preserve a redacted cause in collected support telemetry', async () => {
	const response = await post({
		op: 'evaluate',
		conditions: { a: 'private-trigger-condition' },
		state: { fail: true, by_trigger: { a: { current_records: [{ text: 'private-recording' }] } } },
	});
	expect(response.status).toBe(500);
	let report = '';
	for (let i = 0; i < 40; i++) {
		report = harness.outboundRequests
			.filter((r) => r.url.startsWith('https://sentry.fixture/'))
			.map((r) => String(r.body))
			.join('\n');
		if (report.includes('provider_http_503')) break;
		await new Promise((r) => setTimeout(r, 50));
	}
	expect(report).toContain('provider_http_503');
	expect(report).toContain('no_decisions');
	for (const secret of ['private-trigger-condition', 'private-recording', 'private-provider-content', 'test-jev-key'])
		expect(report).not.toContain(secret);
	expect((await harness.readCostState()).activeReservations).toBe(0);
});

test('replacing a trigger atomically reuses its slot; rejected replacement retains original IDs', async () => {
	const account = { 'X-Test-Account': 'replacement-account' };
	expect((await post({ op: 'register', ids: ['a', 'b', 'c'] }, account)).status).toBe(200);
	expect((await post({ op: 'register', ids: ['d'], release: ['a'] }, account)).status).toBe(200);
	expect((await post({ op: 'register', ids: ['a'] }, account)).status).toBe(409);
	expect((await post({ op: 'register', ids: ['e', 'f'], release: ['b'] }, account)).status).toBe(409);
	expect((await post({ op: 'register', ids: ['b', 'c', 'd'] }, account)).status).toBe(200);
});

test('authentication and malformed batches fail before inference or slot admission', async () => {
	const before = harness.outboundRequests.filter((r) => r.url === endpoint).length;
	expect((await post({ op: 'register', ids: ['a'] }, { Authorization: 'Bearer invalid' })).status).toBe(401);
	const account = { 'X-Test-Account': 'validation-account' };
	for (const body of [
		{ op: 'register', ids: ['a', 'b', 'c', 'd'] },
		{ op: 'register', ids: ['a', 'a'] },
		{ op: 'evaluate', conditions: { a: 'condition' }, state: {} },
		{ op: 'evaluate', conditions: { a: '' }, state: { by_trigger: { a: { current_records: [] } } } },
	])
		expect((await post(body, account)).status).toBe(400);
	expect((await post({ op: 'register', ids: ['x', 'y', 'z'] }, account)).status).toBe(200);
	expect(harness.outboundRequests.filter((r) => r.url === endpoint).length).toBe(before);
});
