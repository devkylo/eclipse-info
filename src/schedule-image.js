import {
  isWorldBoss,
  isBossRedAlert,
  normalizeFixedTimes,
  getEffectiveActiveSec,
  getWorldBossWindow,
  getEffectiveKillSec,
  getEffectiveRespawnSec,
  getAfterNextSpawnMs,
  getBossStatus,
  sortBosses,
  pad2,
  formatTimeHHMM,
  formatRelativeDayLabel,
  formatDurationKorean,
  formatCountdownText,
} from './calculator.js';

const FONT_SANS = "'Pretendard', 'Malgun Gothic', 'Apple SD Gothic Neo', 'Segoe UI', sans-serif";
const FONT_MONO = "'Consolas', 'JetBrains Mono', 'Malgun Gothic', monospace";

function drawRoundedRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function getStatusVisual(status) {
  switch (status) {
    case 'world_active':
    case 'spawning_now':
      return {
        pillBg: 'rgba(239, 68, 68, 0.28)',
        pillBorder: 'rgba(239, 68, 68, 0.8)',
        pillText: '#fecaca',
        timeColor: '#f87171',
        label: '출현 중!',
      };
    case 'imminent':
      return {
        pillBg: 'rgba(239, 68, 68, 0.24)',
        pillBorder: 'rgba(239, 68, 68, 0.72)',
        pillText: '#fecaca',
        timeColor: '#fca5a5',
        label: null,
      };
    case 'upcoming':
      return {
        pillBg: 'rgba(59, 130, 246, 0.22)',
        pillBorder: 'rgba(59, 130, 246, 0.6)',
        pillText: '#93c5fd',
        timeColor: '#f8fafc',
        label: null,
      };
    case 'overdue':
    case 'unscheduled':
      return {
        pillBg: 'rgba(148, 163, 184, 0.16)',
        pillBorder: 'rgba(148, 163, 184, 0.35)',
        pillText: '#cbd5e1',
        timeColor: '#94a3b8',
        label: null,
      };
    default:
      return {
        pillBg: 'rgba(148, 163, 184, 0.14)',
        pillBorder: 'rgba(148, 163, 184, 0.3)',
        pillText: '#cbd5e1',
        timeColor: '#f8fafc',
        label: null,
      };
  }
}

