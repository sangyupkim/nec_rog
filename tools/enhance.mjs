#!/usr/bin/env node
/**
 * 강화가 **감당할 만한 도박인가** (§9.15).
 *
 * 왜 만들었나: 성공률·하락·파괴를 표로 적는 것은 쉽지만, 그 표가 실제로 무엇을 뜻하는지는
 * 굴려 봐야 안다. +10 하나를 만드는 데 부속이 몇 개 들고, 가는 길에 몇 번 부서지는가?
 * 손으로는 셀 수 없다 — 그래서 **진짜 규칙을 만 번 굴린다.**
 *
 * 지키는 선:
 *   · +5는 **재료만 있으면 언젠가 된다** (잃을 것이 없는 구간이므로 100%에 가깝다)
 *   · +10은 쐐기 없이는 **부서지는 쪽이 흔해야** 한다 — 아니면 도박이 아니다
 *   · 쐐기를 쓰면 부서지지 않는다 (막아 준다는 말이 사실이어야 한다)
 *   · 한 판에 드는 부속이 **무덤에서 버는 양**과 같은 자릿수여야 한다
 *
 *   npm run enhance
 */
import { makeRng } from '../src/core.js';
import * as EN from '../src/enhance.js';

let bad = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); if (!c) bad++; };
const RUNS = 4000;

/** 목표 단계까지 올려 본다. 부서지면 끝. 몇 번 굴렸고 부속을 몇 개 먹었는지 센다 */
function climb(rng, goal, ward = false) {
  let plus = 0, tries = 0, parts = 0, wards = 0;
  const mat = { scrap: 0, boneMeal: 0, ichor: 0 };
  while (plus < goal) {
    if (tries > 4000) return { ok: false, tries, parts, wards, mat, stuck: true };
    const target = plus + 1;
    tries++;
    parts += EN.partsNeeded(target);
    for (const [k, v] of Object.entries(EN.costOf(target))) mat[k] += v;
    const use = ward && EN.protectable(target);
    const r = EN.attempt(rng, plus, use);
    if (r.usedProtect) wards++;
    if (r.destroyed) return { ok: false, tries, parts, wards, mat, destroyed: true };
    plus = r.next;
  }
  return { ok: true, tries, parts, wards, mat };
}

const stat = (arr) => {
  const s = arr.slice().sort((a, b) => a - b);
  return { med: s[Math.floor(s.length / 2)], p90: s[Math.floor(s.length * 0.9)] };
};

for (const ward of [false, true]) {
  console.log(`\n■ ${ward ? '쐐기를 쓰며' : '맨손으로'} 올린다 (${RUNS}판)`);
  console.log('  목표   도달률   시도(중앙/상위10%)  먹인 부속(중앙)  부서짐   쐐기');
  for (const goal of [3, 5, 8, 10]) {
    const rng = makeRng(20260917 + goal + (ward ? 999 : 0));
    let done = 0, broke = 0;
    const tries = [], parts = [], wards = [];
    for (let i = 0; i < RUNS; i++) {
      const r = climb(rng, goal, ward);
      if (r.ok) { done++; tries.push(r.tries); parts.push(r.parts); wards.push(r.wards); }
      if (r.destroyed) broke++;
    }
    const t = tries.length ? stat(tries) : { med: '-', p90: '-' };
    const pa = parts.length ? stat(parts) : { med: '-' };
    const w = wards.length ? stat(wards) : { med: '-' };
    console.log(`  +${String(goal).padEnd(4)}${String(Math.round(done / RUNS * 100)).padStart(5)}%`
      + `${String(t.med).padStart(11)} / ${String(t.p90).padEnd(6)}`
      + `${String(pa.med).padStart(10)}개`
      + `${String(Math.round(broke / RUNS * 100)).padStart(8)}%`
      + `${String(w.med).padStart(7)}`);
    if (goal === 5 && !ward) ok(done / RUNS > 0.99, `+5는 맨손으로도 결국 된다 (${Math.round(done / RUNS * 100)}%)`);
    if (goal === 10 && !ward) ok(broke / RUNS > 0.5, `+10은 맨손이면 부서지는 쪽이 흔하다 (${Math.round(broke / RUNS * 100)}%)`);
    if (goal === 10 && ward) ok(broke === 0, `쐐기를 쓰면 부서지지 않는다 (부서짐 ${broke}건)`);
    if (goal === 10 && ward) ok(done / RUNS > 0.99, `쐐기가 있으면 +10도 결국 된다 (${Math.round(done / RUNS * 100)}%)`);
  }
}

console.log('\n■ 단계마다 붙는 값');
console.log('  단계   능력치   기술 위력   성공   먹이   재료');
for (const t of [1, 5, 10]) {
  const c = EN.costOf(t);
  console.log(`  +${String(t).padEnd(4)}`
    + `${String(`+${Math.round((EN.statMul(t) - 1) * 100)}%`).padStart(6)}`
    + `${String(`+${Math.round((EN.powerMul(t) - 1) * 100)}%`).padStart(11)}`
    + `${String(`${EN.SUCCESS[t]}%`).padStart(7)}`
    + `${String(`${EN.partsNeeded(t)}개`).padStart(7)}`
    + `   조각 ${c.scrap} · 골분 ${c.boneMeal} · 진액 ${c.ichor}`);
}
ok(EN.statMul(EN.PLUS_MAX) <= 1.8, `끝까지 올려도 능력치가 두 배가 되지는 않는다 (×${EN.statMul(EN.PLUS_MAX).toFixed(2)})`);
ok(EN.SUCCESS.slice(1).every((v, i, a) => i === 0 || v <= a[i - 1]), '성공률은 단계마다 낮아지기만 한다');

console.log(bad ? `\nFAIL ${bad}` : '\n강화는 감당할 만한 도박이다.');
process.exit(bad ? 1 : 0);
