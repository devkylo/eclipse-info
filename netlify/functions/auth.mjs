import { createNetlifyKvStore } from '../../shared-server/netlify-kv.js';
import { getEnvHostKey, handleAuthRequest } from '../../shared-server/store.js';

export default async (req, context) => {
  const kvStore = createNetlifyKvStore(context);
  return handleAuthRequest(req, kvStore, getEnvHostKey());
};

export const config = {
  path: '/api/auth',
};
