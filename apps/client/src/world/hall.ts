import * as THREE from 'three/webgpu';
import { uv } from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import type { QualitySettings } from '../quality.ts';
import { mulberry32 } from './noise.ts';
import { rimLight } from './painterly.ts';
import { glow, toon } from './toon.ts';

// The great forge-hall, built procedurally in Blender (assets/src) and painted into
// vertex colours. Here we swap in toon/glow materials and bring it to life with
// lights, the sunbeam and drifting motes — all placed from the exported anchors.

export const PALETTE = {
  ember: '#ff8a2a',
  sun: '#fff0cf',
  sky: '#cfe8ff',
  crystal: '#7fe8ff',
  lamp: '#ffc46b',
};

const GLOW: Record<string, [string, number]> = {
  glow_ember: [PALETTE.ember, 2.6],
  glow_crystal: [PALETTE.crystal, 1.3],
  glow_sky: ['#e6f4ff', 2.4],
  glow_lamp: [PALETTE.lamp, 2.8],
  glow_mushroom: ['#9dff8a', 1.6],
};

export interface Anchor {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  extras: Record<string, unknown>;
}

export interface Hall {
  group: THREE.Group;
  anchors: Map<string, Anchor>;
  parts: Map<string, THREE.Object3D>;
  sun: THREE.DirectionalLight;
  /** Make the furnace roar for a moment (blueprint approved). */
  flare(seconds?: number): void;
  /** Send the minecart into the tunnel and back (merge). */
  sendCart(): void;
  /** The gold pile shows what's left of the weekly allowance (0..1). */
  setTreasury(remaining: number): void;
  /** Furnace heat follows the burn rate (0 = idle, 1 = roaring). */
  setHeat(heat: number): void;
  update(t: number, dt: number): void;
}

