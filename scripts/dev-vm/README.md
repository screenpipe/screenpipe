# dev-vm: macOS dev sandbox in a VM

A scripted macOS VM (via [tart](https://tart.run), Apple Virtualization.framework) for running a second, isolated dev environment on the same Mac: Claude desktop + Claude Code, Rust, bun, and screenpipe (app + source). Useful for running two screenpipe instances side by side (separate port 3030, tray, TCC permissions, database), testing onboarding/permission flows from a clean slate, or letting agents work in a sandbox.

## Quick start

```bash
./scripts/dev-vm/setup.sh   # one-time: pulls image (~30GB download), creates VM, provisions everything
./scripts/dev-vm/run.sh     # open the VM window (auto-login as admin)
./scripts/dev-vm/ssh.sh     # shell into it
```

Defaults: `screenpipe-dev` VM, 8 CPU, 16GB RAM, 80GB sparse disk, macOS Tahoe base image. Display: `1920x1022px` virtual display (1:1 crisp in a maximized window on a 1080p host screen; set `VM_DISPLAY=2560x1440px` or similar on bigger/Retina monitors), window opens maximized (`VM_WINDOW=keep` to skip). Refit is off on purpose: `--display-refit` combined with a pinned in-guest mode makes the view render the raw framebuffer 2x-cropped. Other overrides: `VM_NAME`, `IMAGE`, `VM_CPU`, `VM_MEM`, `VM_DISK`, `GUEST_RES`.

## What gets installed in the guest

- Xcode Command Line Tools, Homebrew, git, gh, jq
- Rust (rustup, stable), bun
- Claude desktop (`brew --cask claude`) and Claude Code (native installer)
- screenpipe.app (latest stable from screenpi.pe) and a source checkout at `~/Documents/screenpipe`

Guest credentials: `admin` / `admin` (cirruslabs image default). `setup.sh` installs an ssh key (`~/.ssh/screenpipe-dev-vm`) on first run.

## One-time manual steps (GUI, inside the VM)

1. Open Claude.app and log in (browser OAuth).
2. Run `claude` once in Terminal to authenticate Claude Code.
3. Open screenpipe.app and grant screen recording, accessibility, microphone. The VM has its own TCC database, so this never touches host permissions.
4. Optional: System Settings > sign in with Apple ID (works because host and guest are both macOS 15+). The App Store does NOT work in any Apple Silicon VM; use direct downloads or brew.

## Apple platform limits (apply to every VM tool, not just tart)

- Max 2 macOS guest VMs running at the same time per host.
- No Apple Neural Engine in guests: Vision OCR falls back to CPU/GPU (works, slower).
- Audio input device support is partial; mic-dependent flows can be flaky.
- GPU is paravirtualized Metal at roughly 90% of host performance.

## Lifecycle

```bash
tart stop screenpipe-dev                      # shut down
tart run screenpipe-dev --no-graphics &       # headless boot
tart clone screenpipe-dev screenpipe-dev-snap # cheap snapshot (APFS clone) while stopped
tart delete screenpipe-dev                    # nuke the VM
tart delete ghcr.io/cirruslabs/macos-tahoe-base:latest  # drop the OCI image cache
```

Disk reality check: the provisioned VM costs ~35GB of real host disk (grows with cargo target dirs, up to the 80GB sparse cap). The VM is an APFS clone of the image cache, so deleting the cache right after cloning reclaims little; it mainly means a future `setup.sh` re-clone has to re-download ~30GB.
