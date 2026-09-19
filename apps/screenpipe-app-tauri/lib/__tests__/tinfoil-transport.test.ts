// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { Model } from "@earendil-works/pi-ai";
import { SecureClient, Verifier } from "tinfoil";
import { CipherSuite } from "hpke";
import { KEM_DHKEM_X25519_HKDF_SHA256, KDF_HKDF_SHA256, AEAD_AES_256_GCM } from "@panva/hpke-noble";
import { bytesToHex, hexToBytes, deriveResponseKeys, encryptChunk, HPKE_REQUEST_INFO, EXPORT_LABEL, EXPORT_LENGTH } from "ehbp";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createGlmEncryptedFetch, GLM_CONFIG_REPO, GLM_ENCLAVE } from "../../../../crates/screenpipe-core/assets/extensions/lib/tinfoil-transport";
import { normalizeGlmRequest } from "../../../../crates/screenpipe-core/assets/extensions/lib/glm-protocol";

const endpoint = "https://gateway.test/v1/tinfoil/glm/chat/completions";
const model = "glm-5.3-flash-reap50-iq3m";
const init = (extra = {}) => ({
  method: "POST", headers: { Authorization: "Bearer user-token", "Content-Type": "application/json" },
  body: JSON.stringify({ model, messages: [{ role: "user", content: "PRIVATE_PROMPT_CANARY" }], stream: true, ...extra }),
});
const originalFetch = globalThis.fetch;
afterEach(() => { mock.restore(); globalThis.fetch = originalFetch; });

