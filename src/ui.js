/** 화면 그리기 헬퍼. 왼쪽=상태, 오른쪽=로그+선택지 (§12) */
import { DB, SLOTS, SLOT_LABEL, partName, assembleGolem, SKILL_CAP, josa,
         shieldMax, shieldNow, partOf } from './core.js';
import { ROOM_ICON, ROOM_LABEL, minimapCells } from './dungeon.js';
import * as CP from './campaign.js';
import { SFX, unlock as soundUnlock, isOn as soundOn, toggle as soundToggle } from './sound.js';

const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let keyHandlers = [];

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
    const h = keyHandlers[Number(e.key)];
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
export const panel = (html) => { $('left').innerHTML = josa(html); };

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

/** 전투 중 왼쪽 패널 */
export function combatPanel(cb, save) {
  const mon = cb.mon, g = cb.golem;
  const seen = save.seen?.[mon.defId];
  const summon = cb.summon ? DB.summonsBy[cb.summon.id] : null;

  // 부위 상태 — 이 시스템이 보이지 않으면 조준의 의미를 알 수 없다 (§5.7)
  const worn = cb.g.worn
    .map(({ slot, part }) => {
      const f = cb.frames?.[slot];
      const pct = f ? Math.max(0, (f.hp / f.max) * 100) : 100;
      const low = f && !f.down && pct <= 35;
      return `<div class="frame ${f?.down ? 'down' : ''}">
        <div class="frame-top">
          <span class="lb">${SLOT_LABEL[slot]}</span>
          <span class="vl">${part.raw ? '<span class="chip warn">날것</span> ' : ''}${esc(partName(part))}</span>
          <span class="rt ${part.integrity <= 2 ? 'warn' : ''}">${part.integrity}/${part.maxIntegrity}</span>
        </div>
        <div class="bar tiny ${low ? 'low' : ''}"><i style="width:${f?.down ? 0 : pct}%"></i></div>
        ${f?.down ? '<div class="downtag">방어 무너짐 — 기술 사용 불가</div>' : ''}
      </div>`;
    }).join('');

  const shieldSum = Object.values(cb.frames ?? {}).reduce((n, f) => n + f.hp, 0);
  const shieldCap = Object.values(cb.frames ?? {}).reduce((n, f) => n + f.max, 0);

  const MON_SLOT = { head: '머리', body: '몸통', arm: '팔', leg: '다리' };
  const monParts = Object.values(cb.monFrames ?? {}).map((f) => {
    const pct = Math.max(0, (f.hp / f.max) * 100);
    return `<span class="chip ${f.down ? 'warn' : ''}">${MON_SLOT[f.slot]} ${f.down ? '✕' : Math.round(pct) + '%'}</span>`;
  }).join('');

  panel(`
    <p class="pt">적</p>
    <div class="unit">
      <h3>${esc(mon.name)} <span class="tag" ${seen ? elColor(mon.defElement) : ''}>${seen ? mon.defElement : '???'}</span></h3>
      ${bar(mon.hp, mon.maxHp, true, 'mon')}
      ${statusChips(mon)}
      <div class="chips">${monParts}</div>
    </div>
    ${summon ? `<p class="pt">소환수</p>
    <div class="unit">
      <h3>${esc(summon.name)} <span class="tag">남은 ${cb.summon.left}턴</span></h3>
      <div class="bar small"><i style="width:${(cb.summon.hp / cb.summon.maxHp) * 100}%"></i></div>
      <div class="hpnum">HP ${cb.summon.hp} / ${cb.summon.maxHp}</div>
    </div>` : ''}
    <p class="pt">골렘 — 핵</p>
    <div class="unit">
      <h3>누더기 골렘 <span class="tag" ${elColor(g.defElement)}>${g.defElement}</span></h3>
      ${bar(g.hp, g.maxHp, false, 'golem')}
      ${statusChips(g)}
      <div class="chips">
        <span class="chip good">영력 ${cb.will}/10</span>
        <span class="chip">방어도 ${shieldSum}/${shieldCap}</span>
      </div>
    </div>
    <p class="pt">방어도 · 내구도</p>
    <div class="frames">${worn}</div>
    <p class="note">막대 = 방어도. 피해는 방어도를 먼저 깎고, 다 닳아야 핵에 닿는다.
      방어도는 포션으로 돌아오지 않는다.</p>`);
}

