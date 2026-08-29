'use strict';
/**
 * Vitrina configuration.
 *
 * Two ports on purpose: Tailscale Funnel proxies public traffic from 127.0.0.1,
 * so a loopback check cannot distinguish the internet from a local caller.
 * The public server (funnelled) and the admin API (never funnelled) therefore
 * listen on different ports.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const CONFIG_DIR = path.join(HOME, '.config', 'rancho');
const AUDIENCES_FILE = process.env.VITRINA_AUDIENCES || path.join(CONFIG_DIR, 'vitrina.json');
const ENV_FILE = process.env.VITRINA_ENV_FILE || path.join(CONFIG_DIR, 'vitrina.env');

// launchd carries no secrets in the plist: the service reads them here.
// Existing process env always wins, so a shell can override for testing.
(function loadEnvFile() {
  try {
    for (const line of fs.readFileSync(ENV_FILE, 'utf-8').split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch { /* optional */ }
})();

/** Numeric env with a default; "0" is a valid value (= ephemeral port). */
function envNum(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

const cfg = {
  publicPort: envNum('VITRINA_PORT', 4477),
  adminPort: envNum('VITRINA_ADMIN_PORT', 4478),
  token: process.env.VITRINA_TOKEN || '',
  // Public (funnel) origin — what goes into shared links.
  baseUrl: (process.env.VITRINA_BASE_URL || 'https://whitemini.impala-symmetric.ts.net').replace(/\/$/, ''),
  // Tailnet-only origin (a `tailscale serve` mount without funnel) — used for
  // `private` artifacts. Falls back to baseUrl when unset.
  tailnetUrl: (process.env.VITRINA_TAILNET_URL || '').replace(/\/$/, ''),
  dataDir: process.env.VITRINA_DATA || path.join(HOME, 'vitrina', 'data'),
  appDir: path.resolve(__dirname, '..'),
  relayNotify: process.env.RELAY_NOTIFY_URL || 'http://127.0.0.1:4466/notify',
  relayToken: process.env.RELAY_NOTIFY_TOKEN || '',
  relayDb: process.env.RELAY_DB_PATH || path.join(HOME, 'relay', 'relay.db'),
  defaultTtlDays: envNum('VITRINA_TTL_DAYS', 90),
  maxBytes: envNum('VITRINA_MAX_BYTES', 5 * 1024 * 1024),
  // Expired artifacts are kept this long (so `extend` can resurrect them), then purged.
  purgeAfterDays: envNum('VITRINA_PURGE_AFTER_DAYS', 30),
  audiencesFile: AUDIENCES_FILE,
};

let audCache = { mtime: 0, data: null };

function loadAudiences() {
  try {
    const st = fs.statSync(AUDIENCES_FILE);
    if (audCache.data && st.mtimeMs === audCache.mtime) return audCache.data;
    const data = JSON.parse(fs.readFileSync(AUDIENCES_FILE, 'utf-8'));
    audCache = { mtime: st.mtimeMs, data };
    return data;
  } catch {
    return { people: {}, audiences: {} };
  }
}

/** People (keys) included in a named audience. Unknown audience -> []. */
function membersOf(audience) {
  const a = loadAudiences();
  return (a.audiences && a.audiences[audience]) || [];
}

/** Person record by portal token, or null. */
function personByToken(token) {
  const a = loadAudiences();
  for (const [key, p] of Object.entries(a.people || {})) {
    if (p.portal_token && p.portal_token === token) return { key, ...p };
  }
  return null;
}

/** Audience names that include this person key. */
function audiencesFor(personKey) {
  const a = loadAudiences();
  return Object.entries(a.audiences || {})
    .filter(([, members]) => members.includes(personKey))
    .map(([name]) => name);
}

module.exports = { cfg, loadAudiences, membersOf, personByToken, audiencesFor };
