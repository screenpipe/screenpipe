// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";

import { useState, useRef, type ReactNode } from "react";
import { ArrowUpRight, Check, Copy, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export const CLOUD_MCP_URL = "https://screenpipe.com/api/user/data-sync/mcp";
export const CODEX_CLOUD_SETUP = `codex mcp add screenpipe-cloud --url ${CLOUD_MCP_URL} && codex mcp login screenpipe-cloud --scopes data-sync:read`;
export const CLOUD_EXAMPLE =
  "Use Screenpipe to find the decisions and next steps from my meetings today.";
const CLAUDE_CONNECTORS_URL = "https://claude.ai/settings/connectors";

type Props = {
  enabled: boolean;
  loading?: boolean;
  busy?: boolean;
  error?: string | null;
  onEnable: () => Promise<boolean>;
  onRetry?: () => void;
  onOpenExternal?: (url: string) => Promise<void>;
  device?: boolean;
  children?: ReactNode;
};

/** Cloud consent and client handoff are separate; neither proves client authentication. */
export function CloudAiConnectionCard({
  enabled,
  loading,
  busy,
  error,
  onEnable,
  onRetry,
  onOpenExternal,
  device,
  children,
}: Props) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [client, setClient] = useState<"Codex" | "Claude" | null>(null);
  const [enabling, setEnabling] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const pending = busy || enabling;

  async function copy(value: string, kind: string) {
    setActionError(null);
    setCopied(null);
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
    } catch {
      setActionError(
        "Could not copy. Select the setup text and copy it manually.",
      );
    }
  }

  async function enable() {
    if (pending) return;
    setEnabling(true);
    setActionError(null);
    try {
      if (!(await onEnable()))
        setActionError("Cloud sync could not be enabled. Try again.");
    } catch {
      setActionError("Cloud sync could not be enabled. Try again.");
    } finally {
      setEnabling(false);
    }
  }

  function selectClient(next: "Codex" | "Claude") {
    setClient(next);
    setCopied(null);
    setActionError(null);
  }

  return (
    <section
      className="space-y-5 rounded-lg border bg-card p-5 text-card-foreground"
      aria-label="AI connections"
      data-testid="cloud-ai-connections"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">AI connections</p>
        <p
          className="flex items-center gap-2 text-xs text-muted-foreground"
          role="status"
        >
          {loading || pending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          ) : (
            <span
              className={`h-1.5 w-1.5 rounded-full ${enabled ? "bg-foreground" : "bg-muted-foreground"}`}
            />
          )}
          {loading
            ? "Checking cloud sync…"
            : pending
              ? "Saving…"
              : error
                ? "Sync needs attention"
                : enabled
                ? "Cloud sync on"
                : "Cloud sync off"}
        </p>
      </div>
      <div className="space-y-2">
        <h2 className="text-xl font-semibold tracking-tight">
          Give your AI context from your day
        </h2>
        <p className="max-w-xl text-sm text-muted-foreground">
          Let Codex and Claude find what you saw, recall meeting decisions, and
          pick up where you left off.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          onClick={(event) => {
            triggerRef.current = event.currentTarget;
            selectClient("Codex");
          }}
          disabled={loading || pending || !!error}
        >
          Connect Codex <ArrowUpRight className="ml-2 h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={(event) => {
            triggerRef.current = event.currentTarget;
            selectClient("Claude");
          }}
          disabled={loading || pending || !!error}
        >
          Connect Claude <ArrowUpRight className="ml-2 h-4 w-4" />
        </Button>
      </div>
      <p className="border-l-2 border-border pl-3 text-sm text-muted-foreground">
        Try asking:{" "}
        <span className="text-foreground">
          “What did we decide in today’s meetings?”
        </span>
      </p>
      <p className="text-xs text-muted-foreground">
        Cloud sync uploads your Screenpipe history. Connected AI clients get
        read-only access. You control syncing.
      </p>
      {error && (
        <div role="alert" className="space-y-2 text-sm text-destructive">
          <p>{error}</p>
          {onRetry && (
            <Button type="button" variant="outline" size="sm" onClick={onRetry}>
              Try again
            </Button>
          )}
        </div>
      )}
      {children && (
        <details className="border-t pt-3">
          <summary className="cursor-pointer text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4">
            Manage synced data
          </summary>
          <div className="space-y-4 pt-4">{children}</div>
        </details>
      )}

      <Dialog
        open={!!client}
        onOpenChange={(open) => {
          if (!open && !pending) {
            setClient(null);
            setActionError(null);
          }
        }}
      >
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            triggerRef.current?.focus();
          }}
          className="max-h-[90vh] overflow-y-auto outline-none sm:max-w-lg"
        >
          <DialogHeader className="pr-6 text-left">
            <DialogTitle>
              {enabled
                ? `Connect ${client}`
                : `Enable cloud sync for ${client}?`}
            </DialogTitle>
            <DialogDescription>
              {enabled
                ? "Finish setup in your AI app, then try your first question."
                : device
                  ? "Upload this device’s Screenpipe history so your AI can search it. You can turn syncing off here anytime."
                  : "Allow your Screenpipe devices to upload history so your AI can search it. Each device also needs syncing enabled in the desktop app."}
            </DialogDescription>
          </DialogHeader>
          {!enabled ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Only this account’s synced history is available. Your AI cannot
                change or delete it.
              </p>
              <Button
                type="button"
                className="w-full"
                onClick={() => void enable()}
                disabled={pending}
              >
                {pending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
                )}
                {pending
                  ? "Enabling cloud sync…"
                  : "Enable cloud sync and continue"}
              </Button>
            </div>
          ) : (
            <div className="space-y-5">
              {client === "Codex" ? (
                <div className="space-y-3">
                  <p className="text-sm">
                    Run this once in a terminal with Codex installed. Sign in to
                    your Screenpipe account when the browser opens.
                  </p>
                  <Button
                    type="button"
                    className="w-full"
                    onClick={() => void copy(CODEX_CLOUD_SETUP, "setup")}
                  >
                    {copied === "setup" ? (
                      <Check className="mr-2 h-4 w-4" />
                    ) : (
                      <Copy className="mr-2 h-4 w-4" />
                    )}
                    {copied === "setup"
                      ? "Setup command copied"
                      : "Copy setup command"}
                  </Button>
                  <textarea
                    aria-label="Codex setup command"
                    readOnly
                    rows={4}
                    value={CODEX_CLOUD_SETUP}
                    className="w-full resize-none rounded-md border bg-muted p-3 font-mono text-xs"
                    onFocus={(event) => event.target.select()}
                  />
                  <p className="text-xs text-muted-foreground">
                    Uses a separate “screenpipe-cloud” connection and keeps your
                    local Screenpipe connection.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm">
                    In Claude’s connectors, add a custom connector with this
                    URL, then sign in to Screenpipe.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      onClick={() => void copy(CLOUD_MCP_URL, "setup")}
                    >
                      {copied === "setup" ? (
                        <Check className="mr-2 h-4 w-4" />
                      ) : (
                        <Copy className="mr-2 h-4 w-4" />
                      )}
                      {copied === "setup"
                        ? "URL copied"
                        : "Copy connection URL"}
                    </Button>
                    <Button variant="outline" asChild>
                      <a
                        href={CLAUDE_CONNECTORS_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={
                          onOpenExternal
                            ? (event) => {
                                event.preventDefault();
                                void onOpenExternal(
                                  CLAUDE_CONNECTORS_URL,
                                ).catch(() =>
                                  setActionError(
                                    "Could not open Claude. Open claude.ai/settings/connectors in your browser.",
                                  ),
                                );
                              }
                            : undefined
                        }
                      >
                        Open Claude <ArrowUpRight className="ml-2 h-4 w-4" />
                      </a>
                    </Button>
                  </div>
                  <input
                    aria-label="Cloud MCP URL"
                    readOnly
                    value={CLOUD_MCP_URL}
                    className="w-full rounded-md border bg-muted p-3 font-mono text-xs"
                    onFocus={(event) => event.target.select()}
                  />
                  <p className="text-xs text-muted-foreground">
                    On a team account, an owner may need to add the connector
                    first.
                  </p>
                </div>
              )}
              <div className="space-y-2 border-t pt-4">
                <p className="text-sm font-medium">Then try it in {client}</p>
                <p className="text-sm text-muted-foreground">{CLOUD_EXAMPLE}</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void copy(CLOUD_EXAMPLE, "prompt")}
                >
                  {copied === "prompt"
                    ? "Question copied"
                    : "Copy first question"}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Setup is complete when your AI can list your synced devices.
                Opening setup does not confirm a connection.
              </p>
            </div>
          )}
          {actionError && (
            <p role="alert" className="text-sm text-destructive">
              {actionError}
            </p>
          )}
          {copied && (
            <span role="status" className="sr-only">
              {copied === "prompt" ? "Question copied" : "Setup copied"}
            </span>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
