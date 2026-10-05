# Dropbox connection preview

Browser-mock captures of the real main-app Connections screen, 1280 × 900, dark theme. All sidebar/account data is fictional. Baseline: d9a778e354976edb7e91f5c56e782c2a1286ac13 before edits.

- connections-before.png / connections-after.png: Browse all apps, Documents category. The new row adds one grid row and changes the bottom-aligned scroll position.
- dropbox-card.png: connect prompt.
- dropbox-privacy.png: expanded cloud-processing disclosure.
- dropbox-connected.png: simulated connected account.
- dropbox-disconnected.png: disconnected again.

The card token was temporarily set to a synthetic fixture and the cloud status/authorize/disconnect responses were intercepted in Playwright. The browser used the existing mock engine and mock Tauri runtime. The fixture override was removed before committing. These images verify rendering and simulated state transitions, not live Dropbox OAuth or an installed-app deployment.
