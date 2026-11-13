// 로봇팔 시뮬레이터 서버
// - PC 화면(시뮬레이터): http://localhost:3000
// - 스마트폰 조종기: https://<PC의 IP>:3443/phone.html
//   (스마트폰 기울기 센서는 HTTPS에서만 동작하므로 자체 서명 인증서를 씁니다)
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const selfsigned = require('selfsigned');

const HTTP_PORT = Number(process.env.PORT) || 3000;
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 3443;
const PUBLIC_DIR = path.join(__dirname, 'public');
const CERT_DIR = path.join(__dirname, 'cert');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};

function lanAddresses() {
  const list = [];
  for (const ifs of Object.values(os.networkInterfaces())) {
    for (const i of ifs || []) {
      if (i.family === 'IPv4' && !i.internal) list.push(i.address);
    }
  }
  // 사설망 주소(192.168.x, 10.x, 172.16~31.x)를 앞쪽으로
  const score = (a) => (a.startsWith('192.168.') ? 0 : a.startsWith('10.') ? 1 : a.startsWith('172.') ? 2 : 3);
  return list.sort((a, b) => score(a) - score(b));
}

async function loadCert(ips) {
  const keyFile = path.join(CERT_DIR, 'key.pem');
  const certFile = path.join(CERT_DIR, 'cert.pem');
  const ipFile = path.join(CERT_DIR, 'ips.txt');
  const ipKey = ips.join(',');
  if (fs.existsSync(keyFile) && fs.existsSync(certFile) && fs.existsSync(ipFile) &&
      fs.readFileSync(ipFile, 'utf8') === ipKey) {
    return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
  }
  const altNames = [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }, ...ips.map((ip) => ({ type: 7, ip }))];
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'robot-arm-sim.local' }], {
    days: 825,
    keySize: 2048,
    extensions: [{ name: 'subjectAltName', altNames }],
  });
  fs.mkdirSync(CERT_DIR, { recursive: true });
  fs.writeFileSync(keyFile, pems.private);
  fs.writeFileSync(certFile, pems.cert);
  fs.writeFileSync(ipFile, ipKey);
  return { key: pems.private, cert: pems.cert };
}

function makeHandler(ips) {
  return async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let p = decodeURIComponent(url.pathname);

    // 접속 정보: 시뮬레이터 화면에 QR 코드를 띄우는 데 사용
    if (p === '/api/info') {
      const ip = ips[0] || 'localhost';
      const base = `https://${ip}:${HTTPS_PORT}`;
      const info = {
        ips,
        phone: `${base}/phone.html`,
        phoneQR: await QRCode.toString(`${base}/phone.html`, { type: 'svg', margin: 1 }),
      };
      res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(info));
    }

    // three.js 라이브러리는 node_modules에서 제공 (인터넷 없이도 동작)
    let file;
    if (p.startsWith('/vendor/three/')) {
      file = path.join(__dirname, 'node_modules', 'three', p.slice('/vendor/three/'.length));
      if (!file.startsWith(path.join(__dirname, 'node_modules', 'three'))) file = null;
    } else {
      if (p === '/') p = '/index.html';
      file = path.join(PUBLIC_DIR, p);
      if (!file.startsWith(PUBLIC_DIR)) file = null;
    }
    if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('찾을 수 없습니다');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  };
}

// ---- WebSocket 중계 ----
// 접속자는 첫 메시지로 {type:'hello', role:'display'|'phone'} 를 보냅니다.
// 폰이 보낸 메시지는 모든 display 로 전달하고,
// 폰 연결 상태가 바뀌면 display 에 알려줍니다.
const clients = new Set();

function broadcastToDisplays(obj) {
  const msg = JSON.stringify(obj);
  for (const c of clients) if (c.role === 'display' && c.readyState === 1) c.send(msg);
}

function sendStatus() {
  const status = { type: 'status', phone: false };
  for (const c of clients) if (c.role === 'phone') status.phone = true;
  broadcastToDisplays(status);
  // 폰에게도 시뮬레이터 연결 여부를 알려 줌
  const hasDisplay = [...clients].some((c) => c.role === 'display');
  const msg = JSON.stringify({ type: 'status', display: hasDisplay });
  for (const c of clients) if (c.role !== 'display' && c.readyState === 1) c.send(msg);
}

function attachWS(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('error', () => { /* 포트 오류는 http 서버 쪽에서 처리 */ });
  wss.on('connection', (ws) => {
    ws.role = null;
    clients.add(ws);
    ws.on('message', (data) => {
      let m;
      try { m = JSON.parse(data); } catch { return; }
      if (m.type === 'hello') {
        ws.role = ['display', 'phone'].includes(m.role) ? m.role : null;
        console.log(`[연결] ${ws.role}`);
        sendStatus();
        return;
      }
      if (ws.role === 'phone') {
        m.from = ws.role;
        broadcastToDisplays(m);
      } else if (ws.role === 'display' && m.type === 'feedback') {
        // 시뮬레이터 → 폰 (진동 등 피드백)
        const msg = JSON.stringify(m);
        for (const c of clients) if (c.role === 'phone' && c.readyState === 1) c.send(msg);
      }
    });
    ws.on('close', () => {
      clients.delete(ws);
      if (ws.role) console.log(`[해제] ${ws.role}`);
      sendStatus();
    });
  });
}

(async () => {
  const ips = lanAddresses();
  const handler = makeHandler(ips);
  const tls = await loadCert(ips);

  const httpServer = http.createServer(handler);
  const httpsServer = https.createServer(tls, handler);
  attachWS(httpServer);
  attachWS(httpsServer);

  // --open: 서버가 켜지면 PC 화면을 브라우저로 자동으로 엶 (시작.bat 에서 사용)
  const wantOpen = process.argv.includes('--open') && !process.env.NO_OPEN;
  const openBrowser = () => {
    if (!wantOpen) return;
    const url = `http://localhost:${HTTP_PORT}`;
    const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    require('child_process').exec(cmd, () => {});
  };
  // 이미 실행 중이면(시작.bat 을 두 번 누른 경우 등) 화면만 열고 끝냄
  httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`
시뮬레이터가 이미 실행 중이에요 → http://localhost:${HTTP_PORT}`);
      openBrowser();
      setTimeout(() => process.exit(0), 500);
    } else {
      console.error('서버를 시작하지 못했어요:', err.message);
      process.exit(1);
    }
  });

  httpServer.listen(HTTP_PORT, () => {
    httpsServer.listen(HTTPS_PORT, () => {
      const ip = ips[0] || '<PC의 IP>';
      console.log('');
      console.log('=== 기울기 로봇팔 시뮬레이터 ===');
      console.log(`PC 시뮬레이터 화면 : http://localhost:${HTTP_PORT}`);
      console.log(`스마트폰 조종기     : https://${ip}:${HTTPS_PORT}/phone.html`);
      if (ips.length > 1) console.log(`(다른 IP 후보: ${ips.slice(1).join(', ')})`);
      console.log('폰과 PC는 같은 Wi-Fi 에 연결되어 있어야 합니다.');
      console.log('폰에서 "안전하지 않음" 경고가 뜨면 [고급] → [계속/방문] 을 누르세요.');
      console.log('끝낼 때는 이 창을 닫거나 Ctrl + C 를 누르세요.');
      console.log('');
      openBrowser();
    });
  });
})();
