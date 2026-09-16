#!/usr/bin/env node
/**
 * 몬스터 HP 역산기 — **실제 전투 엔진으로** 목표 턴수(§6.2)를 맞춘다.
 *
 * 처음엔 해석적 근사(최선의 스킬을 매 턴 명중시킨다는 가정)로 HP를 구했는데,
 * 실제 엔진에서는 빗나가고, 부위가 무너져 기술이 사라지고, 충전이 떨어진다.
 * 그래서 근사가 18턴이라고 한 보스가 실제로는 33턴이 걸렸고,
 * 그 33턴 동안 방어도가 바닥나 아무도 보스를 넘지 못했다.
 *
 * 이제 근사를 쓰지 않는다. 몬스터가 **처음 등장하는 단계**의 참조 빌드로
 * 진짜 전투를 여러 번 돌려 중앙값 턴수가 목표 안에 들어오는 HP를 이분 탐색한다.
 *
 *   npm run rebalance     # data/monsters.json 의 hp를 고쳐 쓴다
 *   npm run simulate      # 고친 뒤 층을 완주할 수 있는지 본다
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { DB, makeRng, makePart, makeMonster, elemMul } from '../src/core.js';
import { Combat } from '../src/combat.js';

const P = (n) => new URL(`../data/${n}.json`, import.meta.url);
const L = (n) => JSON.parse(readFileSync(P(n), 'utf8'));
const FILES = ['elements', 'skills', 'parts', 'monsters', 'modifiers', 'necro_skills',
               'summons', 'items', 'attachments', 'quests', 'cores', 'campaign', 'story', 'naming'];
for (const f of FILES) DB[f] = L(f);
for (const k of ['skills', 'parts', 'monsters', 'modifiers', 'necro_skills',
                 'summons', 'items', 'attachments', 'cores']) {
  DB[`${k}By`] = Object.fromEntries(DB[k].map((x) => [x.id, x]));
}
DB.stagesBy = {}; DB.partOfStage = {};
for (const part of DB.campaign.parts) {
  for (const st of part.stages) { DB.stagesBy[st.id] = st; DB.partOfStage[st.id] = part; }
}

const BUILDS = JSON.parse(readFileSync(new URL('./_builds.json', import.meta.url), 'utf8'));
const TARGET = { normal: [4, 6], elite: [8, 12], boss: [15, 20] };
const SLOT_ORDER = { head: ['head'], body: ['body'], arm: ['armL', 'armR'], leg: ['legL', 'legR'] };
const SAMPLES = 15;

/**
 * 사람이라면 고를 법한 스킬 — 힘만 보는 게 아니라 **상성을 본 뒤** 고른다.
 * 힘만 보고 고르면 진혼 방어 보스에게 진혼 기술(배율 0)을 계속 휘두르게 된다.
 * 그건 게임이 어려운 게 아니라 봇이 눈이 먼 것이다.
 */
function bestSkill(cb, list) {
  let best = null, bestScore = -1;
  for (const s of list) {
    const def = DB.skillsBy[s.id];
    const mul = elemMul(s.element, cb.mon.defElement);
    const score = (def.power ?? 0) * (def.hits ?? 1) * mul * ((def.accuracy ?? 100) / 100);
    if (score > bestScore) { bestScore = score; best = s; }
  }
  // 전부 0점이면(전부 무효) 그래도 뭐든 쓴다
  return best ?? list[0];
}

function makeSave(ids, coreId) {
  const inv = ids.map((id) => makePart(id));
  const golem = { core: coreId, head: null, body: null, armL: null, armR: null,
                  legL: null, legR: null, attachments: [], banned: [], retuned: {} };
  for (const p of inv) {
    const kind = DB.partsBy[p.defId].slot;
    const order = SLOT_ORDER[kind] ?? ['body'];
    const slot = order.find((s) => !golem[s]);
    if (slot) golem[slot] = p.uid;
  }
  return { inventory: inv, golem, consumables: {}, necro: { known: [], equipped: [] },
           seen: {}, unlocks: {}, scrap: 0, run: null };
}

/** 이 HP였다면 몇 턴 걸렸겠는가 — 실제 엔진, 여러 판의 중앙값 */
function medianTurns(build, monId, hp) {
  const ts = [];
  for (let i = 0; i < SAMPLES; i++) {
    const save = makeSave(build[0], build[1]);
    const rng = makeRng(4242 + i * 104729);
    const mon = makeMonster(monId, null, rng);
    mon.hp = hp; mon.maxHp = hp;
    const cb = new Combat(save, mon, rng);
    let t = 0;
    while (!cb.over && t < 120) {
      const sk = cb.golemSkills().filter((s) => s.usable);
      if (!sk.length) break;
      cb.act({ kind: 'skill', id: bestSkill(cb, sk).id });
      t++;
    }
    ts.push(cb.result === 'win' ? t : 120);   // 못 이기면 최악으로 친다
  }
  ts.sort((a, b) => a - b);
  return ts[Math.floor(ts.length / 2)];
}

// 각 몬스터가 처음 등장하는 단계
const firstStage = {}; const seen = new Set();
for (const part of DB.campaign.parts) for (const st of part.stages) {
  for (const id of [...(st.monsters ?? []), st.elite, st.boss].filter(Boolean)) {
    if (!seen.has(id)) { seen.add(id); firstStage[id] = st.id; }
  }
}

let changed = 0;
console.log(`목표 턴수에서 HP를 역산한다 (실제 엔진 · 판마다 ${SAMPLES}회 중앙값)\n`);
for (const m of DB.monsters) {
  const sid = firstStage[m.id];
  const build = BUILDS[sid];
  if (!build) continue;
  const [lo, hi] = TARGET[m.tier];
  const want = Math.round((lo + hi) / 2);

  let a = 20, b = 3000, best = null;
  for (let i = 0; i < 14; i++) {
    const mid = Math.round((a + b) / 2);
    if (medianTurns(build, m.id, mid) < want) a = mid; else { best = mid; b = mid; }
  }
  if (best == null) { console.log(`  ! ${m.name} 역산 실패`); continue; }
  const hp = Math.max(40, Math.round(best / 5) * 5);
  const t = medianTurns(build, m.id, hp);
  const mark = t < lo || t > hi ? '!' : ' ';
  if (hp !== m.hp) {
    console.log(`  ${mark} ${m.name.padEnd(13)} ${String(m.hp).padStart(4)} → ${String(hp).padStart(4)}  (${sid} · ${t}턴, 목표 ${lo}~${hi})`);
    m.hp = hp; changed++;
  }
}
writeFileSync(P('monsters'), JSON.stringify(DB.monsters, null, 2) + '\n');
console.log(`\n${changed}종 조정`);
