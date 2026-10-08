import type { ClientCommand, Finding, ForgeEvent, GateName, GateStatus } from '@deepanvil/shared';

// Offering cards: when Odin has judged a piece worthy but the repo is in "approve" mode (or a
// protected path is touched), the card waits for your verdict — gates, Odin's review, the diff,
// and Merge / Send back. Agent text (diffs, notes) is only ever rendered with textContent.

type Send = (cmd: ClientCommand) => boolean;

interface Card {
  id: string;
  title: string;
  dwarfId: string;
  revision: number;
  lines: number;
  gates: Partial<Record<GateName, GateStatus>>;
  summary?: string;
  findings: Finding[];
  reason?: string;
}

const GATE_ICON: Record<GateStatus, string> = { running: '…', pass: '✓', fail: '✗', flaky: '~', skipped: '–' };

export class OfferingCards {
  private root: HTMLElement;
  private send: Send;
  private names: Map<string, string>;
  private cards = new Map<string, Card>();
  private waiting = new Set<string>();
  private modal?: HTMLElement;

  constructor(root: HTMLElement, send: Send, names: Map<string, string>) {
    this.root = root;
    this.send = send;
    this.names = names;
  }

  handle(e: ForgeEvent): void {
    switch (e.type) {
      case 'offering.opened': {
        const c = this.cards.get(e.offeringId) ?? { id: e.offeringId, title: e.title, dwarfId: e.dwarfId, revision: e.revision, lines: e.lines, gates: {}, findings: [] };
        if (c.revision !== e.revision) Object.assign(c, { gates: {}, summary: undefined, findings: [] }); // a fresh revision starts clean
        Object.assign(c, { revision: e.revision, lines: e.lines || c.lines });
        this.cards.set(e.offeringId, c);
        break;
      }
      case 'offering.gate': {
        const c = this.cards.get(e.offeringId);
        if (c) c.gates[e.gate] = e.status;
        break;
      }
      case 'offering.review': {
        const c = this.cards.get(e.offeringId);
        if (c) Object.assign(c, { summary: e.summary, findings: e.findings });
        break;
      }
      case 'offering.state':
        if (e.state === 'awaiting_you') {
          this.waiting.add(e.offeringId);
          const c = this.cards.get(e.offeringId);
          if (c) c.reason = e.reason;
        } else this.waiting.delete(e.offeringId);
        break;
      case 'offering.diff':
        this.showDiff(e.offeringId, e.diff);
        return;
      default:
        return;
    }
    this.render();
  }

  private el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
    const n = document.createElement(tag);
    n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  private render(): void {
    this.root.replaceChildren(
      ...[...this.waiting].map((id) => {
        const c = this.cards.get(id);
        if (!c) return document.createTextNode('');
        const card = this.el('div', 'offering hud-card');
        card.append(
          this.el('div', 'offering-head', `⚖ ${c.title}`),
          this.el('div', 'offering-meta', `${this.names.get(c.dwarfId) ?? c.dwarfId} · revision ${c.revision} · ${c.lines} lines${c.reason ? ` · ${c.reason}` : ''}`),
        );
        const gates = this.el('div', 'offering-gates');
        for (const g of ['tests', 'types', 'lint'] as GateName[]) {
          const st = c.gates[g] ?? 'skipped';
          gates.append(this.el('span', `chip gate-${st}`, `${GATE_ICON[st]} ${g}`));
        }
        card.append(gates);
        if (c.summary) card.append(this.el('div', 'offering-summary', `Odin: ${c.summary}`));
        for (const f of c.findings.slice(0, 4)) {
          card.append(this.el('div', 'offering-finding', `${f.severity} · ${f.file}${f.line ? `:${f.line}` : ''} — ${f.note}`));
        }
        const actions = this.el('div', 'offering-actions');
        const diff = this.el('button', 'btn', 'View diff');
        diff.addEventListener('click', () => this.send({ type: 'offering.diff', offeringId: id }));
        const back = this.el('button', 'btn', 'Send back');
        back.addEventListener('click', () => {
          const note = prompt('What should change? (optional)') ?? undefined;
          this.send({ type: 'offering.send_back', offeringId: id, note });
          this.waiting.delete(id);
          this.render();
        });
        const merge = this.el('button', 'btn btn-primary', 'Merge into main');
        merge.addEventListener('click', () => {
          this.send({ type: 'offering.merge', offeringId: id });
          this.waiting.delete(id);
          this.render();
        });
        actions.append(diff, back, merge);
        card.append(actions);
        return card;
      }),
    );
  }

  /** A full-screen, scrollable unified diff (one line per row, coloured by +/-). */
  private showDiff(id: string, diff: string): void {
    this.modal?.remove();
    const modal = this.el('div', 'diff-modal');
    const head = this.el('div', 'diff-head', `Diff · ${this.cards.get(id)?.title ?? id}`);
    const close = this.el('button', 'btn', 'Close');
    close.addEventListener('click', () => modal.remove());
    head.append(close);
    const body = this.el('pre', 'diff-body');
    for (const line of diff.split('\n')) {
      const cls = line.startsWith('+++') || line.startsWith('---') ? 'd-file' : line.startsWith('+') ? 'd-add' : line.startsWith('-') ? 'd-del' : line.startsWith('@@') ? 'd-hunk' : line.startsWith('diff ') ? 'd-file' : '';
      body.append(this.el('div', cls, line || ' '));
    }
    modal.append(head, body);
    document.body.append(modal);
    this.modal = modal;
  }
}
