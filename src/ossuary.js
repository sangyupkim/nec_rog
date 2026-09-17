/**
 * 납골당 — 오프라인 경과 시간 일괄 정산 (§9).
 *
 * 핵심 규칙: 타이머를 계속 돌리지 않는다. 종료 시각을 저장해 두고,
 * 돌아왔을 때 `now - lastSeenAt`을 한 번에 계산한다.
 * settle()은 DOM과 무관한 순수 계산이라 "72시간 경과" 같은 검증을 즉시 할 수 있다.
 */
import { DB, makePart, partName, makeRng, wornLow } from './core.js';

export const HOUR = 3600_000;
export const CAP_STEPS = [8 * HOUR, 12 * HOUR, 18 * HOUR, 24 * HOUR];
export const CAP_COST = 80;

export const FACILITIES = {
  rotVat:     { name: '부패조',          icon: '🫗', unlock: 0 },
  dissection: { name: '해체대',          icon: '🔪', unlock: 0 },
  vault:      { name: '표본실',          icon: '🏺', unlock: 30 },
  forge:      { name: '접합로',          icon: '🕯', unlock: 0 },
  laborBay:   { name: '사역 골렘 안치소', icon: '⛓', unlock: 150 },
};

/**
 * 자원 채집터 (§9.3-④).
 * `need`  들어가려면 골렘이 갖춰야 하는 능력치
 * `rate`  시간당 산출 (골렘 능력치에 비례해 늘어난다)
 * `wear`  몇 시간마다 부속 내구도가 1씩 닳는가 — 방치 수익과 부속 수명의 교환
 * `findsPart`  몇 시간마다 부속 하나를 주워 올 기회가 오는가 (`partLuck`% 확률)
 */
/* ── 자율 탐험 (§9.3-④) ─────────────────────────────
   전에는 고정된 네 장소(공동묘지·갱도·늪지·유적)로 보냈다.
   그런데 이 게임에서 「가 본 곳」은 **내가 깬 단계**다. 남는 골렘을 그리로 돌려보내
   내가 이미 지나온 길을 다시 훑게 하는 편이 세계와도 맞고, 진행할수록 수확이 느는
   구조도 저절로 따라온다.

   보내는 시간은 내가 정한다 — **짧으면 조금, 길면 많이.**
   대신 시간이 길수록 부속이 닳을 확률이 오른다(운이 좋으면 한 번도 안 닳는다). */
export const TRIPS = [
  { id: 'short',  name: '짧게',  hours: 1,  label: '1시간',  wearChance: 20 },
  { id: 'medium', name: '보통',  hours: 3,  label: '3시간',  wearChance: 45 },
  { id: 'long',   name: '길게',  hours: 6,  label: '6시간',  wearChance: 70 },
];

/** 단계 하나가 한 시간에 내놓는 양. 뒤로 갈수록 많아진다 */
export function tripRate(stageIndex) {
  const t = stageIndex + 1;                 // 1~9
  return {
    silver: 8 + t * 4,
    scrap: 3 + t * 2,
    // 골분은 처음부터 나온다 — 정비의 발목을 잡는 것이 늘 골분이었다 (§10.6)
    boneMeal: 1 + Math.floor(t / 3),
    ichor: t >= 5 ? 1 + Math.floor(t / 5) : 0,
  };
}

/** 부속을 주워 올 확률(%) — 깊이 갈수록, 오래 있을수록 잘 줍는다 */
export const tripPartLuck = (stageIndex, hours) =>
  Math.min(85, 15 + stageIndex * 5 + hours * 5);

