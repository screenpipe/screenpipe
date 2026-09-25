// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { useCallback, useEffect, useRef, useState } from "react";
import { useChatStore } from "@/lib/stores/chat-store";

type SplitAction = "send" | "stop";
interface Request { id: string; action: SplitAction; ready: boolean }

/** Reuse the established session transport after its draft/model restore has
 * completed. A visible secondary composer never dispatches against the old
 * foreground session, and navigation cancels a pending handoff. */
export function useSplitChatActions({
  conversationId, activate, send, stop, canSend, preparing, input, focus, onError,
}: {
  conversationId: string | null;
  activate: (id: string) => Promise<void>;
  send: (text: string) => Promise<void>;
  stop: () => void | Promise<void>;
  canSend: boolean;
  preparing: boolean;
  input: string;
  focus: () => void;
  onError: () => void;
}) {
  const [request, setRequest] = useState<Request | null>(null);
  const requestRef = useRef<Request | null>(null);
  const run = useCallback(async (id: string, action: SplitAction) => {
    if (requestRef.current) return;
    const next = { id, action, ready: false };
    requestRef.current = next;
    setRequest(next);
    try {
      await activate(id);
      if (requestRef.current !== next) return;
      const state = useChatStore.getState();
      if (state.currentId !== id || !state.sessions[id] || state.sessions[id].hidden) {
        requestRef.current = null;
        setRequest(null);
        return;
      }
      const ready = { ...next, ready: true };
      requestRef.current = ready;
      setRequest(ready);
    } catch {
      if (requestRef.current !== next) return;
      requestRef.current = null;
      setRequest(null);
      onError();
    }
  }, [activate, onError]);

  useEffect(() => {
    if (!request?.ready) return;
    const state = useChatStore.getState();
    if (state.currentId !== request.id || !state.sessions[request.id] || state.sessions[request.id].hidden) {
      requestRef.current = null;
      setRequest(null);
      return;
    }
    if (conversationId !== request.id || preparing) return;
    // Claim once before dispatch, including under Strict Mode effect replay.
    if (requestRef.current !== request) return;
    requestRef.current = null;
    setRequest(null);
    focus();
    if (request.action === "send" && !canSend) return; // Draft stays in the restored composer.
    const result = request.action === "send" ? send(input) : stop();
    Promise.resolve(result).catch(onError);
  }, [request, conversationId, preparing, canSend, input, send, stop, focus, onError]);

  useEffect(() => useChatStore.subscribe((state, previous) => {
    const pending = requestRef.current;
    if (pending && state.currentId !== previous.currentId && state.currentId !== pending.id) {
      requestRef.current = null;
      setRequest(null);
    }
  }), []);
  useEffect(() => () => { requestRef.current = null; }, []);
  return { run, pendingId: request?.id ?? null };
}
