/**
 * Channel-agnostic notification layer.
 *
 * Today: sends to Discord via the existing Relay bot client.
 * Tomorrow: if we swap the backend (Telegram, Matrix, Slack, etc.),
 * callers don't change — they invoke `sendToProjectChannel(projectName, text, level)`.
 * Only the resolver inside this module changes.
 */

import type { Client, TextBasedChannel } from 'discord.js';
import * as db from './db.js';

export type NotifyLevel = 'info' | 'warn' | 'error';

const LEVEL_PREFIX: Record<NotifyLevel, string> = {
  info: '',
  warn: '⚠️ ',
  error: '🚨 ',
};

const DISCORD_MAX = 2000;
const SAFE_MAX = 1990;

let discordClient: Client | null = null;

export function setDiscordClient(c: Client): void {
  discordClient = c;
}

export async function sendToProjectChannel(
  projectName: string,
  content: string,
  level: NotifyLevel = 'info',
): Promise<void> {
  const project = db.getProjectByName(projectName);
  if (!project) {
    throw new Error(`project not found: ${projectName}`);
  }

  if (!discordClient) {
    throw new Error('notify: Discord client not initialized yet');
  }

  const channel = await discordClient.channels.fetch(project.discord_channel_id);
  if (!channel || !channel.isTextBased()) {
    throw new Error(`notify: channel not text-based or missing: ${project.discord_channel_id}`);
  }

  const prefix = LEVEL_PREFIX[level] ?? '';
  const body = prefix + content;
  const payload = body.length > SAFE_MAX ? body.slice(0, SAFE_MAX) + '…' : body;

  await (channel as TextBasedChannel & { send: (s: string) => Promise<unknown> }).send(payload);
}
