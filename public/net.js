// PC 화면 ↔ 스마트폰 연결
//
// 로컬 모드: 이 PC에서 server.js 를 실행해 열었을 때
//   - 같은 Wi‑Fi 안에서 WebSocket 으로 연결 (인터넷 없이도 동작)
// 웹 모드: GitHub Pages 처럼 서버 없이 열었을 때
//   - PeerJS(WebRTC)로 PC와 폰을 인터넷을 통해 직접 연결
//   - PC 화면이 '방 코드'를 만들고, 폰은 QR(…/phone.html?room=코드)로 그 방에 들어감
//
// 어느 모드인지는 api/info 가 응답하는지로 자동 판단합니다.

const PEER_PREFIX = 'tiltarm-v1-';
const PEERJS_URL = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
const QRCODE_URL = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // 헷갈리는 0/O, 1/I 제외
const ROOM_KEY = 'tiltarm-room';

export const normalizeRoom = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`스크립트를 불러오지 못했어요: ${src}`));
    document.head.appendChild(s);
  });
}

// 로컬 서버(server.js)가 있으면 그 정보를, 없으면 null
export async function detectLocalServer() {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2500);
    const r = await fetch('api/info', { cache: 'no-store', signal: ctl.signal });
    clearTimeout(timer);
    if (!r.ok) return null;
    const info = await r.json();
    return info && info.phone ? info : null;
  } catch {
    return null;
  }
}

function newRoomCode() {
  let s = '';
  const buf = new Uint32Array(5);
  crypto.getRandomValues(buf);
  for (const n of buf) s += CODE_CHARS[n % CODE_CHARS.length];
  return s;
}

// ---------------- PC 화면 쪽 ----------------
// onMessage(m, fromId): 폰이 보낸 메시지와 보낸 폰의 번호
// onStatus({phones: [폰 번호...]}), onInfo({mode, phoneUrl, qrSvg, code, ips, error})
// send(obj, toId): toId 가 있으면 그 폰에게만, 없으면 모든 폰에게
export async function openDisplayLink({ onMessage, onStatus, onInfo }) {
  const info = await detectLocalServer();
  if (info) {
    let ws;
    const connect = () => {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', role: 'display' }));
      ws.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        if (m.type === 'status') onStatus({ phones: (m.phones || []).map(String) });
        else onMessage(m, m.from != null ? String(m.from) : '');
      };
      ws.onclose = () => { onStatus({ phones: [] }); setTimeout(connect, 1000); };
    };
    connect();
    onInfo({ mode: 'local', phoneUrl: info.phone, qrSvg: info.phoneQR, ips: info.ips || [] });
    return {
      mode: 'local',
      send: (obj, to) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(to != null ? { ...obj, to } : obj)); },
    };
  }

  // 웹 모드
  try {
    await Promise.all([loadScript(PEERJS_URL), loadScript(QRCODE_URL)]);
  } catch (e) {
    onInfo({ mode: 'web', error: '연결 도구를 불러오지 못했어요. 인터넷 연결을 확인하거나, PC에서 시작.bat 으로 실행해 주세요.' });
    return { mode: 'web', send: () => {} };
  }
  const conns = new Map();   // 폰 번호(peer id) → 연결
  const phoneList = () => [...conns.keys()];
  const folder = location.href.replace(/[?#].*$/, '').replace(/[^/]*$/, '');
  let code = null;
  try { code = normalizeRoom(localStorage.getItem(ROOM_KEY)); } catch { /* 무시 */ }
  if (!code || code.length < 4) code = newRoomCode();
  let peer = null;

  const start = (attempt = 0) => {
    peer = new window.Peer(PEER_PREFIX + code, { debug: 0 });
    peer.on('open', () => {
      try { localStorage.setItem(ROOM_KEY, code); } catch { /* 무시 */ }
      const url = `${folder}phone.html?room=${code}`;
      const qr = window.qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      onInfo({ mode: 'web', phoneUrl: url, qrSvg: qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }), code });
    });
    peer.on('connection', (c) => {
      const id = String(c.peer);
      const drop = () => { if (conns.get(id) === c) conns.delete(id); onStatus({ phones: phoneList() }); };
      c.on('open', () => {
        conns.set(id, c);
        onStatus({ phones: phoneList() });
        c.send({ type: 'status', display: true });
      });
      c.on('data', (m) => { if (m && typeof m === 'object' && m.type !== 'hello') onMessage(m, id); });
      c.on('close', drop);
      c.on('error', drop);
    });
    peer.on('disconnected', () => { try { peer.reconnect(); } catch { /* 무시 */ } });
    peer.on('error', (err) => {
      if (err.type === 'unavailable-id') {
        // 새로고침 직후에는 예전 방이 잠시 남아 있음 → 조금 기다렸다 다시, 그래도 안 되면 새 방 코드
        peer.destroy();
        if (attempt < 3) setTimeout(() => start(attempt + 1), 2500);
        else { code = newRoomCode(); start(0); }
      } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
        onInfo({ mode: 'web', error: '연결 중계 서버에 닿지 않아요. 인터넷 연결을 확인해 주세요. 계속 다시 시도합니다…' });
        peer.destroy();
        setTimeout(() => start(attempt), 4000);
      }
    });
  };
  start();
  return {
    mode: 'web',
    send: (obj, to) => {
      if (to != null) { const c = conns.get(String(to)); if (c && c.open) c.send(obj); return; }
      conns.forEach((c) => { if (c.open) c.send(obj); });
    },
  };
}

