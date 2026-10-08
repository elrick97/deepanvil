import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

// One git worktree per anvil: every smith works on their own branch and directory, and
// only the Forgemaster merges back into the main checkout.

const run = promisify(execFile);

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
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
