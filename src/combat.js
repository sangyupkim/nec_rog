/** 커맨드 턴제 전투 엔진. DOM에 의존하지 않으므로 콘솔 시뮬레이션에도 쓸 수 있다. */
import {
  DB, damage, elemMul, rankMul, addStatus, hasStatus,
  assembleGolem, skillElement, partSkills, partName,
  MON_FRAME_RATIO, AIM, RAW_FAIL_CHANCE, SLOT_LABEL, SLOT_KIND,
  partElement, stackStep, resoAttackMul, resoDefenseMul,
  STACK_POWER, STACK_ACC,
} from './core.js';

const WILL_START = 3, WILL_MAX = 10, WILL_GAIN = 1;
const MON_SLOT_LABEL = { head: '머리', body: '몸통', arm: '팔', leg: '다리' };

/** 한 전투에서 도트(중독·화상·가시)가 핵에서 가져갈 수 있는 최대 비율 */
const DOT_CAP = 0.35;

/* 흉곽이 없으면 핵이 드러난다 (§3.1·§5.7).
   몸통은 방어도가 가장 두꺼운 자리다. 그 자리를 비우면 총량이 줄어드는 것만으로는
   "핵이 드러났다"가 느껴지지 않으므로, **들어온 피해의 일부가 방어도를 그냥 지나** 핵에 닿는다.
   핵은 그걸 체력으로 받아 낸다 — 즉시 지는 것이 아니라 **버티는 자원이 바뀌는** 것이다. */
const CORE_EXPOSED = 0.35;

/* ── 막을 곳을 고른다 (§5.14) ───────────────────────
   조준이 「어디를 때릴까」라면, 막기는 「어디로 받을까」다. 고른 자리로 받아 내면 피해가
   줄고, 그 자리의 결로 속성 상성을 따진다 — 냉기 팔로 화염을 받으면 더 아프다.
   다만 **고른 대로 되지는 않는다.** 나보다 빠른 적은 내가 댄 자리를 피해 때린다. */
export const GUARD_KINDS = ['head', 'body', 'arm', 'leg'];
export const GUARD_LABEL = { head: '머리', body: '몸통', arm: '팔', leg: '다리' };
const GUARD_CUT = 0.25;          // 댄 자리로 받아 내면 피해 -25%
const GUARD_BASE = 50;           // 속도가 같을 때 대는 데 성공할 확률
const GUARD_PER_SPD = 3;         // 속도 1 차이마다 ±3%p
const GUARD_MIN = 25, GUARD_MAX = 90;
/** 화상 한 틱 = 최대 체력의 몇 %인가 */
const BURN_RATIO = 0.03;

export class Combat {
  constructor(save, monster, rng) {
    this.save = save;
    this.rng = rng;
    this.mon = monster;
    this.log = [];
    this.phase = 'intro';   // 로그를 국면별로 묶어 UI가 사이에 텀을 둘 수 있게 한다 (§5.8)
    this.dotTaken = 0;      // 이번 전투에서 핵이 도트로 잃은 양 (§5.7 상한)
    this.turn = 0;
    this.over = false;
    this.result = null;
    this.usedNecro = false;
    this.summonCount = 0;

    const g = assembleGolem(save);
    this.g = g;
    this.golem = {
      name: '누더기 골렘',
      hp: save.run?.golemHp ?? g.stats.hp,
      maxHp: g.stats.hp,
      stats: g.stats,
      defElement: g.defElement,
      ranks: { atk: 0, def: 0, spd: 0, eva: 0 },
      statuses: {},
    };
    this.golem.hp = Math.min(this.golem.hp, this.golem.maxHp);

    // 스킬 충전량
    this.charges = {};
    for (const sid of g.active) {
      const s = DB.skillsBy[sid];
      if (s.charges !== null) this.charges[sid] = s.charges;
    }
    this.rechargeClock = {};

    this.will = WILL_START;
    this.necroCd = {};
    this.prep = null;        // 이번 턴 골렘의 공격에 얹어 나갈 술법
    this.watched = false;    // 관찰했는가 — 적의 다음 수가 보인다 (§5.9)
    this.monNext = null;     // 적이 다음에 쓸 기술 (관찰했을 때만 보여 준다)
    this.summon = null;
    this.usedParts = new Set();

    // 이 전투에서 파츠를 실제로 사용했는지 추적 (§3.3 내구도)
    this.skillOwner = {};
    this.slotOfSkill = {};
    for (const { slot, part } of g.worn) {
      for (const sid of partSkills(part)) {
        this.skillOwner[sid] ??= part.uid;
        this.slotOfSkill[sid] ??= slot;
      }
    }

    // ── 파츠 방어도 (§5.7) — 전투가 끝나도 회복되지 않는다 ──
    this.aim = 'random';
    this.guard = null;          // 이번 턴 막기로 댄 부위 (null = 맡긴다)
    this.frames = {};
    for (const { slot, part, shieldMax: max, shield } of g.worn) {
      this.frames[slot] = { slot, part, hp: shield, max, down: shield <= 0 };
    }
    this.coreBare = !g.worn.some((w) => w.slot === 'body');   // 흉곽이 없다 = 핵이 드러났다
    this.monFrames = {};
    for (const [slot, ratio] of Object.entries(MON_FRAME_RATIO)) {
      const max = Math.round(this.mon.maxHp * ratio);
      this.monFrames[slot] = { slot, hp: max, max, down: false };
    }
    this.brokenMonSlots = [];

    this.say(`${this.mon.name}이(가) 어둠 속에서 모습을 드러낸다.`);
  }

