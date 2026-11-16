import {
  DEFAULT_NOTIFY_OFFSETS_SEC,
  DEFAULT_SERVER_ID,
  SERVER_WORLD_GROUPS,
  ALL_SERVERS,
  getServerMeta,
  getOrderedServerTabs,
  toggleServerFavorite,
  moveServerTab,
  getActiveServerData,
  addOrSelectServer,
  removeServerTab,
  createDefaultState,
  createDefaultBosses,
  isWorldBoss,
  isBossRedAlert,
  normalizeBossLevel,
  normalizeFixedTimes,
  getEffectiveActiveSec,
  getWorldBossWindow,
  getBossDisplaySpawnMs,
  getEffectiveKillSec,
  getEffectiveRespawnSec,
  getExpectedKillMs,
  getAfterNextSpawnMs,
  recomputeBossTarget,
  advanceBossCycle,
  setBossTimeByMode,
  undoBossTimeChange,
  applyAutoRollover,
  getEffectiveNotifyOffsetsSec,
  findDueAlerts,
  getBossStatus,
  sortBosses,
  pad2,
  formatTimeHHMM,
  formatTimeHHMMSS,
  formatRelativeDayLabel,
  formatDurationKorean,
  formatOffsetLabel,
  formatCountdown,
  formatCountdownText,
  formatScheduleForShare,
  parseTimeString,
  buildTimestampOnDay,
  normalizeMaintenanceTimeStr,
  getMostRecentWednesdayResetMs,
  getNextWednesdayResetMs,
  parseMaintenanceEndTimeFromText,
  resetFieldBossesForMaintenance,
  applyManualMaintenanceReset,
  applyScheduledWednesdayReset,
  createDefaultSharedState,
  createDefaultLocalPrefs,
  sanitizeSharedState,
  sanitizeLocalPrefs,
  mergeSharedAndLocalState,
  extractSharedStateFromAppState,
} from './calculator.js';
import {
  loadAuthSession,
  saveAuthSession,
  clearAuthSession,
  consumeInviteCodeFromUrl,
  getLegacyLocalBackup,
  loadLocalPrefs,
  saveLocalPrefs,
  fetchSharedBootstrap,
  saveSharedStateRemote,
  fetchAuthStatus,
  postAuthAction,
} from './storage.js';
import {
  unlockAudioOnGesture,
  playAlertSound,
  getNotificationPermission,
  requestNotificationPermission,
  sendDesktopNotification,
  speakKoreanAlert,
} from './notifier.js';
import {
  renderScheduleCanvas,
  canvasToPngBlob,
  copyPngBlobToClipboard,
} from './schedule-image.js';

let sharedState = createDefaultSharedState(Date.now());
let localPrefs = createDefaultLocalPrefs();
let appState = mergeSharedAndLocalState(sharedState, localPrefs, Date.now());
let apiAvailable = false;
let authState = {
  configured: false,
  envHostLocked: false,
  role: 'viewer',
  label: null,
  revoked: false,
  editors: [],
};
const firedAlertKeys = new Set();
let tickWorker = null;
let fallbackIntervalId = null;
let syncIntervalId = null;
let lastSyncFetchMs = 0;
let isSavingShared = false;
let editingBossCustomOffsets = [];
let editingWorldFixedTimes = [];
let currentSpotlightKey = '';
let currentRenderedOrderKey = '';
let latestScheduleBlob = null;
let latestScheduleUrl = '';
let selectedWorldFilter = 'all';

const $ = (id) => document.getElementById(id);

function canEditShared() {
  return !apiAvailable || authState.role === 'host' || authState.role === 'editor';
}

function requireEditPermissionToast() {
  showToast(
    '보기 전용 모드',
    '상단 [🔑 호스트/권한] 버튼을 눌러 호스트 비밀번호 또는 편집 코드를 입력해 주세요.',
    true
  );
}

function syncLocalPrefsFromAppState() {
  const {
    autoWednesdayReset: _ignoredAuto,
    maintenanceEndTime: _ignoredMaint,
    ...personalSettings
  } = appState.settings;
  const serverAlertLogs = {};
  for (const [sid, entry] of Object.entries(appState.servers || {})) {
    if (Array.isArray(entry?.alertLogs) && entry.alertLogs.length > 0) {
      serverAlertLogs[sid] = entry.alertLogs.slice(0, 50);
    }
  }
  localPrefs = sanitizeLocalPrefs({
    ...localPrefs,
    hasSelectedInitialServer: appState.hasSelectedInitialServer,
    activeServerId: appState.activeServerId,
    serverTabs: appState.serverTabs,
    settings: personalSettings,
    serverAlertLogs,
  });
  saveLocalPrefs(localPrefs);
}

function persistLocalOnly() {
  syncLocalPrefsFromAppState();
}

function isEditingModalOrInlineOpen() {
  const active = document.activeElement;
  if (active && active.hasAttribute && active.hasAttribute('data-inline-param')) {
    return true;
  }
  return ['modal-boss', 'modal-quick-time', 'modal-maintenance'].some(
    (id) => !$(id).classList.contains('hidden')
  );
}

async function persistSharedChange(options = {}) {
  syncLocalPrefsFromAppState();

  const nowMs = getNowMs();
  const nextShared = extractSharedStateFromAppState(appState, {
    previousSharedState: sharedState,
    nowMs,
    preserveBossNotifyDefaults: Boolean(options.preserveBossNotifyDefaults),
    updatedBy: authState.label || '로컬',
  });

  if (!apiAvailable) {
    sharedState = nextShared;
    await saveSharedStateRemote(nextShared, nextShared.revision);
    updateAuthAndSyncUI();
    return true;
  }

  if (!canEditShared()) {
    if (!options.silent) requireEditPermissionToast();
    return false;
  }

  isSavingShared = true;
  try {
    const res = await saveSharedStateRemote(nextShared, sharedState.revision, {
      force: Boolean(options.force),
    });

    if (res.ok && res.sharedState) {
      sharedState = res.sharedState;
      appState = mergeSharedAndLocalState(sharedState, localPrefs, getNowMs());
      updateAuthAndSyncUI();
      return true;
    }

    if (res.conflict && res.latestState) {
      sharedState = res.latestState;
      appState = mergeSharedAndLocalState(sharedState, localPrefs, getNowMs());
      applyScheduledWednesdayResetInMemory(getNowMs());
      rolloverAllBosses(getNowMs(), false);
      currentSpotlightKey = '';
      renderServerTabs();
      renderGlobalNotifyControls();
      renderBossList();
      updateAuthAndSyncUI();
      if (!options.silent) {
        showToast('동기화 충돌', res.message || '다른 권한자의 최신 변경을 불러왔습니다.', true);
      }
      return false;
    }

    if (res.unauthorized) {
      clearAuthSession();
      authState = {
        ...authState,
        role: 'viewer',
        label: null,
        revoked: Boolean(res.revoked),
        editors: [],
      };
      if (!options.silent) {
        showToast(
          res.revoked ? '편집 권한 회수됨' : '인증 필요',
          res.message || '수정 권한이 없어 보기 전용으로 전환됩니다.',
          true
        );
      }
      await refreshFromServer(true);
      updateAuthAndSyncUI();
      renderBossList();
      return false;
    }

    if (!options.silent) {
      showToast('저장 실패', res.message || '공용 서버 저장에 실패했습니다.', true);
    }
    return false;
  } finally {
    isSavingShared = false;
  }
}

async function refreshFromServer(silent = false) {
  if (isSavingShared) return;
  lastSyncFetchMs = Date.now();
  const prevRev = sharedState.revision;
  const prevRole = authState.role;
  const prevConfigured = authState.configured;

  const boot = await fetchSharedBootstrap();
  apiAvailable = boot.apiAvailable;
  if (!apiAvailable) {
    if (!silent) {
      showToast('오프라인 상태', '서버에 연결할 수 없어 로컬 캐시를 표시 중입니다.', true);
    }
    updateAuthAndSyncUI();
    return;
  }

  const nextShared = boot.sharedState;
  const nextAuth = boot.auth;

  if (nextAuth.revoked && prevRole !== 'viewer') {
    showToast('편집 권한 회수됨', '호스트가 권한을 회수하여 보기 전용 모드로 전환되었습니다.', true);
  }

  authState = {
    ...authState,
    configured: Boolean(nextAuth.configured),
    envHostLocked: Boolean(nextAuth.envHostLocked),
    role: nextAuth.role || 'viewer',
    label: nextAuth.label || null,
    revoked: Boolean(nextAuth.revoked),
    ...(nextAuth.role !== 'host' ? { editors: [] } : {}),
  };

  if (silent && isEditingModalOrInlineOpen() && nextShared.revision !== prevRev) {
    // Avoid disrupting user mid-edit; apply after modal closes / next refresh
    updateAuthAndSyncUI();
    return;
  }

  const changed = nextShared.revision !== prevRev || authState.role !== prevRole || authState.configured !== prevConfigured;
  sharedState = nextShared;

  if (changed || !silent) {
    const nowMs = getNowMs();
    appState = mergeSharedAndLocalState(sharedState, localPrefs, nowMs);
    applyScheduledWednesdayResetInMemory(nowMs);
    rolloverAllBosses(nowMs, false);
    currentSpotlightKey = '';
    renderServerTabs();
    renderGlobalNotifyControls();
    renderBossList();
    updateAuthAndSyncUI();
    updateTickDisplays(nowMs);
  }

  if (!silent) {
    showToast(
      '동기화 완료',
      `${sharedState.updatedBy || '공용'} 시간표(v${sharedState.revision})를 불러왔습니다.`
    );
  }
}

function applyScheduledWednesdayResetInMemory(nowMs) {
  const res = applyScheduledWednesdayReset(appState, nowMs);
  if (res.didReset) {
    appState = res.state;
  }
  return res.didReset;
}

