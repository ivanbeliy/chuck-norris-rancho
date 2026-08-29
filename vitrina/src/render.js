'use strict';
/**
 * Template filling and the three artifact types.
 *
 * `html` is stored verbatim, `react` is wrapped in the React+Tailwind template,
 * `md` is rendered server-side. The markdown subset is deliberately small
 * (headings, emphasis, code, lists, quotes, tables, links, rules) — anything
 * richer should be authored as `html`.
 */
const fs = require('fs');
const path = require('path');
const { cfg } = require('./config');

const TPL = path.join(cfg.appDir, 'templates');
const cache = new Map();

function tpl(name) {
  if (!cache.has(name)) cache.set(name, fs.readFileSync(path.join(TPL, name), 'utf-8'));
  return cache.get(name);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Fill {{key}} placeholders. Values marked raw are inserted unescaped. */
function fill(name, vars) {
  return tpl(name).replace(/\{\{(\w+)\}\}/g, (_, k) => {
    const v = vars[k];
    if (v && typeof v === 'object' && v.raw !== undefined) return v.raw;
    return esc(v);
  });
}

// ---------------------------------------------------------------- markdown

function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, a, u) => `<img alt="${a}" src="${u}">`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => `<a href="${u}" rel="noopener noreferrer">${t}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\W)_([^_]+)_(?=\W|$)/g, '$1<em>$2</em>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

function markdown(src) {
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;

  const flushTable = () => {
    const rows = [];
    while (i < lines.length && /^\s*\|/.test(lines[i])) {
      rows.push(lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
      i++;
    }
    if (rows.length < 2) { rows.forEach((r) => out.push(`<p>${inline(r.join(' | '))}</p>`)); return; }
    const sep = rows[1].every((c) => /^:?-{2,}:?$/.test(c));
    const head = rows[0];
    const body = sep ? rows.slice(2) : rows.slice(1);
    out.push('<table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>');
    body.forEach((r) => out.push('<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>'));
    out.push('</tbody></table>');
  };

  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    if (/^\s*\|/.test(line)) { flushTable(); continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { const n = Math.min(h[1].length, 3); out.push(`<h${n}>${inline(h[2])}</h${n}>`); i++; continue; }
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${markdown(buf.join('\n'))}</blockquote>`);
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, ''));
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>` + items.map((t) => `<li>${inline(t)}</li>`).join('') + `</${tag}>`);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*>|\s*\||\s*([-*+]|\d+\.)\s)/.test(lines[i])) {
      para.push(lines[i++]);
    }
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- documents

/** Build the stored artifact document from raw input of the given type. */
function buildDocument(type, source, title) {
  if (type === 'react') return fill('react.html', { title, component: { raw: source } });
  if (type === 'md') return fill('md.html', { title, body: { raw: markdown(source) } });
  return String(source); // html — stored verbatim
}

module.exports = { fill, esc, markdown, buildDocument };
