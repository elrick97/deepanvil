// The event contract between the orchestrator and the world.
// The mock simulator (M3) and the real orchestrator (M4) emit exactly these.

export type Model = 'opus' | 'sonnet' | 'haiku';

export type Role = 'forgemaster' | 'smith' | 'sprite' | 'keeper';

export interface Dwarf {
  id: string;
  name: string;
  role: Role;
  model: Model;
}

export type ToolKind = 'read' | 'grep' | 'edit' | 'write' | 'bash';

/** One line of a dwarf's live transcript (what the agent said, ran and got back). */
export interface LogEntry {
  at: number;
  kind: 'say' | 'tool' | 'result' | 'error';
  text: string;
}

/** A blueprint task as shown to you: enough to judge it before the forges are lit. */
export interface BlueprintTaskView {
  id: string;
  title: string;
  brief?: string;
  files?: { path: string; why: string }[];
  acceptance?: string;
}

/** One clarifying question from the Forgemaster (an ask-question form: pick option(s) or write your own). */
export interface PlanQuestion {
  id: string;
  /** Very short label for the question's chip, e.g. "Scope". */
  header: string;
  question: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
  /** Labels of the option(s) Thráin would pick; pre-selected in the form. */
  recommended: string[];
}

/** Your answer to one question: chosen option labels and/or free text ("Other…"). */
export interface PlanAnswer {
  picks: string[];
  other?: string;
}

