#!/usr/bin/env bash
# The always-on forge: runs the server forever inside WSL, restarting it if it exits.
# Started at Windows logon by "Deepanvil Forge.vbs" in the Startup folder (scripts/install-service.sh),
# whose wsl.exe process also keeps the WSL VM from idling out.
# Restart after server changes: npm run forge:restart   Logs: ~/.deepanvil/forge.log
cd "$(dirname "$0")/.."
source scripts/wsl-env.sh
LOG="$HOME/.deepanvil/forge.log"
mkdir -p "$(dirname "$LOG")"
while true; do
  # Keep the log from growing without bound.
  if [[ -f "$LOG" && $(stat -c %s "$LOG") -gt 5000000 ]]; then mv "$LOG" "$LOG.1"; fi
  echo "[$(date -Is)] forge starting" >> "$LOG"
  node apps/server/src/index.ts >> "$LOG" 2>&1
  echo "[$(date -Is)] forge exited with $? — restarting in 3s" >> "$LOG"
  sleep 3
done