function updateAuthAndSyncUI() {
  const editable = canEditShared();
  const shell = document.querySelector('.app-shell');
  if (shell) shell.classList.toggle('is-view-only', !editable);

  const roleBadge = $('sync-role-badge');
  const metaBadge = $('sync-meta-badge');
  const btnAuth = $('btn-open-auth');
  const btnRefresh = $('btn-sync-refresh');

  if (!apiAvailable) {
    roleBadge.textContent = '로컬 단독 모드';
    roleBadge.className = 'pill pill-muted';
    metaBadge.classList.add('hidden');
    btnAuth.textContent = '🔑 로컬 모드';
    btnAuth.className = 'btn btn-ghost btn-sm';
    btnAuth.disabled = true;
    btnRefresh.classList.add('hidden');
  } else {
    btnAuth.disabled = false;
    btnRefresh.classList.remove('hidden');

    if (authState.role === 'host') {
      roleBadge.textContent = '👑 메인 호스트';
      roleBadge.className = 'pill pill-amber';
      btnAuth.textContent = '👑 권한 관리';
      btnAuth.className = 'btn btn-warning btn-sm';
    } else if (authState.role === 'editor') {
      roleBadge.textContent = `🔑 편집자 · ${authState.label || '권한자'}`;
      roleBadge.className = 'pill pill-green';
      btnAuth.textContent = `🔑 ${authState.label || '편집자'}`;
      btnAuth.className = 'btn btn-success btn-sm';
    } else {
      roleBadge.textContent = authState.configured ? '👀 보기 전용' : '⚠️ 호스트 미설정';
      roleBadge.className = authState.configured ? 'pill pill-blue' : 'pill pill-amber';
      btnAuth.textContent = authState.configured ? '🔑 호스트/권한' : '👑 호스트 초기 설정';
      btnAuth.className = authState.configured ? 'btn btn-secondary btn-sm' : 'btn btn-warning btn-sm';
    }

    if (sharedState.updatedBy && Number.isFinite(sharedState.updatedAtMs)) {
      metaBadge.textContent = `최근 수정: ${sharedState.updatedBy} · ${formatTimeHHMM(sharedState.updatedAtMs)}`;
      metaBadge.classList.remove('hidden');
    } else {
      metaBadge.classList.add('hidden');
    }
  }

  $('btn-open-maintenance').disabled = !editable;
  $('btn-add-boss').disabled = !editable;
  $('btn-reset-defaults').disabled = !editable;
  $('inp-import-json').disabled = !editable;
  $('lbl-import-json').classList.toggle('is-disabled', !editable);

  const legacyBox = $('settings-legacy-upload-box');
  if (legacyBox) {
    const showLegacy = apiAvailable && authState.role === 'host' && Boolean(getLegacyLocalBackup());
    legacyBox.classList.toggle('hidden', !showLegacy);
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function getNowMs() {
  return Date.now() + (appState.settings.serverOffsetSec || 0) * 1000;
}

function getActiveBosses() {
  return getActiveServerData(appState).bosses;
}

function setActiveBosses(nextBosses) {
  const sid = appState.activeServerId || DEFAULT_SERVER_ID;
  const current = appState.servers[sid] || { bosses: [], alertLogs: [] };
  appState.servers[sid] = { ...current, bosses: nextBosses };
}

function getActiveLogs() {
  return getActiveServerData(appState).alertLogs;
}

function setActiveLogs(nextLogs) {
  const sid = appState.activeServerId || DEFAULT_SERVER_ID;
  const current = appState.servers[sid] || { bosses: [], alertLogs: [] };
  appState.servers[sid] = { ...current, alertLogs: nextLogs };
}

function formatFullClock(ms) {
  const d = new Date(ms);
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} (${days[d.getDay()]}) ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function showToast(title, body, urgent = false) {
  const container = $('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${urgent ? 'toast-urgent' : ''}`;
  el.innerHTML = `
    <div>
      <div class="toast-title">${escapeHtml(title)}</div>
      <div class="toast-body">${escapeHtml(body)}</div>
    </div>
    <button class="toast-close" type="button" aria-label="닫기">✕</button>
  `;
  const remove = () => {
    if (el.parentNode) el.parentNode.removeChild(el);
  };
  el.querySelector('.toast-close').addEventListener('click', remove);
  container.appendChild(el);
  setTimeout(remove, 9000);
}

function getStatusBadgeInfo(status, world = false) {
  switch (status) {
    case 'world_active':
      return { text: '출현 중! (1시간)', cls: 'pill-red' };
    case 'spawning_now':
      return { text: '출현 중!', cls: 'pill-red' };
    case 'imminent':
      return { text: '10분 이내 임박', cls: 'pill-red' };
    case 'upcoming':
      return { text: '30분 이내', cls: 'pill-blue' };
    case 'overdue':
      return { text: '출현 지남', cls: 'pill-muted' };
    case 'unscheduled':
      return { text: '시간 미설정', cls: 'pill-muted' };
    default:
      return { text: world ? '고정 대기' : '대기 중', cls: 'pill-muted' };
  }
}

function getAnchorLabel(boss) {
  if (boss.anchorType === 'spawn' && Number.isFinite(boss.anchorTimeMs)) {
    return `이전 출현 ${formatTimeHHMM(boss.anchorTimeMs)} 기준`;
  }
  if (boss.anchorType === 'kill' && Number.isFinite(boss.anchorTimeMs)) {
    return `이전 처치 ${formatTimeHHMM(boss.anchorTimeMs)} 기준`;
  }
  return '직접 지정';
}

function computeProgressPercent(boss, nowMs) {
  if (isWorldBoss(boss)) {
    const win = getWorldBossWindow(boss, nowMs);
    if (win.isActiveNow && Number.isFinite(win.windowStartMs) && Number.isFinite(win.windowEndMs)) {
      const total = win.windowEndMs - win.windowStartMs;
      const elapsed = nowMs - win.windowStartMs;
      return Math.max(0, Math.min(100, Math.round((elapsed / Math.max(1, total)) * 100)));
    }
    if (!Number.isFinite(win.nextStartMs)) return 0;
    const windowSpan = 12 * 3600 * 1000;
    const remaining = win.nextStartMs - nowMs;
    const ratio = 1 - Math.min(1, remaining / windowSpan);
    return Math.max(0, Math.min(100, Math.round(ratio * 100)));
  }

  const respawnMs = getEffectiveRespawnSec(boss) * 1000;
  const remainingMs = boss.nextSpawnMs - nowMs;
  if (remainingMs <= 0) return 100;
  const ratio = 1 - Math.min(1, remainingMs / respawnMs);
  return Math.max(0, Math.min(100, Math.round(ratio * 100)));
}

function updatePermissionButton() {
  const btn = $('btn-notify-perm');
  const perm = getNotificationPermission();
  if (perm === 'granted') {
    btn.textContent = '🔔 데스크톱 알림 허용됨 (테스트)';
    btn.className = 'btn btn-success';
  } else if (perm === 'denied') {
    btn.textContent = '🔕 브라우저 알림 차단됨';
    btn.className = 'btn btn-danger';
  } else if (perm === 'unsupported') {
    btn.textContent = '알림 미지원 브라우저';
    btn.className = 'btn btn-ghost';
  } else {
    btn.textContent = '🔔 데스크톱 알림 허용하기';
    btn.className = 'btn btn-warning';
  }
}

function renderServerTabs() {
  const ordered = getOrderedServerTabs(appState.serverTabs);
  appState.serverTabs = ordered;
  const activeId = appState.activeServerId;
  const activeMeta = getServerMeta(activeId);

  $('active-server-pill').textContent = activeMeta.name;

  const listEl = $('server-tabs-list');
  listEl.innerHTML = ordered
    .map((tab) => {
      const meta = getServerMeta(tab.id);
      const isActive = tab.id === activeId;
      const bossCount = appState.servers[tab.id]?.bosses?.length ?? 0;
      const canRemove = ordered.length > 1;
      return `
        <div class="server-tab ${isActive ? 'active' : ''}" data-server-tab="${escapeHtml(tab.id)}">
          <button
            type="button"
            class="tab-star-btn ${tab.favorite ? 'is-fav' : ''}"
            data-server-action="toggle-fav"
            data-server-id="${escapeHtml(tab.id)}"
            title="${tab.favorite ? '즐겨찾기 해제' : '즐겨찾기 고정 (우선 표시)'}"
          >${tab.favorite ? '★' : '☆'}</button>
          <button
            type="button"
            class="tab-select-btn"
            data-server-action="select"
            data-server-id="${escapeHtml(tab.id)}"
          >
            <span>${escapeHtml(meta.name)}</span>
            <span class="tab-count">${bossCount}</span>
          </button>
          ${
            canRemove
              ? `<button type="button" class="tab-remove-btn" data-server-action="remove" data-server-id="${escapeHtml(tab.id)}" title="탭 제거">✕</button>`
              : ''
          }
        </div>
      `;
    })
    .join('');

  const activeIdx = ordered.findIndex((t) => t.id === activeId);
  const canMoveLeft =
    activeIdx > 0 && ordered[activeIdx].favorite === ordered[activeIdx - 1].favorite;
  const canMoveRight =
    activeIdx !== -1 &&
    activeIdx < ordered.length - 1 &&
    ordered[activeIdx].favorite === ordered[activeIdx + 1].favorite;

  $('btn-move-tab-left').disabled = !canMoveLeft;
  $('btn-move-tab-right').disabled = !canMoveRight;
}

function selectServer(serverId, seedMode = 'auto') {
  const nowMs = getNowMs();
  const existedOnServer = Boolean(sharedState.servers?.[serverId]);
  appState = addOrSelectServer(appState, serverId, seedMode, nowMs);
  rolloverAllBosses(nowMs, false);
  currentSpotlightKey = '';
  persistLocalOnly();
  if (!existedOnServer && canEditShared() && (appState.servers?.[serverId]?.bosses?.length || 0) > 0) {
    persistSharedChange({ silent: true, preserveBossNotifyDefaults: true });
  }
  renderServerTabs();
  renderBossList();
  renderAlertLogs();
  updateTickDisplays(nowMs);
}

function renderServerPickerModal() {
  const orderedTabs = getOrderedServerTabs(appState.serverTabs);
  const tabMap = new Map(orderedTabs.map((t) => [t.id, t]));
  const activeId = appState.activeServerId;

  const bark5Meta = getServerMeta(DEFAULT_SERVER_ID);
  const bark5Tab = tabMap.get(DEFAULT_SERVER_ID);
  const isBark5Active = activeId === DEFAULT_SERVER_ID && appState.hasSelectedInitialServer;

  $('server-picker-featured').innerHTML = `
    <div class="featured-server-info">
      <div class="featured-server-title">
        <span>${escapeHtml(bark5Meta.name)}</span>
        <span class="pill pill-green">월드 2종 · 필드 5종 기본 포함</span>
        ${bark5Tab?.favorite ? '<span class="pill pill-amber">★ 즐겨찾기</span>' : ''}
      </div>
      <div class="featured-server-sub">
        월드 보스(크라카, 에버하르트) 및 필드 보스(레마넌트 외 4종)가 미리 등록되어 있습니다.
      </div>
    </div>
    <button
      type="button"
      class="btn btn-primary btn-sm"
      data-picker-select="${DEFAULT_SERVER_ID}"
    >${isBark5Active ? '현재 사용 중인 서버' : `${escapeHtml(bark5Meta.name)} 선택하기`}</button>
  `;

  const filters = [
    { id: 'all', name: '전체 (36)' },
    ...SERVER_WORLD_GROUPS.map((w) => ({ id: w.id, name: w.name })),
  ];
  $('server-world-filters').innerHTML = filters
    .map(
      (f) => `
      <button
        type="button"
        class="world-pill ${selectedWorldFilter === f.id ? 'active' : ''}"
        data-world-filter="${escapeHtml(f.id)}"
      >${escapeHtml(f.name)}</button>
    `
    )
    .join('');

  const groups =
    selectedWorldFilter === 'all'
      ? SERVER_WORLD_GROUPS
      : SERVER_WORLD_GROUPS.filter((w) => w.id === selectedWorldFilter);

  $('server-picker-grid').innerHTML = groups
    .map((world) => {
      const channels = ALL_SERVERS.filter((s) => s.worldId === world.id);
      return `
        <div class="server-world-group">
          <div class="server-world-title">${escapeHtml(world.name)} (01 ~ 06)</div>
          <div class="server-channel-grid">
            ${channels
              .map((srv) => {
                const tab = tabMap.get(srv.id);
                const isAdded = Boolean(tab);
                const isActive = srv.id === activeId && appState.hasSelectedInitialServer;
                const isSharedServer = Boolean(sharedState.servers?.[srv.id]?.bosses?.length);
                return `
                  <div class="server-chip-card ${isActive ? 'is-active' : isAdded ? 'is-added' : ''}">
                    <button
                      type="button"
                      class="tab-star-btn ${tab?.favorite ? 'is-fav' : ''}"
                      data-picker-fav="${escapeHtml(srv.id)}"
                      title="즐겨찾기 토글"
                    >${tab?.favorite ? '★' : '☆'}</button>
                    <button
                      type="button"
                      class="server-chip-name-btn"
                      data-picker-select="${escapeHtml(srv.id)}"
                    >${escapeHtml(srv.name)}</button>
                    ${
                      srv.hasPreset
                        ? '<span class="pill pill-green" title="기본 보스 포함">기본</span>'
                        : isSharedServer
                          ? '<span class="pill pill-blue" title="공용 보스 시간표 등록됨">공유됨</span>'
                          : ''
                    }
                  </div>
                `;
              })
              .join('')}
          </div>
        </div>
      `;
    })
    .join('');
}

function openServerPickerModal(isInitialPrompt = false) {
  $('server-picker-title').textContent = isInitialPrompt
    ? '이클립스: 더 어웨이크닝 · 접속할 서버 선택'
    : '서버 선택 및 즐겨찾기 관리';
  $('server-picker-sub').textContent = isInitialPrompt
    ? '테스트용으로 바르카디온 05 서버가 준비되어 있습니다. 선택한 서버가 다음 접속 시 기본 서버로 열립니다.'
    : '클릭한 서버가 기본 접속 서버로 저장되며, ★ 즐겨찾기로 탭 우선순위를 정할 수 있습니다.';
  renderServerPickerModal();
  openModal('modal-server-picker');
}

function renderGlobalNotifyControls() {
  const s = appState.settings;
  $('chk-desktop-notify').checked = Boolean(s.desktopNotifications);
  $('chk-sound-notify').checked = Boolean(s.soundEnabled);
  $('sel-sound-preset').value = s.soundPreset || 'chime';
  $('rng-sound-volume').value = String(s.soundVolume ?? 0.7);
  $('chk-tts-notify').checked = Boolean(s.ttsEnabled);
  $('sel-sort-by').value = s.sortBy || 'soonest';
  $('chk-group-by-type').checked = Boolean(s.groupByType);

  document.querySelectorAll('#boss-filter-pills [data-boss-filter]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.bossFilter === (s.bossFilter || 'all'));
  });

  const offsetSec = s.serverOffsetSec || 0;
  const offsetBadge = $('clock-offset-badge');
  if (offsetSec !== 0) {
    offsetBadge.textContent = `서버 보정 ${offsetSec > 0 ? '+' : ''}${offsetSec}초`;
    offsetBadge.classList.remove('hidden');
  } else {
    offsetBadge.classList.add('hidden');
  }

  const maintBadge = $('maint-next-badge');
  const maintTimeStr = normalizeMaintenanceTimeStr(s.maintenanceEndTime);
  if (s.autoWednesdayReset) {
    const nextWedMs = getNextWednesdayResetMs(getNowMs(), maintTimeStr);
    const d = new Date(nextWedMs);
    maintBadge.textContent = `수요일 ${maintTimeStr} 자동 리셋 (다음 ${d.getMonth() + 1}/${d.getDate()})`;
    maintBadge.className = 'pill pill-blue';
  } else {
    maintBadge.textContent = `수요일 자동 리셋 꺼짐`;
    maintBadge.className = 'pill pill-muted';
  }

  const chipsEl = $('global-offset-chips');
  if (!s.globalNotifyOffsetsSec.length) {
    chipsEl.innerHTML = `<span class="empty-muted">설정된 공통 알림 시간이 없습니다.</span>`;
    return;
  }

  chipsEl.innerHTML = s.globalNotifyOffsetsSec
    .map(
      (sec) => `
      <span class="offset-chip">
        <span>${escapeHtml(formatOffsetLabel(sec))}</span>
        <button type="button" data-remove-global-offset="${sec}" title="삭제">✕</button>
      </span>
    `
    )
    .join('');
}

function findSpotlightBoss(nowMs) {
  const bosses = getActiveBosses();
  if (!bosses.length) return null;
  const sorted = sortBosses(bosses, 'soonest', nowMs);
  return sorted[0] || null;
}

function getCountdownDisplayForBoss(boss, nowMs) {
  if (isWorldBoss(boss)) {
    const win = getWorldBossWindow(boss, nowMs);
    if (win.isActiveNow && Number.isFinite(win.windowEndMs)) {
      const remMs = win.windowEndMs - nowMs;
      return {
        countdown: formatCountdown(remMs),
        sub: `출현 종료까지 ${formatCountdownText(remMs).replace(/ 후$/, ' 남음')}`,
      };
    }
    if (Number.isFinite(win.nextStartMs)) {
      const diffMs = win.nextStartMs - nowMs;
      return {
        countdown: formatCountdown(diffMs),
        sub: formatCountdownText(diffMs),
      };
    }
    return { countdown: '--:--', sub: '고정 시간 없음' };
  }

  const diffMs = boss.nextSpawnMs - nowMs;
  return {
    countdown: formatCountdown(diffMs),
    sub: formatCountdownText(diffMs),
  };
}

function renderSpotlight(nowMs, force = false) {
  const spotEl = $('spotlight-section');
  const activeMeta = getServerMeta(appState.activeServerId);
  const boss = findSpotlightBoss(nowMs);
  if (!boss) {
    const emptyKey = `empty:${activeMeta.id}`;
    if (!force && currentSpotlightKey === emptyKey) return;
    currentSpotlightKey = emptyKey;
    spotEl.className = 'spotlight-card';
    spotEl.style.removeProperty('--spot-accent');
    spotEl.innerHTML = `
      <div class="spotlight-left">
        <div class="spotlight-kicker">${escapeHtml(activeMeta.name)} · 다음 출현 예정 보스</div>
        <div class="spotlight-name">등록된 보스가 없습니다</div>
        <div class="spotlight-sub">우측 상단의 '+ 보스 추가' 버튼으로 ${escapeHtml(activeMeta.name)} 서버 보스를 등록하세요.</div>
      </div>
    `;
    return;
  }

  const world = isWorldBoss(boss);
  const status = getBossStatus(boss, nowMs);
  const isRed = isBossRedAlert(boss, nowMs);
  const targetMs = getBossDisplaySpawnMs(boss, nowMs);
  const editable = canEditShared();
  const disAttr = editable ? '' : 'disabled';
  const key = `${editable ? '1' : '0'}:${activeMeta.id}:${boss.id}:${boss.bossType}:${boss.level || ''}:${targetMs}:${status}:${boss.killDurationSec}:${boss.respawnDurationSec}`;

  const cdDisplay = getCountdownDisplayForBoss(boss, nowMs);
  if (!force && key === currentSpotlightKey) {
    const cdVal = spotEl.querySelector('[data-spot-countdown]');
    const cdText = spotEl.querySelector('[data-spot-countdown-text]');
    if (cdVal) cdVal.textContent = cdDisplay.countdown;
    if (cdText) cdText.textContent = cdDisplay.sub;
    return;
  }

  currentSpotlightKey = key;
  spotEl.className = `spotlight-card ${isRed ? 'is-red-alert' : ''}`;
  spotEl.style.setProperty('--spot-accent', isRed ? '#ef4444' : boss.color || '#3b82f6');

  const badge = getStatusBadgeInfo(status, world);
  const typeTag = world
    ? `<span class="pill type-badge-world">월드 보스</span>`
    : `<span class="pill type-badge-field">필드 보스</span>`;

  let subHtml = '';
  let actionsHtml = '';

  if (world) {
    const win = getWorldBossWindow(boss, nowMs);
    const timesStr = normalizeFixedTimes(boss.fixedTimes).join(', ') || '미설정';
    const durStr = formatDurationKorean(getEffectiveActiveSec(boss));
    if (win.isActiveNow) {
      subHtml = `현재 출현 중: <strong>${formatTimeHHMM(win.windowStartMs)} ~ ${formatTimeHHMM(win.windowEndMs)}</strong> (${escapeHtml(durStr)}) · 다음 고정 ${Number.isFinite(win.nextStartMs) ? `${escapeHtml(formatRelativeDayLabel(win.nextStartMs, nowMs))} ${formatTimeHHMM(win.nextStartMs)}` : escapeHtml(timesStr)}`;
    } else if (Number.isFinite(win.nextStartMs)) {
      const dayLbl = formatRelativeDayLabel(win.nextStartMs, nowMs);
      subHtml = `고정 출현: <strong>${escapeHtml(dayLbl)} ${formatTimeHHMM(win.nextStartMs)}</strong> · 출현 유지 ${escapeHtml(durStr)} (일정: ${escapeHtml(timesStr)})`;
    } else {
      subHtml = `고정 출현 시간을 설정해 주세요.`;
    }
    actionsHtml = `
      <button class="btn btn-secondary btn-sm" type="button" data-action="edit-boss" data-shared-edit data-boss-id="${escapeHtml(boss.id)}" ${disAttr}>
        시간 설정
      </button>
    `;
  } else {
    const dayLabel = formatRelativeDayLabel(boss.nextSpawnMs, nowMs);
    const afterNextMs = getAfterNextSpawnMs(boss, nowMs);
    const afterDay = formatRelativeDayLabel(afterNextMs, nowMs);
    const respawnLabel = formatDurationKorean(getEffectiveRespawnSec(boss));
    subHtml = `
      출현 예정: <strong>${escapeHtml(dayLabel)} ${formatTimeHHMMSS(boss.nextSpawnMs)}</strong>
      · 예상 처치 ${formatTimeHHMM(getExpectedKillMs(boss))}
      · 이후 다음 젠 ${escapeHtml(afterDay)} ${formatTimeHHMM(afterNextMs)}
    `;
    actionsHtml = `
      <button class="btn btn-primary btn-sm" type="button" data-action="expected-cut" data-shared-edit data-boss-id="${escapeHtml(boss.id)}" ${disAttr}>
        예상 컷 (→ ${formatTimeHHMM(afterNextMs)})
      </button>
      <button class="btn btn-success btn-sm" type="button" data-action="killed-now" data-shared-edit data-boss-id="${escapeHtml(boss.id)}" ${disAttr}>
        지금 컷! (+${escapeHtml(respawnLabel)})
      </button>
    `;
  }

  spotEl.innerHTML = `
    <div class="spotlight-left">
      <div class="spotlight-kicker">
        <span>${escapeHtml(activeMeta.name)} · 가장 가까운 출현 보스</span>
        ${typeTag}
        <span class="pill ${badge.cls}">${escapeHtml(badge.text)}</span>
      </div>
      <div class="spotlight-name">
        <span class="boss-dot" style="background:${escapeHtml(boss.color || '#3b82f6')}"></span>
        ${boss.level ? `<span class="boss-lv" style="font-size:16px;">Lv.${boss.level}</span>` : ''}
        <span>${escapeHtml(boss.name)}</span>
      </div>
      <div class="spotlight-sub">${subHtml}</div>
    </div>
    <div class="spotlight-right">
      <div class="spotlight-timer-box">
        <div class="spotlight-countdown" data-spot-countdown>${cdDisplay.countdown}</div>
        <div class="spotlight-countdown-text" data-spot-countdown-text>${escapeHtml(cdDisplay.sub)}</div>
      </div>
      <div class="spotlight-actions">${actionsHtml}</div>
    </div>
  `;
}

function buildWorldBossCardHtml(boss, nowMs) {
  const editable = canEditShared();
  const disAttr = editable ? '' : 'disabled';
  const status = getBossStatus(boss, nowMs);
  const badge = getStatusBadgeInfo(status, true);
  const win = getWorldBossWindow(boss, nowMs);
  const progress = computeProgressPercent(boss, nowMs);
  const cd = getCountdownDisplayForBoss(boss, nowMs);

  const fixedTimes = normalizeFixedTimes(boss.fixedTimes);
  const activeMin = Math.max(1, Math.round(getEffectiveActiveSec(boss) / 60));

  let mainDayLabel = '고정';
  let mainSubLabel = '1시간 출현';
  let mainTimeText = '미설정';

  if (win.isActiveNow && Number.isFinite(win.windowStartMs) && Number.isFinite(win.windowEndMs)) {
    mainDayLabel = '출현 중';
    mainSubLabel = `~${formatTimeHHMM(win.windowEndMs)} 종료`;
    mainTimeText = `${formatTimeHHMM(win.windowStartMs)}`;
  } else if (Number.isFinite(win.nextStartMs)) {
    mainDayLabel = formatRelativeDayLabel(win.nextStartMs, nowMs);
    mainSubLabel = `${activeMin}분 유지`;
    mainTimeText = formatTimeHHMM(win.nextStartMs);
  }

  const effectiveOffsets = getEffectiveNotifyOffsetsSec(boss, appState.settings);
  const notifySummary = !boss.notifyEnabled
    ? '알림 꺼짐'
    : boss.useCustomNotify
      ? `개별 알림 (${effectiveOffsets.map(formatOffsetLabel).join(', ') || '없음'})`
      : `공통 알림 (${effectiveOffsets.length}개)`;

  const nextAfterStr =
    win.isActiveNow && Number.isFinite(win.nextStartMs)
      ? `다음 고정 출현: <strong>${escapeHtml(formatRelativeDayLabel(win.nextStartMs, nowMs))} ${formatTimeHHMM(win.nextStartMs)}</strong>`
      : `고정 출현 · 유지 <strong>${activeMin}분</strong>`;

  return `
    <article class="boss-card status-${status}" data-boss-card="${escapeHtml(boss.id)}">
      <div class="card-top">
        <div class="boss-title-wrap">
          <span class="boss-dot" style="background:${escapeHtml(boss.color || '#a855f7')}"></span>
          <div>
            <div class="title-row">
              <span class="pill type-badge-world">월드</span>
              ${boss.level ? `<span class="boss-lv">Lv.${boss.level}</span>` : ''}
              <h3 class="boss-name">${escapeHtml(boss.name)}</h3>
            </div>
            ${boss.memo ? `<div class="boss-memo">${escapeHtml(boss.memo)}</div>` : ''}
          </div>
        </div>
        <div class="card-top-actions">
          <span class="pill ${badge.cls}" data-status-badge>${escapeHtml(badge.text)}</span>
          <button
            type="button"
            class="icon-btn ${boss.notifyEnabled ? '' : 'muted'}"
            data-action="toggle-boss-notify"
            data-boss-id="${escapeHtml(boss.id)}"
            title="${boss.notifyEnabled ? '내 브라우저에서 이 보스 알림 끄기' : '내 브라우저에서 이 보스 알림 켜기'}"
          >${boss.notifyEnabled ? '🔔' : '🔕'}</button>
          <button
            type="button"
            class="icon-btn"
            data-action="edit-boss"
            data-shared-edit
            data-boss-id="${escapeHtml(boss.id)}"
            title="${editable ? '고정 시간 / 알림 수정' : '편집 권한 필요'}"
            ${disAttr}
          >✏️</button>
        </div>
      </div>

      <div class="card-time-row">
        <button
          type="button"
          class="spawn-target-btn"
          data-action="edit-boss"
          data-shared-edit
          data-boss-id="${escapeHtml(boss.id)}"
          title="${editable ? '클릭하여 월드 보스 고정 출현 시간 편집' : '보기 전용 모드'}"
          ${disAttr}
        >
          <div class="spawn-day">
            <span data-spawn-day>${escapeHtml(mainDayLabel)}</span>
            <span>·</span>
            <span data-anchor-label>${escapeHtml(mainSubLabel)}</span>
          </div>
          <div class="spawn-hhmm" data-spawn-hhmm>${escapeHtml(mainTimeText)}</div>
        </button>

        <div class="countdown-box">
          <div class="countdown-val" data-countdown>${cd.countdown}</div>
          <div class="countdown-sub" data-countdown-text>${escapeHtml(cd.sub)}</div>
        </div>
      </div>

      <div class="progress-track">
        <div class="progress-fill" data-progress style="width: ${progress}%"></div>
      </div>

      <div class="world-schedule-box">
        <div class="world-schedule-top">
          <span class="param-label">고정 출현 시각</span>
          <div class="param-inputs">
            <span>유지</span>
            <input
              type="number"
              min="1"
              max="720"
              value="${activeMin}"
              data-inline-param="activeMin"
              data-shared-edit
              data-boss-id="${escapeHtml(boss.id)}"
              aria-label="${escapeHtml(boss.name)} 출현 유지 분"
              ${disAttr}
            />
            <span>분</span>
          </div>
        </div>
        <div class="world-time-pills">
          ${
            fixedTimes.length
              ? fixedTimes.map((t) => `<span class="world-time-pill">${escapeHtml(t)}</span>`).join('')
              : `<span class="empty-muted">고정 시간이 없습니다. ✏️ 버튼을 눌러 추가하세요.</span>`
          }
        </div>
      </div>

      <div class="cycle-preview" data-cycle-preview>
        <span>${nextAfterStr}</span>
      </div>

      <div class="card-meta-row">
        <span class="hint-text">출현 정각부터 ${activeMin}분간 빨간 강조</span>
        <button
          type="button"
          class="link-btn"
          data-action="edit-boss"
          data-shared-edit
          data-boss-id="${escapeHtml(boss.id)}"
          ${disAttr}
        >${escapeHtml(notifySummary)}</button>
      </div>
    </article>
  `;
}

function buildFieldBossCardHtml(boss, nowMs) {
  const editable = canEditShared();
  const disAttr = editable ? '' : 'disabled';
  const status = getBossStatus(boss, nowMs);
  const badge = getStatusBadgeInfo(status, false);
  const diffMs = boss.nextSpawnMs - nowMs;
  const dayLabel = formatRelativeDayLabel(boss.nextSpawnMs, nowMs);
  const progress = computeProgressPercent(boss, nowMs);

  const isKillUnset = boss.killDurationSec === null || boss.killDurationSec === undefined;
  const killTotalSec = getEffectiveKillSec(boss);
  const killMin = isKillUnset ? '' : Math.floor(killTotalSec / 60);
  const killSec = isKillUnset ? '' : killTotalSec % 60;

  const respawnTotalSec = getEffectiveRespawnSec(boss);
  const respawnHr = Math.floor(respawnTotalSec / 3600);
  const respawnMin = Math.floor((respawnTotalSec % 3600) / 60);

  const expectedKillMs = getExpectedKillMs(boss);
  const afterNextMs = getAfterNextSpawnMs(boss, nowMs);
  const afterDay = formatRelativeDayLabel(afterNextMs, nowMs);
  const respawnLabel = formatDurationKorean(respawnTotalSec);

  const effectiveOffsets = getEffectiveNotifyOffsetsSec(boss, appState.settings);
  const notifySummary = !boss.notifyEnabled
    ? '알림 꺼짐'
    : boss.useCustomNotify
      ? `개별 알림 (${effectiveOffsets.map(formatOffsetLabel).join(', ') || '없음'})`
      : `공통 알림 (${effectiveOffsets.length}개)`;

  return `
    <article class="boss-card status-${status}" data-boss-card="${escapeHtml(boss.id)}">
      <div class="card-top">
        <div class="boss-title-wrap">
          <span class="boss-dot" style="background:${escapeHtml(boss.color || '#3b82f6')}"></span>
          <div>
            <div class="title-row">
              <span class="pill type-badge-field">필드</span>
              ${boss.level ? `<span class="boss-lv">Lv.${boss.level}</span>` : ''}
              <h3 class="boss-name">${escapeHtml(boss.name)}</h3>
            </div>
            ${boss.memo ? `<div class="boss-memo">${escapeHtml(boss.memo)}</div>` : ''}
          </div>
        </div>
        <div class="card-top-actions">
          <span class="pill ${badge.cls}" data-status-badge>${escapeHtml(badge.text)}</span>
          <button
            type="button"
            class="icon-btn ${boss.notifyEnabled ? '' : 'muted'}"
            data-action="toggle-boss-notify"
            data-boss-id="${escapeHtml(boss.id)}"
            title="${boss.notifyEnabled ? '내 브라우저에서 이 보스 알림 끄기' : '내 브라우저에서 이 보스 알림 켜기'}"
          >${boss.notifyEnabled ? '🔔' : '🔕'}</button>
          <button
            type="button"
            class="icon-btn"
            data-action="edit-boss"
            data-shared-edit
            data-boss-id="${escapeHtml(boss.id)}"
            title="${editable ? '상세 설정 / 알림 수정' : '편집 권한 필요'}"
            ${disAttr}
          >✏️</button>
        </div>
      </div>

      <div class="card-time-row">
        <button
          type="button"
          class="spawn-target-btn"
          data-action="quick-time"
          data-shared-edit
          data-boss-id="${escapeHtml(boss.id)}"
          title="${editable ? '클릭하여 출현/처치 시간 입력' : '보기 전용 모드'}"
          ${disAttr}
        >
          <div class="spawn-day">
            <span data-spawn-day>${escapeHtml(dayLabel)}</span>
            <span>·</span>
            <span data-anchor-label>${escapeHtml(getAnchorLabel(boss))}</span>
          </div>
          <div class="spawn-hhmm" data-spawn-hhmm>${formatTimeHHMM(boss.nextSpawnMs)}</div>
        </button>

        <div class="countdown-box">
          <div class="countdown-val" data-countdown>${formatCountdown(diffMs)}</div>
          <div class="countdown-sub" data-countdown-text>${escapeHtml(formatCountdownText(diffMs))}</div>
        </div>
      </div>

      <div class="progress-track">
        <div class="progress-fill" data-progress style="width: ${progress}%"></div>
      </div>

      <div class="card-params">
        <div class="param-group">
          <div class="param-label">
            <span>처치 걸리는 시간</span>
            ${isKillUnset ? `<span class="pill pill-amber" data-unset-pill>미정(0)</span>` : ''}
          </div>
          <div class="param-inputs">
            <input
              type="number"
              min="0"
              max="999"
              placeholder="미정"
              value="${killMin}"
              data-inline-param="killMin"
              data-shared-edit
              data-boss-id="${escapeHtml(boss.id)}"
              aria-label="${escapeHtml(boss.name)} 처치 소요 분"
              ${disAttr}
            />
            <span>분</span>
            <input
              type="number"
              min="0"
              max="59"
              placeholder="0"
              value="${killSec}"
              data-inline-param="killSec"
              data-shared-edit
              data-boss-id="${escapeHtml(boss.id)}"
              aria-label="${escapeHtml(boss.name)} 처치 소요 초"
              ${disAttr}
            />
            <span>초</span>
          </div>
        </div>

        <div class="param-group">
          <div class="param-label"><span>리스폰 주기</span></div>
          <div class="param-inputs">
            <input
              type="number"
              min="0"
              max="168"
              value="${respawnHr}"
              data-inline-param="respawnHr"
              data-shared-edit
              data-boss-id="${escapeHtml(boss.id)}"
              aria-label="${escapeHtml(boss.name)} 리스폰 시간"
              ${disAttr}
            />
            <span>시간</span>
            <input
              type="number"
              min="0"
              max="59"
              value="${respawnMin}"
              data-inline-param="respawnMin"
              data-shared-edit
              data-boss-id="${escapeHtml(boss.id)}"
              aria-label="${escapeHtml(boss.name)} 리스폰 분"
              ${disAttr}
            />
            <span>분</span>
          </div>
        </div>
      </div>

      <div class="cycle-preview" data-cycle-preview>
        <span>예상 처치: <strong>${formatTimeHHMM(expectedKillMs)}</strong></span>
        <span>이후 다음 젠: <strong>${escapeHtml(afterDay)} ${formatTimeHHMM(afterNextMs)}</strong></span>
      </div>

      <div class="card-actions">
        <button
          type="button"
          class="btn btn-xs btn-primary"
          data-action="expected-cut"
          data-shared-edit
          data-boss-id="${escapeHtml(boss.id)}"
          data-next-cut-btn
          ${disAttr}
        >예상 컷 (→ ${formatTimeHHMM(afterNextMs)})</button>
        <button
          type="button"
          class="btn btn-xs btn-success"
          data-action="killed-now"
          data-shared-edit
          data-boss-id="${escapeHtml(boss.id)}"
          data-kill-now-btn
          ${disAttr}
        >지금 컷! (+${escapeHtml(respawnLabel)})</button>
        <button
          type="button"
          class="btn btn-xs btn-secondary"
          data-action="quick-time"
          data-shared-edit
          data-boss-id="${escapeHtml(boss.id)}"
          ${disAttr}
        >시간 입력</button>
        ${
          boss.previousState
            ? `<button type="button" class="btn btn-xs btn-ghost" data-action="undo-time" data-shared-edit data-boss-id="${escapeHtml(boss.id)}" ${disAttr}>되돌리기</button>`
            : ''
        }
      </div>

      <div class="card-meta-row">
        <label class="inline-check">
          <input
            type="checkbox"
            ${boss.autoRollover ? 'checked' : ''}
            data-action="toggle-auto-rollover"
            data-shared-edit
            data-boss-id="${escapeHtml(boss.id)}"
            ${disAttr}
          />
          <span>자동 다음 주기 갱신</span>
        </label>
        <button
          type="button"
          class="link-btn"
          data-action="edit-boss"
          data-shared-edit
          data-boss-id="${escapeHtml(boss.id)}"
          ${disAttr}
        >${escapeHtml(notifySummary)}</button>
      </div>
    </article>
  `;
}

function buildBossCardHtml(boss, nowMs) {
  return isWorldBoss(boss) ? buildWorldBossCardHtml(boss, nowMs) : buildFieldBossCardHtml(boss, nowMs);
}

function getFilteredAndSortedBosses(nowMs) {
  const filter = appState.settings.bossFilter || 'all';
  const bosses = getActiveBosses().filter((b) => {
    if (filter === 'world') return isWorldBoss(b);
    if (filter === 'field') return !isWorldBoss(b);
    return true;
  });
  return sortBosses(bosses, appState.settings.sortBy, nowMs);
}

function computeOrderSignature(sorted, nowMs) {
  return sorted
    .map((b) => `${b.id}:${getBossStatus(b, nowMs)}:${getBossDisplaySpawnMs(b, nowMs)}`)
    .join('|');
}

function renderBossList() {
  const nowMs = getNowMs();
  const listEl = $('boss-list');
  const sorted = getFilteredAndSortedBosses(nowMs);
  currentRenderedOrderKey = computeOrderSignature(sorted, nowMs);
  $('boss-count-badge').textContent = String(sorted.length);

  if (!sorted.length) {
    const activeMeta = getServerMeta(appState.activeServerId);
    const editable = canEditShared();
    listEl.innerHTML = `
      <div class="panel" style="text-align: center; padding: 32px;">
        <p style="margin:0 0 12px; color: var(--text-muted);">${escapeHtml(activeMeta.name)} 서버에 표시할 보스가 없습니다.</p>
        <button class="btn btn-primary" id="btn-empty-add" type="button" ${editable ? '' : 'disabled'}>+ 보스 추가하기</button>
      </div>
    `;
    const emptyBtn = $('btn-empty-add');
    if (emptyBtn) {
      emptyBtn.addEventListener('click', () => {
        if (!canEditShared()) {
          requireEditPermissionToast();
          return;
        }
        openBossModal(null);
      });
    }
    renderSpotlight(nowMs, true);
    renderServerTabs();
    return;
  }

  const shouldGroup = Boolean(appState.settings.groupByType) && (appState.settings.bossFilter || 'all') === 'all';
  if (shouldGroup) {
    const worldBosses = sorted.filter((b) => isWorldBoss(b));
    const fieldBosses = sorted.filter((b) => !isWorldBoss(b));
    const sections = [];

    if (worldBosses.length) {
      sections.push(`
        <section class="boss-section">
          <div class="boss-section-header">
            <span class="pill type-badge-world">월드 보스</span>
            <span>고정 시간 출현 (1시간 유지 · 출현 시 빨간 강조)</span>
            <span class="pill pill-muted">${worldBosses.length}</span>
          </div>
          <div class="boss-grid">
            ${worldBosses.map((b) => buildBossCardHtml(b, nowMs)).join('')}
          </div>
        </section>
      `);
    }

    if (fieldBosses.length) {
      sections.push(`
        <section class="boss-section">
          <div class="boss-section-header">
            <span class="pill type-badge-field">필드 보스</span>
            <span>처치 시간 반영 리스폰 (10분 전부터 빨간 강조)</span>
            <span class="pill pill-muted">${fieldBosses.length}</span>
          </div>
          <div class="boss-grid">
            ${fieldBosses.map((b) => buildBossCardHtml(b, nowMs)).join('')}
          </div>
        </section>
      `);
    }

    listEl.innerHTML = sections.join('');
  } else {
    listEl.innerHTML = `<div class="boss-grid">${sorted.map((b) => buildBossCardHtml(b, nowMs)).join('')}</div>`;
  }

  renderSpotlight(nowMs, true);
  renderServerTabs();
}

function updateCardComputedPreview(cardEl, boss, nowMs) {
  if (isWorldBoss(boss)) return;
  const dayLabel = formatRelativeDayLabel(boss.nextSpawnMs, nowMs);
  const expectedKillMs = getExpectedKillMs(boss);
  const afterNextMs = getAfterNextSpawnMs(boss, nowMs);
  const afterDay = formatRelativeDayLabel(afterNextMs, nowMs);
  const respawnLabel = formatDurationKorean(getEffectiveRespawnSec(boss));

  const dayEl = cardEl.querySelector('[data-spawn-day]');
  const hhmmEl = cardEl.querySelector('[data-spawn-hhmm]');
  const anchorEl = cardEl.querySelector('[data-anchor-label]');
  const cycleEl = cardEl.querySelector('[data-cycle-preview]');
  const nextCutBtn = cardEl.querySelector('[data-next-cut-btn]');
  const killNowBtn = cardEl.querySelector('[data-kill-now-btn]');

  if (dayEl) dayEl.textContent = dayLabel;
  if (hhmmEl) hhmmEl.textContent = formatTimeHHMM(boss.nextSpawnMs);
  if (anchorEl) anchorEl.textContent = getAnchorLabel(boss);
  if (cycleEl) {
    cycleEl.innerHTML = `
      <span>예상 처치: <strong>${formatTimeHHMM(expectedKillMs)}</strong></span>
      <span>이후 다음 젠: <strong>${escapeHtml(afterDay)} ${formatTimeHHMM(afterNextMs)}</strong></span>
    `;
  }
  if (nextCutBtn) nextCutBtn.textContent = `예상 컷 (→ ${formatTimeHHMM(afterNextMs)})`;
  if (killNowBtn) killNowBtn.textContent = `지금 컷! (+${respawnLabel})`;
}

function updateTickDisplays(nowMs) {
  $('live-clock').textContent = formatFullClock(nowMs);

  // If priority order or status tier changed (e.g., world boss just started or field boss entered 10m window),
  // re-render boss list smoothly when user is not typing into an inline input.
  const activeEl = document.activeElement;
  const isEditingInline = activeEl && activeEl.hasAttribute && activeEl.hasAttribute('data-inline-param');
  const sorted = getFilteredAndSortedBosses(nowMs);
  const nextOrderKey = computeOrderSignature(sorted, nowMs);
  if (!isEditingInline && nextOrderKey !== currentRenderedOrderKey) {
    renderBossList();
  }

  for (const boss of getActiveBosses()) {
    const cardEl = document.querySelector(`[data-boss-card="${CSS.escape(boss.id)}"]`);
    if (!cardEl) continue;

    const world = isWorldBoss(boss);
    const status = getBossStatus(boss, nowMs);
    const badge = getStatusBadgeInfo(status, world);
    const progress = computeProgressPercent(boss, nowMs);
    const cd = getCountdownDisplayForBoss(boss, nowMs);

    const wantedClass = `boss-card status-${status}`;
    if (cardEl.className !== wantedClass) {
      cardEl.className = wantedClass;
    }

    const badgeEl = cardEl.querySelector('[data-status-badge]');
    if (badgeEl) {
      badgeEl.className = `pill ${badge.cls}`;
      badgeEl.textContent = badge.text;
    }

    const cdEl = cardEl.querySelector('[data-countdown]');
    const cdTextEl = cardEl.querySelector('[data-countdown-text]');
    const progEl = cardEl.querySelector('[data-progress]');

    if (cdEl) cdEl.textContent = cd.countdown;
    if (cdTextEl) cdTextEl.textContent = cd.sub;
    if (progEl) progEl.style.width = `${progress}%`;
  }

  renderSpotlight(nowMs, false);

  const activeMeta = getServerMeta(appState.activeServerId);
  const spotBoss = findSpotlightBoss(nowMs);
  if (spotBoss) {
    const cd = getCountdownDisplayForBoss(spotBoss, nowMs);
    document.title = `[${cd.countdown}] ${spotBoss.name} · ${activeMeta.name}`;
  } else {
    document.title = `${activeMeta.name} - 이클립스 보스 타이머`;
  }
}

function renderAlertLogs() {
  const logs = getActiveLogs();
  $('log-count-badge').textContent = String(logs.length);
  const el = $('alert-log-list');
  if (!logs.length) {
    el.innerHTML = `<div class="empty-muted">아직 발생한 알림이 없습니다.</div>`;
    return;
  }
  el.innerHTML = logs
    .map(
      (log) => `
      <div class="log-item">
        <span>${escapeHtml(log.message)}</span>
        <span class="log-time">${formatTimeHHMMSS(log.triggeredAtMs)}</span>
      </div>
    `
    )
    .join('');
}

function rolloverAllBosses(nowMs, notifyOnAdvance = false) {
  let anyRolled = false;
  let activeRolled = false;

  for (const tab of getOrderedServerTabs(appState.serverTabs)) {
    const entry = appState.servers[tab.id];
    if (!entry || !Array.isArray(entry.bosses)) continue;
    const serverMeta = getServerMeta(tab.id);

    const nextBosses = entry.bosses.map((boss) => {
      const nextBoss = applyAutoRollover(boss, nowMs);
      if (nextBoss !== boss && nextBoss.nextSpawnMs !== boss.nextSpawnMs) {
        anyRolled = true;
        if (tab.id === appState.activeServerId) activeRolled = true;
        if (notifyOnAdvance) {
          const dayLbl = formatRelativeDayLabel(nextBoss.nextSpawnMs, nowMs);
          showToast(
            `[${serverMeta.name}] ${boss.name} 다음 주기 반영`,
            `예상 컷 시간 경과 → 다음 젠: ${dayLbl} ${formatTimeHHMM(nextBoss.nextSpawnMs)}`
          );
        }
      }
      return nextBoss;
    });

    entry.bosses = nextBosses;
  }

  return { anyRolled, activeRolled };
}

function handleTick() {
  const nowMs = getNowMs();
  let anyLogsChanged = false;
  let activeLogsChanged = false;
  let wednesdayResetRan = false;

  const schedRes = applyScheduledWednesdayReset(appState, nowMs);
  if (schedRes.didReset) {
    appState = schedRes.state;
    wednesdayResetRan = true;
    firedAlertKeys.clear();
    const maintStr = normalizeMaintenanceTimeStr(appState.settings.maintenanceEndTime);
    showToast(
      `수요일 정기점검 자동 리셋`,
      `${maintStr} 서버 오픈 기준으로 모든 필드 보스 시간이 초기화되었습니다.`,
      true
    );
    renderGlobalNotifyControls();
    renderAlertLogs();
    renderBossList();
  }

  for (const tab of getOrderedServerTabs(appState.serverTabs)) {
    const entry = appState.servers[tab.id];
    if (!entry || !Array.isArray(entry.bosses)) continue;
    const serverMeta = getServerMeta(tab.id);

    const dueAlerts = findDueAlerts(
      entry.bosses,
      appState.settings,
      nowMs,
      firedAlertKeys,
      20,
      serverMeta
    );
    if (!dueAlerts.length) continue;

    anyLogsChanged = true;
    if (tab.id === appState.activeServerId) activeLogsChanged = true;

    for (const alert of dueAlerts) {
      firedAlertKeys.add(alert.alertKey);

      if (appState.settings.soundEnabled) {
        playAlertSound(appState.settings.soundPreset, appState.settings.soundVolume);
      }
      if (appState.settings.desktopNotifications) {
        sendDesktopNotification(
          `⚔️ [${serverMeta.name}] ${alert.bossName} ${formatOffsetLabel(alert.offsetSec)}`,
          alert.message,
          alert.alertKey
        );
      }
      if (appState.settings.ttsEnabled) {
        speakKoreanAlert(alert.message);
      }

      showToast(
        `[${serverMeta.name}] ${alert.bossName} · ${formatOffsetLabel(alert.offsetSec)}`,
        alert.message,
        alert.offsetSec <= 60
      );

      entry.alertLogs.unshift({
        id: alert.alertKey,
        bossId: alert.bossId,
        bossName: alert.bossName,
        offsetSec: alert.offsetSec,
        targetSpawnMs: alert.targetSpawnMs,
        triggeredAtMs: nowMs,
        message: alert.message,
      });
    }

    entry.alertLogs = entry.alertLogs.slice(0, 50);
  }

  if (activeLogsChanged) {
    renderAlertLogs();
  }

  const { anyRolled, activeRolled } = rolloverAllBosses(nowMs, true);

  if (anyLogsChanged) {
    persistLocalOnly();
  }
  if ((wednesdayResetRan || anyRolled) && canEditShared()) {
    persistSharedChange({ preserveBossNotifyDefaults: true, silent: true });
  }
  if (activeRolled) {
    renderBossList();
  }

  if (firedAlertKeys.size > 300) {
    const cutoff = nowMs - 24 * 3600 * 1000;
    for (const key of firedAlertKeys) {
      const parts = key.split(':');
      const spawnTs = Number(parts[parts.length - 2]);
      if (Number.isFinite(spawnTs) && spawnTs < cutoff) {
        firedAlertKeys.delete(key);
      }
    }
  }

  updateTickDisplays(nowMs);
}

function startTickEngine() {
  if (typeof Worker !== 'undefined' && window.location.protocol !== 'file:') {
    try {
      tickWorker = new Worker('./src/timer-worker.js');
      tickWorker.addEventListener('message', (e) => {
        if (e.data && e.data.type === 'tick') handleTick();
      });
      tickWorker.postMessage({ type: 'start' });
    } catch {
      fallbackIntervalId = setInterval(handleTick, 1000);
    }
  } else {
    fallbackIntervalId = setInterval(handleTick, 1000);
  }

  if (!syncIntervalId) {
    syncIntervalId = setInterval(() => {
      if (apiAvailable && !document.hidden) {
        refreshFromServer(true);
      }
    }, 30000);
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      handleTick();
      if (apiAvailable && Date.now() - lastSyncFetchMs > 5000) {
        refreshFromServer(true);
      }
    }
  });
}

