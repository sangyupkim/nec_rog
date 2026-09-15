/** 게임 진행 · 화면 전환 · 세이브 */
import {
  DB, loadData, makeRng, makePart, partName, partStats, partSkills,
  assembleGolem, SLOTS, SLOT_LABEL, SLOT_KIND, SKILL_CAP,
  rollMonster, rollElite, rollBoss, rollLoot, syncUidSeq, skillElement, AIM, RAW_WEAR,
} from './core.js';
import { Combat } from './combat.js';
import { generateFloor, roomAt, exitsOf, ROOM_LABEL, ROOM_ICON, FLAVOR, DIR_KEY } from './dungeon.js';
import {
  rollQuests, advanceQuests, questsAllDone, claimQuests, resetQuests,
  nextResetCost, rollStock, partPrice, sellPrice, canCraft, craft,
  canLearn, learn, buildingStatus, ATTACH_SLOTS,
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
  const starter = [
    makePart('part_body_goblin_torso'),
    makePart('part_arm_goblin_claw'),
    makePart('part_leg_goblin_hop'),
  ];
  return {
    version: 1, seed,
    silver: 180, soulAsh: 40, scrap: 12, ichor: 2, boneMeal: 4,
    inventory: starter,
    golem: {
      core: 'core_scrap',
      head: null, body: starter[0].uid, armL: starter[1].uid, armR: null, leg: starter[2].uid,
      attachments: [], banned: [], retuned: {},
    },
    cores: [],          // 예비 핵
    consumables: { it_corpseoil: 2 },
    owned: { attachments: [] },
    necro: { known: ['nk_bonemend', 'nk_skeleton', 'nk_soulspear'],
             equipped: ['nk_bonemend', 'nk_skeleton', 'nk_soulspear'] },
    quests: { active: rollQuests(r), resets: 0 },
    town: { stock: rollStock(r), smithy: [] },
    seen: {}, run: null,
    ossuary: (() => { const o = O.newOssuary(); o.built.forge = true; return o; })(),
    unlocks: { vaultStart: 1, necroSlots: 3 },
    modSamples: {},
    log: { runs: 0, kills: 0, lost: 0, handouts: 0, hintAim: false, hintRaw: false },
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
function migrate(s) {
  s.cores ??= [];
  s.modSamples ??= {};
  s.unlocks ??= { vaultStart: 1, necroSlots: 3 };
  s.unlocks.vaultStart ??= 1;
  s.unlocks.necroSlots ??= 3;
  s.log ??= {};
  s.log.handouts ??= 0;
  s.log.hintAim ??= false;
  s.log.hintRaw ??= false;
  s.town ??= {};
  s.town.smithy ??= [];
  s.golem ??= {};
  s.golem.core ??= (s.golem.body ? 'core_scrap' : null);  // 예전 골렘에는 핵을 끼워 준다
  s.golem.coreHp ??= null;                                // null = 가득
  for (const p of s.inventory ?? []) p.shield ??= null;   // null = 닳지 않음
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
  o.crew ??= { parts: [] };
  o.crew.parts ??= [];
  o.vault ??= { capacity: 3, parts: [], lostRecords: [] };
  o.vault.parts ??= [];
  o.vault.lostRecords ??= [];
  o.dissection ??= { level: 1, slots: [] };
  o.dissection.slots ??= [];
  o.forge ??= { level: 1, slots: [] };
  o.forge.slots ??= [];
  o.laborBay ??= { level: 1, dispatch: [] };
  o.laborBay.dispatch ??= [];
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
    let max = 0;
    const all = [...s.inventory,
      ...(s.ossuary?.vault?.parts ?? []),
      ...(s.ossuary?.laborBay?.dispatch ?? []).flatMap((d) => d.parts ?? [])];
    for (const p of all) max = Math.max(max, Number(String(p.uid).slice(1)) || 0);
    syncUidSeq(max + 1);
    return s;
  } catch { return null; }
}

const KIND_LABEL = { head: '머리', body: '몸통', arm: '팔', leg: '다리' };
/** 최소 이만큼은 끼워야 무덤에 내려갈 수 있다 (§3.6) */
const MIN_PARTS = 2;
const wornCount = () => SLOTS.filter((s) => S.golem[s]).length;
/** 소지 + 장착한 파츠 총수 — 바르그의 지원 판정에 쓴다 */
const totalParts = () => S.inventory.length;

/* 던전에서만 방향키가 살아난다. 화면이 바뀌면 곧바로 꺼진다. */
let arrowMoves = null;
const setArrowMoves = (map) => { arrowMoves = map; };
// 선택지가 다시 그려질 때마다 기본적으로 꺼진다. 던전 이동 화면만 되켠다.
UI.onChoicesRendered.push(() => { arrowMoves = null; });
document.addEventListener('keydown', (e) => {
  const dir = DIR_KEY[e.key];
  if (!dir || !arrowMoves) return;
  const go = arrowMoves[dir];
  if (!go) return;
  e.preventDefault();
  go();
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
  UI.logLine('방어도는 포션으로 돌아오지 않는다. 던전 작업대방이나 납골당 정비대에서만 되돌린다.', 'good');
  UI.choices([{ label: '돌아간다', cls: 'ghost', on: () => back(false) }]);
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
  UI.choices([{ label: '돌아간다', cls: 'ghost', on: () => back(false) }]);
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
  UI.choices([{ label: '돌아간다', cls: 'ghost', on: () => back(false) }]);
}
const money = (n) => `은화 ${n}`;
const findPart = (uid) => S.inventory.find((p) => p.uid === uid);

/* ── 마을 ───────────────────────────────── */
/** 납골당 정산을 돌리고, 내역이 있으면 복귀 정산 화면을 먼저 보여준다 */
function settleAndReport(next) {
  const r = O.settle(S, Date.now());
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
  UI.topbar(S, '시체골 · 마을');
  UI.townPanel(S, buildingStatus(S));
  if (intro) {
    UI.logHead('시체골');
    UI.logLine('젖은 흙과 초의 냄새. 아무도 당신이 무엇을 하는지 묻지 않는 마을이다.', 'narrate');
    if (questsAllDone(S)) UI.logLine('의뢰소 게시판이 비었다. 보상을 받을 때가 됐다.', 'good');
  }
  UI.choices([
    { label: '🦴 뼈 수습꾼 바르그', cls: S.golem.core ? 'ghost' : 'primary',
      meta: S.golem.core ? '잡담' : '골렘이 없다', on: scavengerScreen },
    { label: '납골당', meta: ossuaryBadge(), on: ossuaryScreen },
    { label: '의뢰소', meta: questsAllDone(S) ? '수령 가능' : `${S.quests.active.filter((q) => q.done).length}/3`, on: questScreen },
    { label: '썩은 손수레', meta: '상점', on: shopScreen },
    { label: '뼈 모루', meta: '대장간', on: forgeScreen },
    { label: '강령술사 조합', meta: '술법', on: conclaveScreen },
    { label: '골렘 정비', on: golemScreen },
    { label: '소지품', on: () => inventoryScreen(town) },
    { label: '무덤으로 내려간다', cls: 'primary', on: startRun },
    { label: '저장', cls: 'ghost', on: () => { save(); UI.logLine('기록을 남겼다.', 'dim'); } },
  ]);
  save();
}

function ossuaryBadge() {
  const o = S.ossuary;
  const busy = o.dissection.slots.length + o.forge.slots.length + o.laborBay.dispatch.length;
  if (o.rotVat.stored >= O.vatCap(o)) return '통이 가득';
  return busy ? `작업 ${busy}건` : '비어 있음';
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
    UI.rowHTML('소지', `${totalParts()}개`, '', totalParts() <= MIN_PARTS),
    UI.rowHTML('상태', ready ? '내려갈 수 있다' : '<span class="empty">아직 못 내려간다</span>', '', !ready),
  ], `<p class="note">핵이 없거나 부속이 ${MIN_PARTS}개 이하로 남으면 바르그가 모자란 것만 채워 준다.</p>`);

  UI.logHead('뼈 수습꾼 바르그');
  const times = S.log.handouts ?? 0;
  if (!S.golem.core || totalParts() <= MIN_PARTS) {
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
  const lowParts = totalParts() <= MIN_PARTS;
  const needsHelp = noCore || lowParts;
  UI.choices([
    { label: needsHelp ? '도움을 받는다' : '도움을 청한다', cls: 'primary',
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
      ]) UI.logLine(t, 'narrate');
      UI.choices([{ label: '돌아간다', cls: 'ghost', on: () => town(false) }]);
    } },
    { label: '돌아간다', cls: 'ghost', on: () => town(false) },
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

  const BASIC = ['part_body_goblin_torso', 'part_arm_goblin_claw', 'part_leg_goblin_hop'];
  while (totalParts() < 3) {
    const need = BASIC[Math.min(totalParts(), BASIC.length - 1)];
    const p = makePart(need);
    S.inventory.push(p);
    given.push(partName(p));
  }
  // 비어 있는 자리에 알아서 끼워 준다 — 빈손으로 내보내지 않는다
  const equipped = new Set(SLOTS.map((x) => S.golem[x]).filter(Boolean));
  for (const slot of SLOTS) {
    if (S.golem[slot]) continue;
    const kind = SLOT_KIND[slot];
    const free = S.inventory.find((p) => !equipped.has(p.uid) && DB.partsBy[p.defId].slot === kind);
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

/* ── 납골당 ─────────────────────────────── */
function ossuaryScreen() {
  const fresh = O.settle(S, Date.now());
  for (const l of fresh.lines) UI.logLine(`${l.facility} — ${l.text}`, l.warn ? 'bad' : 'good');
  UI.topbar(S, '시체골 · 납골당');
  UI.ossuaryPanel(S, O);
  const o = S.ossuary;
  UI.logHead('납골당');
  UI.logLine('네크로맨서의 작업장. 여기서는 시간이 재료를 만든다.', 'narrate');

  const list = [
    { label: '🫗 부패조', meta: `${o.rotVat.stored}/${O.vatCap(o)}`, on: vatScreen },
    { label: '🔪 해체대', meta: `${o.dissection.slots.length}/${O.dissectionSlots(o)}칸`, on: dissectScreen },
  ];
  if (o.built.vault) list.push({ label: '🏺 표본실', meta: `${o.vault.parts.length}/${o.vault.capacity}`, on: vaultScreen });
  if (o.built.forge) list.push({ label: '🕯 접합로', meta: `${o.forge.slots.length}/${O.forgeSlots(o)}칸`, on: forgeJobScreen });
  if (o.built.laborBay) list.push({ label: '⛓ 사역 골렘 안치소', meta: `${o.laborBay.dispatch.length}/${O.laborSlots(o)}칸`, on: laborScreen });
  const cs = O.crewSpeed(S);
  const oh = o.overhaul ?? [];
  list.push({ label: '🔧 정비대', meta: oh.length ? `${oh.length}건 진행 중` : '방어도 · 핵', on: overhaulScreen });
  list.push({ label: '🛠 작업반', meta: cs.cut ? `작업 ${Math.round(cs.cut * 100)}% 단축` : '배치 없음', on: crewScreen });
  list.push({ label: '🕯 제단 — 영구 해금', cls: 'primary', on: altarScreen });
  list.push({ label: '돌아간다', cls: 'ghost', on: () => town(false) });
  UI.choices(list);
  save();
}

function vatScreen() {
  const o = S.ossuary;
  UI.topbar(S, '납골당 · 부패조');
  UI.ossuaryPanel(S, O);
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
    { label: '돌아간다', cls: 'ghost', on: ossuaryScreen },
  ]);
  save();
}

