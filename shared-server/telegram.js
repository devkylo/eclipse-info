import {
  DEFAULT_SERVER_ID,
  applyAutoRollover,
  applyScheduledWednesdayReset,
  createDefaultLocalPrefs,
  formatRelativeDayLabel,
  formatTimeHHMM,
  formatTimeHHMMSS,
  getBossCategory,
  getKstDateParts,
  getServerMeta,
  getWeeklyBossWindow,
  getWorldBossWindow,
  isWeeklyFixedBoss,
  isWorldBoss,
  mergeSharedAndLocalState,
  sanitizeSharedState,
} from '../public/src/calculator.js';
import {
  KEY_TELEGRAM_STATE,
  evaluateAuth,
  getEnvHostKey,
  getRuntimeEnv,
  jsonResponse,
  readAuthSafe,
  readSharedStateOrDefault,
} from './store.js';

export const DEFAULT_TELEGRAM_CHAT_ID = '@eclipse_boss_ba05';
export const DEFAULT_TELEGRAM_CHANNEL_URL = 'https://t.me/eclipse_boss_ba05';
export const TEN_MIN_LEAD_SEC = 10 * 60;
export const MIN_ALERT_REMAINING_SEC = 4 * 60;
export const MAX_ALERT_REMAINING_SEC = 10 * 60 + 15;
const SENT_KEY_TTL_MS = 48 * 3600 * 1000;

export function normalizeTelegramChatId(rawChatId) {
  const trimmed = String(rawChatId || '').trim();
  if (!trimmed) return DEFAULT_TELEGRAM_CHAT_ID;
  const linkMatch = trimmed.match(/^(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]{5,})\/?$/i);
  if (linkMatch && linkMatch[1]) {
    return `@${linkMatch[1]}`;
  }
  return trimmed;
}

export function getTelegramConfig(overrides = {}) {
  const botToken = String(
    overrides.botToken ??
      (getRuntimeEnv('TELEGRAM_BOT_TOKEN') || getRuntimeEnv('eclipse_boss_ba05_bot_token')) ??
      ''
  ).trim();
  const chatId = normalizeTelegramChatId(
    overrides.chatId ?? getRuntimeEnv('TELEGRAM_CHAT_ID') ?? DEFAULT_TELEGRAM_CHAT_ID
  );
  const rawServerId = String(
    overrides.serverId ?? getRuntimeEnv('TELEGRAM_SERVER_ID') ?? DEFAULT_SERVER_ID
  ).trim();
  const serverMeta = getServerMeta(rawServerId || DEFAULT_SERVER_ID);

  return {
    botToken,
    chatId,
    serverId: serverMeta.id,
  };
}

function escapeTelegramHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function getBossCategoryTag(boss) {
  const cat = getBossCategory(boss);
  if (cat === 'world') return '월드';
  if (cat === 'abyss') return '어비스';
  return '필드';
}

function formatSpawnTimeDisplay(targetSpawnMs) {
  const p = getKstDateParts(targetSpawnMs);
  return p.seconds === 0 ? formatTimeHHMM(targetSpawnMs) : formatTimeHHMMSS(targetSpawnMs);
}

function resolveNextSpawnTargetMs(boss, effectiveNowMs) {
  if (isWorldBoss(boss)) {
    return getWorldBossWindow(boss, effectiveNowMs).nextStartMs;
  }
  if (isWeeklyFixedBoss(boss)) {
    return getWeeklyBossWindow(boss, effectiveNowMs).nextStartMs;
  }
  return applyAutoRollover(boss, effectiveNowMs).nextSpawnMs;
}

function prepareServerEvaluationState(rawSharedState, serverId, baseNowMs) {
  const cleanShared = sanitizeSharedState(rawSharedState, baseNowMs);
  const effectiveNowMs = baseNowMs + (cleanShared.serverOffsetSec || 0) * 1000;
  const serverMeta = getServerMeta(serverId || DEFAULT_SERVER_ID);
  const prefs = createDefaultLocalPrefs();
  if (!prefs.serverTabs.some((t) => t.id === serverMeta.id)) {
    prefs.serverTabs.push({ id: serverMeta.id, favorite: false });
  }
  const merged = mergeSharedAndLocalState(cleanShared, prefs, effectiveNowMs);
  const afterReset = applyScheduledWednesdayReset(merged, effectiveNowMs).state;
  const bosses = afterReset.servers?.[serverMeta.id]?.bosses || [];
  return { effectiveNowMs, serverMeta, bosses };
}

