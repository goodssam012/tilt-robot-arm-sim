// 3축 로봇팔 시뮬레이터 (PC 화면)
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { THEMES, applyTheme } from './themes.js';
import { buildMission, COLORS, polar } from './missions.js';
import { openDisplayLink } from './net.js';
import { createHandCam } from './handcam.js';

const $ = (id) => document.getElementById(id);
const DEG = Math.PI / 180;

// ---------------- 기본 장면 ----------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.05, 200);
camera.position.set(0, 5, 6);

const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 2);
sun.position.set(4, 9, 5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5, near: 1, far: 25 });
sun.shadow.bias = -0.0005;
scene.add(sun);

const floor = new THREE.Mesh(new THREE.CircleGeometry(40, 64), new THREE.MeshStandardMaterial({ color: 0x777777, roughness: 0.95 }));
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);
const arena = new THREE.Mesh(new THREE.CircleGeometry(3.55, 64), new THREE.MeshStandardMaterial({ color: 0x999999, roughness: 0.85 }));
arena.rotation.x = -Math.PI / 2;
arena.position.y = 0.004;
arena.receiveShadow = true;
scene.add(arena);
// 작업 영역 격자 (동심원 + 방사선)
const grid = (() => {
  const pts = [];
  for (let r = 1; r <= 3; r += 1) {
    for (let i = 0; i < 64; i++) {
      const a1 = (i / 64) * Math.PI * 2, a2 = ((i + 1) / 64) * Math.PI * 2;
      pts.push(Math.cos(a1) * r, 0, Math.sin(a1) * r, Math.cos(a2) * r, 0, Math.sin(a2) * r);
    }
  }
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    pts.push(Math.cos(a) * 0.7, 0, Math.sin(a) * 0.7, Math.cos(a) * 3.5, 0, Math.sin(a) * 3.5);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x555555, transparent: true, opacity: 0.55 }));
  l.position.y = 0.008;
  return l;
})();
scene.add(grid);

const decor = new THREE.Group();
scene.add(decor);
const themeCtx = { scene, decor, floor, arena, grid, hemi, sun };

// ---------------- 로봇팔 ----------------
const SHOULDER_Y = 0.75;
const L1 = 1.6;          // 위팔 길이
const L2 = 1.45;         // 아래팔 길이
const TIP = 0.56;        // 손목 ~ 집게 끝
const GRAB = 0.42;       // 손목 ~ 집는 지점
const MAX_GAP = 0.62;    // 집게 최대 벌림

const LIMITS = {
  yaw: [-175 * DEG, 175 * DEG],
  shoulder: [-5 * DEG, 165 * DEG],
  elbow: [-160 * DEG, 35 * DEG],
};
const HOME = { yaw: 0, shoulder: 85 * DEG, elbow: -95 * DEG };   // 시작 자세

// ---- 금속 재질 ----
// 주변 환경을 반사하도록 환경맵을 만들어 금속 재질에만 적용
const pmrem = new THREE.PMREMGenerator(renderer);
const envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

// 브러시드(헤어라인) 금속 결 텍스처
function brushedTexture() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#8a8a8a';
  g.fillRect(0, 0, 512, 64);
  for (let i = 0; i < 1400; i++) {
    const v = (100 + Math.random() * 90) | 0;
    g.strokeStyle = `rgba(${v},${v},${v},0.35)`;
    g.lineWidth = 0.2 + Math.random() * 1.1;
    const x = Math.random() * 512, y = Math.random() * 64;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + 40 + Math.random() * 260, y);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(2, 1);
  return t;
}
const brushed = brushedTexture();
const metal = (o) => new THREE.MeshPhysicalMaterial({ envMap, envMapIntensity: 1, metalness: 1, ...o });
const mat = {
  alu: metal({ color: 0xeef1f6, roughness: 1, roughnessMap: brushed, envMapIntensity: 1.4, clearcoat: 0.3, clearcoatRoughness: 0.3 }),
  gun: metal({ color: 0x4a505a, roughness: 0.42, clearcoat: 0.6, clearcoatRoughness: 0.15 }),
  chrome: metal({ color: 0xffffff, roughness: 0.07 }),
  brass: metal({ color: 0xd8a465, roughness: 0.28 }),
  rubber: new THREE.MeshStandardMaterial({ color: 0x15171b, roughness: 0.92, metalness: 0 }),
  glow: new THREE.MeshStandardMaterial({ color: 0x0a2230, emissive: 0x38d6ff, emissiveIntensity: 2.4 }),
};
function mesh(geo, m, shadow = true) {
  const o = new THREE.Mesh(geo, m);
  o.castShadow = shadow;
  o.receiveShadow = shadow;
  return o;
}
const rbox = (w, h, d, r, m) => mesh(new RoundedBoxGeometry(w, h, d, 4, r), m);
const cyl = (rt, rb, h, m, seg = 48) => mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m);
// 관절 허브: z축 방향 원통 + 크롬 캡 + 황동 링 + 볼트
function hub(r, len) {
  const g = new THREE.Group();
  const core = cyl(r, r, len, mat.gun);
  core.rotation.x = Math.PI / 2;
  const cap = cyl(r * 0.62, r * 0.62, len + 0.05, mat.chrome);
  cap.rotation.x = Math.PI / 2;
  g.add(core, cap);
  for (const s of [-1, 1]) {
    const ring = cyl(r * 1.05, r * 1.05, 0.025, mat.brass);
    ring.rotation.x = Math.PI / 2;
    ring.position.z = s * (len / 2 - 0.035);
    g.add(ring);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const bolt = cyl(r * 0.09, r * 0.09, 0.02, mat.gun, 6);
      bolt.rotation.x = Math.PI / 2;
      bolt.position.set(Math.cos(a) * r * 0.42, Math.sin(a) * r * 0.42, s * (len / 2 + 0.03));
      g.add(bolt);
    }
  }
  return g;
}
// 링크 옆면의 장식 패널 + 발광 라인 (z = ±side)
function sidePanels(parent, x, len, h, side, glowMat = mat.glow) {
  for (const s of [-1, 1]) {
    const panel = rbox(len, h, 0.02, 0.008, mat.gun);
    panel.position.set(x, 0, s * side);
    const line = mesh(new THREE.BoxGeometry(len * 0.82, 0.014, 0.006), glowMat, false);
    line.position.set(x, 0, s * (side + 0.011));
    parent.add(panel, line);
  }
}

// 로봇팔 한 대를 만들어 장면에 추가 (glowHex: 발광 라인 색, guideHex: 안내선 색)
function buildArm(glowHex, guideHex) {
const glow = new THREE.MeshStandardMaterial({ color: 0x0a2230, emissive: glowHex, emissiveIntensity: 2.4 });
const armRoot = new THREE.Group();
scene.add(armRoot);

// 받침대
const plinth = cyl(0.8, 0.84, 0.06, mat.gun);
plinth.position.y = 0.03;
const baseGlow = mesh(new THREE.TorusGeometry(0.76, 0.012, 8, 96), glow, false);
baseGlow.rotation.x = Math.PI / 2;
baseGlow.position.y = 0.065;
const housing = cyl(0.6, 0.66, 0.16, mat.alu);
housing.position.y = 0.14;
const topRing = cyl(0.61, 0.61, 0.02, mat.chrome);
topRing.position.y = 0.228;
armRoot.add(plinth, baseGlow, housing, topRing);
for (let i = 0; i < 10; i++) {
  const a = (i / 10) * Math.PI * 2;
  const bolt = cyl(0.028, 0.028, 0.03, mat.gun, 6);
  bolt.position.set(Math.cos(a) * 0.53, 0.245, Math.sin(a) * 0.53);
  armRoot.add(bolt);
}

// 회전 몸체 (베이스 회전)
const yawG = new THREE.Group();
armRoot.add(yawG);
const bearing = cyl(0.48, 0.48, 0.05, mat.gun);
bearing.position.y = 0.26;
const turret = cyl(0.36, 0.44, 0.34, mat.alu);
turret.position.y = 0.45;
const turretGlow = mesh(new THREE.TorusGeometry(0.416, 0.011, 8, 80), glow, false);
turretGlow.rotation.x = Math.PI / 2;
turretGlow.position.y = 0.4;
const turretCap = cyl(0.3, 0.36, 0.05, mat.gun);
turretCap.position.y = 0.645;
yawG.add(bearing, turret, turretGlow, turretCap);
for (const s of [-1, 1]) {   // 어깨를 잡아 주는 양쪽 지지판
  const plate = rbox(0.46, 0.5, 0.07, 0.03, mat.alu);
  plate.position.set(0, 0.72, s * 0.205);
  yawG.add(plate);
}
const shHub = hub(0.2, 0.52);
shHub.position.y = SHOULDER_Y;
yawG.add(shHub);

// 위팔 (어깨)
const shG = new THREE.Group();
shG.position.y = SHOULDER_Y;
yawG.add(shG);
const upper = rbox(L1 - 0.22, 0.21, 0.2, 0.07, mat.alu);
upper.position.x = L1 / 2;
shG.add(upper);
sidePanels(shG, L1 / 2, L1 * 0.62, 0.075, 0.101, glow);
const cable = mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
  new THREE.Vector3(0.05, 0.2, 0.07),
  new THREE.Vector3(L1 * 0.3, 0.15, 0.075),
  new THREE.Vector3(L1 * 0.7, 0.15, 0.075),
  new THREE.Vector3(L1 - 0.05, 0.19, 0.07),
]), 40, 0.022, 8), mat.rubber);
shG.add(cable);
const elHub = hub(0.16, 0.42);
elHub.position.x = L1;
shG.add(elHub);

// 아래팔 (팔꿈치)
const elG = new THREE.Group();
elG.position.x = L1;
shG.add(elG);
const motor = cyl(0.13, 0.13, 0.36, mat.gun);
motor.rotation.z = Math.PI / 2;
motor.position.x = 0.3;
const motorRing = cyl(0.135, 0.135, 0.03, mat.brass);
motorRing.rotation.z = Math.PI / 2;
motorRing.position.x = 0.46;
const fore = rbox(L2 - 0.36, 0.15, 0.16, 0.055, mat.alu);
fore.position.x = (L2 + 0.36) / 2;
elG.add(motor, motorRing, fore);
sidePanels(elG, (L2 + 0.4) / 2, (L2 - 0.4) * 0.8, 0.055, 0.081, glow);

// 손목 + 집게 (집게가 항상 바닥을 향하도록 손목은 자동 수평 유지)
const wrG = new THREE.Group();
wrG.position.x = L2;
elG.add(wrG);
const wrHub = cyl(0.11, 0.11, 0.24, mat.gun);
wrHub.rotation.x = Math.PI / 2;
const wrCap = cyl(0.07, 0.07, 0.28, mat.chrome);
wrCap.rotation.x = Math.PI / 2;
const flange = cyl(0.15, 0.15, 0.035, mat.chrome);
flange.rotation.z = Math.PI / 2;
flange.position.x = 0.09;
// 원형 손바닥 + 십자 가이드 레일 (손가락 4개가 레일을 따라 열리고 닫힘)
const palm = cyl(0.3, 0.3, 0.1, mat.gun, 56);
palm.rotation.z = Math.PI / 2;
palm.position.x = 0.155;
const palmGlow = mesh(new THREE.TorusGeometry(0.302, 0.011, 8, 80), glow, false);
palmGlow.rotation.y = Math.PI / 2;
palmGlow.position.x = 0.155;
const railA = rbox(0.03, 0.86, 0.045, 0.012, mat.chrome);
railA.position.x = 0.215;
const railB = rbox(0.03, 0.045, 0.86, 0.012, mat.chrome);
railB.position.x = 0.215;
const palmCap = cyl(0.08, 0.08, 0.04, mat.brass, 32);
palmCap.rotation.z = Math.PI / 2;
palmCap.position.x = 0.23;
wrG.add(wrHub, wrCap, flange, palm, palmGlow, railA, railB, palmCap);

