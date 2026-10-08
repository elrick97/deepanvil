import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { toon } from './toon.ts';

// Forge moments: sparks (hammering), soft steam puffs (tests pass), cinders (tests
// fail), and gold coins arcing from the treasury to whoever is spending tokens.
// Particle colours go above 1.0 so the bloom pass catches them.

interface Particle {
  alive: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  size: number;
  grow: number;
  gravity: number;
  drag: number;
  color: THREE.Color;
}

export type Burst = 'sparks' | 'steam' | 'cinders';

/** A fixed-size pool of additive particles drawn as one instanced mesh. */
class Pool {
  readonly mesh: THREE.InstancedMesh;
  private ps: Particle[] = [];
  private cursor = 0;
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();
  private c = new THREE.Color();
  private black = new THREE.Color(0, 0, 0);

  constructor(geo: THREE.BufferGeometry, size: number) {
    const mat = new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    this.mesh = new THREE.InstancedMesh(geo, mat, size);
    this.mesh.frustumCulled = false;
    for (let i = 0; i < size; i++) {
      this.ps.push({ alive: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(), life: 0, maxLife: 1, size: 0, grow: 0, gravity: 0, drag: 0, color: new THREE.Color() });
      this.mesh.setMatrixAt(i, this.m4.makeScale(0, 0, 0));
      this.mesh.setColorAt(i, this.black);
    }
  }

  next(): Particle {
    const p = this.ps[this.cursor]!;
    this.cursor = (this.cursor + 1) % this.ps.length;
    p.alive = true;
    p.life = 0;
    return p;
  }

