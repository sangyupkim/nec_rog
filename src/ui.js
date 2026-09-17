/** 화면 그리기 헬퍼. 왼쪽=상태, 오른쪽=로그+선택지 (§12) */
import { DB, SLOTS, SLOT_LABEL, partName, partSkills, partStats, partFlavor, assembleGolem, SKILL_CAP, josa,
         shieldMax, shieldNow, partOf, wornLow,
         partElement, stackStep, resoStep, STACK_POWER, STACK_ACC, RESO_POWER, RESO_GUARD,
         SLOT_KIND } from './core.js';
import { ROOM_ICON, ROOM_LABEL, minimapCells } from './dungeon.js';
import * as CP from './campaign.js';
import { SFX, unlock as soundUnlock, isOn as soundOn, toggle as soundToggle } from './sound.js';

const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let keyHandlers = [];

/* ── 등급 ───────────────────────────────
   부속 이름에 등급 색을 입힌다. 목록에서 값어치가 한눈에 갈리게 하는 것이 목적이다.
   logLine은 textContent라 색이 먹지 않으므로, **HTML을 쓰는 자리에서만** 쓴다. */
export const RARITY_LABEL = { common: '일반', rare: '희귀', unique: '유니크' };
export const rarityOf = (part) => DB.partsBy[part.defId]?.rarity ?? 'common';
/** 등급 색이 입혀진 부속 이름 (HTML) */
export const partHTML = (part) =>
  `<span class="rar ${rarityOf(part)}">${esc(partName(part))}</span>`;

/* ── 로그 ───────────────────────────────── */
export function logLine(text, cls = '') {
  const el = document.createElement('div');
  el.className = `line ${cls}`;
  el.textContent = josa(text);
  $('log').append(el);
  $('log').scrollTop = $('log').scrollHeight;
}
export function logAll(lines) { for (const l of lines) logLine(l.text, l.cls); }

/* ── 전투 로그 연출 (§5.8) ───────────────────
   한 턴의 로그를 한꺼번에 쏟지 않고 국면(골렘 → 적 → 턴 끝)별로 끊어 보여준다.
   같은 국면 안에서는 촘촘히, 국면이 바뀔 때만 텀을 둔다.
   화면을 두드리거나 아무 키나 누르면 남은 줄이 즉시 다 나온다. */
const BEAT = { line: 110, phase: 420 };
const reducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

function shake(kind) {
  if (reducedMotion()) return;
  const app = $('app');
  const cls = kind === 'golem' ? 'hit-golem' : 'hit-mon';
  app.classList.remove(cls);
  void app.offsetWidth;   // 같은 클래스를 연달아 붙일 때 애니메이션을 다시 태우려면 필요하다
  app.classList.add(cls);
  setTimeout(() => app.classList.remove(cls), 360);
}

/**
 * 화면을 검게 덮었다가 다시 연다 (§5.10).
 * 기절처럼 **시간이 끊기는 장면**에 쓴다 — 로그를 한 줄 더 쓰는 것으로는
 * "정신을 잃었다"가 전달되지 않는다. 눈앞이 실제로 꺼져야 한다.
 * 동작을 줄이는 설정에서는 시간만 짧게 흐르고 깜빡임은 생략한다.
 */
export function blackout(text, hold = 1500) {
  const el = $('blackout');
  if (!el) return Promise.resolve();
  const quick = reducedMotion();
  el.querySelector('.bo').textContent = text ?? '';
  el.classList.add('on');
  return new Promise((done) => {
    setTimeout(() => done(), quick ? 350 : hold);
  });
}

/** 검은 화면을 걷는다. 다음 화면을 먼저 그려 두고 불러야 매끄럽다 */
export function lighten() {
  const el = $('blackout');
  if (!el) return Promise.resolve();
  el.classList.remove('on');
  return new Promise((done) => setTimeout(done, reducedMotion() ? 0 : 900));
}

export function logPlay(lines) {
  return new Promise((done) => {
    const list = lines.slice();
    if (!list.length) { done(); return; }
    let i = 0;
    let timer = null;

    const finish = () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', onSkip, true);
      window.removeEventListener('pointerdown', onSkip, true);
      done();
    };
    const dump = () => {
      for (; i < list.length; i++) emit(list[i], true);
      finish();
    };
    const onSkip = () => dump();

    function emit(l, quiet) {
      logLine(l.text, `${l.cls ?? ''}${l.big ? ' big' : ''}`);
      if (quiet) return;
      if (l.hit) shake(l.hit);
      if (l.big) SFX.big();
      else if (l.hit === 'mon') SFX.hitMon();
      else if (l.hit === 'golem') SFX.hitGolem();
      else if (l.broke) SFX.broke();
      if (l.win) SFX.win();
      if (l.defeat) SFX.lose();
    }

    function step() {
      if (i >= list.length) { finish(); return; }
      const l = list[i];
      emit(l, false);
      i++;
      if (i >= list.length) { finish(); return; }
      // 다음 줄이 다른 국면이면 한 박자 쉰다
      const gap = list[i].phase !== l.phase ? BEAT.phase : BEAT.line;
      timer = setTimeout(step, gap);
    }

    window.addEventListener('keydown', onSkip, true);
    window.addEventListener('pointerdown', onSkip, true);
    step();
  });
}

/** 연출이 도는 동안 선택지 자리에 둘 표시 */
export function logWaiting() {
  const box = $('choices');
  box.replaceChildren();
  keyHandlers = [];
  const b = document.createElement('div');
  b.className = 'waiting';
  b.textContent = '· · ·  아무 곳이나 눌러 건너뛰기';
  box.append(b);
}
export function logHead(text) { logLine(text, 'head'); }
export function clearLog() { $('log').replaceChildren(); }

/* ── 상단바 ─────────────────────────────── */
export function topbar(save, where) {
  // 재화를 한 덩어리로 묶는다 — 좁은 화면에서 통째로 다음 줄로 넘어가야 잘리지 않는다
  $('topbar').innerHTML = `
    <span class="where">${esc(where)}</span>
    <button id="uiscale" type="button" title="글자 크기"></button>
    <button id="uisound" type="button" title="소리">${soundOn() ? '♪' : '♪̸'}</button>
    <span class="res">
      <span><b>은화</b> ${save.silver}</span>
      <span><b>영혼재</b> ${save.soulAsh}</span>
      <span><b>조각</b> ${save.scrap}</span>
      <span><b>진액</b> ${save.ichor}</span>
      <span><b>골분</b> ${save.boneMeal}</span>
    </span>`;
  const btn = $('uiscale');
  btn.addEventListener('click', () => window.toggleUiScale?.());
  const snd = $('uisound');
  snd.addEventListener('click', () => {
    soundUnlock();
    snd.textContent = soundToggle() ? '♪' : '♪̸';
    snd.classList.toggle('off', !soundOn());
  });
  snd.classList.toggle('off', !soundOn());
  window.applyUiScale?.();
  drawQuests(save);       // 의뢰 서랍은 어느 화면에서나 같은 자리에 있다 (§12.15)
}

/* ── 튜토리얼 손가락 (§7-B.2) ────────────────────────
   대본이 가리키는 **진짜 단추**를 밝히고, 나머지는 눌리지 않게 한다.
   설명만 읽고 하단의 「다음」을 누르는 것과, 납골당 타일을 직접 누르는 것은 다른 일이다. */

/** 밝힐 자리를 찾는다 — 왼쪽 타일 / 하단 선택지 / 몸 도식의 칸 */
export function findSpot(spot) {
  if (!spot) return null;
  if (spot.slot) return $('left')?.querySelector(`.bodymap .bcell[data-slot="${spot.slot}"]`) ?? null;
  const pool = spot.area === 'left'
    ? $('left')?.querySelectorAll('.bldg') ?? []
    : $('choices')?.querySelectorAll('.btn') ?? [];
  for (const el of pool) {
    if (spot.match.test(el.textContent.replace(/\s+/g, ' '))) return el;
  }
  return null;
}

/**
 * 한 자리만 살려 둔다. 나머지 단추는 흐려지고 눌리지 않는다.
 * @returns 밝힌 element (없으면 null)
 */
export function spotlight(spot) {
  const target = findSpot(spot);
  const all = [
    ...($('choices')?.querySelectorAll('.btn') ?? []),
    ...($('left')?.querySelectorAll('.bldg, .bodymap .bcell') ?? []),
    ...(document.querySelectorAll('#dpad .dp') ?? []),
  ];
  for (const el of all) {
    el.classList.remove('spot', 'tut-dim');
    if (!target) continue;
    if (el === target) el.classList.add('spot');
    else el.classList.add('tut-dim');
  }
  if (target) target.scrollIntoView?.({ block: 'nearest' });
  return target;
}

