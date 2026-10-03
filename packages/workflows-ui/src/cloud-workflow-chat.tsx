// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  cloudWorkflowRequest,
  CloudWorkflowAccessError,
  type CloudEditProposal,
  type CloudWorkflowIdentity,
} from "./cloud-workflow";
import styles from "./cloud-workflow.module.css";
import { WorkflowAssistant, type WorkflowAssistantSession } from "./workflow-assistant";
import { emptyAssistantState, type WorkflowsAssistantPlatform } from "./assistant";
import { PageAssistantContext } from "./page-assistant";
const noAsk: WorkflowsAssistantPlatform["ask"] = async () => { throw new Error("Cloud chat requires its member transport"); };
type Message = {
  id: string;
  role: "user" | "assistant";
  parts: Array<{ type: string; text?: string; proposal?: CloudEditProposal }>;
  metadata?: { studio_turn_id: string; studio_turn_complete: boolean };
};
type Conversation = {
  id: string;
  revision: number;
  messages: Message[];
  composer: string;
  pending_turn?: {
    turn_id: string;
    messages: Array<{ role: string; text: string }>;
  };
};
type Event = {
  type: string;
  id?: string;
  text?: string;
  name?: string;
  output?: { proposal?: CloudEditProposal };
  input?: unknown;
};
export function cloudTurnHistory(messages: Message[]) {
  const history: Array<{ role: "user" | "assistant"; text: string }> = [];
  let size = 0;
  for (const message of [...messages].reverse()) {
    const text = message.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text || "")
      .join("\n")
      .slice(0, 8000);
    if (!text) continue;
    if (size + text.length > 24000 || history.length >= 40) break;
    history.unshift({ role: message.role, text });
    size += text.length;
  }
  return history;
}
const pause = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, 1200);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
export function projectCloudTurn(events: Event[], turnId: string): Message {
  const parts = new Map<string, Message["parts"][number]>();
  for (const event of events) {
    if (event.type === "text")
      parts.set(`text:${event.id}`, { type: "text", text: event.text || "" });
    if (
      event.type === "tool_result" &&
      event.name === "propose_workflow_edit" &&
      event.output?.proposal
    )
      parts.set(`proposal:${event.id}`, {
        type: "workflow-proposal",
        proposal: event.output.proposal,
      });
  }
  return {
    id: `response-${turnId}`,
    role: "assistant",
    parts: Array.from(parts.values()),
    metadata: { studio_turn_id: turnId, studio_turn_complete: true },
  };
}
/** The same durable conversation UI on web and desktop; transport is host-owned. */
export function CloudWorkflowChat({
  identity,
  title = "This workflow",
  appearance,
  request,
  canApply = true,
  onApplied,
  onDenied,
}: {
  identity: CloudWorkflowIdentity;
  title?: string;
  appearance?: Pick<WorkflowsAssistantPlatform, "load" | "save">;
  request: typeof fetch;
  canApply?: boolean;
  onApplied: () => void;
  onDenied: () => void;
}) {
  const mountAssistant = useContext(PageAssistantContext);
  const [docked, setDocked] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(420);
  const platform = useMemo<WorkflowsAssistantPlatform>(() => ({
    ask: noAsk,
    load: appearance?.load ?? (async () => {
      const state = emptyAssistantState();
      try { const prefs = JSON.parse(localStorage.getItem("screenpipe:cloud-chat-display") || "null");
        if (["floating", "sidebar"].includes(prefs?.mode)) state.mode = prefs.mode;
        if (Number.isFinite(prefs?.sidebarWidth)) state.sidebarWidth = prefs.sidebarWidth;
      } catch { /* Appearance is optional; conversation storage is server-owned. */ }
      return state;
    }),
    save: appearance?.save ?? (async state => { localStorage.setItem("screenpipe:cloud-chat-display", JSON.stringify({ mode: state.mode, sidebarWidth: state.sidebarWidth })); }),
  }), [appearance]);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [draft, setDraft] = useState("");
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState<Message | null>(null);
  const [retry, setRetry] = useState<Conversation["pending_turn"]>();
  const [proposal, setProposal] = useState<CloudEditProposal | null>(null);
  const [applied, setApplied] = useState("");
  const current = useRef<Conversation | null>(null);
  const alive = useRef<AbortController | undefined>(undefined);
  const running = useRef(false);
  const callbacks = useRef({ onApplied, onDenied });
  callbacks.current = { onApplied, onDenied };
  const creation = useRef(crypto.randomUUID());
  const key = JSON.stringify(identity);
  const loadedKey = useRef("");
  const fail = (cause: unknown) => {
    if (cause instanceof CloudWorkflowAccessError) {
      current.current = null;
      setConversation(null);
      setLive(null);
      setDraft("");
      callbacks.current.onDenied();
    }
    setError(
      cause instanceof Error
        ? cause.message
        : "Could not reconnect. Try again.",
    );
  };
  const update = (value: Conversation) => {
    current.current = value;
    setConversation(value);
  };
  async function persist(
    value: Conversation,
    messages: Message[],
    composer: string,
    signal: AbortSignal,
  ) {
    const result = await cloudWorkflowRequest(
      request,
      "chat",
      identity,
      "PUT",
      {
        conversation_id: value.id,
        expected_revision: value.revision,
        messages,
        composer,
      },
      signal,
    );
    signal.throwIfAborted();
    update(result.conversation);
    return result.conversation as Conversation;
  }
  async function receive(
    value: Conversation,
    turn: NonNullable<Conversation["pending_turn"]>,
    signal: AbortSignal,
  ) {
    setRetry(turn);
    let after = 0;
    const events: Event[] = [];
    const deadline = Date.now() + 180_000;
    while (!signal.aborted && Date.now() < deadline) {
      const page = await cloudWorkflowRequest(
        request,
        "chat/turn",
        identity,
        "GET",
        {
          conversation_id: value.id,
          turn_id: turn.turn_id,
          after: String(after),
        },
        signal,
      );
      signal.throwIfAborted();
      events.push(...page.events);
      after = page.cursor;
      const message = projectCloudTurn(events, turn.turn_id);
      setLive(message);
      if (["completed", "failed", "cancelled"].includes(page.status)) {
        if (page.status !== "completed")
          message.parts.push({
            type: "text",
            text:
              page.status === "cancelled"
                ? "Response stopped."
                : page.errorCode === "runner_tools_unavailable"
                  ? "Ask your admin to update the workspace runner before trying again."
                  : "The workspace agent could not finish this response. Send a new message to try again.",
          });
        await persist(
          current.current || value,
          [
            ...(current.current || value).messages.filter(
              (m) => m.id !== message.id,
            ),
            message,
          ],
          draftRef.current,
          signal,
        );
        setLive(null);
        setRetry(undefined);
        return;
      }
      if (!page.hasMore) await pause(signal);
    }
    if (!signal.aborted)
      throw new Error(
        "The workspace agent is still working. Reconnect to continue this response.",
      );
  }
  useEffect(() => {
    const controller = new AbortController();
    alive.current = controller;
    creation.current = crypto.randomUUID();
    const preservedDraft = loadedKey.current === key ? draftRef.current : "";
    loadedKey.current = key;
    setLoading(true);
    setError("");
    setDraft(preservedDraft);
    setConversation(null);
    current.current = null;
    setLive(null);
    setProposal(null);
    setRetry(undefined);
    void (async () => {
      try {
        const result = await cloudWorkflowRequest(
          request,
          "chat",
          identity,
          "GET",
          undefined,
          controller.signal,
        );
        controller.signal.throwIfAborted();
        update(result.conversation);
        setDraft(preservedDraft || result.conversation?.composer || "");
        setLoading(false);
        if (result.conversation?.pending_turn) {
          running.current = true;
          setBusy(true);
          await receive(
            result.conversation,
            result.conversation.pending_turn,
            controller.signal,
          );
        }
      } catch (cause) {
        if (!controller.signal.aborted) fail(cause);
      } finally {
        if (!controller.signal.aborted) {
          running.current = false;
          setBusy(false);
          setLoading(false);
        }
      }
    })();
    return () => {
      controller.abort();
      running.current = false;
    };
  }, [key, request, reload]);
  useEffect(() => {
    const refresh = () => {
      if (!running.current && document.visibilityState === "visible")
        setReload((n) => n + 1);
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  // Persist drafts to the same actor-scoped conversation without overlapping a turn.
  useEffect(() => {
    if (loading || busy || error || draft === (conversation?.composer || ""))
      return;
    const timer = setTimeout(() => void saveDraft(), 700);
    return () => clearTimeout(timer);
  }, [draft, loading, busy, error, conversation]);
  async function ensure(signal: AbortSignal) {
    if (current.current) return current.current;
    const result = await cloudWorkflowRequest(
      request,
      "chat",
      identity,
      "POST",
      { request_id: creation.current },
      signal,
    );
    signal.throwIfAborted();
    update(result.conversation);
    return result.conversation as Conversation;
  }
  async function saveDraft() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    const signal = alive.current!.signal;
    try {
      const value = await ensure(signal);
      await persist(value, value.messages, draft, signal);
    } catch (cause) {
      if (!signal.aborted) fail(cause);
    } finally {
      if (!signal.aborted) {
        running.current = false;
        setBusy(false);
      }
    }
  }
  async function send(reconnect = false, text = draft) {
    if (running.current || (!reconnect && (!text.trim() || retry))) return;
    running.current = true;
    setBusy(true);
    setError("");
    const signal = alive.current!.signal;
    try {
      let value = await ensure(signal);
      let turn = reconnect ? retry : undefined;
      if (!turn) {
        const turnId = crypto.randomUUID();
        const messages = [
          ...value.messages,
          {
            id: `user-${turnId}`,
            role: "user" as const,
            parts: [{ type: "text", text: text.trim() }],
          },
        ];
        value = await persist(value, messages, "", signal);
        setDraft((latest) => (latest === text ? "" : latest));
        turn = { turn_id: turnId, messages: cloudTurnHistory(messages) };
        setRetry(turn);
      }
      await cloudWorkflowRequest(
        request,
        "chat/turn",
        identity,
        "POST",
        { conversation_id: value.id, ...turn },
        signal,
      );
      await receive(value, turn, signal);
    } catch (cause) {
      if (!signal.aborted) fail(cause);
    } finally {
      if (!signal.aborted) {
        running.current = false;
        setBusy(false);
        setLoading(false);
      }
    }
  }
  async function stop() {
    if (!retry || !current.current) return;
    try {
      await cloudWorkflowRequest(
        request,
        "chat/turn",
        identity,
        "DELETE",
        { conversation_id: current.current.id, turn_id: retry.turn_id },
        alive.current!.signal,
      );
    } catch (cause) {
      if (!alive.current?.signal.aborted) fail(cause);
    }
  }
  async function apply() {
    if (!proposal || !canApply || running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      await cloudWorkflowRequest(
        request,
        "procedure",
        identity,
        "PUT",
        {
          document: proposal.document,
          expected_revision: proposal.expected_revision,
          source_version: proposal.source_version,
        },
        alive.current!.signal,
      );
      alive.current!.signal.throwIfAborted();
      setApplied("Changes saved to your workspace.");
      setProposal(null);
      callbacks.current.onApplied();
    } catch (cause) {
      if (!alive.current?.signal.aborted) fail(cause);
    } finally {
      if (!alive.current?.signal.aborted) {
        running.current = false;
        setBusy(false);
      }
    }
  }
  const messages = useMemo(() => [...(conversation?.messages || []), ...(live ? [live] : [])], [conversation?.messages, live]);
  const visibleMessages = useMemo(() => messages.map(message => ({ id: message.id, role: message.role, at: "", text: message.parts.filter(p => p.type === "text").map(p => p.text || "").join("\n") })), [messages]);
  const session: WorkflowAssistantSession = {
    title,
    messages: visibleMessages,
    draft, loaded: !loading, busy, error,
    setDraft, send: text => { void send(false, text); }, stop: () => { void stop(); },
    retry: retry ? () => { void send(true); } : error ? () => setReload(n => n + 1) : undefined,
    renderMessage: message => <>{messages.find(m => m.id === message.id)?.parts.filter(p => p.proposal).map((part, i) =>
      <button key={i} disabled={busy} onClick={() => { setProposal(part.proposal!); setApplied(""); }}>Review changes: {part.proposal!.summary}</button>)}</>,
    review: <>{proposal && (
        <section
          className={styles.proposal}
          aria-label="Proposed workflow changes"
        >
          <h3>{proposal.summary}</h3>
          <p className={styles.muted}>Proposed steps · not saved</p>
          <ol>
            {proposal.document.steps.map((step) => (
              <li key={step.id}>
                <strong>{step.action}</strong>
                <p>{step.detail}</p>
                {(
                  [
                    "app",
                    "expected_result",
                    "caveat",
                    "required_access",
                    "escalation",
                    "response_template",
                    "next_step_id",
                  ] as const
                ).map((field) =>
                  step[field] ? (
                    <p key={field}>
                      {field.replaceAll("_", " ")}: {step[field]}
                    </p>
                  ) : null,
                )}
                {step.decision && (
                  <div>
                    <p>Decision: {step.decision.condition}</p>
                    <p>
                      If yes: {step.decision.if_yes} {step.decision.yes_step_id}
                    </p>
                    <p>
                      If no: {step.decision.if_no} {step.decision.no_step_id}
                    </p>
                  </div>
                )}
              </li>
            ))}
          </ol>
          <button onClick={() => void apply()} disabled={busy || !canApply}>
            Apply changes
          </button>
          <button onClick={() => setProposal(null)}>Dismiss</button>
          {!canApply && <p>Save or discard your manual edits first.</p>}
        </section>
      )}{applied && <p role="status">{applied}</p>}</>,
  };
  useEffect(() => {
    mountAssistant?.({ context: { key, title, purpose: "sop" }, ask: noAsk, platform, session });
  }, [mountAssistant, key, title, platform, conversation, draft, loading, busy, error, live, retry, proposal, applied, canApply]);
  useEffect(() => () => mountAssistant?.(null), [mountAssistant]);
  if (mountAssistant) return null;
  return <div className={docked ? styles.webDock : styles.webFloating} style={docked ? { width: `min(${sidebarWidth}px, 100vw)` } : undefined}>
    <WorkflowAssistant platform={platform} context={{ key, title, purpose: "sop" }} session={session} onDockChange={setDocked} onWidthChange={setSidebarWidth} />
  </div>;
}
