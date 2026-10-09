import type { PlanAnswer, PlanQuestion } from '@deepanvil/shared';
import { MODELS } from './engine.ts';
import { loadInstructions, withInstructions } from './instructions.ts';
import { runAgent, type Emit, type Ledger } from './run.ts';

// Thráin, the Forgemaster (Opus). Plans and re-plans; never writes code or reviews it (Odin does).
// The blueprint carries a context pack per task (exact files + why), so Sonnet smiths
// start focused instead of re-exploring the repo — the biggest token saving in the forge.

export interface BlueprintTask {
  id: string;
  title: string;
  brief: string;
  files: { path: string; why: string }[];
  acceptance: string;
}

export interface Blueprint {
  title: string;
  summary: string;
  tasks: BlueprintTask[];
}

const SYSTEM = `You are Thráin, Forgemaster of Deepanvil: a senior engineer who plans work for a crew of smith agents.
You read the repository with your tools, then produce a blueprint. You never write the implementation yourself.

Blueprint rules:
- 1 to 4 tasks. Prefer fewer. Each task must be completable by one engineer in one sitting.
- Tasks run IN PARALLEL in separate git worktrees: they must touch disjoint files, or the merge will conflict.
- "files" is the context pack: the exact paths the smith must read or change, each with why. Be specific.
- "brief" says precisely what to build or change and any constraints/conventions you observed.
- "acceptance" is ONE shell command that proves the task works (usually the test command), plus what must be true.
- Task ids are short kebab-case.`;

const BLUEPRINT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'summary', 'tasks'],
  properties: {
    title: { type: 'string', description: 'Quest title, max 60 chars' },
    summary: { type: 'string', description: 'Two sentences for the human' },
    tasks: {
      type: 'array',
      minItems: 1,
      maxItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'brief', 'files', 'acceptance'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string', description: 'max 40 chars' },
          brief: { type: 'string' },
          files: {
            type: 'array',
            items: { type: 'object', additionalProperties: false, required: ['path', 'why'], properties: { path: { type: 'string' }, why: { type: 'string' } } },
          },
          acceptance: { type: 'string' },
        },
      },
    },
  },
} as const;

const READ_ONLY = ['Read', 'Grep', 'Glob', 'LS'];

/** A system prompt plus what the repository's maintainers wrote down (CLAUDE.md, AGENTS.md). */
export async function systemFor(base: string, repo: string): Promise<string> {
  return withInstructions(base, await loadInstructions(repo));
}

// ---------------------------------------------------------------- clarifying questions

/** Added to Thráin's planning prompt only (re-plans don't need it). */
const CLARIFY = `

Clarify before you plan:
- Look at the repository first, so you only ask what the code cannot tell you.
- Ask (outcome "questions") when the intent is unclear, when there are several reasonable designs with different trade-offs,
  when scope boundaries or edge-case behaviour are open, or when the answer would change the task split. Ask nothing you can
  settle by reading the code, and nothing trivial.
- 1 to 4 questions, each with a short header (max 14 chars), 2 to 4 concrete options with a one-line description each, and
  your own recommended option(s) in "recommended" (exact option labels). Put the question the answer matters most for first.
- If the request is specific and unambiguous, skip the questions and return the blueprint straight away.
- With answers in hand, ask a follow-up only when a new ambiguity really blocks the plan; otherwise return the blueprint.
- Use "notes" to record what you learned about the repository (key files, conventions, test command) in under 1500 characters,
  so you need not read it all again next round.`;

export interface QA {
  question: PlanQuestion;
  answer: PlanAnswer;
}

export interface PlanInput {
  request: string;
  /** Questions already asked and answered, oldest first. */
  qa: QA[];
  /** Thráin's own repository notes from the previous round. */
  notes: string;
  /** False on the last round (or after "just draft it"): he must return a blueprint. */
  canAsk: boolean;
  round: number;
  rounds: number;
  /** A revision: the blueprint you saw and what you want changed. */
  previous?: Blueprint;
  feedback?: string;
}

export type PlanTurn = { kind: 'questions'; questions: PlanQuestion[]; notes: string } | { kind: 'blueprint'; blueprint: Blueprint; notes: string };

const QUESTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'header', 'question', 'options', 'multiSelect', 'recommended'],
  properties: {
    id: { type: 'string', description: 'short kebab-case id' },
    header: { type: 'string', description: 'max 14 chars' },
    question: { type: 'string' },
    options: {
      type: 'array',
      minItems: 2,
      maxItems: 4,
      items: { type: 'object', additionalProperties: false, required: ['label', 'description'], properties: { label: { type: 'string' }, description: { type: 'string' } } },
    },
    multiSelect: { type: 'boolean' },
    recommended: { type: 'array', items: { type: 'string' }, description: 'exact labels of the option(s) you would pick' },
  },
};

