// 웹캠 손 조종
//
// MediaPipe 로 손(21점)과 몸(어깨·손목)을 인식해서 로봇 집게의 '목표 위치'로 바꿉니다.
//   - 손을 오른쪽/왼쪽으로                 → 베이스 회전
//   [손목 방식 · 기본] 사람 팔이 로봇팔을 따라 하는 방식
//   - 팔꿈치를 굽혀 손 올리기/내리기        → 로봇 어깨 (위팔 세우기/눕히기)
//   - 손목을 꺾어 손바닥 숙이기/젖히기      → 로봇 팔꿈치 (아래팔 내리기/올리기)
//   [팔꿈치 방식 · 기본] 위팔 각도로 로봇 어깨, 손목 꺾기로 로봇 팔꿈치
//   - 팔꿈치를 옆으로 들어 위팔을 수평 쪽으로 → 로봇 위팔이 수평 쪽으로 눕기 (내 몸통 = 로봇 기둥)
//   - 회전은 팔꿈치를 기준으로 손을 좌우로 (팔꿈치를 들어도 회전이 바뀌지 않게)
//   [위치 방식 · 이전] 손 높이 → 집게 높이, 손을 화면 쪽으로 밀기/당기기 → 집게 앞뒤
//   - 손 쥐기(주먹) 또는 엄지·검지 집기      → 집기, 손 펴기 → 놓기
// 처음에 오른손/왼손을 고르고, 화면의 안내(목표 동그라미·체크리스트)에 맞춰 기준 자세를 보정합니다.