function addGlobalOffset(offsetSec) {
  const sec = Math.max(0, Math.round(Number(offsetSec)));
  if (!Number.isFinite(sec)) return;
  const next = new Set(appState.settings.globalNotifyOffsetsSec);
  next.add(sec);
  appState.settings.globalNotifyOffsetsSec = Array.from(next).sort((a, b) => b - a);
  renderGlobalNotifyControls();
  renderBossList();
  persistLocalOnly();
}

function removeGlobalOffset(offsetSec) {
  appState.settings.globalNotifyOffsetsSec = appState.settings.globalNotifyOffsetsSec.filter(
    (x) => x !== offsetSec
  );
  renderGlobalNotifyControls();
  renderBossList();
  persistLocalOnly();
}

function openModal(id) {
  $(id).classList.remove('hidden');
}

function closeModal(id) {
  if (id === 'modal-server-picker' && !appState.hasSelectedInitialServer) {
    appState.hasSelectedInitialServer = true;
    persistLocalOnly();
  }
  $(id).classList.add('hidden');
}

function formatShortDateTime(ms) {
  if (!Number.isFinite(Number(ms))) return '미사용';
  const d = new Date(Number(ms));
  return `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function renderEditorsList() {
  const listEl = $('auth-editors-list');
  const countEl = $('auth-editors-count');
  const editors = Array.isArray(authState.editors) ? authState.editors : [];
  countEl.textContent = `${editors.length}명`;

  if (!editors.length) {
    listEl.innerHTML = `<div class="empty-muted">아직 발급된 편집 권한이 없습니다.</div>`;
    return;
  }

  listEl.innerHTML = editors
    .map(
      (ed) => `
      <div class="editor-item">
        <div class="editor-info">
          <div class="editor-name-row">
            <span>🔑 ${escapeHtml(ed.label)}</span>
            <span class="pill pill-muted">끝 4자리 ···${escapeHtml(ed.codeHint || '****')}</span>
          </div>
          <div class="editor-meta">
            발급 ${escapeHtml(formatShortDateTime(ed.createdAtMs))} · 최근 사용 ${escapeHtml(formatShortDateTime(ed.lastUsedAtMs))}
          </div>
        </div>
        <button
          type="button"
          class="btn btn-xs btn-danger"
          data-revoke-editor-id="${escapeHtml(ed.id)}"
          data-revoke-editor-label="${escapeHtml(ed.label)}"
        >권한 회수</button>
      </div>
    `
    )
    .join('');
}

function renderAuthModal() {
  const isSetup = apiAvailable && !authState.configured;
  const isViewer = apiAvailable && authState.configured && authState.role === 'viewer';
  const isEditor = apiAvailable && authState.role === 'editor';
  const isHost = apiAvailable && authState.role === 'host';

  $('auth-setup-view').classList.toggle('hidden', !isSetup);
  $('auth-login-view').classList.toggle('hidden', !isViewer);
  $('auth-editor-view').classList.toggle('hidden', !isEditor);
  $('auth-host-view').classList.toggle('hidden', !isHost);

  if (isEditor) {
    $('auth-current-label').textContent = authState.label || '편집자';
  }
  if (isHost) {
    $('form-change-host-pw').classList.toggle('hidden', Boolean(authState.envHostLocked));
    $('auth-env-locked-note').classList.toggle('hidden', !authState.envHostLocked);
    renderEditorsList();
  }
}

async function openAuthModal() {
  if (!apiAvailable) {
    showToast('로컬 단독 모드', '서버 동기화가 활성화되지 않았습니다.');
    return;
  }
  const status = await fetchAuthStatus();
  if (status.ok) {
    authState = {
      configured: Boolean(status.configured),
      envHostLocked: Boolean(status.envHostLocked),
      role: status.role || 'viewer',
      label: status.label || null,
      revoked: Boolean(status.revoked),
      editors: Array.isArray(status.editors) ? status.editors : [],
    };
    updateAuthAndSyncUI();
  }
  $('issued-editor-box').classList.add('hidden');
  $('auth-login-code').value = '';
  $('auth-setup-password').value = '';
  $('auth-setup-confirm').value = '';
  renderAuthModal();
  openModal('modal-auth');
}

function renderBossCustomOffsetChips() {
  const el = $('boss-custom-offset-chips');
  if (!editingBossCustomOffsets.length) {
    el.innerHTML = `<span class="empty-muted">설정된 개별 알림 시간이 없습니다.</span>`;
    return;
  }
  el.innerHTML = editingBossCustomOffsets
    .map(
      (sec) => `
      <span class="offset-chip">
        <span>${escapeHtml(formatOffsetLabel(sec))}</span>
        <button type="button" data-remove-boss-offset="${sec}">✕</button>
      </span>
    `
    )
    .join('');
}

function renderWorldFixedTimeChips() {
  const el = $('boss-world-time-chips');
  if (!editingWorldFixedTimes.length) {
    el.innerHTML = `<span class="empty-muted">등록된 고정 시간이 없습니다.</span>`;
    return;
  }
  el.innerHTML = editingWorldFixedTimes
    .map(
      (t) => `
      <span class="offset-chip">
        <span>${escapeHtml(t)}</span>
        <button type="button" data-remove-world-time="${escapeHtml(t)}">✕</button>
      </span>
    `
    )
    .join('');
}

function syncBossModalTypeUI(bossType) {
  const isWorld = bossType === 'world';
  $('boss-world-fields').classList.toggle('hidden', !isWorld);
  $('boss-field-fields').classList.toggle('hidden', isWorld);
  $('boss-form-auto-rollover-wrap').classList.toggle('hidden', isWorld);

  $('boss-form-time').required = !isWorld;
  $('boss-form-respawn-hr').required = !isWorld;
  $('boss-form-respawn-min').required = !isWorld;
}

function updateBossModalPreview() {
  const previewEl = $('boss-form-preview');
  const timeStr = $('boss-form-time').value;
  const dayOffset = Number($('boss-form-day-offset').value || 0);
  const mode = document.querySelector('input[name="timeMode"]:checked')?.value || 'manual';
  const baseMs = buildTimestampOnDay(timeStr, getNowMs(), dayOffset);
  if (!baseMs) {
    previewEl.textContent = '시간 형식: HH:MM (예: 16:31)';
    return;
  }

  const killMin = Number($('boss-form-kill-min').value || 0);
  const killSec = Number($('boss-form-kill-sec').value || 0);
  const totalKillSec = Math.max(0, killMin * 60 + killSec);
  const respawnHr = Number($('boss-form-respawn-hr').value || 0);
  const respawnMin = Number($('boss-form-respawn-min').value || 0);
  const totalRespawnSec = Math.max(60, respawnHr * 3600 + respawnMin * 60);

  let targetMs = baseMs;
  if (mode === 'spawn') {
    targetMs = baseMs + (totalKillSec + totalRespawnSec) * 1000;
  } else if (mode === 'kill') {
    targetMs = baseMs + totalRespawnSec * 1000;
  }

  const dayLbl = formatRelativeDayLabel(targetMs, getNowMs());
  previewEl.textContent = `→ 계산된 출현: ${dayLbl} ${formatTimeHHMMSS(targetMs)}`;
}

function openBossModal(bossId) {
  const bosses = getActiveBosses();
  const boss = bossId ? bosses.find((b) => b.id === bossId) : null;
  const nowMs = getNowMs();
  const serverMeta = getServerMeta(appState.activeServerId);

  $('modal-boss-title').textContent = boss
    ? `[${serverMeta.name}] ${boss.name} 설정 수정`
    : `[${serverMeta.name}] 새 보스 추가`;
  $('boss-form-id').value = boss ? boss.id : '';
  $('boss-form-level').value = boss && boss.level ? String(boss.level) : '';
  $('boss-form-name').value = boss ? boss.name : '';
  $('boss-form-color').value = boss ? boss.color : '#3b82f6';
  $('boss-form-memo').value = boss ? boss.memo || '' : '';

  const bossType = boss ? (isWorldBoss(boss) ? 'world' : 'field') : 'field';
  document.querySelector(`input[name="bossTypeMode"][value="${bossType}"]`).checked = true;
  syncBossModalTypeUI(bossType);

  if (boss) {
    editingWorldFixedTimes = normalizeFixedTimes(
      isWorldBoss(boss) ? boss.fixedTimes : ['12:00', '20:00']
    );
    $('boss-form-active-min').value = String(Math.max(1, Math.round(getEffectiveActiveSec(boss) / 60)));

    $('boss-form-auto-rollover').checked = Boolean(boss.autoRollover);
    const isUnset = boss.killDurationSec === null || boss.killDurationSec === undefined;
    const totalKill = getEffectiveKillSec(boss);
    $('boss-form-kill-min').value = isUnset ? '' : String(Math.floor(totalKill / 60));
    $('boss-form-kill-sec').value = isUnset ? '' : String(totalKill % 60);

    const totalRespawn = getEffectiveRespawnSec(boss);
    $('boss-form-respawn-hr').value = String(Math.floor(totalRespawn / 3600));
    $('boss-form-respawn-min').value = String(Math.floor((totalRespawn % 3600) / 60));

    const mode = boss.anchorType || 'manual';
    document.querySelector(`input[name="timeMode"][value="${mode}"]`).checked = true;
    const refTimeMs =
      mode !== 'manual' && Number.isFinite(boss.anchorTimeMs)
        ? boss.anchorTimeMs
        : boss.nextSpawnMs || nowMs;

    const targetDay = new Date(refTimeMs);
    const today = new Date(nowMs);
    const dayDiff = Math.round(
      (new Date(targetDay.getFullYear(), targetDay.getMonth(), targetDay.getDate()).getTime() -
        new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) /
        (24 * 3600 * 1000)
    );
    $('boss-form-day-offset').value = String([-1, 0, 1].includes(dayDiff) ? dayDiff : 0);
    $('boss-form-time').value = formatTimeHHMM(refTimeMs);

    $('boss-form-notify-enabled').checked = boss.notifyEnabled !== false;
    const notifyMode = boss.useCustomNotify ? 'custom' : 'global';
    document.querySelector(`input[name="notifyMode"][value="${notifyMode}"]`).checked = true;
    editingBossCustomOffsets = [...(boss.customNotifyOffsetsSec || DEFAULT_NOTIFY_OFFSETS_SEC)];
    $('btn-delete-boss').classList.remove('hidden');
  } else {
    editingWorldFixedTimes = ['12:00', '20:00'];
    $('boss-form-active-min').value = '60';
    $('boss-form-auto-rollover').checked = Boolean(appState.settings.autoRolloverDefault);
    $('boss-form-kill-min').value = '1';
    $('boss-form-kill-sec').value = '0';
    $('boss-form-respawn-hr').value = '8';
    $('boss-form-respawn-min').value = '0';
    document.querySelector('input[name="timeMode"][value="manual"]').checked = true;
    $('boss-form-day-offset').value = '0';
    $('boss-form-time').value = formatTimeHHMM(nowMs + 3600 * 1000);
    $('boss-form-notify-enabled').checked = true;
    document.querySelector('input[name="notifyMode"][value="global"]').checked = true;
    editingBossCustomOffsets = [...appState.settings.globalNotifyOffsetsSec];
    $('btn-delete-boss').classList.add('hidden');
  }

  const isCustom = document.querySelector('input[name="notifyMode"]:checked').value === 'custom';
  $('boss-custom-notify-area').classList.toggle('hidden', !isCustom);
  renderWorldFixedTimeChips();
  renderBossCustomOffsetChips();
  updateBossModalPreview();
  openModal('modal-boss');
}

function updateQuickTimePreview() {
  const boss = getActiveBosses().find((b) => b.id === $('quick-boss-id').value);
  const previewEl = $('quick-time-preview');
  if (!boss) return;

  const mode = document.querySelector('input[name="quickTimeMode"]:checked')?.value || 'manual';
  const dayOffset = Number($('quick-day-offset').value || 0);
  const baseMs = buildTimestampOnDay($('quick-time-input').value, getNowMs(), dayOffset);
  if (!baseMs) {
    previewEl.textContent = '올바른 시간 형식(예: 16:31 또는 16:31:00)을 입력해 주세요.';
    return;
  }

  const updated = setBossTimeByMode(boss, mode, baseMs);
  const dayLbl = formatRelativeDayLabel(updated.nextSpawnMs, getNowMs());
  const diffText = formatCountdownText(updated.nextSpawnMs - getNowMs());
  previewEl.textContent = `적용 결과 → ${dayLbl} ${formatTimeHHMMSS(updated.nextSpawnMs)} (${diffText})`;
}

function openQuickTimeModal(bossId) {
  const boss = getActiveBosses().find((b) => b.id === bossId);
  if (!boss || isWorldBoss(boss)) return;

  const nowMs = getNowMs();
  $('quick-boss-id').value = boss.id;
  $('quick-time-title').textContent = `${boss.name} 출현 시간 입력`;

  const mode = boss.anchorType || 'manual';
  document.querySelector(`input[name="quickTimeMode"][value="${mode}"]`).checked = true;
  const refMs =
    mode !== 'manual' && Number.isFinite(boss.anchorTimeMs) ? boss.anchorTimeMs : boss.nextSpawnMs;

  const targetDay = new Date(refMs);
  const today = new Date(nowMs);
  const dayDiff = Math.round(
    (new Date(targetDay.getFullYear(), targetDay.getMonth(), targetDay.getDate()).getTime() -
      new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) /
      (24 * 3600 * 1000)
  );
  $('quick-day-offset').value = String([-1, 0, 1].includes(dayDiff) ? dayDiff : 0);
  $('quick-time-input').value = formatTimeHHMM(refMs);

  updateQuickTimePreview();
  openModal('modal-quick-time');
  $('quick-time-input').focus();
  $('quick-time-input').select();
}

async function refreshScheduleImage(tryCopy = true) {
  const statusEl = $('schedule-copy-status');
  const imgEl = $('schedule-preview-img');
  const showCountdown = $('chk-image-countdown').checked;
  const serverMeta = getServerMeta(appState.activeServerId);

  statusEl.className = 'copy-status-banner';
  statusEl.textContent = '시간표 이미지를 생성하는 중...';

  try {
    const canvas = renderScheduleCanvas(getActiveBosses(), getNowMs(), {
      showCountdown,
      serverName: serverMeta.name,
    });
    const blob = await canvasToPngBlob(canvas);
    latestScheduleBlob = blob;

    if (latestScheduleUrl) {
      URL.revokeObjectURL(latestScheduleUrl);
    }
    latestScheduleUrl = URL.createObjectURL(blob);
    imgEl.src = latestScheduleUrl;

    if (tryCopy) {
      const copied = await copyPngBlobToClipboard(blob);
      if (copied) {
        statusEl.className = 'copy-status-banner success';
        statusEl.textContent =
          '✅ 시간표 이미지가 클립보드에 복사되었습니다! (카톡·디스코드에 Ctrl+V)';
        showToast('이미지 복사 완료', `${serverMeta.name} 시간표 이미지를 복사했습니다.`);
      } else {
        statusEl.className = 'copy-status-banner warn';
        statusEl.textContent =
          '⚠️ 브라우저 권한으로 자동 복사가 제한되었습니다. 아래 [PNG 저장] 또는 이미지 우클릭 복사를 이용해 주세요.';
      }
    } else {
      statusEl.className = 'copy-status-banner';
      statusEl.textContent = '미리보기가 갱신되었습니다. [이미지 다시 복사] 또는 [PNG 저장]을 누르세요.';
    }
  } catch (err) {
    statusEl.className = 'copy-status-banner warn';
    statusEl.textContent = `이미지 생성 실패: ${err?.message || '알 수 없는 오류'}`;
  }
}

async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      return true;
    } catch {
      return false;
    }
  }
}

async function copyScheduleTextFallback() {
  const serverMeta = getServerMeta(appState.activeServerId);
  const text = formatScheduleForShare(getActiveBosses(), getNowMs(), serverMeta.name);
  await copyTextToClipboard(text);
  showToast('텍스트 복사 완료', `${serverMeta.name} 시간표 텍스트를 복사했습니다.`);
}

function updateMaintenanceScheduleStatus() {
  const statusEl = $('maint-schedule-status');
  const nowMs = getNowMs();
  const timeStr = normalizeMaintenanceTimeStr(appState.settings.maintenanceEndTime);
  if (appState.settings.autoWednesdayReset) {
    const nextWedMs = getNextWednesdayResetMs(nowMs, timeStr);
    const d = new Date(nextWedMs);
    const days = ['일', '월', '화', '수', '목', '금', '토'];
    statusEl.textContent = `다음 자동 리셋 예정: ${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} (${days[d.getDay()]}) ${timeStr}`;
  } else {
    statusEl.textContent = '매주 수요일 자동 리셋이 꺼져 있습니다. 필요 시 아래 버튼으로 수동 리셋할 수 있습니다.';
  }
}

function updateMaintenancePreview() {
  const previewEl = $('maint-preview');
  const dayOffset = Number($('maint-apply-day-offset').value || 0);
  const timeStr = $('maint-apply-time').value;
  const nowMs = getNowMs();
  const baseMs = buildTimestampOnDay(timeStr, nowMs, dayOffset);
  if (!baseMs) {
    previewEl.textContent = '올바른 시간 형식(예: 08:00 또는 09:30)을 입력해 주세요.';
    return;
  }

  const mode = document.querySelector('input[name="maintResetMode"]:checked')?.value || 'at_open';
  const fieldBosses = getActiveBosses().filter((b) => !isWorldBoss(b));
  if (!fieldBosses.length) {
    previewEl.textContent = '현재 서버에 등록된 필드 보스가 없습니다.';
    return;
  }

  const simulated = resetFieldBossesForMaintenance(fieldBosses, baseMs, mode, nowMs);
  const summary = simulated
    .slice(0, 5)
    .map((b) => {
      const dayLbl = formatRelativeDayLabel(b.nextSpawnMs, nowMs);
      const dayPrefix = dayLbl === '오늘' ? '' : `${dayLbl} `;
      return `${b.name} ${dayPrefix}${formatTimeHHMM(b.nextSpawnMs)}`;
    })
    .join(' · ');
  previewEl.textContent = `적용 미리보기 → ${summary}${simulated.length > 5 ? ' 외' : ''}`;
}

function openMaintenanceModal() {
  const s = appState.settings;
  const timeStr = normalizeMaintenanceTimeStr(s.maintenanceEndTime);
  $('maint-auto-enabled').checked = Boolean(s.autoWednesdayReset);
  $('maint-default-time').value = timeStr;
  $('maint-paste-text').value = '';
  $('maint-apply-day-offset').value = '0';
  $('maint-apply-time').value = timeStr;
  document.querySelector('input[name="maintResetMode"][value="at_open"]').checked = true;
  $('maint-apply-all-servers').checked = true;
  updateMaintenanceScheduleStatus();
  updateMaintenancePreview();
  openModal('modal-maintenance');
}

function bindEvents() {
  // Server tab bar events
  $('server-tabs-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-server-action]');
    if (!btn) return;
    const action = btn.dataset.serverAction;
    const serverId = btn.dataset.serverId;

    if (action === 'select') {
      selectServer(serverId, 'auto');
      const meta = getServerMeta(serverId);
      showToast(`${meta.name} 선택됨`, '다음 접속 시 이 서버가 기본 서버로 열립니다.');
    } else if (action === 'toggle-fav') {
      appState.serverTabs = toggleServerFavorite(appState.serverTabs, serverId);
      persistLocalOnly();
      renderServerTabs();
    } else if (action === 'remove') {
      const meta = getServerMeta(serverId);
      if (
        !window.confirm(
          apiAvailable
            ? `'${meta.name}' 서버 탭을 내 탭 목록에서 숨길까요? (공용 서버 시간표 데이터는 서버에 그대로 유지됩니다.)`
            : `'${meta.name}' 서버 탭을 목록에서 제거할까요? 해당 서버에 저장된 보스 시간도 함께 삭제됩니다.`
        )
      ) {
        return;
      }
      appState = removeServerTab(appState, serverId, { preserveServers: apiAvailable });
      currentSpotlightKey = '';
      persistLocalOnly();
      renderServerTabs();
      renderBossList();
      renderAlertLogs();
    }
  });

  $('btn-move-tab-left').addEventListener('click', () => {
    appState.serverTabs = moveServerTab(appState.serverTabs, appState.activeServerId, -1);
    persistLocalOnly();
    renderServerTabs();
  });

  $('btn-move-tab-right').addEventListener('click', () => {
    appState.serverTabs = moveServerTab(appState.serverTabs, appState.activeServerId, 1);
    persistLocalOnly();
    renderServerTabs();
  });

  $('btn-open-server-picker').addEventListener('click', () => {
    openServerPickerModal(false);
  });

  // Server picker modal events
  $('modal-server-picker').addEventListener('click', (e) => {
    const filterBtn = e.target.closest('[data-world-filter]');
    if (filterBtn) {
      selectedWorldFilter = filterBtn.dataset.worldFilter;
      renderServerPickerModal();
      return;
    }

    const favBtn = e.target.closest('[data-picker-fav]');
    if (favBtn) {
      const serverId = favBtn.dataset.pickerFav;
      const seedMode = $('sel-new-server-seed').value || 'preset';
      const exists = appState.serverTabs.some((t) => t.id === serverId);
      if (!exists) {
        const prevActive = appState.activeServerId;
        appState = addOrSelectServer(appState, serverId, seedMode, getNowMs());
        appState.activeServerId = prevActive;
      }
      appState.serverTabs = toggleServerFavorite(appState.serverTabs, serverId);
      persistLocalOnly();
      renderServerTabs();
      renderServerPickerModal();
      return;
    }

    const selectBtn = e.target.closest('[data-picker-select]');
    if (selectBtn) {
      const serverId = selectBtn.dataset.pickerSelect;
      const seedMode =
        serverId === DEFAULT_SERVER_ID ? 'auto' : $('sel-new-server-seed').value || 'preset';
      selectServer(serverId, seedMode);
      closeModal('modal-server-picker');
      const meta = getServerMeta(serverId);
      showToast(`${meta.name} 서버 적용`, '기본 접속 서버로 설정되었습니다.');
    }
  });

  // Topbar sync & auth actions
  $('btn-sync-refresh').addEventListener('click', () => {
    refreshFromServer(false);
  });

  $('btn-open-auth').addEventListener('click', openAuthModal);

  $('btn-notify-perm').addEventListener('click', async () => {
    const perm = await requestNotificationPermission();
    updatePermissionButton();
    if (perm === 'granted') {
      sendDesktopNotification(
        '⚔️ 보스 타이머 알림 테스트',
        '데스크톱 알림이 정상적으로 동작합니다!',
        'test-notify'
      );
      if (appState.settings.soundEnabled) {
        playAlertSound(appState.settings.soundPreset, appState.settings.soundVolume);
      }
      showToast('알림 테스트 완료', '데스크톱 알림이 허용되어 있습니다.');
    } else if (perm === 'denied') {
      showToast(
        '알림 차단됨',
        '브라우저 주소창 왼쪽 자물쇠 아이콘에서 알림 권한을 허용해 주세요.',
        true
      );
    }
  });

  $('btn-copy-schedule').addEventListener('click', async () => {
    openModal('modal-schedule-image');
    await refreshScheduleImage(true);
  });

  $('chk-image-countdown').addEventListener('change', () => {
    refreshScheduleImage(false);
  });

  $('btn-recopy-schedule-img').addEventListener('click', async () => {
    if (!latestScheduleBlob) {
      await refreshScheduleImage(true);
      return;
    }
    const statusEl = $('schedule-copy-status');
    const copied = await copyPngBlobToClipboard(latestScheduleBlob);
    if (copied) {
      statusEl.className = 'copy-status-banner success';
      statusEl.textContent =
        '✅ 시간표 이미지가 클립보드에 복사되었습니다! (카톡·디스코드에 Ctrl+V)';
      showToast('이미지 복사 완료', '클립보드에 시간표 이미지를 복사했습니다.');
    } else {
      statusEl.className = 'copy-status-banner warn';
      statusEl.textContent =
        '⚠️ 이 브라우저/환경에서는 클립보드 이미지 쓰기가 차단되어 있습니다. [PNG 저장]이나 우클릭 복사를 이용해 주세요.';
    }
  });

  $('btn-download-schedule-img').addEventListener('click', () => {
    if (!latestScheduleUrl) return;
    const serverMeta = getServerMeta(appState.activeServerId);
    const a = document.createElement('a');
    a.href = latestScheduleUrl;
    a.download = `boss-schedule-${serverMeta.id}-${formatTimeHHMM(getNowMs()).replace(':', '')}.png`;
    a.click();
  });

  $('btn-copy-schedule-text').addEventListener('click', copyScheduleTextFallback);

  $('btn-open-maintenance').addEventListener('click', () => {
    if (!canEditShared()) {
      requireEditPermissionToast();
      return;
    }
    openMaintenanceModal();
  });

  $('maint-auto-enabled').addEventListener('change', async (e) => {
    if (!canEditShared()) {
      e.target.checked = appState.settings.autoWednesdayReset;
      requireEditPermissionToast();
      return;
    }
    appState.settings.autoWednesdayReset = e.target.checked;
    if (e.target.checked) {
      const timeStr = normalizeMaintenanceTimeStr(appState.settings.maintenanceEndTime);
      appState.lastMaintenanceResetMs = Math.max(
        appState.lastMaintenanceResetMs || 0,
        getMostRecentWednesdayResetMs(getNowMs(), timeStr)
      );
    }
    await persistSharedChange({ preserveBossNotifyDefaults: true });
    updateMaintenanceScheduleStatus();
    renderGlobalNotifyControls();
  });

  $('btn-save-maint-schedule').addEventListener('click', async () => {
    if (!canEditShared()) {
      requireEditPermissionToast();
      return;
    }
    const parsed = parseTimeString($('maint-default-time').value);
    if (!parsed) {
      showToast('입력 오류', '기본 점검 종료 시각은 HH:MM 형식(예: 08:00)으로 입력해 주세요.', true);
      return;
    }
    const timeStr = `${pad2(parsed.hours)}:${pad2(parsed.minutes)}`;
    appState.settings.maintenanceEndTime = timeStr;
    appState.lastMaintenanceResetMs = Math.max(
      appState.lastMaintenanceResetMs || 0,
      getMostRecentWednesdayResetMs(getNowMs(), timeStr)
    );
    $('maint-default-time').value = timeStr;
    const saved = await persistSharedChange({ preserveBossNotifyDefaults: true });
    updateMaintenanceScheduleStatus();
    renderGlobalNotifyControls();
    if (saved) {
      showToast('정기점검 기본 시각 저장', `매주 수요일 자동 리셋 기준: ${timeStr}`);
    }
  });

  $('maint-paste-text').addEventListener('input', (e) => {
    const extracted = parseMaintenanceEndTimeFromText(e.target.value);
    if (extracted) {
      $('maint-apply-time').value = extracted;
      updateMaintenancePreview();
    }
  });

  $('maint-apply-day-offset').addEventListener('change', updateMaintenancePreview);
  $('maint-apply-time').addEventListener('input', updateMaintenancePreview);
  document.querySelectorAll('input[name="maintResetMode"]').forEach((r) => {
    r.addEventListener('change', updateMaintenancePreview);
  });

  $('form-maintenance-reset').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!canEditShared()) {
      requireEditPermissionToast();
      return;
    }
    const nowMs = getNowMs();
    const dayOffset = Number($('maint-apply-day-offset').value || 0);
    const baseMs = buildTimestampOnDay($('maint-apply-time').value, nowMs, dayOffset);
    if (!baseMs) {
      showToast('입력 오류', '점검 종료 시각을 HH:MM 형식(예: 08:00)으로 입력해 주세요.', true);
      return;
    }

    const mode = document.querySelector('input[name="maintResetMode"]:checked')?.value || 'at_open';
    const scope = $('maint-apply-all-servers').checked ? 'all' : 'active';
    appState = applyManualMaintenanceReset(appState, baseMs, { scope, mode }, nowMs);
    firedAlertKeys.clear();
    currentSpotlightKey = '';
    const saved = await persistSharedChange({ preserveBossNotifyDefaults: true });
    renderServerTabs();
    renderBossList();
    renderAlertLogs();
    updateTickDisplays(nowMs);
    closeModal('modal-maintenance');
    if (saved) {
      showToast(
        '정기점검 리셋 완료',
        `${formatRelativeDayLabel(baseMs, nowMs)} ${formatTimeHHMM(baseMs)} 기준으로 필드 보스를 리셋했습니다.`
      );
    }
  });

  $('btn-add-boss').addEventListener('click', () => {
    if (!canEditShared()) {
      requireEditPermissionToast();
      return;
    }
    openBossModal(null);
  });

  $('btn-open-settings').addEventListener('click', () => {
    $('set-server-offset').value = String(appState.settings.serverOffsetSec || 0);
    updateAuthAndSyncUI();
    openModal('modal-settings');
  });

  // Global notification settings (Personal browser preferences)
  $('chk-desktop-notify').addEventListener('change', async (e) => {
    appState.settings.desktopNotifications = e.target.checked;
    if (e.target.checked && getNotificationPermission() === 'default') {
      await requestNotificationPermission();
      updatePermissionButton();
    }
    persistLocalOnly();
  });

  $('chk-sound-notify').addEventListener('change', (e) => {
    appState.settings.soundEnabled = e.target.checked;
    persistLocalOnly();
  });

  $('sel-sound-preset').addEventListener('change', (e) => {
    appState.settings.soundPreset = e.target.value;
    playAlertSound(appState.settings.soundPreset, appState.settings.soundVolume);
    persistLocalOnly();
  });

  $('rng-sound-volume').addEventListener('input', (e) => {
    appState.settings.soundVolume = Number(e.target.value);
    persistLocalOnly();
  });

  $('btn-test-sound').addEventListener('click', () => {
    playAlertSound(appState.settings.soundPreset, appState.settings.soundVolume);
    if (appState.settings.ttsEnabled) {
      speakKoreanAlert('5분 뒤 베나토리아 출현 예정입니다.');
    }
  });

  $('chk-tts-notify').addEventListener('change', (e) => {
    appState.settings.ttsEnabled = e.target.checked;
    if (e.target.checked) {
      speakKoreanAlert('보스 출현 음성 안내가 켜졌습니다.');
    }
    persistLocalOnly();
  });

  $('global-offset-chips').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-global-offset]');
    if (!btn) return;
    removeGlobalOffset(Number(btn.dataset.removeGlobalOffset));
  });

  document.querySelectorAll('.preset-offset-btn').forEach((btn) => {
    btn.addEventListener('click', () => addGlobalOffset(Number(btn.dataset.sec)));
  });

  $('form-add-global-offset').addEventListener('submit', (e) => {
    e.preventDefault();
    const rawVal = Number($('inp-global-offset-val').value);
    const unit = Number($('sel-global-offset-unit').value);
    if (!Number.isFinite(rawVal) || rawVal < 0) return;
    addGlobalOffset(Math.round(rawVal * unit));
    $('inp-global-offset-val').value = '';
  });

  // Toolbar filter, group-by-type, sort (Personal view settings)
  $('boss-filter-pills').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-boss-filter]');
    if (!btn) return;
    appState.settings.bossFilter = btn.dataset.bossFilter;
    persistLocalOnly();
    renderGlobalNotifyControls();
    renderBossList();
  });

  $('chk-group-by-type').addEventListener('change', (e) => {
    appState.settings.groupByType = e.target.checked;
    persistLocalOnly();
    renderBossList();
  });

  $('sel-sort-by').addEventListener('change', (e) => {
    appState.settings.sortBy = e.target.value;
    persistLocalOnly();
    renderBossList();
  });

  // Spotlight & Boss List delegated click actions
  const handleBossActionClick = async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const bossId = btn.dataset.bossId;
    const bosses = getActiveBosses();
    const idx = bosses.findIndex((b) => b.id === bossId);
    if (idx === -1) return;

    const nowMs = getNowMs();
    const boss = bosses[idx];
    const nextBosses = [...bosses];

    if (action === 'toggle-boss-notify') {
      const nextEnabled = !boss.notifyEnabled;
      const sid = appState.activeServerId;
      if (!localPrefs.bossNotifyOverrides[sid]) localPrefs.bossNotifyOverrides[sid] = {};
      localPrefs.bossNotifyOverrides[sid][bossId] = {
        ...(localPrefs.bossNotifyOverrides[sid][bossId] || {}),
        notifyEnabled: nextEnabled,
      };
      nextBosses[idx] = { ...boss, notifyEnabled: nextEnabled };
      setActiveBosses(nextBosses);
      persistLocalOnly();
      renderBossList();
      return;
    }

    if (!canEditShared()) {
      requireEditPermissionToast();
      return;
    }

    if (action === 'expected-cut') {
      nextBosses[idx] = advanceBossCycle(boss, 'expected_cut', nowMs);
      setActiveBosses(nextBosses);
      renderBossList();
      const saved = await persistSharedChange({ preserveBossNotifyDefaults: true });
      if (saved) {
        showToast(
          `${boss.name} 다음 주기 반영`,
          `다음 출현: ${formatRelativeDayLabel(nextBosses[idx].nextSpawnMs, nowMs)} ${formatTimeHHMM(nextBosses[idx].nextSpawnMs)}`
        );
      }
    } else if (action === 'killed-now') {
      nextBosses[idx] = advanceBossCycle(boss, 'killed_now', nowMs);
      setActiveBosses(nextBosses);
      renderBossList();
      const saved = await persistSharedChange({ preserveBossNotifyDefaults: true });
      if (saved) {
        showToast(
          `${boss.name} 처치 완료`,
          `다음 출현: ${formatRelativeDayLabel(nextBosses[idx].nextSpawnMs, nowMs)} ${formatTimeHHMM(nextBosses[idx].nextSpawnMs)}`
        );
      }
    } else if (action === 'undo-time') {
      nextBosses[idx] = undoBossTimeChange(boss, nowMs);
      setActiveBosses(nextBosses);
      renderBossList();
      await persistSharedChange({ preserveBossNotifyDefaults: true });
    } else if (action === 'quick-time') {
      openQuickTimeModal(bossId);
    } else if (action === 'edit-boss') {
      openBossModal(bossId);
    }
  };

  $('spotlight-section').addEventListener('click', handleBossActionClick);
  $('boss-list').addEventListener('click', handleBossActionClick);

  $('boss-list').addEventListener('change', async (e) => {
    const autoCheck = e.target.closest('[data-action="toggle-auto-rollover"]');
    if (autoCheck) {
      if (!canEditShared()) {
        autoCheck.checked = !autoCheck.checked;
        requireEditPermissionToast();
        return;
      }
      const bosses = getActiveBosses();
      const idx = bosses.findIndex((b) => b.id === autoCheck.dataset.bossId);
      if (idx !== -1) {
        const nextBosses = [...bosses];
        nextBosses[idx] = applyAutoRollover(
          { ...bosses[idx], autoRollover: autoCheck.checked },
          getNowMs()
        );
        setActiveBosses(nextBosses);
        renderBossList();
        await persistSharedChange({ preserveBossNotifyDefaults: true });
      }
      return;
    }

    const paramInput = e.target.closest('[data-inline-param]');
    if (paramInput) {
      applyInlineParamChange(paramInput, true);
    }
  });

  $('boss-list').addEventListener('input', (e) => {
    const paramInput = e.target.closest('[data-inline-param]');
    if (paramInput) {
      applyInlineParamChange(paramInput, false);
    }
  });

  // Alert log clear (personal logs)
  $('btn-clear-logs').addEventListener('click', () => {
    setActiveLogs([]);
    renderAlertLogs();
    persistLocalOnly();
  });

  // Modals close buttons & backdrop click
  document.querySelectorAll('.modal-close').forEach((btn) => {
    btn.addEventListener('click', () => closeModal(btn.dataset.close));
  });
  document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeModal(backdrop.id);
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-backdrop').forEach((m) => {
        if (!m.classList.contains('hidden')) closeModal(m.id);
      });
    }
  });

  // Boss modal internals
  document.querySelectorAll('input[name="bossTypeMode"]').forEach((r) => {
    r.addEventListener('change', (e) => {
      syncBossModalTypeUI(e.target.value);
    });
  });

  $('boss-world-time-chips').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-world-time]');
    if (!btn) return;
    const t = btn.dataset.removeWorldTime;
    editingWorldFixedTimes = editingWorldFixedTimes.filter((x) => x !== t);
    renderWorldFixedTimeChips();
  });

  $('btn-add-world-time').addEventListener('click', () => {
    const val = $('inp-world-fixed-time').value;
    const parsed = parseTimeString(val);
    if (!parsed) {
      showToast('입력 오류', '고정 시간은 HH:MM 형식(예: 12:00 또는 20:00)으로 입력해 주세요.', true);
      return;
    }
    const formatted = `${pad2(parsed.hours)}:${pad2(parsed.minutes)}`;
    editingWorldFixedTimes = normalizeFixedTimes([...editingWorldFixedTimes, formatted]);
    $('inp-world-fixed-time').value = '';
    renderWorldFixedTimeChips();
  });

  document.querySelectorAll('.swatch').forEach((sw) => {
    sw.addEventListener('click', () => {
      $('boss-form-color').value = sw.dataset.color;
    });
  });

  document.querySelectorAll('input[name="notifyMode"]').forEach((r) => {
    r.addEventListener('change', () => {
      const isCustom = document.querySelector('input[name="notifyMode"]:checked').value === 'custom';
      $('boss-custom-notify-area').classList.toggle('hidden', !isCustom);
    });
  });

  $('boss-custom-offset-chips').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-boss-offset]');
    if (!btn) return;
    const targetSec = Number(btn.dataset.removeBossOffset);
    editingBossCustomOffsets = editingBossCustomOffsets.filter((x) => x !== targetSec);
    renderBossCustomOffsetChips();
  });

  $('btn-add-boss-offset').addEventListener('click', () => {
    const rawVal = Number($('inp-boss-offset-val').value);
    const unit = Number($('sel-boss-offset-unit').value);
    if (!Number.isFinite(rawVal) || rawVal < 0) return;
    const set = new Set(editingBossCustomOffsets);
    set.add(Math.round(rawVal * unit));
    editingBossCustomOffsets = Array.from(set).sort((a, b) => b - a);
    $('inp-boss-offset-val').value = '';
    renderBossCustomOffsetChips();
  });

  [
    'boss-form-time',
    'boss-form-day-offset',
    'boss-form-kill-min',
    'boss-form-kill-sec',
    'boss-form-respawn-hr',
    'boss-form-respawn-min',
  ].forEach((id) => {
    $(id).addEventListener('input', updateBossModalPreview);
    $(id).addEventListener('change', updateBossModalPreview);
  });
  document.querySelectorAll('input[name="timeMode"]').forEach((r) => {
    r.addEventListener('change', updateBossModalPreview);
  });

  $('form-boss').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!canEditShared()) {
      requireEditPermissionToast();
      return;
    }
    const id = $('boss-form-id').value.trim();
    const level = normalizeBossLevel($('boss-form-level').value);
    const name = $('boss-form-name').value.trim();
    if (!name) return;

    const bossType = document.querySelector('input[name="bossTypeMode"]:checked')?.value || 'field';
    const useCustomNotify =
      document.querySelector('input[name="notifyMode"]:checked')?.value === 'custom';
    const bosses = [...getActiveBosses()];
    const existingIdx = id ? bosses.findIndex((b) => b.id === id) : -1;
    const sid = appState.activeServerId;

    if (bossType === 'world') {
      if (!editingWorldFixedTimes.length) {
        showToast('입력 오류', '월드 보스는 최소 1개 이상의 고정 출현 시간을 추가해 주세요.', true);
        return;
      }
      const activeMin = Math.max(1, Math.round(Number($('boss-form-active-min').value) || 60));
      const worldBoss = {
        ...(existingIdx !== -1 ? bosses[existingIdx] : {}),
        id: id || `boss-${Date.now()}`,
        bossType: 'world',
        level,
        name,
        color: $('boss-form-color').value || '#a855f7',
        memo: $('boss-form-memo').value.trim(),
        fixedTimes: normalizeFixedTimes(editingWorldFixedTimes),
        activeDurationSec: activeMin * 60,
        killDurationSec: null,
        respawnDurationSec: 8 * 3600,
        nextSpawnMs: 0,
        anchorType: 'manual',
        anchorTimeMs: null,
        notifyEnabled: $('boss-form-notify-enabled').checked,
        useCustomNotify,
        customNotifyOffsetsSec: [...editingBossCustomOffsets],
        autoRollover: false,
        previousState: null,
      };
      if (existingIdx !== -1) bosses[existingIdx] = worldBoss;
      else bosses.push(worldBoss);
      if (localPrefs.bossNotifyOverrides?.[sid]?.[worldBoss.id]) {
        delete localPrefs.bossNotifyOverrides[sid][worldBoss.id];
      }

      setActiveBosses(bosses);
      closeModal('modal-boss');
      renderBossList();
      await persistSharedChange({ includeBossNotify: true });
      return;
    }

    // Field Boss save
    const timeStr = $('boss-form-time').value;
    const parsedTime = parseTimeString(timeStr);
    if (!parsedTime) {
      showToast('입력 오류', '출현 시간은 HH:MM 형식(예: 16:31)으로 입력해 주세요.', true);
      return;
    }

    const rawKillMin = $('boss-form-kill-min').value.trim();
    const rawKillSec = $('boss-form-kill-sec').value.trim();
    const killDurationSec =
      rawKillMin === '' && rawKillSec === ''
        ? null
        : Math.max(0, (Number(rawKillMin) || 0) * 60 + (Number(rawKillSec) || 0));

    const respawnHr = Math.max(0, Number($('boss-form-respawn-hr').value || 0));
    const respawnMin = Math.max(0, Number($('boss-form-respawn-min').value || 0));
    const respawnDurationSec = Math.max(60, respawnHr * 3600 + respawnMin * 60);

    const mode = document.querySelector('input[name="timeMode"]:checked')?.value || 'manual';
    const dayOffset = Number($('boss-form-day-offset').value || 0);
    const baseMs = buildTimestampOnDay(timeStr, getNowMs(), dayOffset);

    const baseBoss = {
      id: id || `boss-${Date.now()}`,
      bossType: 'field',
      level,
      name,
      color: $('boss-form-color').value || '#3b82f6',
      memo: $('boss-form-memo').value.trim(),
      fixedTimes: [],
      activeDurationSec: 3600,
      killDurationSec,
      respawnDurationSec,
      nextSpawnMs: baseMs,
      anchorType: 'manual',
      anchorTimeMs: null,
      notifyEnabled: $('boss-form-notify-enabled').checked,
      useCustomNotify,
      customNotifyOffsetsSec: [...editingBossCustomOffsets],
      autoRollover: $('boss-form-auto-rollover').checked,
      previousState: null,
    };

    const finalized = setBossTimeByMode(
      existingIdx !== -1 ? { ...bosses[existingIdx], ...baseBoss } : baseBoss,
      mode,
      baseMs
    );
    if (existingIdx === -1) finalized.previousState = null;

    if (existingIdx !== -1) {
      bosses[existingIdx] = finalized;
    } else {
      bosses.push(finalized);
    }
    if (localPrefs.bossNotifyOverrides?.[sid]?.[finalized.id]) {
      delete localPrefs.bossNotifyOverrides[sid][finalized.id];
    }

    setActiveBosses(bosses);
    closeModal('modal-boss');
    renderBossList();
    await persistSharedChange({ includeBossNotify: true });
  });

  $('btn-delete-boss').addEventListener('click', async () => {
    if (!canEditShared()) {
      requireEditPermissionToast();
      return;
    }
    const id = $('boss-form-id').value;
    const bosses = getActiveBosses();
    const boss = bosses.find((b) => b.id === id);
    if (!boss) return;
    if (!window.confirm(`'${boss.name}' 보스를 목록에서 삭제할까요?`)) return;
    setActiveBosses(bosses.filter((b) => b.id !== id));
    closeModal('modal-boss');
    renderBossList();
    await persistSharedChange({ preserveBossNotifyDefaults: true });
  });

  // Quick Time Modal
  $('quick-time-input').addEventListener('input', updateQuickTimePreview);
  $('quick-day-offset').addEventListener('change', updateQuickTimePreview);
  document.querySelectorAll('input[name="quickTimeMode"]').forEach((r) => {
    r.addEventListener('change', updateQuickTimePreview);
  });

  $('form-quick-time').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!canEditShared()) {
      requireEditPermissionToast();
      return;
    }
    const id = $('quick-boss-id').value;
    const bosses = [...getActiveBosses()];
    const idx = bosses.findIndex((b) => b.id === id);
    if (idx === -1) return;

    const dayOffset = Number($('quick-day-offset').value || 0);
    const baseMs = buildTimestampOnDay($('quick-time-input').value, getNowMs(), dayOffset);
    if (!baseMs) {
      showToast('입력 오류', '시간 형식이 올바르지 않습니다. (예: 16:31)', true);
      return;
    }

    const mode = document.querySelector('input[name="quickTimeMode"]:checked')?.value || 'manual';
    bosses[idx] = setBossTimeByMode(bosses[idx], mode, baseMs);
    setActiveBosses(bosses);
    closeModal('modal-quick-time');
    renderBossList();
    await persistSharedChange({ preserveBossNotifyDefaults: true });
  });

  // Auth modal events (Host & Editor access)
  $('form-auth-setup').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = $('auth-setup-password').value.trim();
    const confirmPw = $('auth-setup-confirm').value.trim();
    if (pw.length < 4) {
      showToast('입력 오류', '비밀번호는 4자 이상 입력해 주세요.', true);
      return;
    }
    if (pw !== confirmPw) {
      showToast('입력 오류', '비밀번호 확인이 일치하지 않습니다.', true);
      return;
    }
    const res = await postAuthAction({ action: 'setup_host', password: pw });
    if (!res.ok) {
      showToast('설정 실패', res.message || '호스트 비밀번호 설정에 실패했습니다.', true);
      return;
    }
    saveAuthSession({ token: res.token, role: 'host', label: '메인 호스트' });
    authState = {
      configured: true,
      envHostLocked: Boolean(res.envHostLocked),
      role: 'host',
      label: '메인 호스트',
      revoked: false,
      editors: Array.isArray(res.editors) ? res.editors : [],
    };
    $('auth-setup-password').value = '';
    $('auth-setup-confirm').value = '';
    updateAuthAndSyncUI();
    renderAuthModal();
    renderBossList();
    showToast('메인 호스트 설정 완료', '이제 시간표 수정 및 편집자 권한 발급이 가능합니다.');
  });

  $('form-auth-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = $('auth-login-code').value.trim();
    if (!code) return;
    const res = await postAuthAction({ action: 'login', code });
    if (!res.ok) {
      showToast('인증 실패', res.message || '비밀번호 또는 편집 코드가 올바르지 않습니다.', true);
      return;
    }
    saveAuthSession({ token: res.token, role: res.role, label: res.label });
    authState = {
      configured: Boolean(res.configured),
      envHostLocked: Boolean(res.envHostLocked),
      role: res.role,
      label: res.label,
      revoked: false,
      editors: Array.isArray(res.editors) ? res.editors : [],
    };
    $('auth-login-code').value = '';
    updateAuthAndSyncUI();
    renderAuthModal();
    renderBossList();
    showToast('권한 인증 완료', `${res.label || '편집'} 권한이 활성화되었습니다.`);
  });

  const handleLogout = async () => {
    clearAuthSession();
    authState = {
      ...authState,
      role: 'viewer',
      label: null,
      revoked: false,
      editors: [],
    };
    updateAuthAndSyncUI();
    renderAuthModal();
    renderBossList();
    showToast('보기 전용 전환', '편집 권한에서 로그아웃했습니다.');
  };
  $('btn-auth-logout').addEventListener('click', handleLogout);
  $('btn-host-logout').addEventListener('click', handleLogout);

  $('form-create-editor').addEventListener('submit', async (e) => {
    e.preventDefault();
    const label = $('inp-editor-label').value.trim();
    if (!label) return;
    const res = await postAuthAction({ action: 'create_editor', label });
    if (!res.ok) {
      showToast('발급 실패', res.message || '편집 권한 발급에 실패했습니다.', true);
      return;
    }
    authState.editors = Array.isArray(res.editors) ? res.editors : authState.editors;
    $('inp-editor-label').value = '';
    $('issued-editor-label').textContent = res.editor?.label || label;
    $('issued-editor-code').textContent = res.code;
    $('issued-editor-link').value = `${window.location.origin}/?edit=${encodeURIComponent(res.code)}`;
    $('issued-editor-box').classList.remove('hidden');
    renderEditorsList();
    showToast('권한 발급 완료', `'${label}' 초대 링크와 코드가 생성되었습니다.`);
  });

  $('btn-close-issued-box').addEventListener('click', () => {
    $('issued-editor-box').classList.add('hidden');
  });

  $('btn-copy-editor-code').addEventListener('click', async () => {
    await copyTextToClipboard($('issued-editor-code').textContent || '');
    showToast('코드 복사 완료', '편집 코드를 클립보드에 복사했습니다.');
  });

  $('btn-copy-editor-link').addEventListener('click', async () => {
    await copyTextToClipboard($('issued-editor-link').value || '');
    showToast('초대 링크 복사 완료', '카톡/디스코드에 붙여넣어 전달하세요.');
  });

  $('auth-editors-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-revoke-editor-id]');
    if (!btn) return;
    const editorId = btn.dataset.revokeEditorId;
    const label = btn.dataset.revokeEditorLabel || '편집자';
    if (!window.confirm(`'${label}'의 편집 권한을 즉시 회수할까요?`)) return;
    const res = await postAuthAction({ action: 'revoke_editor', editorId });
    if (!res.ok) {
      showToast('회수 실패', res.message || '권한 회수에 실패했습니다.', true);
      return;
    }
    authState.editors = Array.isArray(res.editors) ? res.editors : [];
    renderEditorsList();
    showToast('권한 회수 완료', `'${label}'의 수정 권한이 회수되었습니다.`);
  });

  $('form-change-host-pw').addEventListener('submit', async (e) => {
    e.preventDefault();
    const newPassword = $('inp-new-host-pw').value.trim();
    if (newPassword.length < 4) {
      showToast('입력 오류', '새 비밀번호는 4자 이상 입력해 주세요.', true);
      return;
    }
    const res = await postAuthAction({ action: 'change_host_password', newPassword });
    if (!res.ok) {
      showToast('변경 실패', res.message || '비밀번호 변경에 실패했습니다.', true);
      return;
    }
    saveAuthSession({ token: res.token, role: 'host', label: '메인 호스트' });
    $('inp-new-host-pw').value = '';
    showToast('비밀번호 변경 완료', '새 호스트 비밀번호가 적용되었습니다.');
  });

  // Global settings & backup
  $('btn-save-server-offset').addEventListener('click', () => {
    const val = Math.round(Number($('set-server-offset').value || 0));
    appState.settings.serverOffsetSec = Math.max(-3600, Math.min(3600, val));
    persistLocalOnly();
    renderGlobalNotifyControls();
    renderBossList();
    showToast('시계 보정 적용', `내 PC 서버 오차 보정: ${appState.settings.serverOffsetSec}초`);
  });

  $('btn-export-json').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(appState, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `eclipse-boss-backup-${formatTimeHHMM(getNowMs()).replace(':', '')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  $('inp-import-json').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!canEditShared()) {
      e.target.value = '';
      requireEditPermissionToast();
      return;
    }
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const importedShared = sanitizeSharedState(parsed?.sharedState ?? parsed, getNowMs());
      sharedState = importedShared;
      appState = mergeSharedAndLocalState(sharedState, localPrefs, getNowMs());
      rolloverAllBosses(getNowMs(), false);
      firedAlertKeys.clear();
      currentSpotlightKey = '';
      const saved = await persistSharedChange({
        force: authState.role === 'host',
        includeBossNotify: true,
      });
      renderServerTabs();
      renderGlobalNotifyControls();
      renderBossList();
      renderAlertLogs();
      closeModal('modal-settings');
      if (saved) {
        showToast('가져오기 완료', '백업 데이터를 공용 시간표에 반영했습니다.');
      }
    } catch {
      showToast('가져오기 실패', '올바른 JSON 백업 파일이 아닙니다.', true);
    } finally {
      e.target.value = '';
    }
  });

  $('btn-upload-legacy-backup').addEventListener('click', async () => {
    if (authState.role !== 'host') {
      requireEditPermissionToast();
      return;
    }
    const legacy = getLegacyLocalBackup();
    if (!legacy) return;
    if (!window.confirm('이 브라우저에 저장되어 있던 기존 시간표를 공용 서버로 덮어쓸까요?')) {
      return;
    }
    sharedState = sanitizeSharedState(legacy, getNowMs());
    appState = mergeSharedAndLocalState(sharedState, localPrefs, getNowMs());
    rolloverAllBosses(getNowMs(), false);
    firedAlertKeys.clear();
    currentSpotlightKey = '';
    const saved = await persistSharedChange({ force: true, includeBossNotify: true });
    renderServerTabs();
    renderGlobalNotifyControls();
    renderBossList();
    closeModal('modal-settings');
    if (saved) {
      showToast('기존 시간표 업로드 완료', '이전 로컬 시간표를 공용 서버에 반영했습니다.');
    }
  });

  $('btn-reset-defaults').addEventListener('click', async () => {
    if (!canEditShared()) {
      requireEditPermissionToast();
      return;
    }
    const serverMeta = getServerMeta(appState.activeServerId);
    if (
      !window.confirm(
        `'${serverMeta.name}' 서버의 보스 목록을 초기 프리셋(월드 2종 · 필드 5종)으로 복원할까요?`
      )
    ) {
      return;
    }
    setActiveBosses(createDefaultBosses(Date.now()));
    setActiveLogs([]);
    rolloverAllBosses(getNowMs(), false);
    firedAlertKeys.clear();
    currentSpotlightKey = '';
    renderServerTabs();
    renderBossList();
    renderAlertLogs();
    closeModal('modal-settings');
    const saved = await persistSharedChange({ includeBossNotify: true });
    if (saved) {
      showToast('프리셋 복원 완료', `${serverMeta.name} 서버가 초기 프리셋으로 복원되었습니다.`);
    }
  });
}

