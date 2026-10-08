import * as THREE from 'three/webgpu';

// Parchment speech bubbles that float above a dwarf's head. HTML (not 3D text) so they
// stay crisp and readable on a phone; positioned by projecting a world point each frame.

export type BubbleKind = 'talk' | 'ask' | 'note';

interface Bubble {
  el: HTMLElement;
  anchor: () => THREE.Vector3;
  until: number;
  key?: string;
}

export class Bubbles {
  private root: HTMLElement;
  private camera: THREE.Camera;
  private list: Bubble[] = [];
  private v = new THREE.Vector3();
  private now = 0;

  constructor(root: HTMLElement, camera: THREE.Camera) {
    this.root = root;
    this.camera = camera;
  }

  /** Show a bubble. A `key` replaces any live bubble with the same key (one per dwarf). */
  say(anchor: () => THREE.Vector3, text: string, seconds = 3.5, kind: BubbleKind = 'talk', key?: string): void {
    if (key) this.dismiss(key);
    const el = document.createElement('div');
    el.className = `bubble bubble-${kind}`;
    el.textContent = text;
    this.root.appendChild(el);
    requestAnimationFrame(() => el.classList.add('in'));
    this.list.push({ el, anchor, until: this.now + seconds, key });
  }

  dismiss(key: string): void {
    for (const b of this.list) if (b.key === key) b.until = Math.min(b.until, this.now);
  }

  update(t: number): void {
    this.now = t;
    const w = this.root.clientWidth;
    const h = this.root.clientHeight;
    this.list = this.list.filter((b) => {
      if (t > b.until + 0.4) {
        b.el.remove();
        return false;
      }
      if (t > b.until) b.el.classList.remove('in');
      this.v.copy(b.anchor()).project(this.camera);
      const behind = this.v.z > 1;
      b.el.style.visibility = behind ? 'hidden' : 'visible';
      // Keep the whole bubble on screen (dwarves at the edge of the frame still get heard).
      const half = b.el.offsetWidth / 2 + 8;
      const x = Math.min(w - half, Math.max(half, (this.v.x * 0.5 + 0.5) * w));
      const y = Math.min(h - 8, Math.max(b.el.offsetHeight + 8, (-this.v.y * 0.5 + 0.5) * h));
      b.el.style.transform = `translate(-50%, -100%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      return true;
    });
  }
}
