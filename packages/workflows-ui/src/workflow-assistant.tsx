// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowUp, Check, ChevronDown, Copy, MessageCircle, Minus, PanelRight, PanelRightClose, Plus, Search, Square, SquarePen, RotateCcw, X, Maximize2 } from "lucide-react";
import { assistantContextSnapshot, emptyAssistantState, newAssistantConversation, isAssistantLink, type AssistantContext, type AssistantMessage, type AssistantState, type WorkflowsAssistantPlatform, type WorkflowComposerAccessory } from "./assistant";
import { ChatMarkdown, ComposerTextArea, ChatJumpToLatest } from "./chat-primitives";
import { matchesSidebarShortcut, useSidebarShortcuts } from "./sidebar-shortcuts";
import styles from "./workflow-assistant.module.css";
import { useGT } from "gt-react";


const FEEDBACK_PROMPT = "Review this workflow and ask me 3 specific questions to help refine it. Also invite any general feedback I have.";

/** Remote transports supply conversation state while retaining the existing chat UI. */
export type WorkflowAssistantSession = {
  title: string;
  messages: AssistantMessage[];
  draft: string;
  loaded: boolean;
  busy: boolean;
  error: string;
  setDraft: (text: string) => void;
  send: (text: string) => void;
  stop: () => void;
  retry?: () => void;
  renderMessage?: (message: AssistantMessage) => React.ReactNode;
  review?: React.ReactNode;
};

