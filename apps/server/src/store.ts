import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Model, ModelTotals, QuestSummary } from '@deepanvil/shared';

// The forge's memory (Node's built-in SQLite: no native modules, so it runs fine from the
// node_modules shared with Windows). Lives in WSL at ~/.deepanvil/forge.db.

export type QuestStatus = 'drafting' | 'proposed' | 'forging' | 'done' | 'rejected' | 'failed' | 'interrupted';
export type TaskStatus = 'working' | 'merged' | 'failed' | 'replaced';

export class Store {
  private db: DatabaseSync;

  constructor(path = process.env.DEEPANVIL_DB ?? join(homedir(), '.deepanvil', 'forge.db')) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS quests (
        id TEXT PRIMARY KEY,
        request TEXT NOT NULL,
        title TEXT,
        repo TEXT NOT NULL,
        status TEXT NOT NULL,
        blueprint TEXT,
        created_at INTEGER NOT NULL,
        finished_at INTEGER,
        merged INTEGER DEFAULT 0,
        failed INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS tasks (
        quest_id TEXT NOT NULL,
        id TEXT NOT NULL,
        title TEXT NOT NULL,
        dwarf_id TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER DEFAULT 0,
        summary TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (quest_id, id)
      );
      CREATE TABLE IF NOT EXISTS spend (
        at INTEGER NOT NULL,
        quest_id TEXT,
        dwarf_id TEXT NOT NULL,
        model TEXT NOT NULL,
        cost_usd REAL NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS spend_at ON spend (at);
      CREATE TABLE IF NOT EXISTS offerings (
        id TEXT PRIMARY KEY,
        quest_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        dwarf_id TEXT NOT NULL,
        branch TEXT NOT NULL,
        revision INTEGER NOT NULL,
        state TEXT NOT NULL,
        reason TEXT,
        lines INTEGER DEFAULT 0,
        head_sha TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS gate_runs (
        offering_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        gate TEXT NOT NULL,
        status TEXT NOT NULL,
        duration_ms INTEGER,
        output_tail TEXT,
        at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reviews (
        offering_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        decision TEXT NOT NULL,
        summary TEXT,
        findings TEXT,
        at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS repo_policy (
        repo TEXT PRIMARY KEY,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS push_subs (
        endpoint TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS crew (
        dwarf_id TEXT PRIMARY KEY,
        tasks_done INTEGER DEFAULT 0,
        tasks_failed INTEGER DEFAULT 0,
        escalations INTEGER DEFAULT 0,
        bells INTEGER DEFAULT 0
      );
    `);
  }

  // ------------------------------------------------------------------ quests

  createQuest(id: string, request: string, repo: string): void {
    this.db.prepare('INSERT INTO quests (id, request, repo, status, created_at) VALUES (?, ?, ?, ?, ?)').run(id, request, repo, 'drafting', Date.now());
  }

  proposeQuest(id: string, title: string, blueprint: unknown): void {
    this.db.prepare("UPDATE quests SET title = ?, blueprint = ?, status = 'proposed' WHERE id = ?").run(title, JSON.stringify(blueprint), id);
  }

  /** The blueprint changed mid-quest (a replan): keep the stored plan current without touching the status. */
  updateBlueprint(id: string, blueprint: unknown): void {
    this.db.prepare('UPDATE quests SET blueprint = ? WHERE id = ?').run(JSON.stringify(blueprint), id);
  }

  setQuestStatus(id: string, status: QuestStatus, counts?: { merged: number; failed: number }): void {
    const done = ['done', 'rejected', 'failed', 'interrupted'].includes(status) ? Date.now() : null;
    this.db
      .prepare('UPDATE quests SET status = ?, finished_at = COALESCE(?, finished_at), merged = COALESCE(?, merged), failed = COALESCE(?, failed) WHERE id = ?')
      .run(status, done, counts?.merged ?? null, counts?.failed ?? null, id);
  }

  /** The blueprint still waiting for approval, if the forge restarted mid-decision. */
  pendingQuest(): { id: string; request: string; blueprint: unknown } | undefined {
    const row = this.db.prepare("SELECT id, request, blueprint FROM quests WHERE status = 'proposed' ORDER BY created_at DESC LIMIT 1").get() as
      | { id: string; request: string; blueprint: string }
      | undefined;
    return row && { id: row.id, request: row.request, blueprint: JSON.parse(row.blueprint) };
  }

  /** Quests that were mid-flight when the forge stopped can't resume (their agents died). */
  interruptUnfinished(): string[] {
    const rows = this.db.prepare("SELECT id FROM quests WHERE status IN ('drafting', 'forging')").all() as { id: string }[];
    this.db.prepare("UPDATE quests SET status = 'interrupted', finished_at = ? WHERE status IN ('drafting', 'forging')").run(Date.now());
    this.db.prepare("UPDATE tasks SET status = 'failed', updated_at = ? WHERE status = 'working'").run(Date.now());
    return rows.map((r) => r.id);
  }

  history(limit = 12): QuestSummary[] {
    const rows = this.db
      .prepare(
        `SELECT q.id, q.title, q.request, q.status, q.created_at, q.merged, q.failed,
                COALESCE((SELECT SUM(cost_usd) FROM spend s WHERE s.quest_id = q.id), 0) AS cost
         FROM quests q ORDER BY q.created_at DESC LIMIT ?`,
      )
      .all(limit) as { id: string; title: string | null; request: string; status: string; created_at: number; merged: number; failed: number; cost: number }[];
    return rows.map((r) => ({
      id: r.id,
      title: r.title ?? r.request.slice(0, 60),
      status: r.status,
      createdAt: r.created_at,
      merged: r.merged,
      failed: r.failed,
      costUsd: r.cost,
    }));
  }

  // ------------------------------------------------------------------ tasks & crew

  upsertTask(questId: string, id: string, title: string, dwarfId: string, status: TaskStatus, attempts: number, summary?: string): void {
    this.db
      .prepare(
        `INSERT INTO tasks (quest_id, id, title, dwarf_id, status, attempts, summary, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (quest_id, id) DO UPDATE SET status = excluded.status, attempts = excluded.attempts,
           summary = COALESCE(excluded.summary, summary), updated_at = excluded.updated_at`,
      )
      .run(questId, id, title, dwarfId, status, attempts, summary ?? null, Date.now());
  }

  bumpCrew(dwarfId: string, field: 'tasks_done' | 'tasks_failed' | 'escalations' | 'bells'): void {
    this.db.prepare(`INSERT INTO crew (dwarf_id, ${field}) VALUES (?, 1) ON CONFLICT (dwarf_id) DO UPDATE SET ${field} = ${field} + 1`).run(dwarfId);
  }

  // ------------------------------------------------------------------ Odin

  upsertOffering(o: { id: string; questId: string; taskId: string; dwarfId: string; branch: string; revision: number; state: string; reason?: string; lines?: number; headSha?: string }): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO offerings (id, quest_id, task_id, dwarf_id, branch, revision, state, reason, lines, head_sha, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET revision = excluded.revision, state = excluded.state, reason = excluded.reason,
           lines = COALESCE(excluded.lines, lines), head_sha = COALESCE(excluded.head_sha, head_sha), updated_at = excluded.updated_at`,
      )
      .run(o.id, o.questId, o.taskId, o.dwarfId, o.branch, o.revision, o.state, o.reason ?? null, o.lines ?? null, o.headSha ?? null, now, now);
  }

  recordGate(offeringId: string, revision: number, gate: string, status: string, durationMs: number, outputTail: string): void {
    this.db.prepare('INSERT INTO gate_runs (offering_id, revision, gate, status, duration_ms, output_tail, at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(offeringId, revision, gate, status, durationMs, outputTail.slice(-4000), Date.now());
  }

  recordReview(offeringId: string, revision: number, decision: string, summary: string, findings: unknown): void {
    this.db.prepare('INSERT INTO reviews (offering_id, revision, decision, summary, findings, at) VALUES (?, ?, ?, ?, ?, ?)').run(offeringId, revision, decision, summary, JSON.stringify(findings), Date.now());
  }

  /** Offerings left mid-review by a restart can't resume: their worktrees were cleared. */
  abandonOpenOfferings(): void {
    this.db.prepare("UPDATE offerings SET state = 'abandoned', reason = 'forge restarted', updated_at = ? WHERE state NOT IN ('merged', 'abandoned')").run(Date.now());
  }

  policy(repo: string): string | undefined {
    return (this.db.prepare('SELECT json FROM repo_policy WHERE repo = ?').get(repo) as { json: string } | undefined)?.json;
  }

  setPolicy(repo: string, json: string): void {
    this.db.prepare('INSERT INTO repo_policy (repo, json) VALUES (?, ?) ON CONFLICT (repo) DO UPDATE SET json = excluded.json').run(repo, json);
  }

  // ------------------------------------------------------------------ push

  addPushSub(endpoint: string, json: string): void {
    this.db.prepare('INSERT INTO push_subs (endpoint, json, created_at) VALUES (?, ?, ?) ON CONFLICT (endpoint) DO UPDATE SET json = excluded.json').run(endpoint, json, Date.now());
  }

  removePushSub(endpoint: string): void {
    this.db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(endpoint);
  }

  pushSubs(): { endpoint: string; json: string }[] {
    return this.db.prepare('SELECT endpoint, json FROM push_subs').all() as { endpoint: string; json: string }[];
  }

  // ------------------------------------------------------------------ spend

  recordSpend(questId: string | undefined, dwarfId: string, model: Model, costUsd: number, input: number, output: number, cacheRead: number): void {
    this.db
      .prepare('INSERT INTO spend (at, quest_id, dwarf_id, model, cost_usd, input_tokens, output_tokens, cache_read_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(Date.now(), questId ?? null, dwarfId, model, costUsd, input, output, cacheRead);
  }

  /** Spend per model tier since `since` (ms epoch). */
  spendSince(since: number): { byModel: Partial<Record<Model, ModelTotals>>; totalUsd: number } {
    const rows = this.db
      .prepare(
        `SELECT model, SUM(cost_usd) cost, SUM(input_tokens) input, SUM(output_tokens) output, SUM(cache_read_tokens) cache, COUNT(*) calls
         FROM spend WHERE at >= ? GROUP BY model`,
      )
      .all(since) as { model: Model; cost: number; input: number; output: number; cache: number; calls: number }[];
    const byModel: Partial<Record<Model, ModelTotals>> = {};
    let totalUsd = 0;
    for (const r of rows) {
      byModel[r.model] = { costUsd: r.cost, inputTokens: r.input, outputTokens: r.output, cacheReadTokens: r.cache, calls: r.calls };
      totalUsd += r.cost;
    }
    return { byModel, totalUsd };
  }
}

/** Local midnight, for "today" in the treasury. */
export function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