/**
 * Evaluate which bosses on the configured server are within the 10-minute pre-spawn window
 * (wide enough for 2-minute cron jitter: 10m15s down to 4m00s before spawn).
 */
export function collectTenMinuteAlertCandidates(rawSharedState, options = {}) {
  const baseNowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const { effectiveNowMs, serverMeta, bosses } = prepareServerEvaluationState(
    rawSharedState,
    options.serverId,
    baseNowMs
  );
  if (!bosses.length) {
    return { effectiveNowMs, serverMeta, candidates: [] };
  }

  const candidates = [];
  for (const boss of bosses) {
    if (boss.notifyEnabled === false) continue;
    const targetSpawnMs = resolveNextSpawnTargetMs(boss, effectiveNowMs);
    if (!Number.isFinite(targetSpawnMs)) continue;

    const remainingSec = Math.round((targetSpawnMs - effectiveNowMs) / 1000);
    if (remainingSec < MIN_ALERT_REMAINING_SEC || remainingSec > MAX_ALERT_REMAINING_SEC) {
      continue;
    }

    candidates.push({
      alertKey: `${serverMeta.id}:${boss.id}:${targetSpawnMs}:${TEN_MIN_LEAD_SEC}`,
      bossId: boss.id,
      bossName: boss.name,
      categoryTag: getBossCategoryTag(boss),
      level: boss.level,
      memo: boss.memo || '',
      targetSpawnMs,
      remainingSec,
    });
  }

  candidates.sort((a, b) => a.targetSpawnMs - b.targetSpawnMs || a.bossName.localeCompare(b.bossName, 'ko'));
  return { effectiveNowMs, serverMeta, candidates };
}

export function formatTelegramBossAlertHtml(candidates, serverMeta, effectiveNowMs) {
  if (!Array.isArray(candidates) || !candidates.length) return '';

  const serverName = escapeTelegramHtml(serverMeta?.name || '바르카디온 05');
  const remainMins = candidates.map((c) => Math.max(1, Math.min(10, Math.round(c.remainingSec / 60))));
  const minRemain = Math.min(...remainMins);
  const leadHeadline = minRemain >= 9 ? '10분 전' : `${minRemain}분 전`;

  if (candidates.length === 1) {
    const c = candidates[0];
    const lvText = c.level ? `Lv.${c.level} ` : '';
    const memoText = c.memo ? ` · ${escapeTelegramHtml(c.memo)}` : '';
    const dayLabel = escapeTelegramHtml(formatRelativeDayLabel(c.targetSpawnMs, effectiveNowMs));
    const timeLabel = escapeTelegramHtml(formatSpawnTimeDisplay(c.targetSpawnMs));
    return [
      `⏰ <b>[${serverName}] 보스 출현 ${leadHeadline}</b>`,
      '',
      `⚔️ <b>[${escapeTelegramHtml(c.categoryTag)}] ${escapeTelegramHtml(lvText)}${escapeTelegramHtml(c.bossName)}</b>${memoText}`,
      `🕒 출현 예정: <b>${dayLabel} ${timeLabel}</b> (약 ${remainMins[0]}분 후)`,
    ].join('\n');
  }

  const lines = candidates.map((c, idx) => {
    const lvText = c.level ? `Lv.${c.level} ` : '';
    const memoText = c.memo ? ` (${escapeTelegramHtml(c.memo)})` : '';
    const dayLabel = escapeTelegramHtml(formatRelativeDayLabel(c.targetSpawnMs, effectiveNowMs));
    const timeLabel = escapeTelegramHtml(formatSpawnTimeDisplay(c.targetSpawnMs));
    return `• <b>[${escapeTelegramHtml(c.categoryTag)}] ${escapeTelegramHtml(lvText)}${escapeTelegramHtml(c.bossName)}</b>${memoText} — <b>${dayLabel} ${timeLabel}</b> (약 ${remainMins[idx]}분 후)`;
  });

  return [
    `⏰ <b>[${serverName}] 보스 출현 ${leadHeadline} (${candidates.length}종)</b>`,
    '',
    ...lines,
  ].join('\n');
}