  say(text, cls = '', extra = null) {
    this.log.push({ text, cls, phase: this.phase, ...(extra ?? {}) });
  }

  /* ── 플레이어가 고를 수 있는 것들 ─────────────────── */
  golemSkills() {
    return this.g.active.map((sid) => {
      const s = DB.skillsBy[sid];
      const el = skillElement(this.save, sid);
      const left = s.charges === null ? null : (this.charges[sid] ?? 0);
      const slot = this.slotOfSkill[sid];
      const down = slot ? this.frames[slot]?.down : false;
      return {
        id: sid, name: s.name, element: el, power: s.power,
        charges: s.charges, left, slot, down,
        raw: Boolean(this.frames[slot]?.part?.raw),
        usable: !down && (s.charges === null || left > 0),
        mul: this.save.seen?.[this.mon.defId] ? elemMul(el, this.mon.defElement) : null,
      };
    });
  }

  /** 막을 부위 전환 — 조준과 같은 자리에서 같은 방식으로 돌린다 */
  cycleGuard() {
    const order = [null, ...GUARD_KINDS];
    const i = order.indexOf(this.guard);
    this.guard = order[(i + 1) % order.length];
    return this.guard;
  }

  /** 댄 자리로 실제로 받아 낼 확률(%) — 빠를수록 잘 댄다 (§5.14) */
  guardChance() {
    const mine = (this.golem.stats.spd ?? 0) * rankMul(this.golem.ranks.spd);
    const theirs = (this.mon.stats.spd ?? 0) * rankMul(this.mon.ranks.spd);
    return Math.max(GUARD_MIN, Math.min(GUARD_MAX,
      Math.round(GUARD_BASE + (mine - theirs) * GUARD_PER_SPD)));
  }

  /** 막기에 쓸 수 있는 부위 — 방어도가 남아 있는 자리만 댈 수 있다 */
  guardable() {
    const kinds = new Set();
    for (const f of Object.values(this.frames)) if (!f.down) kinds.add(SLOT_KIND[f.slot]);
    return GUARD_KINDS.filter((k) => kinds.has(k));
  }

  /** 조준 부위 전환 — 매 턴 클릭을 늘리지 않도록 토글로 둔다 */
  cycleAim() {
    const order = ['random', 'upper', 'lower'];
    this.aim = order[(order.indexOf(this.aim) + 1) % order.length];
    return AIM[this.aim];
  }

  /* ── 준비한 술법 (§9-A) ─────────────────────────────
     술법은 더 이상 골렘의 턴을 빼앗지 않는다. **미리 걸어 두면 골렘의 공격과 같은 턴에** 나간다.
     네크로맨서가 뒤에서 술법을 걸고 골렘이 앞에서 때리는 것이 이 게임의 그림이다.
     대신 영력과 재사용 대기가 그대로 값을 받는다 — 매 턴 쓸 수는 없다. */
  cyclePrep() {
    const usable = this.necroSkills().filter((n) => n.usable).map((n) => n.id);
    if (!usable.length) { this.prep = null; return null; }
    const i = usable.indexOf(this.prep);
    this.prep = i < 0 ? usable[0] : (i + 1 < usable.length ? usable[i + 1] : null);
    return this.prep;
  }

  /** 준비한 술법이 아직 쓸 수 있는가. 못 쓰게 됐으면 비운다 */
  prepValid() {
    if (!this.prep) return null;
    const n = this.necroSkills().find((x) => x.id === this.prep);
    if (!n?.usable) { this.prep = null; return null; }
    return n;
  }

  /** 조준에 따라 실제로 맞을 부위를 고른다 */
  pickFrame(frames, key) {
    const conf = AIM[this.aim];
    const alive = Object.values(frames).filter((f) => !f.down);
    if (!alive.length) return null;
    const wanted = conf[key];
    if (!wanted) return this.rng.pick(alive);
    const inZone = alive.filter((f) => wanted.includes(f.slot));
    return inZone.length ? this.rng.pick(inZone) : this.rng.pick(alive);
  }

  necroSkills() {
    return (this.save.necro.equipped ?? []).filter(Boolean).map((id) => {
      const n = DB.necro_skillsBy[id];
      const cd = this.necroCd[id] ?? 0;
      return { ...n, cd, usable: cd === 0 && this.will >= n.will };
    });
  }

  combatItems() {
    return Object.entries(this.save.consumables ?? {})
      .filter(([id, n]) => n > 0 && DB.itemsBy[id]?.use === 'combat')
      .map(([id, n]) => ({ ...DB.itemsBy[id], count: n }));
  }

  /* ── 한 라운드 진행 ───────────────────────────────── */
  act(action) {
    if (this.over) return;
    this.log = [];
    this.turn++;
    this.phase = 'golem';

    let golemActed = false;

    // 술법은 골렘의 공격보다 먼저, **같은 턴 안에서** 나간다 (§9-A)
    const spell = action.necro ?? (action.kind === 'necro' ? action.id : null);
    if (spell) {
      this.phase = 'necro';
      this.useNecro(spell);
      if (this.prep === spell) this.prep = null;
      this.phase = 'golem';
    }
    // 아이템과 관찰은 여전히 골렘의 행동을 대신한다 (그 턴 골렘은 공격하지 않는다)
    if (action.kind === 'necro') golemActed = true;
    else if (action.kind === 'item') { this.useItem(action.id); golemActed = true; }
    else if (action.kind === 'observe') { this.observe(); golemActed = true; }

    // 소환수는 골렘보다 먼저 움직인다
    if (this.summon) { this.phase = 'summon'; this.summonAct(); }
    if (this.checkEnd()) return;

    const golemFirst = this.speed(this.golem) >= this.speed(this.mon);

    const doGolem = () => {
      if (action.kind !== 'skill' || golemActed) return;
      this.phase = 'golem';
      this.golemAct(action.id);
    };
    const doMon = () => { if (this.over) return; this.phase = 'enemy'; this.monsterAct(); };

    if (golemFirst) { doGolem(); if (this.checkEnd()) return; doMon(); }
    else { doMon(); if (this.checkEnd()) return; doGolem(); }
    if (this.checkEnd()) return;

    this.phase = 'end';
    this.endOfTurn();
    this.checkEnd();
  }

