// 스마트폰 조종기 코드: 서버 연결, 센서 권한, 화면 꺼짐 방지, 진동
import { openPhoneLink } from './net.js';

// ---- 진동 ----
// 안드로이드: Vibration API (navigator.vibrate)
// 아이폰: 사파리는 Vibration API가 없어서, iOS 18+ 에서 스위치를 켤 때 나는
//         시스템 햅틱을 대신 사용 (지원하지 않는 버전에서는 진동 없음)
// 폰 진동 모터는 50ms보다 짧으면 거의 느껴지지 않아서 최소 60ms로 늘림
const MIN_PULSE = 60;
export const haptics = (() => {
  const canVibrate = typeof navigator.vibrate === 'function';
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let iosTap = null;
  if (!canVibrate && isIOS) {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = '__hapticSwitch';
    input.setAttribute('switch', '');
    const label = document.createElement('label');
    label.htmlFor = input.id;
    for (const el of [input, label]) {
      Object.assign(el.style, { position: 'fixed', left: '-9999px', top: '0', opacity: '0', pointerEvents: 'none' });
    }
    document.body.append(input, label);
    iosTap = () => label.click();
  }
  const h = {
    mode: canVibrate ? 'vibrate' : iosTap ? 'ios' : 'none',
    lastOk: null,     // 마지막 진동 요청이 받아들여졌는지 (안드로이드에서 차단되면 false)
    count: 0,         // PC에서 받은 진동 신호 수
    pulse(pattern) {
      const segs = (Array.isArray(pattern) ? pattern : [pattern]).map(Number).filter((v) => v > 0);
      if (!segs.length) return false;
      if (canVibrate) {
        const p = segs.map((v, i) => (i % 2 === 0 ? Math.max(MIN_PULSE, v) : v));
        let ok = false;
        try { ok = navigator.vibrate(p); } catch { ok = false; }
        h.lastOk = ok;
        return ok;
      }
      if (iosTap) {
        let t = 0;
        segs.forEach((v, i) => { if (i % 2 === 0) setTimeout(iosTap, t); t += v; });
        h.lastOk = true;
        return true;
      }
      h.lastOk = false;
      return false;
    },
  };
  return h;
})();

// room 이 있으면 인터넷 직접 연결(웹 모드), 없으면 같은 Wi‑Fi의 PC 서버에 연결(로컬 모드)
export function createController({ room = null, onStatus, onFeedback }) {
  const listeners = [];
  let link = null;
  openPhoneLink({
    room,
    onStatus: (s) => onStatus && onStatus(s),
    onMessage: (m) => {
      if (m.type !== 'feedback') return;
      if (m.vibrate) { haptics.count++; haptics.pulse(m.vibrate); }
      onFeedback && onFeedback(m);
    },
  }).then((l) => { link = l; }).catch(() => onStatus && onStatus({ server: false, display: false }));

  function send(obj) {
    if (link) link.send(obj);
  }

  // ---- 센서 ----
  const raw = { alpha: 0, beta: 0, gamma: 0, ok: false };
  function onOrient(e) {
    if (e.beta == null) return;
    raw.alpha = e.alpha || 0;
    raw.beta = e.beta;
    raw.gamma = e.gamma;
    raw.ok = true;
    listeners.forEach((f) => f(raw));
  }

  async function start() {
    // iOS 13+ 는 사용자 터치 후 권한 요청이 필요
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      const r = await DeviceOrientationEvent.requestPermission();
      if (r !== 'granted') throw new Error('기울기 센서 권한이 거부되었습니다.');
    }
    if (!window.isSecureContext) {
      throw new Error('HTTPS 주소(https://...)로 접속해야 센서를 쓸 수 있습니다.');
    }
    window.addEventListener('deviceorientation', onOrient);
    // 화면 꺼짐 방지
    try {
      if ('wakeLock' in navigator) {
        let lock = await navigator.wakeLock.request('screen');
        document.addEventListener('visibilitychange', async () => {
          if (document.visibilityState === 'visible') lock = await navigator.wakeLock.request('screen');
        });
      }
    } catch { /* 지원하지 않는 기기 */ }
    // 세로 화면 고정 시도 (전체화면일 때만 되는 기기가 많음)
    try {
      if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
      if (screen.orientation && screen.orientation.lock) await screen.orientation.lock('portrait');
    } catch { /* 무시 */ }

    // 1.5초 안에 센서 값이 안 들어오면 알려줌
    await new Promise((r) => setTimeout(r, 1500));
    if (!raw.ok) throw new Error('기울기 센서 값이 들어오지 않습니다. 이 기기/브라우저는 센서를 지원하지 않을 수 있어요.');
  }

  return {
    send,
    start,
    raw,
    onSensor: (f) => listeners.push(f),
  };
}

// 데드존과 최대 각도를 적용해 -1 ~ 1 로 변환
export function axis(deg, dead, max) {
  const s = Math.sign(deg);
  const a = Math.abs(deg);
  if (a < dead) return 0;
  return s * Math.min(1, (a - dead) / (max - dead));
}

// 각도 차이를 -180~180 으로
export function angleDiff(a, b) {
  let d = a - b;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}
