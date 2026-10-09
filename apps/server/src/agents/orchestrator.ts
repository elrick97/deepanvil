import { existsSync } from 'node:fs';
import { CREW, type BlueprintTaskView, type ClientCommand, type Dwarf, type ForgeEvent, type PlanAnswer, type PlanQuestion } from '@deepanvil/shared';
import type { Store } from '../store.ts';
import { plan, replan, triage, type Blueprint, type BlueprintTask, type QA } from './forgemaster.ts';
import { policyFor } from './gates.ts';
import { addWorktree, commitAll, git, removeWorktree, worktreesDir } from './git.ts';
import { linkDependencies, Odin } from './odin.ts';
import { sonnetReview, type Reviewer } from './odin-review.ts';
import { Ledger, type Emit } from './run.ts';
import { runSmith, type SmithOutcome } from './smith.ts';
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
  triage: typeof triage;
  runSmith: typeof runSmith;
  reviewer: Reviewer;
  digest: typeof digest;
  banter: typeof banter;
}

export const LIVE_AGENTS: Agents = { plan, replan, triage, runSmith, reviewer: sonnetReview, digest, banter };

interface PendingQuest {
  id: string;
  request: string;
  blueprint: Blueprint;
  /** How many times it has been redrawn (0 = first draft). */
  revision: number;
  /** What Thráin learned about the repo, and what you told him: carried into revisions. */
  notes: string;
  qa: QA[];
}

/** How often one blueprint may be redrawn from feedback (each is an Opus call). */
const MAX_REVISIONS = 6;

/** A blueprint as the client sees it: full task detail, clipped (model text is untrusted). */
function view(id: string, bp: Blueprint, revision: number): { questId: string; title: string; summary: string; revision: number; tasks: BlueprintTaskView[] } {
  return {
    questId: id,
    title: bp.title,
    summary: bp.summary.slice(0, 800),
    revision,
    tasks: bp.tasks.map((t) => ({
      id: t.id,
      title: t.title.slice(0, 80),
      brief: t.brief.slice(0, 1500),
      files: t.files.slice(0, 8).map((f) => ({ path: f.path.slice(0, 200), why: f.why.slice(0, 200) })),
      acceptance: t.acceptance.slice(0, 400),
    })),
  };
}

/** Thráin's planning conversation before a blueprint exists: questions asked, answers given. */
interface Draft {
  id: string;
  request: string;
  round: number;
  notes: string;
  qa: QA[];
  /** The questions waiting for your answer (undefined while Thráin is thinking). */
  asked?: PlanQuestion[];
}

/** At most this many rounds of questions; on the last round he must draft. */
const PLAN_ROUNDS = 2;

/** How often a smith's "blocked" may change the plan within one quest (each is an Opus call). */
const MAX_REPLANS = 3;

type TaskState = 'queued' | 'running' | 'merged' | 'failed' | 'replaced';

/** The quest while it is being forged: the live task list the replanning ladder edits. */
interface QuestRun {
  id: string;
  request: string;
  blueprint: Blueprint;
  /** Not yet started; mutated in place (the smiths pull from it). */
  queue: BlueprintTask[];
  state: Map<string, TaskState>;
  titles: Map<string, string>;
  replans: number;
}

/** What became of a task that a smith flagged as blocked. */
type Change = { kind: 'rewrite'; task: BlueprintTask } | { kind: 'replaced'; reason: string } | { kind: 'fail'; reason: string };

