# Relay

Thin Discord-to-Claude-Code transport layer. Part of the WhiteClaw infrastructure project.

## Architecture

Discord message -> Relay (discord.js bot) -> child_process.spawn('claude', [...]) -> Parse JSON -> Reply to Discord

Relay is a dumb pipe. All intelligence lives inside Claude Code sessions, driven by per-project CLAUDE.md files.

## Tech Stack

- Node.js 22, TypeScript, CommonJS modules
- discord.js 14 (bot framework)
- better-sqlite3 (synchronous SQLite)
- dotenv (env file loading)

## Project Structure

- `src/index.ts` — entry point, bootstrap, graceful shutdown
- `src/bot.ts` — Discord client, slash commands, event handlers
- `src/db.ts` — SQLite schema and queries (projects, sessions)
- `src/spawner.ts` — Claude CLI process spawning, JSON output parsing, timeout
- `src/router.ts` — Message routing: channel -> project -> session -> spawn -> reply
- `src/discord-format.ts` — Output formatting and 2000-char message splitting

## Build & Run

```bash
npm run build   # compile TypeScript to dist/
npm start       # run compiled JS
npm run dev     # run TypeScript directly with tsx (development)
```

## Conventions

- All database operations are synchronous (better-sqlite3)
- IDs use `crypto.randomUUID()`
- Logging via `console.log`/`console.error` with ISO timestamps
- No `--bare` flag on Claude CLI (preserves CLAUDE.md auto-discovery, OAuth, plugins)
- Working directory for Claude is set via spawn `cwd` option, not a CLI flag
- One task at a time per project (reject if busy)
- Session resumed via `--resume <session_id>` for conversation continuity

## Key Constraints

Relay MUST NOT:
- Create its own agent loop
- Modify prompts or add system prompts
- Use Claude API directly
- Use `--bare` flag (breaks OAuth subscription auth and CLAUDE.md discovery)
