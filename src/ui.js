/** 화면 그리기 헬퍼. 왼쪽=상태, 오른쪽=로그+선택지 (§12) */
import { DB, SLOTS, SLOT_LABEL, partName, assembleGolem, SKILL_CAP, josa } from './core.js';
import { ROOM_ICON, ROOM_LABEL, minimapCells } from './dungeon.js';

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
export function logHead(text) { logLine(text, 'head'); }
export function clearLog() { $('log').replaceChildren(); }

/* ── 상단바 ─────────────────────────────── */
export function topbar(save, where) {
  $('topbar').innerHTML = `
    <span class="where">${esc(where)}</span>
    <span class="sp"></span>
    <span><b>은화</b> ${save.silver}</span>
    <span><b>영혼재</b> ${save.soulAsh}</span>
    <span><b>조각</b> ${save.scrap}</span>
    <span><b>진액</b> ${save.ichor}</span>
    <span><b>골분</b> ${save.boneMeal}</span>
    <button id="uiscale" type="button" title="글자 크기"></button>`;
  const btn = $('uiscale');
  btn.addEventListener('click', () => window.cycleUiScale?.());
  window.applyUiScale?.();
}

/* ── 선택지 ─────────────────────────────── */
export function choices(list) {
  const box = $('choices');
  box.replaceChildren();
  keyHandlers = [];
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
    if (!c.disabled && c.on) b.addEventListener('click', c.on);
    box.append(b);
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key >= '1' && e.key <= '9') {
    const h = keyHandlers[Number(e.key)];
    if (h) { e.preventDefault(); h(); }
  }
});

/* ── 왼쪽 패널 ──────────────────────────── */
export const panel = (html) => { $('left').innerHTML = josa(html); };

export const bar = (cur, max, foe = false) => {
  const pct = Math.max(0, Math.min(100, (cur / max) * 100));
  return `<div class="bar ${foe ? 'foe' : ''}"><i style="width:${pct}%"></i></div>
          <div class="hpnum">HP ${Math.max(0, Math.round(cur))} / ${max}</div>`;
};

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

  const worn = cb.g.worn
    .map(({ slot, part }) => {
      const warn = part.integrity <= 2;
      return `<div class="row"><span class="lb">${SLOT_LABEL[slot]}</span>
        <span class="vl">${esc(partName(part))}</span>
        <span class="rt ${warn ? 'warn' : ''}">${part.integrity}/${part.maxIntegrity}</span></div>`;
    }).join('');

  panel(`
    <p class="pt">적</p>
    <div class="unit">
      <h3>${esc(mon.name)} <span class="tag" ${seen ? elColor(mon.defElement) : ''}>${seen ? mon.defElement : '???'}</span></h3>
      ${bar(mon.hp, mon.maxHp, true)}
      ${statusChips(mon)}
    </div>
    ${summon ? `<p class="pt">소환수</p>
    <div class="unit">
      <h3>${esc(summon.name)} <span class="tag">남은 ${cb.summon.left}턴</span></h3>
      <div class="bar small"><i style="width:${(cb.summon.hp / cb.summon.maxHp) * 100}%"></i></div>
      <div class="hpnum">HP ${cb.summon.hp} / ${cb.summon.maxHp}</div>
    </div>` : ''}
    <p class="pt">골렘</p>
    <div class="unit">
      <h3>누더기 골렘 <span class="tag" ${elColor(g.defElement)}>${g.defElement}</span></h3>
      ${bar(g.hp, g.maxHp)}
      ${statusChips(g)}
      <div class="chips"><span class="chip good">영력 ${cb.will}/10</span></div>
    </div>
    <p class="pt">장착 · 내구도</p>
    <div class="rows">${worn}</div>`);
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

  panel(`
    <p class="pt">무덤 ${floorData.floor}층 · 방 ${visited}/${floorData.rooms.length}</p>
    <div class="map" style="grid-template-columns:repeat(${cols},2.2rem)">${grid}</div>
    <div class="legend">
      <span>▣ 현재 위치 · 점선 = 미탐험</span>
      ${sealed.map((r) => `<span>🔒 ${esc(r.seal.label)} 필요</span>`).join('')}
    </div>
    <hr class="sep">
    <p class="pt">골렘</p>
    ${bar(save.run.golemHp, g.stats.hp)}
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
    return `<div class="row"><span class="lb">${SLOT_LABEL[slot]}</span>
      <span class="vl">${esc(partName(p))}${p.integrity <= 0 ? ' <span class="chip warn">부패</span>' : ''}</span>
      <span class="rt ${warn ? 'warn' : ''}">${p.integrity}/${p.maxIntegrity}</span></div>`;
  }).join('');

  const att = (save.golem.attachments ?? []).map((id) => DB.attachmentsBy[id]?.name).filter(Boolean);

  panel(`
    <p class="pt">골렘 구성</p>
    <div class="rows">${rows}</div>
    <div class="statgrid">
      <div><span>최대HP</span> <b>${g.stats.hp}</b></div>
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
      부패조는 상한에 닿으면 생산을 멈춘다.</p>`);
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
