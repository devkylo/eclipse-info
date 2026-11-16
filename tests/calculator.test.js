import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_SERVERS,
  DEFAULT_SERVER_ID,
  getServerMeta,
  getOrderedServerTabs,
  toggleServerFavorite,
  moveServerTab,
  getActiveServerData,
  addOrSelectServer,
  removeServerTab,
  createDefaultState,
  isWorldBoss,
  isAbyssBoss,
  isWeeklyFixedBoss,
  getBossCategory,
  isBossRedAlert,
  getWorldBossWindow,
  getWeeklyBossWindow,
  sanitizeNoticeObject,
  getEffectiveKillSec,
  getAfterNextSpawnMs,
  recomputeBossTarget,
  advanceBossCycle,
  setBossTimeByMode,
  undoBossTimeChange,
  applyAutoRollover,
  findDueAlerts,
  getBossStatus,
  sortBosses,
  formatTimeHHMM,
  formatCountdown,
  formatRelativeDayLabel,
  formatScheduleForShare,
  normalizeBossLevel,
  parseTimeString,
  buildTimestampOnDay,
  getMostRecentWednesdayResetMs,
  getNextWednesdayResetMs,
  parseMaintenanceEndTimeFromText,
  resetFieldBossesForMaintenance,
  applyManualMaintenanceReset,
  applyScheduledWednesdayReset,
  sanitizeState,
  createDefaultSharedState,
  createDefaultLocalPrefs,
  sanitizeSharedState,
  sanitizeLocalPrefs,
  mergeSharedAndLocalState,
  extractSharedStateFromAppState,
} from '../public/src/calculator.js';

// Fixed reference timestamp: 2026-11-16 16:28:30 KST (Monday)
function kstMs(day, hh, mm = 0, ss = 0) {
  return Date.UTC(2026, 10, day, hh - 9, mm, ss, 0);
}

function makeRefTime(hh = 16, mm = 28, ss = 30) {
  return kstMs(16, hh, mm, ss);
}

test('ALL_SERVERS defines 36 servers and 바르카디온 05 initializes 2 world + 3 abyss + 9 field bosses', () => {
  assert.equal(ALL_SERVERS.length, 36);
  const names = new Set(ALL_SERVERS.map((s) => s.name));
  for (const world of ['헤스카리온', '세라하', '발키리아', '바르카디온', '발제라', '셀린']) {
    for (let i = 1; i <= 6; i += 1) {
      assert.ok(names.has(`${world} ${String(i).padStart(2, '0')}`));
    }
  }

  const ref = makeRefTime(16, 28, 30);
  const state = createDefaultState(ref);
  assert.equal(state.version, 8);
  assert.equal(state.hasSelectedInitialServer, false);
  assert.equal(state.activeServerId, 'barkadion-05');
  assert.equal(state.serverTabs.length, 1);

  const bosses = getActiveServerData(state).bosses;
  assert.equal(bosses.length, 14);

  const byName = Object.fromEntries(bosses.map((b) => [b.name, b]));
  assert.equal(byName['크라카'].bossType, 'world');
  assert.equal(byName['크라카'].level, 60);
  assert.deepEqual(byName['크라카'].fixedTimes, ['12:00', '20:00']);
  assert.equal(byName['크라카'].activeDurationSec, 3600);

  assert.equal(byName['에버하르트'].bossType, 'world');
  assert.equal(byName['에버하르트'].level, 80);
  assert.deepEqual(byName['에버하르트'].fixedTimes, ['12:00', '20:00']);
  assert.equal(byName['에버하르트'].activeDurationSec, 3600);

  assert.equal(byName['바리탄'].bossType, 'abyss');
  assert.equal(isAbyssBoss(byName['바리탄']), true);
  assert.equal(getBossCategory(byName['바리탄']), 'abyss');
  assert.equal(byName['바리탄'].level, 50);
  assert.equal(byName['바리탄'].respawnDurationSec, 4 * 3600);
  assert.equal(byName['바리탄'].nextSpawnMs, kstMs(17, 1, 34, 0));

  assert.equal(byName['엘다르'].bossType, 'abyss');
  assert.equal(byName['엘다르'].level, 65);
  assert.equal(byName['엘다르'].respawnDurationSec, 8 * 3600);
  assert.equal(byName['엘다르'].nextSpawnMs, makeRefTime(23, 48, 0));

  assert.equal(byName['카스티안'].bossType, 'abyss');
  assert.equal(byName['카스티안'].level, 80);
  assert.equal(byName['카스티안'].respawnDurationSec, 12 * 3600);
  assert.equal(byName['카스티안'].nextSpawnMs, kstMs(17, 7, 22, 0));

  assert.equal(byName['레마넌트'].bossType, 'field');
  assert.equal(byName['레마넌트'].level, 40);
  assert.equal(byName['레마넌트'].killDurationSec, null);
  assert.equal(byName['레마넌트'].respawnDurationSec, 8 * 3600);
  assert.equal(byName['레마넌트'].nextSpawnMs, makeRefTime(16, 20, 0));

  assert.equal(byName['베나토리아'].level, 50);
  assert.equal(byName['베나토리아'].nextSpawnMs, makeRefTime(16, 31, 0));
  assert.equal(byName['샤렐나'].level, 60);
  assert.equal(byName['샤렐나'].nextSpawnMs, makeRefTime(16, 57, 0));
  assert.equal(byName['칼리브락스'].level, 70);
  assert.equal(byName['칼리브락스'].nextSpawnMs, makeRefTime(20, 49, 0));
  assert.equal(byName['아르칸다르'].level, 75);
  assert.equal(byName['아르칸다르'].killDurationSec, null);
  assert.equal(getEffectiveKillSec(byName['아르칸다르']), 0);
  assert.equal(byName['아르칸다르'].nextSpawnMs, makeRefTime(20, 56, 0));

  assert.equal(byName['벨카르'].bossType, 'field');
  assert.equal(byName['벨카르'].level, 80);
  assert.equal(byName['벨카르'].respawnDurationSec, 15 * 3600);
  assert.equal(byName['벨카르'].nextSpawnMs, kstMs(17, 2, 14, 0));

  assert.equal(byName['사바토'].bossType, 'field');
  assert.equal(byName['사바토'].level, 85);
  assert.equal(isWeeklyFixedBoss(byName['사바토']), true);
  assert.equal(byName['사바토'].weeklyDay, 5);
  assert.equal(byName['사바토'].weeklyTime, '21:00');

  assert.equal(byName['말록'].bossType, 'field');
  assert.equal(byName['말록'].level, 90);
  assert.equal(isWeeklyFixedBoss(byName['말록']), true);
  assert.equal(byName['말록'].weeklyDay, 6);
  assert.equal(byName['말록'].weeklyTime, '21:00');

  assert.equal(byName['샤를레'].bossType, 'field');
  assert.equal(byName['샤를레'].level, 99);
  assert.equal(isWeeklyFixedBoss(byName['샤를레']), true);
  assert.equal(byName['샤를레'].weeklyDay, 0);
  assert.equal(byName['샤를레'].weeklyTime, '21:00');
});

