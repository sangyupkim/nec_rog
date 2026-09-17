#!/usr/bin/env node
/**
 * 데이터 무결성 검증기.
 * JSON으로 콘텐츠를 관리할 때의 유일한 실질적 위험은 "오타 난 ID 참조"다.
 * 이 스크립트가 그것을 커밋 전에 잡는다.
 *
 *   node tools/validate.mjs
 */
import { readFileSync } from 'node:fs';

const load = (n) => JSON.parse(readFileSync(new URL(`../data/${n}.json`, import.meta.url), 'utf8'));

const elements  = load('elements');
const skills    = load('skills');
const parts     = load('parts');
const monsters  = load('monsters');
const modifiers = load('modifiers');
const naming    = load('naming');

const errors = [];
const warns  = [];
const err  = (m) => errors.push(m);
const warn = (m) => warns.push(m);

const SLOTS   = ['head', 'body', 'arm', 'leg'];
const STATS   = ['hp', 'atk', 'def', 'eva', 'spd', 'focus'];
const ELEMENTS = new Set(elements.elements);
const STATUSES = new Set(['중독', '화상', '균열', '마비', '공포', '재생', '가시', '봉인']);
const RANK_STATS = new Set(['atk', 'def', 'spd', 'eva']);

// ---- 중복 ID ----
const indexById = (list, label) => {
  const map = new Map();
  for (const it of list) {
    if (!it.id) { err(`[${label}] id가 없는 항목이 있습니다: ${JSON.stringify(it).slice(0, 60)}`); continue; }
    if (map.has(it.id)) err(`[${label}] 중복 id: ${it.id}`);
    map.set(it.id, it);
  }
  return map;
};
const skillMap = indexById(skills, 'skills');
const partMap  = indexById(parts, 'parts');
const monMap   = indexById(monsters, 'monsters');
const modMap   = indexById(modifiers, 'modifiers');

// ---- 속성 상성표 ----
for (const [atk, row] of Object.entries(elements.matrix)) {
  if (!ELEMENTS.has(atk)) err(`[elements] 미정의 공격 속성: ${atk}`);
  for (const [def, mul] of Object.entries(row)) {
    if (!ELEMENTS.has(def)) err(`[elements] 미정의 방어 속성: ${atk} → ${def}`);
    if (typeof mul !== 'number' || mul < 0) err(`[elements] 잘못된 배율: ${atk} → ${def} = ${mul}`);
  }
}

// ---- 스킬 ----
for (const s of skills) {
  if (!ELEMENTS.has(s.element)) err(`[skill ${s.id}] 미정의 속성: ${s.element}`);
  if (typeof s.power !== 'number' || s.power < 0) err(`[skill ${s.id}] power가 올바르지 않습니다`);
  if (s.accuracy < 1 || s.accuracy > 100) err(`[skill ${s.id}] accuracy 범위 초과: ${s.accuracy}`);
  if (s.charges !== null && (!Number.isInteger(s.charges) || s.charges < 1))
    err(`[skill ${s.id}] charges는 null이거나 1 이상의 정수여야 합니다`);
  if (s.charges !== null && s.recharge === 0)
    warn(`[skill ${s.id}] 충전 제한이 있는데 recharge가 0 — 전투당 ${s.charges}회로 고정됩니다`);
  if (s.power === 0 && (s.effects ?? []).length === 0)
    err(`[skill ${s.id}] 위력도 효과도 없는 빈 스킬입니다`);
  if (!/\{user\}|\{target\}/.test(s.text ?? ''))
    warn(`[skill ${s.id}] text에 {user}/{target} 치환자가 없습니다`);

  for (const e of s.effects ?? []) {
    switch (e.op) {
      case 'status':
        if (!STATUSES.has(e.id)) err(`[skill ${s.id}] 미정의 상태이상: ${e.id}`);
        if (e.id === '중독' && e.stacks == null) err(`[skill ${s.id}] 중독은 stacks가 필요합니다`);
        if (e.id !== '중독' && e.duration == null) err(`[skill ${s.id}] ${e.id}는 duration이 필요합니다`);
        break;
      case 'rank':
        if (!RANK_STATS.has(e.stat)) err(`[skill ${s.id}] 랭크 변화 불가 스탯: ${e.stat}`);
        if (!Number.isInteger(e.delta) || e.delta === 0 || Math.abs(e.delta) > 4)
          err(`[skill ${s.id}] rank delta 범위 오류: ${e.delta}`);
        break;
      case 'lifesteal':
        if (!(e.ratio > 0 && e.ratio <= 1)) err(`[skill ${s.id}] lifesteal ratio 오류: ${e.ratio}`);
        if (s.power === 0) err(`[skill ${s.id}] 위력 0인 스킬에 lifesteal은 무의미합니다`);
        break;
      case 'crit_bonus':
      case 'reveal':
        break;
      default:
        err(`[skill ${s.id}] 알 수 없는 effect op: ${e.op}`);
    }
  }
}

