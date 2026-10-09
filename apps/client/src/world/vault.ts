import * as THREE from 'three/webgpu';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import type { ForgeEvent, GateName } from '@deepanvil/shared';
import type { Soundscape } from '../audio.ts';
import type { Bubbles } from '../bubbles.ts';
import type { Fx } from './fx.ts';
import type { Anchor, Hall } from './hall.ts';
import { rimLight } from './painterly.ts';
import { glow, toon } from './toon.ts';

// The Vault of Main (docs/ODIN.md): Odin on his dais, the rune-door, the scales and the
// ravens, all driven by Odin's offering.* / vault.health / odin.say events.
// - Each gate has one rune material shared by its door ring and its standing stone, so a
//   gate lights in both places at once.
// - The scales tip while Odin weighs a smith's piece; a merge spins the door and swings it
//   open on the gold inside; a send-back sends Huginn with the note to the smith.
// - When main is red the braziers and the failing gates' runes burn red until it's mended.

type OdinClip = 'idle_watch' | 'inspect' | 'read' | 'approve' | 'send_back' | 'summon';
type Rune = GateName | 'review';

const RUNES: Rune[] = ['tests', 'types', 'lint', 'review'];
const RUNE_IDLE = '#9fd8ff';
const RUNE_COLOR: Record<Rune, string> = { tests: '#6dff8f', types: '#6fb2ff', lint: '#c58cff', review: '#ffd257' };
const RED = '#ff4a36';
const AMBER = '#ffb347';
const ODIN_HEAD = 2.55;
const DOOR_OPEN = -1.75; // radians about the hinge: the door swings out into the hall

interface Glow {
  color: string;
  level: number;
  pulse: number; // Hz; 0 = steady
}

const idle = (): Glow => ({ color: RUNE_IDLE, level: 0.5, pulse: 0 });

export async function loadOdinKit(url = '/assets/odin.glb'): Promise<GLTF> {
  return new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(url);
}

/** Toon + rim for painted parts, one shared glow for runes; vertex colours carry the paint. */
function dress(root: THREE.Object3D, glowMat: THREE.Material, paint: THREE.Material): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const pick = (m: THREE.Material) => (m.name.startsWith('glow') ? glowMat : paint);
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(pick) : pick(mesh.material);
    mesh.castShadow = true;
    mesh.frustumCulled = false; // skinned bounds don't follow the animation
  });
}

/** One of Odin's ravens: perches, or flies a path with flapping wings. */
class Raven {
  readonly root: THREE.Object3D;
  private wings: THREE.Object3D[];
  private path?: (k: number) => THREE.Vector3;
  private t0 = 0;
  private dur = 1;
  private done?: () => void;
  private clock = 0;
  private ahead = new THREE.Vector3();

  constructor(template: THREE.Object3D) {
    this.root = template.clone(true);
    this.root.position.set(0, 0, 0);
    this.root.scale.setScalar(1.6); // a touch larger than life, so they read from across the hall
    this.wings = ['raven_wing.L', 'raven_wing.R'].map((n) => this.root.getObjectByName(n)).filter((o): o is THREE.Object3D => !!o);
    this.fold();
  }

  get flying(): boolean {
    return !!this.path;
  }

  perch(at: THREE.Vector3, facing: THREE.Quaternion): void {
    this.path = undefined;
    this.root.position.copy(at);
    this.root.quaternion.copy(facing);
    this.fold();
  }

  fly(path: (k: number) => THREE.Vector3, seconds: number, done?: () => void): void {
    this.path = path;
    this.t0 = this.clock;
    this.dur = seconds;
    this.done = done;
  }

  private fold(): void {
    this.wings.forEach((w, i) => (w.rotation.z = i === 0 ? -1.35 : 1.35));
  }

