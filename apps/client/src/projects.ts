import type { ClientCommand, ForgeEvent, ProjectInfo } from '@deepanvil/shared';

// The project picker (the "live · <project>" chip in the HUD): the repositories the forge knows,
// switch between them, add one by its path (as WSL sees it) or clone an https:// repository.
// Switching is only possible while no quest runs; the forge says why when it refuses.
// Names and paths come from the file system, so they only go in via textContent.

type Send = (cmd: ClientCommand) => boolean;

export class ProjectPicker {
  private root: HTMLElement;
  private send: Send;
  private projects: ProjectInfo[] = [];
  private busy = false;
  private visible = false;

  constructor(root: HTMLElement, send: Send) {
    this.root = root;
    this.send = send;
  }

  handle(e: ForgeEvent): void {
    if (e.type === 'projects') this.projects = e.projects;
    else if (e.type === 'forge.status') this.busy = e.busy && e.mode === 'live';
    else return;
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
    // Keep what you were typing across the re-renders that follow events.
    const keep = [...this.root.querySelectorAll<HTMLInputElement>('input')].map((i) => i.value);
    const hadFocus = this.root.querySelector<HTMLInputElement>('input:focus')?.dataset.field;

    const panel = el('div', 'projects hud-card');
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', 'Projects');

    const head = el('div', 'pj-head');
    const title = el('div', 'pj-title');
    title.textContent = 'Projects';
    const close = el('button', 'icon-btn');
    close.type = 'button';
    close.textContent = '✕';
    close.title = 'Close';
    close.setAttribute('aria-label', 'Close the project list');
    close.addEventListener('click', () => this.toggle());
    head.append(title, close);

    const list = el('div', 'pj-list');
    if (!this.projects.length) {
      const none = el('div', 'pj-note');
      none.textContent = 'No projects yet.';
      list.append(none);
    }
    for (const p of this.projects) list.append(this.row(p));

    const note = el('div', 'pj-note');
    note.textContent = this.busy ? 'A quest is running: you can add projects now, and switch when it is done.' : 'Each project keeps its own history, vault and merge rules.';

    panel.append(head, list, note, this.add('path', 'Add a repository by path', '/home/you/my-project', 'Add', (v) => this.send({ type: 'project.add', path: v })), this.add('url', 'Clone from a URL', 'https://github.com/owner/repo', 'Clone', (v) => this.send({ type: 'project.clone', url: v })));
    this.root.replaceChildren(panel);
    this.root.hidden = false;
    const inputs = panel.querySelectorAll<HTMLInputElement>('input');
    keep.forEach((v, i) => inputs[i] && (inputs[i]!.value = v));
    if (hadFocus) panel.querySelector<HTMLInputElement>(`input[data-field="${hadFocus}"]`)?.focus();
  }

  private row(p: ProjectInfo): HTMLElement {
    const row = el('div', `pj-row${p.active ? ' pj-active' : ''}`);
    const ico = el('span', 'pj-ico');
    ico.textContent = p.active ? '◉' : '○';
    const words = el('span', 'pj-words');
    const name = el('span', 'pj-name');
    name.textContent = p.name + (p.sandbox ? ' · practice sandbox' : '');
    const path = el('span', 'pj-path');
    path.textContent = p.path;
    path.title = p.path;
    const meta = el('span', 'pj-meta');
    meta.textContent = `${p.quests} quest${p.quests === 1 ? '' : 's'}${p.active ? ' · working here' : ''}`;
    words.append(name, path, meta);
    row.append(ico, words);
    if (!p.active) {
      const go = el('button', 'btn');
      go.type = 'button';
      go.textContent = 'Switch';
      go.disabled = this.busy;
      go.addEventListener('click', () => this.send({ type: 'project.switch', path: p.path }));
      const drop = el('button', 'pj-forget');
      drop.type = 'button';
      drop.textContent = '✕';
      drop.title = 'Take it off the list (its files are not touched)';
      drop.setAttribute('aria-label', `Forget ${p.name}`);
      drop.addEventListener('click', () => this.send({ type: 'project.forget', path: p.path }));
      row.append(go, drop);
    }
    return row;
  }

  private add(field: string, label: string, placeholder: string, button: string, submit: (value: string) => boolean): HTMLElement {
    const form = el('form', 'pj-add');
    const input = el('input', '');
    input.type = 'text';
    input.dataset.field = field;
    input.placeholder = placeholder;
    input.maxLength = 500;
    input.autocomplete = 'off';
    input.setAttribute('aria-label', label);
    const go = el('button', 'btn btn-primary');
    go.type = 'submit';
    go.textContent = button;
    form.append(input, go);
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const v = input.value.trim();
      if (v && submit(v)) input.value = '';
    });
    return form;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
