import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import {
  formatResult,
  formatError,
  splitMessage,
  extractAttachments,
} from '../discord-format.js';

describe('formatResult', () => {
  it('returns result as-is', () => {
    expect(formatResult('Done', '0.05')).toBe('Done');
    expect(formatResult('Done', null)).toBe('Done');
  });
});

describe('formatError', () => {
  it('wraps error in bold header and code block', () => {
    expect(formatError('something broke')).toBe(
      '**Error:**\n```\nsomething broke\n```',
    );
  });

  it('truncates errors longer than 1800 chars', () => {
    const long = 'x'.repeat(2000);
    const result = formatError(long);
    expect(result).toContain('x'.repeat(1800));
    expect(result).toContain('...');
    expect(result).not.toContain('x'.repeat(1801));
  });

  it('handles empty string', () => {
    expect(formatError('')).toBe('**Error:**\n```\n\n```');
  });
});

describe('splitMessage', () => {
  it('returns single element when text fits', () => {
    expect(splitMessage('hello')).toEqual(['hello']);
  });

  it('returns single element when text is exactly maxLen', () => {
    const text = 'a'.repeat(2000);
    expect(splitMessage(text)).toEqual([text]);
  });

  it('splits at newline boundary', () => {
    const line1 = 'a'.repeat(1500);
    const line2 = 'b'.repeat(1000);
    const text = `${line1}\n${line2}`;
    const chunks = splitMessage(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(line1);
    expect(chunks[1]).toBe(line2);
  });

  it('falls back to space when no good newline', () => {
    // Words separated by spaces, no newlines — must exceed 2000 chars
    const words = Array(500).fill('word').join(' '); // 2499 chars
    const chunks = splitMessage(words);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
  });

  it('hard-splits when no space or newline found', () => {
    const text = 'x'.repeat(5000);
    const chunks = splitMessage(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].length).toBe(2000);
  });

  it('truncates text exceeding MAX_TOTAL_LENGTH (10000)', () => {
    const text = 'a'.repeat(15000);
    const chunks = splitMessage(text);
    const total = chunks.join('').length;
    // Should be around 10000 + truncation notice, not 15000
    expect(total).toBeLessThan(11000);
  });

  it('caps at MAX_CHUNKS (5)', () => {
    // 5 * 2000 = 10000 chars needed to fill 5 chunks
    const text = Array(600).fill('word1234').join(' '); // ~5400 chars
    const chunks = splitMessage(text, 100);
    expect(chunks.length).toBeLessThanOrEqual(5);
  });

  it('respects custom maxLen parameter', () => {
    const text = 'a'.repeat(300);
    const chunks = splitMessage(text, 100);
    expect(chunks.length).toBe(3);
    expect(chunks[0].length).toBe(100);
  });

  it('caps output at MAX_CHUNKS (5) for large text with small maxLen', () => {
    const text = 'a '.repeat(6000); // 12000 chars, needs many chunks at 100
    const chunks = splitMessage(text, 100);
    expect(chunks.length).toBeLessThanOrEqual(5);
    // Total output is much less than input
    const totalOutput = chunks.reduce((sum, c) => sum + c.length, 0);
    expect(totalOutput).toBeLessThan(text.length);
  });
});

describe('extractAttachments', () => {
  let projectPath: string;
  let outsidePath: string;

  beforeAll(() => {
    projectPath = mkdtempSync(path.join(tmpdir(), 'relay-fmt-proj-'));
    outsidePath = mkdtempSync(path.join(tmpdir(), 'relay-fmt-out-'));

    mkdirSync(path.join(projectPath, '.attachments'), { recursive: true });
    writeFileSync(path.join(projectPath, '.attachments', 'chart.png'), 'PNG');
    writeFileSync(path.join(projectPath, '.attachments', 'report.pdf'), 'PDF');
    writeFileSync(path.join(projectPath, 'docs.txt'), 'doc');
    writeFileSync(path.join(outsidePath, 'secret.env'), 'SECRET=1');
  });

  afterAll(() => {
    rmSync(projectPath, { recursive: true, force: true });
    rmSync(outsidePath, { recursive: true, force: true });
  });

  it('returns original text and empty files when nothing to extract', () => {
    const { content, files } = extractAttachments('plain text', projectPath);
    expect(content).toBe('plain text');
    expect(files).toEqual([]);
  });

  it('extracts markdown image with relative path', () => {
    const text = 'See chart: ![](.attachments/chart.png)';
    const { content, files } = extractAttachments(text, projectPath);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe(path.resolve(projectPath, '.attachments/chart.png'));
    expect(content).toBe('See chart:');
  });

  it('keeps alt text when markdown image has alt', () => {
    const text = '![pretty chart](.attachments/chart.png)';
    const { content } = extractAttachments(text, projectPath);
    expect(content).toBe('pretty chart');
  });

  it('extracts [attach: path] marker and strips it', () => {
    const text = 'Here is the report.\n[attach: .attachments/report.pdf]';
    const { content, files } = extractAttachments(text, projectPath);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe(
      path.resolve(projectPath, '.attachments/report.pdf'),
    );
    expect(content).toBe('Here is the report.');
  });

  it('handles multiple markers and de-duplicates', () => {
    const text =
      '![](.attachments/chart.png)\n[attach: .attachments/chart.png]\n[attach: .attachments/report.pdf]';
    const { files } = extractAttachments(text, projectPath);
    expect(files).toHaveLength(2);
  });

  it('leaves http/https image URLs untouched', () => {
    const text = '![remote](https://example.com/x.png)';
    const { content, files } = extractAttachments(text, projectPath);
    expect(files).toEqual([]);
    expect(content).toBe(text);
  });

  it('rejects paths outside projectPath (traversal)', () => {
    const escape = path.relative(projectPath, path.join(outsidePath, 'secret.env'));
    const text = `[attach: ${escape}]`;
    const { files } = extractAttachments(text, projectPath);
    expect(files).toEqual([]);
  });

  it('rejects absolute paths outside projectPath', () => {
    const text = `[attach: ${path.join(outsidePath, 'secret.env')}]`;
    const { files } = extractAttachments(text, projectPath);
    expect(files).toEqual([]);
  });

  it('accepts absolute paths inside projectPath', () => {
    const abs = path.join(projectPath, 'docs.txt');
    const { files } = extractAttachments(`[attach: ${abs}]`, projectPath);
    expect(files).toEqual([path.resolve(abs)]);
  });

  it('drops missing files silently', () => {
    const { files } = extractAttachments(
      '[attach: .attachments/nope.png]',
      projectPath,
    );
    expect(files).toEqual([]);
  });

  it('caps attachments at 10', () => {
    for (let i = 0; i < 12; i++) {
      writeFileSync(path.join(projectPath, `f${i}.txt`), `${i}`);
    }
    const markers = Array.from({ length: 12 }, (_, i) => `[attach: f${i}.txt]`).join('\n');
    const { files } = extractAttachments(markers, projectPath);
    expect(files).toHaveLength(10);
  });

  it('collapses blank lines left by stripped markers', () => {
    const text = 'Before\n\n[attach: docs.txt]\n\nAfter';
    const { content } = extractAttachments(text, projectPath);
    expect(content).toBe('Before\n\nAfter');
  });
});
