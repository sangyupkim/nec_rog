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
export function rollStock(rng) {
  const items = rng.shuffle(DB.items).slice(0, 4).map((i) => i.id);
  const parts = [];
  const pool = DB.parts.map((p) => p.id);
  for (let i = 0; i < rng.int(2, 3); i++) {
    const modId = rng.chance(45)
      ? rng.weighted(DB.modifiers.filter((m) => m.tier === 1).map((m) => [m.id, m.weight]))
      : null;
    parts.push(makePart(rng.pick(pool), modId));
  }
  return { items, parts };
}

export function partPrice(p) {
  const def = DB.partsBy[p.defId];
  const base = { common: 90, rare: 220 }[def.rarity] ?? 120;
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
