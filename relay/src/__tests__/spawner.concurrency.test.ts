// Configure module-level env before importing spawner.
process.env.RELAY_MAX_CONCURRENT_CLAUDE = '2';
process.env.RELAY_RSS_SAMPLE_INTERVAL_MS = '0';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execFile: vi.fn(),
}));

import { spawn as cpSpawn } from 'child_process';
import { spawnClaude } from '../spawner.js';

type FakeChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
  pid: number;
};

function createFakeChild(pid: number): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  child.pid = pid;
  return child;
}

// Yield microtasks so any pending .then callbacks inside spawner can run.
async function flush(ticks = 3): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
  }
}

describe('spawnClaude global concurrency cap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs at most MAX concurrent and releases FIFO', async () => {
    const children = [0, 1, 2, 3, 4].map((i) => createFakeChild(1000 + i));
    let spawnIndex = 0;
    (cpSpawn as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      return children[spawnIndex++];
    });

    // Kick off 5 spawns concurrently. Distinct projectPaths so the per-project
    // `running` map doesn't collide.
    const promises = [0, 1, 2, 3, 4].map((i) =>
      spawnClaude({
        prompt: `task-${i}`,
        projectPath: `/tmp/proj-${i}`,
        claudeSessionId: null,
        skipPermissions: false,
      }),
    );

    await flush();
    // Only 2 should have started: cpSpawn called twice.
    expect(cpSpawn).toHaveBeenCalledTimes(2);

    // Close the 1st — slot released, 3rd should start.
    children[0].stdout.end(JSON.stringify({ result: 'ok', session_id: 's0' }));
    children[0].emit('close', 0);
    await promises[0];
    await flush();
    expect(cpSpawn).toHaveBeenCalledTimes(3);

    // Close the 2nd — 4th starts (FIFO).
    children[1].stdout.end(JSON.stringify({ result: 'ok', session_id: 's1' }));
    children[1].emit('close', 0);
    await promises[1];
    await flush();
    expect(cpSpawn).toHaveBeenCalledTimes(4);

    // Close the 3rd — 5th starts.
    children[2].stdout.end(JSON.stringify({ result: 'ok', session_id: 's2' }));
    children[2].emit('close', 0);
    await promises[2];
    await flush();
    expect(cpSpawn).toHaveBeenCalledTimes(5);

    // Drain the remaining two.
    children[3].stdout.end(JSON.stringify({ result: 'ok', session_id: 's3' }));
    children[3].emit('close', 0);
    children[4].stdout.end(JSON.stringify({ result: 'ok', session_id: 's4' }));
    children[4].emit('close', 0);

    const results = await Promise.all(promises);
    expect(results.every((r) => r.success)).toBe(true);

    // Confirm FIFO ordering by prompt: spawn[i] had prompt=task-i.
    const calls = (cpSpawn as unknown as ReturnType<typeof vi.fn>).mock.calls;
    for (let i = 0; i < 5; i++) {
      expect(calls[i][1]).toContain(`task-${i}`);
    }
  });

  it('does not block when spawns stay under the cap', async () => {
    const children = [0, 1].map((i) => createFakeChild(2000 + i));
    let spawnIndex = 0;
    (cpSpawn as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      return children[spawnIndex++];
    });

    const p1 = spawnClaude({
      prompt: 'a',
      projectPath: '/tmp/a',
      claudeSessionId: null,
      skipPermissions: false,
    });
    const p2 = spawnClaude({
      prompt: 'b',
      projectPath: '/tmp/b',
      claudeSessionId: null,
      skipPermissions: false,
    });

    await flush();
    expect(cpSpawn).toHaveBeenCalledTimes(2);

    children[0].stdout.end(JSON.stringify({ result: 'a', session_id: 'sa' }));
    children[0].emit('close', 0);
    children[1].stdout.end(JSON.stringify({ result: 'b', session_id: 'sb' }));
    children[1].emit('close', 0);

    await Promise.all([p1, p2]);
  });
});
