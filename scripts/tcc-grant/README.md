# tcc-grant: pre-authorize macOS TCC permissions with zero user interaction

A CLI for granting, checking, and revoking macOS privacy permissions
(Accessibility, Input Monitoring, Screen Recording, Microphone, and others)
for an app — without clicking through a single system dialog.

## Why this exists

screenpipe (and any computer-use agent) needs Accessibility, Input Monitoring,
Screen Recording, and Microphone access. Normally that means a human has to
click through several native permission dialogs the first time the app runs.
On a disposable test/CI VM that's a hard blocker for automation. This tool
seeds `TCC.db` directly so a known app is already-authorized before it ever
launches.

**This only works with System Integrity Protection (SIP) disabled.** SIP
protects `TCC.db` even from root on a normal Mac — writes will silently fail
there. This is meant for SIP-disabled test/CI VMs (e.g. a
[tart](https://tart.run) image built with SIP off), not for bypassing
permissions on a real user's machine.

## Quick start

```bash
# see what's grantable
./tcc-grant.sh list-services

# grant the 4 permissions almost every computer-use agent needs
sudo ./tcc-grant.sh grant --app /Applications/screenpipe.app --all

# check what an app currently has
./tcc-grant.sh status --app com.screenpipe.app

# reset an app back to "never asked" for repeat testing
sudo ./tcc-grant.sh revoke --app com.screenpipe.app --all
```

`grant`'s `--app`/`--target` take a **path to the `.app` bundle only** — this
tool does not resolve a bundle identifier to a path. Every way to do that
(Spotlight/`mdfind`, `lsregister -dump`, scanning a fixed list of
directories) has a real gap for some installed location, and Spotlight
indexing is commonly disabled outright on minimal CI images (`mdutil -s /` →
"Indexing disabled" — confirmed on the VM this was built against). Whoever
calls this tool already knows or can trivially find the path to the app
it's targeting, so that lookup belongs to the caller, not to this tool
silently guessing and sometimes being wrong. `status`/`revoke`'s `--app`
additionally accepts a bare bundle id, since there it's just matching a
`client` string in `TCC.db`, not resolving a path.

## Commands

- `list-services [--json]` — table of every supported permission: alias, raw
  `kTCCService*` identifier, whether it's one of the "core 4", and a
  description. Use the alias with `--service`.
- `grant --app <path-to.app> (--service <alias>[,<alias>...] | --all) [--target <path-to.app>] [--adhoc-sign] [--force]`
  — computes the app's real code-signing requirement (`csreq`) and inserts a
  matching, already-allowed row into both the system and per-user `TCC.db`.
  Requires root and SIP disabled.
  - `--all` grants the core 4: `accessibility,input-monitoring,screen-recording,microphone`.
  - `automation` (Apple Events / sending commands to another named app, e.g.
    scripting System Events) additionally requires `--target
    <path-to-the-app-being-controlled>` — Automation permission is
    per (caller, target) pair, not just per caller.
  - `--adhoc-sign` ad-hoc signs the target app first if it isn't signed at
    all. Only use this on your own test apps — re-signing a third-party app
    invalidates its original signature.
  - `--force` skips the SIP-disabled check (the write will likely still fail
    if SIP is actually enforced; this is for edge cases where `csrutil
    status` is misleading).
- `status --app <path|bundle-id> [--service <alias>] [--json]` — reads current
  grant state from both `TCC.db`s. No root required. Useful for an agent to
  confirm a grant took before launching the target app.
- `revoke --app <path|bundle-id> (--service <alias>[,<alias>...] | --all) [--force]`
  — deletes the app's rows from both `TCC.db`s, resetting it to
  "never asked" (`notDetermined`) so permission flows can be re-tested from a
  clean slate. Requires root and SIP disabled (same direct-DB-write mechanism
  as `grant` — see note in the script about why this doesn't shell out to
  `tccutil reset`).

## How it works

1. Take the `--app` path as given, and read its `CFBundleIdentifier` (this is
   the TCC `client` key).
2. Extract the app's designated requirement (`codesign -d -r-`) and compile it
   to the binary form (`csreq -b`) TCC stores in the `csreq` column — this is
   what ties a grant to *this exact binary's signature*, same as a real prompt
   would.
3. Insert a row into `access` in both
   `/Library/Application Support/com.apple.TCC/TCC.db` (system) and
   `~/Library/Application Support/com.apple.TCC/TCC.db` (the console user's,
   auto-detected via `stat -f%Su /dev/console`) with `auth_value=2` (allowed).
   Writes use `sqlite3 -cmd '.timeout 5000'`: killing and restarting `tccd`
   around the write can otherwise race the daemon's own respawn and hit a
   transient "database is locked" — the busy timeout retries instead of
   failing.
4. Restart `tccd` (system + the console user's GUI instance) so it picks up
   the change immediately.

## Verified

Tested end-to-end on a SIP-disabled `macos-sequoia-base-sip-disabled` tart VM
against a throwaway probe app (`TCCProbe.app`, exercises Accessibility, Input
Monitoring, Screen Recording, Microphone via the real
`AXIsProcessTrusted*`/`IOHIDCheckAccess`/`IOHIDRequestAccess`/`CGPreflight/RequestScreenCaptureAccess`/`AVCaptureDevice`
APIs): unseeded launch produces three stacked native permission prompts;
after `grant --all`, a fresh launch reports all four services already
authorized before any request call runs, with zero dialogs.

## Caveats

- Requires root (`sudo`) for `grant`/`revoke`; SIP must report disabled
  (`csrutil status`).
- `automation` was validated by confirming the DB row and `status` output are
  correct (matches Apple's documented schema for per-target Apple Events
  grants); it wasn't exercised against a probe app that actually sends an
  Apple Event, since `TCCProbe.app` doesn't do that today.
- `grant`/`--target` require a real path to an existing `.app` on disk —
  intentionally no bundle-id lookup (see above). If you only have a bundle
  id, find the path yourself first (`ls /Applications`, `find / -iname
  "*.app"`, or however your install step already knows it) and pass that.
