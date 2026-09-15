/** 데이터 로딩 · 난수 · 골렘 조립 · 데미지 계산. DOM에 의존하지 않는다. */

export const DB = {};

const FILES = ['elements', 'skills', 'parts', 'monsters', 'modifiers',
               'necro_skills', 'summons', 'items', 'attachments', 'quests', 'cores',
               'campaign', 'story'];

export async function loadData() {
  const loaded = await Promise.all(
    FILES.map((f) => fetch(`data/${f}.json`).then((r) => {
      if (!r.ok) throw new Error(`data/${f}.json 을 불러오지 못했습니다 (${r.status})`);
      return r.json();
    })),
  );
  FILES.forEach((f, i) => { DB[f] = loaded[i]; });
  // 캠페인은 단계 id로 바로 찾을 수 있어야 한다 (§7-A)
  DB.stagesBy = {};
  DB.partOfStage = {};
  for (const part of DB.campaign.parts) {
    for (const st of part.stages) { DB.stagesBy[st.id] = st; DB.partOfStage[st.id] = part; }
  }
  DB.stageOrder = DB.campaign.parts.flatMap((p) => p.stages.map((s2) => s2.id));
  for (const key of ['skills', 'parts', 'monsters', 'modifiers', 'necro_skills',
                     'summons', 'items', 'attachments', 'cores']) {
    DB[`${key}By`] = Object.fromEntries(DB[key].map((x) => [x.id, x]));
  }
}

/* ── 시드 난수 (mulberry32) ─────────────────────────── */
export function makeRng(seed) {
  let a = seed >>> 0;
  const f = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  f.int = (min, max) => min + Math.floor(f() * (max - min + 1));
  f.pick = (arr) => arr[Math.floor(f() * arr.length)];
  f.chance = (pct) => f() * 100 < pct;
  f.shuffle = (arr) => {
    const a2 = [...arr];
    for (let i = a2.length - 1; i > 0; i--) {
      const j = Math.floor(f() * (i + 1));
      [a2[i], a2[j]] = [a2[j], a2[i]];
    }
    return a2;
  };
  f.weighted = (entries) => { // [[value, weight], ...]
    const total = entries.reduce((s, e) => s + e[1], 0);
    let roll = f() * total;
    for (const [v, w] of entries) { roll -= w; if (roll <= 0) return v; }
    return entries.at(-1)[0];
  };
  return f;
}

/* ── 한국어 조사 ────────────────────────────────────── */
const hasBatchim = (ch) => {
  const c = ch.charCodeAt(0);
  if (c < 0xAC00 || c > 0xD7A3) return /[013678]$/.test(ch); // 숫자 받침 근사
  return (c - 0xAC00) % 28 !== 0;
};
const JOSA = {
  '가(이)': ['가', '이'], '이(가)': ['가', '이'],
  '을(를)': ['를', '을'], '를(을)': ['를', '을'],
  '은(는)': ['는', '은'], '는(은)': ['는', '은'],
  '와(과)': ['와', '과'], '과(와)': ['와', '과'],
  '로(으로)': ['로', '으로'], '으로(로)': ['로', '으로'],
};
/** "골렘가(이)" 같은 표기를 받침에 맞는 조사로 바꾼다. 모든 로그가 이 함수를 거친다. */
export function josa(text) {
  return String(text).replace(
    /([가-힣0-9])(가\(이\)|이\(가\)|을\(를\)|를\(을\)|은\(는\)|는\(은\)|와\(과\)|과\(와\)|로\(으로\)|으로\(로\))/g,
    (_, ch, pair) => ch + JOSA[pair][hasBatchim(ch) ? 1 : 0],
  );
}

/* ── 속성 상성 ──────────────────────────────────────── */
export const elemMul = (atkEl, defEl) =>
  DB.elements.matrix[atkEl]?.[defEl] ?? DB.elements.default;

export const ELEMENT_LIST = () => DB.elements.elements;

/* ── 능력 랭크 (§5.4) ───────────────────────────────── */
const RANK = { '-4': 0.5, '-3': 0.57, '-2': 0.67, '-1': 0.8, 0: 1,
               1: 1.25, 2: 1.5, 3: 1.75, 4: 2 };
export const rankMul = (n) => RANK[Math.max(-4, Math.min(4, n | 0))];

