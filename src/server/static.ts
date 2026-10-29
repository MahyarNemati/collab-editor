import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Serve the built client. Single-page fallback to `index.html`.
 *
 * Path handling is allow-by-containment: resolve the candidate and require it
 * to sit under the root, which rejects `..` and absolute escapes without
 * trying to enumerate the ways of writing them.
 */
export async function serveStatic(
  root: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const requested = decodeURIComponent(url.pathname);
  const rootResolved = resolve(root);
  const candidate = resolve(join(rootResolved, normalize(requested)));
  if (
    candidate !== rootResolved &&
    !candidate.startsWith(rootResolved + sep)
  ) {
    return false;
  }

  for (const file of [candidate, join(candidate, 'index.html'), join(rootResolved, 'index.html')]) {
    try {
      const info = await stat(file);
      if (!info.isFile()) continue;
      res.writeHead(200, {
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
        'content-length': info.size,
        'cache-control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600',
      });
      createReadStream(file).pipe(res);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}