// ---------------- 스마트폰 쪽 ----------------
// room 이 있으면 웹 모드(PeerJS), 없으면 로컬 모드(WebSocket)
// onMessage(m), onStatus({server, display})
export async function openPhoneLink({ room, onMessage, onStatus }) {
  if (!room) {
    let ws, open = false;
    const connect = () => {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      ws.onopen = () => { open = true; ws.send(JSON.stringify({ type: 'hello', role: 'phone' })); onStatus({ server: true, display: false }); };
      ws.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        if (m.type === 'status') onStatus({ server: true, display: !!m.display });
        else onMessage(m);
      };
      ws.onclose = () => { open = false; onStatus({ server: false, display: false }); setTimeout(connect, 1000); };
      ws.onerror = () => ws.close();
    };
    connect();
    return { mode: 'local', send: (obj) => { if (open && ws.readyState === 1) ws.send(JSON.stringify(obj)); } };
  }

  await loadScript(PEERJS_URL);
  let conn = null, connOpen = false, retry = null;
  const peer = new window.Peer({ debug: 0 });
  const target = PEER_PREFIX + normalizeRoom(room);
  const again = (ms) => { clearTimeout(retry); retry = setTimeout(connect, ms); };
  function connect() {
    if (!peer.open) return;
    conn = peer.connect(target, { serialization: 'json', reliable: true });
    conn.on('open', () => {
      connOpen = true;
      conn.send({ type: 'hello', role: 'phone' });
      onStatus({ server: true, display: true });
    });
    conn.on('data', (m) => {
      if (!m || typeof m !== 'object') return;
      if (m.type === 'status') onStatus({ server: true, display: !!m.display });
      else onMessage(m);
    });
    const lost = () => { if (!connOpen && conn && conn.open) return; connOpen = false; onStatus({ server: !!peer.open, display: false }); again(2000); };
    conn.on('close', lost);
    conn.on('error', lost);
  }
  peer.on('open', () => { onStatus({ server: true, display: false }); connect(); });
  peer.on('disconnected', () => { onStatus({ server: false, display: connOpen }); try { peer.reconnect(); } catch { /* 무시 */ } });
  peer.on('error', (err) => {
    if (err.type === 'peer-unavailable') { onStatus({ server: true, display: false }); again(2500); }   // PC 화면이 아직 안 열렸거나 새로고침 중
    else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) { onStatus({ server: false, display: false }); }
  });
  return { mode: 'web', send: (obj) => { if (connOpen && conn && conn.open) conn.send(obj); } };
}