  speed(u) {
    let spd = (u.stats.spd ?? 0) * rankMul(u.ranks.spd);
    if (hasStatus(u, '마비')) spd /= 2;
    return spd;
  }

  /* ── 골렘 행동 ────────────────────────────────────── */
  golemAct(sid) {
    const s = DB.skillsBy[sid];
    if (s.charges !== null) {
      if ((this.charges[sid] ?? 0) <= 0) { this.say('충전이 남아 있지 않다.'); return; }
      this.charges[sid]--;
      this.rechargeClock[sid] = s.recharge;
    }
    if (this.skillOwner[sid]) this.usedParts.add(this.skillOwner[sid]);

    const el = skillElement(this.save, sid);
    this.say(s.text.replace('{user}', '골렘').replace('{target}', this.mon.name), 'golem');

    if (hasStatus(this.golem, '마비') && this.rng.chance(25)) {
      this.say('골렘의 관절이 얼어붙어 움직이지 않는다.', 'bad');
      return;
    }

    // 정착하지 않은 파츠는 이음새가 어긋난다 (§3.4)
    const owner = this.frames[this.slotOfSkill[sid]]?.part;
    if (owner?.raw && this.rng.chance(RAW_FAIL_CHANCE)) {
      this.say(`${partName(owner)}의 이음새가 어긋나 동작이 불발된다.`, 'bad');
      return;
    }

    const conf = AIM[this.aim];
    if (s.power > 0 && this.aim !== 'random') {
      this.say(`${conf.name}을(를) 노린다.`, 'dim');
    }

    if (s.power > 0) {
      /* 같은 기술을 여러 부속이 함께 내놓으면 그 기술이 날카로워진다 (§5.12).
         결이 겹친 속성으로 때리면 공명한다 (§5.13). 둘 다 **조립에서 번 것**이다. */
      const step = stackStep(this.g.stacks?.[sid] ?? 1);
      const reso = resoAttackMul(this.g.elements ?? {}, el);
      const power = Math.round(s.power * (1 + STACK_POWER * step) * reso);
      const acc = s.accuracy + conf.acc + STACK_ACC * step;
      if (step) this.say(`같은 결의 부속 ${(this.g.stacks[sid])}개가 함께 움직인다. (위력 +${Math.round(STACK_POWER * step * 100)}%)`, 'good');
      else if (reso > 1) this.say(`${el}의 결이 공명한다. (위력 +${Math.round((reso - 1) * 100)}%)`, 'good');
      const hits = s.hits ?? 1;
      let total = 0;
      for (let i = 0; i < hits; i++) {
        if (!this.rollHit(this.golem, this.mon, acc)) {
          this.say(`${this.mon.name}이(가) 몸을 비틀어 피했다.`, 'dim');
          continue;
        }
        total += this.dealDamage(this.golem, this.mon, power, el);
      }
      if (total > 0) {
        this.reportElement(el);
        const tap = this.g.traits.lifetap;
        if (tap) { this.healGolem(tap); this.say(`방혈관이 ${tap}의 생기를 빨아들인다.`, 'good'); }
      }
    }

    for (const e of s.effects ?? []) this.applyEffect(e, this.golem, this.mon, s);
  }

  applyEffect(e, self, foe, skill) {
    switch (e.op) {
      case 'status': {
        const target = e.target === 'self' ? self : foe;
        if (e.chance != null && !this.rng.chance(e.chance)) break;
        addStatus(target, e.id, { stacks: e.stacks ?? 0, duration: e.duration ?? 0 });
        this.say(`${this.nameOf(target)}이(가) ${e.id} 상태가 된다.`,
                 target === this.mon ? 'good' : 'bad');
        break;
      }
      case 'rank': {
        const target = e.target === 'enemy' ? foe : self;
        target.ranks[e.stat] = Math.max(-4, Math.min(4, target.ranks[e.stat] + e.delta));
        const label = { atk: '공격', def: '방어', spd: '속도', eva: '회피' }[e.stat];
        this.say(`${this.nameOf(target)}의 ${label}이(가) ${e.delta > 0 ? '올랐다' : '떨어졌다'}.`,
                 (e.delta > 0) === (target === self) ? 'good' : 'bad');
        break;
      }
      case 'lifesteal': break; // dealDamage에서 처리
      case 'crit_bonus': break;
      case 'reveal':
        // 「죽은 자의 시야」 같은 기술은 관찰과 같은 것을 준다 —
        // 때리면서 보는 셈이라, 턴을 내주는 관찰보다 낫다. 그게 이 기술의 값어치다
        this.save.seen ??= {};
        this.save.seen[this.mon.defId] = true;
        this.watched = true;
        this.monNext ??= this.pickMonsterSkill();
        this.say(`${this.mon.name}의 약점이 드러난다. (방어 속성: ${this.mon.defElement})`, 'good');
        if (DB.skillsBy[this.monNext]) {
          this.say(`다음 수까지 들여다보인다 — 「${DB.skillsBy[this.monNext].name}」.`, 'good');
        }
        break;
      default: break;
    }
  }

