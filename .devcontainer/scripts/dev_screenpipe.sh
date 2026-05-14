#!/bin/bash
set -euo pipefail

log() {
    echo -e "\e[1;34m[INFO]\e[0m $1"
}

cd /workspaces/screenpipe

export XDG_SESSION_TYPE="x11"
export WAYLAND_DISPLAY=""
export OPENBLAS_PATH=/usr/lib/x86_64-linux-gnu/openblas

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
    log "Building CLI"
    cargo build --release -p screenpipe-engine --bin screenpipe
fi

log "Ensuring virtual display"
if ! pgrep -f "Xvfb :99" >/dev/null 2>&1; then
    Xvfb :99 -ac -screen 0 1280x1024x24 +extension GLX +extension RANDR &
    sleep 2
fi

export DISPLAY=:99

if ! pgrep -x openbox >/dev/null 2>&1; then
    mkdir -p ~/.config/openbox
    echo '<openbox_config><menu><file>menu.xml</file></menu></openbox_config>' > ~/.config/openbox/rc.xml
    openbox --config-file ~/.config/openbox/rc.xml &
    sleep 1
fi

log "Setting up audio"
.github/scripts/setup_audio.sh
if [[ -f .screenpipe-audio-env ]]; then
    # shellcheck source=/dev/null
    source .screenpipe-audio-env
fi

log "Resetting previous Screenpipe process"
pkill -x screenpipe || true
rm -f screenpipe.pid

log "Starting Screenpipe in background"
./target/release/screenpipe record --disable-telemetry --debug --language english > screenpipe_output.log 2>&1 &
SCREENPIPE_PID=$!
echo "$SCREENPIPE_PID" > screenpipe.pid

for _ in {1..30}; do
    if curl -fsS http://127.0.0.1:3030/health >/dev/null 2>&1; then
        break
    fi
    sleep 1
done

if ! ps -p "$SCREENPIPE_PID" >/dev/null 2>&1; then
    echo "[ERROR] Screenpipe exited during startup"
    tail -n 200 screenpipe_output.log || true
    exit 1
fi

log "Screenpipe is running (pid $SCREENPIPE_PID)"
echo "Health check: curl -sS http://127.0.0.1:3030/health"
echo "Logs: tail -f /workspaces/screenpipe/screenpipe_output.log"
echo "Stop: .github/scripts/stop_screenpipe.sh"
