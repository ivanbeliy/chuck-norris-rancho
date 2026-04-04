import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'stream';

vi.mock('../db.js');
vi.mock('../spawner.js');
vi.mock('../discord-format.js');
vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('fs', () => ({
  createWriteStream: vi.fn().mockReturnValue({
    on: vi.fn(),
    once: vi.fn(),
    emit: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
    destroy: vi.fn(),
  }),
}));
vi.mock('stream/promises', () => ({
  pipeline: vi.fn().mockResolvedValue(undefined),
}));

import * as db from '../db.js';
import * as spawner from '../spawner.js';
import * as fmt from '../discord-format.js';
import { handleMessage, downloadAttachments, getBufferedCount } from '../router.js';

function createFakeAttachments(
  items: Array<{ name: string; url: string; size: number; contentType: string | null }> = [],
) {
  const entries = items.map((item, i) => [`att-${i}`, { id: `att-${i}`, ...item }] as const);
  return new Map(entries);
}

function createFakeMessage(overrides: Record<string, unknown> = {}) {
  return {
    content: 'do something',
    channel: {
      id: 'ch-1',
      messages: {
        fetch: vi.fn(),
      },
      sendTyping: vi.fn().mockResolvedValue(undefined),
    },
    author: { tag: 'User#1234' },
    reference: null,
    messageSnapshots: null,
    attachments: createFakeAttachments(),
    reply: vi.fn().mockResolvedValue(undefined),
    react: vi.fn().mockResolvedValue(undefined),
    reactions: {
      cache: {
        get: vi.fn().mockReturnValue({
          users: {
            remove: vi.fn().mockResolvedValue(undefined),
          },
        }),
      },
    },
    client: { user: { id: 'bot-id' } },
    ...overrides,
  } as any;
}

const fakeProject = {
  id: 'proj-1',
  discord_channel_id: 'ch-1',
  project_path: '/tmp/proj',
  name: 'test',
  skip_permissions: true,
  created_at: '',
};

const fakeSession = {
  id: 'sess-1',
  project_id: 'proj-1',
  claude_session_id: 'claude-1',
  status: 'idle' as const,
  last_active: null,
  created_at: '',
};

const successResult: spawner.SpawnResult = {
  success: true,
  result: 'Done!',
  claudeSessionId: 'claude-2',
  costUsd: '0.05',
};

const errorResult: spawner.SpawnResult = {
  success: false,
  result: '',
  claudeSessionId: 'claude-1',
  costUsd: null,
  error: 'Something broke',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.getProjectByChannelId).mockReturnValue(fakeProject);
  vi.mocked(db.getOrCreateSession).mockReturnValue(fakeSession);
  vi.mocked(db.updateSessionStatus).mockReturnValue(undefined);
  vi.mocked(db.updateSessionClaudeId).mockReturnValue(undefined);
  vi.mocked(spawner.isRunning).mockReturnValue(false);
  vi.mocked(spawner.spawnClaude).mockResolvedValue(successResult);
  vi.mocked(fmt.formatResult).mockReturnValue('Done!\n\n_Cost: $0.05_');
  vi.mocked(fmt.splitMessage).mockReturnValue(['Done!\n\n_Cost: $0.05_']);
  vi.mocked(fmt.formatError).mockReturnValue('**Error:**\n```\nSomething broke\n```');
});

