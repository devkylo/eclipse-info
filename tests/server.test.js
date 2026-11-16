import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import { createRequestHandler } from '../server.js';

async function invokeHandler(handler, method, url, body = null, reqHeaders = {}) {
  const req = Readable.from(body === null ? [] : [Buffer.from(body, 'utf8')]);
  req.method = method;
  req.url = url;
  req.headers = reqHeaders;

  let statusCode = 200;
  let headers = {};
  const chunks = [];

  const res = {
    writeHead(code, hdrs = {}) {
      statusCode = code;
      headers = Object.fromEntries(
        Object.entries(hdrs).map(([k, v]) => [k.toLowerCase(), v])
      );
    },
    end(chunk = '') {
      if (chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
      }
    },
  };

  await handler(req, res);
  return {
    status: statusCode,
    headers,
    text: Buffer.concat(chunks).toString('utf8'),
  };
}

async function withTempHandler(fn, options = {}) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'boss-timer-test-'));
  const handler = createRequestHandler({ dataDir: tmpDir, ...options });

  try {
    await fn(handler, tmpDir);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

test('server serves index.html, static modules, icon from public/ and blocks disallowed paths', async () => {
  await withTempHandler(async (handler) => {
    const htmlRes = await invokeHandler(handler, 'GET', '/');
    assert.equal(htmlRes.status, 200);
    assert.match(htmlRes.text, /이클립스: 더 어웨이크닝/);

    const iconRes = await invokeHandler(handler, 'GET', '/assets/eclipse-icon.png');
    assert.equal(iconRes.status, 200);
    assert.match(iconRes.headers['content-type'] || '', /image\/png/);

    const jsRes = await invokeHandler(handler, 'GET', '/src/calculator.js');
    assert.equal(jsRes.status, 200);
    assert.match(jsRes.headers['content-type'] || '', /javascript/);

    const imgJsRes = await invokeHandler(handler, 'GET', '/src/schedule-image.js');
    assert.equal(imgJsRes.status, 200);
    assert.match(imgJsRes.headers['content-type'] || '', /javascript/);

    const blockedRes = await invokeHandler(handler, 'GET', '/server.js');
    assert.equal(blockedRes.status, 404);

    const traversalRes = await invokeHandler(handler, 'GET', '/../package.json');
    assert.equal(traversalRes.status, 404);

    const fnBlocked = await invokeHandler(handler, 'GET', '/netlify/functions/auth.mjs');
    assert.equal(fnBlocked.status, 404);
  });
});

test('shared-state and auth enforce view-only, host setup, editor code issuance, conflicts, and revocation', async () => {
  await withTempHandler(async (handler) => {
    const health = await invokeHandler(handler, 'GET', '/api/health');
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.text).mode, 'local-file-server');

    // Anonymous visitor sees shared state in viewer mode, cannot PUT
    const anonGet = await invokeHandler(handler, 'GET', '/api/shared-state');
    assert.equal(anonGet.status, 200);
    const anonJson = JSON.parse(anonGet.text);
    assert.equal(anonJson.auth.configured, false);
    assert.equal(anonJson.auth.role, 'viewer');
    assert.equal(anonJson.sharedState.revision, 1);
    assert.equal(anonJson.sharedState.servers['barkadion-05'].bosses.length, 14);
    assert.deepEqual(anonJson.sharedState.notice, {
      text: '',
      fontSize: 12,
      color: '#ffffff',
      bold: false,
    });

    const anonPut = await invokeHandler(
      handler,
      'PUT',
      '/api/shared-state',
      JSON.stringify({ sharedState: anonJson.sharedState, expectedRevision: 1 })
    );
    assert.equal(anonPut.status, 401);

    // Non-host cannot issue editor codes
    const unauthCreate = await invokeHandler(
      handler,
      'POST',
      '/api/auth',
      JSON.stringify({ action: 'create_editor', label: '몰래추가' })
    );
    assert.equal(unauthCreate.status, 403);

    // First-time host setup
    const setupRes = await invokeHandler(
      handler,
      'POST',
      '/api/auth',
      JSON.stringify({ action: 'setup_host', password: 'host-secret-123' })
    );
    assert.equal(setupRes.status, 201);
    const setupData = JSON.parse(setupRes.text);
    assert.equal(setupData.role, 'host');
    assert.ok(setupData.token);

    // Re-claiming host setup fails
    const secondSetup = await invokeHandler(
      handler,
      'POST',
      '/api/auth',
      JSON.stringify({ action: 'setup_host', password: 'attacker-pw' })
    );
    assert.equal(secondSetup.status, 409);

    // Host updates shared schedule & notice
    const hostEdited = structuredClone(anonJson.sharedState);
    hostEdited.servers['barkadion-05'].bosses[6].killDurationSec = 120;
    hostEdited.notice = { text: '금요일 21시 사바토 집결!', fontSize: 18, color: '#ffd700', bold: true };
    const hostPut = await invokeHandler(
      handler,
      'PUT',
      '/api/shared-state',
      JSON.stringify({ sharedState: hostEdited, expectedRevision: 1 }),
      { authorization: `Bearer ${setupData.token}` }
    );
    assert.equal(hostPut.status, 200);
    const hostPutJson = JSON.parse(hostPut.text);
    assert.equal(hostPutJson.sharedState.revision, 2);
    assert.equal(hostPutJson.sharedState.updatedBy, '메인 호스트');
    assert.equal(hostPutJson.sharedState.servers['barkadion-05'].bosses[6].killDurationSec, 120);
    assert.deepEqual(hostPutJson.sharedState.notice, {
      text: '금요일 21시 사바토 집결!',
      fontSize: 18,
      color: '#ffd700',
      bold: true,
    });

    // Stale expectedRevision returns 409 conflict
    const stalePut = await invokeHandler(
      handler,
      'PUT',
      '/api/shared-state',
      JSON.stringify({ sharedState: hostEdited, expectedRevision: 1 }),
      { authorization: `Bearer ${setupData.token}` }
    );
    assert.equal(stalePut.status, 409);

    // Host issues editor code for '총무'
    const createEditorRes = await invokeHandler(
      handler,
      'POST',
      '/api/auth',
      JSON.stringify({ action: 'create_editor', label: '총무' }),
      { authorization: `Bearer ${setupData.token}` }
    );
    assert.equal(createEditorRes.status, 201);
    const createdEditor = JSON.parse(createEditorRes.text);
    assert.match(createdEditor.code, /^EC-[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    // Editor logs in (case-insensitive check for EC codes)
    const editorLoginRes = await invokeHandler(
      handler,
      'POST',
      '/api/auth',
      JSON.stringify({ action: 'login', code: createdEditor.code.toLowerCase() })
    );
    assert.equal(editorLoginRes.status, 200);
    const editorLogin = JSON.parse(editorLoginRes.text);
    assert.equal(editorLogin.role, 'editor');
    assert.equal(editorLogin.label, '총무');

    // Editor modifies schedule -> revision increments and updatedBy becomes '총무'
    const editorEdited = structuredClone(hostPutJson.sharedState);
    editorEdited.servers['barkadion-05'].bosses[2].memo = '북쪽 숲';
    const editorPut = await invokeHandler(
      handler,
      'PUT',
      '/api/shared-state',
      JSON.stringify({ sharedState: editorEdited, expectedRevision: 2 }),
      { authorization: `Bearer ${editorLogin.token}` }
    );
    assert.equal(editorPut.status, 200);
    const editorPutJson = JSON.parse(editorPut.text);
    assert.equal(editorPutJson.sharedState.revision, 3);
    assert.equal(editorPutJson.sharedState.updatedBy, '총무');

    // Visitor sees '총무's changes
    const visitorRes = await invokeHandler(handler, 'GET', '/api/shared-state');
    const visitorJson = JSON.parse(visitorRes.text);
    assert.equal(visitorJson.sharedState.revision, 3);
    assert.equal(visitorJson.sharedState.servers['barkadion-05'].bosses[2].memo, '북쪽 숲');

    // Host revokes editor -> editor token is IMMEDIATELY invalidated
    const revokeRes = await invokeHandler(
      handler,
      'POST',
      '/api/auth',
      JSON.stringify({ action: 'revoke_editor', editorId: createdEditor.editor.id }),
      { authorization: `Bearer ${setupData.token}` }
    );
    assert.equal(revokeRes.status, 200);

    const revokedPut = await invokeHandler(
      handler,
      'PUT',
      '/api/shared-state',
      JSON.stringify({ sharedState: editorEdited, expectedRevision: 3 }),
      { authorization: `Bearer ${editorLogin.token}` }
    );
    assert.equal(revokedPut.status, 401);
    assert.equal(JSON.parse(revokedPut.text).error, 'REVOKED');

    const revokedAuthGet = await invokeHandler(handler, 'GET', '/api/auth', null, {
      authorization: `Bearer ${editorLogin.token}`,
    });
    const revokedAuthJson = JSON.parse(revokedAuthGet.text);
    assert.equal(revokedAuthJson.role, 'viewer');
    assert.equal(revokedAuthJson.revoked, true);
  });
});

test('HOST_ADMIN_KEY env override locks host setup and authenticates host directly', async () => {
  await withTempHandler(
    async (handler) => {
      const statusRes = await invokeHandler(handler, 'GET', '/api/auth');
      const statusJson = JSON.parse(statusRes.text);
      assert.equal(statusJson.configured, true);
      assert.equal(statusJson.envHostLocked, true);

      const setupBlocked = await invokeHandler(
        handler,
        'POST',
        '/api/auth',
        JSON.stringify({ action: 'setup_host', password: 'override-attempt' })
      );
      assert.equal(setupBlocked.status, 409);

      const loginRes = await invokeHandler(
        handler,
        'POST',
        '/api/auth',
        JSON.stringify({ action: 'login', code: 'env-master-key-99' })
      );
      assert.equal(loginRes.status, 200);
      assert.equal(JSON.parse(loginRes.text).role, 'host');
    },
    { envHostKey: 'env-master-key-99' }
  );
});
