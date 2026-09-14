/** 게임 진행 · 화면 전환 · 세이브 */
import {
  DB, loadData, makeRng, makePart, partName, partStats, partSkills,
  assembleGolem, SLOTS, SLOT_LABEL, SLOT_KIND, SKILL_CAP,
  rollMonster, rollElite, rollLoot, syncUidSeq, skillElement,
} from './core.js';
import { Combat } from './combat.js';
import { generateFloor, roomAt, exitsOf, ROOM_LABEL, ROOM_ICON, FLAVOR } from './dungeon.js';
import {
  rollQuests, advanceQuests, questsAllDone, claimQuests, resetQuests,
  nextResetCost, rollStock, partPrice, sellPrice, canCraft, craft,
  canLearn, learn, buildingStatus, ATTACH_SLOTS,
} from './town.js';
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
      head: null, body: starter[0].uid, armL: starter[1].uid, armR: null, leg: starter[2].uid,
      attachments: [], banned: [], retuned: {},
    },
    consumables: { it_corpseoil: 2 },
    owned: { attachments: [] },
    necro: { known: ['nk_bonemend', 'nk_skeleton', 'nk_soulspear'],
             equipped: ['nk_bonemend', 'nk_skeleton', 'nk_soulspear'] },
    quests: { active: rollQuests(r), resets: 0 },
    town: { stock: rollStock(r) },
    seen: {}, run: null,
    log: { runs: 0, kills: 0, lost: 0 },
  };
}

function save() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(S)); } catch { /* 저장 불가 환경 */ }
}
function load() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (s.version !== 1) return null;
    let max = 0;
    for (const p of s.inventory) max = Math.max(max, Number(String(p.uid).slice(1)) || 0);
    syncUidSeq(max + 1);
    return s;
  } catch { return null; }
}

const KIND_LABEL = { head: '머리', body: '몸통', arm: '팔', leg: '다리' };
const money = (n) => `은화 ${n}`;
const findPart = (uid) => S.inventory.find((p) => p.uid === uid);

/* ── 마을 ───────────────────────────────── */
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
    { label: '의뢰소', meta: questsAllDone(S) ? '수령 가능' : `${S.quests.active.filter((q) => q.done).length}/3`, on: questScreen },
    { label: '썩은 손수레', meta: '상점', on: shopScreen },
    { label: '뼈 모루', meta: '대장간', on: forgeScreen },
    { label: '강령술사 조합', meta: '술법', on: conclaveScreen },
    { label: '골렘 정비', on: golemScreen },
    { label: '소지품', on: inventoryScreen },
    { label: '무덤으로 내려간다', cls: 'primary', on: startRun },
    { label: '저장', cls: 'ghost', on: () => { save(); UI.logLine('기록을 남겼다.', 'dim'); } },
  ]);
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
  list.push({ label: '속성 도가니 · 스킬 속성 변경', meta: money(cru.price),
    disabled: !canCraft(S, cru), on: retuneScreen });
  list.push({ label: '돌아간다', cls: 'ghost', on: () => town(false) });
  UI.choices(list);
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
    `<p class="note">한 번에 3개까지 들고 갈 수 있다. 영력은 전투 시작 3, 매 턴 +1.</p>`);

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
      list.push({ label: `${n.name} 장착`, meta: `${eq.length}/3`, disabled: eq.length >= 3, on: () => {
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
function golemScreen(back = town) {
  UI.topbar(S, '골렘 정비');
  UI.golemPanel(S);
  const g = assembleGolem(S);
  if (g.over) UI.logLine(`스킬이 ${g.active.length}개다. ${SKILL_CAP}개를 넘으면 일부를 봉인해야 한다.`, 'bad');
  UI.choices([
    ...SLOTS.map((slot) => ({ label: `${SLOT_LABEL[slot]} 교체`, on: () => slotScreen(slot, back) })),
    g.skills.length > SKILL_CAP ? { label: '스킬 봉인 관리', on: () => banScreen(back) } : null,
    { label: '돌아간다', cls: 'ghost', on: () => back(false) },
  ]);
  save();
}

function slotScreen(slot, back) {
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
        meta: `공${st.atk >= 0 ? '+' : ''}${st.atk} 체${st.hp >= 0 ? '+' : ''}${st.hp} · ${p.integrity}/${p.maxIntegrity}`,
        on: () => {
          S.golem[slot] = p.uid;
          const after = assembleGolem(S);
          UI.logLine(`${partName(p)}을(를) ${SLOT_LABEL[slot]}에 붙였다.`, 'good');
          if (gain) UI.logLine(`새 스킬: ${gain}`, 'good');
          warnCoverage(before, after);
          golemScreen(back);
        },
      };
    }),
    cur && slot !== 'body' ? { label: '떼어낸다', cls: 'danger', on: () => {
      S.golem[slot] = null;
      UI.logLine(`${SLOT_LABEL[slot]}을(를) 비웠다.`, 'dim');
      golemScreen(back);
    } } : null,
    { label: '돌아간다', cls: 'ghost', on: () => golemScreen(back) },
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

function banScreen(back) {
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
          banScreen(back);
        },
      };
    }),
    { label: '돌아간다', cls: 'ghost', on: () => golemScreen(back) },
  ]);
}

