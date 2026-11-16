/**
 * Pure domain logic for Eclipse: The Awakening Boss Spawn Time calculation,
 * world vs field boss scheduling, multi-server management, formatting, and alerts.
 * Compatible with both browser ES modules and Node.js.
 */

export const DEFAULT_NOTIFY_OFFSETS_SEC = [600, 300, 60, 0];
export const FIELD_BOSS_RED_WINDOW_MS = 10 * 60 * 1000; // 10 minutes before spawn

export const SERVER_WORLD_GROUPS = [
  { id: 'heskarion', name: '헤스카리온', channels: 6 },
  { id: 'seraha', name: '세라하', channels: 6 },
  { id: 'valkyria', name: '발키리아', channels: 6 },
  { id: 'barkadion', name: '바르카디온', channels: 6 },
  { id: 'valzera', name: '발제라', channels: 6 },
  { id: 'celine', name: '셀린', channels: 6 },
];

export const DEFAULT_SERVER_ID = 'barkadion-05';

export const ALL_SERVERS = SERVER_WORLD_GROUPS.flatMap((world) =>
  Array.from({ length: world.channels }, (_, i) => {
    const ch = String(i + 1).padStart(2, '0');
    const id = `${world.id}-${ch}`;
    return {
      id,
      worldId: world.id,
      worldName: world.name,
      channel: ch,
      name: `${world.name} ${ch}`,
      hasPreset: id === DEFAULT_SERVER_ID,
    };
  })
);

const SERVER_MAP = new Map(ALL_SERVERS.map((s) => [s.id, s]));

export function getServerMeta(serverId) {
  return (
    SERVER_MAP.get(serverId) || {
      id: serverId || DEFAULT_SERVER_ID,
      worldId: 'custom',
      worldName: '기타',
      channel: '',
      name: serverId || '바르카디온 05',
      hasPreset: false,
    }
  );
}

export const PRESET_WORLD_BOSS_SPECS = [
  {
    id: 'kraka',
    bossType: 'world',
    level: 60,
    name: '크라카',
    fixedTimes: ['12:00', '20:00'],
    activeDurationSec: 3600, // 1시간 출현 유지
    color: '#a855f7',
    memo: '',
  },
  {
    id: 'everhart',
    bossType: 'world',
    level: 80,
    name: '에버하르트',
    fixedTimes: ['12:00', '20:00'],
    activeDurationSec: 3600, // 1시간 출현 유지
    color: '#ec4899',
    memo: '',
  },
];

export const PRESET_FIELD_BOSS_SPECS = [
  {
    id: 'remanent',
    bossType: 'field',
    level: 40,
    name: '레마넌트',
    killDurationSec: 60,
    respawnDurationSec: 8 * 3600,
    hhmm: '16:20',
    color: '#f59e0b',
    memo: '',
  },
  {
    id: 'venatoria',
    bossType: 'field',
    level: 50,
    name: '베나토리아',
    killDurationSec: 60,
    respawnDurationSec: 8 * 3600,
    hhmm: '16:31',
    color: '#ef4444',
    memo: '',
  },
  {
    id: 'sharelna',
    bossType: 'field',
    level: 60,
    name: '샤렐나',
    killDurationSec: 60,
    respawnDurationSec: 10 * 3600,
    hhmm: '18:57',
    color: '#8b5cf6',
    memo: '',
  },
  {
    id: 'calibrax',
    bossType: 'field',
    level: 70,
    name: '칼리브락스',
    killDurationSec: 60,
    respawnDurationSec: 12 * 3600,
    hhmm: '20:49',
    color: '#3b82f6',
    memo: '',
  },
  {
    id: 'arkandar',
    bossType: 'field',
    level: 75,
    name: '아르칸다르',
    killDurationSec: null,
    respawnDurationSec: 12 * 3600,
    hhmm: '20:56',
    color: '#10b981',
    memo: '',
  },
];

// Kept for compatibility
export const PRESET_BOSS_SPECS = PRESET_FIELD_BOSS_SPECS;

const PRESET_LEVEL_BY_ID = new Map(
  [...PRESET_WORLD_BOSS_SPECS, ...PRESET_FIELD_BOSS_SPECS].map((s) => [s.id, s.level])
);
const PRESET_LEVEL_BY_NAME = new Map(
  [...PRESET_WORLD_BOSS_SPECS, ...PRESET_FIELD_BOSS_SPECS].map((s) => [s.name, s.level])
);

export function normalizeBossLevel(val) {
  if (val === null || val === undefined || val === '') return null;
  const n = Math.round(Number(val));
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

export function createDefaultSettings() {
  return {
    globalNotifyOffsetsSec: [...DEFAULT_NOTIFY_OFFSETS_SEC],
    desktopNotifications: true,
    soundEnabled: true,
    soundPreset: 'chime',
    soundVolume: 0.7,
    ttsEnabled: false,
    autoRolloverDefault: true,
    autoWednesdayReset: true,
    maintenanceEndTime: '08:00',
    serverOffsetSec: 0,
    sortBy: 'soonest',
    bossFilter: 'all', // 'all' | 'world' | 'field'
    groupByType: false,
  };
}

/**
 * Parse "HH:MM", "HH:MM:SS", or "HHMM" into { hours, minutes, seconds } or null.
 */
export function parseTimeString(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  let match = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) {
    match = trimmed.match(/^(\d{2})(\d{2})$/);
  }
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = match[3] !== undefined ? Number(match[3]) : 0;

  if (
    !Number.isInteger(hours) ||
    !Number.isInteger(minutes) ||
    !Number.isInteger(seconds) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59 ||
    seconds < 0 ||
    seconds > 59
  ) {
    return null;
  }

  return { hours, minutes, seconds };
}

export function normalizeFixedTimes(times) {
  if (!Array.isArray(times)) return [];
  const formatted = new Set();
  for (const t of times) {
    const parsed = parseTimeString(String(t ?? ''));
    if (!parsed) continue;
    formatted.add(`${pad2(parsed.hours)}:${pad2(parsed.minutes)}`);
  }
  return Array.from(formatted).sort();
}

/**
 * Build an epoch timestamp for HH:MM(:SS) on the calendar day of referenceMs + dayOffset.
 */
export function buildTimestampOnDay(timeStr, referenceMs = Date.now(), dayOffset = 0) {
  const parsed = parseTimeString(timeStr);
  if (!parsed) return null;
  const d = new Date(referenceMs);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(parsed.hours, parsed.minutes, parsed.seconds, 0);
  return d.getTime();
}

export function normalizeMaintenanceTimeStr(timeStr) {
  const parsed = parseTimeString(String(timeStr ?? ''));
  if (!parsed) return '08:00';
  return `${pad2(parsed.hours)}:${pad2(parsed.minutes)}`;
}

/**
 * Find the most recent Wednesday HH:MM timestamp <= nowMs.
 */
export function getMostRecentWednesdayResetMs(nowMs = Date.now(), timeStr = '08:00') {
  const parsed = parseTimeString(timeStr) || { hours: 8, minutes: 0, seconds: 0 };
  const d = new Date(nowMs);
  const diffDays = (d.getDay() - 3 + 7) % 7; // 3 = Wednesday
  const candidate = new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() - diffDays,
    parsed.hours,
    parsed.minutes,
    parsed.seconds,
    0
  );
  if (nowMs < candidate.getTime()) {
    candidate.setDate(candidate.getDate() - 7);
  }
  return candidate.getTime();
}

/**
 * Find the next upcoming Wednesday HH:MM timestamp > nowMs.
 */
