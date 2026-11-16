import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import { createRequestHandler } from '../server.js';

async function invokeHandler(handler, method, url, body = null) {
  const req = Readable.from(body === null ? [] : [Buffer.from(body, 'utf8')]);
  req.method = method;
  req.url = url;

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

async function withTempHandler(fn) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'boss-timer-test-'));
  const dataFile = path.join(tmpDir, 'bosses.json');
  const handler = createRequestHandler({ dataFile });

  try {
    await fn(handler, dataFile);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

test('server serves index.html, static modules, icon, and blocks disallowed paths', async () => {
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
  });
});

test('server initializes, persists, and validates /api/state', async () => {
  await withTempHandler(async (handler, dataFile) => {
    const health = await invokeHandler(handler, 'GET', '/api/health');
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.text).mode, 'local-file-server');

    const getRes = await invokeHandler(handler, 'GET', '/api/state');
    assert.equal(getRes.status, 200);
    const { state } = JSON.parse(getRes.text);
    assert.equal(state.activeServerId, 'barkadion-05');
    assert.equal(state.servers['barkadion-05'].bosses.length, 7);

    // Modify killDuration of 아르칸다르 (index 6) and global offset
    state.servers['barkadion-05'].bosses[6].killDurationSec = 120;
    state.settings.globalNotifyOffsetsSec = [900, 300, 60, 0];

    const putRes = await invokeHandler(handler, 'PUT', '/api/state', JSON.stringify({ state }));
    assert.equal(putRes.status, 200);

    const savedDisk = JSON.parse(await fs.readFile(dataFile, 'utf8'));
    assert.equal(savedDisk.servers['barkadion-05'].bosses[6].killDurationSec, 120);
    assert.deepEqual(savedDisk.settings.globalNotifyOffsetsSec, [900, 300, 60, 0]);

    const badPut = await invokeHandler(handler, 'PUT', '/api/state', '{bad json');
    assert.equal(badPut.status, 400);
  });
});