function inventoryScreen() {
  UI.topbar(S, '소지품');
  const rows = [
    ...Object.entries(S.consumables).filter(([, n]) => n > 0)
      .map(([id, n]) => UI.rowHTML(DB.itemsBy[id].kind, UI.esc(DB.itemsBy[id].name), `${n}개`)),
    ...S.inventory.map((p) => UI.rowHTML(KIND_LABEL[DB.partsBy[p.defId].slot], UI.esc(partName(p)),
      `${p.integrity}/${p.maxIntegrity}`, p.integrity <= 2)),
  ];
  UI.listPanel('가진 것', rows);
  UI.choices([
    ...S.inventory.filter((p) => p.integrity < p.maxIntegrity && S.consumables.it_bitumen > 0)
      .slice(0, 6).map((p) => ({
        label: `${partName(p)}에 역청`, meta: `+3 (${S.consumables.it_bitumen}개 남음)`, on: () => {
          S.consumables.it_bitumen--;
          p.integrity = Math.min(p.maxIntegrity, p.integrity + 3);
          UI.logLine(`${partName(p)}의 내구도를 메웠다. (${p.integrity}/${p.maxIntegrity})`, 'good');
          inventoryScreen();
        },
      })),
    { label: '돌아간다', cls: 'ghost', on: () => town(false) },
  ]);
}

