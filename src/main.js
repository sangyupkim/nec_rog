/** 게임 진행 · 화면 전환 · 세이브 */
import {
  DB, loadData, makeRng, makePart, partName, partStats, partSkills,
  assembleGolem, SLOTS, SLOT_LABEL, SLOT_KIND, SKILL_CAP,
  rollMonster, rollElite, rollBoss, rollLoot, syncUidSeq, skillElement, AIM, RAW_WEAR,
  stageOf, partOf, shieldNow, shieldMax, partMana, coreMana, CORE_MANA_STEP, CORE_MANA_MAX_LV,
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
           hintAim: false, hintRaw: false, hintSwap: false, hintOssuary: false, hintVault: false },
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
function resyncUids(s) {
  let max = 0;
  // 파츠가 머무는 자리를 **하나도 빼놓지 않고** 훑어야 한다.
  // 해체대·접합로·대장간을 빠뜨렸더니, 거기 올려 둔 파츠의 번호를 새 파츠가
  // 다시 쓰는 일이 생겼다 — 같은 uid가 둘이면 장착 표시가 엉뚱한 것에 붙는다.
  const all = [
    ...(s.inventory ?? []),
    ...(s.ossuary?.vault?.parts ?? []),
    ...(s.ossuary?.crew?.parts ?? []),
    ...(s.ossuary?.workshop?.golems ?? []).flatMap((g) => g.parts ?? []),
    ...(s.ossuary?.laborBay?.dispatch ?? []).flatMap((d) => d.parts ?? []),
    ...(s.ossuary?.dissection?.slots ?? []).flatMap((j) => j.parts ?? (j.part ? [j.part] : [])),
    ...(s.ossuary?.forge?.slots ?? []).flatMap((j) => j.inputs ?? []),
    ...(s.town?.smithy ?? []).map((j) => j.part).filter(Boolean),
  ];
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
  // 자정을 넘겼으면 오늘의 일을 새로 건다 (§10.2-A)
  if (refreshDaily(S, rng)) {
    UI.logLine('☀ 게시판의 종이가 새것으로 바뀌었다. 오늘의 일이 걸렸다.', 'necro');
    save();
  }
  UI.topbar(S, '시체골 · 마을');
  // 건물은 왼쪽 그림에서 눌러 들어간다. 하단에는 '지금 할 행동'만 남긴다 (§12.4)
  UI.townPanel(S, {
    ...buildingStatus(S),
    scavenger: S.golem.core ? `목표 ${CP.progress(S).done}/${CP.progress(S).total}` : '골렘이 없다',
    ossuary: ossuaryBadge(),
    golem: S.golem.core ? `방어도 ${assembleGolem(S).shieldNowTotal}` : '핵 없음',
    inventory: `부속 ${S.inventory.length}`,
  }, {
    scavenger: scavengerScreen,
    ossuary: ossuaryScreen,
    quest: questScreen,
    daily: dailyScreen,
    shop: shopScreen,
    forge: forgeScreen,
    conclave: conclaveScreen,
    golem: golemScreen,
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
    { label: '무덤으로 내려간다', cls: 'primary',
      meta: CP.nextStage(S) ? stageOf(CP.nextStage(S)).name : '아홉 단계 완료', on: startRun },
    { label: '상성표', cls: 'ghost', meta: '속성 일곱', on: () => affinityScreen(() => town(false)) },
    { label: '저장', cls: 'ghost', on: () => { save(); UI.logLine('기록을 남겼다.', 'dim'); } },
    { label: '기록 보관', cls: 'ghost', meta: '내보내기 · 가져오기', on: backupScreen },
  ]);
  save();
}

function ossuaryBadge() {
  const o = S.ossuary;
  const busy = o.dissection.slots.length + o.forge.slots.length + o.laborBay.dispatch.length;
  if (o.rotVat.stored >= O.vatCap(o)) return '통이 가득';
  return busy ? `작업 ${busy}건` : '비어 있음';
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
    UI.rowHTML('내구도', `${part.integrity}/${part.maxIntegrity}`, part.integrity <= 2 ? '위험' : '', part.integrity <= 2),
    UI.rowHTML('방어도', `${shieldNow(part, slot)}/${shieldMax(part, slot)}`, equipped ? '장착 중' : ''),
    ...Object.entries(st).filter(([, v]) => v).map(([k, v]) =>
      UI.rowHTML(STAT_LABEL[k] ?? k, `${v > 0 ? '+' : ''}${v}`, '')),
  ];
  if (def.def_element) rows.push(UI.rowHTML('방어 속성', def.def_element, '몸통만 가진다'));
  if (mod) rows.push(UI.rowHTML('이상', UI.esc(mod.prefix), mod.added_skill ? '기술 추가' : ''));
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
  UI.logLine('일곱 속성이 서로를 먹고 먹힌다. 외울 필요는 없다 — 여기서 언제든 볼 수 있다.', 'narrate');
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
  UI.logLine('네크로맨서의 장부. 베껴 두면 잃어버려도 다시 쓸 수 있다.', 'narrate');
  UI.choices([
    { label: '내보내기', cls: 'primary', meta: '글상자에 띄운다', on: exportSave },
    { label: '가져오기', meta: '붙여넣은 것으로 덮어쓴다', on: importSave },
    { label: '돌아간다', cls: 'ghost', pin: true, on: () => town(false) },
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
    { label: '돌아간다', cls: 'ghost', pin: true, on: () => town(false) },
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
  ], { paged: true });
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
    UI.logLine('바르그는 무덤에서 돌아오지 못한 자들의 부속을 주워다 판다. 당신의 단골이 될 것이다.', 'dim');
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
  vat: vatScreen, dissect: dissectScreen, vault: vaultScreen, forge: forgeJobScreen,
  labor: laborScreen, overhaul: overhaulScreen, workshop: workshopScreen,
  crew: crewScreen, altar: altarScreen,
});
const ossPanel = () => UI.ossuaryPanel(S, O, Date.now(), OSS_GO());