export class Forge {
  readonly ledger: Ledger;
  private store: Store;
  private emit: Emit;
  private cfg: ForgeConfig;
  private agents: Agents;
  private busy = false;
  private pending?: PendingQuest;
  private draft?: Draft;
  private run?: QuestRun;
  /** A question Thráin asked mid-quest (the form is the same as at drafting). */
  private midAsk?: { questions: PlanQuestion[]; questId: string; resolve: (a: Record<string, PlanAnswer> | undefined) => void };
  /** A proposed change of plan waiting for your yes or no. */
  private changeWaits = new Map<string, (approve: boolean) => void>();
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
      this.pending = { id: pending.id, request: pending.request, blueprint, revision: 0, notes: '', qa: [] };
      this.busy = true;
      this.emit({ type: 'blueprint.proposed', ...view(pending.id, blueprint, 0) });
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
      case 'plan.answer':
        this.answerPlan(cmd.questId, cmd.answers);
        break;
      case 'plan.skip':
        this.answerPlan(cmd.questId, undefined);
        break;
      case 'plan.change':
        this.changeWaits.get(cmd.changeId)?.(cmd.approve === true);
        break;
      case 'blueprint.approve':
        if (this.pending?.id === cmd.questId && !this.activeQuest) void this.forge(this.pending);
        break;
      case 'blueprint.revise':
        void this.revise(cmd.questId, String(cmd.note ?? ''));
        break;
      case 'blueprint.drop':
        this.dropTask(cmd.questId, cmd.taskId);
        break;
      case 'blueprint.reject':
        if (this.pending?.id === cmd.questId && !this.activeQuest) {
          this.store.setQuestStatus(cmd.questId, 'rejected');
          this.history();
          this.pending = undefined;
          this.emit({ type: 'blueprint.rejected', questId: cmd.questId });
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
    if (this.draft && !this.activeQuest) {
      // Thráin is waiting for your answers: stopping shelves the quest.
      this.store.setQuestStatus(this.draft.id, 'rejected');
      this.draft = undefined;
      this.setBusy(false);
      this.history();
      this.say('Very well. I shelve the plan.');
      return;
    }
    if (this.pending && !this.activeQuest) {
      // Nothing is running yet: stopping a proposed blueprint is the same as rejecting it.
      return this.handle({ type: 'blueprint.reject', questId: this.pending.id });
    }
    if (!this.abort || this.abort.signal.aborted) return;
    this.say('Down tools, everyone. The quest is stopped.');
    this.abort.abort();
    this.keeper?.stop();
    for (const decide of [...this.changeWaits.values()]) decide(false);
    if (this.midAsk) {
      const m = this.midAsk;
      this.midAsk = undefined;
      this.emit({ type: 'plan.answered', questId: m.questId });
      m.resolve(undefined);
    }
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
    this.draft = { id, request: text, round: 0, notes: '', qa: [] };
    await this.draftTurn();
  }

  /** One turn of Thráin's planning: he either asks questions or hands over the blueprint. */
  private async draftTurn(): Promise<void> {
    const draft = this.draft;
    if (!draft) return;
    const { id } = draft;
    this.activeQuest = id;
    this.abort = new AbortController();
    this.ledger.questId = id;
    this.ledger.abort = this.abort;
    try {
      const turn = await this.agents.plan(
        { request: draft.request, qa: draft.qa, notes: draft.notes, canAsk: draft.round < PLAN_ROUNDS, round: draft.round + 1, rounds: PLAN_ROUNDS },
        this.cfg.repo,
        this.emit,
        this.ledger,
      );
      if (this.stopped) throw new Error('stopped');
      if (turn.kind === 'questions') {
        draft.round++;
        draft.notes = turn.notes;
        draft.asked = turn.questions;
        this.emit({ type: 'plan.questions', questId: id, round: draft.round, rounds: PLAN_ROUNDS, questions: turn.questions });
        this.say(draft.round === 1 ? 'A few questions before I draw this up.' : 'One more thing I need to know.');
        return; // the forge stays busy; your answer (or "just draft it") continues the plan
      }
      const blueprint = turn.blueprint;
      this.draft = undefined;
      this.store.proposeQuest(id, blueprint.title, blueprint);
      this.pending = { id, request: draft.request, blueprint, revision: 0, notes: turn.notes, qa: draft.qa };
      this.emit({ type: 'blueprint.proposed', ...view(id, blueprint, 0) });
      this.say(blueprint.summary);
    } catch (err) {
      this.draft = undefined;
      this.store.setQuestStatus(id, this.stopped ? 'interrupted' : 'failed');
      this.setBusy(false);
      if (!this.stopped) this.fail(err instanceof Error ? err.message : String(err));
    } finally {
      this.activeQuest = undefined;
      this.ledger.questId = undefined;
      this.history();
    }
  }

  /** Your answers (or his own picks when you skipped) as the questions-and-answers he is shown next. */
  private buildQA(asked: PlanQuestion[], answers: Record<string, PlanAnswer> | undefined): QA[] {
    return asked.map((q) => {
      const given = answers?.[q.id];
      const labels = new Set(q.options.map((o) => o.label));
      // Only real option labels count as picks; anything else must come as free text.
      const picks = given ? given.picks.filter((l) => labels.has(l)).slice(0, q.multiSelect ? 4 : 1) : q.recommended;
      const other = given?.other ? String(given.other).slice(0, 600) : undefined;
      // An unanswered question falls back to Thráin's own pick.
      const chosen = picks.length || other ? picks : q.recommended.length ? q.recommended : [q.options[0]!.label];
      return { question: q, answer: { picks: chosen, other } };
    });
  }

