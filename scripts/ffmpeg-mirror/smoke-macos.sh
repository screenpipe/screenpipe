#!/bin/bash
# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
set -euo pipefail

binaries="${1:?Pass the directory containing ffmpeg and ffprobe}"
arch_name="${2:?Pass the expected architecture}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

for program in ffmpeg ffprobe; do
  test "$(lipo -archs "$binaries/$program")" = "$arch_name"
  "$binaries/$program" -version | sed -n '1p'
done
for codec in libx264 libx265; do
  "$binaries/ffmpeg" -hide_banner -loglevel error -f lavfi -i color=s=128x128:r=5 \
    -f lavfi -i sine=frequency=1000 -t 1 -pix_fmt yuv420p -c:v "$codec" -c:a aac "$tmp/$codec.mp4"
  test "$("$binaries/ffprobe" -v error -select_streams v:0 -show_entries stream=width \
    -of default=noprint_wrappers=1:nokey=1 "$tmp/$codec.mp4")" = 128
  "$binaries/ffmpeg" -v error -i "$tmp/$codec.mp4" -frames:v 1 "$tmp/$codec.jpg"
  test -s "$tmp/$codec.jpg"
done
