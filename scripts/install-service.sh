#!/usr/bin/env bash
# Installs (or removes with --remove) the Windows logon launcher for the always-on forge.
# Run from Git Bash on Windows. No admin rights needed: it's a hidden-window VBScript in
# the per-user Startup folder that runs scripts/forge-service.sh inside WSL.
set -euo pipefail
# Git Bash paths (/c/Users/...) map directly onto WSL's (/mnt/c/Users/...).
REPO_WSL="/mnt$(cygpath -u "$(cd "$(dirname "$0")/.." && pwd)")"
STARTUP="$APPDATA/Microsoft/Windows/Start Menu/Programs/Startup"
VBS="$STARTUP/Deepanvil Forge.vbs"
if [[ "${1:-}" == "--remove" ]]; then rm -f "$VBS"; echo "removed $VBS"; exit 0; fi
cat > "$VBS" <<VBS
' Deepanvil: starts the always-on forge inside WSL at logon (hidden window).
CreateObject("WScript.Shell").Run "wsl.exe -d Ubuntu --cd ""$REPO_WSL"" -- bash scripts/forge-service.sh", 0, False
VBS
echo "installed $VBS"
