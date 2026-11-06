// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { timingSafeEqual } from 'node:crypto';
import type { Env } from '../types';

const failure = (status: number, code: string) => Response.json({ error: { code } }, { status, headers: { 'Cache-Control': 'no-store' } });
/** Backend-only Decisions transport. Provider credentials remain in this gateway;
 * the website authenticates workspace scope, processing consent and scan budget. */
export async function handleContentDecisions(request: Request, env: Env): Promise<Response> {
  const expected = Buffer.from(`Bearer ${env.ADMIN_SECRET?.trim() || ''}`);
  const actual = Buffer.from(request.headers.get('Authorization') || '');
  if (!env.ADMIN_SECRET?.trim() || actual.length !== expected.length || !timingSafeEqual(actual, expected)) return failure(401, 'unauthorized');
  if (request.method !== 'POST') return failure(405, 'method_not_allowed');
  const signal = AbortSignal.timeout(40_000);
  let body: any;
  const reader = request.body?.getReader();
  try {
    if (!reader) return failure(400, 'invalid_decision_request');
    const chunks: Uint8Array[] = []; let bytes = 0;
    for (;;) {
      const result = await reader.read(); if (result.done) break;
      bytes += result.value.length; if (bytes > 96_000) return failure(413, 'decision_request_too_large'); chunks.push(result.value);
    }
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { return failure(400, 'invalid_decision_request'); }
  finally { await reader?.cancel().catch(() => {}); }
  if (body?.model !== 'gpt-6-luna' || typeof body.input !== 'string' || body.input.length > 64_000 || !Array.isArray(body.questions) || body.questions.length < 1 || body.questions.length > 32) return failure(400, 'invalid_decision_request');
  const names = new Set<string>();
  for (const q of body.questions) {
    if (q.type !== 'choice' || typeof q.name !== 'string' || !/^r\d+$/.test(q.name) || names.has(q.name) || typeof q.instructions !== 'string' || q.instructions.length > 2000 || !Array.isArray(q.choices) || q.choices.length < 2 || q.choices.length > 42 || q.choices.some((c: any) => typeof c.value !== 'string' || c.value.length > 64 || typeof c.description !== 'string' || c.description.length > 2000)) return failure(400, 'invalid_decision_request');
    names.add(q.name);
  }
  if (!env.OPENAI_API_KEY?.trim()) { console.warn('decisions_failure', JSON.stringify({ code: 'not_configured' })); return failure(503, 'decision_provider_not_configured'); }
  try {
    const upstream = await fetch('https://api.openai.com/v1/decisions', { method: 'POST', redirect: 'manual', signal,
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY.trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-6-luna', input: body.input, questions: body.questions }) });
    if (!upstream.ok) {
      let code = 'unknown';
      try { const error = await upstream.json() as any;
        const allowed = ['invalid_api_key', 'model_not_found', 'insufficient_quota', 'invalid_request_error', 'rate_limit_exceeded', 'unsupported_parameter'];
        if (allowed.includes(error?.error?.code)) code = error.error.code;
        else if (allowed.includes(error?.error?.type)) code = error.error.type;
      } catch { /* never log arbitrary provider bodies */ }
      console.warn('decisions_failure', JSON.stringify({ code, status: upstream.status }));
      // Numeric diagnostics reveal transport/access failures without echoing
      // provider bodies, captured inputs, credentials or request headers.
      return Response.json({ error: { code: 'decision_provider_unavailable', upstream_status: upstream.status } }, { status: upstream.status >= 400 && upstream.status < 500 ? upstream.status : 503, headers: { 'Cache-Control': 'no-store' } });
    }
    return new Response(upstream.body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  } catch { console.warn('decisions_failure', JSON.stringify({ code: 'transport' })); return failure(503, 'decision_provider_unavailable'); }
}
