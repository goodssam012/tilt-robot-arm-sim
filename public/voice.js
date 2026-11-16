// 음성 명령: 내 목소리로 직접 학습시키기
//
// TensorFlow.js 의 음성 명령 기본 모델(speech-commands)에 '전이 학습'으로
// 내가 녹음한 단어를 새로 가르칩니다. 녹음·학습·인식은 모두 폰 안에서 처리하고,
// 처음에 라이브러리와 기본 모델(약 5MB)만 인터넷에서 받습니다.

const TF_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@3.21.0/dist/tf.min.js';
const SC_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow-models/speech-commands@0.5.4/dist/speech-commands.min.js';
const NAME_KEY = 'tiltarm-voice-model';      // 저장된 학습 결과 이름
const COUNT_KEY = 'tiltarm-voice-counts';    // 학습에 쓴 녹음 수
const THR_KEY = 'tiltarm-voice-threshold';
export const NOISE = '_background_noise_';

// 학습할 명령 칸 (key 는 학습 라벨, 말은 아무 단어나 가능)
export const SLOTS = [
  { key: 'grab', label: '집기', hint: '예: "집어"', required: true },
  { key: 'release', label: '놓기', hint: '예: "놓아"', required: true },
  { key: 'up', label: '팔꿈치 올리기', hint: '예: "올려" (선택)' },
  { key: 'down', label: '팔꿈치 내리기', hint: '예: "내려" (선택)' },
  { key: NOISE, label: '배경 소음', hint: '아무 말도 하지 말고 녹음', required: true },
];
export const MIN_EXAMPLES = 5;      // 칸마다 최소 녹음 수 (8번 이상 권장)

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('음성 인식 도구를 불러오지 못했어요. 인터넷 연결을 확인해 주세요.'));
    document.head.appendChild(s);
  });
}
// ---- 마이크·오디오 장치를 한 번만 열어 계속 재사용 ----
// 라이브러리는 녹음할 때마다 마이크와 오디오 장치(AudioContext)를 새로 열고 닫는다.
// 그런데 새 오디오 장치를 '버튼을 누른 순간'이 아니라 마이크 준비를 기다린 뒤에 만들기 때문에,
// 폰 브라우저에서는 두 번째부터 오디오 장치가 정지(suspended) 상태로 열려 소리가 들어오지 않고
// 녹음이 끝나지 않는다. 그래서 버튼을 누르는 순간 오디오 장치를 한 번만 만들어 깨워 두고,
// 라이브러리가 새로 만들거나 닫으려 할 때 그 하나를 계속 쓰게 한다. 마이크도 한 번만 열고 복사본을 넘긴다.
const RealAudioContext = window.AudioContext || window.webkitAudioContext;
let sharedCtx = null;
let sharedStream = null;
let realGetUserMedia = null;
let patched = false;

// 버튼을 누른 그 순간(사용자 동작 안)에 불러야 폰에서 오디오 장치가 정상으로 켜짐
function primeAudio() {
  if (!sharedCtx) {
    try { sharedCtx = new RealAudioContext({ sampleRate: 44100 }); } catch { sharedCtx = new RealAudioContext(); }
    sharedCtx.close = () => Promise.resolve();   // 라이브러리가 닫지 못하게 (계속 재사용)
  }
  if (sharedCtx.state !== 'running') sharedCtx.resume().catch(() => {});
  return sharedCtx;
}
function installAudioPatches() {
  if (patched) return;
  patched = true;
  const Shared = function SharedAudioContext() { return primeAudio(); };
  window.AudioContext = Shared;
  if (window.webkitAudioContext) window.webkitAudioContext = Shared;
  const md = navigator.mediaDevices;
  realGetUserMedia = md.getUserMedia.bind(md);
  md.getUserMedia = async (c) => {
    if (!c || !c.audio || c.video) return realGetUserMedia(c);
    const alive = sharedStream && sharedStream.getAudioTracks().some((t) => t.readyState === 'live');
    if (!alive) sharedStream = await realGetUserMedia({ audio: true, video: false });
    return sharedStream.clone();   // 라이브러리는 복사본만 끄므로 원래 마이크는 계속 켜져 있음
  };
}
// 마이크 끄기 (음성 창을 닫고 듣지 않을 때)
function releaseMic() {
  if (sharedStream) { sharedStream.getTracks().forEach((t) => t.stop()); sharedStream = null; }
}

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 무시 */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* 무시 */ } },
};

