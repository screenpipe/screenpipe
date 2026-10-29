# Window screenshot privacy regression

Run only on a disposable synthetic desktop. These fixtures contain a cyan
`PrivacyAllowed` window and an overlapping magenta `PrivacyBlocked` window.
The probe calls the production capture helper and `SnapshotWriter`, reopens the
saved JPEGs, and checks both raw and persisted pixels. It requires useful allowed
content in all ten frames, so blank screenshots cannot pass.

Build the probe:

```sh
cargo build -p screenpipe-screen --example screenshot_privacy_probe --profile debug-dev
```

On macOS (14+), compile and start the fixture. Give the probe Screen Recording
permission in the disposable guest if necessary:

```sh
clang -fobjc-arc -framework Cocoa -framework CoreGraphics \
  crates/screenpipe-screen/examples/privacy-fixture/macos.m -o /tmp/privacy-fixture
mkdir -p /tmp/privacy-include
/tmp/privacy-fixture /tmp/privacy-include
# In another guest shell:
target/debug-dev/examples/screenshot_privacy_probe /tmp/privacy-include 0 include
```

The macOS fixture recreates the excluded window after every `resolved` marker,
inside the same enumeration/750 ms focus-settle boundary as the original engine.
Use the exact same output directory for fixture and probe when testing this race.
Add `baseline` as the fourth probe argument to exercise the old monitor/exclusion
capture helper; the race must fail with magenta pixels before trusting a green run.
This deterministic newly-created-window race is distinct from a literal Cmd-Tab
replay of a customer's session.

On Linux, use an X11 desktop with Composite enabled (for example Xvfb + Openbox):

```sh
DISPLAY=:99 python3 crates/screenpipe-screen/examples/privacy-fixture/linux.py
# In another guest shell:
DISPLAY=:99 target/debug-dev/examples/screenshot_privacy_probe /tmp/privacy-include 0 include
```

The final argument defaults to `include`; `exclude` exercises an exclusion-only
policy, `none` verifies unfiltered capture still contains both colors, and `empty`
requires a capture error with no PNG/JPEG created. Set `PRIVACY_ANIMATE=1` for the
fixture to move and reorder the excluded window repeatedly. The allowed window
stays stable so capture failures are not mistaken for passing privacy assertions.

On Windows, build both examples and start two disposable native windows:

```powershell
cargo build -p screenpipe-screen --example windows_privacy_fixture --example screenshot_privacy_probe --profile debug-dev
$fixture = "$PWD\target\debug-dev\examples\windows_privacy_fixture.exe"
$allowed = Start-Process $fixture -ArgumentList 'allowed', '120', '140' -PassThru
$blocked = Start-Process $fixture -ArgumentList 'blocked', '300', '260' -PassThru
# The blocked window continuously moves and changes stacking order.
& .\target\debug-dev\examples\screenshot_privacy_probe.exe C:\privacy-include 0 include
Stop-Process -Id $allowed.Id, $blocked.Id
```

Use separate output directories for baseline, include, exclude, empty, and no-policy
runs. The shared probe checks saved JPEGs on Windows too. The native fixture
implements normal Win32 paint/print messages; accelerated application capture
must also be checked with a real browser window. On x86_64, isolated capture uses
WGC. ARM64 bypasses xcap's screen-copy fallback with PrintWindow only; applications
that do not render through PrintWindow can yield unavailable or blank content.

Unsupported window-isolation backends must withhold screenshots: macOS before
14, Wayland window selection, or X11 without Composite. The production event loop
continues independently filtered accessibility collection when screenshots are
withheld. Native pixel probes do not exercise packaged-app onboarding or the
entire recorder/database lifecycle; paired-capture tests cover durable text and
snapshot behavior separately.