const BLUEPRINT_PROPS = BLUEPRINT_SCHEMA.properties;

function planSchema(canAsk: boolean): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['outcome'],
    properties: {
      outcome: { type: 'string', enum: canAsk ? ['questions', 'blueprint'] : ['blueprint'] },
      notes: { type: 'string', description: 'what you learned about the repository, max 1500 chars' },
      ...(canAsk ? { questions: { type: 'array', maxItems: 4, items: QUESTION_SCHEMA } } : {}),
      title: BLUEPRINT_PROPS.title,
      summary: BLUEPRINT_PROPS.summary,
      tasks: BLUEPRINT_PROPS.tasks,
    },
  };
}

/** Question text from the model is untrusted structure: clip it and keep only well-formed questions. */
function cleanQuestions(raw: unknown): PlanQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: PlanQuestion[] = [];
  for (const q of raw.slice(0, 4) as Record<string, unknown>[]) {
    const options = (Array.isArray(q?.options) ? q.options : [])
      .slice(0, 4)
      .map((o: { label?: unknown; description?: unknown }) => ({ label: String(o?.label ?? '').slice(0, 80), description: String(o?.description ?? '').slice(0, 200) }))
      .filter((o: { label: string }) => o.label);
    const question = String(q?.question ?? '').slice(0, 400);
    if (options.length < 2 || !question) continue;
    const labels = options.map((o: { label: string }) => o.label);
    const multiSelect = q.multiSelect === true;
    const recommended = (Array.isArray(q.recommended) ? q.recommended.map(String) : []).filter((l) => labels.includes(l));
    out.push({
      id: `q${out.length + 1}`,
      header: String(q.header ?? 'Question').slice(0, 14),
      question,
      options,
      multiSelect,
      recommended: multiSelect ? recommended : recommended.slice(0, 1),
    });
  }
  return out;
}

function qaText(qa: QA[]): string {
  return qa
    .map(({ question: q, answer: a }, i) => {
      const said = [...a.picks, ...(a.other ? [`(in their own words) ${a.other}`] : [])].join('; ') || '(no answer)';
      return `${i + 1}. [${q.header}] ${q.question}\n   Answer: ${said}`;
    })
    .join('\n');
}

export async function plan(input: PlanInput, repo: string, emit: Emit, ledger: Ledger): Promise<PlanTurn> {
  const prompt = [
    `The human asks:\n\n${input.request}`,
    input.notes ? `\nYour repository notes from reading it earlier (trust them; read more only if needed):\n${input.notes}` : '',
    input.qa.length ? `\nClarifications so far:\n${qaText(input.qa)}` : '',
    input.previous ? `\nYour current blueprint (the human has read it):\n${JSON.stringify(input.previous)}` : '',
    input.feedback ? `\nThe human asks for changes:\n${input.feedback}\nRevise the blueprint: keep what still fits, change what is asked, keep the blueprint rules.` : '',
    input.canAsk
      ? `\nStudy the repository, then either ask clarifying questions or return the blueprint. This is round ${input.round} of ${input.rounds}.`
      : '\nDo not ask further questions. Where something is still open, take the recommended or most sensible choice and state the assumption in the blueprint summary. Return the blueprint.',
  ].join('\n');
  const r = await runAgent(
    {
      dwarfId: 'thrain',
      model: MODELS.opus,
      prompt,
      options: {
        cwd: repo,
        systemPrompt: await systemFor(SYSTEM + CLARIFY, repo),
        tools: READ_ONLY,
        allowedTools: READ_ONLY,
        maxTurns: 25,
        effort: 'high',
        outputFormat: { type: 'json_schema', schema: planSchema(input.canAsk) },
      },
    },
    emit,
    ledger,
  );
  if (r.subtype !== 'success' || !r.structured_output) throw new Error(`The Forgemaster could not draft a blueprint (${r.subtype})`);
  const out = r.structured_output as { outcome?: string; notes?: string; questions?: unknown; title?: string; summary?: string; tasks?: BlueprintTask[] };
  if (out.outcome === 'questions') {
    const questions = input.canAsk ? cleanQuestions(out.questions) : [];
    // Nothing usable to ask (or no asking allowed): make him draft with what he has.
    if (!questions.length) return plan({ ...input, canAsk: false, notes: String(out.notes ?? input.notes).slice(0, 2000) }, repo, emit, ledger);
    return { kind: 'questions', questions, notes: String(out.notes ?? '').slice(0, 2000) };
  }
  if (!out.tasks?.length) throw new Error('The Forgemaster returned a blueprint without tasks');
  const bp: Blueprint = { title: String(out.title ?? 'Quest').slice(0, 80), summary: String(out.summary ?? ''), tasks: out.tasks };
  // Ids become branch and directory names: keep them safe.
  bp.tasks.forEach((t, i) => (t.id = (t.id || `task-${i + 1}`).toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 32)));
  return { kind: 'blueprint', blueprint: bp, notes: String(out.notes ?? input.notes).slice(0, 2000) };
}

