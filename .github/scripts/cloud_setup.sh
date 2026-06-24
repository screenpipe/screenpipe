#!/usr/bin/env bash
# One-shot setup for a headless Linux dev environment or ephemeral cloud sandbox
# (CI containers, Codespaces, cloud coding agents). Makes a bare Ubuntu image
# build + unit-test the screenpipe Rust workspace and TS bindings.
#
# It mirrors the build-dependency set in .github/scripts/install_dependencies.sh
# (what CI's build-ubuntu job uses) so "green here" == "green in CI", and it adds
# the toolchain basics (build-essential/clang/cmake/pkg-config/libssl-dev) that a
# GitHub-hosted runner ships preinstalled but a fresh sandbox may not.
#
# It intentionally OMITS the X11/openbox/xvfb/pulseaudio runtime stack that
# install_dependencies.sh pulls in — that is only needed for the live desktop
# integration test, not for compiling or running unit tests headless.
#
# Verify with:  cargo test --workspace --exclude screenpipe-rfdetr-mlx
# (screenpipe-rfdetr-mlx is Apple-MLX-only and cannot build on Linux.)
set -euo pipefail

echo "::: screenpipe headless setup — installing build dependencies :::"
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  build-essential g++ clang cmake pkg-config curl ca-certificates \
  ffmpeg libavformat-dev libavfilter-dev libavdevice-dev \
  tesseract-ocr libtesseract-dev libleptonica-dev \
  libssl-dev libsqlite3-dev sqlite3 libonig-dev \
  libasound2-dev libpulse-dev libpipewire-0.3-dev \
  libgtk-3-dev libxdo-dev libgbm-dev libwayland-dev libegl-dev \
  libopenblas-dev

# OpenBLAS double-prefix shim: the antirez-asr-sys build script emits
# -llibopenblas (a doubled "lib" prefix), so the linker needs a liblibopenblas.*
# to exist. This matches the OPENBLAS_PATH setup in install_dependencies.sh.
ARCH_TRIPLE="$(gcc -dumpmachine)"   # e.g. x86_64-linux-gnu
sudo mkdir -p "/usr/lib/${ARCH_TRIPLE}/openblas/lib"
sudo ln -sf "/usr/lib/${ARCH_TRIPLE}/libopenblas.so" \
            "/usr/lib/${ARCH_TRIPLE}/openblas/lib/liblibopenblas.so"
sudo ln -sf "/usr/lib/${ARCH_TRIPLE}/libopenblas.a" \
            "/usr/lib/${ARCH_TRIPLE}/openblas/lib/liblibopenblas.a" 2>/dev/null || true

# Persist the two env vars the build needs into the shell profile so every shell
# in the environment inherits them: OPENBLAS_PATH (above) and the multiple-
# definition link flag CI sets via RUSTFLAGS for the build-ubuntu job.
ENVRC="${HOME}/.bashrc"
add_env() { grep -qxF "$1" "$ENVRC" 2>/dev/null || echo "$1" >> "$ENVRC"; }
add_env "export OPENBLAS_PATH=/usr/lib/${ARCH_TRIPLE}/openblas"
add_env 'export RUSTFLAGS="-C link-arg=-Wl,--allow-multiple-definition"'

# Rust toolchain — rust-toolchain.toml pins the channel (+ rustfmt/clippy);
# `rustup show` triggers the install of that pinned channel. cargo is usually
# preinstalled in these environments, so only bootstrap rustup if it is missing.
if ! command -v rustup >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  # shellcheck source=/dev/null
  source "${HOME}/.cargo/env"
fi
rustup show

# Bun — for TS deps and `bun run bindings:check`. Usually preinstalled; guard.
command -v bun >/dev/null 2>&1 || curl -fsSL https://bun.sh/install | bash

# Warm the build so the first real cargo invocation is not a cold compile.
# Non-fatal: a warm-build failure should not fail environment setup.
export OPENBLAS_PATH="/usr/lib/${ARCH_TRIPLE}/openblas"
export RUSTFLAGS="-C link-arg=-Wl,--allow-multiple-definition"
cargo fetch
cargo build --workspace --exclude screenpipe-rfdetr-mlx || true

echo "::: setup complete — verify: cargo test --workspace --exclude screenpipe-rfdetr-mlx :::"
