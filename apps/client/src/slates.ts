import * as THREE from 'three/webgpu';
import type { ForgeEvent, TodoItem, ToolKind } from '@deepanvil/shared';

// A slate in front of each anvil: what that smith is doing right now (the command, the
// file), turning green or red when the tests answer, and fading when they go quiet.
// Under it hangs a small chalkboard with the smith's own to-do list while they have one.
// HTML projected from a world point, like the speech bubbles, so it stays crisp on a phone.
// The text is whatever the agent ran: untrusted, so only ever textContent.

const ICON: Record<ToolKind, string> = { read: '📖', grep: '🔍', edit: '🔨', write: '✍', bash: '$' };
const SHOW = 7;    // seconds a plain action stays up
const VERDICT = 4; // seconds a test result stays up
const WIDTH = 34;  // characters before we clip
const CHALK_ROWS = 6;
const MARK: Record<TodoItem['status'], string> = { pending: '☐', in_progress: '▶', completed: '✓' };

interface Slate {
  stack: HTMLElement;
  chalk: HTMLElement;
  hasTodos: boolean;
  el: HTMLElement;
  icon: HTMLElement;
  text: HTMLElement;
  anchor: THREE.Vector3;
  until: number;
  state: 'run' | 'pass' | 'fail';
}

/** A path or command shortened to its most telling end. */
function clip(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim();
  if (one.length <= WIDTH) return one;
  // Paths read best from the right (the file name); commands from the left.
  return /^[\w.-]*\/|^\//.test(one) && !one.includes(' ') ? `…${one.slice(-(WIDTH - 1))}` : `${one.slice(0, WIDTH - 1)}…`;
}

export class Slates {
  private root: HTMLElement;
  private camera: THREE.Camera;
  private slates = new Map<string, Slate>();
  private where: (dwarfId: string) => THREE.Vector3 | undefined;
  private now = 0;
  private v = new THREE.Vector3();

  /** `where` gives the floor point in front of a smith's anvil (undefined: no anvil, no slate). */
  constructor(root: HTMLElement, camera: THREE.Camera, where: (dwarfId: string) => THREE.Vector3 | undefined) {
    this.root = root;
    this.camera = camera;
    this.where = where;
  }

  private slate(id: string): Slate | undefined {
    let s = this.slates.get(id);
    if (s) return s;
    const anchor = this.where(id);
    if (!anchor) return undefined;
    const stack = document.createElement('div');
    stack.className = 'slate-stack';
    const el = document.createElement('div');
    el.className = 'slate';
    const chalk = document.createElement('div');
    chalk.className = 'chalk';
    chalk.hidden = true;
    const icon = document.createElement('span');
    icon.className = 'slate-ico';
    const text = document.createElement('span');
    text.className = 'slate-text';
    el.append(icon, text);
    stack.append(el, chalk);
    this.root.append(stack);
    s = { stack, chalk, hasTodos: false, el, icon, text, anchor, until: 0, state: 'run' };
    this.slates.set(id, s);
    return s;
  }

  private show(id: string, icon: string, text: string, state: Slate['state'], seconds: number): void {
    const s = this.slate(id);
    if (!s) return;
    s.icon.textContent = icon;
    s.text.textContent = text;
    s.state = state;
    s.until = this.now + seconds;
    s.el.dataset.state = state;
    s.el.classList.add('in');
  }

  private setTodos(id: string, items: TodoItem[]): void {
    const s = this.slate(id);
    if (!s) return;
    s.hasTodos = items.length > 0;
    s.chalk.hidden = !s.hasTodos;
    const rows = items.slice(0, CHALK_ROWS).map((t) => {
      const row = document.createElement('div');
      row.className = `chalk-row chalk-${t.status}`;
      row.textContent = `${MARK[t.status]} ${clip(t.text)}`;
      return row;
    });
    if (items.length > CHALK_ROWS) {
      const more = document.createElement('div');
      more.className = 'chalk-row chalk-more';
      more.textContent = `… ${items.length - CHALK_ROWS} more`;
      rows.push(more);
    }
    s.chalk.replaceChildren(...rows);
  }

  handle(e: ForgeEvent): void {
    switch (e.type) {
      case 'dwarf.todos':
        this.setTodos(e.dwarfId, e.items);
        return;
      case 'tool':
        this.show(e.dwarfId, ICON[e.kind], clip(e.summary), 'run', SHOW);
        return;
      case 'test.pass':
        this.show(e.dwarfId, '✓', 'tests pass', 'pass', VERDICT);
        return;
      case 'test.fail':
        this.show(e.dwarfId, '✗', e.attempt > 1 ? `tests fail (try ${e.attempt})` : 'tests fail', 'fail', VERDICT);
        return;
      case 'permission.request':
        this.show(e.dwarfId, '🔔', clip(e.action), 'run', 60);
        return;
      case 'permission.resolved':
        this.slates.get(e.dwarfId)?.el.classList.remove('in');
        return;
      case 'task.assigned':
      case 'task.done':
        this.slates.get(e.dwarfId)?.el.classList.remove('in');
        this.setTodos(e.dwarfId, []); // a new piece starts with a clean board
        return;
      case 'blueprint.proposed':
        for (const [id, s] of this.slates) {
          s.el.classList.remove('in');
          this.setTodos(id, []);
        }
        return;
    }
  }

  update(t: number): void {
    this.now = t;
    const w = this.root.clientWidth;
    const h = this.root.clientHeight;
    for (const s of this.slates.values()) {
      if (t > s.until) s.el.classList.remove('in');
      const slateUp = s.el.classList.contains('in');
      s.el.style.visibility = slateUp ? 'visible' : 'hidden'; // keeps its height, so the chalkboard doesn't jump
      if (!slateUp && !s.hasTodos) {
        s.stack.style.visibility = 'hidden';
        continue;
      }
      this.v.copy(s.anchor).project(this.camera);
      const behind = this.v.z > 1;
      s.stack.style.visibility = behind ? 'hidden' : 'visible';
      const half = s.stack.offsetWidth / 2 + 6;
      const x = Math.min(w - half, Math.max(half, (this.v.x * 0.5 + 0.5) * w));
      const y = Math.min(h - s.stack.offsetHeight - 8, Math.max(8, (-this.v.y * 0.5 + 0.5) * h));
      s.stack.style.transform = `translate(-50%, 0) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    }
  }
}
