// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { describe, expect, it, vi } from "vitest";
import { createCipheriv, pbkdf2Sync } from "node:crypto";
import { activeDescriptor, decryptMacDescriptor, decryptWindowsDescriptor, validateGateway, skillSpec, reconcileSkill, appDataPath, GATEWAY_MAX_AGE_MS } from "../grokbot-installer.mjs";

const input = { home: "/home/test", bun: "/Applications/screenpipe/bun", dataDir: "/data/custom profile", port: 3137, skill: "API reference\n" };
const spec = skillSpec(input, "Test Mac");
function fixture(initial: any[] = [], ignoreWrites = false) {
  let rows = structuredClone(initial);
  const call = vi.fn(async (name: string, args: any) => {
    if (name === "listAgents") return [{ id: "group", isGroup: true }, { id: "bot", isGroup: false }];
    if (name === "getAgentWorkflows") return structuredClone(rows);
    if (!ignoreWrites) {
      if (name === "createAgentWorkflow") rows.push({ ...args.spec, id: "screenpipe", source: "workflow" });
      if (name === "updateAgentWorkflow") rows = rows.map(row => row.id === args.workflowId ? { ...row, ...args.spec } : row);
      if (name === "deleteAgentWorkflow") rows = rows.filter(row => row.id !== args.workflowId);
    }
    return structuredClone(rows);
  });
  return { call, rows: () => rows };
}

describe("Grok Bot automatic skill installation", () => {
  it("installs into the shared store on a fresh setup, verifies it, and is idempotent", async () => {
    const f = fixture([{ id: "other", source: "workflow", name: "Unrelated skill" }]);
    expect((await reconcileSkill(f.call, spec, "connect")).connected).toBe(true);
    expect(f.rows()[0].name).toBe("Unrelated skill");
    expect(f.call).toHaveBeenCalledWith("createAgentWorkflow", { id: "bot", spec });
    f.call.mockClear();
    expect((await reconcileSkill(f.call, spec, "connect")).connected).toBe(true);
    expect(f.call.mock.calls.map(x => x[0])).toEqual(["listAgents", "getAgentWorkflows", "getAgentWorkflows"]);
  });
  it("refreshes the managed skill for the active port and profile", async () => {
    const f = fixture([{ ...spec, id: "sp", source: "workflow", body: "old instructions" }]);
    await reconcileSkill(f.call, spec, "connect");
    expect(f.call).toHaveBeenCalledWith("updateAgentWorkflow", { id: "bot", workflowId: "sp", spec });
    expect(f.rows()[0].body).toContain('"SCREENPIPE_DATA_DIR": "/data/custom profile"');
    expect(f.rows()[0].body).toContain("http://127.0.0.1:3137");
    expect(f.rows()[0].body).toContain("Never print, upload, or save the token");
    expect(f.rows()[0].trigger).toBeNull();
  });
  it("does not report connected merely because a write succeeded", async () => {
    const f = fixture([], true);
    await expect(reconcileSkill(f.call, spec, "connect")).rejects.toThrow("not confirmed");
  });
  it("does not overwrite unrelated, plugin, or duplicate skills", async () => {
    for (const rows of [
      [{ id: "other", name: spec.name, source: "workflow" }],
      [{ ...spec, id: "plugin", source: "plugin" }],
      [{ ...spec, id: "a", source: "workflow" }, { ...spec, id: "b", source: "workflow" }],
    ]) {
      const f = fixture(rows);
      await expect(reconcileSkill(f.call, spec, "connect")).rejects.toThrow();
      expect(f.call.mock.calls.every(x => ["listAgents", "getAgentWorkflows"].includes(x[0]))).toBe(true);
    }
  });
  it("removes only this computer's skill and verifies removal", async () => {
    const other = { ...skillSpec(input, "Other Mac"), id: "other", source: "workflow" };
    const f = fixture([{ ...spec, id: "sp", source: "workflow" }, other]);
    expect((await reconcileSkill(f.call, spec, "disconnect")).connected).toBe(false);
    expect(f.rows()).toEqual([other]);
    await expect(reconcileSkill(fixture([{ ...spec, id: "sp", source: "workflow" }], true).call, spec, "disconnect")).rejects.toThrow("not removed");
  });
  it("checks status without writing and handles accounts without a Bot", async () => {
    const f = fixture();
    expect((await reconcileSkill(f.call, spec, "status")).connected).toBe(false);
    expect(f.call.mock.calls.map(x => x[0])).toEqual(["listAgents", "getAgentWorkflows"]);
    await expect(reconcileSkill(async () => [], spec, "connect")).rejects.toThrow("first Bot");
  });
});

