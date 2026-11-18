// 웹캠 손 조종
//
// MediaPipe 로 손(21점)과 몸(어깨·손목)을 인식해서 로봇 집게의 '목표 위치'로 바꿉니다.
//   - 손을 몸 중심선에서 오른쪽/왼쪽으로  → 베이스 회전
//   - 팔을 들기/내리기                    → 집게 높이
//   - 손을 화면 쪽으로 밀기/당기기          → 집게 앞뒤 거리 (손바닥이 커 보이는 정도로 추정)
//   - 손 쥐기(주먹) 또는 엄지·검지 집기      → 집기, 손 펴기 → 놓기
// 처음에 오른손/왼손을 고르고, 편한 자세를 '기준(중심)'으로 보정합니다.

const MP_VER = '0.10.14';
const MP_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}`;
const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const POSE_MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const SIDE_KEY = 'tiltarm-hand-side';
const SENS_KEY = 'tiltarm-hand-sens';

// 손 뼈대 연결선 (그리기용)
const HAND_LINKS = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];
const TIPS = [8, 12, 16, 20];

// ---------------- 계산 (화면·카메라와 상관없는 부분, 시험하기 쉽게 분리) ----------------
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// 한 프레임의 인식 결과 → 손 특징값
// hands: [[{x,y},...21]] (정규화 좌표), pose: [{x,y},...33] | null, side: 'right'|'left', aspect: 가로/세로
export function measure({ hands, pose, side, aspect = 4 / 3 }) {
  const iso = (p) => ({ x: p.x * aspect, y: p.y });   // 가로·세로 비율을 맞춘 좌표
  let center = null, scale = null, sideWrist = null;
  if (pose && pose.length > 16) {
    const ls = iso(pose[11]), rs = iso(pose[12]);
    center = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
    scale = Math.max(0.05, dist(ls, rs));             // 어깨 너비 = 길이의 기준
    sideWrist = iso(pose[side === 'right' ? 16 : 15]);
  }
  if (!hands || !hands.length) return { ok: false, reason: 'nohand', center, scale };
  // 고른 손: 몸 인식이 있으면 그쪽 손목에 가장 가까운 손, 없으면 첫 번째 손
  let pick = hands[0];
  if (sideWrist && hands.length > 1) {
    let best = Infinity;
    for (const h of hands) { const d = dist(iso(h[0]), sideWrist); if (d < best) { best = d; pick = h; } }
  } else if (sideWrist && dist(iso(pick[0]), sideWrist) > 0.25 * aspect) {
    return { ok: false, reason: 'otherhand', center, scale };   // 보이는 손이 고른 손이 아님
  }
  const P = pick.map(iso);
  const palm = Math.max(1e-4, dist(P[0], P[9]));       // 손목 ~ 가운뎃손가락 뿌리
  const open = TIPS.reduce((s, i) => s + dist(P[0], P[i]), 0) / TIPS.length / palm;   // 손 펴짐 정도
  const pinch = dist(P[4], P[8]) / palm;              // 엄지·검지 끝 거리
  const hand = { x: (P[0].x + P[9].x) / 2, y: (P[0].y + P[9].y) / 2 };
  if (!center) { center = { x: 0.5 * aspect, y: 0.45 }; scale = 0.25 * aspect; }
  return {
    ok: true,
    // 원본(좌우 반전 안 한) 카메라 영상에서는 사용자의 오른쪽이 화면 왼쪽 → center - hand 가 '오른쪽' 방향
    dx: (center.x - hand.x) / scale,
    dy: (center.y - hand.y) / scale,                   // 위쪽이 +
    palm, open, pinch, center, scale, raw: pick,
  };
}

// 보정값 + 특징값 → 로봇 집게 목표 (yawRight 라디안, reach/height 시뮬레이터 단위), grip 0/1
export function toTarget(m, calib, sens = 1, prevGrip = 0) {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const dz = Math.log(m.palm / calib.palm);           // 손을 밀면 손바닥이 커짐 → +
  const yawRight = clamp((m.dx - calib.dx) * 1.3 * sens, -1.5, 1.5);
  const height = clamp(1.3 + (m.dy - calib.dy) * 1.6 * sens, 0.6, 2.4);
  const reach = clamp(1.85 + dz * 2.2 * sens, 1.05, 2.85);
  const openRatio = m.open / calib.open;
  // 쥐면 닫힘, 펴면 열림 (경계에서 깜빡이지 않게 문턱을 두 개로)
  let grip = prevGrip;
  if (openRatio < 0.62 || m.pinch < 0.28) grip = 1;
  else if (openRatio > 0.78 && m.pinch > 0.4) grip = 0;
  return { yawRight, height, reach, grip, openRatio, dz };
}

// ---------------- 카메라 + 인식 + 화면 ----------------
export function createHandCam(ui) {
  // ui: { panel, video, canvas, status, info, overlay, onTarget(t|null), onLoadStep(text) }
  let vision = null, hand = null, pose = null, stream = null, raf = 0, frame = 0;
  let lastVideoTime = -1, lastPose = null;
  let side = null, calib = null, sens = 1, grip = 0;
  let mode = 'off';           // off | loading | choose | calibrate | active
  let calibSamples = [], calibStart = 0, lastSeen = 0;
  const sm = { dx: 0, dy: 0, palm: 0, open: 0, init: false };   // 부드럽게 만든 값
  try { side = localStorage.getItem(SIDE_KEY); sens = Number(localStorage.getItem(SENS_KEY)) || 1; } catch { /* 무시 */ }

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

  function draw(m, poseLm) {
    const c = ui.canvas, g = c.getContext('2d');
    const w = (c.width = ui.video.videoWidth || 640), h = (c.height = ui.video.videoHeight || 480);
    g.clearRect(0, 0, w, h);
    if (poseLm) {   // 어깨·팔
      g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 3;
      for (const [a, b] of [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16]]) {
        g.beginPath(); g.moveTo(poseLm[a].x * w, poseLm[a].y * h); g.lineTo(poseLm[b].x * w, poseLm[b].y * h); g.stroke();
      }
      const cx = (poseLm[11].x + poseLm[12].x) / 2 * w;   // 몸 중심선
      g.setLineDash([6, 6]); g.strokeStyle = 'rgba(255,197,49,.8)';
      g.beginPath(); g.moveTo(cx, 0); g.lineTo(cx, h); g.stroke(); g.setLineDash([]);
    }
    if (m && m.raw) {
      const col = grip ? '#ffc531' : '#38d6ff';
      g.strokeStyle = col; g.lineWidth = 3;
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
    if (frame++ % 2 === 0) { const pr = pose.detectForVideo(v, ts); lastPose = pr.landmarks && pr.landmarks[0] ? pr.landmarks[0] : lastPose; }
    const aspect = (v.videoWidth || 4) / (v.videoHeight || 3);
    const m = measure({ hands: hr.landmarks, pose: lastPose, side: side || 'right', aspect });
    draw(m, lastPose);
    step(m);
  }

  function step(m) {
    const now = performance.now();
    if (m.ok) {
      lastSeen = now;
      const a = sm.init ? 0.4 : 1, az = sm.init ? 0.25 : 1;
      sm.dx += (m.dx - sm.dx) * a; sm.dy += (m.dy - sm.dy) * a;
      sm.palm += (m.palm - sm.palm) * az; sm.open += (m.open - sm.open) * a;
      sm.init = true;
    }
    if (mode === 'calibrate') {
      const left = 3 - (now - calibStart) / 1000;
      if (!m.ok) { calibStart = now; calibSamples = []; ui.overlay.innerHTML = '<b>손이 안 보여요</b><br>고른 손을 카메라에 보여 주세요'; return; }
      if (left > 1) ui.overlay.innerHTML = `<b>${Math.ceil(left - 1)}</b><br>팔을 앞으로 편하게 내밀고<br>손을 편 채 멈추세요`;
      else {
        calibSamples.push({ dx: m.dx, dy: m.dy, palm: m.palm, open: m.open, pinch: m.pinch });
        ui.overlay.innerHTML = '<b>기준 자세 기록 중…</b>';
        if (left <= 0) finishCalibration();
      }
      return;
    }
    if (mode !== 'active') return;
    if (!m.ok && now - lastSeen > 300) {
      ui.status.textContent = m.reason === 'otherhand' ? '고른 손이 아닌 손이 보여요' : '손이 안 보여요 · 로봇 정지';
      ui.status.className = 'warn';
      ui.onTarget(null);
      return;
    }
    const t = toTarget({ ...m, dx: sm.dx, dy: sm.dy, palm: sm.palm, open: sm.open, pinch: m.ok ? m.pinch : 1 }, calib, sens, grip);
    grip = t.grip;
    ui.onTarget(t);
    ui.status.textContent = '인식 중';
    ui.status.className = 'ok';
    const deg = Math.round(t.yawRight * 57.3);
    ui.info.textContent = `회전 ${deg > 0 ? '오른쪽 ' : deg < 0 ? '왼쪽 ' : ''}${Math.abs(deg)}° · 높이 ${t.height.toFixed(1)} · 앞뒤 ${t.reach.toFixed(1)} · 집게 ${grip ? '닫힘 ✊' : '열림 🖐'}`;
  }

  const median = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  function finishCalibration() {
    if (calibSamples.length < 5) { calibStart = performance.now(); calibSamples = []; return; }
    calib = {
      dx: median(calibSamples.map((s) => s.dx)), dy: median(calibSamples.map((s) => s.dy)),
      palm: median(calibSamples.map((s) => s.palm)), open: median(calibSamples.map((s) => s.open)),
    };
    sm.dx = calib.dx; sm.dy = calib.dy; sm.palm = calib.palm; sm.open = calib.open;
    grip = 0;
    mode = 'active';
    ui.overlay.innerHTML = '<b>보정 완료!</b><br>손을 움직여 보세요';
    setTimeout(() => { if (mode === 'active') ui.overlay.innerHTML = ''; }, 1500);
    ui.onCalibrated && ui.onCalibrated();
  }

  function askSide() {
    mode = 'choose';
    ui.onTarget(null);
    ui.overlay.innerHTML = `<b>어느 손으로 조종할까요?</b><div class="cam-pick">
      <button data-side="right"${side !== 'left' ? ' class="on"' : ''}>오른손</button>
      <button data-side="left"${side === 'left' ? ' class="on"' : ''}>왼손</button></div>`;
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
    calib = null;
    calibSamples = [];
    calibStart = performance.now();
    ui.onTarget(null);
    ui.status.textContent = '보정 중';
    ui.status.className = '';
  }

  return {
    async open() {
      ui.panel.hidden = false;
      if (mode !== 'off') return;
      mode = 'loading';
      try {
        if (!hand) await loadModels();
        await startCamera();
      } catch (e) {
        mode = 'off';
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
      ui.onTarget(null);
      ui.panel.hidden = true;
    },
    recalibrate: askSide,
    setSens(v) { sens = v; try { localStorage.setItem(SENS_KEY, String(v)); } catch { /* 무시 */ } },
    get sens() { return sens; },
    get side() { return side || 'right'; },
    get mode() { return mode; },
    // 시험용: 인식 결과를 직접 넣어 보기
    _step: step,
    _setCalib(c) { calib = c; mode = 'active'; },
  };
}
