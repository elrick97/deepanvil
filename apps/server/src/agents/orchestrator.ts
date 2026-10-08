import { existsSync } from 'node:fs';
import { CREW, type ClientCommand, type Dwarf } from '@deepanvil/shared';
import type { Store } from '../store.ts';
import { plan, replan, type Blueprint, type BlueprintTask } from './forgemaster.ts';
import { policyFor } from './gates.ts';
import { addWorktree, commitAll, git, removeWorktree, worktreesDir } from './git.ts';
import { linkDependencies, Odin } from './odin.ts';
import { sonnetReview, type Reviewer } from './odin-review.ts';
import { Ledger, type Emit } from './run.ts';
import { runSmith } from './smith.ts';
import { banter, digest } from './sprite.ts';

// The live forge: request -> Opus blueprint -> your approval -> Sonnet smiths in parallel
// worktrees -> each finished piece is *offered* to Odin, keeper of main (rebase, gates,
// Sonnet review, fast-forward; docs/ODIN.md). Send-backs return to the same smith; the
// second failure escalates to Thráin for a re-plan, the third gives up. Stoppable anytime.

const ESCALATE_AT = 2; // failures (smith stuck or Odin send-back) before Thráin re-plans
const GIVE_UP_AT = 3; // ...and before the task is abandoned

export interface ForgeConfig {
  repo: string;
  smiths: number;
  /** Odin's merge mode for a repo seen for the first time: "auto" for the sandbox. */
  defaultMode?: 'auto' | 'approve';
}

/** The model-backed steps, injectable so the orchestration can be tested without tokens. */
export interface Agents {
  plan: typeof plan;
  replan: typeof replan;
  runSmith: typeof runSmith;
  reviewer: Reviewer;
  digest: typeof digest;
  banter: typeof banter;
}

export const LIVE_AGENTS: Agents = { plan, replan, runSmith, reviewer: sonnetReview, digest, banter };

interface PendingQuest {
  id: string;
  request: string;
  blueprint: Blueprint;
}

export class Forge {
  readonly ledger: Ledger;
  private store: Store;
  private emit: Emit;
  private cfg: ForgeConfig;
  private agents: Agents;
  private busy = false;
  private pending?: PendingQuest;
  private activeQuest?: string;
  private abort?: AbortController;
  private questN = 0;
  private askN = 0;
  private answers = new Map<string, (approved: boolean) => void>();
  private keeper?: Odin;

  constructor(emit: Emit, cfg: ForgeConfig, store: Store, agents: Agents = LIVE_AGENTS) {
    this.emit = emit;
    this.cfg = cfg;
    this.store = store;
    this.agents = agents;
    this.ledger = new Ledger(store);
  }

  /** Odin for the forge's repo (created on first use: the repo may not exist at startup). */
  get odin(): Odin {
    this.keeper ??= new Odin({
      repo: this.cfg.repo,
      store: this.store,
      emit: this.emit,
      ledger: this.ledger,
      policy: policyFor(this.store, this.cfg.repo, this.cfg.defaultMode === 'auto'),
      reviewer: this.agents.reviewer,
      digest: this.agents.digest,
    });
    return this.keeper;
  }

  /** After a restart: retire quests whose agents died, clear their anvils, re-offer a pending blueprint. */
  async recover(): Promise<void> {
    this.store.abandonOpenOfferings();
    const lost = this.store.interruptUnfinished();
    if (lost.length) this.say(`The forge went cold mid-quest; ${lost.length} quest(s) were interrupted. Their branches are kept.`);
    await this.clearAnvils();
    const pending = this.store.pendingQuest();
    if (pending) {
      const blueprint = pending.blueprint as Blueprint;
      this.pending = { id: pending.id, request: pending.request, blueprint };
      this.busy = true;
      this.emit({ type: 'blueprint.proposed', questId: pending.id, title: blueprint.title, tasks: blueprint.tasks.map((t) => ({ id: t.id, title: t.title })) });
    }
    this.emit(this.status());
    this.emit(this.ledger.event());
    this.history();
    if (existsSync(this.cfg.repo)) void this.odin.checkHealth();
  }

  private async clearAnvils(): Promise<void> {
    if (!existsSync(this.cfg.repo)) return;
    const list = await git(this.cfg.repo, 'worktree', 'list', '--porcelain').catch(() => '');
    const anvils = worktreesDir(this.cfg.repo);
    for (const line of list.split('\n')) {
      const dir = line.startsWith('worktree ') ? line.slice(9) : '';
      if (dir.startsWith(anvils)) await removeWorktree(this.cfg.repo, dir);
    }
    await git(this.cfg.repo, 'worktree', 'prune').catch(() => undefined);
  }

  private history(): void {
    this.emit({ type: 'history', quests: this.store.history() });
  }

  status() {
    return { type: 'forge.status' as const, mode: 'live' as const, repo: this.cfg.repo, smiths: this.cfg.smiths, busy: this.busy };
  }