export function getNextWednesdayResetMs(nowMs = Date.now(), timeStr = '08:00') {
  const recent = getMostRecentWednesdayResetMs(nowMs, timeStr);
  const d = new Date(recent);
  d.setDate(d.getDate() + 7);
  return d.getTime();
}

/**
 * Extract maintenance end time ("HH:MM") from pasted notice text like "05:00 ~ 08:00" or "09:30".
 */
export function parseMaintenanceEndTimeFromText(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const rangeMatches = [...text.matchAll(/(\d{1,2}:\d{2})\s*[~\-–]\s*(\d{1,2}:\d{2})/g)];
  for (let i = rangeMatches.length - 1; i >= 0; i -= 1) {
    const parsed = parseTimeString(rangeMatches[i][2]);
    if (parsed) return `${pad2(parsed.hours)}:${pad2(parsed.minutes)}`;
  }
  const singleMatches = [...text.matchAll(/\b(\d{1,2}:\d{2})\b/g)];
  for (let i = singleMatches.length - 1; i >= 0; i -= 1) {
    const parsed = parseTimeString(singleMatches[i][1]);
    if (parsed) return `${pad2(parsed.hours)}:${pad2(parsed.minutes)}`;
  }
  return null;
}

export function createDefaultWorldBosses() {
  return PRESET_WORLD_BOSS_SPECS.map((spec) => ({
    id: spec.id,
    bossType: 'world',
    level: spec.level,
    name: spec.name,
    fixedTimes: [...spec.fixedTimes],
    activeDurationSec: spec.activeDurationSec,
    killDurationSec: null,
    respawnDurationSec: 8 * 3600,
    nextSpawnMs: 0,
    anchorType: 'manual',
    anchorTimeMs: null,
    notifyEnabled: true,
    useCustomNotify: false,
    customNotifyOffsetsSec: [...DEFAULT_NOTIFY_OFFSETS_SEC],
    autoRollover: false,
    memo: spec.memo,
    color: spec.color,
    previousState: null,
  }));
}

export function createDefaultFieldBosses(referenceMs = Date.now()) {
  return PRESET_FIELD_BOSS_SPECS.map((spec) => ({
    id: spec.id,
    bossType: 'field',
    level: spec.level,
    name: spec.name,
    fixedTimes: [],
    activeDurationSec: 3600,
    killDurationSec: spec.killDurationSec,
    respawnDurationSec: spec.respawnDurationSec,
    nextSpawnMs: buildTimestampOnDay(spec.hhmm, referenceMs, 0),
    anchorType: 'manual',
    anchorTimeMs: null,
    notifyEnabled: true,
    useCustomNotify: false,
    customNotifyOffsetsSec: [...DEFAULT_NOTIFY_OFFSETS_SEC],
    autoRollover: true,
    memo: spec.memo,
    color: spec.color,
    previousState: null,
  }));
}

export function createDefaultBosses(referenceMs = Date.now()) {
  return [...createDefaultWorldBosses(), ...createDefaultFieldBosses(referenceMs)];
}

export function createDefaultState(referenceMs = Date.now()) {
  return {
    version: 6,
    hasSelectedInitialServer: false,
    activeServerId: DEFAULT_SERVER_ID,
    serverTabs: [{ id: DEFAULT_SERVER_ID, favorite: true }],
    lastMaintenanceResetMs: getMostRecentWednesdayResetMs(referenceMs, '08:00'),
    settings: createDefaultSettings(),
    servers: {
      [DEFAULT_SERVER_ID]: {
        bosses: createDefaultBosses(referenceMs),
        alertLogs: [],
      },
    },
  };
}

export function getOrderedServerTabs(serverTabs) {
  if (!Array.isArray(serverTabs)) return [];
  const favs = [];
  const rest = [];
  for (const tab of serverTabs) {
    if (!tab || typeof tab.id !== 'string') continue;
    if (tab.favorite) favs.push({ id: tab.id, favorite: true });
    else rest.push({ id: tab.id, favorite: false });
  }
  return [...favs, ...rest];
}

export function toggleServerFavorite(serverTabs, serverId) {
  const ordered = getOrderedServerTabs(serverTabs);
  const updated = ordered.map((t) =>
    t.id === serverId ? { ...t, favorite: !t.favorite } : t
  );
  return getOrderedServerTabs(updated);
}

export function moveServerTab(serverTabs, serverId, direction) {
  const ordered = getOrderedServerTabs(serverTabs);
  const idx = ordered.findIndex((t) => t.id === serverId);
  if (idx === -1) return ordered;
  const targetIdx = idx + (direction < 0 ? -1 : 1);
  if (targetIdx < 0 || targetIdx >= ordered.length) return ordered;
  if (ordered[idx].favorite !== ordered[targetIdx].favorite) return ordered;

  const copy = [...ordered];
  const [item] = copy.splice(idx, 1);
  copy.splice(targetIdx, 0, item);
  return copy;
}

export function getActiveServerData(state) {
  const serverId = state.activeServerId || DEFAULT_SERVER_ID;
  const entry = (state.servers && state.servers[serverId]) || { bosses: [], alertLogs: [] };
  return {
    serverId,
    serverMeta: getServerMeta(serverId),
    bosses: entry.bosses || [],
    alertLogs: entry.alertLogs || [],
  };
}

export function addOrSelectServer(state, serverId, seedMode = 'auto', nowMs = Date.now()) {
  const id = SERVER_MAP.has(serverId) ? serverId : DEFAULT_SERVER_ID;
  const existingTabs = getOrderedServerTabs(state.serverTabs);
  const hasTab = existingTabs.some((t) => t.id === id);
  const nextTabs = hasTab
    ? existingTabs
    : getOrderedServerTabs([...existingTabs, { id, favorite: false }]);

  const existingServer = state.servers && state.servers[id];
  let nextServerEntry = existingServer;
  if (!existingServer) {
    const usePreset =
      seedMode === 'preset' || (seedMode === 'auto' && id === DEFAULT_SERVER_ID);
    nextServerEntry = {
      bosses: usePreset ? createDefaultBosses(nowMs) : [],
      alertLogs: [],
    };
  }

  return {
    ...state,
    hasSelectedInitialServer: true,
    activeServerId: id,
    serverTabs: nextTabs,
    servers: {
      ...(state.servers || {}),
      [id]: nextServerEntry,
    },
  };
}

export function removeServerTab(state, serverId, options = {}) {
  const ordered = getOrderedServerTabs(state.serverTabs);
  if (ordered.length <= 1) return state;
  const nextTabs = ordered.filter((t) => t.id !== serverId);
  const nextServers = { ...(state.servers || {}) };
  if (!options.preserveServers) {
    delete nextServers[serverId];
  }
  const nextActive =
    state.activeServerId === serverId ? nextTabs[0].id : state.activeServerId;

  return {
    ...state,
    activeServerId: nextActive,
    serverTabs: nextTabs,
    servers: nextServers,
  };
}

export function isWorldBoss(boss) {
  return boss && boss.bossType === 'world';
}

export function getEffectiveActiveSec(boss) {
  const val = Number(boss?.activeDurationSec);
  if (!Number.isFinite(val) || val <= 0) return 3600;
  return Math.max(60, Math.round(val));
}

/**
 * Compute active & upcoming window for a World Boss with fixed daily times.
 */