const MP_VER = '0.10.14';
const MP_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}`;
const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const POSE_MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const SIDE_KEY = 'tiltarm-hand-side';
const SENS_KEY = 'tiltarm-hand-sens';
const PALM_KEY = 'tiltarm-hand-palm-invert';
const SCHEME_KEY = 'tiltarm-hand-scheme';

// 손 뼈대 연결선 (그리기용)
const HAND_LINKS = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];
const TIPS = [8, 12, 16, 20];

// 보정 기준
export const CAL = {
  shoulderMin: 0.18, shoulderMax: 0.75,   // 어깨 너비(화면 세로 기준 비율): 너무 작으면 멀고, 크면 가까움
  openMin: 1.45,                           // 손가락을 편 정도 (손끝~손목 / 손바닥 길이)
  targetDown: 0.15, targetR: 0.45,         // 목표 동그라미: 어깨보다 어깨너비×0.15 아래, 반지름 어깨너비×0.45
  holdSec: 1.0, captureSec: 1.0,           // 모두 맞은 채 1초 유지 → 1초 동안 기록
  centerTol: 0.17,
  elbowDownMax: -50 * Math.PI / 180,      // 팔꿈치 방식: 보정 때 위팔이 이보다 아래로 (몸 옆에 내림)                         // 몸 중심이 화면 가운데에서 이만큼(가로의 비율) 안이면 OK
};

// ---------------- 계산 (화면·카메라와 상관없는 부분, 시험하기 쉽게 분리) ----------------
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const sideName = (side) => (side === 'left' ? '왼손' : '오른손');

// 한 프레임의 인식 결과 → 몸·손 특징값
// hands: [[{x,y},...21]] (정규화 좌표), pose: [{x,y,visibility},...33] | null, side: 'right'|'left', aspect: 가로/세로
// worlds: 손의 3D 좌표(미터, MediaPipe worldLandmarks) — 있으면 손목 꺾임·손 쥠을 더 정확히 계산
export function measure({ hands, worlds = null, pose, side, aspect = 4 / 3, invertPalm = false }) {
  const iso = (p) => ({ x: p.x * aspect, y: p.y });   // 가로·세로 비율을 맞춘 좌표
  const out = { ok: false, aspect, poseOk: false, center: null, scale: null, sideShoulder: null };
  let sideWrist = null;
  if (pose && pose.length > 16) {
    const vis = (i) => pose[i].visibility == null || pose[i].visibility > 0.5;
    const ls = iso(pose[11]), rs = iso(pose[12]);
    out.poseOk = vis(11) && vis(12);
    out.center = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
    out.scale = Math.max(0.05, dist(ls, rs));         // 어깨 너비 = 길이의 기준
    out.sideShoulder = side === 'right' ? rs : ls;    // (몸의 왼쪽/오른쪽 = 사람 기준)
    out.shoulders = [ls, rs];
    sideWrist = iso(pose[side === 'right' ? 16 : 15]);
    // 고른 쪽 팔꿈치: 위팔(어깨→팔꿈치)이 수평과 이루는 각도 (아래로 늘어뜨리면 -90°, 수평이면 0°)
    const ei = side === 'right' ? 14 : 13;
    const el = iso(pose[ei]);
    out.elbow = el;
    out.elbowOk = out.poseOk && vis(ei);
    out.elev = Math.atan2(-(el.y - out.sideShoulder.y), Math.abs(el.x - out.sideShoulder.x));
    out.forearmLen = dist(el, sideWrist);
  }
  if (!hands || !hands.length) return { ...out, reason: 'nohand' };
  // 고른 손: 몸 인식이 있으면 그쪽 손목에 가장 가까운 손, 없으면 첫 번째 손
  let pick = hands[0];
  if (sideWrist && hands.length > 1) {
    let best = Infinity;
    for (const h of hands) { const d = dist(iso(h[0]), sideWrist); if (d < best) { best = d; pick = h; } }
  } else if (sideWrist && dist(iso(pick[0]), sideWrist) > 0.25 * aspect) {
    return { ...out, reason: 'otherhand', raw: pick };   // 보이는 손이 고른 손이 아님
  }
  const P = pick.map(iso);
  const palm = Math.max(1e-4, dist(P[0], P[9]));       // 손목 ~ 가운뎃손가락 뿌리
  let open = TIPS.reduce((s, i) => s + dist(P[0], P[i]), 0) / TIPS.length / palm;   // 손 펴짐 정도
  let pinch = dist(P[4], P[8]) / palm;                // 엄지·검지 끝 거리
  // 손 기울기(손목 꺾임): 손목→가운뎃손가락 뿌리 방향이 위(0)에서 카메라 쪽으로 얼마나 숙었는지 (라디안, 숙이면 +)
  let pitch = null;
  const fore = dist(P[0], P[9]) / Math.max(1e-4, dist(P[5], P[17]));   // (3D 좌표가 없을 때) 손이 숙으면 짧아 보임
  const W = worlds && worlds[hands.indexOf(pick)];
  if (W && W.length > 20) {
    const d3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
    const pl = Math.max(1e-4, d3(W[0], W[9]));
    // 3D 로 재면 손을 숙여 손가락이 짧아 보여도 쥠/폄을 잘못 판단하지 않음
    open = TIPS.reduce((s, i) => s + d3(W[0], W[i]), 0) / TIPS.length / pl;
    pinch = d3(W[4], W[8]) / pl;
    pitch = Math.atan2(-((W[9].z || 0) - (W[0].z || 0)), -(W[9].y - W[0].y));   // z: 카메라에 가까울수록 작음
  }
  const hand = { x: (P[0].x + P[9].x) / 2, y: (P[0].y + P[9].y) / 2 };
  // 손바닥 방향: 손목→검지 뿌리, 손목→새끼 뿌리 두 벡터의 회전 방향으로 판단
  // (좌우 반전 안 한 영상에서 오른손 손바닥이 카메라를 보면 음수, 왼손이면 양수)
  const cross = (P[5].x - P[0].x) * (P[17].y - P[0].y) - (P[5].y - P[0].y) * (P[17].x - P[0].x);
  const facing = side === 'right' ? cross < 0 : cross > 0;
  const palmFacing = invertPalm ? !facing : facing;   // 카메라마다 좌우가 다를 수 있어 자동으로 뒤집을 수 있게
  const center = out.center || { x: 0.5 * aspect, y: 0.45 };
  const scale = out.scale || 0.25 * aspect;
  return {
    ...out,
    ok: true,
    // 원본(좌우 반전 안 한) 카메라 영상에서는 사용자의 오른쪽이 화면 왼쪽 → center - hand 가 '오른쪽' 방향
    dx: (center.x - hand.x) / scale,
    dy: (center.y - hand.y) / scale,                   // 위쪽이 +
    palm, open, pinch, hand, palmFacing, pitch, fore, raw: pick,
  };
}

// 보정 자세 점검: 목표 동그라미 위치와 6가지 체크 (화면 안내용)
export function calibChecks(m, side, scheme = 'wrist') {
  const target = m.sideShoulder && m.scale
    ? { x: m.sideShoulder.x, y: m.sideShoulder.y + CAL.targetDown * m.scale, r: CAL.targetR * m.scale }
    : null;
  const sh = m.scale ? m.scale : 0;   // 어깨 너비 (화면 세로=1 기준)
  const handIn = !!(target && m.ok && dist(m.hand, target) < target.r);
  const checks = [
    { k: 'body', ok: m.poseOk, good: '양쪽 어깨가 보여요', bad: '양쪽 어깨가 화면에 나오게 앉아 주세요' },
    { k: 'dist', ok: m.poseOk && sh >= CAL.shoulderMin && sh <= CAL.shoulderMax, good: '카메라와 거리가 알맞아요',
      bad: sh > CAL.shoulderMax ? '카메라에서 조금 멀어져 주세요' : '카메라에 조금 가까이 와 주세요' },
    { k: 'center', ok: m.poseOk && Math.abs(m.center.x / m.aspect - 0.5) <= CAL.centerTol, good: '화면 가운데에 있어요',
      // 거울 화면 기준: 원본 영상에서 몸이 왼쪽(x 작음)이면 거울 화면에서는 오른쪽에 보임 → 왼쪽으로 옮기라고 안내
      bad: m.center && m.center.x / m.aspect < 0.5 ? '화면 가운데로 (왼쪽으로) 조금 옮겨 주세요' : '화면 가운데로 (오른쪽으로) 조금 옮겨 주세요' },
    { k: 'hand', ok: m.ok, good: `${sideName(side)}이 보여요`,
      bad: m.reason === 'otherhand' ? `다른 손이 보여요. ${sideName(side)}을 들어 주세요` : `${sideName(side)}을 카메라에 보여 주세요` },
    { k: 'palm', ok: m.ok && m.palmFacing, good: '손바닥이 카메라를 봐요', bad: '손바닥이 카메라를 보게 돌려 주세요' },
    { k: 'open', ok: m.ok && m.open >= CAL.openMin, good: '손가락을 활짝 폈어요', bad: '손가락을 위로 활짝 펴 주세요' },
    { k: 'place', ok: handIn, good: '손이 동그라미 안에 있어요', bad: '손을 동그라미 안으로 옮겨 주세요' },
  ];
  if (scheme === 'elbow') {
    checks.push({ k: 'elbow', ok: !!m.elbowOk && m.elev <= CAL.elbowDownMax, good: '팔꿈치를 몸 옆에 내렸어요',
      bad: !m.elbowOk ? '팔꿈치가 화면에 나오게 조금 멀어져 주세요' : '팔꿈치를 몸 옆으로 내려 주세요' });
  }
  return { checks, allOk: checks.every((c) => c.ok), target, firstBad: checks.find((c) => !c.ok) };
}

// 손 위치 → 회전·높이 계산 기준
// 보정 때의 손 위치(기준점)에서 화면 끝(여백 제외)까지 남은 공간을 재 두고,
// 그 공간 안에서 로봇 회전 전체(±170°)와 높이 전체가 나오게 맞춤 → 손이 화면 밖으로 나갈 필요가 없음
export const MAP = {
  margin: 0.08,                 // 화면 가장자리 여백 (이 안쪽까지만 쓰면 됨)
  yawMax: 170 * Math.PI / 180,  // 화면 끝에 손이 닿으면 이만큼 회전
  curve: 1.35,                  // 가운데 근처는 천천히, 끝으로 갈수록 크게 (정밀 조종용)
  hNeutral: 1.3, hMin: 0.6, hMax: 2.4,
  // 손목 방식: 손 높이 → 로봇 어깨 각도(도), 손 기울기 → 로봇 아래팔 방향(도, 수평=0, 아래 -)
  shMid: 85, shUp: 150, shDown: 5,
  foreMid: -10,                 // 보정 자세(손가락 위)일 때 로봇 아래팔 방향 = 시작 자세와 같게
  pitchMin: -55, pitchMax: 95,  // 손 기울기 사용 범위 (보정 자세 기준, 숙이면 +)
  pitchGain: 1.0,
  // 팔꿈치 방식: 보정 자세(위팔 내림) → 로봇 어깨 85°, 위팔 수평 → 5° (로봇 위팔도 수평)
  elevUpGain: 1.5,              // 보정 자세보다 더 내리면 로봇 위팔이 뒤로 (거의 안 씀)
  yawForearm: 0.75,             // 팔꿈치 기준 손 좌우: 아래팔 길이의 이만큼 움직이면 끝까지 회전 (아래팔 약 50° 기울임)
};
export const DEG = Math.PI / 180;
// 기준점에서 각 방향 화면 끝까지 남은 공간 (가로·세로 비율을 맞춘 좌표)
export function rangeBox(calib) {
  const A = calib.aspect, mx = MAP.margin * A, my = MAP.margin;
  const h0 = calib.hand0;
  return {
    left: mx, right: A - mx, top: my, bottom: 1 - my,          // 화면(원본 영상) 기준 사용 범위
    roomR: Math.max(0.05, h0.x - mx),                           // 사용자 오른쪽 = 원본 영상의 왼쪽
    roomL: Math.max(0.05, A - mx - h0.x),
    roomUp: Math.max(0.05, h0.y - my),
    roomDown: Math.max(0.05, 1 - my - h0.y),
  };
}

// 보정값 + 특징값 → 로봇 집게 목표 (yawRight 라디안, reach/height 시뮬레이터 단위), grip 0/1
// scheme: 'elbow'(팔꿈치 방식) | 'wrist'(손목 방식, 로봇 관절 각도로 바로) | 'pos'(위치 방식, 집게 위치 → 역기구학)
export function toTarget(m, calib, sens = 1, prevGrip = 0, scheme = 'wrist') {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const dz = Math.log(m.palm / calib.palm);           // 손을 밀면 손바닥이 커짐 → +
  const R = rangeBox(calib);
  // 좌우: 기준점에서 오른쪽(+)/왼쪽(-)으로 남은 공간 대비 몇 % 움직였는지 → 회전
  let u = calib.hand0.x - m.hand.x;
  u = clamp((u > 0 ? u / R.roomR : u / R.roomL) * sens, -1, 1);
  if (scheme === 'elbow' && m.relX != null && calib.rel0 != null) {
    // 팔꿈치 기준 손 위치로 회전 → 팔꿈치를 옆으로 들어도(손이 같이 옮겨져도) 회전은 그대로
    u = clamp((calib.rel0 - m.relX) / (MAP.yawForearm * calib.fl0) * sens, -1, 1);
  }
  const yawRight = Math.sign(u) * MAP.yawMax * Math.pow(Math.abs(u), MAP.curve);
  // 위아래: 남은 공간 대비 → 높이
  let v = calib.hand0.y - m.hand.y;
  v = clamp((v > 0 ? v / R.roomUp : v / R.roomDown) * sens, -1, 1);
  const height = v > 0 ? MAP.hNeutral + v * (MAP.hMax - MAP.hNeutral) : MAP.hNeutral + v * (MAP.hNeutral - MAP.hMin);
  const reach = clamp(1.85 + dz * 2.2 * sens, 1.05, 2.85);
  const openRatio = m.open / calib.open;
  // 쥐면 닫힘, 펴면 열림 (경계에서 깜빡이지 않게 문턱을 두 개로)
  let grip = prevGrip;
  if (openRatio < 0.62 || m.pinch < 0.28) grip = 1;
  else if (openRatio > 0.78 && m.pinch > 0.4) grip = 0;
  // 손목 방식: 위팔 = 손 높이, 아래팔 = 손 기울기 (사람 아래팔·손이 로봇 위팔·아래팔을 따라 하는 느낌)
  let shoulder = (v > 0 ? MAP.shMid + v * (MAP.shUp - MAP.shMid) : MAP.shMid + v * (MAP.shMid - MAP.shDown)) * DEG;
  let gv = v;   // 옆 게이지 (-1~1)
  if (scheme === 'elbow' && m.elev != null && calib.elev0 != null) {
    // 위팔 각도: 보정 자세 → 로봇 85°, 수평(0°) → 로봇 5°. 사이는 비례
    const d = (m.elev - calib.elev0) * sens;
    const span = Math.max(30 * DEG, -calib.elev0);
    const deg = d >= 0 ? MAP.shMid - (d / span) * (MAP.shMid - MAP.shDown) : MAP.shMid - d / DEG * MAP.elevUpGain;
    const c = Math.max(MAP.shDown, Math.min(MAP.shUp, deg));
    shoulder = c * DEG;
    gv = c >= MAP.shMid ? (c - MAP.shMid) / (MAP.shUp - MAP.shMid) : (c - MAP.shMid) / (MAP.shMid - MAP.shDown);
  }
  const pr = clamp(pitchRel(m, calib) * sens, MAP.pitchMin * DEG, MAP.pitchMax * DEG);
  const fore = MAP.foreMid * DEG - pr * MAP.pitchGain;   // 아래팔 방향 (수평 기준)
  return { scheme, yawRight, height, reach, shoulder, fore, pitchRel: pr, grip, openRatio, dz, u, v, gv };
}
// 보정 자세 대비 손 기울기 (숙이면 +)
export function pitchRel(m, calib) {
  if (m.pitch != null && calib.pitch0 != null) return m.pitch - calib.pitch0;
  // 3D 좌표가 없으면 손이 짧아 보이는 정도로 (방향은 숙임으로 가정)
  if (m.fore && calib.fore0) return Math.acos(Math.max(0, Math.min(1, m.fore / calib.fore0)));
  return 0;
}

// 보정 자세 그림 (거울처럼 보이는 화면 기준: 오른손이면 화면 오른쪽 손을 듦)
function poseFigure(side) {
  const flip = side === 'left' ? ' style="transform:scaleX(-1)"' : '';
  return `<svg class="cal-fig" viewBox="0 0 120 130"${flip} aria-hidden="true">
    <circle cx="52" cy="26" r="13" fill="none" stroke="#fff" stroke-width="3.5"/>
    <path d="M52 39 V92 M30 54 H74 M30 54 L24 92 M52 92 L40 124 M52 92 L64 124" stroke="#fff" stroke-width="3.5" fill="none" stroke-linecap="round"/>
    <path d="M74 54 L90 72 L92 48" stroke="#38d6ff" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="85" y="30" width="15" height="17" rx="5" fill="#38d6ff"/>
    <path d="M87 31 V18 M91 30 V14 M95 30 V16 M99 33 V22 M85 41 L79 35" stroke="#38d6ff" stroke-width="3.2" stroke-linecap="round"/>
  </svg>`;
}

// ---------------- 카메라 + 인식 + 화면 ----------------
export function createHandCam(ui) {
  // ui: { panel, video, canvas, status, info, overlay, onTarget(t|null), onLoadStep(text), onSide(s), onCalibrated() }
  let vision = null, hand = null, pose = null, stream = null, raf = 0, frame = 0;
  let lastVideoTime = -1, lastPose = null;
  let side = null, calib = null, sens = 1, grip = 0;
  let mode = 'off';           // off | loading | choose | calibrate | active
  let calibSamples = [], okSince = 0, lastSeen = 0, lastCheckKey = '';
  let palmInvert = false, palmBadSince = 0;
  let lastT = null;   // 마지막 조종 값 (화면 게이지용)
  let scheme = 'elbow';
  let elbowSeen = 0;
  const sm = { dx: 0, dy: 0, hx: 0, hy: 0, palm: 0, open: 0, pitch: 0, fore: 1, elev: 0, ex: 0, init: false };   // 부드럽게 만든 값
  try {
    side = localStorage.getItem(SIDE_KEY);
    sens = Number(localStorage.getItem(SENS_KEY)) || 1;
    palmInvert = localStorage.getItem(PALM_KEY) === '1';
    const sv = localStorage.getItem(SCHEME_KEY);
    if (sv === 'pos' || sv === 'wrist') scheme = sv;
  } catch { /* 무시 */ }

  // 보정·손 선택 중에는 카메라 창을 크게
  const setBig = (on) => { ui.panel.classList.toggle('big', on); document.body.classList.toggle('cam-big', on); };

  async function loadModels() {
    ui.onLoadStep('손 인식 도구를 불러오는 중… (처음 한 번, 약 14MB)');
    vision = await import(/* 외부 모듈 */ `${MP_URL}/vision_bundle.mjs`);
    const files = await vision.FilesetResolver.forVisionTasks(`${MP_URL}/wasm`);
    const make = async (Cls, opts) => {
      try { return await Cls.createFromOptions(files, { ...opts, baseOptions: { ...opts.baseOptions, delegate: 'GPU' } }); }
      catch { return Cls.createFromOptions(files, { ...opts, baseOptions: { ...opts.baseOptions, delegate: 'CPU' } }); }
    };
    ui.onLoadStep('손 인식 모델을 준비하는 중…');
    hand = await make(vision.HandLandmarker, { baseOptions: { modelAssetPath: HAND_MODEL }, runningMode: 'VIDEO', numHands: 2 });
    ui.onLoadStep('몸 인식 모델을 준비하는 중…');
    pose = await make(vision.PoseLandmarker, { baseOptions: { modelAssetPath: POSE_MODEL }, runningMode: 'VIDEO', numPoses: 1 });
  }

  async function startCamera() {
    ui.onLoadStep('카메라를 켜는 중… (권한을 물으면 [허용])');
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }, audio: false });
    ui.video.srcObject = stream;
    await ui.video.play();
  }

  // 캔버스는 화면에서 좌우 반전되어 보이므로(거울), 글자는 그리지 않고 도형만 그림
  function draw(m, poseLm, cal) {
    const c = ui.canvas, g = c.getContext('2d');
    const w = (c.width = ui.video.videoWidth || 640), h = (c.height = ui.video.videoHeight || 480);
    const A = m ? m.aspect : w / h;
    const px = (p) => [p.x / A * w, p.y * h];         // iso 좌표 → 픽셀
    g.clearRect(0, 0, w, h);
    const calibrating = mode === 'calibrate' || mode === 'choose';

    // 보정 중: 몸이 안 보이면 '여기에 앉으세요' 사람 모양 점선
    if (calibrating && !(m && m.poseOk)) {
      g.setLineDash([10, 8]); g.strokeStyle = 'rgba(255,255,255,.7)'; g.lineWidth = 4;
      g.beginPath(); g.arc(w * 0.5, h * 0.3, h * 0.11, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.moveTo(w * 0.28, h * 0.62); g.quadraticCurveTo(w * 0.5, h * 0.44, w * 0.72, h * 0.62); g.lineTo(w * 0.78, h); g.moveTo(w * 0.28, h * 0.62); g.lineTo(w * 0.22, h); g.stroke();
      g.setLineDash([]);
    }
    if (poseLm) {   // 어깨·팔
      g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 3;
      for (const [a, b] of [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16]]) {
        g.beginPath(); g.moveTo(poseLm[a].x * w, poseLm[a].y * h); g.lineTo(poseLm[b].x * w, poseLm[b].y * h); g.stroke();
      }
      if (!calibrating && !calib) {   // (보정 전) 몸 중심선
        const cx = (poseLm[11].x + poseLm[12].x) / 2 * w;
        g.setLineDash([6, 6]); g.strokeStyle = 'rgba(255,197,49,.8)';
        g.beginPath(); g.moveTo(cx, 0); g.lineTo(cx, h); g.stroke(); g.setLineDash([]);
      }
    }
    // 보정 중: 어깨 표시 + 고른 손 어깨에서 목표 동그라미까지 + 진행 고리
    if (mode === 'calibrate' && cal && cal.target && m.shoulders) {
      for (const s of m.shoulders) {
        const [x, y] = px(s);
        g.fillStyle = m.poseOk ? '#3ddc84' : '#ff5d6c';
        g.beginPath(); g.arc(x, y, 9, 0, Math.PI * 2); g.fill();
      }
      const [sx, sy] = px(m.sideShoulder);
      const [tx, ty] = px(cal.target);
      const tr = cal.target.r / A * w;
      g.setLineDash([8, 8]); g.strokeStyle = 'rgba(255,255,255,.8)'; g.lineWidth = 3;
      g.beginPath(); g.moveTo(sx, sy); g.lineTo(tx, ty); g.stroke(); g.setLineDash([]);
      const okCol = cal.allOk ? '#3ddc84' : '#ffc531';
      g.strokeStyle = okCol; g.lineWidth = 5;
      g.beginPath(); g.arc(tx, ty, tr, 0, Math.PI * 2); g.stroke();
      g.fillStyle = cal.allOk ? 'rgba(61,220,132,.18)' : 'rgba(255,197,49,.12)';
      g.fill();
      // 진행 고리 (모두 맞은 채 버틴 시간)
      if (cal.progress > 0) {
        g.strokeStyle = '#3ddc84'; g.lineWidth = 10;
        g.beginPath(); g.arc(tx, ty, tr + 12, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * cal.progress); g.stroke();
      }
      // 손이 아직 없으면 손바닥 모양 그림자
      if (!m.ok) {
        g.fillStyle = 'rgba(255,255,255,.35)';
        const pw = tr * 0.55, ph = tr * 0.6;
        g.beginPath(); g.roundRect(tx - pw / 2, ty - ph * 0.2, pw, ph, pw * 0.3); g.fill();
        for (let i = 0; i < 4; i++) { const fx = tx - pw / 2 + pw * (0.12 + i * 0.25); g.beginPath(); g.roundRect(fx - pw * 0.08, ty - ph * 0.95, pw * 0.16, ph * 0.8, pw * 0.08); g.fill(); }
        g.beginPath(); g.ellipse(tx + (side === 'left' ? -1 : 1) * pw * 0.62, ty + ph * 0.1, pw * 0.12, ph * 0.3, (side === 'left' ? 0.6 : -0.6), 0, Math.PI * 2); g.fill();
      }
    }
    // 조종 중: 손을 움직여도 되는 범위 상자, 기준점(+), 회전·높이 게이지, 화면 끝 경고
    if (mode === 'active' && calib) {
      const R = rangeBox(calib);
      const X = (ix) => ix / A * w, Y = (iy) => iy * h;
      g.setLineDash([10, 8]); g.strokeStyle = 'rgba(255,255,255,.45)'; g.lineWidth = 2;
      g.strokeRect(X(R.left), Y(R.top), X(R.right) - X(R.left), Y(R.bottom) - Y(R.top)); g.setLineDash([]);
      const [cx0, cy0] = [X(calib.hand0.x), Y(calib.hand0.y)];
      g.strokeStyle = 'rgba(255,197,49,.9)'; g.lineWidth = 3;
      g.beginPath(); g.moveTo(cx0 - 14, cy0); g.lineTo(cx0 + 14, cy0); g.moveTo(cx0, cy0 - 14); g.lineTo(cx0, cy0 + 14); g.stroke();
      if (lastT) {
        // 회전 게이지 (아래쪽 가로 막대): 가운데=기준, 끝=±170°
        const gy = h - 14, gl = X(R.left), gr = X(R.right);
        g.fillStyle = 'rgba(0,0,0,.45)'; g.fillRect(gl, gy - 6, gr - gl, 12);
        const gx = cx0 + (lastT.u > 0 ? (gl - cx0) * lastT.u : (gr - cx0) * -lastT.u);   // 원본 좌표: 사용자 오른쪽 = 왼쪽
        g.fillStyle = '#38d6ff'; g.fillRect(Math.min(cx0, gx), gy - 6, Math.abs(gx - cx0), 12);
        // 높이 게이지 (사용 범위 오른쪽 세로 막대 → 거울 화면에서는 왼쪽에 보임)
        const vx = X(R.right) + 10, vt = Y(R.top), vb = Y(R.bottom);
        g.fillStyle = 'rgba(0,0,0,.45)'; g.fillRect(vx - 6, vt, 12, vb - vt);
        const gv = lastT.gv != null ? lastT.gv : lastT.v;
        const vy = cy0 + (gv > 0 ? (vt - cy0) * gv : (vb - cy0) * -gv);
        g.fillStyle = '#3ddc84'; g.fillRect(vx - 6, Math.min(cy0, vy), 12, Math.abs(vy - cy0));
      }
      // 손이 사용 범위 밖(화면 끝 근처)이면 그쪽 테두리를 빨갛게
      if (m && m.hand) {
        g.fillStyle = 'rgba(255,60,80,.55)';
        const t = 16;
        if (m.hand.x < R.left) g.fillRect(0, 0, t, h);
        if (m.hand.x > R.right) g.fillRect(w - t, 0, t, h);
        if (m.hand.y < R.top) g.fillRect(0, 0, w, t);
        if (m.hand.y > R.bottom) g.fillRect(0, h - t, w, t);
      }
    }
    // 손목 방식: 지금 목표 자세를 작은 로봇팔 옆모습으로 (고른 손 반대쪽 위 구석)
    // 팔꿈치 방식: 재고 있는 위팔(어깨→팔꿈치)과 수평선
    if (mode === 'active' && calib && scheme === 'elbow' && m && m.elbowOk) {
      const [sx, sy] = px(m.sideShoulder), [ex, ey] = px(m.elbow);
      const out = ex >= sx ? 1 : -1;
      g.setLineDash([8, 8]); g.strokeStyle = 'rgba(255,255,255,.6)'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(sx, sy); g.lineTo(sx + out * w * 0.25, sy); g.stroke(); g.setLineDash([]);
      g.strokeStyle = '#3ddc84'; g.lineWidth = 7; g.lineCap = 'round';
      g.beginPath(); g.moveTo(sx, sy); g.lineTo(ex, ey); g.stroke(); g.lineCap = 'butt';
      g.fillStyle = '#3ddc84'; g.beginPath(); g.arc(ex, ey, 8, 0, Math.PI * 2); g.fill();
    }
    if (mode === 'active' && calib && lastT && scheme !== 'pos') {
      const k = h / 480;
      const right = side !== 'left';
      // 원본 영상 기준 좌표. 화면은 좌우 반전 → 오른손이면 원본 오른쪽(=화면 왼쪽) 위에 그림
      const bx = right ? w - 120 * k : 120 * k, by = 112 * k, dir = right ? 1 : -1;   // dir: 화면 가운데 쪽이 '앞'
      const l1 = 46 * k, l2 = 42 * k;
      const ex = bx - dir * Math.cos(lastT.shoulder) * l1, ey = by - Math.sin(lastT.shoulder) * l1;
      const tx = ex - dir * Math.cos(lastT.fore) * l2, ty = ey - Math.sin(lastT.fore) * l2;
      g.fillStyle = 'rgba(0,0,0,.5)'; g.beginPath(); g.roundRect(bx - (right ? 108 : 8) * k, by - 100 * k, 116 * k, 130 * k, 10 * k); g.fill();
      g.strokeStyle = 'rgba(255,255,255,.5)'; g.lineWidth = 2 * k;
      g.beginPath(); g.moveTo(bx - 100 * k * dir, by + 18 * k); g.lineTo(bx + 10 * k * dir, by + 18 * k); g.stroke();   // 바닥
      g.lineCap = 'round';
      g.strokeStyle = '#3ddc84'; g.lineWidth = 9 * k; g.beginPath(); g.moveTo(bx, by); g.lineTo(ex, ey); g.stroke();
      g.strokeStyle = '#38d6ff'; g.lineWidth = 7 * k; g.beginPath(); g.moveTo(ex, ey); g.lineTo(tx, ty); g.stroke();
      g.lineCap = 'butt';
      g.fillStyle = grip ? '#ffc531' : '#fff';
      g.beginPath(); g.arc(tx, ty, 6 * k, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#9aa4b2'; g.fillRect(bx - 9 * k, by, 18 * k, 18 * k);   // 받침대
      g.fillStyle = '#fff'; g.beginPath(); g.arc(bx, by, 5 * k, 0, Math.PI * 2); g.fill();
    }
    // 손 뼈대
    if (m && m.raw) {
      const col = mode === 'calibrate' ? (cal && cal.allOk ? '#3ddc84' : '#ffb547') : grip ? '#ffc531' : '#38d6ff';
      g.strokeStyle = m.ok ? col : 'rgba(255,93,108,.8)'; g.lineWidth = 3;
      for (const [a, b] of HAND_LINKS) { g.beginPath(); g.moveTo(m.raw[a].x * w, m.raw[a].y * h); g.lineTo(m.raw[b].x * w, m.raw[b].y * h); g.stroke(); }
      g.fillStyle = '#fff';
      for (const p of m.raw) { g.beginPath(); g.arc(p.x * w, p.y * h, 3, 0, Math.PI * 2); g.fill(); }
    }
  }

  function loop() {
    raf = requestAnimationFrame(loop);
    const v = ui.video;
    if (!hand || v.readyState < 2 || v.currentTime === lastVideoTime) return;
    lastVideoTime = v.currentTime;
    const ts = performance.now();
    const hr = hand.detectForVideo(v, ts);
    if (frame++ % 2 === 0) { const pr = pose.detectForVideo(v, ts); lastPose = pr.landmarks && pr.landmarks[0] ? pr.landmarks[0] : null; }
    const aspect = (v.videoWidth || 4) / (v.videoHeight || 3);
    const m = measure({ hands: hr.landmarks, worlds: hr.worldLandmarks, pose: lastPose, side: side || 'right', aspect, invertPalm: palmInvert });
    const cal = step(m);
    draw(m, lastPose, cal);
  }

  // 보정 화면 글자 (체크리스트·안내)
  function renderCalibUI(cal, phase) {
    const key = cal.checks.map((c) => (c.ok ? 1 : 0)).join('') + phase;
    if (key === lastCheckKey) return;
    lastCheckKey = key;
    const msg = phase === 'capture' ? '좋아요! 그대로 멈추세요…'
      : phase === 'hold' ? '좋아요! 잠깐만 그대로…'
        : cal.firstBad ? cal.firstBad.bad : '';
    ui.overlay.className = 'cal';
    ui.overlay.innerHTML = `
      <div class="cal-guide">
        ${poseFigure(side)}
        <div class="cal-text">
          <b>${sideName(side)} 보정</b>
          <span>${sideName(side)} <b>손바닥을 카메라 쪽</b>으로, <b>손가락은 위로 활짝</b> (하이파이브 하듯).<br>
          ${scheme === 'elbow' ? '<b>팔꿈치는 몸 옆에 내리고</b> 굽혀서' : '팔꿈치를 살짝 굽혀'} 손을 <b>${side === 'left' ? '왼쪽' : '오른쪽'} 어깨 앞 동그라미</b> 안에 두세요.</span>
        </div>
      </div>
      <ul class="cal-check">${cal.checks.map((c) => `<li class="${c.ok ? 'ok' : ''}">${c.ok ? '✓' : '○'} ${c.ok ? c.good : c.bad.replace(/ 주세요$/, '')}</li>`).join('')}</ul>
      <div class="cal-msg ${phase !== 'wait' ? 'good' : ''}">${msg}</div>`;
  }

  function step(m) {
    const now = performance.now();
    if (m.ok) {
      lastSeen = now;
      const a = sm.init ? 0.4 : 1, az = sm.init ? 0.25 : 1;
      sm.dx += (m.dx - sm.dx) * a; sm.dy += (m.dy - sm.dy) * a;
      sm.hx += (m.hand.x - sm.hx) * a; sm.hy += (m.hand.y - sm.hy) * a;
      sm.palm += (m.palm - sm.palm) * az; sm.open += (m.open - sm.open) * a;
      if (m.pitch != null) sm.pitch += (m.pitch - sm.pitch) * (sm.init ? 0.3 : 1);
      sm.fore += (m.fore - sm.fore) * (sm.init ? 0.3 : 1);
      sm.init = true;
    }
    if (m.elbowOk) {   // 팔꿈치: 안 보이면 마지막 값 그대로 (로봇 위팔 그 자리)
      const b = elbowSeen ? 0.35 : 1;
      sm.elev += (m.elev - sm.elev) * b;
      sm.ex += (m.elbow.x - sm.ex) * b;
      elbowSeen = now;
    }
    if (mode === 'calibrate') {
      const cal = calibChecks(m, side || 'right', scheme);
      // 다른 건 다 맞는데 '손바닥 방향'만 5초 넘게 틀리면, 이 카메라는 좌우 판단이 반대인 것으로 보고 뒤집어 기억
      const othersOk = cal.checks.every((c) => c.ok || c.k === 'palm');
      if (othersOk && !cal.checks.find((c) => c.k === 'palm').ok) {
        if (!palmBadSince) palmBadSince = now;
        else if (now - palmBadSince > 5000) {
          palmInvert = !palmInvert;
          palmBadSince = 0;
          try { localStorage.setItem(PALM_KEY, palmInvert ? '1' : '0'); } catch { /* 무시 */ }
        }
      } else palmBadSince = 0;
      let phase = 'wait';
      if (!cal.allOk) { okSince = 0; calibSamples = []; }
      else {
        if (!okSince) okSince = now;
        const held = (now - okSince) / 1000;
        if (held >= CAL.holdSec) {
          phase = 'capture';
          calibSamples.push({ dx: m.dx, dy: m.dy, palm: m.palm, open: m.open, hx: m.hand.x, hy: m.hand.y, aspect: m.aspect, pitch: m.pitch, fore: m.fore,
            elev: m.elbowOk ? m.elev : null, rel: m.elbowOk ? m.hand.x - m.elbow.x : null, fl: m.elbowOk ? m.forearmLen : null });
          if (held >= CAL.holdSec + CAL.captureSec) finishCalibration();
        } else phase = 'hold';
        cal.progress = Math.min(1, held / (CAL.holdSec + CAL.captureSec));
      }
      if (mode === 'calibrate') renderCalibUI(cal, phase);
      return cal;
    }
    if (mode !== 'active') return null;
    if (!m.ok && now - lastSeen > 300) {
      ui.status.textContent = m.reason === 'otherhand' ? '고른 손이 아닌 손이 보여요' : '손이 안 보여요 · 로봇 정지';
      ui.status.className = 'warn';
      ui.onTarget(null);
      return null;
    }
    const t = toTarget({ ...m, dx: sm.dx, dy: sm.dy, hand: { x: sm.hx, y: sm.hy }, palm: sm.palm, open: sm.open, pinch: m.ok ? m.pinch : 1,
      pitch: m.pitch != null || calib.pitch0 != null ? sm.pitch : null, fore: sm.fore,
      elev: elbowSeen ? sm.elev : null, relX: elbowSeen ? sm.hx - sm.ex : null }, calib, sens, grip, scheme);
    grip = t.grip;
    lastT = t;
    ui.onTarget(t);
    ui.status.textContent = '인식 중';
    ui.status.className = 'ok';
    const deg = Math.round(t.yawRight * 57.3);
    const atEdge = scheme !== 'elbow' && (Math.abs(t.u) >= 0.999 || Math.abs(t.v) >= 0.999);
    const lostElbow = scheme === 'elbow' && now - elbowSeen > 500;
    const yawTxt = `회전 ${deg > 0 ? '오른쪽 ' : deg < 0 ? '왼쪽 ' : ''}${Math.abs(deg)}°`;
    const gripTxt = `집게 ${grip ? '닫힘 ✊' : '열림 🖐'}`;
    ui.info.textContent = lostElbow ? '팔꿈치가 안 보여요 · 위팔은 그 자리에 멈춤'
      : atEdge ? '점선 상자 끝에 닿았어요 — 더 가지 않아도 끝까지 돌아요'
      : scheme !== 'pos'
        ? `${yawTxt} · 위팔 ${Math.round(t.shoulder / DEG)}° · 아래팔 ${Math.round(t.fore / DEG)}° · ${gripTxt}`
        : `${yawTxt} · 높이 ${t.height.toFixed(1)} · 앞뒤 ${t.reach.toFixed(1)} · ${gripTxt}`;
    return null;
  }

  const median = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  function finishCalibration() {
    if (calibSamples.length < 5) { okSince = 0; calibSamples = []; return; }
    calib = {
      dx: median(calibSamples.map((s) => s.dx)), dy: median(calibSamples.map((s) => s.dy)),
      palm: median(calibSamples.map((s) => s.palm)), open: median(calibSamples.map((s) => s.open)),
      // 기준점: 보정 때의 손 위치 (이후 몸이 기울어도 이 위치를 기준으로 계산)
      hand0: { x: median(calibSamples.map((s) => s.hx)), y: median(calibSamples.map((s) => s.hy)) },
      aspect: calibSamples[calibSamples.length - 1].aspect,
      // 손 기울기 기준 (손가락이 위를 향한 보정 자세)
      pitch0: calibSamples.every((s) => s.pitch != null) ? median(calibSamples.map((s) => s.pitch)) : null,
      fore0: median(calibSamples.map((s) => s.fore)),
      // 팔꿈치 방식 기준: 위팔 각도, 팔꿈치 기준 손 위치, 아래팔 길이
      elev0: calibSamples.every((s) => s.elev != null) ? median(calibSamples.map((s) => s.elev)) : null,
      rel0: calibSamples.every((s) => s.rel != null) ? median(calibSamples.map((s) => s.rel)) : null,
      fl0: calibSamples.every((s) => s.fl != null) ? Math.max(0.05, median(calibSamples.map((s) => s.fl))) : null,
    };
    if (calib.elev0 != null) { sm.elev = calib.elev0; sm.ex = calib.hand0.x - calib.rel0; elbowSeen = performance.now(); }
    if (calib.pitch0 != null) sm.pitch = calib.pitch0;
    sm.fore = calib.fore0;
    sm.dx = calib.dx; sm.dy = calib.dy; sm.palm = calib.palm; sm.open = calib.open;
    sm.hx = calib.hand0.x; sm.hy = calib.hand0.y;
    grip = 0;
    mode = 'active';
    lastCheckKey = '';
    ui.overlay.className = '';
    ui.overlay.innerHTML = scheme === 'elbow'
      ? '<b>보정 완료!</b><br>팔꿈치를 옆으로 들면 로봇 위팔이 눕고,<br>손목을 숙이면 아래팔이 내려가요'
      : scheme === 'wrist'
      ? '<b>보정 완료!</b><br>손을 내리면 팔이 앞으로 눕고,<br>손목을 숙이면 아래팔이 내려가요'
      : '<b>보정 완료!</b><br>손을 움직여 보세요';
    setTimeout(() => { setBig(false); }, 900);   // 잠깐 보여 준 뒤 원래 크기로
    setTimeout(() => { if (mode === 'active') ui.overlay.innerHTML = ''; }, 1800);
    ui.onCalibrated && ui.onCalibrated();
  }

  function askSide() {
    mode = 'choose';
    setBig(true);
    ui.onTarget(null);
    ui.status.textContent = '손 선택';
    ui.status.className = '';
    ui.overlay.className = '';
    ui.overlay.innerHTML = `<b>어느 손으로 조종할까요?</b>
      <div class="cam-pick">
        <button data-side="right"${side !== 'left' ? ' class="on"' : ''}>오른손</button>
        <button data-side="left"${side === 'left' ? ' class="on"' : ''}>왼손</button>
      </div>
      <span class="cam-sub">고른 손의 손바닥을 카메라에 보여 주면서 조종해요</span>`;
    ui.overlay.querySelectorAll('button').forEach((b) => { b.onclick = () => chooseSide(b.dataset.side); });
  }
  function chooseSide(s) {
    side = s;
    try { localStorage.setItem(SIDE_KEY, s); } catch { /* 무시 */ }
    ui.onSide && ui.onSide(s);
    calibrate();
  }
  function calibrate() {
    mode = 'calibrate';
    setBig(true);
    calib = null;
    calibSamples = [];
    okSince = 0;
    lastCheckKey = '';
    ui.onTarget(null);
    ui.status.textContent = '보정 중';
    ui.status.className = '';
  }

  return {
    async open() {
      ui.panel.hidden = false;
      if (mode !== 'off') return;
      mode = 'loading';
      setBig(true);
      try {
        if (!hand) await loadModels();
        await startCamera();
      } catch (e) {
        mode = 'off';
        setBig(false);
        const msg = String(e && (e.name || e.message) || e);
        ui.onLoadStep(/NotAllowed|Permission/i.test(msg) ? '카메라 권한이 필요해요. 주소창의 카메라 아이콘에서 허용해 주세요.'
          : /NotFound|Overconstrained/i.test(msg) ? '웹캠을 찾지 못했어요. 웹캠이 연결되어 있는지 확인해 주세요.'
            : '손 인식을 시작하지 못했어요: ' + (e && e.message || msg));
        throw e;
      }
      ui.onLoadStep('');
      loop();
      askSide();   // 처음에는 손 선택 → 보정
    },
    close() {
      cancelAnimationFrame(raf);
      if (stream) stream.getTracks().forEach((t) => t.stop());
      stream = null;
      mode = 'off';
      setBig(false);
      ui.onTarget(null);
      ui.panel.hidden = true;
    },
    recalibrate: askSide,
    setSens(v) { sens = v; try { localStorage.setItem(SENS_KEY, String(v)); } catch { /* 무시 */ } },
    get sens() { return sens; },
    get side() { return side || 'right'; },
    get mode() { return mode; },
    get scheme() { return scheme; },
    setScheme(s) {
      scheme = s === 'pos' || s === 'wrist' ? s : 'elbow';
      try { localStorage.setItem(SCHEME_KEY, scheme); } catch { /* 무시 */ }
      // 팔꿈치 방식인데 팔꿈치 기준이 없으면 다시 보정
      if (mode === 'active' && calib && scheme === 'elbow' && calib.elev0 == null) calibrate();
      else if (mode === 'calibrate') lastCheckKey = '';
    },
    // 시험용: 인식 결과를 직접 넣어 보기
    _step: step,
    _draw: draw,
    _setMode(mo, s) { mode = mo; if (s) side = s; if (mo === 'calibrate') calibrate(); },
    _setCalib(c) { calib = c; mode = 'active'; },
  };
}
