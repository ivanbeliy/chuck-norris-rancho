import { describe, it, expect } from 'vitest';
import { formatResult, formatError, splitMessage } from '../discord-format.js';

describe('formatResult', () => {
  it('appends cost when provided', () => {
    expect(formatResult('Done', '0.05')).toBe('Done\n\n_Cost: $0.05_');
  });

  it('returns result unchanged when cost is null', () => {
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
