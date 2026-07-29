# Releasing `screenpipe-mcp`

Publishing is a **GitHub Actions job**, not a local command: it needs the
`NPM_TOKEN` repo secret. No developer machine is expected to hold npm
credentials for this package.

---

## 0.19.0 — release notes (pending publish)

**Headline: `team-*` tools can finally be pointed at a customer's own query
gateway.** Orgs on the write-only archive tier keep telemetry in their own
object storage, served by a gateway inside their network; the hosted API has no
read path to that data. Before this release the base URL was a hardcoded
constant, so `team-search` / `team-devices` / `team-records` registered and then
failed with **HTTP 401** for every such org, and the only workaround was running
this MCP from source.

- `--team-api-url` flag, `SCREENPIPE_TEAM_API_URL` env var, and `gateway_url`
  in `~/.screenpipe/enterprise.json` now select the team API base, in that
  precedence order, falling back to `https://screenpi.pe/api/enterprise/v1`
  (`src/team-config.ts`).
- The token is unchanged (`sk_ent_…` via `SCREENPIPE_ENTERPRISE_TOKEN` or
  `team_api_token`); only the base moves.
- The HTTP transport no longer reports a frozen `0.14.0` as its version — both
  transports and the Sentry release tag now read `package.json` through
  `src/version.ts`.
- README documents the whole knob, including which install paths cannot reach a
  gateway yet.
- The release path now inspects its own artifact. `scripts/assert-pack-contents.js`
  (`npm run verify:pack`) runs in the step before `npm publish` and fails the
  release if the tarball is missing `dist/team-config.js` / `dist/version.js`, if
  a built file lost the override strings, or if the team API base is a hardcoded
  literal again — the exact shape of the 0.18.15 artifact. The `.mcpb` bundle gets
  the same treatment right after `mcpb pack`.

**Why 0.19.0 and not 0.18.16.** npm's `0.18.15` was built from a tree that
predated `src/team-config.ts`, and nobody bumped `package.json`, so the registry
and the repo both claimed "0.18.15" on two different trees. The version string
is the only handle support has on "which build is the customer running", so the
replacement must be unmistakable rather than one character away from the broken
one: `0.19.x` = has the gateway knob, `0.18.x` = does not. It is also the
semver-correct level, since this adds user-facing surface rather than fixing a
defect in shipped behaviour. Nothing depends on this package through a semver
range — every consumer in the monorepo uses `screenpipe-mcp@latest` — so the
minor bump changes no resolution.

**Known gaps that this release does NOT close** (documented under "Known limits"
in the README):

- Precedence step 3 needs the desktop app: it is the only writer of
  `gateway_url` into `~/.screenpipe/enterprise.json`, and only for a signed-in
  admin. On a server or CI box, set the env var or the flag by hand.
- The `.mcpb` bundle's `manifest.json` has no `user_config`/`env` block, so the
  Claude Desktop extension install has no UI for these variables.
- The `--http` transport still exposes `search_content` only; `team-*` is
  stdio-only.

---

## Before releasing

