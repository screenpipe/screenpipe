// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { homeDir, join } from "@tauri-apps/api/path";
import { exists } from "@tauri-apps/plugin-fs";
import { platform } from "@tauri-apps/plugin-os";
import { commands } from "@/lib/utils/tauri";
import { SCREENPIPE_API_SKILL_MD } from "@/lib/generated/screenpipe-skills";

export const GROKBOT_SETUP_GUIDE = "https://docs.x.ai/grok-bot/computer-and-apps";

// Grok Bot's connectors run on its cloud computer. Detect the companion app
// only for discovery; neither its presence nor copying instructions proves
// that the Bot has access to this machine. Do not write Grok CLI's .grok config.
export async function isGrokBotDetected(): Promise<boolean> {
  try {
    const home = await homeDir();
    const paths = [await join(home, ".grokbot", "settings.json")];
    if (platform() === "macos") {
      paths.push("/Applications/Grok Bot.app", await join(home, "Applications", "Grok Bot.app"));
    }
    return (await Promise.all(paths.map((path) => exists(path).catch(() => false)))).some(Boolean);
  } catch {
    return false;
  }
}

export async function getGrokBotSetupPrompt(): Promise<string> {
  const [api, bun, dataDir] = await Promise.all([
    commands.getLocalApiConfig(),
    commands.bunCheck(),
    commands.getActiveDataDir(),
  ]);
  const port = api !== null && typeof api === "object" && !Array.isArray(api) ? api.port : undefined;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Screenpipe's local address is unavailable. Start recording and try again.");
  }
  if (bun.status !== "ok" || !bun.data.available || !bun.data.path) {
    throw new Error("Screenpipe's bundled runtime is unavailable. Restart Screenpipe and try again.");
  }
  if (dataDir.status !== "ok" || !dataDir.data) {
    throw new Error("Screenpipe's data location is unavailable. Restart Screenpipe and try again.");
  }

  // Only non-secret connection parameters go to the clipboard. Resolve the
  // key on the local computer at use time, including after key rotation.
  const connection = JSON.stringify({
    SCREENPIPE_LOCAL_API_URL: `http://127.0.0.1:${port}`,
    SCREENPIPE_DATA_DIR: dataDir.data,
    bun: bun.data.path,
  }, null, 2);

  return `Set up Screenpipe access for Grok Bot using the local-computer command feature.

Screenpipe runs on my local computer, separate from your cloud computer. Ask me to choose the correct local computer if more than one is available, and request local-command approval through Grok Bot. If local commands are unavailable or denied, stop and explain that setup is incomplete.

Use these connection parameters on that local computer:
${connection}

Use the bundled bun executable above wherever the reference below says bun. Set SCREENPIPE_DATA_DIR and SCREENPIPE_LOCAL_API_URL to the exact values above in every local command. Obtain authentication with that bun executable running \`x screenpipe@latest auth token\`; capture stdout directly into a local variable. Never print, upload, or save the token in chat or a skill. Keep authentication enabled. Do not edit Grok CLI settings or register localhost as a cloud MCP connector, and do not open a network tunnel.

First check /health through the local-computer command feature. Once it succeeds, save a private Screenpipe skill using the reference below, with the local execution and connection parameters above. Do not include credentials. Explain that each retrieval needs the local computer online and follows my Grok Bot local-computer permissions. Ask what I want to retrieve before reading recordings. Do not claim recording access is verified until an authenticated query succeeds; on 401/403, missing authentication, or a locked vault, report setup as incomplete instead of scanning credential files or changing permissions.

Screenpipe API reference (all commands must run on my local computer):

${SCREENPIPE_API_SKILL_MD}`;
}