export const RECIPES = {
  attune:  { name: '정착', ms: 20 * 60_000, desc: '전투에서 막 뜯어온 날것 부속을 골렘에 맞춘다. 성능 100%로 회복된다.',
             cost: { scrap: 8, ichor: 1 }, rawOnly: true },
  fuse:    { name: '융합', ms: 45 * 60_000, desc: '같은 슬롯 파츠 2개를 합친다. 스탯 평균 +15%, 스킬은 양쪽에서 하나씩.',
             cost: { ichor: 3 } },
  graft:   { name: '이식', ms: 20 * 60_000, desc: '파츠 하나에 무작위 모디파이어를 붙인다.',
             cost: { ichor: 2, scrap: 10 } },
  mend:    { name: '수복', ms: 30 * 60_000, desc: '닳거나 부패한 부속의 내구도를 상한까지 되돌린다.',
             cost: { scrap: 12, boneMeal: 2 } },
  refine:  { name: '정제', ms: 60 * 60_000, desc: '내구도 상한 +8, 스탯 +10%.',
             cost: { boneMeal: 5 } },
  revive:  { name: '소생', ms: 240 * 60_000, desc: '런에서 잃은 파츠를 복원한다.',
             cost: { ichor: 10, boneMeal: 8 } },
  /* 남는 것을 모자란 것으로 바꾸는 길 (§10.6).
     부패조는 진액을 끝없이 만들지만 쓰는 곳이 적어 상한에 눌러앉는다.
     굳히기는 그 진액을 골분으로 바꾼다 — 재료를 넣지 않고 부속도 쓰지 않는 유일한 조리법이다. */
  congeal: { name: '굳히기', ms: 25 * 60_000, desc: '넘치는 진액을 졸여 골분으로 굳힌다. 진액 8 → 골분 3.',
             cost: { ichor: 8 }, noInput: true, gives: { boneMeal: 3 } },
};

/* ── 초기 상태 ──────────────────────────────────── */
export function newOssuary() {
  return {
    lastSeenAt: Date.now(),
    offlineCapMs: CAP_STEPS[0],
    capStep: 0,
    // 접합로는 처음부터 열려 있다 — 전투 드랍이 전부 날것이라 '정착'이 필수 경로다
    built: { rotVat: true, dissection: true, vault: false, forge: true, laborBay: false },
    rotVat: { level: 1, input: 0, stored: 0 },
    dissection: { level: 1, slots: [] },
    // 정착은 전투 드랍이 **반드시** 거쳐야 하는 길이라 한 칸이면 병목이 된다.
    // 다른 시설과 달리 두 칸에서 시작한다 (§9.3-③)
    forge: { level: 2, slots: [] },
    laborBay: { level: 1, dispatch: [] },
    vault: { capacity: 3, parts: [], lostRecords: [] },
    // 조립대 — 여분 핵으로 세운 사역 골렘들. 작업반·파견에 세울 수 있는 것은 이들뿐이다
    workshop: { golems: [], seq: 0 },
    crew: { parts: [] },      // (구) 부속 직접 배치 — 마이그레이션에서 조립대로 흡수된다
    overhaul: [],             // 정비대 — 방어도·핵 회복 작업
    pending: null,       // 복귀 정산 화면에서 보여줄 내역
  };
}

/**
 * 사역 골렘 한 기의 능률.
 * 핵이 몸을 세우고 부속이 손을 놀린다 — 둘 다 있어야 일이 된다.
 * 부속만 세워 두는 것으로는 아무 일도 일어나지 않는다.
 */
export function golemPower(g) {
  if (!g?.core) return 0;
  let power = Math.round((CORE_HP_OF(g.core) ?? 0) / 10);
  for (const p of g.parts ?? []) {
    const st = STATS_OF(p);
    power += st.atk + st.def + Math.max(0, st.spd) + st.focus + Math.round((st.hp ?? 0) / 20);
  }
  return power;
}

/**
 * 사역 골렘의 능력치 합. 파견 조건과 산출량이 여기서 나온다.
 * 전투 골렘과 달리 핵은 몸을 세우는 몫만 하고, 일은 부속이 한다.
 */
export function golemStats(g) {
  const out = { atk: 0, def: 0, eva: 0, spd: 0, focus: 0 };
  if (!g) return out;
  const core = CORE_STATS_OF(g.core);
  for (const k of Object.keys(out)) out[k] += core?.[k] ?? 0;
  for (const p of g.parts ?? []) {
    const st = STATS_OF(p);
    for (const k of Object.keys(out)) out[k] += st[k] ?? 0;
  }
  return out;
}

/** 조립대에 선 골렘들 (없으면 빈 배열) */
export const workshopGolems = (save) => save.ossuary?.workshop?.golems ?? [];

