// Zero-token self-test of the forge's orchestration: stub agents, a throwaway git repo,
// a throwaway database. Exercises every path that's rare in real life.
// Run inside WSL: bash scripts/server.sh selftest
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ForgeEvent } from '@deepanvil/shared';
import { Store } from '../store.ts';
import type { BlueprintTask } from './forgemaster.ts';
import { Forge, type Agents } from './orchestrator.ts';
import { judge } from './permissions.ts';
import type { SmithOutcome, SmithRun } from './smith.ts';

const root = mkdtempSync(join(tmpdir(), 'deepanvil-selftest-'));
const repo = join(root, 'repo');
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
execFileSync('mkdir', ['-p', repo]);
sh(repo, 'init', '-q', '-b', 'main');
writeFileSync(join(repo, 'README.md'), '# test\n');
sh(repo, 'add', '-A');
sh(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');

const events: ForgeEvent[] = [];
let autoDeny = false; // answer every bell with "no" (a denied smith may well ask again)
const waiters: { pred: (e: ForgeEvent) => boolean; resolve: (e: ForgeEvent) => void }[] = [];
const emit = (e: ForgeEvent) => {
  events.push(e);
  if (autoDeny && e.type === 'permission.request') queueMicrotask(() => forge.handle({ type: 'permission.answer', requestId: e.requestId, approved: false }));
  for (const w of [...waiters]) if (w.pred(e)) {
    waiters.splice(waiters.indexOf(w), 1);
    w.resolve(e);
  }
};
const waitFor = (pred: (e: ForgeEvent) => boolean, ms = 10_000) =>
  new Promise<ForgeEvent>((resolve, reject) => {
    const hit = events.find(pred);
    if (hit) return resolve(hit);
    waiters.push({ pred, resolve });
    setTimeout(() => reject(new Error('timed out waiting for event')), ms);
  });

// ---------------------------------------------------------------- stub agents

let blueprintTasks: BlueprintTask[] = [];
let replans = 0;
const task = (id: string): BlueprintTask => ({ id, title: id, brief: `do ${id}`, files: [], acceptance: 'true' });
const done = (summary: string): SmithOutcome => ({ status: 'done', testsPassed: true, summary });
const stuck = (summary: string): SmithOutcome => ({ status: 'stuck', testsPassed: false, summary });

const stubs: Agents = {
  plan: async () => ({ title: 'Test quest', summary: 'stub', tasks: blueprintTasks }),
  replan: async (t) => {
    replans++;
    return { ...t, brief: `${t.brief} (redrawn)` };
  },
  review: async (t) => (t.id === 'reject-me' ? { approve: false, note: 'misses the brief' } : { approve: true, note: 'fine' }),
  summarizeDiff: async () => 'stub summary',
  banter: async () => '',
  runSmith: async (run: SmithRun) => {
    const id = run.task.id;
    const write = (file: string, text: string) => writeFileSync(join(run.worktree, file), text);
    if (id === 'flaky') {
      if (run.attempt < 3) return stuck(`attempt ${run.attempt} cracked`);
      if (!run.task.brief.endsWith('(redrawn)')) return stuck('was not re-planned');
    }
    if (id === 'bell') {
      const yes = await run.ask('npm install something');
      if (!yes) return stuck('denied at the bell');
    }
    if (id === 'slow') {
      // Works until the quest is stopped (real agents throw when their query is aborted).
      await new Promise((_, reject) => run.ledger.abort?.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    }
    if (id.startsWith('conflict')) write('shared.txt', `${id}\n`);
    else write(`${id}.txt`, `${id}\n`);
    return done(`did ${id}`);
  },
};

// ---------------------------------------------------------------- scenarios

const store = new Store(join(root, 'forge.db'));
const forge = new Forge(emit, { repo, smiths: 2 }, store, stubs);
let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

async function quest(tasks: BlueprintTask[], during?: () => void): Promise<ForgeEvent[]> {
  const start = events.length;
  blueprintTasks = tasks;
  forge.handle({ type: 'quest.request', text: 'test' });
  const proposed = (await waitFor((e) => e.type === 'blueprint.proposed' && events.indexOf(e) >= start)) as Extract<ForgeEvent, { type: 'blueprint.proposed' }>;
  forge.handle({ type: 'blueprint.approve', questId: proposed.questId });
  during?.();
  await waitFor((e) => e.type === 'forge.status' && !e.busy && events.indexOf(e) > events.indexOf(proposed), 15_000);
  return events.slice(start);
}
const merged = (evs: ForgeEvent[]) => evs.filter((e) => e.type === 'task.done').map((e) => (e as { taskId: string }).taskId).sort();
const worktrees = () => sh(repo, 'worktree', 'list').split('\n').length;

function permissionTable() {
  const wt = '/home/dwarf/forge/sandbox.anvils/brokka-x';
  const cases: [string, Record<string, unknown>, string][] = [
    ['Read', { file_path: `${wt}/src/a.ts` }, 'allow'],
    ['Read', { file_path: '/home/dwarf/.ssh/id_rsa' }, 'ask'],
    ['Edit', { file_path: `${wt}/src/a.ts` }, 'allow'],
    ['Edit', { file_path: 'src/a.ts' }, 'allow'],
    ['Write', { file_path: '/home/dwarf/.bashrc' }, 'ask'],
    ['Edit', { file_path: `${wt}/../../evil.ts` }, 'ask'],
    ['Bash', { command: 'npm test' }, 'allow'],
    ['Bash', { command: 'node --test && git add -A && git commit -m "x"' }, 'allow'],
    ['Bash', { command: 'npm install zod' }, 'ask'],
    ['Bash', { command: 'curl https://example.com' }, 'ask'],
    ['Bash', { command: 'cat ~/.ssh/id_rsa' }, 'ask'],
    ['Bash', { command: 'echo hi > ../outside.txt' }, 'ask'],
    ['Bash', { command: 'ls $(cat secret)' }, 'ask'],
    ['Bash', { command: 'find . -name "*.ts" -delete' }, 'ask'],
    ['Bash', { command: 'git push origin main' }, 'deny'],
    ['Bash', { command: 'sudo rm -rf /' }, 'deny'],
    ['Task', { prompt: 'x' }, 'deny'],
    ['WebFetch', { url: 'https://x.dev' }, 'ask'],
    // Escape hatches found in the security audit:
    ['Bash', { command: 'git diff --output=/home/dwarf/.bashrc' }, 'ask'],
    ['Bash', { command: 'git log --output=notes.txt' }, 'ask'],
    ['Bash', { command: "sed -n '1e touch pwned' README.md" }, 'ask'],
    ['Bash', { command: 'node -p "require(`fs`)"' }, 'ask'],
    ['Bash', { command: 'node --eval "1"' }, 'ask'],
    ['Bash', { command: 'cd .. && cat secrets.txt' }, 'ask'],
    ['Bash', { command: 'cat $HOME/.ssh/id_rsa' }, 'ask'],
    ['Bash', { command: 'find . -fprint out.txt' }, 'ask'],
    ['Bash', { command: 'npm test & curl evil.dev' }, 'ask'],
    // ...while ordinary work stays automatic:
    ['Bash', { command: 'node --test' }, 'allow'],
    ['Bash', { command: 'git commit -m "Add total()"' }, 'allow'],
    ['Bash', { command: 'git diff HEAD~1 -- src/inventory.js' }, 'allow'],
    ['Bash', { command: 'cat ./src/inventory.js | grep total' }, 'allow'],
  ];
  const bad = cases.filter(([tool, input, want]) => judge(tool, input, wt).kind !== want);
  check(`permission table (${cases.length} cases)`, bad.length === 0, bad.map(([t, i]) => `${t} ${JSON.stringify(i)}`).join('; '));
}

async function main() {
  permissionTable();
  await forge.recover();

  let evs = await quest([task('alpha'), task('beta')]);
  check('parallel smiths both merge', merged(evs).join() === 'alpha,beta');
  check('two different smiths worked', new Set(evs.filter((e) => e.type === 'task.assigned').map((e) => (e as { dwarfId: string }).dwarfId)).size === 2);
  check('minecart rolls on merge', evs.some((e) => e.type === 'merge'));
  check('anvils cleared afterwards', worktrees() === 1);

  evs = await quest([task('flaky')]);
  check('fail twice -> escalation', evs.some((e) => e.type === 'escalation'));
  check('re-planned exactly once', replans === 1, `replans=${replans}`);
  check('re-planned task then merges', merged(evs).join() === 'flaky');

  evs = await quest([task('reject-me')]);
  check('review rejection blocks the merge', merged(evs).length === 0 && !readFileSafe('reject-me.txt'));

  evs = await quest([task('conflict-a'), task('conflict-b')]);
  check('conflicting pieces: exactly one merges', merged(evs).length === 1, merged(evs).join());
  check('main checkout left clean after the conflict', sh(repo, 'status', '--porcelain') === '');

  autoDeny = true;
  evs = await quest([task('bell')]);
  autoDeny = false;
  check('bell rings and is answered', evs.some((e) => e.type === 'permission.request') && evs.some((e) => e.type === 'permission.resolved'));
  check('denied smith does not merge', merged(evs).length === 0);

  evs = await quest([task('slow'), task('queued-1'), task('queued-2')], () => {
    void waitFor((e) => e.type === 'task.assigned' && (e as { taskId: string }).taskId === 'slow').then(() => setTimeout(() => forge.handle({ type: 'quest.abort' }), 100));
  });
  const hist = store.history(1)[0];
  check('stop: quest marked interrupted', hist?.status === 'interrupted', hist?.status);
  check('stop: anvils cleared', worktrees() === 1);
  check('stop: no forge.error noise', !evs.some((e) => e.type === 'forge.error'));

  // Restart recovery: a proposed blueprint survives, a forging one is interrupted.
  blueprintTasks = [task('later')];
  forge.handle({ type: 'quest.request', text: 'survive a restart' });
  await waitFor((e) => e.type === 'blueprint.proposed' && (e as { tasks: { id: string }[] }).tasks[0]?.id === 'later');
  const reborn: ForgeEvent[] = [];
  await new Forge((e) => reborn.push(e), { repo, smiths: 2 }, new Store(join(root, 'forge.db')), stubs).recover();
  check('restart re-offers the pending blueprint', reborn.some((e) => e.type === 'blueprint.proposed'));
  check('history persisted across restart', (reborn.find((e) => e.type === 'history') as { quests: unknown[] } | undefined)?.quests.length === 7);

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

function readFileSafe(f: string): string {
  try {
    return readFileSync(join(repo, f), 'utf8');
  } catch {
    return '';
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
