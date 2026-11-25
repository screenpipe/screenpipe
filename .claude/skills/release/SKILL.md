---
name: release
description: "Release the screenpipe monorepo. Bumps versions, triggers GitHub Actions for app, CLI, MCP, and JS packages."
allowed-tools: Bash, Read, Edit, Grep, Write
---

# Screenpipe Monorepo Release Skill

Automate releasing all components of the screenpipe monorepo.

## Components & Versions

| Component | Version File | Current Pattern | Workflow |
|-----------|--------------|-----------------|----------|
| Desktop App | `apps/screenpipe-app-tauri/src-tauri/Cargo.toml` | `version = "X.Y.Z"` | `release-app.yml` |
| CLI/Server | `Cargo.toml` (workspace.package) | `version = "0.2.X"` | `release-cli.yml` |
| MCP | `packages/screenpipe-mcp/package.json` **and** `server.json` (2 fields) | `"version": "X.Y.Z"` | `release-mcp.yml` |

> **MCP has no commit-prefix trigger** — unlike the app, `release-mcp.yml` fires
> only on an `mcp-v*` tag or `workflow_dispatch`, and it refuses to run when
> `package.json`'s version is already on npm (npm cannot overwrite a published
> version, so the run would publish nothing). Follow
> `packages/screenpipe-mcp/RELEASE.md` — it has the exact commands and the
> post-publish checks.

## When to Release What

**Always release CLI** when there are changes under `crates/`. Every shipped Rust
crate lives there, and the `screenpipe` CLI binary is built from
`crates/screenpipe-engine` (`[[bin]] name = "screenpipe"`), so it links whatever
its dependency graph pulls in. That includes `screenpipe-a11y` and
`screenpipe-semantic`, which are easy to overlook because they are not named
"core" or "server".

**App-only release** is fine when changes are only in:
- `apps/screenpipe-app-tauri/` (UI/frontend changes)
- If the release includes new or changed `#[tauri::command]` handlers: from `apps/screenpipe-app-tauri/`, run `bun run bindings:generate` and verify `bun run bindings:check` before tagging

To check what changed since last CLI release:
```bash
# Find last CLI release commit
git log --oneline --all | grep -E "CLI to v" | head -1

# Check if core code changed since then
git diff <COMMIT>..HEAD --stat -- crates/
```

> **An empty diff here is only trustworthy if the pathspec exists.** `git diff -- <path>`
> prints nothing and exits 0 for a path that is not in the tree, so a stale pathspec
> reads exactly like "nothing changed" and you ship an app-only release that drops
> real engine fixes. This skill previously listed top-level `screenpipe-core/`,
> `screenpipe-vision/`, `screenpipe-server/` and friends, all of which had moved
> under `crates/`, so the check silently passed on every release. Confirm the path
> resolves before believing the result:
> ```bash
> ls -d crates/ || echo "PATHSPEC STALE, fix this skill before trusting the diff"
> ```

## Release Workflow

### 1. Check Current Versions
```bash
echo "=== App ===" && grep '^version' apps/screenpipe-app-tauri/src-tauri/Cargo.toml | head -1
echo "=== CLI ===" && grep '^version' Cargo.toml | head -1
echo "=== MCP ===" && grep '"version"' packages/screenpipe-mcp/package.json | head -1
```

### 2. Bump Version

- **App:** edit `apps/screenpipe-app-tauri/src-tauri/Cargo.toml` and bump the `version = "X.Y.Z"` line at the top of `[package]`.
- **CLI:** edit root `Cargo.toml` and bump `version` under `[workspace.package]`.

### 3. Regenerate ALL Cargo.lock files (MANDATORY after any bump)

```bash
./scripts/regenerate-locks.sh
```

The repo has several independent cargo workspaces (root, app, SDK, SDK examples),
each with a tracked Cargo.lock recording the shared crates' versions. Bumping only
Cargo.toml leaves the other locks stale and breaks `cargo test --locked` on main
(happened with the v0.4.29 CLI bump — sdk.yml went red until the locks were fixed).
Commit the regenerated locks together with the bump. `style.yml` runs
`./scripts/regenerate-locks.sh --check` on every push and fails if any lock is stale.

Before dispatching a desktop release, compile the actual app binary through the
guarded native build queue. A raw `cargo check` from a clean worktree is not a
valid substitute: the Tauri build script requires sidecars such as
`bun-aarch64-apple-darwin`, which `scripts/pre_build.js` prepares. Install the
frontend dependencies first so the guarded build can run its prebuild and
frontend/type checks before compiling the app:

```bash
cd apps/screenpipe-app-tauri
bun install --frozen-lockfile
bun run build:tauri:dev
```

The build may regenerate Tauri schemas. Restore build-only schema drift before
staging, then require the release commit to contain only the intended version
files.

