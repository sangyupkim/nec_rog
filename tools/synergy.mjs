#!/usr/bin/env node
/**
 * 겹침·공명·막기를 **실제 전투 엔진으로 센다** (§5.12 · §5.13 · §5.14).
 *
 * 왜 도구인가: 이 셋은 전부 확률과 배율이라 코드를 읽어서는 맞는지 알 수 없다.
 * "같은 기술을 두 개 달면 세진다"가 정말 세지는지는 **때려 보고 평균을 내야** 안다.
 *
 *   npm run synergy
 */
import { readFileSync } from 'node:fs';
import { DB, makeRng, makePart, rollMonster, partSkills, partElement, assembleGolem } from '../src/core.js';
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

const [, coreId] = JSON.parse(readFileSync(new URL('./_builds.json', import.meta.url), 'utf8'))['1-1'];
const SLOT_ORDER = { head: ['head'], body: ['body'], arm: ['armL', 'armR'], leg: ['legL', 'legR'] };

/** 원하는 부속 목록으로 골렘 하나를 세운다 */
function build(defIds) {
  const inv = defIds.map((id) => makePart(id));
  for (const p of inv) p.raw = false;                 // 날것 불발이 평균을 흔든다
  const golem = { core: coreId, head: null, body: null, armL: null, armR: null,
                  legL: null, legR: null, attachments: [], banned: [], retuned: {} };
  const used = new Set();
  for (const p of inv) {
    const order = SLOT_ORDER[DB.partsBy[p.defId].slot] ?? ['body'];
    const slot = order.find((s) => !golem[s] && !used.has(s));
    if (slot) { golem[slot] = p.uid; used.add(slot); }
  }
  return { inventory: inv, golem, consumables: {}, necro: { known: [], equipped: [] },
           seen: {}, unlocks: {}, scrap: 99, run: null };
}

/** 이 골렘이 기술 하나로 넣는 한 대의 평균 피해 */
/* `tweak`으로 전투 시작 직후의 상태를 손댈 수 있다. **같은 골렘·같은 난수**에서
   새 규칙만 꺼 보는 것이 이 도구의 핵심이다 — 부속을 하나 더 다는 비교는
   그 부속의 스탯까지 섞여서 규칙의 값을 알려 주지 못한다. */
function avgHit(save, sid, runs = 400, tweak = null) {
  let sum = 0, n = 0;
  for (let seed = 1; seed <= runs; seed++) {
    const rng = makeRng(seed * 7919);
    const mon = rollMonster('1-1', 1, rng);
    mon.stats.hp = mon.maxHp = 1_000_000;
    mon.stats.eva = 0;                                 // 회피는 이 측정의 관심사가 아니다
    const cb = new Combat(save, mon, rng);
    cb.golem.hp = cb.golem.maxHp = 1_000_000;
    if (tweak) tweak(cb);
    cb.act({ kind: 'skill', id: sid });
    for (const l of cb.log) {
      const m = l.text.match(/이\(가\) (\d+)의 피해를 입는다/);
      if (m && l.phase === 'golem') { sum += Number(m[1]); n++; }
    }
  }
  return n ? sum / n : 0;
}

let bad = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); if (!c) bad++; };

console.log('겹침·공명·막기 — 실제 엔진으로 센다\n');

/* ── ① 같은 기술이 겹치면 세진다 (§5.12) ── */
console.log('■ 겹침 — 같은 기술을 두 부속이 함께 낸다');
{
  // 같은 기술을 주는 팔 한 짝 vs 두 짝
  const arms = DB.parts.filter((p) => p.slot === 'arm' && (p.skills ?? []).length === 1);
  const pick = arms.find((a) => DB.skillsBy[a.skills[0]]?.power > 0);
  const sid = pick.skills[0];
  const one = build([pick.id]);
  const two = build([pick.id, pick.id]);
  const g1 = assembleGolem(one), g2 = assembleGolem(two);
  // 같은 두 짝 골렘에서 겹침 규칙만 끄고 켠다 — 스탯은 양쪽이 똑같다
  const off = avgHit(two, sid, 400, (cb) => { cb.g.stacks = { ...cb.g.stacks, [sid]: 1 }; });
  const on = avgHit(two, sid);
  const up = off ? (on / off - 1) * 100 : 0;
  const whole = avgHit(one, sid);
  console.log(`  · ${DB.skillsBy[sid].name} — 한 짝 ${whole.toFixed(1)} → 두 짝 ${on.toFixed(1)} (스탯까지 합친 실제 차이)`);
  console.log(`  · 그중 겹침 규칙의 몫 — 규칙 끄면 ${off.toFixed(1)} → 켜면 ${on.toFixed(1)} (+${up.toFixed(1)}%)`);
  ok(g1.stacks[sid] === 1 && g2.stacks[sid] === 2, `겹친 수를 센다 (${g1.stacks[sid]} → ${g2.stacks[sid]})`);
  ok(up > 6, `겹치면 그 기술이 날카로워진다 (+${up.toFixed(1)}%)`);
  ok(up < 25, `한 장에 +12%를 넘지 않는다 (+${up.toFixed(1)}%)`);
}