export function getWorldBossWindow(boss, nowMs = Date.now()) {
  const fixedTimes = normalizeFixedTimes(boss?.fixedTimes);
  if (!fixedTimes.length) {
    return {
      isActiveNow: false,
      windowStartMs: null,
      windowEndMs: null,
      nextStartMs: null,
      effectiveTargetMs: null,
    };
  }

  const activeMs = getEffectiveActiveSec(boss) * 1000;
  const candidates = [];
  for (let dayOffset = -1; dayOffset <= 2; dayOffset += 1) {
    for (const t of fixedTimes) {
      const startMs = buildTimestampOnDay(t, nowMs, dayOffset);
      if (startMs !== null) {
        candidates.push(startMs);
      }
    }
  }
  candidates.sort((a, b) => a - b);

  let activeWindow = null;
  let nextStartMs = null;

  for (const startMs of candidates) {
    const endMs = startMs + activeMs;
    if (nowMs >= startMs && nowMs < endMs) {
      activeWindow = { startMs, endMs };
    } else if (startMs > nowMs && nextStartMs === null) {
      nextStartMs = startMs;
    }
  }

  if (activeWindow) {
    return {
      isActiveNow: true,
      windowStartMs: activeWindow.startMs,
      windowEndMs: activeWindow.endMs,
      nextStartMs,
      effectiveTargetMs: activeWindow.startMs,
    };
  }

  return {
    isActiveNow: false,
    windowStartMs: null,
    windowEndMs: null,
    nextStartMs,
    effectiveTargetMs: nextStartMs,
  };
}

export function getBossDisplaySpawnMs(boss, nowMs = Date.now()) {
  if (isWorldBoss(boss)) {
    const win = getWorldBossWindow(boss, nowMs);
    return win.effectiveTargetMs ?? nowMs;
  }
  return boss.nextSpawnMs;
}

export function getEffectiveKillSec(boss) {
  if (boss.killDurationSec === null || boss.killDurationSec === undefined || Number.isNaN(boss.killDurationSec)) {
    return 0;
  }
  return Math.max(0, Math.round(Number(boss.killDurationSec)));
}

export function getEffectiveRespawnSec(boss) {
  const val = Number(boss.respawnDurationSec);
  if (!Number.isFinite(val) || val <= 0) return 60;
  return Math.max(1, Math.round(val));
}

export function calculateNextSpawnFromLastSpawn(lastSpawnMs, killDurationSec, respawnDurationSec) {
  const killSec = killDurationSec === null || killDurationSec === undefined ? 0 : Math.max(0, Math.round(killDurationSec));
  const respawnSec = Math.max(1, Math.round(respawnDurationSec));
  return lastSpawnMs + (killSec + respawnSec) * 1000;
}

export function calculateNextSpawnFromLastKill(lastKillMs, respawnDurationSec) {
  const respawnSec = Math.max(1, Math.round(respawnDurationSec));
  return lastKillMs + respawnSec * 1000;
}

export function recomputeBossTarget(boss) {
  if (isWorldBoss(boss)) return { ...boss };
  const killSec = getEffectiveKillSec(boss);
  const respawnSec = getEffectiveRespawnSec(boss);

  if (boss.anchorType === 'spawn' && Number.isFinite(boss.anchorTimeMs)) {
    return {
      ...boss,
      nextSpawnMs: calculateNextSpawnFromLastSpawn(boss.anchorTimeMs, killSec, respawnSec),
    };
  }

  if (boss.anchorType === 'kill' && Number.isFinite(boss.anchorTimeMs)) {
    return {
      ...boss,
      nextSpawnMs: calculateNextSpawnFromLastKill(boss.anchorTimeMs, respawnSec),
    };
  }

  return { ...boss };
}

export function getExpectedKillMs(boss) {
  return boss.nextSpawnMs + getEffectiveKillSec(boss) * 1000;
}

export function getAfterNextSpawnMs(boss, nowMs = Date.now()) {
  if (isWorldBoss(boss)) {
    const win = getWorldBossWindow(boss, nowMs);
    return win.nextStartMs ?? nowMs;
  }
  return calculateNextSpawnFromLastSpawn(
    boss.nextSpawnMs,
    getEffectiveKillSec(boss),
    getEffectiveRespawnSec(boss)
  );
}

function makeUndoSnapshot(boss) {
  return {
    nextSpawnMs: boss.nextSpawnMs,
    anchorType: boss.anchorType,
    anchorTimeMs: boss.anchorTimeMs,
  };
}

export function advanceBossCycle(boss, mode, nowMs = Date.now()) {
  if (isWorldBoss(boss)) return boss;
  const previousState = makeUndoSnapshot(boss);

  if (mode === 'killed_now') {
    const updated = {
      ...boss,
      anchorType: 'kill',
      anchorTimeMs: nowMs,
      previousState,
    };
    return recomputeBossTarget(updated);
  }

  const updated = {
    ...boss,
    anchorType: 'spawn',
    anchorTimeMs: boss.nextSpawnMs,
    previousState,
  };
  return recomputeBossTarget(updated);
}

export function setBossTimeByMode(boss, mode, timeMs) {
  if (isWorldBoss(boss) || !Number.isFinite(timeMs)) return boss;
  const previousState = makeUndoSnapshot(boss);

  if (mode === 'spawn') {
    return recomputeBossTarget({
      ...boss,
      anchorType: 'spawn',
      anchorTimeMs: timeMs,
      previousState,
    });
  }

  if (mode === 'kill') {
    return recomputeBossTarget({
      ...boss,
      anchorType: 'kill',
      anchorTimeMs: timeMs,
      previousState,
    });
  }

  return {
    ...boss,
    anchorType: 'manual',
    anchorTimeMs: null,
    nextSpawnMs: timeMs,
    previousState,
  };
}

export function undoBossTimeChange(boss, nowMs = Date.now()) {
  if (!boss.previousState) return boss;
  const { nextSpawnMs, anchorType, anchorTimeMs } = boss.previousState;
  const killSec = getEffectiveKillSec(boss);
  const graceMs = Math.max(killSec, 15) * 1000;
  const wouldImmediatelyRoll = boss.autoRollover && nowMs >= nextSpawnMs + graceMs;
  return {
    ...boss,
    nextSpawnMs,
    anchorType,
    anchorTimeMs,
    autoRollover: wouldImmediatelyRoll ? false : boss.autoRollover,
    previousState: null,
  };
}

export function applyAutoRollover(boss, nowMs = Date.now()) {
  if (isWorldBoss(boss) || !boss.autoRollover) return boss;
  const killSec = getEffectiveKillSec(boss);
  const respawnSec = getEffectiveRespawnSec(boss);
  const cycleMs = (killSec + respawnSec) * 1000;
  if (cycleMs <= 0) return boss;

  const graceMs = Math.max(killSec, 15) * 1000;
  if (nowMs < boss.nextSpawnMs + graceMs) return boss;

  const steps = Math.floor((nowMs - boss.nextSpawnMs - graceMs) / cycleMs) + 1;
  const newAnchorSpawnMs = boss.nextSpawnMs + (steps - 1) * cycleMs;
  const newNextSpawnMs = boss.nextSpawnMs + steps * cycleMs;

  return {
    ...boss,
    anchorType: 'spawn',
    anchorTimeMs: newAnchorSpawnMs,
    nextSpawnMs: newNextSpawnMs,
    previousState: makeUndoSnapshot(boss),
  };
}

/**
 * Reset Field Bosses for server maintenance end timestamp.
 * World Bosses keep their fixed schedules untouched.
 * mode:
 * - 'at_open': first spawn = maintenanceEndMs (08:00), rolling forward with autoRollover if past grace
 * - 'after_cycle': next spawn = maintenanceEndMs + killDuration + respawnDuration
 * - 'manual_only': pin nextSpawnMs = maintenanceEndMs without rolling forward
 */
