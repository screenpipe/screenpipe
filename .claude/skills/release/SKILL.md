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
| MCP | `packages/screenpipe-mcp/package.json` | `"version": "X.Y.Z"` | `release-mcp.yml` |

## When to Release What

**Always release CLI** when there are changes to core screenpipe code:
- `screenpipe-core/`
- `screenpipe-vision/`
- `screenpipe-audio/`
- `screenpipe-server/`
- `screenpipe-db/`
- `screenpipe-events/`
- `screenpipe-integrations/`

**App-only release** is fine when changes are only in:
- `apps/screenpipe-app-tauri/` (UI/frontend changes)
- If the release includes new or changed `#[tauri::command]` handlers: from `apps/screenpipe-app-tauri/`, run `bun run bindings:generate` and verify `bun run bindings:check` before tagging

To check what changed since last CLI release:
```bash
# Find last CLI release commit
git log --oneline --all | grep -E "CLI to v" | head -1

# Check if core code changed since then
git diff <COMMIT>..HEAD --stat -- screenpipe-core screenpipe-vision screenpipe-audio screenpipe-server screenpipe-db screenpipe-events screenpipe-integrations
```

## Release Workflow

### 1. Check Current Versions
```bash
echo "=== App ===" && grep '^version' apps/screenpipe-app-tauri/src-tauri/Cargo.toml | head -1
echo "=== CLI ===" && grep '^version' Cargo.toml | head -1
echo "=== MCP ===" && grep '"version"' packages/screenpipe-mcp/package.json | head -1
```

### 2. Bump Version

Edit `apps/screenpipe-app-tauri/src-tauri/Cargo.toml` and bump the `version = "X.Y.Z"` line at the top of `[package]`.

### 3. Commit & Push (Triggers Release)
```bash
git add -A && git commit -m "Bump app to vX.Y.Z" && git pull --rebase && git push
```

Pushing a commit whose message starts with `Bump app` or `release-app` to `main` triggers `release-app.yml` automatically (`check_commit` job gates on the prefix). The build is a **draft only** — does NOT auto-publish. Use the `release-app-publish` prefix to auto-publish instead.

**Do NOT also run `gh workflow run release-app.yml`** — it fires a second `workflow_dispatch` run on the same SHA, doubling the build. The push handles it.

### 4. Monitor Build Status
```bash
# Get latest run ID
gh run list --workflow=release-app.yml --limit=1

# Check status
gh run view <RUN_ID> --json status,conclusion,jobs --jq '{status: .status, conclusion: .conclusion, jobs: [.jobs[] | {name: (.name | split(",")[0]), status: .status, conclusion: .conclusion}]}'
```

### 5. Test the Draft Release
- Download from https://screenpi.pe (requires purchase token)
- Test on macOS and Windows
- Verify updater artifacts exist (.tar.gz, .sig files)

### 6. Publish Release
After testing, publish via the Cloudflare R2 / backend dashboard, OR commit with magic words:
```bash
git commit --allow-empty -m "release-app-publish" && git push
```

## Quick Release (App Only)

```bash
# 1. Bump version in apps/apps/screenpipe-app-tauri/src-tauri/Cargo.toml
# 2. Commit and push — the "Bump app" prefix triggers release-app.yml automatically
git add -A && git commit -m "Bump app to vX.Y.Z" && git push

# 3. Monitor
sleep 5 && gh run list --workflow=release-app.yml --limit=1
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

### Trigger & Publish Behavior
- Commit prefix `Bump app` or `release-app` pushed to main → Draft release
- Commit prefix `release-app-publish` pushed to main → Auto-publish after successful build
- `workflow_dispatch` (manual `gh workflow run`) → Draft release (redundant with the push trigger; avoid using both)

## Notes

- Linux desktop app is disabled (bundling issues)
- App builds take ~25-35 minutes
- CLI builds take ~15-20 minutes
- Always pull before push to avoid conflicts
- Updater artifacts: macOS uses `.tar.gz`/`.sig`, Windows uses `.nsis.zip`/`.sig`
