# chuck-wiki-mcp

MCP (Model Context Protocol) server that exposes Chuck's Obsidian vault (`chuck-norris-wiki`) to Claude Code sessions — read + contribute.

Spec: [chuck-norris-agent/PRODUCT.md §3.2, §6.3](https://github.com/ivanbeliy/chuck-norris-agent/blob/main/PRODUCT.md).

## Tools

### Read (any identity)
- `search_notes(query, scope?, since?, limit?)` — ranked fuzzy search
- `read_note(path)` — full content of one note
- `list_backlinks(path)` — files linking to the given note
- `recent(since, limit?)` — files modified since date
- `check_similarity(title, content?)` — dup-check before `propose_note`

### Contribute (Chuck + project sessions + workstations)
- `propose_note(target_path, content, frontmatter?, reason)` — queue into `proposals/` for review
- `append_observation(path, content)` — add `## Observation YYYY-MM-DD` to existing wiki page
- `contribute_artifact(type, title, content, tags?, source_ref?)` — save snippet/finding/artifact/observation to `sources/from-sessions/<type>/`

### Admin (Chuck @ #general / #wiki only)
- `integrate_proposal(proposal_id, target_path?, mode?)` — accept or merge a pending proposal
- `reject_proposal(proposal_id, reason)` — reject and delete

## Safety middleware

Every write tool:
1. Enforces permissions per `src/permissions.ts` (identity-based access matrix).
2. Scans content against `<vault>/_meta/policies/secret-patterns.txt` — match → reject.
3. Enforces rate limit (10 contributions/hour per identity).
4. Enforces max note size (50 KB).
5. Logs the call (accepted or rejected) to `<vault>/_meta/contributions-log.jsonl`.

## Install

```bash
cd mcp/chuck-wiki
npm install
npm run build
```

## Run

Stdio transport. Needs two env vars:

| Env | Required | Example |
|---|---|---|
| `CHUCK_WIKI_VAULT_PATH` | yes | `/Users/i.beliy/vault` |
| `CHUCK_WIKI_CLIENT_IDENTITY` | yes (for write tools) | `chuck-main`, `chuck-project-rancho`, `workstation-windows` |

Identity prefixes recognized by the access matrix:
- `chuck-main`, `chuck-wiki` → superuser (all tools)
- `chuck-project-*` → read + contribute (no admin)
- `workstation-*` → read + contribute (no admin)
- anything else → read-only

## Claude Code config

Add to `~/.claude/settings.json` (or per-project `.claude/settings.json`):

```json
{
  "mcpServers": {
    "chuck-wiki": {
      "command": "node",
      "args": ["/absolute/path/to/chuck-norris-rancho/mcp/chuck-wiki/dist/index.js"],
      "env": {
        "CHUCK_WIKI_VAULT_PATH": "/Users/i.beliy/vault",
        "CHUCK_WIKI_CLIENT_IDENTITY": "chuck-main"
      }
    }
  }
}
```

For Chuck on Mac Mini: set identity based on channel (injected by Relay — TBD, step 2 of the PRD). For Windows workstation: `CHUCK_WIKI_CLIENT_IDENTITY=workstation-windows`.

## Deploy (Mac Mini)

Install path: `~/chuck-norris-rancho/mcp/chuck-wiki/` (deployed via rancho's deploy script).

For v1 the MCP server is spawned per-session by Claude Code — no separate daemon needed. If we later want HTTP transport with Tailscale, that's a follow-up.

## Dev

```bash
CHUCK_WIKI_VAULT_PATH=/path/to/test/vault \
CHUCK_WIKI_CLIENT_IDENTITY=workstation-dev \
npm run dev
```

Then talk stdio MCP to it (Claude Code, MCP Inspector, or custom client).

## Tests

```bash
npm test
```

(TODO: write vault/safety/permissions tests; tracked in step 4 follow-up.)
