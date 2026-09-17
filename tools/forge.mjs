#!/usr/bin/env node
/**
 * 접합로가 **정말 그렇게 하는가** (§9.13).
 *
 * 왜 만들었나: 「접합로 기능이 정확하게 뭔지 모르겠다」는 말을 듣고 화면에 설명을 붙였다.
 * 그런데 설명은 **거짓말을 하기 쉽다** — 코드를 고치면 글은 그 자리에 남는다.
 * 그래서 실제 정산(`settle`)을 돌려 조리법마다 나온 것을 재고, 화면에 적은 말과 맞는지 본다.
 * 여기서 잡은 것: 융합·이식·정제가 **대장간 강화와 정제 기록을 말없이 지우고** 있었다.
 *
 *   npm run forge
 */
import { readFileSync } from 'node:fs';
import { DB, makePart, partStats, partName } from '../src/core.js';
import * as O from '../src/ossuary.js';

const L = (n) => JSON.parse(readFileSync(new URL(`../data/${n}.json`, import.meta.url), 'utf8'));
for (const f of ['elements', 'skills', 'parts', 'monsters', 'modifiers', 'necro_skills', 'summons',
                 'items', 'attachments', 'quests', 'cores', 'campaign', 'story', 'naming']) DB[f] = L(f);
for (const k of ['skills', 'parts', 'monsters', 'modifiers', 'necro_skills', 'summons',
                 'items', 'attachments', 'cores']) {
  DB[`${k}By`] = Object.fromEntries(DB[k].map((x) => [x.id, x]));
}
O.bindStats(partStats, (id) => DB.coresBy[id]?.hp ?? 0, (id) => DB.coresBy[id]?.stats ?? {});

let bad = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); if (!c) bad++; };

const HOUR = O.HOUR;
const blank = () => ({
  scrap: 999, ichor: 999, boneMeal: 999, silver: 0, soulAsh: 0, inventory: [], cores: [],
  golem: { id: 'g0', coreHp: null }, town: { smithy: [] },
  ossuary: {
    lastSeenAt: 0, offlineCapMs: 99 * HOUR,
    built: { rotVat: true, dissection: true, vault: true, forge: true, laborBay: false },
    rotVat: { level: 1, input: 0, stored: 0 }, dissection: { level: 1, slots: [] },
    vault: { capacity: 99, parts: [], lostRecords: [] }, forge: { level: 2, slots: [] },
    laborBay: { level: 1, dispatch: [] }, overhaul: [],
    workshop: { golems: [], seq: 0 },
  },
});

/** 조리법 하나를 걸고 시간을 흘려, 표본실에 떨어진 결과물을 돌려준다 */
function run(recipe, inputs, extra = {}) {
  const s = blank();
  s.ossuary.forge.slots.push({ recipe, inputs, startedAt: 0, durationMs: 1, ...extra });
  O.settle(s, 10 * HOUR);
  return s.ossuary.vault.parts.at(-1) ?? null;
}

const arms = DB.parts.filter((p) => p.slot === 'arm');
const A = arms[0], B = arms[1];

console.log('■ 정착 — 날것이 온전해진다');
{
  const raw = makePart(A.id); raw.raw = true;
  const out = run('attune', [raw]);
  console.log(`  ${partName(raw)} (날것) → ${out ? partName(out) : '없음'} · raw=${out?.raw}`);
  ok(out && out.raw === false, '날것 표가 떨어진다');
  ok(out && out.defId === raw.defId, '같은 부속 그대로다');
}