function dissectScreen() {
  const o = S.ossuary;
  UI.topbar(S, '납골당 · 해체대');
  UI.ossuaryPanel(S, O);
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
    ...spare.slice(0, 7).map((p) => {
      const rarity = DB.partsBy[p.defId].rarity;
      const spec = O.DISSECT[rarity] ?? O.DISSECT.common;
      return {
        label: `${partName(p)} 해체`,
        meta: `${Math.round(spec.ms / 60000)}분 · 조각 ${spec.scrap[0]}~${spec.scrap[1]}`,
        disabled: free <= 0,
        on: () => {
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
        },
      };
    }),
    { label: '돌아간다', cls: 'ghost', on: ossuaryScreen },
  ]);
  save();
}

function vaultScreen() {
  const o = S.ossuary;
  UI.topbar(S, '납골당 · 표본실');
  UI.ossuaryPanel(S, O);
  UI.logHead('표본실');
  UI.logLine('보존된 표본은 다음 탐험의 출발선이 된다.', 'narrate');
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
    ...spare.slice(0, 4).map((p) => ({
      label: `${partName(p)} 보관`, cls: 'ghost',
      disabled: o.vault.parts.length >= o.vault.capacity,
      on: () => {
        S.inventory = S.inventory.filter((x) => x.uid !== p.uid);
        o.vault.parts.push(p);
        vaultScreen();
      },
    })),
    { label: '돌아간다', cls: 'ghost', on: ossuaryScreen },
  ]);
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
      UI.rowHTML(SLOT_LABEL[slot], UI.esc(partName(part)), `${shield}/${max}`, shield < max)),
  ];
  UI.listPanel('정비 대상', rows,
    `<p class="note">방어도는 포션으로 돌아오지 않는다. 작업대나 여기서만 되돌릴 수 있다.<br>
     핵 체력도 런을 넘어 남는다 — 반쯤 깎인 채로 다시 내려가면 그만큼 불리하다.</p>`);

  UI.logHead('정비대');
  UI.logLine('부서진 것을 원래대로 돌리는 자리. 오래 걸리고 재료를 먹는다.', 'narrate');
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
    { label: '돌아간다', cls: 'ghost', on: ossuaryScreen },
  ]);
  save();
}

