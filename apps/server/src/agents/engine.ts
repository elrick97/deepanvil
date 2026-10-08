import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The Agent SDK drives a platform-specific Claude Code binary. node_modules is shared
// with Windows (which only gets the win32 build), so in WSL we use a private Linux
// engine pinned to the SDK's version: ~/.deepanvil/engine (see scripts/setup-engine.sh).
// It reads the same ~/.claude login as the user's own `claude`, i.e. the subscription.
export const ENGINE_PATH =
  process.env.DEEPANVIL_ENGINE ??
  join(homedir(), '.deepanvil', 'engine', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-linux-x64', 'claude');

// The token min-max tiers (DESIGN.md §2).
export const MODELS = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
} as const;

/**
 * The engine's OS sandbox (bubblewrap) confines smiths' shell commands to their worktree
 * and cuts network access. It needs `bwrap` and `socat` (Linux: `sudo apt install bubblewrap socat`).
 * When both exist the forge requires it; otherwise smiths fall back to the permission
 * allowlist alone and the forge warns at startup. Force off with DEEPANVIL_SANDBOX=0.
 */
export const SANDBOX_READY: boolean = (() => {
  if (process.env.DEEPANVIL_SANDBOX === '0') return false;
  const dirs = (process.env.PATH ?? '').split(':');
  const has = (bin: string) => dirs.some((d) => d && existsSync(join(d, bin)));
  return has('bwrap') && has('socat');
})();
