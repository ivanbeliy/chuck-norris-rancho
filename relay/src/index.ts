import 'dotenv/config';
import * as db from './db.js';
import * as bot from './bot.js';
import * as spawner from './spawner.js';

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const RELAY_DB_PATH = process.env.RELAY_DB_PATH || './relay.db';

if (!DISCORD_BOT_TOKEN) {
  console.error('DISCORD_BOT_TOKEN is required. Set it in .env file.');
  process.exit(1);
}

console.log(`[${new Date().toISOString()}] Relay starting...`);

db.initialize(RELAY_DB_PATH);
console.log(`[${new Date().toISOString()}] Database initialized: ${RELAY_DB_PATH}`);

bot.start(DISCORD_BOT_TOKEN).catch((err) => {
  console.error(`[${new Date().toISOString()}] Failed to start bot:`, err);
  process.exit(1);
});

// Graceful shutdown
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[${new Date().toISOString()}] ${signal} received, shutting down...`);

  await spawner.killAll(30_000);
  await bot.destroy();
  db.close();

  console.log(`[${new Date().toISOString()}] Relay stopped.`);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
  console.error(`[${new Date().toISOString()}] Uncaught exception:`, err);
});

process.on('unhandledRejection', (err) => {
  console.error(`[${new Date().toISOString()}] Unhandled rejection:`, err);
});
