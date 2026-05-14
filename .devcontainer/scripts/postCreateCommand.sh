#!/bin/bash

# Define the alias
ALIAS_CMD="alias test-linux=\"/workspaces/screenpipe/.devcontainer/scripts/linux_integration.sh\""

# Add alias to .bashrc if it exists
grep -qxF "$ALIAS_CMD" ~/.bashrc || echo "$ALIAS_CMD" >> ~/.bashrc

# Add alias to .zshrc if it exists
grep -qxF "$ALIAS_CMD" ~/.zshrc || echo "$ALIAS_CMD" >> ~/.zshrc

# Ensure VNC sessions launch Fluxbox instead of openbox (which shows blank screen)
# Register fluxbox as x-session-manager so TigerVNC picks it up
sudo update-alternatives --set x-session-manager /usr/bin/fluxbox 2>/dev/null || true

cat > ~/.xsession <<'EOF'
#!/bin/sh
exec fluxbox
EOF
chmod +x ~/.xsession
