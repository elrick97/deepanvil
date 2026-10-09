// Zero-token self-test of the forge's orchestration and of Odin, keeper of main: stub smiths
// and a stub reviewer, but real git, real gates (shell commands) and a throwaway database.
// Exercises every path that's rare in real life.
// Run inside WSL: bash scripts/server.sh selftest
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ForgeEvent, PlanQuestion } from '@deepanvil/shared';
import { Store } from '../store.ts';
import type { BlueprintTask, PlanInput, RescopeInput, TriageInput } from './forgemaster.ts';
import type { Policy } from './gates.ts';
import type { Verdict } from './odin-review.ts';
import { Forge, type Agents } from './orchestrator.ts';
import { runGate } from './gates.ts';
import { cloneTarget } from './git.ts';
import { systemFor } from './forgemaster.ts';
import { conventionsFor, loadInstructions, withInstructions } from './instructions.ts';
import { judge } from './permissions.ts';
import { Ledger, waitForRest } from './run.ts';
import { smithSystem, type SmithOutcome, type SmithRun } from './smith.ts';

const root = mkdtempSync(join(tmpdir(), 'deepanvil-selftest-'));
const repo = join(root, 'repo');
const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_EDITOR: 'true' } }).trim();
const shOk = (cwd: string, ...args: string[]) => {
  try {
    sh(cwd, ...args);
    return true;
  } catch {
    return false;
  }
};
mkdirSync(repo, { recursive: true });
sh(repo, 'init', '-q', '-b', 'main');
sh(repo, 'config', 'user.name', 't');
sh(repo, 'config', 'user.email', 't@t');
writeFileSync(join(repo, 'README.md'), '# test\n');
writeFileSync(join(repo, 'shared.txt'), 'base\n');
sh(repo, 'add', '-A');
sh(repo, 'commit', '-q', '-m', 'init');

// Gates are plain shell checks over the working tree:
//  tests: fails on a FAIL file or any "BROKEN" in a .txt; flaky.txt fails the first run only.
//  lint:  fails on "lint-error" in a .txt.
const flakyMark = join(root, 'flaky-mark');
const policy: Policy = {
  mode: 'auto',
  gates: {
    tests: `if test -e FAIL; then echo 'FAIL marker present: main is red'; exit 1; fi; ! grep -rqs BROKEN --include=*.txt . && { if [ -f flaky.txt ] && [ ! -f ${flakyMark} ]; then touch ${flakyMark}; exit 1; fi; true; }`,
    lint: '! grep -rqs lint-error --include=*.txt .',
  },
  gateTimeoutSec: 30,
  maxDiffLines: 50,
  flakyRetries: 1,
  protectedPaths: ['guarded/'],
};

const events: ForgeEvent[] = [];
const waiters: { pred: (e: ForgeEvent) => boolean; resolve: (e: ForgeEvent) => void }[] = [];
let autoDeny = false; // answer every bell with "no" (a denied smith may well ask again)
let humanAnswers: ('merge' | 'send_back')[] = []; // verdicts for offerings that wait for you
const emit = (e: ForgeEvent) => {
  events.push(e);
  if (autoDeny && e.type === 'permission.request') queueMicrotask(() => forge.handle({ type: 'permission.answer', requestId: e.requestId, approved: false }));
  if (e.type === 'offering.state' && e.state === 'awaiting_you') {
    const answer = humanAnswers.shift() ?? 'merge';
    queueMicrotask(() =>
      forge.handle(answer === 'merge' ? { type: 'offering.merge', offeringId: e.offeringId } : { type: 'offering.send_back', offeringId: e.offeringId, note: 'move it out of guarded/' }),
    );
  }
  for (const w of [...waiters]) if (w.pred(e)) {
    waiters.splice(waiters.indexOf(w), 1);
    w.resolve(e);
  }
};
const waitFor = (pred: (e: ForgeEvent) => boolean, ms = 15_000) =>
  new Promise<ForgeEvent>((resolve, reject) => {
    const hit = events.find(pred);
    if (hit) return resolve(hit);
    waiters.push({ pred, resolve });
    setTimeout(() => reject(new Error(`timed out waiting for event; last events: ${events.slice(-10).map((e) => e.type + ((e as { state?: string }).state ? ':' + (e as { state?: string }).state : '')).join(', ')}`)), ms);
  });

// ---------------------------------------------------------------- stub agents

let blueprintTasks: BlueprintTask[] = [];
let replans = 0;
const reviewed: string[] = [];
const task = (id: string): BlueprintTask => ({ id, title: id, brief: `do ${id}`, files: [], acceptance: 'true' });
const done = (summary: string): SmithOutcome => ({ status: 'done', testsPassed: true, summary });
const stuck = (summary: string): SmithOutcome => ({ status: 'stuck', testsPassed: false, summary });

// How the stub Thráin behaves: never ask, ask once (first round only), or ask whenever he may.
let askMode: 'never' | 'once' | 'always' = 'never';
const planCalls: PlanInput[] = [];
const stubQuestion: PlanQuestion = {
  id: 'q1',
  header: 'Scope',
  question: 'Which way?',
  options: [{ label: 'A', description: 'the small one' }, { label: 'B', description: 'the big one' }],
  multiSelect: false,
  recommended: ['B'],
};

// How the stub Thráin triages a blocked task, and a gate that holds one smith busy until he has.
let triageMode: 'rewrite' | 'reslice-equal' | 'reslice-grow' | 'ask-then-rewrite' = 'rewrite';
const triageCalls: TriageInput[] = [];
let holdOpen: (() => void) | undefined;
let holdGate: Promise<void> = Promise.resolve();
const blocked = (detail: string): SmithOutcome => ({ status: 'blocked', testsPassed: false, summary: detail, blocker: { kind: 'too_big', detail } });

// How the stub Thráin answers a rescope request.
let rescopeMode: 'swap-queued' | 'stop-running' | 'none' = 'none';
const rescopeCalls: RescopeInput[] = [];