/**
 * 작업반 능률. 작업반에 세운 **사역 골렘**의 능률 합에 비례해 작업 시간이 줄어든다.
 * 상한 60% — 아무리 좋은 골렘을 세워도 기다림 자체를 없애지는 못한다.
 */
/**
 * 작업반에 붙일 수 있는 골렘 수. 무한정 붙이면 기다림이 통째로 사라진다.
 * 제단에서 안치소를 넓히면 함께 늘어난다 (§9.3-④).
 */
export const crewCap = (o) => 1 + (o?.laborBay?.level ?? 1);

/**
 * 세워 둘 수 있는 사역 골렘 수 (§9.11).
 * 전에는 여분 핵만 있으면 얼마든지 세울 수 있었다. 핵은 단계를 깨거나 사면 계속
 * 들어오니 사실상 무한이었고, 골렘을 쌓을수록 작업반·자율 탐험이 전부 공짜가 된다.
 * 골렘은 이제 **자리**를 먹는다 — 받침대 둘이 기본이고, 안치소를 넓혀야 늘어난다.
 * (던전에 데려가는 몸은 여기 들지 않는다. 그건 내가 조종하는 한 기다.)
 */
export const golemCap = (o) => 2 + (o?.built?.laborBay ? (o.laborBay?.level ?? 1) : 0);

/* ── 사역의 대가는 핵이다 (§9.12) ──────────────────────────────
   작업반과 자율 탐험은 **공짜 수익**이었다. 골렘을 세워 붙여 두기만 하면
   작업 시간이 줄고 재료가 들어왔고, 치르는 것은 자율 탐험의 내구도 한 칸뿐이었다.
   그러니 「세울 수 있는 만큼 세운다」 말고는 결정이 없었다.

   이제 **일은 핵을 갉는다.** 핵 체력은 1 아래로 내려가지 않는다 —
   사역 골렘은 부서지는 게 아니라 **멈춘다**. 정비대의 핵 안정화로 다시 쓴다.
   갉는 속도가 다른 이유가 있다: 작업반은 납골당 안에서 일하고,
   자율 탐험은 **무덤으로 내려간다.** 그래서 저쪽은 핵과 함께 내구도도 건다. */
export const CREW_HP_PER_HOUR = 5;     // 작업반 — 능률을 빌리는 값
export const TRIP_HP_PER_HOUR = 9;     // 자율 탐험 — 무덤값이 붙는다

export const coreMaxOf = (g) => Math.max(1, CORE_HP_OF(g?.core) ?? 1);
export const coreHpOf = (g) => g?.coreHp ?? coreMaxOf(g);
/** 핵이 바닥나 더는 일을 못 하는가 (§9.12) */
export const coreSpent = (g) => coreHpOf(g) <= 1;
/** 핵을 갉는다. 1에서 멈춘다 — 사역 골렘은 부서지지 않는다 */
export function drainCore(g, n) {
  const before = coreHpOf(g);
  g.coreHp = Math.max(1, Math.round(before - n));
  return before - g.coreHp;
}

export function crewSpeed(save) {
  // 멈춘 골렘은 자리를 차지할 뿐 능률을 내지 않는다
  const crew = workshopGolems(save).filter((g) => g.assigned === 'crew' && !coreSpent(g));
  if (!crew.length) return { power: 0, cut: 0, count: 0 };
  const power = crew.reduce((n, g) => n + golemPower(g), 0);
  return { power, cut: Math.min(0.6, power / 200), count: crew.length };
}

let STATS_OF = () => ({ atk: 0, def: 0, spd: 0, focus: 0, hp: 0 });
let CORE_HP_OF = () => 0;
let CORE_STATS_OF = () => ({});
export const bindStats = (fn, coreHp, coreStats) => {
  STATS_OF = fn;
  if (coreHp) CORE_HP_OF = coreHp;
  if (coreStats) CORE_STATS_OF = coreStats;
};

/** 작업반이 붙은 실제 소요 시간 */
export const jobDuration = (save, ms) => Math.round(ms * (1 - crewSpeed(save).cut));

export const vatCap = (o) => o.rotVat.level * 50;
export const dissectionSlots = (o) => o.dissection.level;
export const forgeSlots = (o) => o.forge.level;
export const laborSlots = (o) => o.laborBay.level;