/* ── 데미지 공식 (§3.2) ─────────────────────────────── */
export function damage({ power, atk, def, atkEl, defEl, atkRank = 0, defRank = 0 }) {
  if (!power) return 0;
  const raw = (power * (25 + atk * rankMul(atkRank))) / 50;
  const d = Math.max(0, def * rankMul(defRank));
  const reduced = raw * (1 - d / (d + 40));
  return Math.max(1, Math.floor(reduced * elemMul(atkEl, defEl)));
}

/* ── 파츠 인스턴스 ──────────────────────────────────── */
let uidSeq = 1;
export const nextUid = () => `u${uidSeq++}`;
export const syncUidSeq = (n) => { uidSeq = Math.max(uidSeq, n); };

export function makePart(defId, modId = null) {
  const def = DB.partsBy[defId];
  const mod = modId ? DB.modifiersBy[modId] : null;
  const integrity = Math.max(1, Math.round(def.integrity * (mod?.integrity_multiplier ?? 1)));
  // shield(현재 방어도)는 파츠에 붙어 다닌다. 전투를 넘어, 런을 넘어 남는다.
  return { uid: nextUid(), defId, mod: modId, integrity, maxIntegrity: integrity, shield: null };
}

/** 현재 방어도. null이면 아직 닳지 않은 것으로 본다 */
export const shieldNow = (part, slot) => {
  const max = shieldMax(part, slot);
  return part.shield == null ? max : Math.max(0, Math.min(part.shield, max));
};

export function partName(p) {
  const def = DB.partsBy[p.defId];
  const prefix = (p.mod ? `${DB.modifiersBy[p.mod].prefix} ` : '')
    + (p.fused ? '이어붙인 ' : '')
    + (p.refined ? '정제된 ' : '');
  const suffix = p.upgrade ? ` +${p.upgrade}` : '';
  return def.name_template
    .replace('{mod}', prefix)
    .replace('{owner}', def.owner ?? '')
    .replace(/\s+/g, ' ')
    .trim() + suffix;
}

/** 모디파이어가 반영된 파츠 스탯 */
export function partStats(p) {
  const def = DB.partsBy[p.defId];
  const mod = p.mod ? DB.modifiersBy[p.mod] : null;
  // 접합로에서 융합·정제된 파츠는 자체 스탯을 들고 다닌다 (§9.3-③)
  const base = p.fused?.stats ?? def.stats;
  const refine = 1 + 0.1 * (p.refined ?? 0) + 0.08 * (p.upgrade ?? 0);
  const out = {};
  for (const [k, v0] of Object.entries(base)) {
    const v = v0 * refine;
    out[k] = Math.round(v * (mod?.stat_multiplier?.[k] ?? 1) + (mod?.flat_bonus?.[k] ?? 0));
  }
  // 부패한 파츠는 성능이 절반
  if (p.integrity <= 0) for (const k of Object.keys(out)) out[k] = Math.round(out[k] / 2);
  // 정착하지 않은 날것 파츠는 60%만 발휘된다 (§3.4)
  if (p.raw) for (const k of Object.keys(out)) out[k] = Math.round(out[k] * RAW_STAT_RATIO);
  return out;
}

export function partSkills(p) {
  const def = DB.partsBy[p.defId];
  const mod = p.mod ? DB.modifiersBy[p.mod] : null;
  const ids = [...(p.fused?.skills ?? def.skills)];
  if (mod?.added_skill) ids.push(mod.added_skill);
  return ids;
}

/* ── 미처리 파츠 (§3.4) ─────────────────────────────── */
export const RAW_STAT_RATIO = 0.6;    // 날것 파츠의 스탯 발휘율
export const RAW_FAIL_CHANCE = 25;    // 스킬 사용 실패 확률 %
export const RAW_WEAR = 2;            // 전투당 내구도 소모

/** 골렘의 자리 여섯. 팔도 다리도 두 짝이다 — 사람 몸이 그러니까. */
export const SLOTS = ['head', 'body', 'armL', 'armR', 'legL', 'legR'];
export const SLOT_LABEL = { head: '머리', body: '몸통', armL: '좌완', armR: '우완',
                            legL: '좌각', legR: '우각' };
export const SLOT_KIND = { head: 'head', body: 'body', armL: 'arm', armR: 'arm',
                           legL: 'leg', legR: 'leg' };
export const SKILL_CAP = 9;

