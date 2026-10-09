import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import type { Dwarf } from '@deepanvil/shared';
import { MODELS, SANDBOX_READY } from './engine.ts';
import type { BlueprintTask } from './forgemaster.ts';
import { isTestCommand, judge, kindOf } from './permissions.ts';
import { log, runAgent, type Emit, type Ledger } from './run.ts';
import { digest } from './sprite.ts';

// A Sonnet smith at their anvil: one scoped task, in their own git worktree.
// Hooks turn every tool call into a world event; oversized tool output is digested by
// Pip (Haiku) before Sonnet reads it; anything risky rings the bell and waits for you.

/** Why a smith stopped instead of forcing the task: it cannot be done as briefed. */
export interface Blocker {
  kind: 'wrong_assumption' | 'too_big' | 'depends_on_other' | 'out_of_scope';
  detail: string;
}

export interface SmithOutcome {
  /** done; stuck (tried and failed); blocked (the task itself is wrong: Thráin re-plans it). */
  status: 'done' | 'stuck' | 'blocked';
  testsPassed: boolean;
  summary: string;
  blocker?: Blocker;
}

// Appended to the shared Claude Code preset. Kept identical for every smith and task so the
// whole system prompt is one cached prefix across the crew (task details go in the prompt).
const RULES = `You are a smith of Deepanvil, working one scoped task in your own git worktree (your cwd).
- Stay inside your worktree. Read the files in your context pack first; explore further only if needed.
- Make the smallest change that satisfies the brief, matching the code's existing conventions.
- Change files with the Edit/Write tools, never with shell redirection or heredocs (those ring the human's bell).
- Do not install packages or use the network unless truly required (it will ask a human).
- When done: run the acceptance command, then commit your work with a one-line message (git add -A && git commit -m "<summary>"); no multi-line messages or trailers.
- If the task cannot be done as briefed, do not force it: stop and report status "blocked" with a blocker kind and detail.
  wrong_assumption: the brief rests on something the code contradicts. too_big: it is far larger than described.
  depends_on_other: it needs work another task has not delivered. out_of_scope: you found something that needs a decision first.
  Use "stuck" only when the task is sound but you could not make it work.
- Finish with the structured result. testsPassed means the acceptance command succeeded.`;

const OUTCOME_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'testsPassed', 'summary'],
  properties: {
    status: { type: 'string', enum: ['done', 'stuck', 'blocked'] },
    testsPassed: { type: 'boolean' },
    summary: { type: 'string', description: 'What you changed and how you verified it, or why you are stuck or blocked (max 5 sentences)' },
    blocker: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'detail'],
      description: 'Only when status is blocked',
      properties: {
        kind: { type: 'string', enum: ['wrong_assumption', 'too_big', 'depends_on_other', 'out_of_scope'] },
        detail: { type: 'string', description: 'What is wrong with the task and what you would change (1-3 sentences)' },
      },
    },
  },
};

const DIGEST_OVER = 6000; // characters of tool output before Pip compresses it

export interface SmithRun {
  /** This task's own stop switch (a rescope can stop one smith without stopping the quest). */
  abort?: AbortController;
  smith: Dwarf;
  task: BlueprintTask;
  worktree: string;
  attempt: number;
  notes?: string;
  emit: Emit;
  ledger: Ledger;
  /** Ring the bell; resolves when the human answers. */
  ask: (action: string) => Promise<boolean>;
}

