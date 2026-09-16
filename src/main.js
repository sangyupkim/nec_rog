/** 게임 진행 · 화면 전환 · 세이브 */
import {
  DB, loadData, makeRng, makePart, partName, partStats, partSkills,
  assembleGolem, SLOTS, SLOT_LABEL, SLOT_KIND, SKILL_CAP,
  rollMonster, rollElite, rollBoss, rollLoot, syncUidSeq, skillElement, AIM, RAW_WEAR, wornLow,
  stageOf, partOf, shieldNow, shieldMax, partMana, coreMana, CORE_MANA_STEP, CORE_MANA_MAX_LV,
  partFlavor,
  rollSpareLoss,
} from './core.js';
import { Combat } from './combat.js';
import * as CP from './campaign.js';
import { generateFloor, roomAt, exitsOf, ROOM_LABEL, ROOM_ICON, FLAVOR, DIR_KEY } from './dungeon.js';
import {
  rollQuests, advanceQuests, questsAllDone, claimQuests, resetQuests,
  refreshDaily, advanceDaily, dailyAllDone, claimDaily,
  nextResetCost, rollStock, partPrice, sellPrice, canCraft, craft,
  canLearn, learn, buildingStatus, ATTACH_SLOTS,
  SUPPLY, newSupply, tickSupply, supplyRemain,
} from './town.js';
import * as O from './ossuary.js';
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
  // 해체대·접합로·대장간을 빠뜨렸더니, 거기 올려 둔 파츠의 번호를 새 파츠가
  // 다시 쓰는 일이 생겼다 — 같은 uid가 둘이면 장착 표시가 엉뚱한 것에 붙는다.
  const all = allStoredParts(s);
  for (const p of all) max = Math.max(max, Number(String(p.uid).slice(1)) || 0);
  syncUidSeq(max + 1);
}

function migrate(s) {
  s.cores ??= [];
  s.coreUpgrades ??= {};
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
    use: '정착 · 이식 · 수복 · 부패조 투입 · 방어도 수리 · 대장간 제작과 강화',
    note: '가장 많이 쓰인다. 모자라면 유해 더미를 뒤지거나 파츠를 해체한다.' },
  { key: 'ichor', name: '부패 진액', tag: '촉매',
    from: '부패조 방치 생산 · 희귀 이상 파츠 해체 · 역병 늪지 파견',
    use: '정착 · 융합 · 이식 · 소생 · 핵 안정화 · 방혈관과 도가니 제작',
    note: '부패조에 시체 조각을 담가 두면 시간이 알아서 만들어 준다.' },
  { key: 'boneMeal', name: '골분', tag: '정밀 재료',
    from: '공동묘지·갱도 파견 · 유해 더미 · 유니크 파츠 해체',
    use: '정제 · 소생 · 수복 · 정비대 · 균형추 제작 · 파츠 강화',
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
  UI.logLine('고치는 곳: 납골당 → 접합로 → 정착. 시체 조각 8 + 부패 진액 1, 20분.', 'good');
  UI.logLine('상점에서 산 것, 봉인실 보상, 접합로에서 나온 것은 처음부터 정착 상태다. 날것은 전투 드랍에만 붙는다.', 'dim');
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
  UI.logLine(`▸ 지금 할 일 — ${CP.objective(S)}`, 'necro');
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
      info: `지금 돌고 있는 판은 <b>${PWA.version()}</b>이다.<br>눌러 새 판이 있는지 다시 확인한다.`,
      on: () => {
        PWA.checkForUpdate();
        UI.logLine(PWA.hasUpdate()
          ? '새 판이 와 있다 — 「새 판으로 바꾼다」를 누르면 적용된다.'
          : `판 ${PWA.version()} — 확인했다. 잠시 뒤에도 새것이 없으면 이게 최신이다.`, 'dim');
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
    ...(o.overhaul ?? []), ...(S.town?.smithy ?? []),
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
const CORE_UP_COST = (lv) => ({
  silver: 250 + lv * 250,
  scrap: 10 + lv * 8,
  boneMeal: 2 + lv * 2,
});

function coreManaScreen() {
  const coreId = S.golem.core;
  UI.topbar(S, '시체골 · 영혼석 강화');
  const core = coreId ? DB.coresBy[coreId] : null;
  const lv = coreId ? (S.coreUpgrades[coreId] ?? 0) : 0;
  const g = assembleGolem(S);

  UI.listPanel('영혼석', core ? [
    UI.rowHTML('지금 핵', UI.esc(core.name), `${lv}/${CORE_MANA_MAX_LV}단계`),
    UI.rowHTML('마력', `${g.manaUsed} / ${g.manaMax}`, g.manaOver ? '넘침' : '여유', g.manaOver),
    UI.rowHTML('기본', String(core.mana), `강화 +${lv * CORE_MANA_STEP}`),
  ] : [], `<p class="note">부속은 등급마다 마력을 먹는다 — 일반 2 · 희귀 3 · 유니크 5.<br>
      강화는 <b>이 핵에만</b> 남는다. 다른 핵으로 갈아끼우면 그 핵의 단계를 따른다.</p>`);

  UI.logHead('영혼석 강화');
  UI.logLine('대장장이가 핵을 받아 들고 불에 가까이 댄다. 안쪽에서 무언가 천천히 돈다.', 'narrate');
  if (!core) { UI.logLine('강화할 핵이 없다. 골렘에 핵부터 끼워야 한다.', 'bad'); }
  else if (lv >= CORE_MANA_MAX_LV) UI.logLine('이 핵은 더 받아들이지 못한다. 더 좋은 핵을 구해야 한다.', 'dim');
  else {
    const c = CORE_UP_COST(lv);
    UI.logLine(`한 단계에 마력 +${CORE_MANA_STEP}. 지금 ${g.manaMax} → ${g.manaMax + CORE_MANA_STEP}.`, '');
    UI.logLine(`값: 은화 ${c.silver} · 시체 조각 ${c.scrap} · 골분 ${c.boneMeal}`, 'dim');
  }

  const can = core && lv < CORE_MANA_MAX_LV;
  const c = CORE_UP_COST(lv);
  const lack = can ? shortText(c) : null;
  UI.choices([
    { label: `마력 +${CORE_MANA_STEP} (${lv} → ${lv + 1}단계)`, cls: 'primary',
      meta: !can ? (core ? '더는 못 올린다' : '핵이 없다')
        : lack ?? `은화 ${c.silver} · 조각 ${c.scrap} · 골분 ${c.boneMeal}`,
      disabled: !can || Boolean(lack),
      on: () => {
        S.silver -= c.silver; S.scrap -= c.scrap; S.boneMeal -= c.boneMeal;
        S.coreUpgrades[coreId] = lv + 1;
        UI.logLine(`${core.name}이(가) 더 많은 것을 품는다. 마력 ${coreMana(S)}.`, 'good');
        save();
        coreManaScreen();
      } },
    { label: '돌아간다', cls: 'ghost', pin: true, on: forgeScreen },
  ]);
  save();
}

/* ── 부속 한 장 들여다보기 ─────────────────────────────
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
    UI.rowHTML('자리', KIND_LABEL[def.slot],
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
  if (part.upgrade) rows.push(UI.rowHTML('강화', `+${part.upgrade}`, `능력치 +${part.upgrade * 8}%`));
  if (part.refined) rows.push(UI.rowHTML('정제', `+${part.refined}`, `능력치 +${part.refined * 10}%`));

  UI.listPanel(partName(part), rows,
    part.raw
      ? `<p class="note"><b>날것이다.</b> 능력치는 위 숫자대로 60%만 나오고,
         기술은 넷 중 하나꼴로 불발되며 내구도가 두 배로 닳는다.<br>
         납골당 → 접합로 → <b>정착</b>을 거쳐야 온전해진다.</p>`
      : '<p class="note">정착된 부속이다. 제 성능이 그대로 나온다.</p>');

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

  UI.logHead('지금 할 일');
  if (!next) {
    UI.logLine(S.campaign.ending
      ? '"자네가 무얼 골랐는지는 묻지 않겠네."'
      : '"미궁 끝까지 갔다면서. 남은 건 자네가 정할 일이야."', 'narrate');
  } else {
    const st = stageOf(next);
    const pt = partOf(next);
    UI.logLine(`"${pt.name}. ${st.name}."`, 'necro');
    UI.logLine(st.desc, 'narrate');
    const hz = CP.hazardOf(next);
    if (hz) UI.logLine(`【${hz.name}】 ${hz.text}`, 'bad');
    UI.logLine(`${st.floors}층 끝에 ${DB.monstersBy[st.boss]?.name ?? '무언가'}이(가) 있다.`, '');
  }

  // 들은 이야기는 언제든 다시 읽을 수 있다 — 한 번 흘려보내면 끝인 것이 가장 나쁘다
  const heard = Object.keys(S.campaign.story).filter((k) => k !== 'opening' && DB.story.beats[k]);
  UI.choices([
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
        '"닳은 건 납골당 접합로에서 수복해. 부패한 것도 되살아나."',
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
  const vatFull = o.rotVat.stored >= O.vatCap(o);
  /* 자율 탐험은 안치소를 세워야 열린다. 그전에는 **줄째로 없었다** —
     플레이어가 보기엔 기능이 사라진 것이지, 아직 못 여는 것이 아니다 (§16.5-C).
     자리는 늘 보여 주고, 왜 못 쓰는지를 적는다. */
  UI.listPanel('재료를 만드는 곳', [
    UI.rowHTML('🫗 부패조', '두면 진액이 고인다', `${o.rotVat.stored}/${O.vatCap(o)}`, vatFull),
    UI.rowHTML('🔪 해체대', '부속을 갈라 재료로', `${o.dissection.slots.length}/${O.dissectionSlots(o)}칸`),
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
    { label: '돌아간다', cls: 'ghost', pin: true, on: ossuaryScreen },
  ]);
  save();
}

/** ⚙ 공방 — 골렘을 세우고, 고치고, 부속을 손보는 곳 (§9.3-③⑤, §9.6~9.8) */
function workshopHubScreen() {
  const o = S.ossuary;
  UI.topbar(S, '납골당 · 공방');
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
    ...(o.built.forge ? [UI.rowHTML('접합로', rawN ? `정착 대기 ${rawN}개` : '날것 없음',
      `${o.forge.slots.length}/${O.forgeSlots(o)}칸`, rawN > 0)] : []),
  ], '<p class="note">골렘을 세우는 일과 부속을 손보는 일이 여기 모여 있다.</p>');

  UI.logHead('공방');
  UI.logLine('받침대와 모루, 끓는 통.', 'narrate');

  UI.choices([
    { label: '📋 골렘 명부', cls: 'primary', meta: `${O.workshopGolems(S).length + 1}기 · 어디에 있는가`,
      info: '내 골렘들이 어디에 있는지 보고, 무덤에 데려갈 몸을 고르고, 이름을 붙인다.',
      on: () => rosterScreen(workshopHubScreen) },
    { label: '⚙ 부속 손보기', meta: g.core ? `방어 ${g.shieldNowTotal}` : '핵 없음',
      info: '지금 탐험 자리에 선 골렘의 핵과 부속을 갈아 끼운다.',
      on: () => golemScreen(workshopHubScreen) },
    { label: '🔧 정비대', meta: oh.length ? O.remainText(oh[0].startedAt, oh[0].durationMs) : '방어도 · 핵',
      cls: oh.length ? '' : '', info: '방어도와 핵 체력을 되돌린다. 망가진 만큼 시간이 걸린다.',
      on: overhaulScreen },
    { label: '🔩 조립대', meta: `여분 핵 ${S.cores.length}개`,
      info: '여분 핵으로 새 골렘을 세운다. 세운 골렘은 데려가거나 일을 시킨다.', on: workshopScreen },
    o.built.forge ? { label: '🕯 접합로', meta: rawN ? `정착 대기 ${rawN}개` : `${o.forge.slots.length}/${O.forgeSlots(o)}칸`,
      cls: rawN ? 'primary' : '',
      info: '날것 부속을 정착시키고, 부속끼리 융합·이식·정제한다.', on: forgeJobScreen } : null,
    o.built.vault ? { label: '🏺 표본실', meta: `${o.vault.parts.length}/${o.vault.capacity}칸`,
      info: '맡긴 부속은 무너져도 사라지지 않는다. 잃은 부속의 기록으로 소생도 한다.',
      on: vaultScreen } : null,
    { label: '🛠 작업반', meta: cs.cut ? `${Math.round(cs.cut * 100)}% 단축` : '배치 없음',
      info: '세워 둔 골렘에게 일을 맡긴다. 해체대·접합로·정비대 시간이 줄어든다.', on: crewScreen },
    { label: '돌아간다', cls: 'ghost', pin: true, on: ossuaryScreen },
  ]);
  save();
}

