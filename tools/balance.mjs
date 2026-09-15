#!/usr/bin/env node
/**
 * 데이터 개요 — 참조 빌드로 각 몬스터의 대략적인 턴수를 **어림잡는다.**
 *
 * ⚠ 이 계산은 낙관적이다. "매 턴 가장 센 기술이 명중하고, 부위는 절대 무너지지
 * 않는다"고 가정하기 때문이다. 실제 전투에서는 빗나가고, 부위가 무너져 기술이
 * 사라지고, 충전이 떨어진다. 이 근사가 18턴이라고 한 보스가 실제로는 33턴이었다.
 *
 * **판정의 권한은 `npm run simulate`에 있다** — 그쪽은 실제 엔진을 돌린다.
 * 여기 나오는 ⚠는 "근사와 다르다"는 뜻일 뿐 틀렸다는 뜻이 아니다.
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

/* 핵 = 체력, 파츠 = 방어도 (§5.7) */
const cores = Object.fromEntries(L('cores').map((c) => [c.id, c]));
const SHIELD_BASE = { head: 160, body: 320, arm: 220, leg: 220 };
const shieldOf = (p) => Math.max(30,
  Math.round(SHIELD_BASE[p.slot] + p.stats.def * 6 + p.stats.hp / 6));

const assemble = (ids, coreId = 'core_scrap') => {
  const stats = { hp: 0, atk: 0, def: 0, eva: 0, spd: 0, focus: 0 };
  let defElement = null;
  const skillIds = [];
  let shield = 0;
  const core = cores[coreId];
  stats.hp = core.hp;
  for (const [k, v] of Object.entries(core.stats)) stats[k] += v;
  for (const id of ids) {
    const p = parts[id];
    for (const k of Object.keys(stats)) if (k !== 'hp') stats[k] += p.stats[k];
    shield += shieldOf(p);
    if (p.def_element) defElement = p.def_element;
    skillIds.push(...p.skills);
  }
  return { stats, defElement, shield, effective: stats.hp + shield, skills: [...new Set(skillIds)] };
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
           turns: avg > 0 ? Math.ceil(golem.effective / avg) : Infinity };
};

const TARGET = { normal: [4, 6], elite: [8, 12], boss: [15, 20] };

/**
 * 단계별 참조 빌드 (§7-A). 캠페인이 9단계가 되면서, 단계가 올라가는데
 * 파츠 풀이 못 따라가면 후반이 그대로 벽이 된다. 그것을 여기서 잡는다.
 * 빌드는 "그 단계까지 정직하게 플레이했다면 들고 있을 법한 것"으로 잡는다.
 */
const BUILDS = {
  '1-1': [['part_head_goblin_skull', 'part_body_goblin_torso', 'part_arm_goblin_claw',
           'part_leg_goblin_hop'], 'core_scrap'],
  // 1-1을 깨면 영혼재·은화·전리품이 들어온다. 무쇠 심장과 쥐 왕의 앞발은 살 만하다
  '1-2': [['part_head_goblin_skull', 'part_body_goblin_torso', 'part_arm_goblin_claw',
           'part_leg_hound_legs', 'part_arm_ratking'], 'core_iron'],
  '1-3': [['part_head_goblin_skull', 'part_body_hound_ribcage', 'part_arm_piston',
           'part_arm_bone_spike', 'part_leg_hound_legs'], 'core_iron'],
  '2-1': [['part_head_ratking', 'part_body_sluice', 'part_arm_ratking',
           'part_arm_piston', 'part_leg_bloatmother'], 'core_iron'],
  '2-2': [['part_head_fungal_cap', 'part_body_sluice', 'part_arm_rusted_axe',
           'part_arm_ratking', 'part_leg_bloatmother'], 'core_iron'],
  '2-3': [['part_head_weaver_hood', 'part_body_ogre_hide', 'part_arm_rusted_axe',
           'part_arm_ashpriest', 'part_leg_ogre_stump'], 'core_soul'],
  '3-1': [['part_head_weaver_prime', 'part_body_pallbearer', 'part_arm_weaver_prime',
           'part_arm_ogre_tomb', 'part_leg_pallbearer'], 'core_soul'],
  '3-2': [['part_head_janu', 'part_body_janu', 'part_arm_weaver_prime',
           'part_arm_prototype', 'part_leg_pallbearer'], 'core_soul'],
  '3-3': [['part_head_janu', 'part_body_labyrinth', 'part_arm_ornel',
           'part_arm_prototype', 'part_leg_labyrinth'], 'core_gravelord'],
};