const stubs: Agents = {
  rescope: async (input) => {
    rescopeCalls.push(input);
    if (rescopeMode === 'none') return { decision: 'none', reason: 'already covered' };
    if (rescopeMode === 'swap-queued') return { decision: 'change', reason: 'swap t3 for extra', add: [task('extra')], drop: ['t3', 'ghost'] };
    return { decision: 'change', reason: 'replace the slow one', add: [task('replacement')], drop: ['slowtask'] };
  },
  triage: async (input) => {
    triageCalls.push({ ...input, qa: [...input.qa] });
    holdOpen?.();
    if (triageMode === 'ask-then-rewrite' && input.canAsk) return { decision: 'ask', reason: 'needs your call', questions: [stubQuestion] };
    if (triageMode === 'reslice-equal') return { decision: 'reslice', reason: 'cut differently', tasks: [task('blocky-a')], drop: ['t3'] };
    if (triageMode === 'reslice-grow') return { decision: 'reslice', reason: 'two pieces now', tasks: [task('grow-a'), task('grow-b')], drop: [] };
    return { decision: 'rewrite', reason: 'a clearer brief', task: { ...input.blocked, brief: `${input.blocked.brief} unblocked` } };
  },
  plan: async (input, _repo, _emit, ledger) => {
    planCalls.push({ ...input, qa: [...input.qa] }); // a snapshot: the forge keeps appending to its own list
    if (askMode !== 'never' && input.canAsk && (askMode === 'always' || input.qa.length === 0)) return { kind: 'questions', questions: [stubQuestion], notes: 'repo notes' };
    if (input.feedback === 'slow') await new Promise((_, reject) => ledger.abort?.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    const revised = input.feedback ? { ...input.previous!, title: `Revised: ${input.feedback.slice(0, 20)}`, tasks: [...input.previous!.tasks, task(`extra-${input.qa.length}`)] } : undefined;
    return { kind: 'blueprint', blueprint: revised ?? { title: 'Test quest', summary: 'stub', tasks: blueprintTasks }, notes: 'repo notes' };
  },
  replan: async (t) => {
    replans++;
    return { ...t, brief: `${t.brief} (redrawn)` };
  },
  digest: async (output) => output.slice(-500),
  banter: async () => '',
  // The stub Odin review: "nitpick" needs polishing once; everything else is approved.
  reviewer: async (t, diff): Promise<Verdict> => {
    reviewed.push(t.id);
    if (t.id === 'nitpick' && !diff.includes('polished')) {
      return { decision: 'changes_requested', summary: 'Needs polish.', findings: [{ file: 'nitpick.txt', severity: 'major', note: 'not polished' }] };
    }
    return { decision: 'approve', summary: 'Looks right.', findings: [{ file: `${t.id}.txt`, severity: 'nit', note: 'fine' }] };
  },
  runSmith: async (run: SmithRun) => {
    const id = run.task.id;
    const wt = run.worktree;
    const write = (file: string, text: string) => {
      mkdirSync(join(wt, file, '..'), { recursive: true });
      writeFileSync(join(wt, file), text);
    };
    const notes = run.notes ?? '';
    // Odin said: rebase onto main and resolve the conflict.
    if (notes.includes('conflicts with main')) {
      if (!shOk(wt, 'rebase', 'main')) {
        write('shared.txt', 'base\nconflict-a\nconflict-b\n');
        sh(wt, 'add', 'shared.txt');
        sh(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'rebase', '--continue');
      }
      return done('rebased and resolved');
    }
    // "hold…" tasks wait at a gate the scenario opens (to keep a smith busy while the plan changes).
    if (/^hold\d*$/.test(id)) {
      await holdGate;
      write(`${id}.txt`, 'ok\n');
      return done(`did ${id}`);
    }
    switch (id) {
      case 'blocky':
      case 'qblocky':
        if (!run.task.brief.includes('unblocked')) return blocked('this is too big as briefed');
        write(`${id}.txt`, 'ok\n');
        return done(`did ${id}`);
      case 'always-blocked':
        return blocked('still impossible');
      case 'slowtask':
        // Only this task's own stop switch (a rescope) can end it.
        await new Promise<void>((_, reject) => {
          const signal = (run.abort ?? run.ledger.abort)?.signal;
          if (signal?.aborted) return reject(new Error('aborted'));
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
        return stuck('unreachable');
      case 'gatefix':
        write('gatefix.txt', notes.includes('gates failed') ? 'fixed\n' : 'BROKEN\n');
        return done('did gatefix');
      case 'bigone':
        write('bigone.txt', notes.includes('limit is') ? 'small\n' : `${'line\n'.repeat(80)}`);
        return done('did bigone');
      case 'nitpick':
        write('nitpick.txt', notes.includes('not polished') ? 'polished\n' : 'rough\n');
        return done('did nitpick');
      case 'guarded':
        write('guarded/rules.txt', `rev ${run.attempt}\n`);
        return done('did guarded');
      case 'flaky':
        write('flaky.txt', 'sometimes\n');
        return done('did flaky');
      case 'unrelated':
        write('unrelated.txt', 'ok\n');
        return done('did unrelated');
      case 'mend':
        rmSync(join(wt, 'FAIL'), { force: true });
        write('mend.txt', 'mended\n');
        return done('mended main');
      case 'bell':
        return (await run.ask('npm install something')) ? done('installed') : stuck('denied at the bell');
      case 'slow':
        await new Promise((_, reject) => run.ledger.abort?.signal.addEventListener('abort', () => reject(new Error('aborted'))));
        return stuck('unreachable');
    }
    if (id.startsWith('conflict')) write('shared.txt', `base\n${id}\n`);
    else write(`${id}.txt`, `${id}\n`);
    return done(`did ${id}`);
  },
};

// ---------------------------------------------------------------- scenarios

const store = new Store(join(root, 'forge.db'));
store.setPolicy(repo, JSON.stringify(policy));
const forge = new Forge(emit, { repo, smiths: 2, sandboxRepo: repo }, store, stubs);
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
  await waitFor((e) => e.type === 'forge.status' && !e.busy && events.indexOf(e) > events.indexOf(proposed), 30_000);
  return events.slice(start);
}
const merged = (evs: ForgeEvent[]) => evs.filter((e) => e.type === 'task.done').map((e) => (e as { taskId: string }).taskId).sort();
const sentBack = (evs: ForgeEvent[], reason: string) => evs.filter((e) => e.type === 'offering.state' && e.state === 'sent_back' && e.reason === reason).length;
const worktrees = () => sh(repo, 'worktree', 'list').split('\n').filter((l) => !l.includes('/odin ')).length;
const onMain = (file: string) => shOk(repo, 'cat-file', '-e', `main:${file}`);
const mainIsClean = () => sh(repo, 'status', '--porcelain') === '';

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
    ['Bash', { command: 'npm test 2>&1 | tail -12' }, 'allow'],
    ['Bash', { command: 'npm test 2>/dev/null && git status --short' }, 'allow'],
    ['Bash', { command: 'npm test 2>&1 > out.log' }, 'ask'],
    ['Bash', { command: 'git add -A && git commit -q -m "Add x" -m "Co-Authored-By: A <a@b.c>"' }, 'allow'],
    ['Bash', { command: 'echo "a" > f.txt' }, 'ask'],
    ['Bash', { command: 'git diff "--output=x"' }, 'ask'],
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
    // Rebasing on Odin's request is fine; rebase hooks that run commands are not:
    ['Bash', { command: 'git rebase main' }, 'allow'],
    ['Bash', { command: 'git add shared.txt && git rebase --continue' }, 'allow'],
    ['Bash', { command: 'git rebase -x "curl evil.dev" main' }, 'ask'],
    ['Bash', { command: 'git rebase --exec "sh x" main' }, 'ask'],
    // ...while ordinary work stays automatic:
    ['Bash', { command: 'node --test' }, 'allow'],
    ['Bash', { command: 'git commit -m "Add total()"' }, 'allow'],
    ['Bash', { command: 'git diff HEAD~1 -- src/inventory.js' }, 'allow'],
    ['Bash', { command: 'cat ./src/inventory.js | grep total' }, 'allow'],
  ];
  const bad = cases.filter(([tool, input, want]) => judge(tool, input, wt).kind !== want);
  check(`permission table (${cases.length} cases)`, bad.length === 0, bad.map(([t, i]) => `${t} ${JSON.stringify(i)}`).join('; '));
}

