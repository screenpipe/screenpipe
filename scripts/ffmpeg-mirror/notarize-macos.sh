#!/bin/bash
# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
set -euo pipefail
umask 077

archives="${1:?Pass the archive directory}"
receipts="${2:?Pass the receipts directory}"
mkdir -p "$receipts"

tmp="$(mktemp -d)"
trap 'security delete-keychain "$tmp/mirror.keychain-db" >/dev/null 2>&1 || true' EXIT
export MIRROR_KEYCHAIN="$tmp/mirror.keychain-db"
security create-keychain -p '' "$MIRROR_KEYCHAIN"
security unlock-keychain -p '' "$MIRROR_KEYCHAIN"

/usr/bin/expect <<'TCL'
log_user 0
set timeout 120
spawn xcrun notarytool store-credentials screenpipe-ffmpeg-mirror --apple-id $env(APPLE_ID) --team-id $env(APPLE_TEAM_ID) --keychain $env(MIRROR_KEYCHAIN)
expect {
  -re {(?i)password[^:\r\n]*:} { send -- "$env(APPLE_PASSWORD)\r" }
  timeout { exit 1 }
  eof { exit 1 }
}
expect {
  eof { exit [lindex [wait] 3] }
  timeout { exit 1 }
}
TCL


submit() {
  local archive="$1" result="$receipts/$(basename "$1" .zip).json"
  xcrun notarytool submit "$archive" --keychain-profile screenpipe-ffmpeg-mirror \
    --keychain "$MIRROR_KEYCHAIN" --wait --timeout 10m --output-format json > "$result"
  python3 - "$result" <<'PYTEST'
import json
import sys
with open(sys.argv[1]) as stream:
    result = json.load(stream)
print("Notarization:", result["status"], result["id"])
if result["status"] != "Accepted":
    raise SystemExit("FFmpeg archive was not accepted")
PYTEST
}

submit "$archives/ffmpeg-8.1.3-macos-arm64.zip" &
arm_job=$!
submit "$archives/ffmpeg-8.1.3-macos-x86_64.zip" &
intel_job=$!
wait "$arm_job"
wait "$intel_job"
