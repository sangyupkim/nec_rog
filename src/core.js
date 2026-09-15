/** 데이터 로딩 · 난수 · 골렘 조립 · 데미지 계산. DOM에 의존하지 않는다. */

export const DB = {};

const FILES = ['elements', 'skills', 'parts', 'monsters', 'modifiers',
               'necro_skills', 'summons', 'items', 'attachments', 'quests', 'cores'];

export async function loadData() {
  const loaded = await Promise.all(
    FILES.map((f) => fetch(`data/${f}.json`).then((r) => {
      if (!r.ok) throw new Error(`data/${f}.json 을 불러오지 못했습니다 (${r.status})`);
      return r.json();
    })),
  );
  FILES.forEach((f, i) => { DB[f] = loaded[i]; });
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
  return { uid: nextUid(), defId, mod: modId, integrity, maxIntegrity: integrity };
}

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

export const SLOTS = ['head', 'body', 'armL', 'armR', 'leg'];
export const SLOT_LABEL = { head: '머리', body: '몸통', armL: '좌완', armR: '우완', leg: '다리' };
export const SLOT_KIND = { head: 'head', body: 'body', armL: 'arm', armR: 'arm', leg: 'leg' };
export const SKILL_CAP = 9;

/** 장착 상태 + 부착물로부터 골렘의 실제 능력치를 계산한다 */
export function assembleGolem(save) {
  const stats = { hp: 0, atk: 0, def: 0, eva: 0, spd: 0, focus: 0 };
  let defElement = '타격';
  const skills = [];
  const worn = [];

  // 핵이 없으면 골렘은 서지 못한다 (§3.5)
  const core = save.golem.core ? DB.coresBy[save.golem.core] : null;
  if (core) for (const [k, v] of Object.entries(core.stats)) stats[k] += v;

  for (const slot of SLOTS) {
    const uid = save.golem[slot];
    if (!uid) continue;
    const p = save.inventory.find((x) => x.uid === uid);
    if (!p) continue;
    worn.push({ slot, part: p });
    const st = partStats(p);
    for (const k of Object.keys(stats)) stats[k] += st[k] ?? 0;
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
      for (const [k, v] of Object.entries(a.effect.stats)) stats[k] += v;
    } else if (a.effect.op === 'wear_half') traits.wearHalf = true;
    else if (a.effect.op === 'lifetap') traits.lifetap += a.effect.value;
  }

  const banned = save.golem.banned ?? [];
  const active = skills.filter((s) => !banned.includes(s));
  stats.eva = Math.min(60, stats.eva);
  stats.hp = Math.max(1, stats.hp);

  return { stats, defElement, skills, active, worn, traits, core,
           standing: Boolean(core && save.golem.body),
           over: active.length > SKILL_CAP };
}

/** 스킬의 실효 속성 (속성 도가니로 바꾼 경우 반영) */
export function skillElement(save, skillId) {
  return save.golem.retuned?.[skillId] ?? DB.skillsBy[skillId].element;
}

/* ── 부위 체력 (§5.7) ───────────────────────────────── */
const FRAME_BASE = { head: 60, body: 140, armL: 70, armR: 70, leg: 70 };
/** 부위가 버티는 양. 파츠가 튼튼할수록(체력·방어) 오래 버틴다 */
export function frameMax(part, slot) {
  const st = partStats(part);
  return Math.max(24, Math.round(FRAME_BASE[slot] + st.hp / 6 + st.def * 2));
}

/** 몬스터의 부위별 내구 비율 — 처치보다 부위 파괴가 먼저 오지 않도록 넉넉하게 */
export const MON_FRAME_RATIO = { head: 0.45, body: 0.85, arm: 0.55, leg: 0.48 };

export const AIM = {
  random: { name: '무작위', acc: 0, mul: 1.0, slots: null },
  upper:  { name: '상단',   acc: -15, mul: 1.5, slots: ['head', 'armL', 'armR'], mon: ['head', 'arm'] },
  lower:  { name: '하단',   acc: -10, mul: 1.3, slots: ['body', 'leg'],          mon: ['body', 'leg'] },
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

/** 그 층에서 나올 만한 몬스터를 뽑는다 */
export function rollMonster(floor, rng) {
  const byFloor = {
    1: ['m_goblin', 'm_bonehound'],
    2: ['m_goblin', 'm_bonehound', 'm_fungal', 'm_carrion'],
    3: ['m_bonehound', 'm_fungal', 'm_carrion'],
  };
  const id = rng.pick(byFloor[floor] ?? byFloor[3]);
  const modChance = 25 + floor * 10;
  let mod = null;
  if (rng.chance(modChance)) {
    const tierCap = floor >= 3 ? 2 : 1;
    const pool = DB.modifiers.filter((m) => m.tier <= tierCap);
    mod = rng.weighted(pool.map((m) => [m.id, m.weight]));
  }
  return makeMonster(id, mod, rng);
}

/** 층별 엘리트. 전용 엘리트가 없는 층은 일반 몬스터를 승격시켜 쓴다. */
const ELITE_BY_FLOOR = { 1: 'm_goblin', 2: 'm_weaver', 3: 'm_ogre' };

export function rollElite(floor, rng) {
  const id = ELITE_BY_FLOOR[floor] ?? 'm_ogre';
  const pool = DB.modifiers.filter((x) => x.tier <= (floor >= 3 ? 2 : 1));
  const modId = rng.weighted(pool.map((x) => [x.id, x.weight]));
  const m = makeMonster(id, modId, rng);
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

/** 층 보스. 마지막 층은 전용 보스, 그 전은 엘리트를 승격시켜 쓴다. */
export function rollBoss(floor, rng) {
  if (floor >= 3) {
    const pool = DB.modifiers.filter((x) => x.tier <= 2);
    return makeMonster('m_gravelord', rng.weighted(pool.map((x) => [x.id, x.weight])), rng);
  }
  const m = rollElite(floor, rng);
  m.maxHp = Math.round(m.maxHp * 1.2);
  m.hp = m.maxHp;
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
