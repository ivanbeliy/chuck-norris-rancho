'use strict';
/**
 * Admin API — loopback only, on a port that is never funnelled, plus a shared
 * token. Every Chuck on this machine runs as the same uid, so the token is not
 * a boundary between agents; it is a guard against anything else on the box
 * (and a reminder that this port must never reach the funnel).
 */
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { cfg, loadAudiences, membersOf } = require('./config');
const store = require('./store');
const { buildDocument } = require('./render');

const TYPES = new Set(['html', 'react', 'md']);
const VIS = new Set(['link', 'code', 'private', 'portal']);

function json(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    let total = 0; const chunks = [];
    req.on('data', (c) => {
      total += c.length;
      if (total > max) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/** "90d" | "12w" | "6m" | "never" | ISO date -> ISO string or null. */
function parseExpiry(spec) {
  if (spec === 'never' || spec === null) return null;
  const s = String(spec == null ? `${cfg.defaultTtlDays}d` : spec).trim();
  const m = s.match(/^(\d+)\s*([dwmy])$/i);
  if (m) {
    const n = Number(m[1]);
    const mult = { d: 1, w: 7, m: 30, y: 365 }[m[2].toLowerCase()];
    return new Date(Date.now() + n * mult * 86400000).toISOString();
  }
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return new Date(t).toISOString();
  throw new Error(`bad expiry: ${spec}`);
}

/** Shareable URL. `private` artifacts only resolve on the tailnet mount. */
function urlFor(meta) {
  const origin = meta.vis === 'private' && cfg.tailnetUrl ? cfg.tailnetUrl : cfg.baseUrl;
  return `${origin}/v/${meta.slug}`;
}

/**
 * Create or update an artifact. On update, every field the caller omits keeps
 * its previous value — so `vitrina publish --update <slug> --file new.html`
 * changes the content only, not the sharing policy.
 */
function publish(payload) {
  const prev = payload.update ? store.get(payload.update) : null;
  if (payload.update && !prev) throw new Error(`unknown slug: ${payload.update}`);

  const type = payload.type || (prev ? prev.type : 'html');
  if (!TYPES.has(type)) throw new Error(`bad type: ${type}`);
  const vis = payload.vis || (prev ? prev.vis : 'link');
  if (!VIS.has(vis)) throw new Error(`bad vis: ${vis}`);

  const source = String(payload.source || '');
  if (!source.trim()) throw new Error('empty source');
  if (Buffer.byteLength(source) > cfg.maxBytes) throw new Error('source over size limit');

  const audience = payload.audience || (prev ? prev.audience : 'family');
  if (!membersOf(audience).length && audience !== 'none') {
    throw new Error(`unknown audience: ${audience} (see ${cfg.audiencesFile})`);
  }
  if (vis === 'portal' && audience === 'none') {
    throw new Error('vis=portal needs a real audience (--to family|…)');
  }
  const code = vis === 'code'
    ? String(payload.code !== undefined ? payload.code : (prev && prev.code) || '')
    : null;
  if (vis === 'code' && !/^\d{4,8}$/.test(code)) {
    throw new Error('vis=code requires a 4-8 digit --code');
  }

  const now = new Date().toISOString();
  let meta;
  if (prev) {
    meta = {
      ...prev,
      title: payload.title || prev.title,
      desc: payload.desc !== undefined ? payload.desc : prev.desc,
      type, vis, audience, code,
      project: payload.project || prev.project,
      updated_at: now,
      version: (prev.version || 1) + 1,
      expires_at: payload.expires !== undefined ? parseExpiry(payload.expires) : prev.expires_at,
    };
  } else {
    meta = {
      id: crypto.randomUUID(),
      slug: store.newSlug(),
      title: payload.title || 'Артефакт',
      desc: payload.desc || '',
      type, vis, audience, code,
      project: payload.project || 'main',
      created_at: now,
      updated_at: now,
      version: 1,
      expires_at: parseExpiry(payload.expires),
    };
  }

  const doc = buildDocument(type, source, meta.title);
  store.writeDoc(meta, doc);
  fs.writeFileSync(
    path.join(store.dirFor(meta.id), `source.${type === 'react' ? 'jsx' : type}`), source);

  for (const a of payload.assets || []) {
    const name = path.basename(String(a.name || ''));
    if (!name || name.startsWith('.')) continue;
    const dir = path.join(store.dirFor(meta.id), 'a');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), Buffer.from(a.b64 || '', 'base64'));
  }

  meta.size = Buffer.byteLength(doc);
  store.write(meta);
  return { ...meta, url: urlFor(meta) };
}

async function notifyChannel(project, content) {
  const res = await fetch(cfg.relayNotify, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cfg.relayToken ? { 'X-Relay-Token': cfg.relayToken } : {}),
    },
    body: JSON.stringify({ project, content, level: 'info' }),
  });
  if (!res.ok) throw new Error(`relay notify ${res.status}: ${(await res.text()).trim()}`);
}