/** 각 단계에서 '처음 마주치는' 것들. 목표 턴수는 이 조합에서만 검사한다. */
const campaign = L('campaign');
const EXPECTED = {};
const seen = new Set();
for (const part of campaign.parts) {
  for (const st of part.stages) {
    const fresh = [...(st.monsters ?? []), st.elite, st.boss]
      .filter((id) => id && !seen.has(id));
    fresh.forEach((id) => seen.add(id));
    EXPECTED[st.id] = fresh;
  }
}

let warnings = 0;
for (const [label, [ids, coreId]] of Object.entries(BUILDS)) {
  const g = assemble(ids, coreId);
  const stName = campaign.parts.flatMap((p) => p.stages).find((x) => x.id === label);
  console.log(`\n[${label} ${stName ? stName.name : ''}]  핵 ${g.stats.hp} + 방어도 ${g.shield} = 유효 ${g.effective}`
    + ` · atk ${g.stats.atk} · def ${g.stats.def} · 방어속성 ${g.defElement}`);
  const stage = campaign.parts.flatMap((p) => p.stages).find((x) => x.id === label);
  const appear = new Set([...(stage?.monsters ?? []), stage?.elite, stage?.boss].filter(Boolean));
  for (const m of monsters) {
    if (!appear.has(m.id)) continue;
    const { turns, dpt } = turnsToKill(g, m);
    const surv = survivalTurns(g, m);
    const expected = EXPECTED[label].includes(m.id);
    const [lo, hi] = TARGET[m.tier];
    const off = expected && (turns < lo || turns > hi);
    const mark = !expected ? '  ' : off ? '~ ' : '✓ ';
    console.log(`  ${mark}${m.name.padEnd(11)} HP${String(m.hp).padStart(4)}` +
      `  →${String(turns).padStart(3)}턴 (목표 ${lo}~${hi})` +
      `   피격 ${String(surv.avg).padStart(3)}/턴 · ${surv.turns}턴이면 골렘 사망`);
  }
}

/* ── 층 완주 검사 ────────────────────────────────────────────
 * 전투 1회를 버티는 것과 한 층을 버티는 것은 전혀 다른 문제다.
 *
 * 앞선 판은 "회복 예산 125%"를 가정했는데, **방어도에는 그런 것이 없다.**
 * 방어도는 포션으로 돌아오지 않고 작업대·정비대에서 재료를 써야만 돌아온다 (§5.7).
 * 그 가정 때문에 전투당 12% 라는 숫자가 통과됐고, 실제로는 1층에서 3~4전투 만에
 * 모든 부위의 방어가 무너져 아무도 1-1을 깰 수 없었다.
 *
 * 그래서 이제 층을 실제로 굴려 본다 — 전투마다 방어도를 깎고,
 * 작업대 한 곳에서 가진 조각만큼만 되돌린다.
 */
const BATTLES_PER_FLOOR = 4;     // 실제 생성기 평균 (전투방 4 + 엘리트 1)
const SCRAP_PER_SHIELD = 35;     // 조각 1당 방어도 35 (§5.7 작업대 — src/main.js의 PER_SCRAP과 같아야 한다)
const WORKSHOPS_PER_FLOOR = 1;   // 생성기가 층마다 하나 놓는다
const BONES_SCRAP = 8;           // 유해 더미 한 곳당 조각 (실제 int(4,9)+층×2, 평균 1.6곳)