function sanitizeTelegramAlertState(raw, nowMs) {
  const srcSent = raw && typeof raw === 'object' && raw.sent && typeof raw.sent === 'object' ? raw.sent : {};
  const pruned = {};
  for (const [key, sentAtMs] of Object.entries(srcSent)) {
    const ts = Number(sentAtMs);
    if (Number.isFinite(ts) && nowMs - ts <= SENT_KEY_TTL_MS) {
      pruned[key] = ts;
    }
  }
  return {
    version: 1,
    sent: pruned,
    lastSentAtMs: Number.isFinite(Number(raw?.lastSentAtMs)) ? Number(raw.lastSentAtMs) : null,
  };
}

export async function sendTelegramMessage(botToken, chatId, htmlText, fetchImpl = fetch) {
  const token = String(botToken || '').trim();
  const targetChatId = normalizeTelegramChatId(chatId);
  if (!token) {
    return { ok: false, status: 400, message: 'TELEGRAM_BOT_TOKEN 환경변수가 설정되지 않았습니다.' };
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        chat_id: targetChatId,
        text: htmlText,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      }),
    });

    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    if (!res.ok || !data?.ok) {
      const desc = data?.description || `HTTP ${res.status}`;
      return {
        ok: false,
        status: res.status || 502,
        description: desc,
        message: `텔레그램 전송 실패 (${desc}). 봇 토큰과 채널 관리자 권한(Post messages)을 확인해 주세요.`,
      };
    }

    return {
      ok: true,
      status: 200,
      messageId: data.result?.message_id ?? null,
    };
  } catch (err) {
    return {
      ok: false,
      status: 502,
      message: `텔레그램 API 통신 오류: ${err?.message || '알 수 없는 오류'}`,
    };
  }
}

export async function runTelegramScheduledAlerts(kvStore, options = {}) {
  const cfg = getTelegramConfig(options.config);
  if (!cfg.botToken) {
    return { ok: true, skipped: 'MISSING_BOT_TOKEN', sentCount: 0 };
  }

  const baseNowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const rawShared = await kvStore.get('shared-state');
  const sharedState =
    rawShared && typeof rawShared === 'object' ? rawShared : await readSharedStateOrDefault(kvStore);

  const { effectiveNowMs, serverMeta, candidates } = collectTenMinuteAlertCandidates(sharedState, {
    nowMs: baseNowMs,
    serverId: cfg.serverId,
  });

  // Skip reading/writing dedup state on ~90% of ticks when no boss is near spawning
  if (!candidates.length) {
    return {
      ok: true,
      checkedAtMs: effectiveNowMs,
      serverId: serverMeta.id,
      sentCount: 0,
      candidates: 0,
    };
  }

  const rawAlertState = await kvStore.get(KEY_TELEGRAM_STATE);
  const alertState = sanitizeTelegramAlertState(rawAlertState, effectiveNowMs);
  const unsent = candidates.filter((c) => !alertState.sent[c.alertKey]);

  if (!unsent.length) {
    return {
      ok: true,
      checkedAtMs: effectiveNowMs,
      serverId: serverMeta.id,
      sentCount: 0,
      alreadySent: candidates.length,
    };
  }

  const htmlText = formatTelegramBossAlertHtml(unsent, serverMeta, effectiveNowMs);
  const sendRes = await sendTelegramMessage(cfg.botToken, cfg.chatId, htmlText, options.fetchImpl);
  if (!sendRes.ok) {
    return {
      ok: false,
      error: sendRes.message,
      sentCount: 0,
      chatId: cfg.chatId,
    };
  }

  const nextSent = { ...alertState.sent };
  for (const c of unsent) {
    nextSent[c.alertKey] = effectiveNowMs;
  }

  await kvStore.set(KEY_TELEGRAM_STATE, {
    version: 1,
    sent: nextSent,
    lastSentAtMs: effectiveNowMs,
  });

  return {
    ok: true,
    checkedAtMs: effectiveNowMs,
    serverId: serverMeta.id,
    chatId: cfg.chatId,
    sentCount: unsent.length,
    bossNames: unsent.map((u) => u.bossName),
  };
}

