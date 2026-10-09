import type { BlueprintTaskView, ClientCommand, ForgeEvent } from '@deepanvil/shared';

// Thráin's blueprint as a card: the summary, each task with its brief, context-pack files and
// acceptance check (tap to expand), a ✕ to drop a task, "Ask for changes" to have him redraw
// it in the same conversation, and "Light the forges". All text comes from a model, so it
// only ever goes in through textContent.

type Send = (cmd: ClientCommand) => boolean;

interface View {
  questId: string;
  title: string;
  summary?: string;
  revision: number;
  tasks: BlueprintTaskView[];
}

export class BlueprintCard {
  private root: HTMLElement;
  private send: Send;
  private view?: View;
  private live = false;
  private revising = false;
  private open = new Set<string>(); // task ids whose details are expanded
  private asking = false;           // the "ask for changes" line is showing

  constructor(root: HTMLElement, send: Send) {
    this.root = root;
    this.send = send;
  }

  handle(e: ForgeEvent): void {
    switch (e.type) {
      case 'forge.status':
        this.live = e.mode === 'live';
        if (!e.busy) this.hide(); // nothing is waiting any more
        break;
      case 'blueprint.proposed':
      case 'blueprint.revised':
        if (!this.live) break;
        if (e.type === 'blueprint.proposed' || e.questId !== this.view?.questId) {
          this.open.clear();
          this.asking = false;
        }
        this.view = { questId: e.questId, title: e.title, summary: e.summary, revision: e.revision ?? 0, tasks: e.tasks };
        this.revising = false;
        this.render();
        break;
      case 'blueprint.revising':
        if (!this.view || this.view.questId !== e.questId) break;
        this.revising = true;
        this.asking = false;
        this.render();
        break;
      case 'blueprint.approved':
      case 'blueprint.rejected':
        this.hide();
        break;
    }
  }

  private hide(): void {
    this.view = undefined;
    this.revising = false;
    this.asking = false;
    this.open.clear();
    this.root.hidden = true;
    this.root.replaceChildren();
  }

  private render(): void {
    const v = this.view;
    if (!v) return;
    const card = el('div', 'blueprint hud-card');
    card.setAttribute('aria-label', 'Thráin’s blueprint');
    card.setAttribute('aria-busy', String(this.revising));

    const head = el('div', 'bp-head');
    const label = el('div', 'bp-label');
    label.textContent = v.revision ? `Thráin’s blueprint · redrawn ${v.revision}×` : 'Thráin’s blueprint';
    const title = el('div', 'bp-title');
    title.textContent = v.title;
    head.append(label, title);
    if (v.summary) {
      const sum = el('div', 'bp-summary');
      sum.textContent = v.summary;
      head.append(sum);
    }

    const list = el('div', 'bp-tasks');
    for (const t of v.tasks) list.append(this.task(v, t));

    const actions = el('div', 'bp-actions');
    if (this.revising) {
      const wait = el('div', 'bp-wait');
      wait.textContent = '✎ Thráin is redrawing…';
      actions.append(wait);
    } else {
      const discard = button('Discard', 'btn', () => this.send({ type: 'blueprint.reject', questId: v.questId }));
      const change = button(this.asking ? 'Never mind' : '✎ Ask for changes', 'btn', () => {
        this.asking = !this.asking;
        this.render();
      });
      const go = button('🔥 Light the forges', 'btn btn-primary', () => this.send({ type: 'blueprint.approve', questId: v.questId }));
      actions.append(discard, change, go);
    }

    card.append(head, list);
    if (this.asking && !this.revising) card.append(this.changeLine(v));
    card.append(actions);
    this.root.replaceChildren(card);
    this.root.hidden = false;
    if (this.asking) card.querySelector<HTMLInputElement>('.bp-change input')?.focus();
  }

  private task(v: View, t: BlueprintTaskView): HTMLElement {
    const box = el('details', 'bp-task');
    box.open = this.open.has(t.id);
    box.addEventListener('toggle', () => (box.open ? this.open.add(t.id) : this.open.delete(t.id)));
    const sum = el('summary', 'bp-task-head');
    const name = el('span', 'bp-task-title');
    name.textContent = t.title;
    sum.append(name);
    if (v.tasks.length > 1 && !this.revising) {
      const drop = button('✕', 'bp-drop', () => this.send({ type: 'blueprint.drop', questId: v.questId, taskId: t.id }));
      drop.title = 'Take this task out of the plan';
      drop.setAttribute('aria-label', `Drop task: ${t.title}`);
      // The button sits inside <summary>: don't let its click also toggle the details.
      drop.addEventListener('click', (ev) => ev.preventDefault());
      sum.append(drop);
    }
    box.append(sum);
    if (t.brief) box.append(line('What', t.brief));
    if (t.files?.length) {
      const files = el('div', 'bp-files');
      const k = el('span', 'bp-k');
      k.textContent = 'Files';
      files.append(k);
      for (const f of t.files) {
        const row = el('div', 'bp-file');
        const path = el('code', '');
        path.textContent = f.path;
        const why = el('span', 'bp-why');
        why.textContent = ` — ${f.why}`;
        row.append(path, why);
        files.append(row);
      }
      box.append(files);
    }
    if (t.acceptance) {
      const row = line('Check', '');
      const code = el('code', '');
      code.textContent = t.acceptance;
      row.append(code);
      box.append(row);
    }
    return box;
  }

  private changeLine(v: View): HTMLElement {
    const form = el('form', 'bp-change');
    const input = el('input', '');
    input.type = 'text';
    input.maxLength = 2000;
    input.placeholder = 'What should change? e.g. “split task 2” or “also cover logging”';
    input.setAttribute('aria-label', 'What should Thráin change in the blueprint?');
    const send = el('button', 'btn btn-primary');
    send.type = 'submit';
    send.textContent = 'Redraw';
    form.append(input, send);
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const note = input.value.trim();
      if (!note) return;
      if (this.send({ type: 'blueprint.revise', questId: v.questId, note })) {
        this.revising = true;
        this.asking = false;
        this.render();
      }
    });
    return form;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function button(text: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', cls);
  b.type = 'button';
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

function line(k: string, v: string): HTMLElement {
  const row = el('div', 'bp-line');
  const key = el('span', 'bp-k');
  key.textContent = k;
  row.append(key);
  if (v) {
    const val = el('span', 'bp-v');
    val.textContent = v;
    row.append(val);
  }
  return row;
}
