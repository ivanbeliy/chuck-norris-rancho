import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

export interface Project {
  id: string;
  discord_channel_id: string;
  project_path: string;
  name: string;
  identity: string | null;
  skip_permissions: boolean;
  created_at: string;
}

export interface Session {
  id: string;
  project_id: string;
  claude_session_id: string | null;
  status: 'idle' | 'running' | 'error';
  last_active: string | null;
  created_at: string;
}

export interface SessionWithProject extends Session {
  project_name: string;
}

let db: Database.Database;

export function initialize(dbPath: string): void {
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      discord_channel_id TEXT UNIQUE NOT NULL,
      project_path TEXT NOT NULL,
      name TEXT UNIQUE NOT NULL,
      skip_permissions INTEGER DEFAULT 1,
      identity TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      claude_session_id TEXT,
      status TEXT DEFAULT 'idle' CHECK(status IN ('idle', 'running', 'error')),
      last_active DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Migration: add identity column to existing DBs that predate it.
  const col = db
    .prepare(
      "SELECT COUNT(*) AS c FROM pragma_table_info('projects') WHERE name = 'identity'",
    )
    .get() as { c: number };
  if (col.c === 0) {
    db.exec('ALTER TABLE projects ADD COLUMN identity TEXT');
  }

  resetStuckSessions();
}

export function close(): void {
  if (db) db.close();
}

// --- Projects ---

export function createProject(
  channelId: string,
  path: string,
  name: string,
  skipPermissions = true,
  identity: string | null = null,
): Project {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO projects (id, discord_channel_id, project_path, name, skip_permissions, identity)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, channelId, path, name, skipPermissions ? 1 : 0, identity);
  return getProjectById(id)!;
}

export function updateProjectIdentity(name: string, identity: string | null): boolean {
  const result = db
    .prepare('UPDATE projects SET identity = ? WHERE name = ?')
    .run(identity, name);
  return result.changes > 0;
}

export function getProjectByChannelId(channelId: string): Project | null {
  const row = db
    .prepare('SELECT * FROM projects WHERE discord_channel_id = ?')
    .get(channelId) as any;
  return row ? toProject(row) : null;
}

export function getProjectByName(name: string): Project | null {
  const row = db
    .prepare('SELECT * FROM projects WHERE name = ?')
    .get(name) as any;
  return row ? toProject(row) : null;
}

export function getAllProjects(): Project[] {
  return (db.prepare('SELECT * FROM projects ORDER BY name').all() as any[]).map(
    toProject,
  );
}

export function deleteProject(name: string): boolean {
  const result = db.prepare('DELETE FROM projects WHERE name = ?').run(name);
  return result.changes > 0;
}

function getProjectById(id: string): Project | null {
  const row = db
    .prepare('SELECT * FROM projects WHERE id = ?')
    .get(id) as any;
  return row ? toProject(row) : null;
}

function toProject(row: any): Project {
  return {
    ...row,
    skip_permissions: !!row.skip_permissions,
    identity: row.identity ?? null,
  };
}

// --- Sessions ---

export function getOrCreateSession(projectId: string): Session {
  const existing = db
    .prepare('SELECT * FROM sessions WHERE project_id = ?')
    .get(projectId) as Session | undefined;
  if (existing) return existing;

  const id = randomUUID();
  db.prepare(
    `INSERT INTO sessions (id, project_id, status) VALUES (?, ?, 'idle')`,
  ).run(id, projectId);
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Session;
}

export function updateSessionClaudeId(
  sessionId: string,
  claudeSessionId: string | null,
): void {
  db.prepare(
    'UPDATE sessions SET claude_session_id = ?, last_active = CURRENT_TIMESTAMP WHERE id = ?',
  ).run(claudeSessionId, sessionId);
}

export function updateSessionStatus(
  sessionId: string,
  status: 'idle' | 'running' | 'error',
): void {
  db.prepare(
    'UPDATE sessions SET status = ?, last_active = CURRENT_TIMESTAMP WHERE id = ?',
  ).run(status, sessionId);
}

export function getAllSessions(): SessionWithProject[] {
  return db
    .prepare(
      `SELECT s.*, p.name as project_name
       FROM sessions s JOIN projects p ON s.project_id = p.id
       ORDER BY p.name`,
    )
    .all() as SessionWithProject[];
}

function resetStuckSessions(): void {
  const result = db
    .prepare("UPDATE sessions SET status = 'idle' WHERE status = 'running'")
    .run();
  if (result.changes > 0) {
    console.log(
      `[${new Date().toISOString()}] Reset ${result.changes} stuck session(s) to idle`,
    );
  }
}
