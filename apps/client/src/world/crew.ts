import * as THREE from 'three/webgpu';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import type { Dwarf, ForgeEvent } from '@deepanvil/shared';
import type { Soundscape } from '../audio.ts';
import type { Bubbles } from '../bubbles.ts';
import type { Fx } from './fx.ts';
import type { Anchor, Hall } from './hall.ts';
import { route } from './nav.ts';
import { rimLight } from './painterly.ts';
import { glow, toon } from './toon.ts';

// The crew: one skinned dwarf (assets/src/forge/crew.py) cloned per crew member,
// recoloured through its material slots and dressed with variant meshes. Each dwarf
// has a tiny intent system — walk to a station, then do something there — and every
// forge event becomes behaviour: reading at the lectern, hammering, ringing the bell.

type Slot = 'tunic' | 'trousers' | 'skin' | 'beard' | 'leather' | 'metal' | 'hat' | 'eyes' | 'wood' | 'parchment';
type Clip = 'idle' | 'walk' | 'hammer' | 'read' | 'bellows' | 'ring_bell' | 'cheer' | 'slump' | 'scratch_beard';

interface Look {
  colors: Partial<Record<Slot, string>>;
  hat: 'hat_helmet' | 'hat_hood' | 'hat_cap' | 'hat_master' | null;
  beard: 'beard_long' | 'beard_braids' | 'beard_bushy';
  apron?: boolean;
  tool?: 'hammer' | 'scroll';
  scale?: number;
}

const BASE: Record<Slot, string> = {
  tunic: '#c0533b', trousers: '#5a4636', skin: '#f2c3a0', beard: '#d99a45', leather: '#7a4a2c',
  metal: '#8b8796', hat: '#4f6f8f', eyes: '#2a1c18', wood: '#8a5a36', parchment: '#f1e2bf',
};

// Placeholder looks until the crew's names and personalities are settled (DESIGN.md open item).
const SMITH_LOOKS: Look[] = [
  { colors: { tunic: '#c0533b', beard: '#e0a84a', hat: '#6b4a8c' }, hat: 'hat_helmet', beard: 'beard_braids', apron: true, tool: 'hammer' },
  { colors: { tunic: '#3f7d5a', beard: '#8a4b2a', hat: '#a8452f' }, hat: 'hat_hood', beard: 'beard_long', apron: true, tool: 'hammer' },
  { colors: { tunic: '#3e6aa8', beard: '#d8d2c4', hat: '#7a5a34' }, hat: 'hat_cap', beard: 'beard_bushy', apron: true, tool: 'hammer' },
  { colors: { tunic: '#b5873a', beard: '#c4642f', hat: '#3f5f8a' }, hat: 'hat_helmet', beard: 'beard_long', apron: true, tool: 'hammer' },
];
const MASTER_LOOK: Look = {
  colors: { tunic: '#5b3f8c', beard: '#f0ece2', hat: '#3b2a5c', trousers: '#3a2e4a' },
  hat: 'hat_master', beard: 'beard_long', tool: 'scroll', scale: 1.25,
};

const WALK_SPEED = 1.5; // m/s, matched to the walk clip's stride
const READ_SPOTS = ['lectern', 'shelf_0', 'shelf_1'];

interface Member {
  dwarf: Dwarf;
  root: THREE.Object3D;
  scale: number;
  mixer: THREE.AnimationMixer;
  actions: Map<string, THREE.AnimationAction>;
  current?: THREE.AnimationAction;
  until: number;
  home: Anchor;
  anvilTop?: THREE.Vector3;
  at: string;              // station name, or 'walking'
  path: THREE.Vector3[];
  face: THREE.Quaternion;  // orientation to settle into when standing
  then?: () => void;
  readUntil: number;
  ringing: boolean;
}

interface Flight {
  from: THREE.Vector3;
  to: THREE.Vector3;
  t0: number;
  dur: number;
  done?: () => void;
}

export async function loadCrewKit(url = '/assets/crew.glb'): Promise<GLTF> {
  return new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(url);
}

export class Crew {
  readonly group = new THREE.Group();
  readonly names = new Map<string, string>();
  private members = new Map<string, Member>();
  private sprite?: THREE.Mesh;
  private spriteId?: string;
  private flight?: Flight;
  private master?: Member;
  private fx: Fx;
  private hall: Hall;
  private kit: GLTF;
  private bubbles: Bubbles;
  private audio: Soundscape;
  private clock = 0;
  private pump = 0;
  private masterNext = 4;
  private nextBell = 0;
  private spotTaken = new Map<string, string>(); // reading spot -> dwarf id

