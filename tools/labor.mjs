#!/usr/bin/env node
/**
 * 사역의 대가 — **일을 시키면 핵이 얼마나 버티는가** (§9.12).
 *
 * 왜 만들었나: 작업반과 자율 탐험이 공짜 수익이었다. 핵을 갉게 했는데,
 * 「시간당 몇」은 눈으로 정할 수 없는 숫자다. 너무 빠르면 붙이자마자 멈추고,
 * 너무 느리면 있으나 마나 한 대가가 된다. 그래서 **실제 정산 함수를 돌려** 잰다.
 *
 * 목표:
 *  - 작업반: 한 번 붙여 **반나절(12시간) 이상**은 돌아야 붙일 맛이 난다.
 *    그러나 **사흘(72시간)을 넘기면** 사실상 영구 기관이라 대가가 아니다.
 *  - 자율 탐험: **네다섯 번**은 보낼 수 있어야 한다(한 번에 4시간 기준).
 *  - 되살리는 값(핵 안정화 진액 12)이 **부패조가 버는 것**을 넘지 않아야 한다.
 *
 *   npm run labor
 */
import { readFileSync } from 'node:fs';
import { DB } from '../src/core.js';
import * as O from '../src/ossuary.js';

const L = (n) => JSON.parse(readFileSync(new URL(`../data/${n}.json`, import.meta.url), 'utf8'));
for (const f of ['elements', 'skills', 'parts', 'monsters', 'modifiers', 'necro_skills', 'summons',
                 'items', 'attachments', 'quests', 'cores', 'campaign', 'story', 'naming']) DB[f] = L(f);
for (const k of ['skills', 'parts', 'monsters', 'modifiers', 'necro_skills', 'summons',
                 'items', 'attachments', 'cores']) {
  DB[`${k}By`] = Object.fromEntries(DB[k].map((x) => [x.id, x]));
}
O.bindStats(() => ({ atk: 0, def: 0, spd: 0, focus: 0, hp: 0 }),
  (id) => DB.coresBy[id]?.hp ?? 0, (id) => DB.coresBy[id]?.stats ?? {});

const HOUR = O.HOUR;
let bad = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); if (!c) bad++; };

/** 핵이 1에 닿기까지 걸리는 시간 */
const hoursToHalt = (coreHp, perHour) => (coreHp - 1) / perHour;

console.log('■ 작업반 — 한 번 붙여 얼마나 도는가');
console.log('  핵                체력   멈추기까지   되살리는 값');
const cores = DB.cores.slice().sort((a, b) => a.hp - b.hp);
let crewMin = Infinity; let crewMax = 0;
for (const c of cores) {
  const h = hoursToHalt(c.hp, O.CREW_HP_PER_HOUR);
  crewMin = Math.min(crewMin, h); crewMax = Math.max(crewMax, h);
  const ms = O.overhaulMs('core', c.hp - 1);
  console.log(`  ${c.name.padEnd(16)}${String(c.hp).padStart(4)}   `
    + `${h.toFixed(1).padStart(6)}시간   진액 ${O.OVERHAUL.core.cost.ichor} · ${(ms / HOUR).toFixed(1)}시간`);
}
ok(crewMin >= 12, `가장 약한 핵도 반나절은 돈다 (${crewMin.toFixed(1)}시간)`);
ok(crewMax <= 72, `가장 센 핵도 사흘을 넘기지 않는다 (${crewMax.toFixed(1)}시간)`);

console.log('\n■ 자율 탐험 — 몇 번이나 보낼 수 있는가 (한 번 4시간)');
const TRIP_H = 4;
let tripMin = Infinity;
for (const c of cores) {
  const trips = Math.floor((c.hp - 1) / (O.TRIP_HP_PER_HOUR * TRIP_H));
  tripMin = Math.min(tripMin, trips);
  console.log(`  ${c.name.padEnd(16)}${String(c.hp).padStart(4)}   ${String(trips).padStart(3)}번`);
}
ok(tripMin >= 3, `가장 약한 핵으로도 세 번은 보낸다 (${tripMin}번)`);
ok(O.TRIP_HP_PER_HOUR > O.CREW_HP_PER_HOUR,
  `무덤으로 가는 쪽이 더 닳는다 (탐험 ${O.TRIP_HP_PER_HOUR} > 작업반 ${O.CREW_HP_PER_HOUR})`);

