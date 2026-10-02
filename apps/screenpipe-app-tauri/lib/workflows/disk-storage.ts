// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { BaseDirectory } from "@tauri-apps/api/path";
import {
  exists,
  mkdir,
  readTextFile,
  remove,
  rename,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import type { WorkProfile, WorkflowAnalysis, WorkflowSkillDraft } from "@screenpipe/workflows-ui";
import { serializeWorkflowData, parseGuide, type WorkflowGuide, isAssistantState, type AssistantState } from "@screenpipe/workflows-ui";

const STORAGE_DIRECTORY = "workflows";
const CATALOG_PATH = `${STORAGE_DIRECTORY}/catalog.json`;
const CATALOG_BACKUP_PATH = `${STORAGE_DIRECTORY}/catalog.backup.json`;
const PROFILE_PATH = `${STORAGE_DIRECTORY}/profile.json`;
const PROFILE_BACKUP_PATH = `${STORAGE_DIRECTORY}/profile.backup.json`;
const BASE_OPTIONS = { baseDir: BaseDirectory.AppLocalData } as const;
const RENAME_OPTIONS = {
  oldPathBaseDir: BaseDirectory.AppLocalData,
  newPathBaseDir: BaseDirectory.AppLocalData,
} as const;

let writeQueue: Promise<void> = Promise.resolve();

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

export function isStoredWorkflowAnalysis(value: unknown): value is WorkflowAnalysis {
  const analysis = asRecord(value);
  const body = asRecord(analysis?.analysis);
  return analysis?.schemaVersion === 5 && Array.isArray(body?.workflows);
}

export function isStoredWorkProfile(value: unknown): value is WorkProfile {
  const profile = asRecord(value);
  return Boolean(
    profile &&
    typeof profile.summary === "string" &&
    typeof profile.priorities === "string" &&
    typeof profile.vocabulary === "string" &&
    typeof profile.guidance === "string" &&
    Array.isArray(profile.kpis),
  );
}

async function readValidated<T>(
  primaryPath: string,
  backupPath: string,
  validate: (value: unknown) => value is T,
  label: string,
): Promise<T | null> {
  let foundFile = false;
  for (const path of [primaryPath, backupPath]) {
    if (!(await exists(path, BASE_OPTIONS))) continue;
    foundFile = true;
    try {
      const parsed = JSON.parse(await readTextFile(path, BASE_OPTIONS)) as unknown;
      if (validate(parsed)) return parsed;
    } catch {
      // Keep trying the backup. Neither file is deleted on a failed read.
    }
  }
  if (foundFile) throw new Error(`The saved ${label} is unreadable. Its files were left untouched.`);
  return null;
}

async function replaceWithBackup(path: string, backupPath: string, value: unknown, validate: (value: unknown) => boolean) {
  await mkdir(STORAGE_DIRECTORY, { ...BASE_OPTIONS, recursive: true });
  const temporaryPath = `${path}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  // Resolve the last valid value before touching either file. A corrupt primary
  // must never replace the good backup that allowed recovery.
  const previous = await readValidated(path, backupPath, (v): v is unknown => validate(v), "data");
  let movedPrevious = false;
  try {
    await writeTextFile(temporaryPath, serializeWorkflowData(value), BASE_OPTIONS);
    if (previous !== null) {
      // Preserve the validated recovery value even when the current primary is corrupt.
      const backupTemporary = `${temporaryPath}.backup`;
      try {
        await writeTextFile(backupTemporary, serializeWorkflowData(previous), BASE_OPTIONS);
        await rename(backupTemporary, backupPath, RENAME_OPTIONS);
      } finally {
        if (await exists(backupTemporary, BASE_OPTIONS)) await remove(backupTemporary, BASE_OPTIONS);
      }
      movedPrevious = true;
    }
    await rename(temporaryPath, path, RENAME_OPTIONS);
  } catch (error) {
    try {
      if (await exists(temporaryPath, BASE_OPTIONS)) await remove(temporaryPath, BASE_OPTIONS);
    } catch {
      // The orphaned temporary file is harmless and never read as saved data.
    }
    if (movedPrevious) {
      try {
        if (!(await exists(path, BASE_OPTIONS)) && await exists(backupPath, BASE_OPTIONS)) {
          await rename(backupPath, path, RENAME_OPTIONS);
        }
      } catch {
        // The previous file remains recoverable at the backup path.
      }
    }
    throw error;
  }
}

function queueWrite(task: () => Promise<void>) {
  const result = writeQueue.then(task, task);
  writeQueue = result.catch(() => undefined);
  return result;
}

export function loadWorkflowAnalysisFromDisk() {
  return readValidated(CATALOG_PATH, CATALOG_BACKUP_PATH, isStoredWorkflowAnalysis, "workflow catalog");
}

export function saveWorkflowAnalysisToDisk(analysis: WorkflowAnalysis) {
  return queueWrite(() => replaceWithBackup(CATALOG_PATH, CATALOG_BACKUP_PATH, analysis, isStoredWorkflowAnalysis));
}

export function loadWorkProfileFromDisk() {
  return readValidated(PROFILE_PATH, PROFILE_BACKUP_PATH, isStoredWorkProfile, "work profile");
}

export function saveWorkProfileToDisk(profile: WorkProfile) {
  return queueWrite(() => replaceWithBackup(PROFILE_PATH, PROFILE_BACKUP_PATH, profile, isStoredWorkProfile));
}

export function resetWorkflowDiskStorageForTests() {
  writeQueue = Promise.resolve();
}

export function loadAssistantFromDisk() {
  return readValidated("workflows/assistant.json", "workflows/assistant.backup.json", isAssistantState, "conversations");
}

export function saveAssistantToDisk(state: AssistantState) {
  return queueWrite(() => replaceWithBackup("workflows/assistant.json", "workflows/assistant.backup.json", state, isAssistantState));
}

// Guide drafts share the app's serialized, recoverable file writes.
function isGuideStore(value: unknown): value is Record<string, WorkflowGuide> {
  if (!asRecord(value) || Array.isArray(value)) return false;
  try {
    return Object.entries(value as Record<string, unknown>).every(([key, guide]) => parseGuide(guide).workflowKey === key);
  } catch { return false; }
}
const readGuides = () => readValidated("workflows/guides.json", "workflows/guides.backup.json", isGuideStore, "guides");

export async function loadGuideFromDisk(key: string) {
  await writeQueue;
  const guides = await readGuides();
  return guides && Object.hasOwn(guides, key) ? parseGuide(guides[key]) : null;
}
export function saveGuideToDisk(guide: WorkflowGuide) {
  return queueWrite(async () => {
    const validated = parseGuide(guide);
    const guides = await readGuides();
    await replaceWithBackup("workflows/guides.json", "workflows/guides.backup.json", { ...guides, [validated.workflowKey]: validated }, isGuideStore);
  });
}


export async function listGuidesFromDisk() {
  await writeQueue;
  return Object.values(await readGuides() ?? {}).map(guide => parseGuide(guide));
}

type SkillDraftStore = Record<string, WorkflowSkillDraft>;
function isSkillDraftStore(value: unknown): value is SkillDraftStore {
  if (!asRecord(value) || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(draft => {
    const d = asRecord(draft);
    return d && ["name", "description", "instructions", "sourceWorkflow"].every(key => typeof d[key] === "string" && d[key].length <= 20000);
  });
}
const readSkillDrafts = () => readValidated("workflows/skill-drafts.json", "workflows/skill-drafts.backup.json", isSkillDraftStore, "skill drafts");
export async function listSkillDraftsFromDisk() {
  await writeQueue;
  return Object.entries(await readSkillDrafts() ?? {}).map(([workflowKey, draft]) => ({ workflowKey, draft }));
}
export function saveSkillDraftToDisk(workflowKey: string, draft: WorkflowSkillDraft) {
  return queueWrite(async () => {
    if (!workflowKey || !isSkillDraftStore({ [workflowKey]: draft })) throw new Error("Invalid skill draft");
    const drafts = await readSkillDrafts();
    await replaceWithBackup("workflows/skill-drafts.json", "workflows/skill-drafts.backup.json", { ...drafts, [workflowKey]: draft }, isSkillDraftStore);
  });
}
