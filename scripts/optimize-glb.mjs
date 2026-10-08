// Shrinks a Blender-exported GLB for phones: dedup, prune, quantize, meshopt-compress.
// Usage: node scripts/optimize-glb.mjs <in.glb> [out.glb]
import { statSync } from 'node:fs';
import { NodeIO, PropertyType } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { dedup, meshopt, prune } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

const [input, output = input] = process.argv.slice(2);
if (!input) {
  console.error('usage: node scripts/optimize-glb.mjs <in.glb> [out.glb]');
  process.exit(1);
}

await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });

const before = statSync(input).size;
const doc = await io.read(input);
// Materials are deliberately not deduplicated: they are identical placeholders whose *names*
// are the slots the client recolours. keepLeaves: anchors are empty nodes looked up by name.
await doc.transform(
  dedup({ propertyTypes: [PropertyType.ACCESSOR, PropertyType.MESH, PropertyType.TEXTURE] }),
  prune({ keepLeaves: true, keepAttributes: true }),
  meshopt({ encoder: MeshoptEncoder, level: 'medium', quantizeColor: 8, quantizeNormal: 8, quantizePosition: 14 }),
);
doc.createExtension(EXTMeshoptCompression).setRequired(true);
await io.write(output, doc);
const after = statSync(output).size;
console.log(`[optimize] ${input} ${(before / 1024).toFixed(0)} KB -> ${(after / 1024).toFixed(0)} KB`);