  constructor(fx: Fx, hall: Hall, kit: GLTF, bubbles: Bubbles, audio: Soundscape) {
    this.fx = fx;
    this.hall = hall;
    this.kit = kit;
    this.bubbles = bubbles;
    this.audio = audio;
  }

  // ------------------------------------------------------------------ spawning

  private spawn(dwarf: Dwarf, look: Look, home: Anchor): Member {
    const root = cloneSkinned(this.kit.scene);
    const mats = new Map<string, THREE.Material>();
    const shown = new Set(['body', look.hat, look.beard, look.apron ? 'apron' : null, look.tool ?? null].filter(Boolean) as string[]);
    const assign = (m: THREE.Material): THREE.Material => {
      let out = mats.get(m.name);
      if (!out) {
        if (m.name.startsWith('glow')) out = glow('#7fe8ff', 2);
        else {
          const slot = m.name as Slot;
          const t = toon(look.colors[slot] ?? BASE[slot] ?? '#ffffff', { vertexColors: true });
          // NodeMaterial honours emissiveNode for every material; @types/three only declares it on Standard.
          (t as THREE.MeshToonNodeMaterial & { emissiveNode: THREE.Node | null }).emissiveNode = rimLight('#ffb070', 0.3);
          out = t;
        }
        mats.set(m.name, out);
      }
      return out;
    };
    root.traverse((o) => {
      const mesh = o as THREE.SkinnedMesh;
      if (!mesh.isMesh) return;
      // Multi-material meshes load as a group of primitives named after the mesh.
      mesh.visible = shown.has(mesh.name) || shown.has(mesh.parent?.name ?? '');
      mesh.castShadow = true;
      mesh.frustumCulled = false; // skinned bounds don't follow the animation
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(assign) : assign(mesh.material);
    });
    const scale = look.scale ?? 1.15;
    root.position.copy(home.position);
    root.quaternion.copy(home.quaternion);
    root.scale.setScalar(scale);
    this.group.add(root);

    const mixer = new THREE.AnimationMixer(root);
    const actions = new Map<string, THREE.AnimationAction>();
    for (const clip of this.kit.animations) actions.set(clip.name, mixer.clipAction(clip));
    const m: Member = {
      dwarf, root, scale, mixer, actions, until: Infinity, home,
      at: 'home', path: [], face: home.quaternion.clone(), readUntil: 0, ringing: false,
    };
    this.play(m, 'idle');
    mixer.setTime(Math.random() * 2); // so the crew doesn't breathe in unison
    return m;
  }

  /** (Re)builds the crew from the server's roster. */
  setRoster(crew: Dwarf[]): void {
    for (const m of this.members.values()) m.mixer.stopAllAction();
    this.group.clear();
    this.members.clear();
    this.spotTaken.clear();
    this.master = undefined;
    const anchors = this.hall.anchors;
    crew.filter((d) => d.role === 'smith').forEach((dwarf, i) => {
      this.names.set(dwarf.id, dwarf.name);
      const stand = anchors.get(`smith_${i}`);
      const anvil = anchors.get(`anvil_${i}`);
      if (!stand || !anvil) return; // more smiths than anvils: they wait off-screen for now
      const m = this.spawn(dwarf, SMITH_LOOKS[i % SMITH_LOOKS.length]!, stand);
      m.anvilTop = anvil.position.clone();
      this.members.set(dwarf.id, m);
    });

    const master = crew.find((d) => d.role === 'forgemaster');
    const spot = anchors.get('master');
    if (master && spot) {
      this.names.set(master.id, master.name);
      this.master = this.spawn(master, MASTER_LOOK, spot);
      this.members.set(master.id, this.master);
    }

    const sprite = crew.find((d) => d.role === 'sprite');
    if (sprite) {
      this.names.set(sprite.id, sprite.name);
      this.spriteId = sprite.id;
      this.sprite = new THREE.Mesh(new THREE.IcosahedronGeometry(0.16, 1), glow('#b6ff9e', 3));
      this.group.add(this.sprite);
    }
  }

  // ------------------------------------------------------------------ intents

