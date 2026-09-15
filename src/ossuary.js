/**
 * 납골당 — 오프라인 경과 시간 일괄 정산 (§9).
 *
 * 핵심 규칙: 타이머를 계속 돌리지 않는다. 종료 시각을 저장해 두고,
 * 돌아왔을 때 `now - lastSeenAt`을 한 번에 계산한다.
 * settle()은 DOM과 무관한 순수 계산이라 "72시간 경과" 같은 검증을 즉시 할 수 있다.
 */
import { DB, makePart, partName, makeRng } from './core.js';

export const HOUR = 3600_000;
export const CAP_STEPS = [8 * HOUR, 12 * HOUR, 18 * HOUR, 24 * HOUR];
export const CAP_COST = 80;

export const FACILITIES = {
  rotVat:     { name: '부패조',          icon: '🫗', unlock: 0 },
  dissection: { name: '해체대',          icon: '🔪', unlock: 0 },
  vault:      { name: '표본실',          icon: '🏺', unlock: 30 },
  forge:      { name: '접합로',          icon: '🕯', unlock: 60 },
  laborBay:   { name: '사역 골렘 안치소', icon: '⛓', unlock: 150 },
};

export const SITES = {
  graveyard: { name: '공동묘지',   need: null,        rate: { boneMeal: 2 },           wear: 0 },
  mine:      { name: '무너진 갱도', need: { atk: 25 }, rate: { boneMeal: 3, scrap: 5 }, wear: 6 },
  marsh:     { name: '역병 늪지',   need: { def: 30 }, rate: { ichor: 4 },              wear: 4 },
  ruin:      { name: '전장 유적',   need: { spd: 30 }, rate: { scrap: 3 },              wear: 3, findsPart: 6 },
};

export const RECIPES = {
  attune:  { name: '정착', ms: 20 * 60_000, desc: '전투에서 막 뜯어온 날것 부속을 골렘에 맞춘다. 성능 100%로 회복된다.',
             cost: { scrap: 8, ichor: 1 }, rawOnly: true },
  fuse:    { name: '융합', ms: 45 * 60_000, desc: '같은 슬롯 파츠 2개를 합친다. 스탯 평균 +15%, 스킬은 양쪽에서 하나씩.',
             cost: { ichor: 3 } },
  graft:   { name: '이식', ms: 20 * 60_000, desc: '파츠 하나에 무작위 모디파이어를 붙인다.',
             cost: { ichor: 2, scrap: 10 } },
  mend:    { name: '수복', ms: 30 * 60_000, desc: '닳거나 부패한 부속의 내구도를 상한까지 되돌린다.',
             cost: { scrap: 12, boneMeal: 2 } },
  refine:  { name: '정제', ms: 60 * 60_000, desc: '내구도 상한 +2, 스탯 +10%.',
             cost: { boneMeal: 5 } },
  revive:  { name: '소생', ms: 240 * 60_000, desc: '런에서 잃은 파츠를 복원한다.',
             cost: { ichor: 10, boneMeal: 8 } },
};

/* ── 초기 상태 ──────────────────────────────────── */
export function newOssuary() {
  return {
    lastSeenAt: Date.now(),
    offlineCapMs: CAP_STEPS[0],
    capStep: 0,
    built: { rotVat: true, dissection: true, vault: false, forge: false, laborBay: false },
    rotVat: { level: 1, input: 0, stored: 0 },
    dissection: { level: 1, slots: [] },
    forge: { level: 1, slots: [] },
    laborBay: { level: 1, dispatch: [] },
    vault: { capacity: 3, parts: [], lostRecords: [] },
    crew: { parts: [] },      // 작업반 — 배치하면 해체·접합 작업이 빨라진다
    pending: null,       // 복귀 정산 화면에서 보여줄 내역
  };
}

/**
 * 작업반 능률. 배치한 부속의 능력치 합에 비례해 작업 시간이 줄어든다.
 * 상한 60% — 아무리 좋은 골렘을 세워도 기다림 자체를 없애지는 못한다.
 */
