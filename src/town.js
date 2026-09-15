/** 마을 「시체골」 — 의뢰소 · 상점 · 대장간 · 강령술사 조합 (§10) */
import { DB, makePart } from './core.js';

export const RESET_COSTS = [50, 100, 200, 400];

/* ── 의뢰소 ───────────────────────────────────────── */
export function rollQuests(rng, count = 3) {
  const pool = rng.shuffle(DB.quests);
  const picked = [];
  const usedTypes = {};
  for (const q of pool) {
    usedTypes[q.type] ??= 0;
    if (usedTypes[q.type] >= 2) continue; // 같은 유형이 3개 다 차지하지 않게
    usedTypes[q.type]++;
    picked.push(instantiate(q, rng));
    if (picked.length === count) break;
  }
  return picked;
}

function instantiate(q, rng) {
  const goal = rng.int(q.goal[0], q.goal[1]);
  const scale = goal / q.goal[1];
  return {
    uid: `q${rng.int(1000, 9999)}_${q.id}`,
    id: q.id, type: q.type, title: q.title, target: q.target,
    desc: q.desc.replace('{goal}', goal),
    goal, progress: 0, done: false,
    reward: {
      silver: Math.round(q.reward.silver * (0.7 + scale * 0.5)),
      soulAsh: Math.round(q.reward.soulAsh * (0.7 + scale * 0.5)),
    },
  };
}

/* ── 일일 의뢰 (§10.2-A) ───────────────────────────────
   의뢰소의 의뢰는 런 단위라 "오늘 접속할 이유"가 되지 못한다.
   방치 시설이 하루 한 번 접속을 전제로 설계돼 있으므로,
   하루치로 끊기는 짧은 목표를 따로 둔다. 보상은 방치 재료 쪽으로 기운다. */

const DAILY = [
  { id: 'd_kill',    type: '일일', title: '오늘의 사냥',   target: 'any',      goal: [6, 10],
    desc: '무덤에서 {goal}체를 처치한다.',       reward: { silver: 90, scrap: 6 } },
  { id: 'd_loot',    type: '일일', title: '오늘의 수습',   target: 'loot',     goal: [3, 5],
    desc: '부속 {goal}개를 수습해 온다.',        reward: { silver: 70, ichor: 2 } },
  { id: 'd_rooms',   type: '일일', title: '오늘의 답사',   target: 'rooms',    goal: [10, 16],
    desc: '방 {goal}개를 지난다.',               reward: { silver: 60, scrap: 8 } },
  { id: 'd_job',     type: '일일', title: '오늘의 작업',   target: 'job',      goal: [2, 3],
    desc: '납골당 작업 {goal}건을 끝낸다.',      reward: { soulAsh: 20, boneMeal: 3 } },
  { id: 'd_stage',   type: '일일', title: '오늘의 한 바퀴', target: 'stage',   goal: [1, 1],
    desc: '단계 하나를 끝까지 본다.',            reward: { soulAsh: 35, silver: 150 } },
  { id: 'd_dismant', type: '일일', title: '오늘의 해체',   target: 'dismantle', goal: [2, 3],
    desc: '부속 {goal}개를 해체대에 올린다.',     reward: { scrap: 10, ichor: 1 } },
];

