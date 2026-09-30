// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { timingSafeEqual } from 'node:crypto';
import type { Env } from '../types';

const MAX_BYTES = 65536;
const CALL_ID = /^[a-zA-Z0-9_-]{1,200}$/;
const ACTOR_ID = /^[a-f0-9]{64}$/;
const failure = (status: number, code: string) => Response.json({ error: { code } }, { status, headers: { 'Cache-Control': 'no-store' } });

async function boundedJson(body: ReadableStream<Uint8Array> | null): Promise<any> {
	if (!body) throw new Error('missing body');
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			bytes += value.length;
			if (bytes > MAX_BYTES) throw new Error('body too large');
			chunks.push(value);
		}
	} finally { await reader.cancel().catch(() => {}); }
	return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Website-only control plane. Studio checks actor, organization policy, quota and call tickets. */
export async function handleStudioVoice(request: Request, env: Env): Promise<Response> {
	const secret = env.ADMIN_SECRET?.trim();
	const actual = Buffer.from(request.headers.get('Authorization') || '');
	const expected = Buffer.from(`Bearer ${secret || ''}`);
	if (!secret || actual.length !== expected.length || !timingSafeEqual(actual, expected)) return failure(401, 'unauthorized');
	if (request.method !== 'POST' && request.method !== 'DELETE') return failure(405, 'method_not_allowed');
	let body: any;
	try { body = await boundedJson(request.body); } catch { return failure(400, 'invalid_voice_request'); }
	const closing = request.method === 'DELETE';
	const actor = request.headers.get('OpenAI-Safety-Identifier') || '';
	if (closing ? (typeof body?.call_id !== 'string' || !CALL_ID.test(body.call_id)) : (!ACTOR_ID.test(actor) || body?.session?.model !== 'gpt-live-1' || body?.session?.store !== false || body?.session?.delegation?.type !== 'client' || body?.transport?.type !== 'webrtc' || typeof body?.transport?.sdp !== 'string' || !body.transport.sdp.startsWith('v=0') || typeof body?.session?.instructions !== 'string' || body.session.instructions.length > 16000)) return failure(400, 'invalid_voice_request');
	try {
		// Cloudflare's provider-native proxy returns 404 for /live/sessions.
		// Keep Live inside Screenpipe's authenticated gateway, using its existing backend key.
		// Studio enforces six starts/hour and a 120-second call lifetime; never fall back/retry creation.
		if (!env.OPENAI_API_KEY?.trim()) return failure(503, 'voice_provider_not_configured');
		const connection = { baseURL: 'https://api.openai.com/v1' };
		const headers = new Headers({ 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY.trim()}` });
		if (!closing) headers.set('OpenAI-Safety-Identifier', actor);
		// Only reviewed Live fields may reach the provider; never proxy arbitrary tools or URLs.
		const session = closing ? undefined : { model: 'gpt-live-1', store: false, delegation: { type: 'client' }, client: { data_channel: { allowed_client_events: ['session.commentary.append', 'session.thinking.append', 'session.close'] } }, audio: { output: { voice: 'marin' } }, instructions: body.session.instructions };
		const response = await fetch(`${connection.baseURL.replace(/\/$/, '')}/live/sessions${closing ? `/${body.call_id}/hangup` : ''}`, { method: 'POST', headers, body: closing ? undefined : JSON.stringify({ session, transport: { type: 'webrtc', sdp: body.transport.sdp } }), signal: AbortSignal.timeout(closing ? 7000 : 18000) });
		if (closing) {
			await response.body?.cancel().catch(() => {});
			return response.ok || response.status === 404 || response.status === 410 ? new Response(null, { status: 204 }) : failure(502, 'voice_cleanup_failed');
		}
		if (!response.ok) {
			let upstream: any = {};
			try { upstream = await boundedJson(response.body); } catch {}
			const code = upstream?.error?.code;
			return Response.json({ error: { code: 'voice_provider_unavailable', upstream_status: response.status, provider_code: typeof code === 'string' && /^[a-zA-Z0-9_]{1,80}$/.test(code) ? code : undefined } }, { status: response.status === 429 ? 429 : 503, headers: { 'Cache-Control': 'no-store' } });
		}
		const result = await boundedJson(response.body);
		if (typeof result?.session?.id !== 'string' || !CALL_ID.test(result.session.id)) return failure(502, 'voice_invalid_response');
		if (result?.transport?.type !== 'webrtc' || typeof result?.transport?.sdp !== 'string' || !result.transport.sdp.startsWith('v=0')) {
			const cleanup = await fetch(`${connection.baseURL.replace(/\/$/, '')}/live/sessions/${result.session.id}/hangup`, { method: 'POST', headers, signal: AbortSignal.timeout(7000) });
			await cleanup.body?.cancel().catch(() => {});
			return failure(502, 'voice_invalid_response');
		}
		return Response.json({ session: { id: result.session.id }, transport: { type: 'webrtc', sdp: result.transport.sdp } }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
	} catch {
		return failure(503, 'voice_gateway_unavailable');
	}
}
