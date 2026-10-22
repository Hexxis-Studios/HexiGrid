!macro customInstall
  ${if} ${FileExists} "$newStartMenuLink"
    nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\notification\Set-HexiGridToastShortcut.ps1" -ShortcutPath "$newStartMenuLink" -AppUserModelId "Hexxis.Studios.HexiGrid" -ToastActivatorClsid "eb1fdd5b-8f70-4b5a-b230-998a2dc19303"`
    Pop $0
    ${if} $0 != 0
      DetailPrint "Windows call alerts could not be registered; calls remain available in HexiGrid."
    ${endif}
  ${else}
    DetailPrint "The Start Menu shortcut was not created; Windows call alerts could not be registered."
  ${endif}
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APP_ID}"
    StrCpy $1 "$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" --background"
    ${if} $0 == $1
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APP_ID}"
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "${APP_ID}"
    ${endIf}
  ${endIf}
!macroend
