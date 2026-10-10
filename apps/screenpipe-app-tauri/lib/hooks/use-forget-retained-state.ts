// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { emit } from "@tauri-apps/api/event";
import {
  clearRetainedState,
  updateRetainedState,
} from "@/lib/hooks/use-retained-state";
import { useTauriEvent } from "@/lib/hooks/use-tauri-event";

// Sent to every window when recorded data is deleted or the data folder
// changes. Each window keeps its own retained values, so each must forget them.
const RECORDED_DATA_DELETED = "recorded-data-deleted";

/** History's retained chat list (components/chat/chat-history-view.tsx). */
export const CHAT_HISTORY_LIST_KEY = "chatHistory:list";

/**
 * After recorded data is deleted or the data folder changes: forget retained
 * values in every window, so each section's next visit loads from scratch
 * instead of showing data that is gone.
 */
export async function forgetRetainedStateEverywhere(): Promise<void> {
  clearRetainedState();
  try {
    await emit(RECORDED_DATA_DELETED);
  } catch (error) {
    console.warn("failed to tell other windows that data was deleted", error);
  }
}

/** Mount once per window: drops deleted data from its retained values. */
export function useForgetRetainedStateOnDeletion() {
  useTauriEvent(RECORDED_DATA_DELETED, clearRetainedState);
  // A chat deleted while History is closed must not show again, title and
  // all, on its next visit. An open History reloads on this event itself.
  useTauriEvent<{ id?: string }>("chat-deleted", ({ payload }) =>
    updateRetainedState<{ id: string }[]>(CHAT_HISTORY_LIST_KEY, (chats) =>
      chats.filter((chat) => chat.id !== payload?.id),
    ),
  );
}
