import { isAbsolute, relative, resolve } from 'node:path';

// Tiered permissions (DESIGN.md §3). Allowlist-first: anything not known to be safe inside
// the smith's own worktree rings the bell and waits for you.
//   allow — reads; edits inside the worktree; tests, builds, linters, local git
//   ask   — package installs, network, anything outside the worktree, anything unrecognised
//   deny  — pushing, sudo, spawning sub-agents (the forge orchestrates, not the smiths)

export type Verdict = { kind: 'allow' } | { kind: 'ask'; action: string } | { kind: 'deny'; message: string };

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'TodoWrite', 'ToolSearch']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Each segment of a shell command (split on && || ; |) must match one of these.
// Deliberately absent: sed (its `e` command runs shell), awk/rg (--pre/system() run commands).
const SAFE_COMMANDS: RegExp[] = [
  /^(ls|pwd|cat|head|tail|wc|echo|true|sort|uniq|diff|which|tree|stat|file|basename|dirname)\b/,
  /^grep\b/,
  /^find\b(?!.*\s-(exec|execdir|delete|ok|okdir|fprint0?|fprintf|fls)\b)/,
  /^mkdir\b/,
  /^node\b(?!.*\s(-e|-p|--eval|--print|-r|--require|--import|--loader)\b)/,
  /^(npm|pnpm|yarn) (test|run [\w:-]+|t)\b/,
  /^npx (tsc|vitest|jest|eslint|prettier|tsx)\b/,
  /^(tsc|vitest|jest|eslint|prettier)\b/,
  /^(python3?|pytest) -m (pytest|unittest)\b|^pytest\b/,
  /^git (status|diff|log|show|add|commit|restore|stash|branch|rev-parse|ls-files|rebase|merge)\b(?!.*(--(output|ext-diff|exec)\b|\s-x\b))/,
];
const NEVER: RegExp[] = [/\bgit push\b/, /\bsudo\b/, /\bgit (reset --hard|clean -[a-z]*f)/];

function inside(dir: string, path: string): boolean {
  const rel = relative(dir, resolve(dir, path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// fd merges (2>&1) and /dev/null redirects are harmless; drop them so their `&` / `>` / path
// don't read as separators, file writes or paths outside the anvil.
function stripSafeRedirects(command: string): string {
  return command.replace(/\d?>&\d(?!\w)/g, ' ').replace(/\d?>\s*\/dev\/null(?!\w)/g, ' ');
}

function splitShell(command: string): string[] {
  return command
    .split(/&&|\|\||;|\||&|\n/)
    .map((s) => s.trim().replace(/^cd\s+\S+\s*$/, ''))
    .filter(Boolean);
}

export function judge(tool: string, input: Record<string, unknown>, worktree: string): Verdict {
  if (READ_TOOLS.has(tool)) {
    // Reading is free inside the anvil; outside it (home dir, secrets) needs a human.
    const path = input.file_path ?? input.path;
    if (typeof path === 'string' && path && !inside(worktree, path)) return { kind: 'ask', action: `read ${path}` };
    return { kind: 'allow' };
  }

  if (EDIT_TOOLS.has(tool)) {
    const path = String(input.file_path ?? input.notebook_path ?? '');
    return inside(worktree, path) ? { kind: 'allow' } : { kind: 'ask', action: `edit ${path} (outside the anvil)` };
  }

  if (tool === 'Bash') {
    const command = String(input.command ?? '').trim();
    if (NEVER.some((r) => r.test(command))) return { kind: 'deny', message: 'The Forgemaster handles pushes and destructive git; that is not for the anvil.' };
    // Substitutions and variables can hide anything ($(…), `…`, $HOME); paths that leave the
    // anvil (/abs, ~, ..) need a human. No exemptions: git can write files too (--output=).
    const ask = { kind: 'ask' as const, action: `run \`${command.slice(0, 120)}\`` };
    const plain = stripSafeRedirects(command);
    if (/\$[({\w]|`/.test(plain)) return ask;
    if (/(^|[\s>=<'"])(\/|~|\.\.(\/|\s|$))/.test(plain.replace(/(^|\s)\.\/\S*/g, ' '))) return ask;
    // Any other redirect writes a file through the shell (smiths use Edit/Write for that).
    // Quoted text (a commit message with <email@x.y>) is not a redirect.
    if (/[<>]/.test(plain.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""'))) return ask;
    const segments = splitShell(plain);
    if (segments.length && segments.every((s) => SAFE_COMMANDS.some((r) => r.test(s)))) return { kind: 'allow' };
    return { kind: 'ask', action: `run \`${command.slice(0, 120)}\`` };
  }

  if (tool === 'Task' || tool === 'Agent') return { kind: 'deny', message: 'No sub-agents at the anvil: finish the task yourself.' };
  if (tool === 'WebFetch' || tool === 'WebSearch') return { kind: 'ask', action: `${tool === 'WebFetch' ? 'fetch' : 'search'} ${String(input.url ?? input.query ?? '').slice(0, 100)}` };
  return { kind: 'ask', action: `use ${tool}` };
}

/** World-event kind for a tool call (drives the dwarf's animation). */
export function kindOf(tool: string, input: Record<string, unknown>): 'read' | 'grep' | 'edit' | 'write' | 'bash' | null {
  if (tool === 'Read') return 'read';
  if (tool === 'Grep' || tool === 'Glob' || tool === 'LS') return 'grep';
  if (tool === 'Write') return 'write';
  if (EDIT_TOOLS.has(tool)) return 'edit';
  if (tool === 'Bash') return 'bash';
  void input;
  return null;
}

export function isTestCommand(command: string): boolean {
  return /\b(npm|pnpm|yarn) (run )?test\b|\bnode --test\b|\b(vitest|jest|pytest)\b|-m (pytest|unittest)\b/.test(command);
}
