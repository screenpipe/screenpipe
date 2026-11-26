#!/bin/bash
# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
set -euo pipefail

root="$(cd "$(dirname "$0")" && pwd)"
arch_name="${1:?Pass the built architecture}"
output="${2:?Pass the directory for release assets}"
build="$root/build-$arch_name"
binaries="$root/artifacts/$arch_name"
mkdir -p "$output" "$binaries/licenses"
cp "$build/ffmpeg-8.1.3/COPYING.GPLv2" "$binaries/licenses/FFmpeg-GPL-2.0.txt"
cp "$build/x264-b35605ace3dd/COPYING" "$binaries/licenses/x264-GPL-2.0.txt"
cp "$build/x265_4.3/COPYING" "$binaries/licenses/x265-GPL-2.0.txt"
cat > "$binaries/README.txt" <<'NOTICE'
Screenpipe FFmpeg mirror for macOS

FFmpeg 8.1.3, x264 b35605ace3dd, and x265 4.3 are redistributed under the
GNU General Public License. See the notices in licenses/.

Corresponding source and build scripts:
https://downloads.screenpipe.com/ffmpeg/8.1.3-screenpipe.1/source.tar.gz
NOTICE

if [[ "$arch_name" == arm64 ]]; then
  tar -czf "$output/source.tar.gz" -C "$root" sources build-macos.sh fetch-sources.sh smoke-macos.sh package-macos.sh
fi
