/** 화면 그리기 헬퍼. 왼쪽=상태, 오른쪽=로그+선택지 (§12) */
import { DB, SLOTS, SLOT_LABEL, partName, partSkills, assembleGolem, SKILL_CAP, josa,
         shieldMax, shieldNow, partOf } from './core.js';
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
}

/* ── 선택지 ─────────────────────────────── */
export const onChoicesRendered = [];

/* ── 목록 넘기기 ─────────────────────────────
   선택지가 많은 화면(해체대·접합로·상점…)에서 앞의 몇 개만 보이고
   나머지는 볼 방법이 없었다. 정착 대기 9개 중 7개까지만 보이는 식이다.
   이제 긴 목록은 쪽으로 나누고, `pin: true`인 항목(돌아간다 같은 것)은 모든 쪽에 남는다. */
const PAGE_SIZE = 7;
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

  // 쪽 나누기는 **부속 목록처럼 길어지는 화면에서만** 켠다 (`paged: true`).
  // 마을 같은 허브는 항목이 다 보여야 하므로 그냥 흘려보내고, 상자가 알아서 스크롤한다.
  const size = opts.pageSize ?? PAGE_SIZE;
  const pages = Math.max(1, Math.ceil(items.length / size));
  if (pageAt >= pages) pageAt = pages - 1;

  let shown = items;
  const nav = [];
  if (opts.paged && items.length > size) {
    shown = items.slice(pageAt * size, (pageAt + 1) * size);
    const go = (d) => { pageAt = (pageAt + d + pages) % pages; choices(list, { ...opts, key }); };
    nav.push({ label: '◂ 이전', cls: 'ghost', nokey: true, on: () => go(-1) });
    nav.push({ label: `${pageAt + 1} / ${pages}쪽`, cls: 'ghost', nokey: true, disabled: true });
    nav.push({ label: '다음 ▸', cls: 'ghost', nokey: true, on: () => go(1) });
  }

  render(box, [...shown, ...nav, ...pinned]);
}