function makeFinger(side) {
  const g = new THREE.Group();
  const body = rbox(0.38, 0.1, 0.06, 0.022, mat.alu);
  const knuckle = rbox(0.09, 0.13, 0.09, 0.028, mat.gun);
  knuckle.position.x = -0.15;
  const pad = mesh(new THREE.BoxGeometry(0.22, 0.08, 0.014), mat.rubber);
  pad.position.set(0.06, 0, -side * 0.036);   // 안쪽 면의 고무 패드
  const tipCap = rbox(0.04, 0.1, 0.062, 0.015, mat.chrome);
  tipCap.position.x = 0.19;
  g.add(body, knuckle, pad, tipCap);
  g.position.x = 0.2 + 0.19;
  return g;
}
// 손가락 4개를 90°씩 돌려 배치 (각 손가락은 회전축 그룹 안에서 바깥쪽으로 열림)
const fingers = [0, 1, 2, 3].map((i) => {
  const angle = (i * Math.PI) / 2;   // 십자 레일 위에 하나씩
  const pivot = new THREE.Group();
  pivot.rotation.x = angle;
  const finger = makeFinger(1);
  pivot.add(finger);
  wrG.add(pivot);
  return { angle, pivot, finger };
});
const grabPoint = new THREE.Object3D();
grabPoint.position.x = GRAB;
wrG.add(grabPoint);
const tipPoint = new THREE.Object3D();
tipPoint.position.x = TIP;
wrG.add(tipPoint);

// 집게 아래로 떨어지는 안내선 + 착지 표시
const guideLine = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 1, 6),
  new THREE.MeshBasicMaterial({ color: guideHex, transparent: true, opacity: 0.7 }));
scene.add(guideLine);
const guideDot = new THREE.Mesh(new THREE.RingGeometry(0.05, 0.09, 24),
  new THREE.MeshBasicMaterial({ color: guideHex, transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
guideDot.rotation.x = -Math.PI / 2;
scene.add(guideDot);
return { armRoot, yawG, shG, elG, wrG, fingers, grabPoint, tipPoint, guideLine, guideDot, glow };
}

// 지금 처리 중인 로봇팔의 부품 (useArm 으로 바꿔 끼움)
let armRoot, yawG, shG, elG, wrG, fingers, grabPoint, tipPoint, guideLine, guideDot;
let joint, vel, gripWait, touch;
const PAD_IN = 0.043;   // 손가락 중심 ~ 안쪽 고무 패드 면 거리
// 손가락이 열리는 방향 (위에서 본 단위 벡터)
function fingerDir(f) {
  const a = wrG.getWorldPosition(new THREE.Vector3());
  const b = wrG.localToWorld(new THREE.Vector3(0, -Math.sin(f.angle), Math.cos(f.angle)));
  const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1;
  return [dx / l, dz / l];
}

function applyJoints(j) {
  yawG.rotation.y = Math.PI / 2 + j.yaw;
  shG.rotation.z = j.shoulder;
  elG.rotation.z = j.elbow;
  wrG.rotation.z = -(j.shoulder + j.elbow) - Math.PI / 2;
  armRoot.updateMatrixWorld(true);
}

// ---------------- 미션 상태 ----------------
const state = {
  level: 1,
  score: 0,
  mission: null,
  objects: [],       // {id, mesh, hx, hy, hz, held, resting, vy, locked, color}
  zones: [],         // {id, group, r, height, base:[x,z], move, pos:[x,z]}
  obstacles: [],     // {cx, cz, by, h, hx, hz, rot}
  tasks: [],
  timeLeft: 0,
  running: false,
  phase: 'intro',    // intro | play | success | fail
  held: null,
  grip: 0,
  gripVis: 0,
  themeIndex: 0,
  camMode: 0,
  clock: 0,
  pendingTimer: 0,
  mode: 'mission',   // mission | battle
};

// ---------------- 로봇팔 여러 대 (미션: 1대, 배틀: 2대) ----------------
// 로봇팔마다 관절·속도·집게 상태를 따로 갖고, 처리할 때 useArm 으로 '지금 팔'을 바꿔 끼움
let curArm = null;
function makeArm(glowHex, guideHex) {
  return {
    ...buildArm(glowHex, guideHex),
    joint: { ...HOME },
    vel: { yaw: 0, shoulder: 0, elbow: 0 },
    gripWait: { t: 0, failed: false },   // 폰 '집기' 후 잡기 대기 시간
    touch: { prev: null, last: 0 },      // 접촉 진동 상태
    held: null, grip: 0, gripVis: 0,
    phoneId: null,                       // 조종하는 폰 번호
    keyboard: true,                      // PC 키보드로도 조종하는지
    spheres: null,                       // 충돌 검사용 (상대 팔이 참고)
  };
}
function useArm(a) {
  curArm = a;
  ({ armRoot, yawG, shG, elG, wrG, fingers, grabPoint, tipPoint, guideLine, guideDot, joint, vel, gripWait, touch } = a);
  state.held = a.held;
  state.grip = a.grip;
  state.gripVis = a.gripVis;
}
function saveArm(a) {
  a.held = state.held;
  a.grip = state.grip;
  a.gripVis = state.gripVis;
}
const ARM_GLOW = { mission: 0x38d6ff, p1: 0xff4d5e, p2: 0x4d8bff };
const arms = [makeArm(ARM_GLOW.mission, 0xff3344)];
useArm(arms[0]);
const activeArms = () => (state.mode === 'battle' ? arms : [arms[0]]);

const missionGroup = new THREE.Group();
scene.add(missionGroup);

function disposeGroup(g) {
  g.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { if (m.map) m.map.dispose(); m.dispose(); });
  });
  g.clear();
}

function makeLabel(text, colorHex) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 96;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(10,14,24,0.78)';
  g.beginPath();
  g.roundRect(4, 14, 248, 68, 34);
  g.fill();
  g.fillStyle = '#' + colorHex.toString(16).padStart(6, '0');
  g.beginPath();
  g.arc(44, 48, 18, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#fff';
  g.font = 'bold 36px "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';
  g.textBaseline = 'middle';
  g.fillText(text, 76, 50);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  s.scale.set(0.95, 0.36, 1);
  s.renderOrder = 10;
  return s;
}

function obstacleFromBox(cx, cz, by, h, hx, hz, rot) {
  return { cx, cz, by, h, hx, hz, rot, c: Math.cos(rot), s: Math.sin(rot) };
}
// 점이 장애물(회전된 상자) 안에 있는지
function inObstacle(p, o, pad = 0) {
  if (p.y < o.by - pad || p.y > o.by + o.h + pad) return false;
  const dx = p.x - o.cx, dz = p.z - o.cz;
  const lx = dx * o.c - dz * o.s;   // 상자 기준 좌표 (rotation.y = rot)
  const lz = dx * o.s + dz * o.c;
  return Math.abs(lx) < o.hx + pad && Math.abs(lz) < o.hz + pad;
}