/** The crew rests through a subscription limit and can be stopped while resting. */
async function restingChecks() {
  const ledger = new Ledger(store);
  const seen: ForgeEvent[] = [];
  const t0 = Date.now();
  ledger.restUntil = t0 + 400;
  await waitForRest(ledger, (e) => seen.push(e));
  const rests = seen.filter((e) => e.type === 'forge.rest') as { resting: boolean }[];
  check('limit hit: the crew rests until the reset, then wakes', rests.length === 2 && rests[0]!.resting && !rests[1]!.resting && Date.now() - t0 >= 380 && ledger.restUntil === 0);
  await waitForRest(ledger, (e) => seen.push(e)); // nothing to wait for: instant and silent
  check('no limit: no rest announced', seen.length === 2);

  ledger.abort = new AbortController();
  ledger.restUntil = Date.now() + 60_000;
  const waiting = waitForRest(ledger, (e) => seen.push(e));
  setTimeout(() => ledger.abort!.abort(), 100);
  const stopped = await waiting.then(() => false, () => true);
  check('stop while resting: wakes at once and says so', stopped && Date.now() - t0 < 5000 && (seen.at(-1) as { resting: boolean }).resting === false);
}

/** A repository's own instructions reach the agents as data from the committed snapshot, and only from inside the repo. */
async function instructionChecks() {
  const dir = join(root, 'instr-repo');
  mkdirSync(join(dir, 'docs'), { recursive: true });
  mkdirSync(join(dir, '.claude'), { recursive: true });
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.name', 't');
  sh(dir, 'config', 'user.email', 't@t');
  writeFileSync(join(root, 'secret.txt'), 'TOP-SECRET-VALUE\n');
  writeFileSync(join(dir, 'CLAUDE.md'), 'Use tabs.\nSee @docs/style.md for the rules, and @../secret.txt and @/etc/passwd.md too.\n');
  writeFileSync(join(dir, 'docs', 'style.md'), 'STYLE-GUIDE-MARKER\n');
  writeFileSync(join(dir, 'AGENTS.md'), 'Agents: run npm test before committing.\n');
  symlinkSync(join(root, 'secret.txt'), join(dir, '.claude', 'CLAUDE.md')); // a symlink to a secret outside the repo
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'init');
  writeFileSync(join(dir, 'CLAUDE.md'), 'UNCOMMITTED-EDIT\n'); // not committed: not what the agents get

  const inst = await loadInstructions(dir);
  check('instructions: CLAUDE.md and AGENTS.md are found, the symlink is skipped', inst.files.join() === 'CLAUDE.md,AGENTS.md', inst.files.join());
  check('instructions: the committed text is used, with an in-repo @import inlined', inst.text.includes('Use tabs.') && inst.text.includes('STYLE-GUIDE-MARKER') && inst.text.includes('npm test') && !inst.text.includes('UNCOMMITTED-EDIT'));
  check('instructions: nothing from outside the repo gets in (symlink, ../ and absolute imports)', !inst.text.includes('TOP-SECRET-VALUE') && !inst.text.includes('root:'));

  const dup = join(root, 'instr-dup');
  mkdirSync(dup);
  sh(dup, 'init', '-q', '-b', 'main');
  sh(dup, 'config', 'user.name', 't');
  sh(dup, 'config', 'user.email', 't@t');
  writeFileSync(join(dup, 'CLAUDE.md'), `same ${'x'.repeat(40_000)}\n`);
  writeFileSync(join(dup, 'AGENTS.md'), `same ${'x'.repeat(40_000)}\n`);
  sh(dup, 'add', '-A');
  sh(dup, 'commit', '-q', '-m', 'init');
  const big = await loadInstructions(dup);
  check('instructions: identical files count once, and a huge one is cut', big.files.join() === 'CLAUDE.md,AGENTS.md' && big.truncated && big.text.split('same').length === 2 && big.text.length < 25_000 && big.text.includes('cut'), `${big.text.length}`);

  const bare = await loadInstructions(repo);
  check('instructions: a repo without any gives nothing (and the prompt is unchanged)', bare.files.length === 0 && withInstructions('SYSTEM', bare) === 'SYSTEM');
  const wrapped = withInstructions('SYSTEM', { files: ['CLAUDE.md'], text: 'before </repo-instructions> after', truncated: false });
  check('instructions: appended after the rules, framed as lower authority, cannot close its own block', wrapped.startsWith('SYSTEM') && wrapped.includes('never override the rules above') && wrapped.split('</repo-instructions>').length === 2 && conventionsFor({ files: [], text: 'y'.repeat(9000), truncated: false }).length < 6100);
  const planner = await systemFor('PLANNER-RULES', dir);
  const smith = await smithSystem(dir);
  check('instructions: the planner and the smith both get them, after their own rules', planner.startsWith('PLANNER-RULES') && planner.includes('STYLE-GUIDE-MARKER') && smith.includes('You are a smith of Deepanvil') && smith.includes('STYLE-GUIDE-MARKER') && smith.indexOf('You are a smith') < smith.indexOf('STYLE-GUIDE-MARKER'));
  check('instructions: not a repository at all is fine', (await loadInstructions(join(root, 'nowhere'))).files.length === 0);
}