function ossuaryScreen() {
  const fresh = O.settle(S, Date.now());
  if (fresh.lines.length) notifyQuests({ kind: 'job', count: fresh.lines.length });
  for (const l of fresh.lines) UI.logLine(`${l.facility} — ${l.text}`, l.warn ? 'bad' : 'good');
  UI.topbar(S, '시체골 · 납골당');
  ossPanel();
  const o = S.ossuary;
  UI.logHead('납골당');
  UI.logLine('네크로맨서의 작업장. 여기서는 시간이 재료를 만든다.', 'narrate');
  if (!S.log.hintOssuary) {
    S.log.hintOssuary = true;
    UI.logLine('— 여기서 하는 일은 셋이다 —', 'necro');
    UI.logLine('① 접합로에서 날것 부속을 정착시킨다. 이걸 거쳐야 기술이 불발되지 않는다.', 'necro');
    UI.logLine('② 정비대에서 방어도와 핵을 되돌린다. 포션으로는 방어도가 돌아오지 않는다.', 'necro');
    UI.logLine('③ 나머지는 걸어 두고 나가면 시간이 알아서 한다. 걸어 두지 않으면 아무것도 안 돈다.', 'necro');
    UI.logLine('조립대에서 여분 핵으로 세운 골렘을 작업반에 붙이면 그 시간이 짧아진다.', 'good');
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
    { label: '돌아간다', cls: 'ghost', pin: true, on: ossuaryScreen },
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
    { label: '돌아간다', cls: 'ghost', pin: true, on: ossuaryScreen },
  ], { paged: true });
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
  UI.logLine('여기 맡긴 것은 무슨 일이 있어도 그대로 남는다.', 'narrate');
  UI.logLine(`무덤에 들고 내려간 여분은 골렘이 무너질 때 하나당 ${SPARE_LOSS}%씩 흘린다. 여기 둔 것은 흘리지 않는다.`, 'necro');
  UI.logLine(`칸 ${o.vault.parts.length}/${o.vault.capacity} — 제단에서 늘린다.`, 'dim');
  if (o.vault.lostRecords.length) {
    UI.logLine(`잃어버린 기록: ${o.vault.lostRecords.map((id) => DB.partsBy[id]?.name_template.replace('{mod}', '').replace('{owner}', DB.partsBy[id].owner ?? '')).join(', ')}`, 'dim');
  }
  const equipped = new Set(SLOTS.map((x) => S.golem[x]).filter(Boolean));
  const spare = S.inventory.filter((p) => !equipped.has(p.uid));
  UI.choices([
    ...o.vault.parts.map((p) => ({
      label: `${partName(p)} 꺼내기`, meta: `${p.integrity}/${p.maxIntegrity}`, on: () => {
        o.vault.parts = o.vault.parts.filter((x) => x.uid !== p.uid);
        S.inventory.push(p);
        UI.logLine(`${partName(p)}을(를) 꺼냈다.`, 'good');
        vaultScreen();
      },
    })),
    ...spare.map((p) => ({
      label: `${partName(p)} 보관`, cls: 'ghost',
      disabled: o.vault.parts.length >= o.vault.capacity,
      on: () => {
        S.inventory = S.inventory.filter((x) => x.uid !== p.uid);
        o.vault.parts.push(p);
        vaultScreen();
      },
    })),
    { label: '돌아간다', cls: 'ghost', pin: true, on: ossuaryScreen },
  ], { paged: true });
  save();
}

