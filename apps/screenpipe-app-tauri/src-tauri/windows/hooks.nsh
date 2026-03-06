!macro NSIS_HOOK_PREINSTALL
  ; Kill screenpipe processes before installation
  nsExec::ExecToLog 'taskkill /F /IM screenpipe.exe'
  nsExec::ExecToLog 'taskkill /F /IM screenpipe-app.exe'
  ; Wait a moment for processes to fully terminate and release file handles
  Sleep 1000
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Clean up runtime-downloaded PortableGit (bash for AI chat)
  RMDir /r "$LOCALAPPDATA\screenpipe\git-portable"
  ; Remove parent dir only if empty (preserves other screenpipe data)
  RMDir "$LOCALAPPDATA\screenpipe"
!macroend
