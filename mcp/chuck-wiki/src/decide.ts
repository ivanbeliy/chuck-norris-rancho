import { promises as fs } from 'node:fs';
import * as vault from './vault.js';
import { AUTO_INTEGRATE_BELOW, REVIEW_DUP_ABOVE } from './config.js';

export type Decision =
  | { kind: 'AUTO_INTEGRATE' }
  | { kind: 'PENDING_TARGET_EXISTS'; reason: string }
  | { kind: 'PENDING_DUP'; reason: string; top_hit: string; score: number }
  | { kind: 'PENDING_RELATED'; reason: string; top_hit: string; score: number };

export async function evaluateConflict(
  targetPath: string,
  proposalBody: string,
  title: string,
): Promise<Decision> {
  // Rule 1: target exists → always user-decided.
  if (await vault.exists(targetPath)) {
    return { kind: 'PENDING_TARGET_EXISTS', reason: `target exists: ${targetPath}` };
  }

  // Rule 2: similarity to any existing note.
  const query = `${title} ${proposalBody.slice(0, 500)}`;
  const hits = await vault.searchNotes(query, 'all', undefined, 5);
  if (hits.length === 0) return { kind: 'AUTO_INTEGRATE' };

  const tokens = vault.tokenize(query);
  if (tokens.length === 0) return { kind: 'AUTO_INTEGRATE' };

  const top = hits[0];
  const normalized = top.score / tokens.length;

  if (normalized >= REVIEW_DUP_ABOVE) {
    return {
      kind: 'PENDING_DUP',
      reason: `very similar to ${top.path} (score ${normalized.toFixed(2)})`,
      top_hit: top.path,
      score: normalized,
    };
  }
  if (normalized >= AUTO_INTEGRATE_BELOW) {
    return {
      kind: 'PENDING_RELATED',
      reason: `possibly related to ${top.path} (score ${normalized.toFixed(2)})`,
      top_hit: top.path,
      score: normalized,
    };
  }
  return { kind: 'AUTO_INTEGRATE' };
}

// TL;DR extractor — mechanical: first H1 + first paragraph (truncated).
export function extractTlDr(body: string): string {
  const lines = body.split(/\r?\n/);
  let heading = '';
  const paraBuf: string[] = [];
  let inPara = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!heading && trimmed.startsWith('# ')) {
      heading = trimmed.replace(/^#\s+/, '');
      continue;
    }
    if (!inPara) {
      if (trimmed === '') continue;
      if (trimmed.startsWith('#') || trimmed.startsWith('```')) continue;
      inPara = true;
      paraBuf.push(trimmed);
    } else {
      if (trimmed === '') break;
      paraBuf.push(trimmed);
    }
  }

  const para = paraBuf.join(' ');
  const snippet = para.length > 150 ? para.slice(0, 147) + '…' : para;
  if (heading && snippet) return `**${heading}** — ${snippet}`;
  if (heading) return `**${heading}**`;
  return snippet || '(no summary)';
}

// Move proposal body to target_path, strip proposal-specific frontmatter.
// Used by auto-integrate path (inside propose_note) and by integrate_proposal tool.
export async function integrateProposalInPlace(
  proposalRel: string,
  targetPath: string,
  today: string,
): Promise<void> {
  const raw = await vault.readNote(proposalRel);
  const parsed = vault.parseNote(raw);
  const newFm: Record<string, unknown> = { ...parsed.frontmatter, updated: today };
  delete newFm.target_path;
  delete newFm.reason;
  delete newFm.contribution_reason;
  await vault.writeNote(targetPath, vault.serializeNote(newFm, parsed.body));
  await fs.unlink(vault.resolvePath(proposalRel));
}
