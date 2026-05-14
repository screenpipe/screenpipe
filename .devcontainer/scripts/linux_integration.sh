#!/bin/bash
set -euo pipefail

log() {
    echo -e "\e[1;34m[INFO]\e[0m $1"
}
export XDG_SESSION_TYPE="x11"
export WAYLAND_DISPLAY=""

# Change directory to Screenpipe folder
cd /workspaces/screenpipe/

log "Installing dependencies"
.github/scripts/install_dependencies.sh
export OPENBLAS_PATH=/usr/lib/x86_64-linux-gnu/openblas

log "Verifying Tesseract installation"
.github/scripts/verify_tesseract.sh

log "Building CLI"
cargo build --release -p screenpipe-engine --bin screenpipe

log "Setting up virtual display with window manager"

Xvfb :99 -ac -screen 0 1280x1024x24 &
sleep 3
export DISPLAY=:99
mkdir -p ~/.config/openbox
echo '<openbox_config><menu><file>menu.xml</file></menu></openbox_config>' > ~/.config/openbox/rc.xml
openbox --config-file ~/.config/openbox/rc.xml &
sleep 3
xterm -fa 'Liberation Mono' -fs 10 -e "while true; do echo 'Keeping xterm open'; sleep 60; done" &
sleep 3
xdpyinfo || echo "xdpyinfo failed"
xrandr || echo "xrandr failed"
xwininfo -root -children || echo "xwininfo failed"

log "Setting up audio"
.github/scripts/setup_audio.sh

log "Resetting local Screenpipe state"
pkill -x screenpipe || true
rm -f screenpipe.pid screenpipe_output.log || true
rm -f ~/.screenpipe/db.sqlite ~/.screenpipe/db.sqlite-wal ~/.screenpipe/db.sqlite-shm || true

log "Running Screenpipe"
.github/scripts/run_screenpipe.sh

log "Testing OCR"
.github/scripts/test_ocr.sh

log "Testing Audio Capture"
.github/scripts/test_audio_capture.sh

log "Stopping Screenpipe"
.github/scripts/stop_screenpipe.sh

log "Checking for crashes and expected behavior"
.github/scripts/check_logs.sh

log "Checking final storage usage"
du -ha ~/.screenpipe/data