  update(t: number): void {
    this.clock = t;
    if (!this.path) return;
    const k = Math.max(0, Math.min(1, (t - this.t0) / this.dur));
    this.root.position.copy(this.path(k));
    this.ahead.copy(this.path(Math.min(1, k + 0.02)));
    if (this.ahead.distanceToSquared(this.root.position) > 1e-6) this.root.lookAt(this.ahead);
    const flap = Math.sin(t * 15) * 0.65 + 0.15;
    this.wings.forEach((w, i) => (w.rotation.z = i === 0 ? flap : -flap));
    if (k >= 1) {
      const done = this.done;
      this.path = undefined;
      this.done = undefined;
      this.fold();
      done?.();
    }
  }
}

/** A lazy arc from a to b, rising `lift` metres in the middle. */
function arc(a: THREE.Vector3, b: THREE.Vector3, lift: number): (k: number) => THREE.Vector3 {
  const out = new THREE.Vector3();
  return (k) => {
    const e = k * k * (3 - 2 * k);
    return out.lerpVectors(a, b, e).setY(a.y + (b.y - a.y) * e + Math.sin(Math.PI * k) * lift);
  };
}

export class Vault {
  readonly group = new THREE.Group();
  private hall: Hall;
  private bubbles: Bubbles;
  private audio: Soundscape;
  private fx: Fx;
  private clock = 0;

  // Odin
  private odin?: THREE.Object3D;
  private spot?: Anchor;
  private mixer?: THREE.AnimationMixer;
  private actions = new Map<string, THREE.AnimationAction>();
  private current?: THREE.AnimationAction;
  private until = Infinity;
  private huginnPerch?: THREE.Object3D;
  private huginn?: Raven;
  private muninn?: Raven;
  private headPos = new THREE.Vector3();

  // Runes, door, scales
  private runes: Record<Rune, Glow> = { tests: idle(), types: idle(), lint: idle(), review: idle() };
  private braziers: Glow = { color: RUNE_IDLE, level: 1.8, pulse: 0 };
  private hinge = new THREE.Group();   // at the door's edge, oriented like the vault
  private swing = new THREE.Group();   // turns about the hinge (inner group: never touch hinge Euler)
  private spinner = new THREE.Group(); // at the door's centre
  private doorT = -1; // seconds since a merge opened the door, -1 = closed
  private light?: THREE.PointLight;
  private tilt = 0;
  private tiltTarget = 0;
  private weighing = false;
  private piece?: THREE.Object3D;
  private pans: { node: THREE.Object3D; restY: number; arm: number }[] = [];
  private beam?: THREE.Object3D;
  private beamRest = new THREE.Quaternion();
  private flames: { node: THREE.Object3D; rest: THREE.Vector3 }[] = [];

  // Offerings
  private current_?: string;
  private owner = new Map<string, string>(); // offeringId -> dwarfId
  private failing = new Map<string, string[]>(); // offeringId -> failed gates (with summary)
  private review = new Map<string, string>(); // offeringId -> review summary
  private mainRed = false;
  private redGates: GateName[] = [];
  /** Where a crew member's head is, for Huginn's deliveries. */
  locate?: (dwarfId: string) => (() => THREE.Vector3) | undefined;