describe('handleMessage', () => {
  it('does nothing when channel is not registered', async () => {
    vi.mocked(db.getProjectByChannelId).mockReturnValue(null as any);
    const msg = createFakeMessage();
    await handleMessage(msg);
    expect(spawner.spawnClaude).not.toHaveBeenCalled();
  });

  it('buffers message when task is already running', async () => {
    vi.mocked(spawner.isRunning).mockReturnValue(true);
    const msg = createFakeMessage();
    await handleMessage(msg);

    // Should NOT reject — should buffer and react with 📋
    expect(msg.reply).not.toHaveBeenCalled();
    expect(msg.react).toHaveBeenCalledWith('\uD83D\uDCCB');
    expect(spawner.spawnClaude).not.toHaveBeenCalled();
    expect(getBufferedCount('/tmp/proj')).toBe(1);
  });

  it('spawns claude and replies with formatted result on success', async () => {
    const msg = createFakeMessage();
    await handleMessage(msg);

    expect(db.updateSessionStatus).toHaveBeenCalledWith('sess-1', 'running');
    expect(spawner.spawnClaude).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'do something',
        projectPath: '/tmp/proj',
        claudeSessionId: 'claude-1',
      }),
    );
    expect(db.updateSessionClaudeId).toHaveBeenCalledWith('sess-1', 'claude-2');
    expect(db.updateSessionStatus).toHaveBeenCalledWith('sess-1', 'idle');
    expect(msg.reply).toHaveBeenCalledWith('Done!\n\n_Cost: $0.05_');
  });

  it('replies with error on spawn failure', async () => {
    vi.mocked(spawner.spawnClaude).mockResolvedValue(errorResult);
    const msg = createFakeMessage();
    await handleMessage(msg);

    expect(db.updateSessionStatus).toHaveBeenCalledWith('sess-1', 'error');
    expect(fmt.formatError).toHaveBeenCalledWith('Something broke');
    expect(msg.reply).toHaveBeenCalledWith(
      expect.stringContaining('Error'),
    );
  });

  it('retries with fresh session on session-related error', async () => {
    const sessionError: spawner.SpawnResult = {
      success: false,
      result: '',
      claudeSessionId: 'claude-1',
      costUsd: null,
      error: 'session expired',
    };

    vi.mocked(spawner.spawnClaude)
      .mockResolvedValueOnce(sessionError)
      .mockResolvedValueOnce(successResult);

    const msg = createFakeMessage();
    await handleMessage(msg);

    // Should have been called twice
    expect(spawner.spawnClaude).toHaveBeenCalledTimes(2);
    // Second call should have null session
    expect(spawner.spawnClaude).toHaveBeenCalledWith(
      expect.objectContaining({ claudeSessionId: null }),
    );
    // Session ID should have been cleared
    expect(db.updateSessionClaudeId).toHaveBeenCalledWith('sess-1', null);
    // Final result should be success
    expect(db.updateSessionStatus).toHaveBeenCalledWith('sess-1', 'idle');
  });

  it('includes referenced message context in prompt on reply', async () => {
    const refMessage = {
      content: 'original message',
      author: { tag: 'Author#5678' },
      embeds: [],
    };

    const msg = createFakeMessage({
      content: 'follow up',
      reference: { messageId: 'ref-msg-1' },
    });
    msg.channel.messages.fetch.mockResolvedValue(refMessage);

    await handleMessage(msg);

    const prompt = vi.mocked(spawner.spawnClaude).mock.calls[0][0].prompt;
    expect(prompt).toContain('original message');
    expect(prompt).toContain('Author#5678');
    expect(prompt).toContain('follow up');
  });

  it('includes forwarded message content in prompt', async () => {
    const snapshots = new Map([
      [
        'snap-1',
        {
          content: 'forwarded content',
          embeds: [],
        },
      ],
    ]);

    const msg = createFakeMessage({
      content: 'check this',
      messageSnapshots: snapshots,
    });

    await handleMessage(msg);

    const prompt = vi.mocked(spawner.spawnClaude).mock.calls[0][0].prompt;
    expect(prompt).toContain('forwarded content');
    expect(prompt).toContain('Forwarded message');
    expect(prompt).toContain('check this');
  });

  it('includes embed text from referenced message', async () => {
    const refMessage = {
      content: '',
      author: { tag: 'Bot#0000' },
      embeds: [
        { title: 'Alert', description: 'Server is down' },
      ],
    };

    const msg = createFakeMessage({
      content: 'what happened?',
      reference: { messageId: 'ref-msg-2' },
    });
    msg.channel.messages.fetch.mockResolvedValue(refMessage);

    await handleMessage(msg);

    const prompt = vi.mocked(spawner.spawnClaude).mock.calls[0][0].prompt;
    expect(prompt).toContain('Alert: Server is down');
    expect(prompt).toContain('what happened?');
  });

  it('includes attachment info in prompt when files are attached', async () => {
    // Mock global fetch for attachment download
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      body: Readable.toWeb(Readable.from(Buffer.from('file content'))),
    });
    vi.stubGlobal('fetch', mockFetch);

    const attachments = createFakeAttachments([
      {
        name: 'report.pdf',
        url: 'https://cdn.discordapp.com/attachments/123/456/report.pdf',
        size: 1024,
        contentType: 'application/pdf',
      },
    ]);

    const msg = createFakeMessage({
      content: 'analyze this',
      attachments,
    });

    await handleMessage(msg);

    const prompt = vi.mocked(spawner.spawnClaude).mock.calls[0][0].prompt;
    expect(prompt).toContain('Attached files saved to disk');
    expect(prompt).toContain('report.pdf');
    expect(prompt).toContain('application/pdf');
    expect(prompt).toContain('analyze this');

    vi.unstubAllGlobals();
  });

  it('skips attachments over 25MB', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      body: Readable.toWeb(Readable.from(Buffer.from(''))),
    });
    vi.stubGlobal('fetch', mockFetch);

    const attachments = createFakeAttachments([
      {
        name: 'huge.zip',
        url: 'https://cdn.discordapp.com/attachments/123/456/huge.zip',
        size: 30 * 1024 * 1024, // 30MB
        contentType: 'application/zip',
      },
    ]);

    const msg = createFakeMessage({
      content: 'process this',
      attachments,
    });

    await handleMessage(msg);

    // fetch should not be called for oversized attachment
    expect(mockFetch).not.toHaveBeenCalled();
    // Prompt should not contain attachment info
    const prompt = vi.mocked(spawner.spawnClaude).mock.calls[0][0].prompt;
    expect(prompt).not.toContain('Attached files');
    expect(prompt).toBe('process this');

    vi.unstubAllGlobals();
  });

  it('handles attachment download failure gracefully', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 404 }),
    );

    const attachments = createFakeAttachments([
      {
        name: 'gone.txt',
        url: 'https://cdn.discordapp.com/attachments/123/456/gone.txt',
        size: 100,
        contentType: 'text/plain',
      },
    ]);

    const msg = createFakeMessage({
      content: 'read this',
      attachments,
    });

    await handleMessage(msg);

    // Should still proceed without attachment
    expect(spawner.spawnClaude).toHaveBeenCalled();
    const prompt = vi.mocked(spawner.spawnClaude).mock.calls[0][0].prompt;
    expect(prompt).not.toContain('Attached files');

    vi.unstubAllGlobals();
  });
});

