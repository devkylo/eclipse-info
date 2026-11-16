import {
  createDefaultLocalPrefs,
  createDefaultSharedState,
  sanitizeLocalPrefs,
  sanitizeSharedState,
} from './calculator.js';

const LOCAL_PREFS_KEY = 'eclipse_local_prefs_v1';
const SHARED_MIRROR_KEY = 'eclipse_shared_mirror_v1';
const AUTH_SESSION_KEY = 'eclipse_auth_session_v1';
const LEGACY_STORAGE_KEY = 'boss_spawn_timer_state_v1';

function isHttpProtocol() {
  return (
    typeof window !== 'undefined' &&
    (window.location.protocol === 'http:' || window.location.protocol === 'https:')
  );
}

function readStorageJson(key) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeStorageJson(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage quota errors
  }
}

export function loadAuthSession() {
  const raw = readStorageJson(AUTH_SESSION_KEY);
  if (!raw || typeof raw !== 'object' || typeof raw.token !== 'string' || !raw.token.trim()) {
    return null;
  }
  return {
    token: raw.token.trim(),
    role: raw.role === 'host' || raw.role === 'editor' ? raw.role : 'viewer',
    label: typeof raw.label === 'string' ? raw.label : '',
  };
}

export function saveAuthSession(session) {
  if (!session || typeof session.token !== 'string' || !session.token.trim()) {
    clearAuthSession();
    return;
  }
  writeStorageJson(AUTH_SESSION_KEY, {
    token: session.token.trim(),
    role: session.role,
    label: session.label || '',
  });
}

export function clearAuthSession() {
  try {
    window.localStorage.removeItem(AUTH_SESSION_KEY);
  } catch {
    // Ignore
  }
}

export function consumeInviteCodeFromUrl() {
  if (typeof window === 'undefined') return '';
  try {
    const url = new URL(window.location.href);
    const code = url.searchParams.get('edit');
    if (!code || !code.trim()) return '';
    url.searchParams.delete('edit');
    const cleanUrl = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState(null, '', cleanUrl || '/');
    return code.trim();
  } catch {
    return '';
  }
}

export function getLegacyLocalBackup() {
  return readStorageJson(LEGACY_STORAGE_KEY);
}

export function loadLocalPrefs() {
  const saved = readStorageJson(LOCAL_PREFS_KEY);
  if (saved && typeof saved === 'object') {
    return sanitizeLocalPrefs(saved);
  }

  // Migrate personal preferences cleanly once from pre-sync single-browser storage if present
  const legacy = getLegacyLocalBackup();
  if (legacy && typeof legacy === 'object') {
    const migrated = sanitizeLocalPrefs({
      hasSelectedInitialServer: legacy.hasSelectedInitialServer,
      activeServerId: legacy.activeServerId,
      serverTabs: legacy.serverTabs,
      settings: legacy.settings,
      serverAlertLogs:
        legacy.servers && typeof legacy.servers === 'object'
          ? Object.fromEntries(
              Object.entries(legacy.servers)
                .filter(([, v]) => Array.isArray(v?.alertLogs))
                .map(([k, v]) => [k, v.alertLogs])
            )
          : {},
    });
    saveLocalPrefs(migrated);
    return migrated;
  }

  const defaults = createDefaultLocalPrefs();
  saveLocalPrefs(defaults);
  return defaults;
}

export function saveLocalPrefs(prefs) {
  writeStorageJson(LOCAL_PREFS_KEY, prefs);
}

export function loadSharedMirror(fallbackNow = Date.now()) {
  const cached = readStorageJson(SHARED_MIRROR_KEY);
  if (cached && typeof cached === 'object') {
    return sanitizeSharedState(cached, fallbackNow);
  }
  const legacy = getLegacyLocalBackup();
  if (legacy && typeof legacy === 'object') {
    return sanitizeSharedState(legacy, fallbackNow);
  }
  return createDefaultSharedState(fallbackNow);
}

export function saveSharedMirror(sharedState) {
  writeStorageJson(SHARED_MIRROR_KEY, sharedState);
}

function buildAuthHeaders(extra = {}) {
  const session = loadAuthSession();
  return {
    ...extra,
    ...(session?.token ? { Authorization: `Bearer ${session.token}` } : {}),
  };
}