export function resetFieldBossesForMaintenance(
  bosses,
  maintenanceEndMs,
  mode = 'at_open',
  nowMs = Date.now()
) {
  if (!Array.isArray(bosses) || !Number.isFinite(maintenanceEndMs)) return bosses;

  return bosses.map((boss) => {
    if (isWorldBoss(boss)) return boss;
    const preResetSnapshot = makeUndoSnapshot(boss);

    if (mode === 'after_cycle') {
      const updated = recomputeBossTarget({
        ...boss,
        anchorType: 'spawn',
        anchorTimeMs: maintenanceEndMs,
        previousState: preResetSnapshot,
      });
      if (updated.autoRollover) {
        const rolled = applyAutoRollover(updated, nowMs);
        return { ...rolled, previousState: preResetSnapshot };
      }
      return updated;
    }

    if (mode === 'manual_only') {
      return {
        ...boss,
        anchorType: 'manual',
        anchorTimeMs: null,
        nextSpawnMs: maintenanceEndMs,
        previousState: preResetSnapshot,
      };
    }

    // Default 'at_open': server opens at maintenanceEndMs with field bosses spawned
    const base = {
      ...boss,
      anchorType: 'manual',
      anchorTimeMs: null,
      nextSpawnMs: maintenanceEndMs,
      previousState: preResetSnapshot,
    };
    if (base.autoRollover) {
      const rolled = applyAutoRollover(base, nowMs);
      return { ...rolled, previousState: preResetSnapshot };
    }
    return base;
  });
}

export function applyManualMaintenanceReset(
  state,
  maintenanceEndMs,
  options = {},
  nowMs = Date.now()
) {
  if (!Number.isFinite(maintenanceEndMs)) return state;
  const scope = options.scope === 'active' ? 'active' : 'all';
  const mode = ['at_open', 'after_cycle', 'manual_only'].includes(options.mode)
    ? options.mode
    : 'at_open';

  const targetIds =
    scope === 'active'
      ? [state.activeServerId || DEFAULT_SERVER_ID]
      : getOrderedServerTabs(state.serverTabs).map((t) => t.id);

  const nextServers = { ...(state.servers || {}) };
  const logLabel = `${formatTimeHHMM(maintenanceEndMs)} 정기점검 리셋 적용 (${
    mode === 'after_cycle' ? '점검종료+처치+리스폰' : '오픈 시점 출현 기준'
  })`;

  for (const sid of targetIds) {
    const entry = nextServers[sid];
    if (!entry) continue;
    nextServers[sid] = {
      bosses: resetFieldBossesForMaintenance(entry.bosses, maintenanceEndMs, mode, nowMs),
      alertLogs: [
        {
          id: `maint:${sid}:${maintenanceEndMs}:${nowMs}`,
          bossId: 'maintenance',
          bossName: '정기점검',
          offsetSec: 0,
          targetSpawnMs: maintenanceEndMs,
          triggeredAtMs: nowMs,
          message: `🔄 ${logLabel}`,
        },
        ...(entry.alertLogs || []),
      ].slice(0, 50),
    };
  }

  return {
    ...state,
    lastMaintenanceResetMs: Math.max(state.lastMaintenanceResetMs || 0, maintenanceEndMs),
    servers: nextServers,
  };
}

/**
 * Automatically reset Field Bosses on Wednesday maintenance end time (default 08:00)
 * when crossing a new Wednesday maintenance boundary.
 */
export function applyScheduledWednesdayReset(state, nowMs = Date.now()) {
  if (!state?.settings?.autoWednesdayReset) {
    return { state, didReset: false, resetTimeMs: null };
  }
  const timeStr = normalizeMaintenanceTimeStr(state.settings.maintenanceEndTime);
  const dueResetMs = getMostRecentWednesdayResetMs(nowMs, timeStr);
  const lastDoneMs = Number(state.lastMaintenanceResetMs || 0);

  if (!Number.isFinite(dueResetMs) || dueResetMs <= lastDoneMs) {
    return { state, didReset: false, resetTimeMs: null };
  }

  const nextServers = { ...(state.servers || {}) };
  for (const tab of getOrderedServerTabs(state.serverTabs)) {
    const entry = nextServers[tab.id];
    if (!entry) continue;
    nextServers[tab.id] = {
      bosses: resetFieldBossesForMaintenance(entry.bosses, dueResetMs, 'at_open', nowMs),
      alertLogs: [
        {
          id: `auto-maint:${tab.id}:${dueResetMs}`,
          bossId: 'maintenance',
          bossName: '정기점검',
          offsetSec: 0,
          targetSpawnMs: dueResetMs,
          triggeredAtMs: nowMs,
          message: `🔄 수요일 정기점검(${timeStr}) 자동 리셋 반영 완료`,
        },
        ...(entry.alertLogs || []),
      ].slice(0, 50),
    };
  }

  return {
    state: {
      ...state,
      lastMaintenanceResetMs: dueResetMs,
      servers: nextServers,
    },
    didReset: true,
    resetTimeMs: dueResetMs,
  };
}

export function getEffectiveNotifyOffsetsSec(boss, settings) {
  const raw = boss.useCustomNotify ? boss.customNotifyOffsetsSec : settings.globalNotifyOffsetsSec;
  if (!Array.isArray(raw)) return [];
  const unique = Array.from(
    new Set(
      raw
        .map((n) => Math.round(Number(n)))
        .filter((n) => Number.isFinite(n) && n >= 0)
    )
  );
  return unique.sort((a, b) => b - a);
}

/**
 * Return list of due alerts that crossed their threshold within catchupWindowSec.
 */
export function findDueAlerts(
  bosses,
  settings,
  nowMs,
  firedAlertKeys,
  catchupWindowSec = 20,
  serverMeta = null
) {
  const due = [];
  const windowMs = Math.max(1, catchupWindowSec) * 1000;
  const serverPrefix = serverMeta && serverMeta.id ? `${serverMeta.id}:` : '';

  for (const boss of bosses) {
    if (!boss.notifyEnabled) continue;
    const offsets = getEffectiveNotifyOffsetsSec(boss, settings);

    const targets = [];
    if (isWorldBoss(boss)) {
      const win = getWorldBossWindow(boss, nowMs);
      if (win.isActiveNow && Number.isFinite(win.windowStartMs)) {
        targets.push(win.windowStartMs);
      }
      if (Number.isFinite(win.nextStartMs)) {
        targets.push(win.nextStartMs);
      }
    } else {
      targets.push(boss.nextSpawnMs);
    }

    for (const targetSpawnMs of targets) {
      for (const offsetSec of offsets) {
        const triggerAtMs = targetSpawnMs - offsetSec * 1000;
        const elapsedMs = nowMs - triggerAtMs;
        if (elapsedMs >= 0 && elapsedMs <= windowMs) {
          const alertKey = `${serverPrefix}${boss.id}:${targetSpawnMs}:${offsetSec}`;
          if (!firedAlertKeys.has(alertKey)) {
            due.push({
              alertKey,
              serverId: serverMeta?.id || null,
              serverName: serverMeta?.name || null,
              bossId: boss.id,
              bossName: boss.name,
              bossType: boss.bossType || 'field',
              offsetSec,
              targetSpawnMs,
              triggerAtMs,
              message: formatAlertMessage(
                boss.name,
                offsetSec,
                targetSpawnMs,
                serverMeta?.name || null
              ),
            });
          }
        }
      }
    }
  }

  return due.sort((a, b) => a.triggerAtMs - b.triggerAtMs);
}