describe('message buffer', () => {
  // To test drain, we need handleMessage to process a message while
  // there are already buffered messages. We simulate this by:
  // 1. Buffering messages (isRunning=true)
  // 2. Then processing a normal message (isRunning=false) — which
  //    won't drain because the buffer was for a different "run".
  // Instead, we test the full flow: buffer while busy, then when
  // the next direct message is processed, the drain runs after.

  it('drains buffered messages after current task completes', async () => {
    // Step 1: buffer two messages while busy
    vi.mocked(spawner.isRunning).mockReturnValue(true);

    const msg1 = createFakeMessage({ content: 'first queued' });
    const msg2 = createFakeMessage({ content: 'second queued' });
    await handleMessage(msg1);
    await handleMessage(msg2);

    expect(getBufferedCount('/tmp/proj')).toBe(2);
    expect(msg1.react).toHaveBeenCalledWith('\uD83D\uDCCB');
    expect(msg2.react).toHaveBeenCalledWith('\uD83D\uDCCB');

    // Step 2: project becomes free, new message triggers processing + drain
    vi.mocked(spawner.isRunning).mockReturnValue(false);
    vi.mocked(spawner.spawnClaude).mockResolvedValue(successResult);

    const directMsg = createFakeMessage({ content: 'direct message' });
    await handleMessage(directMsg);

    // spawnClaude should be called twice: once for direct, once for batch
    expect(spawner.spawnClaude).toHaveBeenCalledTimes(2);

    // First call: direct message
    expect(vi.mocked(spawner.spawnClaude).mock.calls[0][0].prompt).toBe(
      'direct message',
    );

    // Second call: batch with both buffered messages
    const batchPrompt = vi.mocked(spawner.spawnClaude).mock.calls[1][0].prompt;
    expect(batchPrompt).toContain('first queued');
    expect(batchPrompt).toContain('second queued');
    expect(batchPrompt).toContain('2 more messages');
    expect(batchPrompt).toContain('[Message 1/2]');
    expect(batchPrompt).toContain('[Message 2/2]');

    // Buffer should be empty now
    expect(getBufferedCount('/tmp/proj')).toBe(0);

    // Last buffered message should have received the reply
    expect(msg2.reply).toHaveBeenCalled();
  });

  it('handles single buffered message without numbering', async () => {
    vi.mocked(spawner.isRunning).mockReturnValue(true);

    const queued = createFakeMessage({ content: 'solo queued' });
    await handleMessage(queued);

    vi.mocked(spawner.isRunning).mockReturnValue(false);
    vi.mocked(spawner.spawnClaude).mockResolvedValue(successResult);

    const direct = createFakeMessage({ content: 'trigger' });
    await handleMessage(direct);

    const batchPrompt = vi.mocked(spawner.spawnClaude).mock.calls[1][0].prompt;
    expect(batchPrompt).toContain('solo queued');
    expect(batchPrompt).toContain('1 more message');
    expect(batchPrompt).not.toContain('[Message 1/1]');
  });
});
