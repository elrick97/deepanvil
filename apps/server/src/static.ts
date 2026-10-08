import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

// Serves the production client build (apps/client/dist, made by `npm run build` on
// Windows) so the always-on forge is one process: page, assets and WebSocket on one origin.

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

// Text compresses ~4x (the three.js bundle: 1 MB -> 0.3 MB); models are already meshopt-packed.
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg', '.webmanifest']);

export function staticHandler(root: string) {
  const base = resolve(root);
  const gzCache = new Map<string, { mtime: number; body: Buffer }>();
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const url = new URL(req.url ?? '/', 'http://forge');
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = normalize(join(base, rel));
    if (file !== base && !file.startsWith(base + sep)) return false; // no escaping the build directory (incl. ../dist-x)

    let path = file;
    let info = await stat(path).catch(() => undefined);
    if (!info?.isFile()) {
      // Unknown routes get the app shell; unknown files are a real 404.
      if (extname(rel)) return false;
      path = join(base, 'index.html');
      info = await stat(path).catch(() => undefined);
      if (!info?.isFile()) return false;
    }
    // Vite's hashed bundles never change; everything else revalidates (models get rebuilt).
    const hashed = /\/assets\/.+-[\w-]{8,}\.(js|css)$/.test(path);
    const gzip = COMPRESSIBLE.has(extname(path)) && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
    if (gzip) {
      let hit = gzCache.get(path);
      if (!hit || hit.mtime !== info.mtimeMs) gzCache.set(path, (hit = { mtime: info.mtimeMs, body: gzipSync(await readFile(path)) }));
      res.writeHead(200, {
        'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
        'content-encoding': 'gzip',
        'content-length': hit.body.length,
        vary: 'accept-encoding',
        'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      });
      res.end(req.method === 'HEAD' ? undefined : hit.body);
      return true;
    }
    res.writeHead(200, {
      'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    if (req.method === 'HEAD') res.end();
    else createReadStream(path).pipe(res);
    return true;
  };
}