/**
 * Determine boss status relative to nowMs.
 * World boss:
 * - 'world_active': within fixed 1h appearance window -> RED card!
 * - 'upcoming': next appearance <= 30m
 * - 'scheduled': > 30m
 * - 'unscheduled': no fixed times configured
 *
 * Field boss:
 * - 'spawning_now': during kill window -> RED card!
 * - 'imminent': <= 10 minutes before spawn -> RED card!
 * - 'upcoming': <= 30 minutes before spawn
 * - 'scheduled': > 30 minutes
 * - 'overdue': passed beyond kill window
 */
export function getBossStatus(boss, nowMs = Date.now()) {
  if (isWorldBoss(boss)) {
    const win = getWorldBossWindow(boss, nowMs);
    if (win.isActiveNow) return 'world_active';
    if (!Number.isFinite(win.nextStartMs)) return 'unscheduled';
    const diffMs = win.nextStartMs - nowMs;
    if (diffMs <= 30 * 60 * 1000) return 'upcoming';
    return 'scheduled';
  }

  const diffMs = boss.nextSpawnMs - nowMs;
  const activeWindowMs = Math.max(getEffectiveKillSec(boss), 60) * 1000;

  if (diffMs <= 0) {
    if (Math.abs(diffMs) <= activeWindowMs) {
      return 'spawning_now';
    }
    return 'overdue';
  }
  if (diffMs <= FIELD_BOSS_RED_WINDOW_MS) return 'imminent';
  if (diffMs <= 30 * 60 * 1000) return 'upcoming';
  return 'scheduled';
}

/**
 * Whether the boss card should highlight RED right now:
 * - World Boss: when currently appearing (1h window)
 * - Field Boss: from 10 minutes before spawn through kill window
 */
export function isBossRedAlert(boss, nowMs = Date.now()) {
  const status = getBossStatus(boss, nowMs);
  return status === 'world_active' || status === 'spawning_now' || status === 'imminent';
}

export function sortBosses(bosses, sortBy = 'soonest', nowMs = Date.now()) {
  const copy = [...bosses];
  if (sortBy === 'name') {
    return copy.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  }
  if (sortBy === 'custom') {
    return copy;
  }

  const getRank = (status) => {
    if (status === 'world_active' || status === 'spawning_now') return 0;
    if (status === 'imminent' || status === 'upcoming' || status === 'scheduled') return 1;
    return 2; // overdue / unscheduled
  };

  return copy.sort((a, b) => {
    const statusA = getBossStatus(a, nowMs);
    const statusB = getBossStatus(b, nowMs);
    const rA = getRank(statusA);
    const rB = getRank(statusB);
    if (rA !== rB) return rA - rB;

    if (rA === 0) {
      const endA = isWorldBoss(a) ? getWorldBossWindow(a, nowMs).windowEndMs : getExpectedKillMs(a);
      const endB = isWorldBoss(b) ? getWorldBossWindow(b, nowMs).windowEndMs : getExpectedKillMs(b);
      if (endA !== endB) return (endA ?? 0) - (endB ?? 0);
      return a.name.localeCompare(b.name, 'ko');
    }

    const tA = getBossDisplaySpawnMs(a, nowMs);
    const tB = getBossDisplaySpawnMs(b, nowMs);
    if (rA === 2) {
      if (tB !== tA) return tB - tA;
      return a.name.localeCompare(b.name, 'ko');
    }
    if (tA !== tB) return tA - tB;
    return a.name.localeCompare(b.name, 'ko');
  });
}

export function pad2(n) {
  return String(Math.floor(Math.abs(n))).padStart(2, '0');
}

