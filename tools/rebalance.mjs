#!/usr/bin/env node
/**
 * 몬스터 HP 역산기 — 목표 턴수(§6.2)에서 HP를 거꾸로 구한다.
 * 몬스터가 '처음 등장하는 단계'의 참조 빌드로 이분 탐색하며,
 * 손으로 정한 수치를 덮어쓴다. 수치를 바꾸고 싶으면 목표 턴수나 빌드를 바꿔라.
 *
 *   npm run rebalance   # data/monsters.json 의 hp를 고쳐 쓴다
 *   npm run balance     # 결과를 검사만 한다 (고치지 않는다)
 *
 * 참조 빌드는 tools/_builds.json — tools/balance.mjs 의 BUILDS 와 같은 내용이다.
 */
import { readFileSync, writeFileSync } from 'node:fs';
const P = (n) => new URL(`data/${n}.json`, `file://${process.cwd()}/`);
const L = (n) => JSON.parse(readFileSync(P(n), 'utf8'));
const parts = Object.fromEntries(L('parts').map((p) => [p.id, p]));
const skills = Object.fromEntries(L('skills').map((s) => [s.id, s]));
const cores = Object.fromEntries(L('cores').map((c) => [c.id, c]));
const monsters = L('monsters');
const EL = L('elements');
const campaign = L('campaign');

const elemMul = (a, d) => EL.matrix[a]?.[d] ?? EL.default;
const damage = (power, atk, def, ae, de) => {
  if (power === 0) return 0;
  const raw = (power * (25 + atk)) / 50;
  return Math.max(1, Math.floor(raw * (1 - def / (def + 40)) * elemMul(ae, de)));
};
const SHIELD_BASE = { head: 80, body: 160, arm: 110, leg: 110 };
const shieldOf = (p) => Math.max(30, Math.round(SHIELD_BASE[p.slot] + p.stats.def * 6 + p.stats.hp / 6));
const assemble = (ids, coreId) => {
  const stats = { hp: 0, atk: 0, def: 0, eva: 0, spd: 0, focus: 0 };
  let defElement = null; const sk = []; let shield = 0;
  const core = cores[coreId];
  stats.hp = core.hp;
  for (const [k, v] of Object.entries(core.stats)) stats[k] += v;
  for (const id of ids) {
    const p = parts[id];
    for (const k of Object.keys(stats)) if (k !== 'hp') stats[k] += p.stats[k];
    shield += shieldOf(p);
    if (p.def_element) defElement = p.def_element;
    sk.push(...p.skills);
  }
  return { stats, defElement, shield, effective: stats.hp + shield, skills: [...new Set(sk)] };
};
const turnsFor = (g, m, hp) => {
  const opts = g.skills.map((id) => skills[id]).filter((s) => s.power > 0).map((s) => ({
    id: s.id,
    dmg: damage(s.power, g.stats.atk, m.stats.def, s.element, m.def_element) * (s.hits ?? 1) * (s.accuracy / 100),
    charges: s.charges,
  })).sort((a, b) => b.dmg - a.dmg);
  if (!opts.length) return Infinity;
  let left = new Map(opts.map((o) => [o.id, o.charges]));
  let h = hp, t = 0;
  while (h > 0 && t < 500) {
    const use = opts.find((o) => o.charges === null || left.get(o.id) > 0) ?? opts.at(-1);
    if (use.charges !== null) left.set(use.id, left.get(use.id) - 1);
    h -= use.dmg; t++;
  }
  return t;
};
const BUILDS = JSON.parse(readFileSync(new URL('tools/_builds.json', `file://${process.cwd()}/`), 'utf8'));
const TARGET = { normal: [4, 6], elite: [8, 12], boss: [15, 20] };

// 각 몬스터가 처음 등장하는 단계
const firstStage = {};
const seen = new Set();
for (const part of campaign.parts) for (const st of part.stages) {
  for (const id of [...(st.monsters ?? []), st.elite, st.boss].filter(Boolean)) {
    if (!seen.has(id)) { seen.add(id); firstStage[id] = st.id; }
  }
}

let changed = 0;
for (const m of monsters) {
  const sid = firstStage[m.id];
  if (!sid || !BUILDS[sid]) continue;
  const g = assemble(BUILDS[sid][0], BUILDS[sid][1]);
  const [lo, hi] = TARGET[m.tier];
  const want = Math.round((lo + hi) / 2);
  // 이분 탐색으로 목표 턴수에 맞는 HP
  let a = 20, b = 4000, best = m.hp;
  for (let i = 0; i < 40; i++) {
    const mid = Math.round((a + b) / 2);
    const t = turnsFor(g, m, mid);
    if (t < want) a = mid; else { best = mid; b = mid; }
  }
  const hp = Math.round(best / 5) * 5;
  const t = turnsFor(g, m, hp);
  if (t < lo || t > hi) { console.log(`  ! ${m.name} 역산 실패 (${t}턴)`); continue; }
  if (hp !== m.hp) { console.log(`  ${m.name.padEnd(12)} ${String(m.hp).padStart(4)} → ${String(hp).padStart(4)}  (${sid}, ${t}턴)`); m.hp = hp; changed++; }
}
writeFileSync(P('monsters'), JSON.stringify(monsters, null, 2) + '\n');
console.log(`\n${changed}종 조정`);
