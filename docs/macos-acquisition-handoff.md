# Acquisition handoff

<!-- doc-covers: none -->

The website companion saves the original, consented browser source and places
an opaque download grant in a platform carrier. The app persists a verifier,
claims the grant, and binds it using the verified Clerk session. This runs in a
background task, independent of recording. All platforms use the same claim,
retry, account-boundary, and retirement protocol.

```text
signed app + xattr -> ZIP -> website personalizes UUID and ZIP checksums
  -> macOS extracts app -> Keychain proof -> claim -> authenticated bind

signed screenpipe-<UUID>.exe -> NSIS validates filename -> installed token
  -> Windows credential-store proof -> claim -> authenticated bind

signed screenpipe-<UUID>.AppImage -> APPIMAGE filename -> credential-store proof
  -> claim -> authenticated bind
```

Retries reuse the same request and verifier. Saved proof survives app updates
that remove the xattr. Account switch/logout invalidates in-flight work and saves
a retirement marker before changing accounts, without waiting for credential
storage. The native settings-store listener also retires immediately on analytics
opt-out, including rapid off/on toggles and requests already in flight. A late
credential write cannot erase a persisted marker, so restart remains retired.
If the filesystem rejects the marker write, retirement is guaranteed only for
the current process. Same-account JWT refresh wakes the
worker without retiring the acquisition. Missing account provisioning is retried.
No token, source data or HTTP error body is logged.

Prepare artifacts locally from an already signed/notarized app:

```sh
python3 scripts/package-attribution-carrier.py \
  --app /path/to/screenpipe.app --platform macos-arm \
  --release VERSION --output /path/to/new-output-directory
```

The script checks app version, architecture, signature and metadata round-trip,
then writes `screenpipe-attribution.zip` and `screenpipe-attribution.json`.
For Linux or Windows, pass the original versioned release artifact instead:

```sh
python3 scripts/package-attribution-carrier.py \
  --artifact /path/to/versioned-installer \
  --platform linux \
  --release VERSION --output /path/to/new-output-directory
```

Linux writes `screenpipe-attribution.AppImage`; Windows and Windows ARM write
`screenpipe-attribution.exe`. Each has a `screenpipe-attribution.json` manifest
containing the original byte length and SHA-256. Windows preparation requires a
Windows host and checks Authenticode, version metadata, and architecture evidence
in the versioned release filename. The NSIS bootstrap PE machine is not treated
as payload architecture. Filename personalization preserves the signed bytes.
Use `--platform windows` for x86_64 and `--platform windows-arm` for ARM64.

The script never uploads artifacts or changes publication pointers. Production
activation and versioned-artifact publication have not been performed. Human
publication remains required. An ordinary, unpersonalized download installs and
runs normally without optional attribution. Renaming a personalized Windows or
Linux download before its first install/launch can lose attribution.

The signature-exempt xattr and ZIP extraction behavior are documented by
[Apple Developer Technical Support](https://developer.apple.com/forums/thread/796303).
There is no ZIP or user-supplied sidecar for Windows. NSIS saves the first valid
grant beside the installed executable and updates never replace it. Linux reads
only the original AppImage path supplied by `APPIMAGE`.

Before enabling website carrier admission, verify actual production artifacts,
app startup, restart, login/logout, trial/purchase, updater recovery, and provider
readback. The macOS test uses an ad-hoc signed fixture; Windows NSIS tests exercise
the real grant macro but mock installer signature/version metadata boundaries;
Linux uses a synthetic AppImage header. These local tests do not prove the full
production download or signing path.