function outputText(resp: unknown): string {
  if (typeof resp === 'string') return resp;
  const r = resp as { stdout?: string; stderr?: string } | null;
  if (r && (typeof r.stdout === 'string' || typeof r.stderr === 'string')) return `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  return JSON.stringify(resp ?? '');
}

export async function runSmith(run: SmithRun): Promise<SmithOutcome> {
  const { smith, task, worktree, emit, ledger } = run;
  let testEvents = 0;

  const pre: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
    const kind = kindOf(input.tool_name, toolInput);
    if (kind) {
      const summary = String(toolInput.command ?? toolInput.file_path ?? toolInput.pattern ?? input.tool_name).slice(0, 120);
      emit({ type: 'tool', dwarfId: smith.id, taskId: task.id, kind, summary });
    }
    return {};
  };

  const post: HookCallback = async (input) => {
    if (input.hook_event_name === 'PostToolUseFailure') {
      log(emit, smith.id, 'error', `${input.tool_name} failed: ${String((input as { error?: unknown }).error ?? '').slice(0, 400)}`);
    } else if (input.hook_event_name === 'PostToolUse' && input.tool_name === 'Bash') {
      // Tail of the output: the part that says whether it worked.
      const out = outputText(input.tool_response).trim();
      if (out) log(emit, smith.id, 'result', out.length > 500 ? `…${out.slice(-500)}` : out);
    }
    if (input.hook_event_name === 'PostToolUseFailure' && input.tool_name === 'Bash') {
      const command = String((input.tool_input as { command?: string })?.command ?? '');
      if (isTestCommand(command)) {
        testEvents++;
        emit({ type: 'test.fail', dwarfId: smith.id, taskId: task.id, attempt: run.attempt });
      }
      return {};
    }
    if (input.hook_event_name !== 'PostToolUse' || input.tool_name !== 'Bash') return {};
    const command = String((input.tool_input as { command?: string })?.command ?? '');
    if (isTestCommand(command)) {
      testEvents++;
      emit({ type: 'test.pass', dwarfId: smith.id, taskId: task.id });
    }
    const text = outputText(input.tool_response);
    if (text.length <= DIGEST_OVER) return {};
    // Token min-max: Haiku compresses the noise so Sonnet reads ~10x less.
    const short = await digest(text, command, emit, ledger);
    emit({ type: 'haiku.digest', fromDwarfId: 'pip', toDwarfId: smith.id, note: `${Math.round(text.length / 1000)}k chars of output → ${Math.round(short.length / 100) / 10}k` });
    const resp = input.tool_response as Record<string, unknown> | string;
    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        updatedToolOutput: typeof resp === 'object' && resp && 'stdout' in resp ? { ...resp, stdout: `[digested by Pip]\n${short}`, stderr: '' } : `[digested by Pip]\n${short}`,
      },
    };
  };

  const prompt = [
    `# Task: ${task.title} (attempt ${run.attempt})`,
    task.brief,
    '',
    '## Context pack',
    ...task.files.map((f) => `- ${f.path} — ${f.why}`),
    '',
    `## Acceptance\n${task.acceptance}`,
    run.notes ? `\n## Notes from the last round (fix these first; Odin checks every point)\n${run.notes}` : '',
  ].join('\n');

  const r = await runAgent(
    {
      dwarfId: smith.id,
      model: MODELS.sonnet,
      prompt,
      options: {
        cwd: worktree,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: RULES },
        disallowedTools: ['Task', 'Agent', 'WebSearch'],
        permissionMode: 'default',
        // Defence in depth: the OS sandbox when available (see engine.ts), never silently skipped.
        ...(SANDBOX_READY ? { sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false } } : {}),
        maxTurns: 60,
        effort: 'medium',
        ...(run.abort ? { abortController: run.abort } : {}),
        env: { ...process.env, GIT_EDITOR: 'true', GIT_AUTHOR_NAME: smith.name, GIT_AUTHOR_EMAIL: `${smith.id}@deepanvil.local`, GIT_COMMITTER_NAME: smith.name, GIT_COMMITTER_EMAIL: `${smith.id}@deepanvil.local` },
        outputFormat: { type: 'json_schema', schema: OUTCOME_SCHEMA },
        hooks: {
          PreToolUse: [{ hooks: [pre] }],
          PostToolUse: [{ hooks: [post] }],
          PostToolUseFailure: [{ hooks: [post] }],
        },
        canUseTool: async (tool, input) => {
          const v = judge(tool, input, worktree);
          if (v.kind === 'allow') return { behavior: 'allow', updatedInput: input };
          if (v.kind === 'deny') return { behavior: 'deny', message: v.message };
          return (await run.ask(v.action))
            ? { behavior: 'allow', updatedInput: input }
            : { behavior: 'deny', message: 'The human said no at the bell. Find another way, or report that you are stuck.' };
        },
      },
    },
    emit,
    ledger,
  );

  const out: SmithOutcome =
    r.subtype === 'success' && r.structured_output
      ? (r.structured_output as SmithOutcome)
      : { status: 'stuck', testsPassed: false, summary: r.subtype === 'success' ? r.result.slice(0, 800) : `Engine stopped: ${r.subtype}` };
  // The world needs to see a verdict even if no test command was recognised (a blocked task has none).
  if (testEvents === 0 && out.status !== 'blocked') {
    emit(out.testsPassed ? { type: 'test.pass', dwarfId: smith.id, taskId: task.id } : { type: 'test.fail', dwarfId: smith.id, taskId: task.id, attempt: run.attempt });
  }
  return out;
}
