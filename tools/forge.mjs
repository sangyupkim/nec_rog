#!/usr/bin/env node
/**
 * 단련로가 **정말 그렇게 하는가** (§9.13 · §9.15).
 *
 * 왜 만들었나: 「단련로 기능이 정확하게 뭔지 모르겠다」는 말을 듣고 화면에 설명을 붙였다.
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
    vault: { level: 1, parts: [], lostRecords: [] }, forge: { level: 2, slots: [] },
    laborBay: { level: 1, dispatch: [] }, overhaul: [],
    workshop: { golems: [], seq: 0 },
  },
});

/** 조리법 하나를 걸고 시간을 흘려, **가방에** 떨어진 결과물을 돌려준다 (§9.18) */
function run(recipe, inputs, extra = {}) {
  const s = blank();
  s.ossuary.forge.slots.push({ recipe, inputs, startedAt: 0, durationMs: 1, ...extra });
  O.settle(s, 10 * HOUR);
  return { part: s.inventory.at(-1) ?? null, save: s };
}

const arms = DB.parts.filter((p) => p.slot === 'arm');
const A = arms[0], B = arms[1];

console.log('■ 정착 — 날것이 온전해진다');
{
  const raw = makePart(A.id); raw.raw = true; raw.plus = 3;
  const { part: out, save: s2 } = run('attune', [raw]);
  console.log(`  ${partName(raw)} (날것) → ${out ? partName(out) : '없음'} · raw=${out?.raw} · 강화 ${out?.plus ?? 0}`
    + ` · 창고 ${s2.ossuary.vault.parts.length}개 · 가방 ${s2.inventory.length}개`);
  ok(out && out.raw === false, '날것 표가 떨어진다');
  ok(out && out.defId === raw.defId, '같은 부속 그대로다');
  ok(out && out.plus === 3, '강화 기록은 그대로 따라간다');
  /* 다 된 것은 **가방으로 온다** (§9.18). 전에는 창고로 보내서, 정착을 걸어 놓고
     돌아오면 부속이 가방에 없어 매번 찾아 헤맸다. */
  ok(s2.ossuary.vault.parts.length === 0, '창고를 거치지 않는다');
  ok(s2.inventory.length === 1, '가방으로 들어온다');
}

console.log('\n■ 없앤 조리법이 걸려 있어도 판이 멈추지 않는다');
{
  /* 융합·이식·정제·수복·소생·굳히기는 각자의 집으로 갔다 (§9.15-A).
     그 전에 저장한 판에는 아직 걸려 있을 수 있다 — 터지면 **그 판은 영영 못 연다.** */
  const s = blank();
  const a = makePart(A.id); const b2 = makePart(B.id);
  s.ossuary.forge.slots.push({ recipe: 'fuse', inputs: [a, b2], startedAt: 0, durationMs: 1 });
  s.ossuary.forge.slots.push({ recipe: 'congeal', inputs: [], startedAt: 0, durationMs: 1 });
  let threw = null;
  try { O.settle(s, 10 * HOUR); } catch (e) { threw = e.message; }
  console.log(`  던진 것: ${threw ?? '없음'} · 돌려받은 부속 ${s.inventory.length}개`);
  ok(!threw, '정산이 터지지 않는다');
  ok(s.inventory.length === 2, '재료로 넣었던 부속을 돌려받는다');
  ok(s.ossuary.forge.slots.length === 0, '옛 작업은 칸에서 걷힌다');
}

console.log('\n■ 강화의 확률과 값은 npm run enhance가 잰다');

console.log(bad ? `\nFAIL ${bad}` : '\n단련로는 적힌 대로 한다.');
process.exit(bad ? 1 : 0);