  update(dt: number): void {
    let top = -1;
    for (let i = 0; i < this.ps.length; i++) {
      const p = this.ps[i]!;
      if (!p.alive) continue;
      p.life += dt;
      if (p.life >= p.maxLife || p.size <= 0) {
        p.alive = false;
        this.mesh.setMatrixAt(i, this.m4.makeScale(0, 0, 0));
        this.mesh.setColorAt(i, this.black);
        continue;
      }
      top = i;
      p.vel.y += p.gravity * dt;
      p.vel.multiplyScalar(Math.max(0, 1 - p.drag * dt));
      p.pos.addScaledVector(p.vel, dt);
      if (p.pos.y < 0.02) { p.pos.y = 0.02; p.vel.y *= -0.3; }
      p.size = Math.max(0, p.size + p.grow * dt);
      // Fade in quickly, out slowly.
      const k = p.life / p.maxLife;
      const fade = Math.min(1, k * 8) * (1 - k) * (1 - k);
      this.s.setScalar(p.size);
      this.mesh.setMatrixAt(i, this.m4.compose(p.pos, this.q, this.s));
      this.mesh.setColorAt(i, this.c.copy(p.color).multiplyScalar(fade));
    }
    // Instanced meshes draw every slot, hidden or not: only draw up to the last live one.
    this.mesh.count = top + 1;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

interface Coin {
  from: THREE.Vector3;
  to: THREE.Vector3;
  t0: number;
  dur: number;
  spin: number;
}

export class Fx {
  readonly group = new THREE.Group();
  private sparks = new Pool(new THREE.OctahedronGeometry(1, 0), 500);
  private puffs = new Pool(new THREE.IcosahedronGeometry(1, 2), 220);
  private coins: (Coin | null)[] = new Array(80).fill(null);
  private coinMesh: THREE.InstancedMesh;
  private now = 0;
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private v = new THREE.Vector3();
  private coinScale = new THREE.Vector3(0.13, 0.13, 0.13);

  /** `coinGeo`: the forge's coin model (assets/src/build_coin.py), radius 1 around Y. */
  constructor(coinGeo?: THREE.BufferGeometry) {
    const geo = coinGeo ?? new THREE.CylinderGeometry(1, 1, 0.16, 16);
    const coinMat = toon('#ffc94d', { vertexColors: !!coinGeo?.attributes.color, emissive: new THREE.Color('#ffb020'), emissiveIntensity: 0.9 });
    this.coinMesh = new THREE.InstancedMesh(geo, coinMat, this.coins.length);
    this.coinMesh.frustumCulled = false;
    for (let i = 0; i < this.coins.length; i++) this.coinMesh.setMatrixAt(i, this.m4.makeScale(0, 0, 0));
    this.group.add(this.sparks.mesh, this.puffs.mesh, this.coinMesh);
  }

  burst(kind: Burst, at: THREE.Vector3): void {
    if (kind === 'steam') {
      for (let i = 0; i < 16; i++) {
        const p = this.puffs.next();
        p.pos.copy(at).add(this.v.set((Math.random() - 0.5) * 0.5, 0, (Math.random() - 0.5) * 0.5));
        p.vel.set((Math.random() - 0.5) * 0.6, 1.1 + Math.random() * 1.2, (Math.random() - 0.5) * 0.6);
        p.maxLife = 1.6 + Math.random() * 1.0;
        p.size = 0.08 + Math.random() * 0.06;
        p.grow = 0.32;
        p.gravity = 0.3;
        p.drag = 1.1;
        p.color.setRGB(0.16, 0.18, 0.2);
      }
      return;
    }
    const n = kind === 'sparks' ? 24 : 16;
    for (let i = 0; i < n; i++) {
      const p = this.sparks.next();
      p.pos.copy(at);
      if (kind === 'sparks') {
        p.vel.set((Math.random() - 0.5) * 6, 2 + Math.random() * 5, (Math.random() - 0.5) * 6);
        p.maxLife = 0.5 + Math.random() * 0.5;
        p.size = 0.05 + Math.random() * 0.04;
        p.grow = -0.06;
        p.gravity = -14;
        p.drag = 0.6;
        p.color.setRGB(3.5, 1.6 + Math.random() * 0.8, 0.4);
      } else {
        p.vel.set((Math.random() - 0.5) * 2.5, 0.8 + Math.random() * 1.5, (Math.random() - 0.5) * 2.5);
        p.maxLife = 0.8 + Math.random() * 0.6;
        p.size = 0.07 + Math.random() * 0.05;
        p.grow = -0.04;
        p.gravity = -5;
        p.drag = 0.8;
        p.color.setRGB(2.6, 0.35, 0.25);
      }
    }
  }

  /** Coins arcing from `from` to `to`, staggered: the visible cost of a model call. */
  coinsTo(from: THREE.Vector3, to: THREE.Vector3, count: number): void {
    for (let k = 0; k < count; k++) {
      const slot = this.coins.findIndex((c) => c === null);
      if (slot < 0) return;
      this.coins[slot] = {
        from: from.clone().add(this.v.set((Math.random() - 0.5) * 0.6, 0, (Math.random() - 0.5) * 0.6)),
        to: to.clone(),
        t0: this.now + k * 0.12,
        dur: 1.1 + Math.random() * 0.3,
        spin: 6 + Math.random() * 6,
      };
    }
  }

  update(t: number, dt: number): void {
    this.now = t;
    this.sparks.update(dt);
    this.puffs.update(dt);
    let top = -1;
    for (let i = 0; i < this.coins.length; i++) {
      const c = this.coins[i];
      if (!c) continue;
      top = i;
      const k = (t - c.t0) / c.dur;
      if (k >= 1) {
        this.coins[i] = null;
        this.coinMesh.setMatrixAt(i, this.m4.makeScale(0, 0, 0));
        continue;
      }
      if (k < 0) continue;
      const ease = k * k * (3 - 2 * k);
      this.v.lerpVectors(c.from, c.to, ease);
      this.v.y += Math.sin(Math.PI * k) * (1.8 + c.from.distanceTo(c.to) * 0.12);
      this.q.setFromEuler(this.e.set(t * c.spin, 0, 0.4)); // tumble end over end so the emblem flashes
      this.coinMesh.setMatrixAt(i, this.m4.compose(this.v, this.q, this.coinScale));
    }
    this.coinMesh.count = top + 1;
    this.coinMesh.instanceMatrix.needsUpdate = true;
  }
}

/** The coin model's geometry (falls back to a plain disc if the asset is missing). */
export async function loadCoin(url = '/assets/coin.glb'): Promise<THREE.BufferGeometry | undefined> {
  try {
    const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(url);
    let geo: THREE.BufferGeometry | undefined;
    gltf.scene.traverse((o) => {
      if (!geo && (o as THREE.Mesh).isMesh) geo = (o as THREE.Mesh).geometry;
    });
    return geo;
  } catch {
    return undefined;
  }
}