async function applyInlineParamChange(inputEl, commit) {
  if (!canEditShared()) {
    if (commit) requireEditPermissionToast();
    return;
  }
  const bossId = inputEl.dataset.bossId;
  const cardEl = document.querySelector(`[data-boss-card="${CSS.escape(bossId)}"]`);
  const bosses = [...getActiveBosses()];
  const idx = bosses.findIndex((b) => b.id === bossId);
  if (!cardEl || idx === -1) return;

  const boss = bosses[idx];
  const nowMs = getNowMs();

  if (isWorldBoss(boss) && inputEl.dataset.inlineParam === 'activeMin') {
    const activeMin = Math.max(1, Math.min(720, Math.floor(Number(inputEl.value) || 60)));
    bosses[idx] = { ...boss, activeDurationSec: activeMin * 60 };
    setActiveBosses(bosses);
    updateTickDisplays(nowMs);
    if (commit) {
      renderBossList();
      await persistSharedChange({ preserveBossNotifyDefaults: true });
    }
    return;
  }

  const killMinEl = cardEl.querySelector('[data-inline-param="killMin"]');
  const killSecEl = cardEl.querySelector('[data-inline-param="killSec"]');
  const respawnHrEl = cardEl.querySelector('[data-inline-param="respawnHr"]');
  const respawnMinEl = cardEl.querySelector('[data-inline-param="respawnMin"]');
  if (!killMinEl || !killSecEl || !respawnHrEl || !respawnMinEl) return;

  const rawKm = killMinEl.value.trim();
  const rawKs = killSecEl.value.trim();

  let killDurationSec;
  if (rawKm === '' && rawKs === '') {
    killDurationSec = null;
  } else {
    const km = Math.max(0, Math.floor(Number(rawKm) || 0));
    const ks = Math.max(0, Math.floor(Number(rawKs) || 0));
    killDurationSec = km * 60 + ks;
  }

  const rh = Math.max(0, Math.floor(Number(respawnHrEl.value) || 0));
  const rm = Math.max(0, Math.floor(Number(respawnMinEl.value) || 0));
  const respawnDurationSec = Math.max(60, rh * 3600 + rm * 60);

  const updated = recomputeBossTarget({
    ...boss,
    killDurationSec,
    respawnDurationSec,
  });

  bosses[idx] = updated;
  setActiveBosses(bosses);

  const unsetPill = cardEl.querySelector('[data-unset-pill]');
  if (unsetPill && killDurationSec !== null) {
    unsetPill.remove();
  }

  updateCardComputedPreview(cardEl, updated, nowMs);
  updateTickDisplays(nowMs);

  if (commit) {
    renderBossList();
    await persistSharedChange({ preserveBossNotifyDefaults: true });
  }
}

