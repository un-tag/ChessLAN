; On first install only, ask for admin once to let ChessLAN through Windows
; Firewall, so voice chat never triggers an "Allow access" prompt later.
; The rule follows the executable path, which updates keep unchanged.

!macro customInstall
  ${ifNot} ${isUpdated}
    ExecShellWait "runas" "$SYSDIR\netsh.exe" 'advfirewall firewall add rule name="ChessLAN" dir=in action=allow program="$INSTDIR\ChessLAN.exe" enable=yes profile=any' SW_HIDE
  ${endIf}
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ExecShellWait "runas" "$SYSDIR\netsh.exe" 'advfirewall firewall delete rule name="ChessLAN"' SW_HIDE
  ${endIf}
!macroend
