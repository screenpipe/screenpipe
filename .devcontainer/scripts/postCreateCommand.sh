#!/bin/bash

# Define the alias
ALIAS_CMD="alias test-linux=\"/workspaces/screenpipe/.devcontainer/scripts/linux_integration.sh\""
DEV_ALIAS_CMD="alias dev-screenpipe=\"/workspaces/screenpipe/.devcontainer/scripts/dev_screenpipe.sh\""
BROWSER_ALIAS_CMD="alias open-browser=\"/workspaces/screenpipe/.devcontainer/scripts/open_browser.sh\""
DATA_ALIAS_CMD="alias open-screenpipe-data=\"/workspaces/screenpipe/.devcontainer/scripts/open_screenpipe_dir.sh\""

# Add alias to .bashrc if it exists
grep -qxF "$ALIAS_CMD" ~/.bashrc || echo "$ALIAS_CMD" >> ~/.bashrc
grep -qxF "$DEV_ALIAS_CMD" ~/.bashrc || echo "$DEV_ALIAS_CMD" >> ~/.bashrc
grep -qxF "$BROWSER_ALIAS_CMD" ~/.bashrc || echo "$BROWSER_ALIAS_CMD" >> ~/.bashrc
grep -qxF "$DATA_ALIAS_CMD" ~/.bashrc || echo "$DATA_ALIAS_CMD" >> ~/.bashrc

# Add alias to .zshrc if it exists
grep -qxF "$ALIAS_CMD" ~/.zshrc || echo "$ALIAS_CMD" >> ~/.zshrc
grep -qxF "$DEV_ALIAS_CMD" ~/.zshrc || echo "$DEV_ALIAS_CMD" >> ~/.zshrc
grep -qxF "$BROWSER_ALIAS_CMD" ~/.zshrc || echo "$BROWSER_ALIAS_CMD" >> ~/.zshrc
grep -qxF "$DATA_ALIAS_CMD" ~/.zshrc || echo "$DATA_ALIAS_CMD" >> ~/.zshrc

# Ensure VNC sessions launch Fluxbox instead of openbox (which shows blank screen)
# Register fluxbox as x-session-manager so TigerVNC picks it up
if command -v fluxbox >/dev/null 2>&1; then
	sudo update-alternatives --install /usr/bin/x-session-manager x-session-manager /usr/bin/fluxbox 60 2>/dev/null || true
	sudo update-alternatives --set x-session-manager /usr/bin/fluxbox 2>/dev/null || true
fi

cat > ~/.xsession <<'EOF'
#!/bin/sh
exec fluxbox
EOF
chmod +x ~/.xsession

mkdir -p ~/.local/share/applications
cat > ~/.local/share/applications/falkon-container.desktop <<'EOF'
[Desktop Entry]
Name=Falkon (Container)
Comment=Container-safe browser launcher
Exec=/workspaces/screenpipe/.devcontainer/scripts/open_browser.sh %u
Terminal=false
Type=Application
Icon=internet-web-browser
Categories=Network;WebBrowser;
MimeType=text/html;text/xml;application/xhtml+xml;x-scheme-handler/http;x-scheme-handler/https;
EOF

cat > ~/.local/share/applications/screenpipe-data.desktop <<'EOF'
[Desktop Entry]
Name=Screenpipe Data Folder
Comment=Open ~/.screenpipe in file browser
Exec=/workspaces/screenpipe/.devcontainer/scripts/open_screenpipe_dir.sh
Terminal=false
Type=Application
Icon=folder
Categories=Utility;FileManager;
EOF

chmod +x /workspaces/screenpipe/.devcontainer/scripts/open_browser.sh
chmod +x /workspaces/screenpipe/.devcontainer/scripts/open_screenpipe_dir.sh

mkdir -p "$HOME/Desktop"
ln -sfn "$HOME/.screenpipe" "$HOME/Desktop/screenpipe-data"
cat > "$HOME/Desktop/Screenpipe Data.desktop" <<'EOF'
[Desktop Entry]
Name=Open Screenpipe Data
Comment=Open ~/.screenpipe in file browser
Exec=/workspaces/screenpipe/.devcontainer/scripts/open_screenpipe_dir.sh
Terminal=false
Type=Application
Icon=folder
Categories=Utility;FileManager;
EOF
chmod +x "$HOME/Desktop/Screenpipe Data.desktop"

update-desktop-database ~/.local/share/applications >/dev/null 2>&1 || true
xdg-settings set default-web-browser falkon-container.desktop >/dev/null 2>&1 || true
