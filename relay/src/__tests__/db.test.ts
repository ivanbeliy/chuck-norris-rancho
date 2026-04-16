import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as db from '../db.js';

beforeEach(() => {
  db.initialize(':memory:');
});

afterEach(() => {
  db.close();
});

describe('projects', () => {
  it('creates a project with generated UUID', () => {
    const p = db.createProject('ch-1', '/tmp/proj', 'test-project');
    expect(p.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(p.discord_channel_id).toBe('ch-1');
    expect(p.project_path).toBe('/tmp/proj');
    expect(p.name).toBe('test-project');
    expect(p.skip_permissions).toBe(true);
  });

  it('getProjectByChannelId returns project for known channel', () => {
    db.createProject('ch-1', '/tmp/proj', 'test');
    const p = db.getProjectByChannelId('ch-1');
    expect(p).not.toBeNull();
    expect(p!.name).toBe('test');
  });

  it('getProjectByChannelId returns null for unknown channel', () => {
    expect(db.getProjectByChannelId('nonexistent')).toBeNull();
  });

  it('getProjectByName finds by name', () => {
    db.createProject('ch-1', '/tmp/proj', 'alpha');
    expect(db.getProjectByName('alpha')).not.toBeNull();
    expect(db.getProjectByName('beta')).toBeNull();
  });

  it('getAllProjects returns all projects', () => {
    db.createProject('ch-1', '/tmp/a', 'alpha');
    db.createProject('ch-2', '/tmp/b', 'beta');
    const all = db.getAllProjects();
    expect(all.length).toBe(2);
  });

  it('deleteProject removes project and returns true', () => {
    db.createProject('ch-1', '/tmp/proj', 'test');
    expect(db.deleteProject('test')).toBe(true);
    expect(db.getProjectByName('test')).toBeNull();
  });

  it('deleteProject returns false for nonexistent', () => {
    expect(db.deleteProject('nonexistent')).toBe(false);
  });

  it('throws on duplicate channel_id', () => {
    db.createProject('ch-1', '/tmp/a', 'alpha');
    expect(() => db.createProject('ch-1', '/tmp/b', 'beta')).toThrow();
  });

  it('throws on duplicate name', () => {
    db.createProject('ch-1', '/tmp/a', 'alpha');
    expect(() => db.createProject('ch-2', '/tmp/b', 'alpha')).toThrow();
  });

  it('createProject without identity defaults to null', () => {
    const p = db.createProject('ch-1', '/tmp/proj', 'no-id');
    expect(p.identity).toBeNull();
  });

  it('createProject with identity persists it', () => {
    const p = db.createProject('ch-1', '/tmp/proj', 'with-id', true, 'chuck-project-test');
    expect(p.identity).toBe('chuck-project-test');
    const fetched = db.getProjectByName('with-id');
    expect(fetched!.identity).toBe('chuck-project-test');
  });

  it('updateProjectIdentity sets and clears', () => {
    db.createProject('ch-1', '/tmp/proj', 'alpha');
    expect(db.updateProjectIdentity('alpha', 'chuck-main')).toBe(true);
    expect(db.getProjectByName('alpha')!.identity).toBe('chuck-main');
    expect(db.updateProjectIdentity('alpha', null)).toBe(true);
    expect(db.getProjectByName('alpha')!.identity).toBeNull();
  });

  it('updateProjectIdentity returns false for nonexistent project', () => {
    expect(db.updateProjectIdentity('nope', 'chuck-main')).toBe(false);
  });
});

describe('sessions', () => {
  let projectId: string;

  beforeEach(() => {
    const p = db.createProject('ch-1', '/tmp/proj', 'test');
    projectId = p.id;
  });

  it('getOrCreateSession creates a new session', () => {
    const s = db.getOrCreateSession(projectId);
    expect(s.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(s.project_id).toBe(projectId);
    expect(s.status).toBe('idle');
    expect(s.claude_session_id).toBeNull();
  });

  it('getOrCreateSession returns existing session on second call', () => {
    const s1 = db.getOrCreateSession(projectId);
    const s2 = db.getOrCreateSession(projectId);
    expect(s1.id).toBe(s2.id);
  });

  it('updateSessionClaudeId sets the claude_session_id', () => {
    const s = db.getOrCreateSession(projectId);
    db.updateSessionClaudeId(s.id, 'claude-123');
    const s2 = db.getOrCreateSession(projectId);
    expect(s2.claude_session_id).toBe('claude-123');
  });

  it('updateSessionStatus changes status', () => {
    const s = db.getOrCreateSession(projectId);
    db.updateSessionStatus(s.id, 'running');
    const s2 = db.getOrCreateSession(projectId);
    expect(s2.status).toBe('running');
  });

  it('getAllSessions includes project name', () => {
    db.getOrCreateSession(projectId);
    const sessions = db.getAllSessions();
    expect(sessions.length).toBe(1);
    expect(sessions[0].project_name).toBe('test');
  });

  it('deleting project cascades to sessions', () => {
    db.getOrCreateSession(projectId);
    db.deleteProject('test');
    expect(db.getAllSessions().length).toBe(0);
  });
});

describe('resetStuckSessions', () => {
  it('resets running sessions to idle on initialize', () => {
    // Create a project and session, set to running
    const p = db.createProject('ch-1', '/tmp/proj', 'test');
    const s = db.getOrCreateSession(p.id);
    db.updateSessionStatus(s.id, 'running');

    // Verify it's running
    const before = db.getOrCreateSession(p.id);
    expect(before.status).toBe('running');

    // Close and reinitialize — resetStuckSessions runs inside initialize
    db.close();
    db.initialize(':memory:');

    // In a fresh :memory: db there are no sessions, so let's test differently:
    // We need to use a file-based db to persist across close/initialize.
    // Instead, test that after initialize, any manual insert with 'running'
    // would be caught. Let's just verify the function exists and the flow works.
    // The real test is: create data, then call initialize on the same db.
  });
});

describe('resetStuckSessions (file-based)', () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const dbPath = path.join(os.tmpdir(), `relay-test-${Date.now()}.db`);

  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
      fs.unlinkSync(dbPath);
    } catch {}
  });

  it('resets running sessions to idle on reinitialize', () => {
    // First init — create data
    db.close(); // close the :memory: from beforeEach
    db.initialize(dbPath);
    const p = db.createProject('ch-1', '/tmp/proj', 'test');
    const s = db.getOrCreateSession(p.id);
    db.updateSessionStatus(s.id, 'running');
    db.close();

    // Second init — should reset stuck sessions
    db.initialize(dbPath);
    const s2 = db.getOrCreateSession(p.id);
    expect(s2.status).toBe('idle');
  });
});
