// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";

import { useState } from "react";
import { Copy, ExternalLink, Loader2 } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { commands } from "@/lib/utils/tauri";
import { getGrokBotSetupPrompt, GROKBOT_SETUP_GUIDE } from "@/lib/grokbot-connection";

export function GrokBotPanel() {
  const [copying, setCopying] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const copySetup = async () => {
    setCopying(true);
    setCopied(false);
    setError(null);
    try {
      const prompt = await getGrokBotSetupPrompt();
      const result = await commands.copyTextToClipboard(prompt);
      if (result.status === "error") throw new Error(result.error);
      setCopied(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not copy setup instructions. Try again.");
    } finally {
      setCopying(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Let Grok Bot search your screen and audio history through its local-computer access.
        Grok Bot needs a one-time setup in its app.
      </p>
      <ol className="list-decimal pl-4 space-y-1 text-xs text-muted-foreground">
        <li>Copy the setup prompt and paste it into Grok Bot.</li>
        <li>Approve access to this computer when Grok Bot asks.</li>
        <li>Ask Grok Bot what you worked on in the last five minutes.</li>
      </ol>
      <p className="text-xs text-muted-foreground">
        Keep Screenpipe and Grok Bot open on this computer. Results you request are shared
        with Grok Bot. Manage or revoke local access in Grok Bot settings.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={copySetup} disabled={copying} size="sm" className="gap-1.5 h-7 text-xs normal-case font-sans tracking-normal">
          {copying ? <Loader2 className="h-3 w-3 animate-spin" /> : <Copy className="h-3 w-3" />}
          {copying ? "preparing..." : "copy setup prompt"}
        </Button>
        <Button variant="outline" onClick={() => openUrl(GROKBOT_SETUP_GUIDE)} size="sm" className="gap-1.5 h-7 text-xs normal-case font-sans tracking-normal">
          <ExternalLink className="h-3 w-3" />setup guide
        </Button>
      </div>
      {copied && <p role="status" className="text-xs text-muted-foreground">Copied. Paste into Grok Bot to finish setup there.</p>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
