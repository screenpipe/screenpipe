#!/bin/bash
set -euo pipefail

URL="${1:-https://screenpi.pe}"
PROFILE_DIR="${HOME}/.cache/falkon-container-profile"

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-$(id -un)}"
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
mkdir -p "$PROFILE_DIR"

# Stale falkon processes can keep profile DBs locked and cause black pages.
if pgrep -x falkon >/dev/null 2>&1; then
	pkill -x falkon || true
	sleep 1
fi

export QTWEBENGINE_DISABLE_SANDBOX=1
export QT_OPENGL=software
export QTWEBENGINE_CHROMIUM_FLAGS="${QTWEBENGINE_CHROMIUM_FLAGS:---no-sandbox --disable-gpu --disable-gpu-compositing --disable-dev-shm-usage --disable-extensions --disable-features=UseSkiaRenderer,CanvasOopRasterization}"
export LIBGL_ALWAYS_SOFTWARE=1

if [[ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]]; then
	exec dbus-run-session -- falkon --profile "$PROFILE_DIR" --no-extensions "$URL"
fi

exec falkon --profile "$PROFILE_DIR" --no-extensions "$URL"
