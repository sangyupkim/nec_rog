#!/usr/bin/env node
/**
 * 내구도가 얼마나 빨리 닳는가 — **실제 전투 엔진으로 센다** (§3.3-C).
 *
 * 왜: "공격 한 번에 내구도 1은 너무 빠르다"는 보고. 규칙을 「맞을 때 확률로」로 바꿨는데,
 * 바꾼 뒤가 정말 느려졌는지, 그리고 **방어도가 먼저 닳는지 내구도가 먼저 닳는지**는
 * 굴려 보지 않으면 알 수 없다. 한 단계(3층 × 전투 5)를 돌려 둘을 나란히 잰다.
 *
 *   npm run wear
 */
import { readFileSync } from 'node:fs';
import { DB, makeRng, makePart, rollMonster, rollElite, rollBoss, assembleGolem, shieldMax } from '../src/core.js';
import { Combat } from '../src/combat.js';

const L = (n) => JSON.parse(readFileSync(new URL(`../data/${n}.json`, import.meta.url), 'utf8'));
for (const f of ['elements', 'skills', 'parts', 'monsters', 'modifiers', 'necro_skills', 'summons',
                 'items', 'attachments', 'quests', 'cores', 'campaign', 'story', 'naming']) DB[f] = L(f);
for (const k of ['skills', 'parts', 'monsters', 'modifiers', 'necro_skills', 'summons',
                 'items', 'attachments', 'cores']) {
  DB[`${k}By`] = Object.fromEntries(DB[k].map((x) => [x.id, x]));
}
DB.stagesBy = {}; DB.partOfStage = {};
for (const part of DB.campaign.parts) for (const st of part.stages) { DB.stagesBy[st.id] = st; DB.partOfStage[st.id] = part; }
DB.stageOrder = DB.campaign.parts.flatMap((p) => p.stages.map((s) => s.id));

const BUILDS = JSON.parse(readFileSync(new URL('./_builds.json', import.meta.url), 'utf8'));
const SLOT_ORDER = { head: ['head'], body: ['body'], arm: ['armL', 'armR'], leg: ['legL', 'legR'] };

function makeSave(stageId) {
  const [ids, coreId] = BUILDS[stageId];
  const inv = ids.map((id) => makePart(id));
  for (const p of inv) p.raw = false;
  const golem = { core: coreId, head: null, body: null, armL: null, armR: null,
                  legL: null, legR: null, attachments: [], banned: [], retuned: {} };
  const used = new Set();
  for (const p of inv) {
    const order = SLOT_ORDER[DB.partsBy[p.defId].slot] ?? ['body'];
    const slot = order.find((s) => !golem[s] && !used.has(s));
    if (slot) { golem[slot] = p.uid; used.add(slot); }
  }
  for (const p of inv) p.shield = shieldMax(p, Object.keys(golem).find((k) => golem[k] === p.uid) ?? 'body');
  return { inventory: inv, golem, consumables: {}, necro: { known: [], equipped: [] },
           seen: {}, unlocks: {}, scrap: 99, run: null };
}

/** 한 단계(3층 × 전투 5 + 층의 주인)를 돌린다. 죽으면 거기서 끝 */
function runStage(stageId, seed) {
  const save = makeSave(stageId);
  const rng = makeRng(seed);
  const st = DB.stagesBy[stageId];
  let battles = 0, died = false;
  for (let floor = 1; floor <= (st.floors ?? 3) && !died; floor++) {
    for (let i = 0; i < 5 && !died; i++) {
      const isBoss = i === 4 && floor === (st.floors ?? 3);
      const mon = isBoss ? rollBoss(stageId, floor, rng) : rollMonster(stageId, floor, rng);
      const cb = new Combat(save, mon, rng);
      let turn = 0;
      while (!cb.over && turn++ < 40) {
        const sk = cb.golemSkills().filter((x) => x.usable && x.power > 0);
        if (!sk.length) break;
        cb.act({ kind: 'skill', id: sk.sort((a, b) => (b.power * (b.mul ?? 1)) - (a.power * (a.mul ?? 1)))[0].id });
      }
      cb.commitShields();
      for (const [uid, n] of Object.entries(cb.wear ?? {})) {
        const p = save.inventory.find((x) => x.uid === uid);
        if (p) p.integrity -= n;
      }
      battles++;
      if (cb.result === 'lose') died = true;
      save.golem.coreHp = cb.golem.hp;
    }
  }
  const worn = save.inventory.filter((p) => Object.values(save.golem).includes(p.uid));
  const intPct = worn.map((p) => p.integrity / p.maxIntegrity);
  const shPct = worn.map((p, i) => {
    const slot = Object.keys(save.golem).find((k) => save.golem[k] === p.uid);
    return (p.shield ?? 0) / shieldMax(p, slot ?? 'body');
  });
  return {
    battles, died,
    broken: worn.filter((p) => p.integrity <= 0).length,
    intLeft: intPct.reduce((a, b) => a + b, 0) / intPct.length,
    shLeft: shPct.reduce((a, b) => a + Math.max(0, b), 0) / shPct.length,
  };
}

console.log('한 단계를 돌고 나면 무엇이 얼마나 남는가 — 30판씩\n');
console.log('  단계        전투  부서진 부속   내구도 남음   방어도 남음   먼저 닳는 쪽');
let bad = 0;
for (const id of ['1-1', '1-3', '2-3', '3-3']) {
  let b = 0, br = 0, il = 0, sl = 0, n = 0;
  for (let s = 1; s <= 30; s++) {
    const r = runStage(id, s * 7919);
    b += r.battles; br += r.broken; il += r.intLeft; sl += r.shLeft; n++;
  }
  const iL = il / n, sL = sl / n;
  const first = sL < iL ? '방어도 ✓' : '내구도 ✗';
  if (sL >= iL) bad++;
  console.log(`  ${id.padEnd(10)} ${(b / n).toFixed(1).padStart(4)}  `
    + `${(br / n).toFixed(2).padStart(9)}   ${(iL * 100).toFixed(0).padStart(9)}%   `
    + `${(sL * 100).toFixed(0).padStart(9)}%   ${first}`);
}
console.log(bad
  ? `\n${bad}개 단계에서 **내구도가 방어도보다 먼저 닳는다** — 방어도 관리가 의미를 잃는다.`
  : '\n모든 단계에서 방어도가 먼저 닳는다. 부속은 그보다 오래 버틴다.');
process.exit(bad ? 1 : 0);
