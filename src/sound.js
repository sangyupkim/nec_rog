/**
 * 소리 — Web Audio로 그때그때 합성한다. 음원 파일이 없으므로
 * 용량도, 로딩도, CSP 문제도 없다.
 *
 * 규칙 두 가지:
 *  1. 브라우저는 사용자가 한 번 건드리기 전에는 소리를 내주지 않는다.
 *     그래서 AudioContext를 첫 입력 때 만든다.
 *  2. 기본은 꺼짐. 소리는 켠 사람만 듣는다.
 */
const KEY = 'patchwork.sound';

let ctx = null;
let on = false;
try { on = localStorage.getItem(KEY) === '1'; } catch { /* 접근 불가 환경 */ }

export const isOn = () => on;

export function toggle() {
  on = !on;
  try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* 무시 */ }
  if (on) { ensure(); blip({ f: 660, to: 880, dur: 0.1, gain: 0.05 }); }
  return on;
}

function ensure() {
  if (ctx) return ctx;
  const AC = window.AudioContext ?? window.webkitAudioContext;
  if (!AC) return null;
  try { ctx = new AC(); } catch { ctx = null; }
  return ctx;
}
/** 첫 입력에서 오디오를 깨운다 — 그 전에는 어떤 소리도 나지 않는다 */
export function unlock() {
  const c = ensure();
  if (c?.state === 'suspended') c.resume().catch(() => {});
}

function blip({ f = 440, to = null, dur = 0.08, type = 'triangle', gain = 0.06, delay = 0 }) {
  if (!on) return;
  const c = ensure();
  if (!c) return;
  const t0 = c.currentTime + delay;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(f, t0);
  if (to) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

/** 짧은 잡음 — 타격의 '퍽' 소리 */
function noise({ dur = 0.09, gain = 0.05, hp = 900, delay = 0 }) {
  if (!on) return;
  const c = ensure();
  if (!c) return;
  const n = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, n, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n) ** 2;
  const src = c.createBufferSource();
  src.buffer = buf;
  const f = c.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = hp;
  const g = c.createGain();
  g.gain.value = gain;
  src.connect(f).connect(g).connect(c.destination);
  src.start(c.currentTime + delay);
}

export const SFX = {
  /** 내가 적을 때렸다 — 가볍고 높다 */
  hitMon: () => { noise({ dur: 0.07, gain: 0.05, hp: 2200 }); blip({ f: 520, to: 300, dur: 0.06, gain: 0.04 }); },
  /** 내 골렘이 맞았다 — 낮고 둔하다 */
  hitGolem: () => { noise({ dur: 0.14, gain: 0.08, hp: 500 }); blip({ f: 150, to: 70, dur: 0.14, type: 'sawtooth', gain: 0.05 }); },
  /** 급소·핵 피해 */
  big: () => { noise({ dur: 0.18, gain: 0.09, hp: 700 }); blip({ f: 220, to: 60, dur: 0.22, type: 'square', gain: 0.05 }); },
  /** 부위 방어가 무너졌다 */
  broke: () => { blip({ f: 300, to: 120, dur: 0.18, type: 'square', gain: 0.05 }); noise({ dur: 0.12, gain: 0.06, hp: 1400, delay: 0.04 }); },
  /** 승리 */
  win: () => { [523, 659, 784].forEach((f, i) => blip({ f, dur: 0.16, gain: 0.05, delay: i * 0.09 })); },
  /** 패배 */
  lose: () => { [392, 311, 233].forEach((f, i) => blip({ f, dur: 0.3, type: 'sawtooth', gain: 0.05, delay: i * 0.16 })); },
  /** 버튼 */
  tap: () => blip({ f: 880, dur: 0.035, gain: 0.025 }),
};
