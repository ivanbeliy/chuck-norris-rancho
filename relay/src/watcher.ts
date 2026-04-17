import { promises as fs, watch, FSWatcher } from 'node:fs';
import * as path from 'node:path';
import { Client, ChannelType } from 'discord.js';
import * as db from './db.js';
import * as router from './router.js';
import * as fmt from './discord-format.js';

const DEBOUNCE_MS = 2000;
const DEDUP_WINDOW_MS = 30_000;

let fsWatcher: FSWatcher | null = null;

export function startWatcher(client: Client): void {
  // Pick the project registered with identity 'chuck-wiki' as the KB vault.
  const projects = db.getAllProjects();
  const wiki = projects.find((p) => p.identity === 'chuck-wiki');
  if (!wiki) {
    console.log(
      `[${new Date().toISOString()}] [watcher] no chuck-wiki project registered; auto-review disabled`,
    );
    return;
  }

  const proposalsDir = path.join(wiki.project_path, 'proposals');
  fs.mkdir(proposalsDir, { recursive: true }).catch(() => {});

  const recentTriggers = new Set<string>();

  fsWatcher = watch(proposalsDir, async (eventType, filename) => {
    if (!filename || !filename.toString().endsWith('.md')) return;
    if (eventType !== 'rename') return;

    const fname = filename.toString();
    if (recentTriggers.has(fname)) return;
    recentTriggers.add(fname);
    setTimeout(() => recentTriggers.delete(fname), DEDUP_WINDOW_MS);

    // Let the file fully land + give MCP a chance to AUTO_INTEGRATE (which deletes the file).
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS));

    const fullPath = path.join(proposalsDir, fname);
    try {
      await fs.access(fullPath);
    } catch {
      // File is gone — most likely AUTO_INTEGRATE moved it to wiki/. Nothing for us to do.
      return;
    }

    try {
      const channel = await client.channels.fetch(wiki.discord_channel_id);
      if (!channel || channel.type !== ChannelType.GuildText) return;

      console.log(
        `[${new Date().toISOString()}] [watcher] auto-review triggered for ${fname}`,
      );
      await channel.sendTyping().catch(() => {});
      const result = await router.handleAutoReview(wiki, fname);

      if (result.success) {
        const formatted = fmt.formatResult(result.result, result.costUsd);
        for (const chunk of fmt.splitMessage(formatted)) {
          await channel.send(chunk);
        }
      } else {
        await channel.send(
          fmt.formatError(`auto-review failed for ${fname}: ${result.error ?? 'unknown error'}`),
        );
      }
    } catch (err) {
      console.error(
        `[${new Date().toISOString()}] [watcher] error handling ${fname}:`,
        err,
      );
    }
  });

  console.log(
    `[${new Date().toISOString()}] [watcher] watching ${proposalsDir} for new proposals`,
  );
}

export function stopWatcher(): void {
  if (fsWatcher) {
    fsWatcher.close();
    fsWatcher = null;
  }
}
