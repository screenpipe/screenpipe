# Digital Clone

Build a private, connected wiki from the people, organizations, meetings and work context you encounter in Screenpipe. Keep it in Screenpipe memories and, optionally, your existing Obsidian vault.

## What it does

- Searches retained history with pagination and resumable cursors. An hourly run continues unfinished discovery after an interruption.
- Maintains people and organization profiles with first/last observations, encounter history, identity ambiguity and links to captured evidence.
- Separates a name observed on screen from a recorded meeting, verified employment or a personal relationship. Two contextual checks review new identities before publication to your wiki.
- Preserves older Digital Clone memories and existing notes. Generated content uses marked sections; manual edits are preserved or reported as conflicts.
- Creates daily navigation, meeting pages, a recent evidence packet, and People, Companies, Home and Coverage indexes.
- Updates Screenpipe memory records by stable identifiers and verifies writes by reading them back. Work remaining and API gaps stay visible.

## Requirements and privacy

Screenpipe must be running, with Bun available to its agent and an AI provider configured. No jq, Python, shell scripts, third-party Bun packages, global Screenpipe CLI, Obsidian plugin, companion Pipe or remote runtime download is required.

The code uses Bun and built-in Node-compatible APIs on macOS, Windows and Linux. Home and configuration directories come from the operating system; the default timezone is the device timezone. Native execution was tested on macOS and Windows. Linux configuration/path rules were tested; native Linux execution has not yet been verified.

The wiki, source ledger, backups and optional Obsidian export remain local. Inference is not necessarily local: with the `screenpipe-cloud` preset, selected screen content and relevant excerpts from local Claude Code, Codex, and Hermes chat logs are sent to Screenpipe's cloud model. Other configured presets send that selected context to the provider named in the preset; review its data-sharing settings before enabling the Pipe. The model defaults to `auto`; set `discovery_model` to a model supported by your Screenpipe setup if needed.

Credentials, contact addresses, sensitive personal context and assistant-generated screens are excluded from new profile evidence. No outbound messages, CRM updates, global agent-instruction changes, git pushes or publishing are performed. The Pipe never reads Screenpipe's internal database files.

## Setup

1. Install the Pipe. It installs disabled; review its permissions and AI settings before enabling hourly maintenance.
2. Run it once. It extracts its embedded, hash-checked runtime and creates `wiki/settings.json` in the Pipe directory. The local wiki works without Obsidian.
3. For Obsidian, select an **existing vault** and set its absolute path as `obsidian_vault`. `obsidian_namespace` defaults to `Digital Clone`. Setup lists vaults registered by Obsidian on your operating system, but never chooses among them or creates a replacement vault.
4. If profiles already exist, optionally set `legacy_people_dirs` and `legacy_company_dirs` to their paths **relative to the chosen vault**. For example, `["People"]` and `["Companies"]`. Existing canonical notes are reused, with an original backup before the first managed addition.
5. Open the wiki's `index.md`, or `Digital Clone/Home` in the chosen vault. Large histories take multiple hourly runs; Coverage distinguishes unfinished discovery, memory projection and inaccessible records.

Settings are preserved across runs and upgrades. A selected vault path is user configuration; none is embedded in the store package. If the configured vault is unavailable or changes unexpectedly, export stops with an error while independent phases continue. Do not copy another person's settings or state files.

## Configuration

| Setting | Default | Purpose |
|---|---|---|
| `obsidian_vault` | unset | Existing vault; optional. |
| `obsidian_namespace` | `Digital Clone` | Relative folder for new notes and indexes. |
| `legacy_people_dirs` / `legacy_company_dirs` | empty arrays | Relative folders containing canonical profiles to preserve. |
| `model` | `auto` | Model selected through Screenpipe. |
| `discovery_model` | inherits `model` | Optional identity-classification model override. |
| `scheduled_discovery_batches` | `6` | Bounded progress per run, from 1 to 30. More batches consume more AI usage. |
| `history_start` | Unix epoch | Earliest retained history to consider; empty years are skipped using the first API result. |
| `history_end` | first setup time | Stable historical scan cutoff; live ingestion continues afterward. |
| `timezone` | device timezone | Calendar dates for daily notes. |
| `memory_projection` | `true` | Mirror compiled pages to local Screenpipe memories. |

To limit historical scope, configure it before the first scan. Existing ingestion cursors are intentionally not reset when settings change. An intentional rescan requires a separate migration/backup of ingestion state, rather than silently losing progress.

## Maintenance and recovery

The Pipe runs its self-contained runtime with Bun. It does not install dependencies. Its launcher returns a run ID; completion is recorded under `wiki/runs/<run-id>/result.json`. A process that starts but never produces its receipt is interrupted, not successful. Another hourly run resumes saved work.

Historical ingestion, candidate discovery, identity review and memory projection are separate queues. Candidate phrases include interface text and other noise: the pending count is not a count of missing people. Quality review may reject candidates. API count discrepancies and unreadable rows are recorded rather than silently treated as complete coverage.

Legacy memories are paginated and imported once. Older claims are labeled unverified; they never become fresh primary evidence. Originals remain in Screenpipe, with local scrubbed recovery snapshots before a compiled update. Duplicate legacy identities that cannot be matched safely remain unresolved; no automatic destructive merge occurs.

Backups and export receipts live under `wiki/obsidian-export`. Only newly created, unedited exporter-owned profiles may be moved into recoverable quarantine after rejection. Existing or edited notes are preserved. A missing ownership manifest blocks replacement of a managed section. Preserve backups and manifests during upgrades.

If there are explicit identity corrections, retain the correction and pause changes to the affected profile until its registry identity is reconciled. Seeing two names together can create an evidence-navigation link; it does not establish employment, a deal, a commitment or a relationship.

## Release changes

This replaces the old 20-record sampling and 24-hour meeting-backfill limit with resumable history collection; adds organizations, reviewed identity matching, evidence navigation and optional managed Obsidian export; and preserves prior Digital Clone memories. Store version numbering is separate from any locally customized Pipe version.

The runtime is embedded as ordinary JavaScript compiled by Bun to fit the store's 64 KiB limit. It is not encoded, encrypted or downloaded at runtime. The bootstrap verifies the embedded bytes before execution; the store reviews the complete prompt by hash. Unbundled TypeScript, tests and the Bun build command are included in the release review artifact.