  constructor(hall: Hall, kit: GLTF, bubbles: Bubbles, audio: Soundscape, fx: Fx) {
    this.hall = hall;
    this.bubbles = bubbles;
    this.audio = audio;
    this.fx = fx;
    const a = hall.anchors;

    // --- Odin
    this.spot = a.get('odin');
    const ravenTemplate = kit.scene.getObjectByName('raven');
    ravenTemplate?.removeFromParent();
    const odinGlow = glow(RUNE_IDLE, 2.2);
    const paint = toon('#ffffff', { vertexColors: true });
    // NodeMaterial honours emissiveNode for every material; @types/three only declares it on Standard.
    (paint as THREE.MeshToonNodeMaterial & { emissiveNode: THREE.Node | null }).emissiveNode = rimLight('#bcd8ff', 0.28);
    if (this.spot) {
      const odin = cloneSkinned(kit.scene);
      dress(odin, odinGlow, paint);
      odin.position.copy(this.spot.position);
      odin.quaternion.copy(this.spot.quaternion);
      this.group.add(odin);
      this.odin = odin;
      this.huginnPerch = odin.getObjectByName('huginn');
      this.mixer = new THREE.AnimationMixer(odin);
      for (const clip of kit.animations) this.actions.set(clip.name, this.mixer.clipAction(clip));
      this.play('idle_watch');
    }

    // --- Ravens
    if (ravenTemplate) {
      dress(ravenTemplate, odinGlow, paint);
      this.huginn = new Raven(ravenTemplate);
      this.huginn.root.visible = false;
      this.muninn = new Raven(ravenTemplate);
      this.group.add(this.huginn.root, this.muninn.root);
      const perch = a.get('muninn');
      if (perch) this.muninn.perch(perch.position, perch.quaternion);
    }

    // --- The door: a hinge at its edge, a spinner at its centre, the door pieces inside.
    const hingeA = a.get('vault_hinge');
    const doorA = a.get('vault_door');
    if (hingeA && doorA) {
      this.hinge.position.copy(hingeA.position);
      this.hinge.quaternion.copy(hingeA.quaternion);
      hall.group.add(this.hinge);
      this.hinge.add(this.swing);
      this.swing.add(this.spinner);
      this.hinge.updateMatrixWorld(true);
      this.spinner.position.copy(this.hinge.worldToLocal(doorA.position.clone()));
      this.spinner.updateMatrixWorld(true);
      for (const [name, o] of hall.parts) if (name.startsWith('vault_door')) this.spinner.attach(o);
      // One light out in front of the door: faint rune-blue, gold when open, red when main is.
      this.light = new THREE.PointLight(RUNE_IDLE, 6, 11, 1.8);
      const out = new THREE.Vector3(0, 0, 1.6).applyQuaternion(doorA.quaternion);
      this.light.position.copy(doorA.position).add(out);
      this.group.add(this.light);
    }

    for (const i of [0, 1]) {
      const node = hall.parts.get(`brazier_flame_${i}`);
      if (node) this.flames.push({ node, rest: node.scale.clone() });
    }

    // The gold inside glows by itself; keep its lit colour low so the door light doesn't blow it out.
    (hall.materials.get('glow_vault') as THREE.MeshToonNodeMaterial | undefined)?.color.set('#4a3412');

    // --- Scales
    this.beam = hall.parts.get('scales_beam');
    if (this.beam) this.beamRest.copy(this.beam.quaternion);
    for (const [name, arm] of [['scales_pan_l', -0.7], ['scales_pan_r', 0.7]] as const) {
      const node = hall.parts.get(name);
      if (node) this.pans.push({ node, restY: node.position.y, arm });
      const extra = hall.parts.get(`${name}_glow_ember`);
      if (extra) {
        this.pans.push({ node: extra, restY: extra.position.y, arm });
        this.piece = extra;
        extra.visible = false;
      }
    }
  }

  // ------------------------------------------------------------------ Odin

  /** Odin as a tap target (chest height), for the dwarf card. */
  target(): { id: string; point: THREE.Vector3 } | undefined {
    return this.odin ? { id: 'odin', point: this.odin.position.clone().setY(this.odin.position.y + 1.2) } : undefined;
  }

  private play(name: OdinClip, seconds = Infinity, once = false): void {
    const next = this.actions.get(name);
    if (!next) return;
    this.until = this.clock + seconds;
    if (this.current === next && !once) return;
    next.reset();
    next.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    next.clampWhenFinished = once;
    next.fadeIn(0.25).play();
    if (this.current !== next) this.current?.fadeOut(0.25);
    this.current = next;
  }

  private head = (): THREE.Vector3 => {
    if (this.odin) this.headPos.copy(this.odin.position).setY(this.odin.position.y + ODIN_HEAD);
    return this.headPos;
  };

  private say(text: string): void {
    this.bubbles.say(this.head, text, Math.min(9, 3 + text.length / 22), 'talk', 'odin');
  }

