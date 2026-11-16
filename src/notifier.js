/**
 * Handles Web Audio sound alerts, Browser Desktop Notifications, and optional TTS.
 */

let audioCtx = null;

function ensureAudioContext() {
  if (typeof window === 'undefined') return null;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!audioCtx) {
    audioCtx = new Ctx();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

export function unlockAudioOnGesture() {
  if (typeof document === 'undefined') return;
  const unlock = () => {
    ensureAudioContext();
    document.removeEventListener('pointerdown', unlock);
    document.removeEventListener('keydown', unlock);
  };
  document.addEventListener('pointerdown', unlock, { once: true });
  document.addEventListener('keydown', unlock, { once: true });
}

function playTone(ctx, { freq, startOffset = 0, duration = 0.25, type = 'sine', volume = 0.4 }) {
  const now = ctx.currentTime + startOffset;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(freq, now);

  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.001, volume), now + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start(now);
  osc.stop(now + duration + 0.02);
}

export function playAlertSound(preset = 'chime', volume = 0.7) {
  const ctx = ensureAudioContext();
  if (!ctx) return false;
  const vol = Math.min(1, Math.max(0.05, Number(volume) || 0.7)) * 0.45;

  try {
    if (preset === 'bell') {
      playTone(ctx, { freq: 880, startOffset: 0, duration: 0.45, type: 'triangle', volume: vol });
      playTone(ctx, { freq: 1318.5, startOffset: 0.16, duration: 0.55, type: 'triangle', volume: vol * 0.85 });
      return true;
    }
    if (preset === 'pulse') {
      playTone(ctx, { freq: 740, startOffset: 0, duration: 0.14, type: 'square', volume: vol * 0.45 });
      playTone(ctx, { freq: 740, startOffset: 0.18, duration: 0.14, type: 'square', volume: vol * 0.45 });
      playTone(ctx, { freq: 987.77, startOffset: 0.36, duration: 0.28, type: 'triangle', volume: vol * 0.8 });
      return true;
    }
    if (preset === 'alarm') {
      playTone(ctx, { freq: 987.77, startOffset: 0, duration: 0.18, type: 'sawtooth', volume: vol * 0.45 });
      playTone(ctx, { freq: 1174.66, startOffset: 0.2, duration: 0.18, type: 'sawtooth', volume: vol * 0.45 });
      playTone(ctx, { freq: 987.77, startOffset: 0.42, duration: 0.18, type: 'sawtooth', volume: vol * 0.45 });
      playTone(ctx, { freq: 1318.51, startOffset: 0.62, duration: 0.36, type: 'sawtooth', volume: vol * 0.5 });
      return true;
    }
    // Default: 'chime'
    playTone(ctx, { freq: 587.33, startOffset: 0, duration: 0.28, type: 'sine', volume: vol });
    playTone(ctx, { freq: 783.99, startOffset: 0.12, duration: 0.32, type: 'sine', volume: vol });
    playTone(ctx, { freq: 1046.5, startOffset: 0.24, duration: 0.5, type: 'sine', volume: vol * 0.9 });
    return true;
  } catch {
    return false;
  }
}

export function getNotificationPermission() {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

export async function requestNotificationPermission() {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission || 'denied';
  }
}

export function sendDesktopNotification(title, body, tag) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
    return false;
  }
  try {
    const n = new Notification(title, {
      body,
      tag,
      requireInteraction: false,
      silent: true, // We handle custom Web Audio sound ourselves
    });
    n.onclick = () => {
      try {
        window.focus();
      } catch {
        // Ignore focus errors
      }
      n.close();
    };
    setTimeout(() => {
      try {
        n.close();
      } catch {
        // Ignore
      }
    }, 10000);
    return true;
  } catch {
    return false;
  }
}

export function speakKoreanAlert(text) {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return false;
  try {
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'ko-KR';
    utter.rate = 1.05;
    utter.pitch = 1.0;
    window.speechSynthesis.speak(utter);
    return true;
  } catch {
    return false;
  }
}