async function parseJsonResponse(res) {
  const ctype = res.headers.get('content-type') || '';
  if (!ctype.includes('application/json')) {
    throw new Error('Non-JSON response');
  }
  return res.json();
}

export async function fetchSharedBootstrap() {
  const fallbackNow = Date.now();
  if (!isHttpProtocol()) {
    return {
      apiAvailable: false,
      sharedState: loadSharedMirror(fallbackNow),
      auth: {
        configured: false,
        envHostLocked: false,
        role: 'local',
        label: '로컬 단독 모드',
        revoked: false,
      },
    };
  }

  try {
    const res = await fetch('/api/shared-state', {
      cache: 'no-store',
      headers: buildAuthHeaders(),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await parseJsonResponse(res);
    if (!data || !data.ok || !data.sharedState) {
      throw new Error('Invalid shared-state response');
    }
    const cleanShared = sanitizeSharedState(data.sharedState, fallbackNow);
    saveSharedMirror(cleanShared);

    const auth = data.auth || {
      configured: false,
      envHostLocked: false,
      role: 'viewer',
      label: null,
      revoked: false,
    };
    if (auth.revoked) {
      clearAuthSession();
    }
    return {
      apiAvailable: true,
      sharedState: cleanShared,
      auth,
    };
  } catch {
    return {
      apiAvailable: false,
      sharedState: loadSharedMirror(fallbackNow),
      auth: {
        configured: false,
        envHostLocked: false,
        role: 'local',
        label: '오프라인 로컬 모드',
        revoked: false,
      },
    };
  }
}

export async function saveSharedStateRemote(sharedState, expectedRevision, options = {}) {
  saveSharedMirror(sharedState);
  if (!isHttpProtocol()) {
    return { ok: true, localOnly: true, sharedState };
  }

  try {
    const res = await fetch('/api/shared-state', {
      method: 'PUT',
      headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        sharedState,
        expectedRevision,
        force: Boolean(options.force),
      }),
    });
    const data = await parseJsonResponse(res);

    if (res.status === 409 && data?.latestState) {
      const latest = sanitizeSharedState(data.latestState, Date.now());
      saveSharedMirror(latest);
      return {
        ok: false,
        status: 409,
        conflict: true,
        message: data.message || '다른 권한자가 먼저 수정했습니다.',
        latestState: latest,
      };
    }

    if (res.status === 401 || res.status === 403) {
      if (data?.error === 'REVOKED') {
        clearAuthSession();
      }
      return {
        ok: false,
        status: res.status,
        unauthorized: true,
        revoked: data?.error === 'REVOKED',
        message: data?.message || '수정 권한이 없습니다.',
      };
    }

    if (!res.ok || !data?.ok || !data?.sharedState) {
      return {
        ok: false,
        status: res.status,
        message: data?.message || '서버 저장에 실패했습니다.',
      };
    }

    const clean = sanitizeSharedState(data.sharedState, Date.now());
    saveSharedMirror(clean);
    return { ok: true, sharedState: clean };
  } catch {
    return {
      ok: false,
      offline: true,
      message: '서버와 연결할 수 없습니다. 잠시 후 새로고침해 주세요.',
    };
  }
}

export async function fetchAuthStatus() {
  if (!isHttpProtocol()) {
    return {
      ok: false,
      offline: true,
      configured: false,
      envHostLocked: false,
      role: 'local',
      label: '로컬 모드',
      revoked: false,
      editors: [],
    };
  }
  try {
    const res = await fetch('/api/auth', {
      cache: 'no-store',
      headers: buildAuthHeaders(),
    });
    const data = await parseJsonResponse(res);
    if (data?.revoked) {
      clearAuthSession();
    }
    return { ok: res.ok && Boolean(data?.ok), ...data };
  } catch {
    return {
      ok: false,
      offline: true,
      configured: false,
      envHostLocked: false,
      role: 'viewer',
      label: null,
      revoked: false,
      editors: [],
    };
  }
}

export async function postAuthAction(payload) {
  if (!isHttpProtocol()) {
    return {
      ok: false,
      status: 0,
      message: '로컬 파일 모드(file://)에서는 권한 서버를 사용할 수 없습니다.',
    };
  }
  try {
    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });
    const data = await parseJsonResponse(res);
    return { status: res.status, ...data };
  } catch {
    return {
      ok: false,
      status: 0,
      message: '권한 서버와 통신하지 못했습니다.',
    };
  }
}