/** 장착 상태 + 부착물로부터 골렘의 실제 능력치를 계산한다 */
/**
 * 핵이 품은 마력. 대장간에서 강화한 만큼 늘어난다 (§3.7).
 * 좋은 부속일수록 마력을 많이 먹으므로, 좋은 것을 쓰려면 더 좋은 핵을 구하거나
 * 지금 핵을 키워야 한다 — 그 저울질이 요점이다.
 */
export const CORE_MANA_STEP = 3;
export const CORE_MANA_MAX_LV = 5;
export function coreMana(save) {
  const core = save.golem.core ? DB.coresBy[save.golem.core] : null;
  if (!core) return 0;
  const lv = save.coreUpgrades?.[save.golem.core] ?? 0;
  return (core.mana ?? 0) + lv * CORE_MANA_STEP;
}
/** 이 부속이 요구하는 마력 */
export const partMana = (part) => DB.partsBy[part.defId]?.mana ?? 0;

/**
 * 골렘이 무너질 때 소지품에서 흘리는 여분을 고른다 (§3.3).
 * 순수 함수로 둔 이유: 확률이 걸린 규칙은 화면을 거치지 않고 바로 재볼 수 있어야 한다.
 *
 * @param {Array} spares  걸 수 있는 여분 (장착·표본실·조립대·파견은 빼고 넘긴다)
 * @param {number} rate   하나당 잃을 확률(%)
 * @param {{chance:(n:number)=>boolean}} rng
 */
export function rollSpareLoss(spares, rate, rng) {
  const lost = [];
  for (const p of spares) if (rng.chance(rate)) lost.push(p);
  return lost;
}

export function assembleGolem(save) {
  const stats = { hp: 0, atk: 0, def: 0, eva: 0, spd: 0, focus: 0 };
  let defElement = '타격';
  const skills = [];
  const worn = [];

  // 핵이 없으면 골렘은 서지 못한다 (§3.5)
  // 체력은 오직 핵에서 나온다. 파츠의 hp 스탯은 방어도로 간다 (§5.7)
  const core = save.golem.core ? DB.coresBy[save.golem.core] : null;
  if (core) {
    stats.hp = core.hp;
    for (const [k, v] of Object.entries(core.stats)) stats[k] += v;
  }

  for (const slot of SLOTS) {
    const uid = save.golem[slot];
    if (!uid) continue;
    const p = save.inventory.find((x) => x.uid === uid);
    if (!p) continue;
    worn.push({ slot, part: p, shieldMax: shieldMax(p, slot), shield: shieldNow(p, slot) });
    const st = partStats(p);
    for (const k of Object.keys(stats)) if (k !== 'hp') stats[k] += st[k] ?? 0;
    const def = DB.partsBy[p.defId];
    if (def.def_element) defElement = def.def_element;
    for (const sid of partSkills(p)) if (!skills.includes(sid)) skills.push(sid);
  }

  const attachments = save.golem.attachments ?? [];
  const traits = { wearHalf: false, lifetap: 0 };
  for (const aid of attachments) {
    const a = DB.attachmentsBy[aid];
    if (!a) continue;
    if (a.effect.op === 'stats') {
      for (const [k, v] of Object.entries(a.effect.stats)) stats[k] += v;   // 부착물은 체력도 올린다
    } else if (a.effect.op === 'wear_half') traits.wearHalf = true;
    else if (a.effect.op === 'lifetap') traits.lifetap += a.effect.value;
  }

  // 마력 — 핵이 감당할 수 있는 만큼만 부속을 붙인다 (§3.7)
  const manaMax = core ? coreMana(save) : 0;
  const manaUsed = worn.reduce((n, w) => n + (DB.partsBy[w.part.defId]?.mana ?? 0), 0);

  const banned = save.golem.banned ?? [];
  const active = skills.filter((s) => !banned.includes(s));
  stats.eva = Math.min(60, stats.eva);
  stats.hp = Math.max(1, stats.hp);
  const shieldTotal = worn.reduce((n, w) => n + w.shieldMax, 0);
  const shieldNowTotal = worn.reduce((n, w) => n + w.shield, 0);

  return { stats, defElement, skills, active, worn, traits, core, shieldTotal, shieldNowTotal,
           manaMax, manaUsed, manaOver: manaUsed > manaMax,
           // 핵만 있으면 선다. 흉곽은 있으면 좋은 것이지 필수가 아니다 (§3.1)
           standing: Boolean(core),
           coreBare: !save.golem.body,
           over: active.length > SKILL_CAP };
}

