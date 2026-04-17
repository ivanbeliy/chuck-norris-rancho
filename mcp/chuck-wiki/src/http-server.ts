import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runWithIdentity } from './identity.js';

export interface HttpServerOpts {
  port: number;
  bind: string;
  secret: string;
  createMcpServer: () => McpServer;
}

const MAX_BODY_BYTES = 2 * 1024 * 1024;

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const b = chunk as Buffer;
    total += b.length;
    if (total > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function sendJson(res: http.ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

export async function startHttpServer(opts: HttpServerOpts): Promise<void> {
  // Per-session transport: key = mcp-session-id.
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const expectedAuth = `Bearer ${opts.secret}`;

  const httpServer = http.createServer(async (req, res) => {
    // Route: only POST /mcp (and DELETE /mcp for session teardown) is handled.
    const url = req.url ?? '/';
    if (!url.startsWith('/mcp')) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }

    // Auth
    const authHeader = req.headers['authorization'];
    if (authHeader !== expectedAuth) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    // Identity
    const identityHeader = req.headers['x-chuck-client'];
    const identity = Array.isArray(identityHeader) ? identityHeader[0] : (identityHeader ?? 'unknown');

    // DELETE = session teardown; GET = SSE stream (not implemented — client doesn't need it for one-shot tool calls)
    if (req.method === 'GET' || req.method === 'DELETE') {
      const sid = req.headers['mcp-session-id'];
      const sessionId = Array.isArray(sid) ? sid[0] : sid;
      if (!sessionId || !transports.has(sessionId)) {
        sendJson(res, 400, { error: 'invalid or missing session id' });
        return;
      }
      const transport = transports.get(sessionId)!;
      await runWithIdentity(identity, async () => {
        await transport.handleRequest(req, res);
      });
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST, GET, DELETE' }).end();
      return;
    }

    // Read and parse body
    let body: string;
    try {
      body = await readBody(req);
    } catch (err) {
      sendJson(res, 413, { error: (err as Error).message });
      return;
    }
    let parsed: unknown;
    try {
      parsed = body.length > 0 ? JSON.parse(body) : undefined;
    } catch {
      sendJson(res, 400, { error: 'invalid json' });
      return;
    }

    // Session mgmt
    const sidHeader = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(sidHeader) ? sidHeader[0] : sidHeader;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports.has(sessionId)) {
      transport = transports.get(sessionId)!;
    } else if (!sessionId && isInitializeRequest(parsed)) {
      // New session
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId);
      };
      const mcp = opts.createMcpServer();
      await mcp.connect(transport);
    } else {
      sendJson(res, 400, {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: no valid session ID or not an initialize request' },
        id: null,
      });
      return;
    }

    // Dispatch with identity context
    await runWithIdentity(identity, async () => {
      await transport.handleRequest(req, res, parsed);
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.on('error', reject);
    httpServer.listen(opts.port, opts.bind, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });
}
