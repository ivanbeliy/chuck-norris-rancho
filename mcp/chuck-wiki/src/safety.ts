import { promises as fs } from 'node:fs';
import * as path from 'node:path';

let patterns: { regex: RegExp; source: string }[] = [];

export async function loadPatterns(vaultRoot: string): Promise<void> {
  const file = path.join(vaultRoot, '_meta', 'policies', 'secret-patterns.txt');
  let content = '';
  try {
    content = await fs.readFile(file, 'utf-8');
  } catch {
    console.error(`[chuck-wiki-mcp] Warning: secret-patterns.txt not found at ${file}`);
    return;
  }
  const lines = content.split(/\r?\n/);
  patterns = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    let flags = '';
    let body = trimmed;
    const flagMatch = body.match(/^\(\?([a-z]+)\)(.*)$/);
    if (flagMatch) {
      flags = flagMatch[1];
      body = flagMatch[2];
    }
    try {
      patterns.push({ regex: new RegExp(body, flags), source: trimmed });
    } catch (e) {
      console.error(`[chuck-wiki-mcp] Invalid regex in secret-patterns.txt: ${trimmed} (${(e as Error).message})`);
    }
  }
  console.error(`[chuck-wiki-mcp] Loaded ${patterns.length} secret patterns`);
}

export interface SecretMatch {
  pattern: string;
  excerpt: string;
}

export function scanForSecrets(content: string): SecretMatch[] {
  const matches: SecretMatch[] = [];
  for (const { regex, source } of patterns) {
    const m = content.match(regex);
    if (m) {
      const idx = m.index ?? 0;
      const excerpt = content.slice(Math.max(0, idx - 20), idx + m[0].length + 20);
      matches.push({ pattern: source, excerpt });
    }
  }
  return matches;
}

const MAX_CONTRIBUTIONS_PER_HOUR = 10;
const MAX_NOTE_SIZE_BYTES = 50 * 1024;

const rateLimitBuckets = new Map<string, number[]>();

export function checkRateLimit(identity: string): { ok: boolean; reason?: string } {
  const now = Date.now();
  const hourAgo = now - 3_600_000;
  const bucket = (rateLimitBuckets.get(identity) ?? []).filter((t) => t > hourAgo);
  if (bucket.length >= MAX_CONTRIBUTIONS_PER_HOUR) {
    return {
      ok: false,
      reason: `rate limit exceeded: ${MAX_CONTRIBUTIONS_PER_HOUR} contributions/hour for ${identity}`,
    };
  }
  bucket.push(now);
  rateLimitBuckets.set(identity, bucket);
  return { ok: true };
}

export function checkSize(content: string): { ok: boolean; reason?: string } {
  const bytes = Buffer.byteLength(content, 'utf-8');
  if (bytes > MAX_NOTE_SIZE_BYTES) {
    return {
      ok: false,
      reason: `note too large: ${bytes} bytes (max ${MAX_NOTE_SIZE_BYTES})`,
    };
  }
  return { ok: true };
}