test('World Boss turns red only during 1h spawn window and moves across 12:00 / 20:00', () => {
  const state = createDefaultState(makeRefTime(11, 55, 0));
  const kraka = getActiveServerData(state).bosses.find((b) => b.name === '크라카');
  assert.equal(isWorldBoss(kraka), true);

  // 11:55 -> 5m before 12:00 -> upcoming, NOT red yet!
  assert.equal(getBossStatus(kraka, makeRefTime(11, 55, 0)), 'upcoming');
  assert.equal(isBossRedAlert(kraka, makeRefTime(11, 55, 0)), false);

  // 12:00:00 -> world_active -> RED!
  assert.equal(getBossStatus(kraka, makeRefTime(12, 0, 0)), 'world_active');
  assert.equal(isBossRedAlert(kraka, makeRefTime(12, 0, 0)), true);

  // 12:59:59 -> still active for 1 hour -> RED!
  const win1259 = getWorldBossWindow(kraka, makeRefTime(12, 59, 59));
  assert.equal(win1259.isActiveNow, true);
  assert.equal(win1259.windowEndMs, makeRefTime(13, 0, 0));
  assert.equal(isBossRedAlert(kraka, makeRefTime(12, 59, 59)), true);

  // 13:00:00 -> finished 12:00 window, shifts to 20:00 -> NOT red
  const win1300 = getWorldBossWindow(kraka, makeRefTime(13, 0, 0));
  assert.equal(win1300.isActiveNow, false);
  assert.equal(win1300.nextStartMs, makeRefTime(20, 0, 0));
  assert.equal(getBossStatus(kraka, makeRefTime(13, 0, 0)), 'scheduled');
  assert.equal(isBossRedAlert(kraka, makeRefTime(13, 0, 0)), false);

  // 20:30:00 -> active until 21:00 -> RED!
  assert.equal(getBossStatus(kraka, makeRefTime(20, 30, 0)), 'world_active');
  assert.equal(isBossRedAlert(kraka, makeRefTime(20, 30, 0)), true);

  // 21:00:00 -> shifts to next day 12:00
  const win2100 = getWorldBossWindow(kraka, makeRefTime(21, 0, 0));
  assert.equal(win2100.isActiveNow, false);
  assert.equal(win2100.nextStartMs, kstMs(17, 12, 0, 0));
});