1. **The source commit must be on `main`.** `src/team-config.ts` arrived with
   PR #5400 (`feat(enterprise): write-only archive + customer-run query
   gateway`). Publishing from a feature branch ships a tree nobody reviewed as
   `latest`. Confirm — this asks whether the *file* is on `main`, not whether a
   particular sha is an ancestor, so it stays correct when the PR is squash- or
   rebase-merged and commit `930020705` ceases to exist:
   ```bash
   git fetch origin
   git cat-file -e origin/main:packages/screenpipe-mcp/src/team-config.ts 2>/dev/null \
     && echo "team-config.ts is on main — safe to release" \
     || echo "NOT on main — do not release"
   ```
2. **The version must not already be on npm.** `release-mcp.yml` now *fails* in
   that case instead of skipping quietly, but check first so you don't burn a
   run:
   ```bash
   node -p "require('./package.json').version"   # repo
   npm view screenpipe-mcp version               # registry — must differ
   ```
3. **Local gates green** (also enforced by `.github/workflows/test-mcp.yml`):
   ```bash
   cd packages/screenpipe-mcp
   bun install --frozen-lockfile
   bun run typecheck
   bun run build
   bun run test
   npm run verify:pack   # what the tarball would actually contain
   ```
   `verify:pack` is the same gate `release-mcp.yml` runs in the step immediately
   before `npm publish`, so a green run there means the artifact was checked, not
   assumed. It fails if `dist/team-config.js` / `dist/version.js` are missing from
   the pack list, if a built file lost `SCREENPIPE_TEAM_API_URL` / `--team-api-url`,
   or if the team API base is back to a hardcoded literal. `npm pack --dry-run`
   writes nothing and needs no npm auth, so it is safe to run anywhere.

## Publishing

Two equivalent triggers. Tag push is preferred — the tag is then a real record
of what shipped:

```bash
# from an up-to-date main checkout
git tag mcp-v0.19.0
git push origin mcp-v0.19.0
```

Or dispatch it (this is how 0.18.15 shipped; the workflow creates the tag
itself in its "Create GitHub Release" step):

```bash
gh workflow run release-mcp.yml -R screenpipe/screenpipe
```

`allow_already_published: true` is **only** for re-running the MCP-Registry /
`mcpb` / GitHub-release steps after a partial failure. It leaves the npm
registry untouched — never use it to "retry" a release you expected to publish.

## After publishing

```bash
VER=0.19.0

# 1. the registry actually moved
npm view screenpipe-mcp version                       # == $VER
npm view screenpipe-mcp dist-tags --json              # latest == $VER

# 2. the run did NOT no-op
gh run list --workflow=release-mcp.yml -R screenpipe/screenpipe --limit=3
gh run view <id> --log | grep -i "already on npm"     # must find nothing

# 3. the artifact carries the gateway knob (this is the whole point)
curl -sSL https://registry.npmjs.org/screenpipe-mcp/-/screenpipe-mcp-$VER.tgz \
  | tar -xzO package/dist/team-config.js | grep SCREENPIPE_TEAM_API_URL

# 4. no hardcoded team base survived
curl -sSL https://registry.npmjs.org/screenpipe-mcp/-/screenpipe-mcp-$VER.tgz \
  | tar -xzO package/dist/index.js | grep 'TEAM_API = "https' \
  && echo "REGRESSION: hardcoded base" || echo "ok — base is resolved, not hardcoded"

# 5. the .mcpb bundle attached to the GitHub release contains it too.
#    The run now gates on this itself ("Verify the mcpb bundle carries the
#    gateway knob") and prints the full `unzip -l` listing, so read that step's
#    log for the definitive answer. Independent confirmation from the artifact:
gh release download mcp-v$VER -R screenpipe/screenpipe -p '*.mcpb' -D /tmp
unzip -l /tmp/screenpipe-mcp.mcpb | grep team-config
```

Checks 3–5 duplicate gates the release run already enforces (`verify:pack` before
`npm publish`, and the mcpb grep after `mcpb pack`). Run them anyway the first
time: they are the only ones that inspect what the **registry** actually serves
rather than what CI built.

End-to-end against a real gateway:

```bash
SCREENPIPE_ENTERPRISE_TOKEN=sk_ent_… \
SCREENPIPE_TEAM_API_URL=https://<gateway>/api/enterprise/v1 \
npx -y screenpipe-mcp@0.19.0
# then call team-devices over stdio and confirm the request reached the
# gateway's access log, not screenpi.pe
```

## Notes

- `server.json`'s two version fields are synced from `package.json` by CI at
  publish time but **never committed back**, so bump them in the same commit.
  `src/version.test.ts` fails if they disagree.
- `manifest.json` intentionally stays at `0.0.0-injected-from-package-json`; CI
  rewrites it during the run.
- The workflow runs a bare `npm install` (no lockfile — `package-lock.json` is
  gitignored, `bun.lock` is the source of truth and npm ignores it), so the
  published build can resolve different transitive dependency versions than the
  local verification did.
