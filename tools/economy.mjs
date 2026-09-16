#!/usr/bin/env node
/**
 * 재화 수지 — **한 단계를 도는 동안 무엇이 얼마나 들어오고 나가는가** (§10.6).
 *
 * 왜 만들었나: 「조각이랑 골분은 너무 없고 진액은 너무 남는다」는 보고를 받았다.
 * 눈으로는 알 수 없다 — 들어오는 자리가 넷, 나가는 자리가 여덟이고 자리마다 확률이 걸려 있다.
 * 그래서 **실제 층 생성기로 방을 세어** 계산한다.
 *
 *   npm run economy
 */
import { readFileSync } from 'node:fs';
import { DB, makeRng } from '../src/core.js';
import { generateFloor } from '../src/dungeon.js';
import { RECIPES, DISSECT, OVERHAUL, dissectionSlots, vatCap, tripRate } from '../src/ossuary.js';
import { SUPPLY } from '../src/town.js';

const L = (n) => JSON.parse(readFileSync(new URL(`../data/${n}.json`, import.meta.url), 'utf8'));
for (const f of ['elements', 'skills', 'parts', 'monsters', 'modifiers', 'necro_skills', 'summons',
                 'items', 'attachments', 'quests', 'cores', 'campaign', 'story', 'naming']) DB[f] = L(f);
for (const k of ['skills', 'parts', 'monsters', 'modifiers', 'necro_skills', 'summons',
                 'items', 'attachments', 'cores']) {
  DB[`${k}By`] = Object.fromEntries(DB[k].map((x) => [x.id, x]));
}

const RES = ['scrap', 'boneMeal', 'ichor'];
const LABEL = { scrap: '조각', boneMeal: '골분', ichor: '진액' };
const zero = () => ({ scrap: 0, boneMeal: 0, ichor: 0 });
const add = (a, b, k = 1) => { for (const r of RES) a[r] = (a[r] ?? 0) + (b[r] ?? 0) * k; return a; };
const fmt = (o) => RES.map((r) => `${LABEL[r]} ${String(Math.round(o[r])).padStart(4)}`).join(' · ');

/** 한 단계(3층)의 방 구성 — 실제 생성기로 센다 */
function rooms(runs = 300) {
  let bones = 0, battle = 0, workshop = 0;
  const got = zero();
  for (let seed = 1; seed <= runs; seed++) {
    for (let floor = 1; floor <= 3; floor++) {
      const fd = generateFloor(seed * 131 + floor, floor);
      for (const room of fd.rooms) {
        if (room.type === 'bones') {
          bones++;
          const r = makeRng(seed + room.x * 31 + room.y * 17);
          got.scrap += r.int(6, 14) + floor * 3;
          if (r.chance(35)) got.boneMeal += r.int(1, 3);
        } else if (room.type === 'battle') battle++;
        else if (room.type === 'workshop') workshop++;
      }
    }
  }
  for (const r of RES) got[r] /= runs;
  return { bones: bones / runs, battle: battle / runs, workshop: workshop / runs, got };
}

const R = rooms();
console.log('재화 수지 — 한 단계(3층)를 돌 때 (300판 평균)\n');
console.log(`방 구성   유해 더미 ${R.bones.toFixed(1)}칸 · 전투 ${R.battle.toFixed(1)}칸 · 작업대 ${R.workshop.toFixed(1)}칸\n`);

console.log('■ 들어오는 것');
console.log(`   유해 더미     ${fmt(R.got)}`);
// 해체대는 시간이 한정돼 있다 — 한 단계를 도는 30~40분 동안 갈 수 있는 만큼만 들어온다
const RUN_MIN = 35;
for (const lv of [1, 2]) {
  const slots = dissectionSlots({ dissection: { level: lv } });
  const n = Math.floor((RUN_MIN / (DISSECT.common.ms / 60000)) * slots);
  const d = zero();
  add(d, { scrap: (DISSECT.common.scrap[0] + DISSECT.common.scrap[1]) / 2 }, n);
  console.log(`   해체대 ${slots}칸    ${fmt(d)}   (한 판 ${RUN_MIN}분에 흔한 부속 ${n}개까지)`);
}
const vat = { rotVat: { level: 1, input: 10, stored: 0 } };
console.log(`   부패조 Lv1    ${fmt(add(zero(), { ichor: Math.floor(10 * 1 * (RUN_MIN / 60) * 0.25) }))}   (넣어 둔 재료 10 기준)`);