  /* ── 몬스터 행동 ──────────────────────────────────── */
  pickMonsterSkill() {
    const ai = this.mon.ai ?? {};
    const known = this.mon.skills;
    if (ai.type === 'pattern' && ai.pattern?.length) {
      return ai.pattern[(this.turn - 1) % ai.pattern.length];
    }
    const weights = ai.weights ?? {};
    let entries = known.map((id) => [id, weights[id] ?? 20]);

    // 데이터로 적은 규칙 — 체력이 낮으면 특정 기술을 선호한다
    const hpPct = (this.mon.hp / this.mon.maxHp) * 100;
    for (const r of ai.rules ?? []) {
      if (r.if === 'hp_below' && hpPct <= r.value && r.prefer && known.includes(r.prefer)) {
        entries = entries.map(([id, w]) => [id, id === r.prefer ? w * 3 : w]);
      }
    }

    // 적이 내 상태를 읽는다 (§5.1). 이게 없으면 조준도 방어도 관리도 팽팽해지지 않는다
    entries = entries.map(([id, w]) => [id, w * this.intentBonus(id)]);

    // 같은 스킬을 너무 반복하지 않는다
    const cap = ai.rules?.find((r) => r.no_repeat_over)?.no_repeat_over ?? 2;
    if (this.mon.repeats >= cap) entries = entries.filter(([id]) => id !== this.mon.lastSkill);
    if (!entries.length) entries = known.map((id) => [id, 1]);
    return this.rng.weighted(entries);
  }

  /**
   * 골렘의 지금 상태를 보고 기술 가중치를 조정한다.
   * 무작위로 때리는 적은 조준도 방어도 관리도 의미 없게 만든다.
   */
  intentBonus(sid) {
    const s = DB.skillsBy[sid];
    if (!s) return 1;
    let mul = 1;

    // 핵이 얼마 안 남았으면 마무리를 노린다 — 회복·보조기를 접고 화력을 든다
    const corePct = (this.golem.hp / this.golem.maxHp) * 100;
    if (corePct <= 35) mul *= s.power > 0 ? 1.6 : 0.3;

    // 방어도가 거의 다 벗겨졌으면 한 방이 큰 쪽으로 — 이제 넘치는 만큼 핵에 닿는다
    const frames = Object.values(this.frames);
    const shieldLeft = frames.reduce((n, f) => n + f.hp, 0);
    const shieldMaxAll = frames.reduce((n, f) => n + f.max, 0) || 1;
    if (shieldLeft / shieldMaxAll <= 0.25 && (s.hits ?? 1) === 1 && s.power > 0) mul *= 1.4;

    // 아직 두껍게 남아 있으면 여러 번 때리는 쪽이 방어도를 빨리 깎는다
    if (shieldLeft / shieldMaxAll > 0.6 && (s.hits ?? 1) > 1) mul *= 1.3;

    // 내 방어 속성에 유리한 속성을 골라 든다 — 몸통 선택이 실제 결정이 된다
    const m = elemMul(s.element, this.golem.defElement);
    if (s.power > 0) mul *= m >= 1.5 ? 1.5 : m <= 0.5 ? 0.5 : 1;

    /* 한 결로 몰아 쌓았으면 적이 그 약점을 파고든다 (§5.13).
       「반대 상성에 취약해진다」가 배율표 속에만 있으면 아무 일도 일어나지 않는다 —
       적이 실제로 그 속성을 **더 자주 들어야** 몰아 쌓기가 도박이 된다. */
    if (s.power > 0) {
      const counts = this.g.elements ?? {};
      const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      if (top && top[1] >= 2 && elemMul(s.element, top[0]) >= 1.5) mul *= 1 + 0.4 * (top[1] - 1);
    }

    // 이미 걸린 상태이상을 또 거는 데 턴을 쓰지 않는다
    const adds = (s.effects ?? []).filter((e) => e.op === 'status').map((e) => e.id);
    if (adds.length && adds.every((id) => this.golem.statuses[id])) mul *= 0.35;

    // 자기 회복기는 멀쩡할 때 쓰지 않는다
    const heals = (s.effects ?? []).some((e) => e.op === 'status' && e.id === '재생' && e.target === 'self');
    if (heals) mul *= (this.mon.hp / this.mon.maxHp) > 0.7 ? 0.4 : 1.8;

    return mul;
  }


