// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { afterEach, describe, expect, it, mock } from 'bun:test';
import { handleGlmEncryptedProxy } from '../handlers/glm-encrypted-proxy';
import type { AuthResult, Env } from '../types';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const enclave = 'https://pii.screenpipe.containers.tinfoil.dev';
const auth = { isValid: true, userId: 'user', deviceId: 'device', tier: 'subscribed', accountPlan: 'business' } as AuthResult;
const env = { TINFOIL_GLM_API_KEY: 'server-only-key' } as Env;
function request(headers: Record<string, string> = {}) {
  return new Request('https://gateway.test/v1/tinfoil/glm/chat/completions', {
    method: 'POST', body: new Uint8Array([0, 255, 2, 128, 19]), headers: {
      Authorization: 'Bearer user-token', Cookie: 'private-cookie',
      'X-Tinfoil-Enclave-Url': enclave, 'Ehbp-Encapsulated-Key': 'ab'.repeat(32),
      'Content-Type': 'application/json', ...headers,
    },
  });
}

describe('GLM encrypted relay', () => {
  it('forwards opaque bytes to the fixed enclave, swaps auth, and preserves encrypted streaming response headers', async () => {
    const encryptedResponse = new Uint8Array([255, 0, 99, 27]);
    globalThis.fetch = mock(async (url, init) => {
      expect(url).toBe(`${enclave}/glm/v1/chat/completions`);
      expect(init?.redirect).toBe('manual');
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe('Bearer server-only-key');
      expect(headers.get('Cookie')).toBeNull();
      expect(headers.get('Ehbp-Encapsulated-Key')).toBe('ab'.repeat(32));
      expect(new Uint8Array(await new Response(init?.body).arrayBuffer())).toEqual(new Uint8Array([0, 255, 2, 128, 19]));
      return new Response(encryptedResponse, { headers: {
        'Ehbp-Response-Nonce': 'cd'.repeat(32), 'Content-Type': 'text/event-stream', 'Set-Cookie': 'upstream-private',
      } });
    }) as typeof fetch;
    const result = await handleGlmEncryptedProxy(request(), env, auth);
    expect(new Uint8Array(await result.arrayBuffer())).toEqual(encryptedResponse);
    expect(result.headers.get('Ehbp-Response-Nonce')).toBe('cd'.repeat(32));
    expect(result.headers.get('Set-Cookie')).toBeNull();
    expect(result.headers.get('Cache-Control')).toBe('no-store');
  });

  it.each([enclave + '/', enclave + '/elsewhere', enclave + ':443', 'http://pii.screenpipe.containers.tinfoil.dev', 'https://inference.tinfoil.sh', 'https://user@pii.screenpipe.containers.tinfoil.dev'])('rejects destination substitution: %s', async (url) => {
    const network = mock(); globalThis.fetch = network as typeof fetch;
    expect((await handleGlmEncryptedProxy(request({ 'X-Tinfoil-Enclave-Url': url }), env, auth)).status).toBe(400);
    expect(network).not.toHaveBeenCalled();
  });

  it('fails closed on authentication, entitlement, missing key and missing encryption header', async () => {
    const network = mock(); globalThis.fetch = network as typeof fetch;
    expect((await handleGlmEncryptedProxy(request(), env, { ...auth, isValid: false })).status).toBe(401);
    expect((await handleGlmEncryptedProxy(request(), env, { ...auth, accountPlan: 'basic' })).status).toBe(403);
    expect((await handleGlmEncryptedProxy(request(), {} as Env, auth)).status).toBe(503);
    expect((await handleGlmEncryptedProxy(request({ 'Ehbp-Encapsulated-Key': '' }), env, auth)).status).toBe(400);
    expect(network).not.toHaveBeenCalled();
  });

  it('does not follow redirects or expose sensitive upstream errors', async () => {
    globalThis.fetch = mock(async () => new Response(null, { status: 307, headers: { Location: 'https://other.test' } })) as typeof fetch;
    expect((await handleGlmEncryptedProxy(request(), env, auth)).status).toBe(502);
    globalThis.fetch = mock(async () => { throw new Error('server-only-key private content'); }) as typeof fetch;
    const result = await handleGlmEncryptedProxy(request(), env, auth);
    expect(await result.text()).not.toContain('server-only-key');
  });
});
