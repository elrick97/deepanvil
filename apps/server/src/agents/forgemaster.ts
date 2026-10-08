import { MODELS } from './engine.ts';
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

export async function plan(request: string, repo: string, emit: Emit, ledger: Ledger): Promise<Blueprint> {
  const r = await runAgent(
    {
      dwarfId: 'thrain',
      model: MODELS.opus,
      prompt: `The human asks:\n\n${request}\n\nStudy the repository, then return the blueprint.`,
      options: {
        cwd: repo,
        systemPrompt: SYSTEM,
        tools: READ_ONLY,
        allowedTools: READ_ONLY,
        maxTurns: 25,
        effort: 'high',
        outputFormat: { type: 'json_schema', schema: BLUEPRINT_SCHEMA as unknown as Record<string, unknown> },
      },
    },
    emit,
    ledger,
  );
  if (r.subtype !== 'success' || !r.structured_output) throw new Error(`The Forgemaster could not draft a blueprint (${r.subtype})`);
  const bp = r.structured_output as Blueprint;
  // Ids become branch and directory names: keep them safe.
  bp.tasks.forEach((t, i) => (t.id = (t.id || `task-${i + 1}`).toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 32)));
  return bp;
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
        systemPrompt: SYSTEM,
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
