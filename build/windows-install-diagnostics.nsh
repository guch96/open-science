!ifndef OPEN_SCIENCE_INSTALL_DIAGNOSTICS_INCLUDED
!define OPEN_SCIENCE_INSTALL_DIAGNOSTICS_INCLUDED

!include LogicLib.nsh
Var cleanupReport
!ifdef VERSION
  !define OPEN_SCIENCE_DIAGNOSTIC_VERSION "${VERSION}"
!else
  !define OPEN_SCIENCE_DIAGNOSTIC_VERSION "unknown"
!endif
!ifdef PRODUCT_NAME
  !define OPEN_SCIENCE_DIAGNOSTIC_PRODUCT "${PRODUCT_NAME}"
!else
  !define OPEN_SCIENCE_DIAGNOSTIC_PRODUCT "Open-Science"
!endif

!ifndef BUILD_UNINSTALLER
Var cleanupAttempt
Var cleanupUninstallArguments
Var cleanupMessage
Var installDiagnosticDirectory

# A fresh filename per launch prevents an earlier failure being mistaken for the final result,
# including when the child never starts or exits before it can write a report.
!macro beginCleanupAttempt
  IntOp $cleanupAttempt $cleanupAttempt + 1
  StrCpy $cleanupReport "$PLUGINSDIR\cleanup-attempt-$cleanupAttempt.json"
  Delete "$cleanupReport"
  StrCpy $0 '$cleanupUninstallArguments --cleanup-report="$cleanupReport"'
  ClearErrors
!macroend

Function showCleanupFailure
  Push $R0
  InitPluginsDir
  SetOutPath $PLUGINSDIR
  File /oname=windows-install-diagnostics.ps1 "${BUILD_RESOURCES_DIR}\windows-install-diagnostics.ps1"
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\windows-install-diagnostics.ps1" -Action finalize -ReportPath "$cleanupReport" -ReportsDirectory "$PLUGINSDIR" -InstallPath "$INSTDIR" -ExitCode "$R0" -AppVersion "${OPEN_SCIENCE_DIAGNOSTIC_VERSION}" -ProductName "${OPEN_SCIENCE_DIAGNOSTIC_PRODUCT}" -Language $LANGUAGE -LogDirectory "$installDiagnosticDirectory"'
  Pop $R1
  Pop $cleanupMessage
  ${if} $R1 != 0
  ${orIf} $cleanupMessage == ""
    StrCpy $cleanupMessage "${OPEN_SCIENCE_DIAGNOSTIC_PRODUCT} could not remove the old application files. Restoration could not be confirmed. Run the official installer again or contact support. The diagnostic could not be saved."
  ${endif}
  DetailPrint "$cleanupMessage"
  IfSilent +2
    MessageBox MB_OK|MB_ICONEXCLAMATION "$cleanupMessage"
  Pop $R0
FunctionEnd
!endif

!endif
