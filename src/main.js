/** 게임 진행 · 화면 전환 · 세이브 */
import {
  DB, loadData, makeRng, makePart, partName, partStats, partSkills,
  assembleGolem, SLOTS, SLOT_LABEL, SLOT_KIND, SKILL_CAP_BASE, SKILL_CAP_STEP, CORE_MAX_LV, CORE_HP_STEP, coreLevel,
  rollMonster, rollElite, rollBoss, rollLoot, syncUidSeq, skillElement, AIM, RAW_WEAR, wornLow,
  stageOf, partOf, shieldNow, shieldMax, partMana, coreMana, CORE_MANA_STEP, CORE_MANA_MAX_LV,
  partFlavor,
  rollSpareLoss, partElement, elemMul, josa,
} from './core.js';
import { Combat, GUARD_LABEL } from './combat.js';
import * as TUT from './tutorial.js';
import * as CP from './campaign.js';
import { generateFloor, roomAt, exitsOf, ROOM_LABEL, ROOM_ICON, FLAVOR, DIR_KEY } from './dungeon.js';
import {
  rollQuests, advanceQuests, questsAllDone, claimQuests, resetQuests,
  refreshDaily, advanceDaily, dailyAllDone, claimDaily,
  nextResetCost, rollStock, STAPLE_ITEMS, partPrice, sellPrice, canCraft, craft,
  canLearn, learn, buildingStatus, ATTACH_SLOTS,
  SUPPLY, newSupply, tickSupply, supplyRemain,
} from './town.js';
import * as O from './ossuary.js';
import * as EN from './enhance.js';
import * as UI from './ui.js';
import * as PWA from './pwa.js';

const SAVE_KEY = 'patchwork.save.v1';
let S = null;          // 세이브 상태
let rng = null;        // 마을용 난수
let cb = null;         // 진행 중인 전투

/* ── 세이브 ─────────────────────────────── */
function newSave() {
  const seed = Math.floor(Math.random() * 1e9);
  const r = makeRng(seed);
  // 네 자리를 채운 채 시작한다. 세 자리로 시작하면 1-1의 방어도 예산이
  // 한 층을 못 버틴다 — npm run simulate가 정한 구성이다
  const starter = [
    makePart('part_head_goblin_skull'),
    makePart('part_body_goblin_torso'),
    makePart('part_arm_goblin_claw'),
    makePart('part_leg_goblin_hop'),
    makePart('part_leg_goblin_hop'),   // 다리는 두 짝이다
  ];
  return {
    version: 1, seed,
    silver: 180, soulAsh: 40, scrap: 12, ichor: 2, boneMeal: 4,
    inventory: starter,
    golem: {
      core: 'core_scrap',
      head: starter[0].uid, body: starter[1].uid, armL: starter[2].uid, armR: null,
      legL: starter[3].uid, legR: starter[4].uid,
      attachments: [], banned: [], retuned: {},
    },
    cores: [],          // 예비 핵
    coreUpgrades: {},   // 핵별 마력 강화 단계 (§3.7)
    consumables: { it_corpseoil: 2 },
    owned: { attachments: [] },
    necro: { known: ['nk_bonemend', 'nk_skeleton', 'nk_soulspear'],
             equipped: ['nk_bonemend', 'nk_skeleton', 'nk_soulspear'] },
    quests: { active: rollQuests(r), resets: 0 },
    daily: null,          // 첫 진입에서 오늘 날짜로 채워진다
    town: { stock: rollStock(r), smithy: [], supply: newSupply() },
    seen: {}, run: null,
    // 캠페인 — 어디까지 왔는가 (§7-A). stage는 '다음에 도전할 단계'
    campaign: { stage: '1-1', cleared: {}, story: {}, ending: null },
    ossuary: (() => { const o = O.newOssuary(); o.built.forge = true; return o; })(),
    unlocks: { necroSlots: 3, salvage: 0, partPool: 0, modTier: 0 },
    modSamples: {},
    // 첫 판의 튜토리얼 (§7-B). step은 대본의 몇 번째 걸음인가
    tutorial: { step: 0, done: false },
    log: { runs: 0, kills: 0, lost: 0, handouts: 0,
           hintAim: false, hintRaw: false, hintSwap: false, hintOssuary: false, hintVault: false, hintWear: false },
  };
}

function save() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(S)); } catch { /* 저장 불가 환경 */ }
}
/**
 * 예전 세이브에 없던 필드를 채운다.
 * 새 기능을 넣을 때 여기를 같이 고치지 않으면, 이미 플레이 중인 사람의 화면에서
 * undefined.map 같은 오류가 난다. 필드를 추가하면 반드시 여기도 추가할 것.
 */
/**
 * 세이브 안의 파츠 uid를 훑어 번호표를 그 뒤로 옮긴다.
 * 이걸 빠뜨리거나 잘못 부르면 새로 만든 파츠가 기존 uid와 겹쳐
 * 골렘이 엉뚱한 부속을 집는다. syncUidSeq는 **숫자**를 받는다 — 세이브가 아니라.
 */
/** 파츠가 머무는 모든 자리를 한 줄로 — 마이그레이션과 uid 재동기화가 같은 목록을 본다 */
function allStoredParts(s) {
  return [
    ...(s.inventory ?? []),
    ...(s.ossuary?.vault?.parts ?? []),
    ...(s.ossuary?.crew?.parts ?? []),
    ...(s.ossuary?.workshop?.golems ?? []).flatMap((g) => g.parts ?? []),
    ...(s.ossuary?.laborBay?.dispatch ?? []).flatMap((d) => d.parts ?? []),
    ...(s.ossuary?.dissection?.slots ?? []).flatMap((j) => j.parts ?? (j.part ? [j.part] : [])),
    ...(s.ossuary?.forge?.slots ?? []).flatMap((j) => j.inputs ?? []),
    ...(s.town?.smithy ?? []).map((j) => j.part).filter(Boolean),
  ];
}

function resyncUids(s) {
  let max = 0;
  // 파츠가 머무는 자리를 **하나도 빼놓지 않고** 훑어야 한다.
  // 해체대·단련로·대장간을 빠뜨렸더니, 거기 올려 둔 파츠의 번호를 새 파츠가
  // 다시 쓰는 일이 생겼다 — 같은 uid가 둘이면 장착 표시가 엉뚱한 것에 붙는다.
  const all = allStoredParts(s);
  for (const p of all) max = Math.max(max, Number(String(p.uid).slice(1)) || 0);
  syncUidSeq(max + 1);
}

function migrate(s) {
  s.cores ??= [];
  /* 상시 소모품(§10.7)을 이미 굴려 둔 손수레에도 채워 준다.
     안 그러면 지금 판을 하고 있는 사람은 다음에 손수레가 새로 깔릴 때까지
     귀환의 문양을 못 산다 — 없던 물건이 생기는 것이지 있던 것을 뺏는 게 아니다. */
  if (s.town?.stock?.items) {
    for (const id of STAPLE_ITEMS()) {
      if (!s.town.stock.items.includes(id)) s.town.stock.items.push(id);
    }
  }
  /* 이미 마을에 있던 사람에게 튜토리얼을 다시 보여 주지 않는다 (§16.1-B).
     기록이 있다는 것 자체가 「이미 배웠다」는 뜻이다. */
  s.tutorial ??= { step: 0, done: true };
  s.coreUpgrades ??= {};
  /* 핵 강화를 열 단계로 늘리면서 한 단계가 주는 마력이 3에서 2로 줄었다 (§3.11-A).
     그대로 두면 이미 올려 둔 핵의 마력이 **말없이 깎인다** — 단계를 올려 값을 맞춘다. */
  if (!s.coreUpgradesV2) {
    for (const [cid, lv] of Object.entries(s.coreUpgrades)) {
      s.coreUpgrades[cid] = Math.min(CORE_MAX_LV, Math.ceil((lv ?? 0) * 3 / 2));
    }
    s.coreUpgradesV2 = true;
  }
  s.coreDust ??= 0;                       // 핵을 빻아 얻은 가루 (§3.11-A)
  s.daily ??= null;
  s.campaign ??= { stage: '1-1', cleared: {}, story: {}, ending: null };
  s.campaign.cleared ??= {};
  s.campaign.story ??= {};
  s.campaign.stage ??= '1-1';
  s.campaign.ending ??= null;
  s.modSamples ??= {};
  s.unlocks ??= { necroSlots: 3 };
  delete s.unlocks.vaultStart;      // 자동 반출이 없어졌으므로 이 해금도 없앤다
  s.unlocks.necroSlots ??= 3;
  s.unlocks.salvage ??= 0;      // 잔해 수습 — 무너진 골렘에서 더 건진다
  s.unlocks.partPool ??= 0;     // 수소문 — 상점에 좋은 부속이 깔린다
  s.unlocks.modTier ??= 0;      // 이상 감식 — tier 2 모디파이어가 일찍 나온다
  s.log ??= {};
  s.log.handouts ??= 0;
  s.log.hintAim ??= false;
  s.log.hintRaw ??= false;
  s.log.hintSwap ??= false;
  s.log.hintOssuary ??= false;
  s.log.hintVault ??= false;
  s.log.hintWear ??= false;
  s.log.hintBench ??= false;
  s.town ??= {};
  s.town.smithy ??= [];
  s.town.supply ??= newSupply();                          // 상점 보급품 재고
  s.coreHpBy ??= {};                                      // 핵마다 따로 기억하는 체력
  s.golem ??= {};
  s.golem.core ??= (s.golem.body ? 'core_scrap' : null);  // 예전 골렘에는 핵을 끼워 준다
  s.golem.coreHp ??= null;                                // null = 가득
  for (const p of s.inventory ?? []) p.shield ??= null;   // null = 닳지 않음
  // 다리가 한 짝이던 시절의 세이브를 좌각으로 옮긴다
  if (s.golem.leg !== undefined) {
    s.golem.legL ??= s.golem.leg;
    delete s.golem.leg;
  }
  s.golem.legL ??= null;
  s.golem.legR ??= null;
  s.golem.attachments ??= [];
  s.golem.banned ??= [];
  s.golem.retuned ??= {};
  // 골렘도 명부에 오른다 — 이름과 번호가 있어야 갈아탈 수 있다 (§9.7)
  s.golem.id ??= 'g0';
  s.golem.name ??= '누더기 골렘';
  /* 내구도 상한을 4배로 올렸다(§3.3-B). 옛 세이브의 파츠는 옛 눈금(4~10)을 쓰고 있어
     그대로 두면 새로 주운 것만 오래 버틴다 — 가진 것도 같은 눈금으로 끌어올린다.
     정제(+8) 이후의 값까지 옛 눈금에 들어오므로, 12 이하만 옛것으로 본다. */
  for (const p of allStoredParts(s)) {
    if (p.maxIntegrity > 12) continue;
    p.maxIntegrity *= 4;
    p.integrity = Math.max(1, Math.min(p.maxIntegrity, p.integrity * 4));
  }
  // 정비 작업은 이제 골렘 한 기에 묶인다 (§9.8). 옛 기록은 지금 몸에 붙인 것으로 본다
  for (const j of s.ossuary?.overhaul ?? []) j.golemId ??= s.golem.id;
  /* 핵만 있는 몸에는 일을 못 시킨다 (§9.6-A). 옛 세이브에는 그렇게 붙여 둔 것이 있다.
     **작업반에서만 떼어낸다.** 작업반은 계속 이득을 주는 자리라 물려야 하지만,
     이미 나가 있는 자율 탐험은 *걸어 둔 일*이다 — 규칙이 바뀌었다고 말없이 없애면
     플레이어는 보낸 골렘이 사라졌다고 본다. 나간 것은 끝까지 다녀오게 두고,
     새로 보내는 것만 막는다. */
  for (const g of s.ossuary?.workshop?.golems ?? []) {
    if ((g.parts?.length ?? 0) >= 1) continue;
    if (g.assigned === 'crew') g.assigned = null;
  }
  /* 강화를 하나로 합쳤다 (§9.15). 대장간의 `upgrade`(+8%씩 3단계)와 접합로의
     `refined`(+10%씩)가 따로 쌓여 있었다 — 둘 다 「강화」인데 축이 둘이었다.
     들인 것을 빼앗지 않는다: 두 값을 더해 새 `plus`로 옮긴다 (§16.1-B). */
  const toPlus = (p) => {
    if (!p || p.plus != null) return;
    const n = (p.upgrade ?? 0) + (p.refined ?? 0);
    if (n > 0) p.plus = Math.min(EN.PLUS_MAX, n);
    delete p.upgrade; delete p.refined;
  };
  for (const p of s.inventory ?? []) toPlus(p);
  for (const g of s.ossuary?.workshop?.golems ?? []) for (const p of g.parts ?? []) toPlus(p);
  for (const p of s.ossuary?.vault?.parts ?? []) toPlus(p);
  for (const j of s.ossuary?.forge?.slots ?? []) for (const p of j.inputs ?? []) toPlus(p);
  for (const j of s.ossuary?.dissection?.slots ?? []) for (const p of (j.parts ?? (j.part ? [j.part] : []))) toPlus(p);
  /* 대장간의 파츠 강화는 없앴다 — 걸려 있던 것은 **부속을 돌려준다.**
     화면에서 사라졌는데 부속이 그 안에 갇혀 있으면 잃어버린 것과 같다. */
  for (const j of s.town?.smithy ?? []) {
    if (!j.part) continue;
    toPlus(j.part);
    if (!(s.inventory ?? []).some((x) => x.uid === j.part.uid)) s.inventory.push(j.part);
  }
  if (s.town) s.town.smithy = [];
  /* 접합로에 걸려 있던 옛 조리법(융합·이식·정제·수복·소생·굳히기)도 마찬가지다.
     이제 없는 일이므로 **재료로 넣은 부속을 돌려주고** 비운다. */
  if (s.ossuary?.forge) {
    const keep = [];
    for (const j of s.ossuary.forge.slots ?? []) {
      if (j.recipe === 'attune') { keep.push(j); continue; }
      for (const p of j.inputs ?? []) {
        if (!(s.inventory ?? []).some((x) => x.uid === p.uid)) s.inventory.push(p);
      }
    }
    s.ossuary.forge.slots = keep;
  }
  s.consumables ??= {};
  s.owned ??= { attachments: [] };
  s.owned.attachments ??= [];
  s.necro ??= { known: [], equipped: [] };
  s.necro.known ??= [];
  s.necro.equipped ??= [];

  const o = (s.ossuary ??= O.newOssuary());
  o.workshop ??= { golems: [], seq: 0 };
  o.workshop.golems ??= [];
  o.workshop.seq ??= 0;
  // 조립대 골렘도 탐험 자리에 오를 수 있게 됐다 — 갈아탈 때 함께 옮길 것들
  for (const g of o.workshop.golems) {
    g.coreHp ??= null;
    g.attachments ??= [];
    g.banned ??= [];
    g.retuned ??= {};
  }
  // 옛 파견 기록은 새 자율 탐험과 형식이 다르다 — 골렘만 돌려주고 비운다
  for (const d of o.laborBay?.dispatch ?? []) {
    if (d.durationMs) continue;
    const g = o.workshop.golems.find((x) => x.id === d.golemId);
    if (g) g.assigned = null;
    d.done = true;
  }
  if (o.laborBay) o.laborBay.dispatch = (o.laborBay.dispatch ?? []).filter((d) => !d.done);
  // 예전엔 부속을 자동으로 밀어 넣었다. 자리 정보가 없으므로 종류에 맞춰 채워 준다
  for (const g of o.workshop.golems) {
    if (g.slots) continue;
    g.slots = {};
    const used = new Set();
    for (const part of g.parts ?? []) {
      const kind = DB.partsBy[part.defId]?.slot;
      const slot = SLOTS.find((x) => SLOT_KIND[x] === kind && !used.has(x));
      if (slot) { g.slots[slot] = part.uid; used.add(slot); }
    }
  }
  // 예전에는 부속을 직접 작업반에 세웠다. 이제는 핵으로 조립한 골렘만 일한다 —
  // 세워 뒀던 부속은 돌려준다. 잃어버리게 두는 것이 가장 나쁜 처리다
  o.crew ??= { parts: [] };
  if (o.crew.parts?.length) {
    for (const part of o.crew.parts) (s.inventory ??= []).push(part);
    o.crew.parts = [];
  }
  o.crew.parts ??= [];
  o.vault ??= { capacity: 3, parts: [], lostRecords: [] };
  o.vault.parts ??= [];
  o.vault.lostRecords ??= [];
  o.dissection ??= { level: 1, slots: [] };
  o.dissection.slots ??= [];
  o.forge ??= { level: 2, slots: [] };
  o.forge.slots ??= [];
  if (o.forge.level < 2) o.forge.level = 2;   // 한 칸이던 시절의 세이브를 올려 준다
  o.laborBay ??= { level: 1, dispatch: [] };
  o.congeal ??= null;                    // 굳히기는 이제 통에 걸어 둔다 (§9.17)
  o.grind ??= null;                      // 핵 빻기 (§3.11-A)
  o.laborBay.dispatch ??= [];
  // 예전에는 부속 낱개를 파견 보냈다. 이제는 조립대 골렘만 나간다 —
  // 나가 있던 부속은 소지품으로 돌려주고 그 파견은 접는다
  o.laborBay.dispatch = o.laborBay.dispatch.filter((d) => {
    if (d.golemId) return true;
    for (const part of d.parts ?? []) (s.inventory ??= []).push(part);
    return false;
  });
  o.rotVat ??= { level: 1, input: 0, stored: 0 };
  o.built ??= {};
  o.built.rotVat ??= true;
  o.built.dissection ??= true;
  o.built.forge = true;          // 정착이 여기 있으므로 항상 열려 있어야 한다
  o.built.vault ??= false;
  o.built.laborBay ??= false;
  o.lastSeenAt ??= Date.now();
  o.offlineCapMs ??= O.CAP_STEPS[0];
  o.capStep ??= 0;
  return s;
}

function load() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const s = migrate(JSON.parse(raw));
    if (s.version !== 1) return null;
    resyncUids(s);
    return s;
  } catch { return null; }
}

const KIND_LABEL = { head: '머리', body: '몸통', arm: '팔', leg: '다리' };
/** 최소 이만큼은 끼워야 무덤에 내려갈 수 있다 (§3.6) */
const MIN_PARTS = 2;
const wornCount = () => SLOTS.filter((s) => S.golem[s]).length;
/** 소지 + 장착한 파츠 총수 — 바르그의 지원 판정에 쓴다 */
const totalParts = () => S.inventory.length;
/* 날것은 스탯 60%에 기술이 불발되므로 '쓸 수 있는 부속'으로 세지 않는다 */
const settledParts = () => S.inventory.filter((p) => !p.raw).length;

/* 던전에서만 방향키가 살아난다. 화면이 바뀌면 곧바로 꺼진다. */
let arrowMoves = null;
const setArrowMoves = (map) => { arrowMoves = map; syncDpad(); };
// 선택지가 다시 그려질 때마다 기본적으로 꺼진다. 던전 이동 화면만 되켠다.
UI.onChoicesRendered.push(() => { arrowMoves = null; syncDpad(); });

/**
 * 화면 오른쪽 아래의 이동 십자키.
 * 선택지 목록에도 방향이 있지만, 그쪽은 다른 항목에 밀려 자리가 바뀐다.
 * 이동은 자리가 고정돼 있어야 손이 기억한다.
 */
function syncDpad() {
  const pad = document.getElementById('dpad');
  if (!pad) return;
  pad.hidden = !arrowMoves;
  // 십자키가 떠 있는 동안에는 선택지 오른쪽에 그만큼 자리를 비운다
  document.getElementById('app')?.classList.toggle('dpad-on', Boolean(arrowMoves));
  if (!arrowMoves) return;
  for (const b of pad.querySelectorAll('.dp')) {
    const move = arrowMoves[b.dataset.dir];
    b.disabled = !move;
    // 선택지에서 뺀 '미탐험 / 방 종류'를 버튼 자체가 알려 준다
    b.dataset.seen = move ? String(move.seen) : '';
    b.title = move ? `${b.dataset.dir} — ${move.label}` : '';
  }
}
// 모듈 스크립트는 defer라 여기 올 때 이미 DOMContentLoaded가 지나 있다.
// 그걸 기다리면 리스너가 영영 안 붙는다 — 바로 붙인다.
(() => {
  const pad = document.getElementById('dpad');
  if (!pad) return;
  pad.addEventListener('click', (e) => {
    const b = e.target.closest('.dp');
    if (!b || b.disabled) return;
    arrowMoves?.[b.dataset.dir]?.go();
  });
})();
document.addEventListener('keydown', (e) => {
  const dir = DIR_KEY[e.key];
  if (!dir || !arrowMoves) return;
  const move = arrowMoves[dir];
  if (!move) return;
  e.preventDefault();
  move.go();
});
const STAT_LABEL = { hp: '체력', atk: '공격', def: '방어', eva: '회피', spd: '속도', focus: '집중' };

/**
 * 재화 안내. 무엇이 어디서 나오고 어디에 들어가는지 한자리에 모은다.
 * key는 세이브의 필드명과 같다 — 소지량을 그대로 읽어 온다.
 */
const RESOURCE_GUIDE = [
  { key: 'silver', name: '은화', tag: '마을 재화',
    from: '전투 후 시체에서 · 파츠 판매 · 의뢰 보상',
    use: '상점 구매 · 대장간 제작과 강화 · 속성 도가니',
    note: '방치로는 한 푼도 안 나온다. 무덤에 내려가야 생긴다.' },
  { key: 'soulAsh', name: '영혼재', tag: '메타 재화',
    from: '탐험을 마칠 때 정산 (층수와 처치 수) · 의뢰 보상',
    use: '제단의 영구 해금 · 강령술사 조합의 술법 습득',
    note: '오직 런에서만 나온다. 이것 때문에 방치만으로는 성장이 막힌다.' },
  { key: 'scrap', name: '시체 조각', tag: '기본 재료',
    from: '유해 더미 방 · 해체대 · 사역 골렘 파견',
    use: '정착 · 강화 · 여분 수복 · 부패조 투입 · 방어도 수리 · 대장간 제작',
    note: '가장 많이 쓰인다. 모자라면 유해 더미를 뒤지거나 파츠를 해체한다.' },
  { key: 'ichor', name: '부패 진액', tag: '촉매',
    from: '부패조 방치 생산 · 희귀 이상 파츠 해체 · 역병 늪지 파견',
    use: '정착 · 강화 · 소생 · 핵 안정화 · 방혈관과 도가니 제작',
    note: '부패조에 시체 조각을 담가 두면 시간이 알아서 만들어 준다.' },
  { key: 'boneMeal', name: '골분', tag: '정밀 재료',
    from: '공동묘지·갱도 파견 · 유해 더미 · 유니크 파츠 해체',
    use: '강화 · 소생 · 여분 수복 · 정비대 · 균형추 제작 · 굳히기로 얻는다',
    note: '적게 나오고 귀하다. 강화와 정비에 집중해서 쓴다.' },
];

/** 부위 조준과 방어도 — 전투의 두 축 */
function aimGuideScreen(back = town) {
  UI.topbar(S, '부위 조준 안내');
  UI.listPanel('조준 세 가지', [
    UI.rowHTML('무작위', '부위를 가리지 않는다', '명중 ±0 · 부위 ×1.0'),
    UI.rowHTML('상단', '머리 · 양팔', '명중 −15 · 부위 ×1.5'),
    UI.rowHTML('하단', '몸통 · 다리', '명중 −10 · 부위 ×1.3'),
  ], `<p class="note">전투 커맨드의 🎯 버튼으로 전환한다. 한 번 고르면 바꿀 때까지 유지된다.</p>`);

  UI.logHead('부위 조준');
  UI.logLine('적의 부위를 부수면 그만큼 약해진다 — 팔을 부수면 공격력이 절반, 다리면 속도와 회피가 절반이다.', 'narrate');
  UI.logLine('대신 부서진 부위는 전리품에서 빠진다. 그 부속은 얻을 수 없다.', 'bad');
  UI.logLine('이것이 조준의 전부다 — 지금 편하게 싸울 것인가, 그 부속을 온전히 얻을 것인가.', 'good');
  UI.logLine('무작위 조준은 부위 피해 배율이 1.0이라 사실상 "부속 보존" 선택지가 된다.', 'dim');

  UI.logLine('', '');
  UI.logLine('내 쪽도 같은 구조다. 핵이 체력이고, 장착한 부속이 방어도다.', 'narrate');
  UI.logLine('피해는 방어도를 먼저 깎고, 방어도가 다 닳아야 핵에 닿는다.', '');
  UI.logLine('부위 방어도가 0이 되면 그 부속의 기술을 쓸 수 없다. 전부 무너지면 핵이 남아도 패배한다.', 'bad');
  UI.logLine('반대도 마찬가지다 — 부속이 멀쩡해도 핵이 0이 되면 그 자리에서 진다.', 'bad');
  UI.logLine('중독·화상·가시는 방어도를 지나쳐 핵을 직접 갉는다. 방어도가 남았는데 핵이 줄었다면 그것이다.', 'necro');
  UI.logLine('방어도는 포션으로 돌아오지 않는다. 던전 작업대방이나 납골당 정비대에서만 되돌린다.', 'good');
  UI.choices([{ label: '돌아간다', cls: 'ghost', pin: true, on: () => back(false) }]);
}

/** 날것 부속 — 전투 드랍을 바로 쓰는 것의 대가 */
function rawGuideScreen(back = town) {
  UI.topbar(S, '날것 부속 안내');
  UI.listPanel('날것 vs 정착', [
    UI.rowHTML('스탯', '60%만 발휘', '100%'),
    UI.rowHTML('기술', '25% 확률로 불발', '정상'),
    UI.rowHTML('내구도', '전투당 2씩 소모', '전투당 1'),
  ], `<p class="note">정비 화면에서 부속마다 <b>날것</b> / <b>정착</b> 표시를 볼 수 있다.</p>`);

  UI.logHead('날것 부속');
  UI.logLine('무덤에서 막 뜯어온 부속은 날것이다. 골렘의 이음새에 맞지 않아 헛돈다.', 'narrate');
  UI.logLine('그대로 끼울 수는 있다 — 다만 스탯은 60%, 기술은 넷 중 하나꼴로 불발되고, 내구도가 배로 닳는다.', 'bad');
  UI.logLine('고치는 곳: 납골당 → 공방 → 단련로 → 정착. 시체 조각 8 + 부패 진액 1, 20분.', 'good');
  UI.logLine('상점에서 산 것, 봉인실 보상, 소생시킨 것은 처음부터 정착 상태다. 날것은 전투 드랍과 자율 탐험에만 붙는다.', 'dim');
  UI.logLine('급하면 지금 끼우고 감수하거나, 마을로 돌아가 제대로 처리하고 오거나 — 그 저울질이 요점이다.', '');
  UI.choices([{ label: '돌아간다', cls: 'ghost', pin: true, on: () => back(false) }]);
}

function resourceGuideScreen(back = town) {
  UI.topbar(S, '재화 안내');
  UI.listPanel('가진 재화',
    RESOURCE_GUIDE.map((r) => UI.rowHTML(r.tag, UI.esc(r.name), String(S[r.key] ?? 0))),
    '<p class="note">무엇이 어디서 나오고 어디에 들어가는지 정리한 것이다.</p>');
  UI.logHead('재화 다섯 가지');
  for (const r of RESOURCE_GUIDE) {
    UI.logLine(`${r.name} — ${r.tag} (지금 ${S[r.key] ?? 0})`, 'necro');
    UI.logLine(`얻는 곳: ${r.from}`, '');
    UI.logLine(`쓰는 곳: ${r.use}`, '');
    UI.logLine(r.note, 'dim');
  }
  UI.logLine('핵심은 은화와 영혼재가 무덤에서만 나온다는 것이다. 방치는 재료만 만든다.', 'good');
  UI.choices([{ label: '돌아간다', cls: 'ghost', pin: true, on: () => back(false) }]);
}
const money = (n) => `은화 ${n}`;
const findPart = (uid) => S.inventory.find((p) => p.uid === uid);

/* ── 마을 ───────────────────────────────── */
/** 납골당 정산을 돌리고, 내역이 있으면 복귀 정산 화면을 먼저 보여준다 */
function settleAndReport(next) {
  const r = O.settle(S, Date.now());
  // 끝난 작업 건수를 오늘의 일에 흘려보낸다
  if (r.lines.length) notifyQuests({ kind: 'job', count: r.lines.length });
  save();
  if (!r.lines.length) { next(); return; }
  UI.topbar(S, '납골당 · 복귀 정산');
  UI.returnReport(O.elapsedText(r.elapsed) + (r.capped ? ' (상한까지만 정산)' : ''), r.lines);
  UI.logHead('돌아왔다');
  UI.logLine(`자리를 비운 사이 ${O.elapsedText(r.elapsed)}이(가) 흘렀다.`, 'narrate');
  for (const l of r.lines) UI.logLine(`${l.facility} — ${l.text}`, l.warn ? 'bad' : 'good');
  if (r.capped) UI.logLine('오프라인 정산 상한에 걸렸다. 제단에서 늘릴 수 있다.', 'dim');
  UI.choices([{ label: '전부 수령', cls: 'primary', on: next }]);
}

/* ── 퀵패널 (§12.17) ────────────────────────────────
   마을 어디에 있든 왼쪽 띠에 **갈 수 있는 곳**이 늘 서 있다.
   지금 있는 곳에는 표가 붙는다 — 어디에 있는지 알아야 옮겨 다닐 수 있다.
   전에는 「돌아간다」로 한 겹씩 거슬러 올라가야만 옆 건물로 갈 수 있었다. */
const TOWN_QUICK = () => [
  { key: 'town', icon: '🏚', label: '마을', on: () => town(false) },
  { key: 'scavenger', icon: '🦴', label: '바르그', on: scavengerScreen },
  { key: 'quest', icon: '📜', label: '의뢰소', on: boardScreen },
  { key: 'market', icon: '🛒', label: '저잣거리', on: marketScreen },
  { key: 'ossuary', icon: '⚱', label: '납골당', on: ossuaryScreen },
  { key: 'inventory', icon: '🎒', label: '가방', on: () => inventoryScreen(town) },
  { sep: true },
  { key: 'dungeon', icon: '🕳', label: '무덤으로', on: startRun },
];

/** 납골당 안에서는 문 셋이 이어 붙는다 — 한 겹 올라갔다 내려오지 않게 */
const OSS_QUICK = () => [
  ...TOWN_QUICK(),
  { sep: true },
  { key: 'materials', icon: '🫗', label: '재료', on: materialsScreen },
  { key: 'workshop', icon: '⚙', label: '공방', on: workshopHubScreen },
  { key: 'altar', icon: '🕯', label: '제단', on: altarScreen },
];

/** 무덤 안에서는 마을 건물이 아니라 **지금 쓸 수 있는 것**이 선다 (§12.17-B) */
const RUN_QUICK = () => {
  const items = S.consumables?.it_sigil_return ?? 0;
  return [
    { key: 'golem', icon: '🦿', label: '골렘', on: () => golemScreen(backToRoom, false) },
    { key: 'bag', icon: '🎒', label: '가방', sub: `${S.inventory.length}`,
      on: () => inventoryScreen(backToRoom) },
    { key: 'affinity', icon: '🜂', label: '상성표', on: () => affinityScreen(backToRoom) },
    { sep: true },
    { key: 'quest', icon: '📜', label: '의뢰', on: () => { UI.logLine('오른쪽 위 📜에 적어 뒀다.', 'dim'); } },
    items ? { key: 'return', icon: '🌀', label: '귀환', sub: `${items}개`,
      on: () => {
        S.consumables.it_sigil_return--;
        UI.logLine('문양이 타오르고, 시야가 뒤집힌다.', 'necro');
        abandonRun(true);
      } } : null,
  ];
};

/** 지금 있는 곳에 표를 붙여 퀵패널을 세운다 */
function quickHere(key, items = null) {
  // 납골당 안에 있으면 문 셋까지 함께 세운다 — 납골당 화면 자체도 그 안이다
  const list = (items ?? (/^(ossuary|materials|workshop|altar)$/.test(key) ? OSS_QUICK() : TOWN_QUICK()))
    .map((it) => (it.sep ? it : { ...it, here: it.key === key }));
  UI.quickPanel(list);
}

function town(intro = true) {
  cb = null;
  resetShopPick();
  overhaulPick = null;
  UI.setCombatMode(false);
  // 자정을 넘겼으면 오늘의 일을 새로 건다 (§10.2-A)
  if (refreshDaily(S, rng)) {
    UI.logLine('☀ 게시판의 종이가 새것으로 바뀌었다. 오늘의 일이 걸렸다.', 'necro');
    save();
  }
  UI.topbar(S, '시체골 · 마을');
  quickHere('town');
  // 건물은 왼쪽 그림에서 눌러 들어간다. 하단에는 '지금 할 행동'만 남긴다 (§12.4)
  const bs = buildingStatus(S);
  const dl = S.daily?.list ?? [];
  UI.townPanel(S, {
    ...bs,
    scavenger: S.golem.core ? `목표 ${CP.progress(S).done}/${CP.progress(S).total}` : '골렘이 없다',
    ossuary: ossuaryBadge(),
    // 대분류 타일은 **안에 있는 것들을 한 줄로 요약한다** — 들어가 보지 않아도 알아야 한다
    quest: `의뢰 ${bs.quest}${bs.questReady ? ' 수령' : ''} · 오늘 ${dl.filter((x) => x.done).length}/${dl.length}`,
    market: [bs.shop, bs.forge !== '재료 부족' ? bs.forge : null,
      bs.conclave !== '없음' ? `술법 ${bs.conclave}` : null].filter(Boolean).join(' · '),
    inventory: `부속 ${S.inventory.length}`,
  }, {
    scavenger: scavengerScreen,
    ossuary: ossuaryScreen,
    quest: boardScreen,
    market: marketScreen,
    inventory: () => inventoryScreen(town),
  });
  if (intro) {
    UI.logHead('시체골');
    UI.logLine('젖은 흙과 초의 냄새. 아무도 당신이 무엇을 하는지 묻지 않는 마을이다.', 'narrate');
    if (questsAllDone(S)) UI.logLine('의뢰소 게시판이 비었다. 보상을 받을 때가 됐다.', 'good');
  }
  // 목표 한 줄 — 이것이 늘 보이는 것이 캠페인의 8할이다 (§7-A.5)
  const bf0 = CP.brief(S);
  UI.logLine(`▸ 지금 할 일 — ${CP.objective(S)}`, 'necro');
  if (bf0) UI.logLine(`   "${bf0.order}" — ${bf0.hunt}을(를) 눕히고 ${bf0.bring}을(를) 가져온다.`, 'dim');
  UI.choices([
    // 가장 자주 누르는 버튼은 **절대 잘리지 않아야 한다** — 잘리면 손가락으로 두 번 눌러야 한다 (§12.6).
    // 어디로 가는지는 곁말이 말한다
    { label: '무덤으로', cls: 'primary',
      meta: CP.nextStage(S) ? stageOf(CP.nextStage(S)).name : '아홉 단계 완료', on: startRun },
    { label: '상성표', cls: 'ghost', meta: '속성 일곱', on: () => affinityScreen(() => town(false)) },
    { label: '저장', cls: 'ghost', on: () => { save(); UI.logLine('기록을 남겼다.', 'dim'); } },
    { label: '기록 보관', cls: 'ghost', meta: '내보내기 · 가져오기', on: backupScreen },
    // 설치할 수 있을 때만 뜬다. 이미 앱으로 열었으면 나오지 않는다 (§12.7)
    PWA.canInstall() ? { label: '📲 앱으로 설치', cls: 'primary',
      meta: '홈 화면에 둔다', on: installApp } : null,
    // 새 판이 와 있으면 그 자리에서 갈아탄다 (§12.7-A)
    PWA.hasUpdate() ? { label: '🔄 새 판으로 바꾼다', cls: 'primary',
      meta: '지금 다시 연다', info: '고쳐서 올린 판이 와 있다. 눌러야 바뀐다 — 기록은 그대로다.',
      on: () => { UI.logLine('새 판으로 바꾼다…', 'good'); PWA.applyUpdate(); } } : null,
    { label: `판 ${PWA.version()}`, cls: 'ghost', nokey: true,
      meta: PWA.hasUpdate() ? '새 판 있음' : '최신',
      /* 화면 크기를 함께 적는다 — 「왜 내 화면만 배치가 다르지」를 물어보려면
         **그 화면이 몇 px인지**부터 알아야 한다. 폴드 펼침이 690×829인 걸
         모르고 문턱을 두 번 잘못 잡았다 (§12.17-C). */
      info: `지금 돌고 있는 판은 <b>${PWA.version()}</b>이다.<br>`
        + `화면 <b>${window.innerWidth}×${window.innerHeight}</b> · 배치 `
        + `<b>${UI.isWide() ? (UI.isMid() ? '정사각형에 가까움' : '넓음') : '좁음'}</b><br>`
        + `눌러 새 판이 있는지 다시 확인한다.`,
      on: () => {
        PWA.checkForUpdate();
        UI.logLine(PWA.hasUpdate()
          ? '새 판이 와 있다 — 「새 판으로 바꾼다」를 누르면 적용된다.'
          : `판 ${PWA.version()} — 확인했다. 화면 ${window.innerWidth}×${window.innerHeight}, 배치 `
            + `${UI.isWide() ? (UI.isMid() ? '정사각형에 가까움' : '넓음') : '좁음'}.`, 'dim');
        setTimeout(() => { if (!S.run && !cb) town(false); }, 1500);
      } },
  ]);
  save();
}

/**
 * 마을 타일 한 줄. **시간이 드는 것을 하나도 빼지 않고 센다** (§9.5-A) —
 * 정비대와 대장간을 빼고 세는 바람에, 정비를 걸어 둔 채 '비어 있음'이라고 적혀 있었다.
 */
function ossuaryBadge() {
  const o = S.ossuary;
  const running = [
    ...o.dissection.slots, ...(o.forge?.slots ?? []), ...o.laborBay.dispatch,
    ...(o.overhaul ?? []), ...(o.congeal ? [o.congeal] : []),
  ];
  if (o.rotVat.stored >= O.vatCap(o)) return '통이 가득';
  if (!running.length) return '비어 있음';
  const soonest = running.reduce((a, b) =>
    (a.startedAt + a.durationMs <= b.startedAt + b.durationMs ? a : b));
  return `${running.length}건 · ${O.remainText(soonest.startedAt, soonest.durationMs)}`;
}

/* ── 영혼석 강화 — 마력을 늘린다 (§3.7) ──────────────────
   좋은 부속일수록 마력을 많이 먹는다. 더 좋은 것을 쓰고 싶으면
   더 좋은 핵을 구하거나, 지금 핵을 여기서 키운다. */
/* (구) CORE_UP_COST — 핵 강화 값은 ossuary.coreUpCost로 옮겼다 (§3.11-A) */

/* ── 핵 강화 (§3.11-A) ─────────────────────────
   뼈 모루의 「영혼석 강화」가 여기로 왔다. 다섯 단계에 마력만 주던 것을
   **열 단계**로 늘리고, 단계마다 셋을 함께 준다 — 마력 · 핵 체력 · 그리고
   세 단계마다 **기술 한 칸**. 핵이 골렘의 그릇이라는 말이 그제야 맞는다.

   주재료는 **핵 가루**다(재료 화면에서 여분 핵을 빻아 얻는다). 기본 재료도 함께 든다 —
   가루만이면 여분 핵의 수가 곧 상한이 되어, 핵이 안 나오는 구간에서 통째로 막힌다. */
function coreUpScreen() {
  const coreId = S.golem.core;
  UI.topbar(S, '단련로 · 핵 강화');
  const core = coreId ? DB.coresBy[coreId] : null;
  const lv = coreLevel(S);
  const g = assembleGolem(S);
  const maxed = lv >= CORE_MAX_LV;
  const cost = maxed ? null : O.coreUpCost(lv);
  const dust = S.coreDust ?? 0;
  const rate = O.CORE_UP_RATE[Math.min(CORE_MAX_LV, lv + 1)] ?? 0;
  const lackDust = cost && dust < cost.dust ? `가루 ${cost.dust - dust} 모자라다` : null;
  const lackMat = cost ? shortText({ boneMeal: cost.boneMeal, ichor: cost.ichor, silver: cost.silver }) : null;
  const block = !core ? '핵이 없다' : maxed ? '더는 못 올린다' : lackDust ?? lackMat ?? null;
  const nextCap = SKILL_CAP_BASE + Math.floor(Math.min(CORE_MAX_LV, lv + 1) / SKILL_CAP_STEP);
  const capUp = nextCap > g.skillCap;

  UI.listPanel(core ? `${core.name} — ${lv}강` : '핵이 없다', core ? [
    UI.rowHTML('마력', `${g.manaUsed} / <b>${g.manaMax}</b>`,
      maxed ? '' : `다음 단계 +${CORE_MANA_STEP}`, g.manaOver),
    UI.rowHTML('핵 체력', `<b>${g.stats.hp}</b>`,
      maxed ? '' : `다음 단계 +${Math.round(CORE_HP_STEP * 100)}%`),
    UI.rowHTML('기술 칸', `<b>${g.active.length} / ${g.skillCap}</b>`,
      maxed ? '' : capUp ? `다음 단계에 <b>${nextCap}칸</b>` : `${SKILL_CAP_STEP}강마다 한 칸`, g.over),
    UI.rowHTML('─', '<b>다음 단계</b>', maxed ? '끝까지 올렸다' : `${lv} → ${lv + 1}강`),
    ...(maxed ? [] : [
      UI.rowHTML('성공', `<b>${rate}%</b>`, '실패해도 단계는 그대로다'),
      UI.rowHTML('핵 가루', `<b>${cost.dust}</b>`, lackDust ?? `가진 것 ${dust}`, Boolean(lackDust)),
      UI.rowHTML('재료', `<b>골분 ${cost.boneMeal} · 진액 ${cost.ichor} · 은화 ${cost.silver}</b>`,
        lackMat ?? '치를 수 있다', Boolean(lackMat)),
    ]),
  ] : [], `<p class="note">한 단계마다 <b>마력 +${CORE_MANA_STEP} · 핵 체력 +${Math.round(CORE_HP_STEP * 100)}%</b>,
      그리고 <b>${SKILL_CAP_STEP}강마다 기술 한 칸</b>. 최대 ${CORE_MAX_LV}강.<br>
      주재료는 <b>핵 가루</b>다 — 재료 화면의 <b>핵 빻기</b>에서 여분 핵을 빻아 얻는다.<br>
      강화는 <b>이 핵에만</b> 남는다. 다른 핵으로 갈아끼우면 그 핵의 단계를 따른다.<br>
      <b>실패해도 단계는 내려가지 않는다</b> — 잃는 것은 재료뿐이다.</p>`);

  UI.logHead('핵 강화');
  UI.logLine('핵을 불에 가까이 대면 안쪽에서 무언가 천천히 돈다.', 'narrate');
  if (!core) UI.logLine('강화할 핵이 없다. 골렘에 핵부터 끼워야 한다.', 'bad');
  else if (maxed) UI.logLine('이 핵은 더 받아들이지 못한다. 더 좋은 핵을 구해야 한다.', 'dim');
  else if (capUp) UI.logLine(`다음 단계에서 기술 칸이 ${g.skillCap} → ${nextCap}로 늘어난다.`, 'necro');

  UI.choices([
    { label: `${lv} → ${lv + 1}강으로 올린다`, cls: 'primary',
      meta: block ?? `성공 ${rate}% · 가루 ${cost.dust} · 골분 ${cost.boneMeal} · 진액 ${cost.ichor} · 은화 ${cost.silver}`,
      disabled: Boolean(block),
      on: () => {
        S.coreDust -= cost.dust;
        S.boneMeal -= cost.boneMeal; S.ichor -= cost.ichor; S.silver -= cost.silver;
        const rng = makeRng((Date.now() ^ (S.seed ?? 1)) >>> 0);
        if (rng.chance(rate)) {
          S.coreUpgrades[coreId] = lv + 1;
          const after = assembleGolem(S);
          UI.logLine(`${core.name}이(가) 더 많은 것을 품는다. ${lv + 1}강 — 마력 ${after.manaMax} · 체력 ${after.stats.hp}.`, 'good');
          if (after.skillCap > g.skillCap) UI.logLine(`기술 칸이 하나 늘었다. ${after.skillCap}칸.`, 'necro');
        } else {
          UI.logLine(`핵이 받아들이지 않았다. ${lv}강 그대로다 — 재료만 탔다.`, 'bad');
        }
        save();
        coreUpScreen();
      } },
    { label: '핵 빻기로', cls: 'ghost', meta: `여분 핵 ${S.cores.length}개 · 가루 ${dust}`,
      on: grindScreen },
    { label: '돌아간다', cls: 'ghost', pin: true, on: forgeJobScreen },
  ], { stage: true, stageTitle: core ? `${core.name} — ${lv}강` : '핵 강화' });
  save();
}

/* ── 부속 한 장 들여다보기 ─────────────────────────────/* ── 부속 한 장 들여다보기 ─────────────────────────────
   이름만 보고는 그 부속이 무슨 기술을 들고 오는지 알 수가 없었다.
   소지품에서 눌러 능력치·기술·상태를 한 화면에 펼친다. */
/**
 * 부속 하나를 낱낱이 보여 준다.
 * `action`을 주면 **여기가 곧 확인 화면**이 된다 — 목록에서 이름이 잘려
 * 무엇인지 모른 채 누르는 일을 없애려는 것이다. (§12.6)
 */
function partDetailScreen(part, back, action = null) {
  const def = DB.partsBy[part.defId];
  const st = partStats(part);
  const slot = SLOT_OF_KIND(def.slot);
  const mod = part.mod ? DB.modifiersBy[part.mod] : null;
  const equipped = SLOTS.some((x) => S.golem[x] === part.uid);

  UI.topbar(S, action?.title ?? '소지품 · 부속');
  const rows = [
    /* 등급은 색이 붙은 조각이라 곁말 자리에 그냥 넣으면 태그가 글자로 나온다 (§12.18-B) */
    UI.rowHTML('자리', KIND_LABEL[def.slot], UI.RARITY_LABEL[def.rarity], false, null,
      `<span class="rar ${def.rarity}">${UI.RARITY_LABEL[def.rarity]}</span>`),
    UI.rowHTML('요구 마력', String(partMana(part)), '핵이 감당해야 한다'),
    // 둘은 서로 다른 축이다 — 내구도는 '쓰면 닳고', 방어도는 '맞으면 깎인다' (§3.3-A)
    UI.rowHTML('내구도', `${part.integrity}/${part.maxIntegrity}`,
      wornLow(part) ? '위험 · 쓰면 닳는다' : '쓰면 닳는다', wornLow(part)),
    UI.rowHTML('방어도', `${shieldNow(part, slot)}/${shieldMax(part, slot)}`,
      equipped ? '장착 중 · 맞으면 깎인다' : '맞으면 깎인다'),
    ...Object.entries(st).filter(([, v]) => v).map(([k, v]) =>
      UI.rowHTML(STAT_LABEL[k] ?? k, `${v > 0 ? '+' : ''}${v}`, '')),
  ];
  if (def.def_element) rows.push(UI.rowHTML('방어 속성', def.def_element, '몸통만 가진다'));
  if (mod) rows.push(UI.rowHTML('이상', UI.esc(mod.prefix), mod.added_skill ? '기술 추가' : ''));
  // 수식어와 주인의 속성이 겹쳤는지 엇갈렸는지 (§3.8)
  const fl = partFlavor(part);
  if (fl.kind === 'merge') rows.push(UI.rowHTML('겹침', UI.esc(fl.note), '효과 1.5배'));
  if (fl.kind === 'clash') rows.push(UI.rowHTML('엇갈림', UI.esc(fl.note), '효과 절반', true));
    if (part.plus) {
    rows.push(UI.rowHTML('강화', `<b>+${part.plus}</b>`,
      `능력치 +${Math.round(EN.PLUS_STAT * part.plus * 100)}% · 위력 +${Math.round(EN.PLUS_POWER * part.plus * 100)}%`));
  }

  UI.listPanel(partName(part), rows,
    part.raw
      ? `<p class="note"><b>날것이다.</b> 능력치는 위 숫자대로 60%만 나오고,
         기술은 넷 중 하나꼴로 불발되며 내구도가 두 배로 닳는다.<br>
         납골당 → 공방 → 단련로 → <b>정착</b>을 거쳐야 온전해진다.</p>`
      : '<p class="note">정착된 부속이다. 제 성능이 그대로 나온다.</p>',
    null, null, UI.partHTML(part));      // 제목도 제 등급 색으로 (§12.18-B)

  UI.logHead(partName(part));
  const from = (def.drop_from ?? []).map((id) => DB.monstersBy[id]?.name).filter(Boolean);
  UI.logLine(from.length ? `${from.join(', ')}에게서 나오는 부속이다.` : '무덤 밖에서 온 것이다.', 'narrate');
  // 두 숫자를 나란히 보여 주면 반드시 헷갈린다. 처음 한 번은 차이를 말해 준다 (§16.5)
  if (!S.log.hintWear) {
    S.log.hintWear = true;
    UI.logLine('— 내구도와 방어도는 다른 것을 센다 —', 'necro');
    UI.logLine('▸ 방어도는 맞으면 깎인다. 0이 되면 그 부위가 무너져 기술을 못 쓰고, 넘친 피해는 핵으로 간다. 수리하면 돌아온다.', 'necro');
    UI.logLine('▸ 내구도는 쓰면 닳는다. 그 전투에서 실제로 쓴 부속만 1씩(날것은 2). 0이 되면 부속이 영영 사라진다.', 'necro');
    UI.logLine('맞는다고 내구도가 닳지는 않는다. 다만 산성 웅덩이 같은 함정과 자율 탐험은 내구도를 직접 갉는다.', 'dim');
    save();
  }
  const skills = partSkills(part);
  if (!skills.length) UI.logLine('이 부속은 기술을 들고 오지 않는다. 능력치만 올린다.', 'dim');
  else {
    UI.logLine('— 이 부속이 주는 기술 —', 'necro');
    for (const sid of skills) {
      const sk = DB.skillsBy[sid];
      const el = skillElement(S, sid);
      const parts2 = [
        `속성 ${el}`,
        sk.power ? `위력 ${sk.power}${sk.hits > 1 ? ` ×${sk.hits}타` : ''}` : '피해 없음',
        `명중 ${sk.accuracy}`,
        sk.charges === null ? '무제한' : `충전 ${sk.charges}`,
      ];
      UI.logLine(`${sk.name} — ${parts2.join(' · ')}`, 'good');
      const eff = (sk.effects ?? []).map(describeEffect).filter(Boolean);
      if (eff.length) UI.logLine(`   ${eff.join(', ')}`, 'dim');
    }
  }

  if (action) {
    UI.logLine(action.ask, 'bad');
    if (action.note) UI.logLine(action.note, 'dim');
  }
  UI.choices([
    action ? { label: action.label, cls: action.cls ?? 'primary', meta: action.meta, on: action.on } : null,
    { label: action ? '아니오' : '돌아간다', cls: 'ghost', pin: true, on: back },
  ]);
}

/* ── 스킬을 읽는 법 (§12.23) ───────────────────────────
   기술 이름만 늘어놓고 「어느 것을 봉인할까」를 묻고 있었다.
   위력도 속성도 충전도 모르는 채로는 고를 수가 없다.
   한 곳에서 만들어 목록·쪽지·상세가 **같은 말을 하게** 한다. */
const skillFacts = (sid) => {
  const sk = DB.skillsBy[sid];
  if (!sk) return [];
  return [
    `속성 ${skillElement(S, sid)}`,
    sk.power ? `위력 ${sk.power}${sk.hits > 1 ? ` ×${sk.hits}타` : ''}` : '피해 없음',
    `명중 ${sk.accuracy}`,
    sk.charges === null ? '충전 무제한' : `충전 ${sk.charges}`,
    ...(sk.priority ? [`우선도 ${sk.priority > 0 ? '+' : ''}${sk.priority}`] : []),
  ];
};
const skillEffects = (sid) => (DB.skillsBy[sid]?.effects ?? []).map(describeEffect).filter(Boolean);
/** 스킬 쪽지 — 어디서 눌러도 같은 내용이 나온다 */
function skillTip(sid, note = '') {
  const sk = DB.skillsBy[sid];
  if (!sk) return '';
  const eff = skillEffects(sid);
  return `<span class="tt">${UI.esc(sk.name)}</span>`
    + `<span class="tm">${UI.esc(skillFacts(sid).join(' · '))}</span>`
    + (eff.length ? `<div class="trow"><span>${UI.esc(eff.join(', '))}</span></div>` : '')
    + (sk.text ? `<div class="trow"><span>${UI.esc(josa(sk.text.replace('{user}', '골렘').replace('{target}', '상대')))}</span></div>` : '')
    + (note ? `<div class="trow"><span>${note}</span></div>` : '');
}

/** 스킬 하나를 자세히 — 어느 부속이 주는 것인지까지 (§12.23) */
function skillDetailScreen(sid, back, banned = false) {
  const sk = DB.skillsBy[sid];
  const g = assembleGolem(S);
  UI.topbar(S, `기술 · ${sk.name}`);
  const from = g.worn.filter(({ part }) => partSkills(part).includes(sid));
  const eff = skillEffects(sid);
  UI.listPanel(sk.name, [
    UI.rowHTML('상태', banned ? '<span class="chip warn">봉인됨</span> 전투에서 못 쓴다'
      : '<span class="chip good">쓴다</span> 전투 목록에 오른다', ''),
    UI.rowHTML('속성', UI.esc(skillElement(S, sid)), ''),
    UI.rowHTML('위력', sk.power ? `<b>${sk.power}</b>${sk.hits > 1 ? ` ×${sk.hits}타` : ''}` : '피해 없음',
      sk.power ? '' : '보조 기술'),
    UI.rowHTML('명중', String(sk.accuracy), sk.accuracy >= 95 ? '거의 빗나가지 않는다' : ''),
    UI.rowHTML('충전', sk.charges === null ? '무제한' : `${sk.charges}회`,
      sk.charges === null ? '언제나 쓴다' : `${sk.recharge ?? 0}턴마다 한 발 찬다`),
    ...(sk.priority ? [UI.rowHTML('우선도', `${sk.priority > 0 ? '+' : ''}${sk.priority}`,
      sk.priority > 0 ? '속도와 상관없이 먼저 친다' : '나중에 친다')] : []),
    ...eff.map((e) => UI.rowHTML('효과', UI.esc(e), '')),
    ...from.map(({ slot, part }) => UI.rowHTML(SLOT_LABEL[slot], UI.partHTML(part),
      part.plus ? `+${part.plus} · 위력 +${Math.round(EN.PLUS_POWER * part.plus * 100)}%` : '')),
  ], `<p class="note">${UI.esc(josa((sk.text ?? '').replace('{user}', '골렘').replace('{target}', '상대')))}</p>
      ${from.length ? `<p class="note">이 기술은 위 부속에서 나온다. 부속을 떼면 기술도 사라진다.<br>
      같은 기술을 여러 부속이 함께 내놓으면 <b>겹쳐서 세진다</b>.</p>` : ''}`);
  UI.logHead(sk.name);
  UI.logLine(skillFacts(sid).join(' · '), 'good');
  if (eff.length) UI.logLine(eff.join(', '), 'dim');
  UI.choices([{ label: '돌아간다', cls: 'ghost', pin: true, on: back }],
    { stage: true, stageTitle: sk.name });
}

/** 효과 한 줄 설명 */
function describeEffect(e) {
  if (e.op === 'status') {
    return `${e.id} 부여 (${e.chance}%${e.stacks ? ` · ${e.stacks}중첩` : ''}${e.duration ? ` · ${e.duration}턴` : ''})`;
  }
  if (e.op === 'rank') {
    const who = e.target === 'enemy' ? '상대' : '자신';
    return `${who} ${STAT_LABEL[e.stat] ?? e.stat} ${e.delta > 0 ? '+' : ''}${e.delta}단계`;
  }
  if (e.op === 'lifesteal') return `피해의 ${Math.round(e.ratio * 100)}%만큼 회복`;
  if (e.op === 'crit_bonus') return '급소 확률 증가';
  if (e.op === 'reveal') return '상대의 방어 속성을 드러낸다';
  return null;
}

/** 부위 종류로 대표 슬롯 하나를 고른다 (방어도 계산용) */
const SLOT_OF_KIND = (kind) => SLOTS.find((s2) => SLOT_KIND[s2] === kind) ?? 'body';

/* ── 파츠 비교 — "이게 나은가?"를 암산시키지 않는다 ──────── */
const DIFF_KEYS = ['atk', 'def', 'eva', 'spd', 'focus'];

/** 이 부속으로 갈아끼웠을 때 골렘 전체가 어떻게 변하는가 */
function swapDelta(slot, part) {
  const keep = S.golem[slot];
  const before = assembleGolem(S);
  S.golem[slot] = part.uid;
  const after = assembleGolem(S);
  S.golem[slot] = keep;

  const stat = {};
  for (const k of DIFF_KEYS) stat[k] = (after.stats[k] ?? 0) - (before.stats[k] ?? 0);
  const curSkills = new Set(before.active);
  return {
    stat,
    shield: after.shieldTotal - before.shieldTotal,
    defElement: after.defElement !== before.defElement
      ? { from: before.defElement, to: after.defElement } : null,
    gained: after.active.filter((x) => !curSkills.has(x)),
    lost: before.active.filter((x) => !after.active.includes(x)),
  };
}

const sign = (n) => (n > 0 ? `+${n}` : `${n}`);

/** 버튼 meta에 들어갈 한 줄 요약 — 변한 것만 적는다 */
function diffText(slot, part) {
  const d = swapDelta(slot, part);
  const bits = DIFF_KEYS.filter((k) => d.stat[k]).map((k) => `${STAT_LABEL[k]}${sign(d.stat[k])}`);
  if (d.shield) bits.push(`방어도${sign(d.shield)}`);
  return bits.length ? bits.join(' ') : '변화 없음';
}

/** 왼쪽 패널에 띄우는 전후 비교 */
function previewSwap(slot, part, before) {
  const d = swapDelta(slot, part);
  const cur = S.golem[slot] ? findPart(S.golem[slot]) : null;
  const rows = [
    UI.rowHTML('지금', cur ? UI.partHTML(cur) : '<span class="empty">비어 있음</span>', ''),
    UI.rowHTML('바꾸면', UI.partHTML(part), part.raw ? '날것' : '정착', part.raw),
  ];
  for (const k of DIFF_KEYS) {
    if (!d.stat[k]) continue;
    rows.push(UI.rowHTML(STAT_LABEL[k],
      `${before.stats[k] ?? 0} → ${(before.stats[k] ?? 0) + d.stat[k]}`,
      sign(d.stat[k]), d.stat[k] < 0));
  }
  if (d.shield) {
    rows.push(UI.rowHTML('방어도', `${before.shieldTotal} → ${before.shieldTotal + d.shield}`,
      sign(d.shield), d.shield < 0));
  }
  if (d.defElement) {
    rows.push(UI.rowHTML('방어 속성', `${d.defElement.from ?? '없음'} → ${d.defElement.to ?? '없음'}`, '바뀜', true));
  }
  const nm = (id) => DB.skillsBy[id]?.name ?? id;
  if (d.gained.length) rows.push(UI.rowHTML('얻는 기술', d.gained.map(nm).map(UI.esc).join(', '), ''));
  if (d.lost.length) rows.push(UI.rowHTML('잃는 기술', d.lost.map(nm).map(UI.esc).join(', '), '', true));

  UI.listPanel('바꾸면 이렇게 된다', rows,
    `<p class="note">${part.raw
      ? '날것이라 성능은 60%만 나온다. 위 숫자는 그것을 반영한 값이다.'
      : '숫자는 골렘 전체 기준이다.'}</p>`);
}

/* ── 속성 상성표 — 게임 안에서 볼 수 있어야 한다 ────────── */
function affinityScreen(back) {
  UI.topbar(S, '상성표');
  const els = DB.elements.elements;
  const cell = (a, d) => {
    const m = DB.elements.matrix[a]?.[d] ?? DB.elements.default;
    if (m === 1) return '<td class="af1">·</td>';
    const cls = m > 1 ? 'afup' : m === 0 ? 'afzero' : 'afdown';
    return `<td class="${cls}">${m === 0 ? '✕' : `×${m}`}</td>`;
  };
  UI.panel(`<p class="pt">속성 상성</p>
    <div class="aftable"><table>
      <tr><th class="afc">공↓ 방→</th>${els.map((d) => `<th>${d}</th>`).join('')}</tr>
      ${els.map((a) => `<tr><th>${a}</th>${els.map((d) => cell(a, d)).join('')}</tr>`).join('')}
    </table></div>
    <p class="note">세로가 공격 속성, 가로가 상대의 방어 속성이다.<br>
      방어 속성은 <b>몸통</b>이 혼자 정한다 (§5.3).</p>`);

  UI.logHead('속성 상성');
  UI.logLine('일곱 속성이 서로를 먹고 먹힌다.', 'narrate');
  UI.logLine('적의 방어 속성은 한 번 싸워 봐야 알 수 있다. 전투 중 \'관찰\'로도 알아낼 수 있다.', 'dim');
  const mine = assembleGolem(S).defElement;
  if (mine) {
    const weak = els.filter((a) => (DB.elements.matrix[a]?.[mine] ?? 1) > 1);
    UI.logLine(`지금 내 몸통은 ${mine}이다. ${weak.length ? `${weak.join(', ')}에 약하다.` : '특별히 약한 속성은 없다.'}`,
      weak.length ? 'bad' : 'good');
  }
  UI.choices([{ label: '돌아간다', cls: 'ghost', pin: true, on: back }]);
}

/* ── 기록 보관 — 세이브 내보내기·가져오기 ────────────────
   세이브는 이 브라우저의 localStorage 한 곳에만 있다. 사이트 데이터를
   지우면 전부 사라지고, 되돌릴 방법이 없다. 몇 줄이면 그 사고를 막는다.
   샌드박스에서는 파일 다운로드가 막히므로 **텍스트를 직접 주고받는다.** */
function backupScreen() {
  UI.topbar(S, '시체골 · 기록 보관');
  const pr = CP.progress(S);
  UI.listPanel('지금 기록', [
    UI.rowHTML('진행', `${pr.done}/${pr.total} 단계`, ''),
    UI.rowHTML('탐험', `${S.log.runs}회`, `처치 ${S.log.kills}`),
    UI.rowHTML('소지', `부속 ${S.inventory.length}개`, `핵 ${S.cores.length}`),
  ], `<p class="note">세이브는 이 브라우저에만 있다. 브라우저가 사이트 데이터를 지우면
      같이 사라지므로, 가끔 내보내 어딘가에 붙여 두는 편이 안전하다.</p>`);

  UI.logHead('기록 보관');
  UI.logLine(`판 ${PWA.version()}${PWA.hasUpdate() ? ' — 새 판이 와 있다' : ''}`, 'dim');
  UI.logLine('네크로맨서의 장부.', 'narrate');
  UI.choices([
    { label: '내보내기', cls: 'primary', meta: '글상자에 띄운다', on: exportSave },
    { label: '가져오기', meta: '붙여넣은 것으로 덮어쓴다', on: importSave },
    { label: '처음부터 다시', cls: 'danger', meta: '기록을 지운다', on: resetScreen },
    PWA.isInstalled()
      ? { label: '앱으로 실행 중', meta: '홈 화면에서 열었다', disabled: true, nokey: true }
      : { label: '📲 앱으로 설치', cls: PWA.canInstall() ? 'primary' : '',
          meta: PWA.canInstall() ? '홈 화면에 둔다' : '브라우저 메뉴 → 홈 화면에 추가',
          disabled: !PWA.canInstall(), on: installApp },
    { label: '돌아간다', cls: 'ghost', pin: true, on: () => town(false) },
  ]);
}

/** 홈 화면에 설치한다 (§12.7) */
async function installApp() {
  const ok = await PWA.install();
  UI.logLine(ok
    ? '시체골이 홈 화면에 자리를 잡았다. 이제 브라우저 없이 바로 열 수 있다.'
    : '설치를 미뤘다. 필요하면 기록 보관에서 다시 부를 수 있다.', ok ? 'good' : 'dim');
  town(false);
}

/**
 * 처음부터 다시 — 테스트할 때 쓴다.
 * 되돌릴 수 없는 일이므로 **한 번 묻고**, 지우기 전에 지금 것을 한 칸 옆에 남긴다.
 */
function resetScreen() {
  UI.topbar(S, '시체골 · 처음부터 다시');
  const pr = CP.progress(S);
  UI.listPanel('지울 기록', [
    UI.rowHTML('진행', `${pr.done}/${pr.total} 단계`, ''),
    UI.rowHTML('탐험', `${S.log.runs}회`, `처치 ${S.log.kills}`),
    UI.rowHTML('소지', `부속 ${S.inventory.length}개`, `핵 ${S.cores.length}`),
    UI.rowHTML('재화', `은화 ${S.silver}`, `영혼재 ${S.soulAsh}`),
  ], '<p class="note">지운 기록은 한 칸 옆(<code>.before-reset</code>)에 남는다. 가져오기로 되살릴 수 있다.</p>');
  UI.logHead('처음부터 다시');
  UI.logLine('장부를 통째로 태운다. 골렘도, 부속도, 걸어 둔 작업도 전부 사라진다.', 'narrate');
  UI.logLine('정말로 지울까?', 'bad');
  UI.choices([
    { label: '예, 전부 지운다', cls: 'danger', meta: '되돌릴 수 없다', on: () => {
      try { localStorage.setItem(`${SAVE_KEY}.before-reset`, JSON.stringify(S)); } catch { /* 무시 */ }
      S = newSave();
      resyncUids(S);
      save();
      UI.clearLog();
      UI.logHead('Project Patchwork');
      UI.logLine('장부가 타고, 재만 남는다. 다시 처음이다.', 'narrate');
      UI.logLine('지우기 전의 기록은 한 칸 옆에 남겨 두었다.', 'dim');
      town(false);
    } },
    { label: '아니오', cls: 'ghost', pin: true, on: backupScreen },
  ]);
}

function exportSave() {
  UI.onTextClosed.length = 0;
  UI.onTextClosed.push(backupScreen);
  save();
  const text = JSON.stringify(S);
  UI.logLine(`기록 ${text.length}자. 아래 상자의 내용을 통째로 복사해 두어라.`, 'good');
  UI.showText('내보낸 기록', text);
}

function importSave() {
  UI.onTextClosed.length = 0;
  UI.onTextClosed.push(backupScreen);
  UI.askText('가져올 기록을 붙여넣어라', (text) => {
    if (!text?.trim()) { UI.logLine('아무것도 붙여넣지 않았다.', 'dim'); return; }
    let parsed;
    try { parsed = JSON.parse(text); } catch {
      UI.logLine('기록을 읽을 수 없다. 복사가 중간에 끊긴 것 같다.', 'bad'); return;
    }
    if (!parsed || typeof parsed !== 'object' || !parsed.golem) {
      UI.logLine('이 게임의 기록이 아니다.', 'bad'); return;
    }
    // 덮어쓰기 전에 지금 것을 한 칸 옆에 남긴다 — 되돌릴 수 없는 일은 만들지 않는다
    try { localStorage.setItem(`${SAVE_KEY}.before-import`, JSON.stringify(S)); } catch { /* 무시 */ }
    S = migrate(parsed);
    resyncUids(S);
    save();
    UI.logLine('기록을 가져왔다. 이전 것은 한 칸 옆에 남겨 두었다.', 'good');
    town(false);
  });
}

/* ── 오늘의 일 — 하루 한 번 들를 이유 (§10.2-A) ──────── */
function dailyScreen() {
  UI.topbar(S, '시체골 · 오늘의 일');
  const list = S.daily?.list ?? [];
  const unclaimed = list.filter((q) => q.done && !q.claimed);

  UI.listPanel(`오늘의 일 (${S.daily?.day ?? '-'})`,
    list.map((q) => UI.rowHTML(q.done ? '완료' : `${q.progress}/${q.goal}`,
      UI.esc(q.title), q.claimed ? '수령함' : rewardText(q.reward), !q.done)),
    `<p class="note">자정이 지나면 새로 걸린다. 받지 않은 보상은 같이 사라진다.<br>
      의뢰소의 의뢰와 달리 <b>하루치</b>이고, 보상은 방치 재료 쪽으로 기운다.</p>`);

  UI.logHead('오늘의 일');
  UI.logLine('게시판 한쪽에 매일 새로 붙는 종이들. 바르그가 대신 떼다 준다.', 'narrate');
  for (const q of list) {
    UI.logLine(`${q.done ? '✔' : '·'} ${q.title} — ${q.desc} (${q.progress}/${q.goal})`,
      q.done ? 'good' : '');
  }

  UI.choices([
    { label: `보상 수령 (${unclaimed.length}건)`, cls: 'primary', disabled: !unclaimed.length,
      on: () => {
        const got = claimDaily(S);
        const got2 = Object.entries(got).filter(([, v]) => v > 0)
          .map(([k, v]) => `${RES_LABEL[k] ?? k} ${v}`).join(', ');
        UI.logLine(`오늘의 보상을 받았다 — ${got2}`, 'good');
        save();
        dailyScreen();
      } },
    { label: '돌아간다', cls: 'ghost', pin: true, on: boardScreen },
  ]);
  save();
}

const RES_LABEL = { silver: '은화', soulAsh: '영혼재', scrap: '시체 조각', ichor: '부패 진액', boneMeal: '골분' };
/* 버튼 곁말에 들어갈 짧은 이름 — '시체 조각 8 모자라다'는 잘려서 못 읽는다 */
const RES_SHORT = { silver: '은화', soulAsh: '영혼재', scrap: '조각', ichor: '진액', boneMeal: '골분' };

/**
 * 무엇이 **얼마나** 모자란지 한 줄로. 전부 있으면 null.
 *
 * 그냥 '재료가 모자라다'라고만 적으면 무엇을 구해 와야 하는지 알 수 없어
 * 창을 나갔다 들어오며 재화를 일일이 대조하게 된다. 부족분을 숫자로 적는다. (§16.5)
 */
/**
 * 값을 통째로 적는다 — 「은화 120 · 조각 20」 (§12.12).
 * 은화만 적고 재료를 숨기면, 누른 뒤에야 무엇이 빠져나갔는지 안다.
 */
function priceText(cost) {
  return Object.entries(cost ?? {}).filter(([, v]) => v)
    .map(([k, v]) => `${RES_SHORT[k] ?? k} ${v}`).join(' · ');
}

function shortText(cost) {
  const out = [];
  for (const [k, v] of Object.entries(cost ?? {})) {
    const lack = v - (S[k] ?? 0);
    if (lack > 0) out.push(`${RES_SHORT[k] ?? k} ${lack}`);
  }
  return out.length ? `${out.join(' · ')} 모자라다` : null;
}
const rewardText = (r) => Object.entries(r).filter(([, v]) => v > 0)
  .map(([k, v]) => `${RES_LABEL[k] ?? k} ${v}`).join(' · ');

/* ── 튜토리얼 (§7-B) ─────────────────────────────────
   컷신처럼 한 걸음씩. 한 화면에 단추 하나뿐이라 고를 것이 없다 —
   처음 켠 사람에게 필요한 것은 자유가 아니라 **다음 한 걸음**이다.
   대본은 src/tutorial.js에 글로 있고, 여기는 그 글을 화면에 올리는 장치다. */

/** 대본이 가리키는 왼쪽 패널을 그린다 — 설명하는 곳과 나중에 들어갈 곳이 같아야 한다 */
function tutorialPanel(kind) {
  switch (kind) {
    case 'golem': UI.golemPanel(S); break;
    case 'ossuary': ossPanel(); break;
    case 'town': UI.townPanel(S, { ...buildingStatus(S), scavenger: '', ossuary: '', quest: '', market: '', inventory: '' }); break;
    case 'workshop': UI.listPanel('납골당 · 공방', [
      UI.rowHTML('⚒ 단련로', '정착 · 강화', `${O.forgeSlots(S.ossuary)}칸`),
      UI.rowHTML('🔩 조립대', '핵으로 골렘을 세운다', `${O.workshopGolems(S).length}/${O.golemCap(S.ossuary)}기`),
      UI.rowHTML('🛠 골렘 정비', '부속을 붙이고 뗀다', ''),
      UI.rowHTML('⚒ 정비대', '방어도 · 내구도 · 핵', ''),
    ], '<p class="note">부속을 손보는 일은 전부 이 문 안에 있다.</p>'); break;
    case 'materials': UI.listPanel('납골당 · 재료', [
      UI.rowHTML('🫗 부패조', '두면 진액이 고인다', `${S.ossuary.rotVat.stored}/${O.vatCap(S.ossuary)}`),
      UI.rowHTML('🔪 해체대', '부속을 갈라 재료로', `${O.dissectionSlots(S.ossuary)}칸`),
      UI.rowHTML('⛓ 자율 탐험', '깬 단계로 골렘을 보낸다', '잠김'),
    ], '<p class="note"><b>걸어 두고 나가야</b> 돈다. 꺼 놔도 시간은 흐른다.</p>'); break;
    case 'cart': UI.listPanel('바르그의 수레', [
      UI.rowHTML('핵', S.golem.core ? UI.esc(DB.coresBy[S.golem.core].name) : '<span class="empty">없음</span>', ''),
      UI.rowHTML('골렘', `부속 ${wornCount()}개`, S.golem.armR ? '' : '우완 비었음', !S.golem.armR),
      UI.rowHTML('가진 것', `부속 ${S.inventory.length}개`, `은화 ${S.silver}`),
    ], '<p class="note">낡은 수레 하나에 뼈와 쇠붙이가 실려 있다.</p>'); break;
    default: UI.listPanel('시체골', [], '<p class="note">굴뚝 연기가 낮게 깔린다.</p>');
  }
}

/** 바르그가 건네는 팔 한 짝 — 날것으로 준다 (스킵하면 정착된 채로 준다) */
function giveTutorialArm(settled = false) {
  const arm = makePart(TUT.GIFT_ARM);
  arm.raw = !settled;
  S.inventory.push(arm);
  return arm;
}

const tutorialArm = () => S.inventory.find((p) => p.defId === TUT.GIFT_ARM);

/** 대본이 진짜 화면 위에서 도는 걸음이면, 그 화면을 그대로 연다 (§7-B.2) */
function tutorialRealScreen(name) {
  switch (name) {
    case 'town': town(false); return true;
    case 'ossuary': ossuaryScreen(); return true;
    case 'workshopHub': workshopHubScreen(); return true;
    case 'forge': forgeJobScreen(); return true;
    case 'materials': materialsScreen(); return true;
    case 'altar': altarScreen(); return true;
    case 'golem': golemScreen(() => tutorialScreen()); return true;
    case 'armR': slotScreen('armR', () => tutorialScreen()); return true;
    default: return false;
  }
}

function tutorialScreen() {
  const step = TUT.STEPS[S.tutorial.step];
  if (!step) { finishTutorial(); return; }
  UI.setCombatMode(false);
  UI.clearSpotlight();

  const go = (lines = null) => {
    S.tutorial.step++;
    S.tutorial.echo = lines;
    save();
    tutorialScreen();
  };

  /* 진짜 화면 위의 걸음 — 화면을 먼저 열고, 그 위에 대본을 얹는다.
     설명만 읽고 하단의 「다음」을 누르는 것과, **납골당 타일을 직접 누르는 것**은 다른 일이다. */
  /* 로그는 **걸음마다 비운다.** 진짜 화면은 자기 줄을 로그에 쓰므로, 비우지 않으면
     화면을 옮길 때마다 지난 걸음의 대본이 그대로 쌓여 같은 말이 두 번 세 번 읽힌다. */
  UI.clearLog();
  const onReal = step.screen ? tutorialRealScreen(step.screen) : false;
  if (!onReal) {
    UI.topbar(S, step.where);
    tutorialPanel(step.panel);
  }

  const echo = S.tutorial.echo ?? [];
  if (echo.length) {
    UI.logHead('방금');
    for (const [t, c] of echo) UI.logLine(t, c ?? '');
    S.tutorial.echo = null;
  }
  UI.logHead(step.head);
  for (const [t, c] of step.lines) UI.logLine(t, c ?? '');

  if (onReal && step.spot) {
    const target = UI.spotlight(step.spot);
    if (target) {
      UI.logLine('— 밝게 표시된 자리를 누른다 —', 'necro');
      /* 진짜 단추의 진짜 동작이 먼저 돌고, 그 다음 걸음이 이어진다.
         (캡처해서 가로채면 「눌렀다」는 감각만 남고 아무 일도 안 일어난다.) */
      target.addEventListener('click', () => {
        const lines = step.act ? tutorialSideEffect(step) : null;
        setTimeout(() => go(lines), 0);
      }, { once: true });
      save();
      return;
    }
    /* 밝힐 자리를 못 찾았다 — 화면이 바뀌었는데 대본이 안 따라온 것이다.
       길을 잃히느니 단추 하나로 넘긴다. */
    UI.logLine('(가리킬 자리를 찾지 못했다 — 아래 단추로 넘어간다)', 'dim');
  }

  UI.choices([
    {
      label: step.btn ?? '다음', cls: 'primary', meta: step.sub,
      on: () => tutorialAct(step, go),
    },
    ...(S.tutorial.step === 0 ? [{
      label: '건너뛴다', cls: 'ghost', meta: '팔은 받고 시작한다',
      info: '설명을 넘기고 바로 마을로 간다. 바르그가 주기로 한 팔은 정착까지 끝난 채로 받는다.',
      on: skipTutorial,
    }] : []),
  ]);
  save();
}

/** 진짜 단추를 눌렀을 때 대본이 곁들이는 일 (정착을 즉시 끝내는 것 같은) */
function tutorialSideEffect(step) {
  if (step.act === 'equipped') {
    /* 붙이는 것은 **진짜 화면이** 했다. 대본은 그 결과를 다음 화면에 되읽어 줄 뿐이다 —
       화면이 넘어가며 로그가 지워지므로, 여기서 챙기지 않으면 아무도 못 본다. */
    const arm = tutorialArm();
    if (!arm) return null;
    const gained = partSkills(arm).map((sid) => DB.skillsBy[sid].name).join(', ');
    return [[`${partName(arm)}을(를) 우완에 붙였다.`, 'good'],
            ...(gained ? [[`새 기술: ${gained}`, 'good']] : [])];
  }
  if (step.act === 'settle') {
    const arm = tutorialArm();
    if (arm) arm.raw = false;
    // 화덕에 올라간 일감은 도로 내린다 — 바르그가 그 자리에서 끝냈다
    S.ossuary.forge.slots = [];
    return [[`${arm ? partName(arm) : '팔'}이(가) 정착됐다. 이제 온전히 쓸 수 있다.`, 'good'],
            ['보통은 조각 8 · 진액 1에 20분이 든다. 이번만 바르그가 대신 해 주었다.', 'dim']];
  }
  return null;
}

function tutorialAct(step, go) {
  switch (step.act) {
    case 'fight': tutorialFight(); return;
    case 'give': {
      const arm = giveTutorialArm(false);
      go([[`${partName(arm)}을(를) 건네받았다. 아직 날것이다.`, 'good']]);
      return;
    }
    case 'settle': {
      const arm = tutorialArm();
      if (arm) arm.raw = false;
      go([[`${arm ? partName(arm) : '팔'}이(가) 정착됐다. 이제 온전히 쓸 수 있다.`, 'good'],
          ['보통은 조각 8 · 진액 1에 20분이 든다. 이번만 바르그가 대신 해 주었다.', 'dim']]);
      return;
    }
    case 'equip': {
      const arm = tutorialArm();
      const lines = [];
      if (arm) {
        S.golem.armR = arm.uid;
        lines.push([`${partName(arm)}을(를) 우완에 붙였다.`, 'good']);
        const gained = partSkills(arm).map((sid) => DB.skillsBy[sid].name).join(', ');
        if (gained) lines.push([`새 기술: ${gained}`, 'good']);
      }
      go(lines);
      return;
    }
    case 'finish': finishTutorial(); return;
    default: break;
  }
  go();
}

/* 첫 전투 — 진짜 전투 엔진으로 붙는다. 흉내만 내면 배운 것이 남지 않는다.
   다만 런이 아니므로 방 하나짜리 껍데기를 세워 둔다. 이긴 뒤의 전리품·내구도 처리는
   튜토리얼 쪽으로 빠진다 (winBattle 첫 줄에서 갈린다). */
function tutorialFight() {
  const r = makeRng((S.seed ?? 1) * 31 + 7);
  S.run = {
    seed: S.seed ?? 1, floor: 1, golemHp: S.golem.coreHp ?? assembleGolem(S).stats.hp,
    rooms: 0, noLoss: true, kills: 0, summons: 0, cleanWins: 0,
    stage: '1-1', hazard: 0, floorData: null, tutorial: true,
  };
  const mon = rollMonster('1-1', 1, r, S.unlocks);
  UI.resetBars(); UI.resetBodyPick();
  cb = new Combat(S, mon, r);
  cb.room = { type: 'battle', x: 0, y: 0, cleared: false, visited: true };
  UI.clearLog();
  UI.logHead('첫 전투');
  UI.logLine('무덤 어귀의 어둠에서 무언가가 기어 나온다.', 'narrate');
  UI.logLine('아래 단추가 골렘이 쓸 수 있는 기술이다. 하나 골라 보내면 된다.', 'necro');
  UI.logLine('🎯 조준은 어디를 때릴지, 🛡 막기는 어디로 받을지를 정한다.', 'dim');
  combatTurn();
}

/** 첫 전투가 끝났다 — 이기든 지든 바르그가 옆에 있다 */
function tutorialBattleOver(won) {
  cb = null;
  S.run = null;
  UI.setCombatMode(false);
  if (!won) {
    // 첫 전투에서 지는 것으로 판을 망치지 않는다. 핵도 쪼개지 않는다
    S.golem.coreHp = null;
    for (const p of S.inventory) p.shield = null;
    UI.logLine('"이런. 일으켜 주지 — 첫판은 나도 그랬네."', 'dim');
  }
  S.tutorial.step++;
  S.tutorial.echo = won
    ? [['골렘이 그것을 눕혔다. 핵은 멀쩡하다.', 'good']]
    : [['골렘이 주저앉았지만 부서지지는 않았다.', 'dim']];
  save();
  tutorialScreen();
}

function skipTutorial() {
  const arm = giveTutorialArm(true);
  S.golem.armR ??= arm.uid;
  S.tutorial = { step: TUT.STEPS.length, done: true, skipped: true };
  save();
  UI.clearLog();
  UI.logHead('시체골');
  UI.logLine('바르그가 말없이 팔 한 짝을 건넸다. 이미 손질이 끝난 것이다.', 'narrate');
  UI.logLine(`${partName(arm)}을(를) 우완에 붙였다.`, 'good');
  UI.logLine('무엇이 어디에 쓰이는지 모르겠으면 바르그에게 물어보면 된다.', 'dim');
  town(false);
}

function finishTutorial() {
  // 스킵과 같은 자리에서 끝나야 한다 — 끝까지 본 사람이 손해를 보면 안 된다
  if (!tutorialArm()) {
    const arm = giveTutorialArm(true);
    S.golem.armR ??= arm.uid;
  }
  S.tutorial.done = true;
  S.campaign.story.opening = true;    // 바르그의 첫 이야기는 방금 들었다
  save();
  town();
}

/* ── 메인 퀘스트 — 바르그가 전담한다 (§7-A.5) ────────── */
function mainQuestScreen() {
  UI.topbar(S, '시체골 · 바르그의 부탁');
  const pr = CP.progress(S);
  const next = CP.nextStage(S);

  UI.listPanel('걸어온 길', (DB.campaign?.parts ?? []).flatMap((pt) =>
    pt.stages.map((st) => {
      const done = CP.isCleared(S, st.id);
      const open = CP.isOpen(S, st.id);
      return UI.rowHTML(st.id,
        open ? UI.esc(st.name) : '<span class="empty">아직 모르는 곳</span>',
        done ? '완료' : open ? (st.id === next ? '◀ 지금' : '열림') : '', !open);
    })), `<p class="note">${pr.done}/${pr.total} 단계.</p>`);

  /* 의뢰문 (§7-A.6).
     전에는 「시궁 아래. 젖은 입구.」 한 줄과 분위기 설명뿐이라, 읽고 나도 **무엇을 하러
     가는지**가 남지 않았다. 목표는 지명이 아니라 **주문**이어야 한다 —
     어디로 가서, 무엇을 잡고, 무엇을 가져오고, 왜. */
  const bf = CP.brief(S);
  if (!next) {
    UI.logHead('남은 일');
    UI.logLine(S.campaign.ending
      ? '"자네가 무얼 골랐는지는 묻지 않겠네."'
      : '"미궁 끝까지 갔다면서. 남은 건 자네가 정할 일이야."', 'narrate');
  } else if (bf) {
    // 지난 줄거리 한 줄 — 여기까지 어떻게 왔는지를 잊은 채로 다음 의뢰를 받지 않게 한다
    const prev = CP.lastBeat(S);
    // 첫 의뢰에는 지난 이야기가 없다 — 없는 것을 억지로 채우면 바로 위 대사와 겹쳐 읽힌다
    if (prev) {
      UI.logHead('지난 이야기');
      UI.logLine(`${prev.title} — ${prev.lines[0].t}`, 'dim');
    }

    UI.logHead(`의뢰 — ${bf.title}`);
    UI.logLine(`"${bf.order}"`, 'necro');
    UI.logLine(`"${bf.why}"`, '');
    UI.logLine(`▸ 어디로  ${bf.where} (${bf.floors}층)`, 'good');
    UI.logLine(`▸ 잡을 것  ${bf.hunt}`, 'good');
    UI.logLine(`▸ 가져올 것  ${bf.bring}`, 'good');
    if (bf.hazard) UI.logLine(`▸ 조심할 것  【${bf.hazard.name}】 ${bf.hazard.text}`, 'bad');
    UI.logLine(bf.note, 'narrate');
    const rw = bf.stage.reward ?? {};
    UI.logLine(`값은 치르겠네 — 영혼재 ${rw.soulAsh ?? 0} · 은화 ${rw.silver ?? 0}${rw.core ? ' · 핵 하나' : ''}.`, 'dim');
    UI.logLine('바닥까지 내려가 그놈을 눕혀야 끝난 것이다. 중간에 돌아오면 의뢰는 그대로 남는다.', 'dim');
  }

  // 들은 이야기는 언제든 다시 읽을 수 있다 — 한 번 흘려보내면 끝인 것이 가장 나쁘다
  const heard = Object.keys(S.campaign.story).filter((k) => k !== 'opening' && DB.story.beats[k]);
  UI.choices([
    { label: '무덤으로', cls: 'primary', meta: next ? stageOf(next).name : '아홉 단계 완료',
      disabled: !next, on: startRun },
    S.campaign.story.opening ? { label: '처음 이야기를 다시 듣는다', cls: 'ghost', meta: '왜 내려가는가',
      on: () => {
        UI.logHead('처음');
        for (const l of DB.story.opening.lines) UI.logLine(l.t, l.c ?? '');
        mainQuestScreen();
      } } : null,
    ...heard.map((id) => ({
      label: `다시 듣는다 — ${DB.story.beats[id].title}`, cls: 'ghost', meta: id,
      on: () => {
        UI.logHead(DB.story.beats[id].title);
        for (const l of DB.story.beats[id].lines) UI.logLine(l.t, l.c ?? '');
        mainQuestScreen();
      },
    })),
    { label: '돌아간다', cls: 'ghost', pin: true, on: scavengerScreen },
  ]);
  save();
}

/* ── 뼈 수습꾼 바르그 (구제 · 안내 NPC) ── */
function scavengerScreen() {
  UI.topbar(S, '시체골 · 뼈 수습꾼');
  quickHere('scavenger');
  const g = assembleGolem(S);
  const ready = Boolean(S.golem.core) && wornCount() >= MIN_PARTS;
  UI.listPanel('바르그의 수레', [
    UI.rowHTML('핵', g.core ? UI.esc(g.core.name) : '<span class="empty">없음</span>',
      g.core ? '장착' : '!', !g.core),
    UI.rowHTML('장착', `${wornCount()}개`, `최소 ${MIN_PARTS}`, wornCount() < MIN_PARTS),
    UI.rowHTML('소지', `${totalParts()}개`, `정착 ${settledParts()}`, settledParts() < MIN_PARTS),
    UI.rowHTML('상태', ready ? '내려갈 수 있다' : '<span class="empty">아직 못 내려간다</span>', '', !ready),
  ], `<p class="note">핵이 없거나 <b>정착된</b> 부속이 ${MIN_PARTS}개 미만이면 바르그가 모자란 것만 채워 준다.<br>
      날것은 기술이 불발되므로 여기서는 쓸 수 있는 부속으로 세지 않는다.</p>`);

  UI.logHead('뼈 수습꾼 바르그');
  // 처음 만나면 왜 내려가는지부터 말한다 (§7-A.6)
  if (!S.campaign.story.opening) {
    S.campaign.story.opening = true;
    for (const l of DB.story.opening.lines) UI.logLine(l.t, l.c ?? '');
    save();
  }
  const times = S.log.handouts ?? 0;
  if (!S.golem.core || settledParts() < MIN_PARTS) {
    UI.logLine(times === 0
      ? '"빈손이군. 그런 얼굴은 여기서 자주 봐."'
      : times < 4 ? '"또 부서져 왔군. 그럴 줄 알았지."'
      : '"자네 덕에 내 수레가 늘 비어 있어."', 'narrate');
    UI.logLine('바르그가 수레를 뒤적인다. 낡은 핵과 뼈 몇 조각이 굴러 나온다.', 'narrate');
  } else {
    UI.logLine('"멀쩡히 서 있는 걸 보니 아직은 쓸 만한가 보군."', 'narrate');
    UI.logLine('바르그는 무덤에서 돌아오지 못한 자들의 부속을 주워다 판다.', 'dim');
  }

  // 핵이 없거나 부속이 바닥났으면 손을 내민다
  const noCore = !S.golem.core;
  const lowParts = settledParts() < MIN_PARTS;
  const needsHelp = noCore || lowParts;
  UI.choices([
    { label: '지금 할 일을 묻는다', cls: 'primary', meta: `${CP.progress(S).done}/${CP.progress(S).total} 단계`,
      on: mainQuestScreen },
    { label: needsHelp ? '도움을 받는다' : '도움을 청한다',
      meta: needsHelp ? '무료' : '아직 쓸 만하다',
      disabled: !needsHelp,
      on: () => { giveHandout(); scavengerScreen(); } },
    { label: '재화가 뭔지 알려달라', cls: 'ghost', on: () => resourceGuideScreen(scavengerScreen) },
    { label: '부위 조준이 뭐냐', cls: 'ghost', on: () => aimGuideScreen(scavengerScreen) },
    { label: '날것 부속이 뭐냐', cls: 'ghost', on: () => rawGuideScreen(scavengerScreen) },
    { label: '조언을 듣는다', cls: 'ghost', on: () => {
      for (const t of [
        '"작업대가 있는 방에서만 갈아끼울 수 있어. 밖에선 눈으로만 봐."',
        '"핵이 깨지면 골렘은 끝이야. 부속은 좀 주워 오겠지만."',
        '"닳은 건 납골당 정비대에서 고쳐. 여분은 거기서 한꺼번에 메운다."',
        '"방어도는 물약으로 안 돌아와. 작업대나 정비대에서만 고쳐."',
        '"부속 둘은 붙어 있어야 내려갈 수 있어. 하나 남은 골렘은 서 있기만 하지."',
        '"흉곽이 없어도 걸을 수는 있어. 대신 핵이 드러나지 — 맞으면 곧장 핵이 깎여."',
        '"술법은 골렘이 때리는 김에 같이 걸어. 턴을 따로 쓰던 시절은 지났다네."',
      ]) UI.logLine(t, 'narrate');
      UI.choices([{ label: '돌아간다', cls: 'ghost', pin: true, on: () => town(false) }]);
    } },
    { label: '돌아간다', cls: 'ghost', pin: true, on: () => town(false) },
  ]);
  save();
}

/**
 * 바르그의 지원. 모자란 것만 채워 준다 —
 * 핵이 없으면 핵을, 부속이 MIN_PARTS 이하면 최하급 부속을 3개까지.
 */
function giveHandout() {
  const given = [];
  if (!S.golem.core) { S.golem.core = 'core_scrap'; given.push(DB.coresBy.core_scrap.name); }

  // 최하급 정착 부속. 날것만 남으면 기술이 넷 중 하나꼴로 불발돼 진행이 막히므로
  // 이 부속들은 정착 상태로 준다.
  //
  // 주의: '소지 개수'가 아니라 **빈 슬롯**을 보고 채워야 한다.
  // 몸통만 두 개 쥐여 주면 개수는 늘어도 골렘은 여전히 한 자리밖에 못 채운다.
  const BASIC_BY_KIND = {
    body: 'part_body_goblin_torso',
    arm: 'part_arm_goblin_claw',
    leg: 'part_leg_goblin_hop',
    head: 'part_head_goblin_skull',
  };
  const FILL_ORDER = ['body', 'armL', 'legL', 'armR', 'legR', 'head'];

  const equippedNow = () => new Set(SLOTS.map((x) => S.golem[x]).filter(Boolean));
  /** 이 슬롯에 지금 끼울 수 있는 정착 부속이 소지품에 있는가 */
  const spareFor = (slot) => {
    const worn = equippedNow();
    const kind = SLOT_KIND[slot];
    return S.inventory.find((p) => !worn.has(p.uid) && !p.raw && DB.partsBy[p.defId].slot === kind);
  };

  for (const slot of FILL_ORDER) {
    if (wornCount() >= MIN_PARTS) break;
    if (S.golem[slot]) continue;
    let part = spareFor(slot);
    if (!part) {
      const defId = BASIC_BY_KIND[SLOT_KIND[slot]];
      if (!defId) continue;
      part = makePart(defId);
      part.raw = false;                    // 바르그의 수레에서 나온 것은 이미 손이 갔다
      S.inventory.push(part);
      given.push(partName(part));
    }
    S.golem[slot] = part.uid;
  }

  // 남은 빈 자리도 마저 채운다. 정착된 것을 먼저 쓴다 —
  // 날것이 자동으로 끼워져 기술이 불발되는 일을 막는다
  const equipped = equippedNow();
  for (const slot of SLOTS) {
    if (S.golem[slot]) continue;
    const kind = SLOT_KIND[slot];
    const fits = (p) => !equipped.has(p.uid) && DB.partsBy[p.defId].slot === kind;
    const free = S.inventory.find((p) => fits(p) && !p.raw) ?? S.inventory.find(fits);
    if (!free) continue;
    S.golem[slot] = free.uid;
    equipped.add(free.uid);
  }

  S.log.handouts = (S.log.handouts ?? 0) + 1;
  if (given.length) UI.logLine(`바르그가 ${given.join(', ')}을(를) 건넸다.`, 'good');
  else UI.logLine('바르그가 남은 부속을 골렘에 끼워 맞춰 준다.', 'good');
  UI.logLine(`골렘에 ${wornCount()}개가 붙었다.`, wornCount() >= MIN_PARTS ? 'good' : 'bad');
  UI.logLine(S.log.handouts >= 3
    ? '"값은 됐어. 어차피 자네가 물어다 줄 테니까."'
    : '"주워 온 것들이야. 값은 나중에 무덤에서 갚아."', 'dim');
  save();
}

/* ── 납골당 ───────────────────────────────
   시설은 왼쪽 그림에서 눌러 들어간다 (§12.4). 하단은 행동만 남는다. */
const OSS_GO = () => ({
  materials: materialsScreen, workshop: workshopHubScreen, altar: altarScreen,
});
const ossPanel = () => UI.ossuaryPanel(S, O, Date.now(), OSS_GO());

/** 🫗 재료 — 시간이 재료를 만드는 곳을 한자리에 (§9.3-①②④) */
function materialsScreen() {
  const o = S.ossuary;
  UI.topbar(S, '납골당 · 재료');
  quickHere('materials');
  const vatFull = o.rotVat.stored >= O.vatCap(o);
  /* 자율 탐험은 안치소를 세워야 열린다. 그전에는 **줄째로 없었다** —
     플레이어가 보기엔 기능이 사라진 것이지, 아직 못 여는 것이 아니다 (§16.5-C).
     자리는 늘 보여 주고, 왜 못 쓰는지를 적는다. */
  UI.listPanel('재료를 만드는 곳', [
    UI.rowHTML('🫗 부패조', '두면 진액이 고인다', `${o.rotVat.stored}/${O.vatCap(o)}`, vatFull),
    UI.rowHTML('🔪 해체대', '부속을 갈라 재료로', `${o.dissection.slots.length}/${O.dissectionSlots(o)}칸`),
    UI.rowHTML('🪨 핵 빻기', o.grind ? `${o.grind.name}을(를) 빻는 중` : '여분 핵을 가루로',
      o.grind ? O.remainText(o.grind.startedAt, o.grind.durationMs)
        : `여분 핵 ${S.cores.length}개 · 가루 ${S.coreDust ?? 0}`, !o.grind && !S.cores.length),
    UI.rowHTML('🥣 굳히기', o.congeal
      ? `${O.CONGEAL.boneMeal * o.congeal.batches}만큼 졸이는 중`
      : '진액을 졸여 골분으로',
      o.congeal ? O.remainText(o.congeal.startedAt, o.congeal.durationMs)
        : `한 몫 진액 ${O.CONGEAL.ichor} → 골분 ${O.CONGEAL.boneMeal}`,
      !o.congeal && O.congealMax(S) < 1),
    UI.rowHTML('⛓ 자율 탐험', o.built.laborBay
      ? '뚫은 층으로 골렘을 보낸다'
      : '<span class="empty">제단에서 안치소를 세워야 열린다</span>',
      o.built.laborBay ? `${o.laborBay.dispatch.length}/${O.laborSlots(o)}칸` : '잠김',
      !o.built.laborBay),
  ], `<p class="note">조각 ${S.scrap} · 진액 ${S.ichor} · 골분 ${S.boneMeal}.<br>
      <b>걸어 두고 나가야</b> 돈다. 부패조는 상한에 닿으면 생산을 멈춘다.</p>`);

  UI.logHead('재료');
  UI.logLine('통이 끓고, 칼이 놓여 있고, 사슬이 비어 있다.', 'narrate');
  if (vatFull) UI.logLine('부패조가 가득 찼다. 비우지 않으면 더 고이지 않는다.', 'bad');
  if (!o.built.laborBay) {
    UI.logLine(`자율 탐험은 아직 열리지 않았다 — 제단에서 사역 골렘 안치소를 세워야 한다 (영혼재 ${O.FACILITIES.laborBay.unlock}).`, 'dim');
  }

  UI.choices([
    { label: '🫗 부패조', meta: `${o.rotVat.stored}/${O.vatCap(o)}${vatFull ? ' 가득' : ''}`,
      cls: vatFull ? 'primary' : '', info: '아무것도 넣지 않아도 부패 진액이 고인다. 상한에 닿으면 멈춘다.',
      on: vatScreen },
    { label: '🔪 해체대', meta: `${o.dissection.slots.length}/${O.dissectionSlots(o)}칸`,
      info: '부속을 갈라 조각·진액·골분을 얻는다. 희귀할수록 많이 나온다.', on: dissectScreen },
    { label: '⛓ 자율 탐험',
      meta: o.built.laborBay ? `${o.laborBay.dispatch.length}/${O.laborSlots(o)}칸`
        : `제단에서 안치소 건설 (영혼재 ${O.FACILITIES.laborBay.unlock})`,
      disabled: !o.built.laborBay,
      info: o.built.laborBay
        ? '이미 클리어한 단계로 남는 골렘을 보낸다. 길게 보낼수록 많이 얻고 많이 닳는다.'
        : '사역 골렘 안치소를 세워야 열린다. 제단에서 영혼재로 짓는다.',
      on: laborScreen },
    /* 굳히기는 단련로에 있었다. **재료를 만드는 일이므로 여기가 집이다** (§9.15-A).
       그리고 **시간이 든다** (§9.17) — 그러지 않으면 부패조가 쌓아 둔 진액을
       그 자리에서 전부 골분으로 바꿀 수 있어, 걸어 두고 기다린다는 규칙이 무너진다. */
    { label: '🥣 굳히기 — 진액을 졸여 골분으로',
      cls: o.congeal ? 'ghost' : '',
      meta: o.congeal ? `졸이는 중 · ${O.remainText(o.congeal.startedAt, o.congeal.durationMs)}`
        : O.congealMax(S) < 1 ? `진액 ${O.CONGEAL.ichor - S.ichor} 모자라다`
        : `얼마나 졸일지 고른다 (한 몫 진액 ${O.CONGEAL.ichor} → 골분 ${O.CONGEAL.boneMeal})`,
      disabled: !o.congeal && O.congealMax(S) < 1,
      now: true,
      info: '<span class="tt">굳히기</span><div class="trow"><span>부패조는 진액을 끝없이 만드는데 쓰는 곳이 적다. 남는 것을 모자란 것으로 바꾼다.</span></div>',
      on: congealScreen },
    /* 핵 빻기 — **재료를 만드는 일이므로 여기가 집이다** (§3.11-A).
       여분 핵은 세울 자리가 없으면 쓸 곳이 없었다. 이제 가루가 되어 핵 강화로 돌아간다. */
    { label: '🪨 핵 빻기 — 여분 핵을 가루로',
      cls: o.grind ? 'ghost' : '',
      meta: o.grind ? `빻는 중 · ${O.remainText(o.grind.startedAt, o.grind.durationMs)}`
        : !S.cores.length ? '여분 핵이 없다'
        : `여분 핵 ${S.cores.length}개 · 가루 ${S.coreDust ?? 0}`,
      disabled: !o.grind && !S.cores.length,
      now: true,
      info: '<span class="tt">핵 빻기</span><div class="trow"><span>빻아 나온 가루는 단련로의 핵 강화에 쓴다. 좋은 핵일수록 많이 나온다.</span></div>',
      on: grindScreen },
    { label: '돌아간다', cls: 'ghost', pin: true, on: ossuaryScreen },
  ], { stage: true, stageTitle: '재료를 만드는 곳' });
  save();
}

/* ── 핵 빻기 (§3.11-A) ─────────────────────────
   여분 핵을 맷돌에 올린다. 한 번에 하나, 스무 분. */
function grindScreen() {
  const o = S.ossuary;
  UI.topbar(S, '납골당 · 핵 빻기');
  quickHere('materials');
  const job = o.grind;

  if (job) {
    UI.listPanel('맷돌에 올린 것', [
      UI.rowHTML('핵', UI.esc(job.name), '빻는 중'),
      UI.rowHTML('나올 가루', `<b>${job.dust}</b>`, `지금 가진 것 ${S.coreDust ?? 0}`),
      UI.rowHTML('남은 시간', O.remainText(job.startedAt, job.durationMs), '끝나면 정산에 함께 나온다'),
    ], `<p class="note">맷돌은 하나뿐이다. 물리면 <b>핵을 도로 받는다</b> — 잃는 것은 시간뿐이다.</p>`);
  } else {
    UI.listPanel('빻을 수 있는 핵', S.cores.map((cid) => {
      const c = DB.coresBy[cid];
      return UI.rowHTML(UI.RARITY_LABEL[c.rarity] ?? '핵', UI.esc(c.name),
        `가루 ${O.dustOf(c)} · 체력 ${c.hp}`);
    }), `<p class="note">빻으면 <b>핵 가루</b>가 나온다 — 단련로의 <b>핵 강화</b>에 쓰는 주재료다.<br>
        좋은 핵일수록 많이 나오지만, 빻은 핵은 <b>돌아오지 않는다</b>.
        조립대에 세울 자리가 남았다면 골렘으로 세우는 편이 나을 수도 있다.<br>
        지금 가진 가루 <b>${S.coreDust ?? 0}</b> · 여분 핵 ${S.cores.length}개.</p>`);
  }

  UI.logHead('핵 빻기');
  UI.logLine('맷돌에 핵을 올리면 낮은 소리가 오래 난다.', 'narrate');
  if (!job && !S.cores.length) UI.logLine('빻을 여분 핵이 없다.', 'dim');

  UI.choices(job ? [
    { label: '물린다', cls: 'danger', meta: `${job.name}을(를) 도로 받는다`,
      on: () => {
        S.cores.push(job.coreId);
        o.grind = null;
        UI.logLine('맷돌을 멈추고 핵을 도로 꺼냈다.', 'dim');
        save(); grindScreen();
      } },
    { label: '돌아간다', cls: 'ghost', pin: true, on: materialsScreen },
  ] : [
    ...S.cores.map((cid, i) => {
      const c = DB.coresBy[cid];
      return {
        label: `${UI.esc(c.name)} 빻는다`,
        meta: `가루 ${O.dustOf(c)} · ${Math.round(O.jobDuration(S, O.GRIND_MS) / 60000)}분`,
        info: `<span class="tt">${UI.esc(c.name)}</span>`
          + `<div class="trow"><span>체력</span><b>${c.hp}</b></div>`
          + `<div class="trow"><span>마력</span><b>${c.mana}</b></div>`
          + `<div class="trow"><span>빻으면 돌아오지 않는다</span></div>`,
        on: () => {
          S.cores.splice(i, 1);
          o.grind = { coreId: cid, name: c.name, dust: O.dustOf(c),
            startedAt: Date.now(), durationMs: O.jobDuration(S, O.GRIND_MS) };
          UI.logLine(`${c.name}을(를) 맷돌에 올렸다. 가루 ${o.grind.dust}이(가) 나온다.`, 'good');
          save(); grindScreen();
        },
      };
    }),
    { label: '돌아간다', cls: 'ghost', pin: true, on: materialsScreen },
  ], { stage: true, stageTitle: job ? '빻는 중' : '무엇을 빻을까' });
  save();
}

/* ── 굳히기 (§9.17) ───────────────────────────
   얼마나 졸일지는 **눈금자로 정한다.** 한 몫은 진액 8 → 골분 3이고,
   몫이 늘수록 시간이 는다. 통은 하나뿐이라 한 번에 한 솥만 올린다. */
function congealScreen(batches = null) {
  const o = S.ossuary;
  UI.topbar(S, '납골당 · 굳히기');
  quickHere('materials');
  const cap = O.congealMax(S);
  const job = o.congeal;
  let n = Math.max(1, Math.min(cap, batches ?? Math.min(cap, 3)));

  if (job) {
    UI.listPanel('통에 올린 것', [
      UI.rowHTML('졸이는 몫', `<b>${job.batches}몫</b>`, `진액 ${O.CONGEAL.ichor * job.batches}을(를) 넣었다`),
      UI.rowHTML('나올 것', `<b>골분 ${O.CONGEAL.boneMeal * job.batches}</b>`, ''),
      UI.rowHTML('남은 시간', O.remainText(job.startedAt, job.durationMs), '끝나면 정산에 함께 나온다'),
    ], `<p class="note">통은 하나뿐이다 — 지금 올린 것이 끝나야 다음을 올린다.<br>
        물리면 <b>넣은 진액은 돌려받는다</b>. 시간만 버린 셈이 된다.</p>`);
  } else {
    UI.listPanel('얼마나 졸일까', [
      UI.rangeRow('congn', { min: 1, max: Math.max(1, cap), value: n, label: '몫', valueText: `${n}몫` }),
      UI.rowHTML('넣는 진액', '<b id="cong-in"></b>', `가진 것 ${S.ichor}`),
      UI.rowHTML('나오는 골분', '<b id="cong-out"></b>', `가진 것 ${S.boneMeal}`),
      UI.rowHTML('걸리는 시간', '<span id="cong-ms"></span>', '작업반을 붙이면 줄어든다'),
    ], `<p class="note">한 몫은 <b>진액 ${O.CONGEAL.ichor} → 골분 ${O.CONGEAL.boneMeal}</b>.
        한 번에 ${O.CONGEAL.max}몫까지 올릴 수 있다 (지금 가진 진액으로는 ${cap}몫).<br>
        몫이 늘수록 오래 걸리지만, <b>불을 올리는 시간은 한 번뿐</b>이라 몰아서 거는 편이 이득이다.</p>`);
  }

  UI.logHead('굳히기');
  UI.logLine('통 아래 불을 키우면 진액이 걸쭉해진다.', 'narrate');
  if (job) UI.logLine(`${job.batches}몫이 졸고 있다 — ${O.remainText(job.startedAt, job.durationMs)}.`, 'dim');
  else if (cap < 1) UI.logLine(`진액이 ${O.CONGEAL.ichor} 있어야 한 몫을 건다.`, 'bad');

  if (!job) {
    const paint = (v) => {
      n = v;
      UI.setText('congn-out', `${v}몫`);
      UI.setText('cong-in', `진액 ${O.CONGEAL.ichor * v}`);
      UI.setText('cong-out', `골분 ${O.CONGEAL.boneMeal * v}`);
      const ms = O.jobDuration(S, O.congealMs(v));
      UI.setText('cong-ms', `${Math.round(ms / 60000)}분`);
      UI.setText('cong-go', `${v}몫 올린다`);
    };
    UI.bindRange('congn', paint);
    UI.choices([
      { label: '<span id="cong-go">올린다</span>', cls: 'primary',
        meta: cap < 1 ? '진액이 모자라다' : '눈금자로 고른 만큼 통에 올린다',
        disabled: cap < 1,
        on: () => {
          S.ichor -= O.CONGEAL.ichor * n;
          o.congeal = { batches: n, startedAt: Date.now(), durationMs: O.jobDuration(S, O.congealMs(n)) };
          UI.logLine(`${n}몫을 통에 올렸다. ${Math.round(o.congeal.durationMs / 60000)}분 뒤에 골분 ${O.CONGEAL.boneMeal * n}이(가) 나온다.`, 'good');
          save();
          congealScreen();
        } },
      { label: '돌아간다', cls: 'ghost', pin: true, on: materialsScreen },
    ], { stage: true, stageTitle: '얼마나 졸일까' });
    paint(n);
  } else {
    UI.choices([
      { label: '물린다', cls: 'danger', meta: `진액 ${O.CONGEAL.ichor * job.batches}을(를) 돌려받는다`,
        on: () => {
          S.ichor += O.CONGEAL.ichor * job.batches;
          o.congeal = null;
          UI.logLine('불을 껐다. 넣었던 진액을 도로 담았다.', 'dim');
          save();
          congealScreen();
        } },
      { label: '돌아간다', cls: 'ghost', pin: true, on: materialsScreen },
    ], { stage: true, stageTitle: '졸이는 중' });
  }
  save();
}

/** ⚙ 공방 — 골렘을 세우고, 고치고, 부속을 손보는 곳 (§9.3-③⑤, §9.6~9.8) */
function workshopHubScreen() {
  const o = S.ossuary;
  UI.topbar(S, '납골당 · 공방');
  quickHere('workshop');
  const g = assembleGolem(S);
  const oh = o.overhaul ?? [];
  const cs = O.crewSpeed(S);
  const wornUid = new Set(SLOTS.map((sl) => S.golem[sl]).filter(Boolean));
  const rawN = S.inventory.filter((p) => p.raw && !wornUid.has(p.uid)).length;

  UI.listPanel('공방', [
    UI.rowHTML('탐험 골렘', UI.esc(S.golem.name), g.core ? `방어 ${g.shieldNowTotal}/${g.shieldTotal}` : '핵 없음', !g.core),
    UI.rowHTML('세워 둔 것', `${O.workshopGolems(S).length}기`, `작업반 ${Math.round(cs.cut * 100)}% 단축`),
    UI.rowHTML('정비대', oh.length ? `${oh.length}건 진행 중` : '비었다', oh.length
      ? O.remainText(oh[0].startedAt, oh[0].durationMs) : '', oh.length > 0),
    ...(o.built.forge ? [UI.rowHTML('단련로', rawN ? `정착 대기 ${rawN}개` : '날것 없음',
      `${o.forge.slots.length}/${O.forgeSlots(o)}칸`, rawN > 0)] : []),
  ], '<p class="note">골렘을 세우는 일과 부속을 손보는 일이 여기 모여 있다.</p>');

  UI.logHead('공방');
  UI.logLine('받침대와 모루, 끓는 통.', 'narrate');

  UI.choices([
    { label: '📋 골렘 명부', cls: 'primary', meta: `${O.workshopGolems(S).length + 1}기 · 어디에 있는가`,
      info: '내 골렘들이 어디에 있는지 보고, 무덤에 데려갈 몸을 고르고, 이름을 붙인다.',
      on: () => rosterScreen(workshopHubScreen) },
    /* (구) '부속 손보기' — 골렘 명부에서 같은 화면으로 들어간다. 문이 둘이면
       「둘이 다른 것인가」를 매번 확인해야 한다. 하나로 줄였다 (§12.21). */
    { label: '🔧 정비대', meta: oh.length ? O.remainText(oh[0].startedAt, oh[0].durationMs) : '방어도 · 핵',
      cls: oh.length ? '' : '', info: '방어도와 핵 체력을 되돌린다. 망가진 만큼 시간이 걸린다.',
      on: overhaulScreen },
    { label: '🔩 조립대', meta: `${O.workshopGolems(S).length}/${O.golemCap(S.ossuary)}기 · 여분 핵 ${S.cores.length}개`,
      info: '여분 핵으로 새 골렘을 세운다. 세운 골렘은 데려가거나 일을 시킨다.', on: workshopScreen },
    o.built.forge ? { label: '⚒ 단련로', meta: rawN ? `정착 대기 ${rawN}개` : `+1 ~ +${EN.PLUS_MAX} 강화`,
      cls: rawN ? 'primary' : '',
      info: '날것을 길들이고(정착), 남는 부속을 먹여 키운다(강화).', on: forgeJobScreen } : null,
    o.built.vault ? { label: '🏺 창고', meta: `${o.vault.parts.length}/${O.vaultCap(o)}칸`
      + (o.vault.lostRecords?.length ? ` · 기록 ${o.vault.lostRecords.length}` : ''),
      info: '맡긴 부속은 무덤에서 무너져도 흘리지 않는다. 잃은 부속의 기록으로 여기서 소생시킨다.',
      on: vaultScreen } : null,
    { label: '🛠 작업반', meta: cs.cut ? `${Math.round(cs.cut * 100)}% 단축` : '배치 없음',
      info: '세워 둔 골렘에게 일을 맡긴다. 해체대·단련로·정비대 시간이 줄어든다.', on: crewScreen },
    { label: '돌아간다', cls: 'ghost', pin: true, on: ossuaryScreen },
  ], { stage: true, stageTitle: '공방' });
  save();
}

function ossuaryScreen() {
  const fresh = O.settle(S, Date.now());
  if (fresh.lines.length) notifyQuests({ kind: 'job', count: fresh.lines.length });
  for (const l of fresh.lines) UI.logLine(`${l.facility} — ${l.text}`, l.warn ? 'bad' : 'good');
  UI.topbar(S, '시체골 · 납골당');
  quickHere('ossuary');
  ossPanel();
  const o = S.ossuary;
  UI.logHead('납골당');
  UI.logLine('네크로맨서의 작업장.', 'narrate');
  if (!S.log.hintOssuary) {
    S.log.hintOssuary = true;
    UI.logLine('— 여기는 셋으로 나뉜다 —', 'necro');
    UI.logLine('🫗 재료 — 부패조·해체대·자율 탐험.', 'necro');
    UI.logLine('⚙ 공방 — 골렘을 세우고, 고치고, 부속을 손본다. 날것 정착도 여기다.', 'necro');
    UI.logLine('🕯 제단 — 영혼재로 영구 해금을 산다.', 'necro');
    UI.logLine('공방에 세운 여분 골렘을 작업반에 붙이면 모든 작업 시간이 짧아진다.', 'good');
    save();
  }

  /* 문 셋은 왼쪽 그림의 타일이었다(§12.4). 가로 배치에서는 **가운데에도** 늘어놓는다 —
     들어갈 곳은 눈이 가 있는 가운데에 있어야 한다 (§12.17). */
  const bs = O.badges?.(S) ?? {};
  UI.choices([
    { label: '🫗 재료', meta: `부패조 ${o.rotVat.stored}/${O.vatCap(o)} · 해체대 ${o.dissection.slots.length}/${O.dissectionSlots(o)}칸`,
      info: '시간이 재료를 만드는 곳. 걸어 두고 나가면 알아서 돈다.', on: materialsScreen },
    { label: '⚙ 공방', meta: `골렘 ${O.workshopGolems(S).length}/${O.golemCap(o)}기`,
      info: '부속을 붙이고 떼고 고친다. 골렘을 세우는 곳도 여기다.', on: workshopHubScreen },
    { label: '🕯 제단', meta: `영혼재 ${S.soulAsh}`,
      info: '영혼재를 태워 영영 돌아오지 않는 확장을 산다.', on: altarScreen },
    { label: '돌아간다', cls: 'ghost', pin: true, on: () => town(false) },
  ], { stage: true, stageTitle: '납골당 — 문이 셋' });
  save();
}

function vatScreen() {
  const o = S.ossuary;
  UI.topbar(S, '납골당 · 부패조');
  ossPanel();
  UI.logHead('부패조');
  UI.logLine(`시체 조각을 담가두면 시간에 비례해 진액이 고인다. 통에 담긴 양 ${o.rotVat.input}, 고인 진액 ${o.rotVat.stored}/${O.vatCap(o)}.`);
  if (o.rotVat.stored >= O.vatCap(o)) UI.logLine('통이 가득 차 더 이상 고이지 않는다. 비워야 다시 돈다.', 'bad');

  const add = (n) => ({
    label: `조각 ${n} 넣기`, disabled: S.scrap < n, on: () => {
      S.scrap -= n; o.rotVat.input += n;
      UI.logLine(`시체 조각 ${n}을 통에 담갔다. (담긴 양 ${o.rotVat.input})`, 'good');
      vatScreen();
    },
  });
  UI.choices([
    { label: '고인 진액 비우기', cls: 'primary', meta: `+${o.rotVat.stored}`, disabled: !o.rotVat.stored, on: () => {
      S.ichor += o.rotVat.stored;
      UI.logLine(`부패 진액 ${o.rotVat.stored}을 받아냈다.`, 'good');
      o.rotVat.stored = 0;
      vatScreen();
    } },
    add(10), add(30),
    { label: '통 비우기 (담긴 조각 회수)', cls: 'ghost', disabled: !o.rotVat.input, on: () => {
      S.scrap += o.rotVat.input; o.rotVat.input = 0; vatScreen();
    } },
    { label: '돌아간다', cls: 'ghost', pin: true, on: materialsScreen },
  ]);
  save();
}

function dissectScreen() {
  const o = S.ossuary;
  UI.topbar(S, '납골당 · 해체대');
  ossPanel();
  UI.logHead('해체대');
  for (const s2 of o.dissection.slots) {
    UI.logLine(`${s2.name} — ${O.remainText(s2.startedAt, s2.durationMs)}`, 'dim');
  }
  const free = O.dissectionSlots(o) - o.dissection.slots.length;
  const equipped = new Set(SLOTS.map((x) => S.golem[x]).filter(Boolean));
  const spare = S.inventory.filter((p) => !equipped.has(p.uid));
  if (free <= 0) UI.logLine('해체대가 꽉 찼다.', 'bad');
  else if (!spare.length) UI.logLine('해체할 여분 파츠가 없다. 장착 중인 파츠는 올릴 수 없다.', 'dim');
  else UI.logLine('해체할 파츠를 고른다. 시간이 지나면 재료가 된다.');
  UI.choices([
    ...spare.map((p) => {
      const def = DB.partsBy[p.defId];
      const spec = O.DISSECT[def.rarity] ?? O.DISSECT.common;
      return {
        // 목록에서는 이름이 잘릴 수 있다. 자리와 내구도를 곁에 적고,
        // 누르면 상세 화면에서 무엇인지 확인한 뒤에 올린다
        label: UI.partHTML(p),
        meta: `${KIND_LABEL[def.slot]} · ${p.integrity}/${p.maxIntegrity} · 조각 ${spec.scrap[0]}~${spec.scrap[1]}`,
        info: UI.partTip(p),
        disabled: free <= 0,
        on: () => partDetailScreen(p, dissectScreen, {
          title: '납골당 · 해체 확인',
          ask: `${partName(p)}을(를) 해체할까?`,
          note: `${Math.round(O.jobDuration(S, spec.ms) / 60000)}분 뒤 시체 조각 ${spec.scrap[0]}~${spec.scrap[1]}`
            + `${spec.ichor ? ` · 진액 ${spec.ichor}` : ''}${spec.boneMeal ? ` · 골분 ${spec.boneMeal}` : ''}`
            + '. 한 번 올리면 되돌릴 수 없다.',
          label: '예, 해체한다', cls: 'danger',
          meta: `${Math.round(O.jobDuration(S, spec.ms) / 60000)}분`,
          on: () => dissectPart(p, spec),
        }),
      };
    }),
    { label: '돌아간다', cls: 'ghost', pin: true, on: materialsScreen },
  ]);
  save();
}

/** 부속 하나를 해체대에 올린다 */
function dissectPart(p, spec) {
  const o = S.ossuary;
  S.inventory = S.inventory.filter((x) => x.uid !== p.uid);
  const r = makeRng(Date.now() & 0xffffffff);
  o.dissection.slots.push({
    name: partName(p), startedAt: Date.now(), durationMs: O.jobDuration(S, spec.ms),
    yield: {
      scrap: r.int(spec.scrap[0], spec.scrap[1]), ichor: spec.ichor, boneMeal: spec.boneMeal,
      modSample: p.mod && r.chance(35) ? p.mod : null,
    },
  });
  UI.logLine(`${partName(p)}을(를) 해체대에 올렸다.`, 'good');
  notifyQuests({ kind: 'dismantle', count: 1 });
  dissectScreen();
}

/* ── 표본실 = 창고 (§9.18) ─────────────────────────
   「표본실이 어떻게 쓰는지 정확하게 모르겠어」 — 이름부터가 그랬다.
   「표본」이라니 무엇을 하는 곳인지 알 수가 없다. 하는 일은 하나다:
   **여기 맡겨 둔 부속은 무덤에서 골렘이 무너져도 흘리지 않는다.**

   왼쪽에 맡긴 것, 오른쪽에 가진 것. 맡기면 오른쪽에서 왼쪽으로 옮겨 간다 —
   어느 쪽에 있는지가 곧 「안전한가」이므로, 그 경계가 눈에 보여야 한다. */
function vaultScreen() {
  const o = S.ossuary;
  UI.topbar(S, '납골당 · 창고');
  const cap = O.vaultCap(o);
  const stored = o.vault.parts;
  const equipped = new Set(SLOTS.map((x) => S.golem[x]).filter(Boolean));
  const spare = S.inventory.filter((p) => !equipped.has(p.uid));
  const full = stored.length >= cap;

  UI.listPanel(`맡긴 것 ${stored.length}/${cap}`,
    stored.length
      ? stored.map((p) => UI.rowHTML(KIND_LABEL[DB.partsBy[p.defId].slot],
          `${p.plus ? `<span class="chip good">+${p.plus}</span> ` : ''}${UI.partHTML(p, { noPlus: true })}`,
          `${p.integrity}/${p.maxIntegrity}`, wornLow(p)))
      : [UI.rowHTML('─', '<span class="empty">아직 맡긴 것이 없다</span>', '')],
    `<p class="note"><b>여기 맡긴 것은 무덤에서 잃지 않는다.</b>
      골렘이 무너지면 들고 내려간 여분은 하나당 ${SPARE_LOSS}%씩 흘리는데, 창고에 둔 것은 그대로 남는다.<br>
      칸은 ${cap}개 — 제단에서 단계를 올리면 ${O.VAULT_STEP}칸씩 늘어난다 (최대 ${O.VAULT_BASE + O.VAULT_STEP * (O.VAULT_MAX_LV - 1)}칸).<br>
      ${full ? '<b>꽉 찼다</b> — 꺼내거나 넓혀야 더 맡긴다.' : '오른쪽에서 부속을 누르면 이리로 옮겨 온다.'}</p>`);

  UI.logHead('창고');
  UI.logLine('선반마다 유리병이 놓여 있다. 맡긴 것은 여기서 기다린다.', 'narrate');
  UI.logLine(`맡긴 것 ${stored.length}/${cap} · 가진 여분 ${spare.length}개.`, 'dim');
  if (o.vault.lostRecords.length) {
    UI.logLine(`잃어버린 기록 ${o.vault.lostRecords.length}개 — 여기서 소생시킨다.`, 'dim');
  }

  const revCost = REVIVE_COST;
  const revLack = shortText(revCost);
  UI.choices([
    /* 오른쪽은 **가진 것**이다. 누르면 왼쪽(창고)으로 옮겨 간다 */
    ...spare.map((p) => ({
      label: `${p.plus ? `<span class="chip good">+${p.plus}</span> ` : ''}${UI.partHTML(p, { noPlus: true })}`,
      meta: full ? '창고가 꽉 찼다'
        : `${UI.RARITY_LABEL[UI.rarityOf(p)]} · ${p.integrity}/${p.maxIntegrity} · 맡긴다`,
      disabled: full,
      info: UI.partTip(p),
      on: () => {
        S.inventory = S.inventory.filter((x) => x.uid !== p.uid);
        o.vault.parts.push(p);
        UI.logLine(`${partName(p)}을(를) 창고에 맡겼다.`, 'good');
        save();
        vaultScreen();
      },
    })),
    /* 맡긴 것을 도로 꺼낸다 — 왼쪽 목록과 짝이 되는 단추 */
    ...stored.map((p) => ({
      label: `${UI.partHTML(p, { noPlus: true })} 꺼낸다`, cls: 'ghost',
      meta: `${p.integrity}/${p.maxIntegrity}${p.plus ? ` · +${p.plus}` : ''} · 가방으로`,
      info: UI.partTip(p),
      on: () => {
        o.vault.parts = o.vault.parts.filter((x) => x.uid !== p.uid);
        S.inventory.push(p);
        UI.logLine(`${partName(p)}을(를) 꺼냈다.`, 'dim');
        save();
        vaultScreen();
      },
    })),
    /* 소생은 기록이 사는 집에서 한다 (§9.15-A). 되살린 것은 **가방으로** 간다 (§9.18) */
    ...o.vault.lostRecords.map((defId, i) => ({
      label: `${UI.esc(DB.partsBy[defId]?.name_template.replace('{mod}', '').replace('{owner}', DB.partsBy[defId]?.owner ?? '').replace(/\s+/g, ' ').trim() ?? '?')} 소생`,
      cls: 'primary',
      meta: revLack ?? `${Object.entries(revCost).map(([k, v]) => `${O.RES_LABEL[k]} ${v}`).join(' · ')} · 기록이 지워진다`,
      disabled: Boolean(revLack),
      info: '<span class="tt">소생</span>'
        + '<div class="trow"><span>무덤에서 흘린 부속을 기록으로 다시 세운다. 이상은 붙지 않는다.</span></div>',
      on: () => {
        for (const [k, v] of Object.entries(revCost)) S[k] -= v;
        const part = makePart(defId, null);
        o.vault.lostRecords.splice(i, 1);
        S.inventory.push(part);
        UI.logLine(`${partName(part)}이(가) 유리병 속에서 다시 맞물린다. 가방에 넣었다.`, 'good');
        save();
        vaultScreen();
      },
    })),
    { label: '돌아간다', cls: 'ghost', pin: true, on: workshopHubScreen },
  ], { stage: true, stageTitle: '가진 것 — 누르면 맡긴다' });
  save();
}

/* ── 정비대: 방어도·핵 회복 ─────────────── *//* ── 정비대: 방어도·핵 회복 ─────────────── */
/* 정비대에서 지금 올려다보고 있는 골렘. 화면을 다시 그려도 기억한다 */
let overhaulPick = null;

/**
 * 골렘 한 기를 정비대의 눈으로 본다 — 탐험 골렘이든 사역 골렘이든 같은 모양으로.
 * 전에는 **탐험 골렘만** 고칠 수 있었다. 사역 골렘은 자율 탐험에서 내구도가 닳는데
 * 되돌릴 길이 없어, 닳으면 해체하는 수밖에 없었다 (§9.9-A).
 */
function repairView(id) {
  if (id === S.golem.id) {
    const g = assembleGolem(S);
    return {
      id: S.golem.id, name: S.golem.name, active: true,
      coreName: g.core?.name ?? null, coreHp: S.golem.coreHp ?? g.stats.hp, coreMax: g.stats.hp,
      worn: g.worn.map(({ slot, part, shieldMax: max, shield }) => ({ slot, part, shield, shieldMax: max })),
      where: 'active',
    };
  }
  const w = O.workshopGolems(S).find((x) => x.id === id);
  if (!w) return null;
  const core = DB.coresBy[w.core];
  const coreMax = Math.max(1, core?.hp ?? 1);
  const worn = SLOTS.map((slot) => {
    const uid = w.slots?.[slot];
    const part = uid ? (w.parts ?? []).find((x) => x.uid === uid) : null;
    return part ? { slot, part, shield: shieldNow(part, slot), shieldMax: shieldMax(part, slot) } : null;
  }).filter(Boolean);
  return {
    id: w.id, name: w.name, active: false, ref: w,
    coreName: core?.name ?? null, coreHp: w.coreHp ?? coreMax, coreMax, worn,
    where: whereOf({ id: w.id, assigned: w.assigned }),
  };
}

/** 정비대에 올릴 수 있는 골렘들 — 나가 있는 몸은 여기 없다 */
function repairable() {
  const out = [repairView(S.golem.id)].filter(Boolean);
  for (const w of O.workshopGolems(S)) {
    const v = repairView(w.id);
    if (v) out.push(v);
  }
  return out;
}

const gapsOf = (v) => ({
  shield: v.worn.reduce((n, w) => n + Math.max(0, w.shieldMax - w.shield), 0),
  core: Math.max(0, v.coreMax - v.coreHp),
  wear: v.worn.reduce((n, w) => n + Math.max(0, w.part.maxIntegrity - w.part.integrity), 0),
});

function overhaulScreen() {
  const o = S.ossuary;
  o.overhaul ??= [];
  const list = repairable();
  if (!list.some((v) => v.id === overhaulPick)) overhaulPick = S.golem.id;
  const v = list.find((x) => x.id === overhaulPick) ?? list[0];
  UI.topbar(S, '납골당 · 정비대');

  const jobsOf = (id) => o.overhaul.filter((j) => j.golemId === id);
  const gaps = v ? gapsOf(v) : { shield: 0, core: 0, wear: 0 };

  /* 왼쪽에 골렘을 늘어놓고 **눌러서 고른다** (§12.10).
     고른 골렘의 부위는 그 아래에 이어 적는다 — 무엇이 얼마나 상했는지가 고르는 근거다. */
  const rows = [
    ...list.map((x) => {
      const gp = gapsOf(x);
      const busy = jobsOf(x.id);
      const state = busy.length ? `정비 중 ${O.remainText(busy[0].startedAt, busy[0].durationMs)}`
        : BUSY_ELSEWHERE[x.where] ? BUSY_ELSEWHERE[x.where]
        : (gp.shield + gp.core + gp.wear) === 0 ? '온전하다'
        : `방 ${gp.shield} · 핵 ${gp.core} · 내 ${gp.wear} 모자라다`;
      return UI.rowHTML(x.active ? '탐험' : WHERE[x.where]?.label ?? '대기',
        `${UI.esc(x.name)}<br><span style="color:var(--muted);font-size:.84em">${UI.esc(x.coreName ?? '핵 없음')}</span>`,
        state, busy.length > 0 || (gp.shield + gp.core + gp.wear) > 0, `g:${x.id}`);
    }),
  ];
  const detail = v ? [
    UI.rowHTML('─', `<b>${UI.esc(v.name)}</b>의 부위`, ''),
    UI.rowHTML('핵', v.coreName ? UI.esc(v.coreName) : '<span class="empty">없음</span>',
      `${v.coreHp}/${v.coreMax}`, v.coreHp < v.coreMax),
    ...v.worn.map(({ slot, part, shieldMax: max, shield }) =>
      UI.rowHTML(SLOT_LABEL[slot], UI.partHTML(part),
        `방 ${shield}/${max} · 내 ${part.integrity}/${part.maxIntegrity}`,
        shield < max || wornLow(part))),
  ] : [];

  UI.listPanel('정비대에 올릴 골렘', [...rows, ...detail],
    `<p class="note">줄을 누르면 그 골렘을 올린다. 지금 올라간 것은 <b>${UI.esc(v?.name ?? '없음')}</b>.<br>
     <b>방</b>은 방어도(맞으면 깎인다), <b>내</b>는 내구도(쓰면 닳는다). 둘 다 여기서 되돌린다.<br>
     방어도는 포션으로 돌아오지 않는다 — 작업대나 여기서만 되돌릴 수 있다.<br>
     맡긴 골렘은 작업이 끝날 때까지 움직이지 못한다.<br>
     <b>일하는 몸은 올릴 수 없다</b> — 자율 탐험을 나갔거나 작업반에 붙어 있으면 먼저 물려야 한다.</p>`,
    (key) => { overhaulPick = key.slice(2); overhaulScreen(); }, `g:${v?.id}`);

  UI.logHead('정비대');
  UI.logLine('부서진 것을 원래대로 돌리는 자리.', 'narrate');
  for (const j of o.overhaul) {
    const who = repairView(j.golemId)?.name ?? '골렘';
    UI.logLine(`${who} · ${O.OVERHAUL[j.kind].name} — ${O.remainText(j.startedAt, j.durationMs)}`, 'dim');
  }
  if (v && BUSY_ELSEWHERE[v.where]) {
    UI.logLine(v.where === 'labor'
      ? `${v.name}은(는) 자율 탐험을 나가 있다. 돌아와야 올릴 수 있다.`
      : `${v.name}은(는) 작업반에서 일하고 있다. 작업반에서 물려야 정비대에 올릴 수 있다.`, 'dim');
  }

  const costText = (c) => Object.entries(c).map(([k, v2]) => `${O.RES_LABEL[k]} ${v2}`).join(' · ');
  const afford = (c) => Object.entries(c).every(([k, v2]) => (S[k] ?? 0) >= v2);
  const running = (kind) => o.overhaul.some((j) => j.kind === kind && j.golemId === v?.id);

  UI.choices([
    ...Object.entries(O.OVERHAUL).map(([kind, r]) => {
      const missing = gaps[kind === 'shield' ? 'shield' : kind === 'wear' ? 'wear' : 'core'];
      const ms = O.jobDuration(S, O.overhaulMs(kind, missing));
      /* 일하는 몸은 정비대에 못 올린다 (§9.14). 자율 탐험은 무덤에 가 있고,
         작업반은 지금 이 작업을 **빠르게 만들고 있는** 몸이다 — 둘 다 여기 없다. */
      const away = v ? BUSY_ELSEWHERE[v.where] ?? null : null;
      return {
        label: r.name,
        info: `${r.desc}\n망가진 만큼 시간이 늘어난다. 작업반 골렘을 붙이면 줄어든다.`,
        meta: !v ? '올릴 골렘이 없다'
          : away ? away
          : running(kind) ? '진행 중'
          : !missing ? '온전하다'
          : `${costText(r.cost)} · ${Math.round(ms / 60000)}분`,
        disabled: !v || Boolean(away) || running(kind) || !missing || !afford(r.cost),
        on: () => {
          for (const [k, n] of Object.entries(r.cost)) S[k] -= n;
          o.overhaul.push({ kind, golemId: v.id, startedAt: Date.now(), durationMs: ms });
          UI.logLine(`${v.name}을(를) 정비대에 올렸다. ${Math.round(ms / 60000)}분 뒤에 끝난다.`, 'good');
          if (v.active) UI.logLine('그동안 다른 골렘을 데려가려면 골렘 명부에서 바꿔 올려라.', 'dim');
          overhaulScreen();
        },
      };
    }),
    // 급하면 물릴 수 있어야 한다. 그러지 않으면 정비를 걸어 둔 채 몇 시간을 못 내려간다
    ...o.overhaul.map((j) => ({
      label: `${O.OVERHAUL[j.kind].name} 물린다`, cls: 'danger',
      meta: `${repairView(j.golemId)?.name ?? '골렘'} · 쓴 재료는 돌아오지 않는다`,
      on: () => {
        o.overhaul = o.overhaul.filter((x) => x !== j);
        UI.logLine(`${O.OVERHAUL[j.kind].name}을(를) 중간에 걷어냈다. 쓴 재료는 돌아오지 않는다.`, 'bad');
        save();
        overhaulScreen();
      },
    })),
    /* 옛 단련로의 '수복'이 여기로 왔다 (§9.15-A) — **고치는 일은 전부 정비대다.**
       정비 셋은 골렘 한 기를 통째로 올리는 일이라, 가방에 굴러다니는 여분은 갈 곳이 없었다. */
    (() => {
      const wornSpare = spareDamaged();
      const c = SPARE_MEND_COST;
      const lack = shortText(c);
      return {
        label: '📦 여분 부속 수복', cls: wornSpare.length ? '' : 'ghost',
        meta: !wornSpare.length ? '상한 여분이 없다'
          : lack ?? `${wornSpare.length}개 · ${Object.entries(c).map(([k, v]) => `${O.RES_LABEL[k]} ${v}`).join(' · ')}`,
        disabled: !wornSpare.length || Boolean(lack),
        info: '<span class="tt">여분 부속 수복</span>'
          + '<div class="trow"><span>골렘에 붙지 않은 여분 중 닳은 것을 전부 상한까지 되돌린다. 기다리지 않는다.</span></div>',
        on: () => {
          for (const [k, v] of Object.entries(c)) S[k] -= v;
          for (const p of wornSpare) p.integrity = p.maxIntegrity;
          UI.logLine(`여분 ${wornSpare.length}개의 닳은 자리를 메웠다.`, 'good');
          save();
          overhaulScreen();
        },
      };
    })(),
    { label: '골렘 명부', cls: 'ghost', on: () => rosterScreen(overhaulScreen) },
    { label: '돌아간다', cls: 'ghost', pin: true, on: workshopHubScreen },
  ]);
  save();
}

/** 골렘에 붙지 않은 것 중 닳은 것 */
function spareDamaged() {
  const equipped = new Set(SLOTS.map((x) => S.golem[x]).filter(Boolean));
  return S.inventory.filter((p) => !equipped.has(p.uid) && p.integrity < p.maxIntegrity);
}
const SPARE_MEND_COST = { scrap: 12, boneMeal: 2 };

/* ── 작업반 ─────────────────────────────── */
/* ── 조립대 — 여분 핵으로 사역 골렘을 세운다 ──────────────
   부속만 세워 두는 것으로는 아무 일도 일어나지 않는다.
   핵이 몸을 세우고, 그 골렘이 일을 한다. */
/* ── 골렘 명부 (§9.7) ─────────────────────────────
   골렘은 하나가 아니다. 하나가 정비대에 올라가 있으면 다른 골렘을 데리고 내려간다.
   `S.golem`은 「지금 탐험 자리에 선 골렘」이고, 조립대의 골렘과 **자리를 맞바꾼다.**
   이렇게 하면 골렘을 참조하는 수백 군데를 건드리지 않고도 여러 기를 굴릴 수 있다. */

/**
 * 일을 맡길 수 있는 골렘인가.
 * **핵만 있는 몸은 서 있을 뿐이다** — 팔이 없으면 캐지도, 나르지도 못한다.
 * 작업반의 능률도 부속 스탯에서 나오므로, 빈 골렘을 붙이면 0을 더하고 자리만 먹는다.
 */
const WORK_MIN_PARTS = 1;
/* 일을 맡길 수 있는가 — 부속이 있어야 하고, **핵이 남아 있어야 한다** (§9.12) */
const canWork = (g) => (g?.parts?.length ?? 0) >= WORK_MIN_PARTS && !O.coreSpent(g);
/** 왜 못 맡기는지 한 줄로 */
const workBlock = (g) => ((g?.parts?.length ?? 0) < WORK_MIN_PARTS
  ? '부속이 없다 — 핵만으로는 일을 못 한다'
  : O.coreSpent(g) ? '핵이 바닥났다 — 정비대에서 안정화해야 한다' : null);
/** 핵 체력을 한 조각으로 */
const coreChip = (g) => `핵 ${O.coreHpOf(g)}/${O.coreMaxOf(g)}`;

/** 지금 다른 일을 하고 있어 정비대에 올릴 수 없는 자리 (§9.14) */
const BUSY_ELSEWHERE = {
  labor: '자율 탐험 중 — 돌아와야 올린다',
  crew: '작업반에서 일하는 중 — 물려야 올린다',
};

const WHERE = {
  active: { label: '탐험', cls: 'good' },
  repair: { label: '정비대', cls: 'warn' },
  crew:   { label: '작업반', cls: '' },
  labor:  { label: '자율 탐험', cls: '' },
  idle:   { label: '대기', cls: '' },
};

/** 지금 이 골렘이 어디에 있는가 */
function whereOf(g) {
  if ((S.ossuary?.overhaul ?? []).some((j) => j.golemId === g.id)) return 'repair';
  if (g.active) return 'active';
  if (g.assigned === 'crew') return 'crew';
  if (g.assigned === 'labor') return 'labor';
  return 'idle';
}

/** 탐험 골렘 + 조립대 골렘을 한 목록으로 */
function roster() {
  const g = assembleGolem(S);
  const out = [{
    id: S.golem.id, name: S.golem.name, core: S.golem.core, active: true,
    parts: g.worn.map((w) => w.part), assigned: null,
    shield: g.shieldNowTotal, shieldMax: g.shieldTotal,
    coreHp: S.golem.coreHp ?? g.stats.hp, coreMax: g.stats.hp,
  }];
  for (const w of O.workshopGolems(S)) {
    out.push({
      id: w.id, name: w.name, core: w.core, active: false, parts: w.parts ?? [],
      assigned: w.assigned, power: O.golemPower(w), ref: w,
    });
  }
  return out;
}

/**
 * 탐험 자리의 골렘과 조립대의 골렘을 맞바꾼다.
 * 부속은 사는 곳이 다르다 — 탐험 골렘의 부속은 소지품에, 조립대 골렘의 부속은 그 골렘이 들고 있다.
 * 그래서 자리를 바꿀 때 **부속도 함께 이사한다.**
 */
function swapGolem(wgId) {
  const o = S.ossuary;
  const i = o.workshop.golems.findIndex((x) => x.id === wgId);
  if (i < 0) return false;
  const next = o.workshop.golems[i];

  // 지금 탐험 골렘을 조립대 레코드로 만든다 (부속은 소지품에서 빼 온다)
  const curParts = SLOTS.map((sl) => S.golem[sl]).filter(Boolean)
    .map((uid) => findPart(uid)).filter(Boolean);
  const cur = {
    id: S.golem.id, name: S.golem.name, core: S.golem.core, coreHp: S.golem.coreHp ?? null,
    parts: curParts,
    slots: Object.fromEntries(SLOTS.map((sl) => [sl, S.golem[sl]]).filter(([, v]) => v)),
    attachments: [...(S.golem.attachments ?? [])],
    banned: [...(S.golem.banned ?? [])],
    retuned: { ...(S.golem.retuned ?? {}) },
    assigned: null,
  };

  // 고른 골렘을 탐험 자리로 올린다
  S.golem = {
    id: next.id, name: next.name, core: next.core, coreHp: next.coreHp ?? null,
    head: null, body: null, armL: null, armR: null, legL: null, legR: null,
    attachments: [...(next.attachments ?? [])],
    banned: [...(next.banned ?? [])],
    retuned: { ...(next.retuned ?? {}) },
  };
  for (const [sl, uid] of Object.entries(next.slots ?? {})) S.golem[sl] = uid;
  // 그 골렘의 부속은 이제 소지품에 있어야 한다 (findPart가 소지품을 본다)
  for (const part of next.parts ?? []) {
    if (!S.inventory.some((x) => x.uid === part.uid)) S.inventory.push(part);
  }
  // 내려간 골렘의 부속은 그 골렘이 들고 간다
  S.inventory = S.inventory.filter((x) => !cur.parts.some((p) => p.uid === x.uid));

  o.workshop.golems[i] = cur;
  resyncUids(S);
  return true;
}

function rosterScreen(back = workshopHubScreen) {
  UI.topbar(S, '골렘 명부');
  const list = roster();
  const cap = O.crewCap(S.ossuary);
  const onCrew = O.workshopGolems(S).filter((g) => g.assigned === 'crew').length;

  UI.listPanel('내 골렘들', list.map((g) => {
    const w = WHERE[whereOf(g)];
    const rt = g.active ? `방어 ${g.shield}/${g.shieldMax}` : `능률 ${g.power}`;
    return UI.rowHTML(w.label, `${UI.esc(g.name)}<br>
      <span style="color:var(--muted);font-size:.84em">${UI.esc(DB.coresBy[g.core]?.name ?? '핵 없음')}
      · 부속 ${g.parts.length}</span>`, rt, whereOf(g) === 'repair');
  }), `<p class="note">탐험 자리에 서는 골렘은 한 기뿐이다. 나머지는 정비대·작업반·자율 탐험에 보내거나 세워 둔다.<br>
      작업반 ${onCrew}/${cap}기 · 자율 탐험 ${S.ossuary.laborBay.dispatch.length}/${O.laborSlots(S.ossuary)}칸<br>
      자율 탐험은 <b>납골당 → 재료</b>에서 보낸다.</p>`);

  UI.logHead('골렘 명부');
  UI.logLine('핵 하나에 골렘 하나.', 'narrate');

  UI.choices([
    ...list.map((g) => ({
      label: `${WHERE[whereOf(g)].label === '탐험' ? '▶ ' : ''}${g.name}`,
      meta: `${WHERE[whereOf(g)].label} · ${g.active ? `방어 ${g.shield}/${g.shieldMax}` : `능률 ${g.power}`}`,
      cls: g.active ? 'primary' : '',
      on: () => golemCardScreen(g.id, back),
    })),
    // 가장 자주 하는 일은 지금 몸을 손보는 것이다. 명부를 거친다고 한 번 더 누르게 할 이유가 없다
    { label: '부속 손보기', cls: 'ghost', pin: true,
      info: '지금 탐험 자리에 선 골렘의 핵과 부속을 갈아 끼운다.',
      on: () => golemScreen(() => rosterScreen(back)) },
    { label: '조립대에서 새로 세운다', cls: 'ghost', meta: `여분 핵 ${S.cores.length}개`, on: workshopScreen },
    { label: '돌아간다', cls: 'ghost', pin: true, on: back },
  ]);
  save();
}

/** 골렘 한 기의 카드 — 여기서 데려가고, 이름을 바꾸고, 일을 시킨다 */
function golemCardScreen(id, back = workshopHubScreen) {
  const g = roster().find((x) => x.id === id);
  if (!g) { rosterScreen(back); return; }
  const here = whereOf(g);
  const o = S.ossuary;

  UI.topbar(S, `골렘 · ${g.name}`);
  if (g.active) UI.golemPanel(S);
  else {
    const st = O.golemStats(g.ref);
    UI.listPanel(g.name, [
      UI.rowHTML('자리', WHERE[here].label, '', here === 'repair'),
      UI.rowHTML('핵', DB.coresBy[g.core]?.name ?? '없음', ''),
      ...SLOTS.map((sl) => {
        const uid = g.ref.slots?.[sl];
        const p = uid ? (g.ref.parts ?? []).find((x) => x.uid === uid) : null;
        return UI.rowHTML(SLOT_LABEL[sl], p ? UI.partHTML(p) : '<span class="empty">비어 있음</span>',
          p ? `${p.integrity}/${p.maxIntegrity}` : '');
      }),
      UI.rowHTML('능률', String(O.golemPower(g.ref)), `공${st.atk} 방${st.def} 속${st.spd}`),
    ], '<p class="note">데려가면 지금 탐험 자리의 골렘과 자리를 맞바꾼다.</p>');
  }

  UI.logHead(g.name);
  UI.logLine(here === 'active' ? '지금 이 몸으로 내려간다.'
    : here === 'repair' ? '정비대에 올라가 있다. 끝나야 움직일 수 있다.'
    : here === 'crew' ? '작업반에 붙어 있다.'
    : here === 'labor' ? '자율 탐험을 나가 있다.'
    : '받침대에 세워 둔 채다.', 'dim');
  // 내보내는 자리는 납골당 「재료」 한 곳뿐이다 (§9.10-A). 여기서는 어디로 가야 하는지만 적는다
  if (!g.active && here === 'idle' && canWork(g.ref)) {
    UI.logLine('자율 탐험은 납골당 → 재료 → 자율 탐험에서 보낸다.', 'dim');
  }

  const busyWhy = here === 'repair' ? '정비 중이다'
    : here === 'labor' ? '자율 탐험 중이다' : null;

  UI.choices([
    !g.active ? {
      label: '데려간다', cls: 'primary',
      meta: busyWhy ?? '탐험 자리로 올린다',
      disabled: Boolean(busyWhy),
      on: () => {
        if (g.ref.assigned === 'crew') g.ref.assigned = null;
        const prev = S.golem.name;
        if (swapGolem(id)) {
          UI.logLine(`${prev}을(를) 내리고 ${g.name}을(를) 탐험 자리에 올렸다.`, 'good');
          save();
        }
        rosterScreen(back);
      },
    } : null,
    { label: '이름 바꾸기', cls: 'ghost', meta: g.name, on: () => renameGolem(id, back) },
    /* 탐험 골렘은 정비 화면으로, 사역 골렘은 조립 화면으로 — **어느 쪽이든 여기서 손본다.**
       전에는 사역 골렘의 부속을 바꾸려면 해체하고 다시 세우는 길밖에 없었다 (§9.7-A). */
    g.active
      ? { label: '부속 손보기', on: () => golemScreen(() => golemCardScreen(id, back)) }
      : { label: '부속 손보기', meta: `부속 ${g.parts.length}개 · 능률 ${g.power}`,
          info: '자리마다 무엇을 끼울지 고른다. 해체하지 않고 바꿀 수 있다.',
          on: () => workGolemScreen(id, () => golemCardScreen(id, back)) },
    !g.active && here !== 'repair' && here !== 'labor' ? {
      label: here === 'crew' ? '작업반에서 물린다' : '작업반에 붙인다',
      meta: here === 'crew' ? ''
        : workBlock(g.ref) ??
          (O.workshopGolems(S).filter((x) => x.assigned === 'crew').length
            >= O.crewCap(o) ? `자리가 없다 (${O.crewCap(o)}기까지)`
            : `능률 ${g.power} · ${coreChip(g.ref)}`),
      disabled: here !== 'crew'
        && (!canWork(g.ref)
          || O.workshopGolems(S).filter((x) => x.assigned === 'crew').length >= O.crewCap(o)),
      on: () => {
        g.ref.assigned = here === 'crew' ? null : 'crew';
        UI.logLine(here === 'crew' ? `${g.name}을(를) 물렸다.` : `${g.name}이(가) 일을 시작했다.`, 'good');
        save();
        golemCardScreen(id, back);
      },
    } : null,
    !g.active && here === 'idle' ? {
      label: '해체한다', cls: 'danger', meta: '핵과 부속을 되찾는다',
      on: () => { disassembleWorkGolem(id); rosterScreen(back); },
    } : null,
    { label: '돌아간다', cls: 'ghost', pin: true, on: () => rosterScreen(back) },
  ]);
}

/** 이름은 내가 붙인다 */
function renameGolem(id, back) {
  const g = roster().find((x) => x.id === id);
  if (!g) { rosterScreen(back); return; }
  UI.onTextClosed.length = 0;
  UI.onTextClosed.push(() => golemCardScreen(id, back));
  UI.logLine('새 이름을 적어라. 비워 두면 그대로 둔다.', 'dim');
  UI.askText(`${g.name}의 새 이름`, (text) => {
    const name = String(text ?? '').trim().slice(0, 20);
    if (!name) { UI.logLine('이름을 그대로 두었다.', 'dim'); golemCardScreen(id, back); return; }
    if (g.active) S.golem.name = name; else g.ref.name = name;
    UI.logLine(`이제 ${name}이라 부른다.`, 'good');
    save();
    golemCardScreen(id, back);
  }, '이 이름으로', g.name);
}

function workshopScreen() {
  const o = S.ossuary;
  const golems = O.workshopGolems(S);
  UI.topbar(S, '납골당 · 조립대');

  UI.listPanel('세워 둔 사역 골렘',
    golems.map((g) => UI.rowHTML(
      DB.coresBy[g.core]?.name ?? '?', UI.esc(g.name),
      `능률 ${O.golemPower(g)} · ${coreChip(g)}${g.assigned === 'crew' ? ' · 작업반' : ''}`,
      O.coreSpent(g))),
    `<p class="note"><b>받침대 ${golems.length}/${O.golemCap(S.ossuary)}기</b> · 여분 핵 ${S.cores.length}개 · 여분 부속 ${sparePool().length}개<br>
      핵 하나에 골렘 하나. 지금 골렘에 끼운 핵은 쓸 수 없다 — 여분이 있어야 세운다.<br>
      받침대가 꽉 차면 더 세울 수 없다. 제단에서 안치소를 넓히면 한 자리씩 늘어난다.<br>
      세운 골렘은 작업반에 붙여 작업 시간을 줄인다. 배치한 부속은 탐험에 쓸 수 없다.<br>
      일을 시키면 <b>핵이 닳는다</b>. 1에 닿으면 멈추고, 정비대의 핵 안정화로 되살린다.</p>`);

  UI.logHead('조립대');
  UI.logLine('핵을 놓고 부속을 맞춘다.', 'narrate');
  if (!S.cores.length) {
    UI.logLine('여분 핵이 없다. 상점에서 사거나 단계를 끝내면 들어온다.', 'dim');
    UI.logLine('지금 골렘에 박혀 있는 핵은 뽑아 쓸 수 없다.', 'dim');
  }
  if (golems.length >= O.golemCap(S.ossuary)) {
    UI.logLine(`받침대가 꽉 찼다 — ${O.golemCap(S.ossuary)}기까지 세울 수 있다.`, 'bad');
  }

  const full = golems.length >= O.golemCap(S.ossuary);
  UI.choices([
    /* 핵을 통째로 늘어놓지 않는다 (§12.22). 핵이 다섯 개면 세워 둔 골렘이
       그 아래로 밀려나, **이 화면이 무엇을 보는 곳인지**가 흐려졌다.
       새로 세우는 일은 문 하나로 모으고, 핵은 그 안에서 고른다. */
    { label: '➕ 새 골렘을 조립한다', cls: full || !S.cores.length ? 'ghost' : 'primary',
      meta: full ? `받침대가 꽉 찼다 (${golems.length}/${O.golemCap(S.ossuary)})`
        : !S.cores.length ? '여분 핵이 없다'
        : `여분 핵 ${S.cores.length}개 · 받침대 ${golems.length}/${O.golemCap(S.ossuary)}`,
      disabled: full || !S.cores.length,
      info: full ? '한 기를 해체하거나 제단에서 안치소를 넓혀야 자리가 난다.'
        : !S.cores.length ? '상점에서 사거나 단계를 끝내면 여분 핵이 들어온다.' : null,
      on: newGolemScreen },
    ...golems.map((g) => ({
      label: `${g.name}`,
      meta: `능률 ${O.golemPower(g)} · 부속 ${g.parts.length}개 · ${coreChip(g)}`
        + `${g.assigned === 'crew' ? ' · 작업반' : ''}${O.coreSpent(g) ? ' · 멈춤' : ''}`,
      on: () => workGolemScreen(g.id),
    })),
    { label: '골렘 명부', cls: 'ghost', info: '내 골렘들이 어디에 있는지 보고, 데려갈 몸을 고른다.',
      on: () => rosterScreen(workshopScreen) },
    { label: '돌아간다', cls: 'ghost', pin: true, on: workshopHubScreen },
  ]);
  save();
}

/* ── 새 골렘 조립 — 핵을 여기서 고른다 (§12.22) ───────── */
function newGolemScreen() {
  const golems = O.workshopGolems(S);
  const full = golems.length >= O.golemCap(S.ossuary);
  UI.topbar(S, '조립대 · 새 골렘');

  UI.listPanel('쓸 수 있는 핵', S.cores.map((cid) => {
    const c = DB.coresBy[cid];
    return UI.rowHTML('핵', UI.esc(c.name), `체력 ${c.hp} · 마력 ${c.mana ?? '-'}`);
  }), `<p class="note">핵 하나에 골렘 하나. <b>지금 탐험 골렘에 박혀 있는 핵은 여기 없다</b> —
      여분만 쓴다.<br>
      받침대 ${golems.length}/${O.golemCap(S.ossuary)}기. 세운 뒤에 부속을 끼운다.<br>
      핵 체력이 곧 그 골렘이 일을 얼마나 오래 버티는가다 — 작업반과 자율 탐험이 이걸 갉는다.</p>`);

  UI.logHead('새 골렘');
  UI.logLine('받침대 위에 빈 자리가 있다. 어떤 핵을 놓을까.', 'narrate');
  if (!S.cores.length) UI.logLine('여분 핵이 없다. 상점에서 사거나 단계를 끝내면 들어온다.', 'dim');

  UI.choices([
    ...S.cores.map((cid) => {
      const c = DB.coresBy[cid];
      return {
        label: `${UI.esc(c.name)}으로 세운다`,
        meta: full ? `받침대가 꽉 찼다 (${golems.length}/${O.golemCap(S.ossuary)})`
          : `체력 ${c.hp} · 부속은 세운 뒤에 고른다`,
        disabled: full,
        info: `<span class="tt">${UI.esc(c.name)}</span>`
          + `<div class="trow"><span>체력</span><b>${c.hp}</b></div>`
          + `<div class="trow"><span>마력</span><b>${c.mana ?? '-'}</b></div>`
          + `<div class="trow"><span>${UI.esc(c.desc ?? '')}</span></div>`,
        on: () => { const g = newWorkGolem(cid); if (g) workGolemScreen(g.id); },
      };
    }),
    { label: '돌아간다', cls: 'ghost', pin: true, on: workshopScreen },
  ], { stage: true, stageTitle: '어떤 핵으로 세우는가' });
  save();
}

/** 조립대·작업반·파견 어디에도 묶이지 않은 여분 부속 */
function sparePool() {
  const o = S.ossuary;
  const equipped = new Set(SLOTS.map((x) => S.golem[x]).filter(Boolean));
  const inLabor = new Set((o.laborBay?.dispatch ?? []).flatMap((d) => (d.parts ?? []).map((p) => p.uid)));
  const inWork = new Set(O.workshopGolems(S).flatMap((g) => g.parts.map((p) => p.uid)));
  return S.inventory.filter((p) => !equipped.has(p.uid) && !inLabor.has(p.uid) && !inWork.has(p.uid));
}

/** 핵만 놓은 빈 골렘을 세운다. 부속은 플레이어가 고른다. */
function newWorkGolem(coreId) {
  const o = S.ossuary;
  if (!S.cores.includes(coreId)) {          // 여분 핵이 아니면 세울 수 없다
    UI.logLine('그 핵은 여분이 아니다.', 'bad');
    return null;
  }
  if (O.workshopGolems(S).length >= O.golemCap(o)) {   // 받침대가 모자라면 못 세운다 (§9.11)
    UI.logLine(`받침대가 꽉 찼다 — ${O.golemCap(o)}기까지다. 한 기를 해체하거나 제단에서 안치소를 넓혀야 한다.`, 'bad');
    return null;
  }
  S.cores = S.cores.filter((x) => x !== coreId);
  o.workshop.seq = (o.workshop.seq ?? 0) + 1;
  const g = {
    id: `wg${o.workshop.seq}`,
    name: `${o.workshop.seq + 1}호 골렘`,
    core: coreId,
    coreHp: null,
    parts: [],
    slots: {},          // 자리 → 부속 uid
    attachments: [], banned: [], retuned: {},
    assigned: null,
  };
  o.workshop.golems.push(g);
  UI.logLine(`${DB.coresBy[coreId].name}을(를) 받침대에 올렸다. 이제 부속을 붙이면 된다.`, 'good');
  save();
  return g;
}

/** 사역 골렘 한 기 — 자리마다 부속을 붙이고 뗀다 */
/* ── 사역 골렘 손보기 (§12.24) ─────────────────────
   탐험 골렘과 **같은 도식**을 쓴다. 전에는 이쪽만 줄글 목록이라,
   부위를 바꾸려면 「좌완 — …」 단추 여섯을 훑어야 했다.
   한 골렘을 손보는 일이 어디서 들어왔느냐에 따라 달라질 이유가 없다. */
function workGolemScreen(id, back = workshopScreen, focus = null) {
  const g = O.workshopGolems(S).find((x) => x.id === id);
  if (!g) { back(); return; }
  g.slots ??= {};
  const core = DB.coresBy[g.core];
  UI.topbar(S, `납골당 · ${g.name}`);

  const at = (slot) => {
    const p = g.parts.find((x) => x.uid === g.slots[slot]) ?? null;
    if (!p) return null;
    return { part: p, shield: shieldNow(p, slot), shieldMax: shieldMax(p, slot) };
  };
  const st = O.golemStats(g);
  const busy = g.assigned === 'labor' ? '자율 탐험 중' : g.assigned === 'crew' ? '작업반' : null;
  const spent = O.coreSpent(g);

  UI.bodyPanel({
    title: g.name,
    sub: core?.name ?? '핵 없음',
    hp: O.coreHpOf(g), hpMax: O.coreMaxOf(g),
    chips: [
      `<span class="chip ${spent ? 'warn' : ''}">핵 ${O.coreHpOf(g)}/${O.coreMaxOf(g)}</span>`,
      `<span class="chip">능률 ${O.golemPower(g)}</span>`,
      `<span class="chip">부속 ${g.parts.length}/6</span>`,
      busy ? `<span class="chip warn">${busy}</span>` : '',
    ].filter(Boolean),
    at,
    rows: [
      UI.rowHTML('능력치', `공격 ${st.atk} · 방어 ${st.def} · 속도 ${st.spd} · 집중 ${st.focus}`, ''),
      UI.rowHTML('일하는 값', '핵이 닳는다', busy ? '지금 일하는 중' : '쉬는 중'),
    ],
    note: `<p class="note">도식에서 <b>부위를 누르면</b> 거기에 끼울 것들이 오른쪽에 뜬다.<br>
      능률 <b>${O.golemPower(g)}</b> — 핵 체력의 1/10에 부속 능력치를 더한 값이다.
      작업반에 붙이면 해체대·단련로·정비대 작업 시간이 줄어든다 (상한 60%).<br>
      ${spent ? '<b>핵이 바닥났다</b> — 정비대에서 안정화해야 다시 일한다.' : ''}</p>`,
  }, (slot) => workGolemScreen(id, back, slot));

  UI.logHead(g.name);
  UI.logLine('받침대 위의 몸을 손본다.', 'narrate');
  if (!g.parts.length) UI.logLine('아직 부속이 하나도 없다. 능률은 핵 몫뿐이다.', 'dim');
  if (busy) UI.logLine(`${busy}이라 지금은 손볼 수 없다.`, 'dim');

  /* 부위를 누르면 **오른쪽이 곧장 그 자리의 교체 목록**이 된다 — 탐험 골렘과 같다 */
  if (focus) { workSlotCards(g, focus, back); return; }

  UI.choices([
    ...SLOTS.map((slot) => {
      const w = at(slot);
      return {
        label: `${SLOT_LABEL[slot]} — ${w ? UI.partHTML(w.part) : '<span class="empty">비어 있음</span>'}`,
        meta: w ? `${w.part.integrity}/${w.part.maxIntegrity} · 바꾸거나 뗀다` : '붙인다',
        info: w ? UI.partTip(w.part) : undefined,
        on: () => workGolemScreen(id, back, slot),
      };
    }),
    g.assigned === 'crew'
      ? { label: '작업반에서 물린다', cls: 'ghost', pin: true,
          on: () => { g.assigned = null; save(); workGolemScreen(id, back); } }
      : g.assigned === 'labor'
        ? { label: '자율 탐험을 나가 있다', cls: 'ghost', pin: true, disabled: true,
            meta: '자율 탐험에서 불러들인다' }
        : { label: '작업반에 붙인다', cls: 'primary', pin: true,
            meta: spent ? '핵이 바닥났다 — 정비대로' : `능률 ${O.golemPower(g)}`,
            disabled: spent || !canWork(g),
            on: () => { g.assigned = 'crew'; save(); workGolemScreen(id, back); } },
    { label: '이 골렘을 해체한다', cls: 'danger', pin: true,
      meta: g.assigned === 'labor' ? '자율 탐험 중에는 해체할 수 없다' : `핵과 부속 ${g.parts.length}개 회수`,
      disabled: g.assigned === 'labor',
      on: () => { disassembleWorkGolem(id); workshopScreen(); } },
    { label: '돌아간다', cls: 'ghost', pin: true, on: back },
  ], { stage: true, stageTitle: `${g.name} — 어디를 손볼까` });
  save();
}

/** 고른 자리에 끼울 것들 — 도식 옆에 바로 펼친다 (§12.24) */
function workSlotCards(g, slot, back) {
  const kind = SLOT_KIND[slot];
  const cur = g.parts.find((p) => p.uid === g.slots[slot]) ?? null;
  const busy = Boolean(g.assigned);
  const options = sparePool().filter((p) => DB.partsBy[p.defId].slot === kind);

  UI.logLine(`${SLOT_LABEL[slot]} — ${cur ? partName(cur) : '비어 있다'}.`, 'necro');
  if (busy) UI.logLine('일하는 중에는 부속을 건드릴 수 없다. 먼저 물려야 한다.', 'bad');
  else if (!options.length && !cur) UI.logLine(`${KIND_LABEL[kind]} 여분이 없다.`, 'dim');

  UI.choices([
    cur ? { label: `${UI.partHTML(cur)} 뗀다`, cls: 'ghost',
      meta: busy ? '일하는 중에는 못 뗀다' : '가진 것으로 되돌린다',
      disabled: busy,
      on: () => {
        g.parts = g.parts.filter((p) => p.uid !== cur.uid);
        delete g.slots[slot];
        S.inventory.push(cur);
        UI.logLine(`${partName(cur)}을(를) 뗐다.`, 'dim');
        save();
        workGolemScreen(g.id, back, slot);
      } } : null,
    ...options.map((p) => ({
      label: UI.partHTML(p),
      meta: busy ? '일하는 중에는 못 끼운다'
        : `${p.integrity}/${p.maxIntegrity}${p.plus ? ` · +${p.plus}` : ''}${p.raw ? ' · 날것' : ''}`,
      disabled: busy,
      info: UI.partTip(p),
      on: () => {
        if (cur) {                              // 끼워져 있던 것은 가진 것으로 돌아간다
          g.parts = g.parts.filter((x) => x.uid !== cur.uid);
          S.inventory.push(cur);
        }
        S.inventory = S.inventory.filter((x) => x.uid !== p.uid);
        g.parts.push(p);
        g.slots[slot] = p.uid;
        UI.logLine(`${SLOT_LABEL[slot]}에 ${partName(p)}을(를) 끼웠다.`, 'good');
        save();
        workGolemScreen(g.id, back, slot);
      },
    })),
    { label: '다른 자리', cls: 'ghost', pin: true, on: () => workGolemScreen(g.id, back) },
    { label: '돌아간다', cls: 'ghost', pin: true, on: back },
  ], { stage: true, stageTitle: `${SLOT_LABEL[slot]}에 넣을 것` });
  save();
}

/* (구) workSlotScreen — 도식 옆에 바로 펼치는 workSlotCards로 대체했다 (§12.24) */


function disassembleWorkGolem(id) {
  const o = S.ossuary;
  const g = o.workshop.golems.find((x) => x.id === id);
  if (!g) return;
  o.workshop.golems = o.workshop.golems.filter((x) => x.id !== id);
  S.cores.push(g.core);
  for (const p of g.parts) S.inventory.push(p);
  UI.logLine(`${g.name}을(를) 해체했다. 핵과 부속 ${g.parts.length}개를 돌려받았다.`, 'good');
  save();
}

/* ── 작업반 — 세워 둔 사역 골렘을 일에 붙인다 ───────────── */
function crewScreen() {
  const o = S.ossuary;
  UI.topbar(S, '납골당 · 작업반');
  const cs = O.crewSpeed(S);
  const golems = O.workshopGolems(S);
  const onDuty = golems.filter((g) => g.assigned === 'crew');

  UI.listPanel('작업반에 붙인 골렘',
    onDuty.map((g) => UI.rowHTML(DB.coresBy[g.core]?.name ?? '?', UI.esc(g.name),
      `능률 ${O.golemPower(g)} · ${coreChip(g)}`, O.coreHpOf(g) <= O.coreMaxOf(g) * 0.25)),
    `<p class="note">합계 능률 ${cs.power} → 해체대·단련로·정비대 작업 시간 <b>${Math.round(cs.cut * 100)}% 단축</b> (상한 60%).<br>
      자리는 ${onDuty.length}/${O.crewCap(o)}기 — 안치소를 넓히면 더 붙일 수 있다.<br>
      부속만으로는 일을 시킬 수 없다. <b>조립대</b>에서 핵을 넣어 세운 골렘만 붙일 수 있다.<br>
      일은 <b>핵을 갉는다</b> — 시간마다 ${O.CREW_HP_PER_HOUR}씩. 1에 닿으면 스스로 멈추고,
      <b>정비대의 핵 안정화</b>를 거쳐야 다시 일한다.</p>`);

  UI.logHead('작업반');
  UI.logLine('세워 둔 골렘에게 일을 맡긴다.', 'narrate');
  if (!golems.length) UI.logLine('조립대에 선 골렘이 없다. 먼저 핵을 넣어 한 기를 세워야 한다.', 'dim');

  UI.choices([
    ...onDuty.map((g) => ({
      label: `${g.name} 물린다`, cls: 'ghost',
      on: () => { g.assigned = null; crewScreen(); },
    })),
    ...golems.filter((g) => !g.assigned && whereOf({ id: g.id }) !== 'repair').map((g) => ({
      label: `${g.name} 붙인다`,
      meta: workBlock(g) ?? (onDuty.length >= O.crewCap(o)
        ? `자리가 없다 (${O.crewCap(o)}기까지)` : `능률 ${O.golemPower(g)} · ${coreChip(g)}`),
      disabled: !canWork(g) || onDuty.length >= O.crewCap(o),
      info: O.coreSpent(g) ? '정비대에서 <b>핵 안정화</b>를 마쳐야 다시 일할 수 있다.'
        : (g?.parts?.length ?? 0) < WORK_MIN_PARTS
          ? '조립대에서 부속을 하나라도 끼워야 일을 맡길 수 있다.' : undefined,
      on: () => {
        g.assigned = 'crew';
        UI.logLine(`${g.name}이(가) 일을 시작했다.`, 'good');
        crewScreen();
      },
    })),
    { label: '조립대로', cls: 'ghost', pin: true, on: workshopScreen },
    { label: '돌아간다', cls: 'ghost', pin: true, on: workshopHubScreen },
  ]);
  save();
}

/* ── 단련로 (옛 접합로) ───────────────────────
   이름을 바꿨다. 「접합로」는 무엇을 하는 곳인지 이름만으로는 알 수 없었고,
   실제로 하는 일도 일곱 가지로 흩어져 있었다. 이제 **두 가지만 한다** —
   무덤에서 갓 뜯어온 것을 길들이고(정착), 남는 부속을 먹여 키운다(강화). */
function forgeJobScreen() {
  const o = S.ossuary;
  UI.topbar(S, `납골당 · 단련로 ${o.forge.slots.length}/${O.forgeSlots(o)}칸`);
  const free = O.forgeSlots(o) - o.forge.slots.length;
  const equippedF = new Set(SLOTS.map((x) => S.golem[x]).filter(Boolean));
  const spare = S.inventory.filter((p) => !equippedF.has(p.uid));
  const rawSpare = spare.filter((p) => p.raw).length;
  const rawWorn = S.inventory.filter((p) => p.raw && equippedF.has(p.uid)).length;
  const r = O.RECIPES.attune;
  const attuneBlock = free <= 0 ? `단련로가 꽉 참 (${o.forge.slots.length}/${O.forgeSlots(o)}칸)`
    : !rawSpare ? (rawWorn ? '골렘에 붙인 날것뿐 — 먼저 떼어내라' : '정착할 날것이 없다')
    : shortText(r.cost) || null;
  /* 강화는 **바탕 하나 + 같은 자리 여분 하나**가 있으면 된다.
     바탕이 골렘에 붙어 있어도 되므로(§9.15-C), 붙인 자리와 같은 자리의 여분이
     하나라도 있으면 열린다 — 전에는 여분이 둘일 때만 열려서, 붙인 것을 키우려는
     사람에게는 문이 잠겨 보였다. */
  const spareBySlot = {};
  for (const p of spare) {
    const sl = DB.partsBy[p.defId].slot;
    spareBySlot[sl] = (spareBySlot[sl] ?? 0) + 1;
  }
  const wornSlots = new Set(SLOTS.map((x) => S.inventory.find((p) => p.uid === S.golem[x]))
    .filter(Boolean).map((p) => DB.partsBy[p.defId].slot));
  const canEnhance = Object.entries(spareBySlot)
    .some(([sl, n]) => n >= 2 || (n >= 1 && wornSlots.has(sl)));

  UI.listPanel('단련로에서 할 수 있는 일', [
    UI.rowHTML('정착', '날것을 길들여 <b>제 성능</b>이 나오게 한다',
      attuneBlock ?? `${Math.round(r.ms / 60000)}분`, Boolean(attuneBlock)),
    UI.rowHTML('부속 강화', `같은 자리 부속을 먹여 <b>+1 ~ +${EN.PLUS_MAX}</b>까지 키운다`,
      canEnhance ? '바로 된다' : '같은 자리 여분이 둘 이상 필요하다', !canEnhance),
    UI.rowHTML('핵 강화', `핵 가루로 <b>마력 · 체력 · 기술 칸</b>을 늘린다`,
      S.golem.core ? `${coreLevel(S)}강 · 가루 ${S.coreDust ?? 0}` : '핵이 없다', !S.golem.core),
  ], `<p class="note"><b>정착</b>은 무덤에서 주워 온 것을 쓸 수 있게 만드는 길이다 —
      날것은 능력치가 60%만 나오고, 기술이 넷 중 하나꼴로 불발되며, 내구도가 두 배로 닳는다.<br>
      <b>강화</b>는 쌓이는 여분을 쓰는 자리다. 한 단계마다 능력치 +${Math.round(EN.PLUS_STAT * 100)}%,
      기술 위력 +${Math.round(EN.PLUS_POWER * 100)}%.<br>
      재료로 쓸 수 있는 것은 <b>여분 부속</b>뿐이다 — 골렘에 붙인 것은 떼어내야 올릴 수 있다.
      (지금 여분 ${spare.length}개 · 날것 ${rawSpare}개)</p>`);

  UI.logHead('단련로');
  UI.logLine('불이 낮게 깔려 있다.', 'narrate');
  for (const j of o.forge.slots) {
    UI.logLine(`${O.RECIPES[j.recipe].name} — ${O.remainText(j.startedAt, j.durationMs)}`, 'dim');
  }
  if (rawSpare) UI.logLine(`정착하지 않은 날것 부속이 ${rawSpare}개 있다.`, 'bad');
  if (rawWorn) UI.logLine(`골렘에 붙인 날것이 ${rawWorn}개 있다. 떼어내야 정착시킬 수 있다.`, 'bad');
  if (free <= 0) {
    UI.logLine(`단련로가 꽉 찼다 (${o.forge.slots.length}/${O.forgeSlots(o)}칸). 지금 걸린 것이 끝나야 다음을 건다.`, 'bad');
    UI.logLine('제단에서 단련로를 증설하면 동시에 여러 개를 걸 수 있다.', 'dim');
  }

  UI.choices([
    { label: '🔥 정착 — 날것을 길들인다', cls: rawSpare && !attuneBlock ? 'primary' : '',
      meta: attuneBlock ?? `${Math.round(r.ms / 60000)}분 · ${Object.entries(r.cost).map(([k, v]) => `${O.RES_LABEL[k]} ${v}`).join(' · ')}`,
      disabled: Boolean(attuneBlock),
      now: true, on: () => recipeScreen('attune') },
    { label: `⚒ 부속 강화 — 부속을 먹여 키운다`,
      meta: canEnhance ? `+1 ~ +${EN.PLUS_MAX}` : '같은 자리 여분이 둘 이상 필요하다',
      disabled: !canEnhance,
      now: true, on: () => enhanceScreen(true) },
    /* 핵 강화는 **여기**로 왔다 (§3.11-A). 뼈 모루의 「영혼석 강화」였는데,
       쇠붙이를 두드리는 자리보다 부속을 키우는 자리 옆에 있는 편이 맞다 —
       둘 다 「그릇을 키우는 일」이다. */
    { label: '🔆 핵 강화 — 그릇을 키운다',
      meta: S.golem.core
        ? `${coreLevel(S)}강 · 가루 ${S.coreDust ?? 0}`
        : '핵이 없다',
      disabled: !S.golem.core,
      now: true, on: coreUpScreen },
    { label: '돌아간다', cls: 'ghost', pin: true, on: workshopHubScreen },
  ], { stage: true, stageTitle: '단련로 — 길들이고, 키운다' });
  save();
}

/* ── 강화 (§9.15) ─────────────────────────────
   두 걸음이다. 무엇을 키울지 고르고, 그 다음에 무엇을 먹일지 본다.
   확률과 잃는 것은 **누르기 전에** 전부 적는다 — 도박에서 숨기는 것은 사기다. */
/* ── 강화 작업대 (§9.15-D) ─────────────────────────────
   「재료로 쓸 아이템도 내가 고르고 싶다. 지금은 무작위로 들어가는 것 같다」 —
   무작위는 아니었고 **덜 아까운 것부터** 자동으로 골랐는데, 그게 더 나빴다.
   고르는 수고를 없애려다 **고르는 권리**를 빼앗았다. 강화 재료는 값나가는 물건이다.

   이제 한 화면에서 끝낸다. 왼쪽 맨 위에 **칸 둘**(강화할 것 · 재료)을 두고,
   칸을 고른 다음 오른쪽에서 부속을 누르면 그 칸으로 들어간다.
   담은 것을 다시 누르면 빠진다. */
let enh = { base: null, feed: [], picking: 'base', ward: false };

const enhReset = () => { enh = { base: null, feed: [], picking: 'base', ward: false }; };

function enhanceScreen(reset = false) {
  if (reset) enhReset();
  const byUid = (uid) => S.inventory.find((p) => p.uid === uid) ?? null;
  // 부서지거나 먹힌 것이 칸에 남아 있지 않게 한다
  if (enh.base && !byUid(enh.base)) { enh.base = null; enh.feed = []; }
  enh.feed = enh.feed.filter((uid) => byUid(uid));

  const equipped = new Set(SLOTS.map((x) => S.golem[x]).filter(Boolean));
  const slotOfPart = new Map(SLOTS.filter((x) => S.golem[x]).map((x) => [S.golem[x], x]));
  const spare = S.inventory.filter((p) => !equipped.has(p.uid));
  const worn = SLOTS.map((x) => byUid(S.golem[x])).filter(Boolean);

  const base = byUid(enh.base);
  const sl = base ? DB.partsBy[base.defId].slot : null;
  const cur = base?.plus ?? 0;
  const target = base ? Math.min(EN.PLUS_MAX, cur + 1) : 1;
  const need = base ? EN.partsNeeded(target) : 0;
  const cost = base ? EN.costOf(target) : null;
  const feed = enh.feed.map(byUid).filter(Boolean);
  const wards = S.consumables.it_ward_nail ?? 0;
  const wardName = DB.itemsBy.it_ward_nail?.name ?? '쐐기';
  const guarding = enh.ward && wards > 0 && base && EN.protectable(target);
  const maxed = base && cur >= EN.PLUS_MAX;
  const lackMat = cost ? shortText(cost) : null;
  const block = !base ? '강화할 것을 먼저 고른다'
    : maxed ? '이미 끝까지 컸다'
    : feed.length < need ? `재료가 ${need - feed.length}개 모자라다`
    : lackMat ?? null;

  UI.topbar(S, '단련로 · 강화');

  /** 부속 한 줄 — 강화 단계를 **이름 앞에 칩으로** 세운다. 이름이 길어 잘려도 보인다 */
  const plusChip = (p) => (p.plus ? `<span class="chip good">+${p.plus}</span> ` : '');
  const slotChip = (p) => (slotOfPart.has(p.uid)
    ? `<span class="chip">${SLOT_LABEL[slotOfPart.get(p.uid)]}</span> ` : '');

  const rows = [
    /* 칸 둘 — 누르면 그 칸이 「고르는 중」이 된다 */
    UI.rowHTML('강화할 것',
      base ? `${plusChip(base)}${slotChip(base)}${UI.partHTML(base, { noPlus: true })}`
        : '<span class="empty">비었다 — 오른쪽에서 고른다</span>',
      base ? `+${cur} → +${target}` : '고르는 중', !base, 'sel:base'),
    UI.rowHTML('재료',
      base ? (feed.length ? feed.map((p) => `${plusChip(p)}${UI.partHTML(p, { noPlus: true })}`).join('<br>')
        : '<span class="empty">비었다 — 오른쪽에서 고른다</span>')
        : '<span class="empty">강화할 것을 먼저</span>',
      base ? `${feed.length}/${need}개` : '', base && feed.length < need, 'sel:feed'),
  ];
  if (base && !maxed) {
    rows.push(
      UI.rowHTML('성공', `<b>${EN.SUCCESS[target]}%</b>`, EN.riskText(target), target > EN.PROTECT_FROM),
      UI.rowHTML('값', `<b>${Object.entries(cost).map(([k, v]) => `${O.RES_LABEL[k]} ${v}`).join(' · ')}</b>`,
        lackMat ?? '치를 수 있다', Boolean(lackMat)),
      UI.rowHTML('올라가는 것',
        `능력치 +${Math.round(EN.PLUS_STAT * target * 100)}% · 기술 위력 +${Math.round(EN.PLUS_POWER * target * 100)}%`,
        `지금 +${cur}`),
      UI.rowHTML(wardName, guarding ? '<b>쓴다</b> — 실패해도 잃지 않는다'
        : EN.protectable(target) ? '쓰지 않는다'
        : '<span class="empty">이 단계에서는 잃을 것이 없다</span>', `${wards}개`),
    );
  }
  rows.push(UI.rowHTML('─', '<b>강화의 규칙</b>', ''));
  for (let t = 1; t <= EN.PLUS_MAX; t++) {
    rows.push(UI.rowHTML(`+${t - 1}→+${t}`,
      `성공 <b>${EN.SUCCESS[t]}%</b> · 재료 ${EN.partsNeeded(t)}개`,
      EN.riskText(t), t > EN.PROTECT_FROM));
  }

  UI.listPanel(enh.picking === 'base' ? '강화 — 무엇을 키울까' : '강화 — 무엇을 먹일까', rows,
    `<p class="note">칸을 누르면 <b>고르는 칸</b>이 바뀌고, 오른쪽에서 부속을 누르면 그 칸으로 들어간다.
      재료로 담은 것을 다시 누르면 빠진다.<br>
      한 단계마다 능력치 +${Math.round(EN.PLUS_STAT * 100)}% · 기술 위력 +${Math.round(EN.PLUS_POWER * 100)}%, 최대 +${EN.PLUS_MAX}.
      재료는 <b>같은 자리</b>여야 하고, 먹인 것은 돌아오지 않는다.<br>
      <b>골렘에 붙인 것도 그대로 키운다</b> — 뗄 필요가 없다. 재료로 쓰는 것만 여분이어야 한다.</p>`,
    (key) => {
      if (key === 'sel:base') { enh.picking = 'base'; enhanceScreen(); return; }
      if (key === 'sel:feed') { if (base) enh.picking = 'feed'; enhanceScreen(); return; }
    },
    enh.picking === 'base' ? 'sel:base' : 'sel:feed');

  UI.logHead('강화');
  UI.logLine(enh.picking === 'base'
    ? '어느 것을 키울까. 붙인 것도 여분도 고를 수 있다.'
    : '같은 자리의 것을 녹여 한 짝에 붙인다.', 'narrate');

  /* 오른쪽 — 지금 고르는 칸에 담을 수 있는 것들.
     못 담는 것도 **지우지 않고 이유를 적는다** (§16.5-C) — 목록에서 사라지면
     「내 부속이 어디 갔지」가 된다. */
  const list = [];
  if (enh.picking === 'base') {
    const cardFor = (p) => {
      const psl = DB.partsBy[p.defId].slot;
      const full = (p.plus ?? 0) >= EN.PLUS_MAX;
      const spareSame = spare.filter((x) => x.uid !== p.uid && DB.partsBy[x.defId].slot === psl).length;
      const t2 = Math.min(EN.PLUS_MAX, (p.plus ?? 0) + 1);
      return {
        label: `${plusChip(p)}${slotChip(p)}${UI.partHTML(p, { noPlus: true })}`,
        meta: `${UI.RARITY_LABEL[UI.rarityOf(p)]} · ${p.integrity}/${p.maxIntegrity}`
          + ` · ${full ? '끝까지 컸다' : `다음 +${t2} 성공 ${EN.SUCCESS[t2]}% · 재료 ${EN.partsNeeded(t2)}개 (가진 여분 ${spareSame})`}`,
        cls: p.uid === enh.base ? 'on' : '',
        disabled: full,
        info: UI.partTip(p),
        on: () => {
          if (enh.base !== p.uid) enh.feed = [];       // 바탕이 바뀌면 재료도 비운다
          enh.base = p.uid;
          enh.picking = 'feed';                        // 곧바로 재료 고르기로 넘어간다
          enhanceScreen();
        },
      };
    };
    list.push(...worn.map(cardFor), ...spare.map(cardFor));
  } else {
    const pool = spare.filter((p) => DB.partsBy[p.defId].slot === sl && p.uid !== enh.base);
    for (const p of pool) {
      const inFeed = enh.feed.includes(p.uid);
      list.push({
        label: `${inFeed ? '<span class="chip warn">담음</span> ' : ''}${plusChip(p)}${UI.partHTML(p, { noPlus: true })}`,
        meta: `${UI.RARITY_LABEL[UI.rarityOf(p)]} · ${p.integrity}/${p.maxIntegrity}`
          + (inFeed ? ' · 누르면 뺀다' : (feed.length >= need ? ' · 재료가 다 찼다' : ' · 누르면 담는다')),
        cls: inFeed ? 'on' : '',
        disabled: !inFeed && feed.length >= need,
        info: UI.partTip(p),
        on: () => {
          enh.feed = inFeed ? enh.feed.filter((x) => x !== p.uid) : [...enh.feed, p.uid];
          enhanceScreen();
        },
      });
    }
    if (!pool.length) {
      list.push({ label: `${KIND_LABEL[sl]} 여분이 없다`, disabled: true, nokey: true,
        meta: '같은 자리의 여분만 먹일 수 있다' });
    }
  }
  /* 사역 골렘이 물고 있는 것은 여기 못 온다 — 없어진 것이 아니라 **거기 가 있다** */
  const heldBy = [];
  for (const g of O.workshopGolems(S)) {
    for (const p of g.parts ?? []) {
      if (enh.picking === 'feed' && DB.partsBy[p.defId].slot !== sl) continue;
      heldBy.push({ g, p });
    }
  }
  for (const { g, p } of heldBy.slice(0, 8)) {
    list.push({
      label: `${plusChip(p)}${UI.partHTML(p, { noPlus: true })}`,
      meta: `${g.name}에 끼워져 있다 — 조립대에서 빼야 쓴다`,
      disabled: true, nokey: true,
    });
  }

  UI.choices([
    { label: `+${target}으로 올린다`, cls: 'primary',
      meta: block ?? `성공 ${EN.SUCCESS[target]}% · ${EN.riskText(target)}`,
      disabled: Boolean(block),
      on: () => doEnhance(base, feed, cost, guarding) },
    // 고를 것들 — 지금 고르는 칸에 담을 수 있는 부속
    ...list,
    base && !maxed && EN.protectable(target) ? {
      label: guarding ? `${wardName}을 쓰지 않는다` : `${wardName}을 쓴다`,
      cls: 'ghost', meta: wards ? `${wards}개 가지고 있다` : '가진 것이 없다',
      disabled: !wards,
      on: () => { enh.ward = !enh.ward; enhanceScreen(); },
    } : null,
    feed.length ? { label: '재료를 비운다', cls: 'ghost',
      on: () => { enh.feed = []; enhanceScreen(); } } : null,
    base ? { label: enh.picking === 'base' ? '재료를 고른다' : '강화할 것을 바꾼다', cls: 'ghost',
      on: () => { enh.picking = enh.picking === 'base' ? 'feed' : 'base'; enhanceScreen(); } } : null,
    { label: '돌아간다', cls: 'ghost', pin: true, on: forgeJobScreen },
  ], { stage: true, stageTitle: enh.picking === 'base' ? '무엇을 키우는가' : `무엇을 먹일까 (${feed.length}/${need})` });
  save();
}

/** 실제로 굴린다. 결과는 **로그로 또박또박** 말한다 — 도박은 결과가 보여야 한다 */
function doEnhance(base, feed, cost, guarding) {
  const rng = makeRng((Date.now() ^ (S.seed ?? 1)) >>> 0);
  const name = partName(base);
  const wornAt = SLOTS.find((x) => S.golem[x] === base.uid) ?? null;
  for (const [k, v] of Object.entries(cost)) S[k] -= v;
  const eaten = new Set(feed.map((p) => p.uid));
  S.inventory = S.inventory.filter((p) => !eaten.has(p.uid));
  const res = EN.attempt(rng, base.plus ?? 0, guarding);
  if (res.usedProtect) S.consumables.it_ward_nail = Math.max(0, (S.consumables.it_ward_nail ?? 0) - 1);

  UI.logLine(`${feed.length}개를 녹여 ${name}에 붙인다.`, 'dim');
  if (res.ok) {
    base.plus = res.next;
    UI.logLine(`이음새가 붙었다. ${partName(base)} — +${res.next}.`, 'good');
  } else if (res.destroyed) {
    S.inventory = S.inventory.filter((p) => p.uid !== base.uid);
    /* 붙어 있던 것이 부서지면 **그 자리를 비워 둔다.** 골렘이 없는 부속을 가리킨 채
       남으면 그 다음 화면부터 전부 깨진다 (§9.15-C). */
    if (wornAt) S.golem[wornAt] = null;
    UI.logLine(`${name}이(가) 견디지 못하고 부서졌다.`
      + (wornAt ? ` ${SLOT_LABEL[wornAt]} 자리가 비었다.` : ''), 'bad');
  } else if (res.dropped) {
    base.plus = res.next || undefined;
    UI.logLine(`이음새가 풀렸다. ${name} — +${res.next}으로 내려갔다.`, 'bad');
  } else if (res.usedProtect) {
    UI.logLine(`실패했지만 쐐기가 버텨 줬다. ${name}은(는) +${res.next} 그대로다.`, 'necro');
  } else {
    UI.logLine(`실패했다. ${name}은(는) +${res.next} 그대로다.`, 'bad');
  }
  save();
  enh.feed = [];
  if (res.destroyed) { enh.base = null; enh.picking = 'base'; }
  enhanceScreen();
}

function recipeScreen(key, first = null) {
  const o = S.ossuary;
  const r = O.RECIPES[key];
  UI.topbar(S, `단련로 · ${r.name}`);
  ossPanel();
  UI.logLine(r.desc, 'dim');
  const costText = (rec) => Object.entries(rec.cost)
    .map(([k, v]) => `${O.RES_LABEL[k]} ${v}`).join(' · ') || '재료 없음';

  const start = (inputs, extra = {}) => {
    for (const [k, v] of Object.entries(r.cost)) S[k] -= v;
    for (const p of inputs) S.inventory = S.inventory.filter((x) => x.uid !== p.uid);
    const ms = O.jobDuration(S, r.ms);
    o.forge.slots.push({ recipe: key, inputs, startedAt: Date.now(), durationMs: ms, ...extra });
    UI.logLine(`${r.name} 작업을 걸었다. ${Math.round(ms / 60000)}분 뒤에 완성된다.`
      + (ms < r.ms ? ` (작업반이 ${Math.round((1 - ms / r.ms) * 100)}% 단축)` : ''), 'good');
    forgeJobScreen();
  };

  // 부속을 쓰지 않는 조리법은 고를 것이 없다 — 바로 건다
  if (r.noInput) {
    UI.choices([
      { label: `${r.name} 시작`, cls: 'primary',
        meta: `${costText(r)} → ${Object.entries(r.gives ?? {}).map(([k, v]) => `${O.RES_LABEL[k]} +${v}`).join(' · ')}`,
        disabled: !Object.entries(r.cost).every(([k, v]) => (S[k] ?? 0) >= v),
        on: () => start([]) },
      { label: '돌아간다', cls: 'ghost', pin: true, on: forgeJobScreen },
    ]);
    return;
  }

  if (key === 'revive') {
    UI.choices([
      ...o.vault.lostRecords.map((defId) => ({
        label: `${DB.partsBy[defId]?.name_template.replace('{mod}', '').replace('{owner}', DB.partsBy[defId].owner ?? '').trim()} 소생`,
        on: () => {
          o.vault.lostRecords = o.vault.lostRecords.filter((x) => x !== defId);
          start([], { defId });
        },
      })),
      { label: '돌아간다', cls: 'ghost', pin: true, on: forgeJobScreen },
    ]);
    return;
  }

  const equipped = new Set(SLOTS.map((x) => S.golem[x]).filter(Boolean));
  let pool = S.inventory.filter((p) => !equipped.has(p.uid));
  if (key === 'attune') {
    pool = pool.filter((p) => p.raw);
    UI.logLine('정착할 날것 부속을 고른다. 장착 중인 부속은 먼저 떼어내야 한다.', 'dim');
  }
  if (key === 'mend') {
    pool = pool.filter((p) => p.integrity < p.maxIntegrity);
    UI.logLine('수복할 부속을 고른다. 부패한 것도 되살릴 수 있다.', 'dim');
  }
  if (key === 'fuse' && first) {
    pool = pool.filter((p) => p.uid !== first.uid
      && DB.partsBy[p.defId].slot === DB.partsBy[first.defId].slot);
    UI.logLine(`${partName(first)}에 무엇을 이어붙일까. (같은 슬롯만 가능)`, 'dim');
  }

  UI.choices([
    ...pool.map((p) => {
      const def = DB.partsBy[p.defId];
      const go = () => {
        if (key !== 'fuse') { start([p]); return; }
        if (!first) { recipeScreen(key, p); return; }
        start([first, p], {
          skillsA: partSkills(first).slice(0, 1),
          skillsB: partSkills(p).slice(0, 1),
        });
      };
      const pick = key === 'fuse' && !first;
      return {
        // 이름이 잘려도 자리·내구도로 구분되고, 누르면 상세를 확인한 뒤에 건다
        label: UI.partHTML(p),
        meta: `${KIND_LABEL[def.slot]} · ${p.integrity}/${p.maxIntegrity}${p.raw ? ' · 날것' : ''}`,
        info: UI.partTip(p),
        on: () => partDetailScreen(p, () => recipeScreen(key, first), {
          title: `단련로 · ${r.name}`,
          ask: pick ? `${partName(p)}을(를) 바탕으로 삼을까?` : `${partName(p)}에 ${r.name}을(를) 걸까?`,
          note: pick ? '고르고 나면 이어붙일 상대를 고른다.'
            : `${Math.round(O.jobDuration(S, r.ms) / 60000)}분 · ${costText(r)}. 재료로 쓴 부속은 돌아오지 않는다.`,
          label: pick ? '이것으로 고른다' : `예, ${r.name}한다`,
          cls: pick ? 'primary' : 'danger',
          on: go,
        }),
      };
    }),
    { label: '돌아간다', cls: 'ghost', pin: true, on: forgeJobScreen },
  ]);
}

/* ── 자율 탐험 (§9.3-④) ───────────────────
   남는 골렘을 **내가 이미 깬 단계**로 돌려보낸다. 짧게 보내면 조금,
   길게 보내면 많이 주워 온다. 내구도는 한 번 굴려 한 칸 — 운이 좋으면 안 닳는다. */

/** 보낼 수 있는 곳 — 깬 단계들. 아직 하나도 못 깼으면 1-1을 얕게 훑는 것만 된다 */
function tripStages() {
  const out = [];
  DB.stageOrder.forEach((id, idx) => {
    if (!CP.isCleared(S, id)) return;
    const st = stageOf(id);
    out.push({ id, idx, name: `${partOf(id).name} · ${st.name}` });
  });
  if (!out.length) {
    const id = DB.stageOrder[0];
    out.push({ id, idx: 0, name: `${partOf(id).name} · ${stageOf(id).name} (얕은 곳)`, shallow: true });
  }
  return out;
}

function laborScreen() {
  const o = S.ossuary;
  UI.topbar(S, `납골당 · 자율 탐험 ${o.laborBay.dispatch.length}/${O.laborSlots(o)}칸`);
  const golems = O.workshopGolems(S);
  const byId = (id) => golems.find((g) => g.id === id);

  UI.listPanel('나가 있는 골렘',
    o.laborBay.dispatch.map((d) => {
      const g = byId(d.golemId);
      return UI.rowHTML(O.remainText(d.startedAt, d.durationMs), UI.esc(g?.name ?? '?'),
        d.stageName ?? '', !g);
    }),
    `<p class="note">한 번에 <b>${O.laborSlots(o)}기</b>까지 내보낼 수 있다
      (지금 ${o.laborBay.dispatch.length}/${O.laborSlots(o)}칸). 제단의 <b>안치소 증설</b>로 늘린다.<br>
      깬 단계로 돌려보내 조각·골분·진액·은화를 주워 오게 한다. 운이 좋으면 부속도.<br>
      주워 온 부속은 <b>가방</b>으로 들어오고, 날것이라 정착을 거쳐야 한다.<br>
      나가 있는 동안 그 골렘은 쓸 수 없다. 돌아올 때 부속 하나가 닳을 수 있다.<br>
      무덤으로 내려가는 일이라 <b>핵도 닳는다</b> — 시간마다 ${O.TRIP_HP_PER_HOUR}씩.
      바닥나면 정비대에서 안정화해야 다시 보낸다.</p>`);

  UI.logHead('자율 탐험');
  UI.logLine('지나온 길을 다시 훑게 한다.', 'narrate');
  for (const d of o.laborBay.dispatch) {
    UI.logLine(`${d.stageName} — ${byId(d.golemId)?.name ?? '?'} · ${O.remainText(d.startedAt, d.durationMs)}`, 'dim');
  }
  const free = O.laborSlots(o) - o.laborBay.dispatch.length;
  // 정비대에 올라간 몸은 보낼 수 없다 — 작업반이 이미 그렇게 하고 있다 (§9.14)
  const idle = golems.filter((g) => !g.assigned && canWork(g) && whereOf({ id: g.id }) !== 'repair');
  if (free <= 0) {
    UI.logLine(`안치소가 ${O.laborSlots(o)}칸뿐이다. 제단에서 안치소를 넓히면 더 보낼 수 있다.`, 'dim');
  }
  if (!golems.length) UI.logLine('조립대에 선 골렘이 없다. 여분 핵으로 한 기를 세워야 보낸다.', 'dim');
  else if (!idle.length) {
    const fixing = golems.filter((g) => !g.assigned && whereOf({ id: g.id }) === 'repair').length;
    if (fixing) UI.logLine(`정비대에 올라간 몸이 ${fixing}기 — 정비가 끝나야 보낼 수 있다.`, 'dim');
    const spent = golems.filter((g) => !g.assigned && O.coreSpent(g)).length;
    const empty = golems.filter((g) => !g.assigned && !canWork(g) && !O.coreSpent(g)).length;
    UI.logLine(spent
      ? `보낼 골렘이 없다. 핵이 바닥난 몸이 ${spent}기 — 정비대에서 안정화해야 다시 보낸다.`
      : empty
        ? `보낼 골렘이 없다. 핵만 있는 몸이 ${empty}기 — 조립대에서 부속을 끼워야 일을 맡길 수 있다.`
        : '놀고 있는 골렘이 없다. 작업반에 붙였거나 이미 나가 있다.', 'dim');
  }

  UI.choices([
    /* 보낼 골렘을 **여기서 바로 고른다.** 고르는 화면을 하나 더 두면
       재료를 캐러 들른 사람이 화면 넷을 지나야 골렘 하나를 내보낸다 (§9.10-A). */
    ...idle.map((g) => {
      const st = O.golemStats(g);
      const bonus = Math.round(Math.min(0.8, (st.atk + st.def + st.spd + st.focus) / 120) * 100);
      return {
        label: `${g.name} 보낸다`, cls: 'primary',
        meta: free <= 0 ? `안치소가 꽉 찼다 (${O.laborSlots(o)}칸)`
          : `수확 +${bonus}% · 부속 ${g.parts.length}개 · ${coreChip(g)}`,
        disabled: free <= 0,
        info: `<span class="tt">${UI.esc(g.name)}</span>`
          + `<span class="tm">공${st.atk} 방${st.def} 속${st.spd} 집${st.focus} · 수확 +${bonus}%</span>`
          + `<div class="trow">${g.parts.map((x) => `<span>${UI.partHTML(x)} ${x.integrity}/${x.maxIntegrity}</span>`).join('')}</div>`,
        on: () => tripPickStage(g.id),
      };
    }),
    ...o.laborBay.dispatch.map((d) => ({
      label: `${byId(d.golemId)?.name ?? '골렘'} 불러들인다`, cls: 'ghost',
      meta: `${O.remainText(d.startedAt, d.durationMs)} · 수확 없음`,
      info: '지금 불러들이면 빈손으로 돌아온다. 끝까지 두어야 수확이 있다.',
      on: () => {
        const g = byId(d.golemId);
        if (g) g.assigned = null;
        o.laborBay.dispatch = o.laborBay.dispatch.filter((x) => x !== d);
        UI.logLine(`${g?.name ?? '골렘'}을(를) 불러들였다. 빈손이다.`, 'dim');
        save();
        laborScreen();
      },
    })),
    !golems.length ? { label: '조립대에서 골렘을 세운다', cls: 'ghost',
      meta: `여분 핵 ${S.cores.length}개`, on: workshopScreen } : null,
    { label: '돌아간다', cls: 'ghost', pin: true, on: materialsScreen },
  ]);
  save();
}


/** ② 어디로, 얼마나 */
/* ── 자율 탐험 — 어디로, 얼마나 (§9.16) ─────────────
   전에는 「짧게·보통·길게」 셋을 **던전마다** 늘어놓아, 단계가 여섯이면 단추가 열여덟이었다.
   고르는 것이 아니라 훑는 일이 됐다. 이제 두 걸음이다 — 어디로 갈지 고르고,
   그 다음에 **눈금자로 시간을 정한다**(1~10시간). */
function tripPickStage(golemId) {
  const g = O.workshopGolems(S).find((x) => x.id === golemId);
  if (!g) { laborScreen(); return; }
  UI.topbar(S, `자율 탐험 · ${g.name}`);
  const stages = tripStages();
  const st = O.golemStats(g);
  const bonus = O.tripBonus(st);

  UI.listPanel('갈 수 있는 곳',
    stages.map((x) => UI.rowHTML(`${x.idx + 1}단계`, UI.esc(x.name),
      Object.entries(O.tripRate(x.idx)).filter(([, v]) => v)
        .map(([k, v]) => `${O.RES_LABEL[k]} ${Math.floor(v * bonus)}/시간`).join(' · '))),
    `<p class="note">깊이 들어간 곳일수록 많이 주워 온다. 깬 단계만 보낼 수 있다.<br>
      위 수치는 <b>${UI.esc(g.name)}</b>의 몫이 붙은 값이다 (능력치로 +${Math.round((bonus - 1) * 100)}%).<br>
      곳을 고르면 <b>시간을 눈금자로 정한다</b>.</p>`);

  UI.logHead('어디로');
  UI.logLine('지나온 길 중 어디를 다시 훑게 할까.', 'narrate');

  UI.choices([
    ...stages.map((x) => ({
      label: UI.esc(x.name),
      meta: `${x.idx + 1}단계 · ` + Object.entries(O.tripRate(x.idx)).filter(([, v]) => v)
        .map(([k, v]) => `${O.RES_LABEL[k]} ${Math.floor(v * bonus)}/시간`).join(' · '),
      now: true,                       // 누르면 곧장 시간 고르기로 (§12.20-A)
      on: () => tripTimeScreen(golemId, x.id),
    })),
    { label: '돌아간다', cls: 'ghost', pin: true, on: laborScreen },
  ], { stage: true, stageTitle: '어디로 보내는가' });
}

/** 기본 시간 — 너무 짧지도 길지도 않은 자리에서 시작한다 */
const TRIP_DEFAULT_H = 4;

function tripTimeScreen(golemId, stageId, hours = TRIP_DEFAULT_H) {
  const g = O.workshopGolems(S).find((x) => x.id === golemId);
  const stage = tripStages().find((x) => x.id === stageId);
  if (!g || !stage) { laborScreen(); return; }
  UI.topbar(S, `자율 탐험 · ${stage.name}`);
  const st = O.golemStats(g);
  const bonus = O.tripBonus(st);
  const rate = O.tripRate(stage.idx);
  let h = hours;

  const yieldText = (n) => Object.entries(rate).filter(([, v]) => v)
    .map(([k, v]) => `${O.RES_LABEL[k]} ${Math.floor(v * bonus * n)}`).join(' · ');

  UI.listPanel(stage.name, [
    UI.rowHTML('보내는 골렘', UI.esc(g.name), `능률 ${O.golemPower(g)}`),
    UI.rangeRow('triph', { min: O.TRIP_HOURS.min, max: O.TRIP_HOURS.max, value: h, label: '시간', valueText: `${h}시간` }),
    UI.rowHTML('예상 수확', '<span id="trip-yield"></span>', ''),
    UI.rowHTML('부속 주울 확률', '<b id="trip-luck"></b>', '집중이 높을수록 잘 줍는다'),
    UI.rowHTML('내구도 닳을 확률', '<b id="trip-wear"></b>', '방어가 높을수록 덜 닳는다'),
    UI.rowHTML('핵이 닳는 양', '<span id="trip-core"></span>', `핵 ${O.coreHpOf(g)}/${O.coreMaxOf(g)}`),
  ], `<p class="note">눈금자를 끌어 <b>${O.TRIP_HOURS.min}시간부터 ${O.TRIP_HOURS.max}시간까지</b> 정한다.
      오래 둘수록 많이 가져오지만 그만큼 몸이 닳는다.<br>
      이 골렘의 몫: 수확 +${Math.round((bonus - 1) * 100)}% ·
      집중 ${st.focus} · 방어 ${st.def} · 속도 ${st.spd}.</p>`);

  /** 눈금자가 움직일 때마다 숫자만 고쳐 쓴다 — 화면을 다시 그리지 않는다 */
  const paint = (n) => {
    h = n;
    UI.setText('triph-out', `${n}시간`);
    UI.setText('trip-yield', yieldText(n));
    UI.setText('trip-luck', `${O.tripPartLuck(stage.idx, n, st)}%`);
    UI.setText('trip-wear', `${O.tripWearChance(n, st)}%`);
    const core = Math.min(O.coreHpOf(g) - 1, Math.round(O.TRIP_HP_PER_HOUR * n));
    UI.setText('trip-core', `-${Math.max(0, core)} (${Math.max(1, O.coreHpOf(g) - core)}/${O.coreMaxOf(g)} 남는다)`);
    UI.setText('trip-send', `${n}시간 보낸다`);
  };
  UI.bindRange('triph', paint);

  UI.logHead('얼마나');
  UI.logLine('오래 두면 많이 가져오지만 그만큼 몸이 닳는다.', 'dim');

  UI.choices([
    { label: '<span id="trip-send">보낸다</span>', cls: 'primary',
      meta: '눈금자로 고른 시간만큼 보낸다',
      on: () => {
        g.assigned = 'labor';
        S.ossuary.laborBay.dispatch.push({
          golemId: g.id, hours: h, stageId: stage.id, stageIndex: stage.idx, stageName: stage.name,
          startedAt: Date.now(), durationMs: h * 3600_000,
        });
        UI.logLine(`${g.name}을(를) ${stage.name}으로 보냈다. ${h}시간 뒤에 돌아온다.`, 'good');
        save();
        laborScreen();
      } },
    { label: '다른 곳으로', cls: 'ghost', on: () => tripPickStage(golemId) },
    { label: '돌아간다', cls: 'ghost', pin: true, on: laborScreen },
  ], { stage: true, stageTitle: `${stage.name} — 얼마나 보낼까` });
  paint(h);                 // 선택지를 그린 뒤 한 번 더 — 단추 글자도 채워야 한다
}

/* ── 제단 (영구 해금) ─────────────────────
   제단은 **영영 돌아오지 않는 지출**이다. 영혼재는 무덤에서만 나오고(§10.1),
   한 번 태우면 되돌릴 수 없다. 그런데 화면은 단추 한 줄에 값만 적어 두고,
   무엇을 사는지는 **쪽지를 띄워야** 알 수 있었다 — 쪽지는 손가락으로 쓰는 화면에서
   잘 안 뜨고, 뜨더라도 짧다.

   그래서 제단은 **두 걸음**이 됐다. 누르면 왼쪽에 그것이 무엇인지 · 지금이 어떻고
   사고 나면 어떻게 되는지 · 왜 중요한지가 펼쳐지고, 그 다음에 태운다.
   중요한 지출 앞에서 한 걸음 쉬는 것은 **손해가 아니라 안전장치**다 (§12.20). */
function altarScreen(pick = null) {
  const o = S.ossuary;
  UI.topbar(S, '납골당 · 제단');
  quickHere('altar');

  /** 제단에 오른 것 하나 — 값·지금·나중·왜를 한 덩어리로 들고 있는다 */
  const offers = [];
  const add = (id, label, cost, now, then, why, fn, extra = null) =>
    offers.push({ id, label, cost, now, then, why, fn, extra });

  for (const [key, f] of Object.entries(O.FACILITIES)) {
    if (o.built[key]) continue;
    add(`build_${key}`, `${f.icon} ${f.name} 건설`, f.unlock,
      '아직 없다 — 이 시설의 일은 통째로 막혀 있다',
      `${f.name}이 열린다`,
      FACILITY_WHY[key] ?? '납골당의 시설 하나가 열린다.',
      () => { o.built[key] = true; UI.logLine(`${f.name}을(를) 세웠다.`, 'good'); });
  }

  const vatCost = 60 + o.rotVat.level * 40;
  add('vat', `부패조 확장 Lv${o.rotVat.level} → ${o.rotVat.level + 1}`, vatCost,
    `Lv${o.rotVat.level} · 저장 상한 ${O.vatCap(o)}`,
    `Lv${o.rotVat.level + 1} · 저장 상한 ${(o.rotVat.level + 1) * 50}`,
    `부패조는 넣어 둔 조각을 </b>진액<b>으로 삭힌다. 단계가 오르면 삭히는 속도와 담아 두는 양이
     함께 는다. 상한에 닿으면 생산이 멈추므로, 오래 자리를 비울수록 상한이 값어치를 한다.
     진액은 정착·강화·소생·핵 안정화에 들어간다 — 사역 골렘을 굴릴수록 많이 먹는다.`,
    () => { o.rotVat.level++; UI.logLine(`부패조가 커졌다. 상한 ${O.vatCap(o)}.`, 'good'); });

  if (o.built.dissection && o.dissection.level < 4) {
    add('dissect', `해체대 증설 (${o.dissection.level} → ${o.dissection.level + 1}칸)`, 50 * o.dissection.level,
      `${o.dissection.level}칸 — 한 번에 ${o.dissection.level}개까지 올린다`,
      `${o.dissection.level + 1}칸`,
      `해체대는 안 쓰는 부속을 </b>조각·진액·골분<b>으로 되돌린다. 칸이 늘면 한 번에 여러 개를
       걸어 둘 수 있다 — 유니크 하나가 두 시간짜리라, 칸이 하나뿐이면 그 사이 다른 것을 못 녹인다.`,
      () => { o.dissection.level++; });
  }
  if (o.built.forge && o.forge.level < 4) {
    add('forge', `단련로 증설 (${o.forge.level} → ${o.forge.level + 1}칸)`, 90 * o.forge.level,
      `${o.forge.level}칸`, `${o.forge.level + 1}칸`,
      `단련로는 </b>정착<b>이 도는 자리다 — 무덤에서 주워 온 날것을 온전하게 만드는
       유일한 길이라, 칸이 하나면 주워 온 것이 줄을 선다.
       (강화는 칸을 쓰지 않는다. 시간을 걸지 않으므로 늘 바로 된다.)`,
      () => { o.forge.level++; });
  }
  if (o.built.laborBay && o.laborBay.level < 3) {
    add('labor', `안치소 증설 (${o.laborBay.level} → ${o.laborBay.level + 1})`, 120 * o.laborBay.level,
      `받침대 ${O.golemCap(o)}기 · 자율 탐험 ${O.laborSlots(o)}칸 · 작업반 ${O.crewCap(o)}기`,
      `받침대 ${O.golemCap(o) + 1}기 · 자율 탐험 ${o.laborBay.level + 1}칸 · 작업반 ${o.laborBay.level + 2}기`,
      `한 번에 </b>세 가지<b>가 늘어난다 — 세워 둘 수 있는 사역 골렘(받침대), 동시에 내보낼 수 있는
       자율 탐험 칸, 작업반에 붙일 수 있는 기수. 제단에서 가장 값이 큰 대신 가장 넓게 퍼지는 확장이다.
       사역 골렘은 일을 시키면 핵이 닳으므로, 기수가 늘면 </b>번갈아 쉬게 할 수 있다.<b>`,
      () => {
        o.laborBay.level++;
        UI.logLine(`안치소가 넓어졌다. 받침대 ${O.golemCap(o)}기 · 자율 탐험 ${O.laborSlots(o)}칸 · 작업반 ${O.crewCap(o)}기.`, 'good');
      });
  }
  if (o.built.vault && o.vault.level < O.VAULT_MAX_LV) {
    add('vault', `창고 확장 (${O.vaultCap(o)} → ${O.vaultCap(o) + O.VAULT_STEP}칸)`, 40 + o.vault.level * 30,
      `${o.vault.parts.length}/${O.vaultCap(o)}칸 차 있다`, `${O.vaultCap(o) + O.VAULT_STEP}칸`,
      `창고에 맡겨 둔 부속은 무덤에서 골렘이 무너져도 </b>흘리지 않는다<b>.
       깊이 내려갈수록 들고 갈 여분을 줄이고 싶어지는데, 그때 맡길 자리가 필요하다.`,
      () => { o.vault.level++; });
  }
  if (o.capStep < O.CAP_STEPS.length - 1) {
    add('cap', `오프라인 상한 확장 (${Math.round(o.offlineCapMs / O.HOUR)} → ${Math.round(O.CAP_STEPS[o.capStep + 1] / O.HOUR)}시간)`,
      O.CAP_COST, `${Math.round(o.offlineCapMs / O.HOUR)}시간까지 정산한다`,
      `${Math.round(O.CAP_STEPS[o.capStep + 1] / O.HOUR)}시간`,
      `자리를 비운 사이의 생산은 </b>이 시간까지만<b> 계산된다. 하루를 비워도 상한이 8시간이면
       8시간치만 들어온다. 하루에 한 번 들르는 사람에게는 이것이 곧 수입이다.`,
      () => { o.capStep++; o.offlineCapMs = O.CAP_STEPS[o.capStep]; });
  }
  if (S.unlocks.salvage < 3) {
    add('salvage', `잔해 수습 (회수율 +${(S.unlocks.salvage + 1) * 10}%p)`, 100 + 80 * S.unlocks.salvage,
      `+${S.unlocks.salvage * 10}%p`, `+${(S.unlocks.salvage + 1) * 10}%p`,
      `골렘이 무너지면 장착한 부속을 확률로만 건진다. 그 확률이 영구히 오른다 —
       </b>패배가 덜 아프게<b> 만드는 유일한 확장이라, 깊이 내려갈수록 값어치가 커진다.`,
      () => { S.unlocks.salvage++; UI.logLine('무너진 골렘에서 더 건질 수 있게 됐다.', 'good'); });
  }
  if (S.unlocks.partPool < 2) {
    add('pool', '수소문 (상점 부속 등급 ↑)', 140 + 120 * S.unlocks.partPool,
      `단계 ${S.unlocks.partPool}`, `단계 ${S.unlocks.partPool + 1}`,
      `바르그의 손수레에 </b>더 좋은 등급의 부속<b>이 들어온다. 무덤에서 나오기를 기다리지 않고
       은화로 살 수 있게 되는 셈이라, 은화가 남아도는 판에서 특히 값어치가 있다.`,
      () => { S.unlocks.partPool++; S.town.stock = rollStock(rng, S.unlocks);
              UI.logLine('바르그가 아는 사람을 통해 더 나은 것이 들어온다.', 'good'); });
  }
  if (!S.unlocks.modTier) {
    add('mod', '이상 감식 (tier 2 이상 조기 등장)', 260, '1단계 이상만 붙는다', '2단계 이상도 붙는다',
      `몬스터에 붙는 </b>수식어<b>가 드랍하는 부속에 그대로 계승된다. 높은 단계의 수식어는
       배율이 크고 기술을 하나 더 얹는다 — 같은 부속의 값어치가 통째로 달라진다.`,
      () => { S.unlocks.modTier = 1; UI.logLine('이상한 것을 알아보는 눈이 생겼다.', 'good'); });
  }
  if (S.unlocks.necroSlots < 5) {
    add('necro', `술법 장착 칸 (${S.unlocks.necroSlots} → ${S.unlocks.necroSlots + 1})`,
      150 * (S.unlocks.necroSlots - 2), `${S.unlocks.necroSlots}칸`, `${S.unlocks.necroSlots + 1}칸`,
      `네크로맨서의 술법은 </b>모든 런에 따라온다<b>. 칸이 늘면 회복·소환·공격을 함께 들고
       갈 수 있다 — 골렘 빌드가 못 메우는 구멍을 메우는 자리다.`,
      () => { S.unlocks.necroSlots++; S.necro.equipped.push(null); });
  }

  const sel = offers.find((x) => x.id === pick) ?? null;

  /* 왼쪽: 고른 것이 있으면 **그것의 설명**, 없으면 시설 도식 그대로 */
  if (sel) {
    const short = S.soulAsh < sel.cost;
    UI.listPanel(sel.label, [
      UI.rowHTML('값', `<b>영혼재 ${sel.cost}</b>`, short ? `${sel.cost - S.soulAsh} 모자라다` : '치를 수 있다', short),
      UI.rowHTML('가진 것', `영혼재 ${S.soulAsh}`, ''),
      UI.rowHTML('남는 것', `영혼재 ${Math.max(0, S.soulAsh - sel.cost)}`, ''),
      UI.rowHTML('지금', sel.now, ''),
      UI.rowHTML('사고 나면', `<b>${sel.then}</b>`, ''),
    ], `<p class="note">${sel.why}</p>
      <p class="note"><b>제단의 지출은 되돌릴 수 없다.</b>
      영혼재는 무덤에서만 나온다 — 방치로는 한 톨도 벌리지 않는다.</p>`);
  } else {
    ossPanel();
  }

  /* 고를 때마다 화면을 다시 그리므로, 머리말까지 매번 찍으면 로그가 제단으로 도배된다.
     처음 들어왔을 때만 자리를 설명하고, 고른 뒤에는 고른 것만 한 줄 적는다. */
  if (sel) {
    UI.logLine(`${sel.label} — 왼쪽에 적어 뒀다. 값은 영혼재 ${sel.cost}.`, 'necro');
  } else {
    UI.logHead('제단');
    UI.logLine('영혼재를 태우는 자리.', 'narrate');
    UI.logLine('무엇이든 눌러 보라. 왼쪽에 그것이 무엇인지 적힌다. 태우는 것은 그 다음이다.', 'dim');
  }

  const list = [];
  if (sel) {
    const short = S.soulAsh < sel.cost;
    list.push({
      label: `${sel.label} — 태운다`, cls: 'primary',
      meta: short ? `영혼재 ${sel.cost} · ${sel.cost - S.soulAsh} 모자라다` : `영혼재 ${sel.cost} → ${S.soulAsh - sel.cost} 남는다`,
      disabled: short,
      on: () => { S.soulAsh -= sel.cost; sel.fn(); altarScreen(); },
    });
    list.push({ label: '고르지 않는다', cls: 'ghost', on: () => altarScreen() });
  }
  for (const it of offers) {
    if (sel && it.id === sel.id) continue;
    list.push({
      label: it.label,
      /* 값은 **언제나** 앞에 적는다 (§12.12) — 모자랄 때는 부족분까지 */
      meta: `영혼재 ${it.cost}${S.soulAsh < it.cost ? ` (${it.cost - S.soulAsh} 모자라다)` : ''} · ${it.then}`,
      cls: S.soulAsh < it.cost ? 'ghost' : '',
      now: true,                    // 누르면 곧장 왼쪽에 펼친다 (§12.20-A)
      on: () => altarScreen(it.id),
    });
  }
  list.push({ label: '돌아간다', cls: 'ghost', pin: true, on: ossuaryScreen });
  UI.choices(list, { stage: true, stageTitle: sel ? `제단 — ${sel.label}` : '제단 — 영혼재를 태운다' });
  save();
}

/** 아직 없는 시설이 무엇을 여는가 — 짓기 전에는 이름만으로 알 수가 없다 */
const FACILITY_WHY = {
  rotVat: `넣어 둔 조각을 시간이 <b>진액</b>으로 삭힌다. 손을 대지 않아도 도는 유일한 생산이다.`,
  dissection: `안 쓰는 부속을 <b>조각·진액·골분</b>으로 되돌린다. 등급이 높을수록 오래 걸리고 많이 나온다.`,
  vault: `부속을 맡겨 두는 창고. <b>자율 탐험이 주워 온 것이 여기로 들어온다</b> — 없으면 주워 올 자리가 없다.`,
  forge: `무덤에서 주워 온 <b>날것을 길들이는 유일한 길</b>(정착)이고, 남는 부속을 먹여 한 짝을 키우는 자리(강화)다.`,
  laborBay: `여분 핵으로 세운 <b>사역 골렘</b>에게 일을 시킨다 — 작업반으로 모든 작업 시간을 줄이고,
    자율 탐험으로 깬 단계에 보내 재료와 부속을 주워 오게 한다. 납골당이 스스로 도는 시작점이다.`,
};

/* ── 의뢰소 ─────────────────────────────── */
/* ── 마을 대분류 (§12.8) ─────────────────────────────
   타일이 아홉이면 고를 것이 아니라 읽을 것이 된다. 하는 일이 같은 것끼리 묶고,
   묶음 안에서 다시 고르게 한다. 대분류 타일은 안에 무엇이 있는지를 한 줄로 요약한다. */

/** 📜 의뢰소 — 세 건짜리 의뢰와 하루짜리 일을 한 게시판에 (§10.2) */
function boardScreen() {
  UI.topbar(S, '시체골 · 의뢰소');
  quickHere('quest');
  const q = S.quests.active;
  const d = S.daily?.list ?? [];
  UI.listPanel('게시판', [
    ...q.map((x) => UI.rowHTML('의뢰', UI.esc(x.title), x.done ? '완료' : `${x.have ?? 0}/${x.need ?? 1}`, !x.done)),
    ...d.map((x) => UI.rowHTML('오늘', UI.esc(x.title), x.done ? '완료' : `${x.have ?? 0}/${x.need ?? 1}`, !x.done)),
  ], `<p class="note">의뢰 세 건은 <b>한 세트로</b> 갈린다 — 셋을 다 마쳐야 다음 판이 걸린다.<br>
      오늘의 일은 자정에 새로 걸리고, 남은 것은 사라진다.</p>`);

  UI.logHead('의뢰소');
  UI.logLine('널빤지에 종이 여섯 장.', 'narrate');

  UI.choices([
    { label: '의뢰 세 건', cls: questsAllDone(S) ? 'primary' : '',
      meta: `${q.filter((x) => x.done).length}/3${questsAllDone(S) ? ' · 수령할 수 있다' : ''}`,
      info: '한 세트로 갈린다. 셋을 다 마치면 보상을 받고 새 세 건이 걸린다.',
      on: questScreen },
    { label: '오늘의 일', meta: `${d.filter((x) => x.done).length}/${d.length} · 자정에 갱신`,
      info: '하루짜리 짧은 일. 자정을 넘기면 새것으로 바뀐다.',
      on: dailyScreen },
    { label: '돌아간다', cls: 'ghost', pin: true, on: () => town(false) },
  ], { stage: true, stageTitle: '의뢰소' });
  save();
}

/** 🏪 저잣거리 — 손수레·뼈 모루·조합을 한 골목으로 (§10.3~10.5) */
function marketScreen() {
  const bs = buildingStatus(S);
  UI.topbar(S, '시체골 · 저잣거리');
  quickHere('market');
  UI.listPanel('골목의 셋', [
    UI.rowHTML('🛒 손수레', '사고판다', bs.shop),
    UI.rowHTML('🔨 뼈 모루', '부착물 제작 · 핵 강화', bs.forge),
    UI.rowHTML('🕯 조합', '네크로맨서의 술법', bs.conclave),
  ], `<p class="note">은화 ${S.silver} · 영혼재 ${S.soulAsh}.
      손수레는 은화로, 조합은 영혼재로 산다.</p>`);

  UI.logHead('저잣거리');
  UI.logLine('좁은 골목에 수레 하나, 모루 하나, 초 켜진 문 하나.', 'narrate');

  UI.choices([
    { label: '🛒 손수레', meta: bs.shop, info: '부속과 소모품을 은화로 사고, 안 쓰는 부속을 판다.', on: shopScreen },
    { label: '🔨 뼈 모루', meta: bs.forge, info: '골렘에 다는 부착물을 만들고, 핵을 강화한다.', on: forgeScreen },
    { label: '🕯 조합', meta: bs.conclave, info: '네크로맨서 본인의 술법을 영혼재로 배운다.', on: conclaveScreen },
    { label: '돌아간다', cls: 'ghost', pin: true, on: () => town(false) },
  ], { stage: true, stageTitle: '저잣거리' });
  save();
}

function questScreen() {
  UI.topbar(S, '시체골 · 의뢰소');
  const rows = S.quests.active.map((q) =>
    UI.rowHTML(q.type, `${UI.esc(q.title)}<br><span style="color:var(--muted);font-size:.84em">${UI.esc(q.desc)}</span>`,
      q.done ? '완료' : `${q.progress}/${q.goal}`, false));
  UI.listPanel('게시된 의뢰 3건', rows,
    `<p class="note">셋을 모두 마치면 새 의뢰가 게시된다. 리셋 비용은 누적으로 오른다.</p>`);

  UI.logHead('의뢰소');
  UI.logLine('낡은 게시판에 의뢰 세 건이 못 박혀 있다.', 'narrate');
  for (const q of S.quests.active) {
    UI.logLine(`[${q.type}] ${q.title} — ${q.desc} (${q.progress}/${q.goal})`, q.done ? 'good' : '');
  }

  const all = questsAllDone(S);
  const cost = nextResetCost(S);
  UI.choices([
    all ? { label: '보상 수령 · 새 의뢰 받기', cls: 'primary', on: () => {
      const got = claimQuests(S, rng);
      UI.logLine(`보상: 은화 ${got.silver}, 영혼재 ${got.soulAsh}.`, 'good');
      UI.logLine('새 의뢰 세 건이 걸렸다.', 'dim');
      questScreen();
    } } : null,
    { label: '의뢰 전부 새로 뽑기', meta: money(cost), disabled: S.silver < cost, on: () => {
      const r = resetQuests(S, rng);
      if (r.ok) UI.logLine(`은화 ${r.cost}을 치르고 게시판을 갈아엎었다.`, 'dim');
      questScreen();
    } },
    { label: '돌아간다', cls: 'ghost', pin: true, on: boardScreen },
  ]);
  save();
}

/* ── 상점 ───────────────────────────────── */
/* 상점에서 고른 물건. 화면을 다시 그려도 고른 것을 기억한다 (§12.10) */
let shopPick = null;
const resetShopPick = () => { shopPick = null; };

/**
 * 썩은 손수레.
 * 전에는 **같은 재고를 두 벌** 늘어놓았다 — 왼쪽에 읽는 목록, 아래에 사는 버튼.
 * 그래서 재고가 아홉이면 하단이 일곱 쪽으로 갈렸다.
 * 이제 **왼쪽 목록을 눌러 고르고, 하단에는 그 물건에 할 수 있는 것만 둔다.**
 */
function shopScreen() {
  UI.topbar(S, '시체골 · 썩은 손수레');
  const stock = S.town.stock;
  const supply = tickSupply(S);

  // 고른 것이 팔려 없어졌으면 고름을 푼다
  const alive = (key) => {
    if (!key) return false;
    const [kind, id] = key.split(':');
    if (kind === 'item') return stock.items.includes(id);
    if (kind === 'core') return (stock.cores ?? []).includes(id);
    if (kind === 'part') return stock.parts.some((p) => p.uid === id);
    if (kind === 'supply') return SUPPLY.some((d) => d.key === id);
    return false;
  };
  if (!alive(shopPick)) shopPick = null;

  const rows = [
    ...(stock.cores ?? []).map((id) => {
      const c = DB.coresBy[id];
      return UI.rowHTML('핵', `${UI.esc(c.name)}<br><span style="color:var(--muted);font-size:.84em">${UI.esc(c.desc)}</span>`,
        money(c.price), S.silver < c.price, `core:${id}`);
    }),
    ...stock.items.map((id) => {
      const it = DB.itemsBy[id];
      return UI.rowHTML(it.kind, `${UI.esc(it.name)}<br><span style="color:var(--muted);font-size:.84em">${UI.esc(it.desc)}</span>`,
        money(it.price), S.silver < it.price, `item:${id}`);
    }),
    ...stock.parts.map((p) => UI.rowHTML(KIND_LABEL[DB.partsBy[p.defId].slot] ?? '파츠',
      UI.partHTML(p), money(partPrice(p)), S.silver < partPrice(p), `part:${p.uid}`)),
    ...SUPPLY.map((d) => {
      const st = supply[d.key];
      const left = supplyRemain(st, d);
      return UI.rowHTML('보급', UI.esc(d.name),
        `${st.n}/${d.cap} · ${money(d.price)}` + (left ? ` · +1 ${O.remainText(Date.now(), left)}` : ''),
        st.n === 0 || S.silver < d.price, `supply:${d.key}`);
    }),
  ];
  UI.listPanel('오늘의 재고', rows,
    `<p class="note">줄을 누르면 아래에 <b>사는 버튼</b>이 뜬다.<br>
     쓰지 않는 파츠는 팔아서 은화로 바꿀 수 있다.<br>
     보급품은 수레가 시간이 지나며 조금씩 받아 둔다 — 칸이 차면 더는 쌓이지 않는다.</p>`,
    (key) => { shopPick = shopPick === key ? null : key; shopScreen(); }, shopPick);

  UI.logHead('썩은 손수레');
  UI.logLine('수레 가득 잡동사니가 실려 있다. 주인은 당신과 눈을 마주치지 않는다.', 'narrate');

  const list = [];
  const [kind, id] = (shopPick ?? '').split(':');
  if (!shopPick) {
    UI.logLine('왼쪽 재고에서 사고 싶은 것을 누르면 여기에 사는 버튼이 뜬다.', 'dim');
  } else if (kind === 'item') {
    const it = DB.itemsBy[id];
    list.push({ label: `${it.name} 구입`, cls: 'primary', meta: money(it.price),
      info: UI.esc(it.desc), disabled: S.silver < it.price, on: () => {
        S.silver -= it.price;
        S.consumables[id] = (S.consumables[id] ?? 0) + 1;
        UI.logLine(`${it.name}을(를) 샀다.`, 'good');
        shopScreen();
      } });
  } else if (kind === 'core') {
    const c = DB.coresBy[id];
    list.push({ label: `${c.name} 구입`, cls: 'primary', meta: money(c.price),
      info: UI.esc(c.desc), disabled: S.silver < c.price, on: () => {
        S.silver -= c.price;
        S.cores.push(id);
        S.town.stock.cores = S.town.stock.cores.filter((x) => x !== id);
        shopPick = null;
        UI.logLine(`${c.name}을(를) 샀다. 골렘 정비에서 끼울 수 있다.`, 'good');
        shopScreen();
      } });
  } else if (kind === 'part') {
    const p = stock.parts.find((x) => x.uid === id);
    const price = partPrice(p);
    list.push({ label: `${UI.partHTML(p)} 구입`, cls: 'primary', meta: money(price),
      info: UI.partTip(p), disabled: S.silver < price, on: () => {
        S.silver -= price;
        S.inventory.push(p);
        S.town.stock.parts = S.town.stock.parts.filter((x) => x !== p);
        shopPick = null;
        UI.logLine(`${partName(p)}을(를) 손에 넣었다.`, 'good');
        shopScreen();
      } });
  } else if (kind === 'supply') {
    const d = SUPPLY.find((x) => x.key === id);
    const st = supply[d.key];
    const bulk = Math.min(st.n, Math.floor(S.silver / d.price), 10);
    list.push({ label: `${d.name} 1개 구입`, cls: 'primary',
      meta: `${money(d.price)} · 재고 ${st.n}/${d.cap}`,
      disabled: st.n < 1 || S.silver < d.price, on: () => buySupply(d, 1) });
    if (bulk > 1) {
      list.push({ label: `${d.name} ${bulk}개 구입`, meta: money(d.price * bulk),
        on: () => buySupply(d, bulk) });
    }
  }
  if (shopPick) list.push({ label: '고르기 취소', cls: 'ghost', on: () => { shopPick = null; shopScreen(); } });
  list.push({ label: '파츠 팔기', cls: 'ghost', pin: true, on: sellScreen });
  list.push({ label: '돌아간다', cls: 'ghost', pin: true, on: marketScreen });
  UI.choices(list);
  save();
}

function buySupply(d, n) {
  const st = tickSupply(S)[d.key];
  const take = Math.min(n, st.n, Math.floor(S.silver / d.price));
  if (take < 1) { UI.logLine('수레에 남은 게 없다.', 'bad'); shopScreen(); return; }
  if (st.n >= d.cap) st.at = Date.now();   // 가득 찬 칸에서 빼면 그때부터 다시 찬다
  st.n -= take;
  S.silver -= d.price * take;
  S[d.key] = (S[d.key] ?? 0) + take;
  UI.logLine(`${d.name} ${take}개를 샀다.`, 'good');
  shopScreen();
}

function sellScreen() {
  UI.topbar(S, '시체골 · 파츠 판매');
  const equipped = new Set(SLOTS.map((s) => S.golem[s]).filter(Boolean));
  const sellable = S.inventory.filter((p) => !equipped.has(p.uid));
  UI.listPanel('팔 수 있는 파츠',
    sellable.map((p) => UI.rowHTML(KIND_LABEL[DB.partsBy[p.defId].slot], UI.partHTML(p),
      `${p.integrity}/${p.maxIntegrity} · ${sellPrice(p)}`)),
    '<p class="note">장착 중인 파츠는 팔 수 없다.</p>');
  UI.logLine('무엇을 넘길까.', 'dim');
  UI.choices([
    ...sellable.map((p) => ({
      label: `${UI.partHTML(p)} 판매`, meta: money(sellPrice(p)), info: UI.partTip(p), on: () => {
        S.silver += sellPrice(p);
        S.inventory = S.inventory.filter((x) => x.uid !== p.uid);
        UI.logLine(`${partName(p)}을(를) 넘겼다. (+${sellPrice(p)})`, 'good');
        notifyQuests({ kind: 'dismantle', count: 1 });
        sellScreen();
      },
    })),
    { label: '돌아간다', cls: 'ghost', pin: true, on: shopScreen },
  ]);
  save();
}

/* ── 대장간 ─────────────────────────────── */
function forgeScreen() {
  UI.topbar(S, '시체골 · 뼈 모루');
  const owned = S.owned.attachments;
  const equipped = S.golem.attachments ?? [];
  UI.listPanel('제작 가능한 부착물',
    DB.attachments.map((a) => UI.rowHTML(
      owned.includes(a.id) ? (equipped.includes(a.id) ? '장착' : '보유') : '미보유',
      `${UI.esc(a.name)}<br><span style="color:var(--muted);font-size:.84em">${UI.esc(a.desc)}</span>`,
      priceText({ silver: a.price, ...(a.materials ?? {}) }))),
    `<p class="note">부착물은 파츠 슬롯을 쓰지 않는다. 골렘당 ${ATTACH_SLOTS}칸.</p>`);

  UI.logHead('뼈 모루');
  UI.logLine('대장장이는 뼈를 다루는 데 익숙하다. 묻지 않고 두드린다.', 'narrate');

  const list = [];
  for (const a of DB.attachments) {
    if (a.effect.op === 'retune') continue;
    if (!S.owned.attachments.includes(a.id)) {
      const cost = { silver: a.price, ...(a.materials ?? {}) };
      const lack = shortText(cost);
      list.push({ label: `${a.name} 제작`,
        meta: `${priceText(cost)}${lack ? ` (${lack})` : ''}`,
        disabled: Boolean(lack),
        info: `<span class="tt">${UI.esc(a.name)}</span><div class="trow"><span>값</span><b>${priceText(cost)}</b></div>`,
        on: () => {
        craft(S, a);
        UI.logLine(`${a.name}을(를) 만들었다.`, 'good');
        forgeScreen();
      } });
    } else if (!equipped.includes(a.id)) {
      list.push({ label: `${a.name} 장착`, meta: `${equipped.length}/${ATTACH_SLOTS}`,
        disabled: equipped.length >= ATTACH_SLOTS, on: () => {
          S.golem.attachments.push(a.id);
          UI.logLine(`${a.name}을(를) 골렘에 붙였다.`, 'good');
          forgeScreen();
        } });
    } else {
      list.push({ label: `${a.name} 해제`, cls: 'ghost', on: () => {
        S.golem.attachments = S.golem.attachments.filter((x) => x !== a.id);
        forgeScreen();
      } });
    }
  }
  const cru = DB.attachmentsBy.at_crucible;
  /* (구) 영혼석 강화 — 납골당 단련로의 핵 강화로 옮겼다 (§3.11-A).
     쇠붙이를 두드리는 자리보다 부속을 키우는 자리 옆이 맞다. */
  list.push({ label: '속성 도가니 · 스킬 속성 변경', meta: money(cru.price),
    disabled: !canCraft(S, cru), on: retuneScreen });
  list.push({ label: '돌아간다', cls: 'ghost', pin: true, on: marketScreen });
  UI.choices(list);
  save();
}

/* (구) 대장간 파츠 강화 — 납골당 단련로의 강화 하나로 합쳤다 (§9.15).
   같은 「강화」라는 말이 두 곳에서 서로 다른 축을 올리고 있었다.
   뼈 모루는 부착물과 영혼석·도가니를 맡는다 — 쇠붙이를 다루는 일만 남겼다. */

function retuneScreen() {
  const g = assembleGolem(S);
  UI.topbar(S, '시체골 · 속성 도가니');
  UI.logHead('속성 도가니');
  UI.logLine('도가니가 열을 머금는다.', 'narrate');
  const attacks = g.active.filter((sid) => DB.skillsBy[sid].power > 0);
  UI.listPanel('현재 스킬 속성',
    attacks.map((sid) => UI.rowHTML(skillElement(S, sid), UI.esc(DB.skillsBy[sid].name),
      String(DB.skillsBy[sid].power))));
  UI.choices([
    ...attacks.map((sid) => ({
      label: `${DB.skillsBy[sid].name} 변경`, meta: skillElement(S, sid),
      on: () => pickElement(sid),
    })),
    { label: '돌아간다', cls: 'ghost', pin: true, on: forgeScreen },
  ]);
}

function pickElement(sid) {
  const cru = DB.attachmentsBy.at_crucible;
  UI.logLine(`${DB.skillsBy[sid].name}을(를) 어떤 속성으로 바꿀까.`, 'dim');
  UI.choices([
    ...DB.elements.elements.map((el) => ({
      label: el, meta: money(cru.price), disabled: !canCraft(S, cru), on: () => {
        S.silver -= cru.price;
        for (const [k, v] of Object.entries(cru.materials)) S[k] -= v;
        S.golem.retuned ??= {};
        S.golem.retuned[sid] = el;
        UI.logLine(`${DB.skillsBy[sid].name}이(가) ${el} 속성이 되었다.`, 'good');
        forgeScreen();
      },
    })),
    { label: '취소', cls: 'ghost', on: retuneScreen },
  ]);
}

/* ── 강령술사 조합 ──────────────────────── */
function conclaveScreen() {
  UI.topbar(S, '시체골 · 강령술사 조합');
  const eq = S.necro.equipped.filter(Boolean);
  UI.listPanel('술법',
    DB.necro_skills.map((n) => UI.rowHTML(n.school,
      `${UI.esc(n.name)}<br><span style="color:var(--muted);font-size:.84em">${UI.esc(n.desc)}</span>`,
      S.necro.known.includes(n.id) ? (eq.includes(n.id) ? '장착' : '보유') : `영혼재 ${n.cost.soulAsh}`)),
    `<p class="note">한 번에 ${S.unlocks.necroSlots}개까지 들고 갈 수 있다. 영력은 전투 시작 3, 매 턴 +1.</p>`);

  UI.logHead('강령술사 조합');
  UI.logLine('촛농이 굳은 탁자 위로 낡은 술법서가 펼쳐져 있다.', 'narrate');

  const list = [];
  for (const n of DB.necro_skills) {
    if (!S.necro.known.includes(n.id)) {
      list.push({ label: `${n.name} 습득`, meta: `영혼재 ${n.cost.soulAsh}`,
        disabled: !canLearn(S, n), on: () => {
          learn(S, n);
          UI.logLine(`${n.name}을(를) 익혔다.`, 'good');
          conclaveScreen();
        } });
    } else if (eq.includes(n.id)) {
      list.push({ label: `${n.name} 내려놓기`, cls: 'ghost', on: () => {
        S.necro.equipped = S.necro.equipped.map((x) => (x === n.id ? null : x));
        conclaveScreen();
      } });
    } else {
      const cap = S.unlocks.necroSlots;
      list.push({ label: `${n.name} 장착`, meta: `${eq.length}/${cap}`, disabled: eq.length >= cap, on: () => {
        const i = S.necro.equipped.findIndex((x) => !x);
        if (i < 0) S.necro.equipped.push(n.id); else S.necro.equipped[i] = n.id;
        conclaveScreen();
      } });
    }
  }
  list.push({ label: '돌아간다', cls: 'ghost', pin: true, on: marketScreen });
  UI.choices(list);
  save();
}

/* ── 골렘 정비 ──────────────────────────── */
/**
 * 골렘 화면.
 * @param back 돌아갈 화면
 * @param canEdit 교체 가능 여부. 던전에서는 작업대(§6.4)에서만 참이다.
 */
/**
 * 던전에서는 작업대 사용권(benchRoom)을 쥐고 있을 때만 손댈 수 있다.
 * 한 번 쓰면 사용권이 사라지고, 같은 화면에 남아 있어도 더는 못 고친다 — 이것이 '한 번뿐'의 실체다.
 */
const canEditNow = (canEdit) => canEdit && (!S.run || benchRoom !== null);

function golemScreen(back = town, canEdit = true) {
  canEdit = canEditNow(canEdit);
  UI.topbar(S, canEdit ? '골렘 정비' : '골렘 상태');
  /* 도식의 부위를 누르면 **하단이 곧장 그 자리의 교체 목록**이 된다 (§12.9).
     「좌완 교체」 같은 버튼을 여섯 개 늘어놓으면 글자를 키운 화면에서는 네 쪽으로 갈린다 —
     이미 눈이 가 있는 그림을 누르는 쪽이 짧다. */
  UI.golemPanel(S, canEdit ? (slot) => slotScreen(slot, back, canEdit) : null);
  const g = assembleGolem(S);
  if (g.over) UI.logLine(`기술이 ${g.active.length}개다. ${g.skillCap}개를 넘으면 일부를 봉인해야 내려간다.`, 'bad');
  const raws = g.worn.filter(({ part }) => part.raw);
  if (raws.length) {
    UI.logLine(`날것 상태로 붙인 부속 ${raws.length}개 — 성능 60%, 기술이 불발될 수 있고 내구도가 배로 닳는다.`, 'bad');
    UI.logLine('납골당 정착대에서 처리하면 온전해진다.', 'dim');
  }
  if (!canEdit) {
    UI.logLine(S.run ? '이 작업대는 다 썼다. 손볼 곳은 마을이나 다음 작업대다.'
      : '여기서는 손볼 수 없다. 작업대가 있는 방이나 마을에서 정비한다.', 'dim');
  }
  if (canEdit) UI.logLine('왼쪽 도식에서 부위를 누르면 거기에 끼울 것들이 아래에 뜬다.', 'dim');
  UI.choices([
    ...(canEdit ? [{ label: '핵 교체', meta: g.core ? g.core.name : '없음',
      info: '핵은 몸이 아니라 골렘 그 자체다. 도식에 자리가 없어 여기서 고른다.',
      on: () => coreScreen(back, canEdit) }] : []),
    /* 기술 목록은 **언제나** 열려 있어야 한다 (§12.23). 전에는 상한을 넘겼을 때만
       문이 열려서, 위력이 얼마인지 보려면 일부러 기술을 늘려야 했다. */
    { label: `🗡 기술 ${g.active.length}/${g.skillCap}${g.skills.length > g.active.length ? ` · 봉인 ${g.skills.length - g.active.length}` : ''}`,
      cls: g.over ? 'primary' : '',
      meta: g.over ? `${g.active.length - g.skillCap}개를 봉인해야 내려간다` : '위력·명중·충전을 보고 봉인한다',
      on: () => banScreen(back, canEdit) },
    canEdit ? { label: '골렘 명부', cls: 'ghost', info: '내 골렘들이 어디에 있는지 보고, 데려갈 몸을 고른다.',
      on: () => rosterScreen(() => golemScreen(back, canEdit)) } : null,
    { label: '돌아간다', cls: 'ghost', pin: true, on: () => back(false) },
  ]);
  save();
}

function coreScreen(back, canEdit = true) {
  canEdit = canEditNow(canEdit);
  if (!canEdit) { golemScreen(back, false); return; }
  UI.topbar(S, '골렘 · 핵');
  UI.golemPanel(S);
  const cur = S.golem.core ? DB.coresBy[S.golem.core] : null;
  UI.logHead('핵');
  UI.logLine(cur ? `현재: ${cur.name} — ${cur.desc}` : '핵이 비어 있다. 골렘이 서지 못한다.', cur ? '' : 'bad');
  if (!S.cores.length) {
    UI.logLine('예비 핵이 없다. 상점에서 사거나 층의 주인을 잡아야 한다.', 'dim');
  }
  const statText = (c) => Object.entries(c.stats).filter(([, v]) => v)
    .map(([k, v]) => `${STAT_LABEL[k]}${v > 0 ? '+' : ''}${v}`).join(' ') || '보정 없음';
  UI.choices([
    ...S.cores.map((cid) => {
      const c = DB.coresBy[cid];
      return { label: `${c.name} 장착`, meta: statText(c), on: () => {
        // 핵마다 체력을 따로 기억한다 — 새 핵은 온전한 채로 들어오고,
        // 빼 둔 핵은 깎인 만큼을 그대로 안고 나간다
        if (S.golem.core) {
          S.coreHpBy[S.golem.core] = S.golem.coreHp;
          S.cores.push(S.golem.core);
        }
        S.cores = S.cores.filter((x) => x !== cid);
        S.golem.core = cid;
        S.golem.coreHp = S.coreHpBy[cid] ?? null;   // 기록 없음 = 가득
        delete S.coreHpBy[cid];
        const max = assembleGolem(S).stats.hp;
        if (S.golem.coreHp !== null) S.golem.coreHp = Math.min(S.golem.coreHp, max);
        UI.logLine(`${c.name}을(를) 골렘 가슴에 앉혔다.`, 'good');
        spendBench('core');
        golemScreen(back, canEdit);
      } };
    }),
    { label: '돌아간다', cls: 'ghost', pin: true, on: () => golemScreen(back, canEdit) },
  ]);
  save();
}

function slotScreen(slot, back, canEdit = true) {
  canEdit = canEditNow(canEdit);
  if (!canEdit) { golemScreen(back, false); return; }
  const kind = SLOT_KIND[slot];
  const cur = S.golem[slot] ? findPart(S.golem[slot]) : null;
  const equipped = new Set(SLOTS.map((s) => S.golem[s]).filter(Boolean));
  const options = S.inventory.filter((p) =>
    DB.partsBy[p.defId].slot === kind && !equipped.has(p.uid));

  UI.topbar(S, `골렘 · ${SLOT_LABEL[slot]}`);
  // 도식에서 다른 부위를 누르면 그 자리로 곧장 건너뛴다 (§12.9)
  // 고른 자리의 부속 하나를 왼쪽에서 펼쳐 준다 (§12.13) — 합계만 보고는 뭘 뺄지 못 고른다
  UI.golemPanel(S, (next) => slotScreen(next, back, canEdit), slot);
  UI.logHead(`${SLOT_LABEL[slot]} 교체`);
  if (cur) {
    UI.logLine(`현재: ${partName(cur)} (내구도 ${cur.integrity}/${cur.maxIntegrity})`);
    const losing = partSkills(cur);
    UI.logLine(`떼어내면 ${losing.map((s) => DB.skillsBy[s].name).join(', ')}을(를) 잃는다.`, 'dim');
  } else UI.logLine('비어 있는 슬롯이다.', 'dim');

  const before = assembleGolem(S);
  UI.choices([
    ...options.map((p) => {
      const st = partStats(p);
      const gain = partSkills(p).map((s) => DB.skillsBy[s].name).join(', ');
      // 이 부속으로 바꾸면 마력이 넘치는가 (§3.7)
      const curMana = cur ? partMana(cur) : 0;
      const after = before.manaUsed - curMana + partMana(p);
      const short = after - before.manaMax;
      return {
        label: UI.partHTML(p),
        disabled: short > 0,
        info: UI.partTip(p, short > 0
          ? `<div class="tsk" style="color:var(--danger)">마력 ${after}/${before.manaMax} — ${short} 모자라다</div>`
          : `<div class="tsk">${diffText(slot, p)}</div>`),
        meta: short > 0
          ? `마력 ${after}/${before.manaMax} — ${short} 모자라다`
          : `마력 ${partMana(p)} · ${p.raw ? '날것 · ' : ''}${diffText(slot, p)} · ${p.integrity}/${p.maxIntegrity}`,
        // 버튼에 얹기만 해도 전후 비교가 왼쪽에 뜬다 — 암산을 시키지 않는다
        hover: () => previewSwap(slot, p, before),
        unhover: () => UI.golemPanel(S, (next) => slotScreen(next, back, canEdit), slot),
        on: () => {
          S.golem[slot] = p.uid;
          const after = assembleGolem(S);
          UI.logLine(`${partName(p)}을(를) ${SLOT_LABEL[slot]}에 붙였다.`, 'good');
          if (p.raw) UI.logLine('아직 정착되지 않은 날것이다. 성능 60%, 기술 불발 25%, 내구도 2배 소모.', 'bad');
          if (gain) UI.logLine(`새 스킬: ${gain}`, 'good');
          warnCoverage(before, after);
          spendBench('swap');
          golemScreen(back, canEdit);
        },
      };
    }),
    cur ? { label: '떼어낸다', cls: 'danger', on: () => {
      S.golem[slot] = null;
      UI.logLine(`${SLOT_LABEL[slot]}을(를) 비웠다.`, 'dim');
      if (slot === 'body') UI.logLine('흉곽이 빠지자 핵이 드러난다. 맞으면 곧장 핵이 깎인다.', 'bad');
      spendBench('swap');
      golemScreen(back, canEdit);
    } } : null,
    { label: '돌아간다', cls: 'ghost', pin: true, on: () => golemScreen(back, canEdit) },
  ]);
}

/** 속성 커버리지가 줄면 경고한다 (§12.5) */
function warnCoverage(before, after) {
  const els = (g) => new Set(g.active
    .filter((s) => DB.skillsBy[s].power > 0)
    .map((s) => skillElement(S, s)));
  const lost = [...els(before)].filter((e) => !els(after).has(e));
  if (lost.length) UI.logLine(`⚠ ${lost.join(', ')} 속성 공격 수단이 사라졌다.`, 'bad');
}

/* ── 스킬 봉인 (§12.23) ─────────────────────────────
   전에는 이름과 속성만 적힌 단추가 늘어서 있었고, 봉인한 것과 아닌 것이
   「봉인 / 봉인 해제」라는 **동사**로만 갈렸다 — 목록을 훑으며 동사를 읽어야
   무엇이 잠겼는지 알 수 있었다. 이제 잠긴 것은 잠긴 것끼리 모이고,
   왼쪽에 위력·명중·충전이 전부 적힌다. */
function banScreen(back, canEdit = true) {
  const g = assembleGolem(S);
  const banned = S.golem.banned ?? [];
  const isBan = (sid) => banned.includes(sid);
  const live = g.skills.filter((sid) => !isBan(sid));
  UI.topbar(S, '골렘 · 스킬 봉인');

  UI.listPanel(`기술 ${live.length}/${g.skillCap} · 봉인 ${g.skills.length - live.length}`,
    g.skills.map((sid) => {
      const sk = DB.skillsBy[sid];
      return UI.rowHTML(skillElement(S, sid),
        `${isBan(sid) ? '<span class="chip warn">봉인</span> ' : ''}${UI.esc(sk.name)}`,
        sk.power ? `위력 ${sk.power}${sk.charges === null ? ' · ∞' : ` · ${sk.charges}`}` : '보조',
        isBan(sid));
    }),
    `<p class="note">전투에 들고 갈 수 있는 기술은 <b>${g.skillCap}개</b>까지다 (기본 ${SKILL_CAP_BASE}개 · 핵을 ${SKILL_CAP_STEP}강 올릴 때마다 한 칸).
      넘으면 넘치는 만큼 봉인해야 무덤에 내려갈 수 있다.<br>
      <b>봉인해도 능력치는 그대로다</b> — 부속은 붙어 있고 기술만 잠근다.<br>
      기술을 누르면 위력·명중·충전과 그것이 나오는 부속을 본다.</p>`);

  UI.logHead('스킬 봉인');
  UI.logLine(`쓸 수 있는 것 ${live.length}개 / 상한 ${g.skillCap}개.`, g.over ? 'bad' : 'dim');
  if (g.over) UI.logLine(`${live.length - g.skillCap}개를 더 봉인해야 내려갈 수 있다.`, 'bad');

  UI.choices([
    ...g.skills.map((sid) => {
      const sk = DB.skillsBy[sid];
      const ban = isBan(sid);
      const full = !ban && false;
      return {
        label: `${ban ? '<span class="chip warn">봉인</span> ' : ''}${UI.esc(sk.name)}`,
        meta: `${skillFacts(sid).slice(0, 3).join(' · ')} — ${ban ? '누르면 푼다' : '누르면 봉인'}`,
        cls: ban ? 'ghost' : '',
        disabled: full,
        info: skillTip(sid, ban ? '지금은 봉인되어 전투 목록에 오르지 않는다.' : ''),
        // 쪽지를 한 번 띄운 뒤에 눌린다 — 여기서는 그게 맞다. 잘못 누르면 빌드가 바뀐다
        on: () => {
          S.golem.banned = ban ? banned.filter((x) => x !== sid) : [...banned, sid];
          UI.logLine(ban ? `${sk.name}의 봉인을 풀었다.` : `${sk.name}을(를) 봉인했다.`, ban ? 'good' : 'dim');
          banScreen(back, canEdit);
        },
      };
    }),
    ...g.skills.map((sid) => ({
      label: `${UI.esc(DB.skillsBy[sid].name)} 자세히`, cls: 'ghost', nokey: true,
      meta: skillEffects(sid).join(', ') || '효과 없음',
      on: () => skillDetailScreen(sid, () => banScreen(back, canEdit), isBan(sid)),
    })),
    { label: '돌아간다', cls: 'ghost', pin: true, on: () => golemScreen(back, canEdit) },
  ], { stage: true, stageTitle: '무엇을 들고 갈까' });
  save();
}

/* ── 소모품을 가방에서 쓴다 (§12.14-A) ───────────────────
   가방은 **읽는 목록**일 뿐 쓰는 자리가 아니었다. 무덤 한복판에서 물약을 들고도
   전투에 들어가야만 쓸 수 있었다 — 가방을 연 이유가 대개 그것인데.
   전투 밖에서 뜻이 있는 것만 쓸 수 있게 하고, 나머지는 **왜 못 쓰는지 적는다.**
   왼쪽 목록과 오른쪽 선택지가 같은 판단을 쓰도록 한 곳에 모은다 — 둘이 갈리면
   왼쪽에서 누른 것이 오른쪽에서는 안 되는 일이 생긴다. */
function consumableUse(id, after) {
  const it = DB.itemsBy[id];
  const e = it?.effect ?? {};
  const inRun = Boolean(S.run);
  const usable = e.op === 'heal' ? Boolean(S.golem.core)
    : e.op === 'escape' ? inRun
    : false;
  const why = e.op === 'rank' ? '전투 중에만 쓴다'
    : e.op === 'repair' ? '고칠 부속을 아래에서 고른다'
    : e.op === 'escape' ? (inRun ? '무덤을 빠져나온다' : '무덤 안에서만 쓴다')
    : e.op === 'heal' && !S.golem.core ? '핵이 없다'
    : '';
  const run = () => {
    if (!usable) { UI.logLine(`${it.name}은(는) 지금 쓸 수 없다 — ${why}`, 'dim'); return; }
    if (e.op === 'heal') {
      const g = assembleGolem(S);
      const before = S.golem.coreHp ?? g.stats.hp;
      S.golem.coreHp = Math.min(g.stats.hp, before + Math.round(g.stats.hp * (e.ratio ?? 0)));
      if (S.run) S.run.golemHp = S.golem.coreHp;          // 무덤 안이면 지금 몸에도 곧장 돈다
      S.consumables[id]--;
      UI.logLine(`${it.name}을(를) 부었다. 핵이 ${S.golem.coreHp - before} 회복했다. (${S.golem.coreHp}/${g.stats.hp})`, 'good');
      save();
      after();
      return;
    }
    if (e.op === 'escape') {
      S.consumables[id]--;
      UI.logLine('문양이 타오르고, 시야가 뒤집힌다.', 'necro');
      abandonRun(true);
    }
  };
  return { it, usable, why, run };
}

function inventoryScreen(back = town) {
  UI.topbar(S, '소지품');
  if (!S.run) quickHere('inventory');
  const equipped = new Set(SLOTS.map((x) => S.golem[x]).filter(Boolean));
  const mats = [
    ['시체 조각', S.scrap], ['부패 진액', S.ichor], ['골분', S.boneMeal],
    ['은화', S.silver], ['영혼재', S.soulAsh],
  ].filter(([, n]) => n > 0).map(([k, n]) => UI.rowHTML('재료', UI.esc(k), String(n)));
  const uses = Object.entries(S.consumables).filter(([, n]) => n > 0)
    .map(([id, n]) => ({ id, n, ...consumableUse(id, () => inventoryScreen(back)) }))
    .filter((u) => u.it);
  /* 왼쪽도 **누를 수 있어야 한다** — 목록만 보여 주고 손이 안 닿으면 죽은 칸이다 (§12.14-A) */
  const items = uses.map((u) => UI.rowHTML(u.it.kind, UI.esc(u.it.name),
    u.usable ? `${u.n}개 · 쓴다` : `${u.n}개`, false, `c:${u.id}`));
  const useRows = uses.map((u) => ({
    label: `${UI.esc(u.it.name)} 쓴다`,
    meta: `${u.n}개 · ${u.why || UI.esc(u.it.desc ?? '')}`,
    disabled: !u.usable,
    info: `<span class="tt">${UI.esc(u.it.name)}</span><span class="tm">${UI.esc(u.it.kind)} · ${u.n}개</span>`
      + `<div class="trow"><span>${UI.esc(u.it.desc ?? '')}</span></div>`
      + (u.usable ? '' : `<div class="trow"><span>지금은 쓸 수 없다 — ${UI.esc(u.why)}</span></div>`),
    on: u.run,
  }));
  // 어느 자리에 끼워져 있는지까지 적는다. '장착'만으로는 어느 팔인지 알 수 없다
  const slotOf = new Map(SLOTS.filter((x) => S.golem[x]).map((x) => [S.golem[x], x]));
  /* 「가진 것」은 **쓸 수 있는 것**의 목록이다 (§12.14).
     골렘에 붙어 있는 여섯은 이미 자리를 잡았고, 여기서 할 수 있는 일이 없다.
     그것들까지 섞어 두면 정작 남는 여분이 목록 아래로 밀려 안 보인다 —
     붙은 것은 골렘 도식에서 보고, 여기서는 여분만 센다. */
  const spare = S.inventory.filter((p) => !equipped.has(p.uid));
  /* 같은 이름이 여러 개면 **번호를 붙인다** (§12.14-C).
     「가방에 장착한 파츠가 아직 있다」는 말을 들었는데, 세어 보니 장착한 것은 하나도 없었다 —
     붙인 것과 **이름이 같은 여분**을 보고 그렇게 읽은 것이다. 이름이 같으면 구분할 길이 없으니
     당연하다. 여분끼리도 번호로 갈라 준다. */
  const serial = new Map();
  const dupCount = {};
  for (const p of spare) { const n = partName(p); dupCount[n] = (dupCount[n] ?? 0) + 1; }
  const seen = {};
  for (const p of spare) {
    const n = partName(p);
    if (dupCount[n] > 1) { seen[n] = (seen[n] ?? 0) + 1; serial.set(p.uid, seen[n]); }
  }
  const NUM = ['', '①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨'];
  const tag = (p) => (serial.has(p.uid) ? ` ${NUM[serial.get(p.uid)] ?? `#${serial.get(p.uid)}`}` : '');
  const parts = spare.map((p) => UI.rowHTML(
    KIND_LABEL[DB.partsBy[p.defId].slot],
    `${p.raw ? '<span class="chip warn">날것</span> ' : ''}${UI.partHTML(p)}${tag(p)}`,
    `${p.integrity}/${p.maxIntegrity}`, wornLow(p), `p:${p.uid}`));
  const rows = [...mats, ...items, ...parts];
  const away = [
    ['창고', (S.ossuary?.vault?.parts ?? []).length],
    ['조립대', O.workshopGolems(S).reduce((n, g) => n + g.parts.length, 0)],
    ['파견', (S.ossuary?.laborBay?.dispatch ?? []).reduce((n, d) => {
      const g = O.workshopGolems(S).find((x) => x.id === d.golemId);
      return n + (g ? g.parts.length : (d.parts ?? []).length);
    }, 0)],
    ['단련로', (S.ossuary?.forge?.slots ?? []).reduce((n, j) => n + (j.inputs?.length ?? 0), 0)],
    ['대장간', (S.town?.smithy ?? []).length],
    ['해체대', (S.ossuary?.dissection?.slots ?? []).length],
  ].filter(([, n]) => n > 0);
  UI.listPanel(`가진 것 — 여분 부속 ${spare.length}개`, rows,
    `<p class="note"><b>골렘에 붙인 ${slotOf.size}개는 여기 없다.</b> 붙은 것은 골렘 정비에서 본다 —
      이름이 같은 것이 보인다면 그건 <b>여분</b>이고, 번호로 갈라 뒀다.</p>`
    + (away.length
      ? `<p class="note">맡겨 둔 것: ${away.map(([k, n]) => `${k} ${n}`).join(' · ')}<br>
         여기 없는 부속은 사라진 게 아니라 그쪽에 가 있다.</p>`
      : ''),
    (pick) => {
      const [kind, key] = [pick.slice(0, 1), pick.slice(2)];
      if (kind === 'c') { uses.find((u) => u.id === key)?.run(); return; }
      const p = spare.find((x) => x.uid === key);
      if (p) partDetailScreen(p, () => inventoryScreen(back));
    });
  UI.logLine(`재료: 조각 ${S.scrap} · 진액 ${S.ichor} · 골분 ${S.boneMeal} / 은화 ${S.silver} · 영혼재 ${S.soulAsh}`, 'dim');
  UI.logLine(`골렘에 붙은 ${slotOf.size}개는 여기 없다 — 골렘 정비에서 본다.`, 'dim');
  UI.logLine(`여분 ${spare.length}개. 여분은 무덤에서 무너지면 일부를 흘린다.`, 'dim');
  UI.choices([
    { label: '재화가 뭔지 보기', cls: 'ghost', pin: true, on: () => resourceGuideScreen(() => inventoryScreen(back)) },
    // 부속을 눌러 무엇을 할 수 있는 물건인지 본다 — 이름만으로는 알 수가 없다
    // 장착 중인 것을 위로 모으고, 어느 자리인지를 이름 앞에 박아 둔다
    ...spare.map((p) => ({
      label: `${UI.partHTML(p)}${tag(p)}`,
      meta: `${UI.RARITY_LABEL[UI.rarityOf(p)]}`
        + ` · 마력 ${partMana(p)}${p.raw ? ' · 날것' : ''} · ${p.integrity}/${p.maxIntegrity}`,
      on: () => partDetailScreen(p, () => inventoryScreen(back)),
    })),
    ...useRows,
    // 회복량은 데이터가 정한다. 여기에 숫자를 박아 두면 items.json을 고쳐도 안 따라온다
    /* 역청도 **여분에만** 내민다 (§12.14-B).
       전에는 「닳는 것은 대개 붙어 있는 부속」이라 장착 중인 것까지 함께 내밀었는데,
       그러자 가방이 골렘 정비와 같은 목록을 두 벌 보여 주는 화면이 됐다.
       붙은 것은 골렘 정비에서 보고 고친다 — 가방은 **여분을 보는 자리**다. */
    ...spare.filter((p) => p.integrity < p.maxIntegrity && S.consumables.it_bitumen > 0)
      .map((p) => ({
        label: `${UI.partHTML(p)}에 역청`,
        meta: `+${BITUMEN()} (${S.consumables.it_bitumen}개 남음)`, on: () => {
          S.consumables.it_bitumen--;
          p.integrity = Math.min(p.maxIntegrity, p.integrity + BITUMEN());
          UI.logLine(`${partName(p)}의 내구도를 메웠다. (${p.integrity}/${p.maxIntegrity})`, 'good');
          save();                       // 메운 것은 곧장 적어 둔다 — 다음 저장까지 미루지 않는다
          inventoryScreen(back);
        },
      })),
    { label: '돌아간다', cls: 'ghost', pin: true, on: () => back(false) },
  ]);
}

/** 소생 값 — 옛 접합로 조리법이 쓰던 것 그대로다 (§9.15-A) */
const REVIVE_COST = { ichor: 10, boneMeal: 8 };

/** 역청 한 병이 메우는 내구도 — items.json이 정한다 */
const BITUMEN = () => DB.itemsBy.it_bitumen?.effect?.value ?? 3;

/* ── 런 시작 ────────────────────────────── */
/* ── 단계 선택 — 어디로 내려갈 것인가 (§7-A) ────────── */
function stageSelect() {
  UI.topbar(S, '시체골 · 무덤 입구');
  const pr = CP.progress(S);
  const next = CP.nextStage(S);

  UI.listPanel('캠페인', (DB.campaign?.parts ?? []).map((pt) => {
    const done = pt.stages.filter((x) => CP.isCleared(S, x.id)).length;
    const open = pt.stages.some((x) => CP.isOpen(S, x.id));
    return UI.rowHTML(`${pt.id}부`, open ? UI.esc(pt.name) : '<span class="empty">잠김</span>',
      open ? `${done}/${pt.stages.length}` : '', !open);
  }), `<p class="note">단계 ${pr.done}/${pr.total} 완료.<br>
      깬 단계는 다시 갈 수 있다 — 보상은 절반이지만 재료와 부속은 그대로 나온다.</p>`);

  UI.logHead('어디로 내려가는가');
  if (next) {
    const st = stageOf(next);
    UI.logLine(`다음 목표: ${partOf(next).name} · ${st.name}`, 'necro');
    UI.logLine(st.desc, 'narrate');
  } else {
    UI.logLine('아홉 단계를 전부 지났다.', 'good');
  }

  const list = [];
  for (const pt of DB.campaign?.parts ?? []) {
    for (const st of pt.stages) {
      if (!CP.isOpen(S, st.id)) continue;
      const cleared = CP.isCleared(S, st.id);
      const hz = CP.hazardOf(st.id);
      list.push({
        label: `${st.id} ${st.name}${cleared ? ' <span class="eff-down">클리어</span>' : ''}`,
        meta: `${pt.place} · ${st.floors}층 · ${hz ? hz.name : '평온'}`,
        cls: st.id === next ? 'primary' : 'ghost',
        on: () => beginStage(st.id),
      });
    }
  }
  list.push({ label: '돌아간다', cls: 'ghost', pin: true, on: () => town(false) });
  UI.choices(list);
  save();
}

function startRun() {
  if (!S.golem.core) {
    UI.logLine('골렘 핵이 없다. 핵 없이는 골렘이 서지 못한다.', 'bad');
    UI.logLine('상점에서 사거나, 뼈 수습꾼을 찾아가 보라.', 'dim');
    return;
  }
  // 몸통은 더 이상 필수가 아니다 (§3.1). 없으면 핵이 드러난 채로 싸운다
  if (!S.golem.body) {
    UI.logLine('흉곽이 없다. 핵이 드러난 채로 내려간다 — 맞으면 곧장 핵이 깎인다.', 'bad');
  }
  if (wornCount() < MIN_PARTS) {
    UI.logLine(`부속이 ${wornCount()}개뿐이다. 최소 ${MIN_PARTS}개는 끼워야 골렘이 움직인다.`, 'bad');
    UI.logLine('골렘 정비에서 더 끼우거나, 뼈 수습꾼에게 부속을 얻어라.', 'dim');
    return;
  }
  // 정비대는 골렘을 통째로 올려놓고 하는 작업이다. 그동안 그 골렘으로 내려갈 수는 없다
  const bench = (S.ossuary?.overhaul ?? []).filter((j) => j.golemId === S.golem.id);
  if (bench.length) {
    UI.logLine(`${S.golem.name}이(가) 정비대에 올라가 있다. 작업이 끝나기 전에는 이 몸으로 내려갈 수 없다.`, 'bad');
    for (const j of bench) {
      UI.logLine(`${O.OVERHAUL[j.kind].name} — ${O.remainText(j.startedAt, j.durationMs)}`, 'dim');
    }
    UI.logLine('골렘 명부에서 다른 골렘을 올리거나, 정비대에서 물릴 수 있다.', 'dim');
    return;
  }
  const gm = assembleGolem(S);
  /* 기술이 상한을 넘으면 **내려갈 수 없다** (§3.11). 화면에는 「봉인해야 내려간다」고
     적어 두고 정작 막지는 않아, 넘긴 채로 그대로 들어가지고 있었다 —
     적힌 규칙과 실제가 다르면 적힌 쪽을 아무도 믿지 않는다. */
  if (gm.over) {
    UI.logLine(`기술이 ${gm.active.length}개다. 들고 갈 수 있는 것은 ${gm.skillCap}개까지다.`, 'bad');
    UI.logLine(`${gm.active.length - gm.skillCap}개를 봉인해야 내려갈 수 있다 — 골렘 정비의 🗡 기술에서 고른다.`, 'dim');
    return;
  }
  if (gm.manaOver) {
    UI.logLine(`핵이 감당하지 못한다. 마력 ${gm.manaUsed}/${gm.manaMax}.`, 'bad');
    UI.logLine('부속을 덜어내거나, 단련로에서 핵을 강화하거나, 더 좋은 핵을 구해야 한다.', 'dim');
    return;
  }
  stageSelect();
}

function beginStage(stageId) {
  const st = stageOf(stageId);
  const pt = partOf(stageId);
  // 표본실은 **창고다.** 자동으로 꺼내 주지 않는다 — 꺼내는 순간 무덤에서 흘릴 수 있는
  // 물건이 되기 때문이다. 맡긴 것을 안전하게 두는 것이 이 방의 값어치다 (§9.3-⑤).
  const g = assembleGolem(S);
  const seed = Math.floor(Math.random() * 1e9);
  S.run = {
    seed, floor: 1, golemHp: S.golem.coreHp ?? g.stats.hp, rooms: 0,
    noLoss: true, kills: 0, summons: 0, cleanWins: 0,
    stage: stageId, hazard: 0,
    floorData: null,
  };
  S.run.floorData = generateFloor(seed, 1);
  S.log.runs++;
  UI.clearLog();
  UI.logHead(`${pt.name} · ${st.name} — 1층`);
  UI.logLine(st.desc, 'narrate');
  const hz = CP.hazardOf(stageId);
  if (hz) UI.logLine(`${hz.name} — ${hz.text}`, 'bad');
  // 흉곽 없이 내려가는 건 선택이지만, 무슨 값을 치르는지는 알고 내려가야 한다 (§3.1)
  if (!S.golem.body) UI.logLine('흉곽이 없다. 핵이 드러난 채다 — 맞는 피해의 일부가 곧장 핵을 깎는다.', 'bad');
  enterRoom(roomAt(S.run.floorData, S.run.floorData.pos), true);
}

function nextFloor() {
  const st = stageOf(S.run.stage);
  S.run.floor++;
  if (S.run.floor > (st?.floors ?? 3)) { runComplete(); return; }
  S.run.floorData = generateFloor(S.run.seed + S.run.floor * 104729, S.run.floor);
  UI.logHead(`${partOf(S.run.stage)?.name ?? '무덤'} · ${st?.name ?? ''} — ${S.run.floor}층`);
  UI.logLine('계단이 더 깊은 어둠으로 이어진다. 공기가 차가워졌다.', 'narrate');
  enterRoom(roomAt(S.run.floorData, S.run.floorData.pos), true);
}

/** 단계를 끝까지 봤다 — 보상과 해금, 그리고 이야기 */
function runComplete() {
  const id = S.run.stage ?? '1-1';
  const st = stageOf(id);
  const res = CP.clearStage(S, id);
  notifyQuests({ kind: 'stageclear', stage: id });

  const ash = res.reward.soulAsh + S.run.kills * 4;
  S.soulAsh += ash;
  S.silver += res.reward.silver;
  if (res.reward.core) S.cores.push(res.reward.core);

  UI.logHead('귀환');
  UI.logLine(`${st?.name ?? '그곳'}의 바닥을 보았다. 골렘은 아직 서 있다.`, 'narrate');
  UI.logLine(`영혼재 ${ash}, 은화 ${res.reward.silver}을 가지고 돌아왔다.`, 'good');
  if (res.reward.core) UI.logLine(`${DB.coresBy[res.reward.core].name}을(를) 주웠다.`, 'necro');
  if (!res.first) UI.logLine('이미 지난 곳이라 보상은 절반이다.', 'dim');

  S.run = null;
  S.town.stock = rollStock(rng, S.unlocks);
  save();

  // 이야기는 처음 깰 때만. 재도전에 같은 대사를 세 번 읽히지 않는다
  if (res.beat) { storyScreen(id, res); return; }
  afterStage(res);
}

function afterStage(res) {
  if (res.openedPart) {
    UI.logHead('길이 열렸다');
    UI.logLine(`${res.openedPart.id}부 · ${res.openedPart.name}이(가) 열렸다.`, 'necro');
    UI.logLine(res.openedPart.intro, 'narrate');
  }
  const next = CP.nextStage(S);
  if (next) UI.logLine(`다음 목표: ${partOf(next).name} · ${stageOf(next).name}`, 'good');
  UI.choices([{ label: '마을로', cls: 'primary', pin: true, on: () => settleAndReport(() => town()) }]);
  save();
}

/** 바르그의 이야기 비트 — 한 번에 4~6줄, 길게 늘어놓지 않는다 */
function storyScreen(id, res) {
  const beat = DB.story.beats[id];
  UI.topbar(S, '시체골 · 뼈 수습꾼');
  UI.listPanel('이야기', [
    UI.rowHTML('장', UI.esc(beat.title), id),
  ], `<p class="note">단계를 처음 지날 때만 들을 수 있다.</p>`);
  UI.logHead(beat.title);
  for (const l of beat.lines) UI.logLine(l.t, l.c ?? '');
  if (beat.unlockText) UI.logLine(beat.unlockText, 'good');

  if (beat.ending) { UI.choices([{ label: '손을 뻗는다…', cls: 'primary', on: endingScreen }]); save(); return; }
  UI.choices([{ label: '…듣는다', cls: 'primary', on: () => afterStage(res) }]);
  save();
}

/** 마지막 선택 — 되살릴 것인가, 놓아줄 것인가 (§7-A.6) */
function endingScreen() {
  UI.topbar(S, '미궁 · 원형의 방');
  UI.logHead('원형의 방');
  UI.logLine('작업대 위에 아직 아무것도 아닌 것이 놓여 있다.', 'narrate');
  UI.choices([
    { label: '일으킨다', cls: 'primary', meta: '여기까지 온 이유', on: () => finishEnding('raise') },
    { label: '놓아준다', meta: '오르넬이 하지 못한 것', on: () => finishEnding('release') },
  ]);
}

function finishEnding(kind) {
  const e = DB.story.endings[kind];
  S.campaign.ending = kind;
  UI.logHead(e.title);
  for (const l of e.lines) UI.logLine(l.t, l.c ?? '');
  UI.logLine('— 끝 —', 'necro');
  UI.logLine('시체골은 그대로 남아 있다. 언제든 다시 내려갈 수 있다.', 'dim');
  UI.choices([{ label: '마을로', cls: 'primary', pin: true, on: () => settleAndReport(() => town()) }]);
  save();
}

/* ── 방 진입 ────────────────────────────── */
/* ── 환경 규칙 — 방을 열수록 대가가 커진다 (§7-A.2) ────── */
function tickHazard() {
  const hz = CP.hazardOf(S.run.stage);
  if (!hz) return;
  const was = CP.hazardTier(S.run.hazard ?? 0);
  S.run.hazard = (S.run.hazard ?? 0) + CP.hazardStep(hz.rate);
  const now = CP.hazardTier(S.run.hazard);
  if (now > was) {
    UI.logLine(`【${hz.name}】 ${CP.HAZARD_TEXT[hz.kind][now]}`, 'bad');
    if (hz.kind === 'gaze' && now >= 3) S.run.gazeAmbush = true;
  }
  // 재배치는 단수가 오를 때가 아니라 방을 옮길 때마다 조금씩 어긋난다
  if (hz.kind === 'shift' && now >= 2) reshuffleUnseen(now);
}

/**
 * 미궁의 재배치. 연결 자체를 끊으면 층을 완주할 수 없게 되므로
 * **아직 가지 않은 방의 성격만** 다시 굴린다 — 지도는 남지만 지도가 하는 말이 달라진다.
 * 3단에서는 아직 안 간 방의 표시 자체가 지워진다.
 */
function reshuffleUnseen(tier) {
  const fd = S.run.floorData;
  const SWAP = ['battle', 'bones', 'event', 'trap', 'rest'];
  let moved = 0;
  for (const r of fd.rooms) {
    if (r.visited || r.cleared) continue;
    if (!SWAP.includes(r.type)) continue;      // 보스·시작·봉인실은 건드리지 않는다
    if (!rng.chance(25)) continue;
    r.type = rng.pick(SWAP);
    moved++;
    if (tier >= 3) r.seen = false;
  }
  if (moved) UI.logLine('【재배치】 지나온 적 없는 곳들이 자리를 바꾼 것 같다.', 'dim');
}

/** 지금 걸려 있는 규칙의 단수 (0~3) */
const hazardNow = () => CP.hazardTier(S.run?.hazard ?? 0);

function enterRoom(room, first = false) {
  const fd = S.run.floorData;
  fd.pos = room.id;
  if (!room.visited) {
    room.visited = true; S.run.rooms++;
    notifyQuests({ kind: 'progress', rooms: S.run.rooms });
    tickHazard();                     // 방을 열 때마다 파트의 규칙이 한 칸 찬다 (§7-A.2)
  }
  room.seen = true;
  for (const { room: nb } of exitsOf(fd, room.id)) nb.seen = true;

  UI.topbar(S, `${partOf(S.run.stage)?.place ?? '무덤'} ${fd.floor}층 · ${ROOM_LABEL[room.type]}`);
  UI.dungeonPanel(S, fd);

  if (!first) UI.logLine(`${ROOM_ICON[room.type]} ${ROOM_LABEL[room.type]}에 들어섰다.`, 'dim');
  if (!room.cleared) {
    const f = FLAVOR[room.type];
    if (f) UI.logLine(rng.pick(f), 'narrate');
  }

  // 망자의 시선: 너무 오래 뒤지면 묻힌 것들이 길을 막는다 (§7-A.2)
  if (S.run.gazeAmbush && !room.cleared && room.type !== 'boss') {
    S.run.gazeAmbush = false;
    UI.logLine('【망자의 시선】 흙을 밀어내며 무언가 일어선다. 길이 막혔다.', 'bad');
    room.type = 'battle';
  }

  if (!room.cleared) {
    switch (room.type) {
      case 'battle': return startBattle(room, false);
      case 'elite': return startBattle(room, true);
      case 'boss': return bossPrompt(room);
      case 'bones': return bonesRoom(room);
      case 'cache': return cacheRoom(room);
      case 'trap': return trapRoom(room);
      case 'event': return eventRoom(room);
      case 'rest': return restRoom(room);
      case 'sealed': return sealedRoom(room);
      case 'workshop':
        room.cleared = true;
        if (!room.used) {
          UI.logLine('버려진 작업대. 공구는 삭았다.', 'narrate');
          if (!S.log.hintBench) {
            S.log.hintBench = true;
            UI.logLine('— 작업대는 한 번뿐이다 —', 'necro');
            UI.logLine('부속 한 자리를 바꾸거나, 한 부위를 고치거나 — 둘 중 하나만 된다.', 'necro');
            UI.logLine('제대로 손보려면 마을 납골당 정비대로 가야 한다. 거기는 시간이 들지만 제한이 없다.', 'dim');
          }
        }
        break;
      default: room.cleared = true;
    }
  }
  roomChoices(room);
}

function roomChoices(room) {
  UI.quickPanel(RUN_QUICK());     // 무덤 안에서는 마을 건물을 들고 다니지 않는다
  const fd = S.run.floorData;
  const exits = exitsOf(fd, room.id);
  // 이동은 십자키가 맡는다. 선택지에 또 넣으면 같은 것이 두 벌이 되고,
  // 정작 필요한 항목(상성표 같은 것)이 십자키에 가려진다.
  const list = [];

  if (room.type === 'workshop') {
    if (room.used) {
      list.push({ label: '작업대 — 다 썼다', disabled: true, meta: BENCH_USED[room.used] ?? '' });
    } else {
      list.push({ label: '부속 한 자리 교체', cls: 'primary', meta: '한 번뿐',
        on: () => { benchRoom = room; golemScreen(backToRoom, true); } });
      list.push({ label: '한 부위 수리', cls: 'primary', meta: '한 번뿐 · 방어도 또는 내구도',
        on: () => { benchRoom = room; repairScreen(); } });
    }
  }
  list.push({ label: '골렘 상태', cls: 'ghost', on: () => golemScreen(backToRoom, false) });
  list.push({ label: '소지품', cls: 'ghost', on: () => inventoryScreen(backToRoom) });
  list.push({ label: '상성표', cls: 'ghost', on: () => affinityScreen(backToRoom) });
  if (S.consumables.it_sigil_return > 0) {
    list.push({ label: '귀환의 문양 사용', cls: 'ghost', on: () => {
      S.consumables.it_sigil_return--;
      UI.logLine('문양이 타오르고, 시야가 뒤집힌다.', 'necro');
      abandonRun(true);
    } });
  }
  UI.choices(list);
  // 선택지를 그린 뒤에 켜야 한다 (choices가 매번 초기화한다)
  setArrowMoves(Object.fromEntries(exits.map((e) => [e.dir, {
    go: () => enterRoom(e.room),
    label: e.room.visited ? ROOM_LABEL[e.room.type] : '미탐험',
    seen: Boolean(e.room.visited),
  }])));
  save();
}

/* ── 작업대 사용권 (§7.4-A) ─────────────────────────
   던전 작업대는 조각 몇 개로 즉시 고쳐 주는데, 마을 정비대는 재료에 시간까지 든다.
   그대로 두면 **작업대 방을 찾는 것만이 정비의 정답**이 되고, 납골당 정비대는 아무도 안 쓴다.
   그래서 작업대는 **한 번만** 쓴다 — 부속 한 자리를 바꾸거나, 한 부위를 수리하거나, 둘 중 하나.
   방에 새겨 두므로 층을 넘기면 다시 생기고, 같은 층에서 되돌아와도 이미 쓴 것은 쓴 것이다. */
let benchRoom = null;                    // 지금 사용권을 쥐고 있는 작업대
const BENCH_USED = { swap: '부속을 바꿨다', core: '핵을 갈았다', repair: '한 부위를 고쳤다' };

/** 작업대를 썼다. 무엇에 썼는지 방에 새긴다. */
function spendBench(kind) {
  if (!benchRoom) return;
  benchRoom.used = kind;
  benchRoom = null;
  UI.logLine('녹슨 공구가 삭아 부스러진다. 이 작업대는 여기까지다.', 'dim');
  save();
}

/** 작업대 방에서 방어도를 즉석 수리한다. 재료를 먹고 시간은 걸리지 않는다 */
/**
 * 던전 작업대 — 한 부위만, 한 번만. 방어도와 내구도 둘 다 여기서 되돌린다 (§6.4-A, §3.3-B).
 * 내구도가 수리되지 않으면 좋은 부속은 계속 데려갈 물건이 아니라 소모품이 된다.
 */
function repairScreen() {
  const g = assembleGolem(S);
  const fd = S.run.floorData;
  UI.topbar(S, `무덤 ${fd.floor}층 · 수리`);
  UI.dungeonPanel(S, fd);
  UI.logHead('수리');
  UI.logLine('녹슨 도구로 이음새를 조인다.', 'narrate');
  UI.logLine('공구가 버텨 주는 것은 한 부위뿐이다. 어디를 고칠지 골라야 한다.', 'dim');

  const PER_SCRAP = 35;        // 시체 조각 1당 되돌아오는 방어도 (밸런스 도구가 정한 값)
  const WEAR_PER_SCRAP = 3;    // 시체 조각 1당 메워지는 내구도
  const rows = [];
  for (const { slot, part, shieldMax: max, shield: cur } of g.worn) {
    if (max - cur > 0) {
      rows.push({ kind: 'shield', slot, part, max, cur, missing: max - cur,
        cost: Math.max(1, Math.ceil((max - cur) / PER_SCRAP)) });
    }
    const wm = part.maxIntegrity - part.integrity;
    if (wm > 0) {
      rows.push({ kind: 'wear', slot, part, max: part.maxIntegrity, cur: part.integrity, missing: wm,
        cost: Math.max(1, Math.ceil(wm / WEAR_PER_SCRAP)) });
    }
  }
  // 가장 급한 것이 위로 — 내구도는 0이면 부속이 사라지므로 비율로 재서 앞세운다
  rows.sort((a, b) => (a.kind === 'wear' ? a.cur / a.max : 1) - (b.kind === 'wear' ? b.cur / b.max : 1)
    || b.missing - a.missing);

  if (!rows.length) UI.logLine('고칠 곳이 없다. 방어도도 내구도도 온전하다.', 'dim');

  UI.choices([
    ...rows.map((r) => ({
      label: `${r.kind === 'wear' ? '🩹' : '🛡'} ${SLOT_LABEL[r.slot]} — ${UI.partHTML(r.part)}`,
      meta: `${r.kind === 'wear' ? '내구도' : '방어도'} ${r.cur}/${r.max} · 조각 ${r.cost}`,
      cls: r.kind === 'wear' && wornLow(r.part) ? 'primary' : '',
      info: r.kind === 'wear'
        ? '내구도는 쓰면 닳는다. 0이 되면 부속이 영영 사라진다.'
        : '방어도는 맞으면 깎인다. 0이 되면 그 부위의 기술을 쓸 수 없다.',
      disabled: S.scrap < r.cost,
      on: () => {
        S.scrap -= r.cost;
        if (r.kind === 'wear') {
          r.part.integrity = r.part.maxIntegrity;
          UI.logLine(`${partName(r.part)}의 닳은 자리를 ${r.max}까지 메웠다.`, 'good');
        } else {
          r.part.shield = r.max;
          UI.logLine(`${partName(r.part)}의 방어도를 ${r.max}까지 되돌렸다.`, 'good');
        }
        spendBench('repair');
        backToRoom();
      },
    })),
    { label: '돌아간다', cls: 'ghost', pin: true, on: backToRoom },
  ]);
  save();
}

const backToRoom = () => {
  UI.setCombatMode(false);
  benchRoom = null;                      // 쓰지 않고 나왔으면 사용권은 방에 남는다
  const fd = S.run.floorData;
  UI.topbar(S, `무덤 ${fd.floor}층`);
  UI.dungeonPanel(S, fd);
  roomChoices(roomAt(fd, fd.pos));
};

/* ── 방 종류별 처리 ─────────────────────── */
function bonesRoom(room) {
  const r = makeRng(S.run.seed + room.x * 31 + room.y * 17);
  // 조각은 방어도를 되돌리는 유일한 수단이다 (§5.7). 여기서 나오는 양이
  // 곧 한 단계를 버틸 수 있는지를 정한다 — 시뮬레이터가 정한 값이다
  const scrap = r.int(6, 14) + S.run.floor * 3;
  const extra = r.chance(35) ? r.int(1, 3) : 0;
  S.scrap += scrap;
  if (extra) S.boneMeal += extra;
  UI.logLine(`쓸 만한 뼈와 살점을 골라냈다. 시체 조각 +${scrap}${extra ? `, 골분 +${extra}` : ''}.`, 'good');
  room.cleared = true;
  UI.dungeonPanel(S, S.run.floorData);
  roomChoices(room);
}

/* ── 특수 상자 (§7.6) ───────────────────────────
   무덤이 강화의 재료를 내주는 자리다. 「불괴의 쐐기」는 상점에서 사려면 비싸고
   수소문까지 해야 하므로, **내려가는 사람에게 돌아오는 몫**이 하나는 있어야 한다. */
function cacheRoom(room) {
  const r = makeRng(S.run.seed + room.x * 131 + room.y * 57);
  UI.logLine('돌무더기 사이에 쇠 상자가 박혀 있다. 자물쇠는 이미 삭았다.', 'narrate');
  const got = [];
  if (r.chance(55)) {
    S.consumables.it_ward_nail = (S.consumables.it_ward_nail ?? 0) + 1;
    got.push(`${DB.itemsBy.it_ward_nail.name} +1`);
  }
  const bone = r.int(2, 5) + S.run.floor;
  const ichor = r.int(3, 8) + S.run.floor;
  S.boneMeal += bone; S.ichor += ichor;
  got.push(`골분 +${bone}`, `진액 +${ichor}`);
  if (r.chance(30)) {
    const silver = r.int(40, 90) + S.run.floor * 20;
    S.silver += silver;
    got.push(`은화 +${silver}`);
  }
  UI.logLine(`상자를 열었다 — ${got.join(', ')}.`, 'good');
  if (!S.log.hintWard && S.consumables.it_ward_nail) {
    S.log.hintWard = true;
    UI.logLine('— 불괴의 쐐기 —', 'necro');
    UI.logLine('단련로의 강화가 +5를 넘으면 실패가 아프다. 이 쐐기가 그 아픔만 막아 준다.', 'necro');
  }
  room.cleared = true;
  UI.dungeonPanel(S, S.run.floorData);
  roomChoices(room);
}

function trapRoom(room) {
  const r = makeRng(S.run.seed + room.x * 91 + room.y * 7);
  const kind = r.pick(['ceiling', 'acid', 'soul']);
  const g = assembleGolem(S);
  UI.choices([
    { label: '함정을 무릅쓰고 지나간다', cls: 'danger', on: () => {
      if (kind === 'ceiling') {
        const dmg = Math.round(g.stats.hp * 0.15);
        S.run.golemHp = Math.max(1, S.run.golemHp - dmg);
        UI.logLine(`천장이 무너져 내린다. 골렘이 ${dmg}의 피해를 입었다.`, 'bad');
      } else if (kind === 'acid') {
        const worn = g.worn.filter(({ part }) => part.integrity > 0);
        if (worn.length) {
          const t = r.pick(worn);
          t.part.integrity--;
          UI.logLine(`산성 웅덩이가 ${partName(t.part)}을(를) 갉아먹는다. (내구도 ${t.part.integrity})`, 'bad');
          if (t.part.integrity <= 0) destroyPart(t.part);
        }
      } else {
        UI.logLine('영혼의 소용돌이가 골렘을 훑고 지나간다. 다음 전투가 불리해진다.', 'bad');
        S.run.curse = true;
      }
      room.cleared = true;
      UI.dungeonPanel(S, S.run.floorData);
      roomChoices(room);
    } },
    { label: '돌아간다', cls: 'ghost', pin: true, on: () => { room.cleared = false; roomChoices(room); } },
  ]);
}

function restRoom(room) {
  const g = assembleGolem(S);
  UI.logLine('벽감의 초에 불을 붙인다. 잠시 숨을 돌릴 수 있다.', 'narrate');
  const damaged = g.worn.filter(({ part }) => part.integrity < part.maxIntegrity);
  UI.choices([
    // 안치실도 방어도를 되돌린다. 핵만 채워 주면 정작 발목을 잡는 쪽은 그대로다.
    // (§5.7의 "재료를 써야 돌아온다"는 그대로다 — 공짜가 아니라 조각을 쓴다)
    (() => {
      const PER_SCRAP = 35;
      const hurt = g.worn.filter((w) => w.shield < w.shieldMax);
      if (!hurt.length) return null;
      const missing = hurt.reduce((n, w) => n + (w.shieldMax - w.shield), 0);
      const cost = Math.max(1, Math.ceil(missing / PER_SCRAP));
      const pay = Math.min(cost, S.scrap);
      return {
        label: '이음새를 조인다 — 방어도 수리',
        meta: S.scrap ? `시체 조각 ${pay}${pay < cost ? ' (가진 만큼)' : ''}` : '조각이 없다',
        disabled: !S.scrap,
        on: () => {
          let left = pay * PER_SCRAP;
          S.scrap -= pay;
          for (const w of hurt) {
            if (left <= 0) break;
            const give = Math.min(left, w.shieldMax - w.shield);
            w.part.shield = w.shield + give;
            left -= give;
          }
          UI.logLine(`벌어진 이음새를 조였다. 방어도 +${pay * PER_SCRAP - Math.max(0, left)}.`, 'good');
          room.cleared = true; UI.dungeonPanel(S, S.run.floorData); roomChoices(room);
        },
      };
    })(),
    { label: '휴식 — 핵 체력 30% 회복', on: () => {
      const amt = Math.round(g.stats.hp * 0.3);
      S.run.golemHp = Math.min(g.stats.hp, S.run.golemHp + amt);
      S.golem.coreHp = S.run.golemHp;
      UI.logLine(`핵의 박동이 고르게 돌아온다. (+${amt})`, 'good');
      room.cleared = true; UI.dungeonPanel(S, S.run.floorData); roomChoices(room);
    } },
    ...damaged.map(({ part }) => ({
      label: `방부 처리 — ${UI.partHTML(part)}`, meta: `${part.integrity}/${part.maxIntegrity} → 완전`,
      on: () => {
        part.integrity = part.maxIntegrity;
        UI.logLine(`${partName(part)}을(를) 방부 처리했다.`, 'good');
        room.cleared = true; UI.dungeonPanel(S, S.run.floorData); roomChoices(room);
      },
    })),
    { label: '개조 — 무작위 모디파이어 (도박)', cls: 'danger', on: () => {
      const r = makeRng(S.run.seed + room.x * 13 + room.y * 29);
      const target = r.pick(g.worn);
      const pool = DB.modifiers.filter((m) => m.tier <= (S.run.floor >= 3 ? 2 : 1));
      const mod = r.weighted(pool.map((m) => [m.id, m.weight]));
      target.part.mod = mod;
      UI.logLine(`초를 녹여 부어 넣는다. ${partName(target.part)}이(가) 되었다.`, 'necro');
      room.cleared = true; UI.dungeonPanel(S, S.run.floorData); roomChoices(room);
    } },
  ]);
}

function sealedRoom(room) {
  const seal = room.seal;
  const g = assembleGolem(S);
  let can = false;
  if (seal.kind === 'scrap') can = S.scrap >= seal.value;
  else if (seal.kind === 'hp') can = S.run.golemHp > g.stats.hp * 0.3;
  else can = g.active.some((sid) => skillElement(S, sid) === seal.value && DB.skillsBy[sid].power > 0);

  UI.logLine(`봉인이 요구하는 것: ${seal.label}`, can ? 'good' : 'bad');
  if (!can) UI.logLine('아직은 열 수 없다. 조건을 갖추고 다시 오면 된다.', 'dim');

  UI.choices([
    { label: '봉인을 연다', cls: 'primary', disabled: !can, on: () => {
      if (seal.kind === 'scrap') S.scrap -= seal.value;
      else if (seal.kind === 'hp') {
        const cost = Math.round(S.run.golemHp * 0.25);
        S.run.golemHp -= cost;
        UI.logLine(`골렘의 체액을 문에 발랐다. (-${cost})`, 'bad');
      }
      const r = makeRng(S.run.seed + room.x * 53 + room.y * 61);
      const pool = DB.parts.filter((p) => p.rarity === 'rare');
      const part = makePart(r.pick(pool.length ? pool : DB.parts).id,
        r.weighted(DB.modifiers.map((m) => [m.id, m.weight])));
      S.inventory.push(part);
      UI.logLine(`봉인 너머에 ${partName(part)}이(가) 놓여 있다.`, 'good');
      notifyQuests({ kind: 'loot', slot: DB.partsBy[part.defId].slot, mod: part.mod });
      room.cleared = true;
      UI.dungeonPanel(S, S.run.floorData);
      roomChoices(room);
    } },
    { label: '지나친다', cls: 'ghost', on: () => roomChoices(room) },
  ]);
}

function eventRoom(room) {
  const r = makeRng(S.run.seed + room.x * 77 + room.y * 41);
  const g = assembleGolem(S);
  const kind = r.pick(['table', 'skull', 'grave']);
  const done = () => { room.cleared = true; UI.dungeonPanel(S, S.run.floorData); roomChoices(room); };

  if (kind === 'table') {
    UI.logLine('버려진 해부대다. 파츠 하나를 바치면 나머지를 손볼 수 있을 것 같다.', 'narrate');
    const equipped = new Set(SLOTS.map((s) => S.golem[s]).filter(Boolean));
    const spare = S.inventory.filter((p) => !equipped.has(p.uid));
    UI.choices([
      ...spare.map((p) => ({
        label: `${UI.partHTML(p)}을(를) 바친다`, on: () => {
          S.inventory = S.inventory.filter((x) => x.uid !== p.uid);
          for (const { part } of g.worn) part.integrity = Math.min(part.maxIntegrity, part.integrity + 8);
          UI.logLine('해부대가 피를 삼키고, 골렘의 이음새가 단단해진다. (전 파츠 내구도 +8)', 'good');
          notifyQuests({ kind: 'dismantle', count: 1 });
          done();
        },
      })),
      { label: '건드리지 않는다', cls: 'ghost', on: done },
    ]);
  } else if (kind === 'skull') {
    UI.logLine('두개골 하나가 혼자 속삭이고 있다. 대가를 요구한다.', 'narrate');
    UI.choices([
      { label: 'HP 20%를 바친다', cls: 'danger', on: () => {
        const cost = Math.round(g.stats.hp * 0.2);
        S.run.golemHp = Math.max(1, S.run.golemHp - cost);
        const part = makePart(r.pick(DB.parts).id,
          r.weighted(DB.modifiers.filter((m) => m.tier >= 2).map((m) => [m.id, m.weight])));
        S.inventory.push(part);
        UI.logLine(`속삭임이 멎고 ${partName(part)}이(가) 남았다.`, 'good');
        notifyQuests({ kind: 'loot', slot: DB.partsBy[part.defId].slot, mod: part.mod });
        done();
      } },
      { label: '무시한다', cls: 'ghost', on: done },
    ]);
  } else {
    UI.logLine('도굴꾼이 등을 보인 채 흥정을 걸어온다.', 'narrate');
    const price = 80;
    UI.choices([
      { label: '은화를 내고 물건을 본다', meta: money(price), disabled: S.silver < price, on: () => {
        S.silver -= price;
        const part = makePart(r.pick(DB.parts).id, r.chance(50)
          ? r.weighted(DB.modifiers.map((m) => [m.id, m.weight])) : null);
        S.inventory.push(part);
        UI.logLine(`${partName(part)}을(를) 받아들었다.`, 'good');
        notifyQuests({ kind: 'loot', slot: DB.partsBy[part.defId].slot, mod: part.mod });
        done();
      } },
      { label: '그냥 간다', cls: 'ghost', on: done },
    ]);
  }
}

function bossPrompt(room) {
  const left = S.run.floorData.rooms.filter((r) => !r.visited).length;
  UI.logLine(`아직 밟지 않은 방이 ${left}개 남아 있다.`, left ? 'bad' : 'dim');
  UI.choices([
    { label: '문을 연다', cls: 'primary', on: () => startBattle(room, true, true) },
    { label: '아직 아니다', cls: 'ghost', on: () => { roomChoices(room); } },
  ]);
}

/* ── 전투 ───────────────────────────────── */
function startBattle(room, elite, isBoss = false) {
  UI.resetBars();          // 새 전투에서 지난 전투의 잔상을 끌고 오지 않는다
  UI.resetBodyPick();      // 펼쳐 둔 부위도 전투마다 접는다
  const r = makeRng(S.run.seed + room.x * 977 + room.y * 131 + S.run.floor);
  const sid = S.run.stage ?? '1-1';
  const mon = isBoss ? rollBoss(sid, S.run.floor, r, S.unlocks)
    : elite ? rollElite(sid, S.run.floor, r, S.unlocks)
    : rollMonster(sid, S.run.floor, r, S.unlocks);
  cb = new Combat(S, mon, r);
  cb.room = room;
  const hzNow = CP.hazardOf(S.run.stage);
  // 범람: 물이 차면 몸이 더 잘 상한다 (§7-A.2) — 이제 내구도는 맞을 때 닳으므로 확률을 올린다
  if (hzNow?.kind === 'flood' && hazardNow() >= 2) cb.wearMul = 2;
  if (hzNow?.kind === 'flood' && hazardNow() >= 3) {
    cb.golem.ranks.spd = (cb.golem.ranks.spd ?? 0) - 1;
    cb.say('물이 허리까지 찼다. 발을 떼기가 무겁다. (속도 -1)', 'bad');
  }
  if (S.run.curse) {
    cb.golem.ranks.atk = -1;
    cb.say('영혼의 소용돌이가 아직 골렘에 감겨 있다. (공격 -1)', 'bad');
    S.run.curse = false;
  }
  const lastFloor = (stageOf(S.run.stage)?.floors ?? 3);
  const stageBoss = isBoss && S.run.floor >= lastFloor;
  UI.logHead(stageBoss ? `${stageOf(S.run.stage)?.name ?? ''}의 주인` : isBoss ? '층의 주인' : elite ? '엘리트 전투' : '전투');
  UI.logAll(cb.log);
  if (!S.log.hintAim) {
    S.log.hintAim = true;
    UI.logLine('— 처음이니 한 번만 짚는다 —', 'necro');
    UI.logLine('피해는 핵이 아니라 부속의 방어도부터 깎는다. 방어도가 다 닳아야 핵이 맞는다.', 'necro');
    UI.logLine('🎯 조준으로 적의 부위를 노릴 수 있다. 부수면 적이 약해지지만 그 부속은 못 얻는다.', 'necro');
    UI.logLine('🛡 막기로 받을 자리를 댈 수 있다. 성공하면 피해가 줄고 그 자리의 결로 상성을 따진다 — 빠를수록 잘 댄다.', 'necro');
    UI.logLine('🕯 술법은 골렘의 턴을 빼앗지 않는다. 걸어 두면 골렘의 공격과 같은 턴에 함께 나간다.', 'necro');
    UI.logLine('자세한 건 마을의 뼈 수습꾼에게 물어보면 된다.', 'dim');
  }
  combatTurn();
}

/* ── 전투 화면 (§12.17) ──────────────────────────────
   전에는 기술·술법·가방·조준·막기가 **전부 하단 독**에 깔렸다. 열 몇 개가 한 줄에
   늘어서면 매 턴 눈이 아래를 훑어야 하고, 쪽까지 나뉘면 기술을 찾다가 턴을 쓴다.

   이제 왼쪽 퀵메뉴가 **무엇을 할지**(공격·술법·가방)를 고르고,
   가운데 무대가 그 안의 **카드**를 펼친다. 하단에는 아무것도 남기지 않는다. */
let combatTab = 'skill';        // 지금 펼쳐 둔 갈래

function combatQuick() {
  const items = cb.combatItems();
  const canObserve = !cb.watched;
  const spells = cb.necroSkills();
  const ready = spells.filter((n) => n.usable).length;
  const prep = cb.prepValid();
  const aimConf = AIM[cb.aim];
  const canGuard = cb.guardable();
  const tab = (key, icon, label, sub, on) => ({
    key, icon, label, sub, here: combatTab === key,
    on: on ?? (() => { combatTab = key; combatTurn(); }),
  });
  UI.quickPanel([
    tab('skill', '⚔', '공격', `${cb.golemSkills().filter((x) => x.usable).length}개`),
    spells.length ? tab('spell', '🕯', '술법', prep ? '걸어 둠' : ready ? `${ready}개` : '대기') : null,
    (items.length || canObserve) ? tab('bag', '🎒', '가방',
      items.length ? `${items.reduce((n, i) => n + i.count, 0)}개` : '관찰') : null,
    { sep: true },
    tab('aim', '🎯', '조준', aimConf.name),
    canGuard.length ? tab('guard', '🛡', '막기', cb.guard ? GUARD_LABEL[cb.guard] : '맡긴다') : null,
  ]);
}

/** 지금 갈래의 카드들 */
function combatCards() {
  switch (combatTab) {
    case 'spell': {
      const prep = cb.prepValid();
      return {
        title: `술법 — 영력 ${cb.will}/10 · 공격과 함께 나간다`,
        cards: cb.necroSkills().map((n) => {
          const def = DB.necro_skillsBy[n.id];
          const on = prep?.id === n.id;
          return {
            label: `${UI.esc(n.name)}`,
            meta: on ? '걸어 뒀다 — 다시 누르면 푼다'
              : n.usable ? `영력 ${n.will}${def?.cooldown ? ` · 재사용 ${def.cooldown}턴` : ''}`
              : n.cd > 0 ? `${n.cd}턴 대기` : `영력 ${n.will} — 모자라다`,
            picked: on, disabled: !n.usable && !on,
            info: `<span class="tt">${UI.esc(n.name)}</span>`
              + `<div class="trow"><span>${UI.esc(def?.desc ?? '')}</span></div>`,
            on: () => { cb.prep = on ? null : n.id; combatTurn(); },
          };
        }),
      };
    }
    case 'bag': {
      const items = cb.combatItems();
      return {
        title: '가방 — 쓰면 그 턴 골렘은 때리지 못한다',
        cards: [
          ...items.map((it) => ({
            label: UI.esc(it.name), meta: `${it.count}개 · 턴 소모`,
            info: `<span class="tt">${UI.esc(it.name)}</span><span class="tm">${UI.esc(it.desc ?? '')}</span>`,
            on: () => resolve({ kind: 'item', id: it.id }),
          })),
          !cb.watched ? { label: '관찰', meta: '다음 수를 읽는다 · 턴 소모',
            info: '적의 방어 속성과 다음에 쓸 기술이 보인다.',
            on: () => resolve({ kind: 'observe' }) } : null,
        ],
      };
    }
    case 'aim': {
      return {
        title: '조준 — 어디를 때릴까',
        cards: ['random', 'upper', 'lower'].map((k) => ({
          label: AIM[k].name,
          meta: k === 'random' ? '부속 보존 · 부위 x1.0'
            : `명중 ${AIM[k].acc} · 부위 x${AIM[k].mul}`,
          picked: cb.aim === k,
          info: k === 'random'
            ? '아무 데나 때린다. 부위가 덜 부서지니 전리품이 온전하다.'
            : `${AIM[k].name}을(를) 노린다. 부수면 적이 약해지지만 그 부속은 못 얻는다.`,
          on: () => { cb.aim = k; combatTurn(); },
        })),
      };
    }
    case 'guard': {
      const chance = cb.guardChance();
      const framesOf = (k) => Object.values(cb.frames).filter((f) => !f.down && SLOT_KIND[f.slot] === k);
      return {
        title: `막기 — 어디로 받을까 · 성공 ${chance}%`,
        cards: [
          ...cb.guardable().map((k) => {
            const fs = framesOf(k);
            const els = [...new Set(fs.map((f) => partElement(f.part)).filter(Boolean))];
            const on = cb.guard === k;
            const sh = fs.reduce((n, f) => n + f.hp, 0);
            const shMax = fs.reduce((n, f) => n + f.max, 0);
            return {
              label: `${GUARD_LABEL[k]}${els.length ? ` <span style="color:var(--el-${els[0]})">${els.join('·')}</span>` : ''}`,
              meta: on ? '대고 있다 — 다시 누르면 푼다' : `방어도 ${sh}/${shMax}`,
              picked: on,
              info: `<span class="tt">${GUARD_LABEL[k]}(으)로 받는다</span>`
                + `<span class="tm">${fs.map((f) => UI.partHTML(f.part)).join(' · ')}</span>`
                + `<div class="trow"><span>결</span><b>${els.join(' · ') || '없음'}</b></div>`
                + `<div class="trow"><span>성공</span><b>${chance}%</b></div>`,
              on: () => { cb.guard = on ? null : k; combatTurn(); },
            };
          }),
          { label: '맡긴다', meta: '고르지 않는다 — 경감도 없다', picked: !cb.guard,
            on: () => { cb.guard = null; combatTurn(); } },
        ],
      };
    }
    default: {
      const prep = cb.prepValid();
      return {
        title: prep ? `공격 — 🕯 ${prep.name}이(가) 함께 나간다` : '공격 — 무엇으로 때릴까',
        cards: cb.golemSkills().map((s) => {
          let mark = '';
          if (s.mul != null) {
            if (s.mul > 1) mark = ' <span class="eff-up">▲</span>';
            else if (s.mul < 1) mark = ` <span class="eff-down">${s.mul === 0 ? '✕' : '▼'}</span>`;
          }
          if (s.raw) mark += ' <span class="eff-down">날것</span>';
          return {
            label: `<span style="color:var(--el-${s.element})">${s.element}</span> ${UI.esc(s.name)}${mark}`,
            meta: s.down ? '부위 정지' : `위력 ${s.power || '—'} · ${s.charges === null ? '∞' : `${s.left}/${s.charges}`}`,
            cls: s.usable && s.power > 0 ? 'primary' : '',
            disabled: !s.usable,
            on: () => resolve({ kind: 'skill', id: s.id, necro: cb.prep }),
          };
        }),
      };
    }
  }
}

function combatTurn() {
  UI.setCombatMode(true);
  UI.topbar(S, `전투 · ${cb.mon.name}`);
  UI.combatPanel(cb, S);

  /* 넓은 화면에서는 퀵메뉴 + 무대로 나눈다. 좁으면 예전처럼 하단 독 하나에 다 담는다 —
     세로 배치는 이번에 손대지 않기로 했다 (§12.17). */
  if (UI.isWide()) {
    combatQuick();
    const { title, cards } = combatCards();
    UI.choices([...cards.filter(Boolean)], { stage: true, stageTitle: title, paged: false });
    return;
  }

  const list = [];
  const aimConf = AIM[cb.aim];
  list.push({
    label: `🎯 조준 — <b>${aimConf.name}</b>`,
    meta: cb.aim === 'random' ? '부속 보존' : `명중 ${aimConf.acc} · 부위 x${aimConf.mul}`,
    cls: cb.aim === 'random' ? 'ghost' : 'primary',
    nokey: true,
    on: () => { combatTab = 'aim'; aimPickScreen(); },
  });
  const canGuard = cb.guardable();
  if (canGuard.length) {
    list.push({
      label: `🛡 막기 — <b>${cb.guard ? GUARD_LABEL[cb.guard] : '맡긴다'}</b>`,
      meta: cb.guard ? `성공 ${cb.guardChance()}%` : '어디로 맞을지 맡긴다',
      cls: cb.guard ? 'primary' : 'ghost', nokey: true,
      on: () => guardPickScreen(),
    });
  }
  const spells = cb.necroSkills();
  if (spells.length) {
    const prep = cb.prepValid();
    const ready = spells.filter((n) => n.usable).length;
    list.push({
      label: `🕯 술법 — <b>${prep ? UI.esc(prep.name) : '없음'}</b>`,
      meta: prep ? `영력 ${prep.will} · 공격과 함께`
        : ready ? `${ready}개 준비됨 — 눌러 고른다` : '재사용 대기 중',
      cls: prep ? 'primary' : 'ghost', disabled: !ready, nokey: true,
      on: () => spellPickScreen(),
    });
  }
  for (const s of cb.golemSkills()) {
    let mark = '';
    if (s.mul != null) {
      if (s.mul > 1) mark = ' <span class="eff-up">▲</span>';
      else if (s.mul < 1) mark = ` <span class="eff-down">${s.mul === 0 ? '✕' : '▼'}</span>`;
    }
    if (s.raw) mark += ' <span class="eff-down">날것</span>';
    list.push({
      label: `<span style="color:var(--el-${s.element})">${s.element}</span> ${s.name}${mark}`,
      meta: s.down ? '부위 정지' : `${s.power || '—'} · ${s.charges === null ? '∞' : `${s.left}/${s.charges}`}`,
      disabled: !s.usable,
      on: () => resolve({ kind: 'skill', id: s.id, necro: cb.prep }),
    });
  }
  const items = cb.combatItems();
  const canObserve = !cb.watched;
  if (items.length || canObserve) {
    list.push({
      label: '🎒 가방', cls: 'ghost',
      meta: items.length ? `${items.reduce((n, i) => n + i.count, 0)}개${canObserve ? ' · 관찰' : ''}` : '관찰',
      on: () => itemTurnScreen(items, canObserve),
    });
  }
  UI.choices(list, { paged: false });
}

/** 좁은 화면에서 조준을 고른다 — 넓은 화면은 무대에서 바로 고른다 */
function aimPickScreen() {
  UI.topbar(S, `전투 · ${cb.mon.name}`);
  UI.combatPanel(cb, S);
  UI.choices([
    ...['random', 'upper', 'lower'].map((k) => ({
      label: `${cb.aim === k ? '▶ ' : ''}${AIM[k].name}`,
      cls: cb.aim === k ? 'primary' : '',
      meta: k === 'random' ? '부속 보존' : `명중 ${AIM[k].acc} · 부위 x${AIM[k].mul}`,
      on: () => { cb.aim = k; combatTurn(); },
    })),
    { label: '돌아간다', cls: 'ghost', pin: true, on: combatTurn },
  ], { paged: false });
}

/**
 * 전투 중 술법 고르기 (§5.11).
 * 전에는 버튼 하나를 눌러 **돌려 가며** 골랐다 — 무엇이 있는지 보려면 끝까지 눌러 봐야 했고,
 * 지나치면 한 바퀴 더 돌아야 했다. 「가방」처럼 **늘어놓고 고른다.**
 * 여기서 고르는 것은 *걸어 두는 일*이라 턴을 쓰지 않는다 — 기술을 골라야 함께 나간다.
 */
function spellPickScreen() {
  const spells = cb.necroSkills();
  const prep = cb.prepValid();
  UI.topbar(S, `전투 · ${cb.mon.name}`);
  UI.combatPanel(cb, S);
  UI.logLine(`영력 ${cb.will}/10 — 술법은 골렘의 공격과 함께 나간다. 여기서는 턴을 쓰지 않는다.`, 'dim');
  UI.choices([
    ...spells.map((n) => {
      const def = DB.necro_skillsBy[n.id];
      const on = prep?.id === n.id;
      return {
        label: `${on ? '▶ ' : ''}${UI.esc(n.name)}`,
        cls: on ? 'primary' : '',
        meta: on ? '걸어 뒀다 — 다시 누르면 푼다'
          : n.usable ? `영력 ${n.will}${def?.cooldown ? ` · 재사용 ${def.cooldown}턴` : ''}`
          : n.cd > 0 ? `${n.cd}턴 대기` : `영력 ${n.will} — 모자라다`,
        disabled: !n.usable && !on,
        info: `<span class="tt">${UI.esc(n.name)}</span>`
          + `<span class="tm">${UI.esc(def?.school ?? '')} · 영력 ${n.will}</span>`
          + `<div class="trow"><span>${UI.esc(def?.desc ?? '')}</span></div>`,
        on: () => { cb.prep = on ? null : n.id; combatTurn(); },
      };
    }),
    prep ? { label: '걸어 둔 것을 푼다', cls: 'ghost',
      on: () => { cb.prep = null; combatTurn(); } } : null,
    { label: '돌아간다', cls: 'ghost', pin: true, on: combatTurn },
  ], { paged: false });
}

/**
 * 막을 곳 고르기 (§5.14 · §5.11).
 * 전에는 단추를 눌러 머리→몸통→팔→다리→맡긴다를 **돌려 가며** 골랐다.
 * 네 자리 중 하나를 고르려고 최대 네 번을 눌러야 했고, 각 자리가 무슨 결인지는
 * 돌려 보기 전에는 알 수 없었다. 이제 한 화면에 늘어놓고 **보고 고른다.**
 */
function guardPickScreen() {
  const kinds = cb.guardable();
  const chance = cb.guardChance();
  UI.topbar(S, `전투 · ${cb.mon.name}`);
  UI.combatPanel(cb, S);
  UI.logLine(`어디로 받을까. 성공하면 피해 -25%, 그 자리의 결로 상성을 따진다.`, 'dim');
  UI.logLine(`지금 대는 데 성공할 확률은 ${chance}% — 내 속도 ${Math.round(cb.golem.stats.spd)} vs 적 속도 ${Math.round(cb.mon.stats.spd)}.`,
    chance >= 60 ? 'good' : chance <= 35 ? 'bad' : '');

  /** 그 자리에 선 부속들 — 결과 남은 방어도를 함께 보여 준다 */
  const framesOf = (k) => Object.values(cb.frames).filter((f) => !f.down && SLOT_KIND[f.slot] === k);
  UI.choices([
    ...kinds.map((k) => {
      const fs = framesOf(k);
      const els = [...new Set(fs.map((f) => partElement(f.part)).filter(Boolean))];
      const on = cb.guard === k;
      const shield = fs.reduce((n, f) => n + f.hp, 0);
      const shieldMaxAll = fs.reduce((n, f) => n + f.max, 0);
      /* 적이 다음에 무엇을 들지 보고 있다면(관찰), 그 속성으로 이 자리가 유리한지까지 말해 준다 */
      const nextEl = cb.watched && cb.monNext ? DB.skillsBy[cb.monNext]?.element : null;
      const mul = nextEl && els.length ? Math.min(...els.map((e) => elemMul(nextEl, e))) : null;
      return {
        label: `${on ? '▶ ' : ''}${GUARD_LABEL[k]}${els.length ? ` <span style="color:var(--el-${els[0]})">${els.join('·')}</span>` : ''}`
          + (mul != null ? (mul <= 0.5 ? ' <span class="eff-up">▲</span>' : mul >= 1.5 ? ' <span class="eff-down">▼</span>' : '') : ''),
        cls: on ? 'primary' : '',
        meta: on ? '대고 있다 — 다시 누르면 푼다'
          : `방어도 ${shield}/${shieldMaxAll} · 성공 ${chance}%`,
        info: `<span class="tt">${GUARD_LABEL[k]}(으)로 받는다</span>`
          + `<span class="tm">${fs.map((f) => UI.partHTML(f.part)).join(' · ')}</span>`
          + `<div class="trow"><span>결</span><b>${els.join(' · ') || '없음'}</b></div>`
          + `<div class="trow"><span>남은 방어도</span><b>${shield}/${shieldMaxAll}</b></div>`
          + `<div class="trow"><span>대는 데 성공</span><b>${chance}%</b></div>`
          + (nextEl ? `<div class="trow"><span>적의 다음 수 ${nextEl}</span><b>${mul <= 0.5 ? '잘 받는다' : mul >= 1.5 ? '아프다' : '보통'}</b></div>` : ''),
        on: () => { cb.guard = on ? null : k; combatTurn(); },
      };
    }),
    { label: `${cb.guard ? '' : '▶ '}맡긴다`, cls: cb.guard ? 'ghost' : 'primary',
      meta: '어디로 맞을지 고르지 않는다 — 경감도 없다',
      info: '대지 않으면 아무 자리나 맞는다. 대신 속도 싸움도 하지 않는다.',
      on: () => { cb.guard = null; combatTurn(); } },
    { label: '돌아간다', cls: 'ghost', pin: true, on: combatTurn },
  ], { paged: false });
}

/** 전투 중 물약·관찰 — 고르면 그 턴을 쓴다 */
function itemTurnScreen(items, canObserve) {
  UI.topbar(S, `전투 · ${cb.mon.name}`);
  UI.combatPanel(cb, S);
  UI.logLine('무엇을 쓸까. 쓰면 골렘은 이번 턴에 때리지 못한다.', 'dim');
  UI.choices([
    ...items.map((it) => ({
      label: it.name, meta: `${it.count}개 · 턴 소모`, info: `<span class="tt">${UI.esc(it.name)}</span>`
        + `<span class="tm">${UI.esc(it.desc ?? '')}</span>`,
      on: () => resolve({ kind: 'item', id: it.id }),
    })),
    canObserve ? { label: '관찰', meta: '다음 수를 읽는다 · 턴 소모',
      info: '<span class="tt">관찰</span><span class="tm">한 턴을 쓴다</span>'
        + '<div class="trow"><span>이 싸움이 끝날 때까지 <b>적의 다음 기술</b>이 보인다</span></div>'
        + '<div class="trow"><span>방어 속성을 기록해 상성 표시가 켜진다</span></div>'
        + '<div class="trow"><span>몸을 낮춰 그 턴 <b>회피 +1랭크</b></span></div>',
      on: () => resolve({ kind: 'observe' }) } : null,
    { label: '돌아간다', cls: 'ghost', pin: true, on: combatTurn },
  ], { paged: false });
}

async function resolve(action) {
  /* 전투가 이미 끝났는데 카드가 한 번 더 눌릴 수 있다 (연출 대기 중의 두 번째 클릭,
     또는 화면이 바뀌기 전에 남아 있던 카드). cb가 없으면 조용히 흘려보낸다. */
  /* 이미 끝난 판의 카드가 한 번 더 눌릴 수 있다 — 무대는 다시 그려지기 전까지 남아 있다.
     끝난 전투에 한 대를 더 넣으면 승리 처리가 두 번 돌아 S.run이 없는 채로 들어간다. */
  if (!cb || cb.over || !S.run) return;
  /* 연출을 기다리는 사이에 전투가 치워질 수 있다(튜토리얼 인계·패배 연출).
     await 뒤에 `cb`를 다시 만지면 그때 null이다 — 이 판을 c로 붙들어 두고,
     도중에 바뀌었으면 조용히 물러난다. */
  const c = cb;
  const before = c.summonCount;
  c.act(action);
  // 로그를 한꺼번에 쏟지 않고 국면별로 끊어 보여준다 (§5.8)
  UI.logWaiting();
  await UI.logPlay(c.log);
  if (cb !== c) return;
  if (cb.summonCount > before) {
    S.run.summons += cb.summonCount - before;
    notifyQuests({ kind: 'summon', count: cb.summonCount - before });
  }
  S.run.golemHp = cb.golem.hp;
  S.golem.coreHp = cb.golem.hp;      // 핵 체력은 런을 넘어 남는다
  cb.commitShields();                 // 방어도도 파츠에 새겨진다
  /* 끝난 판의 **마지막 숫자를 보여 준다.** 전에는 전투가 끝나면 패널을 다시 그리지 않아
     「쓰러진다」는 로그 옆에 적의 체력이 41/170으로 남아 있었다 —
     마지막 한 대가 화면에 반영되지 않은 것이다. 이긴 쪽도 진 쪽도 0을 보고 끝나야 한다. */
  if (cb.over) {
    UI.combatPanel(cb, S);
    // 동작을 줄이는 설정에서는 기다리지 않는다 — 연출은 기다림이 되어선 안 된다 (§5.8)
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    if (!still) await new Promise((r) => setTimeout(r, 420));
  }
  if (cb !== c) return;
  if (!cb.over) { combatTurn(); return; }
  if (cb.result === 'win') winBattle();
  else loseRun();
}

function winBattle() {
  if (S.run?.tutorial) {          // 첫 전투는 전리품도 내구도도 건드리지 않는다 (§7-B)
    UI.logLine('"거봐. 아직 움직이는구먼."', 'good');
    tutorialBattleOver(true);
    return;
  }
  const room = cb.room;
  room.cleared = true;
  S.run.kills++;
  S.log.kills++;
  notifyQuests({ kind: 'kill', monster: cb.mon.defId });
  if (!cb.usedNecro) notifyQuests({ kind: 'cleanwin' });

  /* 내구도는 **맞아서** 닳는다 (§3.3-C). 전투 동안 combat이 세어 둔 것을 여기서 새긴다.
     전에는 「쓴 부속마다 전투당 1」이라 때리기만 해도 팔이 닳았고, 한 단계를 도는 것만으로
     모든 부속이 바스러졌다. 이제 맞지 않은 부속은 멀쩡하다. */
  const g = assembleGolem(S);
  S.run.battles = (S.run.battles ?? 0) + 1;
  const skipWear = g.traits.wearHalf && S.run.battles % 2 === 1;
  if (!skipWear) {
    for (const [uid, n] of Object.entries(cb.wear ?? {})) {
      const p = findPart(uid);
      if (!p || n <= 0) continue;
      p.integrity -= n;
      if (p.integrity <= 0) destroyPart(p);
      else if (wornLow(p)) UI.logLine(`⚠ ${partName(p)}의 내구도가 ${p.integrity}밖에 남지 않았다.`, 'bad');
    }
  } else if (Object.keys(cb.wear ?? {}).length) UI.logLine('철제 이음쇠가 마모를 받아냈다.', 'dim');

  if (S.run.collapsed) { collapseRun(); return; }

  const silver = 20 + S.run.floor * 10 + (cb.mon.tier === 'elite' ? 40 : 0);
  S.silver += silver;
  UI.logLine(`시체에서 은화 ${silver}을 추렸다.`, 'good');

  if (cb.brokenMonSlots.length) {
    UI.logLine(`부서진 부위(${[...new Set(cb.brokenMonSlots)].map((s) => KIND_LABEL[s]).join(', ')})는 회수할 수 없다.`, 'dim');
  }
  const loot = rollLoot(cb.mon, cb.rng, 2, cb.brokenMonSlots);
  const isBoss = room.type === 'boss';
  UI.choices([
    ...loot.map((p) => ({
      label: `${UI.partHTML(p)} 수습`,
      meta: `${KIND_LABEL[DB.partsBy[p.defId].slot]} · 날것 · 내구 ${p.integrity}`,
      info: UI.partTip(p),
      on: () => {
        S.inventory.push(p);
        UI.logLine(`${partName(p)}을(를) 챙겼다.`, 'good');
        if (!S.log.hintRaw) {
          S.log.hintRaw = true;
          UI.logLine('— 날것 부속 —', 'necro');
          UI.logLine('막 뜯어온 것은 골렘에 맞지 않는다. 그대로 끼우면 스탯 60%, 기술 25% 불발, 내구도 2배 소모다.', 'necro');
          UI.logLine('납골당 → 공방 → 단련로 → 정착 (조각 8 + 진액 1, 20분)을 거치면 온전해진다.', 'necro');
        } else {
          UI.logLine('아직 날것이다. 납골당 정착대를 거쳐야 온전히 쓸 수 있다.', 'dim');
        }
        if (!S.log.hintSwap) {
          S.log.hintSwap = true;
          UI.logLine('— 부속 교체 —', 'necro');
          UI.logLine('부속은 능력치만이 아니라 기술을 들고 온다. 팔을 바꾸면 쓸 수 있는 기술이 통째로 바뀐다.', 'necro');
          UI.logLine('그래서 좋은 부속이 아니라 지금 빌드에 맞는 부속을 고르는 것이 이 게임의 결정이다.', 'necro');
          UI.logLine('교체 화면에서 부속에 손을 얹으면 바꿨을 때 무엇이 오르내리는지 전부 보여 준다.', 'good');
        }
        notifyQuests({ kind: 'loot', slot: DB.partsBy[p.defId].slot, mod: p.mod });
        afterBattle(isBoss, room);
      },
    })),
    { label: '아무것도 가져가지 않는다', cls: 'ghost', pin: true, on: () => afterBattle(isBoss, room) },
  ]);
}

function afterBattle(isBoss, room) {
  if (isBoss) {
    const coreId = S.run.floor >= 3 ? 'core_gravelord' : 'core_soul';
    S.cores.push(coreId);
    UI.logLine(`시체 한복판에서 ${DB.coresBy[coreId].name}을(를) 꺼냈다.`, 'necro');
    notifyQuests({ kind: 'floorclear', noLoss: S.run.noLoss });
    notifyQuests({ kind: 'progress', floor: S.run.floor });
    UI.logLine(`${S.run.floor}층을 정리했다.`, 'good');
    /* 마지막 층의 주인을 눕혔으면 **그것으로 단계가 끝난 것이다** (§7-A.5).
       전에는 여기서도 「더 내려간다 / 여기서 돌아간다」를 내밀었다. 더 내려갈 곳이 없는
       마당에 「돌아간다」를 고르면 abandonRun이 돌아 단계가 깨지지 않은 채로 끝났다 —
       주인을 잡고도 걸어온 길이 0/9에 머물렀다. 갈림길이 아닌 곳에 갈림길을 두지 않는다. */
    const last = S.run.floor >= (stageOf(S.run.stage)?.floors ?? 3);
    if (last) {
      UI.logLine('더 내려갈 곳이 없다. 이 단계의 바닥이다.', 'necro');
      UI.choices([{ label: '단계를 끝내고 돌아간다', cls: 'primary', pin: true, on: runComplete }]);
      save();
      return;
    }
    UI.choices([
      { label: '더 내려간다', cls: 'primary', on: nextFloor },
      { label: '여기서 돌아간다', cls: 'ghost',
        meta: '단계는 깨지지 않는다 — 바닥까지 가야 깬 것이다',
        info: '지금 돌아가면 주운 것은 남지만 이 단계는 여전히 「아직 못 깬 곳」이다.',
        on: () => abandonRun(true) },
    ]);
    save();
    return;
  }
  UI.dungeonPanel(S, S.run.floorData);
  roomChoices(room);
}

function destroyPart(p) {
  UI.logLine(`${partName(p)}이(가) 바스러져 사라졌다.`, 'bad');
  S.inventory = S.inventory.filter((x) => x.uid !== p.uid);
  let lostBody = false;
  for (const slot of SLOTS) {
    if (S.golem[slot] !== p.uid) continue;
    S.golem[slot] = null;
    if (slot === 'body') lostBody = true;
  }
  if (S.run) S.run.noLoss = false;
  S.log.lost++;
  const rec = S.ossuary?.vault?.lostRecords;
  if (rec && !rec.includes(p.defId)) rec.push(p.defId);

  // 몸통이 빠지면 핵이 드러날 뿐, 골렘은 계속 선다 (§3.1).
  // 예비가 있으면 갈아끼워 주고, 없으면 그대로 싸운다 — 대신 피해가 핵으로 샌다.
  if (!lostBody) return;
  const spare = S.inventory.find((x) => DB.partsBy[x.defId].slot === 'body');
  if (spare) {
    S.golem.body = spare.uid;
    UI.logLine(`몸통이 사라졌다. 급히 ${partName(spare)}을(를) 끼워 넣는다.`, 'necro');
    if (S.run) S.run.golemHp = Math.min(S.run.golemHp, assembleGolem(S).stats.hp);
  } else {
    UI.logLine('흉곽이 통째로 떨어져 나갔다. 핵이 드러났다 — 이제 맞으면 곧장 핵이 깎인다.', 'bad');
  }
  // 부속이 하나도 남지 않으면 더 싸울 수 없다
  if (S.run && !SLOTS.some((sl) => S.golem[sl])) S.run.collapsed = true;
}

/**
 * 몸통을 잃어 더 내려갈 수 없는 경우 — **패배가 아니라 강제 귀환이다.**
 *
 * 전에는 여기서 골렘을 해체해 핵까지 쪼갰다. 이기고 난 직후, 핵이 162/190으로
 * 멀쩡한데도 흉갑의 내구도가 0이 됐다는 이유만으로 런 전체를 날리는 처벌이었다.
 * 패배의 대가(핵 파괴·부속 산실)는 **핵이 0이 되거나 모든 부위가 무너졌을 때**의 것이고,
 * 흉갑 하나가 닳아 없어진 것은 그저 "더는 못 걷는다"는 뜻이다.
 * 남은 부속과 핵은 그대로 안고 돌아온다.
 */
function collapseRun() {
  UI.logHead('철수');
  UI.logLine('마지막 부속까지 떨어져 나갔다.', 'narrate');
  UI.logLine('핵은 성하다. 남은 부속을 수레에 싣고 돌아선다.', 'good');
  S.golem.coreHp = S.run.golemHp;      // 핵 체력은 런을 넘어 남는다
  const ash = 15 + S.run.kills * 3;
  S.soulAsh += ash;
  UI.logLine(`영혼재 ${ash}를 정산했다.`, 'dim');
  UI.logLine('마을에서 몸통을 끼워야 다시 내려갈 수 있다.', 'dim');
  S.run = null;
  S.town.stock = rollStock(rng, S.unlocks);
  UI.choices([{ label: '마을로 돌아간다', cls: 'primary', on: () => settleAndReport(() => town()) }]);
  save();
}

/**
 * 골렘이 부서졌다. 핵은 깨지고 장착 부속은 흩어진다.
 * 쓰러지는 순간 흩어진 것 중 성한 것일수록 나중에 되찾을 확률이 높다.
 */
/**
 * 골렘이 무너졌다. 장착했던 부속은 확률로 날아가고,
 * **소지품에 들고 있던 여분도 일부 흘린다** (§3.3).
 *
 * 여분까지 거는 이유: 그러지 않으면 여분을 잔뜩 쟁여두는 것만으로 죽음이 무손실이 된다.
 * 아까운 것은 납골당 표본실에 맡겨야 안전하다 — 그게 표본실의 존재 이유다.
 */
const SPARE_LOSS = 20;        // 여분 한 개당 잃을 확률(%)

function dismantleGolem() {
  const g = assembleGolem(S);
  const kept = [], lost = [];
  for (const { slot, part } of g.worn) {
    const ratio = part.maxIntegrity ? part.integrity / part.maxIntegrity : 0;
    // 잔해 수습 해금 한 단마다 +10%p (§8)
    const chance = Math.round(20 + 45 * ratio) + (S.unlocks.salvage ?? 0) * 10;
    if (rng.chance(chance)) {
      part.raw = true;                            // 급히 뜯어 온 것은 날것이다
      kept.push(part);
    } else {
      lost.push(part);
      S.inventory = S.inventory.filter((x) => x.uid !== part.uid);
      const rec = S.ossuary?.vault?.lostRecords;
      if (rec && !rec.includes(part.defId)) rec.push(part.defId);
    }
    S.golem[slot] = null;
  }
  // 소지품의 여분도 일부 흘린다. 표본실·조립대·파견에 맡긴 것은 건드리지 않는다
  const wornUids = new Set(g.worn.map((w) => w.part.uid));
  const inWork = new Set(O.workshopGolems(S).flatMap((wg) => wg.parts.map((x) => x.uid)));
  const inLabor = new Set((S.ossuary?.laborBay?.dispatch ?? []).flatMap((d) => (d.parts ?? []).map((x) => x.uid)));
  const rate = Math.max(5, SPARE_LOSS - (S.unlocks.salvage ?? 0) * 4);
  const atRisk = S.inventory.filter((part) =>
    !wornUids.has(part.uid) && !inWork.has(part.uid) && !inLabor.has(part.uid));
  const spareLost = rollSpareLoss(atRisk, rate, rng);
  for (const part of spareLost) {
    S.inventory = S.inventory.filter((x) => x.uid !== part.uid);
    const rec = S.ossuary?.vault?.lostRecords;
    if (rec && !rec.includes(part.defId)) rec.push(part.defId);
  }

  const brokenCore = S.golem.core;
  S.golem.core = null;
  S.golem.coreHp = null;             // 쪼개진 핵의 상처는 다음 핵에 옮지 않는다
  if (brokenCore) delete S.coreHpBy[brokenCore];
  S.golem.attachments = [];
  return { kept, lost, spareLost, rate, brokenCore };
}

/**
 * 무너진 뒤의 보고. **주워 온 주체가 바르그**이므로, 건진 것은 여기서 세지 않는다 —
 * 그건 깨어난 뒤 그의 손에서 나온다 (§5.10).
 */
function reportDismantle(r) {
  if (r.brokenCore) UI.logLine(`${DB.coresBy[r.brokenCore].name}이(가) 쪼개졌다. 골렘은 더 이상 없다.`, 'bad');
  if (r.lost.length) UI.logLine(`${r.lost.map(partName).join(', ')}은(는) 그 자리에 남았다.`, 'bad');
  if (r.spareLost?.length) {
    UI.logLine(`쓰러지며 짐도 쏟았다 — ${r.spareLost.map(partName).join(', ')}.`, 'bad');
    if (!S.log.hintVault) {
      S.log.hintVault = true;
      UI.logLine('— 창고 —', 'necro');
      UI.logLine(`무덤에 들고 내려간 여분은 무너질 때 하나당 ${r.rate}%씩 흘린다.`, 'necro');
      UI.logLine('납골당 창고에 맡긴 것은 무너져도 그대로 남는다.', 'good');
    }
  }
}

/* ── 패배 — 연결이 끊기고, 깨어나면 바르그가 있다 (§5.10) ──────────────
   전에는 네크로맨서가 **걸어서 도망쳤다.** 이상한 그림이었다 —
   무덤을 빠져나오려면 귀환의 문양이 필요한데, 골렘이 부서진 순간에만
   맨몸으로 걸어 나올 수 있었으니까.

   골렘은 네크로맨서가 영력으로 붙들고 있는 몸이다. 그 몸이 부서지면
   **연결이 끊기며 술자가 되받아친다.** 네크로맨서는 그 자리에서 정신을 잃고,
   깨우는 것은 언제나 뼈 수습꾼이다. 건진 부속은 그의 손에서 나온다. */

function loseRun() {
  if (S.run?.tutorial) {          // 첫 전투에서 진다고 판이 끝나지는 않는다 (§7-B)
    UI.logHead('주저앉다');
    UI.logLine('골렘이 한쪽 무릎을 꺾는다. 바르그가 지팡이로 그것을 툭 친다.', 'narrate');
    tutorialBattleOver(false);
    return;
  }
  UI.logHead('붕괴');
  UI.logLine('골렘의 핵이 갈라진다. 붙들고 있던 실이 한꺼번에 끊긴다.', 'narrate');
  UI.logLine('되받아친 영력이 네크로맨서의 안쪽을 때린다. 무릎이 먼저 꺾인다.', 'bad');
  const r = dismantleGolem();
  reportDismantle(r);
  const ash = 15 + S.run.kills * 3;
  S.soulAsh += ash;
  const kills = S.run.kills;
  S.run = null;
  S.town.stock = rollStock(rng, S.unlocks);
  save();

  UI.choices([{
    label: '…', cls: 'ghost', disabled: true, meta: '정신이 흐려진다',
  }]);
  // 한 박자 두고 화면이 꺼진다 — 즉시 검어지면 마지막 줄을 읽을 틈이 없다
  setTimeout(() => {
    UI.blackout('정신을 잃었다').then(() => wakeWithBarg(r, ash, kills));
  }, 900);
}

/** 깨우는 것은 언제나 그다. 주변에서 주워 온 것을 건네며 시작한다 */
function wakeWithBarg(r, ash, kills) {
  UI.clearLog();
  UI.topbar(S, '시체골 · 수레 곁');
  UI.listPanel('바르그의 수레', [
    UI.rowHTML('핵', S.golem.core ? UI.esc(DB.coresBy[S.golem.core].name) : '<span class="empty">쪼개졌다</span>',
      '', !S.golem.core),
    UI.rowHTML('건진 것', r.kept.length ? `${r.kept.length}개` : '<span class="empty">없다</span>', '', !r.kept.length),
    UI.rowHTML('두고 온 것', r.lost.length ? `${r.lost.length}개` : '없다', '', r.lost.length > 0),
    UI.rowHTML('영혼재', `+${ash}`, ''),
  ], '<p class="note">골렘이 부서지면 술자도 함께 끊긴다. 깨어난 자리는 언제나 그의 수레 곁이다.</p>');
  UI.logHead('깨어나다');
  UI.logLine('젖은 천이 이마에 얹혀 있다. 모닥불 냄새. 수레바퀴 삐걱이는 소리.', 'narrate');
  UI.logLine('"살아 있구먼. 골렘이 깨지면 술자도 같이 깨진다니까 그렇게 말을 안 듣더니."', 'dim');
  UI.logLine('바르그가 당신을 무덤 입구까지 끌고 나왔다. 언제부터 거기 있었는지는 묻지 않는다.', 'narrate');

  if (r.kept.length) {
    for (const part of r.kept) {
      if (!S.inventory.some((x) => x.uid === part.uid)) S.inventory.push(part);
    }
    UI.logLine(`"주변에 흩어진 걸 좀 주워 왔어. 성한 건 아니다만."`, 'dim');
    UI.logLine(`${r.kept.map(partName).join(', ')}을(를) 건네받았다. 급히 뜯어 온 날것이다.`, 'good');
  } else {
    UI.logLine('"건질 게 없더군. 그 아래에 다 두고 왔어."', 'dim');
  }
  UI.logLine(`영혼재 ${ash}가 손안에 남았다. ${kills ? `쓰러뜨린 ${kills}구에서 나온 것이다.` : '그것뿐이다.'}`, 'dim');
  if (!S.golem.core) UI.logLine('"새 핵을 구해 와. 그거 없이는 아무것도 못 세우니까."', 'necro');

  resyncUids(S);
  save();
  UI.choices([{ label: '몸을 일으킨다', cls: 'primary',
    on: () => { UI.lighten(); settleAndReport(() => town()); } }]);
  // 선택지를 그려 둔 다음에 화면을 연다 — 빈 화면이 먼저 보이면 장면이 끊긴다
  UI.lighten();
}

function abandonRun(safe) {
  const ash = (safe ? 30 : 10) + S.run.kills * 3;
  S.soulAsh += ash;
  UI.logLine(`영혼재 ${ash}를 정산했다.`, 'good');
  S.run = null;
  S.town.stock = rollStock(rng, S.unlocks);
  UI.choices([{ label: '마을로', cls: 'primary', pin: true, on: () => settleAndReport(() => town()) }]);
  save();
}

/* ── 의뢰 알림 ──────────────────────────── */
function notifyQuests(ev) {
  const done = advanceQuests(S, ev);
  for (const q of done) UI.logLine(`📜 의뢰 완료 — ${q.title}`, 'necro');
  if (done.length && questsAllDone(S)) UI.logLine('📜 의뢰 세 건을 모두 마쳤다. 의뢰소로.', 'necro');

  const daily = advanceDaily(S, ev);
  for (const q of daily) UI.logLine(`☀ 오늘의 일 — ${q.title} 완료`, 'good');
}

/* ── 부팅 ───────────────────────────────── */
async function boot() {
  // 설치형 앱 준비 — 데이터를 읽기 전에 붙여야 beforeinstallprompt를 놓치지 않는다
  PWA.boot();
  // 설치 가능해지면 마을 화면에 버튼이 생겨야 하므로 다시 그린다
  PWA.onChange.push(() => { if (S && !S.run && !cb) town(false); });
  // 새 판이 준비되면 그 자리에서 알린다 — 껐다 켜도 안 바뀐다는 말이 여기서 나왔다
  PWA.onUpdate.push(() => {
    UI.logLine('🔄 새 판이 와 있다. 마을에서 「새 판으로 바꾼다」를 누르면 적용된다.', 'necro');
    if (S && !S.run && !cb) town(false);
  });
  try {
    await loadData();
    // 작업반 능률 계산에 파츠 스탯과 핵 체력을 넘긴다
    O.bindStats(partStats,
      (coreId) => DB.coresBy[coreId]?.hp ?? 0,
      (coreId) => DB.coresBy[coreId]?.stats ?? {});
  } catch (e) {
    document.getElementById('log').innerHTML =
      `<div class="line bad">${UI.esc(e.message)}</div>
       <div class="line dim">data 폴더를 읽으려면 파일을 직접 여는 대신 로컬 서버로 실행해야 합니다. 터미널에서 <b>npm start</b>.</div>`;
    return;
  }
  const loaded = load();
  S = loaded ?? newSave();
  rng = makeRng(Date.now() & 0xffffffff);
  if (!loaded) {
    UI.logHead('Project Patchwork');
    UI.logLine('당신은 골렘을 만드는 네크로맨서다. 싸우는 것은 당신이 아니라, 당신이 조립한 것이다.', 'narrate');
    UI.logLine('무덤에서 시체를 뜯어 와 골렘에 붙인다. 붙인 부속이 곧 골렘의 능력이자 기술이 된다.', 'narrate');
    UI.logLine('무엇이 어디에 쓰이는지 모르겠으면 마을의 뼈 수습꾼에게 물어보면 된다.', 'dim');
  } else {
    UI.logLine('기록을 불러왔다.', 'dim');
  }
  /* 첫 판이면 마을 대신 대본부터 (§7-B).
     대본 속 전투 도중에 껐다 켰다면 그 판은 버리고 **그 걸음부터** 다시 한다 —
     튜토리얼 전투에는 층 지도가 없어서 탐험 복귀 경로로 보내면 그대로 깨진다. */
  if (!S.tutorial?.done) {
    if (S.run?.tutorial) S.run = null;
    if (!S.run) { UI.clearLog(); tutorialScreen(); return; }
  }
  if (S.run) {
    UI.logLine('무덤 한가운데서 정신이 든다. 탐험이 아직 끝나지 않았다.', 'dim');
    enterRoom(roomAt(S.run.floorData, S.run.floorData.pos), true);
  } else settleAndReport(() => town());
}

window.addEventListener('error', (e) => UI.logLine(`오류: ${e.message}`, 'bad'));
boot();