test('Field Boss turns red from 10 minutes before spawn through kill window', () => {
  const ref = makeRefTime(16, 20, 0);
  const state = createDefaultState(ref);
  const venatoria = getActiveServerData(state).bosses.find((b) => b.name === '베나토리아'); // 16:31

  // 16:20:59 (10m 01s before) -> upcoming, NOT red
  assert.equal(getBossStatus(venatoria, makeRefTime(16, 20, 59)), 'upcoming');
  assert.equal(isBossRedAlert(venatoria, makeRefTime(16, 20, 59)), false);

  // 16:21:00 (10m 00s before) -> imminent, RED!
  assert.equal(getBossStatus(venatoria, makeRefTime(16, 21, 0)), 'imminent');
  assert.equal(isBossRedAlert(venatoria, makeRefTime(16, 21, 0)), true);

  // 16:31:30 (during 1m kill window) -> spawning_now, RED!
  assert.equal(getBossStatus(venatoria, makeRefTime(16, 31, 30)), 'spawning_now');
  assert.equal(isBossRedAlert(venatoria, makeRefTime(16, 31, 30)), true);

  // 16:35:00 (overdue if autoRollover off) -> NOT red
  assert.equal(getBossStatus(venatoria, makeRefTime(16, 35, 0)), 'overdue');
  assert.equal(isBossRedAlert(venatoria, makeRefTime(16, 35, 0)), false);
});

test('sortBosses puts active and approaching bosses at the very top', () => {
  const ref = makeRefTime(16, 28, 0);
  const state = createDefaultState(ref);
  const bosses = getActiveServerData(state).bosses;

  // At 16:28: 베나토리아(16:31) < 샤렐나(16:57) < 크라카/에버하르트(20:00) < 칼리브락스(20:49) < 아르칸다르(20:56) < 엘다르(23:48) < 바리탄(01:34) < 벨카르(02:14) < 카스티안(07:22) < 사바토(금) < 말록(토) < 샤를레(일) < 레마넌트(overdue 16:20)
  const sorted1628 = sortBosses(bosses, 'soonest', ref);
  assert.deepEqual(
    sorted1628.map((b) => b.name),
    [
      '베나토리아',
      '샤렐나',
      '에버하르트',
      '크라카',
      '칼리브락스',
      '아르칸다르',
      '엘다르',
      '바리탄',
      '벨카르',
      '카스티안',
      '사바토',
      '말록',
      '샤를레',
      '레마넌트',
    ]
  );

  // At 20:15: 크라카 and 에버하르트 are active (20:00~21:00) -> sit at the very top!
  const sorted2015 = sortBosses(bosses, 'soonest', makeRefTime(20, 15, 0));
  assert.deepEqual(sorted2015.slice(0, 2).map((b) => b.name), ['에버하르트', '크라카']);
});

test('multi-server selection, favorites priority, tab reordering, and removal', () => {
  const ref = makeRefTime(16, 28, 0);
  let state = createDefaultState(ref);

  state = addOrSelectServer(state, 'seraha-02', 'empty', ref);
  assert.equal(state.hasSelectedInitialServer, true);
  assert.equal(state.activeServerId, 'seraha-02');
  assert.equal(getActiveServerData(state).bosses.length, 0);

  state = addOrSelectServer(state, 'heskarion-01', 'preset', ref);
  assert.equal(state.activeServerId, 'heskarion-01');
  assert.equal(getActiveServerData(state).bosses.length, 14);

  state.serverTabs = toggleServerFavorite(state.serverTabs, 'heskarion-01');
  assert.deepEqual(
    getOrderedServerTabs(state.serverTabs).map((t) => t.id),
    ['barkadion-05', 'heskarion-01', 'seraha-02']
  );

  state.serverTabs = moveServerTab(state.serverTabs, 'heskarion-01', -1);
  assert.deepEqual(
    state.serverTabs.map((t) => t.id),
    ['heskarion-01', 'barkadion-05', 'seraha-02']
  );

  state = removeServerTab(state, 'heskarion-01');
  assert.equal(state.activeServerId, 'barkadion-05');
  state = removeServerTab(state, 'seraha-02');
  assert.equal(state.serverTabs.length, 1);
  state = removeServerTab(state, 'barkadion-05');
  assert.equal(state.serverTabs.length, 1);
});

test('getAfterNextSpawnMs and advanceBossCycle work for Field Bosses and skip World Bosses', () => {
  const ref = makeRefTime(16, 28, 0);
  const state = createDefaultState(ref);
  const bosses = getActiveServerData(state).bosses;
  const rem = bosses.find((b) => b.name === '레마넌트');
  const ven = bosses.find((b) => b.name === '베나토리아');
  const kraka = bosses.find((b) => b.name === '크라카');

  const expected = kstMs(17, 0, 32, 0);
  assert.equal(getAfterNextSpawnMs(ven, ref), expected);
  assert.equal(formatRelativeDayLabel(expected, ref), '내일');

  const advanced = advanceBossCycle(rem, 'expected_cut', ref);
  assert.equal(advanced.nextSpawnMs, kstMs(17, 0, 20, 0));

  const editedKill = recomputeBossTarget({ ...advanced, killDurationSec: 180 });
  assert.equal(editedKill.nextSpawnMs, kstMs(17, 0, 23, 0));

  const undoneFuture = undoBossTimeChange(advanced, makeRefTime(16, 15, 0));
  assert.equal(undoneFuture.autoRollover, true);
  const undonePast = undoBossTimeChange(advanced, makeRefTime(16, 28, 0));
  assert.equal(undonePast.autoRollover, false);

  // World Boss ignores field-only cycle advance & autoRollover
  assert.equal(advanceBossCycle(kraka, 'killed_now', ref), kraka);
  assert.equal(applyAutoRollover(kraka, ref), kraka);
});