export function createVoice() {
  let sc = null;          // speechCommands 라이브러리
  let base = null;        // 기본 모델
  let rec = null;         // 녹음을 모으는 전이 학습기
  let model = null;       // 학습이 끝난(또는 불러온) 전이 학습기
  let listening = false;
  let busy = false;
  const v = {
    ready: false,
    trained: false,
    savedCounts: null,     // 저장된 학습 결과의 녹음 수
    threshold: Number(store.get(THR_KEY)) || 0.75,   // 이 확신도 이상일 때만 명령 실행 (화면에서 조절)

    // 라이브러리·기본 모델 준비, 저장된 학습 결과 불러오기
    async init(onStep = () => {}) {
      if (v.ready) return;
      onStep('음성 인식 도구를 불러오는 중… (처음 한 번, 약 5MB)');
      await loadScript(TF_URL);
      await loadScript(SC_URL);
      sc = window.speechCommands;
      installAudioPatches();
      base = sc.create('BROWSER_FFT');
      onStep('기본 음성 모델을 준비하는 중…');
      await base.ensureModelLoaded();
      rec = base.createTransfer('collect-' + Date.now());
      const saved = store.get(NAME_KEY);
      if (saved) {
        try {
          const names = await sc.listSavedTransferModels();
          if (names.includes(saved)) {
            model = base.createTransfer(saved);
            await model.load();
            v.trained = true;
            try { v.savedCounts = JSON.parse(store.get(COUNT_KEY)); } catch { v.savedCounts = null; }
          }
        } catch { model = null; v.trained = false; }
      }
      v.ready = true;
    },

    counts() { return rec ? rec.countExamples ? safeCount(rec) : {} : {}; },

    // 1초 동안 녹음해서 한 칸에 추가 (녹음 버튼을 누른 동작 안에서 호출)
    async record(key) {
      if (!v.ready || busy) return;
      primeAudio();                       // 첫 await 전에: 버튼을 누른 순간 오디오 장치를 깨움
      busy = true;
      const wasListening = listening;
      try {
        if (wasListening) await v.stop();
        if (sharedCtx.state !== 'running') { try { await sharedCtx.resume(); } catch { /* 아래 시간 초과로 안내 */ } }
        let timer;
        await Promise.race([
          rec.collectExample(key),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('TIMEOUT')), 5000); }),
        ]).finally(() => clearTimeout(timer));
      } catch (e) {
        // 멈춘 녹음 정리 → 다음 녹음을 바로 할 수 있게
        try { const ex = rec.audioDataExtractor; if (ex && ex.frameIntervalTask != null) await ex.stop(); } catch { /* 무시 */ }
        rec.streaming = false;            // 라이브러리의 '녹음 중' 표시도 풀어 줌 (안 풀면 다음 녹음이 거부됨)
        if (e && e.message === 'TIMEOUT') {
          throw new Error(`마이크 소리가 들어오지 않았어요 (오디오 상태: ${sharedCtx ? sharedCtx.state : '없음'}). 한 번 더 눌러 보세요.`);
        }
        throw e;
      } finally {
        busy = false;
        if (wasListening) { try { await v.start(v._onResult); } catch { /* 무시 */ } }
      }
    },

    // 녹음한 것으로 학습 → 폰에 저장
    async train(onEpoch = () => {}) {
      const c = v.counts();
      const missing = SLOTS.filter((s) => s.required && (c[s.key] || 0) < MIN_EXAMPLES);
      if (missing.length) throw new Error(`${missing.map((s) => s.label).join(', ')} 을(를) ${MIN_EXAMPLES}번 이상 녹음해 주세요.`);
      if (listening) await v.stop();
      busy = true;
      try {
        // 매번 새 학습기에 녹음을 옮겨 학습 (명령 칸을 추가·삭제해도 안전)
        const name = 'tiltarm-voice-' + Date.now();
        const fresh = base.createTransfer(name);
        fresh.loadExamples(rec.serializeExamples(), false);   // 새 학습기는 비어 있으므로 '기존 것 지우기' 없이 복사
        const epochs = 30;
        let acc = 0;
        await fresh.train({
          epochs,
          callback: { onEpochEnd: async (ep, logs) => { acc = logs.acc; onEpoch(ep + 1, epochs, logs.acc); } },
        });
        const old = store.get(NAME_KEY);
        await fresh.save();
        store.set(NAME_KEY, name);
        store.set(COUNT_KEY, JSON.stringify(c));
        if (old && old !== name) { try { await sc.deleteSavedTransferModel(old); } catch { /* 무시 */ } }
        model = fresh;
        v.trained = true;
        v.savedCounts = c;
        return acc;
      } finally { busy = false; }
    },

    // 실시간 인식 시작: onResult({ labels, scores, best, score })
    async start(onResult) {
      if (!v.trained || listening) return;
      primeAudio();                       // 버튼을 누른 순간 오디오 장치를 깨움
      v._onResult = onResult;
      await model.listen((r) => {
        const labels = model.wordLabels();
        const scores = Array.from(r.scores);
        let bi = 0;
        scores.forEach((s, i) => { if (s > scores[bi]) bi = i; });
        onResult({ labels, scores, best: labels[bi], score: scores[bi] });
      }, { probabilityThreshold: 0, invokeCallbackOnNoiseAndUnknown: true, overlapFactor: 0.6, includeSpectrogram: false });
      listening = true;
    },
    async stop() {
      if (!listening) return;
      listening = false;
      try { await model.stopListening(); } catch { /* 무시 */ }
    },
    isListening: () => listening,
    primeAudio,
    releaseMic: () => { if (!listening && !busy) releaseMic(); },
    audioState: () => (sharedCtx ? sharedCtx.state : 'none'),
    isBusy: () => busy,

    setThreshold(t) { v.threshold = t; store.set(THR_KEY, String(t)); },

    // 녹음과 저장된 학습 결과 모두 지우기
    async clear() {
      await v.stop();
      if (rec) { try { rec.clearExamples(); } catch { /* 녹음이 없으면 오류를 내므로 무시 */ } }
      const old = store.get(NAME_KEY);
      if (old && sc) { try { await sc.deleteSavedTransferModel(old); } catch { /* 무시 */ } }
      store.del(NAME_KEY);
      store.del(COUNT_KEY);
      model = null;
      v.trained = false;
      v.savedCounts = null;
    },
  };
  return v;
}

function safeCount(r) {
  try { return r.countExamples(); } catch { return {}; }   // 녹음이 하나도 없으면 오류를 내므로
}