// ---------------------------------------------------------------- triage of a blocked task

const TRIAGE = `

A smith flagged a task as blocked: it cannot be done as briefed. Decide the smallest change that gets the quest moving:
- "rewrite": the task itself was wrong or unclear, but its scope stands. Return the corrected task (same id).
- "reslice": the work must be cut differently. Return 1 to 3 new tasks that replace the blocked one, and in "drop" the ids of
  queued (not yet started) tasks that are now obsolete. Tasks run in parallel on disjoint files; work already merged stays on main.
- "ask": only if the right fix hinges on a product or design decision the human must make (never something the repository
  answers). Return 1 to 3 questions, each with 2 to 4 options and your recommended pick.
Prefer rewrite over reslice and reslice over ask. Say in "reason", in one or two sentences, what was wrong and what you changed.`;

export interface TriageInput {
  request: string;
  summary: string;
  /** Every task in the quest and where it stands. */
  tasks: { id: string; title: string; status: string }[];
  blocked: BlueprintTask;
  kind: string;
  detail: string;
  qa: QA[];
  canAsk: boolean;
}

export type Triage =
  | { decision: 'rewrite'; reason: string; task: BlueprintTask }
  | { decision: 'reslice'; reason: string; tasks: BlueprintTask[]; drop: string[] }
  | { decision: 'ask'; reason: string; questions: PlanQuestion[] };

const TASK_SCHEMA = BLUEPRINT_SCHEMA.properties.tasks.items;

function triageSchema(canAsk: boolean): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['decision', 'reason'],
    properties: {
      decision: { type: 'string', enum: canAsk ? ['rewrite', 'reslice', 'ask'] : ['rewrite', 'reslice'] },
      reason: { type: 'string' },
      task: TASK_SCHEMA,
      tasks: { type: 'array', minItems: 1, maxItems: 3, items: TASK_SCHEMA },
      drop: { type: 'array', items: { type: 'string' } },
      ...(canAsk ? { questions: { type: 'array', maxItems: 3, items: QUESTION_SCHEMA } } : {}),
    },
  };
}

export async function triage(input: TriageInput, repo: string, emit: Emit, ledger: Ledger): Promise<Triage> {
  const prompt = [
    `The quest: ${input.request}`,
    `Blueprint summary: ${input.summary}`,
    `Tasks and where they stand:\n${input.tasks.map((t) => `- ${t.id} (${t.title}): ${t.status}`).join('\n')}`,
    `The blocked task:\n${JSON.stringify(input.blocked)}`,
    `The smith says it is blocked (${input.kind}): ${input.detail.slice(0, 2000)}`,
    input.qa.length ? `\nThe human answered your questions:\n${qaText(input.qa)}` : '',
    input.canAsk ? '\nDecide: rewrite, reslice or ask.' : '\nDecide now: rewrite or reslice (no more questions).',
  ].join('\n');
  const r = await runAgent(
    {
      dwarfId: 'thrain',
      model: MODELS.opus,
      prompt,
      options: {
        cwd: repo,
        systemPrompt: await systemFor(SYSTEM + TRIAGE, repo),
        tools: READ_ONLY,
        allowedTools: READ_ONLY,
        maxTurns: 15,
        effort: 'high',
        outputFormat: { type: 'json_schema', schema: triageSchema(input.canAsk) },
      },
    },
    emit,
    ledger,
  );
  if (r.subtype !== 'success' || !r.structured_output) throw new Error(`The Forgemaster could not triage the blocked task (${r.subtype})`);
  const out = r.structured_output as { decision?: string; reason?: string; task?: BlueprintTask; tasks?: BlueprintTask[]; drop?: unknown; questions?: unknown };
  const reason = String(out.reason ?? '').slice(0, 400);
  if (out.decision === 'ask' && input.canAsk) {
    const questions = cleanQuestions(out.questions);
    if (questions.length) return { decision: 'ask', reason, questions };
  }
  if (out.decision === 'reslice' && out.tasks?.length) {
    return { decision: 'reslice', reason, tasks: out.tasks.slice(0, 3), drop: (Array.isArray(out.drop) ? out.drop : []).map(String).slice(0, 8) };
  }
  if (out.task) return { decision: 'rewrite', reason, task: out.task };
  throw new Error('The Forgemaster returned no usable plan change');
}