function loadMission(level) {
  clearTimeout(state.pendingTimer);
  if (state.held) { missionGroup.attach(state.held.mesh); state.held = null; }
  disposeGroup(missionGroup);
  const m = buildMission(level);
  state.mission = m;
  state.objects = [];
  state.zones = [];
  state.obstacles = [];
  state.tasks = m.tasks.map((t) => ({ ...t, done: false }));
  state.timeLeft = m.time;

  // 벽
  const wallM = new THREE.MeshStandardMaterial({ color: 0x8a94a8, roughness: 0.6, metalness: 0.2, transparent: true, opacity: 0.92 });
  const hazardM = new THREE.MeshStandardMaterial({ color: 0xffc531, roughness: 0.6 });
  for (const w of m.walls) {
    const [sx, sy, sz] = w.size;
    const wall = mesh(new THREE.BoxGeometry(sx, sy, sz), wallM);
    wall.position.set(w.pos[0], sy / 2, w.pos[1]);
    wall.rotation.y = w.rotY;
    missionGroup.add(wall);
    const cap = mesh(new THREE.BoxGeometry(sx + 0.02, 0.05, sz + 0.02), hazardM);
    cap.position.set(w.pos[0], sy, w.pos[1]);
    cap.rotation.y = w.rotY;
    missionGroup.add(cap);
    state.obstacles.push(obstacleFromBox(w.pos[0], w.pos[1], 0, sy, sx / 2, sz / 2, w.rotY));
  }

  // 목표 구역
  for (const z of m.zones) {
    const col = COLORS[z.color].hex;
    const g = new THREE.Group();
    if (z.height > 0) {
      const side = z.r * 2 + 0.12;
      const ped = mesh(new THREE.BoxGeometry(side, z.height, side), new THREE.MeshStandardMaterial({ color: 0x59606e, roughness: 0.7 }));
      ped.position.y = z.height / 2;
      g.add(ped);
      state.obstacles.push(obstacleFromBox(z.pos[0], z.pos[1], 0, z.height, side / 2, side / 2, 0));
    }
    const disc = new THREE.Mesh(new THREE.CircleGeometry(z.r, 48),
      new THREE.MeshStandardMaterial({ color: col, transparent: true, opacity: 0.45, roughness: 0.6 }));
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = z.height + 0.012;
    disc.receiveShadow = true;
    const ring = new THREE.Mesh(new THREE.RingGeometry(z.r - 0.05, z.r, 48),
      new THREE.MeshBasicMaterial({ color: col, side: THREE.DoubleSide, transparent: true }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = z.height + 0.016;
    const label = makeLabel(z.move ? '이동 구역' : '목표', col);
    label.position.y = z.height + 0.75;
    g.add(disc, ring, label);
    g.position.set(z.pos[0], 0, z.pos[1]);
    missionGroup.add(g);
    // 원래 각도/거리 (움직이는 구역용)
    const baseDeg = Math.atan2(z.pos[0], -z.pos[1]) / DEG;
    const baseR = Math.hypot(z.pos[0], z.pos[1]);
    state.zones.push({ id: z.id, group: g, ring, r: z.r, height: z.height, move: z.move, baseDeg, baseR, pos: [...z.pos], color: z.color });
  }

  // 물건
  for (const o of m.objects) {
    const col = COLORS[o.color].hex;
    const om = new THREE.MeshStandardMaterial({ color: col, roughness: 0.45, metalness: 0.1, emissive: 0x000000 });
    let geo, hx, hy, hz;
    if (o.shape === 'box') { geo = new THREE.BoxGeometry(0.36, 0.36, 0.36); hx = hy = hz = 0.18; }
    else if (o.shape === 'cyl') { geo = new THREE.CylinderGeometry(0.16, 0.16, 0.44, 28); hx = hz = 0.16; hy = 0.22; }
    else { geo = new THREE.SphereGeometry(0.19, 28, 20); hx = hy = hz = 0.19; }
    const om2 = mesh(geo, om);
    om2.position.set(o.pos[0], hy, o.pos[1]);
    om2.rotation.y = (((level * 7 + state.objects.length * 13) % 10) / 10) * Math.PI;  // 매번 같은 방향 (재생 재현용)
    missionGroup.add(om2);
    const rad = o.shape === 'box' ? hx * 1.12 : hx;   // 충돌용 반지름
    state.objects.push({ id: o.id, label: o.label, color: o.color, shape: o.shape, rad, mesh: om2, hx, hy, hz, held: false, resting: true, vy: 0, locked: false, supportId: null });
  }

  // 화면 표시
  $('stageNo').textContent = `STAGE ${level}`;
  $('mTitle').textContent = m.title;
  $('mDesc').textContent = m.desc;
  $('diff').textContent = '난이도 ' + '★'.repeat(m.stars) + '☆'.repeat(5 - m.stars);
  renderTasks();
  updateTimer();
}

function objById(id) { return state.objects.find((o) => o.id === id); }
function zoneById(id) { return state.zones.find((z) => z.id === id); }

function renderTasks() {
  const ul = $('tasks');
  ul.innerHTML = '';
  for (const t of state.tasks) {
    const o = objById(t.obj);
    const li = document.createElement('li');
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.background = '#' + COLORS[o.color].hex.toString(16).padStart(6, '0');
    li.appendChild(chip);
    let text;
    if (t.type === 'zone') {
      const z = zoneById(t.zone);
      const where = z.height > 0 ? '높은 ' : z.move ? '움직이는 ' : '';
      text = `${o.label} → ${where}${COLORS[z.color].name} 구역`;
    } else {
      text = `${o.label} → ${objById(t.on).label} 위에 쌓기`;
    }
    li.appendChild(document.createTextNode(text));
    if (t.done) li.classList.add('done');
    ul.appendChild(li);
  }
}

function updateTimer() {
  const el = $('timer');
  if (!state.mission || !state.mission.time) { el.textContent = '시간 제한 없음'; el.classList.remove('low'); return; }
  const s = Math.max(0, Math.ceil(state.timeLeft));
  el.textContent = `⏱ ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  el.classList.toggle('low', s <= 15);
}

// ---------------- 충돌/지지 계산 ----------------
const _v = new THREE.Vector3();
const _box = new THREE.Box3();

function objBox(o, out = new THREE.Box3()) {
  const p = o.mesh.getWorldPosition(_v);
  out.min.set(p.x - o.hx, p.y - o.hy, p.z - o.hz);
  out.max.set(p.x + o.hx, p.y + o.hy, p.z + o.hz);
  return out;
}

// (x,z) 아래에서 y 이하로 가장 높은 받침 높이와 받침 물건
function supportBelow(x, z, y, exclude, hx = 0, hz = 0) {
  let best = 0, bestObj = null;
  for (const ob of state.obstacles) {
    const top = ob.by + ob.h;
    if (top <= y + 0.02 && top > best && inObstacle({ x, y: top - 0.01, z }, ob, 0)) { best = top; bestObj = null; }
  }
  for (const o of state.objects) {
    if (o === exclude || o.held) continue;
    const p = o.mesh.position;
    const top = p.y + o.hy;
    if (top > y + 0.02 || top <= best) continue;
    if (Math.abs(p.x - x) < (o.hx + hx) * 0.8 && Math.abs(p.z - z) < (o.hz + hz) * 0.8) { best = top; bestObj = o; }
  }
  return { y: best, obj: bestObj };
}

const samplePts = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const _a = new THREE.Vector3(), _b = new THREE.Vector3();
// 현재 관절 자세가 바닥/벽/다른 물건과 부딪히는지
function poseInvalid() {
  // 벽·받침대와의 충돌만 검사 (바닥은 floorDepth 에서 따로 검사)
  const tip = tipPoint.getWorldPosition(new THREE.Vector3());
  shG.getWorldPosition(_a);
  elG.getWorldPosition(_b);
  const wrist = wrG.getWorldPosition(new THREE.Vector3());
  const pts = [];
  for (let i = 1; i <= 4; i++) pts.push(_a.clone().lerp(_b, i / 4));
  for (let i = 1; i <= 5; i++) pts.push(_b.clone().lerp(wrist, i / 5));
  pts.push(tip, grabPoint.getWorldPosition(new THREE.Vector3()));
  for (const ob of state.obstacles) {
    for (const p of pts) if (inObstacle(p, ob, 0.07)) return true;
  }
  // (물건과의 충돌은 resolveContacts 에서 밀기/막기로 처리)
  // 들고 있는 물건
  if (state.held) {
    const h = state.held;
    objBox(h, _box);
    const corners = [];
    for (const x of [_box.min.x, _box.max.x]) for (const y of [_box.min.y, _box.max.y]) for (const z of [_box.min.z, _box.max.z]) corners.push(new THREE.Vector3(x, y, z));
    corners.push(_box.getCenter(new THREE.Vector3()));
    for (const ob of state.obstacles) for (const p of corners) if (inObstacle(p, ob, 0.0)) return true;
  }
  // 배틀: 상대 로봇팔과 부딪힘
  if (state.mode === 'battle') {
    const mine = armSpheres();
    for (const b of arms) {
      if (b === curArm || !b.spheres) continue;
      for (const [p, r] of mine) for (const [q, s2] of b.spheres) if (p.distanceToSquared(q) < (r + s2) * (r + s2)) return true;
    }
  }
  return false;
}

// ---------------- 접촉 / 밀기 ----------------
// 로봇팔을 작은 구(球) 여러 개로 근사해서 물건과 겹치는지 검사합니다.
// 옆에서 닿으면 물건을 겹친 만큼 밀어내고, 위에서 누르거나
// 고정된 물건·벽 때문에 밀 수 없으면 blocked 로 알려 팔 움직임을 막습니다.
// ---- 물건 모양 계산 (상자는 실제 사각형, 원기둥·공은 원) ----
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _wp = new THREE.Vector3();
// 물건의 세계 기준 회전각(위에서 본 방향)
function worldYaw(o) {
  if (!o.held) return o.mesh.rotation.y;
  o.mesh.getWorldQuaternion(_q);
  return _e.setFromQuaternion(_q, 'YXZ').y;
}
// 높이 구간 [yLo, yHi] 에서 본 물건의 단면 반지름 (공은 높이에 따라 작아짐)
function sliceRadius(o, cy, yLo, yHi) {
  if (o.shape !== 'ball') return o.hx;
  const dy = cy >= yLo && cy <= yHi ? 0 : Math.min(Math.abs(cy - yLo), Math.abs(cy - yHi));
  return Math.sqrt(Math.max(0, o.hx * o.hx - dy * dy));
}

// 구(sx, sz, 반지름 r)가 물건과 겹친 정도. 겹치지 않으면 null
// nx, nz: 물건이 밀려나갈 방향, over: 구의 중심이 물건 바로 위(발자국 안)에 있는지
function sphereVsObj(o, sx, sz, r) {
  const p = o.mesh.position;
  const wx = sx - p.x, wz = sz - p.z;
  if (o.shape === 'box') {
    const yaw = o.mesh.rotation.y, c = Math.cos(yaw), s = Math.sin(yaw), h = o.hx;
    const lx = wx * c - wz * s, lz = wx * s + wz * c;          // 상자 기준 좌표
    const qx = Math.max(-h, Math.min(h, lx)), qz = Math.max(-h, Math.min(h, lz));
    const ex = lx - qx, ez = lz - qz, dist = Math.hypot(ex, ez);
    let nlx, nlz, depth;
    if (dist > 1e-9) {
      if (dist >= r) return null;
      nlx = -ex / dist; nlz = -ez / dist; depth = r - dist;
    } else {                                                    // 구의 중심이 상자 안
      const fx = h - Math.abs(lx), fz = h - Math.abs(lz);
      if (fx < fz) { nlx = -(Math.sign(lx) || 1); nlz = 0; depth = r + fx; }
      else { nlx = 0; nlz = -(Math.sign(lz) || 1); depth = r + fz; }
    }
    return { depth, nx: nlx * c + nlz * s, nz: -nlx * s + nlz * c, over: Math.abs(lx) < h && Math.abs(lz) < h };
  }
  const R = o.hx, d = Math.hypot(wx, wz), depth = R + r - d;
  if (depth <= 0) return null;
  return { depth, nx: d > 1e-6 ? -wx / d : 1, nz: d > 1e-6 ? -wz / d : 0, over: d < R };
}

// 집게 축(ax, az)에서 방향(ux, uz)으로 뻗은 손가락이 안쪽으로 닫힐 때
// 처음 물건 표면에 닿는 거리. 닿지 않으면 -Infinity
function fingerContactDist(o, ax, az, ux, uz, yLo, yHi) {
  const p = o.mesh.getWorldPosition(_wp);
  if (yHi < p.y - o.hy || yLo > p.y + o.hy) return -Infinity;
  const rx = ax - p.x, rz = az - p.z;
  if (o.shape === 'box') {
    const yaw = worldYaw(o), c = Math.cos(yaw), s = Math.sin(yaw), h = o.hx;
    const P = [rx * c - rz * s, rx * s + rz * c];
    const D = [ux * c - uz * s, ux * s + uz * c];
    let tmin = -Infinity, tmax = Infinity;
    for (let i = 0; i < 2; i++) {
      if (Math.abs(D[i]) < 1e-9) { if (Math.abs(P[i]) > h) return -Infinity; continue; }
      const t1 = (-h - P[i]) / D[i], t2 = (h - P[i]) / D[i];
      tmin = Math.max(tmin, Math.min(t1, t2));
      tmax = Math.min(tmax, Math.max(t1, t2));
    }
    return tmax >= tmin ? tmax : -Infinity;
  }
  const R = sliceRadius(o, p.y, yLo, yHi);
  const wx = -rx, wz = -rz;
  const proj = wx * ux + wz * uz, perp2 = wx * wx + wz * wz - proj * proj;
  if (perp2 > R * R) return -Infinity;
  return proj + Math.sqrt(R * R - perp2);
}

const FINGER_XS = [0.26, 0.41, 0.56];
function armSpheres() {
  const list = [];
  const S = shG.getWorldPosition(new THREE.Vector3());
  const E = elG.getWorldPosition(new THREE.Vector3());
  const W = wrG.getWorldPosition(new THREE.Vector3());
  for (let i = 2; i <= 6; i++) list.push([S.clone().lerp(E, i / 6), 0.12]);   // 위팔
  for (let i = 1; i <= 6; i++) list.push([E.clone().lerp(W, i / 6), 0.1]);    // 아래팔
  list.push([E, 0.17], [W, 0.12]);                                             // 팔꿈치·손목 관절
  list.push([wrG.localToWorld(new THREE.Vector3(0.16, 0, 0)), 0.07]);          // 손바닥 중심
  for (const f of fingers) {
    const c = Math.cos(f.angle), s = Math.sin(f.angle);
    list.push([wrG.localToWorld(new THREE.Vector3(0.155, -0.24 * s, 0.24 * c)), 0.07]);  // 손바닥 가장자리
    const r = f.finger.position.z;
    for (const x of FINGER_XS) list.push([wrG.localToWorld(new THREE.Vector3(x, -r * s, r * c)), 0.04]);  // 손가락
  }
  return list;
}

// 물건을 np 위치로 옮겼을 때 벽·받침대에 박히는지
function objBlockedAt(o, np) {
  const r = o.rad * 0.95;
  const pts = [np, new THREE.Vector3(np.x + r, np.y, np.z), new THREE.Vector3(np.x - r, np.y, np.z),
    new THREE.Vector3(np.x, np.y, np.z + r), new THREE.Vector3(np.x, np.y, np.z - r)];
  return state.obstacles.some((ob) => pts.some((p) => inObstacle(p, ob, 0)));
}
const vOverlap = (a, ay, b, by) => ay - a.hy < by + b.hy && ay + a.hy > by - b.hy;

function resolveContacts(apply = true) {
  const res = { contact: false, blocked: false, moved: false, blockDepth: 0 };
  const pushes = new Map();
  const addPush = (o, x, z) => {
    const v = pushes.get(o);
    if (!v || x * x + z * z > v[0] * v[0] + v[1] * v[1]) pushes.set(o, [x, z]);
  };

  // 1) 팔과 물건
  const spheres = armSpheres();
  for (const o of state.objects) {
    if (o.held) continue;
    const p = o.mesh.position, top = p.y + o.hy, bottom = p.y - o.hy;
    for (const [s, r] of spheres) {
      if (s.y - r >= top || s.y + r <= bottom) continue;
      const hit = sphereVsObj(o, s.x, s.z, r);
      if (!hit) continue;
      res.contact = true;
      // 위에서 누르는 경우나 완료되어 고정된 물건은 밀리지 않음
      if (o.locked || (s.y > top - 0.02 && hit.over)) { res.blocked = true; res.blockDepth += hit.depth; continue; }
      addPush(o, hit.nx * hit.depth, hit.nz * hit.depth);
    }
  }

  // 2) 들고 있는 물건과 다른 물건
  const h = state.held;
  if (h) {
    const hp = h.mesh.getWorldPosition(new THREE.Vector3());
    for (const o of state.objects) {
      if (o === h) continue;
      const p = o.mesh.position;
      if (!vOverlap(h, hp.y, o, p.y)) continue;
      const dx = p.x - hp.x, dz = p.z - hp.z, d = Math.hypot(dx, dz);
      const depth = h.rad + o.rad - d;
      if (depth <= 0) continue;
      res.contact = true;
      if (o.locked || hp.y - h.hy > p.y + o.hy - 0.05) { res.blocked = true; res.blockDepth += depth; continue; }  // 위에 올려놓는 중
      addPush(o, d > 1e-6 ? (dx / d) * depth : depth, d > 1e-6 ? (dz / d) * depth : 0);
    }
  }
  if (!pushes.size) return res;

  // 3) 밀기 적용 (밀린 물건이 다른 물건을 한 번 더 밀 수 있음)
  const moves = [];
  for (const [o, [x, z]] of pushes) {
    const np = o.mesh.position.clone();
    np.x += x * 1.02; np.z += z * 1.02;
    if (objBlockedAt(o, np)) { res.blocked = true; res.blockDepth += Math.hypot(x, z); continue; }
    let ok = true;
    const chain = [];
    for (const q of state.objects) {
      if (q === o || q.held || pushes.has(q)) continue;
      const qp = q.mesh.position;
      if (!vOverlap(o, np.y, q, qp.y)) continue;
      const dx = qp.x - np.x, dz = qp.z - np.z, d = Math.hypot(dx, dz);
      const depth = o.rad + q.rad - d;
      if (depth <= 0) continue;
      if (q.locked) { ok = false; break; }
      const qnp = qp.clone();
      qnp.x += (d > 1e-6 ? dx / d : 1) * depth * 1.02;
      qnp.z += (d > 1e-6 ? dz / d : 0) * depth * 1.02;
      if (objBlockedAt(q, qnp)) { ok = false; break; }
      chain.push([q, qnp]);
    }
    if (!ok) { res.blocked = true; res.blockDepth += Math.hypot(x, z); continue; }
    moves.push([o, np], ...chain);
  }
  if (apply) {
    for (const [o, np] of moves) { o.mesh.position.x = np.x; o.mesh.position.z = np.z; }
    res.moved = moves.length > 0;
  }
  return res;
}

const snapObjects = () => state.objects.map((o) => [o, o.mesh.position.x, o.mesh.position.z]);
const restoreObjects = (snap) => snap.forEach(([o, x, z]) => { if (!o.held) { o.mesh.position.x = x; o.mesh.position.z = z; } });

// 닿을 때 폰 진동 + 소리 (처음 닿는 순간 한 번, 계속 밀거나 누르면 짧게 반복)
// kind: null(닿지 않음) | 'touch'(물건) | 'hit'(벽·고정된 물건) | 'floor'(바닥)
const TOUCH_FX = {
  touch: { first: 90, again: 60, every: 300, tone: 240 },
  hit:   { first: 180, again: 100, every: 450, tone: 130 },
  floor: { first: [120, 70, 120], again: 120, every: 450, tone: 95, text: '바닥에 닿았어요' },
};
function contactFeedback(kind, active, now) {
  const fx = kind && TOUCH_FX[kind];
  if (fx && touch.prev !== kind && now - touch.last > 150) {
    feedback({ vibrate: fx.first, contact: kind, ...(fx.text ? { text: fx.text } : {}) });
    if (input.cam.active && curArm === arms[0]) pcFlash(kind);   // 카메라 조종 중에는 진동 대신 화면 테두리로
    beep(fx.tone, kind === 'floor' ? 0.12 : 0.06, 'triangle', 0.08);
    touch.last = now;
  } else if (fx && active && now - touch.last > fx.every) {
    feedback({ vibrate: fx.again, contact: kind });
    touch.last = now;
  }
  touch.prev = kind || null;
}

// 팔(관절 두께 포함)·손가락·들고 있는 물건이 바닥 아래로 들어간 깊이 (0 이면 정상)
const FLOOR_Y = 0;
function floorDepth() {
  let d = 0;
  for (const [s, r] of armSpheres()) d = Math.max(d, FLOOR_Y + r - s.y);
  const tip = tipPoint.getWorldPosition(new THREE.Vector3());
  d = Math.max(d, FLOOR_Y + 0.02 - tip.y);
  if (state.held) d = Math.max(d, FLOOR_Y - objBox(state.held, _box).min.y);
  return d;
}


// ---------------- 입력 ----------------
const input = {
  phones: {},          // 폰 번호 → 최근 조종 값
  keys: new Set(),
  keyLock: false,
};
const IDLE_INPUT = { yaw: 0, shoulder: 0, elbow: 0, grip: 0, speed: 1 };
// 웹캠 손 조종: 집게 목표(회전·앞뒤·높이)와 집게 상태. 켜져 있으면 1번 로봇팔(1P)을 조종
input.cam = { active: false, t: 0, yawRight: 0, reach: 1.85, height: 1.3, grip: 0 };

// 집게 목표 위치 → 로봇 관절 목표 (역기구학: 손목이 그 위치에 오도록 어깨·팔꿈치 각도 계산)
function camIK(c) {
  const lim0 = (v, j) => Math.max(LIMITS[j][0], Math.min(LIMITS[j][1], v));
  if (c.scheme === 'wrist') {   // 손목 방식: 위팔 각도와 아래팔 방향이 바로 옴
    const sh = lim0(c.shoulder, 'shoulder');
    return { yaw: lim0(-c.yawRight, 'yaw'), shoulder: sh, elbow: lim0(c.fore - sh, 'elbow') };
  }
  const r = c.reach, dy = c.height - SHOULDER_Y;
  let d = Math.hypot(r, dy);
  d = Math.max(Math.abs(L1 - L2) + 0.05, Math.min(L1 + L2 - 0.02, d));
  const el = -Math.acos(Math.max(-1, Math.min(1, (d * d - L1 * L1 - L2 * L2) / (2 * L1 * L2))));
  const sh = Math.atan2(dy, r) - Math.atan2(L2 * Math.sin(el), L1 + L2 * Math.cos(el));
  const lim = (v, j) => Math.max(LIMITS[j][0], Math.min(LIMITS[j][1], v));
  return { yaw: lim(-c.yawRight, 'yaw'), shoulder: lim(sh, 'shoulder'), elbow: lim(el, 'elbow') };
}
const NO_KEYS = new Set();
const conn = { phone: false };
let phoneIds = [];                 // 연결된 폰 번호들
const players = [null, null];      // 1P, 2P 를 맡은 폰 번호 (먼저 들어온 폰이 1P)

let link = null;   // 폰 연결 (로컬 Wi‑Fi 또는 인터넷 직접 연결)
function sendFeedback(data, to) {
  if (link) link.send({ type: 'feedback', ...data }, to);
}
const feedbackAll = (data) => sendFeedback(data);
// 지금 처리 중인 로봇팔을 조종하는 사람에게 (미션 모드는 모든 폰)
function feedback(data) {
  if (state.mode !== 'battle') { sendFeedback(data); return; }
  if (curArm && curArm.phoneId != null) sendFeedback(data, curArm.phoneId);
}

// 폰마다 역할 알려 주기 (1P / 2P / 대기)
function announcePlayers() {
  for (const id of phoneIds) {
    sendFeedback({
      mode: state.mode, player: players.indexOf(id) + 1,
      background: THEMES[state.themeIndex].name, rec: rec.mode, loop: rec.loop,
    }, id);
  }
}
// 1P·2P 폰을 로봇팔에 연결 (폰이 없는 팔은 PC 키보드로 조종)
function assignArms() {
  arms[0].phoneId = players[0];
  if (state.mode === 'battle' && arms[1]) {
    arms[1].phoneId = players[1];
    arms[1].keyboard = players[1] == null;
    arms[0].keyboard = players[0] == null && players[1] != null;
  } else {
    arms[0].keyboard = true;
  }
  updateBattleHud();
}

function onPhoneStatus({ phones }) {
  phoneIds = (phones || []).map(String);
  for (let i = 0; i < 2; i++) if (players[i] != null && !phoneIds.includes(players[i])) players[i] = null;
  for (const id of phoneIds) {
    if (players.includes(id)) continue;
    const slot = players.indexOf(null);
    if (slot >= 0) players[slot] = id;
  }
  for (const id of Object.keys(input.phones)) if (!phoneIds.includes(id)) delete input.phones[id];
  const any = phoneIds.length > 0;
  conn.phone = any;
  $('dPhone').classList.toggle('on', any);
  $('qPhone').classList.toggle('on', any);
  $('phoneCount').textContent = phoneIds.length > 1 ? ` ×${phoneIds.length}` : '';
  assignArms();
  announcePlayers();
  // 폰이 연결되면 자동으로 시작
  if (any && state.phase === 'intro') setTimeout(startFromIntro, 1200);
}

function onPhoneMessage(m, from) {
  const id = String(from ?? '');
  const now = performance.now();
  if (m.type === 'ctrl') {
    input.phones[id] = {
      yaw: +m.yaw || 0, shoulder: +m.shoulder || 0, elbow: +m.elbow || 0,
      grip: Math.max(0, Math.min(1, +m.grip || 0)), speed: +m.speed || 1, t: now,
    };
  } else if (m.type === 'event') {
    handleEvent(m.name);
  }
}

function handleEvent(name) {
  if (name === 'bg_next') setTheme(state.themeIndex + 1);
  else if (name === 'bg_prev') setTheme(state.themeIndex - 1);
  else if (name === 'camera') setCam(state.camMode + 1);
  else if (name === 'restart') restartMission();
  else if (name === 'rec_toggle') recToggle();
  else if (name === 'play_toggle') playToggle();
  else if (name === 'loop_toggle') toggleLoop();
}

addEventListener('keydown', (e) => {
  if (e.repeat) { input.keys.add(e.code); return; }
  input.keys.add(e.code);
  if (e.code === 'KeyQ') setTheme(state.themeIndex - 1);
  if (e.code === 'KeyE') setTheme(state.themeIndex + 1);
  if (e.code === 'KeyC') setCam(state.camMode + 1);
  if (e.code === 'KeyG') input.keyLock = !input.keyLock;
  if (e.code === 'Backspace') restartMission();
  if (e.code === 'KeyN') nextMission(true);
  if (e.code === 'KeyB') toggleMode();
  if (e.code === 'KeyH') $('help').classList.toggle('hidden');
  if (e.code === 'KeyV') recToggle();
  if (e.code === 'KeyP') playToggle();
  if (e.code === 'KeyL') toggleLoop();
  if (e.code === 'Space') e.preventDefault();
});
addEventListener('keyup', (e) => input.keys.delete(e.code));
addEventListener('blur', () => input.keys.clear());

// ---------------- 배경 / 카메라 ----------------
function setTheme(i) {
  state.themeIndex = (i + THEMES.length) % THEMES.length;
  const name = applyTheme(themeCtx, state.themeIndex);
  $('theme').textContent = `배경: ${name}  (${state.themeIndex + 1}/${THEMES.length})`;
  feedbackAll({ background: name });
  if (state.phase === 'play') showBanner(name, '배경 전환', '', 1100);
}

const CAMS = ['기본', '위에서', '옆에서', '집게 따라가기'];
const CAMS_BATTLE = ['전체', '위에서', '1P 따라가기', '2P 따라가기'];
function setCam(i) {
  state.camMode = (i + CAMS.length) % CAMS.length;
  $('jCam').textContent = (state.mode === 'battle' ? CAMS_BATTLE : CAMS)[state.camMode];
}
const camTarget = new THREE.Vector3(0, 0.5, -1);
const camLook = new THREE.Vector3(0, 0.5, -1);
function updateCamera(dt) {
  if (state.camFreeze) return;   // 디버그: 카메라 고정
  const want = new THREE.Vector3();
  const look = new THREE.Vector3();
  // 집게 따라가기: 팔 뿌리 → 집게 방향의 뒤쪽 위에서 바라봄
  const follow = (a) => {
    const tip = a.tipPoint.getWorldPosition(new THREE.Vector3());
    const d = tip.clone().sub(a.armRoot.position);
    d.y = 0;
    if (d.lengthSq() < 0.01) d.set(0, 0, -1);
    d.normalize();
    want.copy(tip).addScaledVector(d, -1.6).add(new THREE.Vector3(0, 1.8, 0));
    look.copy(tip);
  };
  if (state.mode === 'battle') {
    if (state.camMode === 0) { want.set(0, 6.6, 6.2); look.set(0, 0, -0.3); }
    else if (state.camMode === 1) { want.set(0, 10, 0.8); look.set(0, 0, 0); }
    else follow(arms[state.camMode === 2 ? 0 : 1]);
  } else if (state.camMode === 0) { want.set(0, 5.2, 5.6); look.set(0, 0.2, -0.9); }
  else if (state.camMode === 1) { want.set(0, 9.5, 0.6); look.set(0, 0, 0); }
  else if (state.camMode === 2) { want.set(6.8, 3.6, -0.4); look.set(0, 0.6, -0.6); }
  else follow(arms[0]);
  const k = 1 - Math.exp(-dt * 4);
  camera.position.lerp(want, k);
  camLook.lerp(look, k);
  camera.lookAt(camLook);
}

// ---------------- 배너 / 소리 ----------------
let bannerTimer;
function showBanner(big, small, cls = '', ms = 1800) {
  const b = $('banner');
  $('bBig').textContent = big;
  $('bSmall').textContent = small;
  b.className = 'show ' + cls;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { b.className = cls; }, ms);
}

let audio;
function beep(freq = 660, dur = 0.12, type = 'sine', vol = 0.15) {
  try {
    audio = audio || new AudioContext();
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + dur);
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + dur);
  } catch { /* 소리 없음 */ }
}
const chord = (notes) => notes.forEach((f, i) => setTimeout(() => beep(f, 0.2, 'triangle'), i * 110));

// 완료 효과: 반짝이는 조각
const sparks = [];
function burst(pos, color) {
  const m = new THREE.MeshBasicMaterial({ color });
  for (let i = 0; i < 24; i++) {
    const s = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.05), m);
    s.position.copy(pos);
    s.userData.v = new THREE.Vector3((Math.random() - 0.5) * 3, Math.random() * 3 + 1, (Math.random() - 0.5) * 3);
    s.userData.life = 1;
    scene.add(s);
    sparks.push(s);
  }
}

// ---------------- 진행 ----------------
function startMission() {
  state.phase = 'play';
  Object.assign(joint, HOME);
  applyJoints(joint);
  const m = state.mission;
  const big = `STAGE ${m.level}`;
  if (m.level === 3) showBanner(big, '⚠ 난이도 상승! 이제부터 제한 시간이 있어요', 'warn', 2600);
  else if (m.level > 3 && m.stars > buildMission(m.level - 1).stars) showBanner(big, `${m.title} · 난이도 상승!`, 'warn', 2200);
  else showBanner(big, m.title, '', 2000);
}

function restartMission() {
  if (state.phase === 'intro') return;
  if (state.mode === 'battle') { startBattle(); return; }
  playStop(true);
  recStop();
  loadMission(state.level);
  startMission();
}

function nextMission(skip = false) {
  if (state.phase === 'intro' || state.mode === 'battle') return;
  playStop(true);
  recStop();
  state.level += 1;
  loadMission(state.level);
  startMission();
  if (skip) showBanner(`STAGE ${state.level}`, '건너뛰었어요 (테스트용)', '', 1500);
}

function completeTask(t, o) {
  t.done = true;
  o.locked = true;
  o.mesh.material.emissive.setHex(COLORS[o.color].hex);
  o.mesh.material.emissiveIntensity = 0.35;
  burst(o.mesh.position.clone().add(new THREE.Vector3(0, o.hy, 0)), COLORS[o.color].hex);
  chord([660, 880]);
  feedback({ vibrate: 60, text: '✔ 성공!' });
  if (rec.mode !== 'play') state.score += 100;
  renderTasks();
  if (state.tasks.every((x) => x.done)) missionSuccess();
}

function missionSuccess() {
  state.phase = 'success';
  chord([523, 659, 784, 1046]);
  if (rec.mode === 'play') {
    // 재생 중 성공: 점수·단계 이동 없이 결과만 표시
    showBanner('재생 성공!', '기록한 동작 그대로 미션을 완료했어요', 'success', 2400);
    feedback({ vibrate: [100, 60, 100], text: '재생 성공!' });
    return;
  }
  const wasRec = rec.mode === 'rec';
  if (wasRec) recStop('success');
  const bonus = state.mission.time ? Math.round(state.timeLeft * 2) : 50;
  state.score += bonus;
  showBanner('미션 성공!', `시간 보너스 +${bonus}${wasRec ? ' · 녹화 저장됨' : ''} · 다음 단계로 이동합니다`, 'success', 2600);
  feedback({ vibrate: [100, 60, 100], text: '미션 성공!' });
  state.pendingTimer = setTimeout(() => nextMission(), 2800);
}

function missionFail() {
  state.phase = 'fail';
  beep(220, 0.5, 'sawtooth', 0.1);
  if (state.held) releaseHeld();
  if (rec.mode === 'rec') recStop('fail');
  showBanner('시간 초과!', '같은 단계를 다시 시작합니다', 'fail', 2600);
  feedback({ vibrate: 300, text: '시간 초과' });
  state.pendingTimer = setTimeout(() => restartMission(), 2800);
}

// 물건이 착지했을 때만 완료 판정 (움직이는 구역이 지나가며 자동 완료되는 것 방지)
function onLanded(o, support) {
  for (const t of state.tasks) {
    if (t.done || t.obj !== o.id) continue;
    const p = o.mesh.position;
    if (t.type === 'zone') {
      const z = zoneById(t.zone);
      const d = Math.hypot(p.x - z.pos[0], p.z - z.pos[1]);
      const bottom = p.y - o.hy;
      if (d <= z.r - 0.04 && Math.abs(bottom - z.height) < 0.06) completeTask(t, o);
    } else if (t.type === 'stack') {
      const below = objById(t.on);
      if (support.obj === below && below.locked) completeTask(t, o);
      else if (support.obj === below && !below.locked) showBanner('순서!', '아래 물건부터 먼저 완료해 주세요', 'warn', 1600);
    }
  }
}

// ---------------- 집기 ----------------
function tryGrab() {
  const gp = grabPoint.getWorldPosition(new THREE.Vector3());
  let best = null, bestD = 1e9;
  for (const o of state.objects) {
    if (o.held || o.locked) continue;
    const p = o.mesh.position;
    const dh = Math.hypot(gp.x - p.x, gp.z - p.z);
    const inY = gp.y > p.y - o.hy - 0.02 && gp.y < p.y + o.hy + 0.06;
    if (dh < 0.2 && inY && dh < bestD) { best = o; bestD = dh; }
  }
  if (!best) return;
  // 위에 다른 물건이 올려져 있으면 같이 떨어지도록 그냥 집음
  best.held = true;
  best.resting = false;
  best.vy = 0;
  wrG.attach(best.mesh);
  state.held = best;
  // 실제 4손가락 그리퍼처럼: 닫히면서 물건을 집게 가운데로 끌어오고, 상자는 손가락과 면이 맞게 돌림
  const lp = best.mesh.position;
  const targetPos = new THREE.Vector3(lp.x, 0, 0);
  let targetQuat = best.mesh.quaternion.clone();
  if (best.shape === 'box') {
    const [ux, uz] = fingerDir(fingers[0]);
    const yawF = Math.atan2(-uz, ux);
    const yawO = worldYaw(best);
    const yawT = yawF + Math.round((yawO - yawF) / (Math.PI / 2)) * (Math.PI / 2);
    const qWorld = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yawT, 0, 'YXZ'));
    targetQuat = wrG.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(qWorld);
  }
  best.grabAnim = { pos: targetPos, quat: targetQuat };
  beep(880, 0.08, 'square', 0.06);
  feedback({ vibrate: 80, held: true });
}

function releaseHeld() {
  const o = state.held;
  if (!o) return;
  missionGroup.attach(o.mesh);
  const e = new THREE.Euler().setFromQuaternion(o.mesh.quaternion, 'YXZ');
  o.mesh.rotation.set(0, e.y, 0);
  o.held = false;
  o.resting = false;
  o.vy = 0;
  state.held = null;
  feedback({ held: false });
  beep(440, 0.08, 'square', 0.05);
}

// ---------------- 녹화 / 재생 ----------------
// 폰 입력이 아니라 "관절 각도 + 집게 상태"를 시간과 함께 기록합니다.
// 재생할 때 같은 단계·같은 시작 상태(물건 배치, 움직이는 구역 시간)로 되돌린 뒤
// 기록된 자세를 그대로 적용하므로 매번 똑같이 반복됩니다.
const REC_KEY = 'robot-arm-recording-v1';
const REC_MIN_STEP = 0;               // 매 프레임 기록 (밀기 결과까지 같게 재현)
const rec = {
  mode: 'idle',      // idle | rec | play
  cur: null,         // 녹화 중인 기록
  data: null,        // 마지막으로 완성된 기록
  t: 0,              // 녹화/재생 경과 시간(초)
  lastT: -1,
  lastGrip: 0,
  fi: 0,             // 재생 중인 프레임 위치
  speed: 1,
  loop: false,
  endHold: 0,
};
const SPEEDS = [0.5, 1, 2];

function validRecording(d) {
  if (!d || typeof d !== 'object' || !Array.isArray(d.frames) || d.frames.length < 2) return null;
  if (!(Number.isInteger(d.level) && d.level >= 1)) return null;
  if (!d.frames.every((f) => Array.isArray(f) && f.length >= 5 && f.every(Number.isFinite))) return null;
  return d;
}
const recDuration = (d) => d.frames[d.frames.length - 1][0];
const fmtTime = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
try {
  const saved = localStorage.getItem(REC_KEY);
  if (saved) rec.data = validRecording(JSON.parse(saved));
} catch { /* 저장소를 쓸 수 없는 환경 */ }

// 집게 끝이 지나간 길 (녹화: 빨강, 재생: 하늘색)
const TRAIL_MAX = 30000;
const trailGeo = new THREE.BufferGeometry();
trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL_MAX * 3), 3));
trailGeo.setDrawRange(0, 0);
const trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ color: 0x38d6ff, transparent: true, opacity: 0.9 }));
trail.frustumCulled = false;
scene.add(trail);
let trailN = 0;
const trailLast = new THREE.Vector3(1e9, 0, 0);
function trailClear() { trailN = 0; trailGeo.setDrawRange(0, 0); trailLast.set(1e9, 0, 0); }
function trailPush(p) {
  if (trailN >= TRAIL_MAX || p.distanceToSquared(trailLast) < 0.0004) return;
  trailGeo.attributes.position.setXYZ(trailN++, p.x, p.y, p.z);
  trailGeo.attributes.position.needsUpdate = true;
  trailGeo.setDrawRange(0, trailN);
  trailLast.copy(p);
}

// 단계를 처음 상태로 되돌림 (녹화·재생 시작점을 똑같이 맞춤)
function resetRun(level) {
  $('connect').classList.add('hidden');
  state.level = level;
  loadMission(level);
  startMission();
  state.clock = 0;
  state.grip = state.gripVis = 0;
  input.keyLock = false;
  vel.yaw = vel.shoulder = vel.elbow = 0;
  trailClear();
}

function recSample(force = false) {
  const g = Math.round(state.grip * 100) / 100;
  if (!force && rec.t - rec.lastT < REC_MIN_STEP && g === rec.lastGrip) return;
  rec.cur.frames.push([+rec.t.toFixed(3), +joint.yaw.toFixed(5), +joint.shoulder.toFixed(5), +joint.elbow.toFixed(5), g]);
  rec.lastT = rec.t;
  rec.lastGrip = g;
}

function recStart() {
  if (rec.mode === 'play') playStop(true);
  resetRun(state.level);
  rec.cur = {
    app: 'tilt-robot-arm-sim', version: 1, level: state.level, title: state.mission.title,
    created: new Date().toISOString(), success: false, frames: [],
  };
  rec.mode = 'rec';
  rec.t = 0; rec.lastT = -1; rec.lastGrip = 0;
  recSample(true);
  trail.material.color.setHex(0xff4d5e);
  showBanner('● 녹화 시작', `STAGE ${state.level} · 지금부터 조종하는 동작을 기록합니다`, 'warn', 2000);
  beep(990, 0.15);
  feedback({ rec: 'rec', text: '● 녹화 시작', vibrate: 60 });
  updateRecUI();
}

// reason: 'user' | 'success' | 'fail'
function recStop(reason = 'user') {
  if (rec.mode !== 'rec') return;
  recSample(true);
  rec.mode = 'idle';
  const d = validRecording(rec.cur);
  rec.cur = null;
  if (!d || recDuration(d) < 0.5) {
    showBanner('녹화 취소', '기록이 너무 짧아요', '', 1500);
    feedback({ rec: 'idle' });
    updateRecUI();
    return;
  }
  d.success = reason === 'success';
  rec.data = d;
  try { localStorage.setItem(REC_KEY, JSON.stringify(d)); } catch { /* 용량 부족 등 */ }
  if (reason === 'user') showBanner('■ 녹화 완료', `${fmtTime(recDuration(d))} 기록 · ▶ 재생으로 똑같이 반복할 수 있어요`, '', 2400);
  feedback({ rec: 'idle', text: '녹화 저장됨' });
  updateRecUI();
}

function playStart() {
  const d = rec.data;
  if (!d) { showBanner('기록 없음', '먼저 ● 녹화로 동작을 기록해 주세요', 'warn', 1800); return; }
  if (rec.mode === 'rec') recStop();
  resetRun(d.level);
  rec.mode = 'play';
  rec.t = 0; rec.fi = 0; rec.endHold = 0;
  const p = playbackPose(d, 0);
  Object.assign(joint, { yaw: p.yaw, shoulder: p.shoulder, elbow: p.elbow });
  applyJoints(joint);
  trail.material.color.setHex(0x38d6ff);
  showBanner('▶ 재생', `STAGE ${d.level} · ${fmtTime(recDuration(d))} 기록 · ${rec.speed}배속${rec.loop ? ' · 반복' : ''}`, '', 1800);
  feedback({ rec: 'play', text: '▶ 재생 중 (조종 잠김)' });
  updateRecUI();
}

function playStop(silent = false) {
  if (rec.mode !== 'play') return;
  rec.mode = 'idle';
  if (!silent) showBanner('■ 재생 정지', '이제 다시 직접 조종할 수 있어요', '', 1500);
  feedback({ rec: 'idle' });
  updateRecUI();
}

function playbackPose(d, t) {
  const f = d.frames;
  while (rec.fi < f.length - 2 && f[rec.fi + 1][0] <= t) rec.fi++;
  const a = f[rec.fi];
  const b = f[Math.min(rec.fi + 1, f.length - 1)];
  const span = b[0] - a[0];
  const u = span > 0 ? Math.min(1, Math.max(0, (t - a[0]) / span)) : 1;
  return {
    yaw: a[1] + (b[1] - a[1]) * u,
    shoulder: a[2] + (b[2] - a[2]) * u,
    elbow: a[3] + (b[3] - a[3]) * u,
    grip: u >= 1 ? b[4] : a[4],
  };
}

const recToggle = () => { if (state.mode === 'battle') return; if (rec.mode === 'rec') recStop(); else recStart(); };
const playToggle = () => { if (state.mode === 'battle') return; if (rec.mode === 'play') playStop(); else playStart(); };
function setSpeed() {
  rec.speed = SPEEDS[(SPEEDS.indexOf(rec.speed) + 1) % SPEEDS.length];
  updateRecUI();
}
function toggleLoop() {
  if (state.mode === 'battle') return;
  rec.loop = !rec.loop;
  feedbackAll({ loop: rec.loop, text: rec.loop ? '🔁 반복 재생 켬' : '반복 재생 끔' });
  updateRecUI();
}

function recDownload() {
  if (!rec.data) { showBanner('기록 없음', '저장할 기록이 없어요', 'warn', 1500); return; }
  const d = rec.data;
  const stamp = d.created.slice(0, 16).replace(/[-:T]/g, '');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(d)], { type: 'application/json' }));
  a.download = `로봇팔기록_STAGE${d.level}_${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function recLoadFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let d = null;
    try { d = validRecording(JSON.parse(reader.result)); } catch { d = null; }
    if (!d) { showBanner('불러오기 실패', '로봇팔 기록 파일(.json)이 아니에요', 'fail', 2000); return; }
    if (rec.mode !== 'idle') { playStop(true); recStop(); }
    rec.data = d;
    try { localStorage.setItem(REC_KEY, JSON.stringify(d)); } catch { /* 무시 */ }
    showBanner('📂 기록 불러옴', `STAGE ${d.level} · ${fmtTime(recDuration(d))} · ▶ 재생을 눌러 보세요`, '', 2200);
    updateRecUI();
  };
  reader.readAsText(file);
}

function updateRecUI() {
  const d = rec.data;
  $('btnRec').textContent = rec.mode === 'rec' ? '■ 녹화 정지' : '● 녹화';
  $('btnRec').classList.toggle('on', rec.mode === 'rec');
  $('btnPlay').textContent = rec.mode === 'play' ? '■ 재생 정지' : '▶ 재생';
  $('btnPlay').classList.toggle('on', rec.mode === 'play');
  $('btnPlay').disabled = !d && rec.mode !== 'play';
  $('btnSave').disabled = !d;
  $('btnSpeed').textContent = `${rec.speed}배속`;
  $('btnLoop').classList.toggle('on', rec.loop);
  $('recPanel').dataset.mode = rec.mode;
  updateRecStatus();
}

function updateRecStatus() {
  const d = rec.data;
  let text, pct = 0;
  if (rec.mode === 'rec') text = `● 녹화 중 ${fmtTime(rec.t)} · STAGE ${state.level}`;
  else if (rec.mode === 'play') {
    const dur = recDuration(d);
    pct = Math.min(1, rec.t / dur);
    text = `▶ 재생 중 ${fmtTime(Math.min(rec.t, dur))} / ${fmtTime(dur)}`;
  } else if (d) text = `저장된 기록: STAGE ${d.level} · ${fmtTime(recDuration(d))}${d.success ? ' · ✔ 성공 기록' : ''}`;
  else text = '기록 없음 · ● 녹화를 눌러 동작을 기록하세요';
  $('recText').textContent = text;
  $('recBar').style.width = (pct * 100).toFixed(1) + '%';
}

$('btnRec').onclick = (e) => { recToggle(); e.currentTarget.blur(); };
$('btnPlay').onclick = (e) => { playToggle(); e.currentTarget.blur(); };
$('btnSpeed').onclick = (e) => { setSpeed(); e.currentTarget.blur(); };
$('btnLoop').onclick = (e) => { toggleLoop(); e.currentTarget.blur(); };
$('btnSave').onclick = (e) => { recDownload(); e.currentTarget.blur(); };
$('btnLoad').onclick = (e) => { $('fileLoad').click(); e.currentTarget.blur(); };
$('fileLoad').onchange = (e) => { if (e.target.files[0]) recLoadFile(e.target.files[0]); e.target.value = ''; };

// ---------------- 배틀 모드 (2인 쟁탈전) ----------------
// 로봇팔 2대가 마주 보고, 가운데 물건을 집어 '내 구역'에 내려놓으면 점수.
// 상자 1점 · 원기둥 2점 · 공 3점 · 황금 상자 5점. 90초 뒤 점수가 높은 쪽이 승리.
const BATTLE_TIME = 90;
const BATTLE_ARM_X = 2.0;                              // 두 팔 사이 거리의 절반
const BATTLE_HOME = { yaw: 0, shoulder: 100 * DEG, elbow: -115 * DEG };   // 배틀 시작 자세 (두 집게가 서로 떨어져 있도록 팔을 접음)
const BATTLE_ZONES = [[-2.0, 1.9], [2.0, 1.9]];       // 1P, 2P 구역: 각 팔의 앞쪽(화면 가까이), 상대 팔은 닿지 않는 위치
const BATTLE_ZONE_R = 0.58;
// 가운데 더미: 육각형 7자리 (벌린 집게가 이웃 물건에 걸리지 않도록 약 70cm 간격)
const PILE_CENTER = [0, 0.2];
const PILE_SPOTS = [PILE_CENTER];
for (let i = 0; i < 6; i++) {
  const a = (i / 6) * Math.PI * 2;
  PILE_SPOTS.push([PILE_CENTER[0] + Math.cos(a) * 0.72, PILE_CENTER[1] + Math.sin(a) * 0.72]);
}
const POINTS = { box: 1, cyl: 2, ball: 3 };
const SHAPE_COLOR = { box: 0xf5c542, cyl: 0x34c96b, ball: 0xa25bff };
const PLAYER = [
  { name: '1P', color: '빨강', hex: 0xe8414f, css: '#ff5d6c' },
  { name: '2P', color: '파랑', hex: 0x3a7bff, css: '#5b95ff' },
];
const battle = { t: 0, scores: [0, 0], count: 0, lastCount: 0, goldTimer: 0, nextId: 0 };

// 모든 팔이 들고 있던 물건을 내려놓은 상태로 정리
function clearHeldAll() {
  for (const a of arms) {
    if (a.held) { missionGroup.attach(a.held.mesh); a.held.held = false; a.held = null; }
    a.grip = a.gripVis = 0;
  }
  state.held = null;
  state.grip = state.gripVis = 0;
}

// 모드에 맞게 로봇팔 배치 (미션: 가운데 1대, 배틀: 양쪽에서 마주 보는 2대)
function placeArms() {
  if (state.mode === 'battle') {
    arms[0].armRoot.position.set(-BATTLE_ARM_X, 0, 0.3);
    arms[0].armRoot.rotation.y = -Math.PI / 2;
    arms[1].armRoot.position.set(BATTLE_ARM_X, 0, 0.3);
    arms[1].armRoot.rotation.y = Math.PI / 2;
    arms[0].glow.emissive.setHex(ARM_GLOW.p1);
    arms[1].glow.emissive.setHex(ARM_GLOW.p2);
    arms[1].armRoot.visible = arms[1].guideLine.visible = arms[1].guideDot.visible = true;
  } else {
    arms[0].armRoot.position.set(0, 0, 0);
    arms[0].armRoot.rotation.y = 0;
    arms[0].glow.emissive.setHex(ARM_GLOW.mission);
    if (arms[1]) arms[1].armRoot.visible = arms[1].guideLine.visible = arms[1].guideDot.visible = false;
  }
  for (const a of arms) {
    useArm(a);
    Object.assign(joint, state.mode === 'battle' ? BATTLE_HOME : HOME);
    vel.yaw = vel.shoulder = vel.elbow = 0;
    gripWait.t = 0; gripWait.failed = false;
    applyJoints(joint);
    a.spheres = null;
    saveArm(a);
  }
  useArm(arms[0]);
}

function spawnBattleObject(x, z, shape, gold = false, drop = 0) {
  let geo, hx, hy, hz;
  if (shape === 'box') { geo = new THREE.BoxGeometry(0.36, 0.36, 0.36); hx = hy = hz = 0.18; }
  else if (shape === 'cyl') { geo = new THREE.CylinderGeometry(0.16, 0.16, 0.44, 28); hx = hz = 0.16; hy = 0.22; }
  else { geo = new THREE.SphereGeometry(0.19, 28, 20); hx = hy = hz = 0.19; }
  const m = gold
    ? metal({ color: 0xffc531, roughness: 0.22, emissive: 0x5a3d00, emissiveIntensity: 0.7 })
    : new THREE.MeshStandardMaterial({ color: SHAPE_COLOR[shape], roughness: 0.45, metalness: 0.1 });
  const ms = mesh(geo, m);
  ms.position.set(x, hy + drop, z);
  ms.rotation.y = Math.random() * Math.PI;
  missionGroup.add(ms);
  const o = {
    id: 'b' + battle.nextId++, label: '', color: 'yellow', shape, rad: shape === 'box' ? hx * 1.12 : hx,
    mesh: ms, hx, hy, hz, held: false, resting: drop === 0, vy: 0, locked: false,
    points: gold ? 5 : POINTS[shape], gold,
  };
  state.objects.push(o);
  return o;
}

// 가운데 더미에서 비어 있는 자리
function freePileSpot() {
  for (let i = 0; i < 30; i++) {
    const a = Math.random() * Math.PI * 2, r = Math.random() * 0.8;
    const x = PILE_CENTER[0] + Math.cos(a) * r, z = PILE_CENTER[1] + Math.sin(a) * r;
    if (state.objects.every((o) => o.held || Math.hypot(o.mesh.position.x - x, o.mesh.position.z - z) > 0.68)) return [x, z];
  }
  return null;
}

function startBattle() {
  clearTimeout(state.pendingTimer);
  clearHeldAll();
  disposeGroup(missionGroup);
  state.objects = [];
  state.zones = [];
  state.obstacles = [];
  state.tasks = [];
  BATTLE_ZONES.forEach(([x, z], p) => {
    const g = new THREE.Group();
    const disc = new THREE.Mesh(new THREE.CircleGeometry(BATTLE_ZONE_R, 48),
      new THREE.MeshStandardMaterial({ color: PLAYER[p].hex, transparent: true, opacity: 0.45, roughness: 0.6 }));
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.012;
    disc.receiveShadow = true;
    const ring = new THREE.Mesh(new THREE.RingGeometry(BATTLE_ZONE_R - 0.05, BATTLE_ZONE_R, 48),
      new THREE.MeshBasicMaterial({ color: PLAYER[p].hex, side: THREE.DoubleSide, transparent: true }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.016;
    const label = makeLabel(`${PLAYER[p].name} 구역`, PLAYER[p].hex);
    label.position.y = 0.75;
    g.add(disc, ring, label);
    g.position.set(x, 0, z);
    missionGroup.add(g);
    state.zones.push({ id: 'p' + p, group: g, ring, r: BATTLE_ZONE_R, height: 0, move: null, pos: [x, z], player: p });
  });
  const shapes = ['box', 'box', 'box', 'cyl', 'cyl', 'ball', 'ball'].sort(() => Math.random() - 0.5);
  PILE_SPOTS.forEach(([x, z], i) => spawnBattleObject(x + (Math.random() - 0.5) * 0.06, z + (Math.random() - 0.5) * 0.06, shapes[i]));
  battle.scores = [0, 0];
  battle.t = BATTLE_TIME;
  battle.count = 3.99;
  battle.lastCount = 4;
  battle.goldTimer = 15;
  state.phase = 'countdown';
  placeArms();
  updateBattleHud();
  updateBattleTimer();
}

function enterBattle() {
  if (state.mode === 'battle') { startBattle(); return; }
  playStop(true);
  recStop();
  state.mode = 'battle';
  if (!arms[1]) arms.push(makeArm(ARM_GLOW.p2, 0x4d8bff));
  $('connect').classList.add('hidden');
  document.body.classList.add('battle');
  $('scoreMission').hidden = true;
  $('scoreBattle').hidden = false;
  $('btnMode').textContent = '🎯 미션 모드';
  assignArms();
  startBattle();
  setCam(0);
  announcePlayers();
}

function enterMission() {
  if (state.mode === 'mission') return;
  clearHeldAll();
  state.mode = 'mission';
  document.body.classList.remove('battle');
  $('scoreMission').hidden = false;
  $('scoreBattle').hidden = true;
  $('btnMode').textContent = '⚔ 배틀 모드';
  $('diff').textContent = '';
  assignArms();
  placeArms();
  loadMission(state.level);
  startMission();
  setCam(0);
  announcePlayers();
}
const toggleMode = () => (state.mode === 'battle' ? enterMission() : enterBattle());

// 물건이 어느 쪽 구역에 내려앉았는지 → 점수
function battleLanded(o) {
  if (o.dead) return;
  const p = o.mesh.position;
  for (const z of state.zones) {
    if (Math.hypot(p.x - z.pos[0], p.z - z.pos[1]) <= z.r - 0.02 && p.y - o.hy < 0.06) {
      o.dead = true;
      battle.scores[z.player] += o.points;
      burst(p.clone().add(new THREE.Vector3(0, o.hy, 0)), PLAYER[z.player].hex);
      chord(o.gold ? [784, 988, 1175] : [660, 880]);
      const id = players[z.player];
      if (id != null) sendFeedback({ vibrate: [60, 40, 60], text: `+${o.points}점!${o.gold ? ' 황금!' : ''}` }, id);
      updateBattleHud();
      return;
    }
  }
}

// 점수가 난 물건과 판 밖으로 멀리 밀려난 물건 치우기
function battleCleanup() {
  const gone = state.objects.filter((o) => o.dead || (!o.held && Math.hypot(o.mesh.position.x, o.mesh.position.z) > 3.9));
  if (!gone.length) return;
  for (const o of gone) {
    missionGroup.remove(o.mesh);
    o.mesh.geometry.dispose();
    o.mesh.material.dispose();
  }
  state.objects = state.objects.filter((o) => !gone.includes(o));
}

function battleTick(dt) {
  if (state.phase === 'countdown') {
    battle.count -= dt;
    const n = Math.ceil(battle.count);
    if (n !== battle.lastCount) {
      battle.lastCount = n;
      if (n > 0) {
        showBanner(String(n), '2인 쟁탈전 · 가운데 물건을 내 구역으로!', 'warn', 900);
        beep(520, 0.12);
      } else {
        state.phase = 'battle';
        showBanner('시작!', '물건을 집어 내 구역에 내려놓으세요', 'success', 1200);
        chord([660, 880]);
        feedbackAll({ vibrate: 200, text: '시작!' });
      }
    }
  } else if (state.phase === 'battle') {
    battle.t -= dt;
    // 20초마다 황금 상자
    battle.goldTimer -= dt;
    if (battle.goldTimer <= 0) {
      battle.goldTimer = 20;
      const spot = !state.objects.some((o) => o.gold) && freePileSpot();
      if (spot) {
        spawnBattleObject(spot[0], spot[1], 'box', true, 1.4);
        showBanner('황금 상자!', '가운데에 5점짜리 황금 상자가 떨어졌어요', 'warn', 1500);
        beep(1046, 0.2, 'triangle');
      }
    }
    // 가운데 물건이 줄면 위에서 떨어뜨려 보충
    if (state.objects.filter((o) => !o.dead && !o.held).length < 3) {
      for (let i = 0; i < 3; i++) {
        const spot = freePileSpot();
        if (!spot) break;
        spawnBattleObject(spot[0], spot[1], ['box', 'box', 'cyl', 'ball'][Math.floor(Math.random() * 4)], false, 1.2);
      }
    }
    if (battle.t <= 0) { battle.t = 0; endBattle(); }
  }
  updateBattleTimer();
}

function endBattle() {
  state.phase = 'over';
  for (const a of arms) { useArm(a); if (state.held) releaseHeld(); saveArm(a); }
  useArm(arms[0]);
  const [s1, s2] = battle.scores;
  const w = s1 === s2 ? -1 : s1 > s2 ? 0 : 1;
  chord([523, 659, 784, 1046]);
  showBanner(w < 0 ? '무승부!' : `${PLAYER[w].name} 승리!`, `${s1} : ${s2} · ↺ 다시(Backspace)를 누르면 재대결`, w < 0 ? 'warn' : 'success', 8000);
  players.forEach((id, p) => {
    if (id == null) return;
    const win = w === p;
    sendFeedback({ vibrate: win ? [100, 60, 100, 60, 250] : 400, text: w < 0 ? '무승부!' : win ? '🏆 승리!' : '아쉽게 졌어요' }, id);
  });
  updateBattleHud();
}

function updateBattleHud() {
  if (state.mode !== 'battle') return;
  $('stageNo').textContent = 'BATTLE';
  $('mTitle').textContent = '2인 쟁탈전';
  $('mDesc').textContent = '가운데 물건을 집어 내 구역에 내려놓으세요. 상자 1점 · 원기둥 2점 · 공 3점 · 황금 상자 5점. 상대 팔을 막거나 물건을 밀어낼 수도 있어요.';
  $('diff').textContent = '⚔ 대결 모드 · B 키로 미션 모드';
  const ul = $('tasks');
  ul.innerHTML = '';
  PLAYER.forEach((pl, p) => {
    const li = document.createElement('li');
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.background = pl.css;
    const who = players[p] != null ? '폰' : arms[p] && arms[p].keyboard ? 'PC 키보드' : '폰 대기 중';
    li.append(chip, document.createTextNode(`${pl.name} ${pl.color} · ${who}`));
    const b = document.createElement('b');
    b.className = 'pts';
    b.textContent = `${battle.scores[p]}점`;
    li.appendChild(b);
    ul.appendChild(li);
  });
  $('scoreBattle').innerHTML = `<b style="color:${PLAYER[0].css}">1P ${battle.scores[0]}</b> : <b style="color:${PLAYER[1].css}">${battle.scores[1]} 2P</b>`;
}

function updateBattleTimer() {
  const el = $('timer');
  if (state.phase === 'countdown') { el.textContent = '준비'; el.classList.remove('low'); return; }
  const s = Math.max(0, Math.ceil(battle.t));
  el.textContent = state.phase === 'over' ? '경기 종료' : `⏱ ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  el.classList.toggle('low', s <= 10 && state.phase === 'battle');
}

// ---------------- 메인 루프 ----------------
const RATE = { yaw: 75 * DEG, shoulder: 48 * DEG, elbow: 65 * DEG };
let last = performance.now();

function frame(now) {
  tick(now);
  requestAnimationFrame(frame);
}

// 로봇팔 한 대의 한 프레임: 입력 → 관절 이동(충돌 검사) → 집게 → 접촉 진동 → 녹화
function armStep(a, dt, now) {
  // 입력 합치기 (폰 신호가 0.5초 이상 끊기면 정지)
  const camOn = a === arms[0] && input.cam.active;
  let L;
  if (camOn) {
    // 카메라: 목표 관절 각도와 지금 각도의 차이만큼 움직임 (기존 충돌·집기 처리는 그대로)
    if (now - input.cam.t < 400) {
      const t = camIK(input.cam), j = a.joint;
      const c = (v) => Math.max(-1, Math.min(1, v * 4));
      L = { yaw: -c(t.yaw - j.yaw), shoulder: -c(t.shoulder - j.shoulder), elbow: -c(t.elbow - j.elbow), grip: input.cam.grip, speed: 1.3 };
    } else L = { ...IDLE_INPUT, grip: input.cam.grip };   // 손이 안 보이면 멈춤 (집게는 그대로)
  } else {
    const src = a.phoneId != null ? input.phones[a.phoneId] : null;
    L = src && now - src.t < 500 ? src : IDLE_INPUT;
  }
  const k = a.keyboard && !camOn ? input.keys : NO_KEYS;
  const keyLock = a.keyboard && !camOn && input.keyLock;
  const key = (a, b) => (k.has(a) ? 1 : 0) - (k.has(b) ? 1 : 0);
  const target = {
    yaw: -(L.yaw + key('KeyD', 'KeyA')) * L.speed,           // 오른쪽 기울임 → 오른쪽 회전
    shoulder: -(L.shoulder + key('KeyW', 'KeyS')) * L.speed, // 앞으로 숙임 → 팔이 앞/아래로
    elbow: -(L.elbow + key('KeyF', 'KeyR')) * L.speed,       // 앞으로 숙임 → 팔뚝이 아래로
  };
  const playing = state.phase === 'play' || state.phase === 'success' || state.phase === 'battle';
  const replay = rec.mode === 'play' && a === arms[0];
  const sm = 1 - Math.exp(-dt * 10);
  for (const j of ['yaw', 'shoulder', 'elbow']) {
    vel[j] += ((playing ? Math.max(-1.6, Math.min(1.6, target[j])) : 0) - vel[j]) * sm;
  }

  // 관절을 하나씩 움직여 보고, 부딪히면 그 관절만 되돌림 (벽을 따라 미끄러지듯)
  let touched = false, hitHard = false, floorHit = false;
  if (replay) {
    // 재생: 기록된 관절 각도와 집게 상태를 그대로 적용 (조종 입력은 무시)
    rec.t += dt;
    const pose = playbackPose(rec.data, rec.t);
    joint.yaw = pose.yaw; joint.shoulder = pose.shoulder; joint.elbow = pose.elbow;
    applyJoints(joint);
    state.grip = pose.grip;
    vel.yaw = vel.shoulder = vel.elbow = 0;
  } else {
    const moving = ['yaw', 'shoulder', 'elbow'].some((j) => Math.abs(vel[j]) > 1e-4);
    // 지금 자세가 이미 끼어 있으면, 더 깊이 끼는 쪽은 막고 빠져나오는 쪽만 허용
    let floor0 = moving ? floorDepth() : 0;
    const wall0 = moving && poseInvalid();
    let block0 = moving ? resolveContacts(false).blockDepth : 0;
    for (const j of ['yaw', 'shoulder', 'elbow']) {
      if (Math.abs(vel[j]) < 1e-4) continue;
      const prev = joint[j];
      const snap = snapObjects();
      joint[j] = Math.max(LIMITS[j][0], Math.min(LIMITS[j][1], prev + vel[j] * RATE[j] * dt));
      applyJoints(joint);
      let bad = false;
      const fd = floorDepth();
      if (fd > 1e-4 && fd > floor0 + 1e-4) { bad = true; floorHit = true; }          // 바닥: 항상 막음
      else if (!wall0 && poseInvalid()) { bad = true; hitHard = true; }              // 벽·받침대
      else {
        const c = resolveContacts(true);                                              // 물건 밀기
        if (c.contact) touched = true;
        if (c.blocked && c.blockDepth > block0 + 1e-4) { bad = true; hitHard = true; }
        else block0 = c.blockDepth;
      }
      if (bad) { joint[j] = prev; vel[j] = 0; applyJoints(joint); restoreObjects(snap); }
      else floor0 = Math.min(floor0, fd);
    }
    // 폰의 '집기'를 눌렀는데 0.45초 안에 잡히는 물건이 없으면 집게를 다시 열고 폰 버튼도 '집기'로 되돌림
    let phoneGrip = L.grip;
    if (phoneGrip > 0.5 && !state.held) {
      gripWait.t += dt;
      if (gripWait.t > 0.45 && !gripWait.failed) {
        gripWait.failed = true;
        feedback({ gripFail: true, vibrate: [40, 60, 40], text: '잡을 물건이 없어요 · 집게를 물건 위에 맞춰 주세요' });
        if (camOn) showBanner('잡을 물건이 없어요', '손을 펴고, 집게를 물건 위에 맞춘 뒤 다시 쥐세요', 'warn', 1600);
      }
    } else if (phoneGrip <= 0.5) {
      gripWait.t = 0;
      gripWait.failed = false;
    }
    if (gripWait.failed && !state.held) phoneGrip = 0;
    state.grip = playing ? Math.max(phoneGrip, k.has('Space') ? 1 : 0, keyLock ? 1 : 0) : 0;
  }

  // 집게
  state.gripVis += (state.grip - state.gripVis) * (1 - Math.exp(-dt * 14));
  if (!state.held && state.grip > 0.55) tryGrab();
  if (state.held && state.grip < 0.35) releaseHeld();
  // 잡은 물건을 집게 가운데로 정렬하는 짧은 애니메이션
  if (state.held && state.held.grabAnim) {
    const ga = state.held.grabAnim, kk = 1 - Math.exp(-dt * 20);
    state.held.mesh.position.lerp(ga.pos, kk);
    state.held.mesh.quaternion.slerp(ga.quat, kk);
    if (state.held.mesh.position.distanceToSquared(ga.pos) < 1e-8) state.held.grabAnim = null;
  }
  // 손가락: 원하는 벌림까지 닫히되, 물건 표면에 닿으면 그 자리에서 멈춤 (뚫고 들어가지 않음)
  const gap = MAX_GAP * (1 - state.gripVis) + 0.08;
  const rWant = gap / 2 + 0.03;
  const W = wrG.getWorldPosition(new THREE.Vector3());
  const yLo = W.y - 0.58, yHi = W.y - 0.2;          // 손가락이 차지하는 높이
  for (const f of fingers) {
    const [ux, uz] = fingerDir(f);
    const rNow = f.finger.position.z;
    let r = rWant;
    for (const o of state.objects) {
      const sC = fingerContactDist(o, W.x, W.z, ux, uz, yLo, yHi);
      if (sC === -Infinity) continue;
      const rMin = sC + PAD_IN;
      if (rNow >= rMin - 0.02 || o.held) r = Math.max(r, rMin);   // 바깥에서 닫혀 오던 손가락만 표면에서 멈춤
    }
    f.finger.position.z = r;
  }

  // 손가락이 닫히거나 재생 중 팔이 움직이며 닿은 물건 밀기 + 접촉 진동
  const cc = resolveContacts(true);
  if (cc.contact) touched = true;
  const armActive = replay || ['yaw', 'shoulder', 'elbow'].some((j) => Math.abs(vel[j]) > 0.05) || cc.moved;
  // 진동 종류: 바닥 > 벽·고정된 물건 > 물건 (손끝이 바닥에 1cm 이내로 닿아 있어도 '바닥'으로 봄)
  if (!floorHit && !replay && floorDepth() > -0.01 && tipPoint.getWorldPosition(new THREE.Vector3()).y < 0.05) floorHit = armActive;
  const kind = floorHit ? 'floor' : hitHard ? 'hit' : touched ? 'touch' : null;
  contactFeedback(kind, armActive || floorHit || hitHard, performance.now());

  // 녹화 / 재생 진행
  if (a !== arms[0] || state.mode !== 'mission') return;
  if (rec.mode === 'rec' && state.phase === 'play') {
    rec.t += dt;
    recSample();
    trailPush(tipPoint.getWorldPosition(new THREE.Vector3()));
  } else if (replay) {
    trailPush(tipPoint.getWorldPosition(new THREE.Vector3()));
    if (rec.t >= recDuration(rec.data)) {
      rec.endHold += dt;            // 마지막 물건이 떨어져 판정될 시간을 잠깐 줌
      if (rec.endHold > 1.2) {
        if (rec.loop) playStart();
        else { playStop(true); showBanner('재생 끝', '▶ 재생으로 다시 보거나, 직접 조종할 수 있어요', '', 2000); }
      }
    }
  }
}

function tick(now) {
  let dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
  last = Math.max(last, now);
  if (rec.mode === 'play') dt *= rec.speed;   // 재생 속도에 맞춰 시간 전체를 빠르게/느리게
  state.clock += dt;

  // 로봇팔마다: 조종 → 충돌 → 집게 (배틀에서는 2대, 서로의 위치를 참고해 부딪힘 검사)
  const list = activeArms();
  for (const a of list) { useArm(a); a.spheres = armSpheres(); saveArm(a); }
  for (const a of list) { useArm(a); armStep(a, dt, now); a.spheres = armSpheres(); saveArm(a); }
  useArm(arms[0]);
  if (rec.mode !== 'idle') updateRecStatus();

  // 물건 낙하 / 착지
  for (const o of state.objects) {
    if (o.held) continue;
    const p = o.mesh.position;
    const sup = supportBelow(p.x, p.z, p.y - o.hy, o, o.hx, o.hz);
    if (o.resting) {
      if (p.y - o.hy > sup.y + 0.01) o.resting = false;   // 아래 받침이 사라짐
      else continue;
    }
    o.vy -= 9.8 * dt;
    p.y += o.vy * dt;
    if (p.y - o.hy <= sup.y) {
      p.y = sup.y + o.hy;
      const hard = o.vy < -1;
      o.vy = 0;
      o.resting = true;
      if (hard) beep(160, 0.06, 'triangle', 0.08);
      if (state.phase === 'play') onLanded(o, sup);
      else if (state.phase === 'battle') battleLanded(o);
    }
  }
  if (state.mode === 'battle') battleCleanup();

  // 움직이는 구역
  for (const z of state.zones) {
    if (!z.move) continue;
    const deg = z.baseDeg + Math.sin(state.clock * z.move.speed) * z.move.amp;
    const [x, zz] = polar(deg, z.baseR);
    z.pos[0] = x; z.pos[1] = zz;
    z.group.position.set(x, 0, zz);
  }
  // 목표 구역 테두리 깜빡임
  for (const z of state.zones) z.ring.material.opacity = 0.6 + Math.sin(state.clock * 4) * 0.4;

  // 안내선 (팔마다)
  for (const a of list) {
    useArm(a);
    const gp = grabPoint.getWorldPosition(new THREE.Vector3());
    const tip = tipPoint.getWorldPosition(new THREE.Vector3());
    const top = state.held ? objBox(state.held, _box).min.y : tip.y;
    const sup = supportBelow(gp.x, gp.z, top, state.held);
    const len = Math.max(0.001, top - sup.y);
    guideLine.scale.y = len;
    guideLine.position.set(gp.x, sup.y + len / 2, gp.z);
    guideDot.position.set(gp.x, sup.y + 0.02, gp.z);
    saveArm(a);
  }
  useArm(arms[0]);

  // 시간
  if (state.phase === 'play' && state.mission.time && rec.mode !== 'play') {
    state.timeLeft -= dt;
    if (state.timeLeft <= 0) { state.timeLeft = 0; missionFail(); }
    updateTimer();
  }
  if (state.mode === 'battle') battleTick(dt);

  // 효과
  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i];
    s.userData.v.y -= 9.8 * dt;
    s.position.addScaledVector(s.userData.v, dt);
    s.userData.life -= dt;
    s.scale.setScalar(Math.max(0.01, s.userData.life));
    if (s.userData.life <= 0) { scene.remove(s); s.geometry.dispose(); sparks.splice(i, 1); }
  }
  if (decor.userData.update) decor.userData.update(state.clock, dt);

  // HUD
  $('jYaw').textContent = `${(joint.yaw / DEG).toFixed(0)}°`;
  $('jSh').textContent = `${(joint.shoulder / DEG).toFixed(0)}°`;
  $('jEl').textContent = `${(joint.elbow / DEG).toFixed(0)}°`;
  $('jGrip').textContent = `${Math.round(state.grip * 100)}%${state.held ? ' · 잡는 중' : ''}`;
  if (state.mode === 'mission') $('scoreVal').textContent = state.score;

  updateCamera(dt);
  renderer.render(scene, camera);
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------------- 시작 화면 ----------------
// 연결 정보(QR·방 코드) 표시
function showConnectInfo(info) {
  if (info.error) { $('ipNote').textContent = info.error; return; }
  $('qrPhone').innerHTML = info.qrSvg;
  $('urlPhone').textContent = info.phoneUrl;
  if (info.mode === 'web') {
    $('connMode').textContent = '인터넷 연결 모드 · 설치 없이 바로 사용';
    $('roomCode').textContent = info.code;
    $('roomRow').hidden = false;
    $('warnTip').textContent = '폰에서 QR 주소를 열고 [시작하기]를 누르면 연결됩니다.';
    $('ipNote').textContent = 'PC와 폰 모두 인터넷이 되어야 해요. 연결이 잘 안 되면 같은 Wi‑Fi에 연결하거나, PC에서 시작.bat 으로 실행해 보세요.';
  } else {
    $('connMode').textContent = '같은 Wi‑Fi 연결 모드 (이 PC에서 실행 중)';
    $('roomRow').hidden = true;
    $('ipNote').textContent = info.ips.length > 1
      ? `QR로 접속이 안 되면 주소의 IP를 다음 중 하나로 바꿔 보세요: ${info.ips.join(', ')}`
      : '폰이 접속되지 않으면 PC 방화벽에서 Node.js 허용 여부를 확인하세요.';
  }
}
openDisplayLink({ onMessage: onPhoneMessage, onStatus: onPhoneStatus, onInfo: showConnectInfo })
  .then((l) => { link = l; });

function startFromIntro() {
  $('connect').classList.add('hidden');
  if (state.phase === 'intro') { beep(660, 0.1); startMission(); }
}
$('btnStart').onclick = () => { if (state.mode === 'battle') enterMission(); startFromIntro(); document.activeElement.blur(); };
$('btnBattle').onclick = () => { beep(660, 0.1); enterBattle(); document.activeElement.blur(); };
$('btnMode').onclick = () => { toggleMode(); document.activeElement.blur(); };

// ---------------- 웹캠 손 조종 ----------------
function pcFlash(kind) {
  const f = $('pcFlash');
  f.className = '';
  void f.offsetWidth;
  f.className = kind;
}
const handCam = createHandCam({
  panel: $('camPanel'), video: $('camVideo'), canvas: $('camCanvas'),
  status: $('camStatus'), info: $('camInfo'), overlay: $('camOverlay'),
  onLoadStep: (t) => { $('camInfo').textContent = t; },
  onTarget: (t) => {
    if (!t) { input.cam.t = 0; return; }
    Object.assign(input.cam, t, { t: performance.now() });
  },
  onSide: (s) => { $('camSide').textContent = s === 'left' ? '왼손' : '오른손'; },
  onCalibrated: () => { beep(880, 0.12); if (state.phase === 'intro') startFromIntro(); },
});
async function toggleHandCam() {
  if (input.cam.active) {
    handCam.close();
    input.cam.active = false;
    document.body.classList.remove('cam');
    $('btnHand').classList.remove('on');
    return;
  }
  input.cam.active = true;
  input.cam.t = 0;
  document.body.classList.add('cam');
  $('btnHand').classList.add('on');
  $('camSide').textContent = handCam.side === 'left' ? '왼손' : '오른손';
  $('camSens').value = Math.round(handCam.sens * 100);
  $('connect').classList.add('hidden');
  try { await handCam.open(); }
  catch { input.cam.active = false; $('btnHand').classList.remove('on'); }
}
$('btnHand').onclick = () => { toggleHandCam(); document.activeElement.blur(); };
$('camClose').onclick = () => { toggleHandCam(); document.activeElement.blur(); };
$('camCalib').onclick = () => { handCam.recalibrate(); document.activeElement.blur(); };
$('camSens').oninput = () => handCam.setSens($('camSens').value / 100);
const CAM_HELP = {
  wrist: '손 <b>좌우</b> → 회전 · 팔꿈치를 굽혀 손 <b>올리기/내리기</b> → 로봇 위팔 세우기/눕히기 · 손목을 꺾어 <b>손바닥 숙이기/젖히기</b> → 아래팔 내리기/올리기 · <b>주먹</b>(또는 엄지·검지 집기) → 집기, <b>펴기</b> → 놓기',
  pos: '손 <b>좌우</b> → 회전 · <b>들고 내리기</b> → 집게 높이 · 화면 쪽으로 <b>밀고 당기기</b> → 앞뒤 · <b>주먹</b>(또는 엄지·검지 집기) → 집기, <b>펴기</b> → 놓기',
};
function showCamScheme() {
  const s = handCam.scheme;
  $('camScheme').textContent = s === 'wrist' ? '방식: 손목' : '방식: 위치';
  $('camHelp').innerHTML = CAM_HELP[s];
}
$('camScheme').onclick = () => { handCam.setScheme(handCam.scheme === 'wrist' ? 'pos' : 'wrist'); showCamScheme(); document.activeElement.blur(); };
showCamScheme();
$('btnConnect').onclick = () => { $('connect').classList.toggle('hidden'); document.activeElement.blur(); };

setTheme(0);
setCam(0);
applyJoints(joint);
loadMission(state.level);
updateRecUI();
requestAnimationFrame(frame);

// 디버그용 (브라우저 콘솔에서 상태 확인)
window.__sim = {
  state, input, tick, camera, rec, arms, players, battle, useArm, saveArm, enterBattle, enterMission, fingerDir, fingerContactDist, worldYaw,
  poseInvalid, resolveContacts, floorDepth, armSpheres, applyJoints, handCam, camIK,
  get joint() { return arms[0].joint; }, get tipPoint() { return arms[0].tipPoint; }, get grabPoint() { return arms[0].grabPoint; },
  get fingers() { return arms[0].fingers; }, get wrG() { return arms[0].wrG; },
};