// ---- 파츠 ----
for (const p of parts) {
  if (!SLOTS.includes(p.slot)) err(`[part ${p.id}] 잘못된 슬롯: ${p.slot}`);
  if (!(p.integrity >= 1)) err(`[part ${p.id}] integrity는 1 이상이어야 합니다`);
  for (const st of STATS)
    if (typeof p.stats?.[st] !== 'number') err(`[part ${p.id}] 스탯 누락: ${st}`);

  for (const sid of p.skills ?? [])
    if (!skillMap.has(sid)) err(`[part ${p.id}] 존재하지 않는 스킬 참조: ${sid}`);
  for (const mid of p.drop_from ?? [])
    if (!monMap.has(mid)) err(`[part ${p.id}] 존재하지 않는 몬스터 참조: ${mid}`);

  // 몸통만 방어 속성을 가진다 (§5.3)
  if (p.slot === 'body') {
    if (!p.def_element) err(`[part ${p.id}] 몸통 파츠에 def_element가 없습니다`);
    else if (!ELEMENTS.has(p.def_element)) err(`[part ${p.id}] 미정의 방어 속성: ${p.def_element}`);
  } else if (p.def_element) {
    err(`[part ${p.id}] 몸통이 아닌 파츠에 def_element가 있습니다`);
  }

  // 요구 마력은 등급에서 나온다 (§3.7)
  const MANA_BY_RARITY = { common: 2, rare: 3, unique: 5, legendary: 7 };
  if (p.mana !== MANA_BY_RARITY[p.rarity]) {
    err(`[part ${p.id}] 요구 마력이 등급과 어긋납니다: ${p.rarity}면 ${MANA_BY_RARITY[p.rarity]}이어야 하는데 ${p.mana}`);
  }

  // 슬롯별 스킬 개수 상한 (§3.1)
  const cap = { head: 1, body: 2, arm: 2, leg: 2 }[p.slot];
  if ((p.skills ?? []).length > cap)
    err(`[part ${p.id}] ${p.slot} 슬롯 스킬 상한 ${cap} 초과: ${p.skills.length}개`);
  if (p.slot !== 'head' && (p.skills ?? []).length === 0)
    warn(`[part ${p.id}] 스킬이 없는 ${p.slot} 파츠 — 스탯 전용 파츠가 의도된 것인지 확인`);
}