  /** Cross-fade a member into a clip; after `seconds` they drift back to idle. */
  private play(m: Member, name: Clip, seconds = Infinity, once = false): void {
    const next = m.actions.get(name);
    if (!next) return;
    m.until = this.clock + seconds;
    if (m.current === next) return;
    next.reset();
    next.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    next.clampWhenFinished = once;
    next.fadeIn(0.18).play();
    m.current?.fadeOut(0.18);
    m.current = next;
  }

  private station(m: Member, name: string): Anchor | undefined {
    return name === 'home' ? m.home : this.hall.anchors.get(name);
  }

  /** Walk to a station (unless already there), then run `then`. */
  private goTo(m: Member, name: string, then?: () => void): void {
    const st = this.station(m, name);
    if (!st) return then?.();
    if (m.at === name && m.path.length === 0) {
      m.face.copy(st.quaternion);
      return then?.();
    }
    this.releaseSpot(m);
    m.path = route(m.root.position, st.position);
    m.at = 'walking';
    m.then = () => {
      m.at = name;
      m.face.copy(st.quaternion);
      then?.();
    };
    this.play(m, 'walk');
  }

  private atHome(m: Member, action: () => void): void {
    if (m.ringing) return; // waiting on you at the bell; work resumes after the answer
    this.goTo(m, 'home', action);
  }

  private releaseSpot(m: Member): void {
    for (const [spot, id] of this.spotTaken) if (id === m.dwarf.id) this.spotTaken.delete(spot);
  }

  /** Reads/greps: wander to a free reading spot and stay while the reading continues. */
  private readTrip(m: Member): void {
    m.readUntil = this.clock + 4.5;
    // Already reading, or already on the way to a reserved spot.
    if (m.ringing || READ_SPOTS.includes(m.at) || [...this.spotTaken.values()].includes(m.dwarf.id)) return;
    const spot = READ_SPOTS.find((s) => !this.spotTaken.has(s) && this.hall.anchors.has(s));
    if (!spot) return this.play(m, 'read', 2.5); // library full: read at the anvil
    this.goTo(m, spot, () => this.play(m, 'read'));
    this.spotTaken.set(spot, m.dwarf.id);
  }

  private headOf(m: Member): () => THREE.Vector3 {
    const v = new THREE.Vector3();
    return () => v.copy(m.root.position).setY(m.root.position.y + 1.95 * m.scale);
  }

  private say(m: Member, text: string, seconds = 3.5, kind: 'talk' | 'ask' | 'note' = 'talk'): void {
    this.bubbles.say(this.headOf(m), text, seconds, kind, m.dwarf.id);
  }

  private fly(to: THREE.Vector3, done?: () => void): void {
    if (!this.sprite) return done?.();
    const from = this.sprite.position.clone();
    this.flight = { from, to: to.clone(), t0: this.clock, dur: Math.max(1.2, from.distanceTo(to) / 7), done };
  }

  // ------------------------------------------------------------------ events

  private offeringOwner = new Map<string, string>(); // offeringId -> smith id