  /** Huginn's perch on Odin's left shoulder (a skinned mesh's own position is the rig origin). */
  private shoulder(): THREE.Vector3 {
    return this.odin ? this.odin.localToWorld(new THREE.Vector3(0.42, 1.7, -0.05)) : new THREE.Vector3();
  }

  /** Huginn carries a note from Odin's shoulder to a smith, then comes home. */
  private sendHuginn(dwarfId: string, note: string): void {
    const raven = this.huginn;
    const perch = this.huginnPerch;
    const target = this.locate?.(dwarfId);
    if (!raven || !perch || !target || raven.flying) return;
    const from = this.shoulder();
    perch.visible = false;
    raven.root.visible = true;
    raven.perch(from, this.spot?.quaternion ?? new THREE.Quaternion());
    const to = target().clone().add(new THREE.Vector3(0, 0.4, 0));
    raven.fly(arc(from, to, 3), Math.max(2, from.distanceTo(to) / 6), () => {
      this.bubbles.say(target, `📜 ${note}`, 5, 'note', dwarfId);
      const back = this.shoulder();
      raven.fly(arc(to, back, 2.5), Math.max(2, to.distanceTo(back) / 6), () => {
        raven.root.visible = false;
        perch.visible = true;
      });
    });
  }

  /** Muninn remembers the merge: a lap high over the hall, then back to the arch. */
  private muninnLap(): void {
    const raven = this.muninn;
    const perch = this.hall.anchors.get('muninn');
    if (!raven || !perch || raven.flying) return;
    const centre = new THREE.Vector3(0, 7.5, -3);
    const start = perch.position.clone();
    const a0 = Math.atan2(start.z - centre.z, start.x - centre.x);
    const out = new THREE.Vector3();
    const r = 9;
    raven.fly((k) => {
      // Ease out of the perch onto the circle, go once round, ease back in.
      const a = a0 - k * Math.PI * 2;
      out.set(centre.x + Math.cos(a) * r, centre.y + Math.sin(k * Math.PI * 4) * 0.6, centre.z + Math.sin(a) * r);
      const w = Math.min(1, Math.min(k, 1 - k) * 8);
      return out.lerp(start, 1 - w);
    }, 9, () => raven.perch(perch.position, perch.quaternion));
  }

  // ------------------------------------------------------------------ events

  /** A smith has laid their piece on the scales. */
  receive(offeringId: string): void {
    if (offeringId !== this.current_ || !this.piece) return;
    if (!this.piece.visible) {
      this.piece.visible = true;
      this.fx.burst('sparks', this.piece.getWorldPosition(new THREE.Vector3()));
    }
    this.tiltTarget = 0.2;
  }

