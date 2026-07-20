# Linux desktop with AT-SPI2 for testing screenpipe accessibility
# Access via browser at http://localhost:6080
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=en_US.UTF-8

# Core desktop + VNC + noVNC
RUN apt-get update && apt-get install -y \
    # Desktop environment (lightweight)
    xfce4 xfce4-terminal dbus-x11 \
    # VNC server + web client
    tigervnc-standalone-server tigervnc-common novnc websockify \
    # AT-SPI2 accessibility (what we're testing)
    at-spi2-core libatspi2.0-dev libatk1.0-dev \
    # Build tools for Rust
    build-essential pkg-config curl git \
    # Screenpipe native deps
    libssl-dev libasound2-dev libavcodec-dev libavformat-dev \
    libavutil-dev libswresample-dev libavdevice-dev \
    libxdo-dev libdbus-1-dev libxcb1-dev libxcb-randr0-dev \
    libx11-dev libxi-dev libxtst-dev libclang-dev \
    # For clipboard/input testing
    xclip xsel xdotool \
    # Misc
    locales sudo procps htop firefox \
    && locale-gen en_US.UTF-8 \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Install Rust
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \
    sh -s -- -y --default-toolchain stable
ENV PATH="/root/.cargo/bin:${PATH}"

# VNC setup - no password for local testing
RUN mkdir -p /root/.vnc && \
    echo "#!/bin/sh" > /root/.vnc/xstartup && \
    echo "unset SESSION_MANAGER" >> /root/.vnc/xstartup && \
    echo "unset DBUS_SESSION_BUS_ADDRESS" >> /root/.vnc/xstartup && \
    echo 'eval $(dbus-launch --sh-syntax)' >> /root/.vnc/xstartup && \
    echo "export XDG_SESSION_TYPE=x11" >> /root/.vnc/xstartup && \
    echo "# Start AT-SPI2 registry for accessibility" >> /root/.vnc/xstartup && \
    echo '/usr/libexec/at-spi2-registryd &' >> /root/.vnc/xstartup && \
    echo "export GTK_MODULES=gail:atk-bridge" >> /root/.vnc/xstartup && \
    echo "export QT_ACCESSIBILITY=1" >> /root/.vnc/xstartup && \
    echo "exec startxfce4" >> /root/.vnc/xstartup && \
    chmod +x /root/.vnc/xstartup

# Entrypoint script
RUN echo '#!/bin/bash' > /start.sh && \
    echo 'set -e' >> /start.sh && \
    echo '# Kill stale VNC if any' >> /start.sh && \
    echo 'vncserver -kill :1 2>/dev/null || true' >> /start.sh && \
    echo 'rm -f /tmp/.X1-lock /tmp/.X11-unix/X1 2>/dev/null' >> /start.sh && \
    echo '# Start VNC (geometry = desktop resolution)' >> /start.sh && \
    echo 'vncserver :1 -geometry 1280x720 -depth 24 -SecurityTypes None --I-KNOW-THIS-IS-INSECURE' >> /start.sh && \
    echo 'export DISPLAY=:1' >> /start.sh && \
    echo '# Start noVNC (web-based VNC client)' >> /start.sh && \
    echo 'websockify --web /usr/share/novnc 6080 localhost:5901 &' >> /start.sh && \
    echo 'echo "============================================"' >> /start.sh && \
    echo 'echo "Desktop ready! Open http://localhost:6080"' >> /start.sh && \
    echo 'echo "============================================"' >> /start.sh && \
    echo '# Keep container alive' >> /start.sh && \
    echo 'exec bash' >> /start.sh && \
    chmod +x /start.sh

WORKDIR /screenpipe
EXPOSE 6080

CMD ["/start.sh"]
