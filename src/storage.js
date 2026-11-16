import { createDefaultState, sanitizeState } from './calculator.js';

const LOCAL_STORAGE_KEY = 'boss_spawn_timer_state_v1';

let detectedLocalApi = false;

function isLocalHostname() {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

async function detectLocalFileServer() {
  if (typeof window === 'undefined') return false;
  if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') return false;
  if (!isLocalHostname()) return false;

  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    if (!res.ok) return false;
    const data = await res.json();
    return Boolean(data && data.ok && data.mode === 'local-file-server');
  } catch {
    return false;
  }
}

export async function loadState() {
  const fallbackNow = Date.now();
  detectedLocalApi = await detectLocalFileServer();

  if (detectedLocalApi) {
    try {
      const res = await fetch('/api/state', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        if (data && data.state) {
          const clean = sanitizeState(data.state, fallbackNow);
          saveLocalMirror(clean);
          return { state: clean, source: 'server' };
        }
      }
    } catch {
      // Fall back to localStorage below
    }
  }

  try {
    const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { state: sanitizeState(parsed, fallbackNow), source: 'local' };
    }
  } catch {
    // Ignore storage read errors
  }

  const initial = createDefaultState(fallbackNow);
  saveLocalMirror(initial);
  return { state: initial, source: detectedLocalApi ? 'server' : 'local' };
}

function saveLocalMirror(state) {
  try {
    window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore quota errors
  }
}

let pendingSaveTimer = null;
let lastStateToSave = null;

export function saveState(state, immediate = false) {
  saveLocalMirror(state);
  lastStateToSave = state;

  if (!detectedLocalApi) return Promise.resolve();

  const flush = async () => {
    const payload = lastStateToSave;
    if (!payload) return;
    try {
      await fetch('/api/state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: payload }),
      });
    } catch {
      // Keep localStorage copy safely intact if server temporarily unavailable
    }
  };

  if (immediate) {
    if (pendingSaveTimer) {
      clearTimeout(pendingSaveTimer);
      pendingSaveTimer = null;
    }
    return flush();
  }

  if (pendingSaveTimer) clearTimeout(pendingSaveTimer);
  pendingSaveTimer = setTimeout(() => {
    pendingSaveTimer = null;
    flush();
  }, 250);

  return Promise.resolve();
}
