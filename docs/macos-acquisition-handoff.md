# Acquisition handoff

<!-- doc-covers: none -->

The website saves the original, consented browser source before download. The
installer is the ordinary signed DMG, EXE or AppImage and carries nothing. After
install, the website's install page opens `screenpipe://attribution?grant=<uuid4>`
through the operating system. The app persists that grant with a verifier,
claims it, and binds it using the verified Clerk session. This runs in a
background task, independent of recording. All platforms share one protocol.

```text
consented website visit -> install page "Open screenpipe"
  -> screenpipe://attribution?grant=<uuid4> -> Keychain / credential-store proof
  -> claim -> sign in from the app, in any browser -> authenticated bind
```

The app accepts only its own build scheme, the `attribution` route and exactly
one valid v4 grant. The first saved grant wins: proof is never replaced, a
retired profile accepts nothing, and the same URL delivered twice (open-URL
event, single-instance forward, launch arguments, `/focus` handoff) is harmless.

Retries reuse the same request and verifier. Saved proof survives app updates.
Account switch/logout invalidates in-flight work and saves a retirement marker
before changing accounts, without waiting for credential storage. The native
settings-store listener also retires immediately on analytics opt-out, including
rapid off/on toggles and requests already in flight. A late credential write
cannot erase a persisted marker, so restart remains retired. If the filesystem
rejects the marker write, retirement is guaranteed only for the current process.
Same-account JWT refresh wakes the worker without retiring the acquisition.
Missing account provisioning is retried. No token, source data or HTTP error
body is logged.

Not covered: a visitor who closes the install page before clicking, or who
installs from a shared link, mirror or package manager, has no grant and stays
an unknown source. Nothing in the installer, packager, manifests or release
workflow is involved in attribution.