export function crewSpeed(save) {
  const parts = save.ossuary?.crew?.parts ?? [];
  if (!parts.length) return { power: 0, cut: 0 };
  let power = 0;
  for (const p of parts) {
    const st = STATS_OF(p);
    power += st.atk + st.def + Math.max(0, st.spd) + st.focus + Math.round(st.hp / 20);
  }
  return { power, cut: Math.min(0.6, power / 200) };
}
let STATS_OF = () => ({ atk: 0, def: 0, spd: 0, focus: 0, hp: 0 });
export const bindStats = (fn) => { STATS_OF = fn; };

/** 작업반이 붙은 실제 소요 시간 */
export const jobDuration = (save, ms) => Math.round(ms * (1 - crewSpeed(save).cut));

export const vatCap = (o) => o.rotVat.level * 50;
export const dissectionSlots = (o) => o.dissection.level;
export const forgeSlots = (o) => o.forge.level;
export const laborSlots = (o) => o.laborBay.level;

export const DISSECT = {
  common: { ms: 10 * 60_000, scrap: [3, 5], ichor: 0, boneMeal: 0 },
  rare:   { ms: 30 * 60_000, scrap: [8, 12], ichor: 1, boneMeal: 0 },
  unique: { ms: 120 * 60_000, scrap: [20, 20], ichor: 3, boneMeal: 2 },
};

/* ── 대장간 강화 (§10.4) ───────────────────────── */
export const UPGRADE_MAX = 3;
export const upgradeCost = (lv) => ({
  silver: 120 + lv * 90,
  scrap: 10 + lv * 8,
  boneMeal: 2 + lv * 2,
});
export const upgradeMs = (lv) => (25 + lv * 20) * 60_000;

/* ── 정산 ──────────────────────────────────────── */
/**
 * 경과 시간만큼 모든 시설을 한 번에 정산한다.
 * @returns {{elapsed:number, capped:boolean, lines:Array}} 복귀 화면에 쓸 내역
 */
export function settle(save, now = Date.now()) {
  const o = save.ossuary;
  const raw = now - o.lastSeenAt;
  // 시스템 시계를 되돌렸을 때 음수 경과로 상태가 깨지지 않게 막는다
  const elapsed = Math.max(0, Math.min(raw, o.offlineCapMs));
  const capped = raw > o.offlineCapMs;
  o.lastSeenAt = now;

  const lines = [];
  if (elapsed < 60_000) return { elapsed, capped: false, lines };

  const rng = makeRng((now ^ 0x9e3779b9) >>> 0);
  settleVat(save, o, elapsed, lines);
  settleDissection(save, o, now, lines);
  settleForge(save, o, now, rng, lines);
  settleLabor(save, o, elapsed, rng, lines);
  settleSmithy(save, now, lines);

  return { elapsed, capped, lines };
}

/** 대장간에 맡긴 강화가 끝났는지 본다 */
function settleSmithy(save, now, lines) {
  const jobs = save.town?.smithy;
  if (!jobs?.length) return;
  const done = [];
  save.town.smithy = jobs.filter((j) => {
    if (now < j.startedAt + j.durationMs) return true;
    done.push(j);
    return false;
  });
  for (const j of done) {
    const part = { ...j.part, upgrade: (j.part.upgrade ?? 0) + 1 };
    save.inventory.push(part);
    lines.push({ facility: '대장간', text: `${partName(part)} 강화 완료 (+${part.upgrade})` });
  }
}

function settleVat(save, o, elapsed, lines) {
  const v = o.rotVat;
  if (!o.built.rotVat || v.input <= 0) return;
  const cap = vatCap(o);
  const hours = elapsed / HOUR;
  const made = Math.floor(v.input * v.level * hours * 0.25);
  if (made <= 0) return;
  const before = v.stored;
  v.stored = Math.min(cap, v.stored + made);
  const gained = v.stored - before;
  if (gained > 0) {
    lines.push({ facility: '부패조', text: `부패 진액 +${gained}`,
                 warn: v.stored >= cap ? '상한 도달 — 생산이 멈췄다' : null });
  } else if (v.stored >= cap) {
    lines.push({ facility: '부패조', text: '통이 가득 차 더 고이지 않는다', warn: '상한 도달' });
  }
}