/* ── 작업반 ─────────────────────────────── */
function crewScreen() {
  const o = S.ossuary;
  UI.topbar(S, '납골당 · 작업반');
  const cs = O.crewSpeed(S);
  UI.listPanel('작업반에 세운 부속',
    o.crew.parts.map((p) => UI.rowHTML(KIND_LABEL[DB.partsBy[p.defId].slot], UI.esc(partName(p)),
      `${p.integrity}/${p.maxIntegrity}`)),
    `<p class="note">능률 ${cs.power} → 해체대·접합로 작업 시간 <b>${Math.round(cs.cut * 100)}% 단축</b> (상한 60%).<br>
     배치한 부속은 탐험에 쓸 수 없다. 내구도는 닳지 않는다.</p>`);

  UI.logHead('작업반');
  UI.logLine('부속을 세워 두면 알아서 손을 놀린다. 능력치가 좋을수록 일이 빨라진다.', 'narrate');

  const equipped = new Set(SLOTS.map((x) => S.golem[x]).filter(Boolean));
  const inLabor = new Set((o.laborBay?.dispatch ?? []).flatMap((d) => d.parts.map((p) => p.uid)));
  const pool = S.inventory.filter((p) => !equipped.has(p.uid) && !inLabor.has(p.uid)
    && !o.crew.parts.some((c) => c.uid === p.uid));

  UI.choices([
    ...o.crew.parts.map((p) => ({
      label: `${partName(p)} 회수`, cls: 'ghost', on: () => {
        o.crew.parts = o.crew.parts.filter((x) => x.uid !== p.uid);
        S.inventory.push(p);
        crewScreen();
      },
    })),
    ...pool.slice(0, 6).map((p) => {
      const st = partStats(p);
      return {
        label: `${partName(p)} 배치`,
        meta: `공${st.atk} 방${st.def} 속${st.spd} 집${st.focus}`,
        on: () => {
          S.inventory = S.inventory.filter((x) => x.uid !== p.uid);
          o.crew.parts.push(p);
          UI.logLine(`${partName(p)}을(를) 작업반에 세웠다.`, 'good');
          crewScreen();
        },
      };
    }),
    { label: '돌아간다', cls: 'ghost', on: ossuaryScreen },
  ]);
  save();
}

/* ── 접합로 ─────────────────────────────── */
function forgeJobScreen() {
  const o = S.ossuary;
  UI.topbar(S, '납골당 · 접합로');
  UI.ossuaryPanel(S, O);
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
  if (free <= 0) UI.logLine('접합로가 꽉 찼다.', 'bad');
  else if (!spareCount) UI.logLine('재료로 쓸 여분 파츠가 없다.', 'dim');

  const rawCount = S.inventory.filter((p) => p.raw && !equippedF.has(p.uid)).length;
  const damagedCount = S.inventory.filter((p) => p.integrity < p.maxIntegrity && !equippedF.has(p.uid)).length;
  const affordable = (r) => Object.entries(r.cost).every(([k, v]) => (S[k] ?? 0) >= v);
  const costText = (r) => Object.entries(r.cost)
    .map(([k, v]) => `${O.RES_LABEL[k]} ${v}`).join(' · ');

  UI.choices([
    ...Object.entries(O.RECIPES).map(([key, r]) => ({
      label: `${r.name}`,
      meta: `${Math.round(r.ms / 60000)}분 · ${costText(r)}`,
      disabled: free <= 0 || !affordable(r)
        || (key === 'revive' ? !o.vault.lostRecords.length
          : key === 'attune' ? rawCount < 1
          : key === 'mend' ? damagedCount < 1
          : spareCount < (key === 'fuse' ? 2 : 1)),
      on: () => recipeScreen(key),
    })),
    { label: '돌아간다', cls: 'ghost', on: ossuaryScreen },
  ]);
  save();
}

