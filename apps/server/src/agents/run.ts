import { query, type Options, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ForgeEvent, Model } from '@deepanvil/shared';
import { startOfToday, type Store } from '../store.ts';
import { ENGINE_PATH } from './engine.ts';

// Every agent call in the forge goes through runAgent(): it pins the engine, turns the
// SDK's message stream into world events (coins per API call, live subscription limits)
// and keeps the ledger of what each model tier has cost.

export type Emit = (e: ForgeEvent) => void;

// List prices per million tokens (input, output, cache read) — only used for the coin
// animation's per-call estimate; the ledger uses the engine's own costUSD.
const PRICE: Record<Model, [number, number, number]> = {
  opus: [4, 20, 0.2],
  sonnet: [2, 10, 0.2],
  haiku: [0.1, 0.5, 0.01],
};

export function tierOf(modelId: string): Model {
  if (modelId.includes('opus') || modelId.includes('fable')) return 'opus';
  if (modelId.includes('haiku')) return 'haiku';
  return 'sonnet';
}

/** Every agent call's cost goes into the store; the treasury shows today's totals. */
export class Ledger {
  /** Set by the orchestrator so spend is attributed to the running quest. */
  questId?: string;
  /** The running quest's stop switch; every agent call under it is aborted with it. */
  abort?: AbortController;
  private store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  add(result: SDKResultMessage, dwarfId: string): void {
    for (const [id, u] of Object.entries(result.modelUsage)) {
      this.store.recordSpend(this.questId, dwarfId, tierOf(id), u.costUSD, u.inputTokens + u.cacheCreationInputTokens, u.outputTokens, u.cacheReadInputTokens);
    }
  }

  event(): ForgeEvent {
    const since = startOfToday();
    return { type: 'ledger', ...this.store.spendSince(since), since };
  }
}

export interface RunSpec {
  dwarfId: string;
  model: string;
  prompt: string;
  options: Omit<Options, 'model' | 'pathToClaudeCodeExecutable'>;
}

export async function runAgent(spec: RunSpec, emit: Emit, ledger: Ledger): Promise<SDKResultMessage> {
  const seen = new Set<string>();
  let result: SDKResultMessage | undefined;
  for await (const msg of query({
    prompt: spec.prompt,
    options: {
      persistSession: false,
      settingSources: [], // the forge decides everything; ignore user/project settings
      // Never inherit the account's claude.ai MCP connectors (mail, calendar, ...): smiths
      // must not see them, and their tool listings cost ~37k tokens on every call.
      strictMcpConfig: true,
      mcpServers: {},
      ...spec.options,
      abortController: spec.options.abortController ?? ledger.abort,
      model: spec.model,
      pathToClaudeCodeExecutable: ENGINE_PATH,
      stderr: (d) => process.stderr.write(`[engine:${spec.dwarfId}] ${d}`),
    },
  })) {
    if (msg.type === 'assistant' && !msg.parent_tool_use_id) {
      // One API response can arrive as several messages; count its usage once.
      const m = msg.message;
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      const tier = tierOf(m.model);
      const [pin, pout, pcache] = PRICE[tier];
      const input = (m.usage.input_tokens ?? 0) + (m.usage.cache_creation_input_tokens ?? 0);
      const output = m.usage.output_tokens ?? 0;
      const cacheRead = m.usage.cache_read_input_tokens ?? 0;
      emit({
        type: 'usage.tick', dwarfId: spec.dwarfId, model: tier, inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead,
        costUsd: (input * pin + output * pout + cacheRead * pcache) / 1e6,
      });
    } else if (msg.type === 'rate_limit_event') {
      const info = msg.rate_limit_info as typeof msg.rate_limit_info & {
        unifiedWindows?: Record<string, { utilization: number; resetsAt: number }>;
      };
      emit({ type: 'limits', status: info.status, fiveHour: info.unifiedWindows?.five_hour, sevenDay: info.unifiedWindows?.seven_day });
    } else if (msg.type === 'result') {
      result = msg;
      ledger.add(msg, spec.dwarfId);
      emit(ledger.event());
    }
  }
  if (!result) throw new Error(`${spec.dwarfId}: the engine ended without a result`);
  return result;
}
