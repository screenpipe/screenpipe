#!/bin/bash
sudo apt-get update
sudo apt-get install -y xvfb x11-xserver-utils ffmpeg libasound2-dev libgtk-3-dev libavformat-dev libavfilter-dev libavdevice-dev x11-utils x11-apps xdotool sqlite3 openbox xterm fonts-liberation tesseract-ocr libtesseract-dev imagemagick fonts-dejavu alsa-utils pulseaudio pulseaudio-utils libxdo-dev libpipewire-0.3-dev libgbm-dev libwayland-dev libegl-dev libopenblas-dev

# antirez-asr-sys build script emits -llibopenblas (double lib prefix).
# Create a symlink so the linker finds it, and set OPENBLAS_PATH with lib/ subdir.
sudo mkdir -p /usr/lib/x86_64-linux-gnu/openblas/lib
sudo ln -sf /usr/lib/x86_64-linux-gnu/libopenblas.so /usr/lib/x86_64-linux-gnu/liblibopenblas.so
sudo ln -sf /usr/lib/x86_64-linux-gnu/libopenblas.a /usr/lib/x86_64-linux-gnu/liblibopenblas.a
sudo ln -sf /usr/lib/x86_64-linux-gnu/libopenblas.so /usr/lib/x86_64-linux-gnu/openblas/lib/liblibopenblas.so
sudo ln -sf /usr/lib/x86_64-linux-gnu/libopenblas.a /usr/lib/x86_64-linux-gnu/openblas/lib/liblibopenblas.a
if [ -n "$GITHUB_ENV" ]; then
  echo "OPENBLAS_PATH=/usr/lib/x86_64-linux-gnu/openblas" >> "$GITHUB_ENV"
fi
export OPENBLAS_PATH=/usr/lib/x86_64-linux-gnu/openblas