function recipeScreen(key, first = null) {
  const o = S.ossuary;
  const r = O.RECIPES[key];
  UI.topbar(S, `접합로 · ${r.name}`);
  UI.ossuaryPanel(S, O);
  UI.logLine(r.desc, 'dim');

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
      ...o.vault.lostRecords.slice(0, 6).map((defId) => ({
        label: `${DB.partsBy[defId]?.name_template.replace('{mod}', '').replace('{owner}', DB.partsBy[defId].owner ?? '').trim()} 소생`,
        on: () => {
          o.vault.lostRecords = o.vault.lostRecords.filter((x) => x !== defId);
          start([], { defId });
        },
      })),
      { label: '돌아간다', cls: 'ghost', on: forgeJobScreen },
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
    ...pool.slice(0, 7).map((p) => ({
      label: partName(p),
      meta: `${DB.partsBy[p.defId].slot} · ${p.integrity}/${p.maxIntegrity}`,
      on: () => {
        if (key !== 'fuse') { start([p]); return; }
        if (!first) { recipeScreen(key, p); return; }
        start([first, p], {
          skillsA: partSkills(first).slice(0, 1),
          skillsB: partSkills(p).slice(0, 1),
        });
      },
    })),
    { label: '돌아간다', cls: 'ghost', on: forgeJobScreen },
  ]);
}

/* ── 사역 골렘 파견 ─────────────────────── */
function laborScreen() {
  const o = S.ossuary;
  UI.topbar(S, '납골당 · 사역 골렘 안치소');
  UI.ossuaryPanel(S, O);
  UI.logHead('사역 골렘 안치소');
  UI.logLine('파견 보낸 골렘의 파츠는 탐험에 쓸 수 없다. 그리고 파견은 내구도를 갉아먹는다.', 'narrate');
  for (const d of o.laborBay.dispatch) {
    UI.logLine(`${O.SITES[d.site].name} — ${d.parts.map((p) => `${partName(p)} ${p.integrity}/${p.maxIntegrity}`).join(', ')}`, 'dim');
  }
  const free = O.laborSlots(o) - o.laborBay.dispatch.length;
  const equippedL = new Set(SLOTS.map((x) => S.golem[x]).filter(Boolean));
  const inLaborL = new Set(o.laborBay.dispatch.flatMap((d) => d.parts.map((p) => p.uid)));
  const availL = S.inventory.filter((p) => !equippedL.has(p.uid) && !inLaborL.has(p.uid)).length;
  if (!availL) UI.logLine('파견 보낼 여분 파츠가 없다.', 'dim');

  UI.choices([
    ...o.laborBay.dispatch.map((d) => ({
      label: `${O.SITES[d.site].name} 파견 회수`, cls: 'ghost', on: () => {
        for (const p of d.parts) S.inventory.push(p);
        o.laborBay.dispatch = o.laborBay.dispatch.filter((x) => x !== d);
        UI.logLine('사역 골렘을 회수했다.', 'good');
        laborScreen();
      },
    })),
    ...Object.entries(O.SITES).map(([key, site]) => ({
      label: `${site.name}으로(로) 파견`,
      meta: site.need ? `${STAT_LABEL[Object.keys(site.need)[0]]} ${Object.values(site.need)[0]}+` : '조건 없음',
      disabled: free <= 0 || !availL,
      on: () => dispatchPick(key),
    })),
    { label: '돌아간다', cls: 'ghost', on: ossuaryScreen },
  ]);
  save();
}

function dispatchPick(siteKey, chosen = []) {
  const o = S.ossuary;
  const site = O.SITES[siteKey];
  UI.topbar(S, `파견 · ${site.name}`);
  const equipped = new Set(SLOTS.map((x) => S.golem[x]).filter(Boolean));
  const inLabor = new Set(o.laborBay.dispatch.flatMap((d) => d.parts.map((p) => p.uid)));
  const pool = S.inventory.filter((p) => !equipped.has(p.uid) && !inLabor.has(p.uid)
    && !chosen.some((c) => c.uid === p.uid));

  const stats = { atk: 0, def: 0, spd: 0 };
  for (const p of chosen) {
    const st = partStats(p);
    stats.atk += st.atk; stats.def += st.def; stats.spd += st.spd;
  }
  const needKey = site.need ? Object.keys(site.need)[0] : null;
  const ready = O.siteReady(site, stats);

  UI.listPanel(`${site.name}에 보낼 파츠`,
    chosen.map((p) => UI.rowHTML(DB.partsBy[p.defId].slot, UI.esc(partName(p)), `${p.integrity}/${p.maxIntegrity}`)),
    `<p class="note">공격 ${stats.atk} · 방어 ${stats.def} · 속도 ${stats.spd}<br>
     ${site.need ? `요구: ${STAT_LABEL[needKey]} ${Object.values(site.need)[0]} — ${ready ? '충족' : '미달'}` : '요구 조건 없음'}<br>
     산출: ${Object.entries(site.rate).map(([k, v]) => `${O.RES_LABEL[k]} ${v}/시간`).join(', ')}
     ${site.wear ? `<br>내구도: ${site.wear}시간마다 1 감소` : ''}</p>`);

  UI.logLine(chosen.length ? '더 보낼 파츠를 고르거나 파견을 시작한다.' : '파견할 파츠를 고른다.', 'dim');
  UI.choices([
    { label: '파견 시작', cls: 'primary', disabled: !chosen.length || !ready, on: () => {
      for (const p of chosen) S.inventory = S.inventory.filter((x) => x.uid !== p.uid);
      o.laborBay.dispatch.push({
        site: siteKey, parts: chosen, startedAt: Date.now(), wearClock: 0,
        statValue: needKey ? stats[needKey] : stats.atk,
      });
      UI.logLine(`${site.name}으로(로) 사역 골렘을 보냈다.`, 'good');
      laborScreen();
    } },
    ...pool.slice(0, 6).map((p) => {
      const st = partStats(p);
      return {
        label: `${partName(p)} 추가`,
        meta: `공${st.atk} 방${st.def} 속${st.spd}`,
        on: () => dispatchPick(siteKey, [...chosen, p]),
      };
    }),
    { label: '취소', cls: 'ghost', on: laborScreen },
  ]);
}

