// Fire-and-forget Discord webhook poster. Callers don't await; errors logged.

const WEBHOOK_URL = process.env.CHUCK_WIKI_DISCORD_WEBHOOK_URL;

export function postToDiscord(text: string): void {
  if (!WEBHOOK_URL) return; // silently no-op when unconfigured (e.g., local dev)
  const content = text.length > 1900 ? text.slice(0, 1897) + '…' : text;
  fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  })
    .then((res) => {
      if (!res.ok) {
        console.error(`[notify] webhook POST failed: ${res.status}`);
      }
    })
    .catch((err: Error) => {
      console.error(`[notify] webhook error: ${err.message}`);
    });
}