/* ── 정비대: 방어도·핵 회복 ─────────────── */
function overhaulScreen() {
  const o = S.ossuary;
  o.overhaul ??= [];
  const g = assembleGolem(S);
  UI.topbar(S, '납골당 · 정비대');

  const coreHp = S.golem.coreHp ?? g.stats.hp;
  const rows = [
    UI.rowHTML('핵', g.core ? UI.esc(g.core.name) : '<span class="empty">없음</span>',
      `${coreHp}/${g.stats.hp}`, coreHp < g.stats.hp),
    ...g.worn.map(({ slot, part, shieldMax: max, shield }) =>
      UI.rowHTML(SLOT_LABEL[slot], UI.partHTML(part), `${shield}/${max}`, shield < max)),
  ];
  UI.listPanel('정비 대상', rows,
    `<p class="note">방어도는 포션으로 돌아오지 않는다. 작업대나 여기서만 되돌릴 수 있다.<br>
     핵 체력도 런을 넘어 남는다 — 반쯤 깎인 채로 다시 내려가면 그만큼 불리하다.</p>`);

  UI.logHead('정비대');
  UI.logLine('부서진 것을 원래대로 돌리는 자리. 오래 걸리고 재료를 먹는다.', 'narrate');
  UI.logLine('골렘을 통째로 올려놓는 작업이라, 끝나기 전에는 무덤에 내려갈 수 없다.', 'necro');
  for (const j of o.overhaul) {
    UI.logLine(`${O.OVERHAUL[j.kind].name} — ${O.remainText(j.startedAt, j.durationMs)}`, 'dim');
  }

  const costText = (c) => Object.entries(c).map(([k, v]) => `${O.RES_LABEL[k]} ${v}`).join(' · ');
  const afford = (c) => Object.entries(c).every(([k, v]) => (S[k] ?? 0) >= v);
  const running = (kind) => o.overhaul.some((j) => j.kind === kind);
  const shieldGap = g.worn.some((w) => w.shield < w.shieldMax);
  const coreGap = coreHp < g.stats.hp;

  UI.choices([
    ...Object.entries(O.OVERHAUL).map(([kind, r]) => {
      const need = kind === 'shield' ? shieldGap : coreGap;
      const ms = O.jobDuration(S, r.ms);
      return {
        label: r.name,
        meta: running(kind) ? '진행 중'
          : !need ? '온전하다'
          : `${costText(r.cost)} · ${Math.round(ms / 60000)}분`,
        disabled: running(kind) || !need || !afford(r.cost),
        on: () => {
          for (const [k, v] of Object.entries(r.cost)) S[k] -= v;
          o.overhaul.push({ kind, startedAt: Date.now(), durationMs: ms });
          UI.logLine(`${r.name}을(를) 맡겼다. ${Math.round(ms / 60000)}분 뒤에 끝난다.`, 'good');
          overhaulScreen();
        },
      };
    }),
    // 급하면 물릴 수 있어야 한다. 그러지 않으면 정비를 걸어 둔 채 몇 시간을 못 내려간다
    ...o.overhaul.map((j) => ({
      label: `${O.OVERHAUL[j.kind].name} 물린다`, cls: 'danger',
      meta: '쓴 재료는 돌아오지 않는다',
      on: () => {
        o.overhaul = o.overhaul.filter((x) => x !== j);
        UI.logLine(`${O.OVERHAUL[j.kind].name}을(를) 중간에 걷어냈다. 쓴 재료는 돌아오지 않는다.`, 'bad');
        save();
        overhaulScreen();
      },
    })),
    { label: '돌아간다', cls: 'ghost', pin: true, on: ossuaryScreen },
  ]);
  save();
}

/* ── 작업반 ─────────────────────────────── */
/* ── 조립대 — 여분 핵으로 사역 골렘을 세운다 ──────────────
   부속만 세워 두는 것으로는 아무 일도 일어나지 않는다.
   핵이 몸을 세우고, 그 골렘이 일을 한다. */
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
  UI.logLine('핵을 놓고 부속을 맞춘다. 전투에 나갈 골렘이 아니라, 여기 남아 손을 놀릴 골렘이다.', 'narrate');
  if (!S.cores.length) {
    UI.logLine('여분 핵이 없다. 상점에서 사거나 단계를 끝내면 들어온다.', 'dim');
    UI.logLine('지금 골렘에 박혀 있는 핵은 뽑아 쓸 수 없다 — 그건 당신이 탈 몸이다.', 'dim');
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
    { label: '돌아간다', cls: 'ghost', pin: true, on: ossuaryScreen },
  ], { paged: true });
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
    name: `사역 골렘 ${o.workshop.seq}호`,
    core: coreId,
    parts: [],
    slots: {},          // 자리 → 부속 uid
    assigned: null,
  };
  o.workshop.golems.push(g);
  UI.logLine(`${DB.coresBy[coreId].name}을(를) 받침대에 올렸다. 이제 부속을 붙이면 된다.`, 'good');
  save();
  return g;
}

/** 사역 골렘 한 기 — 자리마다 부속을 붙이고 뗀다 */
function workGolemScreen(id) {
  const g = O.workshopGolems(S).find((x) => x.id === id);
  if (!g) { workshopScreen(); return; }
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
  UI.logLine('전투에 나갈 골렘이 아니다. 여기 남아 손을 놀릴 몸이다.', 'narrate');
  if (!g.parts.length) UI.logLine('아직 부속이 하나도 없다. 능률은 핵 몫뿐이다.', 'dim');

  UI.choices([
    ...SLOTS.map((slot) => {
      const p = partAt(slot);
      return {
        label: `${SLOT_LABEL[slot]} — ${p ? partName(p) : '비어 있음'}`,
        meta: p ? '바꾸거나 뗀다' : '붙인다',
        on: () => workSlotScreen(g.id, slot),
      };
    }),
    // 자리가 여섯이라 쪽이 넘어간다. 이 둘은 어느 쪽에서든 눌려야 한다
    g.assigned === 'crew'
      ? { label: '작업반에서 물린다', cls: 'ghost', pin: true,
          on: () => { g.assigned = null; save(); workGolemScreen(id); } }
      : g.assigned === 'labor'
        ? { label: '파견 나가 있다', cls: 'ghost', pin: true, disabled: true,
            meta: '안치소에서 불러들인다' }
        : { label: '작업반에 붙인다', cls: 'primary', pin: true, meta: `능률 ${O.golemPower(g)}`,
            on: () => { g.assigned = 'crew'; save(); workGolemScreen(id); } },
    { label: '이 골렘을 해체한다', cls: 'danger', pin: true,
      meta: g.assigned === 'labor' ? '파견 중에는 해체할 수 없다' : `핵과 부속 ${g.parts.length}개 회수`,
      disabled: g.assigned === 'labor',
      on: () => { disassembleWorkGolem(id); workshopScreen(); } },
    { label: '돌아간다', cls: 'ghost', pin: true, on: workshopScreen },
  ], { paged: true });
  save();
}

