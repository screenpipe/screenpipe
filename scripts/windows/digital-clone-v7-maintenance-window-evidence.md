<!-- screenpipe — AI that knows everything you've seen, said, or heard -->
<!-- https://screenpipe.com -->

# Digital Clone v7 detached maintenance window evidence

Tested on November 16, 2026 from desktop commit
`379e8a1a48629319bc469828925ef6c2216960c1`. This is a narrow synthetic
Windows test; it does not establish full-app or customer recovery.

## Source gate

The test fetched `GET https://screenpi.pe/api/pipes/store/digital-clone` as
public code and did not execute the response. The response/root data was:

- version: `7`
- `source_md` UTF-8 bytes: `65532`
- SHA-256: `3ae629da4bab55336fe2586a1a157011445fe85841d6202c95db02da6db4deb9`
- exact `detached:!0,stdio:` occurrences: `1`

The proposed registry-only replacement is:

```text
detached:!0,stdio:
detached:!0,windowsHide:!0,stdio:
```

The resulting full `source_md` SHA-256 is
`74d685f3a6cb67424dc651e9e8a6761d59f37ac9d5c53cd52ee5950945d0d99b`
(`65547` UTF-8 bytes). No store blob or runtime migration belongs in the
desktop repository.

## Native differential attempt

Environment:

- Windows 11 Pro `10.0.26100` (build `26100`)
- Bun `1.3.10`
- Node `22.23.2` (probe sensitivity control only)
- active VM-owned console session; no TCP 3389 listener

The temporary harness was invoked from the repository root with:

```powershell
pwsh.exe -NoProfile -NonInteractive -File .\scripts\windows\digital-clone-v7-maintenance-window-eval.ps1
```

It launched a hidden parent with .NET `ProcessStartInfo.CreateNoWindow`, then
used the v7 call shape under Bun:

```js
spawn(process.execPath, ["run", syntheticClonePath, "maintain"], {
  cwd,
  env: { ...process.env, DIGITAL_CLONE_MAINTENANCE_RUN_ID: runId },
  detached: true,
  // fixed variant only: windowsHide: true,
  stdio: ["ignore", logFd, logFd],
});
child.unref();
```

The synthetic `clone.js maintain` wrote its PID/run ID, waited, and wrote start
and finish markers through the redirected descriptor. A temporary C# Win32
probe used `EnumWindows`, `IsWindowVisible`, `GetWindowThreadProcessId`,
`AttachConsole`, and `GetConsoleWindow`. It compared visible HWND snapshots
before and during each child lifetime. No positive control added
`CREATE_NEW_CONSOLE`.

Observed twice for the shipped Bun call shape:

| Observation | v7 original | `windowsHide` replacement |
| --- | ---: | ---: |
| new visible top-level windows | 0 | 0 |
| direct child-owned visible windows | 0 | 0 |
| attachable child console | no (Win32 error 6) | no (Win32 error 6) |
| hidden parent exit code | 0 | 0 |
| child alive after parent/unref | yes | yes |
| `maintain` argument and run ID preserved | yes | yes |
| redirected start/finish output preserved | yes | yes |
| child exited normally after wait | yes | yes |

The harness' native result was exit `4`: the required original-red condition
(at least one newly visible window) was not observed. A Node
`child_process.spawn` sensitivity control, using the same detached/unref/stdio
options and no explicit Windows creation flag, also observed `0` new visible
windows in both variants on this VM console host.

Cleanup tracked only the synthetic parent and child PIDs in a per-run set,
terminated a still-live member only in `finally`, and removed its unique temp
directory. It did not enumerate or terminate unrelated Bun/Node processes.

## Conclusion and limits

This Windows 11/Bun 1.3.10 image did **not** reproduce the reported visible
empty Bun window, so it cannot provide original-red/patched-green proof that
`windowsHide` alone fixes the incident. The registry replacement above remains
the smallest grounded defensive patch because it preserves detached lifetime,
arguments, environment, cwd, descriptor redirection, and unref behavior, but
this result must not be described as native proof of the store fix.

The reported desktop build and its bundled Bun/console-host behavior remain
unknown. The synthetic launcher does not cover arbitrary helpers orphaned by an
older run, a full app session, disable recovery, capture history, or customer
data. PR 7961 fixes tracked PipeManager disable lifecycle; it does not deploy
the registry source change or prove cleanup of every previously orphaned helper.
