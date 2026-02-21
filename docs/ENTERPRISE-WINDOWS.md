# Enterprise Windows deployment (RoboPack / Intune)

**Step-by-step guides:**  
- **Intune:** [ENTERPRISE-INTUNE.md](ENTERPRISE-INTUNE.md) — deploy as Win32 app with .intunewin.  
- **RoboPack:** [ENTERPRISE-ROBOPACK.md](ENTERPRISE-ROBOPACK.md) — deploy with Custom Package and .exe.

This doc covers the **why** (per-machine, offline, detection) and technical details (config, CI, local build). Use the guides above for straight deployment steps.

---

Enterprise builds install to **C:\Program Files\screenpipe\** (per-machine) and support silent install. They are delivered as a single **NSIS .exe**, which RoboPack accepts directly (Custom Package). No .intunewin required for RoboPack.

The enterprise build uses app identifier **`screenpi.pe.enterprise`**, so app data is stored separately from the consumer build (e.g. under the user profile for that identifier). Consumer and enterprise can be installed side by side without sharing data.

**Why no in-app updater?** Enterprise updates are delivered by IT (e.g. RoboPack), not by the app. So in `tauri.enterprise.conf.json`: **`createUpdaterArtifacts`** is `false` (we don’t build the .nsis.zip/.sig update payloads), and the **updater plugin** is disabled so the app never checks or installs updates itself. The UI (Settings, tray, menu) already hides update options for enterprise builds.

## What we fixed for RoboPack (vs. main-branch NSIS)

When testing the **main-branch** (consumer) NSIS installer with RoboPack, two issues appeared. The **enterprise** build fixes both by using a separate Tauri config (`tauri.enterprise.conf.json`) and a dedicated build path.

### 1. Package installed in user profile (not machine-wide)

- **Problem:** The consumer NSIS installer uses the default install mode (per-user). The app was installed only for the user who ran the install (e.g. under `%LocalAppData%` or user-specific paths), not for the whole computer. RoboPack/IT expect a single machine-wide install so all users get the app and detection rules work reliably (e.g. when detection runs as SYSTEM).
- **Fix:** In the enterprise config we set **`bundle.windows.nsis.installMode`** to **`"perMachine"`**. The enterprise NSIS installer then installs to **`C:\Program Files\screenpipe\`** for all users. Detection rule can use `C:\Program Files\screenpipe\screenpipe.exe` and works in system context; no per-user path.

### 2. Installation required internet access (not offline)

- **Problem:** The consumer installer relied on downloading the WebView runtime during setup when needed. On fully offline or locked-down machines, installation could fail or hang because the installer needed internet access.
- **Fix:** In the enterprise config we set **`bundle.windows.webviewInstallMode`** to **`{ "type": "offlineInstaller" }`**. The WebView is bundled or otherwise available offline, so the enterprise installer does **not** need internet during installation and works on air-gapped or restricted networks.

**Summary:** Use the **enterprise** NSIS build (from the enterprise workflow or the release-app enterprise step) for RoboPack—not the main-branch consumer .exe. The enterprise .exe is per-machine and offline-capable; the consumer .exe is per-user and may require internet for WebView.

### Why the .exe may show as “generic executable” (no publisher/signature)

The enterprise NSIS build is **not** Authenticode-signed by default. So:

- The file **is** an NSIS installer (same as other Tauri Windows builds), but without a Windows code signing certificate the .exe has no digital signature.
- Tools (GitHub, scanners, Windows) may label it as a generic executable or “unknown publisher,” and SmartScreen may warn when run from a download.

To get a signed installer (publisher name, no SmartScreen warning, clearer “installer” recognition):

1. Obtain a **Windows code signing certificate** (OV or EV from a CA; see [Microsoft’s docs](https://learn.microsoft.com/en-us/windows-hardware/drivers/dashboard/code-signing-cert-manage)).
2. In Tauri config (`tauri.enterprise.conf.json` or merged `tauri.windows.conf.json`), set under `bundle.windows`: `certificateThumbprint`, `digestAlgorithm`, `timestampUrl` (see [Tauri Windows signing](https://tauri.app/distribute/sign/windows/)).
3. In CI, before the build: import the .pfx into the runner’s certificate store using secrets (e.g. `WINDOWS_CERTIFICATE`, `WINDOWS_CERTIFICATE_PASSWORD`). Tauri will then run `signtool` during the build and produce a signed NSIS .exe.

Until that is set up, the enterprise .exe remains a valid NSIS installer; it is simply unsigned, so it is treated as a generic executable by the OS and some tools.

## RoboPack (NSIS) — ready

RoboPack accepts the NSIS installer as-is. Use a **Custom Package** and point it at the setup .exe.

| What | Value |
|------|--------|
| **Package** | Single file: `screenpipe-<version>-setup.exe` (e.g. from R2: `enterprise/releases/<version>/x86_64-pc-windows-msvc/`) |
| **Install command** | `screenpipe-<version>-setup.exe /S` (silent; replace `<version>` with the actual version from the filename) |
| **Detection** | File exists: `C:\Program Files\screenpipe\screenpipe.exe` |
| **Uninstall (optional)** | `"C:\Program Files\screenpipe\uninstall.exe" /S` |

Upgrades: deploy a newer version’s .exe with the same install command; NSIS upgrades in place (see [Upgrading (version A → A2)](#upgrading-version-a--a2)).

## Where to get the installer

- **Stable enterprise:** `https://screenpi.pe` → Enterprise / IT install (or your R2 path: `enterprise/releases/<version>/x86_64-pc-windows-msvc/`).
- For **RoboPack:** use the **.exe** (NSIS) only. For Intune you can instead use a .intunewin wrapper (see below).

