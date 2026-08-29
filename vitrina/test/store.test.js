'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.VITRINA_ENV_FILE = '/nonexistent/vitrina.env';
process.env.VITRINA_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'vitrina-store-'));
const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');

test('newSlug: 22 base62 chars, unique', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const s = store.newSlug();
    assert.match(s, /^[0-9A-Za-z]{22}$/);
    seen.add(s);
  }
  assert.equal(seen.size, 500);
});

test('write/get/all/remove round-trip and reload from disk', () => {
  assert.equal(store.load(), 0);
  const a = store.write({ id: 'id-a', slug: 'A'.repeat(22), title: 'a', created_at: '2026-01-01T00:00:00Z' });
  const b = store.write({ id: 'id-b', slug: 'B'.repeat(22), title: 'b', created_at: '2026-02-01T00:00:00Z' });
  store.writeDoc(a, '<p>a</p>');
  assert.equal(store.get(a.slug).title, 'a');
  assert.deepEqual(store.all().map((m) => m.slug), [b.slug, a.slug]); // newest first
  assert.equal(store.readDoc(a).toString(), '<p>a</p>');

  assert.equal(store.load(), 2); // re-index from disk
  assert.equal(store.get(b.slug).title, 'b');

  assert.equal(store.remove(a.slug), true);
  assert.equal(store.remove(a.slug), false);
  assert.equal(store.get(a.slug), null);
  assert.equal(fs.existsSync(store.dirFor('id-a')), false);
});

test('contentPath rejects traversal', () => {
  const meta = { id: 'id-t', slug: 'T'.repeat(22) };
  assert.equal(store.contentPath(meta, '../other'), null);
  assert.equal(store.contentPath(meta, 'a/../../x'), null);
  assert.ok(store.contentPath(meta, 'a/pic.png').endsWith(path.join('id-t', 'a', 'pic.png')));
});

test('isExpired', () => {
  assert.equal(store.isExpired({ expires_at: null }), false);
  assert.equal(store.isExpired({ expires_at: '2000-01-01T00:00:00Z' }), true);
  assert.equal(store.isExpired({ expires_at: '2999-01-01T00:00:00Z' }), false);
});
