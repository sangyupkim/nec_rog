/**
 * 설치형 앱으로 쓰기 (§12.7)
 *
 * 크롬은 조건이 맞으면 스스로 설치 배너를 띄우지만, 모바일에서는 그 배너를
 * 놓치기 쉽다. `beforeinstallprompt`를 붙잡아 두고 **게임 안에 설치 버튼**을 띄운다.
 */
import { BUILD } from './version.js';

let deferred = null;
let reg = null;
let updateReady = false;

export const canInstall = () => Boolean(deferred);

/** 설치 창을 띄운다. 사용자가 받아들였으면 true */
export async function install() {
  if (!deferred) return false;
  const p = deferred;
  deferred = null;
  p.prompt();
  const { outcome } = await p.userChoice.catch(() => ({ outcome: 'dismissed' }));
  return outcome === 'accepted';
}

/** 설치 가능 여부가 바뀌면 부른다 */
export const onChange = [];
const fire = () => { for (const fn of onChange) fn(); };

/* ── 새 판 받기 (§12.7-A) ───────────────────────────────
   설치형으로 켜 두면 페이지가 다시 뜨지 않는다. 서비스 워커는 새것을 받아 두지만
   화면에 도는 코드는 옛것 그대로다 — 껐다 켜도 안 바뀌는 것처럼 보이는 이유다.
   그래서 **켜 둔 채로도 확인하고**, 새 판이 준비되면 화면에 알린다. */
const CHECK_MS = 15 * 60_000;
export const onUpdate = [];
export const hasUpdate = () => updateReady;
export const version = () => BUILD;

const markReady = () => {
  if (updateReady) return;
  updateReady = true;
  for (const fn of onUpdate) fn();
};

/** 지금 새로 고친다 — 기다리던 워커에게 넘겨받으라 이르고 다시 연다 */
export function applyUpdate() {
  const w = reg?.waiting;
  if (w) w.postMessage('skip-waiting');
  // controllerchange를 못 받는 환경도 있으므로 잠깐 뒤 그냥 다시 연다
  setTimeout(() => location.reload(), w ? 400 : 0);
}

/** 새것이 올라왔는지 물어본다. 돌아오는 값은 없다 — 준비되면 onUpdate가 울린다 */
export function checkForUpdate() {
  reg?.update?.().catch(() => { /* 끊겨 있으면 다음 기회에 */ });
}

function watch(r) {
  reg = r;
  if (r.waiting && navigator.serviceWorker.controller) markReady();
  r.addEventListener('updatefound', () => {
    const sw = r.installing;
    if (!sw) return;
    sw.addEventListener('statechange', () => {
      // 처음 설치에는 controller가 없다 — 그건 새 판이 아니라 첫 설치다
      if (sw.state === 'installed' && navigator.serviceWorker.controller) markReady();
    });
  });
  checkForUpdate();
  setInterval(checkForUpdate, CHECK_MS);
  // 앱으로 돌아올 때마다 한 번 더 — 켜 둔 채 며칠 지나는 경우가 이 게임의 보통이다
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkForUpdate();
  });
  window.addEventListener('online', checkForUpdate);
}

export function boot() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();          // 크롬의 기본 배너를 미루고 우리가 띄운다
    deferred = e;
    fire();
  });
  window.addEventListener('appinstalled', () => { deferred = null; fire(); });

  if ('serviceWorker' in navigator) {
    // 페이지가 다 뜬 뒤에 등록한다 — 첫 화면을 늦추지 않기 위해서다
    window.addEventListener('load', () => {
      navigator.serviceWorker.register(new URL('../sw.js', import.meta.url))
        .then(watch)
        .catch(() => { /* file:// 이나 지원 안 하는 환경 — 게임은 그대로 돈다 */ });
    });
  }
}

/** 이미 설치해서 앱으로 열었는가 */
export const isInstalled = () =>
  window.matchMedia?.('(display-mode: standalone)').matches
  || window.navigator.standalone === true;