export const DISSECT = {
  common: { ms: 10 * 60_000, scrap: [4, 7], ichor: 0, boneMeal: 0 },
  rare:   { ms: 30 * 60_000, scrap: [8, 12], ichor: 1, boneMeal: 1 },
  unique: { ms: 120 * 60_000, scrap: [20, 20], ichor: 3, boneMeal: 2 },
  legendary: { ms: 180 * 60_000, scrap: [32, 32], ichor: 5, boneMeal: 4 },
};

/* ── 정비대: 방어도·핵 회복 (§9.3-⑦) ───────────── */
/* ── 정비대 (§9.3-⑥) ─────────────────────────────
   전에는 방어도 재건 40분 · 핵 안정화 60분으로 **고정**이었다.
   초반에는 방어도가 1200 남짓인데도 한 시간을 기다려야 해서 템포가 죽었고,
   후반에 방어도가 세 배가 되어도 같은 40분이라 오히려 헐거워졌다.
   이제 **망가진 만큼** 걸린다 — 조금 깎였으면 조금, 많이 깎였으면 많이. */
export const OVERHAUL = {
  shield: {
    name: '방어도 재건', desc: '모든 부위의 방어도를 상한까지 되돌린다.',
    cost: { scrap: 40, boneMeal: 2 },
    base: 4 * 60_000, per: 200, step: 60_000, cap: 25 * 60_000,
  },
  core: {
    /* 핵은 **진액으로 채운다.** 전에는 진액 5 + 골분 4였는데,
       골분이 한 단계에 2.8밖에 안 들어오는 판에 정비 셋이 11을 먹었다 (§10.6).
       진액은 부패조가 끝없이 만들어 남아돌았다 — 쓰는 곳과 나는 곳을 맞바꾼다. */
    name: '핵 안정화', desc: '핵의 체력을 가득 채운다.',
    cost: { ichor: 12 },
    base: 3 * 60_000, per: 30, step: 60_000, cap: 20 * 60_000,
  },
  // 내구도도 고칠 수 있어야 좋은 부속을 계속 데려간다 (§3.3-B).
  // 접합로의 '수복'은 한 부속씩 30분이라 상비 정비로는 무겁다 — 여기서는 골렘 통째로 한 번에.
  wear: {
    name: '부속 수복', desc: '장착한 모든 부속의 내구도를 상한까지 되돌린다.',
    cost: { scrap: 25, boneMeal: 2 },
    base: 3 * 60_000, per: 8, step: 60_000, cap: 20 * 60_000,
  },
};

/** 망가진 양(missing)에 따른 정비 시간. 작업반 단축은 jobDuration이 따로 먹인다 */
export function overhaulMs(kind, missing) {
  const r = OVERHAUL[kind];
  if (!r) return 0;
  return Math.min(r.cap, r.base + Math.ceil(Math.max(0, missing) / r.per) * r.step);
}

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
  settleCrew(save, o, elapsed, lines);
  settleLabor(save, o, elapsed, rng, lines);
  settleSmithy(save, now, lines);
  settleOverhaul(save, now, lines);

  return { elapsed, capped, lines };
}