export function formatTimeHHMM(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function formatTimeHHMMSS(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function formatRelativeDayLabel(targetMs, nowMs = Date.now()) {
  const target = new Date(targetMs);
  const now = new Date(nowMs);
  const targetDay = new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime();
  const nowDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const diffDays = Math.round((targetDay - nowDay) / (24 * 3600 * 1000));

  if (diffDays === 0) return '오늘';
  if (diffDays === 1) return '내일';
  if (diffDays === -1) return '어제';
  return `${target.getMonth() + 1}/${target.getDate()}`;
}

export function formatDurationKorean(totalSec) {
  const sec = Math.max(0, Math.round(totalSec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}시간`);
  if (m > 0) parts.push(`${m}분`);
  if (s > 0 || parts.length === 0) parts.push(`${s}초`);
  return parts.join(' ');
}

export function formatOffsetLabel(offsetSec) {
  const sec = Math.max(0, Math.round(offsetSec));
  if (sec === 0) return '출현 정각';
  return `${formatDurationKorean(sec)} 전`;
}

export function formatCountdown(diffMs) {
  const absSec = Math.floor(Math.abs(diffMs) / 1000);
  const h = Math.floor(absSec / 3600);
  const m = Math.floor((absSec % 3600) / 60);
  const s = absSec % 60;
  const prefix = diffMs < 0 ? '+' : '';
  if (h > 0) {
    return `${prefix}${pad2(h)}:${pad2(m)}:${pad2(s)}`;
  }
  return `${prefix}${pad2(m)}:${pad2(s)}`;
}

export function formatCountdownText(diffMs) {
  const absSec = Math.round(Math.abs(diffMs) / 1000);
  if (absSec < 60) {
    return diffMs >= 0 ? `${absSec}초 후` : `${absSec}초 지남`;
  }
  const h = Math.floor(absSec / 3600);
  const m = Math.floor((absSec % 3600) / 60);
  const parts = [];
  if (h > 0) parts.push(`${h}시간`);
  if (m > 0) parts.push(`${m}분`);
  const body = parts.join(' ') || '0분';
  return diffMs >= 0 ? `${body} 후` : `${body} 지남`;
}

export function formatAlertMessage(bossName, offsetSec, targetSpawnMs, serverName = null) {
  const hhmm = formatTimeHHMM(targetSpawnMs);
  const prefix = serverName ? `[${serverName}] ` : '';
  if (offsetSec <= 0) {
    return `${prefix}${bossName} 출현 시간입니다! (${hhmm})`;
  }
  return `${prefix}${formatDurationKorean(offsetSec)} 뒤 ${bossName} 출현 예정 (${hhmm})`;
}

export function formatScheduleForShare(bosses, nowMs = Date.now(), serverName = null) {
  const sorted = sortBosses(bosses, 'soonest', nowMs);
  const title = serverName
    ? `[이클립스 · ${serverName} 보스 출현 예상 시간]`
    : `[보스 출현 예상 시간]`;
  const header = `${title} (${formatTimeHHMM(nowMs)} 기준)`;

  const lines = sorted.map((boss) => {
    const lvPrefix = boss.level ? `Lv.${boss.level} ` : '';
    if (isWorldBoss(boss)) {
      const win = getWorldBossWindow(boss, nowMs);
      const timesText = normalizeFixedTimes(boss.fixedTimes).join(', ') || '미설정';
      const durText = formatDurationKorean(getEffectiveActiveSec(boss));
      if (win.isActiveNow) {
        const remText = formatCountdownText(win.windowEndMs - nowMs).replace(/ 후$/, ' 남음');
        return `• [월드] ${lvPrefix}${boss.name} → 출현 중! (~${formatTimeHHMM(win.windowEndMs)}, ${remText}) [고정 ${timesText} · ${durText}]`;
      }
      if (Number.isFinite(win.nextStartMs)) {
        const dayLabel = formatRelativeDayLabel(win.nextStartMs, nowMs);
        const dayPrefix = dayLabel === '오늘' ? '' : `${dayLabel} `;
        const diffText = formatCountdownText(win.nextStartMs - nowMs);
        return `• [월드] ${lvPrefix}${boss.name} → ${dayPrefix}${formatTimeHHMM(win.nextStartMs)} (${diffText}) [고정 ${timesText} · ${durText}]`;
      }
      return `• [월드] ${lvPrefix}${boss.name} → 시간 미설정`;
    }

    const dayLabel = formatRelativeDayLabel(boss.nextSpawnMs, nowMs);
    const timeStr = formatTimeHHMM(boss.nextSpawnMs);
    const dayPrefix = dayLabel === '오늘' ? '' : `${dayLabel} `;
    const diffText = formatCountdownText(boss.nextSpawnMs - nowMs);
    const killText =
      boss.killDurationSec === null || boss.killDurationSec === undefined
        ? '미설정(0분)'
        : formatDurationKorean(getEffectiveKillSec(boss));
    const respawnText = formatDurationKorean(getEffectiveRespawnSec(boss));
    return `• [필드] ${lvPrefix}${boss.name} → ${dayPrefix}${timeStr} (${diffText}) [처치 ${killText} / 리스폰 ${respawnText}]`;
  });

  return [header, ...lines].join('\n');
}

function sanitizeBossArray(rawBosses, fallbackBosses, fallbackNowMs, isLegacyV1, shouldInjectWorldPresets) {
  const source = Array.isArray(rawBosses) ? rawBosses : fallbackBosses;
  const cleaned = source
    .filter((b) => b && typeof b === 'object' && typeof b.name === 'string' && b.name.trim().length > 0)
    .map((b, idx) => {
      const id = typeof b.id === 'string' && b.id.trim() ? b.id : `boss-${idx}-${Date.now()}`;
      const name = b.name.trim();
      const bossType =
        b.bossType === 'world' || b.bossType === 'field'
          ? b.bossType
          : Array.isArray(b.fixedTimes) && b.fixedTimes.length > 0
            ? 'world'
            : 'field';
      const level =
        b.level === undefined
          ? (PRESET_LEVEL_BY_ID.get(id) ?? PRESET_LEVEL_BY_NAME.get(name) ?? null)
          : normalizeBossLevel(b.level);
      const fixedTimes = bossType === 'world' ? normalizeFixedTimes(b.fixedTimes) : [];
      const activeDurationSec = Math.max(60, Math.round(Number(b.activeDurationSec) || 3600));

      const killDurationSec =
        b.killDurationSec === null || b.killDurationSec === undefined || b.killDurationSec === ''
          ? null
          : Math.max(0, Math.round(Number(b.killDurationSec) || 0));
      const respawnDurationSec = Math.max(60, Math.round(Number(b.respawnDurationSec) || 8 * 3600));
      const nextSpawnMs = Number.isFinite(Number(b.nextSpawnMs)) ? Number(b.nextSpawnMs) : fallbackNowMs;
      const anchorType = ['manual', 'spawn', 'kill'].includes(b.anchorType) ? b.anchorType : 'manual';
      const anchorTimeMs =
        anchorType !== 'manual' && Number.isFinite(Number(b.anchorTimeMs)) ? Number(b.anchorTimeMs) : null;

      return {
        id,
        bossType,
        level,
        name,
        fixedTimes,
        activeDurationSec,
        killDurationSec,
        respawnDurationSec,
        nextSpawnMs,
        anchorType,
        anchorTimeMs,
        notifyEnabled: b.notifyEnabled !== false,
        useCustomNotify: Boolean(b.useCustomNotify),
        customNotifyOffsetsSec: Array.isArray(b.customNotifyOffsetsSec)
          ? Array.from(
              new Set(
                b.customNotifyOffsetsSec
                  .map((x) => Math.round(Number(x)))
                  .filter((x) => Number.isFinite(x) && x >= 0)
              )
            ).sort((a, b) => b - a)
          : [...DEFAULT_NOTIFY_OFFSETS_SEC],
        autoRollover:
          bossType === 'world'
            ? false
            : isLegacyV1
              ? true
              : b.autoRollover === undefined
                ? true
                : Boolean(b.autoRollover),
        memo: typeof b.memo === 'string' ? b.memo : '',
        color: typeof b.color === 'string' && b.color.trim() ? b.color : '#3b82f6',
        previousState: b.previousState && typeof b.previousState === 'object' ? b.previousState : null,
      };
    });

  if (shouldInjectWorldPresets) {
    const existingIds = new Set(cleaned.map((b) => b.id));
    const existingNames = new Set(cleaned.map((b) => b.name));
    const toPrepend = createDefaultWorldBosses().filter(
      (wb) => !existingIds.has(wb.id) && !existingNames.has(wb.name)
    );
    return [...toPrepend, ...cleaned];
  }

  return cleaned;
}

function normalizeOffsetList(rawList, fallback = DEFAULT_NOTIFY_OFFSETS_SEC) {
  if (!Array.isArray(rawList)) return [...fallback];
  return Array.from(
    new Set(
      rawList
        .map((x) => Math.round(Number(x)))
        .filter((x) => Number.isFinite(x) && x >= 0)
    )
  ).sort((a, b) => b - a);
}

function sanitizeSettingsObject(rawSettings, fallbackSettings = createDefaultSettings(), isLegacyV1 = false) {
  const settings = {
    ...fallbackSettings,
    ...(rawSettings && typeof rawSettings === 'object' ? rawSettings : {}),
  };
  if (isLegacyV1) {
    settings.autoRolloverDefault = true;
  }
  if (!['all', 'world', 'field'].includes(settings.bossFilter)) {
    settings.bossFilter = 'all';
  }
  if (!['soonest', 'name', 'custom'].includes(settings.sortBy)) {
    settings.sortBy = 'soonest';
  }
  settings.groupByType = Boolean(settings.groupByType);
  settings.desktopNotifications = Boolean(settings.desktopNotifications);
  settings.soundEnabled = settings.soundEnabled !== false;
  settings.ttsEnabled = Boolean(settings.ttsEnabled);
  settings.globalNotifyOffsetsSec = normalizeOffsetList(
    settings.globalNotifyOffsetsSec,
    DEFAULT_NOTIFY_OFFSETS_SEC
  );
  settings.soundVolume = Math.min(1, Math.max(0, Number(settings.soundVolume ?? 0.7)));
  settings.serverOffsetSec = Number.isFinite(Number(settings.serverOffsetSec))
    ? Math.max(-3600, Math.min(3600, Math.round(Number(settings.serverOffsetSec))))
    : 0;
  settings.autoWednesdayReset = settings.autoWednesdayReset !== false;
  settings.maintenanceEndTime = normalizeMaintenanceTimeStr(settings.maintenanceEndTime);
  return settings;
}

function sanitizeServerTabsList(rawTabs, fallbackTabs) {
  const source = Array.isArray(rawTabs) ? rawTabs : fallbackTabs;
  const seenTabIds = new Set();
  const cleanTabs = [];
  for (const t of source) {
    const id = typeof t === 'string' ? t : t?.id;
    if (typeof id !== 'string' || !SERVER_MAP.has(id) || seenTabIds.has(id)) continue;
    seenTabIds.add(id);
    cleanTabs.push({ id, favorite: typeof t === 'object' ? Boolean(t.favorite) : false });
  }
  if (!cleanTabs.length) {
    cleanTabs.push({ id: DEFAULT_SERVER_ID, favorite: true });
  }
  return getOrderedServerTabs(cleanTabs);
}

export function sanitizeState(raw, fallbackNowMs = Date.now()) {
  const defaults = createDefaultState(fallbackNowMs);
  if (!raw || typeof raw !== 'object') return defaults;

  const versionNum = Number(raw.version || 0);
  const isLegacyV1 = !raw.version || versionNum < 2;
  const isPreMultiServer = versionNum < 3;
  const isPreWorldBoss = versionNum < 4;

  const settings = sanitizeSettingsObject(raw.settings, defaults.settings, isLegacyV1);

  const lastMaintenanceResetMs = Number.isFinite(Number(raw.lastMaintenanceResetMs))
    ? Number(raw.lastMaintenanceResetMs)
    : getMostRecentWednesdayResetMs(fallbackNowMs, settings.maintenanceEndTime);

  // Migrate v1/v2 single-server payload into v6 servers['barkadion-05']
  if (isPreMultiServer && !raw.servers) {
    const migratedBosses = sanitizeBossArray(
      raw.bosses,
      defaults.servers[DEFAULT_SERVER_ID].bosses,
      fallbackNowMs,
      isLegacyV1,
      true
    );
    const migratedLogs = Array.isArray(raw.alertLogs) ? raw.alertLogs.slice(0, 50) : [];
    return {
      version: 6,
      hasSelectedInitialServer: Array.isArray(raw.bosses),
      activeServerId: DEFAULT_SERVER_ID,
      serverTabs: [{ id: DEFAULT_SERVER_ID, favorite: true }],
      lastMaintenanceResetMs,
      settings,
      servers: {
        [DEFAULT_SERVER_ID]: {
          bosses: migratedBosses,
          alertLogs: migratedLogs,
        },
      },
    };
  }

  const orderedTabs = sanitizeServerTabsList(raw.serverTabs, defaults.serverTabs);
  const rawServers = raw.servers && typeof raw.servers === 'object' ? raw.servers : {};
  const servers = {};

  for (const tab of orderedTabs) {
    const entry = rawServers[tab.id];
    const fallbackBosses =
      tab.id === DEFAULT_SERVER_ID ? defaults.servers[DEFAULT_SERVER_ID].bosses : [];
    const hasExistingBosses = entry && Array.isArray(entry.bosses) && entry.bosses.length > 0;
    const injectWorld = isPreWorldBoss && (tab.id === DEFAULT_SERVER_ID || hasExistingBosses);

    servers[tab.id] = {
      bosses: sanitizeBossArray(
        entry && Array.isArray(entry.bosses) ? entry.bosses : fallbackBosses,
        fallbackBosses,
        fallbackNowMs,
        false,
        injectWorld
      ),
      alertLogs: entry && Array.isArray(entry.alertLogs) ? entry.alertLogs.slice(0, 50) : [],
    };
  }

  const activeServerId =
    typeof raw.activeServerId === 'string' && servers[raw.activeServerId]
      ? raw.activeServerId
      : orderedTabs[0].id;

  return {
    version: 6,
    hasSelectedInitialServer: Boolean(raw.hasSelectedInitialServer),
    activeServerId,
    serverTabs: orderedTabs,
    lastMaintenanceResetMs,
    settings,
    servers,
  };
}

export function createDefaultSharedState(referenceMs = Date.now()) {
  return {
    version: 7,
    revision: 1,
    updatedAtMs: referenceMs,
    updatedBy: '초기 설정',
    lastMaintenanceResetMs: getMostRecentWednesdayResetMs(referenceMs, '08:00'),
    maintenance: {
      autoWednesdayReset: true,
      maintenanceEndTime: '08:00',
    },
    servers: {
      [DEFAULT_SERVER_ID]: {
        bosses: createDefaultBosses(referenceMs),
      },
    },
  };
}

export function sanitizeSharedState(raw, fallbackNowMs = Date.now()) {
  const defaults = createDefaultSharedState(fallbackNowMs);
  if (!raw || typeof raw !== 'object') return defaults;

  // Support upgrading legacy full state (v1..v6) into shared v7 format cleanly
  if (raw.bosses && !raw.servers) {
    const legacy = sanitizeState(raw, fallbackNowMs);
    return sanitizeSharedState(
      {
        version: 7,
        revision: 1,
        updatedAtMs: fallbackNowMs,
        updatedBy: '백업 가져오기',
        lastMaintenanceResetMs: legacy.lastMaintenanceResetMs,
        maintenance: {
          autoWednesdayReset: legacy.settings.autoWednesdayReset,
          maintenanceEndTime: legacy.settings.maintenanceEndTime,
        },
        servers: legacy.servers,
      },
      fallbackNowMs
    );
  }

  const rawMaint =
    raw.maintenance && typeof raw.maintenance === 'object'
      ? raw.maintenance
      : raw.settings && typeof raw.settings === 'object'
        ? raw.settings
        : {};
  const maintenanceEndTime = normalizeMaintenanceTimeStr(rawMaint.maintenanceEndTime);
  const autoWednesdayReset = rawMaint.autoWednesdayReset !== false;
  const lastMaintenanceResetMs = Number.isFinite(Number(raw.lastMaintenanceResetMs))
    ? Number(raw.lastMaintenanceResetMs)
    : getMostRecentWednesdayResetMs(fallbackNowMs, maintenanceEndTime);

  const rawServers = raw.servers && typeof raw.servers === 'object' ? raw.servers : {};
  const servers = {};
  const versionNum = Number(raw.version || 0);
  const isPreWorldBoss = versionNum > 0 && versionNum < 4;

  for (const [sid, entry] of Object.entries(rawServers)) {
    if (!SERVER_MAP.has(sid) || !entry || typeof entry !== 'object') continue;
    const fallbackBosses =
      sid === DEFAULT_SERVER_ID ? defaults.servers[DEFAULT_SERVER_ID].bosses : [];
    const hasExisting = Array.isArray(entry.bosses) && entry.bosses.length > 0;
    const injectWorld = isPreWorldBoss && (sid === DEFAULT_SERVER_ID || hasExisting);
    servers[sid] = {
      bosses: sanitizeBossArray(
        Array.isArray(entry.bosses) ? entry.bosses : fallbackBosses,
        fallbackBosses,
        fallbackNowMs,
        false,
        injectWorld
      ),
    };
  }

  if (!servers[DEFAULT_SERVER_ID]) {
    servers[DEFAULT_SERVER_ID] = {
      bosses: createDefaultBosses(fallbackNowMs),
    };
  }

  const revisionRaw = Math.floor(Number(raw.revision));
  const revision = Number.isFinite(revisionRaw) && revisionRaw >= 1 ? revisionRaw : 1;
  const updatedAtMs = Number.isFinite(Number(raw.updatedAtMs))
    ? Number(raw.updatedAtMs)
    : fallbackNowMs;
  const updatedBy =
    typeof raw.updatedBy === 'string' && raw.updatedBy.trim()
      ? raw.updatedBy.trim().slice(0, 40)
      : '초기 설정';

  return {
    version: 7,
    revision,
    updatedAtMs,
    updatedBy,
    lastMaintenanceResetMs,
    maintenance: {
      autoWednesdayReset,
      maintenanceEndTime,
    },
    servers,
  };
}

export function createDefaultLocalPrefs() {
  const s = createDefaultSettings();
  return {
    version: 1,
    hasSelectedInitialServer: false,
    activeServerId: DEFAULT_SERVER_ID,
    serverTabs: [{ id: DEFAULT_SERVER_ID, favorite: true }],
    settings: {
      globalNotifyOffsetsSec: s.globalNotifyOffsetsSec,
      desktopNotifications: s.desktopNotifications,
      soundEnabled: s.soundEnabled,
      soundPreset: s.soundPreset,
      soundVolume: s.soundVolume,
      ttsEnabled: s.ttsEnabled,
      autoRolloverDefault: s.autoRolloverDefault,
      serverOffsetSec: s.serverOffsetSec,
      sortBy: s.sortBy,
      bossFilter: s.bossFilter,
      groupByType: s.groupByType,
    },
    bossNotifyOverrides: {},
    serverAlertLogs: {},
  };
}

export function sanitizeLocalPrefs(raw) {
  const defaults = createDefaultLocalPrefs();
  if (!raw || typeof raw !== 'object') return defaults;

  const cleanSettings = sanitizeSettingsObject(raw.settings, createDefaultSettings(), false);
  const {
    autoWednesdayReset: _ignoredAuto,
    maintenanceEndTime: _ignoredMaint,
    ...personalSettings
  } = cleanSettings;

  const serverTabs = sanitizeServerTabsList(raw.serverTabs, defaults.serverTabs);
  const activeServerId =
    typeof raw.activeServerId === 'string' && SERVER_MAP.has(raw.activeServerId)
      ? raw.activeServerId
      : serverTabs[0].id;

  const bossNotifyOverrides = {};
  if (raw.bossNotifyOverrides && typeof raw.bossNotifyOverrides === 'object') {
    for (const [sid, bossMap] of Object.entries(raw.bossNotifyOverrides)) {
      if (!SERVER_MAP.has(sid) || !bossMap || typeof bossMap !== 'object') continue;
      const cleanMap = {};
      for (const [bid, pref] of Object.entries(bossMap)) {
        if (!pref || typeof pref !== 'object') continue;
        cleanMap[bid] = {
          ...(typeof pref.notifyEnabled === 'boolean' ? { notifyEnabled: pref.notifyEnabled } : {}),
          ...(typeof pref.useCustomNotify === 'boolean'
            ? { useCustomNotify: pref.useCustomNotify }
            : {}),
          ...(Array.isArray(pref.customNotifyOffsetsSec)
            ? {
                customNotifyOffsetsSec: normalizeOffsetList(
                  pref.customNotifyOffsetsSec,
                  DEFAULT_NOTIFY_OFFSETS_SEC
                ),
              }
            : {}),
        };
      }
      if (Object.keys(cleanMap).length) bossNotifyOverrides[sid] = cleanMap;
    }
  }

  const serverAlertLogs = {};
  if (raw.serverAlertLogs && typeof raw.serverAlertLogs === 'object') {
    for (const [sid, logs] of Object.entries(raw.serverAlertLogs)) {
      if (!SERVER_MAP.has(sid) || !Array.isArray(logs)) continue;
      serverAlertLogs[sid] = logs.slice(0, 50);
    }
  }

  return {
    version: 1,
    hasSelectedInitialServer: Boolean(raw.hasSelectedInitialServer),
    activeServerId,
    serverTabs,
    settings: personalSettings,
    bossNotifyOverrides,
    serverAlertLogs,
  };
}

export function mergeSharedAndLocalState(sharedState, localPrefs, nowMs = Date.now()) {
  const cleanShared = sanitizeSharedState(sharedState, nowMs);
  const cleanLocal = sanitizeLocalPrefs(localPrefs);

  const orderedTabs = sanitizeServerTabsList(cleanLocal.serverTabs, [{ id: DEFAULT_SERVER_ID, favorite: true }]);
  const activeServerId = SERVER_MAP.has(cleanLocal.activeServerId)
    ? cleanLocal.activeServerId
    : orderedTabs[0].id;
  const activeTabs = orderedTabs.some((t) => t.id === activeServerId)
    ? orderedTabs
    : getOrderedServerTabs([...orderedTabs, { id: activeServerId, favorite: false }]);

  const servers = {};
  const sharedServerIds = new Set(Object.keys(cleanShared.servers));

  for (const [sid, entry] of Object.entries(cleanShared.servers)) {
    const overrides = cleanLocal.bossNotifyOverrides[sid] || {};
    servers[sid] = {
      bosses: entry.bosses.map((boss) => {
        const pref = overrides[boss.id];
        return pref ? { ...boss, ...pref } : boss;
      }),
      alertLogs: cleanLocal.serverAlertLogs[sid] ? [...cleanLocal.serverAlertLogs[sid]] : [],
    };
  }

  for (const tab of activeTabs) {
    if (!servers[tab.id]) {
      servers[tab.id] = {
        bosses: tab.id === DEFAULT_SERVER_ID ? createDefaultBosses(nowMs) : [],
        alertLogs: cleanLocal.serverAlertLogs[tab.id] ? [...cleanLocal.serverAlertLogs[tab.id]] : [],
      };
    }
  }

  return {
    version: 6,
    hasSelectedInitialServer: cleanLocal.hasSelectedInitialServer,
    activeServerId,
    serverTabs: activeTabs,
    lastMaintenanceResetMs: cleanShared.lastMaintenanceResetMs,
    settings: {
      ...cleanLocal.settings,
      autoWednesdayReset: cleanShared.maintenance.autoWednesdayReset,
      maintenanceEndTime: cleanShared.maintenance.maintenanceEndTime,
    },
    servers,
    _sharedMeta: {
      revision: cleanShared.revision,
      updatedAtMs: cleanShared.updatedAtMs,
      updatedBy: cleanShared.updatedBy,
      sharedServerIds: Array.from(sharedServerIds),
    },
  };
}

export function extractSharedStateFromAppState(appState, options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const prevShared = options.previousSharedState
    ? sanitizeSharedState(options.previousSharedState, nowMs)
    : null;
  const prevServers = prevShared?.servers || {};
  const prevSharedIds = new Set(Object.keys(prevServers));

  const servers = {};
  const appServers = appState?.servers && typeof appState.servers === 'object' ? appState.servers : {};

  for (const [sid, entry] of Object.entries(appServers)) {
    if (!SERVER_MAP.has(sid) || !entry || !Array.isArray(entry.bosses)) continue;
    // Keep server in shared store if it was already shared, has bosses, or was explicitly added
    if (!prevSharedIds.has(sid) && entry.bosses.length === 0) continue;

    const prevBossMap = new Map((prevServers[sid]?.bosses || []).map((b) => [b.id, b]));
    servers[sid] = {
      bosses: entry.bosses.map((b) => {
        const prevBoss = prevBossMap.get(b.id);
        // Preserve server's shared notify defaults unless caller explicitly saved boss detail settings
        if (prevBoss && options.preserveBossNotifyDefaults) {
          return {
            ...b,
            notifyEnabled: prevBoss.notifyEnabled,
            useCustomNotify: prevBoss.useCustomNotify,
            customNotifyOffsetsSec: [...prevBoss.customNotifyOffsetsSec],
          };
        }
        return { ...b };
      }),
    };
  }

  return sanitizeSharedState(
    {
      version: 7,
      revision: prevShared?.revision || appState?._sharedMeta?.revision || 1,
      updatedAtMs: options.updatedAtMs ?? appState?._sharedMeta?.updatedAtMs ?? nowMs,
      updatedBy: options.updatedBy ?? appState?._sharedMeta?.updatedBy ?? '편집자',
      lastMaintenanceResetMs: appState?.lastMaintenanceResetMs,
      maintenance: {
        autoWednesdayReset: appState?.settings?.autoWednesdayReset !== false,
        maintenanceEndTime: appState?.settings?.maintenanceEndTime || '08:00',
      },
      servers,
    },
    nowMs
  );
}
