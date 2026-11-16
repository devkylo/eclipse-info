import { getDeployStore, getStore } from '@netlify/blobs';

const STORE_NAME = 'eclipse-shared';

export function createNetlifyKvStore(context) {
  const deployContext = context?.deploy?.context;
  const isProd = !deployContext || deployContext === 'production';
  const store = isProd
    ? getStore({ name: STORE_NAME, consistency: 'strong' })
    : getDeployStore({ name: STORE_NAME, consistency: 'strong' });

  return {
    async get(key) {
      return store.get(key, { type: 'json' });
    },
    async set(key, value) {
      await store.setJSON(key, value);
    },
  };
}