/** 오늘 날짜 문자열. 자정을 넘기면 새 의뢰가 걸린다. */
export const today = (now = Date.now()) => {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function rollDaily(rng, count = 3) {
  return rng.shuffle(DAILY).slice(0, count).map((q) => {
    const goal = rng.int(q.goal[0], q.goal[1]);
    return {
      uid: `${q.id}_${rng.int(1000, 9999)}`, id: q.id, type: q.type,
      title: q.title, target: q.target,
      desc: q.desc.replace('{goal}', goal),
      goal, progress: 0, done: false, reward: { ...q.reward },
    };
  });
}

/** 날짜가 바뀌었으면 새로 건다. 미수령 보상은 사라진다 — 그게 '일일'의 뜻이다. */
export function refreshDaily(save, rng, now = Date.now()) {
  const day = today(now);
  if (save.daily?.day === day) return false;
  save.daily = { day, list: rollDaily(rng), claimed: false };
  return true;
}

export function advanceDaily(save, ev) {
  const news = [];
  for (const q of save.daily?.list ?? []) {
    if (q.done) continue;
    let inc = 0;
    if (q.target === 'any' && ev.kind === 'kill') inc = 1;
    else if (q.target === 'loot' && ev.kind === 'loot') inc = 1;
    else if (q.target === 'rooms' && ev.kind === 'progress' && ev.rooms) inc = Math.max(0, ev.rooms - q.progress);
    else if (q.target === 'job' && ev.kind === 'job') inc = ev.count ?? 1;
    else if (q.target === 'stage' && ev.kind === 'stageclear') inc = 1;
    else if (q.target === 'dismantle' && ev.kind === 'dismantle') inc = ev.count ?? 1;
    if (!inc) continue;
    q.progress = Math.min(q.goal, q.progress + inc);
    if (q.progress >= q.goal) { q.done = true; news.push(q); }
  }
  return news;
}

export const dailyAllDone = (save) => (save.daily?.list ?? []).length > 0
  && save.daily.list.every((q) => q.done);

export function claimDaily(save) {
  const got = { silver: 0, soulAsh: 0, scrap: 0, ichor: 0, boneMeal: 0 };
  for (const q of save.daily?.list ?? []) {
    if (!q.done || q.claimed) continue;
    q.claimed = true;
    for (const k of Object.keys(got)) got[k] += q.reward[k] ?? 0;
  }
  for (const k of Object.keys(got)) save[k] = (save[k] ?? 0) + got[k];
  return got;
}

/**
 * 의뢰 진행도 갱신. 게임 곳곳에서 이벤트를 흘려보내면 여기서 받아 처리한다.
 * ev 예: {kind:'kill', monster:'m_goblin'} {kind:'loot', slot:'arm', mod:'mod_poison'}
 */
export function advanceQuests(save, ev) {
  const news = [];
  for (const q of save.quests.active) {
    if (q.done) continue;
    let inc = 0;
    if (q.type === '처치' && ev.kind === 'kill') {
      if (q.target === 'any' || q.target === ev.monster) inc = 1;
    } else if (q.type === '수집' && ev.kind === 'loot') {
      if (q.target === ev.slot) inc = 1;
      else if (q.target === 'modified' && ev.mod) inc = 1;
    } else if (q.type === '도달' && ev.kind === 'progress') {
      if (q.target === 'floor' && ev.floor >= q.goal) inc = q.goal;
      else if (q.target === 'rooms' && ev.rooms) inc = Math.max(0, ev.rooms - q.progress);
    } else if (q.type === '제약') {
      if (q.target === 'summon' && ev.kind === 'summon') inc = ev.count ?? 1;
      else if (q.target === 'nonecro' && ev.kind === 'cleanwin') inc = 1;
      else if (q.target === 'noloss' && ev.kind === 'floorclear' && ev.noLoss) inc = 1;
    } else if (q.type === '처분' && ev.kind === 'dismantle') {
      inc = ev.count ?? 1;
    }
    if (!inc) continue;
    q.progress = Math.min(q.goal, q.progress + inc);
    if (q.progress >= q.goal) { q.done = true; news.push(q); }
  }
  return news;
}

export const questsAllDone = (save) => save.quests.active.every((q) => q.done);

export function claimQuests(save, rng) {
  let silver = 0, soulAsh = 0;
  for (const q of save.quests.active) {
    if (!q.done) continue;
    silver += q.reward.silver;
    soulAsh += q.reward.soulAsh;
  }
  save.silver += silver;
  save.soulAsh += soulAsh;
  save.quests.active = rollQuests(rng);
  save.quests.resets = 0;
  return { silver, soulAsh };
}

export function resetQuests(save, rng) {
  const cost = RESET_COSTS[Math.min(save.quests.resets, RESET_COSTS.length - 1)];
  if (save.silver < cost) return { ok: false, cost };
  save.silver -= cost;
  save.quests.resets++;
  save.quests.active = rollQuests(rng);
  return { ok: true, cost };
}

export const nextResetCost = (save) =>
  RESET_COSTS[Math.min(save.quests.resets, RESET_COSTS.length - 1)];

/* ── 상점 ─────────────────────────────────────────── */
export function rollStock(rng, unlocks = {}) {
  const items = rng.shuffle(DB.items).slice(0, 4).map((i) => i.id);
  const parts = [];
  // 유니크는 상점에 깔리지 않는다 — 보스를 잡아야 나온다
  // '수소문' 해금 단계마다 희귀 이상이 깔릴 확률이 오른다 (§8)
  const lift = unlocks.partPool ?? 0;
  const all = DB.parts.filter((p) => p.rarity !== 'unique');
  const rareOnly = all.filter((p) => p.rarity === 'rare').map((p) => p.id);
  const pool = all.map((p) => p.id);
  const modCap = unlocks.modTier ? 2 : 1;
  for (let i = 0; i < rng.int(2, 3) + (lift > 1 ? 1 : 0); i++) {
    const modId = rng.chance(45 + lift * 15)
      ? rng.weighted(DB.modifiers.filter((m) => m.tier <= modCap).map((m) => [m.id, m.weight]))
      : null;
    const useRare = lift > 0 && rareOnly.length && rng.chance(25 * lift);
    parts.push(makePart(rng.pick(useRare ? rareOnly : pool), modId));
  }
  // 핵은 한 번에 한둘만 깔린다 — 골렘을 다시 세우는 일이 흔해지면 안 된다
  const cores = DB.cores.filter((c) => c.source.includes('shop'))
    .filter(() => rng.chance(55)).map((c) => c.id).slice(0, 2);
  if (!cores.length) cores.push('core_scrap');
  return { items, parts, cores };
}

export function partPrice(p) {
  const def = DB.partsBy[p.defId];
  const base = { common: 90, rare: 220, unique: 520 }[def.rarity] ?? 120;
  return Math.round(base * (p.mod ? 1.5 : 1));
}

export const sellPrice = (p) => Math.round(partPrice(p) * 0.45);

/* ── 대장간 ───────────────────────────────────────── */
export function canCraft(save, att) {
  if (save.silver < att.price) return false;
  for (const [k, v] of Object.entries(att.materials ?? {})) {
    if ((save[k] ?? 0) < v) return false;
  }
  return true;
}

export function craft(save, att) {
  if (!canCraft(save, att)) return false;
  save.silver -= att.price;
  for (const [k, v] of Object.entries(att.materials ?? {})) save[k] -= v;
  save.owned.attachments.push(att.id);
  return true;
}

export const ATTACH_SLOTS = 2;

/* ── 강령술사 조합 ────────────────────────────────── */
export function learnCost(n) { return n.cost.soulAsh; }

export function canLearn(save, n) {
  return !save.necro.known.includes(n.id) && save.soulAsh >= learnCost(n);
}

export function learn(save, n) {
  if (!canLearn(save, n)) return false;
  save.soulAsh -= learnCost(n);
  save.necro.known.push(n.id);
  if (save.necro.equipped.filter(Boolean).length < 3) {
    const i = save.necro.equipped.findIndex((x) => !x);
    save.necro.equipped[i < 0 ? save.necro.equipped.length : i] = n.id;
  }
  return true;
}

/* ── 마을 건물 상태 한 줄 요약 ────────────────────── */
export function buildingStatus(save) {
  const doneCount = save.quests.active.filter((q) => q.done).length;
  const craftable = DB.attachments.filter((a) => canCraft(save, a)
    && !save.owned.attachments.includes(a.id)).length;
  const learnable = DB.necro_skills.filter((n) => canLearn(save, n)).length;
  return {
    quest: questsAllDone(save) ? '보상 수령 가능!' : `의뢰 ${doneCount}/3 완료`,
    shop: save.town.stock ? `물품 ${save.town.stock.items.length + save.town.stock.parts.length}종` : '재고 갱신됨',
    forge: craftable ? `제작 가능 ${craftable}건` : '재료가 부족하다',
    conclave: learnable ? `배울 수 있는 술법 ${learnable}` : '지금은 배울 것이 없다',
  };
}
