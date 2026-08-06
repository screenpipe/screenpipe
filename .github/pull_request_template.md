---
name: pull request
about: submit changes to the project
title: "[pr] "
labels: ''
assignees: ''

---

## description

brief description of the changes in this pr.

related issue: #

> attach screenshots / recordings here — **never commit media into the repo.** drag the file into this box (works for anyone, browser only) and github hosts it. on the cli: attach it as a release asset — `gh release upload <tag> file.png` if you can write here, else `gh release create media file.png --repo <you>/screenpipe` on your fork — and paste the url.

## AI assistance and human ownership

read the [AI-assisted contribution policy](https://github.com/screenpipe/screenpipe/blob/main/CONTRIBUTING.md#ai-assisted-contributions).

- AI tool(s) used (`none` if not used):
- autonomy level (`none`, `autocomplete`, `chat`, or `agent`):
- what I personally verified:

- [ ] I personally submitted this PR, understand every material change, and can explain it without asking a model to answer maintainers for me.
- [ ] The problem statement, rationale, and replies to maintainers are my own.

## evidence type

check every category that applies and provide its required evidence below.

- [ ] UI or behavior change — before/after recording
- [ ] Backend change — regression tests and relevant logs/results
- [ ] Performance change — reproducible before/after benchmarks
- [ ] Docs, CI, or pure refactor — relevant checks and an explanation; no video required

## before

for UI or behavior changes, add a recording of the app/CLI before this change. otherwise write `not applicable` and explain why.

## after

for UI or behavior changes, add a recording of the app/CLI after this change. otherwise write `not applicable` and provide the evidence required above.

## how to test

list the exact commands or manual steps you personally ran and their results.

1. 
2. 
3. 

## desktop app checklist (if applicable)

If this PR adds or changes `#[tauri::command]` handlers or Rust types exported to the frontend, from `apps/screenpipe-app-tauri/`:

- [ ] `bun run bindings:generate` (if bindings changed)
- [ ] `bun run bindings:check`
- [ ] `bun run typecheck`

Commands are auto-collected via the vendored `tauri-helper` crate — no manual handler list edits in `main.rs`.