function findNextUpcomingBossSummary(sharedState, serverId, baseNowMs) {
  const { effectiveNowMs, bosses } = prepareServerEvaluationState(sharedState, serverId, baseNowMs);

  let best = null;
  for (const boss of bosses) {
    if (boss.notifyEnabled === false) continue;
    const nextMs = resolveNextSpawnTargetMs(boss, effectiveNowMs);
    if (!Number.isFinite(nextMs) || nextMs < effectiveNowMs) continue;
    if (!best || nextMs < best.targetSpawnMs) {
      best = { boss, targetSpawnMs: nextMs };
    }
  }
  if (!best) return null;

  const dayLabel = formatRelativeDayLabel(best.targetSpawnMs, effectiveNowMs);
  const timeLabel = formatSpawnTimeDisplay(best.targetSpawnMs);
  const lvStr = best.boss.level ? `Lv.${best.boss.level} ` : '';
  return `[${getBossCategoryTag(best.boss)}] ${lvStr}${best.boss.name} (${dayLabel} ${timeLabel})`;
}

export async function handleTelegramTestRequest(req, kvStore, envHostKey = getEnvHostKey(), options = {}) {
  const method = (req.method || 'GET').toUpperCase();
  if (method !== 'POST') {
    return jsonResponse(405, { ok: false, error: 'METHOD_NOT_ALLOWED', message: 'POST 요청만 지원합니다.' });
  }

  const authConfig = await readAuthSafe(kvStore);
  const authStatus = evaluateAuth(req, authConfig, envHostKey);
  if (authStatus.role !== 'host' && authStatus.role !== 'editor') {
    return jsonResponse(401, {
      ok: false,
      error: authStatus.revoked ? 'REVOKED' : 'UNAUTHORIZED',
      message: '테스트 전송은 메인 호스트 또는 편집 권한자만 사용할 수 있습니다.',
    });
  }

  const cfg = getTelegramConfig(options.config);
  if (!cfg.botToken) {
    return jsonResponse(400, {
      ok: false,
      error: 'MISSING_BOT_TOKEN',
      message: 'Netlify 환경변수(TELEGRAM_BOT_TOKEN 또는 eclipse_boss_ba05_bot_token)를 먼저 등록한 뒤 재배포해 주세요.',
    });
  }

  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const sharedState = await readSharedStateOrDefault(kvStore);
  const serverMeta = getServerMeta(cfg.serverId);
  const nextBossSummary = findNextUpcomingBossSummary(sharedState, serverMeta.id, nowMs);

  const lines = [
    `✅ <b>[${escapeTelegramHtml(serverMeta.name)}] 텔레그램 봇 연동 테스트 성공</b>`,
    `👤 요청자: ${escapeTelegramHtml(authStatus.label || '권한자')}`,
    `⏰ 알림 규칙: 보스 출현 <b>10분 전</b> 자동 전송 (2분 주기 체크)`,
    `📢 채널: <code>${escapeTelegramHtml(cfg.chatId)}</code>`,
  ];
  if (nextBossSummary) {
    lines.push(`⚔️ 다음 예정 보스: ${escapeTelegramHtml(nextBossSummary)}`);
  }

  const sendRes = await sendTelegramMessage(cfg.botToken, cfg.chatId, lines.join('\n'), options.fetchImpl);
  if (!sendRes.ok) {
    return jsonResponse(502, {
      ok: false,
      error: 'TELEGRAM_SEND_FAILED',
      message: sendRes.message,
      chatId: cfg.chatId,
    });
  }

  return jsonResponse(200, {
    ok: true,
    chatId: cfg.chatId,
    serverId: serverMeta.id,
    serverName: serverMeta.name,
    messageId: sendRes.messageId,
  });
}
