import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { createDefaultState, sanitizeState } from './src/calculator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'bosses.json');
const DEFAULT_PORT = Number(process.env.PORT) || 3737;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const ALLOWED_STATIC_PATHS = new Set([
  '/index.html',
  '/styles.css',
  '/assets/eclipse-icon.png',
  '/src/app.js',
  '/src/calculator.js',
  '/src/notifier.js',
  '/src/schedule-image.js',
  '/src/storage.js',
  '/src/timer-worker.js',
]);

async function readOrInitState(dataFile) {
  try {
    const raw = await fs.readFile(dataFile, 'utf8');
    const parsed = JSON.parse(raw);
    return sanitizeState(parsed, Date.now());
  } catch {
    const initial = createDefaultState(Date.now());
    await writeStateFile(dataFile, initial);
    return initial;
  }
}

async function writeStateFile(dataFile, state) {
  await fs.mkdir(path.dirname(dataFile), { recursive: true });
  const tmpFile = `${dataFile}.tmp`;
  await fs.writeFile(tmpFile, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(tmpFile, dataFile);
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readRequestBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createRequestHandler(options = {}) {
  const dataFile = options.dataFile || DATA_FILE;
  return async (req, res) => {
    try {
      const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
      const pathname = reqUrl.pathname === '/' ? '/index.html' : reqUrl.pathname;

      if (pathname === '/api/health' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, mode: 'local-file-server' });
        return;
      }

      if (pathname === '/api/state' && req.method === 'GET') {
        const state = await readOrInitState(dataFile);
        sendJson(res, 200, { state });
        return;
      }

      if (pathname === '/api/state' && req.method === 'PUT') {
        const rawBody = await readRequestBody(req);
        let parsed;
        try {
          parsed = JSON.parse(rawBody);
        } catch {
          sendJson(res, 400, { error: 'Invalid JSON payload' });
          return;
        }
        const clean = sanitizeState(parsed?.state ?? parsed, Date.now());
        await writeStateFile(dataFile, clean);
        sendJson(res, 200, { ok: true, state: clean });
        return;
      }

      if (req.method === 'GET' && ALLOWED_STATIC_PATHS.has(pathname)) {
        const filePath = path.join(__dirname, pathname.slice(1));
        const ext = path.extname(filePath);
        const content = await fs.readFile(filePath);
        res.writeHead(200, {
          'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
          'Cache-Control': 'no-store',
        });
        res.end(content);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    } catch (err) {
      sendJson(res, 500, { error: err?.message || 'Internal Server Error' });
    }
  };
}

export function createServer(options = {}) {
  return http.createServer(createRequestHandler(options));
}

function openBrowser(url) {
  if (process.platform === 'win32') {
    execFile('cmd.exe', ['/c', 'start', '', url], () => {});
  } else if (process.platform === 'darwin') {
    execFile('open', [url], () => {});
  } else {
    execFile('xdg-open', [url], () => {});
  }
}

async function listenWithFallback(server, startPort, maxTries = 20) {
  let port = startPort;
  for (let i = 0; i < maxTries; i += 1) {
    try {
      await new Promise((resolve, reject) => {
        const onError = (err) => {
          server.off('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });
      return port;
    } catch (err) {
      if (err && err.code === 'EADDRINUSE' && !process.env.PORT) {
        port += 1;
        continue;
      }
      throw err;
    }
  }
  throw new Error(`No available port starting from ${startPort}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (isMain) {
  const server = createServer();
  const shouldOpen = process.argv.includes('--open');

  listenWithFallback(server, DEFAULT_PORT)
    .then((boundPort) => {
      const url = `http://127.0.0.1:${boundPort}`;
      console.log(`보스 출현 예상 시간 타이머 실행 중: ${url}`);
      console.log(`데이터 저장 위치: ${DATA_FILE}`);
      console.log('종료하려면 Ctrl+C를 누르세요.');
      if (shouldOpen) {
        openBrowser(url);
      }
    })
    .catch((err) => {
      console.error('서버 시작 실패:', err);
      process.exit(1);
    });
}
