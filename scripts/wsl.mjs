// Runs a command inside WSL. The distro defaults to "Ubuntu"; set DEEPANVIL_WSL_DISTRO to change it.
// Usage: node scripts/wsl.mjs <command> [args...]
import { spawnSync } from 'node:child_process';

const distro = process.env.DEEPANVIL_WSL_DISTRO || 'Ubuntu';
const res = spawnSync('wsl', ['-d', distro, '--', ...process.argv.slice(2)], { stdio: 'inherit' });
if (res.error) {
  console.error(`Could not run WSL (${distro}): ${res.error.message}`);
  process.exit(1);
}
process.exit(res.status ?? 1);