/* ── ② 같은 결이 모이면 공명한다 (§5.13) ── */
console.log('\n■ 공명 — 같은 결의 부속을 모은다');
{
  const byEl = {};
  for (const p of DB.parts) {
    const el = partElement({ defId: p.id, mod: null });
    (byEl[el] ??= []).push(p);
  }
  const el = Object.entries(byEl).sort((a, b) => b[1].length - a[1].length)[0][0];
  const pool = byEl[el];
  const atk = pool.find((p) => (p.skills ?? []).some((s) => DB.skillsBy[s]?.power > 0
    && DB.skillsBy[s].element === el));
  if (!atk) { ok(false, `${el} 공격 기술을 가진 부속을 못 찾았다`); }
  else {
    const sid = atk.skills.find((s) => DB.skillsBy[s]?.power > 0 && DB.skillsBy[s].element === el);
    // 결이 하나뿐인 골렘 vs 결이 여럿 모인 골렘 — 겹침이 끼지 않도록 서로 다른 부속으로 채운다
    const others = pool.filter((p) => p.id !== atk.id).slice(0, 3);
    const lone = build([atk.id]);
    const many = build([atk.id, ...others.map((p) => p.id)]);
    const gm = assembleGolem(many);
    console.log(`  · 결 ${el} — 모은 수 ${gm.elements[el]}개`);
    ok((gm.elements[el] ?? 0) >= 2, `${el} 부속이 모였다 (${gm.elements[el]}개)`);
    const off = avgHit(many, sid, 400, (cb) => { cb.g.elements = {}; });
    const on = avgHit(many, sid);
    const up = off ? (on / off - 1) * 100 : 0;
    console.log(`  · ${DB.skillsBy[sid].name} — 공명 끄면 ${off.toFixed(1)} → 켜면 ${on.toFixed(1)} (+${up.toFixed(1)}%)`);
    ok(up > 15, `공명하면 더 세다 (+${up.toFixed(1)}%)`);
    ok(up < 45, `${gm.elements[el]}개를 모아도 +30%를 넘지 않는다`);

    // 대가 — 그 결을 누르는 속성에는 더 아프다
    const { resoDefenseMul } = await import('../src/core.js');
    const counter = DB.elements.elements.find((x) =>
      (DB.elements.matrix[x] ?? {})[el] >= 1.5);
    const same = resoDefenseMul(gm.elements, el, el);
    const vs = counter ? resoDefenseMul(gm.elements, counter, el) : 1;
    console.log(`  · 같은 ${el}로 맞으면 x${same.toFixed(2)} · ${counter}로 맞으면 x${vs.toFixed(2)}`);
    ok(same < 1, `같은 결의 공격은 흘려보낸다 (x${same.toFixed(2)})`);
    ok(counter ? vs > 1 : true, `${counter}에는 더 약해진다 (x${vs.toFixed(2)}) — 몰아 쌓은 값이다`);
  }
}

/* ── ③ 막기 (§5.14) ── */
console.log('\n■ 막기 — 댄 자리로 받는다');
{
  const save = build(DB.parts.filter((p) => p.slot === 'body').slice(0, 1).map((p) => p.id)
    .concat(DB.parts.filter((p) => p.slot === 'arm').slice(0, 2).map((p) => p.id))
    .concat(DB.parts.filter((p) => p.slot === 'leg').slice(0, 2).map((p) => p.id)));
  const rng = makeRng(12345);
  const mon = rollMonster('1-1', 1, rng);
  const cb = new Combat(save, mon, rng);

  const fast = { ...cb };
  cb.golem.stats.spd = mon.stats.spd + 10;
  const hi = cb.guardChance();
  cb.golem.stats.spd = mon.stats.spd - 10;
  const lo = cb.guardChance();
  cb.golem.stats.spd = mon.stats.spd;
  const even = cb.guardChance();
  console.log(`  · 성공 확률 — 느릴 때 ${lo}% / 같을 때 ${even}% / 빠를 때 ${hi}%`);
  ok(lo < even && even < hi, '빠를수록 댄 자리로 잘 받는다');
  ok(lo >= 25 && hi <= 90, `바닥 ${lo}% · 천장 ${hi}% 안에 있다`);

  // 실제로 댄 자리로 가는가 — 판정을 200번 돌려 센다
  cb.golem.stats.spd = mon.stats.spd + 20;      // 거의 언제나 성공하는 조건
  cb.guard = 'leg';
  let onLeg = 0, blocked = 0;
  for (let i = 0; i < 200; i++) {
    const r = cb.resolveGuard();
    if (r.frame && r.frame.slot.startsWith('leg')) onLeg++;
    if (r.blocked) blocked++;
  }
  console.log(`  · 다리를 대고 200번 — 다리로 간 것 ${onLeg}번 · 받아 낸 것 ${blocked}번`);
  ok(blocked > 150, `빠르면 대개 받아 낸다 (${blocked}/200)`);
  ok(onLeg >= blocked, '받아 낸 것은 모두 댄 자리로 갔다');

  cb.guard = null;
  let anyBlocked = 0;
  for (let i = 0; i < 200; i++) if (cb.resolveGuard().blocked) anyBlocked++;
  ok(anyBlocked === 0, '맡기면 받아 내는 일이 없다 — 대가 없이 경감은 없다');
}

console.log(bad ? `\n${bad}군데가 설계와 어긋난다.` : '\n겹침·공명·막기가 적힌 대로 동작한다.');
process.exit(bad ? 1 : 0);