test('findDueAlerts triggers for both Field Bosses and World Bosses and deduplicates', () => {
  const ref = makeRefTime(16, 28, 0);
  const state = createDefaultState(ref);
  state.settings.globalNotifyOffsetsSec = [300, 60, 0];
  const bosses = getActiveServerData(state).bosses;
  const serverMeta = getServerMeta(DEFAULT_SERVER_ID);

  const fired = new Set();

  // Field boss 5m alert at 16:26:05
  const due1 = findDueAlerts(bosses, state.settings, makeRefTime(16, 26, 5), fired, 20, serverMeta);
  assert.equal(due1.length, 1);
  assert.equal(due1[0].bossName, '베나토리아');
  fired.add(due1[0].alertKey);
  assert.equal(findDueAlerts(bosses, state.settings, makeRefTime(16, 26, 6), fired, 20, serverMeta).length, 0);

  // World boss 5m alert at 19:55:05 (for 20:00 크라카 + 에버하르트)
  const worldDue5m = findDueAlerts(bosses, state.settings, makeRefTime(19, 55, 5), new Set(), 20, serverMeta);
  assert.equal(worldDue5m.length, 2);
  assert.deepEqual(worldDue5m.map((d) => d.bossName).sort(), ['에버하르트', '크라카']);

  // World boss exact-spawn alert at 20:00:05 (already active windowStartMs)
  const worldDue0s = findDueAlerts(bosses, state.settings, makeRefTime(20, 0, 5), new Set(), 20, serverMeta);
  assert.equal(worldDue0s.length, 2);
  assert.ok(worldDue0s.every((d) => d.offsetSec === 0));
});

test('sanitizeState upgrades v1/v2/v3 data into v4 and injects world bosses safely', () => {
  const ref = makeRefTime(16, 28, 0);
  const v3 = {
    version: 3,
    hasSelectedInitialServer: true,
    activeServerId: 'barkadion-05',
    serverTabs: [{ id: 'barkadion-05', favorite: true }],
    servers: {
      'barkadion-05': {
        bosses: [{ id: 'remanent', name: '레마넌트', respawnDurationSec: 28800, nextSpawnMs: ref }],
        alertLogs: [],
      },
    },
  };

  const upgraded = sanitizeState(v3, ref);
  assert.equal(upgraded.version, 8);
  const bosses = getActiveServerData(upgraded).bosses;
  assert.equal(bosses.length, 10); // 크라카, 에버하르트, 레마넌트 + 바리탄, 엘다르, 카스티안 + 벨카르, 사바토, 말록, 샤를레
  assert.equal(bosses[0].bossType, 'world');
  assert.equal(bosses[0].level, 60);
  assert.equal(bosses[1].bossType, 'world');
  assert.equal(bosses[1].level, 80);
  assert.equal(bosses[2].bossType, 'field');
  assert.equal(bosses[2].level, 40);
  assert.equal(bosses[2].nextSpawnMs, ref);
  assert.equal(bosses[3].bossType, 'abyss');
  assert.equal(bosses[3].name, '바리탄');
  assert.equal(bosses[4].name, '엘다르');
  assert.equal(bosses[5].name, '카스티안');
  assert.equal(bosses[6].name, '벨카르');
  assert.equal(bosses[7].name, '사바토');

  // Upgrading v5 saved data backfills preset levels without overwriting custom spawn times
  const customSpawn = ref + 3600 * 1000;
  const v5 = {
    version: 5,
    hasSelectedInitialServer: true,
    activeServerId: 'barkadion-05',
    serverTabs: [{ id: 'barkadion-05', favorite: true }],
    servers: {
      'barkadion-05': {
        bosses: [
          { id: 'kraka', name: '크라카', bossType: 'world', fixedTimes: ['12:00', '20:00'], activeDurationSec: 3600 },
          { id: 'venatoria', name: '베나토리아', bossType: 'field', respawnDurationSec: 28800, nextSpawnMs: customSpawn },
          { id: 'custom-boss', name: '테라곤', bossType: 'field', respawnDurationSec: 54000, nextSpawnMs: customSpawn },
        ],
        alertLogs: [],
      },
    },
  };
  const upgradedV5 = sanitizeState(v5, ref);
  assert.equal(upgradedV5.version, 8);
  const v5Bosses = getActiveServerData(upgradedV5).bosses;
  assert.equal(v5Bosses.find((b) => b.name === '크라카').level, 60);
  assert.equal(v5Bosses.find((b) => b.name === '베나토리아').level, 50);
  assert.equal(v5Bosses.find((b) => b.name === '베나토리아').nextSpawnMs, customSpawn);
  assert.equal(v5Bosses.find((b) => b.name === '테라곤').level, null);
  assert.equal(v5Bosses.find((b) => b.name === '엘다르').bossType, 'abyss');
  assert.equal(v5Bosses.find((b) => b.name === '샤를레').weeklyDay, 0);

  // Share text formats world, abyss, and field (both cycle and weekly) cleanly
  const share = formatScheduleForShare(bosses, ref, '바르카디온 05');
  assert.match(share, /\[월드\] Lv\.60 크라카/);
  assert.match(share, /\[어비스\] Lv\.50 바리탄/);
  assert.match(share, /\[필드\] Lv\.40 레마넌트/);
  assert.match(share, /\[필드\] Lv\.85 사바토 → .*매주 금요일 21:00 고정/);
});

