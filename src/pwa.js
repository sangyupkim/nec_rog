/**
 * 설치형 앱으로 쓰기 (§12.7)
 *
 * 크롬은 조건이 맞으면 스스로 설치 배너를 띄우지만, 모바일에서는 그 배너를
 * 놓치기 쉽다. `beforeinstallprompt`를 붙잡아 두고 **게임 안에 설치 버튼**을 띄운다.
 */
let deferred = null;

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
        .catch(() => { /* file:// 이나 지원 안 하는 환경 — 게임은 그대로 돈다 */ });
    });
  }
}

/** 이미 설치해서 앱으로 열었는가 */
export const isInstalled = () =>
  window.matchMedia?.('(display-mode: standalone)').matches
  || window.navigator.standalone === true;
