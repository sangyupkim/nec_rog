/** 커맨드 턴제 전투 엔진. DOM에 의존하지 않으므로 콘솔 시뮬레이션에도 쓸 수 있다. */
import {
  DB, damage, elemMul, rankMul, addStatus, hasStatus,
  assembleGolem, skillElement, partSkills, partName,
  MON_FRAME_RATIO, AIM, RAW_FAIL_CHANCE, SLOT_LABEL,
} from './core.js';

const WILL_START = 3, WILL_MAX = 10, WILL_GAIN = 1;
const MON_SLOT_LABEL = { head: '머리', body: '몸통', arm: '팔', leg: '다리' };

export class Combat {
  constructor(save, monster, rng) {
    this.save = save;
    this.rng = rng;
    this.mon = monster;
    this.log = [];
    this.phase = 'intro';   // 로그를 국면별로 묶어 UI가 사이에 텀을 둘 수 있게 한다 (§5.8)
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
    this.frames = {};
    for (const { slot, part, shieldMax: max, shield } of g.worn) {
      this.frames[slot] = { slot, part, hp: shield, max, down: shield <= 0 };
    }
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

  /** 조준 부위 전환 — 매 턴 클릭을 늘리지 않도록 토글로 둔다 */
  cycleAim() {
    const order = ['random', 'upper', 'lower'];
    this.aim = order[(order.indexOf(this.aim) + 1) % order.length];
    return AIM[this.aim];
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

    // 네크로맨서 술법·아이템·관찰은 골렘의 행동을 대신한다 (그 턴 골렘은 공격하지 않는다)
    if (action.kind === 'necro') { this.useNecro(action.id); golemActed = true; }
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
      const hits = s.hits ?? 1;
      let total = 0;
      for (let i = 0; i < hits; i++) {
        if (!this.rollHit(this.golem, this.mon, s.accuracy + conf.acc)) {
          this.say(`${this.mon.name}이(가) 몸을 비틀어 피했다.`, 'dim');
          continue;
        }
        total += this.dealDamage(this.golem, this.mon, s.power, el);
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
        this.save.seen ??= {};
        this.save.seen[this.mon.defId] = true;
        this.say(`${this.mon.name}의 약점이 드러난다. (방어 속성: ${this.mon.defElement})`, 'good');
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
    const sid = this.pickMonsterSkill();
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

  dealDamage(from, to, power, element) {
    let dmg = damage({
      power,
      atk: from.stats.atk,
      def: to.stats.def ?? 0,
      atkEl: element,
      defEl: to.defElement,
      atkRank: from.ranks.atk,
      defRank: to.ranks.def,
    });
    if (hasStatus(from, '화상')) dmg = Math.floor(dmg * 0.75);
    if (hasStatus(to, '균열')) dmg = Math.floor(dmg * 1.5);
    if (this.rng.chance(5)) { dmg = Math.floor(dmg * 1.5); this.say('급소에 들어갔다!', 'good', { big: true }); }

    if (to === this.golem) {
      const leak = this.absorb(dmg);
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
      from.hp -= thorn;
      this.say(`가시가 ${this.nameOf(from)}을(를) 되찌른다. (${thorn}${from === this.golem ? ' · 핵 직격' : ''})`,
        'dim', from === this.golem ? { hit: 'golem' } : null);
    }
    return dmg;
  }

  /**
   * 골렘이 받은 피해를 방어도로 막는다. 막지 못한 만큼만 핵으로 넘어간다 (§5.7).
   * @returns 핵에 닿은 피해
   */
  absorb(dmg) {
    let left = dmg;
    // 조준된 부위가 먼저 맞고, 모자라면 남은 부위가 이어 받는다
    const first = this.pickFrame(this.frames, 'slots');
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
    if (left < dmg) this.say(`방어도가 ${dmg - left}을(를) 받아냈다.`, 'dim', { hit: 'golem' });
    return left;
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

    s.left--;
    if (s.left <= 0) {
      this.say(`${info.name}이(가) 먼지가 되어 흩어진다.`, 'dim');
      this.summon = null;
    }
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

  observe() {
    this.save.seen ??= {};
    this.save.seen[this.mon.defId] = true;
    this.say(`${this.mon.name}을(를) 관찰한다. 방어 속성은 ${this.mon.defElement}.`, 'necro');
    this.say('이제 스킬 옆에 상성이 표시된다.', 'dim');
  }

  /* ── 턴 종료 ──────────────────────────────────────── */
  endOfTurn() {
    for (const u of [this.mon, this.golem]) this.tickStatuses(u);
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

  tickStatuses(u) {
    const st = u.statuses;
    if (st['중독']) {
      const n = st['중독'].stacks;
      u.hp -= n;
      this.say(u === this.golem
        ? `독이 이음새를 타고 흘러 핵을 ${n} 갉는다. (방어도를 지나친다)`
        : `${this.nameOf(u)}이(가) 중독으로 ${n}의 피해를 입는다.`,
        u === this.mon ? 'good' : 'bad', u === this.golem ? { hit: 'golem' } : null);
      st['중독'].stacks--;
      if (st['중독'].stacks <= 0) delete st['중독'];
    }
    if (st['화상']) {
      const n = Math.max(1, Math.round(u.maxHp * 0.05));
      u.hp -= n;
      this.say(u === this.golem
        ? `불길이 부속 틈으로 파고들어 핵을 ${n} 태운다. (방어도를 지나친다)`
        : `${this.nameOf(u)}이(가) 화상으로 ${n}의 피해를 입는다.`,
        u === this.mon ? 'good' : 'bad', u === this.golem ? { hit: 'golem' } : null);
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