console.log('\n■ 실제 정산으로 확인 — 붙여 두고 시간을 흘린다');
const core = cores[Math.floor(cores.length / 2)];
const mkSave = () => ({
  scrap: 0, ichor: 0, boneMeal: 0, silver: 0, soulAsh: 0, inventory: [], cores: [],
  golem: { id: 'g0', coreHp: null }, town: { smithy: [] },
  ossuary: {
    lastSeenAt: 0, offlineCapMs: 999 * HOUR,
    built: { rotVat: true, dissection: true, vault: true, forge: true, laborBay: true },
    rotVat: { level: 1, stored: 0, lastAt: 0 }, dissection: { level: 1, slots: [] },
    vault: { parts: [] }, forge: { level: 1, slots: [] },
    laborBay: { level: 1, dispatch: [] }, overhaul: [],
    workshop: { golems: [{ id: 'w1', name: '일꾼', core: core.id, coreHp: null, parts: [], slots: {}, assigned: 'crew' }] },
  },
});
const s = mkSave();
const g = s.ossuary.workshop.golems[0];
let t = 0; let halted = null;
for (let i = 1; i <= 96 && !halted; i++) {
  t = i * HOUR;
  O.settle(s, t);
  if (O.coreSpent(g)) halted = i;
}
console.log(`  ${core.name} (체력 ${core.hp}) — ${halted}시간째에 멈췄다 · 배치: ${g.assigned ?? '물러남'}`);
ok(halted !== null, '언젠가는 반드시 멈춘다');
ok(g.assigned === null, '멈춘 골렘은 스스로 작업반에서 물러난다');
ok(O.crewSpeed(s).cut === 0, '멈춘 골렘은 능률을 내지 않는다');
const expect = Math.ceil(hoursToHalt(core.hp, O.CREW_HP_PER_HOUR));
ok(Math.abs(halted - expect) <= 1, `계산과 실제가 맞는다 (계산 ${expect}시간 · 실제 ${halted}시간)`);

console.log('\n■ 되살리면 다시 일한다');
g.coreHp = null;
g.assigned = 'crew';
ok(!O.coreSpent(g), '핵 안정화 뒤에는 다시 쓸 수 있다');
ok(O.crewSpeed(s).count === 1, '다시 능률을 낸다');

console.log('\n■ 자율 탐험 — 시간과 골렘이 확률을 어떻게 움직이는가 (§9.16)');
/* 수확만 골렘을 타고 확률은 고정이면, 「좋은 골렘을 보낸다」가 재료 몇 개 더 받는 일로 끝난다.
   줍는 확률과 닳는 확률이 함께 움직여야 고르는 값이 생긴다. */
const STATS = {
  약한골렘: { atk: 4, def: 3, spd: 3, focus: 2 },
  보통골렘: { atk: 10, def: 9, spd: 6, focus: 6 },
  센골렘:   { atk: 20, def: 18, spd: 12, focus: 12 },
};
console.log('  골렘        1시간(줍기/닳기)  5시간         10시간        수확배율');
for (const [name, sv] of Object.entries(STATS)) {
  const cell = (h) => `${String(O.tripPartLuck(2, h, sv)).padStart(2)}%/${String(O.tripWearChance(h, sv)).padStart(2)}%`;
  console.log(`  ${name.padEnd(10)}${cell(1).padStart(12)}${cell(5).padStart(14)}${cell(10).padStart(14)}`
    + `${`×${O.tripBonus(sv).toFixed(2)}`.padStart(11)}`);
}
{
  const w = STATS.약한골렘, st2 = STATS.센골렘;
  ok(O.tripPartLuck(2, 5, st2) > O.tripPartLuck(2, 5, w), '센 골렘이 더 잘 줍는다');
  ok(O.tripWearChance(5, st2) < O.tripWearChance(5, w), '센 골렘이 덜 닳는다');
  ok(O.tripPartLuck(2, 10, w) > O.tripPartLuck(2, 1, w), '오래 두면 더 잘 줍는다');
  ok(O.tripWearChance(10, w) > O.tripWearChance(1, w), '오래 두면 더 닳는다');
  // 1시간짜리가 아무 위험 없는 공짜 수입이 되면 안 된다 — 열 번 보내면 한 번은 닳아야 한다
  ok(O.tripWearChance(1, st2) >= 5, `가장 안전한 보내기도 위험이 남는다 (${O.tripWearChance(1, st2)}%)`);
  ok(O.tripWearChance(10, w) <= 85, `가장 위험한 보내기도 확정은 아니다 (${O.tripWearChance(10, w)}%)`);
}

console.log('\n■ 되살리는 값이 버는 것을 넘지 않는가');
/* 부패조가 시간당 만드는 진액 — 조각을 넣어 둔 1레벨 기준.
   한 번 멈출 때마다 진액 12가 드는데, 그 사이에 부패조가 그보다 많이 만들어야
   「멈추면 다시 세우면 된다」가 성립한다. 아니면 대가가 아니라 벽이다. */
const vat = mkSave();
vat.ossuary.rotVat.input = 10;                  // 조각 10을 넣어 둔 흔한 상태
vat.ossuary.workshop.golems[0].assigned = null; // 부패조만 본다
O.settle(vat, hoursToHalt(core.hp, O.CREW_HP_PER_HOUR) * HOUR);
const earned = vat.ossuary.rotVat.stored;
const need = O.OVERHAUL.core.cost.ichor;
console.log(`  한 번 도는 동안 부패조가 만든 진액 ${earned} (상한 ${O.vatCap(vat.ossuary)}) vs 되살리는 값 ${need}`);
ok(earned >= need, `버는 것이 되살리는 값보다 많다 (${earned} ≥ ${need})`);

console.log(bad ? `\nFAIL ${bad}` : '\n사역의 대가가 목표 안에 있다.');
process.exit(bad ? 1 : 0);
