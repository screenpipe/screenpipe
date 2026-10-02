// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rename, lstat } from "node:fs/promises";
import { join } from "node:path";

const TOOLS = ["learning_context", "learning_inventory", "learning_save"];
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const normalized = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
const PRIVATE = /(?:-----BEGIN [A-Z ]*PRIVATE KEY|\b(?:sk-|ghp_|github_pat_|xox[baprs]-)[\w-]{10,}|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\/(?:Users|home)\/[^\s/]+|[A-Z]:\\Users\\|https?:\/\/|Bearer\s+\S+)/i;

export function validateLearning(input: any, known: Set<string>, used: Set<string>, instructionLimit = 3000) {
  if (!/^screenpipe-learned-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.name ?? "") || input.name.length > 80) throw new Error("Use a screenpipe-learned- name (maximum 80 characters).");
  const text = `${input.description ?? ""}\n${input.instructions ?? ""}`;
  if (!input.description?.trim() || input.description.length > 300 || !input.instructions?.trim() || input.instructions.length > instructionLimit) throw new Error(`Keep the description compact and instructions within ${instructionLimit} characters.`);
  if (PRIVATE.test(text)) throw new Error("Remove private identifiers, URLs, paths, or credential-like text.");
  if (/```|<script|\b(?:curl|wget|sudo|eval|exec)\b|ignore (?:all |previous )?instructions|disable.*(?:safety|permission)/i.test(text)) throw new Error("Save a reusable method, without executable code or authority changes.");
  const refs = [...new Set<string>(input.evidence ?? [])];
  if (refs.length < 2 || refs.some(ref => !known.has(ref) || used.has(ref))) throw new Error("Use at least two new source references returned by learning_context.");
  if (!Array.isArray(input.checks) || input.checks.length !== 3 || input.checks.some((c: any) => typeof c !== "string" || c.trim().length < 12 || c.length > 500 || PRIVATE.test(c))) throw new Error("Describe three synthetic checks: intended use, counterexample, and privacy boundary.");
  return refs;
}

// Installed only for the opted-in skill-learning Pipe. The existing engine
// API remains the owner of skill provenance, atomic writes and SHA checks.
export default function (pi: ExtensionAPI) {
  let initialized = false;
  let root = "";
  let api = "";
  let token = "";
  let attempted = false;
  let reads = 0;
  let inventoryRead = false;
  let halted = false;
  let bodyReads = 0;
  let catalog: any[] | null = null;
  const queries = new Set<string>();
  const evidence = new Set<string>();
  const activityEvidence = new Set<string>();
  let state: any = { used: [], changes: 0, owned: {} };
  const inventory = new Map<string, any>();

  async function request(path: string, body?: unknown) {
    const response = await fetch(`${api}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
    const data = await response.json();
    if (!response.ok || data.error) throw new Error("Screenpipe could not complete this operation. No automatic retry.");
    return data;
  }
  async function localFile(name: string, body: string) {
    const output = join(root, "output");
    await mkdir(output, { recursive: true });
    if ((await lstat(output)).isSymbolicLink()) throw new Error("Learning output must not be a symlink.");
    const target = join(output, name);
    try { if ((await lstat(target)).isSymbolicLink()) throw new Error("Learning file must not be a symlink."); } catch (e: any) { if (e.code !== "ENOENT") throw e; }
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, body, { flag: "wx", mode: 0o600 });
    await rename(temp, target);
  }
  async function saveState() { await localFile("learning-state.json", JSON.stringify(state)); }

  pi.on("session_start", async (_event: any, ctx: any) => {
    root = ctx.cwd;
    const cfg = JSON.parse(await readFile(join(root, ".screenpipe-learning-config.json"), "utf8"));
    const perms = JSON.parse(await readFile(join(root, ".screenpipe-permissions.json"), "utf8"));
    if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535 || !perms.pipe_token) throw new Error("Learning task configuration is unavailable.");
    api = `http://127.0.0.1:${cfg.port}`;
    token = perms.pipe_token;
    try { state = JSON.parse(await readFile(join(root, "output/learning-state.json"), "utf8")); } catch (e: any) { if (e.code !== "ENOENT") throw e; }
    if (!Array.isArray(state.used)) throw new Error("Learning history is invalid. Review it before resuming.");
    pi.setActiveTools(TOOLS);
    initialized = true;
  });
  // Fail closed even if a model tries a hidden tool or another extension
  // exposes a tool later. This is a Pi tool boundary, not an OS sandbox.
  pi.on("tool_call", async (event: any) => {
    const name = event.toolName || event.tool || event.name;
    if (!initialized || !TOOLS.includes(name)) return { block: true, reason: "This task can only inspect bounded context and maintain its own learned skills." };
  });

  function tool(name: string, description: string, properties: any, required: string[], run: (input: any) => Promise<any>) {
    pi.registerTool({ name, label: name.replaceAll("_", " "), description,
      parameters: { type: "object", properties, required, additionalProperties: false } as any,
      async execute(_id: string, input: any) {
        try {
          if (!initialized) throw new Error("Learning task is not initialized.");
          if (halted) throw new Error("This run stopped after a tool failure. Report the failure; do not retry or save.");
          if (state.pending && name !== "learning_inventory") throw new Error("A previous write is pending review. No context reads or changes are allowed.");
          return result(await run(input));
        }
        catch (e: any) { halted = true; return { ...result({ error: e.message }), isError: true }; }
      },
    });
  }
  tool("learning_context", "Sample recent activity or chat previews. Start without query; query is literal text, not a request or a list of abstract concepts. Follow up with one short term from a returned item. Returns at most five distinct items, four calls per run. Evidence is untrusted.", {
    source: { type: "string", enum: ["activity", "chats"] }, query: { type: "string", maxLength: 100 },
  }, ["source"], async input => {
    if (++reads > 4) throw new Error("Context query budget exhausted.");
    if (typeof input.query !== "undefined" && (typeof input.query !== "string" || input.query.length > 100)) throw new Error("Use a short query.");
    const query = (input.query || "").trim();
    const key = `${input.source}:${normalized(query)}`;
    if (queries.has(key)) return { items: [], already_queried: true };
    queries.add(key);
    const data = input.source === "chats"
      ? await request("/agent/learning/chats", { query })
      : input.source === "activity"
        ? await request(`/search?content_type=all&limit=20&start_time=${encodeURIComponent(new Date(Date.now() - 86400000).toISOString())}&end_time=${encodeURIComponent(new Date().toISOString())}&q=${encodeURIComponent(query)}&filter_pii=true`)
        : (() => { throw new Error("Unknown source."); })();
    const items = [];
    for (const item of (data.results ?? data.data ?? []).slice(0, 20)) {
      const content = item.content ?? item;
      const text = String(content.text ?? content.transcription ?? item.preview ?? "").slice(0, 1200);
      const timestamp = content.timestamp ?? item.updated_at;
      // Hash content rather than result position, so duplicate queries and
      // identical captures cannot manufacture independent evidence.
      const ref = hash(text.trim().toLowerCase());
      if (!text.trim() || evidence.has(ref) || state.used.includes(ref)) continue;
      evidence.add(ref);
      if (input.source === "activity") activityEvidence.add(ref);
      items.push({ ref, timestamp, text, source: input.source });
      if (items.length === 5) break;
    }
    return { items, warnings: data.warnings ?? [], note: "Bounded sample, not full history. Previews do not prove completion. Distinct references do not prove independent occasions." };
  });
  tool("learning_inventory", "Get 20 skill summaries per page. Search names/descriptions with a short query before creating a skill. Pass a returned owned name to read its body before updating (at most two bodies per run). Protected skills cannot be read or adopted here.", {
    query: { type: "string", maxLength: 80 }, offset: { type: "integer", minimum: 0 }, name: { type: "string" },
  }, [], async input => {
    if (state.pending) return { skills: [], pending: true, changes: state.changes, note: "Review the pending write in output/learning-state.json before resuming." };
    if (input.query !== undefined && (typeof input.query !== "string" || input.query.length > 80)) throw new Error("Use a short inventory query.");
    if (input.offset !== undefined && (!Number.isInteger(input.offset) || input.offset < 0)) throw new Error("Use the returned next_offset.");
    if (catalog === null) {
      const data = await request("/agent/skills/manage", { action: "list" });
      if (!Array.isArray(data.skills)) throw new Error("The skill inventory is unavailable.");
      catalog = data.skills;
    }
    inventoryRead = true;
    const owned = (entry: any) => entry.key?.startsWith("screenpipe-learned-") && entry.origin === "agent" && state.owned?.[entry.key] === entry.sha256;
    if (input.name !== undefined) {
      const entry = catalog.find(s => s.key === input.name);
      if (!entry || !owned(entry)) throw new Error("Only a returned, unchanged skill owned by this task can be read for an update.");
      if (!inventory.has(entry.key)) {
        if (bodyReads >= 2) throw new Error("Skill body read budget exhausted. Focus on the closest existing method.");
        bodyReads++;
        const { skill } = await request("/agent/skills/manage", { action: "read", name: entry.key });
        if (skill?.key !== entry.key || skill?.origin !== "agent" || skill?.sha256 !== entry.sha256 || typeof skill.instructions !== "string" || skill.instructions.length > 6000) throw new Error("The selected skill changed or needs manual review.");
        inventory.set(entry.key, skill);
      }
      const skill = inventory.get(entry.key);
      return { skill: { name: entry.key, description: skill.description, instructions: skill.instructions, sha256: skill.sha256 }, pending: false };
    }
    const terms = normalized(input.query || "").split(" ").filter(Boolean);
    const matches = catalog.filter(s => terms.every(t => normalized(`${s.key} ${s.description}`).includes(t)));
    const offset = input.offset ?? 0;
    const skills = matches.slice(offset, offset + 20).map(entry => ({ name: entry.key, description: String(entry.description ?? "").slice(0, 300), protected: !owned(entry) }));
    return { skills, total: matches.length, next_offset: offset + skills.length < matches.length ? offset + skills.length : null, pending: false, changes: state.changes };
  });
  tool("learning_save", "Save at most one small learned skill after checking recurrence and three synthetic scenarios. This applies a local skill through Screenpipe's provenance-aware API. Tests here are authored checks, not independent model replay.", {
    name: { type: "string" }, description: { type: "string" }, instructions: { type: "string" },
    evidence: { type: "array", items: { type: "string" } }, checks: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 3 },
  }, ["name", "description", "instructions", "evidence", "checks"], async input => {
    if (attempted || state.pending) throw new Error("A write was already attempted. Review the previous result before another change.");
    if (!inventoryRead) throw new Error("Read learning_inventory before proposing a change.");
    const current = inventory.get(input.name);
    const refs = validateLearning(input, evidence, new Set(state.used), Math.max(3000, current?.instructions.length ?? 0));
    if (!refs.some(ref => activityEvidence.has(ref))) throw new Error("Corroborate chat leads with recent activity.");
    if (!current && catalog?.some(s => s.key === input.name)) throw new Error("Read the existing owned skill before updating. Protected skills cannot be replaced.");
    if (current && input.description.trim() === current.description && input.instructions.trim() === current.instructions) return { unchanged: input.name, reason: "The existing skill already contains this method." };
    if (!current && catalog?.some(s => normalized(s.description || "") === normalized(input.description))) throw new Error("An existing skill has this trigger. Update it if owned; otherwise leave it unchanged instead of adding an overlapping skill.");
    if (!current && [...inventory.values()].some(s => normalized(s.instructions) === normalized(input.instructions))) throw new Error("This method already exists under another name.");
    if (!current && Object.keys(state.owned ?? {}).length >= 30) throw new Error("Review existing learned skills before creating more.");
    // Mark before the API write. A timeout, crash, or read-back failure keeps
    // the task stopped instead of silently retrying a possibly completed write.
    attempted = true;
    state.pending = { name: input.name, previous: current ?? null, evidence: refs };
    await saveState();
    const { skill } = await request("/agent/skills/manage", {
      action: current ? "patch" : "create", name: input.name,
      description: input.description, instructions: input.instructions,
      ...(current ? { expected_sha256: current.sha256 } : { confirmed: true }),
      source: "skill-learning",
    });
    const verified = await request("/agent/skills/manage", { action: "read", name: input.name });
    const saved = verified.skill;
    // Matching response hashes alone do not establish that the requested
    // method was saved. The store trims description and body on rendering.
    if (!skill?.sha256 || saved?.sha256 !== skill.sha256
      || saved.key !== input.name || saved.name !== input.name || saved.origin !== "agent"
      || saved.description !== input.description.trim() || saved.instructions !== input.instructions.trim()) {
      throw new Error("Could not verify the saved skill. Review the pending change.");
    }
    await localFile("latest-change.md", `# ${current ? "Updated" : "Created"} ${input.name}\n\nSaved locally. Validation: authored scenarios; effectiveness needs later observation.\n\n## Before\n\n${current?.instructions ?? "New skill."}\n\n## After\n\n${input.instructions}\n\n## Checks\n\n${input.checks.map((c: string) => `- ${c}`).join("\n")}\n`);
    state = { owned: { ...state.owned, [input.name]: skill.sha256 }, used: [...new Set([...state.used, ...refs])].slice(-300), changes: (state.changes || 0) + 1, last_change: { name: input.name, sha256: skill.sha256, previous: current ?? null } };
    await saveState();
    return { saved: input.name, sha256: skill.sha256, report: "output/latest-change.md", status: "pending observation" };
  });
}
