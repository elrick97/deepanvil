// Measures what the engine adds to a call in different configurations (run on Haiku: cheap).
// Finding (2026-10-08): the account's claude.ai MCP connectors added ~37k tokens per call
// until strictMcpConfig + mcpServers: {} (now a default in run.ts).
// Run inside WSL: bash scripts/server.sh smoke
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { ENGINE_PATH, MODELS } from './engine.ts';

const base: Options = { model: MODELS.haiku, maxTurns: 2, settingSources: [], persistSession: false, pathToClaudeCodeExecutable: ENGINE_PATH };
const schema = { type: 'object', additionalProperties: false, required: ['word'], properties: { word: { type: 'string' } } };
const lean: Options = { systemPrompt: 'Be brief.', tools: [] };
const variants: [string, Options][] = [
  ['custom prompt, no tools', lean],
  ['+ skills: []', { ...lean, skills: [] }],
  ['+ strictMcpConfig', { ...lean, strictMcpConfig: true, mcpServers: {} }],
  ['+ both', { ...lean, skills: [], strictMcpConfig: true, mcpServers: {} }],
];
for (const [label, opts] of variants) {
  for await (const msg of query({ prompt: 'Reply with the word: anvil', options: { ...base, ...opts } })) {
    if (msg.type === 'result') {
      const u = Object.values(msg.modelUsage)[0]!;
      console.log(`${label.padEnd(26)} in=${u.inputTokens} cacheWrite=${u.cacheCreationInputTokens} cacheRead=${u.cacheReadInputTokens} $${u.costUSD.toFixed(5)}`);
    }
  }
}
