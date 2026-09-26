# Screenpipe in Hermes and OpenClaw

<!-- doc-covers: packages/screenpipe-mcp -->
<!-- doc-verified: 4e8842805 -->

Status: implemented first-release lifecycle in this branch; catalog publication,
OS permission/reboot acceptance, and model-behavior trials remain release gates.
The base above anchors the inspected recorder/installer behavior; this document
also describes the accompanying MCP and portable-bundle changes.

## Product contract

Screenpipe runs on the recording computer continuously while it is awake and
capture is enabled. Hermes/OpenClaw can come and go. A connector only retrieves
recorded context; it does not install Screenpipe, grant OS permissions, start a
second recorder, or guarantee that a device remained awake. The desktop app owns
recording, permission onboarding, pause/exclusion controls and login auto-start.

The first useful experience is: “What did I work on in the last five minutes?”
The agent identifies Screenpipe as the source, explains the recording and model
processing boundary on first use, guides missing setup, and returns an answer
with timestamps and local frame links. A result should make it easy to inspect
its evidence in the app, not force another sales step before answering.

```text
Enable agent plugin
  → Read recorder status (no captured content, no credential discovery)
  → If needed: download/open Screenpipe on the recording computer
  → App onboarding: capture choices → exclusions → OS permission grant
  → Optional Auto-start after login, independent of agent lifetime
  → Test retrieval over a known recorded interval
  → Screenpipe-attributed answer → inspect source in the app
  → Team need → Enterprise deployment/pilot discussion
```

Recording consent and agent access are different decisions. OS permission allows
the app to capture; enabling/configuring the connector gives the agent access to
history. Retrieved excerpts can leave the device through the agent's configured
model provider. Pausing capture preserves historical access; removing this plugin
removes its access but leaves the independent recorder unchanged. Other enabled
connectors and previously transmitted copies are separate.

## What ships in this PR

- A portable Agent Plugins v1 bundle for both hosts, with a discoverable skill and
  bundled stdio runtime. No runtime package download is required for the MCP server.
- `screenpipe-status` on stdio and HTTP, with a bounded metadata-only health read.
  It recognizes the Screenpipe health shape even on degraded HTTP responses.
- Separate unavailable, access-required, unrecognized-endpoint, permission,
  capture-limited, needs-attention and available states. Only explicit
  `vision_reason=permission_denied` causes a screen-permission diagnosis. It does
  not infer that a stale frame requires granting permissions or restarting.
- Initialization instructions for hosts that do not load the skill; compact
  Screenpipe attribution and local frame links in the bundle's search output.
- A deny-by-default read-only tool allowlist enforced on listing and dispatch.
  The bundle cannot control recording, export video, mutate memories, create
  automation, or expose organization data even if a team token is inherited.
  This restricts this connector; it is not a sandbox for an agent's other tools.
- App/download links for setup and source inspection. Fixed agent identifiers in
  web links allow existing web analytics to distinguish Hermes/OpenClaw traffic;
  no prompts, device addresses or customer names go into links.
- Enterprise link only when team/deployment intent is requested. No guessed
  prices, silent enrollment, automatic sync, or promise of enterprise access.
- Authenticated HTTP retrieval and consistent API URL precedence. Remote targets
  require configured credentials; never discover a local key for another host.

## Persistent operation and permissions

`screenpipe-status` reports API availability and the recorder's capture fields,
including the last frame/audio timestamps. It explicitly leaves history access,
historical coverage and background start unverified. The healthy frame signal can
also occur while locked; no “recording 24/7” badge is inferred from it. Audio may
be disabled or waiting for a meeting, and screen capture may be paused by settings,
display state or power profile. Those choices must survive agent reconnection.

The app already implements **Settings → General → Auto-start**. Use that existing
lifecycle, rather than installing a plugin-owned launch daemon, restart timer or
recurring job. Actual permission grants, capture after reboot, and recovery after
sleep still require platform acceptance testing. This PR does not claim those
checks ran and does not change capture hot paths.