  handle(cmd: ClientCommand): void {
    switch (cmd.type) {
      case 'quest.request':
        void this.request(cmd.text);
        break;
      case 'blueprint.approve':
        if (this.pending?.id === cmd.questId) void this.forge(this.pending);
        break;
      case 'blueprint.reject':
        if (this.pending?.id === cmd.questId) {
          this.store.setQuestStatus(cmd.questId, 'rejected');
          this.history();
          this.pending = undefined;
          this.setBusy(false);
          this.say('Back to the drawing board, then. Tell me what to change.');
        }
        break;
      case 'quest.abort':
        this.stop();
        break;
      case 'permission.answer':
        this.answers.get(cmd.requestId)?.(cmd.approved);
        break;
      case 'offering.merge':
        this.keeper?.answer(cmd.offeringId, true);
        break;
      case 'offering.send_back':
        this.keeper?.answer(cmd.offeringId, false, cmd.note?.slice(0, 2000));
        break;
      case 'offering.diff': {
        const diff = this.keeper?.diff(cmd.offeringId);
        if (diff !== undefined) this.emit({ type: 'offering.diff', offeringId: cmd.offeringId, diff: diff.slice(0, 400_000) });
        break;
      }
    }
  }

  /** Stop whatever is running: agents are aborted, the bell is answered "no", anvils cleared. */
  private stop(): void {
    if (this.pending && !this.activeQuest) {
      // Nothing is running yet: stopping a proposed blueprint is the same as rejecting it.
      return this.handle({ type: 'blueprint.reject', questId: this.pending.id });
    }
    if (!this.abort || this.abort.signal.aborted) return;
    this.say('Down tools, everyone. The quest is stopped.');
    this.abort.abort();
    this.keeper?.stop();
    for (const answer of [...this.answers.values()]) answer(false);
  }

  private get stopped(): boolean {
    return this.abort?.signal.aborted ?? false;
  }

  private say(text: string): void {
    this.emit({ type: 'master.say', text });
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.emit(this.status());
  }

  private fail(message: string): void {
    this.emit({ type: 'forge.error', message });
    this.say(`Something broke at the forge: ${message}`);
  }

  // ------------------------------------------------------------------ drafting

  private async request(text: string): Promise<void> {
    if (this.busy) return this.fail('a quest is already underway — one at a time.');
    if (!existsSync(this.cfg.repo)) return this.fail(`no repository at ${this.cfg.repo} (run scripts/setup-sandbox.sh or set DEEPANVIL_REPO).`);
    const dirty = await git(this.cfg.repo, 'status', '--porcelain').catch(() => 'x');
    if (dirty) return this.fail(`${this.cfg.repo} has uncommitted changes; commit or stash them first.`);

    this.setBusy(true);
    this.say('Let me study the repository and draw up a blueprint…');
    const id = `q${++this.questN}-${Date.now().toString(36)}`;
    this.store.createQuest(id, text, this.cfg.repo);
    this.activeQuest = id;
    this.abort = new AbortController();
    this.ledger.questId = id;
    this.ledger.abort = this.abort;
    try {
      const blueprint = await this.agents.plan(text, this.cfg.repo, this.emit, this.ledger);
      if (this.stopped) throw new Error('stopped');
      this.store.proposeQuest(id, blueprint.title, blueprint);
      this.pending = { id, request: text, blueprint };
      this.emit({ type: 'blueprint.proposed', questId: id, title: blueprint.title, tasks: blueprint.tasks.map((t) => ({ id: t.id, title: t.title })) });
      this.say(blueprint.summary);
    } catch (err) {
      this.store.setQuestStatus(id, this.stopped ? 'interrupted' : 'failed');
      this.setBusy(false);
      if (!this.stopped) this.fail(err instanceof Error ? err.message : String(err));
    } finally {
      this.activeQuest = undefined;
      this.ledger.questId = undefined;
      this.history();
    }
  }

  // ------------------------------------------------------------------ forging