// ---- 몬스터 ----
for (const m of monsters) {
  if (!ELEMENTS.has(m.def_element)) err(`[monster ${m.id}] 미정의 방어 속성: ${m.def_element}`);
  if (!(m.hp > 0)) err(`[monster ${m.id}] hp가 올바르지 않습니다`);
  if (!['normal', 'elite', 'boss'].includes(m.tier)) err(`[monster ${m.id}] 잘못된 tier: ${m.tier}`);

  for (const sid of m.skills ?? [])
    if (!skillMap.has(sid)) err(`[monster ${m.id}] 존재하지 않는 스킬 참조: ${sid}`);
  for (const pid of m.drops ?? [])
    if (!partMap.has(pid)) err(`[monster ${m.id}] 존재하지 않는 파츠 참조: ${pid}`);

  const known = new Set(m.skills ?? []);
  const ai = m.ai ?? {};
  if (ai.type === 'weighted') {
    for (const sid of Object.keys(ai.weights ?? {}))
      if (!known.has(sid)) err(`[monster ${m.id}] AI 가중치가 보유하지 않은 스킬을 참조: ${sid}`);
    for (const sid of known)
      if (!(sid in (ai.weights ?? {}))) warn(`[monster ${m.id}] 스킬 ${sid}에 가중치가 없어 사용되지 않습니다`);
  } else if (ai.type === 'pattern') {
    for (const sid of ai.pattern ?? [])
      if (!known.has(sid)) err(`[monster ${m.id}] AI 패턴이 보유하지 않은 스킬을 참조: ${sid}`);
    if (!(ai.pattern ?? []).length) err(`[monster ${m.id}] pattern AI인데 pattern이 비어 있습니다`);
  } else {
    err(`[monster ${m.id}] 알 수 없는 AI type: ${ai.type}`);
  }
  for (const r of ai.rules ?? [])
    if (r.prefer && !known.has(r.prefer)) err(`[monster ${m.id}] AI 규칙의 prefer가 미보유 스킬: ${r.prefer}`);

  // 드랍이 파츠 쪽 drop_from과 일치하는가 (양방향 검증)
  for (const pid of m.drops ?? []) {
    const p = partMap.get(pid);
    if (p && !(p.drop_from ?? []).includes(m.id))
      err(`[monster ${m.id}] ${pid}를 드랍하지만 해당 파츠의 drop_from에 ${m.id}가 없습니다`);
  }
}

// ---- 모디파이어 ----
for (const md of modifiers) {
  if (!md.prefix) err(`[modifier ${md.id}] prefix가 없습니다`);
  if (md.added_skill && !skillMap.has(md.added_skill))
    err(`[modifier ${md.id}] 존재하지 않는 스킬 참조: ${md.added_skill}`);
  for (const st of Object.keys(md.stat_multiplier ?? {}))
    if (!STATS.includes(st)) err(`[modifier ${md.id}] 알 수 없는 스탯: ${st}`);
  for (const st of Object.keys(md.flat_bonus ?? {}))
    if (!STATS.includes(st)) err(`[modifier ${md.id}] 알 수 없는 스탯: ${st}`);
  if (!(md.weight > 0)) err(`[modifier ${md.id}] weight는 0보다 커야 합니다`);
  if (!md.added_skill && !md.stat_multiplier && !md.flat_bonus)
    err(`[modifier ${md.id}] 아무 효과도 없습니다`);
}

// ---- 고아 데이터 (참조되지 않는 항목) ----
const usedSkills = new Set([
  ...parts.flatMap((p) => p.skills ?? []),
  ...monsters.flatMap((m) => m.skills ?? []),
  ...modifiers.map((m) => m.added_skill).filter(Boolean),
  'sk_struggle', // 충전 전부 소진 시 자동 제공 (§11)
]);
for (const s of skills)
  if (!usedSkills.has(s.id)) warn(`[skill ${s.id}] 어떤 파츠·몬스터·모디파이어도 사용하지 않습니다`);

