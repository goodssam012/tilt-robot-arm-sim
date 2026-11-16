// 음성 명령: 내 목소리로 직접 학습시키기
//
// TensorFlow.js 의 음성 명령 기본 모델(speech-commands)에 '전이 학습'으로
// 내가 녹음한 단어를 새로 가르칩니다. 녹음·학습·인식은 모두 폰 안에서 처리하고,
// 처음에 라이브러리와 기본 모델(약 5MB)만 인터넷에서 받습니다.
//
// 저장: 녹음(IndexedDB)과 학습 결과(IndexedDB) 둘 다 폰에 저장 → 다시 열어도 그대로.
//       학습 결과가 없어졌으면 저장된 녹음으로 자동으로 다시 학습합니다.

import { primeAudio, installAudioPatches, releaseMic, audioState, sharedAudio } from './audio.js';

const TF_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@3.21.0/dist/tf.min.js';
const SC_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow-models/speech-commands@0.5.4/dist/speech-commands.min.js';
const NAME_KEY = 'tiltarm-voice-model';       // 저장된 학습 결과 이름
const THR_KEY = 'tiltarm-voice-threshold';
export const HAS_DATA_KEY = 'tiltarm-voice-has-data';   // 녹음이나 학습 결과가 있는지 (빠른 확인용)
export const AUTO_KEY = 'tiltarm-voice-auto';           // 지난번에 음성 조종을 켜 두었는지
export const NOISE = '_background_noise_';

// 학습할 명령 칸 (key 는 학습 라벨, 말은 아무 단어나 가능)
export const SLOTS = [
  { key: 'grab', label: '집기', hint: '예: "집어"', required: true },
  { key: 'release', label: '놓기', hint: '예: "놓아"', required: true },
  { key: 'up', label: '팔꿈치 올리기', hint: '예: "올려" (선택)' },
  { key: 'down', label: '팔꿈치 내리기', hint: '예: "내려" (선택)' },
  { key: NOISE, label: '배경 소음', hint: '말하지 말고 3초 녹음', required: true },
];
export const MIN_EXAMPLES = 5;        // 칸마다 최소 녹음 수
export const GOOD_EXAMPLES = 10;      // 권장 녹음 수
// 녹음 길이: 단어는 2초(그 안에 아무 때나 말하면 됨), 배경 소음은 3초
// 학습할 때 가장 큰 소리(말한 부분)를 중심으로 조금씩 밀린 여러 구간을 뽑아 배우므로 타이밍에 덜 민감해짐
export const recordSeconds = (key) => (key === NOISE ? 3 : 2);
const TRAIN = { epochs: 30, fineTuningEpochs: 12, augmentByMixingNoiseRatio: 0.5, validationSplit: 0.2 };

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
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 무시 */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* 무시 */ } },
};

