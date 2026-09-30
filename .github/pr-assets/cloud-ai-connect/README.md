# Cloud AI connection screenshots

24 screenshots of real production React components in an isolated browser preview with synthetic account/device data. These are component previews, not authenticated live sessions or native Tauri screenshots.

Placement: Settings → Account, replacing Data Sync.

Baseline recreated from `f1bcd5bbbb9d838e471cb73e3ec0e88316ef89e7` before editing. Website baseline uses the original DataSyncSetting with a synthetic Clerk user. Desktop baseline uses the exact Data Sync card from AccountSection with fixture inputs. Product CSS and fonts are loaded in both versions.

Desktop viewport: 1000 × 900. Compact/mobile: 390 × 844. America/Los_Angeles. Reduced motion enabled. Before/after use the same viewport and theme. No real account was connected, synced, or deleted.

The card reports saved sync state, not live transfer progress or verified client authentication. There is intentionally no simulated “Connected” screenshot. Codex uses the copyable add/login command; Claude uses a copyable URL and its connector settings. Real-client OAuth remains a release verification step.

- [desktop-after-off](desktop-after-off.png)
- [desktop-before-off](desktop-before-off.png)
- [desktop-before-on](desktop-before-on.png)
- [desktop-claude-copied](desktop-claude-copied.png)
- [desktop-claude-setup](desktop-claude-setup.png)
- [desktop-codex-copied](desktop-codex-copied.png)
- [desktop-codex-setup](desktop-codex-setup.png)
- [desktop-compact-before](desktop-compact-before.png)
- [desktop-compact-claude](desktop-compact-claude.png)
- [desktop-compact-consent](desktop-compact-consent.png)
- [desktop-compact](desktop-compact.png)
- [desktop-consent](desktop-consent.png)
- [desktop-dark-setup](desktop-dark-setup.png)
- [desktop-dark](desktop-dark.png)
- [desktop-devices-error](desktop-devices-error.png)
- [desktop-devices-loading](desktop-devices-loading.png)
- [desktop-error](desktop-error.png)
- [desktop-keyboard-focus](desktop-keyboard-focus.png)
- [desktop-manage](desktop-manage.png)
- [desktop-open-error](desktop-open-error.png)
- [desktop-save-error](desktop-save-error.png)
- [desktop-saving](desktop-saving.png)
- [desktop-sync-on](desktop-sync-on.png)
- [desktop-waiting-for-upload](desktop-waiting-for-upload.png)

## Updated setup flow, September 25

Recaptured after automatic desktop config setup and chat-message fallbacks. 28 images. Native writes and client authentication are fixture outcomes in these component screenshots; no live customer settings were changed. Native filesystem and OAuth end-to-end verification remain pending.

- `components/cloud-ai-connection-card.tsx` SHA256 `1260d1c2260eff809e610c4405bc09428d4a57a852f7e5a34140a3c47bfbd03b`

- `components/cloud-ai-client-setup.tsx` SHA256 `4f4ec8de4c79d755a2fb8a32a04980828c47a16a3e174143a6a873668dd9a913`
