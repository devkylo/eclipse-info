import { createNetlifyKvStore } from '../../shared-server/netlify-kv.js';
import { getEnvHostKey, handleSharedStateRequest } from '../../shared-server/store.js';

export default async (req, context) => {
  const kvStore = createNetlifyKvStore(context);
  return handleSharedStateRequest(req, kvStore, getEnvHostKey());
};

export const config = {
  path: '/api/shared-state',
};