function render(box, list) {
  box.replaceChildren();
  keyHandlers = [];
  for (const fn of onChoicesRendered) fn();
  let n = 0;
  for (const c of list) {
    if (!c) continue;
    const b = document.createElement('button');
    b.className = `btn ${c.cls ?? ''}`;
    b.disabled = Boolean(c.disabled);
    let k = '';
    if (!c.disabled && !c.nokey && n < 9) { n++; k = String(n); keyHandlers[n] = c.on; }
    b.innerHTML = josa(`${k ? `<span class="k">${k}</span>` : ''}<span class="nm">${c.label}</span>`
      + (c.meta ? `<span class="meta">${c.meta}</span>` : ''));
    // 인자를 넘기지 않는다. 그대로 넘기면 클릭 이벤트가 첫 인자로 들어가
    // golemScreen(back) 같은 기본 인자를 덮어써 버린다.
    if (!c.disabled && c.on) {
      b.addEventListener('click', () => { soundUnlock(); SFX.tap(); c.on(); });
    }
    // 미리보기 — 마우스는 올리면, 손가락은 길게 누르면 뜬다
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
function textBox(title, value, readOnly, onOk) {
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
    row.append(mk('가져오기', 'primary', () => onOk?.(ta.value)));
  }
  row.append(mk('닫기', 'ghost', () => onOk?.(readOnly ? null : undefined, true)));

  wrap.append(lb, ta, row);
  box.append(wrap);
  if (readOnly) { ta.focus(); ta.select(); }
}

export function showText(title, value) {
  textBox(title, value, true, () => { for (const fn of onTextClosed) fn(); });
}
export function askText(title, onOk) {
  textBox(title, '', false, (v, closed) => {
    for (const fn of onTextClosed) fn();
    if (!closed) onOk(v);
  });
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
  el.innerHTML = josa(html);
  panelKeys = [];
  for (const d of el.querySelectorAll('details[data-sec]')) {
    const k = d.dataset.sec;
    if (secOpen.has(k)) d.open = secOpen.get(k);
    d.addEventListener('toggle', () => secOpen.set(k, d.open));
  }
};

/** 패널 타일에 클릭과 숫자 키를 걸어 준다. go = { 이름: 함수 } */
export function bindTiles(go = {}) {
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
      return `<div class="bcell empty" style="grid-area:${c.slot}">
        <span class="bl">${CELL_LABEL[c.slot]}</span><span class="bv">—</span></div>`;
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
  <div id="bodydetail" class="bodydetail"><span class="hint">부위를 누르면 무엇을 끼웠는지 보인다.</span></div>`;
}

/** 전투 중 펼쳐 둔 부위. 턴이 바뀌어 패널을 다시 그려도 보던 자리를 유지한다. */
let openSlot = null;
export const resetBodyPick = () => { openSlot = null; };

/** detailFor(slot) → 아래에 펼칠 HTML. null이면 비어 있는 자리. */
export function bindBody(detailFor) {
  const box = $('bodydetail');
  if (!box) return;
  const HINT = '<span class="hint">부위를 누르면 무엇을 끼웠는지 보인다.</span>';
  const show = (slot) => { box.innerHTML = detailFor(slot) ?? '<span class="hint">비어 있는 자리다.</span>'; };
  const mark = () => {
    for (const o of document.querySelectorAll('.bodymap .bcell')) o.classList.toggle('picked', o.dataset.slot === openSlot);
  };
  for (const b of document.querySelectorAll('.bodymap .bcell[data-slot]')) {
    b.addEventListener('click', () => {
      openSlot = openSlot === b.dataset.slot ? null : b.dataset.slot;
      mark();
      if (openSlot) show(openSlot); else box.innerHTML = HINT;
    });
  }
  if (openSlot && detailFor(openSlot)) { mark(); show(openSlot); }
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
      <span>내구도 <b class="${part.integrity <= 2 ? 'warn' : ''}">${part.integrity}/${part.maxIntegrity}</b></span>
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
  return { html: bodyMapHTML(cells), bind: () => bindBody(detail) };
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

  panel(`
    <div class="unit foe">
      <h3>${esc(mon.name)} <span class="tag" ${seen ? elColor(mon.defElement) : ''}>${seen ? mon.defElement : '???'}</span></h3>
      ${bar(mon.hp, mon.maxHp, true, 'mon')}
      ${statusChips(mon)}
      ${monParts ? `<div class="chips">${monParts}</div>` : ''}
    </div>
    ${summon ? `<div class="unit">
      <h3>${esc(summon.name)} <span class="tag">남은 ${cb.summon.left}턴</span></h3>
      <div class="bar small"><i style="width:${(cb.summon.hp / cb.summon.maxHp) * 100}%"></i></div>
    </div>` : ''}
    <hr class="sep">
    <div class="unit">
      <h3>누더기 골렘 <span class="tag" ${elColor(g.defElement)}>${g.defElement}</span></h3>
      ${bar(g.hp, g.maxHp, false, 'golem')}
      ${statusChips(g)}
      <div class="chips">
        <span class="chip good">영력 ${cb.will}/10</span>
        <span class="chip ${shieldSum < shieldCap ? 'warn' : ''}">방어도 ${shieldSum}/${shieldCap}</span>
      </div>
    </div>
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
  const risky = g.worn.filter(({ part }) => part.integrity <= 2);

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
    <div class="map" style="grid-template-columns:repeat(${cols},2.2rem)">${grid}</div>
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
    ${bm.html}
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
      ${t('quest', 3, '📜', '의뢰소', `${q}/3${status.questReady ? ' 수령' : ''}`)}
      ${t('daily', 4, '☀', '오늘의 일', `${d.filter((x) => x.done).length}/${d.length}`)}
      ${t('shop', 5, '🛒', '손수레', status.shop)}
      ${t('forge', 6, '🔨', '뼈 모루', status.forge)}
      ${t('conclave', 7, '🕯', '조합', status.conclave)}
      ${t('golem', 8, '⚙', '골렘 정비', status.golem ?? '')}
      ${t('inventory', 9, '🎒', '소지품', status.inventory ?? '')}
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
export function golemPanel(save) {
  const g = assembleGolem(save);
  const core = save.golem.core ? DB.coresBy[save.golem.core] : null;
  const coreHp = save.golem.coreHp ?? g.stats.hp;
  const att = (save.golem.attachments ?? []).map((id) => DB.attachmentsBy[id]?.name).filter(Boolean);
  const risky = g.worn.filter(({ part }) => part.integrity <= 2);
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
  bm.bind();
}

/** 재화·소지품 등 단순 목록 패널 */
export function listPanel(title, rows, extra = '') {
  panel(`<p class="pt">${esc(title)}</p>
    <div class="rows">${rows.length ? rows.join('') : '<p class="empty">비어 있다.</p>'}</div>${extra}`);
}

export const rowHTML = (lb, vl, rt = '', warn = false) =>
  `<div class="row"><span class="lb">${esc(lb)}</span><span class="vl">${vl}</span>
   <span class="rt ${warn ? 'warn' : ''}">${esc(rt)}</span></div>`;

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

  const vatFull = o.rotVat.stored >= O.vatCap(o);
  t('vat', '🫗', '부패조', `${o.rotVat.stored}/${O.vatCap(o)}${vatFull ? ' 가득' : ''}`, vatFull);
  t('dissect', '🔪', '해체대', jobs(o.dissection.slots) ?? `${o.dissection.slots.length}/${O.dissectionSlots(o)}칸`);
  if (o.built.forge) t('forge', '🕯', '접합로', jobs(o.forge.slots) ?? `${o.forge.slots.length}/${O.forgeSlots(o)}칸`);
  if (o.built.vault) t('vault', '🏺', '표본실', `${o.vault.parts.length}/${o.vault.capacity}`);
  if (o.built.laborBay) t('labor', '⛓', '파견', o.laborBay.dispatch.length
    ? `${o.laborBay.dispatch.length}/${O.laborSlots(o)}칸 나감` : `${O.laborSlots(o)}칸 비었다`);
  const oh = o.overhaul ?? [];
  t('overhaul', '🔧', '정비대', jobs(oh) ?? '방어도 · 핵');
  t('workshop', '⚙', '조립대', `골렘 ${O.workshopGolems(save).length}기`);
  const cs = O.crewSpeed(save);
  t('crew', '🛠', '작업반', cs.cut ? `${Math.round(cs.cut * 100)}% 단축` : '배치 없음');
  t('altar', '🕯', '제단', `영혼재 ${save.soulAsh}`);

  const rawN = save.inventory.filter((p) => p.raw).length;
  panel(`<p class="pt">납골당</p>
    <div class="town">${tiles.join('')}</div>
    ${rawN ? `<div class="chips"><span class="chip warn">정착 대기 ${rawN}개</span></div>` : ''}
    ${sec('idle', '오프라인 정산', `상한 ${Math.round(o.offlineCapMs / 3600000)}시간`,
      `<div class="chips">
        <span class="chip">상한 ${Math.round(o.offlineCapMs / 3600000)}시간</span>
        <span class="chip">부패조 Lv${o.rotVat.level}</span>
      </div>
      <p class="note">자리를 비운 사이 흐른 시간만큼 한 번에 정산된다.
        부패조는 상한에 닿으면 생산을 멈춘다.</p>`)}`);
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
