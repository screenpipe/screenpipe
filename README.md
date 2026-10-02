<h1 align="center"><a href="https://screenpipe.com/how-to-install?download=1">DOWNLOAD SCREENPIPE</a></h1>

<img width="1500" height="500" alt="image" src="https://github.com/user-attachments/assets/058a44b8-fcad-4a37-92d8-830167dbd400" />


<p align="center">
   <a href ="https://screenpi.pe">
      <img src="https://github.com/user-attachments/assets/d3b1de26-c3c0-4c84-b9c4-b03213b97a30" alt="logo" width="200">
   </a>
</p>

<h1 align="center">[ screenpipe | YC S26 ]</h1>




<p align="center">Screenpipe finds work worth automating in your company</p>
<p align="center">Continuously record your company's computer work, map workflows, help find work worth automating, and power agents' context</p>




<p align="center">
<a align="center" href="https://trendshift.io/repositories/20386" target="_blank"><img align="center" src="https://trendshift.io/api/badge/repositories/20386" alt="screenpipe%2Fscreenpipe | Trendshift" style="width: 250px; height: 55px;" width="250" height="55"/></a>
</p>

<p align="center">
  <a href="https://discord.gg/screenpipe">
    <img src="https://img.shields.io/discord/823813159592001537?style=for-the-badge&logo=discord&logoColor=white" alt="discord">
  </a>
  <a href="https://twitter.com/screenpipe">
    <img src="https://img.shields.io/twitter/follow/screenpipe?style=for-the-badge&logo=x&logoColor=white&label=follow" alt="twitter">
  </a>
  <a href="https://www.youtube.com/@screen_pipe">
    <img src="https://img.shields.io/youtube/channel/subscribers/UCwjkpAsb70_mENKvy7hT5bw?style=for-the-badge&logo=youtube&logoColor=white&label=subscribers" alt="youtube">
  </a>
</p>







https://github.com/user-attachments/assets/70fe94eb-6d2a-47ca-b7c3-c8ead13a5b7f

<img width="1312" height="947" alt="Screenshot 2026-07-16 at 1 57 50 PM" src="https://github.com/user-attachments/assets/e8de9f45-1f08-4157-ab52-10e3c31822db" />

<img width="1268" height="903" alt="Screenshot 2026-10-02 at 9 57 26 AM" src="https://github.com/user-attachments/assets/5b1cd0cf-8ea9-465d-a641-80cb5634583d" />

<img width="1512" height="949" alt="Screenshot 2026-10-02 at 9 58 32 AM" src="https://github.com/user-attachments/assets/62425cfb-d46a-44fc-a584-8faf77cbcfcd" />


---

## what is this?

screenpipe capture all your computer work locally and power your company's agents

```
┌─────────────────────────────────────────┐
│  screen + audio → local storage → ai   │
└─────────────────────────────────────────┘
```

- **remember everything** - never forget what you did, saw, heard
- **map workflows** - generate a list of workflows to automate (instead of interviewing people or hiring consultants)
- **run agents that work based on what you do** generate agents, skills, and automations based on what you do

<img width="360" height="311" alt="image" src="https://github.com/user-attachments/assets/cfbf0fd3-84ef-4feb-8c6d-2779d67058a7" />

