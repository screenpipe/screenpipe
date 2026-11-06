// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterEach, expect, spyOn, test } from 'bun:test';
import { handleContentDecisions } from './content-decisions';
const env = { ADMIN_SECRET: 'test-backend', OPENAI_API_KEY: 'test-provider' } as any;
const payload = { model: 'gpt-6-luna', input: 'synthetic fixture', questions: [{ name: 'r0', type: 'choice', instructions: 'Classify this fixture', choices: [{ value: 'work', description: 'Work' }, { value: 'personal', description: 'Personal' }] }] };
const request = (body = payload, auth = 'test-backend') => new Request('https://gateway.test/v1/admin/content-decisions', { method: 'POST', headers: { Authorization: `Bearer ${auth}` }, body: JSON.stringify(body) });
afterEach(() => { globalThis.fetch = original; });
const original = globalThis.fetch;
test('rejects client credentials before contacting a provider', async () => {
  const fetch = spyOn(globalThis, 'fetch');
  expect((await handleContentDecisions(request(payload, 'wrong'), env)).status).toBe(401);
  expect(fetch).not.toHaveBeenCalled(); fetch.mockRestore();
});
test('accepts only bounded Decisions choice requests and forwards no other fields', async () => {
  const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ model: 'gpt-6-luna', answers: [] }));
  expect((await handleContentDecisions(request({ ...payload, tools: ['unsafe'] } as any), env)).status).toBe(200);
  const [url, options] = fetch.mock.calls[0]; expect(url).toBe('https://api.openai.com/v1/decisions'); expect(options!.redirect).toBe('manual');
  expect(JSON.parse(options!.body as string)).toEqual(payload); fetch.mockRestore();
});
test('rejects unsupported model and duplicate question identities without inference', async () => {
  const fetch = spyOn(globalThis, 'fetch');
  expect((await handleContentDecisions(request({ ...payload, model: 'other' }), env)).status).toBe(400);
  expect((await handleContentDecisions(request({ ...payload, questions: [payload.questions[0], payload.questions[0]] }), env)).status).toBe(400);
  expect(fetch).not.toHaveBeenCalled(); fetch.mockRestore();
});
test('never returns upstream private error bodies', async () => {
  const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('private provider body', { status: 500 }));
  const result = await handleContentDecisions(request(), env); expect(result.status).toBe(503);
  expect(await result.text()).not.toContain('private'); fetch.mockRestore();
});