  monsterAct() {
    if (hasStatus(this.mon, '마비') && this.rng.chance(25)) {
      this.say(`${this.mon.name}이(가) 경련하며 움직이지 못한다.`, 'good');
      return;
    }
    // 다음 수는 턴이 끝날 때 미리 뽑아 둔다 — 관찰한 플레이어에게 보여 주려면 먼저 정해져 있어야 한다
    const sid = this.monNext ?? this.pickMonsterSkill();
    this.monNext = null;
    this.mon.repeats = sid === this.mon.lastSkill ? this.mon.repeats + 1 : 0;
    this.mon.lastSkill = sid;

    const s = DB.skillsBy[sid];
    this.say(s.text.replace('{user}', this.mon.name).replace('{target}', '골렘'), 'enemy');

    // 소환수가 대신 맞을 수 있다
    let target = this.golem;
    if (this.summon && s.power > 0) {
      const info = DB.summonsBy[this.summon.id];
      if (this.rng.chance(info.taunt)) target = this.summon;
    }

    if (s.power > 0) {
      const hits = s.hits ?? 1;
      for (let i = 0; i < hits; i++) {
        if (target === this.golem && !this.rollHit(this.mon, this.golem, s.accuracy)) {
          this.say('골렘이 무겁게 비틀어 피한다.', 'good');
          continue;
        }
        if (target === this.summon) {
          const dmg = damage({
            power: s.power, atk: this.mon.stats.atk, def: 0,
            atkEl: s.element, defEl: '타격',
            atkRank: this.mon.ranks.atk, defRank: 0,
          });
          this.summon.hp -= dmg;
          this.say(`${DB.summonsBy[this.summon.id].name}이(가) 대신 ${dmg}의 피해를 받는다.`, 'dim');
          if (this.summon.hp <= 0) {
            this.say(`${DB.summonsBy[this.summon.id].name}이(가) 부서진다.`, 'dim');
            this.summon = null;
            break;
          }
        } else {
          this.dealDamage(this.mon, this.golem, s.power, s.element);
        }
      }
    }
    for (const e of s.effects ?? []) this.applyEffect(e, this.mon, this.golem, s);
  }

  /* ── 공통 판정 ────────────────────────────────────── */
  rollHit(attacker, defender, accuracy) {
    const eva = Math.max(0, (defender.stats.eva ?? 0) * rankMul(defender.ranks.eva)
                          - (attacker.stats.focus ?? 0) / 2);
    const chance = Math.max(30, (accuracy ?? 95) - eva);
    return this.rng.chance(chance);
  }

  /**
   * 이 한 대를 **어느 자리로 받는가**를 먼저 정한다 (§5.14).
   * 댄 자리가 있으면 속도 싸움을 한 번 하고, 없거나 졌으면 아무 자리나 맞는다.
   * 자리가 먼저 정해져야 그 자리의 결로 속성을 따질 수 있다 — 순서가 규칙이다.
   */
  resolveGuard() {
    const alive = Object.values(this.frames).filter((f) => !f.down);
    if (!alive.length) return { frame: null, blocked: false };
    if (!this.guard) return { frame: this.rng.pick(alive), blocked: false };
    const want = alive.filter((f) => SLOT_KIND[f.slot] === this.guard);
    if (!want.length) return { frame: this.rng.pick(alive), blocked: false };
    if (!this.rng.chance(this.guardChance())) {
      const other = alive.filter((f) => !want.includes(f)); // 댄 자리를 피해 들어온다
      this.say(`${GUARD_LABEL[this.guard]}을(를) 댔지만 늦었다.`, 'bad');
      return { frame: this.rng.pick(other.length ? other : alive), blocked: false };
    }
    return { frame: this.rng.pick(want), blocked: true };
  }

  dealDamage(from, to, power, element) {
    /* 골렘이 맞는 경우에는 **맞는 자리를 먼저 정하고** 그 자리의 결로 상성을 본다.
       전에는 몸통의 속성 하나가 골렘 전체의 방어 속성이었다 (§5.13). */
    const g = to === this.golem ? this.resolveGuard() : null;
    // 결이 없는 부속은 골렘의 몸통 속성으로 받는다 (§5.13)
    const defEl = (g?.frame ? partElement(g.frame.part) : null) ?? to.defElement;
    let dmg = damage({
      power,
      atk: from.stats.atk,
      def: to.stats.def ?? 0,
      atkEl: element,
      defEl,
      atkRank: from.ranks.atk,
      defRank: to.ranks.def,
    });
    if (to === this.golem) {
      // 결이 여럿 겹친 자리는 같은 속성을 받아넘기고, 그 결을 누르는 속성에는 약하다
      const reso = resoDefenseMul(this.g.elements ?? {}, element, defEl);
      if (reso !== 1) {
        dmg = Math.max(1, Math.round(dmg * reso));
        this.say(reso < 1
          ? `겹쳐 쌓은 ${defEl}의 결이 같은 기운을 흘려보낸다.`
          : `${defEl}로 몰아 쌓은 탓에 ${element}이(가) 깊이 파고든다.`, reso < 1 ? 'good' : 'bad');
      }
      if (g?.blocked) {
        dmg = Math.max(1, Math.round(dmg * (1 - GUARD_CUT)));
        this.say(`${GUARD_LABEL[this.guard]}(으)로 받아 냈다. (${defEl} · 피해 -${Math.round(GUARD_CUT * 100)}%)`, 'good');
      }
    }
    if (hasStatus(from, '화상')) dmg = Math.floor(dmg * 0.75);
    if (hasStatus(to, '균열')) dmg = Math.floor(dmg * 1.5);
    if (this.rng.chance(5)) { dmg = Math.floor(dmg * 1.5); this.say('급소에 들어갔다!', 'good', { big: true }); }

    if (to === this.golem) {
      const leak = this.absorb(dmg, g?.frame ?? null);
      if (leak > 0) {
        to.hp -= leak;
        this.say(`핵이 ${leak}의 피해를 입는다.`, 'bad', { hit: 'golem', big: true });
      }
    } else {
      to.hp -= dmg;
      this.say(`${this.nameOf(to)}이(가) ${dmg}의 피해를 입는다.`,
        to === this.mon ? 'good' : 'bad',
        { hit: to === this.mon ? 'mon' : 'golem' });
      this.hitFrame(to, dmg);
    }

    if (hasStatus(to, '가시')) {
      const thorn = 3;
      if (from === this.golem) this.coreDot(thorn); else from.hp -= thorn;
      this.say(`가시가 ${this.nameOf(from)}을(를) 되찌른다. (${thorn}${from === this.golem ? ' · 핵 직격' : ''})`,
        'dim', from === this.golem ? { hit: 'golem' } : null);
    }
    return dmg;
  }