test('normalizeBossLevel validates positive integer levels cleanly', () => {
  assert.equal(normalizeBossLevel('60'), 60);
  assert.equal(normalizeBossLevel(80), 80);
  assert.equal(normalizeBossLevel(''), null);
  assert.equal(normalizeBossLevel(0), null);
  assert.equal(normalizeBossLevel(-5), null);
  assert.equal(normalizeBossLevel(null), null);
});

test('formatting and parsing helpers work accurately', () => {
  const ref = makeRefTime(16, 28, 0);
  assert.equal(formatCountdown(3 * 60 * 1000), '03:00');
  assert.equal(formatCountdown(-8 * 60 * 1000), '+08:00');
  assert.deepEqual(parseTimeString('08:05'), { hours: 8, minutes: 5, seconds: 0 });
  assert.equal(parseTimeString('25:99'), null);
  assert.equal(buildTimestampOnDay('00:32', ref, 1), kstMs(17, 0, 32, 0));
  assert.equal(
    setBossTimeByMode(
      getActiveServerData(createDefaultState(ref)).bosses.find((b) => b.name === '아르칸다르'),
      'kill',
      makeRefTime(8, 56, 0)
    ).nextSpawnMs,
    makeRefTime(20, 56, 0)
  );
});

test('Wednesday maintenance scheduling, auto-reset, manual modes, and notice parsing', () => {
  // 2026-11-16 is Monday -> recent Wed 2026-11-11 08:00, next Wed 2026-11-18 08:00
  const mon = kstMs(16, 18, 45, 0);
  assert.equal(
    getMostRecentWednesdayResetMs(mon, '08:00'),
    kstMs(11, 8, 0, 0)
  );
  assert.equal(
    getNextWednesdayResetMs(mon, '08:00'),
    kstMs(18, 8, 0, 0)
  );

  // Wednesday before 08:00 -> still points to previous Wednesday as most recent
  const wed0759 = kstMs(18, 7, 59, 59);
  assert.equal(
    getMostRecentWednesdayResetMs(wed0759, '08:00'),
    kstMs(11, 8, 0, 0)
  );

  // Wednesday at 08:00 -> flips to 2026-11-18 08:00
  const wed0800 = kstMs(18, 8, 0, 0);
  assert.equal(getMostRecentWednesdayResetMs(wed0800, '08:00'), wed0800);

  // Notice text parser extracts end time accurately
  assert.equal(parseMaintenanceEndTimeFromText('2026년 11월 11일(수) 05:00 ~ 08:00'), '08:00');
  assert.equal(parseMaintenanceEndTimeFromText('점검 연장 안내: 04:30 ~ 09:30'), '09:30');
  assert.equal(parseMaintenanceEndTimeFromText('종료 예정 8:15'), '08:15');

  // Auto-reset does NOT wipe Monday initial times
  let state = createDefaultState(mon);
  assert.equal(applyScheduledWednesdayReset(state, mon).didReset, false);
  assert.equal(applyScheduledWednesdayReset(state, wed0759).didReset, false);

  // Auto-reset triggers once at Wednesday 08:00 -> Field bosses reset to 08:00 (spawning_now), World bosses untouched
  const resAtOpen = applyScheduledWednesdayReset(state, wed0800);
  assert.equal(resAtOpen.didReset, true);
  state = resAtOpen.state;

  const bossesAt0800 = getActiveServerData(state).bosses;
  const kraka = bossesAt0800.find((b) => b.name === '크라카');
  const ven = bossesAt0800.find((b) => b.name === '베나토리아');
  const ark = bossesAt0800.find((b) => b.name === '아르칸다르');
  assert.deepEqual(kraka.fixedTimes, ['12:00', '20:00']);
  assert.equal(ven.nextSpawnMs, wed0800);
  assert.equal(getBossStatus(ven, wed0800), 'spawning_now');
  assert.equal(ark.nextSpawnMs, wed0800);

  // Second tick at 08:00:05 does NOT reset again
  assert.equal(applyScheduledWednesdayReset(state, wed0800 + 5000).didReset, false);

  // Opening late on Wednesday at 11:00 auto-rolls from 08:00 spawn -> 08:00 + killDuration + respawn
  const wed1100 = kstMs(18, 11, 0, 0);
  const lateState = createDefaultState(mon);
  const resLate = applyScheduledWednesdayReset(lateState, wed1100);
  assert.equal(resLate.didReset, true);
  const lateByName = Object.fromEntries(getActiveServerData(resLate.state).bosses.map((b) => [b.name, b]));
  assert.equal(lateByName['레마넌트'].nextSpawnMs, kstMs(18, 16, 0, 0)); // 08:00 + 0m + 8h
  assert.equal(lateByName['샤렐나'].nextSpawnMs, kstMs(18, 18, 1, 0)); // 08:00 + 1m + 10h
  assert.equal(lateByName['칼리브락스'].nextSpawnMs, kstMs(18, 20, 1, 0)); // 08:00 + 1m + 12h
  assert.equal(lateByName['아르칸다르'].nextSpawnMs, kstMs(18, 20, 0, 0)); // 08:00 + 0m + 12h

  // Manual extended maintenance reset to 09:30 with undo preserved
  const wed0930 = kstMs(18, 9, 30, 0);
  const manualAfter = applyManualMaintenanceReset(
    createDefaultState(mon),
    wed0930,
    { scope: 'all', mode: 'after_cycle' },
    wed0930
  );
  const manualRem = getActiveServerData(manualAfter).bosses.find((b) => b.name === '레마넌트');
  assert.equal(manualRem.nextSpawnMs, kstMs(18, 17, 30, 0));
  assert.ok(manualRem.previousState);
  const restored = undoBossTimeChange(manualRem, mon);
  assert.equal(restored.nextSpawnMs, makeRefTime(16, 20, 0));

  // Manual 'manual_only' keeps exact 08:00 without rolling even at 11:00
  const pinnedOnly = resetFieldBossesForMaintenance(
    getActiveServerData(createDefaultState(mon)).bosses,
    wed0800,
    'manual_only',
    wed1100
  );
  assert.equal(pinnedOnly.find((b) => b.name === '레마넌트').nextSpawnMs, wed0800);
});