describe("GLM verified client transport", () => {
  it("retains the shared API's usable read contract after a full skill read is compacted", () => {
    const skill = readFileSync(resolve(import.meta.dir,
      "../../../../crates/screenpipe-core/assets/skills/screenpipe-api/SKILL.md"), "utf8");
    const request = normalizeGlmRequest({ model, messages: [
      { role: "system", content: "<available_skills><skill><name>screenpipe-api</name></skill></available_skills>" },
      { role: "tool", content: skill },
    ] });
    const visible = request.messages[1].content;
    expect(visible.length).toBeLessThanOrEqual(8000);
    expect(visible).toContain("/activity-summary?start_time=...&end_time=...");
    expect(visible).toContain("/search?start_time=...&end_time=...&content_type=all");
    expect(visible).toContain("content.transcription");
    expect(visible).toContain("Authorization: Bearer $SCREENPIPE_LOCAL_API_KEY");
    expect(visible).toContain("expected_revision, input_revision, checked_through, items, coverage");
    expect(visible).toContain("with `JSON.stringify`");
    expect(visible).toContain("read that section in a bounded range");
  });

  it("runs the installed Pi provider through real encrypted SSE and a second-turn tool replay", async () => {
    const suite = new CipherSuite(KEM_DHKEM_X25519_HKDF_SHA256, KDF_HKDF_SHA256, AEAD_AES_256_GCM);
    const pair = await suite.GenerateKeyPair(true);
    const hpkePublicKey = bytesToHex(await suite.SerializePublicKey(pair.publicKey));
    spyOn(Verifier.prototype, "verifyBundle").mockResolvedValue({ hpkePublicKey, tlsPublicKeyFingerprint: "fixture" } as any);
    let calls = 0;
    globalThis.fetch = mock(async (input, requestInit) => {
      const request = new Request(input, requestInit);
      if (request.url.endsWith("/attestation")) {
        return Response.json({ domain: new URL(GLM_ENCLAVE).host, enclaveAttestationReport: { format: "fixture", body: "fixture" } });
      }
      expect(request.url).toBe(endpoint);
      const encrypted = new Uint8Array(await request.arrayBuffer());
      expect(new TextDecoder().decode(encrypted)).not.toContain("PRIVATE_PROMPT_CANARY");
      const enc = hexToBytes(request.headers.get("Ehbp-Encapsulated-Key")!);
      const recipient = await suite.SetupRecipient(pair.privateKey, enc, { info: new TextEncoder().encode(HPKE_REQUEST_INFO) });
      const plain = JSON.parse(new TextDecoder().decode(await recipient.Open(encrypted.slice(4))));
      expect(plain.model).toBe(model);
      calls++;
      if (calls === 2) {
        const previous = plain.messages.find((m: any) => m.role === "assistant" && m.tool_calls?.length);
        expect(previous.reasoning_content).toBe("Inspect the source before answering.");
        expect(previous.content ?? "").not.toContain("Inspect the source before answering.");
        expect(previous.tool_calls[0].function.name).toBe("read");
        expect(JSON.parse(previous.tool_calls[0].function.arguments)).toEqual({ path: "file.txt" });
        expect(plain.messages).toContainEqual(expect.objectContaining({
          role: "tool", content: "tool evidence", tool_call_id: previous.tool_calls[0].id,
        }));
      }
      const content = calls === 1 ? '<tool_call>read<arg_key>path</arg_key><arg_value>file.txt</arg_value></tool_call>' : "VERIFIED_FINAL";
      const reasoning = calls === 1
        ? `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { reasoning_content: "Inspect the source before answering." } }] })}\n\n`
        : "";
      const sse = reasoning + `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { content } }] })}\n\ndata: [DONE]\n\n`;
      const nonce = crypto.getRandomValues(new Uint8Array(32));
      const secret = await recipient.Export(new TextEncoder().encode(EXPORT_LABEL), EXPORT_LENGTH);
      const keys = await deriveResponseKeys(secret, enc, nonce);
      const chunk = await encryptChunk(keys, 0, new TextEncoder().encode(sse));
      const frame = new Uint8Array(4 + chunk.length);
      new DataView(frame.buffer).setUint32(0, chunk.length);
      frame.set(chunk, 4);
      expect(new TextDecoder().decode(frame)).not.toContain("VERIFIED_FINAL");
      return new Response(frame, { headers: { 'Ehbp-Response-Nonce': bytesToHex(nonce), 'Content-Type': 'text/event-stream' } });
    }) as typeof fetch;

    // Mirror Rust's installed extension layout, including its dependency anchor.
    const dir = mkdtempSync(join(tmpdir(), "screenpipe-tinfoil-test-"));
    try {
      const source = resolve(import.meta.dir, "../../../../crates/screenpipe-core/assets/extensions");
      mkdirSync(join(dir, "lib"));
      for (const file of ["glm-protocol.ts", "tinfoil-transport.ts"]) {
        writeFileSync(join(dir, "lib", file), readFileSync(join(source, "lib", file)));
      }
      writeFileSync(join(dir, "tinfoil.ts"), readFileSync(join(source, "tinfoil.ts"), "utf8")
        .replace("__SCREENPIPE_PI_PACKAGE_JSON__", JSON.stringify(resolve(import.meta.dir, "../../package.json"))));
      const extension = (await import(pathToFileURL(join(dir, "tinfoil.ts")).href)).default;
      let provider: any;
      await extension({ on: () => {}, registerProvider: (name: string, config: any) => {
        expect(name).toBe("screenpipe");
        expect(config.api).toBe("screenpipe-tinfoil");
        expect(config.models).toBeUndefined();
        provider = config;
      } });
      const selected: Model<any> = { id: model, name: "GLM", provider: "screenpipe", api: "screenpipe-tinfoil", baseUrl: "https://gateway.test/v1", contextWindow: 32768, maxTokens: 8192, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      const context: any = { messages: [{ role: "user", content: "PRIVATE_PROMPT_CANARY", timestamp: 1 }], tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }] };
      const first = await provider.streamSimple(selected, context, { apiKey: "user-token" }).result();
      expect(first.stopReason).toBe("toolUse");
      const call = first.content.find((block: any) => block.type === "toolCall");
      expect(call.name).toBe("read");
      context.messages.push(first, { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "tool evidence" }], isError: false, timestamp: 2 });
      const second = await provider.streamSimple(selected, context, { apiKey: "user-token" }).result();
      expect(second.content).toContainEqual({ type: "text", text: "VERIFIED_FINAL" });
      expect(calls).toBe(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("pins the custom enclave and source repo, waits for verification, and preserves cancellation/auth", async () => {
    const order: string[] = [];
    const controller = new AbortController();
    const fetch = mock(async (_url, request) => {
      order.push("fetch");
      expect(new Headers(request.headers).get("Authorization")).toBe("Bearer user-token");
      expect(request.signal.aborted).toBe(false);
      expect(request.redirect).toBe("error");
      expect(JSON.parse(request.body).chat_template_kwargs).toEqual({ enable_thinking: true, reasoning_effort: "low" });
      return new Response("data: [DONE]\n\n");
    });
    const factory = mock(() => ({ ready: async () => { order.push("verify"); }, fetch }));
    const secureFetch = createGlmEncryptedFetch("https://gateway.test/v1", factory as any);
    await secureFetch(endpoint, { ...init(), signal: controller.signal });
    expect(factory).toHaveBeenCalledWith({ enclaveURL: GLM_ENCLAVE, configRepo: GLM_CONFIG_REPO, baseURL: endpoint, transport: "ehbp", userCacheSecret: expect.any(String) });
    expect(order).toEqual(["verify", "fetch"]);
  });

  it("maps ordinary reasoning settings to GLM's supported effort levels before sealing", async () => {
    const sent: any[] = [];
    const secureFetch = createGlmEncryptedFetch("https://gateway.test/v1", () => ({
      ready: async () => {},
      fetch: async (_url, request) => {
        sent.push(JSON.parse(request.body).chat_template_kwargs);
        return new Response("data: [DONE]\n\n");
      },
    }) as any);
    for (const effort of [undefined, "off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      await secureFetch(endpoint, init({ reasoning_effort: effort }));
    }
    expect(sent.map(body => body.reasoning_effort)).toEqual(["low", "low", "low", "low", "low", "high", "max", "max"]);
    expect(sent.every(body => body.enable_thinking === true)).toBe(true);
  });

  it("reserves answer/tool output while bounding reasoning inside the encrypted request", async () => {
    const sent: any[] = [];
    const secureFetch = createGlmEncryptedFetch("https://gateway.test/v1", () => ({
      ready: async () => {},
      fetch: async (_url, request) => {
        sent.push(JSON.parse(request.body));
        return new Response("data: [DONE]\n\n");
      },
    }) as any);
    for (const body of [
      {}, { reasoning_effort: "high", max_tokens: 8192 },
      { reasoning_effort: "max", max_tokens: 8192 },
      { reasoning_effort: "high", max_tokens: 1536 },
      { reasoning_effort: "max", max_completion_tokens: 128 },
    ]) await secureFetch(endpoint, init(body));
    expect(sent.map(body => body.thinking_budget_tokens)).toEqual([512, 2048, 4096, 512, 0]);
    expect(sent[3].max_tokens).toBe(1536);
    expect(sent[4].max_completion_tokens).toBe(128);
    expect(sent.every(body => body.chat_template_kwargs.enable_thinking)).toBe(true);
  });

  it("isolates prompt caches across credentials even while verification is pending", async () => {
    const configs: any[] = [];
    const sent: string[] = [];
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const transport = createGlmEncryptedFetch("https://gateway.test/v1", config => {
      const index = configs.push(config) - 1;
      return {
        ready: () => pending,
        fetch: async (_url: unknown, request?: RequestInit) => {
          sent.push(`${index}:${new Headers(request?.headers).get("Authorization")}`);
          return new Response("ok");
        },
      } as any;
    });
    const first = transport(endpoint, init());
    const second = transport(endpoint, { ...init(), headers: { Authorization: "Bearer second-user" } });
    // Both requests have yielded to parse their bodies before verification.
    await Bun.sleep(0);
    expect(configs).toHaveLength(2);
    expect(configs[0].userCacheSecret).not.toBe(configs[1].userCacheSecret);
    release();
    await Promise.all([first, second]);
    expect(sent).toEqual(["0:Bearer user-token", "1:Bearer second-user"]);
  });

  it("never sends a prompt after failed verification or cancellation", async () => {
    const fetch = mock();
    const failed = createGlmEncryptedFetch("https://gateway.test/v1", () => ({
      ready: async () => { throw new Error("measurement mismatch"); }, fetch,
    }) as any);
    await expect(failed(endpoint, init())).rejects.toThrow("measurement mismatch");
    expect(fetch).not.toHaveBeenCalled();
    const controller = new AbortController();
    const cancelled = createGlmEncryptedFetch("https://gateway.test/v1", () => ({
      ready: async () => controller.abort(), fetch,
    }) as any);
    await expect(cancelled(endpoint, { ...init(), signal: controller.signal })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects plaintext destinations and model substitution before constructing the SDK", async () => {
    const factory = mock();
    expect(() => createGlmEncryptedFetch("http://gateway.test/v1", factory)).toThrow("HTTPS");
    const fetch = createGlmEncryptedFetch("https://gateway.test/v1", factory);
    await expect(fetch("https://gateway.test/v1/chat/completions", init())).rejects.toThrow("destination");
    await expect(fetch(endpoint, init({ model: "auto" }))).rejects.toThrow("different model");
    expect(factory).not.toHaveBeenCalled();
  });

  it("prepares GLM tools before encryption and converts decrypted native tool calls for Pi", async () => {
    const tools = [
      { type: "function", function: { name: "read", parameters: { properties: { path: { type: "string" } } } } },
      { type: "function", function: { name: "subagent" } },
    ];
    const fetch = mock(async (_url, request) => {
      const body = JSON.parse(request.body);
      expect(body.tools).toHaveLength(1);
      expect(body.max_tokens).toBeGreaterThanOrEqual(4096);
      expect(body.chat_template_kwargs.enable_thinking).toBe(true);
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: '<tool_call>read<arg_key>path</arg_key><arg_value>file.txt</arg_value></tool_call>' } }] })}\n\ndata: [DONE]\n\n`);
    });
    const clientFetch = createGlmEncryptedFetch("https://gateway.test/v1", () => ({ ready: async () => {}, fetch }) as any);
    const response = await clientFetch(endpoint, init({ tools, max_tokens: 1, reasoning_effort: "high" }));
    const text = await response.text();
    expect(text).toContain('"tool_calls"');
    expect(text).toContain('"name":"read"');
    expect(text).toContain('file.txt');
    expect(text).toContain('[DONE]');
  });

  it("uses real SDK encryption and rejects an unencrypted successful response", async () => {
    // Only hardware verification is stubbed. EHBP/HPKE and response validation
    // are the real pinned SDK; the generated key belongs to this test alone.
    const suite = new CipherSuite(KEM_DHKEM_X25519_HKDF_SHA256, KDF_HKDF_SHA256, AEAD_AES_256_GCM);
    const pair = await suite.GenerateKeyPair(true);
    const hpkePublicKey = bytesToHex(await suite.SerializePublicKey(pair.publicKey));
    spyOn(Verifier.prototype, "verifyBundle").mockResolvedValue({ hpkePublicKey, tlsPublicKeyFingerprint: "fixture" } as any);
    const network = mock(async (input: any, requestInit?: RequestInit) => {
      const request = new Request(input, requestInit);
      if (request.url.endsWith("/attestation")) {
        expect(request.headers.get("Authorization")).toBeNull();
        expect(await request.json()).toEqual({ enclaveUrl: GLM_ENCLAVE, repo: GLM_CONFIG_REPO });
        return Response.json({ domain: new URL(GLM_ENCLAVE).host, enclaveAttestationReport: { format: "fixture", body: "fixture" } });
      }
      expect(request.url).toBe(endpoint);
      expect(request.headers.get("X-Tinfoil-Enclave-Url")).toBe(GLM_ENCLAVE);
      expect(request.headers.get("Ehbp-Encapsulated-Key")).toMatch(/^[a-f0-9]{64}$/);
      expect(await request.text()).not.toContain("PRIVATE_PROMPT_CANARY");
      return new Response("PLAINTEXT_RESPONSE_CANARY");
    });
    globalThis.fetch = network as typeof fetch;
    const clientFetch = createGlmEncryptedFetch("https://gateway.test/v1", config => new SecureClient({ ...config, userCacheSecret: "test-cache-scope" }));
    await expect(clientFetch(endpoint, init())).rejects.toThrow();
    expect(network).toHaveBeenCalledTimes(2);
  });

  it("does not reach the relay when the real SDK verifier rejects the bundle", async () => {
    spyOn(Verifier.prototype, "verifyBundle").mockRejectedValue(new Error("invalid hardware signature"));
    const network = mock(async () => Response.json({ domain: new URL(GLM_ENCLAVE).host, enclaveAttestationReport: { format: "fixture", body: "fixture" } }));
    globalThis.fetch = network as typeof fetch;
    const clientFetch = createGlmEncryptedFetch("https://gateway.test/v1", config => new SecureClient({ ...config, userCacheSecret: "test-cache-scope" }));
    await expect(clientFetch(endpoint, init())).rejects.toThrow("invalid hardware signature");
    expect(network).toHaveBeenCalledTimes(1);
  });
});


describe("confidential verification status", () => {
  const proof = { securityVerified: true, configRepo: GLM_CONFIG_REPO, enclaveHost: new URL(GLM_ENCLAVE).host, codeFingerprint: "a".repeat(96), enclaveFingerprint: "a".repeat(96), hpkePublicKey: "b".repeat(64), releaseTag: "fixture", verifiedAt: new Date().toISOString(), secretField: "must not cross UI" };
  it("only reports a verified response after all decrypted chunks complete and filters evidence", async () => {
    const updates: any[] = [];
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const transport = createGlmEncryptedFetch("https://gateway.test/v1", () => ({ ready: async () => {}, getVerificationDocument: () => proof, fetch: async () => new Response(new ReadableStream({ start(value) { controller = value; } })) }), value => updates.push(value));
    const response = await transport(endpoint, init());
    expect(updates.map(v => v.state)).toEqual(["verifying", "attested"]);
    expect(updates[1].document.secretField).toBeUndefined();
    controller.enqueue(new TextEncoder().encode("answer"));
    const body = response.text();
    expect(updates.some(v => v.state === "response_verified")).toBe(false);
    controller.close();
    expect(await body).toBe("answer");
    expect(updates.map(v => v.state)).toEqual(["verifying", "attested", "response_verified"]);
    expect(new Set(updates.map(v => v.requestId)).size).toBe(1);
  });
  it("reports failure rather than verified when decryption fails midstream", async () => {
    const updates: any[] = [];
    const transport = createGlmEncryptedFetch("https://gateway.test/v1", () => ({ ready: async () => {}, getVerificationDocument: () => proof, fetch: async () => new Response(new ReadableStream({ pull(controller) { controller.error(new Error("authentication failed")); } })) }), value => updates.push(value));
    const response = await transport(endpoint, init());
    await expect(response.text()).rejects.toThrow("authentication failed");
    expect(updates.at(-1).state).toBe("failed");
    expect(updates.some(v => v.state === "response_verified")).toBe(false);
  });
  it("reports blocked verification without sending or leaking the error", async () => {
    const updates: any[] = []; let sent = false;
    const transport = createGlmEncryptedFetch("https://gateway.test/v1", () => ({ ready: async () => { throw Error("private internal detail"); }, fetch: async () => { sent = true; return new Response(); } }), value => updates.push(value));
    await expect(transport(endpoint, init())).rejects.toThrow();
    expect(sent).toBe(false);
    expect(updates.map(v => v.state)).toEqual(["verifying", "failed"]);
    expect(JSON.stringify(updates)).not.toContain("private internal detail");
  });
});
