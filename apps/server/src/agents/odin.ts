import { existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { ForgeEvent, GateName } from '@deepanvil/shared';
import type { Store } from '../store.ts';
import type { BlueprintTask } from './forgemaster.ts';
import { GATES, LOCKFILES, runGate, type Policy } from './gates.ts';
import { git, worktreesDir } from './git.ts';
import type { Reviewer } from './odin-review.ts';
import type { Emit, Ledger } from './run.ts';

// Odin, keeper of the Vault of Main (docs/ODIN.md). Smiths never touch main: they offer
// their branch, and Odin — one offering at a time — rebases it on the latest main, checks
// its size, runs the gates (no tokens), has Sonnet review the real diff, and only then
// fast-forwards main to that tested commit. main is green by construction.

export interface Offering {
  id: string;
  questId: string;
  taskId: string;
  dwarfId: string;
  title: string;
  branch: string;
  revision: number;
  task: BlueprintTask;
}

export type SendBackReason = 'conflict' | 'too_big' | 'gate' | 'review' | 'human';
export type Outcome =
  | { kind: 'merged'; sha: string }
  | { kind: 'sent_back'; reason: SendBackReason; notes: string }
  | { kind: 'abandoned' };

export interface OdinDeps {
  repo: string;
  store: Store;
  emit: Emit;
  ledger: Ledger;
  policy: Policy;
  reviewer: Reviewer;
  /** Compress long gate output into fix notes (Pip / Haiku). */
  digest: (output: string, context: string, emit: Emit, ledger: Ledger) => Promise<string>;
}

/** Fresh worktrees have no installed dependencies: share the main checkout's. */
export function linkDependencies(repo: string, worktree: string): void {
  for (const dir of ['node_modules', '.venv']) {
    const src = join(repo, dir);
    const dst = join(worktree, dir);
    if (existsSync(src) && !existsSync(dst)) {
      try {
        symlinkSync(src, dst, 'dir');
      } catch {
        /* best effort: gates will report what's missing */
      }
    }
  }
}

export class Odin {
  private d: OdinDeps;
  private queue: Promise<unknown> = Promise.resolve();
  private scratch: string;
  private waiting = new Map<string, (answer: { merge: boolean; note?: string }) => void>();
  private diffs = new Map<string, string>();
  private abort = new AbortController();
  health: 'green' | 'red' | 'unknown' = 'unknown';

  constructor(deps: OdinDeps) {
    this.d = deps;
    this.scratch = join(worktreesDir(deps.repo), 'odin');
  }

  private say(text: string): void {
    this.d.emit({ type: 'odin.say', text });
  }

  private state(o: Offering, state: Extract<ForgeEvent, { type: 'offering.state' }>['state'], reason?: string, extra: { lines?: number; headSha?: string } = {}): void {
    this.d.store.upsertOffering({ id: o.id, questId: o.questId, taskId: o.taskId, dwarfId: o.dwarfId, branch: o.branch, revision: o.revision, state, reason, ...extra });
    this.d.emit({ type: 'offering.state', offeringId: o.id, state, reason });
  }

  /** A clean detached checkout of main for Odin's own work. */
  private async scratchAt(ref: string): Promise<void> {
    if (!existsSync(this.scratch)) await git(this.d.repo, 'worktree', 'add', '--detach', this.scratch, 'main');
    await git(this.scratch, 'rebase', '--abort').catch(() => undefined);
    await git(this.scratch, 'reset', '--hard', '-q');
    await git(this.scratch, 'clean', '-fdq');
    await git(this.scratch, 'checkout', '-q', '--detach', ref);
    linkDependencies(this.d.repo, this.scratch);
  }

  /** Stop: kill running gates, abandon queued and waiting offerings. */
  stop(): void {
    this.abort.abort();
    for (const answer of [...this.waiting.values()]) answer({ merge: false, note: 'Quest stopped.' });
  }

  /** A new quest starts with a fresh stop switch. */
  reset(): void {
    if (this.abort.signal.aborted) this.abort = new AbortController();
  }

  /** You, from an offering card (approve mode). */
  answer(offeringId: string, merge: boolean, note?: string): void {
    this.waiting.get(offeringId)?.({ merge, note });
  }

  diff(offeringId: string): string | undefined {
    return this.diffs.get(offeringId);
  }

  /** Queue an offering; resolves with its fate. One at a time, in order. */
  offer(o: Offering): Promise<Outcome> {
    this.state(o, 'queued');
    const run = this.queue.then(() => (this.abort.signal.aborted ? ({ kind: 'abandoned' } as Outcome) : this.judge(o)));
    this.queue = run.catch(() => undefined);
    return run.catch((err: unknown) => {
      this.say(`I could not judge “${o.title}”: ${err instanceof Error ? err.message : String(err)}`);
      this.state(o, 'abandoned', 'error');
      return { kind: 'abandoned' } as Outcome;
    });
  }

  private sendBack(o: Offering, reason: SendBackReason, notes: string, say: string): Outcome {
    this.state(o, 'sent_back', reason);
    this.say(say);
    return { kind: 'sent_back', reason, notes };
  }

  private async judge(o: Offering): Promise<Outcome> {
    const p = this.d.policy;
    this.d.emit({ type: 'offering.opened', offeringId: o.id, questId: o.questId, taskId: o.taskId, dwarfId: o.dwarfId, title: o.title, revision: o.revision, lines: 0 });

    // 1. Rebase onto the latest main in Odin's scratch worktree.
    this.state(o, 'rebasing');
    await this.scratchAt(o.branch);
    try {
      // Odin is the committer of rebased commits (authors are kept); works without a git identity.
      await git(this.scratch, '-c', 'user.name=Odin (Deepanvil)', '-c', 'user.email=odin@deepanvil.local', 'rebase', '-q', 'main');
    } catch {
      await git(this.scratch, 'rebase', '--abort').catch(() => undefined);
      return this.sendBack(
        o,
        'conflict',
        'Your branch conflicts with main (another piece landed first). In your worktree run `git rebase main`, resolve every conflict keeping the intent of both changes, `git add` the files, run `git rebase --continue`, then re-run the acceptance check.',
        `“${o.title}” collides with what's already in the vault. Rebase and bring it back.`,
      );
    }
    const head = await git(this.scratch, 'rev-parse', 'HEAD');

    // 2. Size: well-scoped work only (lockfiles don't count).
    const numstat = await git(this.scratch, 'diff', '--numstat', 'main', 'HEAD');
    let lines = 0;
    const files: string[] = [];
    for (const row of numstat.split('\n').filter(Boolean)) {
      const [add, del, file = ''] = row.split('\t');
      files.push(file);
      if (!LOCKFILES.some((l) => file.endsWith(l))) lines += (Number(add) || 0) + (Number(del) || 0);
    }
    if (lines === 0 && files.length === 0) return this.sendBack(o, 'gate', 'Your branch has no changes compared to main.', `“${o.title}” is empty.`);
    this.d.emit({ type: 'offering.opened', offeringId: o.id, questId: o.questId, taskId: o.taskId, dwarfId: o.dwarfId, title: o.title, revision: o.revision, lines });
    this.state(o, 'gates', undefined, { lines, headSha: head });
    if (lines > p.maxDiffLines) {
      return this.sendBack(
        o,
        'too_big',
        `Your change is ${lines} changed lines; the limit is ${p.maxDiffLines}. Cut it down to the essential change for this task (move anything extra out), keeping the acceptance check green.`,
        `“${o.title}” is ${lines} lines — too big to judge well. Split it.`,
      );
    }

    // 3. Gates: no tokens. A red gate gets one retry before it counts (flaky detection).
    const failing: { gate: GateName; command: string; output: string }[] = [];
    const ran: string[] = [];
    for (const gate of GATES) {
      const command = p.gates[gate];
      if (!command) {
        this.d.emit({ type: 'offering.gate', offeringId: o.id, gate, status: 'skipped' });
        continue;
      }
      this.d.emit({ type: 'offering.gate', offeringId: o.id, gate, status: 'running' });
      let result = await runGate(command, this.scratch, p.gateTimeoutSec, this.abort.signal);
      let status: 'pass' | 'fail' | 'flaky' = result.ok ? 'pass' : 'fail';
      for (let retry = 0; status === 'fail' && retry < p.flakyRetries && !result.timedOut && !this.abort.signal.aborted; retry++) {
        result = await runGate(command, this.scratch, p.gateTimeoutSec, this.abort.signal);
        if (result.ok) status = 'flaky';
      }
      if (this.abort.signal.aborted) return { kind: 'abandoned' };
      this.d.store.recordGate(o.id, o.revision, gate, status, result.durationMs, result.output);
      this.d.emit({ type: 'offering.gate', offeringId: o.id, gate, status, summary: status === 'fail' ? result.output.trim().split('\n').slice(-1)[0]?.slice(0, 160) : undefined });
      ran.push(`${gate}: ${status}`);
      if (status === 'fail') failing.push({ gate, command, output: result.output });
    }
    if (failing.length) {
      // Pip turns the red output into fix notes; no review is spent on a red offering.
      const notes: string[] = [];
      for (const f of failing) {
        const out = f.output.length > 3000 ? await this.d.digest(f.output, f.command, this.d.emit, this.d.ledger) : f.output.trim();
        notes.push(`### ${f.gate} failed: \`${f.command}\`\n${out}`);
      }
      return this.sendBack(o, 'gate', `Odin's gates failed on top of the latest main:\n\n${notes.join('\n\n')}`, `“${o.title}” fails ${failing.map((f) => f.gate).join(' and ')}. Back to the anvil.`);
    }
    const untested = !p.gates.tests;

    // 4. Review the real diff (Sonnet, always).
    this.state(o, 'reviewing');
    const diff = await git(this.scratch, 'diff', 'main', 'HEAD');
    this.diffs.set(o.id, diff);
    const verdict = await this.d.reviewer(o.task, diff.slice(0, 150_000), ran.join(', ') || 'no gates configured', this.d.emit, this.d.ledger);
    if (this.abort.signal.aborted) return { kind: 'abandoned' };
    this.d.store.recordReview(o.id, o.revision, verdict.decision, verdict.summary, verdict.findings);
    this.d.emit({ type: 'offering.review', offeringId: o.id, decision: verdict.decision, summary: untested ? `(untested: no test gate) ${verdict.summary}` : verdict.summary, findings: verdict.findings });
    if (verdict.decision === 'changes_requested') {
      const notes = verdict.findings
        .filter((f) => f.severity === 'blocker' || f.severity === 'major')
        .map((f) => `- [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ''} — ${f.note}`)
        .join('\n');
      return this.sendBack(o, 'review', `Odin's review asks for changes:\n${verdict.summary}\n${notes}`, `“${o.title}”: ${verdict.summary}`);
    }

    // 5. Verdict: you decide in approve mode (or when protected paths are touched).
    const guarded = files.find((f) => p.protectedPaths.some((pp) => f.startsWith(pp)));
    if (p.mode === 'approve' || guarded) {
      this.state(o, 'awaiting_you', guarded ? `touches ${guarded}` : undefined);
      this.say(`“${o.title}” is worthy${guarded ? ` — but it touches ${guarded}, so it's your call` : ''}. Merge it?`);
      const answer = await new Promise<{ merge: boolean; note?: string }>((resolve) => this.waiting.set(o.id, resolve));
      this.waiting.delete(o.id);
      if (this.abort.signal.aborted) return { kind: 'abandoned' };
      if (!answer.merge) return this.sendBack(o, 'human', `The human sent it back${answer.note ? `: ${answer.note}` : '.'}`, `Sent back by you: “${o.title}”.`);
    }

    // Fast-forward main to exactly the commit that passed. The tested tree is what lands.
    await git(this.d.repo, 'merge', '--ff-only', '-q', head);
    this.state(o, 'merged');
    this.d.emit({ type: 'offering.merged', offeringId: o.id, sha: head });
    this.setHealth('green', head);
    this.say(`“${o.title}” enters the vault.`);
    return { kind: 'merged', sha: head };
  }

  private setHealth(status: 'green' | 'red' | 'unknown', sha: string, failing?: GateName[]): void {
    this.health = status;
    this.d.emit({ type: 'vault.health', status, sha, failing });
  }

  /** Run the gates on main itself. Red main: only offerings that turn it green can pass. */
  checkHealth(): Promise<void> {
    const run = this.queue.then(async () => {
      if (!existsSync(this.d.repo)) return;
      const sha = await git(this.d.repo, 'rev-parse', 'main').catch(() => '');
      const gates = GATES.filter((g) => this.d.policy.gates[g]);
      if (!sha || !gates.length) return this.setHealth('unknown', sha);
      await this.scratchAt('main');
      const failing: GateName[] = [];
      for (const g of gates) {
        const r = await runGate(this.d.policy.gates[g]!, this.scratch, this.d.policy.gateTimeoutSec, this.abort.signal);
        if (!r.ok) failing.push(g);
      }
      this.setHealth(failing.length ? 'red' : 'green', sha, failing);
      if (failing.length) this.say(`The vault is cracked: ${failing.join(' and ')} fail on main. Only work that mends it may enter.`);
    });
    this.queue = run.catch(() => undefined);
    return run.catch(() => undefined);
  }
}