test('shared state and local prefs merge cleanly and preserve unshown shared servers', () => {
  const ref = makeRefTime(16, 28, 0);
  let shared = createDefaultSharedState(ref);
  shared.serverOffsetSec = 5;
  shared.servers['heskarion-01'] = {
    bosses: [
      {
        id: 'custom-h1',
        bossType: 'field',
        level: 80,
        name: '벨카르',
        respawnDurationSec: 15 * 3600,
        nextSpawnMs: ref + 3600 * 1000,
        notifyEnabled: true,
        color: '#ef4444',
      },
    ],
  };
  shared = sanitizeSharedState(shared, ref);

  let local = createDefaultLocalPrefs();
  local.activeServerId = 'barkadion-05';
  local.settings.soundEnabled = false;
  local.settings.serverOffsetSec = 99;
  local.bossNotifyOverrides = {
    'barkadion-05': {
      remanent: { notifyEnabled: false },
    },
  };
  local = sanitizeLocalPrefs(local);

  let merged = mergeSharedAndLocalState(shared, local, ref);
  assert.equal(merged.settings.soundEnabled, false);
  assert.equal(merged.settings.serverOffsetSec, 5);
  assert.equal(merged.servers['barkadion-05'].bosses.find((b) => b.id === 'remanent').notifyEnabled, false);
  assert.equal(merged.servers['heskarion-01'].bosses[0].name, '벨카르');

  // Closing a personal tab with preserveServers keeps shared data untouched
  merged = addOrSelectServer(merged, 'heskarion-01', 'auto', ref);
  merged = removeServerTab(merged, 'heskarion-01', { preserveServers: true });
  assert.equal(merged.serverTabs.some((t) => t.id === 'heskarion-01'), false);

  const extracted = extractSharedStateFromAppState(merged, {
    previousSharedState: shared,
    nowMs: ref,
    preserveBossNotifyDefaults: true,
    updatedBy: '총무',
  });
  assert.equal(extracted.serverOffsetSec, 5);
  assert.equal(extracted.servers['heskarion-01'].bosses[0].name, '벨카르');
  // Preserve shared notifyEnabled default even when editor locally muted remanent bell
  assert.equal(extracted.servers['barkadion-05'].bosses.find((b) => b.id === 'remanent').notifyEnabled, true);
  assert.equal(extracted.updatedBy, '총무');
});