/** Purge artifacts that expired more than `purgeAfterDays` ago. */
function gc(now = Date.now()) {
  const cutoff = now - cfg.purgeAfterDays * 86400000;
  const dead = store.all().filter((m) => m.expires_at && Date.parse(m.expires_at) < cutoff);
  dead.forEach((m) => store.remove(m.slug));
  return dead.map((m) => m.slug);
}

function summary(m) {
  return {
    slug: m.slug, title: m.title, project: m.project, audience: m.audience,
    vis: m.vis, type: m.type, version: m.version,
    created_at: m.created_at, updated_at: m.updated_at, expires_at: m.expires_at,
    expired: store.isExpired(m), url: urlFor(m),
  };
}

async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/healthz') { res.writeHead(200); return res.end('ok\n'); }
  if (cfg.token && req.headers['x-vitrina-token'] !== cfg.token) return json(res, 401, { error: 'unauthorized' });

  if (req.method === 'GET' && p === '/api/list') {
    const project = url.searchParams.get('project');
    const audience = url.searchParams.get('audience');
    const items = store.all()
      .filter((m) => !project || m.project === project)
      .filter((m) => !audience || m.audience === audience)
      .map(summary);
    return json(res, 200, { count: items.length, items });
  }

  if (req.method === 'GET' && p === '/api/info') {
    const meta = store.get(url.searchParams.get('slug'));
    if (!meta) return json(res, 404, { error: 'not found' });
    return json(res, 200, { ...meta, url: urlFor(meta), expired: store.isExpired(meta) });
  }

  if (req.method === 'GET' && p === '/api/hits') {
    const slug = url.searchParams.get('slug');
    if (!store.get(slug)) return json(res, 404, { error: 'not found' });
    return json(res, 200, { hits: store.hits(slug, Number(url.searchParams.get('limit') || 50)) });
  }

  if (req.method === 'GET' && p === '/api/portals') {
    const a = loadAudiences();
    return json(res, 200, {
      audiences: a.audiences || {},
      people: Object.entries(a.people || {}).map(([key, v]) => ({
        key, name: v.name, discord_id: v.discord_id,
        portal: v.portal_token ? `${cfg.baseUrl}/p/${v.portal_token}` : null,
      })),
    });
  }

  if (req.method !== 'POST') return json(res, 404, { error: 'not found' });

  const raw = await readBody(req, cfg.maxBytes + 1024 * 1024);
  let body;
  try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'invalid json' }); }

  if (p === '/api/publish') {
    const meta = publish(body);
    console.log(`[${new Date().toISOString()}] publish ${meta.slug} "${meta.title}" project=${meta.project} vis=${meta.vis} to=${meta.audience} v${meta.version}`);
    return json(res, 200, {
      slug: meta.slug, url: meta.url, version: meta.version,
      expires_at: meta.expires_at, vis: meta.vis, audience: meta.audience,
    });
  }

  if (p === '/api/revoke') {
    const ok = store.remove(body.slug);
    console.log(`[${new Date().toISOString()}] revoke ${body.slug} -> ${ok}`);
    return json(res, ok ? 200 : 404, ok ? { revoked: body.slug } : { error: 'not found' });
  }

  if (p === '/api/extend') {
    const meta = store.get(body.slug);
    if (!meta) return json(res, 404, { error: 'not found' });
    meta.expires_at = parseExpiry(body.expires);
    store.write(meta);
    return json(res, 200, { slug: meta.slug, expires_at: meta.expires_at });
  }

  if (p === '/api/share') {
    const meta = store.get(body.slug);
    if (!meta) return json(res, 404, { error: 'not found' });
    if (typeof body.project !== 'string' || !body.project) return json(res, 400, { error: 'project required' });
    const text = body.text || `**${meta.title}**${meta.desc ? `\n${meta.desc}` : ''}\n${urlFor(meta)}`;
    await notifyChannel(body.project, text);
    console.log(`[${new Date().toISOString()}] share ${meta.slug} -> #${body.project}`);
    return json(res, 200, { shared: meta.slug, project: body.project, url: urlFor(meta) });
  }

  if (p === '/api/gc') return json(res, 200, { purged: gc() });

  return json(res, 404, { error: 'not found' });
}

function start(port = cfg.adminPort) {
  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      console.error(`[${new Date().toISOString()}] admin error:`, err?.message ?? err);
      if (!res.headersSent) json(res, 400, { error: String(err?.message ?? err) });
    });
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`[${new Date().toISOString()}] vitrina admin on 127.0.0.1:${server.address().port}`);
  });
  return server;
}

module.exports = { start, publish, parseExpiry, urlFor, gc };
