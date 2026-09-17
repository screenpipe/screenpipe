// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { normalizeGlmRequest, normalizeGlmToolCallStream, SCREENPIPE_GLM_MODEL } from "./glm-protocol";

export const GLM_ENCLAVE = "https://pii.screenpipe.containers.tinfoil.dev";
export const GLM_CONFIG_REPO = "screenpipe/privacy-filter";
export const GLM_SECURE_API = "screenpipe-tinfoil";

type VerifiedClient = { ready(): Promise<unknown>; fetch: typeof fetch };
type ClientFactory = (options: {
  enclaveURL: string; configRepo: string; baseURL: string; transport: "ehbp"; userCacheSecret: string;
}) => VerifiedClient;

/** Local-only adapter. No plaintext fetch or gateway fallback is permitted. */
export function createGlmEncryptedFetch(baseURL: string, createClient: ClientFactory): typeof fetch {
  const gateway = new URL(baseURL);
  if (gateway.protocol !== "https:" || gateway.username || gateway.password || gateway.search || gateway.hash) {
    throw new Error("Confidential GLM requires an HTTPS gateway URL");
  }
  const endpoint = `${baseURL.replace(/\/$/, "")}/tinfoil/glm/chat/completions`;
  let client: VerifiedClient | undefined;
  let clientAuth: string | null | undefined;
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== endpoint || request.method !== "POST") {
      throw new Error("Confidential GLM refused an unexpected request destination");
    }
    request.signal.throwIfAborted();
    const body = await request.json();
    if (body.model !== SCREENPIPE_GLM_MODEL) {
      throw new Error("Confidential GLM refused a different model");
    }
    // Match the established gateway adapter before sealing, then normalize
    // native GLM tool calls only after the SDK has decrypted the SSE response.
    const normalized = normalizeGlmRequest(body);
    normalized.chat_template_kwargs = {
      enable_thinking: ["high", "xhigh", "max"].includes(body.reasoning_effort),
    };
    const auth = request.headers.get("Authorization");
    if (!client || clientAuth !== auth) {
      client = createClient({
        enclaveURL: GLM_ENCLAVE,
        configRepo: GLM_CONFIG_REPO,
        baseURL: endpoint,
        transport: "ehbp",
        // Scope prompt caches to this authenticated client lifetime without
        // persisting the SDK's default shared ~/.tinfoil cache secret.
        userCacheSecret: crypto.randomUUID(),
      });
      clientAuth = auth;
    }
    const verifiedClient = client;
    await verifiedClient.ready();
    request.signal.throwIfAborted();
    const response = await verifiedClient.fetch(endpoint, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(normalized),
      signal: request.signal,
      redirect: "error",
    });
    if (!response.ok || !response.body || !Array.isArray(normalized.tools) || normalized.tools.length === 0) {
      return response;
    }
    return new Response(normalizeGlmToolCallStream(response.body, normalized.tools), {
      status: response.status, headers: response.headers,
    });
  };
}