test('all preset boss times and Wednesday resets always calculate in KST (UTC+09:00) regardless of TZ', () => {
  const kst2102 = Date.parse('2026-11-16T21:02:00+09:00');
  const shared = createDefaultSharedState(kst2102);

  assert.equal(shared.lastMaintenanceResetMs, Date.parse('2026-11-11T08:00:00+09:00'));

  const bosses = shared.servers['barkadion-05'].bosses;
  const byName = Object.fromEntries(bosses.map((b) => [b.name, b]));
  assert.equal(byName['레마넌트'].nextSpawnMs, Date.parse('2026-11-16T16:20:00+09:00'));
  assert.equal(byName['베나토리아'].nextSpawnMs, Date.parse('2026-11-16T16:31:00+09:00'));
  assert.equal(byName['샤렐나'].nextSpawnMs, Date.parse('2026-11-16T16:57:00+09:00'));
  assert.equal(byName['칼리브락스'].nextSpawnMs, Date.parse('2026-11-16T20:49:00+09:00'));
  assert.equal(byName['아르칸다르'].nextSpawnMs, Date.parse('2026-11-16T20:56:00+09:00'));

  const rolled = Object.fromEntries(
    bosses.map((b) => [b.name, applyAutoRollover(b, kst2102)])
  );
  assert.equal(formatTimeHHMM(rolled['레마넌트'].nextSpawnMs), '00:20');
  assert.equal(formatTimeHHMM(rolled['베나토리아'].nextSpawnMs), '00:32');
  assert.equal(formatTimeHHMM(rolled['샤렐나'].nextSpawnMs), '02:58');
  assert.equal(formatTimeHHMM(rolled['칼리브락스'].nextSpawnMs), '08:50');
  assert.equal(formatTimeHHMM(rolled['아르칸다르'].nextSpawnMs), '08:56');
});

test('Abyss and extra field bosses inject cleanly from v7/v8 shared state without re-injecting after deletion in v9', () => {
  const kst2305 = Date.parse('2026-11-16T23:05:00+09:00');
  const existingV7 = {
    version: 7,
    revision: 5,
    updatedAtMs: kst2305 - 60000,
    updatedBy: '메인 호스트',
    serverOffsetSec: 0,
    lastMaintenanceResetMs: Date.parse('2026-11-11T08:00:00+09:00'),
    maintenance: { autoWednesdayReset: true, maintenanceEndTime: '08:00' },
    servers: {
      'barkadion-05': {
        bosses: [
          {
            id: 'arkandar',
            bossType: 'field',
            level: 75,
            name: '아르칸다르',
            respawnDurationSec: 12 * 3600,
            nextSpawnMs: Date.parse('2026-11-17T08:57:00+09:00'),
          },
        ],
      },
    },
  };

  const upgraded = sanitizeSharedState(existingV7, kst2305);
  assert.equal(upgraded.version, 9);
  const bosses = upgraded.servers['barkadion-05'].bosses;
  assert.equal(bosses.length, 8); // 아르칸다르 + 바리탄, 엘다르, 카스티안 + 벨카르, 사바토, 말록, 샤를레
  const byName = Object.fromEntries(bosses.map((b) => [b.name, b]));
  assert.equal(byName['아르칸다르'].nextSpawnMs, Date.parse('2026-11-17T08:57:00+09:00'));
  assert.equal(byName['엘다르'].nextSpawnMs, Date.parse('2026-11-16T23:48:00+09:00'));
  assert.equal(byName['바리탄'].nextSpawnMs, Date.parse('2026-11-17T01:34:00+09:00'));
  assert.equal(byName['카스티안'].nextSpawnMs, Date.parse('2026-11-17T07:22:00+09:00'));
  assert.equal(byName['벨카르'].nextSpawnMs, Date.parse('2026-11-17T02:14:00+09:00'));
  assert.equal(byName['사바토'].weeklyDay, 5);
  assert.equal(byName['말록'].weeklyDay, 6);
  assert.equal(byName['샤를레'].weeklyDay, 0);

  // Deleting an abyss or field boss once in v9 stays deleted after sanitizeSharedState
  upgraded.servers['barkadion-05'].bosses = upgraded.servers['barkadion-05'].bosses.filter(
    (b) => b.id !== 'baritan' && b.id !== 'belkar'
  );
  const resaved = sanitizeSharedState(upgraded, kst2305);
  assert.equal(resaved.servers['barkadion-05'].bosses.some((b) => b.id === 'baritan'), false);
  assert.equal(resaved.servers['barkadion-05'].bosses.some((b) => b.id === 'belkar'), false);

  // v8 state that already deleted baritan does NOT re-inject baritan when upgrading to v9
  const existingV8 = {
    version: 8,
    revision: 6,
    servers: {
      'barkadion-05': {
        bosses: [
          {
            id: 'eldar',
            bossType: 'abyss',
            level: 65,
            name: '엘다르',
            respawnDurationSec: 8 * 3600,
            nextSpawnMs: Date.parse('2026-11-16T23:48:00+09:00'),
          },
        ],
      },
    },
  };
  const fromV8 = sanitizeSharedState(existingV8, kst2305);
  assert.equal(fromV8.servers['barkadion-05'].bosses.some((b) => b.id === 'baritan'), false);
  assert.equal(fromV8.servers['barkadion-05'].bosses.some((b) => b.id === 'belkar'), true);
});

