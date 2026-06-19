# A Beginner's Guide to Developing screenpipe

*From "can I even do this?" to a merged pull request.*

By the end of this guide you'll have built screenpipe from source, made a change, and opened a pull request a maintainer can merge. That's the destination. Everything here gets you there without the lost days most people spend first.

**Who it's for.** You like screenpipe and want to work on it, not just file issues. Maybe you've done some web coding or taught yourself a language, but never contributed to someone else's codebase on a continuing basis. You don't need ten years of experience. You need a proper setup and a map, so you don't set sail for failure and quietly give up when a certificate or a test breaks.

Read it once for the shape, then come back to each part when you reach it. You don't have to do it in one sitting.

> **This guide is written for macOS.** The setup, code-signing, and dev-loop commands assume a Mac. On Linux or Windows the build steps differ (see `CONTRIBUTING.md` for your platform), but the ideas carry over unchanged: keep your dev data away from your real captures, prove a change by its output, ship one focused PR at a time. Contributions that extend this guide to other platforms are welcome.

> **How this fits with `CONTRIBUTING.md`.** `CONTRIBUTING.md` is the reference: exact build commands per OS, test layers, styleguides. This is the narrative walkthrough for a first-timer: the order to do things in, why each step matters, and the traps. Read this to get oriented; reach for `CONTRIBUTING.md` for the precise commands.

> **A note on honesty.** This is meant to be a living document. Some of it says "do this." Some says "this is a trap." Some will go stale as tools change. When you find something wrong, fix it. That's part of the job now.

---

## Part 0 — Use the product before you touch the code

The common newcomer mistake: open the repo, point an AI at an issue, say "fix this," and hope the model absorbs what the product is. It won't, and neither would a person. You'd be patching symptoms blind.

Two things first:

