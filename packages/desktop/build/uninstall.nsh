; Windows uninstall (electron-builder includes this in the NSIS script).
;
; The installer removes the program. It does not remove what poptart wrote - songs, samples,
; recordings, settings, and the SuperCollider poptart downloaded for itself - because that is the
; user's work, and an uninstall is also what happens in the middle of an upgrade. So the
; uninstaller asks, once, and defaults to keeping it.
;
; The SuperCollider copy is the reason this asks at all rather than saying nothing: someone who
; uninstalls has ~600 MB left behind that they never chose to download, in a folder they have no
; reason to know about (%USERPROFILE%\.poptart, or wherever POPTART_HOME points). A portable
; install has no such problem - its data sits in the folder next to the app, in plain sight - so
; only the default location is offered here.

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ; POPTART_HOME (and a poptart-data folder) can put this anywhere; only the default is known
    ; here, and only it is offered.
    StrCpy $R0 "$PROFILE\.poptart"
    ${if} ${FileExists} "$R0\*.*"
      ${if} $installMode == "all"
        ; Per-machine: $PROFILE is whoever is running the uninstaller, which may not be the
        ; person whose songs these are. Leave every user's data alone.
        DetailPrint "poptart's songs and settings are left in place (one folder per user)."
      ${else}
        MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
          "Also delete poptart's songs, samples, recordings and settings?$\r$\n$\r$\n\
           $R0$\r$\n$\r$\n\
           This folder also holds the SuperCollider copy poptart downloaded (about 600 MB).$\r$\n$\r$\n\
           Choose No to keep your work - you can delete the folder yourself later." \
          /SD IDNO IDNO keepData
        RMDir /r "$R0"
        DetailPrint "Deleted $R0"
        keepData:
      ${endif}
    ${endif}
  ${endif}
!macroend