### 4. Commit, Push, and Dispatch Exact SHA
```bash
git add -A && git commit -m "Bump app to vX.Y.Z" && git pull --rebase && git push

BUMP_SHA=$(git rev-parse HEAD)
gh workflow run release-app.yml \
  --ref main \
  -f commit_hash="$BUMP_SHA" \
  -f version="X.Y.Z" \
  -f needs_testing=false \
  -f force_github_runners=false
```

`release-app.yml` is currently `workflow_dispatch` only. A bump push does not start it. Dispatch it once with the exact pushed commit and version inputs; its workflow builds, signs, notarizes, and uploads immutable versioned artifacts. It does not publish updater pointers or create the public GitHub release.

Before dispatching, verify the remote `main` SHA still matches `BUMP_SHA`. After dispatching, read the run back and require its `headSha` to match. Never dispatch a second app run for the same version unless the first run failed and the retry is intentional.

The same dispatch starts Enterprise packaging after the consumer matrix succeeds. For Enterprise-only recovery, dispatch `release-app.yml` with the original commit, version, and `-f enterprise_only=true -f native_run_id=<original-run-id>`. Verify the Enterprise jobs and the `Enterprise artifacts` status on the pinned commit.

### 5. Monitor Build Status
```bash
# Get latest run ID
gh run list --workflow=release-app.yml --limit=1

# Check status
gh run view <RUN_ID> --json status,conclusion,jobs --jq '{status: .status, conclusion: .conclusion, jobs: [.jobs[] | {name: (.name | split(",")[0]), status: .status, conclusion: .conclusion}]}'
```

### 6. Test the Draft Release
- Download from https://screenpi.pe (requires purchase token)
- Test on macOS and Windows
- Verify updater artifacts exist (.tar.gz, .sig files)

### 7. Hand Off Public Publication
After testing and artifact verification, stop at the authenticated releases control in the website admin UI. Public updater pointers, Enterprise publication state, GitHub tags/releases, and subscriber notification are human-only actions. AI agents must not operate the admin UI, call its publication endpoint, approve the protected environment, or attempt publication with a commit-message prefix.

## Quick Release (App Only)

```bash
# 1. Bump version in apps/screenpipe-app-tauri/src-tauri/Cargo.toml
# 2. Regenerate every tracked Cargo.lock (skipping this breaks `cargo test --locked` in CI)
./scripts/regenerate-locks.sh

# 3. Commit and push the version bump
git add -A && git commit -m "Bump app to vX.Y.Z" && git push

# 4. Dispatch the exact pushed commit once, then monitor
BUMP_SHA=$(git rev-parse HEAD)
gh workflow run release-app.yml --ref main \
  -f commit_hash="$BUMP_SHA" -f version="X.Y.Z" \
  -f needs_testing=false -f force_github_runners=false
gh run list --workflow=release-app.yml --limit=1
```

## Build Status Format

```
Build <RUN_ID>:
| Platform | Status |
|----------|--------|
| macOS aarch64 | ✅ success / 🔄 in_progress / ❌ failure |
| macOS x86_64 | ✅ success / 🔄 in_progress / ❌ failure |
| Windows | ✅ success / 🔄 in_progress / ❌ failure |
```

## Troubleshooting

### Build Failed
```bash
gh run view <RUN_ID> --log-failed 2>&1 | tail -100
```

### CI red: "cannot update the lock file ... because --locked was passed"
A version bump was pushed without regenerating every tracked Cargo.lock.
```bash
./scripts/regenerate-locks.sh && git add -A && git commit -m "fix: regenerate stale Cargo.lock files"
```

### Cancel Running Build
```bash
gh run cancel <RUN_ID>
```

### Re-run Failed Jobs
```bash
gh run rerun <RUN_ID> --failed
```

### Missing Updater Artifacts (.tar.gz, .sig)
The CI copies `tauri.prod.conf.json` to `tauri.conf.json` before building. If artifacts are missing:
1. Check `tauri.prod.conf.json` has `"createUpdaterArtifacts": true`
2. Check the "Use production config" step ran successfully

## Configuration

### Dev vs Prod Configs
- `tauri.conf.json` - Dev config (identifier: `screenpi.pe.dev`)
- `tauri.prod.conf.json` - Prod config (identifier: `screenpi.pe`, updater enabled)

CI automatically uses prod config for releases by copying it before build.

### Trigger & Publication Behavior
- Dispatch `release-app.yml` once for consumer and Enterprise artifacts. A version-bump push by itself does not start the build.
- Public consumer and Enterprise publication remains a human-only admin-dashboard action after artifact verification.

## Notes

- Linux desktop app is disabled (bundling issues)
- App builds take ~25-35 minutes
- CLI builds take ~15-20 minutes
- Always pull before push to avoid conflicts
- Updater artifacts: macOS uses `.tar.gz`/`.sig`, Windows uses `.nsis.zip`/`.sig`
