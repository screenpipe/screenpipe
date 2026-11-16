# Digital Clone store proposal

Status: complete review payload prepared locally; not submitted or published.

Read-only source fetched on 2026-11-16 from
`GET https://screenpi.pe/api/pipes/store/digital-clone`:

- version: `7`
- published source SHA-256: `3ae629da4bab55336fe2586a1a157011445fe85841d6202c95db02da6db4deb9`
- preserved response: `digital-clone-v7-live.json`

The complete strict payload is
`digital-clone-store-proposal/submission-payload.json`. It contains only
`slug,title,description,icon,category,source_md,readme_md`; no production API
was called. Its compact JSON SHA-256 is
`04f1cd7153c8aeafcd746ea38f1d24426fc5a74920e4da945fc65d8e5bec88ca`.

## Runtime and disclosure

- Source proposal: 65,517 UTF-8 bytes (store limit 65,536), SHA-256
  `6e0251b1322af5c9d5de74128def8809f693d4d567378ebf9e4876b2b544bf38`.
- Patched runtime SHA-256 and embedded bootstrap expectation:
  `16165d0979e86c175ccc40709b90ced87bd7bb28a458fd6ca0aa370d09b377d2`.
- `Bun.spawn` phases and Node-compatible `child_process.spawn` maintenance
  launch both set `windowsHide:true`.
- Maintenance uses `detached: process.platform === "win32"`: Windows needs
  detachment for the verified asynchronous launch and still inherits the app
  Job Object; Unix remains attached to its owning process group.
- Frontmatter description states that `screenpipe-cloud` sends screen content
  and local AI chat logs to Screenpipe's cloud model. The README explains the
  selected Claude Code/Codex/Hermes excerpts and that other presets send
  selected context to their configured provider.

`build-store-proposal.ts` deterministically rebuilds these artifacts from the
preserved live response. `verify-store-proposal.ts` used bundled Bun 1.3.10 to
verify strict fields, byte limit, bootstrap extraction/hash, local-fixture
setup/context/maintain/launch paths, a complete asynchronous receipt, and no
visible console from a Windows `Bun.spawn` probe.

Pending production steps: submit this payload for human review in
`/admin/pipes`; merge/build the app change; then a human publishes the app via
Admin Releases. No migration or environment change is expected.
