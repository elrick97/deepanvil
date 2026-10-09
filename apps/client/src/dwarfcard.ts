import type { Dwarf, ForgeEvent, LogEntry } from '@deepanvil/shared';
import { coinAmount } from './coins.ts';

// Tap a dwarf: a card with what they're doing now, what it has cost, and their live
// transcript (what the agent said, ran and got back). Everything the agents write is
// untrusted text, so it only ever goes into the DOM through textContent.

interface Sheet {
  dwarf: Dwarf;
  task?: string;
  taskId?: string;
  doing?: string;
  attempts: number;
  usd: number;
  log: LogEntry[];
}

const KEEP = 120;
const ROLE: Record<string, string> = { smith: 'Smith', forgemaster: 'Forgemaster', sprite: 'Sprite', keeper: 'Keeper of main' };
const MODEL: Record<string, string> = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };
const KIND_LABEL: Record<LogEntry['kind'], string> = { say: '💬', tool: '⚒', result: '↳', error: '⚠' };

export class DwarfCard {
  private root: HTMLElement;
  private sheets = new Map<string, Sheet>();
  private shown?: string;
  private body?: HTMLElement;
  private stick = true; // keep the log scrolled to the newest line unless the reader scrolled up
  /** Set by main: follow a dwarf with the camera (id), or stop (undefined). */
  onFollow?: (id: string | undefined) => void;
  private following?: string;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  private sheet(id: string): Sheet | undefined {
    return this.sheets.get(id);
  }

  private push(id: string, entry: LogEntry): void {
    const s = this.sheet(id);
    if (!s) return;
    s.log.push(entry);
    if (s.log.length > KEEP) s.log.shift();
    if (this.shown === id) this.appendLine(entry);
  }

  handle(e: ForgeEvent): void {
    if (e.type === 'hello') {
      for (const d of e.crew) if (!this.sheets.has(d.id)) this.sheets.set(d.id, { dwarf: d, attempts: 0, usd: 0, log: [] });
      return;
    }
    switch (e.type) {
      case 'blueprint.proposed':
        for (const s of this.sheets.values()) Object.assign(s, { task: undefined, taskId: undefined, doing: undefined, attempts: 0, usd: 0, log: [] });
        this.render();
        return;
      case 'task.assigned': {
        const s = this.sheet(e.dwarfId);
        if (s) Object.assign(s, { task: e.title, taskId: e.taskId, doing: undefined, attempts: 0 });
        break;
      }
      case 'task.done': {
        const s = this.sheet(e.dwarfId);
        if (s) Object.assign(s, { doing: 'Piece finished', task: s.task });
        break;
      }
      case 'tool': {
        const s = this.sheet(e.dwarfId);
        if (s) s.doing = `${e.kind}: ${e.summary}`;
        break;
      }
      case 'test.fail': {
        const s = this.sheet(e.dwarfId);
        if (s) s.attempts = Math.max(s.attempts, e.attempt);
        break;
      }
      case 'usage.tick': {
        const s = this.sheet(e.dwarfId);
        if (s) s.usd += e.costUsd;
        break;
      }
      case 'dwarf.log':
        this.push(e.dwarfId, e.entry);
        break;
      case 'master.say':
        this.push('thrain', { at: Date.now(), kind: 'say', text: e.text });
        break;
      case 'odin.say':
        this.push('odin', { at: Date.now(), kind: 'say', text: e.text });
        break;
      case 'banter':
        this.push(e.dwarfId, { at: Date.now(), kind: 'say', text: e.line });
        break;
      case 'haiku.digest': {
        const s = this.sheet(e.toDwarfId);
        if (s) this.push(e.toDwarfId, { at: Date.now(), kind: 'result', text: `📜 Pip: ${e.note}` });
        break;
      }
    }
    if (this.shown) this.refreshHead();
  }

  /** Toggle the card for a dwarf (tapping the same one again closes it). */
  open(id: string | undefined): void {
    if (!id || this.shown === id) return this.close();
    if (!this.sheets.has(id)) return;
    this.shown = id;
    this.stick = true;
    this.render();
  }

  close(): void {
    this.shown = undefined;
    this.root.replaceChildren();
    this.root.hidden = true;
    this.setFollow(undefined);
  }

  private setFollow(id: string | undefined): void {
    this.following = id;
    this.onFollow?.(id);
  }

  /** The camera was moved by hand: stop following. */
  released(): void {
    this.following = undefined;
    this.refreshHead();
  }

  private render(): void {
    const s = this.shown ? this.sheet(this.shown) : undefined;
    if (!s) {
      this.root.replaceChildren();
      this.root.hidden = true;
      return;
    }
    this.root.hidden = false;
    const card = el('div', 'dwarf-card hud-card');
    const head = el('div', 'dwarf-head');
    head.dataset.head = '';
    const close = el('button', 'icon-btn');
    close.textContent = '✕';
    close.title = 'Close';
    close.addEventListener('click', () => this.close());
    const follow = el('button', 'chip');
    follow.dataset.follow = '';
    follow.addEventListener('click', () => {
      this.setFollow(this.following === s.dwarf.id ? undefined : s.dwarf.id);
      this.refreshHead();
    });
    const log = el('div', 'dwarf-log');
    log.addEventListener('scroll', () => (this.stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 24), { passive: true });
    this.body = log;
    card.append(close, head, follow, log);
    this.root.replaceChildren(card);
    for (const entry of s.log) this.appendLine(entry, false);
    this.refreshHead();
    log.scrollTop = log.scrollHeight;
  }

  private refreshHead(): void {
    const s = this.shown ? this.sheet(this.shown) : undefined;
    const head = this.root.querySelector<HTMLElement>('[data-head]');
    const follow = this.root.querySelector<HTMLElement>('[data-follow]');
    if (!s || !head) return;
    const rows = el('div', 'dwarf-rows');
    const name = el('div', 'dwarf-name');
    name.textContent = s.dwarf.name;
    const sub = el('div', 'dwarf-sub');
    sub.textContent = `${ROLE[s.dwarf.role] ?? s.dwarf.role} · ${MODEL[s.dwarf.model] ?? s.dwarf.model}`;
    rows.append(name, sub);
    if (s.task) rows.append(line('Task', s.task));
    if (s.doing) rows.append(line('Now', s.doing));
    if (s.attempts) rows.append(line('Cracked', `${s.attempts} time${s.attempts === 1 ? '' : 's'}`));
    const spend = el('div', 'dwarf-line');
    const label = el('span', 'dwarf-k');
    label.textContent = 'Spent';
    spend.append(label, coinAmount(s.usd));
    rows.append(spend);
    head.replaceChildren(rows);
    if (follow) follow.textContent = this.following === s.dwarf.id ? '◉ Following' : '○ Follow';
  }

  private appendLine(entry: LogEntry, scroll = true): void {
    const log = this.body;
    if (!log) return;
    const row = el('div', `log-line log-${entry.kind}`);
    const icon = el('span', 'log-ico');
    icon.textContent = KIND_LABEL[entry.kind];
    const text = el('span', 'log-text');
    text.textContent = entry.text;
    row.append(icon, text);
    log.append(row);
    while (log.childElementCount > KEEP) log.firstElementChild?.remove();
    if (scroll && this.stick) log.scrollTop = log.scrollHeight;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}

function line(k: string, v: string): HTMLElement {
  const row = el('div', 'dwarf-line');
  const key = el('span', 'dwarf-k');
  key.textContent = k;
  const val = el('span', 'dwarf-v');
  val.textContent = v;
  row.append(key, val);
  return row;
}
