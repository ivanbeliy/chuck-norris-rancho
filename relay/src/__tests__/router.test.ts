import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db.js');
vi.mock('../spawner.js');
vi.mock('../discord-format.js');

import * as db from '../db.js';
import * as spawner from '../spawner.js';
import * as fmt from '../discord-format.js';
import { handleMessage } from '../router.js';

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

  it('rejects when task is already running', async () => {
    vi.mocked(spawner.isRunning).mockReturnValue(true);
    const msg = createFakeMessage();
    await handleMessage(msg);
    expect(msg.reply).toHaveBeenCalledWith(
      expect.stringContaining('already running'),
    );
    expect(spawner.spawnClaude).not.toHaveBeenCalled();
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
});
