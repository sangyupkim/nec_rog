#!/usr/bin/env node
/**
 * 층 완주 시뮬레이터 — **실제 전투 엔진을 그대로 돌린다.**
 *
 * 왜 이걸 만들었나: 해석적 근사(평균 피해 × 예상 턴수)가 두 번 연속 틀렸다.
 * 한 번은 방어도 회복을 실제보다 후하게 잡았고, 한 번은 전투 길이를 짧게 잡았다.
 * 근사가 통과시킨 수치로 1-1이 아무도 깰 수 없는 상태였다.
 *
 * 그래서 근사를 버리고 src/combat.js를 그대로 불러 돌린다.
 * 느리지만(단계당 수십 판) 거짓말은 하지 않는다.
 *
 *   npm run simulate           # 9단계 전부
 *   npm run simulate 1-1       # 한 단계만
 */
import { readFileSync } from 'node:fs';
import { DB, makeRng, makePart, assembleGolem, rollMonster, rollElite, rollBoss,
         shieldMax, shieldNow, elemMul } from '../src/core.js';
import { Combat } from '../src/combat.js';

/* core.js의 loadData()는 브라우저 fetch를 쓴다. 노드에서는 같은 모양으로 직접 채운다. */
const L = (n) => JSON.parse(readFileSync(new URL(`../data/${n}.json`, import.meta.url), 'utf8'));
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
DB.stageOrder = DB.campaign.parts.flatMap((p) => p.stages.map((s) => s.id));

const BUILDS = JSON.parse(readFileSync(new URL('./_builds.json', import.meta.url), 'utf8'));

/* ── 층 구성 (실제 생성기 평균) ───────────────────── */
const BATTLES = 4;          // 전투방 (실제 생성기 평균 3.9)
const ELITE = 1;            // 엘리트방 — 층마다 하나
const REST = 0.5;           // 안치실 — 여기서도 조각을 써서 방어도를 되돌린다
const BONES = 1.6;          // 유해 더미
const SCRAP_MUL = Number(process.env.SCRAP_MUL ?? 1);
const WORKSHOP = 1;         // 작업대
const PER_SCRAP = 35;       // 조각 1당 방어도 (src/main.js와 같아야 한다)
const START_SCRAP = 12;

const SLOT_ORDER = { head: ['head'], body: ['body'], arm: ['armL', 'armR'], leg: ['legL', 'legR'] };

/* 튜닝 손잡이 — 데이터를 고치기 전에 얼마가 맞는지 여기서 훑는다.
   BOSS_ATK=0.8 npm run simulate  처럼 쓴다. */
const BOSS_ATK = Number(process.env.BOSS_ATK ?? 1);
const ELITE_ATK = Number(process.env.ELITE_ATK ?? 1);
const scaleAtk = (mon) => {
  const k = mon.tier === 'boss' ? BOSS_ATK : mon.tier === 'elite' ? ELITE_ATK : 1;
  if (k !== 1) mon.stats.atk = Math.round(mon.stats.atk * k);
  return mon;
};

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

/** 참조 빌드로 세이브 하나를 만든다 */
function makeSave(ids, coreId) {
  const inv = ids.map((id) => makePart(id));
  const golem = { core: coreId, head: null, body: null, armL: null, armR: null,
                  legL: null, legR: null, attachments: [], banned: [], retuned: {} };
  const used = new Set();
  for (const p of inv) {
    const kind = DB.partsBy[p.defId].slot;
    const order = SLOT_ORDER[kind] ?? ['body'];
    const slot = order.find((s) => !golem[s] && !used.has(s));
    if (slot) { golem[slot] = p.uid; used.add(slot); }
  }
  return { inventory: inv, golem, consumables: {}, necro: { known: [], equipped: [] },
           seen: {}, unlocks: {}, scrap: START_SCRAP, run: null };
}

/** 한 판. 골렘은 '가장 센 스킬'만 쓴다 — 사람보다 못한 수준이 하한이다 */
function fight(save, mon, rng, coreHp) {
  const cb = new Combat(save, mon, rng);
  if (coreHp != null) cb.golem.hp = Math.min(cb.golem.maxHp, coreHp);
  let t = 0;
  while (!cb.over && t < 100) {
    const sk = cb.golemSkills().filter((s) => s.usable);
    if (!sk.length) break;                      // 부위가 다 무너져 쓸 기술이 없다
    cb.act({ kind: 'skill', id: bestSkill(cb, sk).id });
    t++;
  }
  cb.commitShields();
  return { result: cb.result, turns: t, coreHp: cb.golem.hp,
           shield: Object.values(cb.frames).reduce((n, f) => n + f.hp, 0) };
}

const shieldTotal = (save) => assembleGolem(save).shieldTotal;
const shieldNowTotal = (save) => assembleGolem(save).shieldNowTotal;

/** 작업대 — 가진 조각만큼 방어도를 되돌린다 */
function repair(save) {
  let used = 0;
  for (const { slot, part } of assembleGolem(save).worn) {
    const max = shieldMax(part, slot);
    const now = shieldNow(part, slot);
    if (now >= max) continue;
    const need = Math.ceil((max - now) / PER_SCRAP);
    const pay = Math.min(need, save.scrap);
    if (pay <= 0) break;
    part.shield = Math.min(max, now + pay * PER_SCRAP);
    save.scrap -= pay; used += pay;
  }
  return used;
}

