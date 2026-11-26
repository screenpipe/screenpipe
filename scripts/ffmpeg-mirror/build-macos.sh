#!/bin/bash
# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
set -euo pipefail

root="$(cd "$(dirname "$0")" && pwd)"
arch_name="${1:?Pass arm64 or x86_64}"
case "$arch_name" in
  arm64) host=aarch64-apple-darwin; host_arch=aarch64 ;;
  x86_64) host=x86_64-apple-darwin; host_arch=x86_64 ;;
  *) echo "Unsupported architecture" >&2; exit 2 ;;
esac
jobs="${BUILD_JOBS:-7}"
build="$root/build-$arch_name"
prefix="$build/prefix"
source="$root/sources"
mkdir -p "$build" "$prefix" "$root/tools"
tar -xzf "$source/x264-b35605ace3dd.tar.gz" -C "$build"
tar -xzf "$source/x265_4.3.tar.gz" -C "$build"
tar -xJf "$source/ffmpeg-8.1.3.tar.xz" -C "$build"
tar -xJf "$source/pkgconf-3.0.11.tar.xz" -C "$build"
(
  cd "$build/pkgconf-3.0.11"
  ./configure --prefix="$root/tools"
  make -j"$jobs"
  make install
)

export MACOSX_DEPLOYMENT_TARGET=11.0
export CC=clang
export CFLAGS="-arch $arch_name"
export LDFLAGS="-arch $arch_name"
(
  cd "$build/x264-b35605ace3dd"
  ./configure --prefix="$prefix" --host="$host" --enable-static --enable-pic --disable-asm --disable-cli
  make -j"$jobs"
  make install
)
cmake -S "$build/x265_4.3/source" -B "$build/x265-cmake"   -DCMAKE_SYSTEM_NAME=Darwin -DCMAKE_SYSTEM_PROCESSOR="$arch_name"   -DCMAKE_OSX_ARCHITECTURES="$arch_name" -DCMAKE_OSX_DEPLOYMENT_TARGET="$MACOSX_DEPLOYMENT_TARGET"   -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$prefix"   -DENABLE_SHARED=OFF -DENABLE_CLI=OFF -DENABLE_ASSEMBLY=OFF -DENABLE_LIBNUMA=OFF
cmake --build "$build/x265-cmake" --parallel "$jobs"
cmake --install "$build/x265-cmake"

(
  cd "$build/ffmpeg-8.1.3"
  export PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig"
  ./configure --cc=clang --arch="$host_arch" --target-os=darwin --enable-cross-compile     --extra-cflags="-arch $arch_name" --extra-ldflags="-arch $arch_name"     --pkg-config="$root/tools/bin/pkgconf" --pkg-config-flags=--static     --enable-gpl --enable-libx264 --enable-libx265 --enable-videotoolbox --enable-audiotoolbox     --disable-x86asm --disable-autodetect --disable-debug --disable-doc --disable-ffplay     --extra-libs=-lc++
  make -j"$jobs" ffmpeg ffprobe
  mkdir -p "$root/artifacts/$arch_name"
  install -m 0755 ffmpeg ffprobe "$root/artifacts/$arch_name/"
)