async function init() {
  unlockAudioOnGesture();
  updatePermissionButton();

  localPrefs = loadLocalPrefs();
  const inviteCode = consumeInviteCodeFromUrl();

  const boot = await fetchSharedBootstrap();
  apiAvailable = boot.apiAvailable;
  sharedState = boot.sharedState;
  authState = {
    configured: Boolean(boot.auth?.configured),
    envHostLocked: Boolean(boot.auth?.envHostLocked),
    role: boot.auth?.role || 'viewer',
    label: boot.auth?.label || null,
    revoked: Boolean(boot.auth?.revoked),
    editors: [],
  };

  if (inviteCode && apiAvailable) {
    const loginRes = await postAuthAction({ action: 'login', code: inviteCode });
    if (loginRes.ok) {
      saveAuthSession({ token: loginRes.token, role: loginRes.role, label: loginRes.label });
      authState = {
        ...authState,
        configured: Boolean(loginRes.configured),
        envHostLocked: Boolean(loginRes.envHostLocked),
        role: loginRes.role,
        label: loginRes.label,
        revoked: false,
      };
      showToast(
        '편집 권한 활성화',
        `'${loginRes.label || '편집자'}' 권한으로 로그인되었습니다.`
      );
    } else {
      showToast('유효하지 않은 초대 링크', loginRes.message || '회수되었거나 만료된 초대 코드입니다.', true);
    }
  } else if (authState.revoked) {
    showToast('편집 권한 회수됨', '기존 편집 권한이 회수되어 보기 전용으로 접속했습니다.', true);
  }

  lastSyncFetchMs = Date.now();
  appState = mergeSharedAndLocalState(sharedState, localPrefs, Date.now());

  const initNowMs = getNowMs();
  const schedDidReset = applyScheduledWednesdayResetInMemory(initNowMs);
  const { anyRolled } = rolloverAllBosses(initNowMs, false);
  if ((schedDidReset || anyRolled) && canEditShared()) {
    await persistSharedChange({ preserveBossNotifyDefaults: true, silent: true });
  }

  renderServerTabs();
  renderGlobalNotifyControls();
  renderBossList();
  renderAlertLogs();
  updateAuthAndSyncUI();
  updateTickDisplays(getNowMs());

  bindEvents();
  startTickEngine();

  if (!appState.hasSelectedInitialServer) {
    openServerPickerModal(true);
  }
}

init();
