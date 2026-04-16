import { spawn as cpSpawn, ChildProcess } from 'child_process';

export interface SpawnOptions {
  prompt: string;
  projectPath: string;
  claudeSessionId: string | null;
  skipPermissions: boolean;
  identity?: string | null;
}

export interface SpawnResult {
  success: boolean;
  result: string;
  claudeSessionId: string;
  costUsd: string | null;
  error?: string;
}

const running = new Map<string, ChildProcess>();

const DEFAULT_TIMEOUT_MS = Number(process.env.RELAY_TASK_TIMEOUT_MS) || 600_000;

export function spawnClaude(options: SpawnOptions): Promise<SpawnResult> {
  const args: string[] = [
    '-p',
    options.prompt,
    '--output-format',
    'json',
  ];

  if (options.claudeSessionId) {
    args.push('--resume', options.claudeSessionId);
  }

  if (options.skipPermissions) {
    args.push('--dangerously-skip-permissions');
  }

  const identityEnv: Record<string, string> = options.identity
    ? { CHUCK_WIKI_CLIENT_IDENTITY: options.identity }
    : {};

  const child = cpSpawn('claude', args, {
    cwd: options.projectPath,
    env: {
      ...process.env,
      ...identityEnv,
      PATH: `/opt/homebrew/bin:/opt/homebrew/opt/node@22/bin:${process.env.PATH || ''}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  running.set(options.projectPath, child);

  let stdout = '';
  let stderr = '';

  child.stdout!.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr!.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  return new Promise<SpawnResult>((resolve) => {
    const timeout = setTimeout(() => {
      console.error(
        `[${new Date().toISOString()}] Timeout: killing claude process for ${options.projectPath}`,
      );
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 5000);
    }, DEFAULT_TIMEOUT_MS);

    child.on('close', (code) => {
      clearTimeout(timeout);
      running.delete(options.projectPath);

      if (code === 0) {
        try {
          const parsed = JSON.parse(stdout);
          resolve({
            success: true,
            result: parsed.result || '(no result)',
            claudeSessionId:
              parsed.session_id || options.claudeSessionId || '',
            costUsd: parsed.total_cost_usd?.toString() || null,
          });
        } catch {
          // JSON parse failed — return raw stdout
          resolve({
            success: true,
            result: stdout.trim() || '(empty output)',
            claudeSessionId: options.claudeSessionId || '',
            costUsd: null,
          });
        }
      } else {
        resolve({
          success: false,
          result: '',
          claudeSessionId: options.claudeSessionId || '',
          costUsd: null,
          error: `Claude exited with code ${code}: ${(stderr || stdout).trim().slice(0, 2000)}`,
        });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      running.delete(options.projectPath);
      resolve({
        success: false,
        result: '',
        claudeSessionId: options.claudeSessionId || '',
        costUsd: null,
        error: `Failed to spawn claude: ${err.message}`,
      });
    });
  });
}

export function isRunning(projectPath: string): boolean {
  const child = running.get(projectPath);
  return !!child && !child.killed;
}

export function killByProject(projectPath: string): boolean {
  const child = running.get(projectPath);
  if (child && !child.killed) {
    child.kill('SIGTERM');
    return true;
  }
  return false;
}

export function killAll(timeoutMs = 30_000): Promise<void> {
  const entries = [...running.entries()];
  if (entries.length === 0) return Promise.resolve();

  for (const [, child] of entries) {
    if (!child.killed) child.kill('SIGTERM');
  }

  return new Promise((resolve) => {
    const check = setInterval(() => {
      if (running.size === 0) {
        clearInterval(check);
        resolve();
      }
    }, 500);

    setTimeout(() => {
      for (const [, child] of running) {
        if (!child.killed) child.kill('SIGKILL');
      }
      clearInterval(check);
      resolve();
    }, timeoutMs);
  });
}