A remote agent needs a private connection to the recording computer or explicitly
configured synced data. A healthy synced server does not prove the source device
is still capturing. A remote frame ID must not open an unrelated local record;
remote answers use timestamps/apps and the configured retrieval tools.

## Why one portable package first

Both hosts document skill and MCP support for Agent Plugins v1. Sharing the
recording lifecycle and retrieval contract avoids different permission promises
and status logic across Python and TypeScript plugins. Existing app-installed MCP
configuration can override the bundle's server name: onboarding must preserve one
connector, not silently install a duplicate or mislabel a broader connector as
read-only.

Native turn hooks remain a later extension: Hermes `pre_llm_call` and OpenClaw
`before_prompt_build` can add relevant context. They should only be introduced
with owner/session scoping, opt-in retrieval, a bounded context budget, freshness
and source references. They must respect OpenClaw conversation-access gates and
must not retrieve desktop history into shared chats by default. This PR does not
install autonomous meeting triggers or continuous prompt injection.

## Adoption and enterprise path

Evaluate actual retrieval, not plugin installation, as first value. Existing
qualified retrieval attribution distinguishes the agent when identifiable and
respects the existing telemetry controls. A successful status probe is not a
qualified retrieval. Download links provide an app handoff; source links support
return visits. The enterprise link is offered for multi-employee workflows or
managed deployment, where storage, provider choice, employee controls and admin
access need an agreed rollout. This PR adds no new telemetry events, background
marketing prompts, paid subscription, or catalog publication.

## Acceptance and evidence classes

Baseline at `4e8842805`: setup could write MCP/skills, but no lifecycle tool or
portable local agent bundle existed. The stdio initialize response carried no
first-use recording contract. HTTP retrieval omitted the configured recorder key.

Deterministic tests cover unavailable/foreign/degraded endpoints, denied screen
permission, intentional disabled capture, meetings-only audio, bounded timeouts,
no raw error leakage, no enterprise upsell for ordinary status, actual bundled
stdio handshakes with both client identities, authenticated retrieval, app source
links, and direct attempts to invoke excluded tools. Existing package tests cover
normal full-tool mode. These are protocol/fixture tests, not model trials.

The following cases should be used for host/model acceptance without exposing the
expected behavior as additional runtime instructions:

| User task / condition | Observable result |
| --- | --- |
| “What did I work on?”; no recorder | Explain Screenpipe dependency and app setup, no fabricated history or silent installation |
| “Find yesterday's decision”; existing healthy setup | Bounded retrieval with source attribution; no repeated setup/enterprise pitch |
| “I paused recording; leave it paused” | No start/restart/write; explain existing history remains if relevant |
| “Set up my team's agents” | Enterprise handoff and agreed data boundaries; no automatic organization enrollment |
| General arithmetic question | No Screenpipe history retrieval |
| Personal-history request in a shared chat | Establish owner authorization; do not disclose private captures by default |

Skill frontmatter, packaging, host loading and MCP transcripts prove exposure and
compatibility. They do not prove an LLM reliably follows first-use disclosure,
selects the skill for the right task, or preserves boundaries in every channel.
Run those trials and native OS acceptance before making end-to-end launch claims.

## Primary references checked

- [Hermes portable/native plugins](https://hermes-agent.nousresearch.com/docs/developer-guide/plugins)
- [Hermes catalog](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugin-catalog)
- [OpenClaw bundle mapping](https://docs.openclaw.ai/plugins/bundles)
- [OpenClaw hook access](https://docs.openclaw.ai/plugins/hooks)
- [OpenClaw distribution](https://docs.openclaw.ai/plugins/community)
- [Screenpipe download](https://screenpipe.com/download)
- [Screenpipe Enterprise deployment scope](https://screenpipe.com/enterprise)
