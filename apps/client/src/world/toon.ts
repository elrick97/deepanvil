import * as THREE from 'three/webgpu';

// Shared stepped light ramp — the base of the painterly look.
// Four soft bands; the painted textures from Blender will sit on top of this.
let ramp: THREE.DataTexture | undefined;

function gradientMap(): THREE.DataTexture {
  if (ramp) return ramp;
  const steps = new Uint8Array([70, 140, 205, 255]);
  ramp = new THREE.DataTexture(steps, steps.length, 1, THREE.RedFormat);
  ramp.minFilter = THREE.NearestFilter;
  ramp.magFilter = THREE.NearestFilter;
  ramp.needsUpdate = true;
  return ramp;
}

export function toon(color: THREE.ColorRepresentation, opts: Partial<THREE.MeshToonMaterialParameters> = {}): THREE.MeshToonNodeMaterial {
  return new THREE.MeshToonNodeMaterial({ color, gradientMap: gradientMap(), ...opts });
}

/** Self-lit material that feeds the bloom pass (furnace mouth, crystals, sky opening). */
export function glow(color: THREE.ColorRepresentation, intensity = 2): THREE.MeshToonNodeMaterial {
  return toon(color, { emissive: new THREE.Color(color), emissiveIntensity: intensity });
}

/** Faceted, hand-carved look: split shared vertices so every face gets its own normal. */
export function facet<T extends THREE.BufferGeometry>(geo: T): THREE.BufferGeometry {
  const flat = geo.index ? geo.toNonIndexed() : geo;
  flat.computeVertexNormals();
  return flat;
}
