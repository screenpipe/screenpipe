// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { workflowModelPreference } from "./model-choice";
import { WORKFLOW_MODELS } from "@screenpipe/workflows-ui";
import { commands, type PiProviderConfig } from "@/lib/utils/tauri";
import { mountAgentEventBus, registerForeground, onTerminated, onEvicted } from "@/lib/events/bus";
import type { AgentInnerEvent } from "@/lib/events/types";
import { advanceMeetingChatStream, emptyStreamState } from "@/components/meeting-notes/meeting-chat-stream";
import { INTERNAL_TITLE_PREFIX } from "@/lib/utils/internal-session";
import type { WorkflowsAssistantPlatform } from "@screenpipe/workflows-ui";

export async function runWorkflowAgent({ name, prompt, config, signal, onProgress, onEvent, allowEmpty = false, timeoutMs = 180000 }: {
  name: "assistant" | "context" | "guide";
  prompt: string;
  config: PiProviderConfig;
  signal: AbortSignal;
  onProgress?: Parameters<WorkflowsAssistantPlatform["ask"]>[0]["onProgress"];
  onEvent?: (event: AgentInnerEvent) => void;
  allowEmpty?: boolean;
  timeoutMs?: number;
}) {
    const sessionId = `${INTERNAL_TITLE_PREFIX}workflow-${name}-${crypto.randomUUID()}`;
    let stream = emptyStreamState();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resolve!: (text: string) => void;
    let reject!: (error: Error) => void;
    const result = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
    // Startup can still be awaiting IPC when stop/termination arrives.
    void result.catch(() => {});
    const fail = (error: Error) => { if (!settled) { settled = true; reject(error); } };
    const abort = () => { fail(new DOMException("Stopped", "AbortError")); void commands.piStop(sessionId).catch(() => {}); };
    const assertActive = () => { if (signal.aborted || settled) { void commands.piStop(sessionId).catch(() => {}); throw new DOMException("Stopped", "AbortError"); } };
    const unregister: Array<() => void> = [];
    signal.addEventListener("abort", abort, { once: true });
    try {
      const startup = (async () => {
      assertActive();
      timer = setTimeout(() => fail(new Error("This is taking longer than expected. Try a narrower question.")), timeoutMs);
      onProgress?.({ text: "", activity: "starting" });
      await mountAgentEventBus(); assertActive();
      const base = await commands.getScreenpipeBaseDir(); assertActive();
      if (base.status === "error") throw new Error("Couldn’t open your local workspace.");
      // Use the same encrypted account token that hydrates normal chat's
      // settings.user.token. Read it for each run so login/logout is current.
      const userToken = await commands.getCloudToken(); assertActive();
      if (config.provider === "screenpipe-cloud" && !userToken) {
        throw new Error("Sign in to Screenpipe in Settings to continue.");
      }
      unregister.push(registerForeground(sessionId, (envelope) => {
        if (settled || envelope.sessionId !== sessionId || envelope.source !== "pi") return;
        try { onEvent?.(envelope.event); } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); return; }
        if (envelope.event.type === "message_start" && envelope.event.message?.role === "assistant") stream = emptyStreamState();
        // Reuse stream folding, not the meeting rail's narrower tool policy.
        stream = advanceMeetingChatStream(stream, envelope, (toolName) =>
          !toolName || config.allowedTools?.includes(toolName) === true);
        if (stream.error) { fail(new Error(stream.error)); return; }
        if (envelope.event.type === "message_end" && envelope.event.message?.stopReason === "error") { fail(new Error(envelope.event.message.errorMessage || "Couldn’t finish the answer.")); return; }
        onProgress?.({ text: stream.text, activity: envelope.event.type?.startsWith("tool_execution") ? "searching" : stream.text ? "writing" : "starting" });
        if (stream.done) {
          if (!allowEmpty && !stream.text.trim()) { fail(new Error("No answer came back. Try again.")); return; }
          settled = true; resolve(stream.text);
        }
      }));
      unregister.push(onTerminated((event) => { if (event.sessionId === sessionId) fail(new Error("The conversation was interrupted. Try again.")); }));
      unregister.push(onEvicted((event) => { if (event.sessionId === sessionId) fail(new Error("The conversation was interrupted. Try again.")); }));
      const choice = await workflowModelPreference.load(); assertActive();
      config = { ...config, provider: "screenpipe-cloud", model: WORKFLOW_MODELS[choice].model, url: "", apiKey: null, acpAgent: null, backend: null, maxContextChars: null };
      const started = await commands.piStart(sessionId, `${base.data}/pi-workflows-${name}`, userToken, config);
      assertActive();
      if (started.status === "error" || !started.data.running) throw new Error(started.status === "error" ? started.error : "Couldn’t start the assistant.");
      const prompted = await commands.piPrompt(sessionId, prompt, null, null);
      if (prompted.status === "error") throw new Error(prompted.error);
      return await result;
      })();
      // Stop/timeout must settle the UI even when native startup is slow. The
      // post-await guards stop a late-starting process before it can prompt.
      return await Promise.race([startup, result]);
    } finally {
      settled = true;
      clearTimeout(timer);
      unregister.forEach((off) => off());
      signal.removeEventListener("abort", abort);
      await commands.piStop(sessionId).catch(() => {});
    }
}
