'use strict';
/**
 * Filesystem-backed artifact store. No database: one directory per artifact,
 * meta.json alongside the content. An in-memory index is built at boot and
 * kept in sync on write — both HTTP servers share this process, so one index.
 *
 *   <dataDir>/store/<id>/meta.json
 *   <dataDir>/store/<id>/index.html      the artifact document
 *   <dataDir>/store/<id>/source.<ext>    original input (md / jsx), if any
 *   <dataDir>/store/<id>/a/*             artifact-local assets
 *   <dataDir>/hits.log                   JSONL access log
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { cfg } = require('./config');

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function storeDir() { return path.join(cfg.dataDir, 'store'); }
function dirFor(id) { return path.join(storeDir(), id); }

/** 128 bits of entropy rendered base62 -> 22 chars. The URL is the capability. */
function newSlug() {
  let n = BigInt('0x' + crypto.randomBytes(16).toString('hex'));
  let out = '';
  const base = BigInt(62);
  while (n > 0n) { out = ALPHABET[Number(n % base)] + out; n /= base; }
  return out.padStart(22, '0');
}

const index = new Map(); // slug -> meta

function metaPath(id) { return path.join(dirFor(id), 'meta.json'); }

function load() {
  index.clear();
  fs.mkdirSync(storeDir(), { recursive: true });
  for (const id of fs.readdirSync(storeDir())) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath(id), 'utf-8'));
      index.set(meta.slug, meta);
    } catch { /* half-written or stray dir — skip */ }
  }
  return index.size;
}

function write(meta) {
  fs.mkdirSync(dirFor(meta.id), { recursive: true });
  fs.writeFileSync(metaPath(meta.id), JSON.stringify(meta, null, 2));
  index.set(meta.slug, meta);
  return meta;
}

function get(slug) { return index.get(slug) || null; }
function all() { return [...index.values()].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')); }

function isExpired(meta) {
  return !!meta.expires_at && Date.parse(meta.expires_at) < Date.now();
}

function remove(slug) {
  const meta = get(slug);
  if (!meta) return false;
  fs.rmSync(dirFor(meta.id), { recursive: true, force: true });
  index.delete(slug);
  return true;
}

function contentPath(meta, rel) {
  const base = dirFor(meta.id);
  const p = path.resolve(base, rel);
  if (p !== base && !p.startsWith(base + path.sep)) return null; // traversal
  return p;
}

function readDoc(meta) {
  return fs.readFileSync(path.join(dirFor(meta.id), 'index.html'));
}

function writeDoc(meta, html) {
  fs.mkdirSync(dirFor(meta.id), { recursive: true });
  fs.writeFileSync(path.join(dirFor(meta.id), 'index.html'), html);
}

function logHit(meta, req, kind) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const rec = {
    t: new Date().toISOString(),
    slug: meta.slug,
    kind,
    ip: crypto.createHash('sha256').update(ip + '|' + meta.slug).digest('hex').slice(0, 12),
    ua: String(req.headers['user-agent'] || '').slice(0, 160),
    funnel: req.headers['tailscale-funnel-request'] ? 1 : 0,
  };
  try {
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    fs.appendFileSync(path.join(cfg.dataDir, 'hits.log'), JSON.stringify(rec) + '\n');
  } catch { /* logging must never break a page render */ }
}

function hits(slug, limit = 50) {
  const f = path.join(cfg.dataDir, 'hits.log');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf-8').trim().split('\n')
    .filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && r.slug === slug).slice(-limit).reverse();
}

module.exports = {
  newSlug, load, write, get, all, remove, isExpired,
  contentPath, readDoc, writeDoc, logHit, hits, dirFor, storeDir,
};
