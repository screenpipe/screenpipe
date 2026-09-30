// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import type { AuthResult, Env } from '../types';
import { isHostedAiModelAllowed } from '../services/hosted-ai-policy';
import { createErrorResponse } from '../utils/cors';

const GLM_ENCLAVE = 'https://pii.screenpipe.containers.tinfoil.dev';
const GLM_MODEL = 'glm-5.3-flash-reap50-iq3m';

/** Fixed-destination opaque relay. Verification and EHBP sealing run locally. */
export async function handleGlmEncryptedProxy(request: Request, env: Env, auth: AuthResult): Promise<Response> {
  if (!auth.isValid || (!auth.userId && !auth.service)) {
    return createErrorResponse(401, 'Sign in to use confidential GLM.');
  }
  if (!isHostedAiModelAllowed(GLM_MODEL, auth.accountPlan)) {
    return createErrorResponse(403, 'Your plan does not include confidential GLM.');
  }
  if (!env.TINFOIL_GLM_API_KEY?.trim()) {
    return createErrorResponse(503, 'Confidential GLM is not configured.');
  }
  // Do not accept arbitrary Tinfoil hosts, paths, credentials, ports or redirects.
  if (request.headers.get('X-Tinfoil-Enclave-Url') !== GLM_ENCLAVE) {
    return createErrorResponse(400, 'Unexpected confidential GLM enclave.');
  }
  const key = request.headers.get('Ehbp-Encapsulated-Key');
  if (!key || !/^[a-f0-9]{64}$/i.test(key)) {
    return createErrorResponse(400, 'An EHBP-encrypted request is required.');
  }
  const headers = new Headers({
    Authorization: `Bearer ${env.TINFOIL_GLM_API_KEY}`,
    'Ehbp-Encapsulated-Key': key,
  });
  for (const name of ['Content-Type', 'Accept']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  try {
    const upstream = await fetch(`${GLM_ENCLAVE}/glm/v1/chat/completions`, {
      method: 'POST', headers, body: request.body,
      signal: request.signal, redirect: 'manual',
    });
    if (upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel();
      return createErrorResponse(502, 'Confidential GLM returned an unexpected redirect.');
    }
    const responseHeaders = new Headers({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'Ehbp-Response-Nonce, Content-Type',
      'Cache-Control': 'no-store',
    });
    for (const name of ['Ehbp-Response-Nonce', 'Content-Type']) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch {
    // Never include upstream bodies, request content, or auth headers in errors.
    return createErrorResponse(502, 'Confidential GLM transport failed.');
  }
}
