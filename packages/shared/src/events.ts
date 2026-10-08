// The event contract between the orchestrator and the world.
// The mock simulator (M3) and the real orchestrator (M4) emit exactly these.

export type Model = 'opus' | 'sonnet' | 'haiku';

export type Role = 'forgemaster' | 'smith' | 'sprite';

export interface Dwarf {
  id: string;
  name: string;
  role: Role;
  model: Model;
}

export type ToolKind = 'read' | 'grep' | 'edit' | 'write' | 'bash';

export type ForgeEvent =
  | { type: 'hello'; serverTime: number; crew: Dwarf[] }
  | { type: 'blueprint.proposed'; questId: string; title: string; tasks: { id: string; title: string }[] }
  | { type: 'blueprint.approved'; questId: string }
  | { type: 'task.assigned'; questId: string; taskId: string; dwarfId: string; title: string }
  | { type: 'task.done'; questId: string; taskId: string; dwarfId: string }
  | { type: 'tool'; dwarfId: string; taskId: string; kind: ToolKind; summary: string }
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
  | { type: 'forge.status'; mode: 'mock' | 'live'; repo: string; smiths: number; busy: boolean }
  | { type: 'forge.error'; message: string };

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
  | { type: 'blueprint.approve'; questId: string }
  | { type: 'blueprint.reject'; questId: string }
  | { type: 'quest.abort' }
  | { type: 'permission.answer'; requestId: string; approved: boolean }
  | { type: 'push.subscribe'; subscription: { endpoint: string; keys: { p256dh: string; auth: string } } };

export type ForgeEventType = ForgeEvent['type'];

/** Envelope sent over the WebSocket. */
export interface Envelope {
  seq: number;
  at: number;
  event: ForgeEvent;
}