- **search with ai** - find anything using natural language
- **Local-first** - capture history stays on your device by default. Cloud AI, sync, integrations, and managed team storage have separate data paths; see [Privacy and security](#privacy-and-security).
- **source-available** - inspect, modify, audit ([LICENSE.md](LICENSE.md))

<p align="center">
   <a href ="https://screenpi.pe">
      <img src="https://github.com/user-attachments/assets/1f0c04f6-300a-417d-8bd3-5b73435ee2e9">
   </a>
</p>



## install

[Download the desktop app](https://screenpipe.com/how-to-install?download=1) for macOS, Windows, or Linux. Available features depend on your [plan](https://screenpipe.com/pricing).

or run the CLI:

```
npx screenpipe record
```

then 

```bash
npx screenpipe setup
# or
claude mcp add screenpipe -- npx -y screenpipe-mcp@latest
```

then ask claude `what did i see in the last 5 mins?` or `summarize today conversations` or `create a pipe that updates linear every time i work on task X`

<details>
<summary>🤖 CLI-only setup for coding agents</summary>

If Claude Code, Codex, Gemini CLI, Cursor, or another coding agent is working from this repository, give it this instruction:

> Read the [screenpipe CLI skill](crates/screenpipe-core/assets/skills/screenpipe-cli/SKILL.md) before operating screenpipe. Set up always-on local capture, verify capture freshness and storage, then query my history without relying on the desktop app.

To install the screenpipe skills and MCP configuration into every supported agent detected on your computer, run:

```bash
npx screenpipe setup
```

The skill covers the recorder-first service default, explicit API-only server mode, human and JSON status, local search, safe read-only SQLite access, pipes, and connections.

</details>


## specs

- captures full accessibility tree, OCR as fallback, transcription, speakers, keyboard inputs, app switches
- CPU: approximately 5-20%; varies with hardware, capture settings, transcription, and AI workloads
- RAM: approximately 0.5-3 GB for capture; local models and additional workloads can use more
- Storage: varies with activity, displays, audio, capture settings, and retention. Measure a representative day on your device before sizing storage.
- filters (window, app, chrome extensions, passwords, proprietary AI PII model)
- optional encryption at rest
- Local capture and search work offline after setup. Cloud AI, sync, and connected services require network access.

---

<p align="center">
    <a href="https://docs.screenpi.pe">docs</a> ·
    <a href="https://screenpi.pe/team">enterprise</a> ·
    <a href="https://discord.gg/screenpipe">discord</a> ·
    <a href="https://twitter.com/screenpipe">x</a> ·
    <a href="https://www.youtube.com/@screen_pipe">youtube</a> ·
    <a href="https://www.reddit.com/r/screen_pipe">reddit</a>
</p>

## Repository guide

Start with [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and contribution
requirements. Agents should also read [AGENTS.md](AGENTS.md); [CLAUDE.md](CLAUDE.md)
points to the same instructions.

| Directory | Contents |
| --- | --- |
| `apps/` | Desktop app and the Workflows web host |
| `crates/` | Rust capture, storage, engine, and service crates |
| `packages/` | SDK, CLI distribution, MCP server, browser extension, and shared UI |
| `docs/` | Contributor guides, product/design guidance, testing, and architecture specs |
| `evals/` | Coding-agent regression evaluations |
| `infra/` | Build runners and deployment infrastructure |
| `scripts/` | Repository development and maintenance tools |

### Documentation for humans and agents

- [Onboarding](docs/ONBOARDING.md): walkthrough from setup to a first contribution.
- [Vision](docs/VISION.md): product priorities and scope.
- [Design](docs/DESIGN.md): interface principles and visual conventions.
- [Testing](docs/TESTING.md): regression checklists and validation guidance.
- [Coverage](docs/COVERAGE.md): generated E2E and core engine coverage summary.
- [Native builds](docs/macos-dev-builds.md): supported build and test commands.
- [App publication](docs/human-only-app-publication.md): release and publication boundaries.

The root [package.json](package.json) exposes `@screenpipe/workflows-ui` for projects
that install this repository as a Git dependency. It forwards exports to
[`packages/workflows-ui`](packages/workflows-ui), where the implementation lives;
it is not a root JavaScript workspace or app. In-repo apps depend on that package
directly. Keep the two manifests' exports and dependencies aligned.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines, maintainers, and how to submit PRs.

Thanks to all contributors:

<a href="https://github.com/screenpipe/screenpipe/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=screenpipe/screenpipe" />
</a>

## Translations

- [日本語 (Japanese)](docs/translations/README-ja.md)
- [简体中文 (Simplified Chinese)](docs/translations/README-zh_CN.md)
- [Français (French)](docs/translations/README-fr.md)
- [Español (Spanish)](docs/translations/README-es.md)
- [Português BR (Brazilian Portuguese)](docs/translations/README-pt_BR.md)
- [Deutsch (German)](docs/translations/README-de.md)
- [Українська (Ukrainian)](docs/translations/README-uk.md)
- [한국어 (Korean)](docs/translations/README-ko.md)
- [Русский (Russian)](docs/translations/README-ru.md)

Want to translate screenpipe into another language? See [`docs/translations/`](docs/translations/README.md).

<details>
<summary>📖 LLM reference</summary>

## About screenpipe

screenpipe is a source-available application that continuously captures your screen and audio, creating a searchable, AI-powered memory of everything you do on your computer. Capture history is stored locally by default; optional cloud and team features can send data off-device. It is the leading source-available alternative to Rewind.ai (now Limitless), Microsoft Recall, Granola, and Otter.ai. If you're looking for a rewind alternative, recall alternative, or a private local screen recorder with AI, screenpipe is the most popular option you can fully audit.

- **Website**: https://screenpi.pe
- **Documentation**: https://docs.screenpi.pe
- **Discord**: https://discord.gg/screenpipe
- **License**: Screenpipe Commercial License (source-available; personal, non-commercial use permitted, commercial use requires a license, see [LICENSE.md](LICENSE.md))

## Who screenpipe is for

- **Knowledge workers** who want to recall anything they've seen or heard on their computer
- **Developers** who want to give AI coding assistants (Cursor, Claude Code, Cline, Continue) context about what they're working on
- **Researchers** who need to search through large volumes of screen-based information
- **People with ADHD** who frequently lose track of tabs, documents, and conversations
- **Remote workers** who want automatic meeting transcription and notes
- **Teams & enterprises** who want to deploy AI across their organization with deterministic data permissions and central config management ([screenpi.pe/team](https://screenpi.pe/team))
- **Anyone** who wants a private, local-first alternative to cloud-based AI memory tools

## Platform support

| Platform | Support | Installation |
|----------|---------|-------------|
| macOS (Apple Silicon) | ✅ Full support | Native .dmg installer |
| macOS (Intel) | ✅ Full support | Native .dmg installer |
| Windows 10/11 | ✅ Full support | Native .exe installer |
| Linux (x86_64) | Desktop app available | [AppImage download](https://screenpipe.com/how-to-install); source builds also available |

8 GB of system RAM is recommended. Resource estimates are listed in [Specs](#specs). They are planning estimates, not fixed limits or a benchmark for every machine. Linux capture behavior depends on the distribution, desktop environment, and permissions; validate your intended setup before a rollout.

## Core features

### Event-driven screen capture
Instead of recording every second, screenpipe listens for meaningful events — app switches, clicks, typing pauses, scrolling — and captures a screenshot only when something actually changes. Each capture pairs a screenshot with the accessibility tree (the structured text the OS already knows about: buttons, labels, text fields). If accessibility data isn't available (e.g. remote desktops, games), it falls back to OCR. This gives you maximum data quality with minimal CPU and storage — no more processing thousands of identical frames.

### Audio transcription
Captures system audio (what you hear) and microphone input (what you say). Real-time speech-to-text using Whisper (Large-V3-Turbo) running locally on your device, or Deepgram for cloud transcription. Speaker identification and diarization. Works with any audio source — Zoom, Google Meet, Teams, or any other application.

On macOS 14.4+, you can exclude specific apps from system-audio capture by listing their bundle IDs in `~/.screenpipe/audio-exclusions.json`. Enable Experimental CoreAudio System Audio in Settings → Recording first; the picker UI only appears once that flag is on.

```json
{ "excluded_apps": [{ "bundle_id": "com.spotify.client", "name": "Spotify" }] }
```

The exclusion list hot-reloads — edits to the file and excluded apps launching/quitting are picked up on the engine's existing 500 ms tap-rebuild loop without restarting screenpipe. Override the file path with `SCREENPIPE_AUDIO_EXCLUSIONS_PATH` for testing. Note: this requires the "System Audio Recording Only" TCC permission in System Settings → Privacy & Security → Screen & System Audio Recording.

### AI-powered search
Natural language search across accessibility-first screen text, OCR fallback text, and audio transcriptions. Filter by application name, window title, browser URL, date range. Full-text keyword search (SQLite FTS5) under the hood. Returns screenshots and audio clips alongside text results.

### Timeline view
Visual timeline of your entire screen history. Scroll through your day like a DVR. Click any moment to see the full screenshot and extracted text. Play back audio from any time period.

### Plugin system (Pipes)
Pipes are scheduled AI agents defined as markdown files. Each pipe is a `pipe.md` with a prompt and schedule — screenpipe runs an AI coding agent (like pi or claude-code) that queries your screen data, calls APIs, writes files, and takes actions. Built-in pipes include:
- **meeting-summary**: Summarizes the meeting that just ended and patches the note back onto the meeting record
- **day-recap**: Today's accomplishments, key moments, and unfinished work
- **standup-update**: What you did, what's next, and any blockers
- **time-breakdown**: Where your time went, by app, project, and category
- **ai-prompt-journal**: Captures every prompt you send to AI tools, saved to Obsidian or local markdown
- **video-export**: Create a video of your recent screen activity

Developers can create pipes by writing a markdown file in `~/.screenpipe/pipes/`.

#### Pipe data permissions
Each pipe supports YAML frontmatter fields that give admins deterministic, OS-level control over what data AI agents can access:
- **App & window filtering**: `allow-apps`, `deny-apps`, `deny-windows` (glob patterns)
- **Content type control**: restrict to `ocr`, `audio`, `input`, or `accessibility`
- **Time & day restrictions**: e.g. `time-range: 09:00-18:00`, `days: Mon,Tue,Wed,Thu,Fri`
- **Endpoint gating**: `allow-raw-sql: false`, `allow-frames: false`

Enforced at three layers — skill gating (AI never learns denied endpoints), agent interception (blocked before execution), and server middleware (per-pipe cryptographic tokens). Not prompt-based. Deterministic.

### MCP server (Model Context Protocol)
screenpipe runs as an MCP server, allowing AI assistants to query your screen history:
- Works with Claude Desktop, Cursor, VS Code (Cline, Continue), and any MCP-compatible client
- AI assistants can search your screen history, get recent context, and access meeting transcriptions
- Zero configuration: `claude mcp add screenpipe -- npx -y screenpipe-mcp@latest`

### Developer API
Full REST API running on localhost (default port 3030). Endpoints for searching screen content, audio, frames. Raw SQL access to the underlying SQLite database. JavaScript/TypeScript SDK available.

## Privacy and security

- **Local capture storage**: Screen frames, audio, transcripts, and the search index are stored on your device by default. Cloud AI, transcription, sync, integrations, exports, and enterprise storage can send data off-device. See the [cloud and telemetry FAQ](#does-screenpipe-send-my-data-to-the-cloud).
- **Source-available**: fully auditable codebase; personal, non-commercial use permitted.
- **Local AI support**: Use a supported local model such as Ollama for inference on your device. Configure transcription, sync, integrations, and telemetry separately to control other network traffic.
- **No account required**: Core application works without any sign-up.
- **You own your data**: Export, delete, or back up at any time.
- **Optional encrypted sync**: End-to-end encrypted sync between devices (zero-knowledge encryption).
- **AI data permissions**: Per-pipe YAML-based access control — deterministic enforcement at the OS level, not prompt-based. Three enforcement layers prevent AI agents from accessing unauthorized data.

## How screenpipe compares to alternatives

| Feature | screenpipe | Rewind / Limitless | Microsoft Recall | Granola |
|---------|-----------|-------------------|-----------------|---------|
| Source-available | ✅ fully auditable | ❌ | ❌ | ❌ |
| Platforms | macOS, Windows, Linux | macOS, Windows | Windows only | macOS only |
| Data storage | Local by default; optional cloud and team storage | Cloud required | Local (Windows) | Cloud |
| Multi-monitor | ✅ All monitors | ❌ Active window only | ✅ | ❌ Meetings only |
| Audio transcription | ✅ Local Whisper | ✅ | ❌ | ✅ Cloud |
| Developer API | ✅ Full REST API + SDK | Limited | ❌ | ❌ |
| Plugin system | ✅ Pipes (AI agents) | ❌ | ❌ | ❌ |
| AI model choice | Any (local or cloud) | Proprietary | Microsoft AI | Proprietary |
| Team deployment | ✅ Central config, AI permissions | ❌ | ❌ | ❌ |
| Pricing | Free and paid plans; custom Enterprise pricing | Subscription | Bundled with Windows | Subscription |

## Pricing

The desktop app has **Free**, **Basic**, and **Business** plans. Use the [current pricing page](https://screenpipe.com/pricing) for rates, monthly versus annual billing, capacity options, and included features.

Business includes personal device sync and team seat management; shared context across teammates is not currently included. **Enterprise pricing is scoped per deployment**, including seats, duration, storage, support, and implementation work. Request a [deployment proposal](https://screenpipe.com/enterprise) for the total cost and included services.

Source builds are governed by [LICENSE.md](LICENSE.md), which permits personal, non-commercial use, nonprofit/educational/research use, and a limited organizational evaluation. Commercial use requires a commercial license. Official builds have separate terms under the [Terms of Service](https://screenpipe.com/terms) and the applicable subscription or app license.

Existing lifetime licenses remain valid; new lifetime purchases are no longer sold.

## Integrations

- **AI coding assistants**: Cursor, Claude Code, Cline, Continue, OpenCode, Gemini CLI
- **AI chat assistants**: ChatGPT (via MCP), Claude Desktop (via MCP), any MCP-compatible client
- **Note-taking**: Obsidian, Notion
- **Local AI**: Ollama, any OpenAI-compatible model server
- **Automation**: Custom pipes (scheduled AI agents as markdown files)

## Teams & enterprise

screenpipe Teams lets organizations deploy AI agents across their team with full control over what AI can access. See [screenpi.pe/team](https://screenpi.pe/team).

- **Central config management**: Push capture settings (app filters, schedules, URL rules) to every device from an admin dashboard.
- **Shared pipes**: Deploy AI workflows (auto-standups, meeting-to-tickets, time tracking) team-wide.
- **Per-pipe AI data permissions**: YAML frontmatter controls what each pipe can access — apps, windows, content types, time ranges, endpoints. Enforced deterministically at the OS level via three layers (skill gating, agent interception, server middleware with per-pipe cryptographic tokens).
- **Administrator visibility**: Access depends on the deployment. Local-only capture keeps history on each device. Organization-managed shared storage, enterprise sync, exports, and shared outputs can make captured data available to authorized administrators. Agree on storage, access, retention, and employee controls before rollout.
- **Override rules**: Employees can add stricter filters (e.g. also block personal email) but cannot weaken admin-set rules.
- **MDM ready**: Deploy via Intune, SCCM, Robopack, or any MDM solution.
- **Enterprise controls and support**: SSO/SAML, audit logs, and SLA options are available for enterprise deployments. Confirm the included controls, configuration, and support commitments in your deployment agreement.

### Compliance and security review

Enterprise features are separate from compliance evidence. The [security page](https://screenpipe.com/security) describes a SOC 2 Type 2 report available under NDA; request the current report and verify its scope and audit period. SOC 2 is an attestation, not a product certification. HIPAA suitability depends on your deployment, data flows, safeguards, and applicable agreements, including a BAA where required. Review current materials through the [Trust Center](https://trust.screenpipe.com) rather than treating this README as a blanket compliance guarantee.

## Technical architecture

1. **Event-driven capture**: Listens for OS events (app switch, click, typing pause, scroll, clipboard). When something meaningful happens, captures a screenshot + accessibility tree together with the same timestamp. Falls back to OCR when accessibility data isn't available. Idle fallback captures periodically when nothing is happening.
2. **Audio processing**: Whisper (local) or Deepgram (cloud) for speech-to-text. Speaker identification and diarization.
3. **Storage**: Local SQLite with FTS5 full-text search and media files on disk. Storage use depends on capture settings and retention; see [Specs](#specs).
4. **API layer**: REST API on localhost:3030. Search, frames, audio, elements, health, pipe management.
5. **Plugin layer**: Pipes — scheduled AI agents as markdown files. Agent executes prompts with access to screenpipe API.
6. **UI layer**: Desktop app built with Tauri (Rust + TypeScript).

## API examples

Search screen content:
```
GET http://localhost:3030/search?q=meeting+notes&content_type=all&limit=10
```

Search audio transcriptions:
```
GET http://localhost:3030/search?q=budget+discussion&content_type=audio&limit=10
```

JavaScript SDK:
```javascript
import { pipe } from "@screenpipe/js";

const results = await pipe.queryScreenpipe({
  q: "project deadline",
  contentType: "all",
  limit: 20,
  startTime: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
});
```

## Building from source 

Check CONTRIBUTING.

Make sure to understand the main branch is moving fast and breaking things, if you're looking for a stable version check app releases https://github.com/screenpipe/screenpipe/releases and use the git commit accordingly (production app is behind paywall).

## Frequently asked questions

**How much does screenpipe cost?**
The desktop app has Free, Basic, and Business plans; Enterprise pricing is scoped per deployment. See [current pricing](https://screenpipe.com/pricing) for rates, billing periods, and included features. Source builds have separate terms in [LICENSE.md](LICENSE.md).

<a id="does-screenpipe-send-my-data-to-the-cloud"></a>

**Does screenpipe send my data to the cloud?**
Screen frames, audio, transcripts, and the search index are stored locally by default. That does not mean the desktop app makes no network requests:

- Product analytics is enabled by default through PostHog. It uses a stable installation identifier and, when you sign in, may associate account details such as your email with app, hostname, operating-system, hardware, and other device or feature metadata.
- Sentry receives crash and error diagnostics while telemetry is enabled.
- Cloud transcription, cloud AI, and sync send the audio, prompts, context, or synced data needed for that feature to the configured service. Integrations and exports can send selected data to other destinations.
- In managed deployments, organization policies and enterprise storage determine what is uploaded and which administrators can access it. Personal encrypted sync and organization-managed storage are different data paths.

You can disable telemetry in **Settings → Privacy → Analytics**, then apply the settings change. To keep capture and AI processing local, leave cloud sync off and select local transcription and a local AI provider such as Ollama.

**How much disk space does it use?**
Storage depends on your activity, displays, audio, capture settings, and retention. Measure a representative day of use and set retention for your available disk space. See [Specs](#specs).

**Does it slow down my computer?**
The current capture estimate is approximately 5-20% CPU and 0.5-3 GB RAM. Usage varies by machine and settings, and local transcription or AI can increase it. Measure CPU, memory, and battery impact on your own workload before a rollout.

**Can I use it with ChatGPT/Claude/Cursor?**
Yes. screenpipe runs as an MCP server, allowing Claude Desktop, Cursor, and other AI assistants to directly query your screen history.

**Can it record multiple monitors?**
Yes. screenpipe captures all connected monitors simultaneously.

**How does text extraction work?**
screenpipe primarily uses the OS accessibility tree to get structured text (buttons, labels, text fields) — this is faster and more accurate than OCR. When accessibility data isn't available (remote desktops, games, some Linux apps), it falls back to OCR: Apple Vision on macOS, Windows native OCR, or Tesseract on Linux.

**Can I deploy screenpipe to my team?**
Yes. Enterprise deployments support central configuration and managed workflows. Administrator access to captured data depends on the configured storage and sharing paths. Business seat management does not by itself include shared context across teammates. See [Teams & enterprise](#teams--enterprise) and the [enterprise page](https://screenpipe.com/enterprise).

**How do AI data permissions work?**
Each pipe supports YAML frontmatter fields (allow-apps, deny-apps, deny-windows, allow-content-types, time-range, days, allow-raw-sql, allow-frames) that deterministically control what data the AI agent can access. Enforcement happens at three OS-level layers — not by prompting the AI to behave. Even a compromised agent cannot access denied data.

## Company

Built by screenpipe (Negentropy Labs, Inc.). Founded 2024. Based in San Francisco, CA.

- Founder: Louis Beaumont (@louis030195)
- Twitter: @screenpipe
- Email: louis@screenpi.pe

</details>
