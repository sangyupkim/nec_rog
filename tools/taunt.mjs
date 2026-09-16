#!/usr/bin/env node
/**
 * 소환수가 정말 대신 맞는지 — **실제 전투 엔진을 그대로 돌려 센다** (§9-B).
 *
 * 왜 만들었나: "해골이 대신 받아 줘야 하는데 방어도가 닳는다"는 보고를 받았다.
 * 눈으로는 알 수 없고, 로그를 세어 봐야 알 수 있는 종류의 문제다.
 * 세어 보니 가로채는 비율(taunt)은 맞았고, 대신 **소환수가 한 턴 일찍 사라지고 있었다** —
 * 소환수는 골렘보다 먼저 움직이므로, 마지막 턴에 움직이자마자 흩어져
 * 그 턴의 적 공격을 막지 못했다. 「2턴간」이라던 뼈 방패가 한 번만 막아 준 이유다.
 *
 *   npm run taunt
 */
import { readFileSync } from 'node:fs';
import { DB, makeRng, makePart, rollMonster } from '../src/core.js';
import { Combat } from '../src/combat.js';

const L = (n) => JSON.parse(readFileSync(new URL(`../data/${n}.json`, import.meta.url), 'utf8'));
for (const f of ['elements', 'skills', 'parts', 'monsters', 'modifiers', 'necro_skills', 'summons',
                 'items', 'attachments', 'quests', 'cores', 'campaign', 'story', 'naming']) DB[f] = L(f);
for (const k of ['skills', 'parts', 'monsters', 'modifiers', 'necro_skills', 'summons',
                 'items', 'attachments', 'cores']) {
  DB[`${k}By`] = Object.fromEntries(DB[k].map((x) => [x.id, x]));
}
DB.stagesBy = {}; DB.partOfStage = {};
for (const part of DB.campaign.parts) {
  for (const st of part.stages) { DB.stagesBy[st.id] = st; DB.partOfStage[st.id] = part; }
}
DB.stageOrder = DB.campaign.parts.flatMap((p) => p.stages.map((s) => s.id));

const [ids, coreId] = JSON.parse(readFileSync(new URL('./_builds.json', import.meta.url), 'utf8'))['1-1'];
const SLOT_ORDER = { head: ['head'], body: ['body'], arm: ['armL', 'armR'], leg: ['legL', 'legR'] };

function makeSave(necro) {
  const inv = ids.map((id) => makePart(id));
  const golem = { core: coreId, head: null, body: null, armL: null, armR: null,
                  legL: null, legR: null, attachments: [], banned: [], retuned: {} };
  const used = new Set();
  for (const p of inv) {
    const order = SLOT_ORDER[DB.partsBy[p.defId].slot] ?? ['body'];
    const slot = order.find((s) => !golem[s] && !used.has(s));
    if (slot) { golem[slot] = p.uid; used.add(slot); }
  }
  return { inventory: inv, golem, consumables: {}, necro: { known: necro, equipped: necro },
           seen: {}, unlocks: {}, scrap: 99, run: null };
}