function settleDissection(save, o, now, lines) {
  if (!o.built.dissection) return;
  const done = [];
  o.dissection.slots = o.dissection.slots.filter((s) => {
    if (now < s.startedAt + s.durationMs) return true;
    done.push(s);
    return false;
  });
  for (const s of done) {
    save.scrap += s.yield.scrap;
    save.ichor += s.yield.ichor;
    save.boneMeal += s.yield.boneMeal;
    const extras = [];
    if (s.yield.ichor) extras.push(`진액 +${s.yield.ichor}`);
    if (s.yield.boneMeal) extras.push(`골분 +${s.yield.boneMeal}`);
    if (s.yield.modSample) {
      save.modSamples = save.modSamples ?? {};
      save.modSamples[s.yield.modSample] = (save.modSamples[s.yield.modSample] ?? 0) + 1;
      extras.push(`${DB.modifiersBy[s.yield.modSample].prefix} 표본`);
    }
    lines.push({ facility: '해체대', text: `${s.name} 해체 완료 — 시체 조각 +${s.yield.scrap}`
      + (extras.length ? `, ${extras.join(', ')}` : '') });
  }
}

function settleForge(save, o, now, rng, lines) {
  if (!o.built.forge) return;
  const done = [];
  o.forge.slots = o.forge.slots.filter((s) => {
    if (now < s.startedAt + s.durationMs) return true;
    done.push(s);
    return false;
  });
  for (const s of done) {
    const part = finishRecipe(save, s, rng);
    if (!part) { lines.push({ facility: '접합로', text: `${RECIPES[s.recipe].name} 실패 — 재료를 돌려받았다` }); continue; }
    pushToVault(save, o, part, lines);
    lines.push({ facility: '접합로', text: `${RECIPES[s.recipe].name} 완료 → ${partName(part)}` });
  }
}

function finishRecipe(save, job, rng) {
  const inputs = job.inputs ?? [];
  switch (job.recipe) {
    case 'fuse': {
      const [a, b] = inputs;
      if (!a || !b) return null;
      const part = makePart(a.defId, a.mod ?? b.mod ?? null);
      part.fused = {
        stats: mergeStats(a, b),
        skills: [...new Set([...(job.skillsA ?? []), ...(job.skillsB ?? [])])],
      };
      part.integrity = part.maxIntegrity = Math.max(a.maxIntegrity, b.maxIntegrity);
      return part;
    }
    case 'graft': {
      const a = inputs[0];
      if (!a) return null;
      const pool = DB.modifiers.filter((m) => m.tier <= 2);
      const part = makePart(a.defId, rng.weighted(pool.map((m) => [m.id, m.weight])));
      if (a.fused) part.fused = a.fused;
      return part;
    }
    case 'refine': {
      const a = inputs[0];
      if (!a) return null;
      const part = makePart(a.defId, a.mod);
      part.maxIntegrity = a.maxIntegrity + 2;
      part.integrity = part.maxIntegrity;
      part.refined = (a.refined ?? 0) + 1;
      if (a.fused) part.fused = a.fused;
      return part;
    }
    case 'mend': {
      const a = inputs[0];
      if (!a) return null;
      return { ...a, integrity: a.maxIntegrity };
    }
    case 'attune': {
      const a = inputs[0];
      if (!a) return null;
      const part = { ...a, raw: false };
      return part;
    }
    case 'revive': {
      const defId = job.defId;
      if (!defId) return null;
      return makePart(defId, null);
    }
    default: return null;
  }
}

