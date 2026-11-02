// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Finish an empty model turn inside the existing agent loop, before agent_end
 * releases the composer/queue. Reuse the conversation, including tool results;
 * never replay the user's original request as a fresh run. */
export default function (pi: ExtensionAPI) {
  const results = new Set<string>();
  let progress = 0;
  let recoveredAtProgress = -1;
  let waitingForConnection = false;

  pi.on("message_start", (event) => {
    if (event.message.role !== "user") return;
    results.clear();
    progress = 0;
    recoveredAtProgress = -1;
    waitingForConnection = false;
  });

  pi.on("turn_end", (event, ctx) => {
    for (const result of event.toolResults) {
      const content = JSON.stringify(result.content);
      // A connect handoff needs the user, rather than another model call.
      if (result.content.some((part) => {
        if (part.type !== "text") return false;
        try { return JSON.parse(part.text).status === "needs_connection"; }
        catch { return false; }
      })) waitingForConnection = true;
      if (!result.isError) {
        const signature = createHash("sha256").update(`${result.toolName}:${content}`).digest("hex");
        if (!results.has(signature)) {
          results.add(signature);
          progress += 1;
        }
      }
    }

    const message = event.message;
    if (message.role !== "assistant" || ctx.signal?.aborted || ctx.hasPendingMessages() || waitingForConnection) return;
    // Errors belong to Pi's provider retry lifecycle; abort belongs to Stop.
    // Tool calls already keep Pi's inner loop running, including truncated calls.
    if (message.stopReason !== "stop" && message.stopReason !== "length" && message.stopReason !== "toolUse") return;
    if (message.content.some((part) => part.type === "toolCall")) return;
    if (message.stopReason === "stop" && message.content.some((part) => part.type === "text" && part.text.trim())) {
      if (recoveredAtProgress >= 0) console.warn("[answer-recovery] action=complete outcome=answered");
      return;
    }
    // Repeating an empty completion without new evidence cannot make progress.
    // Leave it terminal and recoverable in chat instead of looping forever.
    if (recoveredAtProgress === progress) {
      console.warn(`[answer-recovery] action=stop stop_reason=${message.stopReason} outcome=incomplete cause=no_new_evidence recovery=retry`);
      return;
    }
    recoveredAtProgress = progress;
    console.warn(`[answer-recovery] action=continue stop_reason=${message.stopReason} outcome=pending`);
    pi.sendMessage({
      customType: "screenpipe-answer-recovery",
      display: false,
      content: "The previous model response ended before answering the user. Continue the user's pending request from the existing conversation and tool results. Do not repeat completed actions. Finish any remaining authorized work and give the user a useful final answer explaining what completed and what remains unresolved. Do not end with only thinking or tool activity.",
    }, { deliverAs: "followUp" });
  });
}