  private async forge(quest: PendingQuest): Promise<void> {
    this.pending = undefined;
    this.activeQuest = quest.id;
    this.abort = new AbortController();
    this.ledger.questId = quest.id;
    this.ledger.abort = this.abort;
    this.store.setQuestStatus(quest.id, 'forging');
    this.emit({ type: 'blueprint.approved', questId: quest.id });
    this.odin.reset();
    // main may have changed outside the forge since the last check: look before anything is offered.
    await this.odin.checkHealth();
    const smiths = CREW.filter((d) => d.role === 'smith').slice(0, Math.max(1, this.cfg.smiths));
    const queue = [...quest.blueprint.tasks];
    const merged: string[] = [];
    const failed: string[] = [];

    const work = async (smith: Dwarf): Promise<void> => {
      for (let task = queue.shift(); task && !this.stopped; task = queue.shift()) {
        const ok = await this.runTask(quest.id, smith, task).catch((err: unknown) => {
          if (!this.stopped) this.emit({ type: 'forge.error', message: `${smith.name}: ${err instanceof Error ? err.message : String(err)}` });
          return false;
        });
        (ok ? merged : failed).push(task.title);
      }
    };
    await Promise.all(smiths.map(work));

    if (this.stopped) {
      this.store.setQuestStatus(quest.id, 'interrupted', { merged: merged.length, failed: failed.length + queue.length });
      await this.clearAnvils();
    } else {
      if (merged.length) this.emit({ type: 'merge', questId: quest.id, branch: `forge/${quest.id}` });
      this.say(
        failed.length
          ? `Merged ${merged.length} of ${merged.length + failed.length}. These need your eye: ${failed.join(', ')}.`
          : `All ${merged.length} pieces merged into ${this.cfg.repo.split('/').pop()}. A fine day's work.`,
      );
      this.store.setQuestStatus(quest.id, merged.length ? 'done' : 'failed', { merged: merged.length, failed: failed.length });
    }
    this.activeQuest = undefined;
    this.ledger.questId = undefined;
    this.history();
    this.setBusy(false);
  }

  private async runTask(questId: string, smith: Dwarf, task: BlueprintTask): Promise<boolean> {
    const branch = `forge/${questId}/${task.id}`;
    const taskId = task.id;
    const offeringId = `${questId}-${taskId}`;
    let attempts = 0;
    const record = (status: 'working' | 'merged' | 'failed', summary?: string) =>
      this.store.upsertTask(questId, taskId, task.title, smith.id, status, attempts, summary);
    const fail = (summary: string): false => {
      record('failed', summary);
      this.store.bumpCrew(smith.id, 'tasks_failed');
      return false;
    };
    record('working');
    this.emit({ type: 'task.assigned', questId, taskId, dwarfId: smith.id, title: task.title });
    if (Math.random() < 0.5) {
      void this.agents.banter(smith.name, `starting "${task.title}"`, this.emit, this.ledger).then((line) => line && this.emit({ type: 'banter', dwarfId: smith.id, line }), () => undefined);
    }

    // The worktree lives until the offering is merged or abandoned: send-backs are fixed in place.
    const worktree = await addWorktree(this.cfg.repo, `${smith.id}-${taskId}`, branch);
    linkDependencies(this.cfg.repo, worktree);
    try {
      let failures = 0;
      let revision = 0;
      let notes: string | undefined;
      let replanned = false;
      while (!this.stopped) {
        attempts++;
        const outcome = await this.agents.runSmith({ smith, task, worktree, attempt: attempts, notes, emit: this.emit, ledger: this.ledger, ask: (a) => this.ask(smith, a) });
        await commitAll(worktree, `${task.title} (${smith.name}, attempt ${attempts})`);
        if (this.stopped) break;

        if (outcome.status === 'done' && outcome.testsPassed) {
          // Lay it on Odin's scales.
          revision++;
          const verdict = await this.odin.offer({ id: offeringId, questId, taskId, dwarfId: smith.id, title: task.title, branch, revision, task });
          if (verdict.kind === 'merged') {
            record('merged', outcome.summary);
            this.store.bumpCrew(smith.id, 'tasks_done');
            this.emit({ type: 'task.done', questId, taskId, dwarfId: smith.id });
            return true;
          }
          if (verdict.kind === 'abandoned') return fail('Abandoned.');
          notes = verdict.notes;
        } else {
          notes = outcome.summary;
        }

        failures++;
        if (failures >= GIVE_UP_AT) return fail(notes ?? 'Failed three times.');
        if (failures >= ESCALATE_AT && !replanned) {
          // Twice cracked: back to the Forgemaster's table to be re-planned.
          replanned = true;
          this.emit({ type: 'escalation', dwarfId: smith.id, taskId, reason: (notes ?? '').slice(0, 200) });
          this.store.bumpCrew(smith.id, 'escalations');
          task = await this.agents.replan(task, notes ?? '', worktree, this.emit, this.ledger);
          this.say(`Redrawn “${task.title}”. Try it this way, ${smith.name}.`);
        }
      }
      return fail('Stopped.');
    } finally {
      await removeWorktree(this.cfg.repo, worktree);
    }
  }

  /** Ring the bell and wait for your answer (a stopped quest answers "no"). */
  private ask(smith: Dwarf, action: string): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false);
    const requestId = `${smith.id}-${Date.now().toString(36)}-${++this.askN}`;
    this.emit({ type: 'permission.request', dwarfId: smith.id, requestId, action });
    this.store.bumpCrew(smith.id, 'bells');
    return new Promise((resolve) => {
      this.answers.set(requestId, (approved) => {
        this.answers.delete(requestId);
        this.emit({ type: 'permission.resolved', dwarfId: smith.id, requestId, approved });
        resolve(approved);
      });
    });
  }
}