function mergeStats(a, b) {
  const out = {};
  const sa = DB.partsBy[a.defId].stats, sb = DB.partsBy[b.defId].stats;
  for (const k of Object.keys(sa)) out[k] = Math.round(((sa[k] + sb[k]) / 2) * 1.15);
  return out;
}

function settleLabor(save, o, elapsed, rng, lines) {
  if (!o.built.laborBay) return;
  const hours = elapsed / HOUR;
  for (const d of o.laborBay.dispatch) {
    const site = SITES[d.site];
    const bonus = 1 + (d.statValue ?? 0) / 100;
    const gained = [];
    for (const [res, rate] of Object.entries(site.rate)) {
      const n = Math.floor(rate * bonus * hours);
      if (n > 0) { save[res] += n; gained.push(`${RES_LABEL[res]} +${n}`); }
    }
    if (site.findsPart) {
      const found = Math.floor(hours / site.findsPart);
      for (let i = 0; i < found; i++) {
        const pool = DB.parts.filter((p) => p.rarity !== 'unique');
        const part = makePart(rng.pick(pool).id, rng.chance(35)
          ? rng.weighted(DB.modifiers.filter((m) => m.tier === 1).map((m) => [m.id, m.weight])) : null);
        pushToVault(save, o, part, lines);
        gained.push(`${partName(part)} 발견`);
      }
    }
    // 파견은 내구도를 갉아먹는다 — 방치 수익과 파츠 수명의 교환 (§9.3-④)
    let lost = null;
    if (site.wear) {
      d.wearClock = (d.wearClock ?? 0) + hours;
      while (d.wearClock >= site.wear) {
        d.wearClock -= site.wear;
        const alive = d.parts.filter((p) => p.integrity > 0);
        if (!alive.length) break;
        const target = rng.pick(alive);
        target.integrity--;
        if (target.integrity <= 0) lost = partName(target);
      }
    }
    lines.push({
      facility: '파견',
      text: `${site.name} · ${gained.length ? gained.join(', ') : '수확 없음'}`,
      warn: lost ? `${lost}이(가) 삭아 사라졌다` : lowIntegrityWarn(d),
    });
    if (lost) d.parts = d.parts.filter((p) => p.integrity > 0);
    if (!d.parts.length) d.done = true;
  }
  const ended = o.laborBay.dispatch.filter((d) => d.done);
  for (const d of ended) lines.push({ facility: '파견', text: `${SITES[d.site].name} 파견이 끝났다 — 골렘이 남지 않았다` });
  o.laborBay.dispatch = o.laborBay.dispatch.filter((d) => !d.done);
}

const lowIntegrityWarn = (d) => {
  const low = d.parts.filter((p) => p.integrity <= 2);
  return low.length ? `${low.map(partName).join(', ')} 내구도 위험` : null;
};

export const RES_LABEL = { scrap: '시체 조각', ichor: '부패 진액', boneMeal: '골분', silver: '은화', soulAsh: '영혼재' };

export function pushToVault(save, o, part, lines) {
  if (o.vault.parts.length < o.vault.capacity) o.vault.parts.push(part);
  else {
    save.inventory.push(part);
    if (lines) lines.push({ facility: '표본실', text: `자리가 없어 ${partName(part)}을(를) 창고로 보냈다` });
  }
}

/* ── 남은 시간 표기 ─────────────────────────────── */
export function remainText(startedAt, durationMs, now = Date.now()) {
  const left = startedAt + durationMs - now;
  if (left <= 0) return '완료';
  const m = Math.ceil(left / 60_000);
  if (m < 60) return `${m}분 남음`;
  return `${Math.floor(m / 60)}시간 ${m % 60}분 남음`;
}

export function elapsedText(ms) {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}분`;
  const h = Math.floor(m / 60);
  return `${h}시간 ${m % 60}분`;
}

/** 파견 골렘의 요구 스탯 충족 여부 */
export function siteReady(site, stats) {
  if (!site.need) return true;
  const [k, v] = Object.entries(site.need)[0];
  return (stats[k] ?? 0) >= v;
}