/** 스킬의 실효 속성 (속성 도가니로 바꾼 경우 반영) */
export function skillElement(save, skillId) {
  return save.golem.retuned?.[skillId] ?? DB.skillsBy[skillId].element;
}

/* ── 파츠 방어도 (§5.7) ─────────────────────────────
 * 핵이 골렘의 체력이고, 파츠는 그 앞을 막아서는 방어도다.
 * 피해는 방어도를 먼저 깎고, 방어도가 다 닳아야 핵에 닿는다.
 * 방어도는 전투가 끝나도 회복되지 않는다 — 수리해야 돌아온다.
 */
// 방어도는 한 층(전투 4~6회)을 버틸 양이어야 한다.
// 포션으로 돌아오지 않으므로, 한 전투에 소진되면 그 뒤로는 핵이 직접 맞는다.
/**
 * 부위별 기본 방어도 (§5.7).
 * 방어도는 포션으로 돌아오지 않으므로 **한 판이 아니라 한 단계(3층)를 버티는 예산**이다.
 * 처음엔 한 판 기준으로 잡았다가, 1층에서 3~4전투 만에 모든 부위가 무너져
 * 아무도 1-1을 깰 수 없었다. `npm run balance`의 층 완주 검사가 정한 값이다.
 */
const SHIELD_BASE = { head: 160, body: 320, armL: 220, armR: 220, legL: 220, legR: 220 };
export function shieldMax(part, slot) {
  const st = partStats(part);
  return Math.max(30, Math.round(SHIELD_BASE[slot] + st.def * 6 + st.hp / 6));
}
export const frameMax = shieldMax;   // 옛 이름 호환

/** 몬스터의 부위별 내구 비율 — 처치보다 부위 파괴가 먼저 오지 않도록 넉넉하게 */
export const MON_FRAME_RATIO = { head: 0.45, body: 0.85, arm: 0.55, leg: 0.48 };

export const AIM = {
  random: { name: '무작위', acc: 0, mul: 1.0, slots: null },
  upper:  { name: '상단',   acc: -15, mul: 1.5, slots: ['head', 'armL', 'armR'], mon: ['head', 'arm'] },
  lower:  { name: '하단',   acc: -10, mul: 1.3, slots: ['body', 'legL', 'legR'],  mon: ['body', 'leg'] },
};

/* ── 몬스터 인스턴스 ────────────────────────────────── */
export function makeMonster(defId, modId, rng) {
  const def = DB.monstersBy[defId];
  const mod = modId ? DB.modifiersBy[modId] : null;
  const stats = {};
  for (const [k, v] of Object.entries(def.stats)) {
    stats[k] = Math.round(v * (mod?.stat_multiplier?.[k] ?? 1) + (mod?.flat_bonus?.[k] ?? 0));
  }
  const hp = Math.round(def.hp * (mod?.stat_multiplier?.hp ?? 1));
  const skills = [...def.skills];
  if (mod?.added_skill) skills.push(mod.added_skill);
  return {
    defId, mod: modId,
    name: (mod ? `${mod.prefix} ` : '') + def.name,
    hp, maxHp: hp, stats, defElement: def.def_element,
    skills, tier: def.tier, ai: def.ai, lastSkill: null, repeats: 0,
    ranks: { atk: 0, def: 0, spd: 0, eva: 0 }, statuses: {},
    rng,
  };
}

/* ── 캠페인 단계별 몬스터 (§7-A) ──────────────────────
   층이 아니라 '단계'가 무엇이 나오는지를 정한다. 같은 3층이라도
   1부 1단계의 3층과 3부 3단계의 3층은 전혀 다른 곳이다. */

export const stageOf = (id) => DB.stagesBy?.[id] ?? null;
export const partOf = (id) => DB.partOfStage?.[id] ?? null;

