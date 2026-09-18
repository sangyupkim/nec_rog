/**
 * 서비스 워커 — 설치형 앱으로 쓰기 위한 최소한의 것.
 *
 * 켜져 있으면 늘 새것을 받고, 캐시는 **끊겼을 때를 위한 보험**으로 쓴다.
 * 그래야 고쳐서 올린 것이 다음 실행이 아니라 지금 보인다.
 *
 * 이 파일을 고칠 때는 VERSION을 반드시 올린다. 안 올리면 옛 캐시가 남는다.
 */
/* src/version.js의 BUILD와 같은 값이어야 한다 — npm run validate가 어긋나면 잡는다 */
const BUILD = '0.9.43';
const VERSION = `patchwork-${BUILD}`;
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './src/main.js', './src/ui.js', './src/core.js', './src/combat.js',
  './src/dungeon.js', './src/town.js', './src/ossuary.js', './src/campaign.js', './src/sound.js',
  './data/elements.json', './data/skills.json', './data/parts.json', './data/monsters.json',
  './data/modifiers.json', './data/necro_skills.json', './data/summons.json', './data/items.json',
  './data/attachments.json', './data/quests.json', './data/cores.json',
  './data/campaign.json', './data/story.json', './data/naming.json',
  './src/pwa.js', './src/version.js',
];

/* 화면이 「지금 새로 고친다」를 눌렀을 때 — 기다리던 새 워커가 곧장 넘겨받는다 */
self.addEventListener('message', (e) => {
  if (e.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('install', (e) => {
  // 한 파일이라도 실패하면 설치가 통째로 깨지므로 하나씩 담는다
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await Promise.all(SHELL.map((u) => cache.add(u).catch(() => { /* 없으면 넘어간다 */ })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

/**
 * 코드와 데이터는 **새것 먼저**(network-first), 아이콘·매니페스트는 캐시 먼저.
 *
 * 캐시 먼저로 통일하면 고쳐서 올려도 다음 실행에나 반영된다 — 고쳐 가며 폰으로
 * 확인하는 지금 단계에서는 그게 "안 고쳐졌다"로 보인다. 그래서 켜져 있을 때는
 * 늘 새것을 받고, 캐시는 **끊겼을 때를 위한 보험**으로만 쓴다.
 */
const FRESH_FIRST = /\/(src|data)\/|\/index\.html$|\/$/;

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // 글꼴 같은 바깥 것은 브라우저에 맡긴다

  const freshFirst = req.mode === 'navigate' || FRESH_FIRST.test(url.pathname);

  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const fromNet = fetch(req).then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => null);

    if (freshFirst) {
      const res = await fromNet;
      if (res) return res;
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') return (await cache.match('./index.html')) ?? Response.error();
      return Response.error();
    }

    // 아이콘·매니페스트 — 캐시에서 바로 주고 뒤에서 새것을 받아 둔다
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    const res = await fromNet;
    return res ?? Response.error();
  })());
});

/** 새 판이 준비됐는지 페이지가 물어볼 수 있다 */
self.addEventListener('message', (e) => { if (e.data === 'skip-waiting') self.skipWaiting(); });
