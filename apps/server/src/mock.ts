import { CREW, type Dwarf, type ForgeEvent, type ToolKind } from '@deepanvil/shared';

// A quest-shaped stand-in for the orchestrator, for demos without agents. It plays out
// the whole loop the real forge does: blueprint -> approval -> smiths read, hammer,
// test, retry, escalate, ring the bell -> offer each piece at Odin's vault (gates,
// review, merge or send-back) -> merge, with Haiku digests and banter.

const master = CREW.find((d) => d.role === 'forgemaster')!;
const sprite = CREW.find((d) => d.role === 'sprite')!;
const odin = CREW.find((d) => d.role === 'keeper')!;
const smiths = CREW.filter((d) => d.role === 'smith');

const QUESTS: { title: string; tasks: string[] }[] = [
  { title: 'Add dark mode to the settings page', tasks: ['Theme tokens', 'Toggle component', 'Persist preference'] },
  { title: 'Fix flaky login test', tasks: ['Reproduce the race', 'Await session cookie'] },
  { title: 'Paginate the orders API', tasks: ['Cursor helper', 'Orders endpoint', 'Client pager', 'API docs'] },
  { title: 'Upgrade to Vite 8', tasks: ['Bump deps', 'Fix config', 'Smoke test build'] },
  { title: 'Rate-limit the webhook receiver', tasks: ['Token bucket', 'Middleware wiring'] },
];

const BANTER = [
  'This ingot has opinions.', 'Who left a TODO in the bellows?', 'Another semicolon for the pile!',
  'Smells like a race condition.', 'By my beard, the types line up!', 'Pass me the big hammer.',
  'I could do this one in my sleep.', 'Hmm. Hmmmm.', 'Tests first, ale later.', 'Stand back, sparks incoming!',
];
const DIGESTS = ['412 lines of test log -> 3 failures', 'npm install noise -> 1 peer warning', 'diff summary: 6 files, +88 -31'];
const ASKS = ['npm install zod', 'curl the staging API', 'delete 14 snapshot files'];
const GATE_FAILS = ['1 failing: renders the empty state', '2 failing: pager.spec.ts', 'expected 3, received 2'];
const REVIEW_ASKS = ['An edge case is untested: the empty list.', 'This swallows the error; surface it to the caller.', 'The helper duplicates one in utils; reuse it.'];
const READS = ['src/settings/theme.ts', 'src/api/orders.ts', 'tests/login.spec.ts', 'vite.config.ts', 'README.md'];

// Seeded so a demo replays the same way; reseed per quest for variety.
let seed = 1337;
const rnd = (): number => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const jitter = (ms: number) => sleep(ms * (0.7 + rnd() * 0.6));

