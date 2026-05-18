#!/bin/bash
set -euo pipefail

# Ensure VNC sessions prefer fluxbox, which is stable in desktop-lite.
if command -v fluxbox >/dev/null 2>&1; then
    sudo update-alternatives --install /usr/bin/x-session-manager x-session-manager /usr/bin/fluxbox 60 2>/dev/null || true
    sudo update-alternatives --set x-session-manager /usr/bin/fluxbox 2>/dev/null || true
fi

cat > "$HOME/.xsession" <<'EOF'
#!/bin/sh
exec fluxbox
EOF
chmod +x "$HOME/.xsession"

# If VNC is already up, bounce display :1 so it relaunches with updated session.
if pgrep -f "Xtigervnc :1" >/dev/null 2>&1; then
    tigervncserver -kill :1 >/dev/null 2>&1 || true
fi
