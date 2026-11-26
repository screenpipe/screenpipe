#!/bin/bash
# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
set -euo pipefail
umask 077

binaries="${1:?Pass a directory with the built pair}"
destination="${2:?Pass the output ZIP path}"
tmp="$(mktemp -d)"
trap 'security delete-keychain "$tmp/mirror.keychain-db" >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT

# Keep the certificate and its password out of process arguments.
printf '%s' "$APPLE_CERTIFICATE" | base64 --decode > "$tmp/input.p12"
openssl pkcs12 -in "$tmp/input.p12" -passin env:APPLE_CERTIFICATE_PASSWORD -nodes -out "$tmp/input.pem"
# Apple Security does not import OpenSSL's default PKCS#12 encryption on all runners.
openssl pkcs12 -export -in "$tmp/input.pem" -passout pass: \
  -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 -out "$tmp/import.p12"
rm -f "$tmp/input.p12" "$tmp/input.pem"

export MIRROR_KEYCHAIN="$tmp/mirror.keychain-db"
security create-keychain -p '' "$MIRROR_KEYCHAIN"
security unlock-keychain -p '' "$MIRROR_KEYCHAIN"
security import "$tmp/import.p12" -k "$MIRROR_KEYCHAIN" -P '' -T /usr/bin/codesign
rm -f "$tmp/import.p12"
security set-key-partition-list -S apple-tool:,apple: -s -k '' "$MIRROR_KEYCHAIN" >/dev/null

for program in ffmpeg ffprobe; do
  codesign --force --options runtime --timestamp --keychain "$MIRROR_KEYCHAIN" \
    --sign "$APPLE_SIGNING_IDENTITY" "$binaries/$program"
  codesign --verify --strict "$binaries/$program"
done
ditto -c -k --norsrc "$binaries" "$destination"

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

xcrun notarytool submit "$destination" --keychain-profile screenpipe-ffmpeg-mirror \
  --keychain "$MIRROR_KEYCHAIN" --wait --output-format json > "$tmp/notary-result.json"
python3 - "$tmp/notary-result.json" <<'PY'
import json
import sys
with open(sys.argv[1]) as stream:
    result = json.load(stream)
print("Notarization:", result["status"], result["id"])
if result["status"] != "Accepted":
    raise SystemExit("FFmpeg archive was not accepted")
PY