/**
 * 한 단계를 통째로 굴린다.
 * profile 'lean'  — 엘리트방을 지나친다 (전투 4 + 층의 주인). 조심스러운 플레이.
 * profile 'full'  — 전부 연다 (전투 4 + 엘리트 + 층의 주인). §6.1대로 대가가 있어야 한다.
 */
function runStage(stageId, build, seed, profile = 'full') {
  const st = DB.stagesBy[stageId];
  const rng = makeRng(seed);
  const save = makeSave(build[0], build[1]);
  let coreHp = null;
  const trace = [];
  for (let floor = 1; floor <= (st.floors ?? 3); floor++) {
    save.scrap += Math.round(BONES * SCRAP_MUL * (10 + floor * 3));
    const line = [];
    // 층에는 전투방 + 엘리트방 + 보스방이 **각각** 있다.
    // 보스방은 마지막 층에서만 그 단계의 보스이고, 그 전 층에서는 '층의 주인'이다.
    for (let i = 0; i < BATTLES; i++) line.push(scaleAtk(rollMonster(stageId, floor, rng)));
    if (profile === 'full') {
      for (let i = 0; i < ELITE; i++) line.push(scaleAtk(rollElite(stageId, floor, rng)));
    }
    line.push(scaleAtk(rollBoss(stageId, floor, rng)));
    // 사람은 수리를 아껴 뒀다가 엘리트·보스 직전에 쓴다. 그게 이 방들의 쓸모다
    const spots = WORKSHOP + (Math.random() < REST ? 1 : 0);
    const repairAt = new Set();
    for (let k = 0; k < spots; k++) repairAt.add(line.length - 1 - k);
    for (let i = 0; i < line.length; i++) {
      if (repairAt.has(i)) repair(save);
      const r = fight(save, line[i], rng, coreHp);
      coreHp = r.coreHp;
      trace.push(`${floor}층 ${line[i].name} ${r.turns}턴 → 방어도 ${r.shield}/${shieldTotal(save)} 핵 ${r.coreHp}`);
      if (r.result !== 'win') return { ok: false, floor, at: i + 1, trace, why: r.result ?? '무승부' };
    }
  }
  return { ok: true, trace, left: shieldNowTotal(save) / shieldTotal(save) };
}

/* ── 실행 ────────────────────────────────────────── */
const only = process.argv[2];
const RUNS = 20;

/* 목표 — 조심스럽게 가면 대체로 넘고(75%+), 전부 뒤지면 자주 실패한다(30%+).
 *
 * '전부'의 바를 낮게 잡은 것은 봐주는 게 아니다. §6.1이 아이작식을 고른 이유가
 * "탐험할수록 비싸진다"이고, 전부 여는 것이 안전하면 그 말이 거짓이 된다.
 * 다만 0%면 그건 선택지가 아니라 함정이므로, 30%를 하한으로 둔다. */
const BAR = { lean: 0.75, full: 0.30 };

let bad = 0;
console.log(`층 완주 시뮬레이션 — 단계마다 ${RUNS}회씩 두 가지로 굴린다`);
console.log(`  알뜰: 전투 ${BATTLES} + 층의 주인 (엘리트방을 지나침) — 목표 ${BAR.lean * 100}% 이상`);
console.log(`  전부: 전투 ${BATTLES} + 엘리트 + 층의 주인 — 목표 ${BAR.full * 100}% 이상`);
console.log('골렘은 상성을 보고 가장 센 기술을 쓴다. 물약·술법은 쓰지 않는다.\n');

for (const [id, build] of Object.entries(BUILDS)) {
  if (only && id !== only) continue;
  const st = DB.stagesBy[id];
  const out = {};
  for (const profile of ['lean', 'full']) {
    let win = 0; const fails = {};
    for (let i = 0; i < RUNS; i++) {
      const r = runStage(id, build, 1000 + i * 7919, profile);
      if (r.ok) win++;
      else {
        const k = `${r.floor}층 ${r.at}번째`;
        fails[k] = (fails[k] ?? 0) + 1;
        if (process.env.TRACE && profile === 'full' && Object.values(fails).reduce((a, x) => a + x, 0) === 1) {
          console.log(r.trace.map((x) => '      ' + x).join('\n'));
        }
      }
    }
    out[profile] = { rate: win / RUNS, win, fails };
  }
  const offLean = out.lean.rate < BAR.lean;
  const offFull = out.full.rate < BAR.full;
  if (offLean || offFull) bad++;
  console.log(`  ${offLean || offFull ? '⚠' : '✓'} ${id} ${(st.name ?? '').padEnd(8)}`
    + ` 알뜰 ${String(out.lean.win).padStart(2)}/${RUNS}${offLean ? '✗' : ''}`
    + ` · 전부 ${String(out.full.win).padStart(2)}/${RUNS}${offFull ? '✗' : ''}`
    + (offLean || offFull
      ? `   ${Object.entries(offLean ? out.lean.fails : out.full.fails)
          .sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${k}×${v}`).join(', ')}`
      : ''));
}
console.log(bad ? `\n목표를 못 맞춘 단계 ${bad}개 — 조정 필요.` : '\n아홉 단계 모두 목표 안에 있다.');
