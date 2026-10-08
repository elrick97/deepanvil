#!/usr/bin/env bash
# Runs the forge server inside WSL. Invoked by `npm run server` from Windows.
# `bash scripts/server.sh smoke` runs the Agent SDK smoke test instead.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/wsl-env.sh
if [[ "${1:-}" == "smoke" ]]; then exec node apps/server/src/agents/smoke.ts; fi
if [[ "${1:-}" == "selftest" ]]; then exec node apps/server/src/agents/selftest.ts; fi
exec node apps/server/src/index.ts
