#!/usr/bin/env node
/**
 * 밸런스 점검기 — 참조 빌드로 각 몬스터를 잡는 데 걸리는 턴수를 계산한다.
 * §6.2의 턴수 목표(일반 4~6, 엘리트 8~12, 보스 15~20)를 벗어나면 경고한다.
 *
 *   node tools/balance.mjs
 */
import { readFileSync } from 'node:fs';
const L = (n) => JSON.parse(readFileSync(new URL(`../data/${n}.json`, import.meta.url), 'utf8'));

const parts  = Object.fromEntries(L('parts').map((p) => [p.id, p]));
const skills = Object.fromEntries(L('skills').map((s) => [s.id, s]));
const monsters = L('monsters');
const EL = L('elements');

const elemMul = (atkEl, defEl) => EL.matrix[atkEl]?.[defEl] ?? EL.default;

/** §3.2 데미지 공식 */
export const damage = (power, atk, def, atkEl, defEl) => {
  if (power === 0) return 0;
  const raw = (power * (25 + atk)) / 50;
  const reduced = raw * (1 - def / (def + 40));
  return Math.max(1, Math.floor(reduced * elemMul(atkEl, defEl)));
};

const assemble = (ids) => {
  const stats = { hp: 0, atk: 0, def: 0, eva: 0, spd: 0, focus: 0 };
  let defElement = null;
  const skillIds = [];
  for (const id of ids) {
    const p = parts[id];
    for (const k of Object.keys(stats)) stats[k] += p.stats[k];
    if (p.def_element) defElement = p.def_element;
    skillIds.push(...p.skills);
  }
  return { stats, defElement, skills: [...new Set(skillIds)] };
};

/** 충전을 고려해 최선의 스킬을 순서대로 쓴다고 가정한 턴수 */
const turnsToKill = (golem, mon) => {
  const opts = golem.skills.map((id) => skills[id]).filter((s) => s.power > 0)
    .map((s) => ({
      id: s.id,
      dmg: damage(s.power, golem.stats.atk, mon.stats.def, s.element, mon.def_element)
           * (s.hits ?? 1) * (s.accuracy / 100),
      charges: s.charges,
    }))
    .sort((a, b) => b.dmg - a.dmg);
  if (!opts.length) return { turns: Infinity, dpt: 0 };

  let hp = mon.hp, turns = 0;
  const left = new Map(opts.map((o) => [o.id, o.charges]));
  while (hp > 0 && turns < 200) {
    const use = opts.find((o) => o.charges === null || left.get(o.id) > 0) ?? opts.at(-1);
    if (use.charges !== null) left.set(use.id, left.get(use.id) - 1);
    hp -= use.dmg; turns++;
  }
  return { turns, dpt: Math.round(mon.hp / turns) };
};

/** 몬스터가 골렘을 잡는 데 걸리는 턴수 (골렘 생존 여유 확인용) */
const survivalTurns = (golem, mon) => {
  const best = Math.max(...mon.skills.map((id) => {
    const s = skills[id];
    return damage(s.power, mon.stats.atk, golem.stats.def, s.element, golem.defElement)
           * (s.hits ?? 1) * (s.accuracy / 100);
  }), 0);
  const avg = mon.skills.reduce((sum, id) => {
    const s = skills[id];
    return sum + damage(s.power, mon.stats.atk, golem.stats.def, s.element, golem.defElement) * (s.hits ?? 1);
  }, 0) / mon.skills.length;
  return { best: Math.round(best), avg: Math.round(avg),
           turns: avg > 0 ? Math.ceil(golem.stats.hp / avg) : Infinity };
};

const TARGET = { normal: [4, 6], elite: [8, 12], boss: [15, 20] };

const BUILDS = {
  '1층 시작': ['part_body_goblin_torso', 'part_arm_goblin_claw', 'part_leg_goblin_hop'],
  '2층 중반': ['part_head_goblin_skull', 'part_body_goblin_torso', 'part_arm_goblin_claw',
               'part_arm_bone_spike', 'part_leg_hound_legs'],
  '3층 후반': ['part_head_fungal_cap', 'part_body_ogre_hide', 'part_arm_rusted_axe',
               'part_arm_bone_spike', 'part_leg_ogre_stump'],
};
/**
 * 각 몬스터가 '처음 등장하는' 층. 목표 턴수는 이 조합에서만 검사한다.
 * 이전 층 몬스터가 나중에 빨리 죽는 것은 성장이 체감되는 정상 동작이다.
 */
const EXPECTED = {
  '1층 시작': ['m_goblin', 'm_bonehound'],
  '2층 중반': ['m_fungal'],
  '3층 후반': ['m_ogre'],
};

let warnings = 0;
for (const [label, ids] of Object.entries(BUILDS)) {
  const g = assemble(ids);
  console.log(`\n[${label}]  HP ${g.stats.hp} · atk ${g.stats.atk} · def ${g.stats.def} · 방어속성 ${g.defElement}`);
  for (const m of monsters) {
    const { turns, dpt } = turnsToKill(g, m);
    const surv = survivalTurns(g, m);
    const expected = EXPECTED[label].includes(m.id);
    const [lo, hi] = TARGET[m.tier];
    const off = expected && (turns < lo || turns > hi);
    if (off) warnings++;
    const mark = !expected ? '  ' : off ? '⚠ ' : '✓ ';
    console.log(`  ${mark}${m.name.padEnd(11)} HP${String(m.hp).padStart(4)}` +
      `  →${String(turns).padStart(3)}턴 (목표 ${lo}~${hi})` +
      `   피격 ${String(surv.avg).padStart(3)}/턴 · ${surv.turns}턴이면 골렘 사망`);
  }
}

console.log('\n✓ = 해당 층에서 만나는 몬스터가 목표 턴수 안에 있음 / ⚠ = 벗어남');
console.log('  표시 없음 = 그 층에서 마주치지 않는 조합 (참고용)');
console.log(warnings ? `\n목표 이탈 ${warnings}건 — 조정 필요.` : '\n모든 예상 조우가 목표 턴수 안에 있음.');
