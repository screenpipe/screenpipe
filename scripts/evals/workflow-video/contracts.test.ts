// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { draft } from "./cases";
const path = process.env.VIDEO_EVAL_SOURCE ? resolve(process.env.VIDEO_EVAL_SOURCE, "video-tool.ts") : resolve(import.meta.dir, "../../../packages/workflows-ui/src/video-tool.ts");
const { default: register, applyVideoEdit } = await import(path);
let cwd: string, tools: Record<string, any>;
beforeEach(async () => {
  cwd = await mkdtemp(`${tmpdir()}/video-contract-`);
  await writeFile(`${cwd}/video-project.json`, JSON.stringify({ draft, images: {} }));
  tools = {}; register({ registerTool: (t: any) => { tools[t.name] = t; } });
});
afterEach(() => rm(cwd, { recursive: true, force: true }));
const read = (args = {}, input = ["text", "image"]) => tools.read_video_sop.execute("read", args, undefined, undefined, { cwd, model: { input } });
const edit = (changes: any[], extra = {}) => tools.edit_video_sop.execute("edit", { changes, render: false, ...extra });
test("empty edit preserves the exact saved document", () => expect(applyVideoEdit(draft, { changes: [], render: false })).toEqual(draft));
test("rejects edit before project read", async () => { await expect(edit([])).rejects.toThrow(/Read/); });
test("rejects nonexistent section inside the tool, before accepting a proposal", async () => { await read(); await expect(edit([{ id: "section-99", title: "Invented" }])).rejects.toThrow(/unknown/i); });
test("rejects a script whose combined narration exceeds the limit", async () => { await read(); await expect(edit([{ id: "section-0", narration: "a".repeat(18000) }])).rejects.toThrow(/draft/i); });
test("allows correction after a rejected proposal", async () => { await read(); try { await edit([{ id: "section-99", title: "Bad" }]); } catch {} expect((await edit([{ id: "section-0", title: "Ready" }])).content[0].text).toContain("Ready"); });
test("rejects a second accepted patch in the same turn", async () => { await read(); await edit([{ id: "section-0", title: "Ready" }]); await expect(edit([{ id: "section-1", title: "Other" }])).rejects.toThrow(/one|already/i); });
test("rejects focus without inspecting the screenshot", async () => { await read(); await expect(edit([{ id: "section-1", focus: { x: 0.5, y: 0.5, zoom: 1.3 } }])).rejects.toThrow(/Inspect/); });
test("a missing screenshot never counts as inspected", async () => { await read({ scene_id: "section-1" }); await expect(edit([{ id: "section-1", focus: { x: 0.5, y: 0.5, zoom: 1.3 } }])).rejects.toThrow(/Inspect/); });
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP2kAAAAASUVORK5CYII=", "base64");
async function image() { await writeFile(`${cwd}/video-project.json`, JSON.stringify({ draft, images: { "section-1": "image/png" } })); await writeFile(`${cwd}/section-1.image`, png); }
test("text-only model cannot gain image inspection capability", async () => { await image(); const result = await read({ scene_id: "section-1" }, ["text"]); expect(result.content[0].type).toBe("text"); await expect(edit([{ id: "section-1", focus: { x: 0.5, y: 0.5, zoom: 1.2 } }])).rejects.toThrow(/Inspect/); });
test("focus works after real image bytes are returned", async () => { await image(); expect((await read({ scene_id: "section-1" })).content[0].data).toBe(png.toString("base64")); expect((await edit([{ id: "section-1", focus: { x: 0.5, y: 0.5, zoom: 1.2 } }])).content[0].text).toContain("1.2"); });
test("does not silently discard a requested focus on a hidden image", async () => { await image(); await read({ scene_id: "section-1" }); await expect(edit([{ id: "section-1", includeImage: false, focus: { x: 0.5, y: 0.5, zoom: 1.2 } }])).rejects.toThrow(/screenshot|image/i); });
test("explicitly hiding an image clears its prior focus", () => { const before = structuredClone(draft); before.scenes[1].focus = { x: 0.5, y: 0.5, zoom: 1.2 }; expect(applyVideoEdit(before, { changes: [{ id: "section-1", includeImage: false }], render: false }).scenes[1].focus).toBeNull(); });
for (const [name, changes, extra] of [
  ["duplicate sections", [{ id: "section-0", title: "A" }, { id: "section-0", title: "B" }], {}],
  ["invalid pace", [{ id: "section-0", pace: 9 }], {}],
  ["empty order", [], { order: [] }],
  ["unknown property", [{ id: "section-0", command: "rm -rf" }], {}],
] as const) test(`rejects ${name}`, async () => { await read(); await expect(edit([...changes], extra)).rejects.toThrow(); });
test("rejects screenshot path traversal", async () => { await expect(read({ scene_id: "../../other" })).rejects.toThrow(/Unknown/); });

test("enforces a requested word limit and permits a corrected proposal", async () => {
  await read();
  await expect(edit([{ id: "section-0", narration: "Open the request; confirm its owner. If none is listed, ask the coordinator before proceeding.", maxNarrationWords: 14 }])).rejects.toThrow(/exceeds 14/);
  const patch = { changes: [{ id: "section-0", narration: "Open request; confirm owner. If missing, ask coordinator before proceeding.", maxNarrationWords: 14 }], render: false };
  expect((await tools.edit_video_sop.execute("retry", patch)).content[0].text).toContain("Open request");
  expect(applyVideoEdit(draft, patch).scenes[0]).not.toHaveProperty("maxNarrationWords");
});
for (const limit of [0, -1, 1.5, NaN, Infinity, 18001]) test(`rejects invalid word limit ${limit}`, async () => { await read(); await expect(edit([{ id: "section-0", maxNarrationWords: limit }])).rejects.toThrow(); });
