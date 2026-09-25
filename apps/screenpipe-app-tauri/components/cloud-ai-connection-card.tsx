// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";

import { useState, useRef, type ReactNode } from "react";
import { ArrowUpRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import {
  CloudAiClientSetup,
  CLOUD_MCP_URL,
  CLAUDE_CONNECTORS_URL,
  type CloudClient,
} from "./cloud-ai-client-setup";
export {
  CLOUD_MCP_URL,
  CODEX_CLOUD_SETUP,
  CODEX_SETUP_PROMPT,
} from "./cloud-ai-client-setup";
export const CLOUD_EXAMPLE =
  "Use Screenpipe to find the decisions and next steps from my meetings today.";

type Props = {
  enabled: boolean;
  loading?: boolean;
  busy?: boolean;
  error?: string | null;
  onEnable: () => Promise<boolean>;
  onRetry?: () => void;
  onOpenExternal?: (url: string) => Promise<void>;
  onConfigureClient?: (client: CloudClient) => Promise<void>;
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
  onConfigureClient,
  children,
}: Props) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [client, setClient] = useState<"Codex" | "Claude" | null>(null);
  const [enabling, setEnabling] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [configuring, setConfiguring] = useState<CloudClient | null>(null);
  const [configured, setConfigured] = useState<
    Partial<Record<CloudClient, boolean>>
  >({});
  const configLock = useRef(false);
  const pending = busy || enabling || !!configuring;

  async function configure(target: CloudClient) {
    if (!onConfigureClient || configLock.current) return;
    configLock.current = true;
    setConfiguring(target);
    setActionError(null);
    try {
      await onConfigureClient(target);
      setConfigured((previous) => ({ ...previous, [target]: true }));
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : "Could not add the connection. Retry or use the setup message.",
      );
    } finally {
      configLock.current = false;
      setConfiguring(null);
    }
  }

  function openClaude() {
    setActionError(null);
    // Open synchronously from the click so browser popup blockers do not treat
    // the clipboard await as a lost user gesture. No account state is inferred.
    const opened = onOpenExternal
      ? onOpenExternal(CLAUDE_CONNECTORS_URL)
      : Promise.resolve(
          window.open(CLAUDE_CONNECTORS_URL, "_blank", "noopener,noreferrer"),
        );
    void opened.catch(() =>
      setActionError(
        "Could not open Claude. Use the link under Connection URL and help.",
      ),
    );
    void copy(CLOUD_MCP_URL, "claude-url");
  }

  async function copy(value: string, kind: string) {
    setActionError(null);
    setCopied(null);
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
    } catch {
      setActionError(
        "Could not copy. Expand the setup message or connection URL below and copy it manually.",
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
      else if (client === "Codex" && onConfigureClient)
        await configure("codex");
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
    if (next === "Codex" && enabled && onConfigureClient)
      void configure("codex");
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
              ? configuring
                ? "Adding connection…"
                : "Saving…"
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
              <CloudAiClientSetup
                client={client ?? "Codex"}
                native={!!onConfigureClient}
                configuring={configuring}
                configured={configured}
                copied={copied}
                onConfigure={(target) => void configure(target)}
                onCopy={(value, kind) => void copy(value, kind)}
                onOpenClaude={openClaude}
              />
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