export function clearSpotlight() {
  for (const el of document.querySelectorAll('.spot, .tut-dim')) {
    el.classList.remove('spot', 'tut-dim');
  }
}

/* ── 의뢰 서랍 (§12.15) ─────────────────────────────
   「지금 뭐 하러 가는 중이었지」를 알려면 마을로 올라가 바르그를 눌러야 했다.
   던전 한복판에서는 확인할 길이 아예 없었다. 의뢰는 **늘 손 닿는 곳에** 접혀 있어야 한다.

   접혀 있을 때는 제목 한 줄, 펼치면 목록, 목록의 제목을 누르면 그 의뢰만 펼쳐진다.
   메인(바르그)과 의뢰소·오늘의 일을 한 서랍에 모은다 — 「의뢰」는 플레이어에게 하나다. */
let questOpen = false;
let questPick = null;
try { questOpen = localStorage.getItem('patchwork.quests.open') === '1'; } catch { /* 사생활 창 */ }

const remember = () => {
  try { localStorage.setItem('patchwork.quests.open', questOpen ? '1' : '0'); } catch { /* 무시 */ }
};

/** 서랍에 들어갈 의뢰 전부 — 메인 하나와 의뢰소·오늘의 일 */
function questItems(save) {
  const out = [];
  const bf = CP.brief(save);
  if (bf) {
    out.push({
      key: `main:${bf.id}`, group: '바르그의 부탁', title: bf.title, mark: bf.id, main: true,
      rows: [
        ['주문', `"${bf.order}"`], ['어디로', `${bf.where} (${bf.floors}층)`],
        ['잡을 것', bf.hunt], ['가져올 것', bf.bring],
        ...(bf.hazard ? [['조심', `【${bf.hazard.name}】 ${bf.hazard.text}`]] : []),
      ],
      quote: bf.why,
    });
  }
  for (const q of save.quests?.active ?? []) {
    out.push({
      key: `board:${q.uid}`, group: '의뢰소', title: q.title,
      mark: q.done ? '완료' : `${Math.min(q.progress, q.goal)}/${q.goal}`, done: q.done,
      rows: [['내용', q.desc], ['보상', `은화 ${q.reward.silver} · 영혼재 ${q.reward.soulAsh}`]],
    });
  }
  for (const q of save.daily?.list ?? []) {
    out.push({
      key: `daily:${q.id}`, group: '오늘의 일', title: q.title,
      mark: q.done ? '완료' : `${Math.min(q.progress, q.goal)}/${q.goal}`, done: q.done,
      rows: [['내용', q.desc]],
    });
  }
  return out;
}

