import { statSync } from 'fs';
import * as path from 'path';

const DISCORD_MAX = 2000;
const MAX_TOTAL_LENGTH = 10_000;
const MAX_CHUNKS = 5;

const MAX_OUTGOING_ATTACHMENT_SIZE = 25 * 1024 * 1024; // 25 MB
const MAX_OUTGOING_ATTACHMENTS = 10; // Discord hard limit per message

// Matches ![alt](path) with optional whitespace. Path captured up to ')'.
const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(\s*([^)\s]+)\s*\)/g;
// Matches [attach: path] — path is everything up to ']'.
const ATTACH_MARKER_RE = /\[attach:\s*([^\]]+?)\s*\]/gi;

export function formatResult(
  result: string,
  _costUsd: string | null,
): string {
  return result;
}

export function formatError(error: string): string {
  const truncated =
    error.length > 1800 ? error.slice(0, 1800) + '...' : error;
  return `**Error:**\n\`\`\`\n${truncated}\n\`\`\``;
}

export interface ExtractedAttachments {
  content: string;
  files: string[];
}

/**
 * Extract outgoing file attachments from Claude's text output.
 *
 * Supports two conventions:
 * 1. Markdown image: `![alt](path)` — used for inline images. Removed from text.
 * 2. Explicit marker: `[attach: path]` — used for any file type. Removed from text.
 *
 * External URLs (http/https/data:) are left in the text — Discord auto-embeds them.
 *
 * Paths are resolved relative to `projectPath`. The resolved path must remain
 * inside `projectPath` (symlink-agnostic prefix check), or it is dropped. Files
 * that are missing, over-size, or beyond `MAX_OUTGOING_ATTACHMENTS` are dropped
 * silently (logged to stderr).
 */
export function extractAttachments(
  text: string,
  projectPath: string,
): ExtractedAttachments {
  const files: string[] = [];
  const seen = new Set<string>();

  const tryAdd = (rawPath: string): void => {
    if (files.length >= MAX_OUTGOING_ATTACHMENTS) return;
    if (/^(https?:|data:)/i.test(rawPath)) return;

    const resolvedProject = path.resolve(projectPath);
    const resolved = path.isAbsolute(rawPath)
      ? path.resolve(rawPath)
      : path.resolve(resolvedProject, rawPath);

    const rel = path.relative(resolvedProject, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      console.error(
        `[${new Date().toISOString()}] Dropping outgoing attachment outside project: ${rawPath}`,
      );
      return;
    }

    if (seen.has(resolved)) return;

    try {
      const st = statSync(resolved);
      if (!st.isFile()) return;
      if (st.size > MAX_OUTGOING_ATTACHMENT_SIZE) {
        console.error(
          `[${new Date().toISOString()}] Dropping oversize outgoing attachment ${rawPath} (${st.size}B)`,
        );
        return;
      }
    } catch {
      console.error(
        `[${new Date().toISOString()}] Dropping missing outgoing attachment: ${rawPath}`,
      );
      return;
    }

    seen.add(resolved);
    files.push(resolved);
  };

  // Strip markdown image syntax (keeps alt text if present, else removes entirely).
  let content = text.replace(MARKDOWN_IMAGE_RE, (_m, alt: string, p: string) => {
    if (/^(https?:|data:)/i.test(p)) return _m; // preserve URL images
    tryAdd(p);
    return alt ? alt : '';
  });

  // Strip [attach: …] markers.
  content = content.replace(ATTACH_MARKER_RE, (_m, p: string) => {
    tryAdd(p);
    return '';
  });

  // Collapse any blank lines left behind by removed markers.
  content = content.replace(/\n{3,}/g, '\n\n').trim();

  return { content, files };
}

export function splitMessage(
  text: string,
  maxLen: number = DISCORD_MAX,
): string[] {
  if (text.length <= maxLen) return [text];

  // Truncate extremely long output
  let remaining =
    text.length > MAX_TOTAL_LENGTH
      ? text.slice(0, MAX_TOTAL_LENGTH) +
        `\n\n... _(truncated, full output was ${text.length} chars)_`
      : text;

  const chunks: string[] = [];

  while (remaining.length > 0 && chunks.length < MAX_CHUNKS) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline near the limit
    let splitIdx = remaining.lastIndexOf('\n', maxLen);
    if (splitIdx < maxLen * 0.5) {
      // No good newline — try space
      splitIdx = remaining.lastIndexOf(' ', maxLen);
    }
    if (splitIdx < maxLen * 0.3) {
      // No good space — hard split
      splitIdx = maxLen;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  if (remaining.length > 0 && chunks.length >= MAX_CHUNKS) {
    // Append truncation notice to last chunk
    const last = chunks[chunks.length - 1];
    const notice = '\n\n... _(message truncated)_';
    if (last.length + notice.length <= maxLen) {
      chunks[chunks.length - 1] = last + notice;
    }
  }

  return chunks;
}