/** One line of an agent's own to-do list (its TodoWrite tool), shown on the anvil's chalkboard. */
export interface TodoItem {
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export type ForgeEvent =
  | { type: 'hello'; serverTime: number; crew: Dwarf[] }
  | { type: 'plan.questions'; questId: string; round: number; rounds: number; questions: PlanQuestion[] }
  /** The questions were answered (or the quest ended): every open form closes. */
  | { type: 'plan.answered'; questId: string }
  /**
   * The plan changed mid-quest because a smith flagged their task as blocked. "applied": it is
   * done (the banner updates); "proposed": it grows the scope, so it waits for your answer
   * (plan.change); "declined": you kept the original plan.
   */
  | { type: 'plan.amended'; questId: string; changeId: string; state: 'proposed' | 'applied' | 'declined'; reason: string; added: BlueprintTaskView[]; changed: BlueprintTaskView[]; dropped: { id: string; title: string }[] }
  | { type: 'blueprint.proposed'; questId: string; title: string; summary?: string; revision?: number; tasks: BlueprintTaskView[] }
  /** Thráin redrew the blueprint (or you dropped a task): same shape, but not a new quest. */
  | { type: 'blueprint.revised'; questId: string; title: string; summary?: string; revision: number; tasks: BlueprintTaskView[] }
  /** Thráin is redrawing it from your feedback: the card waits. */
  | { type: 'blueprint.revising'; questId: string }
  /** You sent the blueprint back: every screen drops its draft card and banner. */
  | { type: 'blueprint.rejected'; questId: string }
  | { type: 'blueprint.approved'; questId: string }
  | { type: 'task.assigned'; questId: string; taskId: string; dwarfId: string; title: string }
  | { type: 'task.done'; questId: string; taskId: string; dwarfId: string }
  | { type: 'tool'; dwarfId: string; taskId: string; kind: ToolKind; summary: string }
  | { type: 'dwarf.log'; dwarfId: string; entry: LogEntry }
  /** The subscription limit was hit: the crew rests until `until` (ms epoch), then work resumes by itself. */
  | { type: 'forge.rest'; resting: boolean; until?: number; reason?: string }
  | { type: 'dwarf.todos'; dwarfId: string; items: TodoItem[] }
  | { type: 'test.pass'; dwarfId: string; taskId: string }
  | { type: 'test.fail'; dwarfId: string; taskId: string; attempt: number }
  | { type: 'permission.request'; dwarfId: string; requestId: string; action: string }
  | { type: 'permission.resolved'; dwarfId: string; requestId: string; approved: boolean }
  | { type: 'haiku.digest'; fromDwarfId: string; toDwarfId: string; note: string }
  | { type: 'escalation'; dwarfId: string; taskId: string; reason: string }
  | { type: 'merge'; questId: string; branch: string }
  | { type: 'usage.tick'; dwarfId: string; model: Model; inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number }
  | { type: 'banter'; dwarfId: string; line: string }
  | { type: 'master.say'; text: string }
  | { type: 'limits'; status: 'allowed' | 'allowed_warning' | 'rejected'; fiveHour?: LimitWindow; sevenDay?: LimitWindow }
  | { type: 'ledger'; byModel: Partial<Record<Model, ModelTotals>>; totalUsd: number; since: number }
  | { type: 'history'; quests: QuestSummary[] }
  | { type: 'push.config'; publicKey: string }
  // --- Odin, keeper of the Vault of Main (docs/ODIN.md)
  | { type: 'offering.opened'; offeringId: string; questId: string; taskId: string; dwarfId: string; title: string; revision: number; lines: number }
  | { type: 'offering.state'; offeringId: string; state: OfferingState; reason?: string }
  | { type: 'offering.gate'; offeringId: string; gate: GateName; status: GateStatus; summary?: string }
  | { type: 'offering.review'; offeringId: string; decision: 'approve' | 'changes_requested'; summary: string; findings: Finding[] }
  | { type: 'offering.merged'; offeringId: string; sha: string }
  | { type: 'offering.diff'; offeringId: string; diff: string }
  | { type: 'vault.health'; status: 'green' | 'red' | 'unknown'; sha: string; failing?: GateName[] }
  | { type: 'odin.say'; text: string }
  | { type: 'forge.status'; mode: 'mock' | 'live'; repo: string; smiths: number; busy: boolean }
  | { type: 'forge.error'; message: string };

export type OfferingState = 'queued' | 'rebasing' | 'gates' | 'reviewing' | 'awaiting_you' | 'merged' | 'sent_back' | 'abandoned';
export type GateName = 'tests' | 'types' | 'lint';
export type GateStatus = 'running' | 'pass' | 'fail' | 'flaky' | 'skipped';

/** One review finding; only blocker/major send work back. */
export interface Finding {
  file: string;
  line?: number;
  severity: 'blocker' | 'major' | 'minor' | 'nit';
  note: string;
}

/** Subscription usage window as reported by the engine (0..1 utilisation, unix seconds). */
export interface LimitWindow {
  utilization: number;
  resetsAt: number;
}

/** One line of the quest log (newest first). */
export interface QuestSummary {
  id: string;
  title: string;
  status: string;
  createdAt: number;
  merged: number;
  failed: number;
  costUsd: number;
}

export interface ModelTotals {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  calls: number;
}

/** Commands the world (you) sends to the forge. */
export type ClientCommand =
  | { type: 'quest.request'; text: string }
  | { type: 'plan.answer'; questId: string; answers: Record<string, PlanAnswer> }
  /** "Just draft it": Thráin goes ahead with his own picks. */
  | { type: 'plan.skip'; questId: string }
  /** Your answer to a proposed mid-quest change of plan. */
  | { type: 'plan.change'; changeId: string; approve: boolean }
  | { type: 'blueprint.approve'; questId: string }
  /** Ask Thráin for changes; he redraws in the same conversation. */
  | { type: 'blueprint.revise'; questId: string; note: string }
  /** Take one task out of the blueprint (no tokens spent). */
  | { type: 'blueprint.drop'; questId: string; taskId: string }
  | { type: 'blueprint.reject'; questId: string }
  | { type: 'quest.abort' }
  | { type: 'permission.answer'; requestId: string; approved: boolean }
  | { type: 'offering.merge'; offeringId: string }
  | { type: 'offering.send_back'; offeringId: string; note?: string }
  | { type: 'offering.diff'; offeringId: string }
  | { type: 'push.subscribe'; subscription: { endpoint: string; keys: { p256dh: string; auth: string } } };

export type ForgeEventType = ForgeEvent['type'];

/** Envelope sent over the WebSocket. */
export interface Envelope {
  seq: number;
  at: number;
  event: ForgeEvent;
}
