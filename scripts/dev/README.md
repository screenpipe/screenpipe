# dev: local development + dogfooding loop (macOS, Apple Silicon)

screenpipe is most useful when it's running 24/7 — which is exactly what makes it
awkward to hack on. The installed prod app already holds port `3030` and
`~/.screenpipe`, so naively running a dev build alongside it is the silent-capture
collision in [#3466](https://github.com/screenpipe/screenpipe/issues/3466).

These three scripts automate the two maintainer-supported ways around that, so you
keep your always-on capture while you develop:

| script | what it does |
|--------|--------------|
| `sp-dev-app` | quit prod app → `bun tauri dev` → **restore prod on exit** (even on crash/Ctrl-C) |
| `sp-dev-cli` | run the CLI/core against an isolated data dir + port, **alongside** a still-running prod app |
| `sp-update-src` | clean `git pull` (survives a dirty tree) + `bun install` when JS deps change; the other two call it first |

They're optional accelerators, not a required toolchain — each one wraps patterns
already in [`CONTRIBUTING.md`](../../CONTRIBUTING.md). For a fully isolated second
environment in a VM instead, see [`scripts/dev-vm`](../dev-vm).

## Which mode?

- **Hacking on the desktop app (UI, tray, Tauri commands)** → `sp-dev-app`. It uses
  the real `~/.screenpipe`, so you get realistic data. The catch: a dev DB migration
  can permanently alter your prod DB. For risky migrations, use the CLI mode below.
- **Hacking on the CLI/core/engine, or testing a migration** → `sp-dev-cli`. It runs
  against a throwaway data dir (`$TMPDIR/screenpipe-dev`) on port `3031`, so your prod
  app can keep capturing on `3030` and your months of real data are never touched.

## Quick start

```bash
# from a screenpipe clone:
./scripts/dev/sp-dev-app                 # app dev; prod app restored when you exit
./scripts/dev/sp-dev-cli                 # cli dev on an isolated dir+port, prod keeps running
./scripts/dev/sp-dev-cli -- --disable-audio   # pass extra flags through to the binary
```

Every script takes `-h`/`--help`. Put them on your `PATH` if you like:

```bash
ln -s "$PWD/scripts/dev/sp-dev-app"   ~/.local/bin/sp-dev-app
ln -s "$PWD/scripts/dev/sp-dev-cli"   ~/.local/bin/sp-dev-cli
ln -s "$PWD/scripts/dev/sp-update-src" ~/.local/bin/sp-update-src
```

By default the scripts operate on the clone they live in. Point them elsewhere with
`SCREENPIPE_SRC_DIR=/path/to/clone`.

## Build prerequisites (the parts that aren't obvious)

The main install steps are in [`CONTRIBUTING.md`](../../CONTRIBUTING.md#macos). Three
Apple-Silicon gotchas trip up a first build from source and aren't covered there:

1. **Full Xcode, not just the Command Line Tools.** The `cidre` dependency's build
   script shells out to `xcodebuild`, so CLT alone fails. After installing Xcode:

   ```bash
   sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
   sudo xcodebuild -license accept
   sudo xcodebuild -runFirstLaunch
   ```

2. **The Metal Toolchain is a separate download.** `mlx-rs` (used for local models)
   needs it, and recent Xcode ships it as an on-demand component rather than bundling
   it. No sudo, ~700MB:

   ```bash
   xcodebuild -downloadComponent MetalToolchain
   ```

3. **`bun tauri dev`/`bun tauri build` auto-run `pre_build.js`; a raw `cargo build`
   in `src-tauri/` does not.** That prebuild downloads the bun/ffmpeg/ffprobe sidecars
   into `src-tauri/binaries/`. If you build that crate directly, run it yourself first:

   ```bash
   cd apps/screenpipe-app-tauri && bun scripts/pre_build.js
   ```

   (Invoke the `.js` directly, or `export PATH="$HOME/.bun/bin:$PATH"` first — the
   prebuild's `bun run` subshells go through `/bin/bash`, which may not inherit a
   shell-rc `PATH`, so `bun: command not found` can otherwise recur mid-prebuild.)

The `sp-dev-app` / `sp-dev-cli` scripts assume `bun` and `cargo` are already on your
`PATH` and bail with a clear message if not.

## Optional: two-machine split

If you want capture to never pause, keep the prod app running on one Mac and do
build/test work on a second Mac (reached over SSH/Tailscale) that has its own clone +
toolchain. The scripts are machine-agnostic — `SCREENPIPE_SRC_DIR` points each at its
local clone — so nothing here changes; it's purely a hardware choice. Skip it if you
only have one machine; `sp-dev-cli`'s isolated dir+port already lets dev and prod
coexist on a single box.

## Producing PR evidence

Every PR must provide the evidence appropriate to its change, as described in
[`CONTRIBUTING.md`](../../CONTRIBUTING.md#ai-assisted-contributions). App/UX
changes need a before/after recording. Backend / CLI / DB / log changes normally
need regression tests and relevant logs or results; when the behavior is easiest
to demonstrate in a terminal, `pr-evidence` can record the old behavior and the
fix in one session and render a single GIF (headless, no browser):

```bash
brew install asciinema agg
./scripts/dev/pr-evidence --out fix.gif \
  --before-label "before (#NNNN)" --before 'cmd that shows the bug' \
  --after-label  "after"          --after  'cmd that shows it fixed'
```

Both commands run in the current directory. Host the GIF per
[`CONTRIBUTING.md`](../../CONTRIBUTING.md#pull-requests) (drag-drop into the PR, or
a fork release asset) — don't commit it to the repo. Unlike the dev scripts above,
this one isn't macOS-specific.

## Scope

macOS on Apple Silicon, which is screenpipe's primary dev target. The `sp-*` dev
scripts use `osascript`/`pgrep`/`open` semantics that are macOS-specific; they aren't
written or tested for Linux or Windows (`pr-evidence` is portable). Build screenpipe
on those platforms with the steps in [`CONTRIBUTING.md`](../../CONTRIBUTING.md).
