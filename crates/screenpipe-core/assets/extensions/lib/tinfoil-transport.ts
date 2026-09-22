// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { normalizeGlmRequest, normalizeGlmToolCallStream, SCREENPIPE_GLM_MODEL } from "./glm-protocol";

export const GLM_ENCLAVE = "https://pii.screenpipe.containers.tinfoil.dev";
export const GLM_CONFIG_REPO = "screenpipe/privacy-filter";
export const GLM_SECURE_API = "screenpipe-tinfoil";

export type VerificationUpdate = { requestId: string; state: "verifying" | "attested" | "response_verified" | "failed"; document?: Record<string, unknown> };
type VerifiedClient = { ready(): Promise<unknown>; fetch: typeof fetch; getVerificationDocument?(): unknown };
type ClientFactory = (options: {
  enclaveURL: string; configRepo: string; baseURL: string; transport: "ehbp"; userCacheSecret: string;
}) => VerifiedClient;

/** Local-only adapter. No plaintext fetch or gateway fallback is permitted. */
export function createGlmEncryptedFetch(baseURL: string, createClient: ClientFactory, onVerification?: (update: VerificationUpdate) => void): typeof fetch {
  const gateway = new URL(baseURL);
  if (gateway.protocol !== "https:" || gateway.username || gateway.password || gateway.search || gateway.hash) {
    throw new Error("Confidential GLM requires an HTTPS gateway URL");
  }
  const endpoint = `${baseURL.replace(/\/$/, "")}/tinfoil/glm/chat/completions`;
  let client: VerifiedClient | undefined;
  let clientAuth: string | null | undefined;
  return async (input, init) => {
    const requestId = crypto.randomUUID();
    let document: Record<string, unknown> | undefined;
    const report = (state: VerificationUpdate["state"]) => {
      // UI delivery must never alter transport or expose auth/session secrets.
      try { onVerification?.({ requestId, state, ...(document ? { document } : {}) }); } catch {}
    };
    report("verifying");
    try {
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
      // GLM 5.3 is a reasoning-only model with low/high/max effort. The old
      // enable_thinking=false switch suppresses its reasoning delimiter, not
      // its reasoning budget, and can leak thoughts into visible content.
      // There is no medium level: unsupported values otherwise become max.
      normalized.chat_template_kwargs = {
        enable_thinking: true,
        reasoning_effort: ["xhigh", "max"].includes(body.reasoning_effort)
          ? "max" : body.reasoning_effort === "high" ? "high" : "low",
      };
      // Effort is guidance, not a generation limit. Bound each response's
      // reasoning while reserving output for its answer or tool arguments.
      // Enforced inside the attested llama.cpp sampler, including tool turns.
      const effort = normalized.chat_template_kwargs.reasoning_effort;
      const reasoningBudget = effort === "max" ? 4096 : effort === "high" ? 2048 : 512;
      const outputLimit = normalized.max_completion_tokens ?? normalized.max_tokens ?? 8192;
      normalized.thinking_budget_tokens = Math.min(reasoningBudget, Math.max(0, outputLimit - 1024));
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
      const proof = verifiedClient.getVerificationDocument?.() as Record<string, unknown> | undefined;
      if (proof?.securityVerified === true) {
        // Only public attestation evidence crosses the UI boundary.
        document = Object.fromEntries(["schemaVersion", "configRepo", "enclaveHost", "releaseTag", "releaseDigest", "codeFingerprint", "enclaveFingerprint", "hpkePublicKey", "verifiedAt", "securityVerified", "verifier", "steps"].filter(key => key in proof).map(key => [key, proof[key]]));
        report("attested");
      }
      request.signal.throwIfAborted();
      const response = await verifiedClient.fetch(endpoint, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(normalized),
        signal: request.signal,
        redirect: "error",
      });
      if (!response.ok || !response.body) {
        report("failed");
        return response;
      }
      // SecureClient's body is already authenticated/decrypted. Report complete
      // only after every chunk has been read successfully, never on HTTP 200.
      const reader = response.body.getReader();
      let finished = false;
      const authenticatedBody = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              finished = true;
              if (document) report("response_verified");
              controller.close();
            } else controller.enqueue(value);
          } catch (error) { report("failed"); controller.error(error); }
        },
        async cancel(reason) { if (!finished) report("failed"); await reader.cancel(reason); },
      });
      const decodedBody = Array.isArray(normalized.tools) && normalized.tools.length > 0
        ? normalizeGlmToolCallStream(authenticatedBody, normalized.tools) : authenticatedBody;
      return new Response(decodedBody, { status: response.status, headers: response.headers });
    } catch (error) { report("failed"); throw error; }
  };
}