  handle(e: ForgeEvent): void {
    if (e.type === 'offering.opened') this.offeringOwner.set(e.offeringId, e.dwarfId);
    if (e.type === 'offering.state' || e.type === 'offering.merged') {
      const m = this.members.get(this.offeringOwner.get(e.offeringId) ?? '');
      if (m && e.type === 'offering.merged') {
        this.play(m, 'cheer', 1.25, true);
        if (m.anvilTop) this.audio.cheer(m.anvilTop);
      } else if (m && e.type === 'offering.state' && e.state === 'sent_back') {
        this.play(m, 'slump', 2.2);
        const why: Record<string, string> = { conflict: 'It clashes with the vault. Rebase…', too_big: 'Too big, says Odin. Trimming.', gate: 'Odin’s runes went red.', review: 'Odin wants changes.', human: 'Sent back. Fair enough.' };
        this.say(m, why[e.reason ?? ''] ?? 'Back to the anvil.', 3);
      }
      return;
    }
    switch (e.type) {
      case 'hello':
        return this.setRoster(e.crew);
      case 'blueprint.proposed':
        if (this.master) {
          this.play(this.master, 'read', 6);
          this.say(this.master, `A new blueprint: “${e.title}”`, 5, 'note');
        }
        return;
      case 'blueprint.approved':
        this.hall.flare(2.5);
        this.audio.whoosh(this.audio.furnace);
        if (this.master) this.say(this.master, 'Light the forges!', 2.5);
        for (const m of this.members.values()) if (m !== this.master && m.at === 'home') this.play(m, 'cheer', 1.25, true);
        return;
      case 'merge': {
        this.hall.sendCart();
        const cart = this.hall.anchors.get('cart')?.position;
        if (cart) this.audio.rumble(cart, 5);
        if (this.master) {
          this.play(this.master, 'cheer', 1.25, true);
          this.say(this.master, 'Into the cart with it — merged!', 3.5);
        }
        return;
      }
      case 'master.say':
        if (this.master) this.say(this.master, e.text, Math.min(9, 3 + e.text.length / 25));
        return;
      case 'haiku.digest': {
        const from = this.members.get(e.fromDwarfId);
        const to = this.members.get(e.toDwarfId);
        if (!to) return;
        // From 'pip' (no member): Pip sets off from wherever it is.
        const start = from ? this.headOf(from)() : (this.sprite?.position.clone() ?? this.headOf(to)());
        this.fly(start, () =>
          this.fly(this.headOf(to)(), () => {
            this.bubbles.say(this.headOf(to), `📜 ${e.note}`, 3.5, 'note', `pip-${to.dwarf.id}`);
            const home = this.hall.anchors.get('sprite_home')?.position;
            if (home) this.fly(home);
          }),
        );
        return;
      }
    }

    if (!('dwarfId' in e)) return;
    const m = this.members.get(e.dwarfId);
    if (!m) return;
    switch (e.type) {
      case 'task.assigned':
        this.atHome(m, () => this.play(m, 'idle'));
        this.say(m, `On it: ${e.title}`, 3);
        break;
      case 'tool':
        if (e.kind === 'read' || e.kind === 'grep') {
          this.readTrip(m);
        } else if (e.kind === 'bash') {
          this.atHome(m, () => {
            this.play(m, 'bellows', 2.5);
            this.pump = 2.5;
            const bellows = this.hall.parts.get('bellows_top');
            if (bellows) this.audio.whoosh(bellows.getWorldPosition(new THREE.Vector3()));
          });
        } else {
          this.atHome(m, () => {
            this.play(m, 'hammer', 1.83);
            // Sparks and a clang on each strike (frame 19 of the 22-frame swing at 24 fps).
            for (const at of [0.79, 1.71]) {
              setTimeout(() => {
                if (!m.anvilTop || m.at !== 'home') return;
                this.fx.burst('sparks', m.anvilTop);
                this.audio.clang(m.anvilTop);
              }, at * 1000);
            }
          });
        }
        break;
      case 'test.pass':
        this.play(m, 'cheer', 1.25, true);
        if (m.anvilTop) {
          this.fx.burst('steam', m.anvilTop);
          this.audio.hiss(m.anvilTop);
          this.audio.cheer(m.anvilTop);
        }
        break;
      case 'test.fail':
        this.play(m, 'slump', 2.2);
        if (m.anvilTop) {
          this.fx.burst('cinders', m.anvilTop);
          this.audio.fizzle(m.anvilTop);
        }
        if (e.attempt === 1) this.say(m, 'Cracked! Again…', 2.5);
        break;
      case 'permission.request':
        this.goTo(m, 'bell_stand', () => {
          m.ringing = true;
          this.play(m, 'ring_bell');
        });
        this.say(m, `May I ${e.action}?`, 60, 'ask');
        break;
      case 'permission.resolved':
        m.ringing = false;
        this.say(m, e.approved ? 'Thank ye!' : 'Aye, another way then.', 2.5);
        this.goTo(m, 'home', () => this.play(m, 'idle'));
        break;
      case 'escalation':
        this.say(m, "It won't hold, master. Twice cracked.", 3.5);
        this.goTo(m, 'table_visit', () => {
          this.play(m, 'slump', 6);
          if (this.master) {
            this.play(this.master, 'scratch_beard', 4);
            this.say(this.master, 'Hmm. Let me redraw this part.', 4);
          }
        });
        break;
      case 'banter':
        this.say(m, e.line, 3.5);
        break;
      case 'offering.opened':
        if (e.lines) this.say(m, e.revision > 1 ? 'Back to Odin’s scales!' : 'To Odin’s scales!', 2.5);
        break;
      case 'usage.tick': {
        const treasury = this.hall.anchors.get('treasury')?.position;
        if (!treasury) break;
        const tokens = e.inputTokens + e.outputTokens;
        this.fx.coinsTo(treasury, this.headOf(m)(), Math.min(6, 1 + Math.floor(tokens / 1500)));
        this.audio.coins(treasury);
        break;
      }
    }
  }

