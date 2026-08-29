'use strict';
/**
 * Public server — the only surface exposed through Tailscale Funnel.
 * Read-only: it can serve artifacts and portals, and nothing else.
 */
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { cfg, personByToken, audiencesFor, membersOf } = require('./config');
const store = require('./store');
const { fill, esc } = require('./render');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
};

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
};

const PORTAL_COOKIE = 'vt_portal';
const PORTAL_COOKIE_MAX_AGE = 365 * 86400;
const CODE_COOKIE_MAX_AGE = 30 * 86400;

// The artifact runs in a sandboxed iframe (opaque origin), so CSP sources must
// be the absolute host rather than 'self'. connect-src 'none' is the point of
// the whole exercise: an artifact cannot phone anything home.
function artifactCsp() {
  const origins = [cfg.baseUrl, cfg.tailnetUrl].filter(Boolean).join(' ');
  return [
    `default-src ${origins}`,
    `script-src ${origins} 'unsafe-inline' 'unsafe-eval'`,
    `style-src ${origins} 'unsafe-inline'`,
    `img-src ${origins} data: blob:`,
    `font-src ${origins} data:`,
    `media-src ${origins} data: blob:`,
    "connect-src 'none'",
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

const rate = new Map(); // ip -> {n, reset}
function rateLimited(ip) {
  const now = Date.now();
  const r = rate.get(ip);
  if (!r || now > r.reset) { rate.set(ip, { n: 1, reset: now + 60000 }); return false; }
  r.n++;
  if (rate.size > 5000) rate.clear();
  return r.n > 120;
}

function send(res, code, body, headers = {}) {
  res.writeHead(code, { ...BASE_HEADERS, ...headers });
  res.end(body);
}
function notFound(res) { send(res, 404, 'not found\n', { 'Content-Type': 'text/plain; charset=utf-8' }); }

function page(res, code, title, heading, body, form = '') {
  send(res, code, fill('message.html', { title, heading, body, form: { raw: form } }),
    { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
}

function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('uk-UA', {
    day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Kyiv',
  });
}

function cookies(req) {
  const out = new Map();
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return out;
}

function codeCookieValue(meta) {
  return crypto.createHmac('sha256', cfg.token || 'vitrina')
    .update(meta.id + '|' + (meta.code || '')).digest('hex').slice(0, 32);
}

function hasCodeCookie(req, meta) {
  return cookies(req).get(`vt_${meta.slug}`) === codeCookieValue(meta);
}

/** The person whose portal this browser has opened, or null. */
function portalPerson(req) {
  const token = cookies(req).get(PORTAL_COOKIE);
  return token ? personByToken(token) : null;
}

function readBody(req, max = 4096) {
  return new Promise((resolve, reject) => {
    let total = 0; const chunks = [];
    req.on('data', (c) => {
      total += c.length;
      if (total > max) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function codeForm(slug, err) {
  return `<form method="post" action="/v/${esc(slug)}/code">
    <input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="8" autofocus>
    <button type="submit">Відкрити</button></form>${err ? `<p style="margin-top:10px;color:#b91c1c">${esc(err)}</p>` : ''}`;
}

function isFunnel(req) { return !!req.headers['tailscale-funnel-request']; }

/**
 * Gate an artifact request. Returns true when a response has been written
 * (denied), null when access is allowed. Order matters: `private` must look
 * like a 404 from the internet even when expired, so existence never leaks.
 */
function gate(req, res, meta, opts = {}) {
  if (meta.vis === 'private' && isFunnel(req)) { notFound(res); return true; }
  if (store.isExpired(meta)) {
    page(res, 410, 'Термін дії минув', 'Термін дії минув',
      'Це посилання більше не діє. Попроси Чака поділитися ще раз.');
    return true;
  }
  if (meta.vis === 'code' && !hasCodeCookie(req, meta)) {
    if (opts.raw) { notFound(res); return true; }
    page(res, 401, meta.title || 'Захищено', 'Потрібен код',
      'Введи код, який тобі надіслали разом із посиланням.', codeForm(meta.slug));
    return true;
  }
  if (meta.vis === 'portal') {
    const person = portalPerson(req);
    if (!person || !membersOf(meta.audience).includes(person.key)) {
      if (opts.raw) { notFound(res); return true; }
      store.logHit(meta, req, 'portal-fail');
      page(res, 403, meta.title || 'Захищено', 'Лише через портал',
        'Це посилання відкривається тільки з твого персонального порталу. ' +
        'Відкрий портал із закладки (або попроси Чака надіслати його ще раз) і повернись сюди.');
      return true;
    }
  }
  return null;
}

function serveShell(req, res, meta) {
  if (gate(req, res, meta)) return;
  store.logHit(meta, req, 'shell');
  const html = fill('shell.html', {
    title: meta.title || 'Артефакт',
    desc: meta.desc || '',
    url: `${cfg.baseUrl}/v/${meta.slug}`,
    raw: `/v/${meta.slug}/raw`,
    project: meta.project || 'chuck',
    date: fmtDate(meta.updated_at || meta.created_at),
    version_note: meta.version > 1 ? ` · v${meta.version}` : '',
    expiry_note: meta.expires_at ? `діє до ${fmtDate(meta.expires_at)}` : '',
  });
  send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
}

function serveRaw(req, res, meta) {
  if (gate(req, res, meta, { raw: true })) return;
  let doc;
  try { doc = store.readDoc(meta); } catch { return notFound(res); }
  send(res, 200, doc, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': artifactCsp(),
    'Cache-Control': 'no-store',
  });
}

function serveAsset(req, res, meta, rel) {
  if (gate(req, res, meta, { raw: true })) return;
  const p = store.contentPath(meta, path.join('a', rel));
  if (!p || !fs.existsSync(p) || !fs.statSync(p).isFile()) return notFound(res);
  send(res, 200, fs.readFileSync(p), {
    'Content-Type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'public, max-age=86400',
  });
}

/**
 * A person's portal: everything currently shared with any audience they are
 * in. Opening it also sets the portal cookie that unlocks `portal` artifacts.
 */
function servePortal(req, res, token) {
  const person = personByToken(token);
  if (!person) return notFound(res);
  const mine = new Set(audiencesFor(person.key));
  const items = store.all().filter((m) =>
    !store.isExpired(m) && m.vis !== 'private' && mine.has(m.audience));

  const list = items.length
    ? '<ul>' + items.map((m) => `<li><a href="/v/${esc(m.slug)}">
        <div class="t">${esc(m.title || 'Без назви')}</div>
        ${m.desc ? `<div class="d">${esc(m.desc)}</div>` : ''}
        <div class="m">${esc(m.project || '')} · ${esc(fmtDate(m.updated_at || m.created_at))}${
          m.expires_at ? ` · діє до ${esc(fmtDate(m.expires_at))}` : ''}${
          m.vis === 'code' ? ' · 🔒 код' : ''}</div>
      </a></li>`).join('') + '</ul>'
    : '<div class="empty">Поки що порожньо.</div>';

  send(res, 200, fill('portal.html', { name: person.name || person.key, items: { raw: list } }), {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Set-Cookie': `${PORTAL_COOKIE}=${token}; Path=/; Max-Age=${PORTAL_COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`,
  });
}

function serveVendor(req, res, file) {
  const dir = path.join(cfg.appDir, 'assets');
  const p = path.resolve(dir, file);
  if (p !== dir && !p.startsWith(dir + path.sep)) return notFound(res);
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return notFound(res);
  send(res, 200, fs.readFileSync(p), {
    'Content-Type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'public, max-age=604800, immutable',
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  let p;
  try { p = decodeURIComponent(url.pathname); } catch { return notFound(res); }
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0];

  if (p === '/healthz') return send(res, 200, 'ok\n', { 'Content-Type': 'text/plain' });
  if (rateLimited(ip)) return send(res, 429, 'slow down\n', { 'Content-Type': 'text/plain' });

  let m;
  if ((m = p.match(/^\/_a\/([\w.-]+)$/))) return serveVendor(req, res, m[1]);
  if ((m = p.match(/^\/p\/([A-Za-z0-9]{10,64})\/?$/))) return servePortal(req, res, m[1]);

  if ((m = p.match(/^\/v\/([A-Za-z0-9]{22})(\/raw|\/code|\/a\/.+)?\/?$/))) {
    const meta = store.get(m[1]);
    if (!meta) return notFound(res);
    const tail = m[2] || '';
    if (tail === '/raw') return serveRaw(req, res, meta);
    if (tail === '/code') {
      if (req.method !== 'POST') return notFound(res);
      const body = await readBody(req);
      const given = new URLSearchParams(body).get('code') || '';
      if (meta.code && given === meta.code) {
        return send(res, 302, '', {
          Location: `/v/${meta.slug}`,
          'Set-Cookie': `vt_${meta.slug}=${codeCookieValue(meta)}; Path=/v/${meta.slug}; Max-Age=${CODE_COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`,
        });
      }
      store.logHit(meta, req, 'code-fail');
      return page(res, 401, meta.title || 'Захищено', 'Код не підійшов',
        'Спробуй ще раз.', codeForm(meta.slug, 'Невірний код'));
    }
    if (tail.startsWith('/a/')) return serveAsset(req, res, meta, tail.slice(3));
    return serveShell(req, res, meta);
  }

  return notFound(res);
}

function start(port = cfg.publicPort) {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(`[${new Date().toISOString()}] public error:`, err?.message ?? err);
      if (!res.headersSent) send(res, 500, 'error\n', { 'Content-Type': 'text/plain' });
    });
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`[${new Date().toISOString()}] vitrina public on 127.0.0.1:${server.address().port}`);
  });
  return server;
}

module.exports = { start, artifactCsp };
