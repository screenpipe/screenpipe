!macro NSIS_HOOK_PREINSTALL
  ; Kill screenpipe processes before installation.
  nsExec::ExecToLog 'taskkill /F /T /IM screenpipe.exe'
  nsExec::ExecToLog 'taskkill /F /T /IM screenpipe-app.exe'
  ; Stop any remaining process running from this install directory, including
  ; the bundled Bun sidecar. Use CIM ExecutablePath instead of Get-Process.Path:
  ; reading process module paths can throw "Access to the path is denied".
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command "$$root = [System.IO.Path]::GetFullPath(''$INSTDIR'').TrimEnd(''\'') + ''\''; Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$root, [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { $$pidToStop = $$_.ProcessId; Stop-Process -Id $$pidToStop -Force -ErrorAction SilentlyContinue; Wait-Process -Id $$pidToStop -Timeout 5 -ErrorAction SilentlyContinue }"'
  ; Wait a moment for processes to fully terminate and release file handles.
  Sleep 1000
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Clean up runtime-downloaded PortableGit (bash for AI chat)
  RMDir /r "$LOCALAPPDATA\screenpipe\git-portable"
  ; Remove parent dir only if empty (preserves other screenpipe data)
  RMDir "$LOCALAPPDATA\screenpipe"
!macroend