/** 그 자리에 넣을 부속을 고른다 */
function workSlotScreen(id, slot) {
  const g = O.workshopGolems(S).find((x) => x.id === id);
  if (!g) { workshopScreen(); return; }
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
        on: () => {
          detach();
          S.inventory = S.inventory.filter((x) => x.uid !== p.uid);
          g.parts.push(p);
          g.slots[slot] = p.uid;
          UI.logLine(`${partName(p)}을(를) ${g.name}의 ${SLOT_LABEL[slot]}에 붙였다.`, 'good');
          save();
          workGolemScreen(id);
        },
      };
    }),
    cur ? { label: '떼어낸다', cls: 'danger',
      on: () => { detach(); UI.logLine(`${partName(cur)}을(를) 되찾았다.`, 'dim'); save(); workGolemScreen(id); } } : null,
    { label: '돌아간다', cls: 'ghost', pin: true, on: () => workGolemScreen(id) },
  ], { paged: true });
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
    `<p class="note">합계 능률 ${cs.power} → 해체대·접합로 작업 시간 <b>${Math.round(cs.cut * 100)}% 단축</b> (상한 60%).<br>
      부속만으로는 일을 시킬 수 없다. <b>조립대</b>에서 핵을 넣어 세운 골렘만 붙일 수 있다.</p>`);

  UI.logHead('작업반');
  UI.logLine('세워 둔 골렘에게 일을 맡긴다. 핵이 좋을수록, 부속이 좋을수록 일이 빠르다.', 'narrate');
  if (!golems.length) UI.logLine('조립대에 선 골렘이 없다. 먼저 핵을 넣어 한 기를 세워야 한다.', 'dim');

  UI.choices([
    ...onDuty.map((g) => ({
      label: `${g.name} 물린다`, cls: 'ghost',
      on: () => { g.assigned = null; crewScreen(); },
    })),
    ...golems.filter((g) => !g.assigned).map((g) => ({
      label: `${g.name} 붙인다`,
      meta: `능률 ${O.golemPower(g)}`,
      on: () => {
        g.assigned = 'crew';
        UI.logLine(`${g.name}이(가) 일을 시작했다.`, 'good');
        crewScreen();
      },
    })),
    { label: '조립대로', pin: true, on: workshopScreen },
    { label: '돌아간다', cls: 'ghost', pin: true, on: ossuaryScreen },
  ], { paged: true });
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
  UI.logLine('버린 파츠에 두 번째 생명을 준다.', 'narrate');
  const rawAll = S.inventory.filter((p) => p.raw).length;
  if (rawAll) UI.logLine(`정착하지 않은 날것 부속이 ${rawAll}개 있다.`, 'bad');
  if (free <= 0) {
    UI.logLine(`접합로가 꽉 찼다 (${o.forge.slots.length}/${O.forgeSlots(o)}칸). 지금 걸린 작업이 끝나야 다음을 건다.`, 'bad');
    UI.logLine('제단에서 접합로를 증설하면 동시에 여러 개를 걸 수 있다.', 'dim');
  } else if (!spareCount) UI.logLine('재료로 쓸 여분 파츠가 없다.', 'dim');

  const rawCount = S.inventory.filter((p) => p.raw && !equippedF.has(p.uid)).length;
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
          : key === 'attune' ? '정착할 날것이 없다'
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
    { label: '돌아간다', cls: 'ghost', pin: true, on: ossuaryScreen },
  ], { paged: true });
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
  ], { paged: true });
}

/* ── 사역 골렘 파견 ─────────────────────── */
/* ── 사역 골렘 안치소 — 자원을 주워 오게 보낸다 (§9.3-④) ──
   작업반과 같은 원칙이다. 부속 낱개가 아니라 **조립대에서 세운 골렘**을 보낸다. */
