import { MODELS } from './engine.ts';
import { runAgent, type Emit, type Ledger } from './run.ts';

// Pip, the Haiku sprite. Small jobs with a tiny prompt and no tools: a bare Claude Code
// system prompt costs ~37k tokens per call, a custom one-liner costs ~600.

const PIP = 'You are Pip, the forge sprite of a dwarven coding workshop. Be brief and precise.';

async function ask(prompt: string, emit: Emit, ledger: Ledger): Promise<string> {
  const r = await runAgent(
    { dwarfId: 'pip', model: MODELS.haiku, prompt, options: { systemPrompt: PIP, tools: [], maxTurns: 1, effort: 'low' } },
    emit,
    ledger,
  );
  return r.subtype === 'success' ? r.result.trim() : '';
}

/**
 * Compress long tool output (test logs, install noise) before a bigger model reads it.
 * Every error line, path, line number and failing test name must survive verbatim.
 */
export async function digest(output: string, context: string, emit: Emit, ledger: Ledger): Promise<string> {
  const prompt = [
    `A smith ran: ${context}`,
    'Compress this output for them. Keep VERBATIM: every error/failure message, file path, line number,',
    'failing test name and the final summary line. Drop progress noise and passing-test chatter.',
    'Reply with the compressed output only.',
    '<output>',
    output.slice(0, 120_000),
    '</output>',
  ].join('\n');
  return (await ask(prompt, emit, ledger)) || output.slice(-4000);
}

/** One line of in-character flavour for a speech bubble (max ~12 words). */
export async function banter(name: string, situation: string, emit: Emit, ledger: Ledger): Promise<string> {
  const line = await ask(
    `Write one short, cozy, funny line (max 12 words, no quotes) that the dwarf smith ${name} mutters while ${situation}.`,
    emit,
    ledger,
  );
  return line.replace(/^["“]|["”]$/g, '').slice(0, 90);
}
