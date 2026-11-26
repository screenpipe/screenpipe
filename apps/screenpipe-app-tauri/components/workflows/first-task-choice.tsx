// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";

import { ArrowRight, Check, Search, Workflow } from "lucide-react";
import { useState } from "react";
import type { ProductMode } from "./product-switcher";
import { useGT } from "gt-react";


export function FirstTaskChoice({ onComplete }: { onComplete: (mode: ProductMode) => Promise<void> }) {

  const ui = useGT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function complete(mode: ProductMode) {
    if (busy) return;
    setBusy(true); setError("");
    try { await onComplete(mode); }
    catch { setError(ui("Couldn't save your choice. Please try again.")); setBusy(false); }
  }
  return <section className="mx-auto w-full max-w-xl px-6 py-8 text-foreground">
    <p className="mb-5 flex items-center justify-center gap-2 text-xs text-muted-foreground"><Check size={14} /> Screenpipe is set up</p>
    <h1 className="text-center text-3xl font-medium tracking-tight">What would you like to do first?</h1>
    <p className="mt-3 text-center text-sm text-muted-foreground">Your memory and workflows, together in one app.</p>
    <div className="mt-9 grid gap-3">
      <button disabled={busy} onClick={() => void complete("screenpipe")} className="group flex items-center gap-4 rounded-lg border border-border p-5 text-left transition-colors hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50">
        <Search size={22} /><span className="flex-1"><strong className="block text-base font-medium">Find something</strong><span className="mt-1 block text-sm text-muted-foreground">Ask about a conversation, a task, or a moment from your day.</span></span><ArrowRight size={17} />
      </button>
      <button disabled={busy} onClick={() => void complete("workflows")} className="group flex items-center gap-4 rounded-lg border border-border p-5 text-left transition-colors hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50">
        <Workflow size={22} /><span className="flex-1"><strong className="block text-base font-medium">Understand a workflow</strong><span className="mt-1 block text-sm text-muted-foreground">See the steps in work you repeat, with evidence from your history.</span></span><ArrowRight size={17} />
      </button>
    </div>
    <p className="mt-7 text-center text-xs text-muted-foreground">Switch anytime from the menu at the top of the sidebar.</p>
    {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
  </section>;
}