function laborScreen() {
  const o = S.ossuary;
  UI.topbar(S, `납골당 · 파견 ${o.laborBay.dispatch.length}/${O.laborSlots(o)}칸`);
  const golems = O.workshopGolems(S);
  const byId = (id) => golems.find((g) => g.id === id);

  UI.listPanel('나가 있는 골렘',
    o.laborBay.dispatch.map((d) => {
      const g = byId(d.golemId);
      const site = O.SITES[d.site];
      return UI.rowHTML(site.name, UI.esc(g?.name ?? '?'),
        g ? `부속 ${g.parts.length}` : '사라짐', !g);
    }),
    `<p class="note">시간이 지나면 조각·골분·진액을 주워 온다. 운이 좋으면 부속도 가져온다.<br>
      주워 온 부속은 <b>표본실</b>로 들어가고, 날것이라 정착을 거쳐야 한다.<br>
      나가 있는 동안 그 골렘의 부속은 쓸 수 없고, 터에 따라 내구도가 닳는다.</p>`);

  UI.logHead('사역 골렘 안치소');
  UI.logLine('세운 골렘을 밖으로 내보낸다. 돌아올 때 무언가를 들고 온다.', 'narrate');
  for (const d of o.laborBay.dispatch) {
    const g = byId(d.golemId);
    UI.logLine(`${O.SITES[d.site].name} — ${g?.name ?? '?'}`
      + (g ? ` (${g.parts.map((p) => `${partName(p)} ${p.integrity}/${p.maxIntegrity}`).join(', ')})` : ''), 'dim');
  }
  const free = O.laborSlots(o) - o.laborBay.dispatch.length;
  const idle = golems.filter((g) => !g.assigned && g.parts.length);
  if (!golems.length) UI.logLine('조립대에 선 골렘이 없다. 여분 핵으로 한 기를 세워야 보낸다.', 'dim');
  else if (!idle.length) UI.logLine('놀고 있는 골렘이 없다. 작업반에 붙였거나 이미 나가 있다.', 'dim');

  UI.choices([
    ...o.laborBay.dispatch.map((d) => {
      const g = byId(d.golemId);
      return {
        label: `${O.SITES[d.site].name}에서 불러들인다`, cls: 'ghost',
        meta: g?.name ?? '',
        on: () => {
          if (g) g.assigned = null;
          o.laborBay.dispatch = o.laborBay.dispatch.filter((x) => x !== d);
          UI.logLine(`${g?.name ?? '사역 골렘'}을(를) 불러들였다.`, 'good');
          save();
          laborScreen();
        },
      };
    }),
    ...Object.entries(O.SITES).map(([key, site]) => {
      const needKey = site.need ? Object.keys(site.need)[0] : null;
      const fits = idle.filter((g) => O.siteReady(site, O.golemStats(g)));
      const why = free <= 0 ? `안치소가 꽉 참 (${o.laborBay.dispatch.length}/${O.laborSlots(o)}칸)`
        : !idle.length ? '보낼 골렘이 없다'
        : !fits.length ? `${STAT_LABEL[needKey]} ${site.need[needKey]} 이상이 필요하다`
        : null;
      return {
        label: `${site.name}으로 보낸다`,
        meta: why ?? (site.need
          ? `${STAT_LABEL[needKey]} ${site.need[needKey]}+ · 보낼 수 있는 골렘 ${fits.length}기`
          : `조건 없음 · 보낼 수 있는 골렘 ${fits.length}기`),
        disabled: Boolean(why),
        on: () => dispatchPick(key),
      };
    }),
    { label: '조립대로', on: workshopScreen },
    { label: '돌아간다', cls: 'ghost', pin: true, on: ossuaryScreen },
  ], { paged: true });
  save();
}

/** 어느 골렘을 보낼지 고른다 */
function dispatchPick(siteKey) {
  const o = S.ossuary;
  const site = O.SITES[siteKey];
  const needKey = site.need ? Object.keys(site.need)[0] : null;
  UI.topbar(S, `파견 · ${site.name}`);

  const idle = O.workshopGolems(S).filter((g) => !g.assigned && g.parts.length);
  UI.listPanel(`${site.name}`, [
    UI.rowHTML('요구', site.need ? `${STAT_LABEL[needKey]} ${site.need[needKey]} 이상` : '없음', ''),
    UI.rowHTML('산출', Object.entries(site.rate)
      .map(([k, v]) => `${O.RES_LABEL[k]} ${v}/시간`).join(' · '), ''),
    UI.rowHTML('부속', site.findsPart
      ? `${site.findsPart}시간마다 ${site.partLuck}% 확률` : '없음', ''),
    UI.rowHTML('내구도', site.wear ? `${site.wear}시간마다 1 감소` : '닳지 않음', '', Boolean(site.wear)),
  ], `<p class="note">${site.desc}<br>산출은 골렘의 ${STAT_LABEL[needKey ?? 'atk']}에 비례해 늘어난다.</p>`);

  UI.logHead(`${site.name}으로`);
  UI.logLine(site.desc, 'narrate');
  if (!idle.length) UI.logLine('보낼 수 있는 골렘이 없다.', 'dim');

  UI.choices([
    ...idle.map((g) => {
      const st = O.golemStats(g);
      const ready = O.siteReady(site, st);
      return {
        label: `${g.name} 보낸다`,
        meta: ready
          ? `공${st.atk} 방${st.def} 속${st.spd} · 산출 ${Math.round((1 + (st[needKey ?? 'atk'] ?? 0) / 100) * 100)}%`
          : `${STAT_LABEL[needKey]} ${st[needKey]} / ${site.need[needKey]} — 모자라다`,
        disabled: !ready,
        on: () => {
          g.assigned = 'labor';
          o.laborBay.dispatch.push({
            site: siteKey, golemId: g.id, startedAt: Date.now(), wearClock: 0, findClock: 0,
          });
          UI.logLine(`${g.name}을(를) ${site.name}으로 보냈다.`, 'good');
          save();
          laborScreen();
        },
      };
    }),
    { label: '취소', cls: 'ghost', pin: true, on: laborScreen },
  ], { paged: true });
}

