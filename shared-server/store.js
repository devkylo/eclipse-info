import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createDefaultSharedState, sanitizeSharedState } from '../public/src/calculator.js';

const KEY_SHARED_STATE = 'shared-state';
const KEY_AUTH_CONFIG = 'auth-config';
export const KEY_TELEGRAM_STATE = 'telegram-alert-state';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_EDITORS = 50;

export function getRuntimeEnv(name) {
  try {
    if (typeof Netlify !== 'undefined' && Netlify.env && typeof Netlify.env.get === 'function') {
      const v = Netlify.env.get(name);
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  } catch {
    // Fallback to process.env outside Netlify runtime
  }
  const envVal = process.env[name];
  return typeof envVal === 'string' && envVal.trim() ? envVal.trim() : '';
}

export function getEnvHostKey() {
  return getRuntimeEnv('HOST_ADMIN_KEY');
}

export function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function hashSecretScrypt(secret, saltHex = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(String(secret), saltHex, 32).toString('hex');
  return { salt: saltHex, hash: derived };
}

function verifySecretScrypt(candidate, saltHex, expectedHex) {
  if (!saltHex || !expectedHex || typeof candidate !== 'string') return false;
  const derived = crypto.scryptSync(candidate, saltHex, 32);
  const expected = Buffer.from(expectedHex, 'hex');
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

function normalizeEditorCodeInput(code) {
  return String(code ?? '').trim().toUpperCase();
}

function generateEditorCode() {
  const bytes = crypto.randomBytes(8);
  let chars = '';
  for (let i = 0; i < 8; i += 1) {
    chars += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return `EC-${chars.slice(0, 4)}-${chars.slice(4, 8)}`;
}

function sanitizeAuthConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const sessionSecret =
    typeof cfg.sessionSecret === 'string' && cfg.sessionSecret.length >= 32
      ? cfg.sessionSecret
      : '';
  const hostTokenVersion = Math.max(1, Math.floor(Number(cfg.hostTokenVersion) || 1));
  const hostKeyHash =
    cfg.hostKeyHash &&
    typeof cfg.hostKeyHash.salt === 'string' &&
    typeof cfg.hostKeyHash.hash === 'string'
      ? { salt: cfg.hostKeyHash.salt, hash: cfg.hostKeyHash.hash }
      : null;

  const editors = Array.isArray(cfg.editors)
    ? cfg.editors
        .filter(
          (e) =>
            e &&
            typeof e.id === 'string' &&
            typeof e.label === 'string' &&
            typeof e.codeSalt === 'string' &&
            typeof e.codeHash === 'string'
        )
        .map((e) => ({
          id: e.id,
          label: e.label.trim().slice(0, 24) || '편집자',
          codeSalt: e.codeSalt,
          codeHash: e.codeHash,
          codeHint: typeof e.codeHint === 'string' ? e.codeHint.slice(-4) : '****',
          createdAtMs: Number(e.createdAtMs) || Date.now(),
          lastUsedAtMs: Number.isFinite(Number(e.lastUsedAtMs)) ? Number(e.lastUsedAtMs) : null,
        }))
    : [];

  return { sessionSecret, hostTokenVersion, hostKeyHash, editors };
}

function formatSafeEditors(editors) {
  return editors.map((e) => ({
    id: e.id,
    label: e.label,
    codeHint: e.codeHint,
    createdAtMs: e.createdAtMs,
    lastUsedAtMs: e.lastUsedAtMs,
  }));
}

function signSessionToken(payload, sessionSecret) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', sessionSecret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function parseSessionToken(token, sessionSecret) {
  if (typeof token !== 'string' || !sessionSecret) return null;
  const parts = token.trim().split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!body || !sig) return null;
  const expectedSig = crypto.createHmac('sha256', sessionSecret).update(body).digest('base64url');
  if (!timingSafeEqualStr(sig, expectedSig)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function extractBearerToken(req) {
  const authHeader = req.headers.get('authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (match && match[1]) return match[1].trim();
  const alt = req.headers.get('x-auth-token');
  return typeof alt === 'string' ? alt.trim() : '';
}

export function evaluateAuth(req, authConfig, envHostKey) {
  const configured = Boolean(envHostKey || authConfig.hostKeyHash);
  const envHostLocked = Boolean(envHostKey);
  const rawToken = extractBearerToken(req);

  if (!rawToken) {
    return { configured, envHostLocked, role: 'viewer', label: null, editorId: null, revoked: false };
  }

  const payload = parseSessionToken(rawToken, authConfig.sessionSecret);
  if (!payload || typeof payload !== 'object') {
    return {
      configured,
      envHostLocked,
      role: 'viewer',
      label: null,
      editorId: null,
      revoked: configured,
    };
  }

  if (payload.r === 'host') {
    if (!configured) {
      return { configured, envHostLocked, role: 'viewer', label: null, editorId: null, revoked: true };
    }
    const expectedEnvDigest = envHostKey ? sha256Hex(envHostKey).slice(0, 16) : '';
    const tokenVersionOk = Number(payload.v) === authConfig.hostTokenVersion;
    const envMatches = envHostKey
      ? payload.ek === expectedEnvDigest
      : !payload.ek && Boolean(authConfig.hostKeyHash);

    if (tokenVersionOk && envMatches) {
      return {
        configured,
        envHostLocked,
        role: 'host',
        label: '메인 호스트',
        editorId: null,
        revoked: false,
      };
    }
    return { configured, envHostLocked, role: 'viewer', label: null, editorId: null, revoked: true };
  }

  if (payload.r === 'editor' && typeof payload.id === 'string') {
    const editor = authConfig.editors.find((e) => e.id === payload.id);
    if (!editor) {
      return {
        configured,
        envHostLocked,
        role: 'viewer',
        label: null,
        editorId: null,
        revoked: true,
      };
    }
    return {
      configured,
      envHostLocked,
      role: 'editor',
      label: editor.label,
      editorId: editor.id,
      revoked: false,
    };
  }

  return { configured, envHostLocked, role: 'viewer', label: null, editorId: null, revoked: false };
}

async function readOrInitSessionSecretConfig(kvStore) {
  const raw = await kvStore.get(KEY_AUTH_CONFIG);
  const cfg = sanitizeAuthConfig(raw);
  if (!cfg.sessionSecret) {
    cfg.sessionSecret = crypto.randomBytes(32).toString('hex');
    await kvStore.set(KEY_AUTH_CONFIG, cfg);
  }
  return cfg;
}

export async function readAuthSafe(kvStore) {
  const raw = await kvStore.get(KEY_AUTH_CONFIG);
  return sanitizeAuthConfig(raw);
}

export async function readSharedStateOrDefault(kvStore) {
  const raw = await kvStore.get(KEY_SHARED_STATE);
  if (raw && typeof raw === 'object') {
    return sanitizeSharedState(raw, Date.now());
  }
  return createDefaultSharedState(Date.now());
}

function createHostToken(authConfig, envHostKey) {
  return signSessionToken(
    {
      r: 'host',
      id: null,
      v: authConfig.hostTokenVersion,
      ek: envHostKey ? sha256Hex(envHostKey).slice(0, 16) : '',
      iat: Date.now(),
    },
    authConfig.sessionSecret
  );
}

export async function handleSharedStateRequest(req, kvStore, envHostKey = getEnvHostKey()) {
  const method = (req.method || 'GET').toUpperCase();
  const authConfig = await readAuthSafe(kvStore);
  const authStatus = evaluateAuth(req, authConfig, envHostKey);

  if (method === 'GET') {
    const sharedState = await readSharedStateOrDefault(kvStore);
    return jsonResponse(200, {
      ok: true,
      sharedState,
      auth: {
        configured: authStatus.configured,
        envHostLocked: authStatus.envHostLocked,
        role: authStatus.role,
        label: authStatus.label,
        revoked: authStatus.revoked,
      },
    });
  }

  if (method === 'PUT') {
    if (authStatus.role !== 'host' && authStatus.role !== 'editor') {
      return jsonResponse(401, {
        ok: false,
        error: authStatus.revoked ? 'REVOKED' : 'UNAUTHORIZED',
        message: authStatus.revoked
          ? '편집 권한이 만료되었거나 회수되었습니다.'
          : '수정 권한이 없습니다. 보기 전용 모드입니다.',
      });
    }

    let body;
    try {
      body = await req.json();
    } catch {
      return jsonResponse(400, { ok: false, error: 'INVALID_JSON', message: '잘못된 JSON 요청입니다.' });
    }

    const current = await readSharedStateOrDefault(kvStore);
    const expectedRevision = body?.expectedRevision;
    const force = Boolean(body?.force) && authStatus.role === 'host';

    if (
      !force &&
      expectedRevision !== undefined &&
      expectedRevision !== null &&
      Number(expectedRevision) !== current.revision
    ) {
      return jsonResponse(409, {
        ok: false,
        error: 'CONFLICT',
        message: '다른 권한자가 먼저 수정했습니다. 최신 시간표로 갱신했습니다.',
        latestState: current,
      });
    }

    const nowMs = Date.now();
    const incoming = body?.sharedState ?? body?.state ?? body;
    const sanitized = sanitizeSharedState(incoming, nowMs);
    const nextShared = {
      ...sanitized,
      revision: current.revision + 1,
      updatedAtMs: nowMs,
      updatedBy: authStatus.label || '편집자',
    };

    await kvStore.set(KEY_SHARED_STATE, nextShared);
    return jsonResponse(200, { ok: true, sharedState: nextShared });
  }

  return jsonResponse(405, { ok: false, error: 'METHOD_NOT_ALLOWED', message: '지원하지 않는 요청 방식입니다.' });
}

export async function handleAuthRequest(req, kvStore, envHostKey = getEnvHostKey()) {
  const method = (req.method || 'GET').toUpperCase();

  if (method === 'GET') {
    const authConfig = await readAuthSafe(kvStore);
    const authStatus = evaluateAuth(req, authConfig, envHostKey);
    return jsonResponse(200, {
      ok: true,
      configured: authStatus.configured,
      envHostLocked: authStatus.envHostLocked,
      role: authStatus.role,
      label: authStatus.label,
      revoked: authStatus.revoked,
      editors: authStatus.role === 'host' ? formatSafeEditors(authConfig.editors) : [],
    });
  }

  if (method !== 'POST') {
    return jsonResponse(405, { ok: false, error: 'METHOD_NOT_ALLOWED', message: '지원하지 않는 요청 방식입니다.' });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { ok: false, error: 'INVALID_JSON', message: '잘못된 JSON 요청입니다.' });
  }

  const action = String(body?.action || '').trim();
  const authConfig = await readOrInitSessionSecretConfig(kvStore);

  if (action === 'setup_host') {
    if (envHostKey || authConfig.hostKeyHash) {
      return jsonResponse(409, {
        ok: false,
        error: 'ALREADY_CONFIGURED',
        message: '이미 메인 호스트 비밀번호가 설정되어 있습니다.',
      });
    }
    const password = typeof body?.password === 'string' ? body.password.trim() : '';
    if (password.length < 4 || password.length > 64) {
      return jsonResponse(400, {
        ok: false,
        error: 'INVALID_PASSWORD',
        message: '호스트 비밀번호는 4자 이상 64자 이하로 입력해 주세요.',
      });
    }

    authConfig.hostKeyHash = hashSecretScrypt(password);
    authConfig.hostTokenVersion = 1;
    await kvStore.set(KEY_AUTH_CONFIG, authConfig);

    const token = createHostToken(authConfig, envHostKey);
    return jsonResponse(201, {
      ok: true,
      token,
      role: 'host',
      label: '메인 호스트',
      configured: true,
      envHostLocked: false,
      editors: formatSafeEditors(authConfig.editors),
    });
  }

  if (action === 'login') {
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    if (!code) {
      return jsonResponse(400, {
        ok: false,
        error: 'MISSING_CODE',
        message: '비밀번호 또는 편집 코드를 입력해 주세요.',
      });
    }

    const hostMatch = envHostKey
      ? timingSafeEqualStr(sha256Hex(code), sha256Hex(envHostKey))
      : Boolean(
          authConfig.hostKeyHash &&
            verifySecretScrypt(code, authConfig.hostKeyHash.salt, authConfig.hostKeyHash.hash)
        );

    if (hostMatch) {
      const token = createHostToken(authConfig, envHostKey);
      return jsonResponse(200, {
        ok: true,
        token,
        role: 'host',
        label: '메인 호스트',
        configured: true,
        envHostLocked: Boolean(envHostKey),
        editors: formatSafeEditors(authConfig.editors),
      });
    }

    const normalizedCode = normalizeEditorCodeInput(code);
    for (const editor of authConfig.editors) {
      if (verifySecretScrypt(normalizedCode, editor.codeSalt, editor.codeHash)) {
        editor.lastUsedAtMs = Date.now();
        await kvStore.set(KEY_AUTH_CONFIG, authConfig);
        const token = signSessionToken(
          { r: 'editor', id: editor.id, v: 1, iat: Date.now() },
          authConfig.sessionSecret
        );
        return jsonResponse(200, {
          ok: true,
          token,
          role: 'editor',
          editorId: editor.id,
          label: editor.label,
          configured: Boolean(envHostKey || authConfig.hostKeyHash),
          envHostLocked: Boolean(envHostKey),
          editors: [],
        });
      }
    }

    return jsonResponse(401, {
      ok: false,
      error: 'INVALID_CODE',
      message: '비밀번호 또는 편집 코드가 올바르지 않습니다.',
    });
  }

  // Host-only management actions below
  const authStatus = evaluateAuth(req, authConfig, envHostKey);
  if (authStatus.role !== 'host') {
    return jsonResponse(403, {
      ok: false,
      error: 'FORBIDDEN',
      message: '메인 호스트 권한이 필요합니다.',
    });
  }

  if (action === 'create_editor') {
    const label = typeof body?.label === 'string' ? body.label.trim().slice(0, 24) : '';
    if (!label) {
      return jsonResponse(400, {
        ok: false,
        error: 'INVALID_LABEL',
        message: '권한을 줄 사람 이름(별명)을 입력해 주세요.',
      });
    }
    if (authConfig.editors.length >= MAX_EDITORS) {
      return jsonResponse(400, {
        ok: false,
        error: 'LIMIT_REACHED',
        message: `편집자 계정은 최대 ${MAX_EDITORS}명까지 발급할 수 있습니다.`,
      });
    }

    const code = generateEditorCode();
    const { salt, hash } = hashSecretScrypt(code);
    const editorRecord = {
      id: `ed_${crypto.randomBytes(6).toString('hex')}`,
      label,
      codeSalt: salt,
      codeHash: hash,
      codeHint: code.slice(-4),
      createdAtMs: Date.now(),
      lastUsedAtMs: null,
    };
    authConfig.editors.push(editorRecord);
    await kvStore.set(KEY_AUTH_CONFIG, authConfig);

    return jsonResponse(201, {
      ok: true,
      code,
      editor: {
        id: editorRecord.id,
        label: editorRecord.label,
        codeHint: editorRecord.codeHint,
        createdAtMs: editorRecord.createdAtMs,
        lastUsedAtMs: editorRecord.lastUsedAtMs,
      },
      editors: formatSafeEditors(authConfig.editors),
    });
  }

  if (action === 'revoke_editor') {
    const editorId = typeof body?.editorId === 'string' ? body.editorId.trim() : '';
    const beforeLen = authConfig.editors.length;
    authConfig.editors = authConfig.editors.filter((e) => e.id !== editorId);
    if (authConfig.editors.length === beforeLen) {
      return jsonResponse(404, {
        ok: false,
        error: 'NOT_FOUND',
        message: '해당 편집자 권한을 찾을 수 없습니다.',
      });
    }
    await kvStore.set(KEY_AUTH_CONFIG, authConfig);
    return jsonResponse(200, {
      ok: true,
      editors: formatSafeEditors(authConfig.editors),
    });
  }

  if (action === 'change_host_password') {
    if (envHostKey) {
      return jsonResponse(400, {
        ok: false,
        error: 'ENV_LOCKED',
        message: 'Netlify 환경변수(HOST_ADMIN_KEY)로 호스트 비밀번호가 고정되어 있습니다.',
      });
    }
    const newPassword = typeof body?.newPassword === 'string' ? body.newPassword.trim() : '';
    if (newPassword.length < 4 || newPassword.length > 64) {
      return jsonResponse(400, {
        ok: false,
        error: 'INVALID_PASSWORD',
        message: '새 비밀번호는 4자 이상 64자 이하로 입력해 주세요.',
      });
    }
    authConfig.hostKeyHash = hashSecretScrypt(newPassword);
    authConfig.hostTokenVersion += 1;
    await kvStore.set(KEY_AUTH_CONFIG, authConfig);
    const token = createHostToken(authConfig, envHostKey);
    return jsonResponse(200, {
      ok: true,
      token,
      editors: formatSafeEditors(authConfig.editors),
    });
  }

  return jsonResponse(400, {
    ok: false,
    error: 'UNKNOWN_ACTION',
    message: '알 수 없는 요청입니다.',
  });
}

/**
 * File-backed KV store adapter for local Node server & automated tests.
 */
export function createFileKvStore(dataDir) {
  const queues = new Map();

  function filePathForKey(key) {
    if (key === KEY_SHARED_STATE) return path.join(dataDir, 'shared-state.json');
    if (key === KEY_AUTH_CONFIG) return path.join(dataDir, 'auth.json');
    if (key === KEY_TELEGRAM_STATE) return path.join(dataDir, 'telegram-alerts.json');
    throw new Error(`Unsupported store key: ${key}`);
  }

  function enqueue(key, fn) {
    const prev = queues.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    queues.set(key, next);
    return next;
  }

  return {
    async get(key) {
      const target = filePathForKey(key);
      try {
        const raw = await fs.readFile(target, 'utf8');
        return JSON.parse(raw);
      } catch {
        // Migrate legacy single-file bosses.json once if present
        if (key === KEY_SHARED_STATE) {
          try {
            const legacyRaw = await fs.readFile(path.join(dataDir, 'bosses.json'), 'utf8');
            return JSON.parse(legacyRaw);
          } catch {
            return null;
          }
        }
        return null;
      }
    },
    async set(key, value) {
      const target = filePathForKey(key);
      return enqueue(key, async () => {
        await fs.mkdir(dataDir, { recursive: true });
        const tmp = `${target}.${crypto.randomBytes(4).toString('hex')}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
        await fs.rename(tmp, target);
      });
    },
  };
}
