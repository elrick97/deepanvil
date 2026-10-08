#!/usr/bin/env bash
# Installs the Agent SDK's Linux engine into ~/.deepanvil/engine (run inside WSL / Linux).
# node_modules is shared with Windows, which only gets the win32 build, so the Linux binary
# lives here, pinned to the exact SDK version in package-lock.json. Re-run after bumping the SDK.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/wsl-env.sh
VERSION=$(node -p "require('./node_modules/@anthropic-ai/claude-agent-sdk/package.json').version")
mkdir -p "$HOME/.deepanvil/engine"
cd "$HOME/.deepanvil/engine"
npm i --no-audit --no-fund "@anthropic-ai/claude-agent-sdk-linux-x64@${VERSION}"
./node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude --version
echo "engine ready (SDK ${VERSION}). It uses your Claude login in ~/.claude — run \`claude\` once to log in if needed."
