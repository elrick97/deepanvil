import * as THREE from 'three/webgpu';
import type { ForgeEvent, ToolKind } from '@deepanvil/shared';

// A slate in front of each anvil: what that smith is doing right now (the command, the
// file), turning green or red when the tests answer, and fading when they go quiet.
// HTML projected from a world point, like the speech bubbles, so it stays crisp on a phone.
// The text is whatever the agent ran: untrusted, so only ever textContent.

const ICON: Record<ToolKind, string> = { read: '📖', grep: '🔍', edit: '🔨', write: '✍', bash: '$' };
const SHOW = 7;    // seconds a plain action stays up
const VERDICT = 4; // seconds a test result stays up
const WIDTH = 34;  // characters before we clip

interface Slate {
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
    const el = document.createElement('div');
    el.className = 'slate';
    const icon = document.createElement('span');
    icon.className = 'slate-ico';
    const text = document.createElement('span');
    text.className = 'slate-text';
    el.append(icon, text);
    this.root.append(el);
    s = { el, icon, text, anchor, until: 0, state: 'run' };
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

  handle(e: ForgeEvent): void {
    switch (e.type) {
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
      case 'task.assigned':
      case 'task.done':
        if ('dwarfId' in e) this.slates.get(e.dwarfId)?.el.classList.remove('in');
        return;
      case 'blueprint.proposed':
        for (const s of this.slates.values()) s.el.classList.remove('in');
        return;
    }
  }

  update(t: number): void {
    this.now = t;
    const w = this.root.clientWidth;
    const h = this.root.clientHeight;
    for (const s of this.slates.values()) {
      if (t > s.until) s.el.classList.remove('in');
      if (!s.el.classList.contains('in')) {
        s.el.style.visibility = 'hidden';
        continue;
      }
      this.v.copy(s.anchor).project(this.camera);
      const behind = this.v.z > 1;
      s.el.style.visibility = behind ? 'hidden' : 'visible';
      const half = s.el.offsetWidth / 2 + 6;
      const x = Math.min(w - half, Math.max(half, (this.v.x * 0.5 + 0.5) * w));
      const y = Math.min(h - s.el.offsetHeight - 8, Math.max(8, (-this.v.y * 0.5 + 0.5) * h));
      s.el.style.transform = `translate(-50%, 0) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    }
  }
}
