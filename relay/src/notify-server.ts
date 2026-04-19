/**
 * Tiny HTTP server that local scripts POST to when they want to notify
 * a project's channel. Binds to loopback only; no external deps
 * beyond Node's built-in `http`.
 *
 * POST /notify
 *   body: {"project":"<name>","content":"...","level":"info|warn|error"}
 *   optional header: X-Relay-Token: <shared secret from env>
 *   response: 204 on success, 4xx/5xx on errors (plain text)
 *
 * GET /healthz
 *   200 OK (for launchd / watchdog)
 */

import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { sendToProjectChannel, NotifyLevel } from './notify.js';

const MAX_BODY = 8 * 1024;

let server: Server | null = null;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, code: number, text: string): void {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

export function start(port: number, token?: string): void {
  server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/healthz') {
        return send(res, 200, 'ok\n');
      }
      if (req.method !== 'POST' || req.url !== '/notify') {
        return send(res, 404, 'not found\n');
      }
      if (token) {
        const got = req.headers['x-relay-token'];
        if (got !== token) return send(res, 401, 'unauthorized\n');
      }

      const raw = await readBody(req);
      let payload: any;
      try {
        payload = JSON.parse(raw);
      } catch {
        return send(res, 400, 'invalid json\n');
      }
      const { project, content, level } = payload || {};
      if (typeof project !== 'string' || typeof content !== 'string' || !project || !content) {
        return send(res, 400, 'missing project or content\n');
      }
      const lvl: NotifyLevel =
        level === 'warn' || level === 'error' ? level : 'info';

      await sendToProjectChannel(project, content, lvl);
      return send(res, 204, '');
    } catch (err: any) {
      console.error(
        `[${new Date().toISOString()}] notify server error:`,
        err?.message ?? err,
      );
      return send(res, 500, (err?.message ?? 'error') + '\n');
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(
      `[${new Date().toISOString()}] Notify server listening on 127.0.0.1:${port}`,
    );
  });

  server.on('error', (err) => {
    console.error(
      `[${new Date().toISOString()}] Notify server failed:`,
      err.message,
    );
  });
}

export async function stop(): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
}