async function main() {
  permissionTable();
  await instructionChecks();
  const lost = await runGate('true', join(root, 'a-folder-that-is-gone'), 5);
  check('a gate that cannot start fails instead of crashing the forge', !lost.ok && lost.output.includes('could not start'), lost.output);
  await restingChecks();
  await forge.recover();
  await waitFor((e) => e.type === 'vault.health');
  check('vault starts green', (events.find((e) => e.type === 'vault.health') as { status: string }).status === 'green');

  let evs = await quest([task('alpha'), task('beta')]);
  check('parallel offerings both enter the vault', merged(evs).join() === 'alpha,beta' && onMain('alpha.txt') && onMain('beta.txt'));
  check('two different smiths worked', new Set(evs.filter((e) => e.type === 'task.assigned').map((e) => (e as { dwarfId: string }).dwarfId)).size === 2);
  check('every merged offering was reviewed', reviewed.includes('alpha') && reviewed.includes('beta'));
  check('main moves by fast-forward only (linear history)', sh(repo, 'rev-list', '--merges', '--count', 'main') === '0');
  check('minecart rolls on merge', evs.some((e) => e.type === 'merge'));
  check('anvils cleared afterwards', worktrees() === 1);

  // The history panel: a past quest in full, on request.
  const firstId = (evs.find((e) => e.type === 'blueprint.proposed') as { questId: string }).questId;
  const detailAt = events.length;
  forge.handle({ type: 'history.open', questId: firstId });
  const detail = (await waitFor((e) => e.type === 'quest.detail' && events.indexOf(e) >= detailAt)) as Extract<ForgeEvent, { type: 'quest.detail' }>;
  check('history: a past quest comes back with tasks, offerings and reviews', detail.detail.tasks.map((t) => t.id).sort().join() === 'alpha,beta' && detail.detail.tasks.every((t) => t.status === 'merged') && detail.detail.offerings.length === 2 && detail.detail.offerings.every((o) => o.state === 'merged' && o.review?.decision === 'approve') && detail.detail.request === 'test', JSON.stringify(detail.detail.offerings));
  const unknownAt = events.length;
  forge.handle({ type: 'history.open', questId: 'no-such-quest' });
  await new Promise((r) => setTimeout(r, 100));
  check('history: an unknown quest id is ignored', !events.slice(unknownAt).some((e) => e.type === 'quest.detail'));

  evs = await quest([task('gatefix')]);
  check('red gate → sent back with notes → fixed', sentBack(evs, 'gate') === 1 && merged(evs).join() === 'gatefix');
  check('no review spent on the red revision', reviewed.filter((t) => t === 'gatefix').length === 1);

  evs = await quest([task('conflict-a'), task('conflict-b')]);
  check('conflict → smith rebases & resolves → both merged', sentBack(evs, 'conflict') === 1 && merged(evs).join() === 'conflict-a,conflict-b', merged(evs).join());
  check('resolution kept both sides', readFileSync(join(repo, 'shared.txt'), 'utf8').includes('conflict-a') && readFileSync(join(repo, 'shared.txt'), 'utf8').includes('conflict-b'));
  check('main checkout clean after the conflict', mainIsClean());

  evs = await quest([task('bigone')]);
  check('oversized offering → "split it" → smaller one merged', sentBack(evs, 'too_big') === 1 && merged(evs).join() === 'bigone');

  evs = await quest([task('nitpick')]);
  check('review asks for changes → revision 2 merged', sentBack(evs, 'review') === 1 && merged(evs).join() === 'nitpick');
  check('minor findings never block', evs.some((e) => e.type === 'offering.review' && e.decision === 'approve'));

  humanAnswers = ['send_back', 'merge'];
  evs = await quest([task('guarded')]);
  check('protected path waits for you (auto mode or not)', evs.filter((e) => e.type === 'offering.state' && e.state === 'awaiting_you').length === 2);
  check('your send-back returns to the smith, your merge lands it', sentBack(evs, 'human') === 1 && merged(evs).join() === 'guarded');

  evs = await quest([task('flaky')]);
  check('flaky gate is retried and noted, not blocking', evs.some((e) => e.type === 'offering.gate' && e.status === 'flaky') && merged(evs).join() === 'flaky');

  // A cracked vault: something red lands on main outside the forge.
  writeFileSync(join(repo, 'FAIL'), 'red\n');
  sh(repo, 'add', 'FAIL');
  sh(repo, 'commit', '-q', '-m', 'oops');
  const replansBefore = replans;
  evs = await quest([task('unrelated')]);
  check('red main: health check reports it', evs.some((e) => e.type === 'vault.health' && e.status === 'red'));
  check('red main: unrelated work cannot enter', merged(evs).length === 0 && !onMain('unrelated.txt'));

  // The vault panel: Odin's rules and how recent offerings fared (gate output, his review).
  const vaultAt = events.length;
  forge.handle({ type: 'vault.open' });
  const vault = (await waitFor((e) => e.type === 'vault.info' && events.indexOf(e) >= vaultAt)) as Extract<ForgeEvent, { type: 'vault.info' }>;
  const refused = vault.info.recent.find((o) => o.taskId === 'unrelated');
  const entered = vault.info.recent.find((o) => o.taskId === 'gatefix');
  check('vault panel: Odin\'s policy', vault.info.policy.mode === policy.mode && vault.info.policy.maxDiffLines === policy.maxDiffLines && Object.keys(vault.info.policy.gates).length > 0 && vault.info.repo.length > 0 && !vault.info.repo.includes('/'));
  check('vault panel: a refused offering shows its failing gate and output', refused?.state === 'sent_back' && refused.gates.some((g) => g.status === 'fail' && g.tail.length > 0), JSON.stringify(refused?.gates));
  check('vault panel: a merged offering shows its passing gates and Odin\'s review', entered?.state === 'merged' && entered.revision === 2 && entered.gates.length > 0 && entered.gates.every((g) => g.status === 'pass') && entered.review?.decision === 'approve', JSON.stringify(entered?.review));
  check('vault panel: newest offering first', vault.info.recent.every((o, i, all) => i === 0 || all[i - 1]!.at >= o.at));
  check('two failures escalate to Thráin, the third gives up', replans === replansBefore + 1 && evs.some((e) => e.type === 'escalation'));
  evs = await quest([task('mend')]);
  check('mending main enters and turns the vault green', merged(evs).join() === 'mend' && evs.some((e) => e.type === 'vault.health' && e.status === 'green'));

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

  // The replanning ladder: a blocked smith is triaged by Thráin; small changes just happen, bigger ones ask you.
  const amended = (evs: ForgeEvent[], state: string) => evs.filter((e) => e.type === 'plan.amended' && e.state === state) as Extract<ForgeEvent, { type: 'plan.amended' }>[];
  const heldGate = () => {
    holdGate = new Promise<void>((resolve) => (holdOpen = resolve));
  };

  triageMode = 'rewrite';
  triageCalls.length = 0;
  evs = await quest([task('blocky')]);
  check('blocked → rewritten → the same smith finishes it', merged(evs).join() === 'blocky' && triageCalls.length === 1 && amended(evs, 'applied')[0]?.changed[0]?.brief?.includes('unblocked') === true);
  check('blocked: the smith carries the ingot back (escalation), no failure counted', evs.some((e) => e.type === 'escalation' && e.reason.startsWith('blocked')) && !evs.some((e) => e.type === 'test.fail'));
  check('triage sees every task and what the smith said', triageCalls[0]?.tasks.map((t) => t.id).join() === 'blocky' && triageCalls[0].detail === 'this is too big as briefed' && triageCalls[0].canAsk);

  triageMode = 'reslice-equal';
  heldGate();
  evs = await quest([task('blocky'), task('hold'), task('t3')]);
  const cut = amended(evs, 'applied')[0];
  check('reslice (same size): applied without asking, obsolete queued task dropped', cut?.added.map((t) => t.id).join() === 'blocky-a' && cut.dropped.map((d) => d.id).sort().join() === 'blocky,t3', JSON.stringify(cut?.dropped));
  check('...the new task is forged, the dropped one never runs', merged(evs).join() === 'blocky-a,hold' && !evs.some((e) => e.type === 'task.assigned' && e.taskId === 't3'), merged(evs).join());
  check('...and the stored blueprint follows the amendment', JSON.stringify(store.history(1)[0]).includes('"status":"done"'));
  holdOpen = undefined;
  holdGate = Promise.resolve();

  triageMode = 'reslice-grow';
  evs = await quest([task('blocky')], () => {
    void waitFor((e) => e.type === 'plan.amended' && e.state === 'proposed').then((e) => forge.handle({ type: 'plan.change', changeId: (e as { changeId: string }).changeId, approve: true }));
  });
  check('reslice that grows the plan waits for you, then proceeds', amended(evs, 'proposed').length === 1 && amended(evs, 'applied').length === 1 && merged(evs).join() === 'grow-a,grow-b', merged(evs).join());

  evs = await quest([task('blocky')], () => {
    void waitFor((e) => e.type === 'plan.amended' && e.state === 'proposed' && events.indexOf(e) > events.length - 40).then((e) => forge.handle({ type: 'plan.change', changeId: (e as { changeId: string }).changeId, approve: false }));
  });
  check('declining keeps the original plan: the blocked piece is left undone', amended(evs, 'declined').length === 1 && merged(evs).length === 0 && !amended(evs, 'applied').length);

  triageMode = 'ask-then-rewrite';
  triageCalls.length = 0;
  evs = await quest([task('qblocky')], () => {
    void waitFor((e) => e.type === 'plan.questions' && events.indexOf(e) > events.length - 40).then((e) => forge.handle({ type: 'plan.answer', questId: (e as { questId: string }).questId, answers: { q1: { picks: ['A'] } } }));
  });
  check('a decision only you can make: Thráin asks mid-quest, then redraws', triageCalls.length === 2 && triageCalls[1]!.qa[0]?.answer.picks.join() === 'A' && !triageCalls[1]!.canAsk && merged(evs).join() === 'qblocky', `${triageCalls.length} calls`);

  triageMode = 'rewrite';
  triageCalls.length = 0;
  evs = await quest([task('always-blocked')]);
  check('replan cap: after three redraws the task fails instead of looping', triageCalls.length === 3 && merged(evs).length === 0 && store.history(1)[0]?.status === 'failed', `${triageCalls.length} calls`);

  triageMode = 'reslice-grow';
  evs = await quest([task('blocky')], () => {
    void waitFor((e) => e.type === 'plan.amended' && e.state === 'proposed' && events.indexOf(e) > events.length - 40).then(() => forge.handle({ type: 'quest.abort' }));
  });
  check('stop while a change waits for your answer: the quest ends cleanly', store.history(1)[0]?.status === 'interrupted' && !evs.some((e) => e.type === 'forge.error'), store.history(1)[0]?.status);
  triageMode = 'rewrite';

  // Rescoping by hand while the crew works: a proposal, your yes, and only what can still be stopped is stopped.
  const questIdNow = () => (events.findLast((e) => e.type === 'blueprint.approved') as { questId: string }).questId;
  const proposedChange = (at: number) => waitFor((e) => e.type === 'plan.amended' && e.state === 'proposed' && events.indexOf(e) >= at) as Promise<Extract<ForgeEvent, { type: 'plan.amended' }>>;
  const rescopeNow = (note: string) => forge.handle({ type: 'quest.rescope', questId: questIdNow(), note });

  rescopeMode = 'swap-queued';
  rescopeCalls.length = 0;
  heldGate();
  evs = await quest([task('hold3'), task('hold4'), task('t3')], () => {
    void (async () => {
      await waitFor((e) => e.type === 'task.assigned' && (e as { taskId: string }).taskId === 'hold4');
      const at = events.length;
      rescopeNow('swap t3 for something else');
      const proposal = await proposedChange(at);
      forge.handle({ type: 'plan.change', changeId: proposal.changeId, approve: true });
      await waitFor((e) => e.type === 'plan.amended' && e.state === 'applied' && events.indexOf(e) >= at);
      holdOpen?.();
    })();
  });
  const swap = amended(evs, 'applied').find((e) => e.source === 'rescope');
  check('rescope: Thráin sees every task and where it stands', rescopeCalls[0]?.tasks.find((t) => t.id === 't3')?.status === 'queued' && rescopeCalls[0].tasks.find((t) => t.id === 'hold3')?.status === 'running' && rescopeCalls[0].note === 'swap t3 for something else');
  check('rescope: you approve, the queued task is swapped (unknown ids ignored)', swap?.dropped.map((d) => d.id).join() === 't3' && swap.added.map((t) => t.id).join() === 'extra', JSON.stringify(swap?.dropped));
  check('...the swapped-in task is forged, the dropped one never runs', merged(evs).join() === 'extra,hold3,hold4' && !evs.some((e) => e.type === 'task.assigned' && e.taskId === 't3'), merged(evs).join());

  rescopeMode = 'stop-running';
  evs = await quest([task('slowtask')], () => {
    void (async () => {
      await waitFor((e) => e.type === 'task.assigned' && (e as { taskId: string }).taskId === 'slowtask' && events.indexOf(e) >= events.length - 30);
      const at = events.length;
      rescopeNow('drop the slow one');
      const proposal = await proposedChange(at);
      forge.handle({ type: 'plan.change', changeId: proposal.changeId, approve: true });
    })();
  });
  const stopProposal = amended(evs, 'proposed').find((e) => e.source === 'rescope');
  check('rescope: stopping a running task is announced in the proposal', stopProposal?.stopping?.join() === 'slowtask');
  check('rescope: that smith stops alone, the replacement is forged, no errors', merged(evs).join() === 'replacement' && store.history(1)[0]?.status === 'done' && !evs.some((e) => e.type === 'forge.error'), `${merged(evs).join()} ${store.history(1)[0]?.status}`);

  rescopeMode = 'swap-queued';
  heldGate();
  evs = await quest([task('hold5')], () => {
    void (async () => {
      await waitFor((e) => e.type === 'task.assigned' && (e as { taskId: string }).taskId === 'hold5' && events.indexOf(e) >= events.length - 30);
      const at = events.length;
      rescopeNow('add something');
      const proposal = await proposedChange(at);
      forge.handle({ type: 'plan.change', changeId: proposal.changeId, approve: false });
      await waitFor((e) => e.type === 'plan.amended' && e.state === 'declined' && events.indexOf(e) >= at);
      holdOpen?.();
    })();
  });
  check('rescope declined: the plan stays as it was', amended(evs, 'declined').length === 1 && merged(evs).join() === 'hold5' && !amended(evs, 'applied').some((e) => e.source === 'rescope'));

  rescopeMode = 'none';
  rescopeCalls.length = 0;
  heldGate();
  evs = await quest([task('hold6')], () => {
    void (async () => {
      await waitFor((e) => e.type === 'task.assigned' && (e as { taskId: string }).taskId === 'hold6' && events.indexOf(e) >= events.length - 30);
      const at = events.length;
      rescopeNow('already covered?');
      await waitFor((e) => e.type === 'master.say' && e.text === 'already covered' && events.indexOf(e) >= at);
      // The cap: four rescopes per quest.
      for (let i = 0; i < 4; i++) {
        const before = rescopeCalls.length;
        rescopeNow(`again ${i}`);
        await new Promise((r) => setTimeout(r, 150));
        if (rescopeCalls.length === before) break;
      }
      holdOpen?.();
    })();
  });
  check('rescope: "no change needed" is just an answer, no proposal', !amended(evs, 'proposed').length);
  check('rescope cap: the fifth is refused', rescopeCalls.length === 4, `${rescopeCalls.length} calls`);

  const quiet = events.length;
  rescopeNow('nothing is running');
  await new Promise((r) => setTimeout(r, 150));
  check('rescope with no quest running does nothing', events.length === quiet && rescopeCalls.length === 4);
  holdOpen = undefined;
  holdGate = Promise.resolve();
  rescopeMode = 'none';

  // Clarifying questions: Thráin asks, you answer (or tell him to just draft), at most two rounds.
  const nextEvent = async <T extends ForgeEvent['type']>(type: T, from: number) =>
    (await waitFor((e) => e.type === type && events.indexOf(e) >= from)) as Extract<ForgeEvent, { type: T }>;
  const ask = (text: string) => {
    const from = events.length;
    forge.handle({ type: 'quest.request', text });
    return from;
  };
  const rejectDraft = (questId: string) => forge.handle({ type: 'blueprint.reject', questId });
  blueprintTasks = [task('asked')];

  askMode = 'once';
  planCalls.length = 0;
  let from = ask('something vague');
  let qs = await nextEvent('plan.questions', from);
  check('vague request: Thráin asks first, the forge stays busy', qs.round === 1 && qs.questions[0]?.recommended[0] === 'B' && !events.slice(from).some((e) => e.type === 'blueprint.proposed'));
  forge.handle({ type: 'plan.answer', questId: qs.questId, answers: { q1: { picks: ['A', 'bogus'], other: 'and log it' } } });
  let bp = await nextEvent('blueprint.proposed', from);
  const second = planCalls[1];
  check('answers reach the planner with his own notes', second?.qa[0]?.answer.picks.join() === 'A' && second.qa[0].answer.other === 'and log it' && second.notes === 'repo notes' && second.round === 2);
  check('only real option labels count as picks', second?.qa[0]?.answer.picks.length === 1);
  rejectDraft(bp.questId);
  check('rejecting a blueprint tells every screen', (await nextEvent('blueprint.rejected', from)).questId === bp.questId);

  askMode = 'always';
  planCalls.length = 0;
  from = ask('vague again');
  qs = await nextEvent('plan.questions', from);
  forge.handle({ type: 'plan.skip', questId: qs.questId });
  bp = await nextEvent('blueprint.proposed', from);
  check('"just draft it": his own picks, no more questions', planCalls.length === 2 && !planCalls[1]!.canAsk && planCalls[1]!.qa[0]?.answer.picks.join() === 'B');
  rejectDraft(bp.questId);

  planCalls.length = 0;
  from = ask('very vague');
  qs = await nextEvent('plan.questions', from);
  forge.handle({ type: 'plan.answer', questId: qs.questId, answers: { q1: { picks: ['A'] } } });
  const round2 = await nextEvent('plan.questions', events.indexOf(qs) + 1);
  forge.handle({ type: 'plan.answer', questId: round2.questId, answers: { q1: { picks: ['B'] } } });
  bp = await nextEvent('blueprint.proposed', from);
  check('two rounds at most: the third turn must draft', round2.round === 2 && planCalls.length === 3 && !planCalls[2]!.canAsk && planCalls[2]!.qa.length === 2);
  rejectDraft(bp.questId);

  askMode = 'once';
  from = ask('abandoned');
  qs = await nextEvent('plan.questions', from);
  forge.handle({ type: 'quest.abort' });
  await waitFor((e) => e.type === 'forge.status' && !e.busy && events.indexOf(e) > events.indexOf(qs));
  check('stop while he waits for answers shelves the quest', store.history(1)[0]?.status === 'rejected', store.history(1)[0]?.status);
  forge.handle({ type: 'plan.answer', questId: qs.questId, answers: {} }); // a late answer is ignored
  check('a late answer after stopping does nothing', !events.slice(events.indexOf(qs) + 1).some((e) => e.type === 'blueprint.proposed'));
  askMode = 'never';

  // Revising a blueprint: Thráin redraws in the same conversation; tasks can be dropped without tokens.
  blueprintTasks = [task('keep'), task('cut')];
  planCalls.length = 0;
  from = ask('plan me something');
  bp = await nextEvent('blueprint.proposed', from);
  check('the blueprint carries task detail for the card', bp.tasks[0]?.brief === 'do keep' && bp.tasks[0].acceptance === 'true' && bp.summary === 'stub' && bp.revision === 0);
  forge.handle({ type: 'blueprint.revise', questId: bp.questId, note: 'also add logging' });
  const revising = await nextEvent('blueprint.revising', from);
  const rev = await nextEvent('blueprint.revised', from);
  const last = planCalls.at(-1)!;
  check('revision: he sees his old plan, your note and his repo notes', last.previous?.tasks.length === 2 && last.feedback === 'also add logging' && !last.canAsk && last.notes === 'repo notes' && last.qa.at(-1)?.answer.other === 'also add logging');
  check('revision: announced, then the redrawn plan (revision 1)', events.indexOf(revising) < events.indexOf(rev) && rev.revision === 1 && rev.tasks.length === 3 && rev.title.startsWith('Revised'));
  forge.handle({ type: 'blueprint.drop', questId: bp.questId, taskId: 'cut' });
  const dropped = await waitFor((e) => e.type === 'blueprint.revised' && e.revision === 2);
  check('dropping a task costs no tokens and bumps the revision', (dropped as { tasks: { id: string }[] }).tasks.map((t) => t.id).join() === 'keep,extra-1' && planCalls.length === 2);
  forge.handle({ type: 'blueprint.approve', questId: bp.questId });
  await waitFor((e) => e.type === 'forge.status' && !e.busy && events.indexOf(e) > events.indexOf(dropped), 30_000);
  check('only the tasks that stayed were forged', merged(events.slice(from)).join() === 'extra-1,keep', merged(events.slice(from)).join());

  // The revision cap: each redraw is an Opus call.
  blueprintTasks = [task('cap')];
  from = ask('endless tinkering');
  bp = await nextEvent('blueprint.proposed', from);
  for (let i = 1; i <= 6; i++) {
    forge.handle({ type: 'blueprint.revise', questId: bp.questId, note: `change ${i}` });
    await waitFor((e) => e.type === 'blueprint.revised' && e.revision === i && events.indexOf(e) >= from);
  }
  const callsBefore = planCalls.length;
  const evCount = events.length;
  forge.handle({ type: 'blueprint.revise', questId: bp.questId, note: 'one more' });
  await new Promise((r) => setTimeout(r, 200));
  check('revision cap: the seventh redraw is refused', planCalls.length === callsBefore && !events.slice(evCount).some((e) => e.type === 'blueprint.revising'));
  rejectDraft(bp.questId);

  // Stopping mid-revision keeps the old blueprint.
  blueprintTasks = [task('steady')];
  from = ask('revise then stop');
  bp = await nextEvent('blueprint.proposed', from);
  forge.handle({ type: 'blueprint.revise', questId: bp.questId, note: 'slow' });
  const slowStart = await nextEvent('blueprint.revising', from);
  forge.handle({ type: 'quest.abort' });
  const restored = (await waitFor((e) => e.type === 'blueprint.revised' && events.indexOf(e) > events.indexOf(slowStart))) as { revision: number; tasks: unknown[] };
  check('stop mid-revision: the old blueprint comes back, still approvable', restored.revision === 0 && restored.tasks.length === 1);
  forge.handle({ type: 'blueprint.approve', questId: bp.questId });
  await waitFor((e) => e.type === 'forge.status' && !e.busy && events.indexOf(e) > events.indexOf(slowStart), 30_000);
  check('...and it forges normally afterwards', merged(events.slice(from)).join() === 'steady', merged(events.slice(from)).join());

  // Projects: add by path (validated), switch only when idle, a repo whose branch is not "main", history per project.
  const errorFor = async (cmd: Parameters<typeof forge.handle>[0]) => {
    const at = events.length;
    forge.handle(cmd);
    return ((await waitFor((e) => e.type === 'forge.error' && events.indexOf(e) >= at)) as { message: string }).message;
  };
  const mkRepo = (name: string, branch: string, commit = true) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    sh(dir, 'init', '-q', '-b', branch);
    sh(dir, 'config', 'user.name', 't');
    sh(dir, 'config', 'user.email', 't@t');
    if (commit) {
      writeFileSync(join(dir, 'README.md'), `# ${name}\n`);
      sh(dir, 'add', '-A');
      sh(dir, 'commit', '-q', '-m', 'init');
    }
    return dir;
  };
  const lastProjects = () => (events.findLast((e) => e.type === 'projects') as Extract<ForgeEvent, { type: 'projects' }>).projects;
  const trunkRepo = mkRepo('trunk-repo', 'trunk');
  writeFileSync(join(trunkRepo, 'CLAUDE.md'), 'Keep functions small.\n');
  sh(trunkRepo, 'add', '-A');
  sh(trunkRepo, 'commit', '-q', '-m', 'add instructions');
  const emptyRepo = mkRepo('empty-repo', 'main', false);
  const detached = mkRepo('detached-repo', 'main');
  sh(detached, 'checkout', '-q', '--detach');
  const plain = join(root, 'plain-folder');
  mkdirSync(plain);

  check('projects: the starting repo is listed and active', lastProjects().length === 1 && lastProjects()[0]!.active && lastProjects()[0]!.path === realpathSync(repo));
  check('projects: a relative path is refused', (await errorFor({ type: 'project.add', path: 'some/where' })).includes('absolute'));
  check('projects: a Windows path is refused with a hint', (await errorFor({ type: 'project.add', path: 'C:\\Users\\me\\proj' })).includes('WSL'));
  check('projects: a missing folder is refused', (await errorFor({ type: 'project.add', path: join(root, 'nope') })).includes('no folder'));
  check('projects: a folder that is not a repository is refused', (await errorFor({ type: 'project.add', path: plain })).includes('not a git repository'));
  check('projects: a repository without commits is refused', (await errorFor({ type: 'project.add', path: emptyRepo })).includes('no commits'));
  check('projects: a detached HEAD is refused', (await errorFor({ type: 'project.add', path: detached })).includes('detached'));
  check('projects: only https clone URLs are accepted', (await errorFor({ type: 'project.clone', url: 'file:///etc' })).includes('https'));
  check('projects: clone URL names and rejections', cloneTarget('https://github.com/o/r.git', '/p').name === 'r' && cloneTarget('https://github.com/o/r.git', '/p').dir === '/p/r' && ['ssh://git@github.com/o/r', 'http://github.com/o/r', 'https://x.com/../etc', 'git@github.com:o/r', 'https://github.com/o/r; rm -rf ~', '--upload-pack=x'].every((u) => !(() => { try { cloneTarget(u, '/p'); return true; } catch { return false; } })()));

  // Adding a subfolder adds its repository; being idle, the forge turns to it.
  mkdirSync(join(trunkRepo, 'sub'));
  const addAt = events.length;
  forge.handle({ type: 'project.add', path: join(trunkRepo, 'sub') });
  await waitFor((e) => e.type === 'forge.status' && e.repo === realpathSync(trunkRepo) && events.indexOf(e) >= addAt);
  check('projects: adding a subfolder adds the repository and switches to it', lastProjects().length === 2 && lastProjects().find((p) => p.active)?.path === realpathSync(trunkRepo));
  check('projects: the picker is told which instruction files the agents read', lastProjects().find((p) => p.active)?.instructions?.join() === 'CLAUDE.md');
  check('projects: not the sandbox, so Odin will ask before merging', lastProjects().find((p) => p.active)?.sandbox === false);

  // A repo on a branch called "trunk": Odin keeps that branch, not "main".
  evs = await quest([task('projA')]);
  check('a project whose branch is not main: the piece merges into that branch', merged(evs).join() === 'projA' && shOk(trunkRepo, 'cat-file', '-e', 'trunk:projA.txt') && sh(trunkRepo, 'log', '--oneline', 'trunk').includes('projA'), merged(evs).join());
  check('...and the quest belongs to that project only', store.history(30, realpathSync(trunkRepo)).length === 1 && !store.history(30, realpathSync(repo)).some((q) => q.title === 'Test quest' && q.merged === 1 && q.id === store.history(30, realpathSync(trunkRepo))[0]!.id));
  const vaultAt2 = events.length;
  forge.handle({ type: 'vault.open' });
  const trunkVault = (await waitFor((e) => e.type === 'vault.info' && events.indexOf(e) >= vaultAt2)) as Extract<ForgeEvent, { type: 'vault.info' }>;
  check('...the vault panel shows that project', trunkVault.info.repo === 'trunk-repo' && trunkVault.info.policy.mode === 'approve' && trunkVault.info.recent[0]?.taskId === 'projA');

  // Switching is refused while a quest runs; adding is allowed but does not switch.
  evs = await quest([task('slow')], () => {
    void (async () => {
      await waitFor((e) => e.type === 'task.assigned' && (e as { taskId: string }).taskId === 'slow' && events.indexOf(e) >= events.length - 30);
      const refusal = await errorFor({ type: 'project.switch', path: realpathSync(repo) });
      check('projects: switching mid-quest is refused', refusal.includes('Finish or stop'));
      const other = mkRepo('late-repo', 'main');
      forge.handle({ type: 'project.add', path: other });
      await waitFor((e) => e.type === 'projects' && e.projects.some((pr) => pr.name === 'late-repo') && events.indexOf(e) >= events.length - 30);
      forge.handle({ type: 'quest.abort' });
    })();
  });
  check('projects: adding mid-quest lists the project without switching', lastProjects().some((pr) => pr.name === 'late-repo') && lastProjects().find((pr) => pr.active)?.path === realpathSync(trunkRepo));

  // Back to the first project; forgetting works, but not on the active one.
  const backAt = events.length;
  forge.handle({ type: 'project.switch', path: realpathSync(repo) });
  await waitFor((e) => e.type === 'forge.status' && e.repo === realpathSync(repo) && events.indexOf(e) >= backAt);
  check('projects: switching back works', lastProjects().find((pr) => pr.active)?.path === realpathSync(repo));
  check('projects: the active project cannot be forgotten', (await errorFor({ type: 'project.forget', path: realpathSync(repo) })).includes('switch to another'));
  forge.handle({ type: 'project.forget', path: realpathSync(trunkRepo) });
  check('projects: a forgotten project leaves the list (its files stay)', !lastProjects().some((pr) => pr.path === realpathSync(trunkRepo)) && existsSync(trunkRepo));
  check('projects: an unknown project cannot be switched to', (await errorFor({ type: 'project.switch', path: realpathSync(trunkRepo) })).includes('not on the list'));

  // A project you have only just added runs none of its own scripts until you approve a quest in it.
  const marker = join(root, 'trust-marker');
  const trustRepo = mkRepo('trust-repo', 'main', false);
  writeFileSync(join(trustRepo, 'package.json'), JSON.stringify({ scripts: { test: `node -e "require('fs').writeFileSync('${marker}', 'ran')"` } }));
  writeFileSync(join(trustRepo, 'README.md'), '# trust\n');
  sh(trustRepo, 'add', '-A');
  sh(trustRepo, 'commit', '-q', '-m', 'init');
  const trustAt = events.length;
  forge.handle({ type: 'project.add', path: trustRepo });
  await waitFor((e) => e.type === 'forge.status' && e.repo === realpathSync(trustRepo) && events.indexOf(e) >= trustAt);
  await new Promise((r) => setTimeout(r, 1500));
  check('trust: switching to a new project runs none of its scripts', !existsSync(marker) && !existsSync(`${trustRepo}.anvils/odin`));
  check('trust: and says so', events.slice(trustAt).some((e) => e.type === 'master.say' && e.text.includes('until you approve a quest')));
  evs = await quest([task('trusty')]);
  check('trust: approving a quest is when its scripts first run', existsSync(marker) && merged(evs).join() === 'trusty', merged(evs).join());
  check('trust: from then on the project is trusted', store.hasForged(realpathSync(trustRepo)) && !store.hasForged(realpathSync(emptyRepo)));
  forge.handle({ type: 'project.switch', path: realpathSync(repo) });
  await waitFor((e) => e.type === 'forge.status' && e.repo === realpathSync(repo) && events.indexOf(e) >= events.length - 20);
  forge.handle({ type: 'project.forget', path: realpathSync(trustRepo) });

  // Restart recovery: a proposed blueprint survives a restart.
  blueprintTasks = [task('later')];
  forge.handle({ type: 'quest.request', text: 'survive a restart' });
  await waitFor((e) => e.type === 'blueprint.proposed' && (e as { tasks: { id: string }[] }).tasks[0]?.id === 'later');
  const reborn: ForgeEvent[] = [];
  await new Forge((e) => reborn.push(e), { repo, smiths: 2, sandboxRepo: repo }, new Store(join(root, 'forge.db')), stubs).recover();
  check('restart re-offers the pending blueprint', reborn.some((e) => e.type === 'blueprint.proposed'));
  check('history persisted across restart', ((reborn.find((e) => e.type === 'history') as { quests: unknown[] } | undefined)?.quests.length ?? 0) >= 12);
  check('no stray files left in the main checkout', mainIsClean() && !existsSync(join(repo, 'flaky-mark')));

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
