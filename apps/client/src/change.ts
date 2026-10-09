import type { BlueprintTaskView, ClientCommand, ForgeEvent } from '@deepanvil/shared';

// A change of plan that needs your yes: a smith flagged their task as blocked and Thráin's fix
// adds work (more new tasks than the ones it replaces). The card shows why, and the diff:
// ＋ new tasks, ～ changed, － dropped. Only that smith waits; the others keep working.
// All text comes from a model, so it only ever goes in through textContent.

type Send = (cmd: ClientCommand) => boolean;

interface Proposal {
  changeId: string;
  source: 'blocked' | 'rescope';
  /** Task ids in progress that this change would stop. */
  stopping: string[];
  reason: string;
  added: BlueprintTaskView[];
  changed: BlueprintTaskView[];
  dropped: { id: string; title: string }[];
}

export class ChangeCard {
  private root: HTMLElement;
  private send: Send;
  private shown?: Proposal;

  constructor(root: HTMLElement, send: Send) {
    this.root = root;
    this.send = send;
  }

  handle(e: ForgeEvent): void {
    switch (e.type) {
      case 'plan.amended':
        if (e.state === 'proposed') this.show({ changeId: e.changeId, source: e.source ?? 'blocked', stopping: e.stopping ?? [], reason: e.reason, added: e.added, changed: e.changed, dropped: e.dropped });
        else if (this.shown?.changeId === e.changeId) this.hide();
        break;
      case 'forge.status':
        if (!e.busy) this.hide();
        break;
    }
  }

  private hide(): void {
    this.shown = undefined;
    this.root.hidden = true;
    this.root.replaceChildren();
  }

  private show(p: Proposal): void {
    this.shown = p;
    const card = el('div', 'change hud-card');
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', 'Thráin proposes a change of plan');

    const head = el('div', 'change-head');
    const label = el('div', 'change-label');
    label.textContent = p.source === 'rescope' ? 'You asked to change the plan · Thráin proposes a re-cut' : 'A smith is blocked · Thráin proposes a change of plan';
    const why = el('div', 'change-why');
    why.textContent = p.reason;
    head.append(label, why);

    const diff = el('div', 'change-diff');
    for (const t of p.added) diff.append(row('＋', 'add', t.title, t.brief));
    for (const t of p.changed) diff.append(row('～', 'chg', t.title, t.brief));
    for (const d of p.dropped) diff.append(row('－', 'del', d.title, p.stopping.includes(d.id) ? 'in progress: this smith would be stopped and the work so far discarded' : undefined));

    const note = el('div', 'change-note');
    note.textContent =
      p.source === 'rescope'
        ? 'Nothing already merged or with Odin is touched. Say no and the plan stays as it is.'
        : 'This adds work beyond what the blocked task covered, so it needs your word. The other smiths carry on meanwhile.';

    const actions = el('div', 'change-actions');
    const keep = el('button', 'btn');
    keep.type = 'button';
    keep.textContent = p.source === 'rescope' ? 'Keep the plan' : 'Keep the original plan';
    keep.addEventListener('click', () => this.answer(p, false));
    const go = el('button', 'btn btn-primary');
    go.type = 'button';
    go.textContent = p.source === 'rescope' ? 'Re-cut it' : 'Go ahead';
    go.addEventListener('click', () => this.answer(p, true));
    actions.append(keep, go);

    card.append(head, diff, note, actions);
    this.root.replaceChildren(card);
    this.root.hidden = false;
  }

  private answer(p: Proposal, approve: boolean): void {
    if (this.send({ type: 'plan.change', changeId: p.changeId, approve })) this.hide();
  }
}

function row(sign: string, cls: string, title: string, detail?: string): HTMLElement {
  const r = el('div', `change-row change-${cls}`);
  const s = el('span', 'change-sign');
  s.textContent = sign;
  const words = el('span', 'change-words');
  const t = el('span', 'change-title');
  t.textContent = title;
  words.append(t);
  if (detail) {
    const d = el('span', 'change-detail');
    d.textContent = detail;
    words.append(d);
  }
  r.append(s, words);
  return r;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
