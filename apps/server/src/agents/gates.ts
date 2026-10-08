import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GateName } from '@deepanvil/shared';
import type { Store } from '../store.ts';

// Odin's gates: tests, types, lint. Plain commands with a timeout — no model, no tokens.
// The per-repo policy lives in the forge's database (never in the repo, so a repo can't
// loosen its own rules); it's auto-detected the first time Odin sees a repo.

export interface Policy {
  /** "auto": Odin merges. "approve": Odin recommends, you merge. */
  mode: 'auto' | 'approve';
  gates: Partial<Record<GateName, string>>;
  gateTimeoutSec: number;
  maxDiffLines: number;
  flakyRetries: number;
  /** Offerings touching these always wait for you, whatever `mode` says. */
  protectedPaths: string[];
}

export const GATES: GateName[] = ['tests', 'types', 'lint'];
export const LOCKFILES = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'poetry.lock', 'Cargo.lock', 'uv.lock', 'Gemfile.lock'];

/** Guess a repo's gate commands from its manifests. */
export function detectGates(repo: string): Partial<Record<GateName, string>> {
  const gates: Partial<Record<GateName, string>> = {};
  const pkgPath = join(repo, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string>; devDependencies?: Record<string, string>; dependencies?: Record<string, string> };
      const scripts = pkg.scripts ?? {};
      if (scripts.test && !/no test specified/.test(scripts.test)) gates.tests = 'npm test --silent';
      const typeScript = ['typecheck', 'type-check', 'types', 'tsc'].find((s) => scripts[s]);
      if (typeScript) gates.types = `npm run --silent ${typeScript}`;
      else if (existsSync(join(repo, 'tsconfig.json')) && (pkg.devDependencies?.typescript || pkg.dependencies?.typescript)) gates.types = 'npx --no-install tsc --noEmit';
      if (scripts.lint) gates.lint = 'npm run --silent lint';
    } catch {
      /* unreadable package.json: leave gates empty and say so on the card */
    }
  }
  if (!gates.tests && (existsSync(join(repo, 'pyproject.toml')) || existsSync(join(repo, 'pytest.ini')))) gates.tests = 'python3 -m pytest -q';
  if (!gates.tests && existsSync(join(repo, 'Makefile')) && /^test:/m.test(readFileSync(join(repo, 'Makefile'), 'utf8'))) gates.tests = 'make test';
  return gates;
}

/** The repo's policy, creating the default on first sight. `sandboxRepo` repos default to auto. */
export function policyFor(store: Store, repo: string, sandboxRepo: boolean): Policy {
  const saved = store.policy(repo);
  if (saved) return JSON.parse(saved) as Policy;
  const policy: Policy = {
    mode: sandboxRepo ? 'auto' : 'approve',
    gates: detectGates(repo),
    gateTimeoutSec: 600,
    maxDiffLines: 400,
    flakyRetries: 1,
    protectedPaths: ['.github/', 'migrations/'],
  };
  store.setPolicy(repo, JSON.stringify(policy));
  return policy;
}

export interface GateResult {
  ok: boolean;
  output: string;
  durationMs: number;
  timedOut: boolean;
}

/** Run one gate command in `cwd` (bash, so `&&` and `!` work), keeping the output's tail. */
export function runGate(command: string, cwd: string, timeoutSec: number, signal?: AbortSignal): Promise<GateResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], { cwd, env: { ...process.env, CI: '1', FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let output = '';
    let timedOut = false;
    const keep = (d: Buffer) => {
      output = (output + d.toString()).slice(-60_000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    // Kill the whole process group (test runners spawn workers).
    const kill = () => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutSec * 1000);
    signal?.addEventListener('abort', kill, { once: true });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
      resolve({ ok: code === 0 && !timedOut, output: timedOut ? `${output}\n[timed out after ${timeoutSec}s]` : output, durationMs: Date.now() - started, timedOut });
    });
  });
}
