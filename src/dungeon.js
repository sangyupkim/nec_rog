/** 시드 기반 층 생성 (§6.8). 격자 무작위 보행 + 말단 우선 배치. */
import { makeRng } from './core.js';

export const ROOM_ICON = {
  start: '▣', battle: '⚔', elite: '☠', event: '?', workshop: '🔨',
  rest: '🔥', sealed: '🔒', bones: '💀', trap: '⚠', boss: '👑',
};
export const ROOM_LABEL = {
  start: '시작방', battle: '전투', elite: '엘리트', event: '이벤트', workshop: '작업대',
  rest: '안치실', sealed: '봉인실', bones: '유해 더미', trap: '함정', boss: '보스방',
};

const key = (x, y) => `${x},${y}`;
// 화면 기준 방향이 직관적이다. 키보드 방향키와도 그대로 대응된다.
const DIRS = [[0, -1, '위'], [1, 0, '오른쪽'], [0, 1, '아래'], [-1, 0, '왼쪽']];
export const DIR_KEY = { ArrowUp: '위', ArrowRight: '오른쪽', ArrowDown: '아래', ArrowLeft: '왼쪽' };

export function generateFloor(seed, floor) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const f = tryGenerate(seed + attempt * 7919, floor);
    if (f) return f;
  }
  return tryGenerate(seed, floor, true);
}

function tryGenerate(seed, floor, force = false) {
  const rng = makeRng(seed);
  const target = rng.int(9, 12);
  const rooms = new Map();
  rooms.set(key(0, 0), { x: 0, y: 0, type: 'start' });

  // 무작위 보행 확장 — 이웃이 3개 이상인 칸은 피해 뭉치지 않게 한다
  let guard = 0;
  while (rooms.size < target && guard++ < 900) {
    const from = rng.pick([...rooms.values()]);
    const [dx, dy] = rng.pick(DIRS);
    const nx = from.x + dx, ny = from.y + dy;
    if (Math.abs(nx) > 3 || Math.abs(ny) > 3) continue;
    const k = key(nx, ny);
    if (rooms.has(k)) continue;
    const neighbours = DIRS.filter(([ax, ay]) => rooms.has(key(nx + ax, ny + ay))).length;
    if (neighbours > 1 && !rng.chance(20)) continue;
    rooms.set(k, { x: nx, y: ny, type: null });
  }
  if (rooms.size < 9 && !force) return null;

  const list = [...rooms.values()];
  const neighboursOf = (r) => DIRS
    .map(([dx, dy, dir]) => ({ dir, room: rooms.get(key(r.x + dx, r.y + dy)) }))
    .filter((n) => n.room);

  // 시작방으로부터의 거리
  const dist = new Map([[key(0, 0), 0]]);
  const queue = [rooms.get(key(0, 0))];
  while (queue.length) {
    const cur = queue.shift();
    for (const { room } of neighboursOf(cur)) {
      if (!dist.has(key(room.x, room.y))) {
        dist.set(key(room.x, room.y), dist.get(key(cur.x, cur.y)) + 1);
        queue.push(room);
      }
    }
  }
  if (dist.size !== rooms.size && !force) return null; // 도달 불가 방이 있으면 실패

  const leaves = list
    .filter((r) => r.type !== 'start' && neighboursOf(r).length === 1)
    .sort((a, b) => dist.get(key(b.x, b.y)) - dist.get(key(a.x, a.y)));
  if (leaves.length < 3 && !force) return null;

  // 보스방은 가장 먼 말단
  const boss = leaves.shift();
  boss.type = 'boss';

  // 중요한 방은 말단 우선
  const special = ['elite', 'workshop'];
  if (floor >= 2) special.push('sealed');
  for (const t of special) {
    const r = leaves.shift();
    if (r) r.type = t;
  }

  const rest = list.filter((r) => !r.type);
  const battleTarget = Math.max(4, Math.min(6, Math.round(rooms.size * 0.45)));
  const bag = [];
  for (let i = 0; i < battleTarget; i++) bag.push('battle');
  bag.push('bones', 'bones', 'event');
  if (floor >= 2) bag.push('trap');
  if (rng.chance(60)) bag.push('rest');
  while (bag.length < rest.length) bag.push(rng.pick(['battle', 'bones', 'event']));

  const shuffled = rng.shuffle(bag).slice(0, rest.length);
  rest.forEach((r, i) => { r.type = shuffled[i]; });

  const battles = list.filter((r) => r.type === 'battle').length;
  if ((battles < 3 || battles > 7) && !force) return null;

  for (const r of list) {
    r.visited = r.type === 'start';
    r.cleared = r.type === 'start';
    r.seen = r.type === 'start';
    r.id = key(r.x, r.y);
  }
  // 시작방 이웃은 발견 상태로
  for (const { room } of neighboursOf(rooms.get(key(0, 0)))) room.seen = true;

  // 봉인실 조건
  for (const r of list) {
    if (r.type !== 'sealed') continue;
    r.seal = rng.pick([
      { kind: 'scrap', value: 15, label: '시체 조각 15' },
      { kind: 'hp', value: 25, label: '현재 HP의 25%' },
      { kind: 'element', value: rng.pick(['화염', '독', '부패']), label: null },
    ]);
    if (r.seal.kind === 'element') r.seal.label = `${r.seal.value} 속성 스킬`;
  }

  return { floor, seed, rooms: list, pos: key(0, 0), neighbours: neighboursOf };
}

export function roomAt(floorData, id) {
  return floorData.rooms.find((r) => r.id === id);
}

export function exitsOf(floorData, id) {
  const cur = roomAt(floorData, id);
  return DIRS
    .map(([dx, dy, dir]) => ({ dir, room: floorData.rooms.find((r) => r.x === cur.x + dx && r.y === cur.y + dy) }))
    .filter((e) => e.room);
}

/** 미니맵 문자열 — 왼쪽 패널에 그대로 그린다 */
export function minimapCells(floorData) {
  const xs = floorData.rooms.map((r) => r.x);
  const ys = floorData.rooms.map((r) => r.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const cells = [];
  for (let y = minY; y <= maxY; y++) {
    const row = [];
    for (let x = minX; x <= maxX; x++) {
      const r = floorData.rooms.find((q) => q.x === x && q.y === y);
      row.push(r ?? null);
    }
    cells.push(row);
  }
  return { cells, minX, minY, maxX, maxY };
}

export const FLAVOR = {
  start: ['축축한 흙냄새가 난다. 내려온 길은 이미 어둠에 잠겼다.'],
  battle: ['무언가 이 방을 파헤쳐 놓았다. 발자국은 사람의 것이 아니다.',
           '벽을 따라 긁힌 자국이 이어진다. 아직 새것이다.',
           '공기가 무겁다. 여기 무언가 있다.'],
  elite: ['천장이 내려앉을 듯 낮다. 거대한 무언가가 이 방을 쓰고 있었다.'],
  event: ['방 한가운데 무언가가 놓여 있다.'],
  workshop: ['버려진 작업대가 있다. 도구는 녹슬었지만 쓸 만하다.'],
  rest: ['벽감마다 초가 꽂혀 있다. 아직 온기가 남아 있다.'],
  sealed: ['문에 뼈로 짠 봉인이 걸려 있다.'],
  bones: ['유해가 무더기로 쌓여 있다. 쓸 만한 것을 골라낼 수 있겠다.'],
  trap: ['바닥이 심상치 않다. 지나가려면 대가를 치러야 할 것 같다.'],
  boss: ['문 너머에서 무거운 숨소리가 들린다. 이 층의 주인이다.'],
};