/** 소환수가 살아 있는 동안의 피격만 센다. act()마다 로그가 비므로 턴을 넘겨 기억한다 */
function measure(nk, sid, runs = 300) {
  let onSummon = 0, onGolem = 0;
  /* 「N턴간」이 맞는지는 **수명이 다해 흩어진 경우만** 봐야 한다.
     맞아 부서진 것까지 섞으면, 잘 싸우는 소환수일수록 수명이 짧아 보인다. */
  let expired = 0, expiredTurns = 0;
  /* **수명이 다하는 자리**가 맞는지 본다. 소환수는 골렘보다 먼저 움직이므로,
     움직이는 국면(summon)에서 흩어지면 *그 턴의 적 공격을 막지 못한다.*
     반드시 턴이 끝날 때(end) 흩어져야 한다 — 이것이 한 턴을 잃던 버그의 정체다. */
  let earlyExit = 0;
  for (let seed = 1; seed <= runs; seed++) {
    const rng = makeRng(seed * 7919);
    const save = makeSave([nk]);
    const mon = rollMonster('1-1', 1, rng);
    mon.stats.hp = mon.maxHp = 100000;          // 적이 죽지 않게 — 소환 상태를 오래 본다
    const cb = new Combat(save, mon, rng);
    cb.golem.hp = cb.golem.maxHp = 100000;
    let alive = false, cast = false, stood = 0;
    for (let t = 0; t < 16 && !cb.over; t++) {
      // 영력이 모자라면 아직 못 부른다 — 찰 때까지 평범하게 싸운다
      const spell = cb.necroSkills().find((x) => x.id === nk);
      if (!cast && spell?.usable) { cb.act({ kind: 'necro', id: nk }); cast = true; }
      else {
        const sk = cb.golemSkills().filter((s) => s.usable);
        if (!sk.length) break;
        cb.act({ kind: 'skill', id: sk[0].id });
      }
      let counted = false;
      for (const l of cb.log) {
        if (/소환/.test(l.text)) { alive = true; stood = 0; }
        if (alive) {
          if (!counted) { stood++; counted = true; }
          if (/대신 .*피해를 받는다/.test(l.text)) onSummon++;
          else if (/방어도가 .*받아냈다|핵이 .*깎/.test(l.text)) onGolem++;
        }
        if (/먼지가 되어 흩어진다/.test(l.text)) {
          expired++; expiredTurns += stood; alive = false;
          if (l.phase !== 'end') earlyExit++;
        }
        else if (/부서진다/.test(l.text)) alive = false;
      }
    }
  }
  const hits = onSummon + onGolem;
  return { onSummon, onGolem, hits, expired, earlyExit,
           perCast: expired ? +(onSummon / expired).toFixed(1) : 0,
           rate: hits ? Math.round(onSummon / hits * 100) : 0,
           turns: expired ? +(expiredTurns / expired).toFixed(1) : 0 };
}

console.log('소환수 가로채기 — 실제 엔진으로 센다 (300판)\n');
let bad = 0;
const CASES = [
  ['nk_skeleton', 'sm_skeleton'],
  ['nk_crow', 'sm_crow'],
  ['nk_boneshield', 'sm_shield'],
];
for (const [nk, sid] of CASES) {
  const info = DB.summonsBy[sid];
  const r = measure(nk, sid);
  // 확률이라 흔들린다. 15%p까지 봐준다
  const offRate = Math.abs(r.rate - info.taunt);
  const rateOk = offRate <= 15;
  // 「N턴간」이라 적었으면 N턴을 서 있어야 한다 (부서져 일찍 죽는 경우가 있어 하한만 본다)
  // 수명이 다해 흩어진 경우는 적힌 턴 수만큼 정확히 서 있어야 한다
  const turnsOk = r.expired === 0 || Math.abs(r.turns - info.duration) < 0.25;
  const exitOk = r.earlyExit === 0;
  if (!rateOk || !turnsOk || !exitOk) bad++;
  console.log(`  ${rateOk && turnsOk && exitOk ? '✓' : '✗'} ${info.name.padEnd(7)}`
    + ` 가로채기 ${String(r.rate).padStart(3)}% (적힌 값 ${info.taunt}%)`
    + ` · 수명대로 흩어진 ${String(r.expired).padStart(3)}판의 평균 ${String(r.turns).padStart(4)}턴 (적힌 값 ${info.duration})`
    + ` · 표본 ${r.hits}대`
    + (exitOk ? '' : `\n      ↳ ${r.earlyExit}판에서 적이 때리기 전에 흩어졌다 — 그 턴은 막아 주지 못한다`));
}
console.log(bad ? `\n어긋난 소환수 ${bad}종 — 조정 필요.` : '\n소환수가 적힌 대로 동작한다.');
process.exit(bad ? 1 : 0);
