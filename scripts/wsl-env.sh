#!/usr/bin/env bash
# Puts a suitable Node on PATH inside WSL/Linux. Source this before running the forge.
# Uses nvm when present (its default alias), otherwise whatever `node` is already on PATH.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [[ -s "$NVM_DIR/nvm.sh" ]]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm use --silent default >/dev/null 2>&1 || true
fi
if ! command -v node >/dev/null 2>&1; then
  echo "deepanvil: Node.js not found in WSL/Linux. Install Node 24+ (e.g. via nvm)." >&2
  return 1 2>/dev/null || exit 1
fi
if [[ "$(command -v node)" == /mnt/* ]]; then
  echo "deepanvil: found the Windows node.exe ($(command -v node)); install Node 24+ inside WSL itself (e.g. via nvm)." >&2
  return 1 2>/dev/null || exit 1
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if (( NODE_MAJOR < 24 )); then
  echo "deepanvil: Node $(node -v) found; the forge needs Node 24+ (TypeScript type stripping, node:sqlite)." >&2
  return 1 2>/dev/null || exit 1
fi