/* ---- 등급의 사다리 (§3.10) ----
   등급을 하나 더 얹으면 값·마력·해체 산출·상점 진열이 전부 따라와야 한다.
   하나라도 빠뜨리면 「전설인데 상점에 깔린다」 같은 일이 조용히 생긴다. */
{
  const ORDER = ['common', 'rare', 'unique', 'legendary'];
  for (const p of parts) {
    if (!ORDER.includes(p.rarity)) err(`[part ${p.id}] 모르는 등급: ${p.rarity}`);
  }
  const legend = parts.filter((p) => p.rarity === 'legendary');
  if (!legend.length) warn('전설 등급 부속이 하나도 없습니다');
  // 전설은 **보스만** 내놓는다 — 아무 몬스터나 흘리면 등급이 뜻을 잃는다
  const bosses = new Set(load('campaign').parts.flatMap((pt) => pt.stages.map((st) => st.boss)));
  for (const p of legend) {
    const from = monsters.filter((m) => (m.drops ?? []).includes(p.id));
    if (!from.length) { err(`[part ${p.id}] 전설인데 아무도 떨어뜨리지 않습니다`); continue; }
    const notBoss = from.filter((m) => !bosses.has(m.id));
    if (notBoss.length) {
      err(`[part ${p.id}] 전설은 단계 보스만 내놓아야 합니다 — ${notBoss.map((m) => m.name).join(', ')}`);
    }
  }
}

/* ---- 단계마다 의뢰문이 있는가 (§7-A.6) ----
   「어디로 가서 무엇을 잡고 무엇을 가져오라」가 없는 단계는 목표가 아니라 지명일 뿐이다.
   새 단계를 붙일 때 이야기를 빼먹지 않도록 그물을 친다. */
{
  const campaign = load('campaign');
  const story = load('story');
  const monNames = new Set(monsters.map((m) => m.name));
  for (const part of campaign.parts) {
    for (const st of part.stages) {
      const b = st.brief;
      if (!b) { err(`[stage ${st.id}] brief가 없습니다 — 어디서 무엇을 잡아 무엇을 가져오는지 적어야 합니다`); continue; }
      for (const k of ['order', 'hunt', 'where', 'bring', 'why']) {
        if (!b[k]) err(`[stage ${st.id}] brief.${k}가 비어 있습니다`);
      }
      const boss = monMap.get(st.boss);
      if (boss && b.hunt && b.hunt !== boss.name) {
        err(`[stage ${st.id}] brief.hunt 「${b.hunt}」가 실제 보스 「${boss.name}」와 다릅니다`);
      }
      if (b.hunt && !monNames.has(b.hunt) && !/미궁 그 자체/.test(b.hunt)) {
        warn(`[stage ${st.id}] brief.hunt 「${b.hunt}」에 해당하는 몬스터가 없습니다`);
      }
      if (!story.beats?.[st.id]) warn(`[stage ${st.id}] 클리어 이야기(story.beats)가 없습니다`);
    }
  }
}

const droppedParts = new Set(monsters.flatMap((m) => m.drops ?? []));
for (const p of parts)
  if (!droppedParts.has(p.id)) warn(`[part ${p.id}] 어떤 몬스터도 드랍하지 않습니다`);