/* ── 제단 (영구 해금) ───────────────────── */
function altarScreen() {
  const o = S.ossuary;
  UI.topbar(S, '납골당 · 제단');
  ossPanel();
  UI.logHead('제단');
  UI.logLine('영혼재는 오직 무덤에서만 나온다. 여기서 그것을 태워 영구적인 것을 산다.', 'narrate');

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
    list.push(buy(`파견 자리 증설 (${o.laborBay.level} → ${o.laborBay.level + 1})`, c, `영혼재 ${c}`,
      () => { o.laborBay.level++; }));
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
    { label: '돌아간다', cls: 'ghost', pin: true, on: () => town(false) },
  ]);
  save();
}

/* ── 상점 ───────────────────────────────── */
function shopScreen() {
  UI.topbar(S, '시체골 · 썩은 손수레');
  const stock = S.town.stock;
  const supply = tickSupply(S);
  const rows = [
    ...(stock.cores ?? []).map((id) => {
      const c = DB.coresBy[id];
      return UI.rowHTML('핵', `${UI.esc(c.name)}<br><span style="color:var(--muted);font-size:.84em">${UI.esc(c.desc)}</span>`, money(c.price));
    }),
    ...stock.items.map((id) => {
      const it = DB.itemsBy[id];
      return UI.rowHTML(it.kind, `${UI.esc(it.name)}<br><span style="color:var(--muted);font-size:.84em">${UI.esc(it.desc)}</span>`, money(it.price));
    }),
    ...stock.parts.map((p) => UI.rowHTML(KIND_LABEL[DB.partsBy[p.defId].slot] ?? '파츠',
      UI.partHTML(p), money(partPrice(p)))),
  ];
  const supRows = SUPPLY.map((d) => {
    const st = supply[d.key];
    const left = supplyRemain(st, d);
    return UI.rowHTML('보급', UI.esc(d.name),
      `${st.n}/${d.cap} · ${money(d.price)}` + (left ? ` · +1 ${O.remainText(Date.now(), left)}` : ''),
      st.n === 0);
  });
  UI.listPanel('오늘의 재고', [...rows, ...supRows],
    `<p class="note">쓰지 않는 파츠는 팔아서 은화로 바꿀 수 있다.<br>
     보급품은 수레가 시간이 지나며 조금씩 받아 둔다 — 칸이 차면 더는 쌓이지 않는다.</p>`);

  UI.logHead('썩은 손수레');
  UI.logLine('수레 가득 잡동사니가 실려 있다. 주인은 당신과 눈을 마주치지 않는다.', 'narrate');

  const list = [];
  for (const id of stock.items) {
    const it = DB.itemsBy[id];
    list.push({ label: `${it.name} 구입`, meta: money(it.price), disabled: S.silver < it.price, on: () => {
      S.silver -= it.price;
      S.consumables[id] = (S.consumables[id] ?? 0) + 1;
      UI.logLine(`${it.name}을(를) 샀다.`, 'good');
      shopScreen();
    } });
  }
  for (const cid of stock.cores ?? []) {
    const c = DB.coresBy[cid];
    list.push({ label: `${c.name} 구입`, meta: money(c.price), disabled: S.silver < c.price, on: () => {
      S.silver -= c.price;
      S.cores.push(cid);
      S.town.stock.cores = S.town.stock.cores.filter((x) => x !== cid);
      UI.logLine(`${c.name}을(를) 샀다. 골렘 정비에서 끼울 수 있다.`, 'good');
      shopScreen();
    } });
  }
  for (const p of stock.parts) {
    const price = partPrice(p);
    list.push({ label: `${partName(p)} 구입`, meta: money(price), disabled: S.silver < price, on: () => {
      S.silver -= price;
      S.inventory.push(p);
      S.town.stock.parts = S.town.stock.parts.filter((x) => x !== p);
      UI.logLine(`${partName(p)}을(를) 손에 넣었다.`, 'good');
      shopScreen();
    } });
  }
  for (const d of SUPPLY) {
    const st = supply[d.key];
    const bulk = Math.min(st.n, Math.floor(S.silver / d.price), 10);
    list.push({ label: `${d.name} 1개 구입`, meta: `${money(d.price)} · 재고 ${st.n}/${d.cap}`,
      disabled: st.n < 1 || S.silver < d.price, on: () => buySupply(d, 1) });
    if (bulk > 1) {
      list.push({ label: `${d.name} ${bulk}개 구입`, cls: 'ghost', meta: money(d.price * bulk),
        on: () => buySupply(d, bulk) });
    }
  }
  list.push({ label: '파츠 팔기', on: sellScreen });
  list.push({ label: '돌아간다', cls: 'ghost', pin: true, on: () => town(false) });
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
      label: `${partName(p)} 판매`, meta: money(sellPrice(p)), on: () => {
        S.silver += sellPrice(p);
        S.inventory = S.inventory.filter((x) => x.uid !== p.uid);
        UI.logLine(`${partName(p)}을(를) 넘겼다. (+${sellPrice(p)})`, 'good');
        notifyQuests({ kind: 'dismantle', count: 1 });
        sellScreen();
      },
    })),
    { label: '돌아간다', cls: 'ghost', pin: true, on: shopScreen },
  ], { paged: true });
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
  list.push({ label: '돌아간다', cls: 'ghost', pin: true, on: () => town(false) });
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
  ], { paged: true });
  save();
}

