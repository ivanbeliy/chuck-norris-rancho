import { promises as fs } from 'node:fs';
import * as path from 'node:path';

let logPath = '';

export function configure(vaultRoot: string): void {
  logPath = path.join(vaultRoot, '_meta', 'contributions-log.jsonl');
}

export interface LogEntry {
  ts: string;
  tool: string;
  identity: string;
  action: 'ok' | 'rejected';
  reason?: string;
  path?: string;
  target?: string;
  proposal_id?: string;
}

export async function append(entry: Omit<LogEntry, 'ts'>): Promise<void> {
  if (!logPath) return;
  const full: LogEntry = { ts: new Date().toISOString(), ...entry };
  const line = JSON.stringify(full) + '\n';
  try {
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.appendFile(logPath, line, 'utf-8');
  } catch (err) {
    console.error(`[chuck-wiki-mcp] Failed to append log: ${(err as Error).message}`);
  }
}
