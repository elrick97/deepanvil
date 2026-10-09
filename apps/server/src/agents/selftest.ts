// Zero-token self-test of the forge's orchestration and of Odin, keeper of main: stub smiths
// and a stub reviewer, but real git, real gates (shell commands) and a throwaway database.
// Exercises every path that's rare in real life.
// Run inside WSL: bash scripts/server.sh selftest
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ForgeEvent, PlanQuestion } from '@deepanvil/shared';
import { Store } from '../store.ts';
import type { BlueprintTask, PlanInput } from './forgemaster.ts';
import type { Policy } from './gates.ts';
import type { Verdict } from './odin-review.ts';
import { Forge, type Agents } from './orchestrator.ts';
import { judge } from './permissions.ts';
import { Ledger, waitForRest } from './run.ts';
import type { SmithOutcome, SmithRun } from './smith.ts';

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
    tests: `! test -e FAIL && ! grep -rqs BROKEN --include=*.txt . && { if [ -f flaky.txt ] && [ ! -f ${flakyMark} ]; then touch ${flakyMark}; exit 1; fi; true; }`,
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
    setTimeout(() => reject(new Error('timed out waiting for event')), ms);
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

const stubs: Agents = {
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
    switch (id) {
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

async function main() {
  permissionTable();
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

  // Restart recovery: a proposed blueprint survives a restart.
  blueprintTasks = [task('later')];
  forge.handle({ type: 'quest.request', text: 'survive a restart' });
  await waitFor((e) => e.type === 'blueprint.proposed' && (e as { tasks: { id: string }[] }).tasks[0]?.id === 'later');
  const reborn: ForgeEvent[] = [];
  await new Forge((e) => reborn.push(e), { repo, smiths: 2 }, new Store(join(root, 'forge.db')), stubs).recover();
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
