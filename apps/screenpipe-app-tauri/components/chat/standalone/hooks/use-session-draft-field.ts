// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import {
  useCallback,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useChatStore, type SessionDraft } from "@/lib/stores/chat-store";

const EMPTY_DRAFT: SessionDraft = {
  input: "",
  pastedImages: [],
  attachedDocs: [],
  pendingDocs: [],
};

/** Scoped setters retain their owner across async file reads and pane changes. */
export function useSessionDraftField<
  K extends keyof SessionDraft,
  T extends SessionDraft[K],
>(
  sessionId: string | undefined,
  key: K,
  initial: T,
): [T, Dispatch<SetStateAction<T>>] {
  const [local, setLocal] = useState(initial);
  const stored = useChatStore((state) =>
    sessionId ? state.sessions[sessionId]?.composerDraft?.[key] : undefined,
  );
  const setValue = useCallback<Dispatch<SetStateAction<T>>>(
    (update) => {
      if (!sessionId) {
        setLocal(update);
        return;
      }
      const state = useChatStore.getState();
      if (!state.sessions[sessionId] || state.sessions[sessionId].hidden)
        return;
      const draft = state.sessions[sessionId].composerDraft ?? EMPTY_DRAFT;
      const value =
        typeof update === "function" ? update(draft[key] as T) : update;
      state.actions.setComposerDraft(sessionId, { ...draft, [key]: value });
    },
    [sessionId, key],
  );
  return [sessionId ? ((stored ?? EMPTY_DRAFT[key]) as T) : local, setValue];
}
