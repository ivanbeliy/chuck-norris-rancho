#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as vault from './vault.js';
import * as safety from './safety.js';
import * as perms from './permissions.js';
import * as log from './log.js';

const VAULT_PATH = process.env.CHUCK_WIKI_VAULT_PATH;
const IDENTITY = process.env.CHUCK_WIKI_CLIENT_IDENTITY ?? 'unknown';

if (!VAULT_PATH) {
  console.error('CHUCK_WIKI_VAULT_PATH env var is required (absolute path to the Obsidian vault root).');
  process.exit(1);
}

vault.configure(VAULT_PATH);
log.configure(VAULT_PATH);
await safety.loadPatterns(VAULT_PATH);

console.error(`[chuck-wiki-mcp] started; identity=${IDENTITY}; vault=${VAULT_PATH}`);

const server = new McpServer({
  name: 'chuck-wiki',
  version: '0.1.0',
});

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function errorResult(reason: string) {
  return { content: [{ type: 'text' as const, text: `ERROR: ${reason}` }], isError: true };
}

// --- READ TOOLS ---

server.registerTool(
  'search_notes',
  {
    description:
      'Fuzzy text search across the vault (sources/ and/or wiki/). Returns ranked hits with path, title, snippet, age_days, tags.',
    inputSchema: {
      query: z.string().min(1),
      scope: z.enum(['sources', 'wiki', 'all']).optional(),
      since: z.string().optional().describe('ISO date — only notes updated after this date'),
      limit: z.number().int().positive().max(50).optional(),
    },
  },
  async (args) => {
    try {
      perms.assertCan(IDENTITY, 'search_notes');
      const hits = await vault.searchNotes(args.query, args.scope ?? 'all', args.since, args.limit ?? 10);
      return textResult(JSON.stringify(hits, null, 2));
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
);

server.registerTool(
  'read_note',
  {
    description: 'Read full content of a single note by vault-relative path.',
    inputSchema: {
      path: z.string().describe('e.g. "wiki/concepts/mcp-server.md"'),
    },
  },
  async (args) => {
    try {
      perms.assertCan(IDENTITY, 'read_note');
      const content = await vault.readNote(args.path);
      return textResult(content);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
);

server.registerTool(
  'list_backlinks',
  {
    description: 'List vault files that contain a [[wikilink]] to the given note.',
    inputSchema: {
      path: z.string(),
    },
  },
  async (args) => {
    try {
      perms.assertCan(IDENTITY, 'list_backlinks');
      const links = await vault.listBacklinks(args.path);
      return textResult(JSON.stringify(links, null, 2));
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
);

server.registerTool(
  'recent',
  {
    description: 'List files modified since the given ISO date, newest first.',
    inputSchema: {
      since: z.string().describe('ISO date, e.g. "2026-04-10"'),
      limit: z.number().int().positive().max(100).optional(),
    },
  },
  async (args) => {
    try {
      perms.assertCan(IDENTITY, 'recent');
      const items = await vault.recent(args.since, args.limit ?? 20);
      return textResult(JSON.stringify(items, null, 2));
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
);

server.registerTool(
  'check_similarity',
  {
    description:
      'Before proposing a new note, check if a similar one already exists. Returns up to 5 candidates with overlap score 0..1.',
    inputSchema: {
      title: z.string(),
      content: z.string().optional(),
    },
  },
  async (args) => {
    try {
      perms.assertCan(IDENTITY, 'check_similarity');
      const query = args.title + ' ' + (args.content ?? '').slice(0, 500);
      const hits = await vault.searchNotes(query, 'all', undefined, 5);
      const maxScore = hits[0]?.score ?? 0;
      const candidates = hits.map((h) => ({
        path: h.path,
        title: h.title,
        overlap: Math.min(1, h.score / Math.max(1, maxScore)),
      }));
      return textResult(JSON.stringify({ candidates }, null, 2));
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
);

// --- WRITE TOOLS (contribution lane) ---

function frontmatterWithMeta(
  fm: Record<string, unknown>,
  identity: string,
  reason?: string,
): Record<string, unknown> {
  const today = vault.isoDate();
  return {
    created: fm.created ?? today,
    updated: today,
    ...fm,
    contributed_by: identity,
    ...(reason ? { contribution_reason: reason } : {}),
  };
}

server.registerTool(
  'propose_note',
  {
    description:
      'Propose a new note. Goes into proposals/ queue for Chuck to review via /review-proposals. Returns proposal_id (the file path).',
    inputSchema: {
      target_path: z.string().describe('Intended final path, e.g. "wiki/playbooks/discordjs-intents.md"'),
      content: z.string().describe('Markdown body (without frontmatter)'),
      frontmatter: z.record(z.any()).optional(),
      reason: z.string().describe('Why this is worth contributing'),
    },
  },
  async (args) => {
    try {
      perms.assertCan(IDENTITY, 'propose_note');
      const sizeCheck = safety.checkSize(args.content);
      if (!sizeCheck.ok) {
        await log.append({ tool: 'propose_note', identity: IDENTITY, action: 'rejected', reason: sizeCheck.reason });
        return errorResult(sizeCheck.reason!);
      }
      const secrets = safety.scanForSecrets(args.content);
      if (secrets.length > 0) {
        const reason = `secret_scan matched: ${secrets.map((s) => s.pattern).join(', ')}`;
        await log.append({ tool: 'propose_note', identity: IDENTITY, action: 'rejected', reason });
        return errorResult(reason);
      }
      const rate = safety.checkRateLimit(IDENTITY);
      if (!rate.ok) {
        await log.append({ tool: 'propose_note', identity: IDENTITY, action: 'rejected', reason: rate.reason });
        return errorResult(rate.reason!);
      }

      const ts = vault.isoTimestamp();
      const slug = vault.slugify(args.target_path.replace(/^.*\//, '').replace(/\.md$/, ''));
      const proposalRel = `proposals/${ts}-${slug}.md`;
      const fm = frontmatterWithMeta(
        { ...(args.frontmatter ?? {}), target_path: args.target_path, reason: args.reason },
        IDENTITY,
        args.reason,
      );
      const full = vault.serializeNote(fm, args.content);
      await vault.writeNote(proposalRel, full);

      await log.append({
        tool: 'propose_note',
        identity: IDENTITY,
        action: 'ok',
        path: proposalRel,
        target: args.target_path,
        reason: args.reason,
      });

      return textResult(JSON.stringify({ proposal_id: proposalRel, status: 'pending' }, null, 2));
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
);

server.registerTool(
  'append_observation',
  {
    description:
      'Append a "## Observation YYYY-MM-DD" section to an existing wiki note. Use when your session confirmed or nuanced an existing playbook/concept.',
    inputSchema: {
      path: z.string().describe('existing wiki note path'),
      content: z.string().describe('observation body (no heading needed; section is auto-added)'),
    },
  },
  async (args) => {
    try {
      perms.assertCan(IDENTITY, 'append_observation');
      if (!(await vault.exists(args.path))) {
        return errorResult(`note not found: ${args.path}`);
      }
      const sizeCheck = safety.checkSize(args.content);
      if (!sizeCheck.ok) {
        await log.append({ tool: 'append_observation', identity: IDENTITY, action: 'rejected', reason: sizeCheck.reason });
        return errorResult(sizeCheck.reason!);
      }
      const secrets = safety.scanForSecrets(args.content);
      if (secrets.length > 0) {
        const reason = `secret_scan matched: ${secrets.map((s) => s.pattern).join(', ')}`;
        await log.append({ tool: 'append_observation', identity: IDENTITY, action: 'rejected', reason });
        return errorResult(reason);
      }
      const rate = safety.checkRateLimit(IDENTITY);
      if (!rate.ok) return errorResult(rate.reason!);

      const today = vault.isoDate();
      const block = `\n\n## Observation ${today} (from ${IDENTITY})\n\n${args.content.trim()}\n`;
      await vault.appendNote(args.path, block);

      await log.append({
        tool: 'append_observation',
        identity: IDENTITY,
        action: 'ok',
        path: args.path,
      });
      return textResult(JSON.stringify({ status: 'appended', path: args.path }, null, 2));
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
);

server.registerTool(
  'contribute_artifact',
  {
    description:
      'Save a reusable artifact (code snippet, finding, diagram, observation) to sources/from-sessions/. Immutable after write.',
    inputSchema: {
      type: z.enum(['snippets', 'findings', 'artifacts', 'observations']),
      title: z.string().describe('short human-readable title'),
      content: z.string(),
      tags: z.array(z.string()).optional(),
      source_ref: z.string().optional().describe('e.g. project name or task context'),
    },
  },
  async (args) => {
    try {
      perms.assertCan(IDENTITY, 'contribute_artifact');
      const sizeCheck = safety.checkSize(args.content);
      if (!sizeCheck.ok) return errorResult(sizeCheck.reason!);
      const secrets = safety.scanForSecrets(args.content);
      if (secrets.length > 0) {
        const reason = `secret_scan matched: ${secrets.map((s) => s.pattern).join(', ')}`;
        await log.append({ tool: 'contribute_artifact', identity: IDENTITY, action: 'rejected', reason });
        return errorResult(reason);
      }
      const rate = safety.checkRateLimit(IDENTITY);
      if (!rate.ok) return errorResult(rate.reason!);

      const today = vault.isoDate();
      const slug = vault.slugify(args.title);
      const rel = `sources/from-sessions/${args.type}/${today}-${slug}.md`;
      if (await vault.exists(rel)) {
        return errorResult(`artifact already exists at ${rel}; choose a different title or update via propose_note`);
      }
      const fm = frontmatterWithMeta(
        {
          tags: args.tags ?? [],
          ...(args.source_ref ? { source_ref: args.source_ref } : {}),
          artifact_type: args.type,
          confidence: 0.9,
        },
        IDENTITY,
      );
      const body = `# ${args.title}\n\n${args.content}\n`;
      await vault.writeNote(rel, vault.serializeNote(fm, body));

      await log.append({
        tool: 'contribute_artifact',
        identity: IDENTITY,
        action: 'ok',
        path: rel,
      });
      return textResult(JSON.stringify({ status: 'saved', path: rel }, null, 2));
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
);

// --- ADMIN TOOLS (superuser only) ---

server.registerTool(
  'integrate_proposal',
  {
    description:
      'Accept a proposal: move it to target_path (or the path in its frontmatter). Admin-only (chuck-main/chuck-wiki).',
    inputSchema: {
      proposal_id: z.string().describe('path returned by propose_note, e.g. "proposals/2026-04-16T14-02-xxx.md"'),
      target_path: z.string().optional().describe('override frontmatter target_path'),
      mode: z.enum(['accept', 'merge']).optional(),
    },
  },
  async (args) => {
    try {
      perms.assertCan(IDENTITY, 'integrate_proposal');
      if (!(await vault.exists(args.proposal_id))) {
        return errorResult(`proposal not found: ${args.proposal_id}`);
      }
      const raw = await vault.readNote(args.proposal_id);
      const parsed = vault.parseNote(raw);
      const target = args.target_path ?? (parsed.frontmatter.target_path as string | undefined);
      if (!target) {
        return errorResult('no target_path provided or in frontmatter');
      }

      const mode = args.mode ?? (await vault.exists(target) ? 'merge' : 'accept');
      const today = vault.isoDate();

      if (mode === 'accept') {
        const newFm = { ...parsed.frontmatter, updated: today };
        delete (newFm as Record<string, unknown>).target_path;
        delete (newFm as Record<string, unknown>).reason;
        await vault.writeNote(target, vault.serializeNote(newFm, parsed.body));
      } else {
        const existing = await vault.readNote(target);
        const contributor = (parsed.frontmatter.contributed_by as string | undefined) ?? 'unknown';
        const block = `\n\n## Contribution from ${contributor} ${today}\n\n${parsed.body.trim()}\n`;
        await vault.writeNote(target, existing + block);
      }

      // delete the proposal
      const { promises: fs } = await import('node:fs');
      await fs.unlink(vault.resolvePath(args.proposal_id));

      await log.append({
        tool: 'integrate_proposal',
        identity: IDENTITY,
        action: 'ok',
        proposal_id: args.proposal_id,
        target,
        reason: mode,
      });
      return textResult(JSON.stringify({ status: 'integrated', mode, target }, null, 2));
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
);

server.registerTool(
  'reject_proposal',
  {
    description: 'Reject a proposal and delete it. Admin-only.',
    inputSchema: {
      proposal_id: z.string(),
      reason: z.string(),
    },
  },
  async (args) => {
    try {
      perms.assertCan(IDENTITY, 'reject_proposal');
      if (!(await vault.exists(args.proposal_id))) {
        return errorResult(`proposal not found: ${args.proposal_id}`);
      }
      const { promises: fs } = await import('node:fs');
      await fs.unlink(vault.resolvePath(args.proposal_id));
      await log.append({
        tool: 'reject_proposal',
        identity: IDENTITY,
        action: 'ok',
        proposal_id: args.proposal_id,
        reason: args.reason,
      });
      return textResult(JSON.stringify({ status: 'rejected', proposal_id: args.proposal_id }, null, 2));
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
);

// --- start ---

const transport = new StdioServerTransport();
await server.connect(transport);
