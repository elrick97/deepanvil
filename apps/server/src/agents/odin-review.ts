import type { Finding } from '@deepanvil/shared';
import { MODELS } from './engine.ts';
import type { BlueprintTask } from './forgemaster.ts';
import { runAgent, type Emit, type Ledger } from './run.ts';

// Odin's judgement: one Sonnet call, no tools, on the *real* diff of an offering that already
// passed every gate. The system prompt and schema never change, so they stay a cached prefix.

export interface Verdict {
  decision: 'approve' | 'changes_requested';
  summary: string;
  findings: Finding[];
}

const SYSTEM = `You are Odin, keeper of the Vault of Main: the reviewer every change must pass before it lands on main.
The change below already passes the repository's tests, typecheck and lint, rebased on the latest main.
Judge only what automated gates can't: does it do what the task asked, is it correct, is it safe, is it
maintainable, does it fit the code around it? Be concrete and brief.
- "blocker": wrong, unsafe or breaks the brief. "major": a real bug or design problem worth fixing now.
  "minor"/"nit": worth mentioning but never a reason to send work back.
- Approve unless there is at least one blocker or major finding. Do not invent problems.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'summary', 'findings'],
  properties: {
    decision: { type: 'string', enum: ['approve', 'changes_requested'] },
    summary: { type: 'string', description: 'One short paragraph for the human' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'severity', 'note'],
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'nit'] },
          note: { type: 'string' },
        },
      },
    },
  },
};

/** `conventions` is the repository's own instructions (CLAUDE.md, AGENTS.md) as committed on the base branch. */
export type Reviewer = (task: BlueprintTask, diff: string, gateSummary: string, emit: Emit, ledger: Ledger, conventions?: string) => Promise<Verdict>;

export const sonnetReview: Reviewer = async (task, diff, gateSummary, emit, ledger, conventions) => {
  const r = await runAgent(
    {
      dwarfId: 'odin',
      model: MODELS.sonnet,
      prompt: [
        `<task>${JSON.stringify({ title: task.title, brief: task.brief, acceptance: task.acceptance })}</task>`,
        `<gates>${gateSummary}</gates>`,
        // The maintainers' own rules (judge the change against them too); in the user turn so the system prompt stays one cached prefix.
        ...(conventions ? [`<repo-conventions>\n${conventions.replaceAll('</repo-conventions>', '</ repo-conventions>')}\n</repo-conventions>`] : []),
        `<diff>\n${diff}\n</diff>`,
      ].join('\n'),
      options: {
        systemPrompt: SYSTEM,
        tools: [],
        maxTurns: 1,
        effort: 'medium',
        outputFormat: { type: 'json_schema', schema: SCHEMA },
      },
    },
    emit,
    ledger,
  );
  if (r.subtype !== 'success' || !r.structured_output) {
    // No verdict is not an approval: the human decides.
    return { decision: 'changes_requested', summary: `Odin could not reach a verdict (${r.subtype}); a human should look.`, findings: [] };
  }
  const v = r.structured_output as Verdict;
  // Only blocker/major findings may send work back, whatever the model said.
  const serious = v.findings.some((f) => f.severity === 'blocker' || f.severity === 'major');
  return { ...v, decision: serious ? 'changes_requested' : 'approve' };
};
