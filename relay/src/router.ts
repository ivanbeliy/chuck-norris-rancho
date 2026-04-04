import { Message, Attachment } from 'discord.js';
import { pipeline } from 'stream/promises';
import { createWriteStream } from 'fs';
import { mkdir } from 'fs/promises';
import { Readable } from 'stream';
import * as path from 'path';
import * as db from './db.js';
import * as spawner from './spawner.js';
import * as fmt from './discord-format.js';

const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024; // 25 MB

// Message buffer: while a project is busy, incoming messages accumulate here
const messageBuffer = new Map<string, Message[]>();

export function getBufferedCount(projectPath: string): number {
  return messageBuffer.get(projectPath)?.length ?? 0;
}

interface SavedAttachment {
  name: string;
  filePath: string;
  contentType: string | null;
  size: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Download Discord attachments to the project's .attachments/ directory.
 */
export async function downloadAttachments(
  attachments: Message['attachments'],
  projectPath: string,
): Promise<SavedAttachment[]> {
  if (!attachments.size) return [];

  const dir = path.join(projectPath, '.attachments');
  await mkdir(dir, { recursive: true });

  const saved: SavedAttachment[] = [];
  for (const [, att] of attachments) {
    if (att.size > MAX_ATTACHMENT_SIZE) {
      console.log(
        `[${new Date().toISOString()}] Skipping attachment ${att.name} (${formatBytes(att.size)} > ${formatBytes(MAX_ATTACHMENT_SIZE)})`,
      );
      continue;
    }

    const fileName = `${Date.now()}-${att.name}`;
    const filePath = path.join(dir, fileName);

    try {
      const response = await fetch(att.url);
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`);
      }
      const readable = Readable.fromWeb(response.body as any);
      await pipeline(readable, createWriteStream(filePath));

      saved.push({
        name: att.name,
        filePath,
        contentType: att.contentType,
        size: att.size,
      });
    } catch (err) {
      console.error(
        `[${new Date().toISOString()}] Failed to download attachment ${att.name}:`,
        err,
      );
    }
  }

  return saved;
}

/**
 * Build prompt for a single message including reply context, forwards, and attachments.
 */
export async function buildPrompt(
  message: Message,
  savedAttachments: SavedAttachment[] = [],
): Promise<string> {
  const parts: string[] = [];

  // Handle reply — fetch the referenced message and include as context
  if (message.reference?.messageId) {
    try {
      const ref = await message.channel.messages.fetch(
        message.reference.messageId,
      );
      const author = ref.author?.tag || 'Unknown';
      let refContent = ref.content || '';

      // Include embed text if the referenced message has embeds
      if (ref.embeds.length > 0) {
        const embedTexts = ref.embeds
          .map((e) => [e.title, e.description].filter(Boolean).join(': '))
          .filter(Boolean);
        if (embedTexts.length > 0) {
          refContent += (refContent ? '\n' : '') + embedTexts.join('\n');
        }
      }

      if (refContent) {
        parts.push(
          `[Replying to message from ${author}]\n${refContent}\n\n[Your message]`,
        );
      }
    } catch {
      // Can't fetch referenced message — proceed without context
    }
  }

  // Handle forwarded messages (Discord message snapshots, discord.js v14.16+)
  if (message.messageSnapshots?.size) {
    for (const [, snap] of message.messageSnapshots) {
      const fwdContent = snap.content || '';
      const embedTexts = (snap.embeds || [])
        .map((e) => [e.title, e.description].filter(Boolean).join(': '))
        .filter(Boolean);
      const combined = [fwdContent, ...embedTexts].filter(Boolean).join('\n');
      if (combined) {
        parts.push(`[Forwarded message]\n${combined}\n`);
      }
    }
  }

  // Include attachment info
  if (savedAttachments.length > 0) {
    const fileList = savedAttachments
      .map((f) => `- ${f.filePath} (${f.name}, ${f.contentType || 'unknown'}, ${formatBytes(f.size)})`)
      .join('\n');
    parts.push(`[Attached files saved to disk]\n${fileList}\n`);
  }

  parts.push(message.content);
  return parts.join('\n');
}

/**
 * Build a combined prompt from multiple buffered messages.
 */
async function buildBatchPrompt(
  messages: Message[],
  projectPath: string,
): Promise<string> {
  const parts: string[] = [];

  parts.push(
    `[While you were busy, the user sent ${messages.length} more message${messages.length > 1 ? 's' : ''}. Process them all.]`,
  );

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const savedAtts = await downloadAttachments(msg.attachments, projectPath);
    const msgPrompt = await buildPrompt(msg, savedAtts);
    parts.push(
      messages.length > 1
        ? `[Message ${i + 1}/${messages.length}]\n${msgPrompt}`
        : msgPrompt,
    );
  }

  return parts.join('\n\n');
}

// ── Entry point ──────────────────────────────────────────────

export async function handleMessage(message: Message): Promise<void> {
  const project = db.getProjectByChannelId(message.channel.id);
  if (!project) return;

  if (spawner.isRunning(project.project_path)) {
    // Buffer the message — it will be processed after the current task
    const buf = messageBuffer.get(project.project_path) || [];
    buf.push(message);
    messageBuffer.set(project.project_path, buf);
    await message.react('\uD83D\uDCCB').catch(() => {}); // 📋 queued
    return;
  }

  // Process immediately
  const session = db.getOrCreateSession(project.id);
  db.updateSessionStatus(session.id, 'running');

  await message.react('\u23F3').catch(() => {}); // ⏳ hourglass
  if ('sendTyping' in message.channel) {
    await message.channel.sendTyping().catch(() => {});
  }

  const savedAttachments = await downloadAttachments(
    message.attachments,
    project.project_path,
  );
  const prompt = await buildPrompt(message, savedAttachments);

  const result = await runWithRetry(prompt, project, session);
  await finalize(message, session, result);

  // Drain any messages that arrived while we were busy
  await drainBuffer(project);
}

// ── Drain buffered messages ──────────────────────────────────

async function drainBuffer(project: db.Project): Promise<void> {
  const buffered = messageBuffer.get(project.project_path);
  if (!buffered || buffered.length === 0) return;

  // Take all buffered messages at once
  messageBuffer.delete(project.project_path);

  console.log(
    `[${new Date().toISOString()}] Draining ${buffered.length} buffered message(s) for ${project.name}`,
  );

  const lastMessage = buffered[buffered.length - 1];
  const session = db.getOrCreateSession(project.id);
  db.updateSessionStatus(session.id, 'running');

  // Hourglass on the last message
  await lastMessage.react('\u23F3').catch(() => {});
  if ('sendTyping' in lastMessage.channel) {
    await lastMessage.channel.sendTyping().catch(() => {});
  }

  const prompt = await buildBatchPrompt(buffered, project.project_path);
  const result = await runWithRetry(prompt, project, session);
  await finalizeBatch(buffered, session, result);

  // Recurse: more messages may have arrived during this batch
  await drainBuffer(project);
}

// ── Spawn with session-error retry ───────────────────────────

async function runWithRetry(
  prompt: string,
  project: db.Project,
  session: db.Session,
): Promise<spawner.SpawnResult> {
  const result = await spawner.spawnClaude({
    prompt,
    projectPath: project.project_path,
    claudeSessionId: session.claude_session_id,
    skipPermissions: project.skip_permissions,
  });

  if (
    !result.success &&
    result.error &&
    /session|expired|not found/i.test(result.error)
  ) {
    console.log(
      `[${new Date().toISOString()}] Session error for ${project.name}, retrying with fresh session`,
    );
    db.updateSessionClaudeId(session.id, null);

    return spawner.spawnClaude({
      prompt,
      projectPath: project.project_path,
      claudeSessionId: null,
      skipPermissions: project.skip_permissions,
    });
  }

  return result;
}

// ── Finalize: single message ─────────────────────────────────

async function finalize(
  message: Message,
  session: db.Session,
  result: spawner.SpawnResult,
): Promise<void> {
  updateSession(session, result);

  if (result.success) {
    const formatted = fmt.formatResult(result.result, result.costUsd);
    const chunks = fmt.splitMessage(formatted);
    for (const chunk of chunks) {
      await message.reply(chunk);
    }
  } else {
    await message.reply(
      fmt.formatError(result.error || 'Unknown error'),
    );
  }

  await message.reactions.cache
    .get('\u23F3')
    ?.users.remove(message.client.user!.id)
    .catch(() => {});
  await message
    .react(result.success ? '\u2705' : '\u274C')
    .catch(() => {});
}

// ── Finalize: batch of buffered messages ─────────────────────

async function finalizeBatch(
  messages: Message[],
  session: db.Session,
  result: spawner.SpawnResult,
): Promise<void> {
  updateSession(session, result);

  const lastMessage = messages[messages.length - 1];

  // Reply to the last message
  if (result.success) {
    const formatted = fmt.formatResult(result.result, result.costUsd);
    const chunks = fmt.splitMessage(formatted);
    for (const chunk of chunks) {
      await lastMessage.reply(chunk);
    }
  } else {
    await lastMessage.reply(
      fmt.formatError(result.error || 'Unknown error'),
    );
  }

  // Update reactions on all buffered messages: 📋 → ✅/❌
  const emoji = result.success ? '\u2705' : '\u274C';
  for (const msg of messages) {
    await msg.reactions.cache
      .get('\uD83D\uDCCB')
      ?.users.remove(msg.client.user!.id)
      .catch(() => {});
    await msg.reactions.cache
      .get('\u23F3')
      ?.users.remove(msg.client.user!.id)
      .catch(() => {});
    await msg.react(emoji).catch(() => {});
  }
}

// ── Helpers ──────────────────────────────────────────────────

function updateSession(
  session: db.Session,
  result: spawner.SpawnResult,
): void {
  if (result.claudeSessionId) {
    db.updateSessionClaudeId(session.id, result.claudeSessionId);
  }
  db.updateSessionStatus(
    session.id,
    result.success ? 'idle' : 'error',
  );
}