function retuneScreen() {
  const g = assembleGolem(S);
  UI.topbar(S, '시체골 · 속성 도가니');
  UI.logHead('속성 도가니');
  UI.logLine('도가니가 열을 머금는다. 스킬 하나의 속성을 바꿀 수 있다.', 'narrate');
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
  list.push({ label: '돌아간다', cls: 'ghost', pin: true, on: () => town(false) });
  UI.choices(list);
  save();
}

/* ── 골렘 정비 ──────────────────────────── */
/**
 * 골렘 화면.
 * @param back 돌아갈 화면
 * @param canEdit 교체 가능 여부. 던전에서는 작업대(§6.4)에서만 참이다.
 */
function golemScreen(back = town, canEdit = true) {
  UI.topbar(S, canEdit ? '골렘 정비' : '골렘 상태');
  UI.golemPanel(S);
  const g = assembleGolem(S);
  if (g.over) UI.logLine(`스킬이 ${g.active.length}개다. ${SKILL_CAP}개를 넘으면 일부를 봉인해야 한다.`, 'bad');
  const raws = g.worn.filter(({ part }) => part.raw);
  if (raws.length) {
    UI.logLine(`날것 상태로 붙인 부속 ${raws.length}개 — 성능 60%, 기술이 불발될 수 있고 내구도가 배로 닳는다.`, 'bad');
    UI.logLine('납골당 정착대에서 처리하면 온전해진다.', 'dim');
  }
  if (!canEdit) UI.logLine('여기서는 손볼 수 없다. 작업대가 있는 방이나 마을에서 정비한다.', 'dim');
  UI.choices([
    ...(canEdit ? [{ label: '핵 교체', meta: g.core ? g.core.name : '없음', on: () => coreScreen(back, canEdit) }] : []),
    ...(canEdit
      ? SLOTS.map((slot) => ({ label: `${SLOT_LABEL[slot]} 교체`, on: () => slotScreen(slot, back, canEdit) }))
      : []),
    canEdit && g.skills.length > SKILL_CAP ? { label: '스킬 봉인 관리', on: () => banScreen(back, canEdit) } : null,
    { label: '돌아간다', cls: 'ghost', pin: true, on: () => back(false) },
  ]);
  save();
}

function coreScreen(back, canEdit = true) {
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
  ], { paged: true });
  save();
}

