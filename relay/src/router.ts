import { Message } from 'discord.js';
import * as db from './db.js';
import * as spawner from './spawner.js';
import * as fmt from './discord-format.js';

/**
 * Build the prompt including context from replied-to or forwarded messages.
 */
async function buildPrompt(message: Message): Promise<string> {
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

  parts.push(message.content);
  return parts.join('\n');
}

export async function handleMessage(message: Message): Promise<void> {
  const project = db.getProjectByChannelId(message.channel.id);
  if (!project) return;

  if (spawner.isRunning(project.project_path)) {
    await message.reply(
      'A task is already running for this project. Please wait for it to finish.',
    );
    return;
  }

  const session = db.getOrCreateSession(project.id);
  db.updateSessionStatus(session.id, 'running');

  // Acknowledge receipt
  await message.react('\u23F3').catch(() => {}); // hourglass
  if ('sendTyping' in message.channel) {
    await message.channel.sendTyping().catch(() => {});
  }

  const prompt = await buildPrompt(message);

  const result = await spawner.spawnClaude({
    prompt,
    projectPath: project.project_path,
    claudeSessionId: session.claude_session_id,
    skipPermissions: project.skip_permissions,
  });

  // If session-related error, clear session ID and retry once
  if (
    !result.success &&
    result.error &&
    /session|expired|not found/i.test(result.error)
  ) {
    console.log(
      `[${new Date().toISOString()}] Session error for ${project.name}, retrying with fresh session`,
    );
    db.updateSessionClaudeId(session.id, null);

    const retry = await spawner.spawnClaude({
      prompt,
      projectPath: project.project_path,
      claudeSessionId: null,
      skipPermissions: project.skip_permissions,
    });

    return finalize(message, session, retry);
  }

  return finalize(message, session, result);
}

async function finalize(
  message: Message,
  session: db.Session,
  result: spawner.SpawnResult,
): Promise<void> {
  // Update session state
  if (result.claudeSessionId) {
    db.updateSessionClaudeId(session.id, result.claudeSessionId);
  }
  db.updateSessionStatus(
    session.id,
    result.success ? 'idle' : 'error',
  );

  // Send response
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

  // Update reactions: remove hourglass, add result indicator
  await message.reactions.cache
    .get('\u23F3')
    ?.users.remove(message.client.user!.id)
    .catch(() => {});
  await message
    .react(result.success ? '\u2705' : '\u274C')
    .catch(() => {});
}