/** 모디파이어는 단계의 상한과 층 깊이를 함께 본다 */
function rollMod(stage, floor, rng, unlocks = {}) {
  const chance = 25 + floor * 10;
  if (!rng.chance(chance)) return null;
  // '이상 감식'을 해금하면 tier 2가 한 층 일찍 나온다 (§8)
  const early = unlocks.modTier ? 1 : 0;
  const base = stage?.modTier ?? 1;
  const cap = floor + early >= 3 ? base : Math.min(1, base);
  const pool = DB.modifiers.filter((m) => m.tier <= cap);
  return rng.weighted(pool.map((m) => [m.id, m.weight]));
}

/** 그 단계에서 나올 만한 몬스터를 뽑는다 */
export function rollMonster(stageId, floor, rng, unlocks = {}) {
  const stage = stageOf(stageId);
  const pool = stage?.monsters?.length ? stage.monsters : ['m_goblin', 'm_bonehound'];
  return makeMonster(rng.pick(pool), rollMod(stage, floor, rng, unlocks), rng);
}

/** 단계의 엘리트. 전용 엘리트가 아니면 일반 몬스터를 승격시켜 쓴다. */
export function rollElite(stageId, floor, rng, unlocks = {}) {
  const stage = stageOf(stageId);
  const id = stage?.elite ?? 'm_ogre';
  const m = makeMonster(id, rollMod(stage, floor, rng, unlocks), rng);
  if (DB.monstersBy[id].tier !== 'elite') {
    m.maxHp = Math.round(m.maxHp * 2.2);
    m.hp = m.maxHp;
    m.stats.atk = Math.round(m.stats.atk * 1.2);
    m.stats.def = Math.round(m.stats.def * 1.3);
    m.name = `굶주린 ${m.name}`;
    m.tier = 'elite';
  }
  return m;
}

/** 층 보스. 마지막 층에만 그 단계의 전용 보스가 선다. */
export function rollBoss(stageId, floor, rng, unlocks = {}) {
  const stage = stageOf(stageId);
  const last = stage?.floors ?? 3;
  if (floor >= last && stage?.boss) {
    return makeMonster(stage.boss, rollMod(stage, floor, rng, unlocks), rng);
  }
  // 마지막 층이 아니면 '층의 주인' — 일반 몬스터를 키운 것이다.
  // 전용 엘리트를 한 번 더 키우면(엘리트 × 1.2) 층 중간에 보스급이 서 버린다.
  const pool = stage?.monsters?.length ? stage.monsters : ['m_goblin'];
  const m = makeMonster(rng.pick(pool), rollMod(stage, floor, rng, unlocks), rng);
  m.maxHp = Math.round(m.maxHp * 2.6);
  m.hp = m.maxHp;
  m.stats.atk = Math.round(m.stats.atk * 1.25);
  m.stats.def = Math.round(m.stats.def * 1.2);
  m.tier = 'elite';
  m.name = `층의 주인 ${m.name}`;
  return m;
}

/**
 * 처치한 몬스터가 남기는 파츠 후보.
 * 전투 중 부서진 부위는 쓸 수 없으므로 후보에서 빠진다 (§5.7).
 */
export function rollLoot(mon, rng, count = 2, brokenSlots = []) {
  const def = DB.monstersBy[mon.defId];
  const usable = def.drops.filter((pid) => !brokenSlots.includes(DB.partsBy[pid].slot));
  const pool = rng.shuffle(usable).slice(0, count);
  return pool.map((pid) => {
    const p = makePart(pid, mon.mod);
    p.raw = true;              // 막 뜯어낸 것은 정착 전까지 날것이다
    return p;
  });
}

/* ── 상태이상 ───────────────────────────────────────── */
export const STATUS_INFO = {
  중독: { desc: '턴 종료 시 스택만큼 피해, 스택 1 감소' },
  화상: { desc: '턴 종료 시 최대HP 5% 피해, 공격 -25%' },
  균열: { desc: '받는 피해 +50%' },
  마비: { desc: '25% 확률로 행동 불가, 속도 반감' },
  재생: { desc: '턴 종료 시 최대HP 8% 회복' },
  가시: { desc: '피격 시 반사 피해' },
};

export function addStatus(unit, id, { stacks = 0, duration = 0 } = {}) {
  const cur = unit.statuses[id];
  if (id === '중독') {
    unit.statuses[id] = { stacks: Math.min(10, (cur?.stacks ?? 0) + stacks) };
  } else {
    unit.statuses[id] = { duration: Math.max(cur?.duration ?? 0, duration) };
  }
}

export const hasStatus = (unit, id) => Boolean(unit.statuses[id]);
