; x64.nsh provides ${DisableX64FSRedirection} / ${EnableX64FSRedirection}.
; It has its own include guard so repeated inclusion is safe.
!include "x64.nsh"

; ---------------------------------------------------------------------------
; _SP_KillProcesses -- shared helper called by both PREINSTALL and PREUNINSTALL
; Kills all screenpipe processes by name and by install-directory path.
; Uses Push/Pop to preserve $0 and $1 across the call site.
; ---------------------------------------------------------------------------
!macro _SP_KillProcesses
  Push $0
  Push $1

  ; $PLUGINSDIR is a per-session temp dir auto-cleaned on installer exit.
  ; InitPluginsDir is idempotent -- safe to call even if a plugin already ran.
  InitPluginsDir

  DetailPrint "Stopping screenpipe processes..."
  nsExec::ExecToLog 'taskkill /F /T /IM screenpipe.exe'
  Pop $0
  DetailPrint "taskkill screenpipe.exe: $0"
  nsExec::ExecToLog 'taskkill /F /T /IM screenpipe-app.exe'
  Pop $0
  DetailPrint "taskkill screenpipe-app.exe: $0"

  ; Stop any remaining process running from this install directory, including
  ; the bundled Bun sidecar. Use CIM ExecutablePath instead of Get-Process.Path:
  ; reading process module paths can throw "Access to the path is denied".
  ; FileWriteUTF16LE /BOM writes UTF-16LE with BOM + CRLF line endings -- the
  ; encoding and line-ending format PowerShell 5.1 on Windows expects. Plain
  ; FileWrite outputs ANSI (system codepage) and silently breaks on non-ASCII
  ; paths; LF-only endings can cause misbehavior on Windows PowerShell 5.1.
  ; ${__LINE__} makes the skip label unique per insertion so this macro can be
  ; inserted more than once without duplicate-label compile errors.
  !define _SP_SKIP ps_skip_${__LINE__}
  ClearErrors
  FileOpen $1 "$PLUGINSDIR\screenpipe-kill.ps1" w
  IfErrors ${_SP_SKIP}
    FileWriteUTF16LE /BOM $1 '$$d = "$INSTDIR"; if (-not $$d.EndsWith([char]92)) { $$d = $$d + [char]92 }$\r$\n'
    FileWriteUTF16LE $1 'Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.ToLower().StartsWith($$d.ToLower()) -and $$_.Name -ne "uninstall.exe" } | ForEach-Object { $$p = $$_.ProcessId; Stop-Process -Id $$p -Force -ErrorAction SilentlyContinue; Wait-Process -Id $$p -Timeout 5 -ErrorAction SilentlyContinue }$\r$\n'
    FileClose $1
    DetailPrint "Stopping processes from $INSTDIR..."
    ; Disable WOW64 FS redirection so System32 resolves to the real 64-bit dir.
    ; Screenpipe targets 64-bit Windows 10/11 only. RemoteSigned is sufficient --
    ; the .ps1 is written locally and has no Zone.Identifier ADS.
    ; /TIMEOUT=30000 caps the wait at 30 s so the installer cannot hang forever.
    ${DisableX64FSRedirection}
    nsExec::ExecToLog /TIMEOUT=30000 '"$WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -inputformat none -ExecutionPolicy RemoteSigned -File "$PLUGINSDIR\screenpipe-kill.ps1"'
    Pop $0
    ${EnableX64FSRedirection}
    ; $0 is 0 on success, a numeric exit code on failure, or "error"/"timeout"
    ; if nsExec itself could not launch PowerShell. Surface it for installer logs.
    DetailPrint "PowerShell process-kill exit: $0"
  ${_SP_SKIP}:
  !undef _SP_SKIP

  ; Wait for processes to fully terminate and release file handles.
  ; 3000ms covers slow machines and Bun sidecar file handle teardown.
  DetailPrint "Waiting for processes to release file handles..."
  Sleep 3000
  DetailPrint "Process cleanup complete."

  Pop $1
  Pop $0
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro _SP_KillProcesses
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro _SP_KillProcesses
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Clean up runtime-downloaded PortableGit (bash for AI chat)
  RMDir /r "$LOCALAPPDATA\screenpipe\git-portable"
  ; Remove parent dir only if empty (preserves other screenpipe data)
  RMDir "$LOCALAPPDATA\screenpipe"
!macroend
