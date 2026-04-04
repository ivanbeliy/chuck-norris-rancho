import { Message } from 'discord.js';
import * as db from './db.js';
import * as spawner from './spawner.js';
import * as fmt from './discord-format.js';

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

  const result = await spawner.spawnClaude({
    prompt: message.content,
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
      prompt: message.content,
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