export function startMockForge(emit: (e: ForgeEvent) => void): void {
  let questN = 0;

  const usage = (d: Dwarf, scale = 1) =>
    emit({
      type: 'usage.tick', dwarfId: d.id, model: d.model,
      inputTokens: Math.round((900 + rnd() * 3500) * scale),
      outputTokens: Math.round((120 + rnd() * 800) * scale),
      cacheReadTokens: Math.round(rnd() * 18000 * scale),
      costUsd: Math.round(rnd() * 400 * scale) / 10000,
    });
  const log = (d: Dwarf, kind: 'say' | 'tool' | 'result' | 'error', text: string) => emit({ type: 'dwarf.log', dwarfId: d.id, entry: { at: Date.now(), kind, text } });
  const tool = (d: Dwarf, taskId: string, kind: ToolKind, summary: string) => {
    emit({ type: 'tool', dwarfId: d.id, taskId, kind, summary });
    if (kind === 'bash') log(d, 'tool', `Bash: ${summary}`);
    else log(d, 'tool', `${{ read: 'Read', grep: 'Grep', edit: 'Edit', write: 'Write' }[kind]}: ${summary}`);
  };
  const odinSay = (text: string) => emit({ type: 'odin.say', text });

  // Odin judges one offering at a time, like the real merge queue (agents/odin.ts).
  let odinQueue: Promise<unknown> = Promise.resolve();
  async function judge(questId: string, taskId: string, smith: Dwarf, title: string, revision: number): Promise<boolean> {
    const offeringId = `${taskId}-o`;
    const base = { offeringId, questId, taskId, dwarfId: smith.id, title, revision };
    emit({ type: 'offering.opened', ...base, lines: 0 });
    emit({ type: 'offering.state', offeringId, state: 'rebasing' });
    await jitter(1500);
    emit({ type: 'offering.opened', ...base, lines: 20 + Math.floor(rnd() * 180) });
    emit({ type: 'offering.state', offeringId, state: 'gates' });
    await jitter(4000); // the smith carries the piece to the scales
    for (const gate of ['tests', 'types', 'lint'] as const) {
      emit({ type: 'offering.gate', offeringId, gate, status: 'running' });
      await jitter(2200);
      if (gate === 'tests' && revision === 1 && rnd() < 0.15) {
        emit({ type: 'offering.gate', offeringId, gate, status: 'fail', summary: pick(GATE_FAILS) });
        emit({ type: 'offering.state', offeringId, state: 'sent_back', reason: 'gate' });
        odinSay(`“${title}” fails tests. Back to the anvil.`);
        return false;
      }
      emit({ type: 'offering.gate', offeringId, gate, status: 'pass' });
    }
    emit({ type: 'offering.state', offeringId, state: 'reviewing' });
    usage(odin, 0.5);
    await jitter(5000);
    if (revision === 1 && rnd() < 0.2) {
      const summary = pick(REVIEW_ASKS);
      emit({ type: 'offering.review', offeringId, decision: 'changes_requested', summary, findings: [] });
      emit({ type: 'offering.state', offeringId, state: 'sent_back', reason: 'review' });
      odinSay(`“${title}”: ${summary}`);
      return false;
    }
    emit({ type: 'offering.review', offeringId, decision: 'approve', summary: 'Small, tested and clear.', findings: [] });
    odinSay(`“${title}” enters the vault.`);
    emit({ type: 'offering.state', offeringId, state: 'merged' });
    emit({ type: 'offering.merged', offeringId, sha: Math.floor(rnd() * 0xfffffff).toString(16).padStart(7, '0') });
    await jitter(3000);
    return true;
  }
  const offer = (questId: string, taskId: string, smith: Dwarf, title: string, revision: number): Promise<boolean> => {
    const run = odinQueue.then(() => judge(questId, taskId, smith, title, revision));
    odinQueue = run.catch(() => undefined);
    return run;
  };

  // The smith's own to-do list (a chalkboard at the anvil), ticked off as the task goes.
  const board = (d: Dwarf, done: number) =>
    emit({ type: 'dwarf.todos', dwarfId: d.id, items: ['Read the context pack', 'Make the change', 'Run the tests', 'Commit'].map((text, i) => ({ text, status: i < done ? 'completed' : i === done ? 'in_progress' : 'pending' })) });

  async function runTask(questId: string, taskId: string, smith: Dwarf, title: string): Promise<void> {
    board(smith, 0);
    // Scout: read the files named in the blueprint's context pack.
    for (let i = 0; i < 2 + Math.floor(rnd() * 3); i++) {
      tool(smith, taskId, rnd() < 0.7 ? 'read' : 'grep', pick(READS));
      if (rnd() < 0.4) usage(smith);
      await jitter(1400);
    }
    log(smith, 'say', 'I have the context I need; time to shape the code.');
    board(smith, 1);
    if (rnd() < 0.3) emit({ type: 'banter', dwarfId: smith.id, line: pick(BANTER) });

    for (let attempt = 1; ; attempt++) {
      for (let i = 0; i < 2 + Math.floor(rnd() * 4); i++) {
        tool(smith, taskId, rnd() < 0.75 ? 'edit' : 'write', 'shaping the code');
        usage(smith);
        await jitter(2200);
      }
      if (rnd() < 0.18) {
        const requestId = `${taskId}-perm-${attempt}`;
        emit({ type: 'permission.request', dwarfId: smith.id, requestId, action: pick(ASKS) });
        await jitter(7000);
        emit({ type: 'permission.resolved', dwarfId: smith.id, requestId, approved: rnd() < 0.85 });
        await jitter(1500);
      }
      board(smith, 2);
      tool(smith, taskId, 'bash', 'npm test');
      await jitter(2600);
      log(smith, 'result', `Tests  ${2 + Math.floor(rnd() * 12)} passed${rnd() < 0.28 ? ', 1 failed' : ''}
Duration  ${(0.4 + rnd() * 2).toFixed(1)}s`);
      emit({ type: 'haiku.digest', fromDwarfId: smith.id, toDwarfId: master.id, note: pick(DIGESTS) });
      usage(sprite, 0.3);
      if (rnd() < 0.72 || attempt >= 3) {
        emit({ type: 'test.pass', dwarfId: smith.id, taskId });
        break;
      }
      emit({ type: 'test.fail', dwarfId: smith.id, taskId, attempt });
      await jitter(2200);
      if (attempt === 2) {
        // Two failures: the ingot goes back to the Forgemaster's table to be re-planned.
        emit({ type: 'escalation', dwarfId: smith.id, taskId, reason: 'failed twice' });
        usage(master, 0.6);
        await jitter(9000);
      }
    }
    board(smith, 3);
    // Offer it at the vault until Odin lets it in.
    for (let revision = 1; ; revision++) {
      await jitter(1200);
      if (await offer(questId, taskId, smith, title, revision)) break;
      for (let i = 0; i < 2; i++) {
        tool(smith, taskId, 'edit', 'addressing Odin’s note');
        usage(smith);
        await jitter(2200);
      }
      tool(smith, taskId, 'bash', 'npm test');
      await jitter(2000);
      emit({ type: 'test.pass', dwarfId: smith.id, taskId });
    }
    emit({ type: 'task.done', questId, taskId, dwarfId: smith.id });
  }

  async function runQuest(): Promise<void> {
    const q = QUESTS[questN++ % QUESTS.length]!;
    const questId = `q${questN}`;
    const tasks = q.tasks.map((title, i) => ({ id: `${questId}-t${i + 1}`, title }));
    emit({
      type: 'blueprint.proposed', questId, title: q.title, summary: `${tasks.length} piece(s), forged in parallel.`, revision: 0,
      tasks: tasks.map((t) => ({ ...t, brief: `Do "${t.title}" in the existing style.`, files: [{ path: 'src/index.ts', why: 'entry point' }], acceptance: 'npm test' })),
    });
    usage(master, 1.5);
    await jitter(5000);
    emit({ type: 'blueprint.approved', questId });
    await sleep(1200);

    // Every third quest hits the subscription limit: the crew naps for a moment, then carries on.
    if (questN % 3 === 0) {
      emit({ type: 'forge.rest', resting: true, until: Date.now() + 20_000, reason: 'subscription limit' });
      await sleep(20_000);
      emit({ type: 'forge.rest', resting: false });
      await sleep(1500);
    }

    // Tasks beyond the number of smiths wait for a free anvil.
    const queue = [...tasks];
    const free = [...smiths];
    const running: Promise<void>[] = [];
    const startNext = async (smith: Dwarf): Promise<void> => {
      const t = queue.shift();
      if (!t) return;
      emit({ type: 'task.assigned', questId, taskId: t.id, dwarfId: smith.id, title: t.title });
      await sleep(600);
      await runTask(questId, t.id, smith, t.title);
      await startNext(smith);
    };
    while (free.length && queue.length) {
      running.push(startNext(free.shift()!));
      await jitter(900);
    }
    await Promise.all(running);

    emit({ type: 'merge', questId, branch: `forge/${questId}` });
    usage(master, 0.8);
    await jitter(9000);
  }

  void (async () => {
    await sleep(1500);
    emit({ type: 'vault.health', status: 'green', sha: 'mock' });
    for (;;) await runQuest();
  })();
}