function formatDateHeader(ms) {
  const d = new Date(ms);
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} (${days[d.getDay()]}) ${pad2(d.getHours())}:${pad2(d.getMinutes())} 기준`;
}

function truncateText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let clipped = text;
  while (clipped.length > 1 && ctx.measureText(`${clipped}…`).width > maxWidth) {
    clipped = clipped.slice(0, -1);
  }
  return `${clipped}…`;
}

/**
 * Render the boss spawn schedule into a high-DPI HTMLCanvasElement.
 */
export function renderScheduleCanvas(bosses, nowMs = Date.now(), options = {}) {
  const showCountdown = options.showCountdown !== false;
  const serverName = options.serverName || '';
  const sorted = sortBosses(bosses, 'soonest', nowMs);

  const width = 760;
  const padX = 24;
  const padTop = 22;
  const headerH = 58;
  const rowH = 68;
  const rowGap = 10;
  const footerH = 38;
  const rowsHeight = sorted.length > 0 ? sorted.length * rowH + (sorted.length - 1) * rowGap : 72;
  const height = padTop + headerH + rowsHeight + 16 + footerH;

  const scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = height * scale;

  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);

  const bgGrad = ctx.createLinearGradient(0, 0, width, height);
  bgGrad.addColorStop(0, '#0b1220');
  bgGrad.addColorStop(1, '#111a2e');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, width, height);

  drawRoundedRect(ctx, 8, 8, width - 16, height - 16, 14);
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
  ctx.lineWidth = 1;
  ctx.stroke();

  drawRoundedRect(ctx, padX, padTop + 2, 42, 26, 7);
  const badgeGrad = ctx.createLinearGradient(padX, padTop, padX + 42, padTop + 28);
  badgeGrad.addColorStop(0, '#f59e0b');
  badgeGrad.addColorStop(1, '#ef4444');
  ctx.fillStyle = badgeGrad;
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.font = `800 11px ${FONT_SANS}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText('BOSS', padX + 21, padTop + 15);

  ctx.textAlign = 'left';
  ctx.fillStyle = '#f8fafc';
  ctx.font = `800 20px ${FONT_SANS}`;
  const headerTitle = '보스 출현 예상 시간표';
  ctx.fillText(headerTitle, padX + 52, padTop + 16);

  if (serverName) {
    const titleW = ctx.measureText(headerTitle).width;
    const pillX = padX + 52 + titleW + 10;
    ctx.font = `700 12px ${FONT_SANS}`;
    const srvW = ctx.measureText(serverName).width + 18;
    drawRoundedRect(ctx, pillX, padTop + 4, srvW, 23, 11);
    ctx.fillStyle = 'rgba(59, 130, 246, 0.2)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(59, 130, 246, 0.55)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#93c5fd';
    ctx.textAlign = 'center';
    ctx.fillText(serverName, pillX + srvW / 2, padTop + 16);
  }

  ctx.textAlign = 'right';
  ctx.fillStyle = '#94a3b8';
  ctx.font = `600 13px ${FONT_MONO}`;
  ctx.fillText(formatDateHeader(nowMs), width - padX, padTop + 16);

  ctx.strokeStyle = 'rgba(148, 163, 184, 0.16)';
  ctx.beginPath();
  ctx.moveTo(padX, padTop + 44);
  ctx.lineTo(width - padX, padTop + 44);
  ctx.stroke();

  let cursorY = padTop + headerH;

  if (!sorted.length) {
    drawRoundedRect(ctx, padX, cursorY, width - padX * 2, 72, 11);
    ctx.fillStyle = '#151e30';
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.fillStyle = '#94a3b8';
    ctx.font = `600 14px ${FONT_SANS}`;
    ctx.fillText('등록된 보스가 없습니다.', width / 2, cursorY + 36);
    cursorY += 72;
  } else {
    sorted.forEach((boss, idx) => {
      const y = cursorY + idx * (rowH + rowGap);
      const cardW = width - padX * 2;
      const status = getBossStatus(boss, nowMs);
      const isRed = isBossRedAlert(boss, nowMs);
      const vis = getStatusVisual(status);
      const world = isWorldBoss(boss);

      drawRoundedRect(ctx, padX, y, cardW, rowH, 11);
      ctx.fillStyle = isRed ? '#2a1219' : '#151f33';
      ctx.fill();
      ctx.strokeStyle = isRed ? 'rgba(239, 68, 68, 0.72)' : 'rgba(148, 163, 184, 0.18)';
      ctx.lineWidth = isRed ? 1.5 : 1;
      ctx.stroke();

      ctx.save();
      drawRoundedRect(ctx, padX, y, cardW, rowH, 11);
      ctx.clip();
      ctx.fillStyle = isRed ? '#ef4444' : boss.color || '#3b82f6';
      ctx.fillRect(padX, y, 6, rowH);
      ctx.restore();

      // Type badge ([월드] or [필드])
      const textX = padX + 20;
      const typeTag = world ? '월드' : '필드';
      ctx.font = `700 11px ${FONT_SANS}`;
      const tagW = ctx.measureText(typeTag).width + 12;
      drawRoundedRect(ctx, textX, y + 12, tagW, 20, 6);
      ctx.fillStyle = world ? 'rgba(168, 85, 247, 0.24)' : 'rgba(59, 130, 246, 0.2)';
      ctx.fill();
      ctx.strokeStyle = world ? 'rgba(168, 85, 247, 0.6)' : 'rgba(59, 130, 246, 0.45)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = world ? '#e9d5ff' : '#bfdbfe';
      ctx.textAlign = 'center';
      ctx.fillText(typeTag, textX + tagW / 2, y + 22);

      // Boss Level + Name
      let nameX = textX + tagW + 8;
      ctx.textAlign = 'left';
      if (boss.level) {
        const lvStr = `Lv.${boss.level}`;
        ctx.fillStyle = '#fcd34d';
        ctx.font = `700 13px ${FONT_SANS}`;
        ctx.fillText(lvStr, nameX, y + 23);
        nameX += ctx.measureText(lvStr).width + 6;
      }

      ctx.fillStyle = '#f8fafc';
      ctx.font = `700 17px ${FONT_SANS}`;
      const nameStr = boss.name;
      ctx.fillText(nameStr, nameX, y + 23);

      const nameW = ctx.measureText(nameStr).width;
      if (boss.memo) {
        ctx.fillStyle = '#94a3b8';
        ctx.font = `500 12px ${FONT_SANS}`;
        const maxMemoW = Math.max(40, 210 - nameW);
        ctx.fillText(truncateText(ctx, `· ${boss.memo}`, maxMemoW), nameX + nameW + 8, y + 24);
      }

      // Line 2 + Right Time
      const rightEdge = padX + cardW - 16;
      let subLine = '';
      let timeText = '';
      let badgeText = '';

      if (world) {
        const win = getWorldBossWindow(boss, nowMs);
        const timesStr = normalizeFixedTimes(boss.fixedTimes).join(', ') || '미설정';
        const durStr = formatDurationKorean(getEffectiveActiveSec(boss));
        if (win.isActiveNow) {
          subLine = `고정 ${timesStr}  ·  ${durStr} 유지  ·  ${formatTimeHHMM(win.windowStartMs)} ~ ${formatTimeHHMM(win.windowEndMs)}`;
          timeText = `~${formatTimeHHMM(win.windowEndMs)} 종료`;
          badgeText = `출현 중 (${formatCountdownText(win.windowEndMs - nowMs).replace(/ 후$/, ' 남음')})`;
        } else if (Number.isFinite(win.nextStartMs)) {
          subLine = `고정 ${timesStr}  ·  ${durStr} 출현`;
          timeText = `${formatRelativeDayLabel(win.nextStartMs, nowMs)} ${formatTimeHHMM(win.nextStartMs)}`;
          badgeText = formatCountdownText(win.nextStartMs - nowMs);
        } else {
          subLine = `고정 시간 미설정  ·  ${durStr} 출현`;
          timeText = '시간 미설정';
          badgeText = '대기';
        }
      } else {
        const isUnset = boss.killDurationSec === null || boss.killDurationSec === undefined;
        const killText = isUnset ? '처치 미정(0분)' : `처치 ${formatDurationKorean(getEffectiveKillSec(boss))}`;
        const respawnText = `리스폰 ${formatDurationKorean(getEffectiveRespawnSec(boss))}`;
        const afterMs = getAfterNextSpawnMs(boss, nowMs);
        const afterDay = formatRelativeDayLabel(afterMs, nowMs);
        const afterPrefix = afterDay === '오늘' ? '' : `${afterDay} `;
        subLine = `${killText}  ·  ${respawnText}  ·  다음 젠 ${afterPrefix}${formatTimeHHMM(afterMs)}`;
        timeText = `${formatRelativeDayLabel(boss.nextSpawnMs, nowMs)} ${formatTimeHHMM(boss.nextSpawnMs)}`;
        badgeText = vis.label || formatCountdownText(boss.nextSpawnMs - nowMs);
      }

      ctx.fillStyle = isRed ? '#fca5a5' : '#94a3b8';
      ctx.font = `500 12px ${FONT_SANS}`;
      ctx.fillText(subLine, textX, y + 47);

      ctx.textAlign = 'right';
      ctx.fillStyle = vis.timeColor;
      ctx.font = `800 19px ${FONT_MONO}`;
      ctx.fillText(timeText, rightEdge, showCountdown ? y + 24 : y + 35);

      if (showCountdown) {
        ctx.font = `700 11.5px ${FONT_SANS}`;
        const pillTextW = ctx.measureText(badgeText).width;
        const pillW = pillTextW + 18;
        const pillH = 22;
        const pillX = rightEdge - pillW;
        const pillY = y + 37;

        drawRoundedRect(ctx, pillX, pillY, pillW, pillH, 11);
        ctx.fillStyle = vis.pillBg;
        ctx.fill();
        ctx.strokeStyle = vis.pillBorder;
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.textAlign = 'center';
        ctx.fillStyle = vis.pillText;
        ctx.fillText(badgeText, pillX + pillW / 2, pillY + 11.5);
      }
    });
    cursorY += rowsHeight;
  }

  const footerY = cursorY + 28;
  ctx.textAlign = 'left';
  ctx.fillStyle = '#64748b';
  ctx.font = `600 11.5px ${FONT_SANS}`;
  ctx.fillText(`총 ${sorted.length}종 보스 · 월드 보스 / 필드 보스 통합 시간표`, padX, footerY);

  ctx.textAlign = 'right';
  ctx.fillText('이클립스: 더 어웨이크닝 · 보스 타이머', width - padX, footerY);

  return canvas;
}

export function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('PNG 이미지 생성에 실패했습니다.'));
    }, 'image/png');
  });
}

export async function copyPngBlobToClipboard(blob) {
  if (
    typeof ClipboardItem === 'undefined' ||
    !navigator.clipboard ||
    typeof navigator.clipboard.write !== 'function'
  ) {
    return false;
  }
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    return true;
  } catch {
    return false;
  }
}
