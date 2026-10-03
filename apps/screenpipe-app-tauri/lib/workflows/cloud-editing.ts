// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { tauriFetchWithDeadline } from "@/lib/http/tauri-fetch";
import { screenpipeWebUrl } from "@/lib/web-url";
import { loadCloudDraft, saveCloudDraft, loadCloudChatAppearance, saveCloudChatAppearance } from "./disk-storage";
export function createCloudWorkflowRequest(token?: string): typeof fetch {
  return async (input, init) => {
    if (!token) throw new Error("Sign in to edit your cloud workflows.");
    if (
      typeof input !== "string" ||
      !input.startsWith("/api/enterprise/member-workflows/")
    )
      throw new Error("Invalid workflow request");
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return tauriFetchWithDeadline(
      screenpipeWebUrl(input, "https://screenpipe.com"),
      { ...init, headers },
      { timeoutMs: 25_000 },
    );
  };
}
export const cloudWorkflowDrafts = {
  load: loadCloudDraft,
  save: saveCloudDraft,
};

export const cloudChatAppearance = { load: loadCloudChatAppearance, save: saveCloudChatAppearance };
