import { createServer, type IncomingMessage } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { CREW, type ClientCommand, type Envelope, type ForgeEvent } from '@deepanvil/shared';
import { SANDBOX_READY } from './agents/engine.ts';
import { Forge } from './agents/orchestrator.ts';
import { startMockForge } from './mock.ts';
import { staticHandler } from './static.ts';
import { Pusher } from './push.ts';
import { Store } from './store.ts';

const PORT = Number(process.env.PORT ?? 8787);
// MOCK=1 plays the quest simulator; otherwise the forge is live and idles until you ask.
const MOCK = process.env.MOCK === '1';
const REPO = process.env.DEEPANVIL_REPO ?? join(homedir(), 'deepanvil', 'forge', 'sandbox');
const SMITHS = Number(process.env.DEEPANVIL_SMITHS ?? 2);

let seq = 0;
const clients = new Set<WebSocket>();

// State-bearing events of the current quest, replayed to anyone who connects mid-quest
// (e.g. opening the phone) so the banner and the crew's positions are right.
const STATEFUL = new Set<ForgeEvent['type']>([
  'blueprint.proposed', 'blueprint.approved', 'task.assigned', 'task.done', 'escalation',
  'permission.request', 'permission.resolved', 'merge',
  'offering.opened', 'offering.state', 'offering.gate', 'offering.review', 'offering.merged',
]);
let questLog: string[] = [];
// Each dwarf's recent transcript (agent speech, commands, output tails), replayed on connect.
const TRANSCRIPT_KEEP = 80;
const transcripts = new Map<string, string[]>();
// Each dwarf's latest to-do list (a chalkboard), replayed on connect.
const todos = new Map<string, string>();
// Latest gauges, so a phone that connects later sees the treasury and limits at once.
const latest = new Map<string, string>();
const GAUGES = new Set<ForgeEvent['type']>(['limits', 'ledger', 'forge.status', 'history', 'vault.health']);

function envelope(event: ForgeEvent): string {
  const env: Envelope = { seq: ++seq, at: Date.now(), event };
  return JSON.stringify(env);
}

const store = MOCK ? undefined : new Store();
const pusher = store ? new Pusher(store) : undefined;

export function broadcast(event: ForgeEvent): void {
  pusher?.notifyFor(event);
  const msg = envelope(event);
  if (event.type === 'blueprint.proposed') {
    questLog = [];
    transcripts.clear();
    todos.clear();
  }
  if (event.type === 'dwarf.todos') todos.set(event.dwarfId, msg);
  if (event.type === 'task.done' || event.type === 'task.assigned') todos.delete(event.dwarfId);
  if (event.type === 'dwarf.log') {
    const list = transcripts.get(event.dwarfId) ?? [];
    list.push(msg);
    if (list.length > TRANSCRIPT_KEEP) list.shift();
    transcripts.set(event.dwarfId, list);
  }
  if (STATEFUL.has(event.type)) questLog.push(msg);
  if (GAUGES.has(event.type)) latest.set(event.type, msg);
  for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(msg);
}

/**
 * Browsers attach Origin to WebSocket handshakes and POSTs. Only the forge's own page may
 * drive it: otherwise any website open on this PC could open ws://localhost:8787 and order
 * quests or answer the bell (cross-site WebSocket hijacking / CSRF). Non-browser clients
 * (curl, tests) send no Origin and are allowed: they already have local access.
 */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

const serveClient = staticHandler(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'client', 'dist'));

const http = createServer(async (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, clients: clients.size, seq, mode: MOCK ? 'mock' : 'live', sandbox: SANDBOX_READY, node: process.version, platform: process.platform }));
    return;
  }
  // Notification buttons (Allow / Deny) answer the bell without opening the app.
  if (req.method === 'POST' && req.url === '/api/answer' && forge) {
    // JSON-only + same-origin: a cross-site form can't send this content type without a preflight.
    if (!sameOrigin(req) || !String(req.headers['content-type'] ?? '').startsWith('application/json')) {
      res.writeHead(403).end();
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { requestId, approved } = JSON.parse(body) as { requestId: string; approved: boolean };
      forge.handle({ type: 'permission.answer', requestId: String(requestId), approved: approved === true });
      res.writeHead(204).end();
    } catch {
      res.writeHead(400).end();
    }
    return;
  }
  if (await serveClient(req, res).catch(() => false)) return;
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 256 * 1024, verifyClient: ({ req }: { req: IncomingMessage }) => sameOrigin(req) });
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(envelope({ type: 'hello', serverTime: Date.now(), crew: CREW }));
  if (pusher) ws.send(envelope({ type: 'push.config', publicKey: pusher.publicKey }));
  for (const msg of questLog) ws.send(msg);
  for (const list of transcripts.values()) for (const msg of list) ws.send(msg);
  for (const msg of todos.values()) ws.send(msg);
  for (const msg of latest.values()) ws.send(msg);
  ws.on('message', (data) => {
    if (!forge) return;
    try {
      const cmd = JSON.parse(String(data)) as ClientCommand;
      if (cmd.type === 'push.subscribe') return pusher?.subscribe(cmd.subscription);
      forge.handle(cmd);
    } catch (err) {
      console.error('[deepanvil] bad command', err);
    }
  });
  ws.on('close', () => clients.delete(ws));
});

const SANDBOX_REPO = join(homedir(), 'deepanvil', 'forge', 'sandbox');
const forge = store ? new Forge(broadcast, { repo: REPO, smiths: SMITHS, defaultMode: REPO === SANDBOX_REPO ? 'auto' : 'approve' }, store) : undefined;

http.listen(PORT, () => {
  console.log(`[deepanvil] forge listening on :${PORT} (${process.platform}, node ${process.version})`);
  if (MOCK) {
    broadcast({ type: 'forge.status', mode: 'mock', repo: '(simulator)', smiths: CREW.filter((d) => d.role === 'smith').length, busy: true });
    startMockForge(broadcast);
  } else {
    console.log(`[deepanvil] live forge: repo ${REPO}, ${SMITHS} smiths`);
    if (!SANDBOX_READY) console.warn('[deepanvil] WARNING: OS sandbox unavailable (need bwrap + socat) — smiths are limited by the permission allowlist only.');
    void forge!.recover();
  }
});
