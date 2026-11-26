#!/bin/bash
# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
set -euo pipefail

root="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$root/sources"
cd "$root/sources"

fetch() {
  local url="$1" file="$2" sha256="$3"
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --retry 3 --output "$file.part" "$url"
  printf '%s  %s\n' "$sha256" "$file.part" | shasum -a 256 -c -
  mv "$file.part" "$file"
}

# Release archives and checksums cross-checked against Homebrew's stable source metadata.
fetch https://ffmpeg.org/releases/ffmpeg-8.1.3.tar.xz ffmpeg-8.1.3.tar.xz \
  7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3
fetch https://github.com/Multicorewareinc/x265/releases/download/4.3/x265_4.3.tar.gz x265_4.3.tar.gz \
  83c53e4c8bbb8f1e33ed59e10a7d621d1d7801ca853910c3eb41f038b8ffb121
fetch https://distfiles.ariadne.space/pkgconf/pkgconf-3.0.11.tar.xz pkgconf-3.0.11.tar.xz \
  d0cd841bc8e55b9da888106c00dc256d05b7d1d8e5a46f4be4eb4c5125bd2dc4

x264_revision=b35605ace3ddf7c1a5d67a2eb553f034aef41d55
x264_repo="$(mktemp -d)"
trap 'rm -rf "$x264_repo"' EXIT
git -C "$x264_repo" init -q
git -C "$x264_repo" fetch --depth=1 https://code.videolan.org/videolan/x264.git "$x264_revision"
test "$(git -C "$x264_repo" rev-parse FETCH_HEAD)" = "$x264_revision"
git -C "$x264_repo" archive --prefix=x264-b35605ace3dd/ "$x264_revision" | gzip -n > x264-b35605ace3dd.tar.gz