export function WorkflowAssistant({ session, platform, context, onDockChange, onWidthChange, onOpenChange, onModeChange, headerToggle = false, active = true, composerAccessory, promptRequest, onBusyChange }: {
  platform: WorkflowsAssistantPlatform;
  session?: WorkflowAssistantSession;
  promptRequest?: { id: string; text: string };
  onBusyChange?: (busy: boolean) => void;
  context: AssistantContext;
  onDockChange: (docked: boolean) => void;
  onWidthChange?: (width: number) => void;
  onOpenChange?: (open: boolean) => void;
  onModeChange?: (mode: AssistantState["mode"]) => void;
  headerToggle?: boolean;
  active?: boolean;
  composerAccessory?: WorkflowComposerAccessory;
}) {
  const ui = useGT();
  const shortcuts = useSidebarShortcuts();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<AssistantState>(emptyAssistantState);
  const useHeaderToggle = headerToggle && state.mode === "sidebar";
  const launcherLabel = headerToggle ? "Open chat" : "Ask Screenpipe";
  const stateRef = useRef(state);
  const [localLoaded, setLoaded] = useState(false);
  const loadedRef = useRef(false);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState(false);
  const [localError, setError] = useState("");
  const [localBusy, setBusy] = useState(false);
  const [activity, setActivity] = useState("Starting…");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const [displayOpen, setDisplayOpen] = useState(false);
  const [pendingFeedback, setPendingFeedback] = useState<{ context: AssistantContext; question?: string } | null>(null);
  const consumedFeedback = useRef<typeof pendingFeedback>(null);
  const savingFeedback = useRef(false);
  const [feedbackSaving, setFeedbackSaving] = useState(false);
  const [feedbackError, setFeedbackError] = useState("");
  const [includeContext, setIncludeContext] = useState(true);
  const [atBottom, setAtBottom] = useState(true);
  const [copied, setCopied] = useState("");
  const panel = useRef<HTMLElement>(null);
  const displayMenu = useRef<HTMLDivElement>(null);
  const displayTrigger = useRef<HTMLButtonElement>(null);
  const resizing = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const historyInput = useRef<HTMLInputElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const loadInFlight = useRef(false);
  const loaded = session ? session.loaded && localLoaded : localLoaded;
  const busy = session?.busy ?? localBusy;
  const error = session?.error || localError;
  const storedConversation = state.conversations.find((c) => c.id === state.activeId)!;
  const conversation = session ? { ...storedConversation, title: session.title, messages: session.messages, draft: session.draft } : storedConversation;
  const feedbackContext = conversation.feedbackContext;
  const selectedSop = useRef<string | null>(null);
  const consumedPrompt = useRef<string | null>(null);
  const width = Number.isFinite(state.sidebarWidth) ? Math.max(340, Math.min(560, state.sidebarWidth!)) : 420;

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

  useEffect(() => { if (active && !loadedRef.current && !loadError) void restore(); }, [active, restore, loadError]);
  useEffect(() => {
    if (session) return;
    if (context.purpose !== "sop" && context.purpose !== "video") { selectedSop.current = null; return; }
    if (!loaded || busy || selectedSop.current === context.key) return;
    selectedSop.current = context.key;
    // Keep existing feedback and ordinary drafts separate from SOP edits.
    const existing = [...stateRef.current.conversations].reverse().find(c =>
      !c.feedbackContext && (c.pageKey === context.key || c.messages.some(m => m.context?.key === context.key)));
    const next = existing ?? { ...newAssistantConversation(), pageKey: context.key };
    update(s => ({ ...s, activeId: next.id, conversations: existing ? s.conversations : [...s.conversations, next] }));
    setError(""); setHistoryOpen(false);
  }, [context.key, context.purpose, loaded, busy, update]);
  useEffect(() => () => onDockChange(false), [onDockChange]);
  useEffect(() => { onDockChange(open && state.mode === "sidebar"); }, [open, state.mode, onDockChange]);
  useEffect(() => { onWidthChange?.(width); }, [width, onWidthChange]);
  useEffect(() => { onOpenChange?.(open); }, [open, onOpenChange]);
  useEffect(() => { if (loaded || loadError) onModeChange?.(state.mode); }, [state.mode, loaded, loadError, onModeChange]);
  useEffect(() => { if (open && loaded) (historyOpen ? historyInput.current : input.current)?.focus(); }, [open, loaded, historyOpen]);
  useEffect(() => {
    if (displayOpen) displayMenu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
  }, [displayOpen]);
  useEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [conversation.messages, open, activity]);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => { if (!displayMenu.current?.contains(event.target as Node)) setDisplayOpen(false); };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (loadedRef.current) void platform.save(stateRef.current).catch(() => {});
    };
  }, [platform]);

  useEffect(() => {
    if (active && open) window.dispatchEvent(new CustomEvent("workflows:assistant-opened"));
  }, [active, open]);

  const close = useCallback(() => {
    setOpen(false);
    setDisplayOpen(false);
    if (loadedRef.current) void persist(stateRef.current).catch(() => {});
    const focused = document.activeElement;
    requestAnimationFrame(() => {
      if (document.activeElement === focused || document.activeElement === document.body)
        (useHeaderToggle ? document.querySelector<HTMLButtonElement>("[data-workflows-assistant-toggle]") : launcher.current)?.focus();
    });
  }, [persist, useHeaderToggle]);
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat) return;
      if (matchesSidebarShortcut(event, "right")) {
        event.preventDefault();
        if (open) close(); else setOpen(true);
      } else if (event.key === "Escape" && open && panel.current?.contains(event.target as Node)) {
        event.preventDefault();
        event.stopPropagation();
        if (displayOpen) { setDisplayOpen(false); displayTrigger.current?.focus(); }
        else if (historyOpen) setHistoryOpen(false); else close();
      }
    };
    window.addEventListener("keydown", onKey);
    const openChat = () => setOpen(true);
    const toggleChat = () => { if (open) close(); else setOpen(true); };
    window.addEventListener("workflows:minimize-assistant", close);
    window.addEventListener("workflows:open-assistant", openChat);
    window.addEventListener("workflows:toggle-assistant", toggleChat);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("workflows:minimize-assistant", close);
      window.removeEventListener("workflows:open-assistant", openChat);
      window.removeEventListener("workflows:toggle-assistant", toggleChat);
    };
  }, [active, open, close, historyOpen, displayOpen]);

  useEffect(() => {
    if (!active || !platform.saveFeedback) return;
    const openFeedback = (event: Event) => {
      const selected = (event as CustomEvent<AssistantContext & { question?: string }>).detail;
      if (!selected?.workflow || selected.purpose !== "feedback") return;
      const snapshot = assistantContextSnapshot(selected);
      // Preserve previous corrections locally while keeping media out of chat history.
      snapshot.workflow!.userCorrection = selected.workflow.userCorrection;
      setPendingFeedback({ context: snapshot, question: typeof selected.question === "string" ? selected.question.trim() : undefined });
      setHistoryOpen(false);
      setOpen(true);
    };
    window.addEventListener("workflows:feedback", openFeedback);
    return () => window.removeEventListener("workflows:feedback", openFeedback);
  }, [active, platform.saveFeedback]);

  useEffect(() => {
    if (!pendingFeedback || !loaded || busy || controller.current || consumedFeedback.current === pendingFeedback) return;
    consumedFeedback.current = pendingFeedback;
    const existing = pendingFeedback.question ? [...stateRef.current.conversations].reverse().find(c =>
      c.clarificationQuestion === pendingFeedback.question && c.feedbackContext?.key === pendingFeedback.context.key) : undefined;
    const fresh = existing ?? { ...newAssistantConversation(), feedbackContext: pendingFeedback.context, clarificationQuestion: pendingFeedback.question };
    if (pendingFeedback.question && !existing) {
      fresh.title = pendingFeedback.question.slice(0, 64);
      fresh.messages = [{ id: crypto.randomUUID(), role: "assistant", text: pendingFeedback.question, at: new Date().toISOString() }];
    }
    update(current => ({ ...current, activeId: fresh.id, conversations: existing ? current.conversations : [...current.conversations, fresh] }));
    setPendingFeedback(null);
    setIncludeContext(true);
    setError("");
    setFeedbackError("");
    if (!pendingFeedback.question) void send(FEEDBACK_PROMPT);
    requestAnimationFrame(() => input.current?.focus());
  }, [pendingFeedback, loaded, busy, update]);

  useEffect(() => {
    if (!promptRequest || !loaded || busy || controller.current || consumedPrompt.current === promptRequest.id) return;
    consumedPrompt.current = promptRequest.id;
    setOpen(true);
    setIncludeContext(true);
    void send(promptRequest.text, false, context);
  }, [promptRequest, loaded, busy, context]);

  const patchMessage = (conversationId: string, messageId: string, patch: Partial<AssistantMessage>) => update((current) => ({
    ...current, conversations: current.conversations.map((c) => c.id !== conversationId ? c : { ...c, messages: c.messages.map((m) => m.id === messageId ? { ...m, ...patch } : m) }),
  }), 1000);

  async function send(question: string, retry = false, requestedContext?: AssistantContext) {
    if (session) {
      if (busy || !loaded) return;
      setError("");
      if (retry) session.retry?.(); else session.send(question);
      return;
    }
    if (!question.trim() || controller.current || !loadedRef.current) return;
    const current = stateRef.current.conversations.find((c) => c.id === stateRef.current.activeId)!;
    const previousUserIndex = current.messages.findLastIndex((m) => m.role === "user");
    const history = retry ? current.messages.slice(0, previousUserIndex) : current.messages;
    const turnContext = requestedContext ? assistantContextSnapshot(requestedContext) : retry ? current.messages[previousUserIndex]?.context ?? null : current.feedbackContext ? assistantContextSnapshot(current.feedbackContext) : includeContext ? assistantContextSnapshot(context) : null;
    const userId = crypto.randomUUID();
    const alreadySavedFeedback = retry && current.messages[previousUserIndex]?.feedbackSaved;
    const answerId = crypto.randomUUID();
    const abort = new AbortController();
    controller.current = abort;
    onBusyChange?.(true);
    setBusy(true); setError(""); setHistoryOpen(false); setActivity("Starting…");
    follow.current = true; setAtBottom(true);
    const snapshot = update((s) => ({ ...s, conversations: s.conversations.map((c) => c.id !== current.id ? c : {
      ...c, draft: retry ? c.draft : "", title: c.clarificationQuestion ? c.title : c.feedbackContext ? ui("Feedback: {value1}", { value1: c.feedbackContext.title }) : history.length ? c.title : question.trim().slice(0, 64),
      messages: [...history,
        { id: userId, role: "user", feedbackSaved: alreadySavedFeedback || undefined, text: question.trim(), at: new Date().toISOString(), ...(turnContext ? { context: turnContext } : {}) },
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
        if (progress.workflow && current.feedbackContext) update(s => ({ ...s, conversations: s.conversations.map(c => c.id === current.id ? { ...c, feedbackContext: assistantContextSnapshot({ ...c.feedbackContext!, workflow: progress.workflow, title: progress.workflow!.title }) } : c) }));
        setActivity(progress.activity === "working" ? "Working…" : progress.activity === "searching" ? "Searching your memory…" : progress.activity === "writing" ? "Writing…" : "Starting…");
        patchMessage(current.id, answerId, { text: progress.text, ...(progress.toolCalls ? {toolCalls: progress.toolCalls} : {}) });
      } });
      if (!mounted.current) return;
      patchMessage(current.id, answerId, { text, status: abort.signal.aborted ? "stopped" : undefined });
    } catch (cause) {
      if (!mounted.current) return;
      const stopped = abort.signal.aborted;
      const answer = stateRef.current.conversations.find(c => c.id === current.id)?.messages.find(m => m.id === answerId);
      patchMessage(current.id, answerId, { status: stopped ? "stopped" : "error", toolCalls: answer?.toolCalls?.map(tool => tool.status === "running" ? {...tool, status: stopped ? "stopped" : "error"} : tool) });
      if (!stopped) setError(cause instanceof Error ? cause.message : ui("Couldn’t finish the answer. Try again."));
    } finally {
      if (controller.current === abort) controller.current = null;
      onBusyChange?.(false);
      if (mounted.current) {
        setBusy(false);
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = null;
        void persist(stateRef.current).catch(() => {});
      }
    }
  }

  async function saveFeedback() {
    const current = stateRef.current.conversations.find(c => c.id === stateRef.current.activeId)!;
    const user = [...current.messages].reverse().find(m => m.role === "user");
    if (!current.feedbackContext?.workflow || !platform.saveFeedback || !user || user.feedbackSaved || savingFeedback.current) return;
    savingFeedback.current = true;
    setFeedbackSaving(true); setFeedbackError("");
    try {
      const previousNotes = current.feedbackContext.workflow.userCorrection?.trim() || "";
      const discussion = current.messages.filter(m => m.text && !m.status && m.text !== FEEDBACK_PROMPT)
        .map(m => `${m.role === "user" ? "User" : "Assistant (proposal)"}: ${m.text}`).join("\n\n");
      await platform.saveFeedback(current.feedbackContext.workflow, [previousNotes, discussion].filter(Boolean).join("\n\n"));
      patchMessage(current.id, user.id, { feedbackSaved: true });
      await persist(stateRef.current);
    } catch (cause) {
      setFeedbackError(cause instanceof Error ? cause.message : "Couldn’t save feedback. Try again.");
    } finally { savingFeedback.current = false; setFeedbackSaving(false); }
  }

  const lastUser = [...conversation.messages].reverse().find((message) => message.role === "user");
  const lastAnswer = conversation.messages.at(-1);
  const suggestions = session ? ["Make the steps easier to follow", "Clarify this workflow"] : context.purpose === "video"
    ? ["Make the narration shorter", "Create video"]
    : context.purpose === "sop"
    ? ["Make this SOP shorter", "Make the steps easier to follow"]
    : context.workflow
    ? ["Summarize this workflow", "Find recent examples in my memory"]
    : ["What did I work on yesterday?", "Find a conversation I had this week"];
  const history = [...(session ? [conversation] : state.conversations)].reverse().filter((item) =>
    (session ? session.messages.length : item.messages.length) && (!historyQuery.trim() || [item.title, ...item.messages.map((message) => message.text)].join(" ").toLowerCase().includes(historyQuery.trim().toLowerCase())));
  const openSource = useCallback((url: string) => {
    if (platform.openLink) void platform.openLink(url).catch(() => setError(ui("Couldn’t open that source.")));
  }, [platform]);

  function setWidth(value: number) {
    const maximum = Math.min(560, window.innerWidth - (window.innerWidth >= 960 ? 520 : 24));
    update((current) => ({ ...current, sidebarWidth: Math.max(340, Math.min(maximum, value)) }));
  }
  function chooseMode(mode: AssistantState["mode"]) {
    update((current) => ({ ...current, mode }));
    setDisplayOpen(false);
    requestAnimationFrame(() => input.current?.focus());
  }
  function newConversation() {
    const fresh = { ...newAssistantConversation(), ...(["sop", "video"].includes(context.purpose ?? "") ? { pageKey: context.key } : {}) };
    update((current) => ({ ...current, activeId: fresh.id, conversations: [...current.conversations, fresh] }));
    setHistoryOpen(false); setHistoryQuery(""); setError("");
    requestAnimationFrame(() => input.current?.focus());
  }

  return <>
    {!open && (loaded || loadError) && !useHeaderToggle && <button ref={launcher} className={styles.launcher} onClick={() => setOpen(true)} aria-keyshortcuts={shortcuts.right.aria} aria-label={launcherLabel} aria-expanded={false}>
      <svg className={styles.launcherMark} viewBox="0 0 32 32" width="28" height="28" fill="none" aria-hidden="true">
        <path className={styles.launcherFrame} d="M8 5.5h16a3 3 0 0 1 3 3v13a3 3 0 0 1-3 3h-9l-6 3v-3H8a3 3 0 0 1-3-3v-13a3 3 0 0 1 3-3Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        <g className={styles.launcherEyes} fill="currentColor"><rect x="11" y="12" width="2.5" height="5" rx="1.25" /><rect x="19" y="12" width="2.5" height="5" rx="1.25" /></g>
      </svg><span aria-hidden="true">{launcherLabel}<kbd>{shortcuts.right.keys.join(" ")}</kbd></span>{busy && <i aria-label={ui("Answer in progress")} />}
    </button>}
    <aside id="workflows-assistant" ref={panel} hidden={!open} className={[styles.panel, state.mode === "sidebar" ? styles.docked : styles.floating].join(" ")}
      style={{ "--assistant-width": width + "px" } as React.CSSProperties}
      data-empty={!conversation.messages.length && !historyOpen} data-mode={state.mode} role="region" aria-label={ui("Screenpipe assistant")}>
      <div className={styles.resizeHandle} role="separator" tabIndex={0} aria-label={ui("Resize chat")} aria-orientation="vertical"
        aria-valuemin={340} aria-valuemax={560} aria-valuenow={width}
        onPointerDown={(event) => { resizing.current = true; event.currentTarget.setPointerCapture?.(event.pointerId); event.preventDefault(); }}
        onPointerMove={(event) => { if (resizing.current && panel.current) setWidth(panel.current.getBoundingClientRect().right - event.clientX); }}
        onPointerUp={(event) => { resizing.current = false; event.currentTarget.releasePointerCapture?.(event.pointerId); }}
        onLostPointerCapture={() => { resizing.current = false; }}
        onKeyDown={(event) => { if (["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) { event.preventDefault(); setWidth(event.key === "Home" ? 420 : width + (event.key === "ArrowLeft" ? 24 : -24)); } }} />
      <header className={styles.header}>
        <button className={styles.title} aria-label={ui("Conversation history")} aria-expanded={historyOpen} disabled={!loaded}
          title={conversation.messages.length ? conversation.title : ui("New chat")} onClick={() => { setHistoryOpen(!historyOpen); setDisplayOpen(false); }}>
          <span>{conversation.clarificationQuestion ? conversation.title : feedbackContext ? ui("Feedback") : conversation.messages.length ? conversation.title : ui("New chat")}</span><ChevronDown size={13} />
        </button>
        <div className={styles.headerActions}>
          {!session && <button aria-label={ui("New conversation")} title={ui("New chat")} disabled={busy || !loaded} onClick={newConversation}><SquarePen size={16} /></button>}
          <div ref={displayMenu} className={styles.displayControl}>
            <button ref={displayTrigger} aria-label={ui("Chat display")} title={ui("Chat display")} aria-haspopup="menu" aria-expanded={displayOpen}
              disabled={!loaded} onClick={() => setDisplayOpen(!displayOpen)} onKeyDown={(event) => {
                if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); setDisplayOpen(true); }
              }}><Maximize2 size={16} /></button>
            {displayOpen && <div className={styles.displayMenu} role="menu" aria-label={ui("Chat display")} onKeyDown={(event) => {
              if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const choices = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
              const active = choices.indexOf(document.activeElement as HTMLButtonElement);
              choices[event.key === "Home" ? 0 : event.key === "End" ? choices.length - 1 : (active + (event.key === "ArrowUp" ? -1 : 1) + choices.length) % choices.length]?.focus();
            }}>
              <span>Display as</span>
              <button role="menuitemradio" aria-checked={state.mode === "floating"} onClick={() => chooseMode("floating")}><Maximize2 size={15} /><span>Floating</span>{state.mode === "floating" && <Check size={14} />}</button>
              <button role="menuitemradio" aria-checked={state.mode === "sidebar"} onClick={() => chooseMode("sidebar")}><PanelRight size={15} /><span>Sidebar</span>{state.mode === "sidebar" && <Check size={14} />}</button>
            </div>}
          </div>
          <button aria-label={state.mode === "floating" ? ui("Minimize chat") : ui("Collapse right sidebar")} title={`${state.mode === "floating" ? "Minimize chat" : "Collapse right sidebar"} (${shortcuts.right.keys.join(" ")})`} aria-expanded={true}
            aria-controls="workflows-assistant" aria-keyshortcuts={shortcuts.right.aria} onClick={close}>{state.mode === "floating" ? <Minus size={18} /> : <PanelRightClose size={14} strokeWidth={1.5} />}</button>
        </div>
      </header>
      <div className={styles.body} ref={scroll} data-workflows-chat-scroll role={historyOpen ? undefined : "log"} aria-label={historyOpen ? undefined : ui("Conversation")} aria-live="off"
        onScroll={() => { const element = scroll.current!; follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 70; setAtBottom(follow.current); }}>
        {!loaded && <div className={styles.restoring}>{loadError || ui("Opening your conversations…")}{loadError && <button onClick={() => void restore()}>Try again</button>}</div>}
        {loaded && historyOpen ? <div className={styles.history}>
          <div className={styles.historyHeader}><button aria-label={ui("Back to chat")} onClick={() => setHistoryOpen(false)}><ArrowLeft size={16} /></button><h3>Conversations</h3></div>
          <label className={styles.historySearch}><Search size={15} /><input ref={historyInput} value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} placeholder={ui("Search conversations…")} aria-label={ui("Search conversations")} /></label>
          {history.map((item) => <button key={item.id} aria-label={item.title} className={styles.historyItem} disabled={busy} onClick={() => {
            update((current) => ({ ...current, activeId: item.id })); setHistoryOpen(false); setError(""); follow.current = true;
          }}><MessageCircle size={15} /><span><strong>{item.title}</strong><small>{item.messages.find((message) => message.role === "assistant")?.text.replace(/[#*_]/g, "").slice(0, 85)}</small></span>{item.id === state.activeId && <Check size={14} />}</button>)}
          {!history.length && <p>{historyQuery ? ui("No matching conversations.") : ui("Your conversations will appear here.")}</p>}
        </div> : loaded && <>
          {!conversation.messages.length && <div className={styles.empty}>
            <h2>{feedbackContext ? ui("What should change?") : session ? ui("Edit this workflow") : context.purpose === "video" ? ui("Edit the video script") : context.purpose === "sop" ? ui("Edit this SOP") : context.workflow ? ui("Ask about this workflow") : ui("Search your memory")}</h2>
            {!feedbackContext && <div>{suggestions.map((question) => <button key={question} onClick={() => void send(question)}><Search size={15} /><span>{question}</span><ArrowUp size={13} /></button>)}</div>}
          </div>}
          {conversation.messages.map((message) => <article key={message.id} className={message.role === "user" ? styles.user : styles.assistant} aria-label={message.role === "user" ? ui("Your question") : ui("Screenpipe answer")}>
            {message.role === "user" ? <p>{message.text}</p> : <ChatMarkdown text={message.text} streaming={busy && message.id === lastAnswer?.id} allowLink={isAssistantLink} onOpenLink={platform.openLink ? openSource : undefined} />}
            {message.toolCalls?.map(tool => <details key={tool.id} className={styles.toolCall}>
              <summary><span aria-hidden="true">{tool.status === "running" ? "◌" : tool.status === "complete" ? "✓" : tool.status === "stopped" ? "□" : "!"}</span><span>{tool.name.replace(/_/g, " ")}</span><small>{tool.status === "running" && tool.detail && !tool.detail.startsWith("{") ? tool.detail.slice(0, 80) : tool.status}</small></summary>
              {tool.detail && <pre>{tool.detail}</pre>}
            </details>)}
            {session?.renderMessage?.(message)}
            {message.feedbackSaved && message.id === lastUser?.id && <small>Feedback saved for the next update</small>}
            {message.status === "stopped" && <small>Stopped</small>}
            {message.role === "assistant" && message.text && (!busy || message.id !== lastAnswer?.id) && <div className={styles.messageActions}>
              <button aria-label={ui("Copy answer")} title={ui("Copy answer")} onClick={() => void navigator.clipboard.writeText(message.text).then(() => { setCopied(message.id); setTimeout(() => setCopied(""), 1500); }).catch(() => setError(ui("Couldn’t copy. You can select the answer and copy it.")))}>{copied === message.id ? <Check size={14} /> : <Copy size={14} />}</button>
              {!session && !busy && message.id === lastAnswer?.id && !message.status && lastUser && <button aria-label={ui("Retry answer")} title={ui("Retry answer")} onClick={() => void send(lastUser.text, true)}><RotateCcw size={14} /></button>}
            </div>}
          </article>)}
          {session?.review}
          {busy && <div className={styles.activity} role="status"><i aria-hidden="true" />{activity}</div>}
          {!busy && (error || lastAnswer?.status === "error" || lastAnswer?.status === "stopped") && <div className={styles.error} role="status"><span>{error || (lastAnswer?.status === "error" ? ui("This answer didn’t finish.") : "")}</span>{(session ? session.retry : lastUser) && <button onClick={() => session ? session.retry?.() : void send(lastUser!.text, true)}>Try again</button>}</div>}
        </>}
      </div>
      {!historyOpen && <ChatJumpToLatest hasMessages={!!conversation.messages.length} scrolledUp={!atBottom} onJump={() => {
        follow.current = true; setAtBottom(true); scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: "auto" });
      }} />}
      {!platform.learnsFromFeedback && !historyOpen && feedbackContext && !busy && conversation.messages.some(m => m.role === "user" && m.text !== FEEDBACK_PROMPT) && lastUser && !lastUser.feedbackSaved && <div className={styles.feedbackActions}>
        <button disabled={feedbackSaving} onClick={() => void saveFeedback()}>{feedbackSaving ? ui("Saving…") : ui("Save feedback")}</button>
      </div>}
      {feedbackError && <div className={styles.saveError} role="alert">{feedbackError}</div>}
      {saveError && <div className={styles.saveError} role="alert">Couldn’t save this conversation.<button onClick={() => void persist(stateRef.current).catch(() => {})}>Retry save</button></div>}
      {!historyOpen && <form className={styles.composer} onSubmit={(event) => { event.preventDefault(); void send(conversation.draft); }}>
        {session ? <span className={styles.context}><span className={styles.contextDot} /><span>{context.title}</span></span> : feedbackContext ? <span className={styles.context}><span className={styles.contextDot} /><span>{feedbackContext.title}</span></span> : <button type="button" className={styles.context} aria-pressed={includeContext} title={includeContext ? ui("Remove current page from the next message") : ui("Include current page in the next message")} onClick={() => setIncludeContext(!includeContext)}>{includeContext ? <><span className={styles.contextDot} /><span>{context.title}</span><X size={12} /></> : <><Plus size={13} /><span>Add current page</span></>}</button>}
        <ComposerTextArea ref={input} aria-label={ui("Ask Screenpipe")} placeholder={session ? ui("Ask about this workflow…") : feedbackContext ? platform.learnsFromFeedback ? ui("Share feedback to refine this workflow…") : ui("Answer a question or share feedback…") : includeContext && context.purpose === "video" ? ui("Change the narration, screenshots, or pacing…") : includeContext && context.purpose === "sop" ? ui("Ask Screenpipe to edit this SOP…") : includeContext && context.workflow ? ui("Ask about this workflow…") : ui("Ask or find anything…")} rows={1}
          value={conversation.draft} maxLength={8000} disabled={!loaded} onChange={(event) => session ? session.setDraft(event.target.value) : update((current) => ({
            ...current, conversations: current.conversations.map((item) => item.id === current.activeId ? { ...item, draft: event.target.value } : item),
          }))} onSend={() => void send(conversation.draft)} />
        <div className={styles.composerFooter}>
          {open && active && composerAccessory?.({ inputValue: conversation.draft, inputRef: input,
            onValueChange: value => session ? session.setDraft(value) : update(current => ({ ...current, conversations: current.conversations.map(item => item.id === current.activeId ? { ...item, draft: value } : item) })),
            disabled: !loaded || busy, sessionId: conversation.id,
          })}
          {busy ? <button type="button" className={styles.send} aria-label={ui("Stop answer")} title={ui("Stop answer")} onClick={() => session ? session.stop() : controller.current?.abort()}><Square size={12} fill="currentColor" /></button>
            : <button className={styles.send} type="submit" aria-label={feedbackContext ? ui("Send feedback") : ui("Send message")} title={ui("Send (Enter)")} disabled={!loaded || !conversation.draft.trim()}><ArrowUp size={18} /></button>}
        </div>
      </form>}
    </aside>
  </>;
}
