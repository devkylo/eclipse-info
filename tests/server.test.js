import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import { createRequestHandler } from '../server.js';
import { createDefaultSharedState } from '../public/src/calculator.js';
import { createFileKvStore } from '../shared-server/store.js';
import {
  DEFAULT_TELEGRAM_CHAT_ID,
  collectTenMinuteAlertCandidates,
  getTelegramConfig,
  normalizeTelegramChatId,
  runTelegramScheduledAlerts,
} from '../shared-server/telegram.js';

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

test('Telegram 10-min alert evaluator, 2-min cron dedup, fast-skip, and @eclipse_boss_ba05 defaults work cleanly', async () => {
  assert.equal(DEFAULT_TELEGRAM_CHAT_ID, '@eclipse_boss_ba05');
  assert.equal(normalizeTelegramChatId('https://t.me/eclipse_boss_ba05'), '@eclipse_boss_ba05');
  assert.equal(normalizeTelegramChatId('-1001234567890'), '-1001234567890');

  const prevTgTok = process.env.TELEGRAM_BOT_TOKEN;
  const prevAliasTok = process.env.eclipse_boss_ba05_bot_token;
  try {
    delete process.env.TELEGRAM_BOT_TOKEN;
    process.env.eclipse_boss_ba05_bot_token = '55555:ALIAS_TOKEN';
    assert.equal(getTelegramConfig().botToken, '55555:ALIAS_TOKEN');
  } finally {
    if (prevTgTok === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = prevTgTok;
    if (prevAliasTok === undefined) delete process.env.eclipse_boss_ba05_bot_token;
    else process.env.eclipse_boss_ba05_bot_token = prevAliasTok;
  }

  // 2026-11-17 11:50:00 KST -> 10m before 12:00 World Boss pair (크라카 + 에버하르트)
  const kst1150 = Date.UTC(2026, 10, 17, 11 - 9, 50, 0, 0);
  const shared = createDefaultSharedState(kst1150);

  const worldDue = collectTenMinuteAlertCandidates(shared, {
    nowMs: kst1150,
    serverId: 'barkadion-05',
  });
  assert.deepEqual(
    worldDue.candidates.map((c) => c.bossId).sort(),
    ['everhart', 'kraka']
  );

  // Too early at 11:48:00 KST -> 0 candidates
  const kst1148 = Date.UTC(2026, 10, 17, 11 - 9, 48, 0, 0);
  const tooEarly = collectTenMinuteAlertCandidates(shared, {
    nowMs: kst1148,
    serverId: 'barkadion-05',
  });
  assert.equal(tooEarly.candidates.length, 0);

  // Full scheduled run with dedup + fast-skip Blobs read check
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'boss-tg-test-'));
  try {
    const rawKv = createFileKvStore(tmpDir);
    await rawKv.set('shared-state', shared);

    let alertStateReads = 0;
    const countedKv = {
      async get(key) {
        if (key === 'telegram-alert-state') alertStateReads += 1;
        return rawKv.get(key);
      },
      async set(key, value) {
        return rawKv.set(key, value);
      },
    };

    const sentPayloads = [];
    const mockFetch = async (url, init) => {
      sentPayloads.push({ url, body: JSON.parse(init.body) });
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, result: { message_id: 77 } };
        },
      };
    };

    // Fast-skip when 0 candidates -> does NOT even read telegram-alert-state
    const earlyRun = await runTelegramScheduledAlerts(countedKv, {
      nowMs: kst1148,
      config: { botToken: '12345:TEST_TOKEN' },
      fetchImpl: mockFetch,
    });
    assert.equal(earlyRun.sentCount, 0);
    assert.equal(alertStateReads, 0);
    assert.equal(sentPayloads.length, 0);

    // At 11:50:00 -> bundles 크라카 + 에버하르트 into 1 message to @eclipse_boss_ba05
    const hitRun = await runTelegramScheduledAlerts(countedKv, {
      nowMs: kst1150,
      config: { botToken: '12345:TEST_TOKEN' },
      fetchImpl: mockFetch,
    });
    assert.equal(hitRun.sentCount, 2);
    assert.equal(sentPayloads.length, 1);
    assert.equal(sentPayloads[0].url, 'https://api.telegram.org/bot12345:TEST_TOKEN/sendMessage');
    assert.equal(sentPayloads[0].body.chat_id, '@eclipse_boss_ba05');
    assert.match(sentPayloads[0].body.text, /10분 전/);
    assert.match(sentPayloads[0].body.text, /크라카/);
    assert.match(sentPayloads[0].body.text, /에버하르트/);

    // Next 2-minute tick (11:52:00) -> still within window, deduplicated cleanly
    const repeatRun = await runTelegramScheduledAlerts(countedKv, {
      nowMs: kst1150 + 2 * 60 * 1000,
      config: { botToken: '12345:TEST_TOKEN' },
      fetchImpl: mockFetch,
    });
    assert.equal(repeatRun.sentCount, 0);
    assert.equal(repeatRun.alreadySent, 2);
    assert.equal(sentPayloads.length, 1);

    // Cycle boss auto-rollover check without web client open: state saved at 01:00 -> 바리탄 01:34 rolls to 05:34 at 05:24:10 KST
    const kst0100 = Date.UTC(2026, 10, 17, 1 - 9, 0, 0, 0);
    await rawKv.set('shared-state', createDefaultSharedState(kst0100));
    const kst0524 = Date.UTC(2026, 10, 17, 5 - 9, 24, 10, 0);
    const abyssRun = await runTelegramScheduledAlerts(countedKv, {
      nowMs: kst0524,
      config: { botToken: '12345:TEST_TOKEN' },
      fetchImpl: mockFetch,
    });
    assert.equal(abyssRun.sentCount, 1);
    assert.deepEqual(abyssRun.bossNames, ['바리탄']);
    assert.match(sentPayloads[1].body.text, /\[어비스\] Lv\.50 바리탄/);

    // Weekly fixed boss check: 사바토 (금요일 21:00) at 2026-11-20 20:50:00 KST
    await rawKv.set('shared-state', shared);
    const fri2050 = Date.UTC(2026, 10, 20, 20 - 9, 50, 0, 0);
    const weeklyRun = await runTelegramScheduledAlerts(countedKv, {
      nowMs: fri2050,
      config: { botToken: '12345:TEST_TOKEN' },
      fetchImpl: mockFetch,
    });
    assert.equal(weeklyRun.sentCount, 1);
    assert.deepEqual(weeklyRun.bossNames, ['사바토']);

    // Wednesday maintenance auto-reset in memory: 2026-11-18 11:50 KST -> 크라카 + 에버하르트 + 바리탄(08:00+4h=12:00)
    const wed1150 = Date.UTC(2026, 10, 18, 11 - 9, 50, 0, 0);
    const wedCheck = collectTenMinuteAlertCandidates(shared, {
      nowMs: wed1150,
      serverId: 'barkadion-05',
    });
    assert.deepEqual(
      wedCheck.candidates.map((c) => c.bossId).sort(),
      ['baritan', 'everhart', 'kraka']
    );

    // Respects boss.notifyEnabled === false
    const mutedShared = {
      ...shared,
      servers: {
        ...shared.servers,
        'barkadion-05': {
          bosses: shared.servers['barkadion-05'].bosses.map((b) =>
            b.id === 'sabato' ? { ...b, notifyEnabled: false } : b
          ),
        },
      },
    };
    const mutedCheck = collectTenMinuteAlertCandidates(mutedShared, {
      nowMs: fri2050,
      serverId: 'barkadion-05',
    });
    assert.equal(mutedCheck.candidates.some((c) => c.bossId === 'sabato'), false);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('/api/telegram-test enforces auth, validates token, and sends formatted test alert', async () => {
  const sentCalls = [];
  const mockFetch = async (url, init) => {
    sentCalls.push({ url, body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      async json() {
        return { ok: true, result: { message_id: 99 } };
      },
    };
  };

  await withTempHandler(
    async (handler) => {
      const loginRes = await invokeHandler(
        handler,
        'POST',
        '/api/auth',
        JSON.stringify({ action: 'login', code: 'host-pw-999' })
      );
      const { token } = JSON.parse(loginRes.text);

      // View-only user cannot trigger test push
      const unauthRes = await invokeHandler(handler, 'POST', '/api/telegram-test', '{}');
      assert.equal(unauthRes.status, 401);

      // Host succeeds and hits @eclipse_boss_ba05
      const okRes = await invokeHandler(handler, 'POST', '/api/telegram-test', '{}', {
        authorization: `Bearer ${token}`,
      });
      assert.equal(okRes.status, 200);
      const okJson = JSON.parse(okRes.text);
      assert.equal(okJson.ok, true);
      assert.equal(okJson.chatId, '@eclipse_boss_ba05');
      assert.equal(sentCalls.length, 1);
      assert.match(sentCalls[0].body.text, /10분 전/);
    },
    {
      envHostKey: 'host-pw-999',
      telegramConfig: { botToken: '99999:MOCK_BOT' },
      telegramFetchImpl: mockFetch,
    }
  );
});
