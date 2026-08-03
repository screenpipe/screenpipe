; x64.nsh provides ${DisableX64FSRedirection} / ${EnableX64FSRedirection}.
; LogicLib provides ${If}/${Do}/${ExitDo} and generates unique labels per use,
; so the macros below can be inserted repeatedly.
; Both have their own include guards so repeated inclusion is safe.
!include "x64.nsh"
!include "LogicLib.nsh"

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

; ---------------------------------------------------------------------------
; _SP_ClearLockedFile <name> -- guarantee $INSTDIR\<name> is writable before
; the installer extracts over it.
;
; Windows refuses to overwrite the image of a running process. That is the
; "Error opening file for writing: ...\bun.exe" dialog (#5467, #3647): the
; updater hands off to this installer via ShellExecuteW and then calls
; std::process::exit(0), which orphans -- without killing -- the bun sidecars
; that run out of $INSTDIR (pi agent, pipes). _SP_KillProcesses above is only
; best effort: its PowerShell/WMI sweep swallows every error and gives up after
; 30 s, which is easy to hit overnight while Defender runs its scheduled scan.
; Retry in the dialog then never helps, because nothing in that path releases
; the handle.
;
; So do not depend on the kill. A locked image cannot be deleted or
; overwritten, but it *can* be renamed (the mapping is opened with
; FILE_SHARE_DELETE) -- the same swap Chrome and Firefox use to update
; themselves. Wait a few seconds first so short-lived locks (antivirus reading
; the file) clear without leaving anything behind, then move the file aside.
; The name is free for extraction and the orphan keeps running from the renamed
; copy until it exits on its own.
;
; Deliberately no `Delete /REBOOTOK`: it needs admin for this per-user install
; and would raise a reboot prompt. Leftovers are swept in POSTINSTALL and again
; by the app at boot (see updates.rs::sweep_moved_aside_binaries).
; ---------------------------------------------------------------------------
!macro _SP_ClearLockedFile Name
  Push $0 ; full path
  Push $1 ; lock-wait attempt counter
  Push $2 ; open-for-write probe handle
  Push $3 ; move-aside suffix
  Push $4 ; move-aside candidate path
  Push $5 ; rename attempt guard

  StrCpy $0 "$INSTDIR\${Name}"
  ${If} ${FileExists} "$0"
    StrCpy $1 0
    ${Do}
      ; Mode "a" needs write access and does not truncate, so it fails in
      ; exactly the cases where extraction would fail.
      ClearErrors
      FileOpen $2 "$0" a
      ${IfNot} ${Errors}
        FileClose $2
        ${ExitDo}
      ${EndIf}

      IntOp $1 $1 + 1
      ${If} $1 >= 3
        DetailPrint "${Name} still locked after $1 tries - moving it aside"

        ; Seed the suffix with the tick count so repeated upgrades never reuse a
        ; name: leftovers that are themselves still locked (an orphan from an
        ; earlier update) must not be able to exhaust the destinations. Falls
        ; back to 0 if the System plugin is unavailable, and increments from
        ; there on collision.
        StrCpy $3 ""
        System::Call 'kernel32::GetTickCount()i.r3' ; ms since boot
        ${If} $3 == ""
          StrCpy $3 0
        ${EndIf}
        ; GetTickCount is a DWORD but NSIS ints are signed, so mask the sign bit
        ; off rather than building names like `.sp-old--1234` after 24 days up.
        IntOp $3 $3 & 2147483647

        StrCpy $5 0
        ${Do}
          StrCpy $4 "$0.sp-old-$3"
          ; Drop a same-named leftover so the destination is free. If that one
          ; is locked too, Rename fails and the next suffix is tried.
          Delete "$4"
          ClearErrors
          Rename "$0" "$4"
          ${IfNot} ${Errors}
            DetailPrint "moved ${Name} aside to $4"
            ; Usually fails while the orphan still runs - swept later.
            Delete "$4"
            ${ExitDo}
          ${EndIf}
          IntOp $3 $3 + 1
          IntOp $5 $5 + 1
          ; Pure hang guard, not a cap on destinations: with a tick-count seed a
          ; collision needs a leftover of that exact name, so reaching this many
          ; failures means the *source* cannot be renamed at all (the holder
          ; denied FILE_SHARE_DELETE, or the directory is not writable).
          ${If} $5 >= 1000
            DetailPrint "could not move ${Name} aside after $5 attempts"
            ; Fail loudly instead of letting extraction hit the locked path and
            ; raise the unrecoverable "Error opening file for writing" dialog.
            MessageBox MB_OK|MB_ICONSTOP "Setup could not replace ${Name} because another program is using it.$\r$\n$\r$\nClose screenpipe (and any bun.exe in Task Manager), then run this installer again." /SD IDOK
            SetErrors
            Abort "could not replace ${Name} - it is locked by another program"
          ${EndIf}
        ${Loop}
        ${ExitDo}
      ${EndIf}

      DetailPrint "${Name} is locked, waiting ($1/3)..."
      Sleep 1000
    ${Loop}
  ${EndIf}

  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro _SP_KillProcesses

  ; Everything the app keeps running out of $INSTDIR. The kill above is the
  ; tidy path; these checks are what actually guarantee extraction can write,
  ; whether or not it worked.
  DetailPrint "Making app binaries writable..."
  ; Leftovers from earlier updates whose holder has since exited. Clearing them
  ; first keeps them from accumulating across repeated upgrades.
  Delete "$INSTDIR\*.sp-old*"
  !insertmacro _SP_ClearLockedFile "bun.exe"
  !insertmacro _SP_ClearLockedFile "screenpipe.exe"
  !insertmacro _SP_ClearLockedFile "screenpipe-app.exe"
  !insertmacro _SP_ClearLockedFile "ffmpeg.exe"
  !insertmacro _SP_ClearLockedFile "ffprobe.exe"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Binaries moved aside above. The orphan holding them has usually exited by
  ; now; whatever is left gets swept by the app on its next boot.
  Delete "$INSTDIR\*.sp-old*"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro _SP_KillProcesses
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Clean up runtime-downloaded PortableGit (bash for AI chat)
  RMDir /r "$LOCALAPPDATA\screenpipe\git-portable"
  ; Clean up runtime-downloaded baseline bun (non-AVX2 CPU fallback)
  RMDir /r "$LOCALAPPDATA\screenpipe\bun-baseline"
  ; Remove parent dir only if empty (preserves other screenpipe data)
  RMDir "$LOCALAPPDATA\screenpipe"
!macroend
