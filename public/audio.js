// 마이크·오디오 장치를 한 번만 열어 계속 재사용
//
// 음성 인식 라이브러리는 녹음할 때마다 마이크와 오디오 장치(AudioContext)를 새로 열고 닫는다.
// 그런데 새 오디오 장치를 '버튼을 누른 순간'이 아니라 마이크 준비를 기다린 뒤에 만들기 때문에,
// 폰 브라우저에서는 두 번째부터 오디오 장치가 정지(suspended) 상태로 열려 소리가 들어오지 않는다.
// 그래서 버튼을 누르는 순간 오디오 장치를 하나 만들어 깨워 두고, 라이브러리가 새로 만들거나
// 닫으려 할 때 그 하나를 계속 쓰게 한다. 마이크도 한 번만 열고 복사본을 넘긴다.
// (이 파일은 가벼워서 조종기 페이지가 처음부터 불러 둔다 → '시작하기' 버튼에서도 깨울 수 있음)

const RealAudioContext = window.AudioContext || window.webkitAudioContext;
let sharedCtx = null;
let sharedStream = null;
let realGetUserMedia = null;
let patched = false;

// 버튼을 누른 그 순간(사용자 동작 안)에 불러야 폰에서 오디오 장치가 정상으로 켜짐
export function primeAudio() {
  if (!RealAudioContext) return null;
  if (!sharedCtx) {
    try { sharedCtx = new RealAudioContext({ sampleRate: 44100 }); } catch { sharedCtx = new RealAudioContext(); }
    sharedCtx.close = () => Promise.resolve();   // 라이브러리가 닫지 못하게 (계속 재사용)
  }
  if (sharedCtx.state !== 'running') sharedCtx.resume().catch(() => {});
  return sharedCtx;
}

export function installAudioPatches() {
  if (patched) return;
  patched = true;
  const Shared = function SharedAudioContext() { return primeAudio(); };
  window.AudioContext = Shared;
  if (window.webkitAudioContext) window.webkitAudioContext = Shared;
  const md = navigator.mediaDevices;
  // 브라우저 원래 기능을 쓸 때마다 찾아 씀
  realGetUserMedia = (c) => (window.MediaDevices ? MediaDevices.prototype.getUserMedia.call(md, c) : Promise.reject(new Error('마이크를 쓸 수 없는 브라우저예요')));
  md.getUserMedia = async (c) => {
    if (!c || !c.audio || c.video) return realGetUserMedia(c);
    const alive = sharedStream && sharedStream.getAudioTracks().some((t) => t.readyState === 'live');
    if (!alive) sharedStream = await realGetUserMedia({ audio: true, video: false });
    return sharedStream.clone();   // 라이브러리는 복사본만 끄므로 원래 마이크는 계속 켜져 있음
  };
}

// 마이크 끄기 (듣지도 녹음하지도 않을 때)
export function releaseMic() {
  if (sharedStream) { sharedStream.getTracks().forEach((t) => t.stop()); sharedStream = null; }
}

export const audioState = () => (sharedCtx ? sharedCtx.state : 'none');
export const sharedAudio = () => sharedCtx;