function ossuaryScreen() {
  const fresh = O.settle(S, Date.now());
  if (fresh.lines.length) notifyQuests({ kind: 'job', count: fresh.lines.length });
  for (const l of fresh.lines) UI.logLine(`${l.facility} — ${l.text}`, l.warn ? 'bad' : 'good');
  UI.topbar(S, '시체골 · 납골당');
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

  UI.choices([
    { label: '돌아간다', cls: 'ghost', on: () => town(false) },
  ]);
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

function vaultScreen() {
  const o = S.ossuary;
  UI.topbar(S, '납골당 · 표본실');
  ossPanel();
  UI.logHead('표본실');
  UI.logLine('선반마다 유리병이 놓여 있다.', 'narrate');
  UI.logLine(`무덤에 들고 내려간 여분은 골렘이 무너질 때 하나당 ${SPARE_LOSS}%씩 흘린다. 여기 둔 것은 흘리지 않는다.`, 'necro');
  UI.logLine(`칸 ${o.vault.parts.length}/${o.vault.capacity} — 제단에서 늘린다.`, 'dim');
  if (o.vault.lostRecords.length) {
    UI.logLine(`잃어버린 기록: ${o.vault.lostRecords.map((id) => DB.partsBy[id]?.name_template.replace('{mod}', '').replace('{owner}', DB.partsBy[id].owner ?? '')).join(', ')}`, 'dim');
  }
  const equipped = new Set(SLOTS.map((x) => S.golem[x]).filter(Boolean));
  const spare = S.inventory.filter((p) => !equipped.has(p.uid));
  UI.choices([
    ...o.vault.parts.map((p) => ({
      label: `${partName(p)} 꺼내기`, meta: `${p.integrity}/${p.maxIntegrity}`, info: UI.partTip(p), on: () => {
        o.vault.parts = o.vault.parts.filter((x) => x.uid !== p.uid);
        S.inventory.push(p);
        UI.logLine(`${partName(p)}을(를) 꺼냈다.`, 'good');
        vaultScreen();
      },
    })),
    ...spare.map((p) => ({
      label: `${partName(p)} 보관`, cls: 'ghost', info: UI.partTip(p),
      disabled: o.vault.parts.length >= o.vault.capacity,
      on: () => {
        S.inventory = S.inventory.filter((x) => x.uid !== p.uid);
        o.vault.parts.push(p);
        vaultScreen();
      },
    })),
    { label: '돌아간다', cls: 'ghost', pin: true, on: workshopHubScreen },
  ]);
  save();
}

/* ── 정비대: 방어도·핵 회복 ─────────────── */
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
        : x.where === 'labor' ? '나가 있다'
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
     맡긴 골렘은 작업이 끝날 때까지 움직이지 못한다.</p>`,
    (key) => { overhaulPick = key.slice(2); overhaulScreen(); }, `g:${v?.id}`);

  UI.logHead('정비대');
  UI.logLine('부서진 것을 원래대로 돌리는 자리.', 'narrate');
  for (const j of o.overhaul) {
    const who = repairView(j.golemId)?.name ?? '골렘';
    UI.logLine(`${who} · ${O.OVERHAUL[j.kind].name} — ${O.remainText(j.startedAt, j.durationMs)}`, 'dim');
  }
  if (v && v.where === 'labor') UI.logLine(`${v.name}은(는) 자율 탐험을 나가 있다. 돌아와야 올릴 수 있다.`, 'dim');

  const costText = (c) => Object.entries(c).map(([k, v2]) => `${O.RES_LABEL[k]} ${v2}`).join(' · ');
  const afford = (c) => Object.entries(c).every(([k, v2]) => (S[k] ?? 0) >= v2);
  const running = (kind) => o.overhaul.some((j) => j.kind === kind && j.golemId === v?.id);

  UI.choices([
    ...Object.entries(O.OVERHAUL).map(([kind, r]) => {
      const missing = gaps[kind === 'shield' ? 'shield' : kind === 'wear' ? 'wear' : 'core'];
      const ms = O.jobDuration(S, O.overhaulMs(kind, missing));
      const away = v?.where === 'labor';
      return {
        label: r.name,
        info: `${r.desc}\n망가진 만큼 시간이 늘어난다. 작업반 골렘을 붙이면 줄어든다.`,
        meta: !v ? '올릴 골렘이 없다'
          : away ? '나가 있다'
          : running(kind) ? '진행 중'
          : !missing ? '온전하다'
          : `${costText(r.cost)} · ${Math.round(ms / 60000)}분`,
        disabled: !v || away || running(kind) || !missing || !afford(r.cost),
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
    { label: '골렘 명부', cls: 'ghost', on: () => rosterScreen(overhaulScreen) },
    { label: '돌아간다', cls: 'ghost', pin: true, on: workshopHubScreen },
  ]);
  save();
}

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
const canWork = (g) => (g?.parts?.length ?? 0) >= WORK_MIN_PARTS;

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
        : !canWork(g.ref) ? '부속이 없다 — 핵만으로는 일을 못 한다'
        : (O.workshopGolems(S).filter((x) => x.assigned === 'crew').length
          >= O.crewCap(o) ? `자리가 없다 (${O.crewCap(o)}기까지)` : `능률 ${g.power}`),
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
      `능률 ${O.golemPower(g)}${g.assigned === 'crew' ? ' · 작업반' : ''}`)),
    `<p class="note"><b>여분 핵 ${S.cores.length}개</b> · 여분 부속 ${sparePool().length}개<br>
      핵 하나에 골렘 하나. 지금 골렘에 끼운 핵은 쓸 수 없다 — 여분이 있어야 세운다.<br>
      세운 골렘은 작업반에 붙여 작업 시간을 줄인다. 배치한 부속은 탐험에 쓸 수 없다.</p>`);

  UI.logHead('조립대');
  UI.logLine('핵을 놓고 부속을 맞춘다.', 'narrate');
  if (!S.cores.length) {
    UI.logLine('여분 핵이 없다. 상점에서 사거나 단계를 끝내면 들어온다.', 'dim');
    UI.logLine('지금 골렘에 박혀 있는 핵은 뽑아 쓸 수 없다.', 'dim');
  }

  UI.choices([
    ...S.cores.map((cid) => {
      const c = DB.coresBy[cid];
      return {
        label: `${c.name}으로 새 골렘`,
        meta: `체력 ${c.hp} · 부속은 직접 고른다`,
        on: () => { const g = newWorkGolem(cid); if (g) workGolemScreen(g.id); },
      };
    }),
    ...golems.map((g) => ({
      label: `${g.name}`,
      meta: `능률 ${O.golemPower(g)} · 부속 ${g.parts.length}개${g.assigned === 'crew' ? ' · 작업반' : ''}`,
      on: () => workGolemScreen(g.id),
    })),
    { label: '골렘 명부', cls: 'ghost', info: '내 골렘들이 어디에 있는지 보고, 데려갈 몸을 고른다.',
      on: () => rosterScreen(workshopScreen) },
    { label: '돌아간다', cls: 'ghost', pin: true, on: workshopHubScreen },
  ]);
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
function workGolemScreen(id, back = workshopScreen) {
  const g = O.workshopGolems(S).find((x) => x.id === id);
  if (!g) { back(); return; }
  g.slots ??= {};
  const core = DB.coresBy[g.core];
  UI.topbar(S, `납골당 · ${g.name}`);

  const partAt = (slot) => g.parts.find((p) => p.uid === g.slots[slot]) ?? null;
  UI.listPanel(g.name, [
    UI.rowHTML('핵', UI.esc(core?.name ?? '?'), `체력 ${core?.hp ?? 0}`),
    ...SLOTS.map((slot) => {
      const p = partAt(slot);
      return UI.rowHTML(SLOT_LABEL[slot],
        p ? UI.partHTML(p) : '<span class="empty">비어 있음</span>',
        p ? `${p.integrity}/${p.maxIntegrity}` : '', !p);
    }),
  ], `<p class="note">능률 <b>${O.golemPower(g)}</b> — 핵 체력의 1/10에 부속 능력치를 더한 값이다.<br>
      작업반에 붙이면 해체대·접합로 작업 시간이 줄어든다 (상한 60%).</p>`);

  UI.logHead(g.name);
  UI.logLine('핵을 올려 새 골렘을 세운다.', 'narrate');
  if (!g.parts.length) UI.logLine('아직 부속이 하나도 없다. 능률은 핵 몫뿐이다.', 'dim');

  UI.choices([
    ...SLOTS.map((slot) => {
      const p = partAt(slot);
      return {
        label: `${SLOT_LABEL[slot]} — ${p ? partName(p) : '비어 있음'}`,
        meta: p ? '바꾸거나 뗀다' : '붙인다',
        on: () => workSlotScreen(g.id, slot, back),
      };
    }),
    // 자리가 여섯이라 쪽이 넘어간다. 이 둘은 어느 쪽에서든 눌려야 한다
    g.assigned === 'crew'
      ? { label: '작업반에서 물린다', cls: 'ghost', pin: true,
          on: () => { g.assigned = null; save(); workGolemScreen(id, back); } }
      : g.assigned === 'labor'
        ? { label: '파견 나가 있다', cls: 'ghost', pin: true, disabled: true,
            meta: '안치소에서 불러들인다' }
        : { label: '작업반에 붙인다', cls: 'primary', pin: true, meta: `능률 ${O.golemPower(g)}`,
            on: () => { g.assigned = 'crew'; save(); workGolemScreen(id, back); } },
    { label: '이 골렘을 해체한다', cls: 'danger', pin: true,
      meta: g.assigned === 'labor' ? '파견 중에는 해체할 수 없다' : `핵과 부속 ${g.parts.length}개 회수`,
      disabled: g.assigned === 'labor',
      on: () => { disassembleWorkGolem(id); workshopScreen(); } },
    { label: '돌아간다', cls: 'ghost', pin: true, on: back },
  ]);
  save();
}

/** 그 자리에 넣을 부속을 고른다 */
function workSlotScreen(id, slot, back = workshopScreen) {
  const g = O.workshopGolems(S).find((x) => x.id === id);
  if (!g) { back(); return; }
  const kind = SLOT_KIND[slot];
  const cur = g.parts.find((p) => p.uid === g.slots[slot]) ?? null;
  const options = sparePool().filter((p) => DB.partsBy[p.defId].slot === kind);

  UI.topbar(S, `${g.name} · ${SLOT_LABEL[slot]}`);
  UI.listPanel(`${SLOT_LABEL[slot]}에 넣을 것`,
    options.map((p) => {
      const st = partStats(p);
      return UI.rowHTML(KIND_LABEL[kind], UI.partHTML(p),
        `능률 ${st.atk + st.def + Math.max(0, st.spd) + st.focus}`);
    }),
    `<p class="note">지금: ${cur ? UI.partHTML(cur) : '비어 있음'}<br>
      여기 넣은 부속은 탐험에 쓸 수 없지만 내구도도 닳지 않는다.</p>`);

  UI.logHead(`${SLOT_LABEL[slot]} 고르기`);
  if (!options.length) UI.logLine('그 자리에 넣을 여분 부속이 없다.', 'dim');

  const detach = () => {
    if (!cur) return;
    g.parts = g.parts.filter((p) => p.uid !== cur.uid);
    delete g.slots[slot];
    S.inventory.push(cur);
  };

  UI.choices([
    ...options.map((p) => {
      const st = partStats(p);
      return {
        label: UI.partHTML(p),
        meta: `공${st.atk} 방${st.def} 속${st.spd} 집${st.focus} · ${p.integrity}/${p.maxIntegrity}`,
        info: UI.partTip(p),
        on: () => {
          detach();
          S.inventory = S.inventory.filter((x) => x.uid !== p.uid);
          g.parts.push(p);
          g.slots[slot] = p.uid;
          UI.logLine(`${partName(p)}을(를) ${g.name}의 ${SLOT_LABEL[slot]}에 붙였다.`, 'good');
          save();
          workGolemScreen(id, back);
        },
      };
    }),
    cur ? { label: '떼어낸다', cls: 'danger',
      on: () => { detach(); UI.logLine(`${partName(cur)}을(를) 되찾았다.`, 'dim'); save(); workGolemScreen(id, back); } } : null,
    { label: '돌아간다', cls: 'ghost', pin: true, on: () => workGolemScreen(id, back) },
  ]);
}

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
    onDuty.map((g) => UI.rowHTML(DB.coresBy[g.core]?.name ?? '?', UI.esc(g.name), `능률 ${O.golemPower(g)}`)),
    `<p class="note">합계 능률 ${cs.power} → 해체대·접합로·정비대 작업 시간 <b>${Math.round(cs.cut * 100)}% 단축</b> (상한 60%).<br>
      자리는 ${onDuty.length}/${O.crewCap(o)}기 — 안치소를 넓히면 더 붙일 수 있다.<br>
      부속만으로는 일을 시킬 수 없다. <b>조립대</b>에서 핵을 넣어 세운 골렘만 붙일 수 있다.</p>`);

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
      meta: !canWork(g) ? '부속이 없다 — 핵만으로는 일을 못 한다'
        : onDuty.length >= O.crewCap(o) ? `자리가 없다 (${O.crewCap(o)}기까지)` : `능률 ${O.golemPower(g)}`,
      disabled: !canWork(g) || onDuty.length >= O.crewCap(o),
      info: !canWork(g) ? '조립대에서 부속을 하나라도 끼워야 일을 맡길 수 있다.' : undefined,
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

/* ── 접합로 ─────────────────────────────── */
function forgeJobScreen() {
  const o = S.ossuary;
  UI.topbar(S, `납골당 · 접합로 ${o.forge.slots.length}/${O.forgeSlots(o)}칸`);
  ossPanel();
  UI.logHead('접합로');
  for (const j of o.forge.slots) {
    UI.logLine(`${O.RECIPES[j.recipe].name} — ${O.remainText(j.startedAt, j.durationMs)}`, 'dim');
  }
  const free = O.forgeSlots(o) - o.forge.slots.length;
  const equippedF = new Set(SLOTS.map((x) => S.golem[x]).filter(Boolean));
  const spareCount = S.inventory.filter((p) => !equippedF.has(p.uid)).length;
  UI.logLine('불이 낮게 깔려 있다.', 'narrate');
  // 장착 중인 날것은 여기서 정착시킬 수 없다 — 세는 것도 따로 센다
  const rawSpare = S.inventory.filter((p) => p.raw && !equippedF.has(p.uid)).length;
  const rawWorn = S.inventory.filter((p) => p.raw && equippedF.has(p.uid)).length;
  if (rawSpare) UI.logLine(`정착하지 않은 날것 부속이 ${rawSpare}개 있다.`, 'bad');
  if (rawWorn) {
    UI.logLine(`골렘에 붙인 날것이 ${rawWorn}개 있다. 떼어내야 정착시킬 수 있다.`, 'bad');
  }
  if (free <= 0) {
    UI.logLine(`접합로가 꽉 찼다 (${o.forge.slots.length}/${O.forgeSlots(o)}칸). 지금 걸린 작업이 끝나야 다음을 건다.`, 'bad');
    UI.logLine('제단에서 접합로를 증설하면 동시에 여러 개를 걸 수 있다.', 'dim');
  } else if (!spareCount) UI.logLine('재료로 쓸 여분 파츠가 없다.', 'dim');

  const rawCount = rawSpare;
  const damagedCount = S.inventory.filter((p) => p.integrity < p.maxIntegrity && !equippedF.has(p.uid)).length;
  const costText = (r) => Object.entries(r.cost)
    .map(([k, v]) => `${O.RES_LABEL[k]} ${v}`).join(' · ');

  UI.choices([
    ...Object.entries(O.RECIPES).map(([key, r]) => {
      // 못 누르는 이유를 버튼에 적는다. 그냥 흐려지기만 하면 고장으로 읽힌다
      const noStock = key === 'revive' ? !o.vault.lostRecords.length
        : key === 'attune' ? rawCount < 1
        : key === 'mend' ? damagedCount < 1
        : spareCount < (key === 'fuse' ? 2 : 1);
      const why = free <= 0 ? `접합로가 꽉 참 (${o.forge.slots.length}/${O.forgeSlots(o)}칸)`
        : noStock ? (key === 'revive' ? '잃어버린 기록이 없다'
          : key === 'attune' ? (rawWorn ? '골렘에 붙인 날것뿐 — 먼저 떼어내라' : '정착할 날것이 없다')
          : key === 'mend' ? '상한 부속이 없다'
          : key === 'fuse' ? '여분이 둘 이상 필요하다' : '여분 부속이 없다')
        : shortText(r.cost);
      return {
        label: `${r.name}`,
        meta: why ?? `${Math.round(r.ms / 60000)}분 · ${costText(r)}`,
        disabled: Boolean(why),
        on: () => recipeScreen(key),
      };
    }),
    { label: '돌아간다', cls: 'ghost', pin: true, on: workshopHubScreen },
  ]);
  save();
}

function recipeScreen(key, first = null) {
  const o = S.ossuary;
  const r = O.RECIPES[key];
  UI.topbar(S, `접합로 · ${r.name}`);
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
          title: `접합로 · ${r.name}`,
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
      주워 온 부속은 <b>표본실</b>로 들어가고, 날것이라 정착을 거쳐야 한다.<br>
      나가 있는 동안 그 골렘은 쓸 수 없다. 돌아올 때 부속 하나가 닳을 수 있다.</p>`);

  UI.logHead('자율 탐험');
  UI.logLine('지나온 길을 다시 훑게 한다.', 'narrate');
  for (const d of o.laborBay.dispatch) {
    UI.logLine(`${d.stageName} — ${byId(d.golemId)?.name ?? '?'} · ${O.remainText(d.startedAt, d.durationMs)}`, 'dim');
  }
  const free = O.laborSlots(o) - o.laborBay.dispatch.length;
  const idle = golems.filter((g) => !g.assigned && canWork(g));
  if (free <= 0) {
    UI.logLine(`안치소가 ${O.laborSlots(o)}칸뿐이다. 제단에서 안치소를 넓히면 더 보낼 수 있다.`, 'dim');
  }
  if (!golems.length) UI.logLine('조립대에 선 골렘이 없다. 여분 핵으로 한 기를 세워야 보낸다.', 'dim');
  else if (!idle.length) {
    const empty = golems.filter((g) => !g.assigned && !canWork(g)).length;
    UI.logLine(empty
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
          : `수확 +${bonus}% · 부속 ${g.parts.length}개`,
        disabled: free <= 0,
        info: `<span class="tt">${UI.esc(g.name)}</span>`
          + `<span class="tm">공${st.atk} 방${st.def} 속${st.spd} 집${st.focus} · 수확 +${bonus}%</span>`
          + `<div class="trow">${g.parts.map((x) => `<span>${UI.esc(partName(x))} ${x.integrity}/${x.maxIntegrity}</span>`).join('')}</div>`,
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
function tripPickStage(golemId) {
  const g = O.workshopGolems(S).find((x) => x.id === golemId);
  if (!g) { laborScreen(); return; }
  UI.topbar(S, `자율 탐험 · ${g.name}`);
  const stages = tripStages();
  UI.listPanel('갈 수 있는 곳',
    stages.map((st) => UI.rowHTML(`${st.idx + 1}단계`, UI.esc(st.name),
      Object.entries(O.tripRate(st.idx)).filter(([, v]) => v)
        .map(([k, v]) => `${O.RES_LABEL[k]} ${v}/시간`).join(' · '))),
    '<p class="note">깊이 들어간 곳일수록 많이 주워 온다. 깬 단계만 보낼 수 있다.</p>');
  UI.logHead('어디로, 얼마나');
  UI.logLine('오래 두면 많이 가져오지만 그만큼 몸이 닳는다.', 'dim');

  const list = [];
  for (const st of stages) {
    for (const t of O.TRIPS) {
      const rate = O.tripRate(st.idx);
      const sg = O.golemStats(g);
      const bonus = 1 + Math.min(0.8, (sg.atk + sg.def + sg.spd + sg.focus) / 120);
      const yield_ = Object.entries(rate).filter(([, v]) => v)
        .map(([k, v]) => `${O.RES_LABEL[k]} ${Math.floor(v * bonus * t.hours)}`).join(' · ');
      list.push({
        label: `${st.name} — ${t.name}`,
        meta: `${t.label} · ${yield_}`,
        info: `<span class="tt">${UI.esc(st.name)} · ${t.label}</span>`
          + `<div class="trow"><span>예상 수확 ${yield_}</span></div>`
          + `<div class="trow"><span>부속 주울 확률 <b>${O.tripPartLuck(st.idx, t.hours)}%</b></span></div>`
          + `<div class="trow"><span>내구도 닳을 확률 <b>${t.wearChance}%</b> — 한 칸</span></div>`,
        on: () => {
          g.assigned = 'labor';
          S.ossuary.laborBay.dispatch.push({
            golemId: g.id, trip: t.id, stageId: st.id, stageIndex: st.idx, stageName: st.name,
            startedAt: Date.now(), durationMs: t.hours * 3600_000,
          });
          UI.logLine(`${g.name}을(를) ${st.name}으로 보냈다. ${t.label} 뒤에 돌아온다.`, 'good');
          save();
          laborScreen();
        },
      });
    }
  }
  list.push({ label: '돌아간다', cls: 'ghost', pin: true, on: laborScreen });
  UI.choices(list);
}

/* ── 제단 (영구 해금) ───────────────────── */
function altarScreen() {
  const o = S.ossuary;
  UI.topbar(S, '납골당 · 제단');
  ossPanel();
  UI.logHead('제단');
  UI.logLine('영혼재를 태우는 자리.', 'narrate');

  // 모자랄 때는 곁말 자리를 부족분에 내준다 — 못 누르는 이유가 먼저 읽혀야 한다
  const buy = (label, cost, meta, fn, disabled = false) => ({
    label,
    meta: (S.soulAsh < cost ? `영혼재 ${cost - S.soulAsh} 모자라다` : null) ?? meta ?? `영혼재 ${cost}`,
    disabled: disabled || S.soulAsh < cost,
    on: () => { S.soulAsh -= cost; fn(); altarScreen(); },
  });

  const list = [];
  for (const [key, f] of Object.entries(O.FACILITIES)) {
    if (o.built[key]) continue;
    list.push(buy(`${f.icon} ${f.name} 건설`, f.unlock, `영혼재 ${f.unlock}`, () => {
      o.built[key] = true;
      UI.logLine(`${f.name}을(를) 세웠다.`, 'good');
    }));
  }
  const vatCost = 60 + o.rotVat.level * 40;
  list.push(buy(`부패조 확장 Lv${o.rotVat.level} → ${o.rotVat.level + 1}`, vatCost, `영혼재 ${vatCost}`, () => {
    o.rotVat.level++;
    UI.logLine(`부패조가 커졌다. 상한 ${O.vatCap(o)}.`, 'good');
  }));
  if (o.built.dissection && o.dissection.level < 4) {
    const c = 50 * o.dissection.level;
    list.push(buy(`해체대 증설 (${o.dissection.level} → ${o.dissection.level + 1}칸)`, c, `영혼재 ${c}`,
      () => { o.dissection.level++; }));
  }
  if (o.built.forge && o.forge.level < 4) {
    const c = 90 * o.forge.level;
    list.push(buy(`접합로 증설 (${o.forge.level} → ${o.forge.level + 1}칸)`, c, `영혼재 ${c}`,
      () => { o.forge.level++; }));
  }
  if (o.built.laborBay && o.laborBay.level < 3) {
    const c = 120 * o.laborBay.level;
    list.push(buy(`안치소 증설 (${o.laborBay.level} → ${o.laborBay.level + 1})`, c,
      `자율 탐험 ${o.laborBay.level + 1}칸 · 작업반 ${o.laborBay.level + 2}기`,
      () => {
        o.laborBay.level++;
        UI.logLine(`안치소가 넓어졌다. 자율 탐험 ${O.laborSlots(o)}칸 · 작업반 ${O.crewCap(o)}기.`, 'good');
      }));
  }
  if (o.built.vault && o.vault.capacity < 10) {
    list.push(buy(`표본실 확장 (${o.vault.capacity} → ${o.vault.capacity + 1}칸)`, 40, '영혼재 40',
      () => { o.vault.capacity++; }));
  }
  if (o.capStep < O.CAP_STEPS.length - 1) {
    list.push(buy(`오프라인 상한 확장 (${Math.round(o.offlineCapMs / O.HOUR)} → ${Math.round(O.CAP_STEPS[o.capStep + 1] / O.HOUR)}시간)`,
      O.CAP_COST, `영혼재 ${O.CAP_COST}`, () => {
        o.capStep++;
        o.offlineCapMs = O.CAP_STEPS[o.capStep];
      }));
  }
  // (구) '표본 지참 수'는 자동 반출과 함께 없앴다. 표본실은 이제 순수한 창고이고,
  // 값어치는 칸 수에서 나온다 — 바로 위의 '표본실 확장'이 그 창구다.
  if (S.unlocks.salvage < 3) {
    const c = 100 + 80 * S.unlocks.salvage;
    list.push(buy(`잔해 수습 (회수율 +${(S.unlocks.salvage + 1) * 10}%p)`, c, `영혼재 ${c}`,
      () => { S.unlocks.salvage++; UI.logLine('무너진 골렘에서 더 건질 수 있게 됐다.', 'good'); }));
  }
  if (S.unlocks.partPool < 2) {
    const c = 140 + 120 * S.unlocks.partPool;
    list.push(buy(`수소문 (상점 부속 등급 ↑)`, c, `영혼재 ${c}`,
      () => { S.unlocks.partPool++; S.town.stock = rollStock(rng, S.unlocks);
              UI.logLine('바르그가 아는 사람을 통해 더 나은 것이 들어온다.', 'good'); }));
  }
  if (!S.unlocks.modTier) {
    list.push(buy('이상 감식 (tier 2 이상 조기 등장)', 260, '영혼재 260',
      () => { S.unlocks.modTier = 1; UI.logLine('이상한 것을 알아보는 눈이 생겼다.', 'good'); }));
  }
  if (S.unlocks.necroSlots < 5) {
    const c = 150 * (S.unlocks.necroSlots - 2);
    list.push(buy(`술법 장착 칸 (${S.unlocks.necroSlots} → ${S.unlocks.necroSlots + 1})`, c, `영혼재 ${c}`,
      () => { S.unlocks.necroSlots++; S.necro.equipped.push(null); }));
  }
  list.push({ label: '돌아간다', cls: 'ghost', pin: true, on: ossuaryScreen });
  UI.choices(list);
  save();
}

/* ── 의뢰소 ─────────────────────────────── */
/* ── 마을 대분류 (§12.8) ─────────────────────────────
   타일이 아홉이면 고를 것이 아니라 읽을 것이 된다. 하는 일이 같은 것끼리 묶고,
   묶음 안에서 다시 고르게 한다. 대분류 타일은 안에 무엇이 있는지를 한 줄로 요약한다. */

/** 📜 의뢰소 — 세 건짜리 의뢰와 하루짜리 일을 한 게시판에 (§10.2) */
function boardScreen() {
  UI.topbar(S, '시체골 · 의뢰소');
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
  ]);
  save();
}