// ---- 녹음 저장용 IndexedDB ----
function openDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('tiltarm-voice', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function dbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const q = db.transaction('kv').objectStore('kv').get(key);
    q.onsuccess = () => resolve(q.result);
    q.onerror = () => reject(q.error);
  });
}
async function dbPut(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction('kv', 'readwrite');
    if (value == null) t.objectStore('kv').delete(key); else t.objectStore('kv').put(value, key);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export const hasSavedVoice = () => store.get(HAS_DATA_KEY) === '1' || !!store.get(NAME_KEY);

export function createVoice() {
  let sc = null;          // speechCommands 라이브러리
  let base = null;        // 기본 모델
  let rec = null;         // 녹음을 모으는 전이 학습기
  let model = null;       // 학습이 끝난(또는 불러온) 전이 학습기
  let listening = false;
  let busy = false;
  let initPromise = null;

  const counts = () => { try { return rec ? rec.countExamples() : {}; } catch { return {}; } };   // 녹음이 없으면 오류를 내므로
  const enoughToTrain = (c = counts()) => SLOTS.every((s) => !s.required || (c[s.key] || 0) >= MIN_EXAMPLES);

  async function saveRecordings() {
    const c = counts();
    const any = Object.values(c).some((n) => n > 0);
    try { await dbPut('examples', any ? rec.serializeExamples() : null); } catch { /* 저장 공간 문제 */ }
    if (any || model) store.set(HAS_DATA_KEY, '1'); else store.del(HAS_DATA_KEY);
  }

  async function trainNow(onEpoch) {
    if (listening) await v.stop();
    busy = true;
    try {
      // 매번 새 학습기에 녹음을 옮겨 학습 (명령 칸을 추가·삭제해도 안전)
      const name = 'tiltarm-voice-' + Date.now();
      const fresh = base.createTransfer(name);
      fresh.loadExamples(rec.serializeExamples(), false);
      const total = TRAIN.epochs + TRAIN.fineTuningEpochs;
      let ep = 0, acc = 0, valAcc = null;
      const callback = {
        onEpochEnd: async (_e, logs) => {
          ep += 1;
          acc = logs.acc;
          if (logs.val_acc != null) valAcc = logs.val_acc;
          onEpoch(ep, total, logs.acc, logs.val_acc);
        },
      };
      try {
        await fresh.train({ ...TRAIN, callback });
      } catch (e) {
        // 녹음이 적어 검증용으로 나눌 수 없으면 검증 없이 다시
        if (!/split|validation/i.test(String(e && e.message))) throw e;
        ep = 0;
        await fresh.train({ ...TRAIN, validationSplit: undefined, callback });
      }
      const old = store.get(NAME_KEY);
      await fresh.save();
      store.set(NAME_KEY, name);
      store.set(HAS_DATA_KEY, '1');
      if (old && old !== name) { try { await sc.deleteSavedTransferModel(old); } catch { /* 무시 */ } }
      model = fresh;
      v.trained = true;
      return { acc, valAcc };
    } finally { busy = false; }
  }

  const v = {
    ready: false,
    trained: false,
    threshold: Number(store.get(THR_KEY)) || 0.7,   // 이 확신도 이상일 때만 명령 실행 (화면에서 조절)
    margin: 0.15,                                   // 1등이 2등보다 이만큼은 앞서야 실행 (헷갈릴 때 무시)

    // 라이브러리·기본 모델 준비 → 저장된 녹음·학습 결과 불러오기 (필요하면 자동으로 다시 학습)
    init(onStep = () => {}) {
      if (!initPromise) initPromise = (async () => {
        onStep('음성 인식 도구를 불러오는 중… (처음 한 번, 약 5MB)');
        await loadScript(TF_URL);
        await loadScript(SC_URL);
        sc = window.speechCommands;
        installAudioPatches();
        try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch { /* 무시 */ }
        base = sc.create('BROWSER_FFT');
        onStep('기본 음성 모델을 준비하는 중…');
        await base.ensureModelLoaded();
        rec = base.createTransfer('collect-' + Date.now());
        // 저장된 녹음
        try {
          const buf = await dbGet('examples');
          if (buf) rec.loadExamples(buf, false);
        } catch { /* 저장된 녹음 없음 */ }
        // 저장된 학습 결과
        const saved = store.get(NAME_KEY);
        if (saved) {
          try {
            const names = await sc.listSavedTransferModels();
            if (names.includes(saved)) {
              model = base.createTransfer(saved);
              await model.load();
              v.trained = true;
            }
          } catch { model = null; v.trained = false; }
        }
        // 학습 결과가 사라졌지만 녹음이 남아 있으면 자동으로 다시 학습
        if (!v.trained && enoughToTrain()) {
          onStep('저장된 녹음으로 다시 학습하는 중…');
          await trainNow((ep, total) => onStep(`저장된 녹음으로 다시 학습하는 중… ${ep}/${total}`));
        }
        v.ready = true;
      })();
      return initPromise;
    },

    counts,
    enoughToTrain,

    // 녹음해서 한 칸에 추가 (녹음 버튼을 누른 동작 안에서 호출)
    async record(key) {
      if (!v.ready || busy) return;
      primeAudio();                       // 첫 await 전에: 버튼을 누른 순간 오디오 장치를 깨움
      busy = true;
      const wasListening = listening;
      const secs = recordSeconds(key);
      try {
        if (wasListening) await v.stop();
        const ctx = sharedAudio();
        if (ctx && ctx.state !== 'running') { try { await ctx.resume(); } catch { /* 아래 시간 초과로 안내 */ } }
        let timer;
        await Promise.race([
          rec.collectExample(key, { durationMultiplier: secs }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('TIMEOUT')), (secs + 4) * 1000); }),
        ]).finally(() => clearTimeout(timer));
        await saveRecordings();
      } catch (e) {
        // 멈춘 녹음 정리 → 다음 녹음을 바로 할 수 있게
        try { const ex = rec.audioDataExtractor; if (ex && ex.frameIntervalTask != null) await ex.stop(); } catch { /* 무시 */ }
        rec.streaming = false;            // 라이브러리의 '녹음 중' 표시도 풀어 줌 (안 풀면 다음 녹음이 거부됨)
        if (e && e.message === 'TIMEOUT') {
          throw new Error(`마이크 소리가 들어오지 않았어요 (오디오 상태: ${audioState()}). 한 번 더 눌러 보세요.`);
        }
        throw e;
      } finally {
        busy = false;
        if (wasListening) { try { await v.start(v._onResult); } catch { /* 무시 */ } }
      }
    },

    // 한 칸의 마지막 녹음 지우기 (잘못 녹음했을 때)
    async undo(key) {
      if (!rec || busy) return false;
      let list = [];
      try { list = rec.getExamples(key); } catch { return false; }
      if (!list.length) return false;
      rec.removeExample(list[list.length - 1].uid);
      await saveRecordings();
      return true;
    },

    // 녹음한 것으로 학습 → 폰에 저장
    async train(onEpoch = () => {}) {
      const c = counts();
      const missing = SLOTS.filter((s) => s.required && (c[s.key] || 0) < MIN_EXAMPLES);
      if (missing.length) throw new Error(`${missing.map((s) => s.label).join(', ')} 을(를) ${MIN_EXAMPLES}번 이상 녹음해 주세요.`);
      return trainNow(onEpoch);
    },

    // 실시간 인식 시작: onResult({ labels, scores, best, score, second })
    async start(onResult) {
      if (!v.trained || listening) return;
      primeAudio();                       // 버튼을 누른 순간 오디오 장치를 깨움
      v._onResult = onResult;
      await model.listen((r) => {
        const labels = model.wordLabels();
        const scores = Array.from(r.scores);
        let bi = 0;
        scores.forEach((s, i) => { if (s > scores[bi]) bi = i; });
        const second = Math.max(0, ...scores.filter((_, i) => i !== bi));
        onResult({ labels, scores, best: labels[bi], score: scores[bi], second });
      }, { probabilityThreshold: 0, invokeCallbackOnNoiseAndUnknown: true, overlapFactor: 0.75, includeSpectrogram: false });
      listening = true;
    },
    async stop() {
      if (!listening) return;
      listening = false;
      try { await model.stopListening(); } catch { /* 무시 */ }
    },
    isListening: () => listening,
    isBusy: () => busy,
    primeAudio,
    releaseMic: () => { if (!listening && !busy) releaseMic(); },
    audioState,

    setThreshold(t) { v.threshold = t; store.set(THR_KEY, String(t)); },

    // 녹음과 저장된 학습 결과 모두 지우기
    async clear() {
      await v.stop();
      if (rec) { try { rec.clearExamples(); } catch { /* 녹음이 없으면 오류를 내므로 무시 */ } }
      const old = store.get(NAME_KEY);
      if (old && sc) { try { await sc.deleteSavedTransferModel(old); } catch { /* 무시 */ } }
      try { await dbPut('examples', null); } catch { /* 무시 */ }
      store.del(NAME_KEY);
      store.del(HAS_DATA_KEY);
      store.del(AUTO_KEY);
      model = null;
      v.trained = false;
    },
  };
  return v;
}
