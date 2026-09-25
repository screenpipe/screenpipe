// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";

import { screenpipeWebUrl, PROD_WEB_BASE } from "@/lib/web-url";
import { Button } from "@/components/ui/button";

export type CloudClient = "codex" | "claude-code";
export const CLOUD_MCP_URL = screenpipeWebUrl("/api/user/data-sync/mcp", PROD_WEB_BASE);
export const CLAUDE_CONNECTORS_URL = "https://claude.ai/customize/connectors";
export const CODEX_CLOUD_SETUP = `codex mcp add screenpipe-cloud --url ${CLOUD_MCP_URL} && codex mcp login screenpipe-cloud --scopes data-sync:read`;
export const CODEX_SETUP_PROMPT = `Connect my local Codex app to Screenpipe Cloud at ${CLOUD_MCP_URL} using a separate MCP server named screenpipe-cloud. Preserve my existing servers and settings. Check for an existing connection first. If the Codex CLI is available, add the HTTP server and start OAuth login with the data-sync:read scope. If no CLI is installed, safely add [mcp_servers.screenpipe-cloud] with url = "${CLOUD_MCP_URL}" to my active Codex config (respect CODEX_HOME; otherwise ~/.codex/config.toml). Do not overwrite a conflicting entry or install software. Ask me to authenticate in Settings > MCP servers and reload if required. Never ask me to paste tokens into chat. Verify by listing my synced devices before saying it is connected. If you cannot access my local config, tell me to add this URL in my app's MCP settings.`;
export const CLAUDE_CODE_SETUP_PROMPT = `Connect Claude Code to Screenpipe Cloud at ${CLOUD_MCP_URL} with a user-scoped HTTP MCP server named screenpipe-cloud. Preserve existing connections and check whether it is already configured. If needed, run: claude mcp add --transport http --scope user screenpipe-cloud ${CLOUD_MCP_URL}. Ask me to open /mcp and authenticate. Do not install software or ask for tokens in chat. Verify by listing my synced devices before saying it is connected. If this is ordinary Claude chat rather than Claude Code, direct me to ${CLAUDE_CONNECTORS_URL} to add this URL and connect instead.`;

type Props = {
  client: "Codex" | "Claude";
  native: boolean;
  configuring: CloudClient | null;
  configured: Partial<Record<CloudClient, boolean>>;
  copied: string | null;
  onConfigure: (client: CloudClient) => void;
  onCopy: (text: string, kind: string) => void;
  onOpenClaude: () => void;
};