  // ------------------------------------------------------------------ frame

  private tmpV = new THREE.Vector3();
  private tmpQ2 = new THREE.Quaternion();
  private up = new THREE.Vector3(0, 1, 0);

  update(t: number, dt: number): void {
    this.clock = t;
    for (const m of this.members.values()) {
      if (m.path.length) {
        const target = m.path[0]!;
        const d = this.tmpV.subVectors(target, m.root.position).setY(0);
        const dist = d.length();
        const step = WALK_SPEED * dt;
        if (dist <= step) {
          m.root.position.copy(target);
          m.path.shift();
          if (!m.path.length) {
            const then = m.then;
            m.then = undefined;
            this.play(m, 'idle');
            then?.();
          }
        } else {
          m.root.position.addScaledVector(d, step / dist);
          this.tmpQ2.setFromAxisAngle(this.up, Math.atan2(d.x, d.z));
          m.root.quaternion.slerp(this.tmpQ2, 1 - Math.exp(-10 * dt));
        }
      } else {
        m.root.quaternion.slerp(m.face, 1 - Math.exp(-8 * dt));
        if (t > m.until) this.play(m, 'idle');
        // Done reading: head back to the anvil.
        if (READ_SPOTS.includes(m.at) && t > m.readUntil) this.goTo(m, 'home', () => this.play(m, 'idle'));
      }
      m.mixer.update(dt);
    }

    // The Forgemaster ponders the blueprint between quests.
    if (this.master && t > this.masterNext && t > this.master.until) {
      this.play(this.master, Math.random() < 0.6 ? 'read' : 'scratch_beard', 3 + Math.random() * 3);
      this.masterNext = t + 8 + Math.random() * 6;
    }

    // Pip: message runs, otherwise lazy loops over the garden.
    if (this.sprite) {
      const f = this.flight;
      if (f) {
        const k = Math.min(1, (t - f.t0) / f.dur);
        const e = k * k * (3 - 2 * k);
        this.sprite.position.lerpVectors(f.from, f.to, e);
        this.sprite.position.y += Math.sin(Math.PI * k) * 1.5;
        if (k >= 1) {
          this.flight = undefined;
          f.done?.();
        }
      } else {
        const home = this.hall.anchors.get('sprite_home')?.position;
        if (home) {
          this.tmpV.set(home.x + Math.cos(t * 0.6) * 2.2, home.y + Math.sin(t * 1.7) * 0.4, home.z + Math.sin(t * 0.6) * 1.6);
          this.sprite.position.lerp(this.tmpV, 1 - Math.exp(-2 * dt));
        }
      }
    }

    // The bell swings (and rings) while anyone is pulling its rope.
    const ringing = [...this.members.values()].some((m) => m.ringing && m.at === 'bell_stand');
    const bell = this.hall.anchors.get('bell')?.position;
    if (ringing && bell && t > this.nextBell) {
      this.audio.bell(bell);
      this.nextBell = t + 1.1;
    }
    this.pump = Math.max(0, this.pump - dt);
    this.swingPart('bell', this.xAxis, ringing ? Math.sin(t * 5.7) * 0.32 : 0);
    this.swingPart('bellows_top', this.zAxis, (Math.sin(t * 9) * 0.5 + 0.5) * 0.18 * Math.min(1, this.pump));
  }

  private xAxis = new THREE.Vector3(1, 0, 0);
  private zAxis = new THREE.Vector3(0, 0, 1);
  private rest = new Map<string, THREE.Quaternion>();
  private tmpQ = new THREE.Quaternion();

  /** Rotates a named hall part about one of its local axes, relative to its resting pose. */
  private swingPart(name: string, axis: THREE.Vector3, angle: number): void {
    const part = this.hall.parts.get(name);
    if (!part) return;
    let rest = this.rest.get(name);
    if (!rest) this.rest.set(name, (rest = part.quaternion.clone()));
    part.quaternion.copy(rest).multiply(this.tmpQ.setFromAxisAngle(axis, angle));
  }
}
