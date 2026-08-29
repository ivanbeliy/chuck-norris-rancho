'use strict';
process.env.VITRINA_ENV_FILE = '/nonexistent/vitrina.env';
const test = require('node:test');
const assert = require('node:assert/strict');
const { markdown, fill, buildDocument, esc } = require('../src/render');

test('markdown: headings, lists, code, table, inline', () => {
  const html = markdown([
    '# Title', '', 'Some **bold** and _em_ and `code` [link](https://x.y/z).', '',
    '- one', '- two', '', '1. first', '2. second', '',
    '```', 'raw <b>', '```', '',
    '| a | b |', '|---|---|', '| 1 | 2 |', '',
    '> quoted', '', '---',
  ].join('\n'));
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>em<\/em>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<a href="https:\/\/x\.y\/z" rel="noopener noreferrer">link<\/a>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(html, /<pre><code>raw &lt;b&gt;<\/code><\/pre>/);
  assert.match(html, /<table><thead><tr><th>a<\/th><th>b<\/th><\/tr><\/thead><tbody>\s*<tr><td>1<\/td><td>2<\/td><\/tr>\s*<\/tbody><\/table>/);
  assert.match(html, /<blockquote><p>quoted<\/p><\/blockquote>/);
  assert.match(html, /<hr>/);
});

test('markdown escapes html in text', () => {
  assert.equal(markdown('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
});

test('fill escapes values unless marked raw', () => {
  const out = fill('message.html', { title: '<t>', heading: 'h & h', body: 'b', form: { raw: '<form></form>' } });
  assert.match(out, /<title>&lt;t&gt;<\/title>/);
  assert.match(out, /<h1>h &amp; h<\/h1>/);
  assert.match(out, /<form><\/form>/);
});

test('buildDocument by type', () => {
  assert.equal(buildDocument('html', '<h1>x</h1>', 'T'), '<h1>x</h1>');
  const md = buildDocument('md', '# Hi', 'My "title"');
  assert.match(md, /<title>My &quot;title&quot;<\/title>/);
  assert.match(md, /<h1>Hi<\/h1>/);
  const react = buildDocument('react', 'function App(){return null}', 'R');
  assert.match(react, /src="\/_a\/react\.js"/);
  assert.match(react, /function App\(\)\{return null\}/);
  assert.match(react, /type="text\/babel"/);
});

test('esc covers the five html specials', () => {
  assert.equal(esc(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
});
