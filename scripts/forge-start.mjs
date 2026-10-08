// Starts the always-on forge now (same launcher Windows runs at logon).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const vbs = join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Deepanvil Forge.vbs');
if (!existsSync(vbs)) {
  console.error('Launcher not installed. Run: npm run forge:install');
  process.exit(1);
}
spawn('wscript.exe', [vbs], { detached: true, stdio: 'ignore' }).unref();
console.log('forge starting — npm run forge:log to watch');