console.log('\n■ 융합 — 둘을 합쳐 하나로');
{
  const a = makePart(A.id); a.upgrade = 2; a.maxIntegrity = a.integrity = 10;
  const b = makePart(B.id); b.refined = 1; b.maxIntegrity = b.integrity = 30;
  const out = run('fuse', [a, b], { skillsA: (DB.partsBy[A.id].skills ?? []).slice(0, 1),
                                    skillsB: (DB.partsBy[B.id].skills ?? []).slice(0, 1) });
  const sa = DB.partsBy[A.id].stats, sb = DB.partsBy[B.id].stats;
  const want = Object.fromEntries(Object.keys(sa).map((k) => [k, Math.round(((sa[k] + sb[k]) / 2) * 1.15)]));
  console.log(`  결과 ${partName(out)} · 자리 ${DB.partsBy[out.defId].slot} · 내구 ${out.maxIntegrity}`
    + ` · 강화 ${out.upgrade ?? 0} · 정제 ${out.refined ?? 0}`);
  ok(out.defId === a.defId, '이름과 자리는 **먼저 고른 쪽**을 따른다');
  ok(JSON.stringify(out.fused.stats) === JSON.stringify(want), '능력치는 둘의 평균 +15%다');
  ok(out.maxIntegrity === 30, '내구도 상한은 높은 쪽을 가져온다');
  ok(out.fused.skills.length === 2, '기술을 양쪽에서 하나씩 물려받는다');
  ok((out.upgrade ?? 0) === 2, '대장간 강화는 더 좋은 쪽이 남는다');
  ok((out.refined ?? 0) === 1, '정제도 더 좋은 쪽이 남는다');
}

console.log('\n■ 이식 — 이상만 갈아 끼운다');
{
  const a = makePart(A.id, DB.modifiers[0].id);
  a.upgrade = 3; a.refined = 2; a.integrity = 4;
  const out = run('graft', [a]);
  console.log(`  ${partName(a)} → ${partName(out)} · 강화 ${out.upgrade ?? 0} · 정제 ${out.refined ?? 0}`
    + ` · 내구 ${out.integrity}/${out.maxIntegrity}`);
  ok(Boolean(out.mod), '이상이 붙어 있다');
  ok(out.upgrade === 3 && out.refined === 2, '강화·정제 기록은 그대로 따라간다');
  ok(out.integrity <= 4, '닳은 내구도까지 되돌려 주지는 않는다');
}

console.log('\n■ 정제 — 상한 +8, 능력치 +10%, 겹쳐 쌓인다');
{
  const a = makePart(A.id); a.upgrade = 1;
  const once = run('refine', [a]);
  const twice = run('refine', [once]);
  console.log(`  상한 ${a.maxIntegrity} → ${once.maxIntegrity} → ${twice.maxIntegrity}`
    + ` · 정제 ${once.refined} → ${twice.refined} · 강화 ${twice.upgrade ?? 0}`);
  ok(once.maxIntegrity === a.maxIntegrity + 8, '상한이 8 오른다');
  ok(once.refined === 1 && twice.refined === 2, '겹쳐 쌓인다');
  ok(twice.upgrade === 1, '강화 기록이 남는다');
}

console.log('\n■ 수복 — 내구도만 채운다');
{
  const a = makePart(A.id); a.integrity = 1; a.upgrade = 2;
  const out = run('mend', [a]);
  console.log(`  내구 ${a.integrity}/${a.maxIntegrity} → ${out.integrity}/${out.maxIntegrity}`);
  ok(out.integrity === out.maxIntegrity, '상한까지 찬다');
  ok(out.maxIntegrity === a.maxIntegrity && out.upgrade === 2, '다른 것은 건드리지 않는다');
}

console.log('\n■ 소생 — 기록으로 다시 만든다');
{
  const s = blank();
  s.ossuary.forge.slots.push({ recipe: 'revive', inputs: [], defId: A.id, startedAt: 0, durationMs: 1 });
  O.settle(s, 10 * HOUR);
  const out = s.ossuary.vault.parts.at(-1);
  console.log(`  기록 ${A.id} → ${out ? partName(out) : '없음'} · 이상 ${out?.mod ?? '없음'}`);
  ok(out && out.defId === A.id, '같은 부속이 돌아온다');
  ok(out && !out.mod, '이상은 붙지 않는다');
}

console.log('\n■ 굳히기 — 부속을 쓰지 않는다');
{
  const s = blank();
  const before = s.boneMeal;
  s.ossuary.forge.slots.push({ recipe: 'congeal', inputs: [], startedAt: 0, durationMs: 1 });
  O.settle(s, 10 * HOUR);
  console.log(`  골분 ${before} → ${s.boneMeal} · 표본실 ${s.ossuary.vault.parts.length}개`);
  ok(s.boneMeal === before + O.RECIPES.congeal.gives.boneMeal, '골분이 늘어난다');
  ok(s.ossuary.vault.parts.length === 0, '부속은 나오지 않는다');
}

console.log(bad ? `\nFAIL ${bad}` : '\n접합로는 적힌 대로 한다.');
process.exit(bad ? 1 : 0);