/** 던전 탐험 중 왼쪽 패널 */
export function dungeonPanel(save, floorData) {
  const { cells } = minimapCells(floorData);
  const cur = floorData.pos;
  const grid = cells.map((row) => row.map((r) => {
    if (!r) return `<div class="cell"></div>`;
    if (!r.seen && !r.visited) return `<div class="cell"></div>`;
    const cls = ['cell', 'room'];
    if (r.id === cur) cls.push('here');
    else if (!r.visited) cls.push('seen');
    else if (r.cleared) cls.push('done');
    const icon = r.visited || r.type === 'start' ? ROOM_ICON[r.type] : '·';
    return `<div class="cell ${cls.join(' ')}" title="${ROOM_LABEL[r.type] ?? ''}">${icon}</div>`;
  }).join('')).join('');

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

  panel(`
    <p class="pt">${esc(place)} ${floorData.floor}층 · 방 ${visited}/${floorData.rooms.length}</p>
    ${hazardHtml}
    <div class="map" style="grid-template-columns:repeat(${cols},2.2rem)">${grid}</div>
    <div class="legend">
      <span>▣ 현재 위치 · 점선 = 미탐험</span>
      ${sealed.map((r) => `<span>🔒 ${esc(r.seal.label)} 필요</span>`).join('')}
    </div>
    <hr class="sep">
    <p class="pt">핵 · 방어도</p>
    ${bar(save.run.golemHp, g.stats.hp)}
    <div class="chips">
      <span class="chip ${g.shieldNowTotal < g.shieldTotal ? 'warn' : ''}">방어도 ${g.shieldNowTotal}/${g.shieldTotal}</span>
    </div>
    ${risky.length ? `<div class="chips">${risky.map(({ slot, part }) =>
      `<span class="chip warn">⚠ ${esc(partName(part))} ${part.integrity}</span>`).join('')}</div>` : ''}
    <div class="statgrid">
      <div><span>공격</span> <b>${g.stats.atk}</b></div>
      <div><span>방어</span> <b>${g.stats.def}</b></div>
      <div><span>회피</span> <b>${g.stats.eva}</b></div>
      <div><span>속도</span> <b>${g.stats.spd}</b></div>
      <div><span>집중</span> <b>${g.stats.focus}</b></div>
      <div><span>속성</span> <b>${g.defElement}</b></div>
    </div>`);
}

/** 마을 왼쪽 패널 */
export function townPanel(save, status) {
  const b = (icon, n, s) => `<div class="bldg"><div class="n">${icon} ${n}</div><div class="s">${esc(s)}</div></div>`;
  panel(`
    <p class="pt">시체골 · 밤</p>
    <div class="town">
      ${b('📜', '의뢰소', status.quest)}
      ${b('🛒', '썩은 손수레', status.shop)}
      ${b('🔨', '뼈 모루', status.forge)}
      ${b('🕯', '강령술사 조합', status.conclave)}
      ${b('⛏', '무덤으로', `Act 1 · ${save.run ? `${save.run.floor}층 진행 중` : '1층부터'}`)}
    </div>
    <hr class="sep">
    <p class="pt">네크로맨서 술법</p>
    <div class="rows">
      ${(save.necro.equipped.filter(Boolean).length
        ? save.necro.equipped.filter(Boolean).map((id) => {
            const n = DB.necro_skillsBy[id];
            return `<div class="row"><span class="lb">${n.school}</span>
              <span class="vl">${esc(n.name)}</span><span class="rt">영력 ${n.will}</span></div>`;
          }).join('')
        : '<p class="empty">아직 배운 술법이 없다.</p>')}
    </div>`);
}

/** 골렘 상태창 왼쪽 패널 */
export function golemPanel(save) {
  const g = assembleGolem(save);
  const rows = SLOTS.map((slot) => {
    const uid = save.golem[slot];
    const p = uid ? save.inventory.find((x) => x.uid === uid) : null;
    if (!p) {
      return `<div class="row"><span class="lb">${SLOT_LABEL[slot]}</span>
        <span class="vl empty">비어 있음</span><span class="rt">—</span></div>`;
    }
    const warn = p.integrity <= 2;
    const tags = (p.raw ? '<span class="chip warn">날것</span> ' : '<span class="chip good">정착</span> ')
      + (p.integrity <= 0 ? '<span class="chip warn">부패</span> ' : '');
    const sMax = shieldMax(p, slot);
    const sNow = shieldNow(p, slot);
    return `<div class="row"><span class="lb">${SLOT_LABEL[slot]}</span>
      <span class="vl">${tags}${esc(partName(p))}
        <span class="chip ${sNow < sMax ? 'warn' : ''}">방어 ${sNow}/${sMax}</span></span>
      <span class="rt ${warn ? 'warn' : ''}">${p.integrity}/${p.maxIntegrity}</span></div>`;
  }).join('');

  const att = (save.golem.attachments ?? []).map((id) => DB.attachmentsBy[id]?.name).filter(Boolean);

  const core = save.golem.core ? DB.coresBy[save.golem.core] : null;
  const coreHp = save.golem.coreHp ?? g.stats.hp;
  panel(`
    <p class="pt">골렘 구성</p>
    <div class="rows">
      <div class="row"><span class="lb">핵</span>
        <span class="vl">${core ? esc(core.name) : '<span class="empty">없음 — 골렘이 서지 못한다</span>'}</span>
        <span class="rt ${coreHp < g.stats.hp ? 'warn' : ''}">${core ? `${coreHp}/${g.stats.hp}` : '!'}</span></div>
      ${rows}
    </div>
    <div class="statgrid">
      <div><span>핵 체력</span> <b>${g.stats.hp}</b></div>
      <div><span>방어도</span> <b>${g.shieldNowTotal}/${g.shieldTotal}</b></div>
      <div><span>공격</span> <b>${g.stats.atk}</b></div>
      <div><span>방어</span> <b>${g.stats.def}</b></div>
      <div><span>회피</span> <b>${g.stats.eva}</b></div>
      <div><span>속도</span> <b>${g.stats.spd}</b></div>
      <div><span>집중</span> <b>${g.stats.focus}</b></div>
    </div>
    <div class="chips">
      <span class="chip" style="color:var(--el-${g.defElement})">방어 속성 ${g.defElement}</span>
      <span class="chip ${g.over ? 'warn' : ''}">스킬 ${g.active.length}/${SKILL_CAP}</span>
    </div>
    <hr class="sep">
    <p class="pt">부착물 ${att.length}/2</p>
    ${att.length ? `<div class="chips">${att.map((n) => `<span class="chip good">${esc(n)}</span>`).join('')}</div>`
      : '<p class="empty">없음</p>'}
    <hr class="sep">
    <p class="pt">사용 가능한 스킬</p>
    <div class="rows">
      ${g.active.map((sid) => {
        const s = DB.skillsBy[sid];
        const el = save.golem.retuned?.[sid] ?? s.element;
        return `<div class="row"><span class="lb" style="color:var(--el-${el})">${el}</span>
          <span class="vl">${esc(s.name)}</span>
          <span class="rt">${s.power || '—'} · ${s.charges === null ? '∞' : s.charges}</span></div>`;
      }).join('')}
    </div>`);
}

