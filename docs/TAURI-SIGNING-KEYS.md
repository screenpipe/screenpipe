# Regenerating Tauri updater signing keys

The app updater uses a **minisign** key pair. The private key is used at build time to sign update artifacts; the public key is embedded in the app so it can verify updates.

If the private key is lost, generate a new pair and update config + secrets as below.

## 1. Generate a new key pair

From the repo root (or from `apps/screenpipe-app-tauri`):

```bash
cd apps/screenpipe-app-tauri
bunx tauri signer generate -w ./screenpipe-updater.key
```

This creates:

- `screenpipe-updater.key` — **private key** (do not commit; use only in CI secrets).
- `screenpipe-updater.key.pub` — **public key** (contents go into config).

You can use a different path; `-w` is the path prefix for both files.

Optionally protect the private key with a password (recommended for CI). When prompted, set a password; you’ll store it in `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in GitHub.

## 2. Update the public key in config

Copy the **entire contents** of `screenpipe-updater.key.pub` (one line, base64-like). Set it in both:

- `apps/screenpipe-app-tauri/src-tauri/tauri.prod.conf.json` → `plugins.updater.pubkey`
- `apps/screenpipe-app-tauri/src-tauri/tauri.beta.conf.json` → `plugins.updater.pubkey`

So both configs have the same `pubkey` value.

## 3. Add GitHub Actions secrets

In the repo: **Settings → Secrets and variables → Actions**, add (or update):

| Secret name              | Value |
|--------------------------|--------|
| `TAURI_PRIVATE_KEY`      | Either the **path** to the private key file (e.g. `./screenpipe-updater.key`) or the **full PEM contents** (multi-line). For CI, inline PEM is usually used: paste the whole `-----BEGIN PRIVATE KEY-----` … `-----END PRIVATE KEY-----` block. |
| `TAURI_KEY_PASSWORD`     | The password you set in step 1, or leave empty if you did not set a password. |

The workflows use these as:

- `TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_PRIVATE_KEY }}`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_KEY_PASSWORD }}`

## 4. Secure the private key

- Delete `screenpipe-updater.key` from your machine once you’ve stored it in GitHub (and any backup you use).
- Do not commit `screenpipe-updater.key` or put the raw private key in repo or docs.
- You can add `*.key` to `.gitignore` if you keep a local copy.

## Note

After you rotate keys, **existing installed apps** still have the old public key. They will only trust updates signed with the old private key. So:

- Either keep the old private key long enough to sign one last update that tells users to upgrade to a build that embeds the new public key, or  
- Accept that users on the old key will need to install the next version manually (e.g. download from site); from that version on, auto-updates will use the new key.
