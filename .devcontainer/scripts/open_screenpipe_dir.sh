#!/bin/bash
set -euo pipefail

TARGET_DIR="$HOME/.screenpipe"
mkdir -p "$TARGET_DIR"

if command -v nautilus >/dev/null 2>&1; then
    exec nautilus "$TARGET_DIR"
fi

exec xdg-open "$TARGET_DIR"