/* ── 제단 (영구 해금) ───────────────────── */
function altarScreen() {
  const o = S.ossuary;
  UI.topbar(S, '납골당 · 제단');
  UI.ossuaryPanel(S, O);
  UI.logHead('제단');
  UI.logLine('영혼재는 오직 무덤에서만 나온다. 여기서 그것을 태워 영구적인 것을 산다.', 'narrate');

  const buy = (label, cost, meta, fn, disabled = false) => ({
    label, meta: meta ?? `영혼재 ${cost}`,
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
  if (o.built.forge && o.forge.level < 3) {
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
  if (S.unlocks.vaultStart < 3) {
    const c = 120 * S.unlocks.vaultStart;
    list.push(buy(`표본 지참 수 (${S.unlocks.vaultStart} → ${S.unlocks.vaultStart + 1}개)`, c, `영혼재 ${c}`,
      () => { S.unlocks.vaultStart++; }));
  }
  if (S.unlocks.necroSlots < 5) {
    const c = 150 * (S.unlocks.necroSlots - 2);
    list.push(buy(`술법 장착 칸 (${S.unlocks.necroSlots} → ${S.unlocks.necroSlots + 1})`, c, `영혼재 ${c}`,
      () => { S.unlocks.necroSlots++; S.necro.equipped.push(null); }));
  }
  list.push({ label: '돌아간다', cls: 'ghost', on: ossuaryScreen });
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
    { label: '돌아간다', cls: 'ghost', on: () => town(false) },
  ]);
  save();
}

/* ── 상점 ───────────────────────────────── */
function shopScreen() {
  UI.topbar(S, '시체골 · 썩은 손수레');
  const stock = S.town.stock;
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
      UI.esc(partName(p)), money(partPrice(p)))),
  ];
  UI.listPanel('오늘의 재고', rows, `<p class="note">쓰지 않는 파츠는 팔아서 은화로 바꿀 수 있다.</p>`);

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
  list.push({ label: '파츠 팔기', on: sellScreen });
  list.push({ label: '돌아간다', cls: 'ghost', on: () => town(false) });
  UI.choices(list);
  save();
}

function sellScreen() {
  UI.topbar(S, '시체골 · 파츠 판매');
  const equipped = new Set(SLOTS.map((s) => S.golem[s]).filter(Boolean));
  const sellable = S.inventory.filter((p) => !equipped.has(p.uid));
  UI.listPanel('팔 수 있는 파츠',
    sellable.map((p) => UI.rowHTML(KIND_LABEL[DB.partsBy[p.defId].slot], UI.esc(partName(p)),
      `${p.integrity}/${p.maxIntegrity} · ${sellPrice(p)}`)),
    '<p class="note">장착 중인 파츠는 팔 수 없다.</p>');
  UI.logLine('무엇을 넘길까.', 'dim');
  UI.choices([
    ...sellable.slice(0, 8).map((p) => ({
      label: `${partName(p)} 판매`, meta: money(sellPrice(p)), on: () => {
        S.silver += sellPrice(p);
        S.inventory = S.inventory.filter((x) => x.uid !== p.uid);
        UI.logLine(`${partName(p)}을(를) 넘겼다. (+${sellPrice(p)})`, 'good');
        notifyQuests({ kind: 'dismantle', count: 1 });
        sellScreen();
      },
    })),
    { label: '돌아간다', cls: 'ghost', on: shopScreen },
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
      list.push({ label: `${a.name} 제작`, meta: money(a.price), disabled: !canCraft(S, a), on: () => {
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
  list.push({ label: '속성 도가니 · 스킬 속성 변경', meta: money(cru.price),
    disabled: !canCraft(S, cru), on: retuneScreen });
  list.push({ label: '돌아간다', cls: 'ghost', on: () => town(false) });
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
    pool.map((p) => UI.rowHTML(KIND_LABEL[DB.partsBy[p.defId].slot], UI.esc(partName(p)),
      `+${p.upgrade ?? 0} → +${(p.upgrade ?? 0) + 1}`)),
    `<p class="note">강화 한 단계마다 모든 능력치 +8%, 최대 +${O.UPGRADE_MAX}.<br>
     맡기면 시간이 걸리고, 그동안 그 부속은 쓸 수 없다.</p>`);
  UI.logHead('파츠 강화');
  UI.logLine('대장장이가 부속을 받아 들고 무게를 가늠한다.', 'narrate');
  if (!pool.length) UI.logLine('강화할 여분 부속이 없다. 장착 중인 것은 먼저 떼어내야 한다.', 'dim');

  UI.choices([
    ...pool.slice(0, 7).map((p) => {
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
    { label: '돌아간다', cls: 'ghost', on: forgeScreen },
  ]);
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
    { label: '돌아간다', cls: 'ghost', on: forgeScreen },
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
  list.push({ label: '돌아간다', cls: 'ghost', on: () => town(false) });
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
    { label: '돌아간다', cls: 'ghost', on: () => back(false) },
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
        if (S.golem.core) S.cores.push(S.golem.core);
        S.cores = S.cores.filter((x) => x !== cid);
        S.golem.core = cid;
        UI.logLine(`${c.name}을(를) 골렘 가슴에 앉혔다.`, 'good');
        golemScreen(back, canEdit);
      } };
    }),
    { label: '돌아간다', cls: 'ghost', on: () => golemScreen(back, canEdit) },
  ]);
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
    ...options.slice(0, 8).map((p) => {
      const st = partStats(p);
      const gain = partSkills(p).map((s) => DB.skillsBy[s].name).join(', ');
      return {
        label: partName(p),
        meta: `${p.raw ? '날것 · ' : ''}공${st.atk >= 0 ? '+' : ''}${st.atk} 체${st.hp >= 0 ? '+' : ''}${st.hp} · ${p.integrity}/${p.maxIntegrity}`,
        on: () => {
          S.golem[slot] = p.uid;
          const after = assembleGolem(S);
          UI.logLine(`${partName(p)}을(를) ${SLOT_LABEL[slot]}에 붙였다.`, 'good');
          if (p.raw) UI.logLine('아직 정착되지 않은 날것이다. 성능 60%, 기술 불발 25%, 내구도 2배 소모.', 'bad');
          if (gain) UI.logLine(`새 스킬: ${gain}`, 'good');
          warnCoverage(before, after);
          golemScreen(back, canEdit);
        },
      };
    }),
    cur && slot !== 'body' ? { label: '떼어낸다', cls: 'danger', on: () => {
      S.golem[slot] = null;
      UI.logLine(`${SLOT_LABEL[slot]}을(를) 비웠다.`, 'dim');
      golemScreen(back, canEdit);
    } } : null,
    { label: '돌아간다', cls: 'ghost', on: () => golemScreen(back, canEdit) },
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
    { label: '돌아간다', cls: 'ghost', on: () => golemScreen(back, canEdit) },
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
  const parts = S.inventory.map((p) => UI.rowHTML(
    KIND_LABEL[DB.partsBy[p.defId].slot],
    `${equipped.has(p.uid) ? '<span class="chip good">장착</span> ' : ''}${p.raw ? '<span class="chip warn">날것</span> ' : ''}${UI.esc(partName(p))}`,
    `${p.integrity}/${p.maxIntegrity}`, p.integrity <= 2));
  const rows = [...mats, ...items, ...parts];
  UI.listPanel(`가진 것 — 파츠 ${S.inventory.length}개`, rows);
  UI.logLine(`재료: 조각 ${S.scrap} · 진액 ${S.ichor} · 골분 ${S.boneMeal} / 은화 ${S.silver} · 영혼재 ${S.soulAsh}`, 'dim');
  UI.choices([
    { label: '재화가 뭔지 보기', cls: 'ghost', on: () => resourceGuideScreen(() => inventoryScreen(back)) },
    ...S.inventory.filter((p) => p.integrity < p.maxIntegrity && S.consumables.it_bitumen > 0)
      .slice(0, 6).map((p) => ({
        label: `${partName(p)}에 역청`, meta: `+3 (${S.consumables.it_bitumen}개 남음)`, on: () => {
          S.consumables.it_bitumen--;
          p.integrity = Math.min(p.maxIntegrity, p.integrity + 3);
          UI.logLine(`${partName(p)}의 내구도를 메웠다. (${p.integrity}/${p.maxIntegrity})`, 'good');
          inventoryScreen(back);
        },
      })),
    { label: '돌아간다', cls: 'ghost', on: () => back(false) },
  ]);
}