  /** You ask for changes: Thráin redraws in the same conversation (one Opus turn, no new questions). */
  private async revise(questId: string, note: string): Promise<void> {
    const p = this.pending;
    const text = note.trim().slice(0, 2000);
    if (!p || p.id !== questId || this.activeQuest || !text) return;
    if (p.revision >= MAX_REVISIONS) {
      this.say('We have redrawn this one often enough. Light the forges, or send it back and start afresh.');
      return;
    }
    this.activeQuest = p.id;
    this.abort = new AbortController();
    this.ledger.questId = p.id;
    this.ledger.abort = this.abort;
    this.emit({ type: 'blueprint.revising', questId: p.id });
    this.say('Let me redraw that…');
    const asked: QA = {
      question: { id: `change-${p.revision + 1}`, header: 'Change', question: `Change request ${p.revision + 1} to the blueprint`, options: [], multiSelect: false, recommended: [] },
      answer: { picks: [], other: text },
    };
    try {
      const turn = await this.agents.plan(
        { request: p.request, qa: [...p.qa, asked], notes: p.notes, canAsk: false, round: PLAN_ROUNDS, rounds: PLAN_ROUNDS, previous: p.blueprint, feedback: text },
        this.cfg.repo,
        this.emit,
        this.ledger,
      );
      if (this.stopped) throw new Error('stopped');
      if (turn.kind !== 'blueprint') throw new Error('Thráin asked a question instead of redrawing');
      Object.assign(p, { blueprint: turn.blueprint, notes: turn.notes, qa: [...p.qa, asked], revision: p.revision + 1 });
      this.store.proposeQuest(p.id, p.blueprint.title, p.blueprint);
      this.emit({ type: 'blueprint.revised', ...view(p.id, p.blueprint, p.revision) });
      this.say(p.blueprint.summary);
    } catch (err) {
      // The old blueprint is still good: put its card back and say what happened.
      if (!this.stopped) this.fail(err instanceof Error ? err.message : String(err));
      else this.say('Stopped. The blueprint stays as it was.');
      this.emit({ type: 'blueprint.revised', ...view(p.id, p.blueprint, p.revision) });
    } finally {
      this.activeQuest = undefined;
      this.ledger.questId = undefined;
      this.history();
    }
  }

  /** You take a task out of the blueprint. No tokens: it is just editing the plan. */
  private dropTask(questId: string, taskId: string): void {
    const p = this.pending;
    if (!p || p.id !== questId || this.activeQuest) return;
    if (p.blueprint.tasks.length < 2) return this.say('A blueprint needs at least one task. Send it back instead.');
    const tasks = p.blueprint.tasks.filter((t) => t.id !== taskId);
    if (tasks.length === p.blueprint.tasks.length) return;
    p.blueprint = { ...p.blueprint, tasks };
    p.revision++;
    this.store.proposeQuest(p.id, p.blueprint.title, p.blueprint);
    this.emit({ type: 'blueprint.revised', ...view(p.id, p.blueprint, p.revision) });
  }

