import { createNetlifyKvStore } from '../../shared-server/netlify-kv.js';
import { getEnvHostKey } from '../../shared-server/store.js';
import { handleTelegramTestRequest } from '../../shared-server/telegram.js';

export default async (req, context) => {
  const kvStore = createNetlifyKvStore(context);
  return handleTelegramTestRequest(req, kvStore, getEnvHostKey());
};

export const config = {
  path: '/api/telegram-test',
};