/* ── 런 시작 ────────────────────────────── */
function startRun() {
  if (!S.golem.core) {
    UI.logLine('골렘 핵이 없다. 핵 없이는 골렘이 서지 못한다.', 'bad');
    UI.logLine('상점에서 사거나, 뼈 수습꾼을 찾아가 보라.', 'dim');
    return;
  }
  if (!S.golem.body) { UI.logLine('몸통 없이는 내려갈 수 없다.', 'bad'); return; }
  if (wornCount() < MIN_PARTS) {
    UI.logLine(`부속이 ${wornCount()}개뿐이다. 최소 ${MIN_PARTS}개는 끼워야 골렘이 움직인다.`, 'bad');
    UI.logLine('골렘 정비에서 더 끼우거나, 뼈 수습꾼에게 부속을 얻어라.', 'dim');
    return;
  }
  const vault = S.ossuary.vault;
  if (vault.parts.length) {
    const bring = vault.parts.slice(0, S.unlocks.vaultStart);
    vault.parts = vault.parts.filter((p) => !bring.includes(p));
    for (const p of bring) {
      p.integrity = Math.max(1, Math.round(p.maxIntegrity / 2)); // 표본은 절반 상태로 나온다 (§8)
      S.inventory.push(p);
    }
    UI.logLine(`표본실에서 ${bring.map(partName).join(', ')}을(를) 챙겼다.`, 'good');
  }
  const g = assembleGolem(S);
  const seed = Math.floor(Math.random() * 1e9);
  S.run = {
    seed, floor: 1, golemHp: S.golem.coreHp ?? g.stats.hp, rooms: 0,
    noLoss: true, kills: 0, summons: 0, cleanWins: 0,
    floorData: null,
  };
  S.run.floorData = generateFloor(seed, 1);
  S.log.runs++;
  UI.clearLog();
  UI.logHead('무덤 1층');
  UI.logLine('사다리가 끝나는 곳에서 흙냄새가 올라온다. 골렘이 먼저 발을 디딘다.', 'narrate');
  enterRoom(roomAt(S.run.floorData, S.run.floorData.pos), true);
}

function nextFloor() {
  S.run.floor++;
  if (S.run.floor > 3) { runComplete(); return; }
  S.run.floorData = generateFloor(S.run.seed + S.run.floor * 104729, S.run.floor);
  UI.logHead(`무덤 ${S.run.floor}층`);
  UI.logLine('계단이 더 깊은 어둠으로 이어진다. 공기가 차가워졌다.', 'narrate');
  enterRoom(roomAt(S.run.floorData, S.run.floorData.pos), true);
}

