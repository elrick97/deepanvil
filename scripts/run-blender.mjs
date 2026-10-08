// Runs Blender with the given arguments. Override the binary with the BLENDER env var.
import { spawnSync } from 'node:child_process';

const blender = process.env.BLENDER ?? 'C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe';
const res = spawnSync(blender, process.argv.slice(2), { stdio: 'inherit' });
if (res.error) {
  console.error(`Could not start Blender at "${blender}": ${res.error.message}`);
  process.exit(1);
}
process.exit(res.status ?? 1);