## Install command (silent)

```text
screenpipe-<version>-setup.exe /S
```

Example: `screenpipe-2.50.3-setup.exe /S`  
Replace `<version>` with the actual version (e.g. from the filename).

## Detection rule (RoboPack / MDM)

Use a **file** detection rule so the deployment tool can verify the install (avoids rollback):

| Setting    | Value |
|-----------|--------|
| **Type**  | File |
| **Path**  | `C:\Program Files\screenpipe\screenpipe.exe` |
| **Detection** | File or folder exists |

- Do **not** use `%LocalAppData%\screenpipe\` — the consumer build uses that; the enterprise build uses Program Files.
- When detection runs as SYSTEM, `C:\Program Files\screenpipe\screenpipe.exe` is stable and visible.

## Upgrading (version A → A2)

When a newer enterprise build (e.g. **A2**) is installed on a machine that already has an older version (**A**), the NSIS installer treats it as an **upgrade**:

- **Same product:** identifier `screenpi.pe.enterprise` and install path `C:\Program Files\screenpipe\` are unchanged.
- **In-place replace:** the installer overwrites the existing files and updates the Add/Remove Programs entry to the new version. No need to uninstall first.
- **Pre-install hook:** before replacing files, the installer runs `windows/hooks.nsh`, which stops any running Screenpipe processes (`screenpipe.exe`, `screenpipe-app.exe`) so files are not locked.
- **User data:** app data (e.g. under the user profile for `screenpi.pe.enterprise`) is left as-is; only the binaries under Program Files are updated.

So you can deploy the new version’s setup (e.g. `screenpipe-2.50.4-setup.exe /S`) over an existing install; it will upgrade in place. Detection rule can stay “File exists: `C:\Program Files\screenpipe\screenpipe.exe`” (optionally with a version check if your tool supports it).

## Uninstall (optional)

Uninstaller path (for RoboPack/MDM uninstall command or scripts):

```text
"C:\Program Files\screenpipe\uninstall.exe"
```

## Using .intunewin (Intune only)

If you use **Microsoft Intune** and have a **.intunewin** file (same content as the NSIS .exe, wrapped for Intune):

1. In Intune: Apps → Windows → Add → **Win32 app** → upload the .intunewin.
2. Set **Install command**: `screenpipe-<version>-setup.exe /S` (match the setup exe name inside the package).
3. Set **Detection rule** as above: File, `C:\Program Files\screenpipe\screenpipe.exe`, exists.
4. Assign to users or devices.

For **RoboPack** you do **not** need .intunewin; use the .exe directly as in the [RoboPack (NSIS)](#robopack-nsis--ready) section.

---

## What the enterprise build considers (config + code)

Summary of how the **enterprise** variant is defined and how the app behaves when `identifier === "screenpi.pe.enterprise"`:

| Area | What |
|------|------|
| **Identity** | `tauri.enterprise.conf.json`: `identifier`: `"screenpi.pe.enterprise"`, `productName`: `"screenpipe"`. App data (config, DB, etc.) lives under the profile for this identifier, separate from consumer. |
| **Bundle** | `createUpdaterArtifacts`: `false` (no .nsis.zip/.sig). `publisher`: `"Screenpipe Inc."`. Windows: `nsis.installMode`: `"perMachine"`, `webviewInstallMode`: `"offlineInstaller"`. NSIS hooks come from merged `tauri.windows.conf.json` (kill processes before install/upgrade). |
| **Updater** | Config: `plugins.updater` → `active: false`. Rust: `updates::is_enterprise_build()` → no update check, no periodic check. Tray and app menu: no “Check for updates” / update item. |
| **UI** | `useIsEnterpriseBuild()` (frontend) / `is_enterprise_build_cmd` (backend): Settings hide “Auto-update” and “Version” (rollback); update banner never shown. |
| **CI** | `.github/workflows/release-app.yml`: after stable Windows build, rebuild with enterprise config, create .intunewin via IntuneWinAppUtil, then upload NSIS `*.exe`/`*.nsis.zip`/`*.sig` and `*.intunewin` to R2 `enterprise/releases/<version>/x86_64-pc-windows-msvc/`. RoboPack uses the .exe; Intune uses the .intunewin. |

So: one NSIS .exe per version, silent `/S`, per-machine path, offline WebView, no in-app updater, and RoboPack can use the .exe as a Custom Package with the install command and detection rule above.

---

# Full local setup: build → Intune (Windows VM)

Use this flow on a **local Windows VM** (or physical Windows PC) to build the enterprise installer, test it, create a .intunewin, and deploy via Intune before handing to customers.

## Part 1: Build the enterprise installer

1. **Clone and open the repo** (if not already):
   ```powershell
   cd C:\path\to\screenpipe   # or wherever you cloned
   ```

2. **Use the enterprise config:**
   ```powershell
   cd apps\screenpipe-app-tauri\src-tauri
   copy tauri.enterprise.conf.json tauri.conf.json
   cd ..\..
   ```

3. **Install deps and build** (from repo root; you need Node/bun, Rust, VS/Windows SDK):
   ```powershell
   cd apps\screenpipe-app-tauri
   bun install
   bunx tauri build --target x86_64-pc-windows-msvc --features mkl,official-build
   ```
   If build fails for missing VS/Windows SDK, install the required tools first. On success you get:
   ```text
   apps\screenpipe-app-tauri\src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis\screenpipe-2.x.x-setup.exe
   ```

4. **Check the exe exists and note the exact filename:**
   ```powershell
   dir apps\screenpipe-app-tauri\src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis\*.exe
   ```
   Use this filename (e.g. `screenpipe-2.50.3-setup.exe`) for the install command in Intune.

---

## Part 2: Test the installer locally (optional)

5. **Install silently:**
   ```powershell
   .\apps\screenpipe-app-tauri\src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis\screenpipe-2.x.x-setup.exe /S
   ```
   Replace `2.x.x` with your real version.

6. **Confirm detection path:**
   ```powershell
   Test-Path "C:\Program Files\screenpipe\screenpipe.exe"
   ```
   Should be `True`. Open the app once to confirm it runs.

7. **Uninstall (optional):**
   ```powershell
   & "C:\Program Files\screenpipe\uninstall.exe" /S
   ```

---

## Part 3: Create the .intunewin

**Option A — Use the script (from repo):**  
From `apps/screenpipe-app-tauri` run:
```powershell
.\scripts\exe-to-intunewin.ps1
```
This uses the built exe in `src-tauri\target\...\bundle\nsis\*setup*.exe`. Or pass `-SetupExe "C:\path\to\screenpipe-2.x.x-setup.exe"` and optionally `-OutDir "C:\intunewin\out"`. The script downloads IntuneWinAppUtil if needed and writes the `.intunewin` to `scripts\intunewin\out\` (or your `-OutDir`).

**Option B — Manual:**

8. **Download Microsoft’s tool:**
   - Open: https://github.com/microsoft/Microsoft-Win32-Content-Prep-Tool  
   - Download **IntuneWinAppUtil.exe** (from the repo or Releases) and put it in a folder, e.g. `C:\intunewin\`.

9. **Prepare a folder with only the setup exe:**
   ```powershell
   $nsis = "C:\path\to\screenpipe\apps\screenpipe-app-tauri\src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis"
   New-Item -ItemType Directory -Force -Path C:\intunewin\package
   $setupName = (Get-ChildItem "$nsis\*setup*.exe").Name
   Copy-Item "$nsis\$setupName" -Destination "C:\intunewin\package\$setupName"
   ```
   You should have only one file in `C:\intunewin\package\`: e.g. `screenpipe-2.50.3-setup.exe`.

10. **Run the tool:**
    ```powershell
    New-Item -ItemType Directory -Force -Path C:\intunewin\out
    cd C:\intunewin
    .\IntuneWinAppUtil.exe -c C:\intunewin\package -s C:\intunewin\package\screenpipe-2.x.x-setup.exe -o C:\intunewin\out -q
    ```
    Replace `screenpipe-2.x.x-setup.exe` with your actual filename. A `.intunewin` file will appear in `C:\intunewin\out\`.

---

## Part 4: Add the app in Intune and install on a device

11. **Open Intune:**
    - Go to https://endpoint.microsoft.com  
    - Sign in with an account that has Intune admin (or use a [Microsoft 365 dev tenant](https://developer.microsoft.com/en-us/microsoft-365/dev-program)).

12. **Create the Win32 app:**
    - **Apps** → **Windows** → **Add** → **Win32 app** (or **Apps** → **All apps** → **Add** → **App type** → **Windows app (Win32)**).
    - **Select file:** upload the `.intunewin` from `C:\intunewin\out\`.
    - **App information:** fill name (e.g. “Screenpipe”), publisher, etc. → **Next**.

13. **Program (install/uninstall):**
    - **Install command:** `screenpipe-2.x.x-setup.exe /S` (exact exe name from your build).
    - **Uninstall command (optional):** `"C:\Program Files\screenpipe\uninstall.exe" /S`
    - **Next**.

14. **Requirements:** leave defaults (e.g. Windows 10 1607+) → **Next**.

15. **Detection rules (important):**
    - **Rule type:** File  
    - **Path:** `C:\Program Files\screenpipe\screenpipe.exe`  
    - **File or folder:** File (or “File or folder exists”)  
    - **Next** through the rest → **Create**.

16. **Assign:**
    - Open the app you just created → **Assignments** → **Add group**.
    - Choose **Required** (or **Available** for Company Portal).
    - Select a group that contains your test user (or your VM’s user). Save.

17. **On the same VM (or another enrolled device):**
    - Ensure the device is **enrolled in Intune** (Azure AD joined, hybrid joined, or MDM-enrolled).
    - Wait for sync (a few minutes) or: **Settings** → **Accounts** → **Access work or school** → **Sync**.
    - The app should install automatically (or appear in Company Portal if you chose Available). Verify:
      ```powershell
      Test-Path "C:\Program Files\screenpipe\screenpipe.exe"
      ```

18. **In Intune:**  
    **Apps** → your Screenpipe app → **Device status** / **User status** → confirm **Installed** (no rollback).

---

## One-page cheat sheet

| Step | What |
|------|------|
| 1 | On VM: `copy tauri.enterprise.conf.json → tauri.conf.json` in `src-tauri`, then `bunx tauri build` from `apps/screenpipe-app-tauri`. |
| 2 | Note the built exe name in `…\bundle\nsis\` (e.g. `screenpipe-2.50.3-setup.exe`). |
| 3 | (Optional) Run that exe with `/S`, confirm `C:\Program Files\screenpipe\screenpipe.exe` exists, then uninstall. |
| 4 | Download IntuneWinAppUtil.exe; put only the setup exe in a folder; run `-c` that folder `-s` that exe `-o` output folder `-q`. |
| 5 | In Intune: Apps → Windows → Add → Win32 app → upload .intunewin. |
| 6 | Install command: `screenpipe-<version>-setup.exe /S`. Detection: File, `C:\Program Files\screenpipe\screenpipe.exe`, exists. |
| 7 | Assign to a group that includes your test user/device. |
| 8 | Sync the device; confirm app installs and Intune shows “Installed.” |

The CI workflow (`.github/workflows/release-app.yml`) does the same build, creates the .intunewin in-pipeline, and uploads both the NSIS .exe and the .intunewin to R2. For RoboPack use the .exe; for Intune download the .intunewin from R2 and go to Part 4 in the Intune portal. You can also do Part 1 + Part 3 on a VM if needed.