  /**
   * 골렘이 받은 피해를 방어도로 막는다. 막지 못한 만큼만 핵으로 넘어간다 (§5.7).
   * @returns 핵에 닿은 피해
   */
  absorb(dmg, first0 = null) {
    let left = dmg;
    let bare = 0;
    // 흉곽이 없으면 일부는 방어도를 지나쳐 곧장 핵으로 간다
    if (this.coreBare) {
      bare = Math.max(1, Math.round(dmg * CORE_EXPOSED));
      left -= bare;
    }
    // 맞기로 정해진 부위가 먼저 받고, 모자라면 남은 부위가 이어 받는다
    const first = first0 ?? this.pickFrame(this.frames, 'slots');
    const order = [first, ...Object.values(this.frames).filter((f) => f && f !== first && !f.down)]
      .filter(Boolean);
    for (const f of order) {
      if (left <= 0) break;
      if (f.down) continue;
      const taken = Math.min(f.hp, left);
      f.hp -= taken;
      left -= taken;
      if (f.hp <= 0) {
        f.hp = 0; f.down = true;
        this.say(`${partName(f.part)}의 방어가 무너졌다. 연결된 기술을 쓸 수 없다.`, 'bad', { broke: true });
        this.brokenGolemSlots ??= [];
        this.brokenGolemSlots.push(f.slot);
      }
    }
    const soaked = dmg - bare - left;
    if (soaked > 0) this.say(`방어도가 ${soaked}을(를) 받아냈다.`, 'dim', { hit: 'golem' });
    if (bare > 0) this.say('드러난 핵에 그대로 꽂힌다.', 'bad', { hit: 'golem' });
    return left + bare;
  }

  /** 몬스터 부위에 피해가 누적된다. 0이 되면 그 부위는 망가진다 (§5.7) */
  hitFrame(to, dmg) {
    const conf = AIM[this.aim];
    if (to === this.mon) {
      const f = this.pickFrame(this.monFrames, 'mon');
      if (!f) return;
      f.hp -= Math.round(dmg * conf.mul);
      if (f.hp > 0) return;
      f.hp = 0; f.down = true;
      this.brokenMonSlots.push(f.slot);
      this.say(`${this.mon.name}의 ${MON_SLOT_LABEL[f.slot]}이(가) 짓뭉개졌다. 부속으로 쓸 수 없다.`, 'bad');
      this.applyMonBreak(f.slot);
      return;
    }
  }

  /** 몬스터는 골렘이 아니므로 부위 파괴가 능력 저하로 나타난다 */
  applyMonBreak(slot) {
    const st = this.mon.stats;
    if (slot === 'arm') { st.atk = Math.round(st.atk * 0.5); this.say(`${this.mon.name}의 팔이 늘어진다. 공격이 약해졌다.`, 'good'); }
    else if (slot === 'leg') { st.spd = Math.round(st.spd * 0.5); st.eva = Math.round(st.eva * 0.5); this.say('다리를 절며 느려진다.', 'good'); }
    else if (slot === 'head') { st.focus = Math.round(st.focus * 0.4); this.say('머리가 꺾여 겨냥이 흐트러진다.', 'good'); }
    else if (slot === 'body') { st.def = Math.round(st.def * 0.5); this.say('몸통이 열렸다. 방어가 무너진다.', 'good'); }
  }

  reportElement(el) {
    const m = elemMul(el, this.mon.defElement);
    this.save.seen ??= {};
    this.save.seen[this.mon.defId] = true;
    if (m === 0) this.say('효과가 없다.', 'dim');
    else if (m > 1) this.say('효과가 굉장했다!', 'good');
    else if (m < 1) this.say('효과가 별로였다...', 'dim');
  }

  nameOf(u) {
    if (u === this.golem) return '골렘';
    if (u === this.mon) return this.mon.name;
    return DB.summonsBy[u.id]?.name ?? '무언가';
  }

  /** 회복은 핵에만 닿는다. 방어도는 수리해야 돌아온다 (§5.7) */
  healGolem(n) {
    this.golem.hp = Math.min(this.golem.maxHp, this.golem.hp + n);
  }

  /** 남은 방어도를 파츠에 새긴다. 수리하기 전까지 이대로 남는다 */
  commitShields() {
    for (const f of Object.values(this.frames)) f.part.shield = f.hp;
  }

