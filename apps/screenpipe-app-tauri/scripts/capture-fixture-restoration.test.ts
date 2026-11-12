// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import ts from "typescript";
import { test } from "bun:test";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import assert from "node:assert/strict";
const file = resolve(import.meta.dir, "../e2e/specs/starred-session-popover.spec.ts");
const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
// Execute the real cleanup block, with only native IPC and health I/O replaced.
// This catches a dropped start intent without copying its retry implementation.
const blocks: ts.Block[] = [];
function visit(node: ts.Node) {
    if (ts.isTryStatement(node) && node.finallyBlock) {
        const text = node.finallyBlock.getText(source);
        if (text.includes('getLocalApiConfig') && text.includes('"spawn_screenpipe"'))
            blocks.push(node.finallyBlock);
    }
    ts.forEachChild(node, visit);
}
visit(source);
blocks.sort((a, b) => a.getWidth(source) - b.getWidth(source));
assert.ok(blocks.length);
const script = ts.transpile(`(async()=>${blocks[0].getText(source)})()`);
test.each(["busy-once", "native-error", "never-healthy", "already-healthy"])("Capture fixture restoration: %s", async (mode) => {
    let calls = 0, healthy = mode === "already-healthy", healthReads = 0;
    const context = {
        t: (n: number) => n, getLocalApiConfig: async () => ({ port: 11437, key: "fixture-local-key" }), authHeaders: (key: string) => ({ Authorization: `Bearer ${key}` }),
        invokeOrThrow: async (command: string) => { assert.equal(command, "spawn_screenpipe"); calls++; if (mode === "native-error")
            throw Error("native access rejected"); if (mode === "busy-once" && calls > 1)
            healthy = true; },
        fetchJson: async (url: string, headers: any) => { assert.equal(url, "http://127.0.0.1:11437/health"); assert.equal(headers.Authorization, "Bearer fixture-local-key"); healthReads++; return { ok: healthy }; },
        browser: { waitUntil: async (condition: () => Promise<boolean>, opts: any) => { assert.equal(opts.timeout, 30000); for (let i = 0; i < 5; i++)
                if (await condition())
                    return; throw Error("health unavailable"); } },
    };
    const result = runInNewContext(script, context);
    if (mode === "busy-once") {
        await result;
        assert.equal(calls, 2);
        assert.ok(healthReads > 1);
        assert.equal(healthy, true);
    }
    else if (mode === "already-healthy") {
        await result;
        assert.equal(calls, 0);
    }
    else if (mode === "native-error") {
        await assert.rejects(result, /native access rejected/);
        assert.equal(calls, 1);
    }
    else {
        await assert.rejects(result, /health unavailable/);
        assert.equal(healthy, false);
    }
});