/* ── 런 시작 ────────────────────────────── */
function startRun() {
  const g = assembleGolem(S);
  if (!S.golem.body) { UI.logLine('몸통 없이는 내려갈 수 없다.', 'bad'); return; }
  const seed = Math.floor(Math.random() * 1e9);
  S.run = {
    seed, floor: 1, golemHp: g.stats.hp, rooms: 0,
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
  UI.choices([{ label: '마을로', cls: 'primary', on: () => town() }]);
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
  const list = exits.map((e) => ({
    label: `${e.dir}으로`,
    meta: e.room.visited ? ROOM_LABEL[e.room.type] : '미탐험',
    on: () => enterRoom(e.room),
  }));
  if (room.type === 'workshop') list.push({ label: '작업대에서 정비', on: () => golemScreen(backToRoom) });
  list.push({ label: '골렘 상태', cls: 'ghost', on: () => golemScreen(backToRoom) });
  if (S.consumables.it_sigil_return > 0) {
    list.push({ label: '귀환의 문양 사용', cls: 'ghost', on: () => {
      S.consumables.it_sigil_return--;
      UI.logLine('문양이 타오르고, 시야가 뒤집힌다.', 'necro');
      abandonRun(true);
    } });
  }
  UI.choices(list);
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
    { label: '휴식 — HP 30% 회복', on: () => {
      const amt = Math.round(g.stats.hp * 0.3);
      S.run.golemHp = Math.min(g.stats.hp, S.run.golemHp + amt);
      UI.logLine(`골렘의 이음새를 조였다. (+${amt})`, 'good');
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
  const mon = elite ? rollElite(S.run.floor, r) : rollMonster(S.run.floor, r);
  if (isBoss) {
    mon.maxHp = Math.round(mon.maxHp * 1.2);
    mon.hp = mon.maxHp;
    mon.name = `층의 주인 ${mon.name}`;
  }
  cb = new Combat(S, mon, r);
  cb.room = room;
  if (S.run.curse) {
    cb.golem.ranks.atk = -1;
    cb.say('영혼의 소용돌이가 아직 골렘에 감겨 있다. (공격 -1)', 'bad');
    S.run.curse = false;
  }
  UI.logHead(elite ? '엘리트 전투' : '전투');
  UI.logAll(cb.log);
  combatTurn();
}

function combatTurn() {
  UI.topbar(S, `전투 · ${cb.mon.name}`);
  UI.combatPanel(cb, S);

  const list = [];
  for (const s of cb.golemSkills()) {
    let mark = '';
    if (s.mul != null) {
      if (s.mul > 1) mark = ' <span class="eff-up">▲</span>';
      else if (s.mul < 1) mark = ` <span class="eff-down">${s.mul === 0 ? '✕' : '▼'}</span>`;
    }
    list.push({
      label: `<span style="color:var(--el-${s.element})">${s.element}</span> ${s.name}${mark}`,
      meta: `${s.power || '—'} · ${s.charges === null ? '∞' : `${s.left}/${s.charges}`}`,
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
      p.integrity--;
      if (p.integrity <= 0) destroyPart(p);
      else if (p.integrity <= 2) UI.logLine(`⚠ ${partName(p)}의 내구도가 ${p.integrity}밖에 남지 않았다.`, 'bad');
    }
  } else UI.logLine('철제 이음쇠가 마모를 받아냈다.', 'dim');

  if (S.run.collapsed) { collapseRun(); return; }

  const silver = 20 + S.run.floor * 10 + (cb.mon.tier === 'elite' ? 40 : 0);
  S.silver += silver;
  UI.logLine(`시체에서 은화 ${silver}을 추렸다.`, 'good');

  const loot = rollLoot(cb.mon, cb.rng, 2);
  const isBoss = room.type === 'boss';
  UI.choices([
    ...loot.map((p) => ({
      label: `${partName(p)} 수습`,
      meta: `${KIND_LABEL[DB.partsBy[p.defId].slot]} · 내구 ${p.integrity}`,
      on: () => {
        S.inventory.push(p);
        UI.logLine(`${partName(p)}을(를) 챙겼다.`, 'good');
        notifyQuests({ kind: 'loot', slot: DB.partsBy[p.defId].slot, mod: p.mod });
        afterBattle(isBoss, room);
      },
    })),
    { label: '아무것도 가져가지 않는다', cls: 'ghost', on: () => afterBattle(isBoss, room) },
  ]);
}

function afterBattle(isBoss, room) {
  if (isBoss) {
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
  const ash = 15 + S.run.kills * 3;
  S.soulAsh += ash;
  UI.logLine(`남은 부속을 주워 담았다. 영혼재 ${ash}.`, 'dim');
  S.run = null;
  S.town.stock = rollStock(rng);
  UI.choices([{ label: '마을로 돌아간다', cls: 'primary', on: () => town() }]);
  save();
}

function loseRun() {
  UI.logHead('붕괴');
  UI.logLine('네크로맨서는 무너진 골렘 앞에 선다. 부속을 주울 시간은 없다.', 'narrate');
  const ash = 15 + S.run.kills * 3;
  S.soulAsh += ash;
  UI.logLine(`가까스로 영혼재 ${ash}만 챙겨 달아났다.`, 'dim');
  S.run = null;
  S.town.stock = rollStock(rng);
  UI.choices([{ label: '마을로 돌아간다', cls: 'primary', on: () => town() }]);
  save();
}

function abandonRun(safe) {
  const ash = (safe ? 30 : 10) + S.run.kills * 3;
  S.soulAsh += ash;
  UI.logLine(`영혼재 ${ash}를 정산했다.`, 'good');
  S.run = null;
  S.town.stock = rollStock(rng);
  UI.choices([{ label: '마을로', cls: 'primary', on: () => town() }]);
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
  } else {
    UI.logLine('기록을 불러왔다.', 'dim');
  }
  if (S.run) {
    UI.logLine('무덤 한가운데서 정신이 든다. 탐험이 아직 끝나지 않았다.', 'dim');
    enterRoom(roomAt(S.run.floorData, S.run.floorData.pos), true);
  } else town();
}

window.addEventListener('error', (e) => UI.logLine(`오류: ${e.message}`, 'bad'));
boot();