  handle(e: ForgeEvent): void {
    switch (e.type) {
      case 'offering.opened':
        this.owner.set(e.offeringId, e.dwarfId);
        if (this.current_ !== e.offeringId || e.lines === 0) {
          this.current_ = e.offeringId;
          this.failing.delete(e.offeringId);
          for (const r of RUNES) this.runes[r] = this.gateIdle(r);
          this.weighing = false;
          this.tiltTarget = this.piece?.visible ? 0.2 : 0;
          this.play('inspect', 4);
        }
        return;
      case 'offering.gate': {
        if (e.offeringId !== this.current_) return;
        const g = this.runes[e.gate];
        const color = RUNE_COLOR[e.gate];
        if (e.status === 'running') Object.assign(g, { color, level: 1.6, pulse: 1.4 });
        else if (e.status === 'pass') Object.assign(g, { color, level: 2.6, pulse: 0 });
        else if (e.status === 'flaky') Object.assign(g, { color: AMBER, level: 2.2, pulse: 0.7 });
        else if (e.status === 'skipped') Object.assign(g, { color: '#8fa0b0', level: 0.25, pulse: 0 });
        else {
          Object.assign(g, { color: RED, level: 2.8, pulse: 2.5 });
          const list = this.failing.get(e.offeringId) ?? [];
          list.push(e.summary ? `${e.gate}: ${e.summary}` : e.gate);
          this.failing.set(e.offeringId, list);
          this.audio.fizzle(this.hall.anchors.get(`gate_${e.gate}`)?.position ?? this.head());
        }
        if (e.status === 'pass') this.audio.hiss(this.hall.anchors.get(`gate_${e.gate}`)?.position ?? this.head());
        return;
      }
      case 'offering.state':
        if (e.offeringId !== this.current_) return;
        if (e.state === 'gates') {
          this.weighing = true;
          this.play('inspect');
        } else if (e.state === 'reviewing') {
          Object.assign(this.runes.review, { color: RUNE_COLOR.review, level: 1.8, pulse: 1.1 });
          this.weighing = true;
          this.play('read');
        } else if (e.state === 'awaiting_you') {
          this.weighing = false;
          this.tiltTarget = 0;
          this.play('idle_watch');
        } else if (e.state === 'sent_back') {
          this.weighing = false;
          this.tiltTarget = 0.42; // found wanting
          this.play('send_back', 2.2, true);
          const who = this.owner.get(e.offeringId);
          if (who) this.sendHuginn(who, this.noteFor(e.offeringId, e.reason));
          setTimeout(() => this.clearScales(e.offeringId), 2600);
        } else if (e.state === 'abandoned') {
          this.clearScales(e.offeringId);
          this.play('idle_watch');
        }
        return;
      case 'offering.review':
        if (e.offeringId !== this.current_) return;
        this.review.set(e.offeringId, e.summary);
        Object.assign(this.runes.review, e.decision === 'approve'
          ? { color: RUNE_COLOR.review, level: 2.8, pulse: 0 }
          : { color: RED, level: 2.6, pulse: 2 });
        if (e.decision === 'approve') this.tiltTarget = 0;
        return;
      case 'offering.merged':
        if (e.offeringId !== this.current_) return;
        this.weighing = false;
        this.tiltTarget = 0;
        this.play('approve', 1.7, true);
        this.doorT = 0;
        for (const r of RUNES) Object.assign(this.runes[r], { color: RUNE_COLOR[r], level: 3.2, pulse: 0 });
        this.audio.rumble(this.hinge.position, 3);
        this.muninnLap();
        setTimeout(() => this.clearScales(e.offeringId), 6500);
        return;
      case 'vault.health':
        this.mainRed = e.status === 'red';
        this.redGates = e.status === 'red' ? (e.failing ?? []) : [];
        Object.assign(this.braziers, this.mainRed ? { color: RED, level: 2.6, pulse: 0.8 } : { color: RUNE_IDLE, level: 1.8, pulse: 0 });
        if (!this.current_) for (const r of RUNES) this.runes[r] = this.gateIdle(r);
        if (this.mainRed) this.play('summon', 3.5, true);
        return;
      case 'odin.say':
        this.say(e.text);
        return;
    }
  }

  private gateIdle(r: Rune): Glow {
    return r !== 'review' && this.redGates.includes(r) ? { color: RED, level: 1.6, pulse: 0.5 } : idle();
  }

  private noteFor(offeringId: string, reason?: string): string {
    switch (reason) {
      case 'gate': return (this.failing.get(offeringId) ?? ['the gates failed']).join(' · ').slice(0, 140);
      case 'review': return (this.review.get(offeringId) ?? 'Odin asks for changes.').slice(0, 140);
      case 'too_big': return 'Too heavy for one offering: split it.';
      case 'conflict': return 'It clashes with main: rebase and try again.';
      case 'human': return 'The forge-master sent it back.';
      default: return 'Back to the anvil.';
    }
  }

  private clearScales(offeringId: string): void {
    if (this.current_ !== offeringId) return;
    this.current_ = undefined;
    if (this.piece) this.piece.visible = false;
    this.tiltTarget = 0;
    for (const r of RUNES) this.runes[r] = this.gateIdle(r);
  }

  // ------------------------------------------------------------------ frame