/** 🏪 저잣거리 — 손수레·뼈 모루·조합을 한 골목으로 (§10.3~10.5) */
function marketScreen() {
  const bs = buildingStatus(S);
  UI.topbar(S, '시체골 · 저잣거리');
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
  ]);
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
    list.push({ label: `${partName(p)} 구입`, cls: 'primary', meta: money(price),
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
      label: `${partName(p)} 판매`, meta: money(sellPrice(p)), info: UI.partTip(p), on: () => {
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
      `${a.price} · ${Object.entries(a.materials ?? {}).map(([k, v]) =>
        `${{ scrap: '조각', ichor: '진액', boneMeal: '골분' }[k]}${v}`).join(' ')}`)),
    `<p class="note">부착물은 파츠 슬롯을 쓰지 않는다. 골렘당 ${ATTACH_SLOTS}칸.</p>`);

  UI.logHead('뼈 모루');
  UI.logLine('대장장이는 뼈를 다루는 데 익숙하다. 묻지 않고 두드린다.', 'narrate');

  const list = [];
  for (const a of DB.attachments) {
    if (a.effect.op === 'retune') continue;
    if (!S.owned.attachments.includes(a.id)) {
      const lack = shortText({ silver: a.price, ...(a.materials ?? {}) });
      list.push({ label: `${a.name} 제작`, meta: lack ?? money(a.price), disabled: Boolean(lack), on: () => {
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
  const jobs = S.town.smithy ?? [];
  for (const j of jobs) {
    list.push({ label: `${partName(j.part)} 강화 중`, meta: O.remainText(j.startedAt, j.durationMs),
      disabled: true, nokey: true });
  }
  list.push({ label: '파츠 강화', meta: `${jobs.length}/2칸`, disabled: jobs.length >= 2, on: upgradeScreen });
  list.push({ label: '🔆 영혼석 강화 — 마력 늘리기', cls: 'primary',
    meta: `마력 ${coreMana(S)}`, on: coreManaScreen });
  list.push({ label: '속성 도가니 · 스킬 속성 변경', meta: money(cru.price),
    disabled: !canCraft(S, cru), on: retuneScreen });
  list.push({ label: '돌아간다', cls: 'ghost', pin: true, on: marketScreen });
  UI.choices(list);
  save();
}

/** 대장간 파츠 강화 — 재료와 은화를 들이고 시간을 기다린다 */
function upgradeScreen() {
  UI.topbar(S, '시체골 · 파츠 강화');
  const equipped = new Set(SLOTS.map((x) => S.golem[x]).filter(Boolean));
  const pool = S.inventory.filter((p) => !equipped.has(p.uid) && (p.upgrade ?? 0) < O.UPGRADE_MAX);
  const costText = (lv) => {
    const c = O.upgradeCost(lv);
    return `은화 ${c.silver} · 조각 ${c.scrap} · 골분 ${c.boneMeal}`;
  };
  const afford = (lv) => {
    const c = O.upgradeCost(lv);
    return S.silver >= c.silver && S.scrap >= c.scrap && S.boneMeal >= c.boneMeal;
  };
  UI.listPanel('강화할 수 있는 부속',
    pool.map((p) => UI.rowHTML(KIND_LABEL[DB.partsBy[p.defId].slot], UI.partHTML(p),
      `+${p.upgrade ?? 0} → +${(p.upgrade ?? 0) + 1}`)),
    `<p class="note">강화 한 단계마다 모든 능력치 +8%, 최대 +${O.UPGRADE_MAX}.<br>
     맡기면 시간이 걸리고, 그동안 그 부속은 쓸 수 없다.</p>`);
  UI.logHead('파츠 강화');
  UI.logLine('대장장이가 부속을 받아 들고 무게를 가늠한다.', 'narrate');
  if (!pool.length) UI.logLine('강화할 여분 부속이 없다. 장착 중인 것은 먼저 떼어내야 한다.', 'dim');

  UI.choices([
    ...pool.map((p) => {
      const lv = p.upgrade ?? 0;
      return {
        label: `${partName(p)} 강화`,
        meta: `${costText(lv)} · ${Math.round(O.upgradeMs(lv) / 60000)}분`,
        disabled: !afford(lv),
        on: () => {
          const c = O.upgradeCost(lv);
          S.silver -= c.silver; S.scrap -= c.scrap; S.boneMeal -= c.boneMeal;
          S.inventory = S.inventory.filter((x) => x.uid !== p.uid);
          S.town.smithy.push({ part: p, startedAt: Date.now(),
                               durationMs: O.jobDuration(S, O.upgradeMs(lv)) });
          UI.logLine(`${partName(p)}을(를) 모루에 올렸다. 완성되면 납골당 정산에 함께 나온다.`, 'good');
          forgeScreen();
        },
      };
    }),
    { label: '돌아간다', cls: 'ghost', pin: true, on: forgeScreen },
  ]);
  save();
}

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
  if (g.over) UI.logLine(`스킬이 ${g.active.length}개다. ${SKILL_CAP}개를 넘으면 일부를 봉인해야 한다.`, 'bad');
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
    canEdit && g.skills.length > SKILL_CAP ? { label: '스킬 봉인 관리', on: () => banScreen(back, canEdit) } : null,
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
  UI.golemPanel(S, (next) => slotScreen(next, back, canEdit));
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
        unhover: () => UI.golemPanel(S, (next) => slotScreen(next, back, canEdit)),
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

function banScreen(back, canEdit = true) {
  const g = assembleGolem(S);
  UI.topbar(S, '골렘 · 스킬 봉인');
  UI.golemPanel(S);
  UI.logLine(`사용 가능한 스킬은 ${SKILL_CAP}개까지다. 봉인한 스킬도 스탯은 그대로 유지된다.`, 'dim');
  UI.choices([
    ...g.skills.map((sid) => {
      const banned = (S.golem.banned ?? []).includes(sid);
      return {
        label: `${DB.skillsBy[sid].name} ${banned ? '봉인 해제' : '봉인'}`,
        meta: skillElement(S, sid),
        on: () => {
          S.golem.banned ??= [];
          S.golem.banned = banned
            ? S.golem.banned.filter((x) => x !== sid)
            : [...S.golem.banned, sid];
          banScreen(back, canEdit);
        },
      };
    }),
    { label: '돌아간다', cls: 'ghost', pin: true, on: () => golemScreen(back, canEdit) },
  ]);
}

function inventoryScreen(back = town) {
  UI.topbar(S, '소지품');
  const equipped = new Set(SLOTS.map((x) => S.golem[x]).filter(Boolean));
  const mats = [
    ['시체 조각', S.scrap], ['부패 진액', S.ichor], ['골분', S.boneMeal],
    ['은화', S.silver], ['영혼재', S.soulAsh],
  ].filter(([, n]) => n > 0).map(([k, n]) => UI.rowHTML('재료', UI.esc(k), String(n)));
  const items = Object.entries(S.consumables).filter(([, n]) => n > 0)
    .map(([id, n]) => UI.rowHTML(DB.itemsBy[id].kind, UI.esc(DB.itemsBy[id].name), `${n}개`));
  // 어느 자리에 끼워져 있는지까지 적는다. '장착'만으로는 어느 팔인지 알 수 없다
  const slotOf = new Map(SLOTS.filter((x) => S.golem[x]).map((x) => [S.golem[x], x]));
  const parts = S.inventory.map((p) => UI.rowHTML(
    slotOf.has(p.uid) ? SLOT_LABEL[slotOf.get(p.uid)] : KIND_LABEL[DB.partsBy[p.defId].slot],
    `${slotOf.has(p.uid) ? '<span class="chip good">장착</span> ' : ''}${p.raw ? '<span class="chip warn">날것</span> ' : ''}${UI.partHTML(p)}`,
    `${p.integrity}/${p.maxIntegrity}`, wornLow(p)));
  const rows = [...mats, ...items, ...parts];
  const away = [
    ['표본실', (S.ossuary?.vault?.parts ?? []).length],
    ['조립대', O.workshopGolems(S).reduce((n, g) => n + g.parts.length, 0)],
    ['파견', (S.ossuary?.laborBay?.dispatch ?? []).reduce((n, d) => {
      const g = O.workshopGolems(S).find((x) => x.id === d.golemId);
      return n + (g ? g.parts.length : (d.parts ?? []).length);
    }, 0)],
    ['접합로', (S.ossuary?.forge?.slots ?? []).reduce((n, j) => n + (j.inputs?.length ?? 0), 0)],
    ['대장간', (S.town?.smithy ?? []).length],
    ['해체대', (S.ossuary?.dissection?.slots ?? []).length],
  ].filter(([, n]) => n > 0);
  UI.listPanel(`가진 것 — 파츠 ${S.inventory.length}개`, rows,
    away.length
      ? `<p class="note">맡겨 둔 것: ${away.map(([k, n]) => `${k} ${n}`).join(' · ')}<br>
         여기 없는 부속은 사라진 게 아니라 그쪽에 가 있다.</p>`
      : '');
  UI.logLine(`재료: 조각 ${S.scrap} · 진액 ${S.ichor} · 골분 ${S.boneMeal} / 은화 ${S.silver} · 영혼재 ${S.soulAsh}`, 'dim');
  UI.logLine(`장착 ${slotOf.size}개 · 여분 ${S.inventory.length - slotOf.size}개. 여분은 무덤에서 무너지면 일부를 흘린다.`, 'dim');
  UI.choices([
    { label: '재화가 뭔지 보기', cls: 'ghost', pin: true, on: () => resourceGuideScreen(() => inventoryScreen(back)) },
    // 부속을 눌러 무엇을 할 수 있는 물건인지 본다 — 이름만으로는 알 수가 없다
    // 장착 중인 것을 위로 모으고, 어느 자리인지를 이름 앞에 박아 둔다
    ...[...S.inventory]
      .sort((a, b) => Number(slotOf.has(b.uid)) - Number(slotOf.has(a.uid)))
      .map((p) => {
        const at = slotOf.get(p.uid);
        return {
          label: `${at ? `<span class="chip good">${SLOT_LABEL[at]}</span> ` : ''}${UI.partHTML(p)}`,
          meta: `${at ? '장착 중' : '여분'} · ${UI.RARITY_LABEL[UI.rarityOf(p)]}`
            + ` · 마력 ${partMana(p)}${p.raw ? ' · 날것' : ''} · ${p.integrity}/${p.maxIntegrity}`,
          on: () => partDetailScreen(p, () => inventoryScreen(back)),
        };
      }),
    // 회복량은 데이터가 정한다. 여기에 숫자를 박아 두면 items.json을 고쳐도 안 따라온다
    ...S.inventory.filter((p) => p.integrity < p.maxIntegrity && S.consumables.it_bitumen > 0)
      .map((p) => ({
        label: `${partName(p)}에 역청`,
        meta: `+${BITUMEN()} (${S.consumables.it_bitumen}개 남음)`, on: () => {
          S.consumables.it_bitumen--;
          p.integrity = Math.min(p.maxIntegrity, p.integrity + BITUMEN());
          UI.logLine(`${partName(p)}의 내구도를 메웠다. (${p.integrity}/${p.maxIntegrity})`, 'good');
          inventoryScreen(back);
        },
      })),
    { label: '돌아간다', cls: 'ghost', pin: true, on: () => back(false) },
  ]);
}

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
  if (gm.manaOver) {
    UI.logLine(`핵이 감당하지 못한다. 마력 ${gm.manaUsed}/${gm.manaMax}.`, 'bad');
    UI.logLine('부속을 덜어내거나, 대장간에서 핵을 강화하거나, 더 좋은 핵을 구해야 한다.', 'dim');
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
      label: `${r.kind === 'wear' ? '🩹' : '🛡'} ${SLOT_LABEL[r.slot]} — ${partName(r.part)}`,
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
      label: `방부 처리 — ${partName(part)}`, meta: `${part.integrity}/${part.maxIntegrity} → 완전`,
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
        label: `${partName(p)}을(를) 바친다`, on: () => {
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
    UI.logLine('🕯 술법은 골렘의 턴을 빼앗지 않는다. 걸어 두면 골렘의 공격과 같은 턴에 함께 나간다.', 'necro');
    UI.logLine('자세한 건 마을의 뼈 수습꾼에게 물어보면 된다.', 'dim');
  }
  combatTurn();
}

function combatTurn() {
  UI.setCombatMode(true);
  UI.topbar(S, `전투 · ${cb.mon.name}`);
  UI.combatPanel(cb, S);

  const list = [];
  const aimConf = AIM[cb.aim];
  list.push({
    label: `🎯 조준 — <b>${aimConf.name}</b>`,
    meta: cb.aim === 'random' ? '부속 보존' : `명중 ${aimConf.acc} · 부위 x${aimConf.mul}`,
    cls: cb.aim === 'random' ? 'ghost' : 'primary',
    nokey: true,
    on: () => { cb.cycleAim(); combatTurn(); },
  });

  // 술법은 골렘의 공격에 얹어 나간다 (§9-A). 여기서 걸어 두고 기술을 고르면 함께 터진다
  const spells = cb.necroSkills();
  if (spells.length) {
    const prep = cb.prepValid();
    const ready = spells.filter((n) => n.usable).length;
    list.push({
      label: `🕯 술법 — <b>${prep ? UI.esc(prep.name) : '없음'}</b>`,
      meta: prep ? `영력 ${prep.will} · 공격과 함께`
        : ready ? `${ready}개 준비됨 — 눌러 고른다`
        : spells.every((n) => n.cd > 0) ? '재사용 대기 중' : '영력이 모자라다',
      cls: prep ? 'primary' : 'ghost',
      // 무엇이 걸렸는지 눌러 보지 않고도 알아야 한다 — 소환수는 얼마나 대신 맞는지까지
      info: prep
        ? `<span class="tt">${UI.esc(prep.name)}</span>`
          + `<span class="tm">영력 ${prep.will}${prep.cooldown ? ` · 재사용 ${prep.cooldown}턴` : ''}</span>`
          + `<div class="trow"><span>${UI.esc(DB.necro_skillsBy[prep.id]?.desc ?? '')}</span></div>`
        : `<span class="tt">네크로맨서 술법</span>`
          + `<span class="tm">골렘의 공격과 함께 나간다</span>`
          + spells.map((n) => `<div class="trow"><span>${UI.esc(n.name)}</span>`
            + `<span>${n.usable ? `영력 ${n.will}` : n.cd > 0 ? `${n.cd}턴 대기` : '영력 부족'}</span></div>`).join(''),
      disabled: !ready,
      nokey: true,
      on: () => { cb.cyclePrep(); combatTurn(); },
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
  /* 물약과 관찰은 **한 칸 뒤로 물린다.**
     기술과 나란히 늘어놓으면 커맨드가 열 몇 개가 되어 쪽이 나뉘고,
     전투 중에 쪽을 넘겨 가며 기술을 찾게 된다. 매 턴 고르는 것은 기술이다. */
  const items = cb.combatItems();
  // 관찰은 '처음 보는 적'에만 쓰던 것이었으나, 이제 **다음 수를 읽는** 수단이라
  // 아는 적에게도 쓸 이유가 있다. 이미 살핀 적에게만 가린다 (§5.9)
  const canObserve = !cb.watched;
  if (items.length || canObserve) {
    list.push({
      label: '🎒 지닌 것', cls: 'ghost',
      meta: items.length ? `${items.reduce((n, i) => n + i.count, 0)}개${canObserve ? ' · 관찰' : ''}` : '관찰',
      on: () => itemTurnScreen(items, canObserve),
    });
  }
  // 전투에서는 쪽을 나누지 않는다 — 쓸 수 있는 기술이 한눈에 다 보여야 한다
  UI.choices(list, { paged: false });
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
  const before = cb.summonCount;
  cb.act(action);
  // 로그를 한꺼번에 쏟지 않고 국면별로 끊어 보여준다 (§5.8)
  UI.logWaiting();
  await UI.logPlay(cb.log);
  if (cb.summonCount > before) {
    S.run.summons += cb.summonCount - before;
    notifyQuests({ kind: 'summon', count: cb.summonCount - before });
  }
  S.run.golemHp = cb.golem.hp;
  S.golem.coreHp = cb.golem.hp;      // 핵 체력은 런을 넘어 남는다
  cb.commitShields();                 // 방어도도 파츠에 새겨진다
  if (!cb.over) { combatTurn(); return; }
  if (cb.result === 'win') winBattle();
  else loseRun();
}

function winBattle() {
  const room = cb.room;
  room.cleared = true;
  S.run.kills++;
  S.log.kills++;
  notifyQuests({ kind: 'kill', monster: cb.mon.defId });
  if (!cb.usedNecro) notifyQuests({ kind: 'cleanwin' });

  // 내구도 소모 (§3.3) — 이 전투에서 실제로 쓴 파츠만
  const g = assembleGolem(S);
  S.run.battles = (S.run.battles ?? 0) + 1;
  const skipWear = g.traits.wearHalf && S.run.battles % 2 === 1;
  if (!skipWear) {
    for (const uid of cb.usedParts) {
      const p = findPart(uid);
      if (!p) continue;
      // 범람: 무릎까지 물이 차면 다리가 젖어 두 배로 상한다 (§7-A.2)
      const flooded = CP.hazardOf(S.run.stage)?.kind === 'flood' && hazardNow() >= 2
        && DB.partsBy[p.defId].slot === 'leg';
      p.integrity -= (p.raw ? RAW_WEAR : 1) * (flooded ? 2 : 1);
      if (p.integrity <= 0) destroyPart(p);
      else if (wornLow(p)) UI.logLine(`⚠ ${partName(p)}의 내구도가 ${p.integrity}밖에 남지 않았다.`, 'bad');
    }
  } else UI.logLine('철제 이음쇠가 마모를 받아냈다.', 'dim');

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
      label: `${partName(p)} 수습`,
      meta: `${KIND_LABEL[DB.partsBy[p.defId].slot]} · 날것 · 내구 ${p.integrity}`,
      info: UI.partTip(p),
      on: () => {
        S.inventory.push(p);
        UI.logLine(`${partName(p)}을(를) 챙겼다.`, 'good');
        if (!S.log.hintRaw) {
          S.log.hintRaw = true;
          UI.logLine('— 날것 부속 —', 'necro');
          UI.logLine('막 뜯어온 것은 골렘에 맞지 않는다. 그대로 끼우면 스탯 60%, 기술 25% 불발, 내구도 2배 소모다.', 'necro');
          UI.logLine('납골당 → 접합로 → 정착 (조각 8 + 진액 1, 20분)을 거치면 온전해진다.', 'necro');
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
    UI.choices([
      { label: '더 내려간다', cls: 'primary', on: nextFloor },
      { label: '여기서 돌아간다', cls: 'ghost', on: () => abandonRun(true) },
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
      UI.logLine('— 표본실 —', 'necro');
      UI.logLine(`무덤에 들고 내려간 여분은 무너질 때 하나당 ${r.rate}%씩 흘린다.`, 'necro');
      UI.logLine('납골당 표본실에 맡긴 것은 무너져도 그대로 남는다.', 'good');
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
  if (S.run) {
    UI.logLine('무덤 한가운데서 정신이 든다. 탐험이 아직 끝나지 않았다.', 'dim');
    enterRoom(roomAt(S.run.floorData, S.run.floorData.pos), true);
  } else settleAndReport(() => town());
}

window.addEventListener('error', (e) => UI.logLine(`오류: ${e.message}`, 'bad'));
boot();