export function drawQuests(save) {
  const box = $('quests');
  if (!box) return;
  const items = questItems(save);
  if (!items.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  const undone = items.filter((q) => !q.done).length;
  const head = `<button type="button" class="qhead ${undone ? 'urge' : ''}">📜 의뢰 ${undone}${undone < items.length ? `/${items.length}` : ''} ${questOpen ? '▴' : '▾'}</button>`;
  let body = '';
  if (questOpen) {
    let group = null;
    const parts = [];
    for (const q of items) {
      if (q.group !== group) { group = q.group; parts.push(`<p class="qgrp">${esc(group)}</p>`); }
      const on = questPick === q.key;
      parts.push(`<button type="button" class="qt ${on ? 'on' : ''}" data-q="${esc(q.key)}">`
        + `<span class="qm">${esc(q.mark ?? '')}</span>${on ? '▾ ' : '▸ '}${esc(q.title)}</button>`);
      if (on) {
        parts.push(`<div class="qd">`
          + q.rows.map(([k, v]) => `<div class="qr"><span class="qk">${esc(k)}</span><b>${esc(v)}</b></div>`).join('')
          + (q.quote ? `<div class="qq">"${esc(q.quote)}"</div>` : '')
          + `</div>`);
      }
    }
    body = `<div class="qbody">${parts.join('')}</div>`;
  }
  box.innerHTML = head + body;
  box.querySelector('.qhead').addEventListener('click', () => {
    questOpen = !questOpen; remember(); drawQuests(save);
  });
  for (const el of box.querySelectorAll('.qt')) {
    el.addEventListener('click', () => {
      questPick = questPick === el.dataset.q ? null : el.dataset.q;   // 다시 누르면 접힌다
      drawQuests(save);
    });
  }
}

/* ── 선택지 ─────────────────────────────── */
export const onChoicesRendered = [];

/* ── 목록 넘기기 ─────────────────────────────
   선택지가 많은 화면(해체대·접합로·상점…)에서 앞의 몇 개만 보이고
   나머지는 볼 방법이 없었다. 정착 대기 9개 중 7개까지만 보이는 식이다.
   이제 긴 목록은 쪽으로 나누고, `pin: true`인 항목(돌아간다 같은 것)은 모든 쪽에 남는다. */
let pageAt = 0;        // 지금 보고 있는 쪽
let pageKey = '';      // 목록이 바뀌면 첫 쪽으로 되돌린다

export function choices(list, opts = {}) {
  const box = $('choices');
  const all = list.filter(Boolean);
  const pinned = all.filter((c) => c.pin);
  const items = all.filter((c) => !c.pin);

  // 목록의 정체가 바뀌면 쪽을 초기화한다
  const key = opts.key ?? items.map((c) => c.label).join('|');
  if (key !== pageKey) { pageKey = key; pageAt = 0; }

  /* 쪽 나누기.
   * 숫자 키는 1~9뿐이다. 항목이 그보다 많으면 **열 번째부터는 키가 없고**,
   * 높이가 고정된 독에서는 넘친 줄이 스크롤 뒤로 숨는다(실측: 상점에서 6개가 키를 못 받고
   * 독이 116px 넘쳤다). 그래서 **아홉을 넘으면 저절로 쪽을 나눈다.**
   * 다 보여야 하는 화면은 `paged: false`로 끈다. */
  const KEY_MAX = 9;
  const { cols, cells } = dockCapacity();
  // 쪽을 나누면 넘김 띠가 **한 줄을 통째로** 쓴다. 칸 하나가 아니다.
  const keyRoom = KEY_MAX - pinned.length;               // 숫자 키가 닿는 만큼
  /* 쪽 넘김은 **칸 하나**를 쓴다. 전에는 한 줄을 통째로 쓰는 띠라,
     칸이 넷인 화면에서 한 줄짜리 띠 하나가 칸 넷을 삼켰다 —
     태블릿에서 여덟 칸 중 셋만 항목에 쓰였다. 고정 독에서 그만한 낭비는 없다. */
  const fitRoom = cells - pinned.length - 1;             // 독에 실제로 들어가는 만큼
  const size = opts.pageSize ?? Math.max(2, Math.min(keyRoom, fitRoom));
  const doPage = opts.paged
    ?? (items.length > Math.max(2, Math.min(keyRoom, cells - pinned.length)));
  const pages = Math.max(1, Math.ceil(items.length / size));
  if (pageAt >= pages) pageAt = pages - 1;

  let shown = items;
  const nav = [];
  if (doPage && items.length > size) {
    shown = items.slice(pageAt * size, (pageAt + 1) * size);
    const go = (d) => { pageAt = (pageAt + d + pages) % pages; choices(list, { ...opts, key }); };
    nav.push({ pager: true, page: pageAt + 1, pages, go });
  }

  render(box, [...shown, ...nav, ...pinned]);
}

/**
 * 부속 하나를 쪽지 한 장에 담는다 — 목록에서 잘려 안 보이는 것을 그대로 펼친다.
 * 버튼의 `info`에 넣어 쓴다.
 */
export function partTip(part, extra = '') {
  const def = DB.partsBy[part.defId] ?? {};
  const st = typeof part.defId === 'string' ? partStats(part) : {};
  const KIND = { head: '머리', body: '몸통', arm: '팔', leg: '다리' };
  const SL = { atk: '공격', def: '방어', eva: '회피', spd: '속도', focus: '집중', hp: '체력' };
  const stats = Object.entries(st).filter(([, v]) => v)
    .map(([k, v]) => `<b>${SL[k] ?? k}</b> ${v > 0 ? '+' : ''}${v}`).join(' · ');
  const sk = partSkills(part).map((id) => DB.skillsBy[id]).filter(Boolean);
  const mod = part.mod ? DB.modifiersBy[part.mod] : null;
  return `
    <span class="tt">${partHTML(part)}</span>
    <span class="tm">${KIND[def.slot] ?? ''} · ${RARITY_LABEL[def.rarity] ?? ''}`
      + `${part.raw ? ' · 날것' : ''}${def.def_element ? ` · 방어 ${def.def_element}` : ''}</span>
    <div class="trow">
      <span>내구도 <b>${part.integrity}/${part.maxIntegrity}</b></span>
      <span>요구 마력 <b>${DB.partsBy[part.defId]?.mana ?? '—'}</b></span>
      ${part.upgrade ? `<span>강화 <b>+${part.upgrade}</b></span>` : ''}
      ${part.refined ? `<span>정제 <b>+${part.refined}</b></span>` : ''}
    </div>
    ${stats ? `<div class="trow">${stats}</div>` : '<div class="trow">능력치 보정 없음</div>'}
    ${sk.length ? `<div class="tsk">기술 — ${sk.map((x) =>
        `${esc(x.name)}(${x.element}${x.power ? ` ${x.power}` : ''})`).join(', ')}</div>` : ''}
    ${mod ? `<div class="tsk">이상 — ${esc(mod.prefix)}</div>` : ''}
    ${(() => {   // 겹쳤는가, 엇갈렸는가 (§3.8)
      const fl = partFlavor(part);
      if (fl.kind === 'merge') return `<div class="tsk" style="color:var(--gold)">겹침 — ${esc(fl.note)} (효과 1.5배)</div>`;
      if (fl.kind === 'clash') return `<div class="tsk" style="color:var(--danger)">엇갈림 — ${esc(fl.note)} (효과 절반)</div>`;
      return '';
    })()}
    ${part.raw ? '<div class="tsk" style="color:var(--danger)">날것 — 성능 60%, 기술 25% 불발, 내구도 2배 소모</div>' : ''}
    ${extra}`;
}

/* ── 쪽지 ─────────────────────────────────────
   버튼 폭이 좁아 이름과 곁말이 잘린다. 잘린 것을 볼 방법이 없으면
   "무엇이 붙어 있는지 모른 채" 고르게 된다.
   · 마우스: 올리면 뜬다 — 누르는 것은 그대로 한 번이다.
   · 손가락: 한 번 누르면 뜨고, **같은 것을 한 번 더 눌러야 실행된다.**
   더 보여 줄 것이 없는 버튼(다 보이고 info도 없는 것)은 예전처럼 한 번에 눌린다. */
let lastTouch = false;
let armedBtn = null;
document.addEventListener('pointerdown', (e) => { lastTouch = e.pointerType === 'touch'; }, true);

const tipEl = () => $('tip');

export function hideTip() {
  const t = tipEl();
  // 내용까지 비운다 — 숨기기만 하면 다음 화면에서 지난 쪽지의 글이 남아 있다
  if (t) { t.hidden = true; t.innerHTML = ''; }
  if (armedBtn) { armedBtn.classList.remove('armed'); armedBtn = null; }
}

function showTip(html, anchor) {
  const t = tipEl();
  if (!t) return;
  t.innerHTML = josa(html);
  t.hidden = false;
  // 버튼 위에 띄우고, 화면 밖으로 나가면 안쪽으로 당긴다
  const r = anchor.getBoundingClientRect();
  const tr = t.getBoundingClientRect();
  const pad = 8;
  let left = r.left + r.width / 2 - tr.width / 2;
  left = Math.max(pad, Math.min(left, window.innerWidth - tr.width - pad));
  let top = r.top - tr.height - 6;
  if (top < pad) top = Math.min(r.bottom + 6, window.innerHeight - tr.height - pad);
  t.style.left = `${Math.round(left)}px`;
  t.style.top = `${Math.round(top)}px`;
}

/**
 * 이 버튼이 더 보여 줄 것이 있는가 — 붙여 둔 상세가 있거나, **눈에 띄게** 잘렸거나.
 *
 * 여유(tolerance)를 넉넉히 두는 이유: 기기마다 글꼴과 화면 배율이 달라
 * 잘리지 않은 한 줄도 `scrollHeight`가 1~3px 더 나오는 일이 흔하다.
 * 그걸 잘린 것으로 치면 「돌아간다」까지 두 번 눌러야 하는 물건이 된다.
 * 진짜 잘림은 말줄임표 하나만 해도 한 글자 폭이므로, 반 글자보다 크게 넘칠 때만 본다.
 */
function hasMore(btn, c) {
  if (c.info) return true;
  for (const el of btn.querySelectorAll('.nm, .meta')) {
    const em = parseFloat(getComputedStyle(el).fontSize) || 14;
    const tol = Math.max(5, em * 0.5);
    if (el.scrollWidth - el.clientWidth > tol || el.scrollHeight - el.clientHeight > tol) return true;
  }
  return false;
}

/** 쪽지에 넣을 기본 내용 — 버튼에 있던 것을 그대로, 잘리지 않게 */
const plainTip = (c) => `<span class="tt">${c.label}</span>`
  + (c.meta ? `<span class="tm">${c.meta}</span>` : '');

/* 바깥을 누르면 쪽지를 접는다 */
document.addEventListener('pointerdown', (e) => {
  if (armedBtn && !armedBtn.contains(e.target)) hideTip();
}, true);
window.addEventListener('resize', hideTip);

/**
 * 독에 버튼이 몇 개나 들어가는가. 그리기 전에 알아야 쪽 크기를 정할 수 있으므로
 * 자식이 아니라 **폭과 높이에서 계산한다.**
 */
function dockCapacity() {
  const box = $('choices');
  if (!box) return { cols: 2, cells: 9 };
  const cs = getComputedStyle(box);
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const gapX = parseFloat(cs.columnGap) || 0;
  const gapY = parseFloat(cs.rowGap) || 0;
  const w = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const h = box.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  // gridAutoRows는 fillDock이 늘려 놓은 값이라 여기서 읽으면 스스로를 먹는다.
  // 기준 높이는 언제나 --btn-h다.
  const btnH = (parseFloat(cs.getPropertyValue('--btn-h')) || 2.85) * rem;
  /* 칸 수는 **브라우저가 이미 잰 것을 읽는다.** 같은 식을 CSS와 여기 두 군데에 적어 두면
     한쪽만 고쳤을 때 조용히 어긋난다 — 실제로 8.5rem로 좁히고 나서 계산은 다섯,
     화면은 넷이 되어 독이 넘칠 뻔했다. 아직 그린 적이 없을 때만 식으로 어림한다. */
  const drawn = cs.gridTemplateColumns.split(' ').filter((x) => x && x !== 'none').length;
  const minCol = (document.getElementById('app')?.classList.contains('combat') ? 7 : 8.5) * rem;
  const cols = Math.max(1, drawn || Math.floor((w + gapX) / (minCol + gapX)));
  const rows = Math.max(1, Math.floor((h + gapY) / (btnH + gapY)));
  return { cols, cells: cols * rows };
}

function render(box, list) {
  box.replaceChildren();
  keyHandlers = [];
  hideTip();
  for (const fn of onChoicesRendered) fn();
  let n = 0;
  for (const c of list) {
    if (!c) continue;
    if (c.pager) {
      const strip = document.createElement('div');
      strip.className = 'pager';
      strip.innerHTML = `<button type="button" class="pg" data-d="-1">◂ 이전</button>`
        + `<span class="pgn">${c.page} / ${c.pages}쪽</span>`
        + `<button type="button" class="pg" data-d="1">다음 ▸</button>`;
      for (const pb of strip.querySelectorAll('.pg')) {
        pb.addEventListener('click', () => { soundUnlock(); SFX.tap(); c.go(Number(pb.dataset.d)); });
      }
      box.append(strip);
      continue;
    }
    const b = document.createElement('button');
    b.className = `btn ${c.cls ?? ''}${c.meta ? '' : ' tall'}`;
    b.disabled = Boolean(c.disabled);
    let k = '';
    if (!c.disabled && !c.nokey && n < 9) { n++; k = String(n); keyHandlers[n] = c.on; }
    b.innerHTML = josa(`${k ? `<span class="k">${k}</span>` : ''}<span class="nm">${c.label}</span>`
      + (c.meta ? `<span class="meta">${c.meta}</span>` : ''));

    const tip = () => (c.info ? c.info : plainTip(c))
      + (lastTouch ? '<span class="thint">한 번 더 누르면 고른다</span>' : '');

    // 못 누르는 버튼도 이유를 끝까지 읽을 수 있어야 한다 — 쪽지는 붙여 준다
    b.addEventListener('pointerenter', (e) => {
      if (e.pointerType === 'touch') return;
      if (hasMore(b, c)) showTip(tip(), b);
    });
    b.addEventListener('pointerleave', () => { if (!armedBtn) hideTip(); });

    // 인자를 넘기지 않는다. 그대로 넘기면 클릭 이벤트가 첫 인자로 들어가
    // golemScreen(back) 같은 기본 인자를 덮어써 버린다.
    if (!c.disabled && c.on) {
      b.addEventListener('click', () => {
        // 손가락으로 처음 누른 것이고 더 보여 줄 게 있으면, 이번 누름은 '보기'다
        if (lastTouch && armedBtn !== b && hasMore(b, c)) {
          hideTip();
          armedBtn = b;
          b.classList.add('armed');
          showTip(tip(), b);
          return;
        }
        hideTip();
        soundUnlock(); SFX.tap(); c.on();
      });
    } else if (c.disabled) {
      b.addEventListener('click', () => { if (hasMore(b, c)) showTip(tip(), b); });
    }

    // 미리보기 — 마우스는 올리면 전후 비교가 왼쪽에 뜬다
    if (!c.disabled && c.hover) {
      b.addEventListener('pointerenter', () => c.hover());
      b.addEventListener('focus', () => c.hover());
      if (c.unhover) {
        b.addEventListener('pointerleave', () => c.unhover());
        b.addEventListener('blur', () => c.unhover());
      }
    }
    box.append(b);
  }
  fillDock(box);
}

/**
 * 버튼이 몇 개뿐이어도 독의 높이는 고정이다. 그대로 두면 아래가 텅 빈다 —
 * 실측으로 164px 중 102px이 비었다. 그 높이를 버튼에 돌려주면
 * 이름이 두 줄까지 펴져 잘리는 일이 줄어든다. 대신 버튼이 우스꽝스럽게
 * 커지지 않도록 기본 높이의 두 배까지만 늘린다.
 */
function fillDock(box) {
  box.style.gridAutoRows = '';
  const btns = box.querySelectorAll('.btn');
  if (!btns.length) return;
  const cs = getComputedStyle(box);
  const cols = cs.gridTemplateColumns.split(' ').filter(Boolean).length || 1;
  // 쪽 넘김 띠·연출 대기 표시는 한 줄을 통째로 쓴다. 버튼 수만 세면 줄 수가 틀린다
  let used = 0, rows = 0;
  for (const el of box.children) {
    if (el.classList.contains('btn')) {
      if (used === 0) rows++;
      if (++used === cols) used = 0;
    } else {
      if (used) { used = 0; }
      rows++;
    }
  }
  rows = Math.max(1, rows);
  const gap = parseFloat(cs.rowGap) || 0;
  const inner = box.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const base = parseFloat(cs.gridAutoRows) || btns[0].getBoundingClientRect().height;
  const fit = (inner - (rows - 1) * gap) / rows;
  // 남는 높이를 나눠 주되 **두 줄이 들어갈 만큼까지만**이다.
  // 두 배까지 늘리면 버튼 넷짜리 화면에서 칸이 우스꽝스럽게 커진다.
  const rowH = fit > base ? Math.floor(Math.min(fit, base * 1.35)) : base;
  if (rowH !== base) box.style.gridAutoRows = `${rowH}px`;

  /* 이름을 몇 줄까지 풀지는 **칸의 높이가 정한다.**
     무조건 두 줄로 두면 칸이 낮을 때 곁말이 잘려 나가 오히려 못 읽게 된다. */
  const b0 = btns[0];
  const bs = getComputedStyle(b0);
  const pad = parseFloat(bs.paddingTop) + parseFloat(bs.paddingBottom) + 2;
  const nm = b0.querySelector('.nm');
  const lineH = nm ? parseFloat(getComputedStyle(nm).lineHeight) : 16;
  const metaEl = [...btns].map((b) => b.querySelector('.meta')).find(Boolean);
  const metaH = metaEl ? parseFloat(getComputedStyle(metaEl).lineHeight) : 0;
  const lines = Math.max(1, Math.min(3, Math.floor((rowH - pad - metaH) / lineH)));
  box.style.setProperty('--nm-lines', String(lines));

  // 독이 넘치면 그 사실이 보여야 한다 — 높이가 고정이라 넘친 줄은 소리 없이 가려진다
  box.classList.toggle('more', box.scrollHeight > box.clientHeight + 1);
}

document.addEventListener('keydown', (e) => {
  if (e.key >= '1' && e.key <= '9') {
    const n = Number(e.key);
    const h = keyHandlers[n] ?? panelKeys[n];
    if (h) { e.preventDefault(); h(); }
  }
});

/* ── 글상자 — 세이브를 주고받는 자리 ──────────────────
   아티팩트 샌드박스에서는 파일 다운로드가 막힌다. 링크로 내려받게 하면
   조용히 아무 일도 일어나지 않으므로, 텍스트를 직접 보여 주고 받는다. */
function textBox(title, value, readOnly, onOk, okLabel = '가져오기') {
  const box = $('choices');
  box.replaceChildren();
  keyHandlers = [];

  const wrap = document.createElement('div');
  wrap.className = 'textbox';
  const lb = document.createElement('p');
  lb.className = 'tb-title';
  lb.textContent = title;
  const ta = document.createElement('textarea');
  ta.value = value ?? '';
  ta.readOnly = readOnly;
  ta.spellcheck = false;
  ta.setAttribute('aria-label', title);
  const row = document.createElement('div');
  row.className = 'tb-row';

  const mk = (text, cls, fn) => {
    const b = document.createElement('button');
    b.className = `btn ${cls}`;
    b.textContent = text;
    b.addEventListener('click', fn);
    return b;
  };
  if (readOnly) {
    row.append(mk('전체 선택', 'primary', () => { ta.focus(); ta.select(); }));
  } else {
    row.append(mk(okLabel, 'primary', () => onOk?.(ta.value)));
  }
  row.append(mk('닫기', 'ghost', () => onOk?.(readOnly ? null : undefined, true)));

  wrap.append(lb, ta, row);
  box.append(wrap);
  if (readOnly) { ta.focus(); ta.select(); }
}

export function showText(title, value) {
  textBox(title, value, true, () => { for (const fn of onTextClosed) fn(); });
}
export function askText(title, onOk, okLabel = '가져오기', value = '') {
  textBox(title, value, false, (v, closed) => {
    for (const fn of onTextClosed) fn();
    if (!closed) onOk(v);
  }, okLabel);
}
/** 글상자를 닫았을 때 원래 화면으로 돌아가기 위한 갈고리 */
export const onTextClosed = [];

/* ── 왼쪽 패널 ──────────────────────────── */
/* ── 접이식 구역 ─────────────────────────────
   왼쪽 패널이 한 번에 쏟아내는 정보가 너무 많았다. 늘 봐야 하는 것(도식·경고)만
   펼쳐 두고, 나머지(능력치표·스킬 목록)는 제목만 남기고 접는다.
   무엇을 펼쳐 뒀는지는 화면을 다시 그려도 기억한다 — 접는 UI의 절반은 이 기억이다. */
const secOpen = new Map();

/** 접이식 구역 한 칸. id는 기억의 열쇠, sub는 접힌 채로도 보이는 요약. */
export const sec = (id, title, sub, html, open = false) => `
  <details class="sec" data-sec="${id}"${open ? ' open' : ''}>
    <summary><span class="st">${esc(title)}</span>${sub ? `<span class="ss">${sub}</span>` : ''}</summary>
    <div class="sc">${html}</div>
  </details>`;

/* 패널 안 타일에 걸린 숫자 단축키. 선택지에 없는 숫자만 여기로 넘어온다. */
let panelKeys = [];

export const panel = (html) => {
  const el = $('left');
  // 타일 모드는 bindTiles가 다시 켠다 — 화면이 바뀌면 일단 끈다
  $('app')?.classList.remove('tiles');
  el.innerHTML = josa(html);
  // 세로모드에서 패널은 높이가 묶여 있다. 넘친 부분이 있다는 것을 알려야
  // 아래에 뭔가 더 있다는 걸 알고 스크롤한다 (실측: 던전에서 몸 도식이 12px 잘렸다)
  requestAnimationFrame(() => el.classList.toggle('more', el.scrollHeight > el.clientHeight + 1));
  panelKeys = [];
  for (const d of el.querySelectorAll('details[data-sec]')) {
    const k = d.dataset.sec;
    if (secOpen.has(k)) d.open = secOpen.get(k);
    d.addEventListener('toggle', () => secOpen.set(k, d.open));
  }
};

/** 패널 타일에 클릭과 숫자 키를 걸어 준다. go = { 이름: 함수 } */
export function bindTiles(go = {}) {
  // 패널이 '누를 수 있는 것'이 됐다 — 세로모드에서는 로그 아래로 내려간다 (§12.2-A)
  $('app')?.classList.add('tiles');
  for (const b of $('left').querySelectorAll('[data-go]')) {
    const fn = go[b.dataset.go];
    if (!fn) { b.setAttribute('disabled', ''); continue; }
    b.addEventListener('click', () => { soundUnlock(); SFX.tap(); fn(); });
    const k = Number(b.dataset.k);
    if (k >= 1 && k <= 9) panelKeys[k] = fn;
  }
}

/**
 * 체력 바. key를 주면 직전 값을 기억해 **깎인 만큼을 잔상으로 남긴다** —
 * 숫자만 바뀌면 무엇이 얼마나 줄었는지 눈이 못 따라간다.
 */
const lastBar = new Map();
export const bar = (cur, max, foe = false, key = null) => {
  const pct = Math.max(0, Math.min(100, (cur / max) * 100));
  let ghost = '';
  if (key) {
    const prev = lastBar.get(key);
    lastBar.set(key, pct);
    // 늘어난 경우(회복·새 전투)에는 잔상을 남기지 않는다
    if (prev != null && prev > pct) ghost = `<u style="left:${pct}%;width:${prev - pct}%"></u>`;
  }
  return `<div class="bar ${foe ? 'foe' : ''}"><i style="width:${pct}%"></i>${ghost}</div>
          <div class="hpnum">HP ${Math.max(0, Math.round(cur))} / ${max}</div>`;
};
/** 전투가 끝나면 잔상 기억을 비운다 */
export const resetBars = () => lastBar.clear();

const elColor = (el) => `style="color:var(--el-${el})"`;

function statusChips(u) {
  const out = [];
  for (const [k, v] of Object.entries(u.statuses ?? {})) {
    const n = v.stacks ?? v.duration ?? '';
    out.push(`<span class="chip">${k} ${n}</span>`);
  }
  for (const [k, v] of Object.entries(u.ranks ?? {})) {
    if (!v) continue;
    const label = { atk: '공격', def: '방어', spd: '속도', eva: '회피' }[k];
    out.push(`<span class="chip ${v > 0 ? 'good' : 'warn'}">${label} ${v > 0 ? '+' : ''}${v}</span>`);
  }
  return out.length ? `<div class="chips">${out.join('')}</div>` : '';
}

/* ── 몸 도식 ─────────────────────────────────
   여섯 줄짜리 목록은 화면 절반을 먹고도 한눈에 안 들어온다.
   사람 모양으로 세워 놓고 **숫자 하나씩만** 보여 주고, 끼운 부속은 눌렀을 때 아래에 펼친다.
   전투·정비·탐험이 같은 그림을 쓰므로 어느 화면에서 보든 읽는 법이 같다. */
const CELL_LABEL = { head: '머리', body: '몸통', armL: '좌완', armR: '우완', legL: '좌각', legR: '우각' };

/** cells: [{ slot, pct, down, empty }] → 사람 모양 격자 */
export function bodyMapHTML(cells) {
  return `<div class="bodymap">${cells.map((c) => {
    if (c.empty) {
      // 빈 자리야말로 누르고 싶은 자리다. 그림만 그려 두면 끼울 길이 없다
      return `<button type="button" class="bcell empty" style="grid-area:${c.slot}"
        data-slot="${c.slot}" aria-label="${CELL_LABEL[c.slot]} 비어 있음">
        <span class="bl">${CELL_LABEL[c.slot]}</span><span class="bv">—</span></button>`;
    }
    const pct = Math.max(0, Math.min(100, Math.round(c.pct)));
    const state = c.down ? 'down' : pct <= 35 ? 'low' : pct <= 70 ? 'mid' : 'ok';
    return `<button type="button" class="bcell ${state}" style="grid-area:${c.slot}"
      data-slot="${c.slot}" aria-label="${CELL_LABEL[c.slot]} ${pct}%">
      <span class="bl">${CELL_LABEL[c.slot]}</span>
      <span class="bv">${c.down ? '✕' : `${pct}%`}</span>
      <span class="bfill" style="height:${c.down ? 0 : pct}%"></span>
    </button>`;
  }).join('')}</div>
  <div id="bodydetail" class="bodydetail"></div>`;
}

/** 전투 중 펼쳐 둔 부위. 턴이 바뀌어 패널을 다시 그려도 보던 자리를 유지한다. */
let openSlot = null;
export const resetBodyPick = () => { openSlot = null; };

/**
 * detailFor(slot) → 아래에 펼칠 HTML. null이면 비어 있는 자리.
 * onPick(slot)을 주면 **펼치는 대신 그 자리로 곧장 넘어간다** — 정비 화면에서
 * 부위를 누르면 하단이 바로 그 자리의 교체 목록이 되게 하는 길이다 (§12.9).
 */
export function bindBody(detailFor, onPick = null) {
  const box = $('bodydetail');
  if (!box) return;
  const HINT = onPick
    ? '<span class="hint">부위를 누르면 거기에 끼울 것들이 아래에 뜬다.</span>'
    : '<span class="hint">부위를 누르면 무엇을 끼웠는지 보인다.</span>';
  const show = (slot) => { box.innerHTML = detailFor(slot) ?? '<span class="hint">비어 있는 자리다.</span>'; };
  const mark = () => {
    for (const o of document.querySelectorAll('.bodymap .bcell')) o.classList.toggle('picked', o.dataset.slot === openSlot);
  };
  for (const b of document.querySelectorAll('.bodymap .bcell[data-slot]')) {
    b.addEventListener('click', () => {
      if (onPick) { openSlot = b.dataset.slot; mark(); onPick(b.dataset.slot); return; }
      openSlot = openSlot === b.dataset.slot ? null : b.dataset.slot;
      mark();
      if (openSlot) show(openSlot); else box.innerHTML = HINT;
    });
  }
  if (box.innerHTML === '') box.innerHTML = HINT;
  if (!onPick && openSlot && detailFor(openSlot)) { mark(); show(openSlot); }
  if (onPick) mark();
}

/** 부속 하나를 펼쳐 보여 주는 칸 — 전투와 정비가 같은 모양을 쓴다 */
export function partDetailHTML(part, { shield, shieldMax: sMax, down = false, extra = '' }) {
  const sk = partSkills(part).map((id) => DB.skillsBy[id]?.name).filter(Boolean);
  return `
    <div class="bd-top">
      ${partHTML(part)}
      ${part.raw ? '<span class="chip warn">날것</span>' : '<span class="chip good">정착</span>'}
    </div>
    <div class="bd-row">
      <span>방어도 <b>${Math.max(0, shield)}/${sMax}</b></span>
      <span>내구도 <b class="${wornLow(part) ? 'warn' : ''}">${part.integrity}/${part.maxIntegrity}</b></span>
    </div>
    ${down ? '<div class="bd-down">방어가 무너졌다 — 이 부속의 기술을 쓸 수 없다.</div>' : ''}
    ${sk.length ? `<div class="bd-row"><span>기술 ${sk.map(esc).join(', ')}</span></div>` : ''}
    ${extra}`;
}

/** 세이브에 장착된 그대로의 몸 도식 (정비·탐험 화면) */
export function golemBody(save) {
  const cells = SLOTS.map((slot) => {
    const uid = save.golem[slot];
    const p = uid ? save.inventory.find((x) => x.uid === uid) : null;
    if (!p) return { slot, empty: true };
    const max = shieldMax(p, slot);
    return { slot, pct: (shieldNow(p, slot) / max) * 100, down: shieldNow(p, slot) <= 0 };
  });
  const detail = (slot) => {
    const uid = save.golem[slot];
    const p = uid ? save.inventory.find((x) => x.uid === uid) : null;
    if (!p) return null;
    const max = shieldMax(p, slot);
    const now = shieldNow(p, slot);
    return partDetailHTML(p, { shield: now, shieldMax: max, down: now <= 0 });
  };
  return { html: bodyMapHTML(cells), bind: (onPick) => bindBody(detail, onPick) };
}

function bindBodyCells(cb) {
  bindBody((slot) => {
    const w = cb.g.worn.find((x) => x.slot === slot);
    if (!w) return null;
    const f = cb.frames?.[slot];
    return partDetailHTML(w.part, {
      shield: f ? f.hp : 0, shieldMax: f ? f.max : 0, down: Boolean(f?.down),
    });
  });
}

/** 전투 중에는 커맨드가 많아진다 — 독의 칸을 좁혀 한 화면에 담는다 */
export const setCombatMode = (on) => $('app')?.classList.toggle('combat', Boolean(on));

export function combatPanel(cb, save) {
  const mon = cb.mon, g = cb.golem;
  const seen = save.seen?.[mon.defId];
  const summon = cb.summon ? DB.summonsBy[cb.summon.id] : null;

  const cells = SLOTS.map((slot) => {
    const w = cb.g.worn.find((x) => x.slot === slot);
    if (!w) return { slot, empty: true };
    const f = cb.frames?.[slot];
    return { slot, pct: f ? (f.hp / f.max) * 100 : 100, down: Boolean(f?.down) };
  });

  const shieldSum = Object.values(cb.frames ?? {}).reduce((n, f) => n + f.hp, 0);
  const shieldCap = Object.values(cb.frames ?? {}).reduce((n, f) => n + f.max, 0);

  const MON_SLOT = { head: '머리', body: '몸통', arm: '팔', leg: '다리' };
  const monParts = Object.values(cb.monFrames ?? {}).map((f) => {
    const pct = Math.max(0, (f.hp / f.max) * 100);
    return `<span class="chip ${f.down ? 'warn' : ''}">${MON_SLOT[f.slot]} ${f.down ? '✕' : Math.round(pct) + '%'}</span>`;
  }).join('');

  /* 적과 골렘을 위아래로 쌓으면 둘이서 화면의 절반을 먹고, 정작 봐야 할
     장비 내구도(몸 도식)가 접힘 아래로 내려간다. **좌우로 나란히** 세워 둘을 한 줄에 담는다. */
  panel(`
    <div class="duo">
      <div class="unit foe">
        <h3>${esc(mon.name)}</h3>
        <span class="tag" ${seen ? elColor(mon.defElement) : ''}>${seen ? mon.defElement : '???'}</span>
        ${cb.watched && cb.monNext && DB.skillsBy[cb.monNext]
          ? `<div class="next">다음 — <b>${esc(DB.skillsBy[cb.monNext].name)}</b></div>` : ''}
        ${bar(mon.hp, mon.maxHp, true, 'mon')}
        ${statusChips(mon)}
        ${monParts ? `<div class="chips">${monParts}</div>` : ''}
      </div>
      <div class="unit">
        <h3>누더기 골렘</h3>
        <span class="tag" ${elColor(g.defElement)}>${g.defElement}</span>
        ${bar(g.hp, g.maxHp, false, 'golem')}
        ${statusChips(g)}
        <div class="chips">
          <span class="chip good">영력 ${cb.will}/10</span>
          <span class="chip ${shieldSum < shieldCap ? 'warn' : ''}">방어 ${shieldSum}/${shieldCap}</span>
          ${cb.prep && DB.necro_skillsBy[cb.prep]
            ? `<span class="chip good">🕯 ${esc(DB.necro_skillsBy[cb.prep].name)}</span>` : ''}
        </div>
      </div>
    </div>
    ${summon ? `<div class="chips"><span class="chip good">
      ${esc(summon.name)} ${cb.summon.hp}/${cb.summon.maxHp} · 남은 ${cb.summon.left}턴</span>
      ${summon.taunt ? `<span class="chip">대신 맞음 ${summon.taunt}%</span>`
        : '<span class="chip">대신 맞지 않는다</span>'}</div>` : ''}
    ${bodyMapHTML(cells)}`);

  // 누르면 그 자리에 끼운 부속을 펼친다. 패널 전체를 다시 그리지 않는다
  bindBodyCells(cb);
}

/** 던전 탐험 중 왼쪽 패널 */
export function dungeonPanel(save, floorData) {
  const { cells } = minimapCells(floorData);
  const cur = floorData.pos;
  /* 방 상태를 한눈에 — 이동을 십자키로 돌리면서 "갔던 방인지"를 알 길이 지도뿐이 됐다.
     · 지금 자리  ▣ 강조 테두리
     · 아직 안 가 봄  ? 초록 점선 — 갈 곳이 남았다는 신호
     · 가 봤지만 안 끝남  아이콘 + 실선
     · 끝난 방  아이콘 흐리게 */
  const grid = cells.map((row) => row.map((r) => {
    if (!r) return `<div class="cell"></div>`;
    if (!r.seen && !r.visited) return `<div class="cell"></div>`;
    const cls = ['cell', 'room'];
    let icon;
    let title = ROOM_LABEL[r.type] ?? '';
    if (r.id === cur) { cls.push('here'); icon = ROOM_ICON[r.type]; title += ' · 지금 자리'; }
    else if (!r.visited) { cls.push('unseen'); icon = '?'; title = '아직 가 보지 않았다'; }
    else if (r.cleared) { cls.push('done'); icon = ROOM_ICON[r.type]; title += ' · 끝남'; }
    else { cls.push('open'); icon = ROOM_ICON[r.type]; title += ' · 남아 있다'; }
    return `<div class="cell ${cls.join(' ')}" title="${esc(title)}">${icon}</div>`;
  }).join('')).join('');

  const left = floorData.rooms.filter((r) => (r.seen || r.visited) && !r.visited).length;

  const cols = cells[0]?.length ?? 1;
  const sealed = floorData.rooms.filter((r) => r.type === 'sealed' && (r.seen || r.visited) && !r.cleared);
  const visited = floorData.rooms.filter((r) => r.visited).length;
  const g = assembleGolem(save);
  const risky = g.worn.filter(({ part }) => wornLow(part));

  // 지금 어디에 있고, 무엇이 목을 조이는가 (§7-A)
  const place = partOf(save.run?.stage)?.place ?? '무덤';
  const hz = CP.hazardOf(save.run?.stage);
  const tier = CP.hazardTier(save.run?.hazard ?? 0);
  const hazardHtml = hz
    ? `<p class="hz${tier ? ` t${tier}` : ''}">【${esc(hz.name)}】 ${tier
        ? esc(CP.HAZARD_TEXT[hz.kind][tier]) : '아직은 조용하다.'}</p>`
    : '';

  const bm = golemBody(save);
  panel(`
    <p class="pt">${esc(place)} ${floorData.floor}층 <span class="sub">방 ${visited}/${floorData.rooms.length}</span></p>
    ${hazardHtml}
    <div class="sidebyside">
    <div class="map" style="grid-template-columns:repeat(${cols},2.2rem)">${grid}</div>
    ${bm.html}
    </div>
    <div class="legend">
      <span class="lg"><i class="sw here"></i>지금</span>
      <span class="lg"><i class="sw unseen"></i>안 가 봄${left ? ` ${left}` : ''}</span>
      <span class="lg"><i class="sw open"></i>남음</span>
      <span class="lg"><i class="sw done"></i>끝남</span>
      ${sealed.map((r) => `<span>🔒 ${esc(r.seal.label)}</span>`).join('')}
    </div>
    <hr class="sep">
    ${bar(save.run.golemHp, g.stats.hp)}
    <div class="chips">
      <span class="chip ${g.shieldNowTotal < g.shieldTotal ? 'warn' : ''}">방어도 ${g.shieldNowTotal}/${g.shieldTotal}</span>
      ${risky.map(({ part }) => `<span class="chip warn">⚠ ${esc(partName(part))} ${part.integrity}</span>`).join('')}
    </div>
    ${sec('stat', '능력치', `공격 ${g.stats.atk} · 방어 ${g.stats.def} · 속도 ${g.stats.spd}`, statGridHTML(g))}`);
  bm.bind();
}

/** 능력치 표 — 여러 화면이 같은 모양을 쓴다 */
export function statGridHTML(g) {
  return `<div class="statgrid">
      <div><span>공격</span> <b>${g.stats.atk}</b></div>
      <div><span>방어</span> <b>${g.stats.def}</b></div>
      <div><span>회피</span> <b>${g.stats.eva}</b></div>
      <div><span>속도</span> <b>${g.stats.spd}</b></div>
      <div><span>집중</span> <b>${g.stats.focus}</b></div>
      <div><span>속성</span> <b style="color:var(--el-${g.defElement})">${g.defElement}</b></div>
    </div>`;
}

/* ── 마을 ─────────────────────────────────
   건물을 선택지에 늘어놓으면 하단이 열 칸씩 차서 정작 '지금 할 일'이 묻힌다.
   마을은 **왼쪽에 그림으로 세워 두고 눌러 들어간다.** 하단에는 행동만 남는다. */
export function townPanel(save, status, go = {}) {
  const t = (key, k, icon, name, sub, cls = '') => `
    <button type="button" class="bldg ${cls}" data-go="${key}" data-k="${k}">
      <span class="bk">${k}</span>
      <span class="bi">${icon}</span>
      <span class="bn">${esc(name)}</span>
      <span class="bs">${esc(sub)}</span>
    </button>`;

  const q = save.quests.active.filter((x) => x.done).length;
  const d = (save.daily?.list ?? []);
  const sp = save.necro.equipped.filter(Boolean).map((id) => DB.necro_skillsBy[id]);

  panel(`
    <p class="pt">시체골 · 밤</p>
    <div class="town">
      ${t('scavenger', 1, '🦴', '바르그', status.scavenger ?? '길잡이', save.golem.core ? '' : 'urge')}
      ${t('ossuary', 2, '⚱', '납골당', status.ossuary ?? '')}
      ${t('quest', 3, '📜', '의뢰소', status.quest ?? `${q}/3`)}
      ${t('market', 4, '🏪', '저잣거리', status.market ?? '')}
      ${t('inventory', 5, '🎒', '소지품', status.inventory ?? '')}
    </div>
    ${sec('necro', '네크로맨서 술법', sp.length ? `${sp.length}개` : '없음',
      sp.length
        ? `<div class="rows">${sp.map((n) => `<div class="row"><span class="lb">${n.school}</span>
            <span class="vl">${esc(n.name)}</span><span class="rt">영력 ${n.will}</span></div>`).join('')}</div>`
        : '<p class="empty">아직 배운 술법이 없다.</p>')}`);
  bindTiles(go);
}

/* ── 골렘 정비 ───────────────────────────────
   장착 여섯 줄 + 능력치 일곱 + 스킬 열 줄이 한 화면에 전부 쏟아져 있었다.
   도식 하나와 경고만 남기고, 나머지는 제목만 두고 접는다. */
/**
 * 고른 자리의 **그 부속 하나**를 읽는다 (§12.13).
 * 전에는 왼쪽에 합계만 있어서, 무엇을 빼야 합계가 어떻게 되는지 알 수 없었다 —
 * 「공격 24」를 보고도 그 24를 어느 팔이 냈는지 모르면 바꿀 것을 고를 수 없다.
 */
function focusHTML(save, g, slot) {
  const w = g.worn.find((x) => x.slot === slot);
  if (!w) return sec('focus', `${SLOT_LABEL[slot]}`, '비어 있다',
    '<p class="empty">아무것도 붙어 있지 않다.</p>', true);
  const p = w.part;
  const st = partStats(p);
  const el = partElement(p);
  const sk = partSkills(p);
  const rows = [];
  const NAME = { hp: '체력', atk: '공격', def: '방어', eva: '회피', spd: '속도', focus: '집중' };
  for (const [k, v] of Object.entries(st)) {
    if (!v) continue;
    rows.push(rowHTML(NAME[k] ?? k, `${v > 0 ? '+' : ''}${v}`,
      k === 'hp' ? '방어도로 간다' : `골렘 합계 ${g.stats[k]}`));
  }
  if (!rows.length) rows.push('<p class="empty">능력치 보정이 없다.</p>');
  const skRows = sk.map((sid) => {
    const s2 = DB.skillsBy[sid];
    const n = g.stacks?.[sid] ?? 1;
    const step = stackStep(n);
    return rowHTML(save.golem.retuned?.[sid] ?? s2.element, esc(s2.name),
      step ? `${n}겹 · 위력 +${Math.round(STACK_POWER * step * 100)}% 명중 +${STACK_ACC * step}`
        : `위력 ${s2.power || '—'}`);
  });
  const n = g.elements?.[el] ?? 1;
  const rstep = resoStep(n);
  return sec('focus', `${SLOT_LABEL[slot]} — ${esc(partName(p))}`,
    `${el} · 내구 ${p.integrity}/${p.maxIntegrity}`,
    `<div class="chips">
       <span class="chip" style="color:var(--el-${el})">결 ${el}</span>
       <span class="chip ${w.shield < w.shieldMax ? 'warn' : ''}">방어도 ${w.shield}/${w.shieldMax}</span>
       ${p.raw ? '<span class="chip warn">날것</span>' : ''}
     </div>
     <div class="rows">${rows.join('')}</div>
     ${skRows.length ? `<p class="pt" style="margin-top:.5rem">이 부속이 주는 기술</p>
       <div class="rows">${skRows.join('')}</div>` : ''}
     <p class="note">${rstep
       ? `같은 결의 부속이 <b>${n}개</b> — ${el} 공격 +${Math.round(RESO_POWER * rstep * 100)}%,
          ${el}로 맞을 때 -${Math.round(RESO_GUARD * rstep * 100)}%.
          대신 ${el}을(를) 누르는 속성에는 그만큼 약하다.`
       : `같은 결의 부속이 이것뿐이다. 하나 더 붙이면 ${el}이(가) 공명한다.`}</p>`, true);
}

export function golemPanel(save, onPick = null, focus = null) {
  const g = assembleGolem(save);
  const core = save.golem.core ? DB.coresBy[save.golem.core] : null;
  const coreHp = save.golem.coreHp ?? g.stats.hp;
  const att = (save.golem.attachments ?? []).map((id) => DB.attachmentsBy[id]?.name).filter(Boolean);
  const risky = g.worn.filter(({ part }) => wornLow(part));
  const raw = g.worn.filter(({ part }) => part.raw);
  const bm = golemBody(save);

  panel(`
    <p class="pt">골렘 <span class="sub">${core ? esc(core.name) : '핵 없음'}</span></p>
    ${core ? bar(coreHp, g.stats.hp) : '<p class="empty">핵이 없다 — 골렘이 서지 못한다.</p>'}
    <div class="chips">
      <span class="chip ${g.shieldNowTotal < g.shieldTotal ? 'warn' : ''}">방어도 ${g.shieldNowTotal}/${g.shieldTotal}</span>
      <span class="chip" style="color:var(--el-${g.defElement})">${g.defElement}</span>
      <span class="chip ${g.over ? 'warn' : ''}">스킬 ${g.active.length}/${SKILL_CAP}</span>
      <span class="chip ${g.manaOver ? 'warn' : ''}">마력 ${g.manaUsed}/${g.manaMax}</span>
    </div>
    ${risky.length || raw.length ? `<div class="chips">
      ${raw.map(({ part }) => `<span class="chip warn">날것 ${esc(partName(part))}</span>`).join('')}
      ${risky.map(({ part }) => `<span class="chip warn">⚠ ${esc(partName(part))} ${part.integrity}</span>`).join('')}
    </div>` : ''}
    ${bm.html}
    ${focus ? focusHTML(save, g, focus) : ''}
    ${sec('stat', '능력치', `공격 ${g.stats.atk} · 방어 ${g.stats.def} · 속도 ${g.stats.spd}`, statGridHTML(g))}
    ${sec('skills', '사용 가능한 스킬', `${g.active.length}개`,
      `<div class="rows">${g.active.map((sid) => {
        const sk = DB.skillsBy[sid];
        const el = save.golem.retuned?.[sid] ?? sk.element;
        return `<div class="row"><span class="lb" style="color:var(--el-${el})">${el}</span>
          <span class="vl">${esc(sk.name)}</span>
          <span class="rt">${sk.power || '—'} · ${sk.charges === null ? '∞' : sk.charges}</span></div>`;
      }).join('')}</div>`)}
    ${sec('att', '부착물', `${att.length}/2`,
      att.length ? `<div class="chips">${att.map((n) => `<span class="chip good">${esc(n)}</span>`).join('')}</div>`
        : '<p class="empty">없음</p>')}`);
  bm.bind(onPick);
}

/** 재화·소지품 등 단순 목록 패널 */
/**
 * 왼쪽 목록. `onPick`을 주면 **줄을 누를 수 있게** 된다 (§12.10) —
 * 목록과 버튼을 두 벌로 늘어놓는 대신, 읽는 목록을 그대로 고르는 목록으로 쓴다.
 * 고른 줄은 `picked`로 표시하고, 하단은 그 줄에 할 수 있는 것만 남긴다.
 */
export function listPanel(title, rows, extra = '', onPick = null, picked = null) {
  panel(`<p class="pt">${esc(title)}</p>
    <div class="rows${onPick ? ' pickable' : ''}">${rows.length ? rows.join('') : '<p class="empty">비어 있다.</p>'}</div>${extra}`);
  if (!onPick) return;
  for (const el of document.querySelectorAll('.rows.pickable .row[data-pick]')) {
    el.classList.toggle('picked', el.dataset.pick === picked);
    el.addEventListener('click', () => onPick(el.dataset.pick));
  }
}

/** pick을 주면 누를 수 있는 줄이 된다 (listPanel의 onPick과 짝이다) */
export const rowHTML = (lb, vl, rt = '', warn = false, pick = null) => {
  /* 곁말이 길면 한 줄 아래로 내린다 — 같은 줄에서 다투면 이름 칸이 세로로 선다 (§12.11) */
  const stack = String(rt).length > 14;
  return `<${pick ? 'button type="button"' : 'div'} class="row${stack ? ' stack' : ''}" ${pick ? `data-pick="${esc(pick)}"` : ''}><span class="lb">${esc(lb)}</span><span class="vl">${vl}</span>
   <span class="rt ${warn ? 'warn' : ''}">${esc(rt)}</span></${pick ? 'button' : 'div'}>`;
};

/* ── 납골당 ─────────────────────────────────
   마을과 같은 방식 — 시설은 왼쪽에 세워 두고 눌러 들어간다. */
export function ossuaryPanel(save, O, now = Date.now(), go = {}) {
  const o = save.ossuary;
  const jobs = (arr) => arr.length ? O.remainText(arr[0].startedAt, arr[0].durationMs, now)
    + (arr.length > 1 ? ` 외 ${arr.length - 1}` : '') : null;

  const tiles = [];
  const t = (key, icon, name, sub, warn = false) =>
    tiles.push(`<button type="button" class="bldg ${warn ? 'urge' : ''}" data-go="${key}"
      data-k="${tiles.length + 1}">
      <span class="bk">${tiles.length + 1}</span><span class="bi">${icon}</span>
      <span class="bn">${esc(name)}</span><span class="bs">${esc(sub)}</span></button>`);

  // 대분류 셋 — 재료를 얻는 곳 · 골렘을 세우고 고치는 곳 · 영구히 사는 곳 (§12.8)
  const vatFull = o.rotVat.stored >= O.vatCap(o);
  const mat = [
    `부패조 ${o.rotVat.stored}/${O.vatCap(o)}`,
    o.dissection.slots.length ? `해체 ${o.dissection.slots.length}` : null,
    o.built.laborBay ? `탐험 ${o.laborBay.dispatch.length}/${O.laborSlots(o)}` : null,
  ].filter(Boolean).join(' · ');
  t('materials', '🫗', '재료', vatFull ? `${mat} 가득` : mat, vatFull);

  const oh = o.overhaul ?? [];
  const cs = O.crewSpeed(save);
  const work = [
    `골렘 ${O.workshopGolems(save).length + 1}기`,
    oh.length ? `정비 ${jobs(oh)}` : null,
    o.built.forge && o.forge.slots.length ? `접합 ${o.forge.slots.length}` : null,
    cs.cut ? `${Math.round(cs.cut * 100)}% 단축` : null,
  ].filter(Boolean).join(' · ');
  t('workshop', '⚙', '공방', work, oh.length > 0);

  t('altar', '🕯', '제단', `영혼재 ${save.soulAsh}`);

  /* ── 돌아가는 일 (§9.5-A) ────────────────────────────
     시간이 드는 것은 여섯 군데에 흩어져 있다 — 부패조·해체대·접합로·정비대·자율 탐험·대장간.
     각 화면에 들어가 봐야 알 수 있으면, 걸어 둔 것을 잊고 그냥 나간다.
     **여기 한 줄씩 모아 놓는다.** 끝나는 순서대로. */
  const jobs_ = [];
  /** endsAt이 없으면(부패조처럼) 끝이 없는 상시 진행이다 */
  const push_ = (where, what, job, warn = false) => {
    const endsAt = job ? job.startedAt + job.durationMs : 0;
    jobs_.push({ where, what, endsAt, warn,
      when: job ? O.remainText(job.startedAt, job.durationMs, now) : '계속' });
  };

  if (o.built.rotVat) {
    const cap = O.vatCap(o);
    if (o.rotVat.stored >= cap) push_('부패조', '가득 찼다 — 비워야 다시 고인다', null, true);
    else if (o.rotVat.input > 0) push_('부패조', `진액이 고이는 중 ${o.rotVat.stored}/${cap}`, null);
    else push_('부패조', '재료를 넣지 않았다 — 아무것도 고이지 않는다', null, true);
  }
  for (const j of o.dissection?.slots ?? []) {
    push_('해체대', j.name ?? '부속 해체', j);
  }
  for (const j of o.forge?.slots ?? []) {
    push_('접합로', O.RECIPES[j.recipe]?.name ?? '작업', j);
  }
  for (const j of o.overhaul ?? []) {
    push_('정비대', O.OVERHAUL[j.kind]?.name ?? '정비', j);
  }
  for (const d of o.laborBay?.dispatch ?? []) {
    const g = (o.workshop?.golems ?? []).find((x) => x.id === d.golemId);
    push_('자율 탐험', `${g?.name ?? '골렘'} — ${d.stageName ?? ''}`, d);
  }
  for (const j of save.town?.smithy ?? []) {
    push_('뼈 모루', j.part ? partName(j.part) : '강화', j);
  }
  // 끝나는 순서대로. 상시 진행(부패조)은 맨 뒤로 보내 '언제 끝나는가'가 위에 오게 한다
  jobs_.sort((a, b) => (a.endsAt || Infinity) - (b.endsAt || Infinity));
  const soonest_ = jobs_.find((j) => j.endsAt);
  const soon_ = soonest_ ? soonest_.when : null;

  /* 날것은 **장착 중인 것과 소지품에 있는 것을 갈라 세어야 한다.**
     접합로의 정착은 소지품에 있는 것만 받는데, 배지가 둘을 합쳐 세는 바람에
     "정착 대기 1개"라고 알리면서 정작 정착 버튼은 "정착할 날것이 없다"가 됐다. */
  const wornUid = new Set(SLOTS.map((sl) => save.golem[sl]).filter(Boolean));
  const rawN = save.inventory.filter((p) => p.raw && !wornUid.has(p.uid)).length;
  const rawWorn = save.inventory.filter((p) => p.raw && wornUid.has(p.uid)).length;
  panel(`<p class="pt">납골당</p>
    <div class="town">${tiles.join('')}</div>
    ${rawN || rawWorn ? `<div class="chips">
      ${rawN ? `<span class="chip warn">정착 대기 ${rawN}개</span>` : ''}
      ${rawWorn ? `<span class="chip warn">장착 중 날것 ${rawWorn}개</span>` : ''}
    </div>` : ''}
    ${sec('idle', '돌아가는 일', jobs_.length ? `${jobs_.length}건${soon_ ? ` · 가장 빠른 것 ${soon_}` : ''}` : '없다',
      (jobs_.length
        ? `<div class="rows jobs">${jobs_.map((j) => rowHTML(j.where, esc(j.what), j.when, j.warn)).join('')}</div>`
        : '<p class="empty">걸어 둔 일이 없다.</p>')
      + `<div class="chips">
        <span class="chip">상한 ${Math.round(o.offlineCapMs / 3600000)}시간</span>
        <span class="chip">부패조 Lv${o.rotVat.level}</span>
      </div>
      <p class="note">자리를 비운 사이 흐른 시간만큼 한 번에 정산된다.
        상한을 넘긴 시간은 버려지므로, 오래 비울 거면 제단에서 상한을 늘려 둔다.</p>`, true)}`);
  bindTiles(go);
}

/** 복귀 정산 화면 — 방치형의 보상 순간 */
export function returnReport(elapsedLabel, lines) {
  const rows = lines.map((l) =>
    `<div class="row"><span class="lb">${esc(l.facility)}</span>
     <span class="vl">${esc(l.text)}</span>
     <span class="rt ${l.warn ? 'warn' : ''}">${l.warn ? esc(l.warn) : ''}</span></div>`);
  panel(`<p class="pt">자리를 비운 사이</p>
    <div class="unit"><h3>${esc(elapsedLabel)}</h3></div>
    <div class="rows">${rows.join('') || '<p class="empty">아무 일도 없었다.</p>'}</div>`);
}
