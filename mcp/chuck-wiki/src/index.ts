#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as vault from './vault.js';
import * as safety from './safety.js';
import * as perms from './permissions.js';
import * as log from './log.js';
import { getIdentity, setStdioIdentity } from './identity.js';
import { startHttpServer } from './http-server.js';
import { evaluateConflict, extractTlDr, integrateProposalInPlace } from './decide.js';
import { postToDiscord } from './notify.js';

const MODE = (process.env.CHUCK_WIKI_MCP_MODE ?? 'stdio') as 'stdio' | 'http';
const VAULT_PATH = process.env.CHUCK_WIKI_VAULT_PATH;

if (!VAULT_PATH) {
  console.error('CHUCK_WIKI_VAULT_PATH env var is required (absolute path to the Obsidian vault root).');
  process.exit(1);
}

vault.configure(VAULT_PATH);
log.configure(VAULT_PATH);
await safety.loadPatterns(VAULT_PATH);

if (MODE === 'stdio') {
  const id = process.env.CHUCK_WIKI_CLIENT_IDENTITY ?? 'unknown';
  setStdioIdentity(id);
  console.error(`[chuck-wiki-mcp] started; mode=stdio; identity=${id}; vault=${VAULT_PATH}`);
} else {
  console.error(`[chuck-wiki-mcp] starting; mode=http; vault=${VAULT_PATH}`);
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function errorResult(reason: string) {
  return { content: [{ type: 'text' as const, text: `ERROR: ${reason}` }], isError: true };
}

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

// Factory: new McpServer with all tools registered.
// stdio mode: called once. http mode: called per session.
export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'chuck-wiki',
    version: '0.1.0',
  });

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
        perms.assertCan(getIdentity(), 'search_notes');
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
        perms.assertCan(getIdentity(), 'read_note');
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
        perms.assertCan(getIdentity(), 'list_backlinks');
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
        perms.assertCan(getIdentity(), 'recent');
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
        perms.assertCan(getIdentity(), 'check_similarity');
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
      const identity = getIdentity();
      try {
        perms.assertCan(identity, 'propose_note');
        const sizeCheck = safety.checkSize(args.content);
        if (!sizeCheck.ok) {
          await log.append({ tool: 'propose_note', identity, action: 'rejected', reason: sizeCheck.reason });
          return errorResult(sizeCheck.reason!);
        }
        const secrets = safety.scanForSecrets(args.content);
        if (secrets.length > 0) {
          const reason = `secret_scan matched: ${secrets.map((s) => s.pattern).join(', ')}`;
          await log.append({ tool: 'propose_note', identity, action: 'rejected', reason });
          return errorResult(reason);
        }
        const rate = safety.checkRateLimit(identity);
        if (!rate.ok) {
          await log.append({ tool: 'propose_note', identity, action: 'rejected', reason: rate.reason });
          return errorResult(rate.reason!);
        }

        const ts = vault.isoTimestamp();
        const slug = vault.slugify(args.target_path.replace(/^.*\//, '').replace(/\.md$/, ''));
        const proposalRel = `proposals/${ts}-${slug}.md`;
        const fm = frontmatterWithMeta(
          { ...(args.frontmatter ?? {}), target_path: args.target_path, reason: args.reason },
          identity,
          args.reason,
        );
        const full = vault.serializeNote(fm, args.content);
        await vault.writeNote(proposalRel, full);

        // Decide: auto-integrate or keep pending for human review.
        const titleForSearch = slug.replace(/-/g, ' ');
        const decision = await evaluateConflict(args.target_path, args.content, titleForSearch);
        const tldr = extractTlDr(args.content);

        if (decision.kind === 'AUTO_INTEGRATE') {
          await integrateProposalInPlace(proposalRel, args.target_path, vault.isoDate());
          await log.append({
            tool: 'propose_note',
            identity,
            action: 'ok+auto-integrated',
            path: args.target_path,
            target: args.target_path,
            reason: args.reason,
          });
          const wikiLink = `[[${args.target_path.replace(/^wiki\//, '').replace(/\.md$/, '')}]]`;
          postToDiscord(`✅ auto-added ${wikiLink} from \`${identity}\`\n${tldr}`);
          return textResult(
            JSON.stringify({ status: 'auto-integrated', path: args.target_path, tldr }, null, 2),
          );
        }

        const reasonText = 'reason' in decision ? decision.reason : 'conflict';
        await log.append({
          tool: 'propose_note',
          identity,
          action: 'ok+pending',
          path: proposalRel,
          target: args.target_path,
          reason: `${args.reason}; decision=${decision.kind}: ${reasonText}`,
        });
        postToDiscord(
          `⚠️ proposal needs review: \`${args.target_path}\` from \`${identity}\`\n**Why pending:** ${reasonText}\n**TL;DR:** ${tldr}\nRun \`/review-proposals\` in #wiki.`,
        );
        return textResult(
          JSON.stringify(
            {
              proposal_id: proposalRel,
              status: 'pending',
              decision: decision.kind,
              reason: reasonText,
            },
            null,
            2,
          ),
        );
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
      const identity = getIdentity();
      try {
        perms.assertCan(identity, 'append_observation');
        if (!(await vault.exists(args.path))) {
          return errorResult(`note not found: ${args.path}`);
        }
        const sizeCheck = safety.checkSize(args.content);
        if (!sizeCheck.ok) {
          await log.append({ tool: 'append_observation', identity, action: 'rejected', reason: sizeCheck.reason });
          return errorResult(sizeCheck.reason!);
        }
        const secrets = safety.scanForSecrets(args.content);
        if (secrets.length > 0) {
          const reason = `secret_scan matched: ${secrets.map((s) => s.pattern).join(', ')}`;
          await log.append({ tool: 'append_observation', identity, action: 'rejected', reason });
          return errorResult(reason);
        }
        const rate = safety.checkRateLimit(identity);
        if (!rate.ok) return errorResult(rate.reason!);

        const today = vault.isoDate();
        const block = `\n\n## Observation ${today} (from ${identity})\n\n${args.content.trim()}\n`;
        await vault.appendNote(args.path, block);

        await log.append({
          tool: 'append_observation',
          identity,
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
      const identity = getIdentity();
      try {
        perms.assertCan(identity, 'contribute_artifact');
        const sizeCheck = safety.checkSize(args.content);
        if (!sizeCheck.ok) return errorResult(sizeCheck.reason!);
        const secrets = safety.scanForSecrets(args.content);
        if (secrets.length > 0) {
          const reason = `secret_scan matched: ${secrets.map((s) => s.pattern).join(', ')}`;
          await log.append({ tool: 'contribute_artifact', identity, action: 'rejected', reason });
          return errorResult(reason);
        }
        const rate = safety.checkRateLimit(identity);
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
          identity,
        );
        const body = `# ${args.title}\n\n${args.content}\n`;
        await vault.writeNote(rel, vault.serializeNote(fm, body));

        await log.append({
          tool: 'contribute_artifact',
          identity,
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
      const identity = getIdentity();
      try {
        perms.assertCan(identity, 'integrate_proposal');
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
          await integrateProposalInPlace(args.proposal_id, target, today);
        } else {
          const existing = await vault.readNote(target);
          const contributor = (parsed.frontmatter.contributed_by as string | undefined) ?? 'unknown';
          const block = `\n\n## Contribution from ${contributor} ${today}\n\n${parsed.body.trim()}\n`;
          await vault.writeNote(target, existing + block);
          const { promises: fs } = await import('node:fs');
          await fs.unlink(vault.resolvePath(args.proposal_id));
        }

        await log.append({
          tool: 'integrate_proposal',
          identity,
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
      const identity = getIdentity();
      try {
        perms.assertCan(identity, 'reject_proposal');
        if (!(await vault.exists(args.proposal_id))) {
          return errorResult(`proposal not found: ${args.proposal_id}`);
        }
        const { promises: fs } = await import('node:fs');
        await fs.unlink(vault.resolvePath(args.proposal_id));
        await log.append({
          tool: 'reject_proposal',
          identity,
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

  return server;
}

// --- Bootstrap ---

if (MODE === 'stdio') {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
} else {
  const port = Number(process.env.CHUCK_WIKI_MCP_PORT ?? 8765);
  const bind = process.env.CHUCK_WIKI_MCP_BIND ?? '127.0.0.1';
  const secret = process.env.CHUCK_WIKI_MCP_SECRET;
  if (!secret) {
    console.error('CHUCK_WIKI_MCP_SECRET env var is required in http mode');
    process.exit(1);
  }
  await startHttpServer({ port, bind, secret, createMcpServer });
  console.error(`[chuck-wiki-mcp] HTTP listening on ${bind}:${port}`);
}
