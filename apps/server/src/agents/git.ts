import { execFile } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

// One git worktree per anvil: every smith works on their own branch and directory, and
// only the Forgemaster merges back into the main checkout.

const run = promisify(execFile);

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * What a project must be: a folder that is (inside) a git repository, with at least one commit and a
 * branch checked out. The branch is the one Odin keeps: finished work is merged into it.
 */
export async function inspectRepo(input: string): Promise<{ root: string; branch: string }> {
  let p = input.trim();
  if (!p) throw new Error('Give a folder path.');
  if (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\')) {
    throw new Error('That is a Windows path, but the forge runs in WSL: use the path as WSL sees it (/home/you/project; /mnt/c/... works but is much slower for git).');
  }
  if (p === '~' || p.startsWith('~/')) p = join(homedir(), p.slice(1));
  if (!isAbsolute(p)) throw new Error('Use an absolute path (starting with / or ~/).');
  let real: string;
  try {
    real = realpathSync(p);
  } catch {
    throw new Error(`There is no folder at ${p}.`);
  }
  if (!statSync(real).isDirectory()) throw new Error(`${real} is not a folder.`);
  let root: string;
  try {
    root = realpathSync(await git(real, 'rev-parse', '--show-toplevel'));
  } catch {
    throw new Error(`${real} is not a git repository (git init, then make a first commit).`);
  }
  if (root.includes('.anvils')) throw new Error('That is one of the forge’s own work folders.');
  try {
    await git(root, 'rev-parse', '--verify', 'HEAD');
  } catch {
    throw new Error(`${root} has no commits yet: make a first commit.`);
  }
  const branch = await git(root, 'symbolic-ref', '--short', 'HEAD').catch(() => '');
  if (!branch) throw new Error(`${root} is on a detached HEAD: check out a branch first.`);
  return { root, branch };
}

/** Only plain https:// repository URLs are cloned (no ssh/file/ext transports, no odd characters). */
export function cloneTarget(url: string, projectsDir: string): { url: string; name: string; dir: string } {
  const u = url.trim();
  if (!/^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._~\/-]+$/.test(u) || u.includes('..')) {
    throw new Error('Clone from an https:// URL, for example https://github.com/owner/repo.');
  }
  const last = u.replace(/\.git$/, '').split('/').filter(Boolean).pop() ?? '';
  const name = last.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 60) || 'project';
  return { url: u, name, dir: join(projectsDir, name) };
}

export async function cloneInto(url: string, dir: string): Promise<void> {
  // No prompts (a private repo without stored credentials must fail, not hang) and no ssh/file transports.
  await run('git', ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', 'clone', '-q', '--', url, dir], {
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

export function worktreesDir(repo: string): string {
  return join(dirname(repo), `${repo.split('/').pop()}.anvils`);
}

export async function addWorktree(repo: string, name: string, branch: string): Promise<string> {
  const dir = join(worktreesDir(repo), name);
  await mkdir(worktreesDir(repo), { recursive: true });
  await git(repo, 'worktree', 'add', '-B', branch, dir, 'HEAD');
  return dir;
}

export async function removeWorktree(repo: string, dir: string): Promise<void> {
  await git(repo, 'worktree', 'remove', '--force', dir).catch(() => undefined);
}

/** Commit anything the smith left uncommitted (they are asked to commit, but may forget). */
export async function commitAll(dir: string, message: string): Promise<void> {
  await git(dir, 'add', '-A');
  const status = await git(dir, 'status', '--porcelain');
  if (status) await git(dir, '-c', 'user.name=Deepanvil Smith', '-c', 'user.email=smith@deepanvil.local', 'commit', '-m', message);
}