export async function loadHall(q: QualitySettings, url = '/assets/hall.glb'): Promise<Hall> {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(url);
  const group = new THREE.Group();
  group.add(gltf.scene);
  gltf.scene.updateMatrixWorld(true);

  const anchors = new Map<string, Anchor>();
  const parts = new Map<string, THREE.Object3D>();
  const materials = new Map<string, THREE.Material>();
  const material = (name: string): THREE.Material => {
    let m = materials.get(name);
    if (!m) {
      if (name in GLOW) m = glow(...GLOW[name]!);
      else if (name === 'gold') m = toon('#ffffff', { vertexColors: true, emissive: new THREE.Color('#7a4e10'), emissiveIntensity: 0.6 });
      else {
        const paint = toon('#ffffff', { vertexColors: true });
        // NodeMaterial honours emissiveNode for every material; @types/three only declares it on Standard.
        (paint as THREE.MeshToonNodeMaterial & { emissiveNode: THREE.Node | null }).emissiveNode = rimLight();
        m = paint;
      }
      materials.set(name, m);
    }
    return m;
  };

  gltf.scene.traverse((o) => {
    if (o.name.startsWith('anchor_')) {
      const position = new THREE.Vector3();
      const quaternion = new THREE.Quaternion();
      o.matrixWorld.decompose(position, quaternion, new THREE.Vector3());
      anchors.set(o.name.slice('anchor_'.length), { position, quaternion, extras: o.userData });
      return;
    }
    parts.set(o.name, o);
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const name = (mesh.material as THREE.Material).name || 'paint';
    mesh.material = material(name);
    const glowing = name.startsWith('glow');
    mesh.receiveShadow = !glowing;
    mesh.castShadow = !glowing;
  });

  const need = (name: string): Anchor => {
    const a = anchors.get(name);
    if (!a) throw new Error(`hall.glb is missing anchor_${name}`);
    return a;
  };

  // --- Light: cool daylight from the sky hole vs warm forge and lamp glow.
  const skyHole = need('sky_hole').position;
  const sunSpot = need('sun_spot').position;
  group.add(new THREE.HemisphereLight('#d6e6ff', '#5a3520', 1.05));

  const sun = new THREE.DirectionalLight(PALETTE.sun, 3.4);
  const sunDir = skyHole.clone().sub(sunSpot).normalize();
  sun.position.copy(new THREE.Vector3(0, 0, -3).addScaledVector(sunDir, 30));
  sun.target.position.set(0, 0, -3);
  group.add(sun, sun.target);
  if (q.shadows) {
    sun.castShadow = true;
    const size = q.tier === 'high' ? 4096 : 2048;
    sun.shadow.mapSize.set(size, size);
    const c = sun.shadow.camera;
    c.left = -21; c.right = 21; c.top = 21; c.bottom = -21; c.near = 5; c.far = 60;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.05;
  }

  const fire = new THREE.PointLight(PALETTE.ember, 42, 20, 1.8);
  fire.position.copy(need('fire').position);
  group.add(fire);

  // Extra point lights from anchors, lamps first, capped per quality tier.
  const pointBudget = q.tier === 'high' ? 8 : q.tier === 'medium' ? 5 : 2;
  const extraLights = [...anchors.entries()]
    .filter(([k]) => k.startsWith('light_'))
    .sort(([a], [b]) => (a.includes('lamp') ? 0 : 1) - (b.includes('lamp') ? 0 : 1))
    .slice(0, pointBudget);
  for (const [, a] of extraLights) {
    const e = a.extras as { color?: string; intensity?: number; range?: number };
    const l = new THREE.PointLight(e.color ?? PALETTE.lamp, e.intensity ?? 10, e.range ?? 9, 1.8);
    l.position.copy(a.position);
    group.add(l);
  }

  // --- The sunbeam: a soft additive cone from the opening to the garden.
  const shaftLen = skyHole.distanceTo(sunSpot);
  const shaftGeo = new THREE.CylinderGeometry(2.6, 3.4, shaftLen, 32, 1, true);
  shaftGeo.translate(0, -shaftLen / 2, 0);
  const shaftMat = new THREE.MeshBasicNodeMaterial({
    color: PALETTE.sun,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  shaftMat.opacityNode = uv().y.pow(2.0).mul(0.13);
  const shaft = new THREE.Mesh(shaftGeo, shaftMat);
  shaft.position.copy(skyHole);
  shaft.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), sunSpot.clone().sub(skyHole).normalize());
  group.add(shaft);

  // --- Dust motes drifting down the beam.
  const rand = mulberry32(7);
  const moteMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.sun).multiplyScalar(1.6), transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false });
  const motes = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.035, 0), moteMat, q.motes);
  motes.frustumCulled = false;
  const seeds = Array.from({ length: q.motes }, () => ({ t: rand(), r: Math.sqrt(rand()) * 2.8, a: rand() * Math.PI * 2, s: 0.3 + rand() * 0.7 }));
  group.add(motes);
  const beam = sunSpot.clone().sub(skyHole);
  const side = new THREE.Vector3().crossVectors(beam, new THREE.Vector3(0, 1, 0)).normalize();
  const up = new THREE.Vector3().crossVectors(side, beam).normalize();
  const m4 = new THREE.Matrix4();
  const p = new THREE.Vector3();

  // --- The minecart: gather its parts into one group so it can ride the rail.
  const rail = [...anchors.entries()]
    .filter(([k]) => k.startsWith('rail_'))
    .sort(([a], [b]) => Number(a.slice(5)) - Number(b.slice(5)))
    .map(([, a]) => a.position);
  const cart = new THREE.Group();
  if (rail.length > 1) {
    cart.position.copy(rail[0]!);
    cart.lookAt(rail[1]!);
    group.add(cart);
    cart.updateMatrixWorld(true);
    for (const [name, o] of parts) if (name.startsWith('minecart')) cart.attach(o);
  }
  const railLen: number[] = [0];
  for (let i = 1; i < rail.length; i++) railLen.push(railLen[i - 1]! + rail[i]!.distanceTo(rail[i - 1]!));
  const total = railLen[railLen.length - 1] ?? 0;
  let cartT = -1; // seconds into the trip, -1 = parked
  const tripOut = 4.5;
  const tripPause = 2.5;
  const look = new THREE.Vector3();
  function railAt(d: number, out: THREE.Vector3): THREE.Vector3 {
    let i = 1;
    while (i < railLen.length - 1 && railLen[i]! < d) i++;
    const seg = railLen[i]! - railLen[i - 1]!;
    return out.lerpVectors(rail[i - 1]!, rail[i]!, seg > 0 ? (d - railLen[i - 1]!) / seg : 0);
  }

  let flareLeft = 0;
  let heat = 0;
  let heatShown = 0;
  let pileTarget = 1;
  const pile = parts.get('gold_pile');
  const pileRest = pile?.scale.clone();

  const crystalMat = materials.get('glow_crystal') as THREE.MeshToonNodeMaterial | undefined;
  const emberMat = materials.get('glow_ember') as THREE.MeshToonNodeMaterial | undefined;

  function update(t: number, dt: number): void {
    flareLeft = Math.max(0, flareLeft - dt);
    heatShown += (heat - heatShown) * (1 - Math.exp(-0.8 * dt));
    const roar = (0.8 + heatShown * 0.7) * (1 + Math.min(1, flareLeft) * 1.4);
    if (pile && pileRest) {
      // Squash the mound down as the week's allowance is spent; never quite to nothing.
      const k = 0.18 + 0.82 * pileTarget;
      const cur = pile.scale.y / pileRest.y;
      const next = cur + (k - cur) * (1 - Math.exp(-1.5 * dt));
      pile.scale.set(pileRest.x * (0.55 + 0.45 * next), pileRest.y * next, pileRest.z * (0.55 + 0.45 * next));
    }
    if (cartT >= 0 && total > 0) {
      cartT += dt;
      // Out (ease in-out), pause in the dark, then back.
      const k = cartT < tripOut ? cartT / tripOut : cartT < tripOut + tripPause ? 1 : 1 - (cartT - tripOut - tripPause) / tripOut;
      const e = Math.max(0, Math.min(1, k));
      const d = e * e * (3 - 2 * e) * total;
      railAt(d, cart.position);
      railAt(Math.min(total, d + 0.3), look);
      if (look.distanceToSquared(cart.position) > 1e-4) cart.lookAt(look);
      if (cartT > tripOut * 2 + tripPause) cartT = -1;
    }
    fire.intensity = roar * 40 + Math.sin(t * 7.3) * 4.5 + Math.sin(t * 13.1) * 2.5 + Math.sin(t * 2.1) * 6;
    if (emberMat) emberMat.emissiveIntensity = roar * (2.4 + Math.sin(t * 5.7) * 0.3 + Math.sin(t * 11.3) * 0.15);
    if (crystalMat) crystalMat.emissiveIntensity = 1.2 + Math.sin(t * 0.9) * 0.25;

    for (let i = 0; i < seeds.length; i++) {
      const s = seeds[i]!;
      s.t = (s.t + dt * 0.012 * s.s) % 1;
      s.a += dt * 0.15 * s.s;
      const radius = s.r * (0.8 + s.t * 0.35);
      p.copy(skyHole).addScaledVector(beam, s.t)
        .addScaledVector(side, Math.cos(s.a) * radius)
        .addScaledVector(up, Math.sin(s.a) * radius);
      m4.makeTranslation(p.x, p.y, p.z);
      motes.setMatrixAt(i, m4);
    }
    motes.instanceMatrix.needsUpdate = true;
  }

  return {
    group, anchors, parts, sun, update,
    flare: (seconds = 2.5) => { flareLeft = seconds; },
    setTreasury: (remaining) => { pileTarget = Math.max(0, Math.min(1, remaining)); },
    setHeat: (h) => { heat = Math.max(0, Math.min(1, h)); },
    sendCart: () => { if (cartT < 0) cartT = 0; },
  };
}
