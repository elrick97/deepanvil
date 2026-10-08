import type { ForgeEvent, LimitWindow, Model, ModelTotals } from '@deepanvil/shared';
import { coinAmount } from './coins.ts';

/** Minimal M0 overlay: title, link status, renderer backend, fps, and an event ticker. */
export class Hud {
  private dot: HTMLElement;
  private backend: HTMLElement;
  private fps: HTMLElement;
  private ticker: HTMLElement;
  private lines: HTMLElement[] = [];
  private soundBtn: HTMLButtonElement;
  /** undefined until the viewer chooses; false once they muted on purpose. */
  soundWanted?: boolean;
  onSoundToggle?: (on: boolean) => void;
  private gauges: HTMLElement;
  private mode = '';
  private limits?: { fiveHour?: LimitWindow; sevenDay?: LimitWindow };
  private spend?: { byModel: Partial<Record<Model, ModelTotals>>; totalUsd: number };

  constructor(root: HTMLElement) {
    root.innerHTML = `
      <div class="hud-card">
        <div class="hud-title">Deepanvil</div>
        <div class="hud-meta">
          <span><span class="dot" data-dot></span><span data-link>kindling…</span></span>
          <span data-backend></span>
          <span data-fps></span>
          <button class="sound-btn" data-sound aria-label="Toggle sound">🔇 sound</button>
        </div>
        <div class="gauges" data-gauges></div>
      </div>
      <div class="hud-card ticker" data-ticker></div>`;
    this.dot = root.querySelector('[data-dot]')!;
    this.backend = root.querySelector('[data-backend]')!;
    this.fps = root.querySelector('[data-fps]')!;
    this.ticker = root.querySelector('[data-ticker]')!;
    this.ticker.style.display = 'none';
    this.gauges = root.querySelector('[data-gauges]')!;
    this.soundBtn = root.querySelector('[data-sound]')!;
    this.soundBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const on = this.soundBtn.dataset.on !== '1';
      this.soundWanted = on;
      this.setSound(on);
      this.onSoundToggle?.(on);
    });
  }

  /** Mode, live subscription windows and the treasury (spend per model tier). */
  gauge(e: ForgeEvent): void {
    if (e.type === 'forge.status') this.mode = e.mode === 'live' ? `⚒ live · ${e.repo.split('/').pop()} · ${e.smiths} smiths` : '🎭 simulator';
    else if (e.type === 'limits') this.limits = { fiveHour: e.fiveHour, sevenDay: e.sevenDay };
    else if (e.type === 'ledger') this.spend = { byModel: e.byModel, totalUsd: e.totalUsd };
    else return;
    this.renderGauges();
  }

  renderGauges(): void {
    const chips: { text: string | (Node | string)[]; cls?: string }[] = [];
    if (this.mode) chips.push({ text: this.mode });
    const win = (label: string, w?: LimitWindow) => {
      if (!w) return;
      const pct = Math.round(w.utilization * 100);
      const left = Math.max(0, w.resetsAt * 1000 - Date.now());
      const h = Math.floor(left / 3_600_000);
      const reset = h >= 24 ? `${Math.round(h / 24)}d` : h > 0 ? `${h}h` : `${Math.ceil(left / 60_000)}m`;
      chips.push({ text: `${label} ${pct}% · resets ${reset}`, cls: pct >= 90 ? 'hot' : pct >= 75 ? 'warn' : undefined });
    };
    win('5h', this.limits?.fiveHour);
    win('7d', this.limits?.sevenDay);
    if (this.spend) {
      // Gold spent this session, then the split per tier: the token min-max at a glance.
      const parts: (Node | string)[] = ['today ', coinAmount(this.spend.totalUsd)];
      for (const m of ['opus', 'sonnet', 'haiku'] as const) {
        const t = this.spend.byModel[m];
        if (!t) continue;
        const tier = coinAmount(t.costUsd, `${m[0]!.toUpperCase()} `);
        tier.classList.add('tier');
        tier.title = `${m}: ${t.calls} calls, ${t.inputTokens + t.cacheReadTokens} in / ${t.outputTokens} out tokens — ${tier.title}`;
        parts.push(tier);
      }
      chips.push({ text: parts });
    }
    this.gauges.replaceChildren(
      ...chips.map((c) => {
        const el = document.createElement('span');
        el.className = `gauge${c.cls ? ` ${c.cls}` : ''}`;
        if (typeof c.text === 'string') el.textContent = c.text;
        else el.append(...c.text);
        return el;
      }),
    );
  }

  setSound(on: boolean): void {
    this.soundBtn.dataset.on = on ? '1' : '0';
    this.soundBtn.textContent = on ? '🔊 sound' : '🔇 sound';
  }

  setLink(connected: boolean): void {
    this.dot.classList.toggle('on', connected);
    this.dot.nextElementSibling!.textContent = connected ? 'forge lit' : 'forge cold';
  }

  setBackend(name: string, tier: string): void {
    this.backend.textContent = `${name} · ${tier}`;
  }

  setFps(fps: number, dpr: number): void {
    this.fps.textContent = `${fps} fps · ${dpr.toFixed(2)}x`;
  }

  log(event: ForgeEvent, names: Map<string, string>): void {
    // Event text will come from real agents (file names, commands): never treat it as HTML.
    const line = document.createElement('div');
    if (event.type === 'usage.tick') {
      line.append(`${names.get(event.dwarfId) ?? event.dwarfId} spends `, coinAmount(event.costUsd), ` · ${fmt(event.inputTokens + event.outputTokens)} tokens (${event.model})`);
    } else {
      const text = describe(event, names);
      if (!text) return;
      line.textContent = text;
      if (event.type === 'forge.error') line.className = 'error';
    }
    this.lines.unshift(line);
    this.lines.length = Math.min(this.lines.length, 4);
    this.ticker.style.display = '';
    this.ticker.replaceChildren(...this.lines);
  }
}

const TOOL_VERBS = { read: 'reads a tome', grep: 'searches the archives', edit: 'hammers the ingot', write: 'forges a new piece', bash: 'works the bellows' };
const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function describe(e: ForgeEvent, names: Map<string, string>): string | null {
  const n = (id: string) => names.get(id) ?? id;
  switch (e.type) {
    case 'tool': return `${n(e.dwarfId)} ${TOOL_VERBS[e.kind]}`;
    case 'test.pass': return `${n(e.dwarfId)} quenches — tests pass ✦`;
    case 'test.fail': return `${n(e.dwarfId)}'s ingot cracks ✗`;
    case 'blueprint.proposed': return `The Forgemaster drafts: ${e.title}`;
    case 'blueprint.approved': return 'The forges are lit!';
    case 'task.assigned': return `${n(e.dwarfId)} takes up “${e.title}”`;
    case 'task.done': return `${n(e.dwarfId)} finishes a piece`;
    case 'permission.request': return `🔔 ${n(e.dwarfId)} asks: ${e.action}`;
    case 'permission.resolved': return `${n(e.dwarfId)} was ${e.approved ? 'granted' : 'refused'}`;
    case 'escalation': return `${n(e.dwarfId)} returns the ingot to the table`;
    case 'haiku.digest': return `Pip carries a note: ${e.note}`;
    case 'merge': return `Merged ${e.branch} — into the minecart!`;
    case 'banter': return null;
    case 'master.say': return `Thráin: ${e.text}`;
    case 'forge.error': return `⚠ ${e.message}`;
    default: return null;
  }
}
