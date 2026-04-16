import { promises as fs } from 'node:fs';
import * as path from 'node:path';

let vaultRoot = '';

export function configure(rootAbsPath: string): void {
  vaultRoot = path.resolve(rootAbsPath);
}

export function getRoot(): string {
  return vaultRoot;
}

export function resolvePath(relPath: string): string {
  const abs = path.resolve(vaultRoot, relPath);
  if (!abs.startsWith(vaultRoot + path.sep) && abs !== vaultRoot) {
    throw new Error(`Path escape attempt: ${relPath}`);
  }
  return abs;
}

export function toRelative(absPath: string): string {
  return path.relative(vaultRoot, absPath).split(path.sep).join('/');
}

export interface Frontmatter {
  [key: string]: unknown;
}

export interface ParsedNote {
  frontmatter: Frontmatter;
  body: string;
  raw: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

export function parseNote(raw: string): ParsedNote {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) {
    return { frontmatter: {}, body: raw, raw };
  }
  const fmBlock = match[1];
  const body = match[2];
  const fm: Frontmatter = {};
  let currentKey: string | null = null;
  const listBuf: string[] = [];
  const lines = fmBlock.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    const listItem = line.match(/^\s+-\s+(.*)$/);
    if (listItem && currentKey) {
      listBuf.push(listItem[1].trim());
      fm[currentKey] = [...listBuf];
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
    if (kv) {
      currentKey = kv[1];
      listBuf.length = 0;
      const val = kv[2].trim();
      if (val === '') {
        fm[currentKey] = null;
      } else if (val.startsWith('[') && val.endsWith(']')) {
        fm[currentKey] = val
          .slice(1, -1)
          .split(',')
          .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
          .filter(Boolean);
      } else if (/^-?\d+(\.\d+)?$/.test(val)) {
        fm[currentKey] = Number(val);
      } else {
        fm[currentKey] = val.replace(/^['"]|['"]$/g, '');
      }
    }
  }
  return { frontmatter: fm, body, raw };
}

export function serializeNote(fm: Frontmatter, body: string): string {
  const lines: string[] = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    if (Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - ${item}`);
    } else if (v === null || v === undefined) {
      lines.push(`${k}:`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push('---', '');
  return lines.join('\n') + body;
}

export async function listMarkdown(subdir?: string): Promise<string[]> {
  const root = subdir ? path.join(vaultRoot, subdir) : vaultRoot;
  const out: string[] = [];
  await walk(root, out);
  return out;
}

async function walk(dir: string, out: string[]): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walk(full, out);
    } else if (e.isFile() && e.name.endsWith('.md')) {
      out.push(full);
    }
  }
}

export async function readNote(relPath: string): Promise<string> {
  const abs = resolvePath(relPath);
  return await fs.readFile(abs, 'utf-8');
}

export async function writeNote(relPath: string, content: string): Promise<void> {
  const abs = resolvePath(relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf-8');
}

export async function appendNote(relPath: string, append: string): Promise<void> {
  const abs = resolvePath(relPath);
  await fs.appendFile(abs, append, 'utf-8');
}

export async function exists(relPath: string): Promise<boolean> {
  try {
    await fs.access(resolvePath(relPath));
    return true;
  } catch {
    return false;
  }
}

export async function stat(relPath: string): Promise<{ mtime: Date; size: number } | null> {
  try {
    const s = await fs.stat(resolvePath(relPath));
    return { mtime: s.mtime, size: s.size };
  } catch {
    return null;
  }
}

export interface SearchHit {
  path: string;
  title: string;
  snippet: string;
  score: number;
  age_days: number;
  tags: string[];
}

export async function searchNotes(
  query: string,
  scope: 'sources' | 'wiki' | 'all' = 'all',
  since?: string,
  limit = 10,
): Promise<SearchHit[]> {
  const sinceMs = since ? Date.parse(since) : 0;
  const subdirs = scope === 'all' ? ['sources', 'wiki'] : [scope];
  const files: string[] = [];
  for (const s of subdirs) files.push(...(await listMarkdown(s)));

  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}_-]/gu, ''))
    .filter((t) => t.length >= 2);

  if (tokens.length === 0) return [];

  const now = Date.now();
  const hits: SearchHit[] = [];

  for (const abs of files) {
    const st = await fs.stat(abs);
    if (sinceMs && st.mtimeMs < sinceMs) continue;
    const raw = await fs.readFile(abs, 'utf-8');
    const { frontmatter, body } = parseNote(raw);
    const hay = (body + ' ' + ((frontmatter.tags as string[] | undefined)?.join(' ') ?? '')).toLowerCase();
    let score = 0;
    for (const t of tokens) {
      const matches = hay.split(t).length - 1;
      if (matches > 0) score += matches;
    }
    if (score === 0) continue;

    const ageDays = Math.floor((now - st.mtimeMs) / 86_400_000);
    score += Math.max(0, 30 - ageDays) * 0.1;

    const titleMatch = body.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : path.basename(abs, '.md');

    const firstTokenIdx = tokens
      .map((t) => hay.indexOf(t))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b)[0] ?? 0;
    const snipStart = Math.max(0, firstTokenIdx - 80);
    const snippet = body.slice(snipStart, snipStart + 240).replace(/\s+/g, ' ').trim();

    hits.push({
      path: toRelative(abs),
      title,
      snippet,
      score: Math.round(score * 100) / 100,
      age_days: ageDays,
      tags: (frontmatter.tags as string[] | undefined) ?? [],
    });
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

export async function listBacklinks(targetPath: string): Promise<string[]> {
  const base = path.basename(targetPath, '.md');
  const files = await listMarkdown();
  const out: string[] = [];
  const needles = [`[[${targetPath}]]`, `[[${base}]]`, `[[${targetPath.replace(/\.md$/, '')}]]`];
  for (const abs of files) {
    if (toRelative(abs) === targetPath) continue;
    const content = await fs.readFile(abs, 'utf-8');
    if (needles.some((n) => content.includes(n))) {
      out.push(toRelative(abs));
    }
  }
  return out;
}

export async function recent(since: string, limit = 20): Promise<{ path: string; mtime: string }[]> {
  const sinceMs = Date.parse(since);
  const files = await listMarkdown();
  const entries: { path: string; mtime: Date }[] = [];
  for (const abs of files) {
    const st = await fs.stat(abs);
    if (st.mtimeMs >= sinceMs) {
      entries.push({ path: toRelative(abs), mtime: st.mtime });
    }
  }
  entries.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return entries.slice(0, limit).map((e) => ({ path: e.path, mtime: e.mtime.toISOString() }));
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export function isoDate(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function isoTimestamp(d: Date = new Date()): string {
  return d.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}