  /** Your answers (or undefined: "just draft it" with Thráin's own picks) to the current questions. */
  private answerPlan(questId: string, answers: Record<string, PlanAnswer> | undefined): void {
    const mid = this.midAsk;
    if (mid && mid.questId === questId) {
      this.midAsk = undefined;
      this.emit({ type: 'plan.answered', questId });
      mid.resolve(answers);
      return;
    }
    const draft = this.draft;
    if (!draft || draft.id !== questId || !draft.asked || this.activeQuest) return;
    draft.qa.push(...this.buildQA(draft.asked, answers));
    draft.asked = undefined;
    this.emit({ type: 'plan.answered', questId });
    if (!answers) draft.round = PLAN_ROUNDS; // "just draft it": no more questions
    this.say(answers ? 'Thank you. Let me think that through…' : 'Then I will use my own judgement.');
    void this.draftTurn();
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
    const run: QuestRun = {
      id: quest.id,
      request: quest.request,
      blueprint: quest.blueprint,
      queue: [...quest.blueprint.tasks],
      state: new Map(quest.blueprint.tasks.map((t) => [t.id, 'queued'])),
      titles: new Map(quest.blueprint.tasks.map((t) => [t.id, t.title])),
      replans: 0,
    };
    this.run = run;
    const queue = run.queue;
    const merged: string[] = [];
    const failed: string[] = [];

    const work = async (smith: Dwarf): Promise<void> => {
      for (let task = queue.shift(); task && !this.stopped; task = queue.shift()) {
        run.state.set(task.id, 'running');
        const result = await this.runTask(quest.id, smith, task).catch((err: unknown): 'failed' => {
          if (!this.stopped) this.emit({ type: 'forge.error', message: `${smith.name}: ${err instanceof Error ? err.message : String(err)}` });
          return 'failed';
        });
        run.state.set(task.id, result);
        // A replaced task is neither merged nor failed: its successors carry the work.
        if (result === 'merged') merged.push(task.title);
        else if (result === 'failed') failed.push(task.title);
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
    this.run = undefined;
    this.activeQuest = undefined;
    this.ledger.questId = undefined;
    this.history();
    this.setBusy(false);
  }

  private async runTask(questId: string, smith: Dwarf, task: BlueprintTask): Promise<'merged' | 'failed' | 'replaced'> {
    const branch = `forge/${questId}/${task.id}`;
    const taskId = task.id;
    const offeringId = `${questId}-${taskId}`;
    let attempts = 0;
    const record = (status: 'working' | 'merged' | 'failed' | 'replaced', summary?: string) =>
      this.store.upsertTask(questId, taskId, task.title, smith.id, status, attempts, summary);
    const fail = (summary: string): 'failed' => {
      record('failed', summary);
      this.store.bumpCrew(smith.id, 'tasks_failed');
      return 'failed';
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

        if (outcome.status === 'blocked') {
          // The task itself is wrong: not a failure. Thráin triages it (rewrite, reslice or ask you).
          const change = await this.replanBlocked(smith, task, outcome);
          if (change.kind === 'replaced') {
            record('replaced', change.reason);
            return 'replaced';
          }
          if (change.kind === 'fail') return fail(change.reason);
          task = change.task;
          notes = `Thráin redrew this task after you flagged it. Work from the new brief; it supersedes the old one.`;
          continue;
        }

        if (outcome.status === 'done' && outcome.testsPassed) {
          // Lay it on Odin's scales.
          revision++;
          const verdict = await this.odin.offer({ id: offeringId, questId, taskId, dwarfId: smith.id, title: task.title, branch, revision, task });
          if (verdict.kind === 'merged') {
            record('merged', outcome.summary);
            this.store.bumpCrew(smith.id, 'tasks_done');
            this.emit({ type: 'task.done', questId, taskId, dwarfId: smith.id });
            return 'merged';
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

  // ------------------------------------------------------------------ replanning

  /**
   * A smith flagged their task as blocked. Thráin triages: rewrite it, reslice it into new tasks,
   * or (when it hinges on a decision only you can make) ask you. Small changes just happen and are
   * announced; one that grows the scope waits for your yes. Merged work stays on main.
   */
  private async replanBlocked(smith: Dwarf, task: BlueprintTask, outcome: SmithOutcome): Promise<Change> {
    const run = this.run;
    if (!run) return { kind: 'fail', reason: outcome.summary };
    const blocker = outcome.blocker ?? { kind: 'wrong_assumption' as const, detail: outcome.summary };
    if (run.replans >= MAX_REPLANS) {
      return { kind: 'fail', reason: `Blocked (${blocker.detail}), and this quest has already been re-planned ${MAX_REPLANS} times.` };
    }
    run.replans++;
    // The smith carries the ingot back to the Forgemaster's table (the escalation animation).
    this.emit({ type: 'escalation', dwarfId: smith.id, taskId: task.id, reason: `blocked: ${blocker.detail}`.slice(0, 200) });
    this.store.bumpCrew(smith.id, 'escalations');
    this.say(`${smith.name} flags “${task.title}”: ${blocker.detail.slice(0, 140)}`);

    const input = () => ({
      request: run.request,
      summary: run.blueprint.summary,
      tasks: [...run.state].map(([id, status]) => ({ id, title: run.titles.get(id) ?? id, status })),
      blocked: task,
      kind: blocker.kind,
      detail: blocker.detail,
    });
    let qa: QA[] = [];
    let decision = await this.agents.triage({ ...input(), qa, canAsk: true }, this.cfg.repo, this.emit, this.ledger);
    if (this.stopped) return { kind: 'fail', reason: 'Stopped.' };
    if (decision.decision === 'ask') {
      const questions = decision.questions;
      const answers = await new Promise<Record<string, PlanAnswer> | undefined>((resolve) => {
        this.midAsk = { questions, questId: run.id, resolve };
        this.emit({ type: 'plan.questions', questId: run.id, round: 1, rounds: 1, questions });
        this.say('I need your word on this before I redraw it.');
      });
      if (this.stopped) return { kind: 'fail', reason: 'Stopped.' };
      qa = this.buildQA(questions, answers);
      decision = await this.agents.triage({ ...input(), qa, canAsk: false }, this.cfg.repo, this.emit, this.ledger);
      if (this.stopped) return { kind: 'fail', reason: 'Stopped.' };
    }
    if (decision.decision === 'ask') return { kind: 'fail', reason: 'Thráin could not decide how to change the plan.' };

    const changeId = `${run.id}-c${run.replans}`;
    if (decision.decision === 'rewrite') {
      const next: BlueprintTask = { ...decision.task, id: task.id };
      this.applyAmendment(run, changeId, decision.reason, { added: [], changed: [next], dropped: [] });
      this.say(`Redrawn “${next.title}”: ${decision.reason}`);
      return { kind: 'rewrite', task: next };
    }

    // Reslice: new tasks take this one's place; obsolete queued tasks are dropped.
    const taken = new Set(run.titles.keys());
    const added = decision.tasks.slice(0, 3).map((t, i) => {
      const base = (t.id || `${task.id}-${i + 1}`).toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 28) || `task-${i + 1}`;
      let id = base;
      for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
      taken.add(id);
      return { ...t, id };
    });
    const dropIds = decision.drop.filter((id) => run.queue.some((q) => q.id === id));
    const dropped = [{ id: task.id, title: task.title }, ...dropIds.map((id) => ({ id, title: run.titles.get(id) ?? id }))];
    const change = { added, changed: [], dropped };
    // More work than before (new tasks beyond the ones they replace) is a change of scope: it needs your yes.
    if (added.length > dropped.length) {
      this.emit({ type: 'plan.amended', questId: run.id, changeId, state: 'proposed', reason: decision.reason, ...this.views(change) });
      this.say('This grows the plan. Tell me whether to go ahead.');
      const ok = await new Promise<boolean>((resolve) => {
        this.changeWaits.set(changeId, (approve) => {
          this.changeWaits.delete(changeId);
          resolve(approve);
        });
      });
      if (!ok) {
        this.emit({ type: 'plan.amended', questId: run.id, changeId, state: 'declined', reason: decision.reason, ...this.views(change) });
        return { kind: 'fail', reason: this.stopped ? 'Stopped.' : 'You kept the original plan; this piece is left undone.' };
      }
    }
    this.applyAmendment(run, changeId, decision.reason, change);
    this.say(`The plan is re-cut: ${decision.reason}`);
    return { kind: 'replaced', reason: decision.reason };
  }

  private views(c: { added: BlueprintTask[]; changed: BlueprintTask[]; dropped: { id: string; title: string }[] }) {
    return { added: view('', { title: '', summary: '', tasks: c.added }, 0).tasks, changed: view('', { title: '', summary: '', tasks: c.changed }, 0).tasks, dropped: c.dropped };
  }

  /** Make a change of plan real: the live queue, the task list, the stored blueprint, and tell the screens. */
  private applyAmendment(run: QuestRun, changeId: string, reason: string, c: { added: BlueprintTask[]; changed: BlueprintTask[]; dropped: { id: string; title: string }[] }): void {
    for (const d of c.dropped) {
      const at = run.queue.findIndex((q) => q.id === d.id);
      if (at >= 0) run.queue.splice(at, 1); // not started yet: it simply never runs
      run.state.set(d.id, 'replaced');
    }
    run.queue.unshift(...c.added);
    for (const t of c.added) {
      run.state.set(t.id, 'queued');
      run.titles.set(t.id, t.title);
    }
    for (const t of c.changed) run.titles.set(t.id, t.title);
    const gone = new Set(c.dropped.map((d) => d.id));
    const changed = new Map(c.changed.map((t) => [t.id, t]));
    run.blueprint = { ...run.blueprint, tasks: [...run.blueprint.tasks.filter((t) => !gone.has(t.id)).map((t) => changed.get(t.id) ?? t), ...c.added] };
    this.store.updateBlueprint(run.id, run.blueprint);
    this.emit({ type: 'plan.amended', questId: run.id, changeId, state: 'applied', reason, ...this.views(c) });
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
