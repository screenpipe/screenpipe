# Screenpipe for Hermes and OpenClaw

A portable Agent Plugins v1 bundle: a self-contained, read-only Screenpipe MCP
server plus a skill for recording setup, retrieval, attribution and app handoff.
Requires a compatible host, Node 18+, and the Screenpipe app on the recording
computer. Installing the bundle alone does not record anything.

## The first-run experience

1. Install and open [Screenpipe](https://screenpipe.com/download?utm_source=agent&utm_medium=agent_plugin)
   on the computer you want to record. Complete onboarding, choose capture and
   exclusions, and grant the requested OS permissions yourself.
2. Keep Screenpipe running. **Settings → General → Auto-start** starts the app in
   the background after login. Recording is independent of your agent session;
   sleep, shutdown, intentional pauses and exclusions can leave gaps.
3. Enable this plugin in your agent. Selected history becomes available to that
   agent and its configured model provider. Local storage does not mean an
   external agent's model processing stays local.
4. Ask: **“Set up Screenpipe, then tell me what I worked on in the last five minutes.”**
   Expect recording status, any required next step, then a source-backed answer.
   No connector can recover history from before Screenpipe started recording.

## Build and install

From `packages/screenpipe-mcp`, using Bun:

```sh
bun install --frozen-lockfile
bun run build:installers
```

The builder writes `installers/screenpipe-agent/` and `screenpipe-agent.zip`.
The folder contains the actual bundled server, not a downloader or recorder.
Do not install this source template directly: `dist/index.js` is generated.

Hermes (with portable Agent Plugins support): copy the generated directory into
its user plugin directory, then enable it. Stop if that destination already
exists and review the installed version first. The current Hermes Git/catalog
installer does not accept an absolute local directory as its source.

```sh
mkdir -p "$HOME/.hermes/plugins"
test ! -e "$HOME/.hermes/plugins/screenpipe-agent" && \
  cp -R /absolute/path/to/installers/screenpipe-agent "$HOME/.hermes/plugins/screenpipe-agent"
hermes plugins enable screenpipe-agent
hermes plugins list
```

If Hermes asks to allow replacing built-in tools, decline. Screenpipe does not
need that privileged capability.

OpenClaw (with Agent Plugins bundle support):

```sh
openclaw plugins install /absolute/path/to/installers/screenpipe-agent
openclaw plugins enable screenpipe-agent
openclaw plugins inspect screenpipe-agent
```

Start a new session. Use the host's skill list to discover the namespaced
Screenpipe skill. If you already connected Screenpipe in the app, keep one MCP
server named `screenpipe`: a manually configured server can take precedence over
the bundle. Inspect the effective tools. The read-only bundle must not expose
`control-recording`, `create-pipe`, `update-memory`, or team tools. Remove the
older MCP entry through its existing setup/removal flow if adopting this bundle.
Do not erase other host configuration.

The bundled server uses the existing Screenpipe API key environment variables
or local Screenpipe CLI credential discovery. Keys belong in the host's secret
configuration, never in committed `mcp.json`, chat, screenshots, or command URLs.
If Node is unavailable, the app's existing Connections → AI apps setup is an
alternative integration using its bundled runtime. It exposes the standard MCP
tool set, not this read-only bundle. Do not enable both paths under the same
server name.

## Remote agents

Screenpipe must run on the computer being recorded, even if Hermes/OpenClaw runs
on a server. Point `SCREENPIPE_API_URL` at an explicitly configured private
connection to that recorder and provide its `SCREENPIPE_LOCAL_API_KEY` through
the host environment. Local key discovery is disabled for remote addresses.
Use a private tunnel or an explicitly configured synced-data deployment; do not
bind the recorder publicly. A synced server's health is not proof the source
computer is currently recording. App links open on the user's computer.

The bundle runs stdio beside the agent and queries the configured recorder API,
so it retains the full local read-only tool set for remote agents. The separate
HTTP MCP transport still has a smaller tool set (search and lifecycle status).

## Controls and team use

Pause or change capture in Screenpipe. Disable/remove this plugin through the
host to remove its access; the independent recorder keeps its current state.
Removing a connector does not retract excerpts already sent to a model provider.

For managed rollout and reviewed team workflow sharing, see
[Screenpipe Enterprise](https://screenpipe.com/enterprise?utm_source=agent&utm_medium=agent_plugin).
Agree on employee controls, storage, AI providers, retention and administrator
access before enrolling devices. This bundle does not enable sync, enroll a
device, configure billing, or grant organization access.

## Verification and distribution

`bun run test` covers the status state machine, real MCP dispatch from the built
archive, denied writes, and retained search behavior with synthetic data.
A packaged archive is not a Hermes catalog or ClawHub listing. Publish/catalog
review and live OS permission/reboot tests are separate release gates. This v1
uses MCP initialization instructions and a discoverable skill; it does not inject
raw screen history on every turn or install autonomous meeting-triggered jobs.