/** 재화·소지품 등 단순 목록 패널 */
export function listPanel(title, rows, extra = '') {
  panel(`<p class="pt">${esc(title)}</p>
    <div class="rows">${rows.length ? rows.join('') : '<p class="empty">비어 있다.</p>'}</div>${extra}`);
}

export const rowHTML = (lb, vl, rt = '', warn = false) =>
  `<div class="row"><span class="lb">${esc(lb)}</span><span class="vl">${vl}</span>
   <span class="rt ${warn ? 'warn' : ''}">${esc(rt)}</span></div>`;

/* ── 납골당 ─────────────────────────────── */
export function ossuaryPanel(save, O, now = Date.now()) {
  const o = save.ossuary;
  const line = (icon, name, status, warn = false) =>
    `<div class="row"><span class="lb">${icon}</span><span class="vl">${esc(name)}</span>
     <span class="rt ${warn ? 'warn' : ''}">${esc(status)}</span></div>`;

  const rows = [];
  rows.push(line('🫗', '부패조', o.built.rotVat
    ? `${o.rotVat.stored}/${O.vatCap(o)}${o.rotVat.stored >= O.vatCap(o) ? ' 가득' : ''}`
    : '미건설', o.rotVat.stored >= O.vatCap(o)));
  rows.push(line('🔪', '해체대', o.built.dissection
    ? (o.dissection.slots.length
        ? o.dissection.slots.map((s) => O.remainText(s.startedAt, s.durationMs, now)).join(', ')
        : `비어 있음 (${O.dissectionSlots(o)}칸)`)
    : '미건설'));
  rows.push(line('🏺', '표본실', o.built.vault
    ? `${o.vault.parts.length}/${o.vault.capacity}` : '미건설'));
  rows.push(line('🕯', '접합로', o.built.forge
    ? (o.forge.slots.length
        ? o.forge.slots.map((s) => O.remainText(s.startedAt, s.durationMs, now)).join(', ')
        : `비어 있음 (${O.forgeSlots(o)}칸)`)
    : '미건설'));
  rows.push(line('⛓', '사역 골렘 안치소', o.built.laborBay
    ? (o.laborBay.dispatch.length
        ? o.laborBay.dispatch.map((d) => O.SITES[d.site].name).join(', ')
        : `파견 없음 (${O.laborSlots(o)}칸)`)
    : '미건설'));

  panel(`<p class="pt">납골당</p>
    <div class="rows">${rows.join('')}</div>
    <hr class="sep">
    <p class="pt">오프라인 정산</p>
    <div class="chips">
      <span class="chip">상한 ${Math.round(o.offlineCapMs / 3600000)}시간</span>
      <span class="chip">부패조 Lv${o.rotVat.level}</span>
    </div>
    <p class="note">자리를 비운 사이 흐른 시간만큼 한 번에 정산된다.
      부패조는 상한에 닿으면 생산을 멈춘다.</p>
    ${(() => { const n = save.inventory.filter((p) => p.raw).length;
      return n ? `<div class="chips"><span class="chip warn">정착 대기 ${n}개</span></div>` : ''; })()}`);
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
