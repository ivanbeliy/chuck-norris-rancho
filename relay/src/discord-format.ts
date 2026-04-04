const DISCORD_MAX = 2000;
const MAX_TOTAL_LENGTH = 10_000;
const MAX_CHUNKS = 5;

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
