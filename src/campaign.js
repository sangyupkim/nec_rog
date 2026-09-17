/** 캠페인 진행 — 3부 9단계, 해금, 메인 퀘스트 (§7-A). DOM에 의존하지 않는다. */
import { DB, stageOf, partOf } from './core.js';

/** 단계가 열려 있는가. 첫 단계는 언제나 열려 있고, 나머지는 앞 단계를 깬 뒤에 열린다. */
export function isOpen(save, id) {
  const order = DB.stageOrder ?? [];
  const i = order.indexOf(id);
  if (i <= 0) return i === 0;
  return Boolean(save.campaign?.cleared?.[order[i - 1]]);
}

export const isCleared = (save, id) => Boolean(save.campaign?.cleared?.[id]);

/** 열려 있는 단계 전부 — 이미 깬 곳도 재료를 얻으러 다시 갈 수 있다 */
export const openStages = (save) => (DB.stageOrder ?? []).filter((id) => isOpen(save, id));

/** 다음에 도전할 곳. 아직 깨지 않은 것 중 가장 앞. 전부 깼으면 null */
export function nextStage(save) {
  return (DB.stageOrder ?? []).find((id) => isOpen(save, id) && !isCleared(save, id)) ?? null;
}

/** 마을에 한 줄로 띄울 현재 목표 — 목표 부각은 이 한 줄이 8할이다 */
export function objective(save) {
  const id = nextStage(save);
  if (!id) return save.campaign?.ending ? '모든 것이 끝났다.' : '미궁의 끝에서 선택이 남았다.';
  const st = stageOf(id);
  const pt = partOf(id);
  return `${pt.name} · ${st.name} (${id})`;
}

/**
 * 지금 받아 든 의뢰문 (§7-A.6).
 * 「어디로 가서 무엇을 잡고 무엇을 가져오라」 — 목표 한 줄이 지명뿐이면 목표가 아니다.
 * 데이터(campaign.json의 stage.brief)가 말하고, 화면은 그대로 읽어 준다.
 */
export function brief(save, id = nextStage(save)) {
  if (!id) return null;
  const st = stageOf(id);
  const pt = partOf(id);
  if (!st?.brief) return null;
  return {
    id, stage: st, part: pt,
    title: `${pt.name} · ${st.name}`,
    floors: st.floors,
    hazard: hazardOf(id),
    ...st.brief,
  };
}

/** 이야기를 어디까지 들었는가 — 의뢰문에 지난 줄거리를 한 줄 얹는다 */
export function lastBeat(save) {
  const order = DB.stageOrder ?? [];
  const heard = order.filter((x) => save.campaign?.story?.[x] && DB.story?.beats?.[x]);
  const id = heard[heard.length - 1];
  return id ? { id, ...DB.story.beats[id] } : null;
}

/** 진행도 — 9단계 중 몇 개를 깼는가 */
export function progress(save) {
  const order = DB.stageOrder ?? [];
  return { done: order.filter((id) => isCleared(save, id)).length, total: order.length };
}

/**
 * 단계를 깼다. 처음이면 이야기 비트와 보상을 돌려준다.
 * 이미 깬 곳을 다시 깬 것이면 보상은 절반, 이야기는 재생하지 않는다.
 */
export function clearStage(save, id) {
  const st = stageOf(id);
  const first = !isCleared(save, id);
  save.campaign.cleared[id] = true;
  const next = nextStage(save);
  if (next) save.campaign.stage = next;

  const r = st?.reward ?? {};
  const scale = first ? 1 : 0.5;
  const reward = {
    soulAsh: Math.round((r.soulAsh ?? 0) * scale),
    silver: Math.round((r.silver ?? 0) * scale),
    core: first ? (r.core ?? null) : null,
  };
  const beat = first ? (DB.story?.beats?.[id] ?? null) : null;
  if (beat) save.campaign.story[id] = true;

  // 파트의 마지막 단계를 처음 깼다면 다음 파트가 열린다
  const pt = partOf(id);
  const isLast = pt && pt.stages[pt.stages.length - 1].id === id;
  const openedPart = first && isLast ? nextPartOf(pt.id) : null;

  return { first, reward, beat, openedPart, isLast };
}

function nextPartOf(partId) {
  return (DB.campaign?.parts ?? []).find((p) => p.id === partId + 1) ?? null;
}

/* ── 환경 규칙 (§7-A.2) ─────────────────────────────
   파트마다 층 전체에 걸리는 규칙이 하나씩 있다.
   단계가 올라가면 같은 규칙이 더 빨리·더 세게 걸린다. */

export function hazardOf(stageId) {
  const pt = partOf(stageId);
  const st = stageOf(stageId);
  if (!pt || !st?.hazardRate) return null;
  return { kind: pt.hazard, name: pt.hazardName, text: pt.hazardText, rate: st.hazardRate };
}

/** 방을 하나 열 때마다 쌓이는 값. rate가 클수록 빨리 찬다. */
export const hazardStep = (rate) => rate;

/** 지금 단계가 몇 단인가 — 0(없음) 1 2 3 */
export function hazardTier(level) {
  if (level >= 24) return 3;
  if (level >= 14) return 2;
  if (level >= 7) return 1;
  return 0;
}

export const HAZARD_TEXT = {
  flood: [
    '', '물이 발목을 넘었다.',
    '물이 무릎까지 찼다. 다리가 젖어 무겁다. (다리 내구도 소모 2배)',
    '물이 허리까지 찼다. 발을 뗄 때마다 느려진다. (속도 −1)',
  ],
  gaze: [
    '', '등 뒤에서 무언가 보고 있다.',
    '시선이 늘었다. 무덤들이 얕게 뒤척인다.',
    '묻힌 것들이 일어났다. 다음 방에서 기다린다.',
  ],
  shift: [
    '', '지나온 통로가 어긋난 것 같다.',
    '가지 않은 방의 연결이 바뀌었다. 지도를 다 믿지 마라.',
    '미궁이 당신을 가운데로 몰고 있다.',
  ],
};