describe("Grok Bot credential boundary", () => {
  it("selects only the active account's fresh descriptor", () => {
    const accounts = { "cursor-accounts": JSON.stringify({ active: "active" }) };
    const descriptor = { version: 2, entries: { active: { encrypted: "right", savedAtMs: 10 }, other: { encrypted: "wrong", savedAtMs: 20 } } };
    expect(activeDescriptor(accounts, descriptor, 20)).toBe("right");
    expect(() => activeDescriptor(accounts, descriptor, GATEWAY_MAX_AGE_MS + 11)).toThrow();
    expect(() => activeDescriptor({ "cursor-accounts": '{"active":"signed-out"}' }, descriptor, 20)).toThrow();
    expect(() => activeDescriptor(accounts, { ...descriptor, version: 3 }, 20)).toThrow();
  });
  it("decrypts a macOS safeStorage fixture without exposing it in status", () => {
    const password = "test-only-password";
    const cipher = createCipheriv("aes-128-cbc", pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1"), Buffer.alloc(16, 32));
    const cleartext = '{"token":"test-only-gateway-token"}';
    const encrypted = Buffer.concat([Buffer.from("v10"), cipher.update(cleartext), cipher.final()]).toString("base64");
    expect(decryptMacDescriptor(encrypted, password)).toBe(cleartext);
    expect(() => decryptMacDescriptor(Buffer.from("v20-invalid").toString("base64"), password)).toThrow();
  });
  it("decrypts Windows AES-GCM using only the DPAPI-wrapped profile key", () => {
    const key = Buffer.alloc(32, 7);
    const iv = Buffer.alloc(12, 8);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const cleartext = '{"token":"windows-fixture"}';
    const data = Buffer.concat([cipher.update(cleartext), cipher.final()]);
    const encrypted = Buffer.concat([Buffer.from("v10"), iv, data, cipher.getAuthTag()]).toString("base64");
    const unprotect = vi.fn(() => key);
    const localState = { os_crypt: { encrypted_key: Buffer.from("DPAPIwrapped-fixture").toString("base64") } };
    expect(decryptWindowsDescriptor(encrypted, localState, unprotect)).toBe(cleartext);
    expect(unprotect).toHaveBeenCalledWith(Buffer.from("wrapped-fixture"));
    expect(() => decryptWindowsDescriptor(Buffer.from("v20-unsupported").toString("base64"), localState, unprotect)).toThrow();
  });
  it("restricts credentials to the Grok Bot gateway and a known network header", () => {
    const raw = { baseUrl: "https://computer.us8.cursorvm.com/", token: "fixture", headers: { "x-anyrun-network-token": "network-fixture", "X-Untrusted": "ignored" } };
    expect(validateGateway(raw).headers).not.toHaveProperty("X-Untrusted");
    for (const baseUrl of ["http://computer.cursorvm.com/", "https://cursorvm.com.evil.test/", "https://evil.test/", "https://user@computer.cursorvm.com/", "https://computer.cursorvm.com/path", "https://computer.cursorvm.com/?token=x"]) {
      expect(() => validateGateway({ ...raw, baseUrl })).toThrow();
    }
  });
  it("uses platform app data roots and isolates a supplied fixture home", () => {
    expect(appDataPath("/fixture", "darwin", {})).toBe("/fixture/Library/Application Support/Grok Bot");
    expect(appDataPath("/fixture", "win32", {})).toBe("/fixture/AppData/Roaming/Grok Bot");
    expect(appDataPath("/fixture", "linux", {})).toBe("/fixture/.config/Grok Bot");
  });
  it.each([0, 65536, "3030"])("rejects an invalid active port: %s", port => {
    expect(() => skillSpec({ ...input, port }, "Mac")).toThrow();
  });
});