export function CloudAiClientSetup({
  client,
  native,
  configuring,
  configured,
  copied,
  onConfigure,
  onCopy,
  onOpenClaude,
}: Props) {
  const target = client === "Codex" ? "codex" : "claude-code";
  const prompt =
    client === "Codex" ? CODEX_SETUP_PROMPT : CLAUDE_CODE_SETUP_PROMPT;
  const promptControl = (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Paste this into a local {client === "Codex" ? "Codex" : "Claude Code"}{" "}
        chat. Your AI can handle setup, then ask you to sign in.
      </p>
      <Button
        type="button"
        className="w-full"
        onClick={() => onCopy(prompt, "setup-message")}
      >
        {copied === "setup-message"
          ? "Setup message copied"
          : "Copy setup message"}
      </Button>
      {copied === "setup-message" && (
        <p role="status" className="text-sm">
          Now paste into {client === "Codex" ? "Codex" : "Claude Code"} and
          send.
        </p>
      )}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">View setup message</summary>
        <textarea
          aria-label={`${client} setup message`}
          readOnly
          value={prompt}
          rows={7}
          className="mt-2 w-full rounded-md border bg-muted p-3 text-xs"
          onFocus={(event) => event.target.select()}
        />
      </details>
    </div>
  );
  const nativeControl = (
    <div className="space-y-3">
      {configured[target] ? (
        <div role="status" className="space-y-2">
          <p className="text-sm font-medium">
            Added to {client === "Codex" ? "Codex" : "Claude Code"}
          </p>
          <p className="text-sm text-muted-foreground">
            {client === "Codex"
              ? "In Codex, open Settings → MCP servers, reload if needed, and authenticate screenpipe-cloud."
              : "In Claude Code, open /mcp and authenticate screenpipe-cloud. Restart the session if it is not listed."}
          </p>
        </div>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {client === "Codex"
              ? "Screenpipe adds the connection for you. No terminal or separate CLI install."
              : "Screenpipe adds the connection to Claude Code on this computer."}
          </p>
          <Button
            type="button"
            className="w-full"
            disabled={!!configuring}
            onClick={() => onConfigure(target)}
          >
            {configuring === target
              ? "Adding connection…"
              : `Add to ${client === "Codex" ? "Codex" : "Claude Code"}`}
          </Button>
        </>
      )}
      <details className="text-sm">
        <summary className="cursor-pointer">
          Set up through chat instead
        </summary>
        <div className="pt-3">{promptControl}</div>
      </details>
    </div>
  );
  if (client === "Codex")
    return (
      <div className="space-y-4">
        {native ? nativeControl : promptControl}
        <details className="text-sm">
          <summary className="cursor-pointer">Other ways to connect</summary>
          <div className="space-y-3 pt-3">
            <p className="text-sm text-muted-foreground">
              No CLI? In the Codex app, open Settings → MCP servers → Add
              server. Choose Streamable HTTP, name it screenpipe-cloud, paste
              this URL, and authenticate.
            </p>
            <input
              aria-label="Cloud MCP URL"
              readOnly
              value={CLOUD_MCP_URL}
              className="w-full rounded-md border bg-muted p-3 font-mono text-xs"
              onFocus={(event) => event.target.select()}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onCopy(CLOUD_MCP_URL, "url")}
            >
              {copied === "url" ? "URL copied" : "Copy connection URL"}
            </Button>
            <p className="text-xs text-muted-foreground">
              Already use the CLI?
            </p>
            <textarea
              aria-label="Codex setup command"
              readOnly
              rows={4}
              value={CODEX_CLOUD_SETUP}
              className="w-full resize-none rounded-md border bg-muted p-3 font-mono text-xs"
              onFocus={(event) => event.target.select()}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onCopy(CODEX_CLOUD_SETUP, "setup")}
            >
              {copied === "setup"
                ? "Setup command copied"
                : "Copy setup command"}
            </Button>
          </div>
        </details>
      </div>
    );
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Add a custom connector in Claude, paste the URL, then connect your
        Screenpipe account. Works with Claude web and desktop.
      </p>
      <Button type="button" className="w-full" onClick={onOpenClaude}>
        {copied === "claude-url"
          ? "URL copied · Open Claude again"
          : "Copy URL and open Claude"}
      </Button>
      <p className="text-xs text-muted-foreground">
        A chat message cannot add a connector to your Claude account. On a team
        account, an owner may need to add it first.
      </p>
      <details className="text-sm">
        <summary className="cursor-pointer">Connection URL and help</summary>
        <div className="space-y-3 pt-3">
          <input
            aria-label="Cloud MCP URL"
            readOnly
            value={CLOUD_MCP_URL}
            className="w-full rounded-md border bg-muted p-3 font-mono text-xs"
            onFocus={(event) => event.target.select()}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onCopy(CLOUD_MCP_URL, "url")}
          >
            {copied === "url" ? "URL copied" : "Copy connection URL"}
          </Button>
          <a
            href={CLAUDE_CONNECTORS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="block text-xs underline"
          >
            Open Claude connectors
          </a>
        </div>
      </details>
      <details className="text-sm">
        <summary className="cursor-pointer">Using Claude Code?</summary>
        <div className="pt-3">{native ? nativeControl : promptControl}</div>
      </details>
    </div>
  );
}