/* ---- 이름에 같은 말이 두 번 나오지 않는가 (§3.8) ----
   「얼어붙은 얼어붙은 시체의 언 팔」 같은 이름을 다시 만들지 않기 위한 그물이다.
   수식어 × 파츠를 전부 조립해 보고, 한 이름 안에 같은 속성어가 두 번 들어가면 잡는다. */
{
  const WORD = {
    '얼어붙은': '냉기', '언': '냉기', '서리': '냉기', '혹한에': '냉기',
    '불타는': '화염', '불탄': '화염', '타오르는': '화염', '업화에': '화염',
    '독을': '독', '독': '독', '맹독이': '독',
    '썩어가는': '부패', '썩은': '부패', '곰팡이': '부패', '창궐한': '부패',
  };
  const opp = (a, b) => naming.opposites.some(([x, y]) => (a === x && b === y) || (a === y && b === x));
  for (const part of parts) {
    for (const mod of [null, ...modifiers]) {
      // core.js의 partFlavor와 같은 규칙으로 조립한다
      const info = naming.owners[part.owner ?? ''];
      let prefix = mod ? mod.prefix : '';
      let owner = part.owner ?? '';
      if (mod?.flavor && info) {
        if (mod.flavor === info.flavor) { prefix = naming.merge[mod.flavor].prefix; owner = info.bare; }
        else if (opp(mod.flavor, info.flavor)) { prefix = naming.clash.prefix; }
      }
      const name = part.name_template
        .replace('{mod}', prefix ? prefix + ' ' : '')
        .replace('{owner}', owner).replace(/\s+/g, ' ').trim();
      const seen = [];
      for (const w of name.split(/\s+/)) { const f = WORD[w]; if (f) seen.push(f); }
      const dup = seen.filter((x, i) => seen.indexOf(x) !== i);
      // 서로 다른 속성이 섞이는 것은 괜찮다(「불타는 곰팡이 시체의 다리」).
      // 반대 속성끼리는 애초에 「엇갈린」으로 합쳐지므로 여기까지 오지 않는다.
      if (dup.length) errors.push(`[naming ${part.id}] 같은 속성이 두 번 들어간 이름: "${name}"`);
    }
  }
}

// ---- 커버리지 리포트 ----
const bySlot = Object.fromEntries(SLOTS.map((s) => [s, parts.filter((p) => p.slot === s).length]));
const byElement = {};
for (const s of skills) if (s.power > 0) byElement[s.element] = (byElement[s.element] ?? 0) + 1;
const bodyElements = parts.filter((p) => p.slot === 'body').map((p) => p.def_element);

// ---- 출력 ----
console.log('── 데이터 현황 ──────────────────────────────');
console.log(`스킬 ${skills.length} · 파츠 ${parts.length} · 몬스터 ${monsters.length} · 모디파이어 ${modifiers.length}`);
console.log('파츠 슬롯 분포 :', SLOTS.map((s) => `${s} ${bySlot[s]}`).join('  '));
console.log('공격 속성 분포 :', Object.entries(byElement).map(([e, n]) => `${e} ${n}`).join('  '));
console.log('몸통 방어 속성 :', bodyElements.join(', '));

for (const e of elements.elements)
  if (!byElement[e]) warn(`[coverage] '${e}' 속성 공격 스킬이 하나도 없습니다`);

/* ── 판 번호가 어긋나지 않는가 (§12.7-A) ──────────────
   src/version.js의 BUILD와 sw.js의 BUILD가 다르면, 서비스 워커는 캐시를 새로 열지 않는다.
   화면에는 새 번호가 뜨는데 실제로는 옛 파일이 돌아, 「껐다 켜도 안 바뀐다」가 된다. */
{
  const vsrc = readFileSync(new URL('../src/version.js', import.meta.url), 'utf8');
  const swsrc = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  const a = (vsrc.match(/BUILD\s*=\s*'([^']+)'/) ?? [])[1];
  const b = (swsrc.match(/BUILD\s*=\s*'([^']+)'/) ?? [])[1];
  if (!a) err('[version] src/version.js에서 BUILD를 찾지 못했습니다');
  else if (!b) err('[version] sw.js에서 BUILD를 찾지 못했습니다');
  else if (a !== b) err(`[version] 판 번호가 어긋납니다 — src/version.js ${a} ≠ sw.js ${b}`);
  else console.log(`판 번호      : ${a} (src/version.js = sw.js)`);
}

console.log('');
if (warns.length) {
  console.log(`── 경고 ${warns.length}건 ────────────────────────────`);
  warns.forEach((w) => console.log('  ! ' + w));
  console.log('');
}
if (errors.length) {
  console.log(`── 오류 ${errors.length}건 ────────────────────────────`);
  errors.forEach((e) => console.log('  ✗ ' + e));
  console.log('\n검증 실패.');
  process.exit(1);
}
console.log('검증 통과. 참조 무결성 문제 없음.');
