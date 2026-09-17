/**
 * 부속 강화 (§9.15) — 같은 자리의 부속을 **재료 삼아** 한 짝을 키운다.
 *
 * 왜 이 모양인가. 무덤을 돌면 부속이 계속 쌓이는데 쓸 곳이 해체대뿐이었다.
 * 그렇다고 예전처럼 융합·이식·정제를 따로 두면 **무엇을 언제 쓰는지 아무도 모른다**.
 * 그래서 하나로 합쳤다 — 남는 부속을 같은 자리에 먹여 **1강에서 10강까지** 올린다.
 *
 * 도박이되, **바닥이 있는 도박**이다:
 *   · 5강까지는 실패해도 그대로다. 재료만 잃는다.
 *   · 6~8강은 실패하면 한 단계 내려갈 수 있다.
 *   · 9·10강은 **부서질 수도** 있다.
 *   · 5강부터는 「불괴의 쐐기」가 내려감과 부서짐을 막는다 (실패해도 그 자리에 선다).
 *
 * 숫자는 전부 여기 있다. 화면도 도구도 이 표를 읽는다 — 두 곳에 적으면 언젠가 갈린다.
 */

export const PLUS_MAX = 10;

/** 강화 한 단계가 주는 것 — 능력치와 기술 위력에 함께 붙는다 */
export const PLUS_STAT = 0.06;
export const PLUS_POWER = 0.05;
export const statMul = (plus = 0) => 1 + PLUS_STAT * Math.min(PLUS_MAX, plus ?? 0);
export const powerMul = (plus = 0) => 1 + PLUS_POWER * Math.min(PLUS_MAX, plus ?? 0);

/** 목표 단계별 성공 확률(%) — 인덱스가 곧 목표 단계다 */
export const SUCCESS = [0, 90, 75, 65, 55, 45, 38, 32, 26, 20, 15];

/** 쐐기가 뜻을 갖기 시작하는 단계 — 이 아래에서는 실패해도 잃을 것이 없다 */
export const PROTECT_FROM = 5;

/** 목표 단계에 필요한 **같은 자리 부속** 개수 — 1강은 1개, 10강은 10개 */
export const partsNeeded = (target) => Math.max(1, Math.min(PLUS_MAX, target));

/** 목표 단계에 드는 재료 */
export const costOf = (target) => ({
  scrap: 8 * target,
  boneMeal: Math.ceil(target * 1.2),
  ichor: 3 * target,
});

/**
 * 실패했을 때 무슨 일이 생기는가 (확률 %).
 * 남는 확률은 「그대로」다 — 표에 적지 않은 것이 곧 제자리다.
 */
export const FAIL = (target) => (target <= PROTECT_FROM ? { down: 0, destroy: 0 }
  : target <= 8 ? { down: 50, destroy: 0 }
  : target === 9 ? { down: 60, destroy: 20 }
  : { down: 60, destroy: 30 });

/** 이 단계를 올릴 때 쐐기가 막아 줄 것이 있는가 */
export const protectable = (target) => {
  const f = FAIL(target);
  return f.down > 0 || f.destroy > 0;
};

/**
 * 한 번 시도한다. **순수 함수다** — 저장을 건드리지 않고 결과만 말한다.
 * @param rng      makeRng가 만든 난수기
 * @param cur      지금 강화 단계
 * @param protect  쐐기를 쓰는가
 * @returns {{target, ok, next, destroyed, dropped, usedProtect}}
 */
export function attempt(rng, cur = 0, protect = false) {
  const target = Math.min(PLUS_MAX, (cur ?? 0) + 1);
  const ok = rng.chance(SUCCESS[target] ?? 0);
  if (ok) return { target, ok: true, next: target, destroyed: false, dropped: false, usedProtect: false };

  const f = FAIL(target);
  // 쐐기는 **잃는 것만** 막는다. 성공시켜 주지는 않는다
  if (protect && protectable(target)) {
    return { target, ok: false, next: cur, destroyed: false, dropped: false, usedProtect: true };
  }
  const roll = rng.int(1, 100);
  if (roll <= f.destroy) return { target, ok: false, next: 0, destroyed: true, dropped: false, usedProtect: false };
  if (roll <= f.destroy + f.down) {
    return { target, ok: false, next: Math.max(0, cur - 1), destroyed: false, dropped: true, usedProtect: false };
  }
  return { target, ok: false, next: cur, destroyed: false, dropped: false, usedProtect: false };
}

/** 화면에 그대로 내보낼 한 줄 — 「실패하면 무엇을 잃는가」 */
export function riskText(target) {
  const f = FAIL(target);
  if (!f.down && !f.destroy) return '실패해도 그 자리에 선다';
  if (!f.destroy) return `실패하면 ${f.down}%로 한 단계 내려간다`;
  return `실패하면 ${f.down}%로 내려가고 ${f.destroy}%로 부서진다`;
}