function runComplete() {
  const ash = 60 + S.run.kills * 4;
  S.soulAsh += ash;
  S.silver += 150;
  UI.logHead('귀환');
  UI.logLine('무덤 바닥을 보았다. 골렘은 아직 서 있다.', 'narrate');
  UI.logLine(`영혼재 ${ash}, 은화 150을 가지고 돌아왔다.`, 'good');
  S.run = null;
  S.town.stock = rollStock(rng);
  UI.choices([{ label: '마을로', cls: 'primary', on: () => settleAndReport(() => town()) }]);
  save();
}

/* ── 방 진입 ────────────────────────────── */
function enterRoom(room, first = false) {
  const fd = S.run.floorData;
  fd.pos = room.id;
  if (!room.visited) { room.visited = true; S.run.rooms++; notifyQuests({ kind: 'progress', rooms: S.run.rooms }); }
  room.seen = true;
  for (const { room: nb } of exitsOf(fd, room.id)) nb.seen = true;

  UI.topbar(S, `무덤 ${fd.floor}층 · ${ROOM_LABEL[room.type]}`);
  UI.dungeonPanel(S, fd);

  if (!first) UI.logLine(`${ROOM_ICON[room.type]} ${ROOM_LABEL[room.type]}에 들어섰다.`, 'dim');
  if (!room.cleared) {
    const f = FLAVOR[room.type];
    if (f) UI.logLine(rng.pick(f), 'narrate');
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
      case 'workshop': room.cleared = true; break;
      default: room.cleared = true;
    }
  }
  roomChoices(room);
}

function roomChoices(room) {
  const fd = S.run.floorData;
  const exits = exitsOf(fd, room.id);
  const ARROW = { 위: '↑', 오른쪽: '→', 아래: '↓', 왼쪽: '←' };
  const list = exits.map((e) => ({
    label: `${ARROW[e.dir]} ${e.dir}`,
    meta: e.room.visited ? ROOM_LABEL[e.room.type] : '미탐험',
    on: () => enterRoom(e.room),
  }));

  if (room.type === 'workshop') {
    list.push({ label: '작업대에서 정비', cls: 'primary', on: () => golemScreen(backToRoom, true) });
    list.push({ label: '방어도 수리', cls: 'primary', meta: '시체 조각', on: repairScreen });
  }
  list.push({ label: '골렘 상태', cls: 'ghost', on: () => golemScreen(backToRoom, false) });
  list.push({ label: '소지품', cls: 'ghost', on: () => inventoryScreen(backToRoom) });
  if (S.consumables.it_sigil_return > 0) {
    list.push({ label: '귀환의 문양 사용', cls: 'ghost', on: () => {
      S.consumables.it_sigil_return--;
      UI.logLine('문양이 타오르고, 시야가 뒤집힌다.', 'necro');
      abandonRun(true);
    } });
  }
  UI.choices(list);
  // 선택지를 그린 뒤에 켜야 한다 (choices가 매번 초기화한다)
  setArrowMoves(Object.fromEntries(exits.map((e) => [e.dir, () => enterRoom(e.room)])));
  save();
}

/** 작업대 방에서 방어도를 즉석 수리한다. 재료를 먹고 시간은 걸리지 않는다 */
function repairScreen() {
  const g = assembleGolem(S);
  const fd = S.run.floorData;
  UI.topbar(S, `무덤 ${fd.floor}층 · 방어도 수리`);
  UI.dungeonPanel(S, fd);
  UI.logHead('방어도 수리');
  UI.logLine('녹슨 도구로 이음새를 조인다. 깎인 방어도를 조금은 되돌릴 수 있다.', 'narrate');

  const COST_PER = 1;          // 방어도 15당 시체 조각 1
  const rows = g.worn.map(({ slot, part, shieldMax: max, shield: cur }) => {
    const missing = max - cur;
    const cost = Math.max(1, Math.ceil((missing / 15) * COST_PER));
    return { slot, part, max, cur, missing, cost };
  }).filter((r) => r.missing > 0);

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
        repairScreen();
      },
    })),
    rows.length > 1 ? { label: '전부 수리', cls: 'primary',
      meta: `조각 ${rows.reduce((n, r) => n + r.cost, 0)}`,
      disabled: S.scrap < rows.reduce((n, r) => n + r.cost, 0),
      on: () => {
        for (const r of rows) { S.scrap -= r.cost; r.part.shield = r.max; }
        UI.logLine('모든 부위의 방어도를 되돌렸다.', 'good');
        repairScreen();
      } } : null,
    { label: '돌아간다', cls: 'ghost', on: backToRoom },
  ]);
  save();
}

const backToRoom = () => {
  const fd = S.run.floorData;
  UI.topbar(S, `무덤 ${fd.floor}층`);
  UI.dungeonPanel(S, fd);
  roomChoices(roomAt(fd, fd.pos));
};

/* ── 방 종류별 처리 ─────────────────────── */
function bonesRoom(room) {
  const r = makeRng(S.run.seed + room.x * 31 + room.y * 17);
  const scrap = r.int(4, 9) + S.run.floor * 2;
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
    { label: '돌아간다', cls: 'ghost', on: () => { room.cleared = false; roomChoices(room); } },
  ]);
}

