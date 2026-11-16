// PC 화면 ↔ 스마트폰 연결
//
// 로컬 모드: 이 PC에서 server.js 를 실행해 열었을 때
//   - 같은 Wi‑Fi 안에서 WebSocket 으로 연결 (인터넷 없이도 동작)
// 웹 모드: GitHub Pages 처럼 서버 없이 열었을 때
//   - PeerJS(WebRTC)로 PC와 폰을 인터넷을 통해 직접 연결
//   - 직접 연결이 막힌 네트워크(LTE/5G, 학교·회사 Wi‑Fi 등)에서는 공개 MQTT 중계 서버로 연결
//   - PC 화면이 '방 코드'를 만들고, 폰은 QR(…/phone.html?room=코드)로 그 방에 들어감
//
// 어느 모드인지는 api/info 가 응답하는지로 자동 판단합니다.

const PEER_PREFIX = 'tiltarm-v1-';
const PEERJS_URL = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
const QRCODE_URL = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js';
const MQTT_URL = 'https://unpkg.com/mqtt@5.10.1/dist/mqtt.min.js';
// 중계 서버 (공개 MQTT). PC 화면은 두 곳 모두, 폰은 먼저 닿는 곳 하나를 씀
const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://test.mosquitto.org:8081'];
const topicUp = (code) => `tiltarm/v1/${code}/up`;       // 폰 → PC 화면
const topicDown = (code) => `tiltarm/v1/${code}/down`;   // PC 화면 → 폰
const randomId = () => Math.random().toString(36).slice(2, 10);
// 폰의 직접 연결 이름(tiltarm-v1-p-번호)에서 폰 번호만 꺼냄 → 직접/중계 어느 쪽이든 같은 폰은 같은 번호
const phoneIdFromPeer = (peerId) => String(peerId).replace(/^tiltarm-v1-p-/, '');
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

  // 웹 모드: ① 직접 연결(PeerJS/WebRTC) + ② 중계 서버(MQTT) 를 함께 열어 둠
  //  - 같은 Wi‑Fi 처럼 직접 연결이 되면 ①로 빠르게
  //  - 폰이 LTE/5G 이거나 학교·회사 Wi‑Fi 처럼 기기끼리 직접 통신을 막으면 ②로 (조금 느리지만 어디서나 됨)
  try {
    await loadScript(QRCODE_URL);
  } catch (e) {
    onInfo({ mode: 'web', error: '연결 도구를 불러오지 못했어요. 인터넷 연결을 확인하거나, PC에서 시작.bat 으로 실행해 주세요.' });
    return { mode: 'web', send: () => {} };
  }
  const [peerOk, mqttOk] = (await Promise.allSettled([loadScript(PEERJS_URL), loadScript(MQTT_URL)])).map((r) => r.status === 'fulfilled');

  const conns = new Map();        // 폰 번호 → 직접 연결
  const relayPhones = new Map();  // 폰 번호 → 중계로 마지막에 소식이 온 시각
  const folder = location.href.replace(/[?#].*$/, '').replace(/[^/]*$/, '');
  let code = null;
  try { code = normalizeRoom(localStorage.getItem(ROOM_KEY)); } catch { /* 무시 */ }
  if (!code || code.length < 4) code = newRoomCode();

  let lastList = '';
  const phoneList = () => {
    const now = performance.now();
    for (const [id, t] of relayPhones) if (now - t > 4500) relayPhones.delete(id);
    return [...new Set([...conns.keys(), ...relayPhones.keys()])];
  };
  const pushStatus = (force = false) => {
    const list = phoneList();
    const key = list.join(',');
    if (force || key !== lastList) { lastList = key; onStatus({ phones: list }); }
  };

  const showQR = () => {
    try { localStorage.setItem(ROOM_KEY, code); } catch { /* 무시 */ }
    const url = `${folder}phone.html?room=${code}`;
    const qr = window.qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    onInfo({ mode: 'web', phoneUrl: url, qrSvg: qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }), code });
  };
  showQR();   // 방 코드는 이 PC 화면이 정하므로 바로 보여 줌

  // ② 중계 서버: 두 곳에 모두 접속 (폰은 먼저 닿는 곳 하나를 씀)
  const brokers = [];
  const relayPublish = (to, m) => {
    const payload = JSON.stringify({ to: to ?? null, m });
    for (const c of brokers) if (c.connected) c.publish(topicDown(code), payload);
  };
  if (mqttOk) {
    for (const url of BROKERS) {
      const c = window.mqtt.connect(url, { clientId: 'tiltarm-d-' + randomId(), connectTimeout: 8000, reconnectPeriod: 3000, keepalive: 30, clean: true });
      c.on('connect', () => c.subscribe(topicUp(code)));
      c.on('error', () => { /* 다시 연결은 라이브러리가 함 */ });
      c.on('message', (topic, payload) => {
        if (topic !== topicUp(code)) return;
        let d;
        try { d = JSON.parse(String(payload)); } catch { return; }
        if (!d || d.from == null || !d.m || typeof d.m !== 'object') return;
        const id = String(d.from);
        const isNew = !relayPhones.has(id);
        relayPhones.set(id, performance.now());
        if (conns.has(id)) return;                 // 직접 연결된 폰이면 중계 메시지는 무시
        if (isNew) { pushStatus(); relayPublish(id, { type: 'status', display: true }); }
        if (d.m.type !== 'hello' && d.m.type !== 'ping') onMessage(d.m, id);
      });
      brokers.push(c);
    }
  }
  // 1.5초마다: 폰 목록 정리 + 중계로 '이 PC 화면이 살아 있음' 알림
  setInterval(() => { pushStatus(); relayPublish(null, { type: 'status', display: true }); }, 1500);

  // ① 직접 연결
  let peer = null;
  const resubscribe = (oldCode) => {
    for (const c of brokers) if (c.connected) { c.unsubscribe(topicUp(oldCode)); c.subscribe(topicUp(code)); }
  };
  const start = (attempt = 0) => {
    if (!peerOk) return;
    peer = new window.Peer(PEER_PREFIX + code, { debug: 0 });
    peer.on('connection', (c) => {
      const id = phoneIdFromPeer(c.peer);
      const drop = () => { if (conns.get(id) === c) conns.delete(id); pushStatus(); };
      c.on('open', () => {
        conns.set(id, c);
        pushStatus();
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
        else { const old = code; code = newRoomCode(); resubscribe(old); showQR(); start(0); }
      } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
        peer.destroy();
        setTimeout(() => start(attempt), 4000);   // 직접 연결 서버가 안 돼도 중계로는 계속 연결 가능
      }
    });
  };
  start();
  // 8초가 지나도 아무 연결 서버에도 닿지 않으면 알림
  setTimeout(() => {
    if (!(peer && peer.open) && !brokers.some((c) => c.connected)) {
      onInfo({ mode: 'web', error: '연결 서버에 닿지 않아요. PC의 인터넷 연결을 확인하거나, PC에서 시작.bat 으로 실행해 보세요. 계속 다시 시도합니다…' });
    }
  }, 8000);

  return {
    mode: 'web',
    send: (obj, to) => {
      if (to != null) {
        const c = conns.get(String(to));
        if (c && c.open) c.send(obj); else relayPublish(String(to), obj);
        return;
      }
      conns.forEach((c) => { if (c.open) c.send(obj); });
      if (relayPhones.size) relayPublish(null, obj);
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

  // 웹 모드: 먼저 직접 연결(PeerJS)을 시도하고, 5초 안에 안 되면 중계 서버(MQTT)로 연결
  // onStatus({ server, display, via: 'p2p' | 'relay' | null, stage })
  const target = PEER_PREFIX + normalizeRoom(room);
  const roomCode = normalizeRoom(room);
  // 이 폰의 번호: 새로고침해도 같은 번호 → 1P/2P 자리가 바뀌지 않음
  let uid = null;
  try { uid = sessionStorage.getItem('tiltarm-uid'); } catch { /* 무시 */ }
  if (!uid) { uid = randomId(); try { sessionStorage.setItem('tiltarm-uid', uid); } catch { /* 무시 */ } }

  let conn = null, connOpen = false, retry = null, peer = null;
  let relay = null, relayDisplay = false, lastDisplaySeen = 0, relayStarting = false;
  let lastCtrl = '', lastCtrlAt = 0;
  const report = (stage) => {
    const via = connOpen ? 'p2p' : relayDisplay ? 'relay' : null;
    onStatus({ server: !!(peer && peer.open) || !!(relay && relay.connected), display: !!via, via, stage });
  };

  // ② 중계 서버
  async function startRelay() {
    if (relay || relayStarting) return;
    relayStarting = true;
    report('중계 서버로 연결하는 중…');
    try { await loadScript(MQTT_URL); } catch { relayStarting = false; report('중계 서버 도구를 불러오지 못했어요'); return; }
    // 먼저 닿는 중계 서버 하나를 씀
    for (const url of BROKERS) {
      const c = window.mqtt.connect(url, { clientId: 'tiltarm-p-' + uid + '-' + randomId(), connectTimeout: 6000, reconnectPeriod: 3000, keepalive: 30, clean: true });
      const ok = await new Promise((res) => {
        const t = setTimeout(() => res(false), 7000);
        c.once('connect', () => { clearTimeout(t); res(true); });
      });
      if (!ok) { c.end(true); continue; }
      relay = c;
      break;
    }
    relayStarting = false;
    if (!relay) { report('중계 서버에 닿지 않아요. 인터넷 연결을 확인해 주세요'); setTimeout(startRelay, 5000); return; }
    const up = (m) => relay.connected && relay.publish(topicUp(roomCode), JSON.stringify({ from: uid, m }));
    relay._up = up;
    relay.on('connect', () => { relay.subscribe(topicDown(roomCode)); up({ type: 'hello' }); });
    relay.subscribe(topicDown(roomCode));
    relay.on('message', (topic, payload) => {
      if (topic !== topicDown(roomCode)) return;
      let d;
      try { d = JSON.parse(String(payload)); } catch { return; }
      if (!d || !d.m || (d.to != null && String(d.to) !== uid)) return;
      if (connOpen) return;                          // 직접 연결 중이면 중계 메시지는 무시
      if (d.m.type === 'status') {
        lastDisplaySeen = performance.now();
        if (!relayDisplay) { relayDisplay = true; report('중계로 연결됨'); }
        return;
      }
      onMessage(d.m);
    });
    up({ type: 'hello' });
    // 1.5초마다 '이 폰이 살아 있음' 알림, PC 화면 소식이 4.5초 넘게 없으면 끊긴 것으로 봄
    setInterval(() => {
      if (connOpen) return;
      up({ type: 'ping' });
      if (relayDisplay && performance.now() - lastDisplaySeen > 4500) { relayDisplay = false; report('PC 화면을 찾는 중…'); }
    }, 1500);
    report('PC 화면을 찾는 중… (중계)');
  }
  // 5초 안에 직접 연결이 안 되면 중계로
  setTimeout(() => { if (!connOpen) startRelay(); }, 5000);
  // 주소에 ?via=relay 가 있으면 처음부터 중계만 사용 (직접 연결이 계속 안 되는 곳에서 쓰는 우회로)
  const forceRelay = new URLSearchParams(location.search).get('via') === 'relay';
  if (forceRelay) startRelay();

  // ① 직접 연결
  if (!forceRelay) { try { await loadScript(PEERJS_URL); } catch { startRelay(); } }
  if (window.Peer && !forceRelay) {
    const again = (ms) => { clearTimeout(retry); retry = setTimeout(connect, ms); };
    const makePeer = (id) => {
      peer = new window.Peer(PEER_PREFIX + 'p-' + id, { debug: 0 });
      peer.on('open', () => { report('PC 화면을 찾는 중…'); connect(); });
      peer.on('disconnected', () => { report(); try { peer.reconnect(); } catch { /* 무시 */ } });
      peer.on('error', (err) => {
        if (err.type === 'peer-unavailable') { report('PC 화면을 찾는 중…'); again(2500); }   // PC 화면이 아직 안 열렸거나 새로고침 중
        else if (err.type === 'unavailable-id') { peer.destroy(); uid = randomId(); try { sessionStorage.setItem('tiltarm-uid', uid); } catch { /* 무시 */ } makePeer(uid); }
        else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) { report(); startRelay(); }
      });
    };
    function connect() {
      if (!peer || !peer.open) return;
      conn = peer.connect(target, { serialization: 'json', reliable: true });
      conn.on('open', () => {
        connOpen = true;
        conn.send({ type: 'hello', role: 'phone' });
        report('직접 연결됨');
      });
      conn.on('data', (m) => {
        if (!m || typeof m !== 'object') return;
        if (m.type === 'status') { report('직접 연결됨'); return; }
        onMessage(m);
      });
      const lost = () => { if (!connOpen && conn && conn.open) return; connOpen = false; report('다시 연결하는 중…'); startRelay(); again(2000); };
      conn.on('close', lost);
      conn.on('error', lost);
    }
    makePeer(uid);
  }

  return {
    mode: 'web',
    via: () => (connOpen ? 'p2p' : relayDisplay ? 'relay' : null),
    send: (obj) => {
      if (connOpen && conn && conn.open) { conn.send(obj); return; }
      if (!relay || !relay._up) return;
      // 중계는 조금 느리므로 조종 신호는 1초에 15번까지, 값이 그대로면 0.3초마다만 보냄
      if (obj.type === 'ctrl') {
        const now = performance.now();
        const key = JSON.stringify(obj);
        if (now - lastCtrlAt < 66 || (key === lastCtrl && now - lastCtrlAt < 300)) return;
        lastCtrl = key; lastCtrlAt = now;
      }
      relay._up(obj);
    },
  };
}
