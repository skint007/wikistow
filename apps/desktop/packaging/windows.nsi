; The Windows installer, built by scripts/windows-packages.sh with makensis
; for each architecture. It installs for the person running it, with no
; administrator prompt, into %LOCALAPPDATA%\Programs\WikiStow Desktop: a
; Start menu entry, `wikistow://` links for signing in, and an uninstaller
; listed in Settings > Apps. Not Programs\wikistow, which is the CLI's, on
; the PATH: Windows ignores case, so its wikistow.exe would be WikiStow.exe. The app's data in %APPDATA%\WikiStow stays when it goes.
;
; makensis (from any folder: it reads the icon beside this file) -DVERSION=<version> -DFILE_VERSION=<a.b.c.0> -DARCH=<x64|arm64>
;   -DAPP=<staged app folder> -DOUT=<installer> packaging/windows.nsi

Unicode true
ManifestDPIAware true
RequestExecutionLevel user
SetCompressor /SOLID lzma

!include MUI2.nsh
!include x64.nsh

!define KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\WikiStow"
!define LINKS "Software\Classes\wikistow"
!define UNINSTALLER "Uninstall WikiStow.exe"

Name "WikiStow"
OutFile "${OUT}"
InstallDir "$LOCALAPPDATA\Programs\WikiStow Desktop"
BrandingText "WikiStow ${VERSION}"

VIProductVersion "${FILE_VERSION}"
VIAddVersionKey ProductName "WikiStow"
VIAddVersionKey FileDescription "WikiStow ${VERSION} setup"
VIAddVersionKey ProductVersion "${VERSION}"
VIAddVersionKey FileVersion "${VERSION}"
VIAddVersionKey LegalCopyright "MIT License"

!define MUI_ICON "wikistow-desktop.ico"
!define MUI_UNICON "wikistow-desktop.ico"
!define MUI_FINISHPAGE_RUN "$INSTDIR\WikiStow.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Open WikiStow"
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

; Windows keeps a running program's file open, so neither replacing nor
; removing it works until WikiStow is closed. Silent runs give up.
!macro WaitUntilClosed
  retry:
  IfFileExists "$INSTDIR\WikiStow.exe" 0 closed
  ClearErrors
  FileOpen $0 "$INSTDIR\WikiStow.exe" a
  IfErrors 0 opened
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "WikiStow is open. Close it, then choose Retry." /SD IDCANCEL IDRETRY retry
  Abort
  opened:
  FileClose $0
  closed:
!macroend

; What an install puts in its folder: Electron's files, its `locales` and
; `resources` folders, and the uninstaller. The folder is the app's own:
; nothing offers another (/D isn't documented), and every top-level file
; in it goes.
!macro RemoveApp
  Delete "$INSTDIR\*.*"
  RMDir /r "$INSTDIR\locales"
  RMDir /r "$INSTDIR\resources"
!macroend

Function .onInit
  ; The arm64 app doesn't run on an x64 computer. The x64 one runs on
  ; Windows 11 on Arm, emulated, but more slowly than the arm64 one.
  !if ${ARCH} == arm64
    ${IfNot} ${IsNativeARM64}
      MessageBox MB_ICONSTOP "This is the installer for Windows on Arm. Download the x64 one for this computer." /SD IDOK
      Abort
    ${EndIf}
  !endif
FunctionEnd

Section
  !insertmacro WaitUntilClosed
  ; An update replaces the app, so no file of an older version stays.
  !insertmacro RemoveApp
  SetOutPath "$INSTDIR"
  File /r "${APP}/*"
  WriteUninstaller "$INSTDIR\${UNINSTALLER}"

  CreateShortcut "$SMPROGRAMS\WikiStow.lnk" "$INSTDIR\WikiStow.exe"

  ; The browser hands the sign-in back as a `wikistow://` link, which starts
  ; the app with the link as its argument. A running app gets it from there.
  WriteRegStr HKCU "${LINKS}" "" "URL:WikiStow"
  WriteRegStr HKCU "${LINKS}" "URL Protocol" ""
  WriteRegStr HKCU "${LINKS}\DefaultIcon" "" "$INSTDIR\WikiStow.exe,0"
  WriteRegStr HKCU "${LINKS}\shell\open\command" "" '"$INSTDIR\WikiStow.exe" "%1"'

  WriteRegStr HKCU "${KEY}" "DisplayName" "WikiStow"
  WriteRegStr HKCU "${KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${KEY}" "Publisher" "WikiStow"
  WriteRegStr HKCU "${KEY}" "DisplayIcon" "$INSTDIR\WikiStow.exe,0"
  WriteRegStr HKCU "${KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${KEY}" "UninstallString" '"$INSTDIR\${UNINSTALLER}"'
  WriteRegStr HKCU "${KEY}" "QuietUninstallString" '"$INSTDIR\${UNINSTALLER}" /S'
  WriteRegStr HKCU "${KEY}" "URLInfoAbout" "https://github.com/skint007/wikistow"
  WriteRegDWORD HKCU "${KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${KEY}" "NoRepair" 1
SectionEnd

Section Uninstall
  !insertmacro WaitUntilClosed
  Delete "$SMPROGRAMS\WikiStow.lnk"
  DeleteRegKey HKCU "${LINKS}"
  DeleteRegKey HKCU "${KEY}"
  !insertmacro RemoveApp
  RMDir "$INSTDIR"
SectionEnd