console.log('\n■ 나가는 것 — 한 단계를 돌고 나면');
const fixed = {};
fixed['방어도 재건'] = add(zero(), OVERHAUL.shield.cost);
fixed['부속 수복'] = add(zero(), OVERHAUL.wear.cost);
fixed['핵 안정화'] = add(zero(), OVERHAUL.core.cost);
const total = zero();
for (const [k, v] of Object.entries(fixed)) { console.log(`   ${k.padEnd(9)} ${fmt(v)}`); add(total, v); }
console.log(`   ${'정비 합계'.padEnd(9)} ${fmt(total)}`);
console.log(`   ${'정착 1개'.padEnd(9)} ${fmt(add(zero(), RECIPES.attune.cost))}   (주워 온 날것은 이걸 거쳐야 쓴다)`);

console.log('\n■ 수지');
for (const lv of [1, 2]) {
  const slots = dissectionSlots({ dissection: { level: lv } });
  const n = Math.floor((RUN_MIN / (DISSECT.common.ms / 60000)) * slots);
  const inc = zero();
  add(inc, R.got);
  add(inc, { scrap: (DISSECT.common.scrap[0] + DISSECT.common.scrap[1]) / 2 }, n);
  add(inc, { ichor: Math.floor(10 * (RUN_MIN / 60) * 0.25) });
  const net = zero();
  for (const r of RES) net[r] = inc[r] - total[r];
  const attunes = Math.floor(Math.max(0, net.scrap) / RECIPES.attune.cost.scrap);
  console.log(`   해체대 ${slots}칸 — 들어옴 ${fmt(inc)}`);
  console.log(`            정비 뒤 ${RES.map((r) => `${LABEL[r]} ${net[r] >= 0 ? '+' : ''}${Math.round(net[r])}`).join(' · ')}`
    + `  → 정착 ${attunes}개 가능`);
}

console.log('\n■ 진액은 어디로 가나');
for (const [k, r] of Object.entries(RECIPES)) {
  if (!r.cost.ichor) continue;
  console.log(`   ${r.name.padEnd(5)} 진액 ${r.cost.ichor}`);
}
console.log(`   ${OVERHAUL.core.name.padEnd(5)} 진액 ${OVERHAUL.core.cost.ichor}`);
console.log(`   부패조 Lv1이 시간당 2~3을 만든다. 하루 켜 두면 상한 ${vatCap(vat)}이 찬다.`);

console.log('\n■ 골분은 어디서 오나');
console.log(`   유해 더미     35% 확률로 1~3 → 한 단계에 ${R.got.boneMeal.toFixed(1)}`);
console.log(`   해체대        희귀 ${DISSECT.rare.boneMeal} · 유니크 ${DISSECT.unique.boneMeal}`);
console.log(`   자율 탐험     ${[1, 3, 5, 7, 9].map((t) => `${t}단계 ${tripRate(t - 1).boneMeal}/시간`).join(' · ')}`);
console.log(`   상점          은화 ${SUPPLY.find((d) => d.key === 'boneMeal').price} · 12분마다 +1 (칸 12)`);
console.log(`   나가는 곳     방어도 재건 ${OVERHAUL.shield.cost.boneMeal} · 부속 수복 ${OVERHAUL.wear.cost.boneMeal}`
  + ` · 핵 안정화 ${(OVERHAUL.core.cost.boneMeal ?? 0)} · 수복 ${RECIPES.mend.cost.boneMeal} · 정제 ${RECIPES.refine.cost.boneMeal}`);