1. **Run the real app.** Install the [prebuilt build](https://docs.screenpi.pe) and use it for a day. Let it record. Search your own history. You can't build well for a tool you've never felt.
2. **Read `VISION.md` and `DESIGN.md`.** screenpipe captures what you've seen, said, and heard, and indexes it locally. The values are stability over features, activation over new capabilities. They don't want feature creep. The upshot: a maintainer rewards changes that harden what exists over clever additions.

---

## Part 1 — The one rule that keeps you safe

Most projects you can hack carelessly. screenpipe you can't, and this is the most important paragraph here:

> screenpipe records your real life. Your screen and audio go 24/7 into `~/.screenpipe`. When you develop, your irreplaceable data sits right next to the code you're about to break. A careless run can read, write, or wipe months of your own captures.

So the craft is simple to state: keep the thing you're testing away from the data you can't lose. You'll run two screenpipes.

- **Your everyday one**: recording your life, normal port, `~/.screenpipe`. Never point a dev build at it.
- **A throwaway dev one**: different port, different data dir. Crash it, wipe it, rebuild it freely.

If you remember one thing from this guide: two instances, never crossed.

---

## Part 2 — Set up your machine

This is the boring part that stops people, so don't rush it. On macOS (see `CONTRIBUTING.md` for Linux and Windows):

1. Install Rust:
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   ```
2. Install the system libraries:
   ```bash
   brew install pkg-config ffmpeg jq cmake wget git-lfs
   ```
3. Install the full Xcode from the App Store. The command-line tools alone aren't enough. Then:
   ```bash
   sudo xcodebuild -license
   xcodebuild -runFirstLaunch
   ```
4. Install Bun, the JS/TS runtime the app uses. This project uses `bun`, not `npm`:
   ```bash
   curl -fsSL https://bun.sh/install | bash
   ```
5. Clone and build the engine to prove the toolchain works:
   ```bash
   git clone https://github.com/screenpipe/screenpipe
   cd screenpipe
   cargo build --release --features metal
   ```

If that build finishes, you've built screenpipe from source and your machine is ready. If it fails, stop and fix it before going further. A half-working toolchain is where the lost days happen.

The engine builds with `cargo`. The desktop app builds with `bun tauri build` from `apps/screenpipe-app-tauri/`. You usually only need the one you're changing.

---

## Part 3 — Accounts and tokens you actually need

Good news nobody says out loud: most contributions need almost no accounts or keys.

- **A GitHub account and a fork.** The only hard requirement. Fork `screenpipe/screenpipe`, push branches to your fork, open PRs from there. Install the `gh` CLI and run `gh auth login` once; it turns ten git steps into one.
- **An AI provider key, only if you touch AI features.** screenpipe runs local models, so much of the codebase needs no external key. If your change calls a cloud model, add your own key in the app settings. Don't collect keys you don't need yet.
- **No paid screenpipe account.** You build from source. That is your screenpipe.

Two rules that matter more than the list. The good way: authenticate `gh` once and let it manage git. The trap: never hardcode a token into a file you might commit. Keys live in settings or environment variables, never in the tree.

Collect the minimum for the task in front of you.

---

## Part 4 — Make macOS stop dropping your permissions

Read this even though it's fiddly, because it saves you from a confusing failure. Stay calm here; this is the step people misdiagnose.

screenpipe needs Screen Recording, Microphone, and Accessibility permissions. macOS ties those to an app's code signature. A normal dev build gets a fresh signature every rebuild, so macOS treats each rebuild as a new app and drops your permissions. Your code is fine, but capture "returns nothing," and you lose an afternoon to a bug that isn't there.

The fix: sign dev builds with one stable identity. If you don't have an Apple Developer cert, make a free self-signed one:

1. In Keychain Access → Certificate Assistant → Create a Certificate, name it `screenpipe dev`, Identity Type **Self-Signed Root**, Certificate Type **Code Signing**. Confirm it exists:
   ```bash
   security find-identity -v -p codesigning
   # you should see your "screenpipe dev" identity in the list
   ```
2. Build and sign with it. Same flow as `scripts/build_macos.sh`, your cert:
   ```bash
   cd apps/screenpipe-app-tauri
   bun tauri build --no-sign --features metal
   APP="src-tauri/target/release/bundle/macos/screenpipe - Development.app"
   xattr -cr "$APP"
   codesign --force --deep --sign "screenpipe dev" "$APP"
   ```
3. Grant the three permissions once. The signature is now stable, so future rebuilds keep them.

You only need this for desktop-app work. If you're on the engine via the command line, skip it. But remember it: the day capture "stops working" after a rebuild, this is why.

---

## Part 5 — Run a dev instance that can't hurt you

Here's how you keep the two instances apart in practice. The one-liner runs a dev instance on its own port and data dir, isolated from `~/.screenpipe`:

```bash
./target/release/screenpipe --port 3035 --data-dir "${TMPDIR:-/tmp}/sp"
```

That's the safety wall. A few details (also in `CONTRIBUTING.md` → "running dev + prod in the same time"):

- Use `${TMPDIR:-/tmp}`, not `/tmp`. macOS sweeps `/tmp` and can delete your dev data mid-session. `$TMPDIR` is per-user, survives the session, and is private to you.
- Port `3035` keeps it off your everyday instance's API.
- Wipe that data dir whenever you want. That's the point.

Once you trust that your dev instance can't reach your real data, you stop being careful and start being fast. You can run a scary migration, corrupt it, rebuild it, and lose nothing. That speed is what this one habit buys you.

You don't need to automate this yet. Type the command yourself until it's muscle memory. Wrap it in a script later; learn it by hand first.

---

## Part 6 — Prove your change actually works

"It compiled" and "it launched" aren't proof. For a tool whose job is capturing data, the proof is: did data flow, and does the feature behave through the API?

- Run the test layer you touched. Rust: `cargo test`, scoped to your crate while iterating. App: `bun test`. Run what CI runs before you open a PR.
- For a capture change, watch the output. Start your dev instance, then confirm new rows get written and the API returns what you expect. A build that boots but writes nothing is a failed change wearing a success costume.
- If you touched window, tray, monitor, or audio behavior, read `TESTING.md` first. It lists every edge case that has broken before.

After any change, ask what you'd look at to know it really worked, then go look. That question is what separates merged PRs from "did you test this on a real instance?"

---

## Part 7 — Find something worth doing

You don't have to invent anything.

- **The issue tracker.** Small, well-defined bugs, and issues where a maintainer asked for help. Search first so you don't duplicate an open PR.
- **Open invitations.** Asks like "more end-to-end examples, the more the better" are low-risk and clearly wanted.
- **Friction you hit yourself.** The best source. A wrong doc, a missing caveat, a step in this guide that tripped you. A small fix like that is a perfect first PR; it's how some of the notes in `CONTRIBUTING.md` got there.

Make your first PR boringly safe: a doc fix, a tiny bug, an example. You're proving you can land a clean change end to end, nothing more.

---

## Part 8 — Ship it: the contribution loop

The first time this feels like a lot. After that it's five minutes.

1. **Sync your fork** to the latest upstream so you're on current code. Fast-forward your fork's `main` to `upstream/main` before branching, so you don't "fix" something already fixed.
2. **Branch** off fresh `main` with a short name like `docs/fix-dev-data-dir`. Keep issue numbers out of the branch name and PR title; that's the house style here.
3. **Make one change.** One concern per PR. If you spot an unrelated fix, save it for a separate PR. Bundled PRs get closed.
4. **Test it for real** (Part 6).
5. **Commit** with an imperative first line ("add X", not "added X"), a blank line, then why. Sign the commit if you can; it shows as Verified on GitHub.
6. **Push to your fork and open the PR.** Fill every section of the template, especially before/after. If you can show it working on a real instance, do.

Maintainers merge on evidence. "Tests pass, trust me" is weak. "Here's the behavior before, here's after, on a live instance" is what gets merged.

---

## Part 9 — How review works here

Every project has a culture you usually learn by bruising yourself on it. Here's screenpipe's, so you can skip the bruises.

- **Focused beats big.** One clean, single-purpose PR with evidence merges fast. A sprawl touching ten things gets closed even when each change was fine.
- **Evidence beats assertion.** Expect "did you test this on a real instance?" Answer it before it's asked.
- **Stability beats cleverness.** Re-read Part 0. A change that hardens the product beats a flashy feature.
- **Credit the reporter, check for existing work.** Both take ten seconds and both matter.
- **There's a person reviewing.** Make their review easy. A PR understood in thirty seconds merges in thirty seconds.

None of this is unique to screenpipe. It's professional contribution, stated plainly. Learn it here, carry it everywhere.

---

## Part 10 — When it breaks

Things will fail. That's normal, not a verdict on you. The real trap is not knowing whether the failure is yours or a known quirk. Here are quirks that have eaten people's time:

- **A pre-commit check fails on files you didn't touch.** Some hooks scan wider than your change. Read the message, fix the cause, and don't bypass the gate to silence it.
- **Your data dir vanished mid-session.** You used `/tmp` instead of `$TMPDIR` (Part 5). The system swept it.
- **Capture stopped working after a rebuild.** Permissions dropped because the build wasn't signed with a stable identity (Part 4).
- **A file you didn't edit shows as dirty.** Often an auto-generated file like a lockfile regenerating. Usually safe to reset that file to the committed version, but know what it is first.

When something fails, ask "is this a known quirk?" before assuming it's your code. Half the time it is. Add the ones you find to this list.

---

## Part 11 — Why set all this up instead of clone-and-pray

This is a lot. Couldn't you just clone the repo, open an AI assistant, and start fixing issues?

For a one-off typo, yes. For developing screenpipe again and again, no, and here's the math:

- **You pay the setup once.** Every quirk above costs hours to rediscover cold. Learn them once and they're free. Your first contribution pays for setup; the rest are fast.
- **The downside of skipping is lopsided.** One corrupted `~/.screenpipe` is months of your life. One sloppy PR burns credibility you'll want later. An evening of setup is cheap against either.
- **Trust compounds.** Clean, evidenced PRs merge faster, so you contribute more, so your PRs get trusted on sight. That only starts if the first few are clean.

A clone-and-pray contributor fixes a bug and hopes. A set-up contributor knows it works, proves it, and lands it. Same person, different outcome. The difference is this guide.

---

## You're in

Ship one merged PR and something real has happened: you went from using a tool to building it. You didn't need permission or a degree. You needed the product in your hands, your data kept safe, your change proven, and your PR focused and kind.

Now go find a small issue and do it properly.

---

> This started as one contributor's path from zero to a merged PR, written down so the next person doesn't bleed for the same lessons. If a step is wrong, stale, or could be kinder, change it. The best version of this guide is the one the next newcomer improves for the one after.
