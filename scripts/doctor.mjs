// `npm run doctor`: checks everything Deepanvil needs and says what to do about anything missing.
// Read-only: it never installs or changes anything. Run it from the repo root on Windows.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const distro = process.env.DEEPANVIL_WSL_DISTRO || 'Ubuntu';
const results = [];
const check = (level, name, ok, fix = '') => results.push({ level, name, ok, fix });

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 60_000, ...opts });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.replace(/\0/g, '').trim() };
};
const inWsl = (script) => run('wsl', ['-d', distro, '--', 'bash', '-lc', script]);

// --- Windows side
const winMajor = Number(process.versions.node.split('.')[0]);
check('required', `Node ${process.versions.node} on Windows (22+ for the client)`, winMajor >= 22, 'Install Node 22+ (24 recommended) on Windows.');
check('required', 'npm dependencies installed', existsSync('node_modules/three') && existsSync('node_modules/@anthropic-ai/claude-agent-sdk'), 'Run: npm install');
check('required', 'client production build (apps/client/dist)', existsSync('apps/client/dist/index.html'), 'Run: npm run build');
check('required', 'git', run('git', ['--version']).ok, 'Install Git for Windows.');

// --- WSL side
const wsl = inWsl('echo ok');
check('required', `WSL distro "${distro}"`, wsl.ok && wsl.out.includes('ok'), `Install WSL with Ubuntu (wsl --install -d Ubuntu), or set DEEPANVIL_WSL_DISTRO.`);
if (wsl.ok) {
  const node = inWsl('source scripts/wsl-env.sh && node -v');
  check('required', `Node 24+ inside WSL ${node.ok ? `(${node.out.split('\n').pop()})` : ''}`, node.ok, node.out.split('\n').pop() || 'Install Node 24+ inside WSL (e.g. via nvm).');
  check('required', 'git inside WSL', inWsl('git --version').ok, 'sudo apt install git');
  const engine = inWsl('test -x ~/.deepanvil/engine/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude');
  check('required', 'Agent SDK Linux engine (~/.deepanvil/engine)', engine.ok, 'In WSL: bash scripts/setup-engine.sh');
  const login = inWsl('test -s ~/.claude/.credentials.json || test -n "$ANTHROPIC_API_KEY"');
  check('required', 'Claude login inside WSL', login.ok, 'In WSL: run `claude` once and log in (or export ANTHROPIC_API_KEY for the forge).');
  const sandbox = inWsl('command -v bwrap && command -v socat');
  check('recommended', 'OS sandbox for smiths (bubblewrap + socat)', sandbox.ok, 'In WSL: sudo apt install bubblewrap socat');
  const repo = inWsl('test -d "${DEEPANVIL_REPO:-$HOME/deepanvil/forge/sandbox}/.git"');
  check('recommended', 'a repo for the crew (default: the practice sandbox)', repo.ok, 'In WSL: bash scripts/setup-sandbox.sh (or set DEEPANVIL_REPO)');
}

// --- The running forge and optional extras
let forge = false;
try {
  forge = JSON.parse(execFileSync('curl', ['-s', '--max-time', '3', 'http://localhost:8787/health'], { encoding: 'utf8' })).ok === true;
} catch {
  /* not running */
}
check('recommended', 'forge running on http://localhost:8787', forge, 'npm run forge:install && npm run forge:start (or: npm run server)');
check('optional', 'Blender 5.2 (only to rebuild the 3D assets)', existsSync(process.env.BLENDER ?? 'C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe'), 'Install Blender, or set BLENDER to its path. The built assets are already in the repo.');
check('optional', 'Tailscale (phone access)', run('tailscale', ['version']).ok, 'Install Tailscale, then: tailscale serve --bg http://localhost:8787');

// --- Report
const icon = { true: '✓', false: { required: '✗', recommended: '!', optional: '·' } };
let missing = 0;
for (const r of results) {
  const mark = r.ok ? icon.true : icon.false[r.level];
  console.log(`${mark} ${r.name}${r.ok ? '' : `  [${r.level}]\n    → ${r.fix}`}`);
  if (!r.ok && r.level === 'required') missing++;
}
console.log(missing ? `\n${missing} required item(s) missing.` : '\nReady to forge.');
process.exit(missing ? 1 : 0);