// ---------------------------------------------------------------- rescoping by hand

const RESCOPE = `

The human wants to change the plan while the crew is already working. You see every task and where it stands.
- Tasks "merged", "in_review" (offered to Odin), "failed" or "replaced" cannot be changed; their work stands.
- You may drop tasks that are "queued" (not started) or "running" (their smith is stopped and the work so far is discarded),
  and add 1 to 4 new tasks. Tasks run in parallel on disjoint files, and new tasks build on what is already merged on main.
- Change as little as the request needs. Drop a running task only when the request really makes it pointless or wrong.
- If the request needs no change (it is already covered, or it is not about the plan), answer "none" and say why.
In "reason" say in one or two sentences what changes and why.`;

export interface RescopeInput {
  request: string;
  summary: string;
  tasks: { id: string; title: string; status: string; brief: string }[];
  note: string;
}

export type Rescope = { decision: 'none'; reason: string } | { decision: 'change'; reason: string; add: BlueprintTask[]; drop: string[] };

export async function rescope(input: RescopeInput, repo: string, emit: Emit, ledger: Ledger): Promise<Rescope> {
  const prompt = [
    `The quest: ${input.request}`,
    `Blueprint summary: ${input.summary}`,
    `Tasks and where they stand:\n${input.tasks.map((t) => `- ${t.id} (${t.title}) [${t.status}]: ${t.brief.slice(0, 300)}`).join('\n')}`,
    `\nThe human asks:\n${input.note.slice(0, 2000)}`,
    '\nDecide: "change" (what to drop, what to add) or "none".',
  ].join('\n');
  const r = await runAgent(
    {
      dwarfId: 'thrain',
      model: MODELS.opus,
      prompt,
      options: {
        cwd: repo,
        systemPrompt: await systemFor(SYSTEM + RESCOPE, repo),
        tools: READ_ONLY,
        allowedTools: READ_ONLY,
        maxTurns: 15,
        effort: 'high',
        outputFormat: {
          type: 'json_schema',
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['decision', 'reason'],
            properties: {
              decision: { type: 'string', enum: ['change', 'none'] },
              reason: { type: 'string' },
              add: { type: 'array', maxItems: 4, items: TASK_SCHEMA },
              drop: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
    emit,
    ledger,
  );
  if (r.subtype !== 'success' || !r.structured_output) throw new Error(`The Forgemaster could not rescope the quest (${r.subtype})`);
  const out = r.structured_output as { decision?: string; reason?: string; add?: BlueprintTask[]; drop?: unknown };
  const reason = String(out.reason ?? '').slice(0, 400);
  if (out.decision !== 'change') return { decision: 'none', reason };
  return { decision: 'change', reason, add: (out.add ?? []).slice(0, 4), drop: (Array.isArray(out.drop) ? out.drop : []).map(String).slice(0, 8) };
}

/** Re-plan one task after a smith failed it twice. */
export async function replan(task: BlueprintTask, failureNotes: string, repo: string, emit: Emit, ledger: Ledger): Promise<BlueprintTask> {
  const r = await runAgent(
    {
      dwarfId: 'thrain',
      model: MODELS.opus,
      prompt: [
        'A smith failed this task twice. Diagnose why from their notes and the repository, then rewrite the task',
        '(same id) with a clearer brief, a better context pack and a realistic acceptance check.',
        `<task>${JSON.stringify(task)}</task>`,
        `<smith_notes>${failureNotes.slice(0, 20_000)}</smith_notes>`,
      ].join('\n'),
      options: {
        cwd: repo,
        systemPrompt: await systemFor(SYSTEM, repo),
        tools: READ_ONLY,
        allowedTools: READ_ONLY,
        maxTurns: 15,
        effort: 'high',
        outputFormat: { type: 'json_schema', schema: BLUEPRINT_SCHEMA.properties.tasks.items as unknown as Record<string, unknown> },
      },
    },
    emit,
    ledger,
  );
  if (r.subtype !== 'success' || !r.structured_output) return task;
  return { ...(r.structured_output as BlueprintTask), id: task.id };
}
