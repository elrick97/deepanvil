import type { ClientCommand, ForgeEvent, Model, QuestDetail, QuestSummary } from '@deepanvil/shared';
import { coinAmount } from './coins.ts';

// The quest history: every past quest with its outcome and cost (tap one to open it: what was
// asked, what each task became and who forged it, what Odin made of each piece, what it cost per
// tier). Titles, requests and summaries came from agents, so they only go in via textContent.

type Send = (cmd: ClientCommand) => boolean;

const STATUS: Record<string, { icon: string; label: string }> = {
  done: { icon: '✦', label: 'merged' },
  failed: { icon: '✗', label: 'failed' },
  interrupted: { icon: '⏹', label: 'stopped' },
  rejected: { icon: '✕', label: 'discarded' },
  forging: { icon: '⚒', label: 'forging' },
  proposed: { icon: '✎', label: 'awaiting approval' },
  drafting: { icon: '✎', label: 'drafting' },
};
const TIER: Record<Model, string> = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };
const OFFERING: Record<string, string> = { merged: 'merged', sent_back: 'sent back', abandoned: 'abandoned', awaiting_you: 'waited for you', queued: 'queued', rebasing: 'rebasing', gates: 'at the gates', reviewing: 'in review' };

export class HistoryPanel {
  private root: HTMLElement;
  private send: Send;
  private names: Map<string, string>;
  private quests: QuestSummary[] = [];
  private details = new Map<string, QuestDetail>();
  private open = new Set<string>();
  private visible = false;

  constructor(root: HTMLElement, send: Send, names: Map<string, string>) {
    this.root = root;
    this.send = send;
    this.names = names;
  }

  handle(e: ForgeEvent): void {
    if (e.type === 'history') {
      this.quests = e.quests;
      // A quest's numbers may have changed (it just finished): drop cached details so the next look is fresh.
      this.details.clear();
      for (const id of this.open) this.send({ type: 'history.open', questId: id });
    } else if (e.type === 'quest.detail') {
      this.details.set(e.detail.id, e.detail);
    } else return;
    if (this.visible) this.render();
  }

  toggle(): void {
    this.visible = !this.visible;
    if (!this.visible) {
      this.root.hidden = true;
      this.root.replaceChildren();
      return;
    }
    this.render();
  }

  private render(): void {
    const panel = el('div', 'history hud-card');
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', 'Quest history');

    const head = el('div', 'hist-head');
    const title = el('div', 'hist-title');
    title.textContent = 'Quest history';
    const close = el('button', 'icon-btn');
    close.type = 'button';
    close.textContent = '✕';
    close.title = 'Close';
    close.setAttribute('aria-label', 'Close the quest history');
    close.addEventListener('click', () => this.toggle());
    head.append(title, close);

    const list = el('div', 'hist-list');
    if (!this.quests.length) {
      const empty = el('div', 'hist-empty');
      empty.textContent = 'No quests yet. Ask Thráin for one.';
      list.append(empty);
    }
    for (const q of this.quests) list.append(this.quest(q));
    panel.append(head, list);
    this.root.replaceChildren(panel);
    this.root.hidden = false;
  }

  private quest(q: QuestSummary): HTMLElement {
    const box = el('details', 'hist-q');
    box.open = this.open.has(q.id);
    box.addEventListener('toggle', () => {
      if (box.open) {
        this.open.add(q.id);
        if (!box.querySelector('.hist-detail')) box.append(this.detail(q.id));
        if (!this.details.has(q.id)) this.send({ type: 'history.open', questId: q.id });
      } else this.open.delete(q.id);
    });
    const st = STATUS[q.status] ?? { icon: '·', label: q.status };
    const sum = el('summary', `hist-sum hist-${q.status}`);
    const icon = el('span', 'hist-ico');
    icon.textContent = st.icon;
    icon.title = st.label;
    const name = el('span', 'hist-name');
    name.textContent = q.title;
    const meta = el('span', 'hist-meta');
    meta.append(when(q.createdAt), ` · ${st.label}`);
    if (q.merged || q.failed) meta.append(` · ${q.merged} merged${q.failed ? `, ${q.failed} failed` : ''}`);
    meta.append(' · ', coinAmount(q.costUsd));
    const words = el('span', 'hist-words');
    words.append(name, meta);
    sum.append(icon, words);
    box.append(sum);
    if (box.open) box.append(this.detail(q.id));
    return box;
  }

  private detail(id: string): HTMLElement {
    const body = el('div', 'hist-detail');
    const d = this.details.get(id);
    if (!d) {
      body.textContent = 'Opening the ledger…';
      return body;
    }
    const ask = el('div', 'hist-ask');
    ask.textContent = d.request;
    body.append(ask);

    const tiers = (Object.keys(d.spend) as Model[]).filter((m) => d.spend[m]);
    if (tiers.length) {
      const spend = el('div', 'hist-spend');
      for (const m of tiers) {
        const t = d.spend[m]!;
        const chip = coinAmount(t.costUsd, `${TIER[m]} `);
        chip.title = `${t.calls} call${t.calls === 1 ? '' : 's'} — ${chip.title}`;
        spend.append(chip);
      }
      body.append(spend);
    }

    for (const t of d.tasks) {
      const row = el('div', 'hist-task');
      const line = el('div', 'hist-task-line');
      const state = el('span', `hist-state hist-${t.status}`);
      state.textContent = t.status === 'merged' ? '✦' : t.status === 'failed' ? '✗' : t.status === 'replaced' ? '↻' : '⚒';
      state.title = t.status;
      const text = el('span', '');
      text.textContent = `${t.title} — ${this.names.get(t.dwarfId) ?? t.dwarfId}${t.attempts > 1 ? ` · ${t.attempts} tries` : ''}`;
      line.append(state, text);
      row.append(line);
      if (t.summary) {
        const sum = el('div', 'hist-note');
        sum.textContent = t.summary;
        row.append(sum);
      }
      for (const o of d.offerings.filter((x) => x.taskId === t.id)) {
        const od = el('div', 'hist-note');
        od.textContent = `⚖ revision ${o.revision}: ${OFFERING[o.state] ?? o.state}${o.reason ? ` (${o.reason})` : ''}${o.lines ? ` · ${o.lines} lines` : ''}${o.review ? ` — Odin: ${o.review.summary}` : ''}`;
        row.append(od);
      }
      body.append(row);
    }
    return body;
  }
}

function when(at: number): string {
  const secs = (at - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, size] of [['day', 86_400], ['hour', 3_600], ['minute', 60]] as const) {
    if (Math.abs(secs) >= size) return rtf.format(Math.round(secs / size), unit);
  }
  return 'just now';
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