function restRoom(room) {
  const g = assembleGolem(S);
  UI.logLine('벽감의 초에 불을 붙인다. 잠시 숨을 돌릴 수 있다.', 'narrate');
  const damaged = g.worn.filter(({ part }) => part.integrity < part.maxIntegrity);
  UI.choices([
    { label: '휴식 — 핵 체력 30% 회복', on: () => {
      const amt = Math.round(g.stats.hp * 0.3);
      S.run.golemHp = Math.min(g.stats.hp, S.run.golemHp + amt);
      S.golem.coreHp = S.run.golemHp;
      UI.logLine(`핵의 박동이 고르게 돌아온다. (+${amt})`, 'good');
      room.cleared = true; UI.dungeonPanel(S, S.run.floorData); roomChoices(room);
    } },
    ...damaged.slice(0, 4).map(({ part }) => ({
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
      ...spare.slice(0, 4).map((p) => ({
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
  const r = makeRng(S.run.seed + room.x * 977 + room.y * 131 + S.run.floor);
  const mon = isBoss ? rollBoss(S.run.floor, r)
    : elite ? rollElite(S.run.floor, r)
    : rollMonster(S.run.floor, r);
  cb = new Combat(S, mon, r);
  cb.room = room;
  if (S.run.curse) {
    cb.golem.ranks.atk = -1;
    cb.say('영혼의 소용돌이가 아직 골렘에 감겨 있다. (공격 -1)', 'bad');
    S.run.curse = false;
  }
  UI.logHead(isBoss ? '층의 주인' : elite ? '엘리트 전투' : '전투');
  UI.logAll(cb.log);
  if (!S.log.hintAim) {
    S.log.hintAim = true;
    UI.logLine('— 처음이니 한 번만 짚는다 —', 'necro');
    UI.logLine('피해는 핵이 아니라 부속의 방어도부터 깎는다. 방어도가 다 닳아야 핵이 맞는다.', 'necro');
    UI.logLine('🎯 조준으로 적의 부위를 노릴 수 있다. 부수면 적이 약해지지만 그 부속은 못 얻는다.', 'necro');
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
      on: () => resolve({ kind: 'skill', id: s.id }),
    });
  }
  for (const n of cb.necroSkills()) {
    list.push({
      label: `🕯 ${n.name}`,
      meta: n.cd > 0 ? `재사용 ${n.cd}턴` : `영력 ${n.will}`,
      disabled: !n.usable,
      on: () => resolve({ kind: 'necro', id: n.id }),
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

function resolve(action) {
  const before = cb.summonCount;
  cb.act(action);
  UI.logAll(cb.log);
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
      p.integrity -= p.raw ? RAW_WEAR : 1;
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
        notifyQuests({ kind: 'loot', slot: DB.partsBy[p.defId].slot, mod: p.mod });
        afterBattle(isBoss, room);
      },
    })),
    { label: '아무것도 가져가지 않는다', cls: 'ghost', on: () => afterBattle(isBoss, room) },
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

  // 몸통은 비울 수 없는 슬롯이다 (§3.1). 예비가 있으면 갈아끼우고, 없으면 골렘이 서지 못한다.
  if (!lostBody) return;
  const spare = S.inventory.find((x) => DB.partsBy[x.defId].slot === 'body');
  if (spare) {
    S.golem.body = spare.uid;
    UI.logLine(`몸통이 사라졌다. 급히 ${partName(spare)}을(를) 끼워 넣는다.`, 'necro');
    if (S.run) S.run.golemHp = Math.min(S.run.golemHp, assembleGolem(S).stats.hp);
  } else if (S.run) {
    S.run.collapsed = true;
  }
}

/** 몸통을 잃어 골렘이 더 이상 설 수 없는 경우 */
function collapseRun() {
  UI.logHead('해체');
  UI.logLine('몸통을 잃은 골렘이 주저앉는다. 끼워 넣을 흉곽이 남아 있지 않다.', 'narrate');
  const r = dismantleGolem();
  reportDismantle(r);
  const ash = 15 + S.run.kills * 3;
  S.soulAsh += ash;
  UI.logLine(`영혼재 ${ash}를 정산했다.`, 'dim');
  S.run = null;
  S.town.stock = rollStock(rng);
  UI.choices([{ label: '마을로 돌아간다', cls: 'primary', on: () => settleAndReport(() => town()) }]);
  save();
}

/**
 * 골렘이 부서졌다. 핵은 깨지고 장착 부속은 흩어진다.
 * 도망치며 주울 수 있는 것만 건진다 — 성한 부속일수록 잘 건진다.
 */
function dismantleGolem() {
  const g = assembleGolem(S);
  const kept = [], lost = [];
  for (const { slot, part } of g.worn) {
    const ratio = part.maxIntegrity ? part.integrity / part.maxIntegrity : 0;
    const chance = Math.round(20 + 45 * ratio);   // 20~65%
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
  const brokenCore = S.golem.core;
  S.golem.core = null;
  S.golem.attachments = [];
  return { kept, lost, brokenCore };
}

function reportDismantle(r) {
  if (r.brokenCore) UI.logLine(`${DB.coresBy[r.brokenCore].name}이(가) 쪼개졌다. 골렘은 더 이상 없다.`, 'bad');
  if (r.kept.length) UI.logLine(`흩어진 것 중 ${r.kept.map(partName).join(', ')}을(를) 급히 주워 담았다.`, 'good');
  if (r.lost.length) UI.logLine(`${r.lost.map(partName).join(', ')}은(는) 그 자리에 남겨두고 왔다.`, 'bad');
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
  S.town.stock = rollStock(rng);
  UI.choices([{ label: '마을로 돌아간다', cls: 'primary', on: () => settleAndReport(() => town()) }]);
  save();
}

function abandonRun(safe) {
  const ash = (safe ? 30 : 10) + S.run.kills * 3;
  S.soulAsh += ash;
  UI.logLine(`영혼재 ${ash}를 정산했다.`, 'good');
  S.run = null;
  S.town.stock = rollStock(rng);
  UI.choices([{ label: '마을로', cls: 'primary', on: () => settleAndReport(() => town()) }]);
  save();
}

/* ── 의뢰 알림 ──────────────────────────── */
function notifyQuests(ev) {
  const done = advanceQuests(S, ev);
  for (const q of done) UI.logLine(`📜 의뢰 완료 — ${q.title}`, 'necro');
  if (done.length && questsAllDone(S)) UI.logLine('📜 의뢰 세 건을 모두 마쳤다. 의뢰소로.', 'necro');
}

/* ── 부팅 ───────────────────────────────── */
async function boot() {
  try {
    await loadData();
    O.bindStats(partStats);   // 작업반 능률 계산에 파츠 스탯을 넘긴다
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