/** 정비대에 맡긴 방어도·핵 회복이 끝났는지 본다 */
function settleOverhaul(save, now, lines) {
  const jobs = save.ossuary?.overhaul;
  if (!jobs?.length) return;
  const done = [];
  save.ossuary.overhaul = jobs.filter((j) => {
    if (now < j.startedAt + j.durationMs) return true;
    done.push(j);
    return false;
  });
  for (const j of done) {
    // 작업은 골렘 한 기를 통째로 올려놓고 한다. 그 한 기만 되돌린다
    const id = j.golemId ?? save.golem.id;
    const target = id === save.golem.id ? null
      : (save.ossuary.workshop?.golems ?? []).find((g) => g.id === id);
    if (id !== save.golem.id && !target) continue;   // 해체되어 사라진 골렘
    const name = target ? target.name : (save.golem.name ?? '골렘');
    if (j.kind === 'shield') {
      const parts = target ? (target.parts ?? []) : save.inventory;
      for (const p of parts) p.shield = null;        // null = 상한까지 회복
      lines.push({ facility: '정비대', text: `${name} — 방어도 재건 완료, 모든 부위가 온전해졌다` });
    } else if (j.kind === 'wear') {
      const parts = target ? (target.parts ?? []) : save.inventory;
      for (const p of parts) p.integrity = p.maxIntegrity;
      lines.push({ facility: '정비대', text: `${name} — 부속 수복 완료, 닳은 자리가 메워졌다` });
    } else {
      if (target) target.coreHp = null; else save.golem.coreHp = null;   // null = 가득
      lines.push({ facility: '정비대', text: `${name} — 핵 안정화 완료, 박동이 고르다` });
    }
  }
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
    // 재화만 돌려주는 조리법(굳히기)은 부속을 만들지 않는다 (§10.6)
    const gives = RECIPES[s.recipe]?.gives;
    if (gives) {
      for (const [k, v] of Object.entries(gives)) save[k] = (save[k] ?? 0) + v;
      lines.push({ facility: '접합로',
        text: `${RECIPES[s.recipe].name} 완료 — ${Object.entries(gives).map(([k, v]) => `${RES_LABEL[k]} +${v}`).join(', ')}` });
      continue;
    }
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
      /* 들인 것을 조용히 잃게 두지 않는다 — 대장간 강화와 정제는 **더 좋은 쪽을 따라간다.**
         전에는 합치는 순간 둘 다 사라졌다. 은화와 골분을 들인 기록이 말없이 증발하면,
         「좋은 부속은 아예 건드리지 않는 것이 낫다」가 되어 접합로가 죽는다. */
      part.upgrade = Math.max(a.upgrade ?? 0, b.upgrade ?? 0) || undefined;
      part.refined = Math.max(a.refined ?? 0, b.refined ?? 0) || undefined;
      return part;
    }
    case 'graft': {
      const a = inputs[0];
      if (!a) return null;
      const pool = DB.modifiers.filter((m) => m.tier <= 2);
      const part = makePart(a.defId, rng.weighted(pool.map((m) => [m.id, m.weight])));
      if (a.fused) part.fused = a.fused;
      part.upgrade = a.upgrade;      // 이상만 갈아 끼운다 — 들인 강화·정제는 그대로 둔다
      part.refined = a.refined;
      part.integrity = Math.min(a.integrity, part.maxIntegrity);
      return part;
    }
    case 'refine': {
      const a = inputs[0];
      if (!a) return null;
      const part = makePart(a.defId, a.mod);
      part.maxIntegrity = a.maxIntegrity + 8;
      part.integrity = part.maxIntegrity;
      part.refined = (a.refined ?? 0) + 1;
      if (a.fused) part.fused = a.fused;
      part.upgrade = a.upgrade;      // 정제는 강화 위에 얹힌다
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

/**
 * 작업반 정산 — 붙여 둔 골렘의 **핵이 시간만큼 닳는다** (§9.12).
 * 1에 닿으면 스스로 물러난다. 자리를 잡은 채 능률 0으로 서 있으면
 * 「왜 빨라지지 않지」를 알 길이 없으니, **멈춘 것은 손에서 내려놓는다.**
 */
function settleCrew(save, o, elapsed, lines) {
  const hours = elapsed / HOUR;
  if (hours <= 0) return;
  for (const g of o.workshop?.golems ?? []) {
    if (g.assigned !== 'crew') continue;
    const lost = drainCore(g, CREW_HP_PER_HOUR * hours);
    if (!lost) continue;
    const halted = coreSpent(g);
    if (halted) g.assigned = null;
    lines.push({
      facility: '작업반',
      text: `${g.name} — 핵 -${lost} (${coreHpOf(g)}/${coreMaxOf(g)})`,
      warn: halted ? `${g.name}이(가) 멈췄다 — 정비대에서 핵을 안정화해야 다시 일한다` : null,
    });
  }
}

/**
 * 파견 정산 — 보낸 **사역 골렘**이 시간에 비례해 자원을 주워 온다 (§9.3-④).
 * 능력치가 좋을수록 많이 가져오고, 터에 따라 부속도 주워 온다.
 * 대신 부속 내구도가 닳는다 — 공짜 수익은 없다.
 */
function settleLabor(save, o, elapsed, rng, lines) {
  if (!o.built.laborBay) return;
  const now = Date.now();
  for (const d of o.laborBay.dispatch) {
    const g = (o.workshop?.golems ?? []).find((x) => x.id === d.golemId);
    if (!g) { d.done = true; continue; }          // 골렘이 사라졌으면 파견도 끝난다
    if (now < d.startedAt + d.durationMs) continue;   // 아직 돌아올 때가 아니다
    d.done = true;

    const st = golemStats(g);
    const hours = d.durationMs / HOUR;
    // 능력치가 높을수록 더 주워 온다. 상한 +80% — 골렘이 좋아도 시간이 일을 한다
    const bonus = 1 + Math.min(0.8, (st.atk + st.def + st.spd + st.focus) / 120);
    const gained = [];
    for (const [res, rate] of Object.entries(tripRate(d.stageIndex ?? 0))) {
      const n = Math.floor(rate * bonus * hours);
      if (n > 0) { save[res] = (save[res] ?? 0) + n; gained.push(`${RES_LABEL[res]} +${n}`); }
    }

    // 부속 줍기 — 확실한 수입이 아니라 덤이다
    if (rng.chance(tripPartLuck(d.stageIndex ?? 0, hours))) {
      // 자율 탐험이 주워 오는 것에 보스 전용(유니크·전설)은 섞이지 않는다
      const pool = DB.parts.filter((p) => p.rarity !== 'unique' && p.rarity !== 'legendary');
      const part = makePart(rng.pick(pool).id, rng.chance(35)
        ? rng.weighted(DB.modifiers.filter((m) => m.tier === 1).map((m) => [m.id, m.weight])) : null);
      part.raw = true;                            // 주워 온 것은 날것이다 (§3.4)
      pushToVault(save, o, part, lines);
      gained.push(`${partName(part)} 주워 옴`);
    }

    /* 무덤으로 내려갔으니 **핵도 닳는다** (§9.12). 작업반보다 빠르게 갉고,
       내구도까지 확률로 건다 — 자율 탐험이 더 버는 대신 더 치르는 쪽이다. */
    const coreLost = drainCore(g, TRIP_HP_PER_HOUR * hours);
    if (coreLost) gained.push(`핵 -${coreLost} (${coreHpOf(g)}/${coreMaxOf(g)})`);

    /* 내구도는 **한 번 굴려 한 칸**이다. 전에는 시간에 비례해 계속 갉아
       오래 보내면 골렘이 녹아 없어졌다. 이제 길게 보낼수록 확률이 오를 뿐,
       운이 좋으면 한 번도 안 닳는다 — 보내는 것이 도박이 아니라 선택이 된다. */
    let lost = null;
    const trip = TRIPS.find((t) => t.id === d.trip) ?? TRIPS[0];
    if (rng.chance(trip.wearChance)) {
      const alive = (g.parts ?? []).filter((p) => p.integrity > 0);
      if (alive.length) {
        const target = rng.pick(alive);
        target.integrity--;
        if (target.integrity <= 0) lost = partName(target);
        else gained.push(`${partName(target)} 내구도 -1`);
      }
    } else gained.push('말끔히 돌아왔다');

    lines.push({
      facility: '자율 탐험',
      text: `${d.stageName ?? '무덤'} · ${g.name} (${trip.label}) — ${gained.length ? gained.join(', ') : '수확 없음'}`,
      warn: lost ? `${lost}이(가) 삭아 사라졌다`
        : coreSpent(g) ? `${g.name}의 핵이 바닥났다 — 정비대에서 안정화해야 다시 보낸다`
        : lowIntegrityWarn(g),
    });
  }
  for (const d of o.laborBay.dispatch.filter((x) => x.done)) {
    const g = (o.workshop?.golems ?? []).find((x) => x.id === d.golemId);
    if (g) g.assigned = null;
  }
  o.laborBay.dispatch = o.laborBay.dispatch.filter((d) => !d.done);
}

const lowIntegrityWarn = (g) => {
  const low = (g.parts ?? []).filter((p) => wornLow(p));
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

