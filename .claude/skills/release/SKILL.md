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
| Desktop App | `screenpipe-app-tauri/src-tauri/Cargo.toml` | `version = "X.Y.Z"` | `release-app.yml` |
| CLI/Server | `Cargo.toml` (workspace.package) | `version = "0.2.X"` | `release-cli.yml` |
| MCP | `screenpipe-integrations/screenpipe-mcp/package.json` | `"version": "X.Y.Z"` | `release-mcp.yml` |
| JS Browser SDK | `screenpipe-js/browser-sdk/package.json` | `"version": "X.Y.Z"` | npm publish |
| JS Node SDK | `screenpipe-js/node-sdk/package.json` | `"version": "X.Y.Z"` | npm publish |
| JS CLI | `screenpipe-js/cli/package.json` | `"version": "X.Y.Z"` | npm publish |

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
- `screenpipe-app-tauri/` (UI/frontend changes)

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
echo "=== App ===" && grep '^version' screenpipe-app-tauri/src-tauri/Cargo.toml | head -1
echo "=== CLI ===" && grep '^version' Cargo.toml | head -1
echo "=== MCP ===" && grep '"version"' screenpipe-integrations/screenpipe-mcp/package.json | head -1
```

### 2. Bump Version

Edit `screenpipe-app-tauri/src-tauri/Cargo.toml` to update version.

### 3. Commit & Push
```bash
git add -A && git commit -m "Bump app to vX.Y.Z" && git pull --rebase && git push
```

### 4. Trigger Release (Draft Only)
```bash
gh workflow run release-app.yml
```

**Important**: `workflow_dispatch` creates a **draft only** - does NOT auto-publish. This allows manual testing before publishing.

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

### 7. Publish Release
After testing, publish via the Cloudflare R2 / backend dashboard, OR commit with magic words:
```bash
git commit --allow-empty -m "release-app-publish" && git push
```

## Quick Release (App Only)

```bash
# 1. Bump version in Cargo.toml
# 2. Commit and push
git add -A && git commit -m "Bump app to vX.Y.Z" && git push

# 3. Trigger release (draft)
gh workflow run release-app.yml

# 4. Monitor
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

### Auto-Publish Behavior
- `workflow_dispatch` (manual trigger) → Draft only, no publish
- Commit with "release-app-publish" → Auto-publish after successful build

## Notes

- Linux desktop app is disabled (bundling issues)
- App builds take ~25-35 minutes
- CLI builds take ~15-20 minutes
- Always pull before push to avoid conflicts
- Updater artifacts: macOS uses `.tar.gz`/`.sig`, Windows uses `.nsis.zip`/`.sig`