  /* ── 네크로맨서 ───────────────────────────────────── */
  useNecro(id) {
    const n = DB.necro_skillsBy[id];
    if (!n || (this.necroCd[id] ?? 0) > 0 || this.will < n.will) return;
    this.will -= n.will;
    this.necroCd[id] = n.cooldown;
    this.usedNecro = true;
    this.say(`네크로맨서가 ${n.name}을(를) 시전한다.`, 'necro');

    const e = n.effect;
    switch (e.op) {
      case 'heal': {
        const amt = Math.round(this.golem.maxHp * e.ratio);
        this.healGolem(amt);
        this.say(`골렘의 이음새가 메워진다. (+${amt})`, 'good');
        break;
      }
      case 'rank':
        this.golem.ranks[e.stat] = Math.max(-4, Math.min(4, this.golem.ranks[e.stat] + e.delta));
        this.say('골렘의 몸에서 검은 김이 피어오른다.', 'good');
        break;
      case 'cleanse': {
        const k = Object.keys(this.golem.statuses).find((x) => x !== '재생' && x !== '가시');
        if (k) { delete this.golem.statuses[k]; this.say(`${k} 상태가 씻겨나간다.`, 'good'); }
        else this.say('씻어낼 것이 없다.', 'dim');
        break;
      }
      case 'damage': {
        const dmg = damage({
          power: e.power, atk: 20, def: this.mon.stats.def,
          atkEl: e.element, defEl: this.mon.defElement, defRank: this.mon.ranks.def,
        });
        this.mon.hp -= dmg;
        this.say(`${this.mon.name}이(가) ${dmg}의 피해를 입는다.`, 'good');
        this.reportElement(e.element);
        if (e.status) {
          addStatus(this.mon, e.status.id, { stacks: e.status.stacks ?? 0, duration: e.status.duration ?? 0 });
          this.say(`${this.mon.name}이(가) ${e.status.id} 상태가 된다.`, 'good');
        }
        break;
      }
      case 'execute': {
        const dmg = Math.round(this.mon.maxHp * e.ratio);
        this.mon.hp -= dmg;
        this.say(`선고가 내려진다. ${this.mon.name}이(가) ${dmg}의 피해를 입는다.`, 'good');
        break;
      }
      case 'summon': {
        const info = DB.summonsBy[e.id];
        if (this.summon) this.say(`${DB.summonsBy[this.summon.id].name}이(가) 흩어진다.`, 'dim');
        this.summon = { id: e.id, hp: info.hp, maxHp: info.hp, left: info.duration };
        this.summonCount++;
        this.say(`${info.name}이(가) 땅을 뚫고 일어선다. (${info.duration}턴)`, 'necro');
        break;
      }
      default: break;
    }
  }

  summonAct() {
    const s = this.summon;
    const info = DB.summonsBy[s.id];
    const a = info.action;
    if (a.op === 'attack') {
      this.say(info.text, 'necro');
      const dmg = damage({
        power: a.power, atk: 18, def: this.mon.stats.def,
        atkEl: a.element, defEl: this.mon.defElement, defRank: this.mon.ranks.def,
      });
      this.mon.hp -= dmg;
      this.say(`${this.mon.name}이(가) ${dmg}의 피해를 입는다.`, 'good');
      if (a.rank) {
        this.mon.ranks[a.rank.stat] = Math.max(-4, Math.min(4, this.mon.ranks[a.rank.stat] + a.rank.delta));
        this.say(`${this.mon.name}의 회피가 떨어졌다.`, 'good');
      }
    } else if (a.op === 'burst') {
      this.say(info.text, 'necro');
      addStatus(this.mon, a.status.id, { stacks: a.status.stacks });
      this.say(`${this.mon.name}이(가) 역병에 뒤덮인다.`, 'good');
      this.summon = null;
      return;
    } else if (a.op === 'guard') {
      this.say(info.text, 'necro');
    }

    /* 남은 턴은 **턴이 끝날 때** 센다 (endOfTurn).
       여기서 깎으면 소환수가 제 몫을 다 하기 전에 사라진다 —
       소환수는 골렘보다 먼저 움직이므로, 마지막 턴에 움직이자마자 흩어져
       *그 턴의 적 공격을 대신 맞지 못했다.* 「2턴간 대신 받는다」던 뼈 방패가
       실제로는 한 번만 막아 준 이유가 이것이다. */
  }

  /* ── 아이템 · 관찰 ────────────────────────────────── */
  useItem(id) {
    const item = DB.itemsBy[id];
    if (!item || !(this.save.consumables?.[id] > 0)) return;
    this.save.consumables[id]--;
    this.say(`${item.name}을(를) 사용한다.`, 'necro');
    const e = item.effect;
    if (e.op === 'heal') {
      const amt = Math.round(this.golem.maxHp * e.ratio);
      this.healGolem(amt);
      this.say(`골렘이 ${amt} 회복했다.`, 'good');
    } else if (e.op === 'rank') {
      const t = e.target === 'enemy' ? this.mon : this.golem;
      t.ranks[e.stat] = Math.max(-4, Math.min(4, t.ranks[e.stat] + e.delta));
      this.say(`${this.nameOf(t)}의 방어가 ${e.delta > 0 ? '올랐다' : '떨어졌다'}.`,
               e.target === 'enemy' ? 'good' : 'good');
    }
  }

  /**
   * 관찰 (§5.9) — 한 턴을 내주고 **이 전투 내내 적의 다음 수를 본다.**
   *
   * 전에는 방어 속성만 알려 줬는데, 그건 한 대 때려 보면 「효과가 굉장했다」로 그냥 알 수 있었다.
   * 턴을 쓰고 맞기까지 하면서 살 정보가 아니었다. 이제 세 가지를 준다 —
   * 상성 표시, **적의 다음 기술**, 그리고 몸을 낮춘 그 턴의 회피.
   */
  observe() {
    this.save.seen ??= {};
    this.save.seen[this.mon.defId] = true;
    this.watched = true;
    this.monNext ??= this.pickMonsterSkill();
    this.say(`${this.mon.name}을(를) 살핀다. 방어 속성은 ${this.mon.defElement}.`, 'necro');
    const nx = DB.skillsBy[this.monNext];
    if (nx) this.say(`숨을 고르는 품이 보인다 — 다음은 「${nx.name}」다.`, 'necro');
    this.say('이제 이 싸움이 끝날 때까지 다음 수가 보인다.', 'good');
    // 몸을 낮추고 살피는 동안은 덜 맞는다
    this.golem.ranks.eva = Math.min(4, (this.golem.ranks.eva ?? 0) + 1);
    this.say('골렘이 자세를 낮춘다. 회피가 올랐다.', 'good');
  }