function slotScreen(slot, back, canEdit = true) {
  const kind = SLOT_KIND[slot];
  const cur = S.golem[slot] ? findPart(S.golem[slot]) : null;
  const equipped = new Set(SLOTS.map((s) => S.golem[s]).filter(Boolean));
  const options = S.inventory.filter((p) =>
    DB.partsBy[p.defId].slot === kind && !equipped.has(p.uid));

  UI.topbar(S, `골렘 · ${SLOT_LABEL[slot]}`);
  UI.golemPanel(S);
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
        meta: short > 0
          ? `마력 ${after}/${before.manaMax} — ${short} 모자라다`
          : `마력 ${partMana(p)} · ${p.raw ? '날것 · ' : ''}${diffText(slot, p)} · ${p.integrity}/${p.maxIntegrity}`,
        // 버튼에 얹기만 해도 전후 비교가 왼쪽에 뜬다 — 암산을 시키지 않는다
        hover: () => previewSwap(slot, p, before),
        unhover: () => UI.golemPanel(S),
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
  ], { paged: true });
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
    `${p.integrity}/${p.maxIntegrity}`, p.integrity <= 2));
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
    ...S.inventory.filter((p) => p.integrity < p.maxIntegrity && S.consumables.it_bitumen > 0)
      .map((p) => ({
        label: `${partName(p)}에 역청`, meta: `+3 (${S.consumables.it_bitumen}개 남음)`, on: () => {
          S.consumables.it_bitumen--;
          p.integrity = Math.min(p.maxIntegrity, p.integrity + 3);
          UI.logLine(`${partName(p)}의 내구도를 메웠다. (${p.integrity}/${p.maxIntegrity})`, 'good');
          inventoryScreen(back);
        },
      })),
    { label: '돌아간다', cls: 'ghost', pin: true, on: () => back(false) },
  ], { paged: true });
}

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
  const bench = S.ossuary?.overhaul ?? [];
  if (bench.length) {
    UI.logLine('골렘이 정비대에 올라가 있다. 작업이 끝나기 전에는 내려갈 수 없다.', 'bad');
    for (const j of bench) {
      UI.logLine(`${O.OVERHAUL[j.kind].name} — ${O.remainText(j.startedAt, j.durationMs)}`, 'dim');
    }
    UI.logLine('납골당 정비대에서 물릴 수도 있다 — 쓴 재료는 돌아오지 않는다.', 'dim');
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
  UI.logLine('작업대 위의 것은 아직 아무것도 아니다. 당신이 정하는 대로 될 것이다.', 'narrate');
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
          UI.logLine('버려진 작업대. 공구는 삭았지만 한 번은 버텨 줄 것이다.', 'narrate');
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
      list.push({ label: '한 부위 방어도 수리', cls: 'primary', meta: '한 번뿐 · 시체 조각',
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
function repairScreen() {
  const g = assembleGolem(S);
  const fd = S.run.floorData;
  UI.topbar(S, `무덤 ${fd.floor}층 · 방어도 수리`);
  UI.dungeonPanel(S, fd);
  UI.logHead('방어도 수리');
  UI.logLine('녹슨 도구로 이음새를 조인다. 깎인 방어도를 되돌릴 수 있다.', 'narrate');
  UI.logLine('공구가 버텨 주는 것은 한 부위뿐이다. 어디를 고칠지 골라야 한다.', 'dim');

  const PER_SCRAP = 35;        // 시체 조각 1당 되돌아오는 방어도 (밸런스 도구가 정한 값)
  const rows = g.worn.map(({ slot, part, shieldMax: max, shield: cur }) => {
    const missing = max - cur;
    const cost = Math.max(1, Math.ceil(missing / PER_SCRAP));
    return { slot, part, max, cur, missing, cost };
  }).filter((r) => r.missing > 0)
    .sort((a, b) => b.missing - a.missing);     // 가장 많이 깎인 곳이 위에

  if (!rows.length) UI.logLine('모든 부위의 방어도가 온전하다.', 'dim');

  UI.choices([
    ...rows.map((r) => ({
      label: `${SLOT_LABEL[r.slot]} — ${partName(r.part)}`,
      meta: `${r.cur}/${r.max} · 조각 ${r.cost}`,
      disabled: S.scrap < r.cost,
      on: () => {
        S.scrap -= r.cost;
        r.part.shield = r.max;
        UI.logLine(`${partName(r.part)}의 방어도를 ${r.max}까지 되돌렸다.`, 'good');
        spendBench('repair');
        backToRoom();
      },
    })),
    { label: '돌아간다', cls: 'ghost', pin: true, on: backToRoom },
  ], { paged: true });
  save();
}

const backToRoom = () => {
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
  ], { paged: true });
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
          for (const { part } of g.worn) part.integrity = Math.min(part.maxIntegrity, part.integrity + 2);
          UI.logLine('해부대가 피를 삼키고, 골렘의 이음새가 단단해진다. (전 파츠 내구도 +2)', 'good');
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
  for (const it of cb.combatItems()) {
    list.push({ label: `${it.name}`, meta: `${it.count}개`, on: () => resolve({ kind: 'item', id: it.id }) });
  }
  if (!S.seen?.[cb.mon.defId]) {
    list.push({ label: '관찰', cls: 'ghost', meta: '턴 소모', on: () => resolve({ kind: 'observe' }) });
  }
  UI.choices(list);
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
      else if (p.integrity <= 2) UI.logLine(`⚠ ${partName(p)}의 내구도가 ${p.integrity}밖에 남지 않았다.`, 'bad');
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
          UI.logLine('— 부속을 왜 바꾸는가 —', 'necro');
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
  UI.logLine('마지막 부속까지 떨어져 나갔다. 핵만 남은 것은 골렘이 아니다.', 'narrate');
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
 * 도망치며 주울 수 있는 것만 건진다 — 성한 부속일수록 잘 건진다.
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

function reportDismantle(r) {
  if (r.brokenCore) UI.logLine(`${DB.coresBy[r.brokenCore].name}이(가) 쪼개졌다. 골렘은 더 이상 없다.`, 'bad');
  if (r.kept.length) UI.logLine(`흩어진 것 중 ${r.kept.map(partName).join(', ')}을(를) 급히 주워 담았다.`, 'good');
  if (r.lost.length) UI.logLine(`${r.lost.map(partName).join(', ')}은(는) 그 자리에 남겨두고 왔다.`, 'bad');
  if (r.spareLost?.length) {
    UI.logLine(`달아나며 짐도 흘렸다 — ${r.spareLost.map(partName).join(', ')}.`, 'bad');
    if (!S.log.hintVault) {
      S.log.hintVault = true;
      UI.logLine('— 아까운 것은 맡겨 두어라 —', 'necro');
      UI.logLine(`무덤에 들고 내려간 여분은 무너질 때 하나당 ${r.rate}%씩 흘린다.`, 'necro');
      UI.logLine('납골당 표본실에 맡긴 것은 무슨 일이 있어도 그대로 남는다. 그것이 표본실이다.', 'good');
    }
  }
  if (!S.golem.core) UI.logLine('새 핵을 구해야 다시 내려갈 수 있다.', 'dim');
}

function loseRun() {
  UI.logHead('붕괴');
  UI.logLine('네크로맨서는 무너진 골렘 앞에 선다. 챙길 수 있는 것만 챙겨야 한다.', 'narrate');
  const r = dismantleGolem();
  reportDismantle(r);
  const ash = 15 + S.run.kills * 3;
  S.soulAsh += ash;
  UI.logLine(`영혼재 ${ash}를 챙겨 달아났다.`, 'dim');
  S.run = null;
  S.town.stock = rollStock(rng, S.unlocks);
  UI.choices([{ label: '마을로 돌아간다', cls: 'primary', on: () => settleAndReport(() => town()) }]);
  save();
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