  private tmpC = new THREE.Color();
  private tmpV = new THREE.Vector3();
  private tmpQ = new THREE.Quaternion();
  private zAxis = new THREE.Vector3(0, 0, 1);

  private shine(name: string, g: Glow, t: number, dt: number): void {
    const m = this.hall.materials.get(name) as THREE.MeshToonNodeMaterial | undefined;
    if (!m) return;
    const k = 1 - Math.exp(-6 * dt);
    this.tmpC.set(g.color);
    m.color.lerp(this.tmpC, k);
    m.emissive.lerp(this.tmpC, k);
    const level = g.level * (g.pulse ? 0.65 + 0.35 * Math.sin(t * g.pulse * Math.PI * 2) : 1);
    m.emissiveIntensity += (level - m.emissiveIntensity) * k;
  }

  update(t: number, dt: number): void {
    this.clock = t;
    this.mixer?.update(dt);
    if (this.current && this.current !== this.actions.get('idle_watch') && t > this.until) this.play('idle_watch');
    this.huginn?.update(t);
    this.muninn?.update(t);

    for (const r of RUNES) this.shine(`glow_rune_${r}`, this.runes[r], t, dt);
    this.shine('glow_rune', this.braziers, t, dt);
    this.flames.forEach(({ node, rest }, i) => {
      // Relative to the rest scale: meshopt quantization stores a scale on the node.
      node.scale.copy(rest).multiply(this.tmpV.set(1, 0.9 + Math.sin(t * 9 + i * 2) * 0.08 + Math.sin(t * 15.3 + i) * 0.05, 1));
    });

    // The door: spin (1.4 s), swing open (1.2 s), hold, swing shut (1.6 s).
    let open = 0;
    if (this.doorT >= 0) {
      this.doorT += dt;
      const d = this.doorT;
      const ease = (x: number) => { const c = Math.max(0, Math.min(1, x)); return c * c * (3 - 2 * c); };
      this.spinner.quaternion.setFromAxisAngle(this.zAxis, ease(d / 1.4) * Math.PI * 2);
      open = d < 1.4 ? 0 : d < 6 ? ease((d - 1.4) / 1.2) : 1 - ease((d - 6) / 1.6);
      this.swing.rotation.y = open * DOOR_OPEN;
      if (d > 1.5 && d - dt <= 1.5 && this.piece?.visible) {
        this.fx.burst('sparks', this.piece.getWorldPosition(new THREE.Vector3()));
        this.piece.visible = false;
      }
      if (d > 7.8) {
        this.doorT = -1;
        this.swing.rotation.y = 0;
        this.spinner.quaternion.identity();
        for (const r of RUNES) this.runes[r] = this.gateIdle(r);
      }
    }
    const hoard = this.hall.materials.get('glow_vault') as THREE.MeshToonNodeMaterial | undefined;
    if (hoard) hoard.emissiveIntensity = 0.55 + open * 0.45 + Math.sin(t * 2.3) * 0.06;
    if (this.light) {
      const target = open > 0.05 ? '#ffc861' : this.mainRed ? RED : RUNE_IDLE;
      this.light.color.lerp(this.tmpC.set(target), 1 - Math.exp(-4 * dt));
      const want = 6 + open * 10 + (this.mainRed ? 10 + Math.sin(t * 5) * 4 : 0);
      this.light.intensity += (want - this.light.intensity) * (1 - Math.exp(-4 * dt));
    }

    // The scales: tilt toward the target, wobbling while Odin is still weighing.
    const want = this.tiltTarget + (this.weighing ? Math.sin(t * 1.9) * 0.09 : Math.sin(t * 0.7) * 0.015);
    this.tilt += (want - this.tilt) * (1 - Math.exp(-3 * dt));
    if (this.beam) this.beam.quaternion.copy(this.beamRest).multiply(this.tmpQ.setFromAxisAngle(this.zAxis, this.tilt));
    for (const p of this.pans) p.node.position.y = p.restY + p.arm * Math.sin(this.tilt);
  }
}