/** 이 몬스터 한 판에서 골렘이 받는 총 피해 */
function fightDrain(g, m) {
  const { turns } = turnsToKill(g, m);
  const surv = survivalTurns(g, m);
  return surv.avg * Math.max(1, turns - 1);
}

console.log('\n── 층 완주 검사 ──────────────────────────');
console.log(`층마다 전투 ${BATTLES_PER_FLOOR}회 + 엘리트 1회 · 작업대 ${WORKSHOPS_PER_FLOOR}곳`
  + ` (조각 1당 방어도 ${SCRAP_PER_SHIELD})`);
console.log('방어도는 포션으로 돌아오지 않는다. 층을 못 버티면 목표 턴수가 맞아도 소용없다.\n');

for (const [label, [ids, coreId]] of Object.entries(BUILDS)) {
  const g = assemble(ids, coreId);
  const stage = campaign.parts.flatMap((x) => x.stages).find((x) => x.id === label);
  if (!stage) continue;
  const pool = (stage.monsters ?? []).map((id) => monsters.find((x) => x.id === id)).filter(Boolean);
  const eliteDef = monsters.find((x) => x.id === stage.elite);
  const bossDef = monsters.find((x) => x.id === stage.boss);
  if (!pool.length || !bossDef) continue;

  // 평균적인 일반 전투 한 판
  const avgNormal = pool.reduce((n, m) => n + fightDrain(g, m), 0) / pool.length;
  // 엘리트는 승격 보정을 반영한다 (§ rollElite)
  const elite = eliteDef.tier === 'elite' ? eliteDef
    : { ...eliteDef, hp: Math.round(eliteDef.hp * 2.2),
        stats: { ...eliteDef.stats, atk: Math.round(eliteDef.stats.atk * 1.2) } };
  const eliteDrain = fightDrain(g, elite);
  const bossDrain = fightDrain(g, bossDef);

  let shield = g.shield;
  let scrap = 12;              // 시작 조각. 층마다 유해 더미로 조금 더 는다
  let died = null;
  for (let floor = 1; floor <= (stage.floors ?? 3) && !died; floor++) {
    scrap += Math.round(1.6 * BONES_SCRAP);
    const fights = [];
    for (let i = 0; i < BATTLES_PER_FLOOR; i++) fights.push(['일반', avgNormal]);
    fights.push(floor === (stage.floors ?? 3) ? ['보스', bossDrain] : ['엘리트', eliteDrain]);
    // 작업대는 층 중간에 만난다고 본다
    const repairAt = Math.floor(fights.length / 2);
    fights.forEach(([kind, dmg], i) => {
      if (died) return;
      if (i === repairAt) {
        const need = Math.ceil((g.shield - shield) / SCRAP_PER_SHIELD);
        const pay = Math.min(need, scrap);
        shield = Math.min(g.shield, shield + pay * SCRAP_PER_SHIELD);
        scrap -= pay;
      }
      shield -= dmg;
      if (shield <= 0) died = `${floor}층 ${i + 1}번째 전투(${kind})`;
    });
  }
  const mark = died ? '⚠ ' : '✓ ';
  if (died) warnings++;
  console.log(`  ${mark}${label} ${(stage.name ?? '').padEnd(8)} 방어도 ${g.shield}`
    + ` · 일반 ${Math.round(avgNormal)}/판 · 엘리트 ${Math.round(eliteDrain)} · 보스 ${Math.round(bossDrain)}`
    + (died ? `  → ${died}에서 무너짐` : '  → 완주 가능'));
}

console.log('\n✓ = 근사 턴수가 목표 안 / ~ = 근사와 다름 (근사가 낙관적이라 흔하다)');
console.log('  표시 없음 = 그 단계에서 마주치지 않는 조합 (참고용)');
console.log('  실제 판정은 npm run simulate — 이 표는 눈으로 훑는 용도다.');
console.log(warnings ? `\n층 완주 어림셈에서 ${warnings}건 걸림 — simulate로 확인할 것.` : '');
