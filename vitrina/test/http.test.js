'use strict';
/**
 * End-to-end over real sockets: both servers on ephemeral loopback ports,
 * a temp data dir and a temp audiences file. Exercises the sharing model
 * (link / code / portal / private), updates, expiry, revoke and gc.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vitrina-http-'));
const audiences = path.join(tmp, 'vitrina.json');
fs.writeFileSync(audiences, JSON.stringify({
  people: {
    ivan: { name: 'Іван', portal_token: 'ivanivanivanivanivan' },
    mari: { name: 'Марі', portal_token: 'marimarimarimarimari' },
  },
  audiences: { family: ['ivan', 'mari'], ivan: ['ivan'] },
}));

Object.assign(process.env, {
  VITRINA_ENV_FILE: '/nonexistent/vitrina.env',
  VITRINA_DATA: path.join(tmp, 'data'),
  VITRINA_AUDIENCES: audiences,
  VITRINA_PORT: '0',
  VITRINA_ADMIN_PORT: '0',
  VITRINA_TOKEN: 'test-token',
  VITRINA_BASE_URL: 'https://pub.example',
  VITRINA_TAILNET_URL: 'https://tail.example:8444',
  VITRINA_PURGE_AFTER_DAYS: '30',
});

const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');
const publicSrv = require('../src/public');
const adminSrv = require('../src/admin');

let PUB, ADM, servers;

test.before(async () => {
  store.load();
  servers = [publicSrv.start(0), adminSrv.start(0)];
  await Promise.all(servers.map((s) => new Promise((r) => s.once('listening', r))));
  PUB = `http://127.0.0.1:${servers[0].address().port}`;
  ADM = `http://127.0.0.1:${servers[1].address().port}`;
});
test.after(() => {
  servers.forEach((s) => s.close());
  fs.rmSync(tmp, { recursive: true, force: true });
});

const admin = async (method, route, body) => {
  const res = await fetch(ADM + route, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Vitrina-Token': 'test-token' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};
const pub = (route, opts = {}) => fetch(PUB + route, { redirect: 'manual', ...opts });
const FUNNEL = { 'Tailscale-Funnel-Request': '?1', 'X-Forwarded-For': '203.0.113.9' };
const publish = (extra) => admin('POST', '/api/publish', { source: '<h1>hi</h1>', title: 'T', ...extra });
const cookieOf = (res) => String(res.headers.get('set-cookie') || '').split(';')[0];

test('admin: token is enforced, healthz is open', async () => {
  const r = await fetch(ADM + '/api/list');
  assert.equal(r.status, 401);
  assert.equal((await fetch(ADM + '/healthz')).status, 200);
});

test('publish link -> shell with OG, raw with CSP, assets; unknown slug 404', async () => {
  const { status, body } = await publish({
    desc: 'D', project: 'garden',
    assets: [{ name: 'pic.txt', b64: Buffer.from('hello').toString('base64') }],
  });
  assert.equal(status, 200);
  assert.match(body.slug, /^[0-9A-Za-z]{22}$/);
  assert.equal(body.url, `https://pub.example/v/${body.slug}`);
  assert.equal(body.vis, 'link');
  assert.equal(body.audience, 'family');
  assert.ok(body.expires_at);

  const shell = await pub(`/v/${body.slug}`, { headers: FUNNEL });
  assert.equal(shell.status, 200);
  const html = await shell.text();
  assert.match(html, /<meta property="og:title" content="T">/);
  assert.match(html, /<meta property="og:description" content="D">/);
  assert.match(html, new RegExp(`<iframe src="/v/${body.slug}/raw" sandbox="allow-scripts`));
  assert.match(html, /garden ·/);

  const raw = await pub(`/v/${body.slug}/raw`, { headers: FUNNEL });
  assert.equal(raw.status, 200);
  assert.equal(await raw.text(), '<h1>hi</h1>');
  const csp = raw.headers.get('content-security-policy');
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /default-src https:\/\/pub\.example https:\/\/tail\.example:8444/);
  assert.equal(raw.headers.get('x-content-type-options'), 'nosniff');

  const asset = await pub(`/v/${body.slug}/a/pic.txt`, { headers: FUNNEL });
  assert.equal(asset.status, 200);
  assert.equal(await asset.text(), 'hello');
  assert.equal((await pub(`/v/${body.slug}/a/../meta.json`, { headers: FUNNEL })).status, 404);

  assert.equal((await pub('/v/' + 'x'.repeat(22), { headers: FUNNEL })).status, 404);
  assert.equal((await pub('/', { headers: FUNNEL })).status, 404);
  assert.equal((await pub('/healthz')).status, 200);

  const hits = await admin('GET', `/api/hits?slug=${body.slug}`);
  assert.equal(hits.body.hits.length, 1);
  assert.equal(hits.body.hits[0].kind, 'shell');
  assert.equal(hits.body.hits[0].funnel, 1);
  assert.notEqual(hits.body.hits[0].ip, '203.0.113.9'); // hashed, never raw
});

test('md and react types are wrapped; bad type / vis / audience rejected', async () => {
  const md = await publish({ type: 'md', source: '# Hello\n\ntext' });
  const mdRaw = await (await pub(`/v/${md.body.slug}/raw`)).text();
  assert.match(mdRaw, /<h1>Hello<\/h1>/);
  assert.match(mdRaw, /<title>T<\/title>/);

  const react = await publish({ type: 'react', source: 'function App(){return null}' });
  const reactRaw = await (await pub(`/v/${react.body.slug}/raw`)).text();
  assert.match(reactRaw, /\/_a\/babel\.js/);

  assert.equal((await publish({ type: 'pdf' })).status, 400);
  assert.equal((await publish({ vis: 'public' })).status, 400);
  assert.equal((await publish({ audience: 'nobody' })).status, 400);
  assert.equal((await publish({ source: '   ' })).status, 400);
  assert.equal((await publish({ vis: 'code' })).status, 400); // needs --code
  assert.equal((await publish({ vis: 'code', code: '12' })).status, 400);
});

test('vendored assets served from /_a with immutable cache, traversal blocked', async () => {
  const r = await pub('/_a/react.js');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('cache-control'), /immutable/);
  assert.equal((await pub('/_a/../package.json')).status, 404);
  assert.equal((await pub('/_a/nope.js')).status, 404);
});

test('code: form until the right code, then scoped cookie unlocks shell + raw', async () => {
  const { body } = await publish({ vis: 'code', code: '4242' });
  const gated = await pub(`/v/${body.slug}`, { headers: FUNNEL });
  assert.equal(gated.status, 401);
  assert.match(await gated.text(), new RegExp(`action="/v/${body.slug}/code"`));
  assert.equal((await pub(`/v/${body.slug}/raw`, { headers: FUNNEL })).status, 404);

  const wrong = await pub(`/v/${body.slug}/code`, {
    method: 'POST', headers: { ...FUNNEL, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'code=0000',
  });
  assert.equal(wrong.status, 401);
  assert.match(await wrong.text(), /Невірний код/);

  const ok = await pub(`/v/${body.slug}/code`, {
    method: 'POST', headers: { ...FUNNEL, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'code=4242',
  });
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.get('location'), `/v/${body.slug}`);
  const cookie = cookieOf(ok);
  assert.match(cookie, new RegExp(`^vt_${body.slug}=[0-9a-f]{32}$`));
  assert.match(ok.headers.get('set-cookie'), /HttpOnly; Secure/);

  assert.equal((await pub(`/v/${body.slug}`, { headers: { ...FUNNEL, Cookie: cookie } })).status, 200);
  assert.equal((await pub(`/v/${body.slug}/raw`, { headers: { ...FUNNEL, Cookie: cookie } })).status, 200);
  assert.equal((await pub(`/v/${body.slug}`, { headers: { ...FUNNEL, Cookie: `vt_${body.slug}=deadbeef` } })).status, 401);

  const hits = await admin('GET', `/api/hits?slug=${body.slug}`);
  assert.ok(hits.body.hits.some((h) => h.kind === 'code-fail'));
});

test('portal: /p/<token> lists shared items and sets the cookie that unlocks portal artifacts', async () => {
  const fam = await publish({ vis: 'portal', audience: 'family', title: 'FamOnly' });
  const ivanOnly = await publish({ vis: 'portal', audience: 'ivan', title: 'IvanOnly' });

  // No cookie -> 403 explanation page, raw looks absent.
  const denied = await pub(`/v/${fam.body.slug}`, { headers: FUNNEL });
  assert.equal(denied.status, 403);
  assert.match(await denied.text(), /Лише через портал/);
  assert.equal((await pub(`/v/${fam.body.slug}/raw`, { headers: FUNNEL })).status, 404);

  // Unknown portal token -> 404
  assert.equal((await pub('/p/nopenopenopenope', { headers: FUNNEL })).status, 404);

  // Mari opens her portal: sees family items, not ivan-only; gets a cookie.
  const portal = await pub('/p/marimarimarimarimari', { headers: FUNNEL });
  assert.equal(portal.status, 200);
  const page = await portal.text();
  assert.match(page, /Привіт, Марі/);
  assert.match(page, /FamOnly/);
  assert.doesNotMatch(page, /IvanOnly/);
  const cookie = cookieOf(portal);
  assert.equal(cookie, 'vt_portal=marimarimarimarimari');

  // With the cookie: family artifact opens, ivan-only stays closed.
  assert.equal((await pub(`/v/${fam.body.slug}`, { headers: { ...FUNNEL, Cookie: cookie } })).status, 200);
  assert.equal((await pub(`/v/${fam.body.slug}/raw`, { headers: { ...FUNNEL, Cookie: cookie } })).status, 200);
  assert.equal((await pub(`/v/${ivanOnly.body.slug}`, { headers: { ...FUNNEL, Cookie: cookie } })).status, 403);

  // Ivan's portal lists both and opens both.
  const ivanPortal = await pub('/p/ivanivanivanivanivan', { headers: FUNNEL });
  const ivanPage = await ivanPortal.text();
  assert.match(ivanPage, /FamOnly/);
  assert.match(ivanPage, /IvanOnly/);
  const ivanCookie = cookieOf(ivanPortal);
  assert.equal((await pub(`/v/${ivanOnly.body.slug}`, { headers: { ...FUNNEL, Cookie: ivanCookie } })).status, 200);

  // portal vis with no audience is rejected at publish time
  assert.equal((await publish({ vis: 'portal', audience: 'none' })).status, 400);
});

test('private: 404 on the funnel, opens on the tailnet, URL points at the tailnet origin, hidden from portals', async () => {
  const { body } = await publish({ vis: 'private', title: 'Secret' });
  assert.equal(body.url, `https://tail.example:8444/v/${body.slug}`);
  assert.equal((await pub(`/v/${body.slug}`, { headers: FUNNEL })).status, 404);
  assert.equal((await pub(`/v/${body.slug}/raw`, { headers: FUNNEL })).status, 404);
  assert.equal((await pub(`/v/${body.slug}`)).status, 200); // no funnel header = tailnet/loopback
  const portal = await (await pub('/p/ivanivanivanivanivan')).text();
  assert.doesNotMatch(portal, /Secret/);
});

test('update keeps the URL and every omitted field, bumps version; explicit fields override', async () => {
  const first = await publish({ vis: 'code', code: '1234', audience: 'ivan', title: 'Orig', desc: 'd1', project: 'garden' });
  const upd = await admin('POST', '/api/publish', { update: first.body.slug, source: '<h1>v2</h1>' });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.slug, first.body.slug);
  assert.equal(upd.body.version, 2);
  assert.equal(upd.body.vis, 'code');
  assert.equal(upd.body.audience, 'ivan');
  assert.equal(upd.body.expires_at, first.body.expires_at);
  const info = await admin('GET', `/api/info?slug=${first.body.slug}`);
  assert.equal(info.body.title, 'Orig');
  assert.equal(info.body.desc, 'd1');
  assert.equal(info.body.code, '1234');
  assert.equal(info.body.project, 'garden');

  const upd2 = await admin('POST', '/api/publish', { update: first.body.slug, source: '<h1>v3</h1>', vis: 'link', title: 'New' });
  assert.equal(upd2.body.version, 3);
  assert.equal(upd2.body.vis, 'link');
  assert.equal((await admin('GET', `/api/info?slug=${first.body.slug}`)).body.title, 'New');
  assert.equal(await (await pub(`/v/${first.body.slug}/raw`)).text(), '<h1>v3</h1>');

  assert.equal((await admin('POST', '/api/publish', { update: 'Z'.repeat(22), source: 'x' })).status, 400);
});

test('expiry: 410 page when expired, extend resurrects, never = no expiry, gc purges after grace', async () => {
  const { body } = await publish({ expires: '2020-01-01' });
  const gone = await pub(`/v/${body.slug}`, { headers: FUNNEL });
  assert.equal(gone.status, 410);
  assert.match(await gone.text(), /Термін дії минув/);
  assert.equal((await admin('GET', `/api/info?slug=${body.slug}`)).body.expired, true);

  const ext = await admin('POST', '/api/extend', { slug: body.slug, expires: '30d' });
  assert.equal(ext.status, 200);
  assert.equal((await pub(`/v/${body.slug}`, { headers: FUNNEL })).status, 200);

  const never = await admin('POST', '/api/extend', { slug: body.slug, expires: 'never' });
  assert.equal(never.body.expires_at, null);
  assert.equal((await admin('POST', '/api/extend', { slug: body.slug, expires: 'soon' })).status, 400);

  // gc: expired 10 days ago -> kept; expired 40 days ago -> purged
  const recent = await publish({ expires: new Date(Date.now() - 10 * 86400000).toISOString() });
  const old = await publish({ expires: new Date(Date.now() - 40 * 86400000).toISOString() });
  const gc = await admin('POST', '/api/gc', {});
  assert.deepEqual(gc.body.purged, [old.body.slug]);
  assert.equal((await admin('GET', `/api/info?slug=${recent.body.slug}`)).status, 200);
  assert.equal((await admin('GET', `/api/info?slug=${old.body.slug}`)).status, 404);
});

test('revoke removes immediately; list filters by project and audience', async () => {
  const a = await publish({ project: 'p-rev', audience: 'ivan' });
  const b = await publish({ project: 'p-rev', audience: 'family' });
  const list = await admin('GET', '/api/list?project=p-rev');
  assert.equal(list.body.count, 2);
  assert.equal((await admin('GET', '/api/list?project=p-rev&audience=ivan')).body.count, 1);

  assert.equal((await admin('POST', '/api/revoke', { slug: a.body.slug })).status, 200);
  assert.equal((await pub(`/v/${a.body.slug}`, { headers: FUNNEL })).status, 404);
  assert.equal((await admin('POST', '/api/revoke', { slug: a.body.slug })).status, 404);
  assert.equal((await admin('GET', '/api/list?project=p-rev')).body.count, 1);
  assert.equal((await admin('GET', '/api/list?project=p-rev')).body.items[0].slug, b.body.slug);
});

test('portals endpoint exposes people, portal URLs and audiences', async () => {
  const r = await admin('GET', '/api/portals');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.audiences.family, ['ivan', 'mari']);
  const mari = r.body.people.find((p) => p.key === 'mari');
  assert.equal(mari.portal, 'https://pub.example/p/marimarimarimarimari');
});

test('share posts to Relay notify with the artifact link', async () => {
  const http = require('http');
  const got = [];
  const relay = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c));
    req.on('end', () => { got.push({ token: req.headers['x-relay-token'], body: JSON.parse(b) }); res.writeHead(204); res.end(); });
  });
  await new Promise((r) => relay.listen(0, '127.0.0.1', r));
  const { cfg } = require('../src/config');
  const prevUrl = cfg.relayNotify; const prevTok = cfg.relayToken;
  cfg.relayNotify = `http://127.0.0.1:${relay.address().port}/notify`;
  cfg.relayToken = 'relay-secret';
  try {
    const { body } = await publish({ title: 'Shared', desc: 'about' });
    const r = await admin('POST', '/api/share', { slug: body.slug, project: 'garden' });
    assert.equal(r.status, 200);
    assert.equal(got.length, 1);
    assert.equal(got[0].token, 'relay-secret');
    assert.equal(got[0].body.project, 'garden');
    assert.equal(got[0].body.content, `**Shared**\nabout\nhttps://pub.example/v/${body.slug}`);
    assert.equal((await admin('POST', '/api/share', { slug: body.slug })).status, 400);
  } finally {
    cfg.relayNotify = prevUrl; cfg.relayToken = prevTok;
    relay.close();
  }
});