test('Weekly fixed field bosses compute KST windows, skip maintenance reset, and fire alerts', () => {
  const mon2318 = Date.parse('2026-11-16T23:18:00+09:00');
  const state = createDefaultState(mon2318);
  const bosses = getActiveServerData(state).bosses;
  const sabato = bosses.find((b) => b.name === '사바토'); // Fri 21:00
  const mallok = bosses.find((b) => b.name === '말록'); // Sat 21:00
  const charle = bosses.find((b) => b.name === '샤를레'); // Sun 21:00

  assert.equal(getWeeklyBossWindow(sabato, mon2318).nextStartMs, Date.parse('2026-11-20T21:00:00+09:00'));
  assert.equal(getWeeklyBossWindow(mallok, mon2318).nextStartMs, Date.parse('2026-11-21T21:00:00+09:00'));
  assert.equal(getWeeklyBossWindow(charle, mon2318).nextStartMs, Date.parse('2026-11-22T21:00:00+09:00'));

  // Friday 20:52 -> imminent RED alert; 21:30 -> spawning_now; 22:00 -> shifts to next Friday
  const fri2052 = Date.parse('2026-11-20T20:52:00+09:00');
  assert.equal(getBossStatus(sabato, fri2052), 'imminent');
  assert.equal(isBossRedAlert(sabato, fri2052), true);

  const fri2130 = Date.parse('2026-11-20T21:30:00+09:00');
  assert.equal(getBossStatus(sabato, fri2130), 'spawning_now');
  assert.equal(isBossRedAlert(sabato, fri2130), true);

  const fri2200 = Date.parse('2026-11-20T22:00:00+09:00');
  assert.equal(getBossStatus(sabato, fri2200), 'scheduled');
  assert.equal(getWeeklyBossWindow(sabato, fri2200).nextStartMs, Date.parse('2026-11-27T21:00:00+09:00'));

  // Due alert fires at Friday 20:55:05 (5m before 21:00)
  const fri2055 = Date.parse('2026-11-20T20:55:05+09:00');
  const due = findDueAlerts([sabato], state.settings, fri2055, new Set(), 20, getServerMeta(DEFAULT_SERVER_ID));
  assert.equal(due.length, 1);
  assert.equal(due[0].bossName, '사바토');

  // Wednesday maintenance leaves weekly fixed bosses untouched while resetting regular field bosses
  const wed0800 = Date.parse('2026-11-18T08:00:00+09:00');
  const afterMaint = resetFieldBossesForMaintenance([sabato, bosses.find((b) => b.name === '벨카르')], wed0800, 'at_open', wed0800);
  assert.equal(getWeeklyBossWindow(afterMaint[0], wed0800).nextStartMs, Date.parse('2026-11-20T21:00:00+09:00'));
  assert.equal(afterMaint[1].nextSpawnMs, wed0800);
});

test('Shared notice styling and personal bossViewPrefs (favorite/hidden) merge cleanly', () => {
  const ref = Date.parse('2026-11-16T23:18:00+09:00');
  assert.deepEqual(sanitizeNoticeObject(null), {
    text: '',
    fontSize: 12,
    color: '#ffffff',
    bold: false,
  });
  assert.deepEqual(
    sanitizeNoticeObject({ text: '오늘 집결', fontSize: 99, color: '#FFCC00', bold: true }),
    {
      text: '오늘 집결',
      fontSize: 28,
      color: '#ffcc00',
      bold: true,
    }
  );

  const shared = createDefaultSharedState(ref);
  shared.notice = { text: '21시 집결!', fontSize: 16, color: '#38bdf8', bold: true };

  const local = sanitizeLocalPrefs({
    bossViewPrefs: {
      'barkadion-05': {
        sabato: { favorite: true, hidden: false },
        remanent: { favorite: false, hidden: true },
      },
    },
  });

  const merged = mergeSharedAndLocalState(shared, local, ref);
  assert.deepEqual(merged.notice, { text: '21시 집결!', fontSize: 16, color: '#38bdf8', bold: true });
  assert.equal(merged.bossViewPrefs['barkadion-05'].sabato.favorite, true);
  assert.equal(merged.bossViewPrefs['barkadion-05'].remanent.hidden, true);

  // Viewer prefs do not leak into shared state extraction, while notice updates preserve cleanly
  const extracted = extractSharedStateFromAppState(merged, { previousSharedState: shared, nowMs: ref });
  assert.deepEqual(extracted.notice, {
    text: '21시 집결!',
    fontSize: 16,
    color: '#38bdf8',
    bold: true,
  });
  assert.equal(extracted.bossViewPrefs, undefined);
});
