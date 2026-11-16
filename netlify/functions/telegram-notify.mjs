import { createNetlifyKvStore } from '../../shared-server/netlify-kv.js';
import { runTelegramScheduledAlerts } from '../../shared-server/telegram.js';

export default async (req, context) => {
  const kvStore = createNetlifyKvStore(context);
  const result = await runTelegramScheduledAlerts(kvStore);
  if (!result.ok) {
    console.error('Telegram scheduled alert error:', result.error);
  }
  return new Response(JSON.stringify(result), {
    status: result.ok ? 200 : 500,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};

export const config = {
  schedule: '*/2 * * * *',
};
