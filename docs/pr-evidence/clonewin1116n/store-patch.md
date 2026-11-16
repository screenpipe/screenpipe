# Digital Clone v7 store follow-up

Status: reviewed patch required in the production-backed Pipe registry; not
applied to production. The registry source is not owned by this repository and
the Windows development GitHub App has no source repository to open a separate
PR against.

Read-only source inspected on 2026-11-16:
`GET https://screenpi.pe/api/pipes/store/digital-clone`

- slug: `digital-clone`
- version: `7`
- published source SHA-256:
  `3ae629da4bab55336fe2586a1a157011445fe85841d6202c95db02da6db4deb9`

## Required metadata patch

Replace the store description and the matching `description` field in
`source_md`:

```diff
-People, companies and work context, with resumable history and optional Obsidian export.
+Builds sourced context from screen activity and local AI chat logs. When the screenpipe-cloud preset is selected, selected screen content and local AI chat logs are sent to Screenpipe's cloud model.
```

Add this sentence to the README's **Requirements and privacy** section, next to
the existing inference disclosure:

```diff
-Identity classification sends selected capture excerpts through Screenpipe's AI endpoint.
+Identity classification sends selected capture excerpts and relevant excerpts from local AI chat logs through the selected AI preset. When the screenpipe-cloud preset is selected, that content is sent to Screenpipe's cloud model.
```

## Required Windows runtime patch

In the maintained, unbundled source for `clone.js`, make every background Bun
or Node-compatible spawn explicitly hidden on Windows before compiling and
rehashing the embedded runtime. At minimum, v7's maintenance launcher needs:

```diff
 const child = spawn(process.execPath, ["run", clonePath, "maintain"], {
   cwd: root,
   env: { ...process.env, DIGITAL_CLONE_MAINTENANCE_RUN_ID: runId },
   detached: true,
+  windowsHide: process.platform === "win32",
   stdio: ["ignore", logFd, logFd],
 });
```

The same explicit `windowsHide` option is required on the phase-level
`Bun.spawn` calls so a future detached phase cannot regress. Rebuild the
embedded runtime, update its SHA-256 bootstrap check, run its Windows fixture
and visible-window tests, then publish a new Pipe-store version through the
store's human-controlled process. Do not edit v7 in place.

