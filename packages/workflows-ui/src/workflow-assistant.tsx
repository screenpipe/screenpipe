// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Check, Copy, History, MessageCircle, PanelRight, Plus, Search, Square, X, Maximize2 } from "lucide-react";
import { assistantContextSnapshot, emptyAssistantState, newAssistantConversation, isAssistantLink, type AssistantContext, type AssistantMessage, type AssistantState, type WorkflowsAssistantPlatform } from "./assistant";
import styles from "./workflow-assistant.module.css";

/** Small safe Markdown subset. React escapes content; arbitrary HTML and URL schemes never execute. */
function AnswerText({ text, openLink }: { text: string; openLink?: (url: string) => void }) {
  function inline(value: string): React.ReactNode {
    return value.split(/(\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g).map((part, j) => {
      // Agent replies often emphasize a source link. Preserve its interaction
      // inside the emphasis instead of exposing the Markdown as plain text.
      if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={j}>{inline(part.slice(2, -2))}</strong>;
      const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (link && isAssistantLink(link[2])) return <a key={j} href={link[2]} target="_blank" rel="noreferrer" onClick={openLink ? (event) => { event.preventDefault(); openLink(link[2]); } : undefined}>{link[1]}</a>;
      return part || "\u00a0";
    });
  }
  return <div className={styles.answer}>{text.split("\n").map((line, i) => <div key={i} className={/^#{1,3} /.test(line) ? styles.answerHeading : undefined}>{inline(line.replace(/^#{1,3} /, ""))}</div>)}</div>;
}

export function WorkflowAssistant({ platform, context, onDockChange }: {
  platform: WorkflowsAssistantPlatform;
  context: AssistantContext;
  onDockChange: (docked: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<AssistantState>(emptyAssistantState);
  const stateRef = useRef(state);
  const [loaded, setLoaded] = useState(false);
  const loadedRef = useRef(false);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState("Starting…");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [includeContext, setIncludeContext] = useState(true);
  const [atBottom, setAtBottom] = useState(true);
  const [copied, setCopied] = useState("");
  const panel = useRef<HTMLElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const loadInFlight = useRef(false);
  const conversation = state.conversations.find((c) => c.id === state.activeId)!;

  const persist = useCallback(async (snapshot: AssistantState) => {
    try { await platform.save(snapshot); if (mounted.current) setSaveError(false); }
    catch (cause) { if (mounted.current) setSaveError(true); throw cause; }
  }, [platform]);

  const update = useCallback((change: (current: AssistantState) => AssistantState, delay = 400) => {
    const next = change(stateRef.current);
    stateRef.current = next;
    setState(next);
    // Stream updates are throttled, not debounced: a steady stream still gets
    // a recoverable disk checkpoint each second.
    if (saveTimer.current && delay !== 1000) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    if (loadedRef.current && !saveTimer.current) saveTimer.current = setTimeout(() => { saveTimer.current = null; void persist(stateRef.current).catch(() => {}); }, delay);
    return next;
  }, [persist]);

  const restore = useCallback(async () => {
    if (loadInFlight.current) return;
    loadInFlight.current = true;
    setLoadError("");
    try {
      const saved = await platform.load();
      if (!mounted.current) return;
      if (saved) { stateRef.current = saved; setState(saved); }
      loadedRef.current = true;
      setLoaded(true);
    } catch { if (mounted.current) setLoadError("Couldn’t open your saved conversations."); }
    finally { loadInFlight.current = false; }
  }, [platform]);

  useEffect(() => { if (open && !loadedRef.current && !loadError) void restore(); }, [open, restore, loadError]);
  useEffect(() => { onDockChange(open && state.mode === "sidebar"); }, [open, state.mode, onDockChange]);
  useEffect(() => { if (open && loaded && !historyOpen) input.current?.focus(); }, [open, loaded, historyOpen]);
  useEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [state, open, activity]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (loadedRef.current) void platform.save(stateRef.current).catch(() => {});
    };
  }, [platform]);

  const close = useCallback(() => {
    setOpen(false);
    if (loadedRef.current) void persist(stateRef.current).catch(() => {});
    requestAnimationFrame(() => launcher.current?.focus());
  }, [persist]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j") {
        event.preventDefault();
        if (open) close(); else setOpen(true);
      } else if (event.key === "Escape" && open && panel.current?.contains(event.target as Node)) {
        event.preventDefault();
        event.stopPropagation();
        if (historyOpen) setHistoryOpen(false); else close();
      }
    };
    window.addEventListener("keydown", onKey);
    const openChat = () => setOpen(true);
    window.addEventListener("workflows:open-assistant", openChat);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("workflows:open-assistant", openChat); };
  }, [open, close, historyOpen]);

  const patchMessage = (conversationId: string, messageId: string, patch: Partial<AssistantMessage>) => update((current) => ({
    ...current, conversations: current.conversations.map((c) => c.id !== conversationId ? c : { ...c, messages: c.messages.map((m) => m.id === messageId ? { ...m, ...patch } : m) }),
  }), 1000);

  async function send(question: string, retry = false) {
    if (!question.trim() || controller.current || !loadedRef.current) return;
    const current = stateRef.current.conversations.find((c) => c.id === stateRef.current.activeId)!;
    const previousUserIndex = current.messages.findLastIndex((m) => m.role === "user");
    const history = retry ? current.messages.slice(0, previousUserIndex) : current.messages;
    const turnContext = retry ? current.messages[previousUserIndex]?.context ?? null : includeContext ? assistantContextSnapshot(context) : null;
    const answerId = crypto.randomUUID();
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true); setError(""); setHistoryOpen(false); setActivity("Starting…");
    follow.current = true; setAtBottom(true);
    const snapshot = update((s) => ({ ...s, conversations: s.conversations.map((c) => c.id !== current.id ? c : {
      ...c, draft: "", title: history.length ? c.title : question.trim().slice(0, 64),
      messages: [...history,
        { id: crypto.randomUUID(), role: "user", text: question.trim(), at: new Date().toISOString(), ...(turnContext ? { context: turnContext } : {}) },
        { id: answerId, role: "assistant", text: "", at: new Date().toISOString() }],
    }) }));
    try {
      // A user turn reaches durable storage before the agent starts.
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = null;
      await persist(snapshot);
      if (abort.signal.aborted) throw new DOMException("Stopped", "AbortError");
      const text = await platform.ask({ question: question.trim(), context: turnContext, history, signal: abort.signal, onProgress: (progress) => {
        if (abort.signal.aborted || !mounted.current) return;
        setActivity(progress.activity === "searching" ? "Searching your memory…" : progress.activity === "writing" ? "Writing…" : "Starting…");
        patchMessage(current.id, answerId, { text: progress.text });
      } });
      if (!mounted.current) return;
      patchMessage(current.id, answerId, { text, status: abort.signal.aborted ? "stopped" : undefined });
    } catch (cause) {
      if (!mounted.current) return;
      const stopped = abort.signal.aborted;
      patchMessage(current.id, answerId, { status: stopped ? "stopped" : "error" });
      if (!stopped) setError(cause instanceof Error ? cause.message : "Couldn’t finish the answer. Try again.");
    } finally {
      if (controller.current === abort) controller.current = null;
      if (mounted.current) {
        setBusy(false);
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = null;
        void persist(stateRef.current).catch(() => {});
      }
    }
  }

  const lastUser = [...conversation.messages].reverse().find((m) => m.role === "user");
  const lastAnswer = conversation.messages.at(-1);
  const suggestions = context.workflow
    ? ["What’s slowing this workflow down?", "Find recent examples in my memory"]
    : ["What did I work on yesterday?", "Find a conversation I had this week"];

  return <>
    {!open && <button ref={launcher} className={styles.launcher} onClick={() => setOpen(true)} title="Ask Screenpipe (⌘ J)" aria-label="Ask Screenpipe" aria-expanded={false}><MessageCircle size={18} /><span>Ask Screenpipe</span>{busy && <i aria-label="Answer in progress" />}</button>}
    <aside ref={panel} hidden={!open} className={`${styles.panel} ${state.mode === "sidebar" ? styles.docked : styles.floating}`} role="region" aria-label="Screenpipe assistant">
      <header className={styles.header}>
        <span><MessageCircle size={16} /><strong>Screenpipe</strong></span>
        <div>
          <button aria-label="Conversation history" title="Conversation history" aria-pressed={historyOpen} onClick={() => setHistoryOpen(!historyOpen)}><History size={16} /></button>
          <button aria-label="New conversation" title="New conversation" disabled={busy || !loaded} onClick={() => { const fresh = newAssistantConversation(); update((s) => ({ ...s, activeId: fresh.id, conversations: [...s.conversations, fresh] })); setHistoryOpen(false); setError(""); }}><Plus size={17} /></button>
          <button aria-label={state.mode === "floating" ? "Dock in sidebar" : "Switch to floating bubble"} title={state.mode === "floating" ? "Dock in sidebar" : "Switch to floating bubble"} disabled={!loaded} onClick={() => update((s) => ({ ...s, mode: s.mode === "floating" ? "sidebar" : "floating" }))}>{state.mode === "floating" ? <PanelRight size={16} /> : <Maximize2 size={15} />}</button>
          <button aria-label="Close assistant" title="Close (Esc)" onClick={close}><X size={17} /></button>
        </div>
      </header>
      <div className={styles.body} ref={scroll} onScroll={() => { const el = scroll.current!; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 70; setAtBottom(follow.current); }}>
        {!loaded && <div className={styles.restoring}>{loadError || "Opening your conversations…"}{loadError && <button onClick={() => void restore()}>Try again</button>}</div>}
        {loaded && historyOpen ? <div className={styles.history}><h3>Conversations</h3>{[...state.conversations].reverse().filter((c) => c.messages.length).map((c) => <button key={c.id} disabled={busy} onClick={() => { update((s) => ({ ...s, activeId: c.id })); setHistoryOpen(false); setError(""); follow.current = true; }}><MessageCircle size={14} /><span>{c.title}</span>{c.id === state.activeId && <Check size={14} />}</button>)}{!state.conversations.some((c) => c.messages.length) && <p>Your conversations will appear here.</p>}</div> : loaded && <>
          {!conversation.messages.length && <div className={styles.empty}><MessageCircle size={25} strokeWidth={1.5} /><h2>A little help, right here.</h2><p>Find something in your memory, or ask about what you’re looking at.</p><div>{suggestions.map((question) => <button key={question} onClick={() => void send(question)}><Search size={14} /><span>{question}</span><ArrowUp size={13} /></button>)}</div></div>}
          {conversation.messages.map((message) => <article key={message.id} className={message.role === "user" ? styles.user : styles.assistant} aria-label={message.role === "user" ? "Your question" : "Screenpipe answer"}>
            {message.context && <small>{message.context.title}</small>}
            {message.role === "user" ? <p>{message.text}</p> : <AnswerText text={message.text} openLink={platform.openLink ? (url) => void platform.openLink!(url).catch(() => setError("Couldn’t open that source.")) : undefined} />}
            {message.status === "stopped" && <small>Stopped</small>}
            {message.role === "assistant" && message.text && !busy && <button className={styles.copy} aria-label="Copy answer" onClick={() => void navigator.clipboard.writeText(message.text).then(() => { setCopied(message.id); setTimeout(() => setCopied(""), 1500); }).catch(() => setError("Couldn’t copy. You can select the answer and copy it."))}>{copied === message.id ? <Check size={13} /> : <Copy size={13} />}</button>}
          </article>)}
          {busy && <div className={styles.activity} role="status"><i />{activity}</div>}
          {!busy && (error || lastAnswer?.status === "error" || lastAnswer?.status === "stopped") && <div className={styles.error} role="status"><span>{error || (lastAnswer?.status === "error" ? "This answer didn’t finish." : "")}</span>{lastUser && <button onClick={() => void send(lastUser.text, true)}>Try again</button>}</div>}
        </>}
      </div>
      {!atBottom && !historyOpen && <button className={styles.jump} onClick={() => { follow.current = true; scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: "auto" }); }}><ArrowDown size={13} />Latest</button>}
      {saveError && <div className={styles.saveError} role="alert">Couldn’t save this conversation.<button onClick={() => void persist(stateRef.current).catch(() => {})}>Retry save</button></div>}
      <form className={styles.composer} onSubmit={(event) => { event.preventDefault(); void send(conversation.draft); }}>
        <button type="button" className={styles.context} aria-pressed={includeContext} title={includeContext ? "Remove current page from the next message" : "Include current page in the next message"} onClick={() => setIncludeContext(!includeContext)}>{includeContext ? <><span className={styles.contextDot} /><span>{context.title}</span><X size={11} /></> : <><Plus size={12} /><span>Add current page</span></>}</button>
        <textarea ref={input} aria-label="Ask Screenpipe" placeholder="Ask or find anything…" rows={2} value={conversation.draft} maxLength={8000} disabled={!loaded} onChange={(event) => update((s) => ({ ...s, conversations: s.conversations.map((c) => c.id === s.activeId ? { ...c, draft: event.target.value } : c) }))} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(conversation.draft); } }} />
        <div className={styles.composerFooter}><span><Search size={12} />Your memory</span>{busy ? <button type="button" className={styles.send} aria-label="Stop answer" onClick={() => controller.current?.abort()}><Square size={12} fill="currentColor" /></button> : <button className={styles.send} type="submit" aria-label="Send message" disabled={!loaded || !conversation.draft.trim()}><ArrowUp size={17} /></button>}</div>
      </form>
    </aside>
  </>;
}
