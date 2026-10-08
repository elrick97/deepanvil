#!/usr/bin/env bash
# Loads nvm-managed Node inside WSL. Source this before running node in WSL.
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm use --silent default >/dev/null 2>&1 || true
