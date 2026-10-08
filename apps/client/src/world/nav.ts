import * as THREE from 'three/webgpu';

// Walking routes for the crew. The hall is a ring of workstations around the furnace,
// so instead of a navmesh every trip goes: sidestep off the anvil line -> out to a
// walkway ring -> around the ring -> in to the destination. Cheap, and it never
// clips through anvils, the furnace or the drafting table.

const FURNACE = new THREE.Vector2(0, -9);
const RING = 11;           // walkway radius: outside the anvils (r=9), inside most props
const INNER = 10;          // anything closer than this to the furnace is "at the anvils"
const STEP = 0.22;         // radians between ring waypoints

const angleOf = (p: THREE.Vector3) => Math.atan2(p.z - FURNACE.y, p.x - FURNACE.x);
const radiusOf = (p: THREE.Vector3) => Math.hypot(p.x - FURNACE.x, p.z - FURNACE.y);
const onCircle = (a: number, r: number) => new THREE.Vector3(FURNACE.x + Math.cos(a) * r, 0, FURNACE.y + Math.sin(a) * r);

function shortestDelta(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Waypoints from `from` to `to` (both on the floor). The last point is `to`. */
export function route(from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3[] {
  if (from.distanceTo(to) < 2.5) return [to.clone()];
  const a0 = angleOf(from);
  const a1 = angleOf(to);
  const d = shortestDelta(a0, a1);
  const dir = Math.sign(d) || 1;
  const pts: THREE.Vector3[] = [];

  // Leaving the anvil circle: sidestep toward the destination, then walk out between anvils.
  let a = a0;
  if (radiusOf(from) < INNER) {
    a = a0 + dir * 0.13;
    pts.push(onCircle(a, radiusOf(from) + 0.2));
  }
  const endA = radiusOf(to) < INNER ? a1 - dir * 0.13 : a1;
  pts.push(onCircle(a, RING));
  const span = shortestDelta(a, endA);
  const n = Math.floor(Math.abs(span) / STEP);
  for (let i = 1; i <= n; i++) pts.push(onCircle(a + Math.sign(span) * i * STEP, RING));
  pts.push(onCircle(endA, RING));
  if (radiusOf(to) < INNER) pts.push(onCircle(endA, radiusOf(to) + 0.2));
  pts.push(to.clone());
  return pts;
}