  /* ── 턴 종료 ──────────────────────────────────────── */
  endOfTurn() {
    // 소환수의 남은 턴은 여기서 센다 — 그 턴의 적 공격까지 막아 준 뒤에 흩어진다
    if (this.summon) {
      const info = DB.summonsBy[this.summon.id];
      if (--this.summon.left <= 0) {
        this.say(`${info.name}이(가) 먼지가 되어 흩어진다.`, 'dim');
        this.summon = null;
      }
    }
    for (const u of [this.mon, this.golem]) this.tickStatuses(u);
    // 다음 턴에 적이 쓸 기술을 지금 정한다. 관찰했다면 그것이 화면에 보인다
    this.monNext = this.pickMonsterSkill();
    for (const [sid, left] of Object.entries(this.rechargeClock)) {
      const s = DB.skillsBy[sid];
      const speed = 1 + Math.floor((this.golem.stats.focus ?? 0) / 6);
      const next = left - speed;
      if (next <= 0) {
        this.charges[sid] = Math.min(s.charges, (this.charges[sid] ?? 0) + 1);
        delete this.rechargeClock[sid];
      } else this.rechargeClock[sid] = next;
    }
    for (const k of Object.keys(this.necroCd)) {
      if (this.necroCd[k] > 0) this.necroCd[k]--;
    }
    this.will = Math.min(WILL_MAX, this.will + WILL_GAIN);
  }

  /**
   * 중독·화상은 방어도를 지나쳐 핵을 직접 갉는다 (§5.7).
   * 다만 **한 전투에서 핵의 DOT_CAP까지만** 가져간다.
   * 그러지 않으면 보스전(15~20턴)에서 도트만으로 핵이 반드시 비는데,
   * 그건 압박이 아니라 산수로 정해진 처형이다 — 실제로 부푼 어머니가
   * 방어도를 631 남긴 채 핵만 0으로 만들고 있었다.
   */
  coreDot(n) {
    const cap = Math.round(this.golem.maxHp * DOT_CAP);
    const left = Math.max(0, cap - this.dotTaken);
    const dealt = Math.min(n, left);
    this.dotTaken += dealt;
    this.golem.hp -= dealt;
    return dealt;
  }

  tickStatuses(u) {
    const st = u.statuses;
    if (st['중독']) {
      const raw = st['중독'].stacks;
      const n = u === this.golem ? this.coreDot(raw) : raw;
      if (u !== this.golem) u.hp -= n;
      if (n > 0) {
        this.say(u === this.golem
          ? `독이 이음새를 타고 흘러 핵을 ${n} 갉는다. (방어도를 지나친다)`
          : `${this.nameOf(u)}이(가) 중독으로 ${n}의 피해를 입는다.`,
          u === this.mon ? 'good' : 'bad', u === this.golem ? { hit: 'golem' } : null);
      } else if (u === this.golem) {
        this.say('독이 더 파고들 곳을 찾지 못한다.', 'dim');
      }
      st['중독'].stacks--;
      if (st['중독'].stacks <= 0) delete st['중독'];
    }
    if (st['화상']) {
      const raw = Math.max(1, Math.round(u.maxHp * BURN_RATIO));
      const n = u === this.golem ? this.coreDot(raw) : raw;
      if (u !== this.golem) u.hp -= n;
      if (n > 0) {
        this.say(u === this.golem
          ? `불길이 부속 틈으로 파고들어 핵을 ${n} 태운다. (방어도를 지나친다)`
          : `${this.nameOf(u)}이(가) 화상으로 ${n}의 피해를 입는다.`,
          u === this.mon ? 'good' : 'bad', u === this.golem ? { hit: 'golem' } : null);
      }
    }
    if (st['재생']) {
      const n = Math.round(u.maxHp * 0.08);
      u.hp = Math.min(u.maxHp, u.hp + n);
      this.say(`${this.nameOf(u)}이(가) ${n} 회복한다.`, u === this.mon ? 'bad' : 'good');
    }
    for (const [k, v] of Object.entries(st)) {
      if (v.duration != null) {
        v.duration--;
        if (v.duration <= 0) delete st[k];
      }
    }
  }

  checkEnd() {
    if (this.mon.hp <= 0) {
      this.mon.hp = 0;
      this.over = true;
      this.result = 'win';
      this.say(`${this.mon.name}이(가) 쓰러진다.`, 'good', { win: true });
      return true;
    }
    if (this.golem.hp <= 0) {
      this.golem.hp = 0;
      this.over = true;
      this.result = 'lose';
      this.say('핵이 쪼개진다. 골렘이 무너져 내린다.', 'bad', { defeat: true, big: true });
      return true;
    }
    const frames = Object.values(this.frames);
    if (frames.length && frames.every((f) => f.down)) {
      this.over = true;
      this.result = 'lose';
      this.say('모든 부위의 방어가 무너졌다. 골렘은 더 이상 움직이지 못한다.', 'bad');
      return true;
    }
    return false;
  }
}
