//! The «Overheat» battle rules, ported 1:1 from the game's engine (app/src/engine/battle.ts) so the contract can
//! replay a battle from its log (seed + both decks + every action) and decide the result and the wear itself.
//! Only the rules — the AI is not needed to replay. A differential test replays battles played by the TypeScript
//! engine (`contract/fixtures/battles.json`, made by `app/scripts/export-battles.ts`) and checks the same results.

use near_sdk::serde::Deserialize;
use near_sdk::serde_json::Value;

pub const CORE_HP: i32 = 20;
const BOARD_SLOTS: usize = 5;
const MAX_TURNS: u32 = 10;
const START_HAND: usize = 3;
const MAX_HAND: usize = 6;
const HEAT_PER_ATTACK: i32 = 2;
const HEAT_COOL_PER_TURN: i32 = 1;
const VENT_COOL: i32 = 3;
const HEAT_CAP: i32 = 4;
const HEAT_CAP_BASIC: i32 = 6;
const SHOCK_HEAT: i32 = 2;
const PATCH_PER_TURN: i32 = 1;
const VET_WINS: [u32; 3] = [3, 8, 15];
const VET_HP: [i32; 4] = [0, 0, 1, 2];

#[derive(Clone, Copy, PartialEq)]
pub enum Kind {
    None,
    Armor,
    Maneuver,
    Repair,
    Blast,
    Charge,
    Shock,
}

#[derive(Clone, Copy)]
pub struct Model {
    pub id: &'static str,
    pub cost: i32,
    pub atk: i32,
    pub hp: i32,
    pub kind: Kind,
    pub n: i32,
}

use Kind::*;
const fn m(id: &'static str, cost: i32, atk: i32, hp: i32, kind: Kind, n: i32) -> Model {
    Model { id, cost, atk, hp, kind, n }
}
/// The model table (app/src/engine/robots.ts MODELS).
pub const MODELS: [Model; 28] = [
    m("spark", 1, 2, 3, None, 0),
    m("bolt", 2, 3, 4, None, 0),
    m("volt", 3, 4, 6, None, 0),
    m("dozer", 4, 5, 6, None, 0),
    m("plate", 2, 1, 2, Armor, 1),
    m("wall", 3, 1, 3, Armor, 1),
    m("bastion", 4, 2, 3, Armor, 1),
    m("titan", 6, 3, 6, Armor, 1),
    m("scout", 1, 3, 3, Maneuver, 0),
    m("hound", 3, 4, 5, Maneuver, 0),
    m("ghost", 4, 4, 5, Maneuver, 0),
    m("raptor", 5, 5, 6, Maneuver, 0),
    m("drone", 1, 1, 1, Repair, 2),
    m("welder", 2, 2, 3, Repair, 2),
    m("medic", 4, 4, 5, Repair, 3),
    m("ark", 6, 5, 9, Repair, 5),
    m("cracker", 1, 2, 2, Blast, 1),
    m("mine", 3, 4, 3, Blast, 2),
    m("shrapnel", 5, 5, 7, Blast, 2),
    m("apoc", 6, 8, 9, Blast, 4),
    m("dash", 1, 2, 2, Charge, 1),
    m("ram", 2, 3, 2, Charge, 1),
    m("hammer", 3, 4, 3, Charge, 1),
    m("bull", 5, 4, 5, Charge, 1),
    m("zapper", 2, 2, 5, Shock, 0),
    m("arc", 3, 3, 6, Shock, 0),
    m("tesla", 4, 3, 6, Shock, 0),
    m("storm", 6, 5, 8, Shock, 0),
];

pub fn model(id: &str) -> Option<&'static Model> {
    MODELS.iter().find(|x| x.id == id)
}

/// mulberry32, bit-for-bit like app/src/engine/rng.ts
struct Rng(u32);
impl Rng {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        ((t ^ (t >> 14)) as f64) / 4_294_967_296.0
    }
    fn int(&mut self, max: usize) -> usize {
        (self.next() * max as f64).floor() as usize
    }
    fn shuffle(&mut self, a: &mut [String]) {
        let mut i = a.len();
        while i > 1 {
            i -= 1;
            let j = self.int(i + 1);
            a.swap(i, j);
        }
    }
}

#[derive(Deserialize, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct LogRobot {
    pub uid: String,
    #[serde(rename = "modelId")]
    pub model_id: String,
    pub vw: Option<u32>,
    pub dur: Option<u32>,
    #[serde(rename = "tokenId")]
    pub token_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct LogInput {
    pub seed: u64,
    pub a: Vec<LogRobot>,
    pub b: Vec<LogRobot>,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct BattleLog {
    pub input: LogInput,
    pub actions: Vec<Value>,
}

#[derive(Clone)]
struct Unit {
    uid: String,
    model: &'static Model,
    hp: i32,
    max_hp: i32,
    heat: i32,
    ready: bool,
    offline: bool,
    charge_bonus: i32,
    fresh: bool,
    pos: usize,
}

#[derive(Default, Clone, Copy)]
pub struct Wear {
    pub fielded: bool,
    pub destroyed: bool,
    pub overheated: bool,
}

struct Side {
    core: i32,
    deck: Vec<String>,
    hand: Vec<String>,
    board: Vec<Unit>,
    energy: i32,
    turns: u32,
}

pub struct Battle {
    active: usize,
    sides: [Side; 2],
    models: Vec<(String, &'static Model, i32)>, // uid, model, hp bonus
    pub wear: Vec<(String, Wear)>,
    /// None — ongoing; Some(None) — draw; Some(Some(side)) — that side won
    pub winner: Option<Option<usize>>,
}

enum Target {
    Unit(usize, String),
    Core(usize),
}

fn heat_cap(m: &Model) -> i32 {
    if m.kind == None { HEAT_CAP_BASIC } else { HEAT_CAP }
}
fn armor(u: &Unit) -> i32 {
    if u.model.kind == Armor { u.model.n } else { 0 }
}

impl Battle {
    pub fn new(a: &[LogRobot], b: &[LogRobot], seed: u64) -> Result<Battle, String> {
        let mut rng = Rng((seed & 0xffff_ffff) as u32);
        let mut models = vec![];
        let mut wear = vec![];
        let mut mk = |team: &[LogRobot], extra: usize, rng: &mut Rng| -> Result<Side, String> {
            for r in team {
                let md = model(&r.model_id).ok_or("unknown model")?;
                let rank = VET_WINS.iter().filter(|x| r.vw.unwrap_or(0) >= **x).count();
                if models.iter().any(|(u, _, _): &(String, &Model, i32)| *u == r.uid) {
                    return Err("duplicate robot".into());
                }
                models.push((r.uid.clone(), md, VET_HP[rank]));
                wear.push((r.uid.clone(), Wear::default()));
            }
            let mut deck: Vec<String> = team.iter().map(|r| r.uid.clone()).collect();
            rng.shuffle(&mut deck);
            let n = (START_HAND + extra).min(deck.len());
            let hand: Vec<String> = deck.drain(..n).collect();
            Ok(Side { core: CORE_HP, deck, hand, board: vec![], energy: 0, turns: 0 })
        };
        let sa = mk(a, 0, &mut rng)?;
        let sb = mk(b, 1, &mut rng)?;
        let mut st = Battle { active: 0, sides: [sa, sb], models, wear, winner: Option::None };
        st.start_turn();
        Ok(st)
    }

    fn model_of(&self, uid: &str) -> Option<(&'static Model, i32)> {
        self.models.iter().find(|(u, _, _)| u == uid).map(|(_, m, b)| (*m, *b))
    }
    fn wear_mut(&mut self, uid: &str) -> &mut Wear {
        let i = self.wear.iter().position(|(u, _)| u == uid).unwrap();
        &mut self.wear[i].1
    }
    fn unit_idx(&self, side: usize, uid: &str) -> Option<usize> {
        self.sides[side].board.iter().position(|u| u.uid == uid)
    }

    fn start_turn(&mut self) {
        let a = self.active;
        let me = &mut self.sides[a];
        me.turns += 1;
        me.energy = (me.turns as i32 + 1).min(6);
        if !me.deck.is_empty() && me.hand.len() < MAX_HAND {
            let uid = me.deck.remove(0);
            me.hand.push(uid);
        }
        for u in me.board.iter_mut() {
            u.heat = (u.heat - HEAT_COOL_PER_TURN).max(0);
            u.charge_bonus = 0;
            u.fresh = false;
            if u.offline {
                u.offline = false;
                u.ready = false;
            } else {
                u.ready = true;
            }
        }
        // Repair robots patch the most damaged ally (first in board order on a tie), else the Core
        let repairers = me.board.iter().filter(|r| r.model.kind == Repair).count();
        for _ in 0..repairers {
            let mut best: Option<usize> = Option::None;
            for (i, u) in me.board.iter().enumerate() {
                if u.hp < u.max_hp {
                    match best {
                        Some(b) if me.board[b].max_hp - me.board[b].hp >= u.max_hp - u.hp => {}
                        _ => best = Some(i),
                    }
                }
            }
            if let Some(i) = best {
                let amount = PATCH_PER_TURN.min(me.board[i].max_hp - me.board[i].hp);
                me.board[i].hp += amount;
            } else if me.core < CORE_HP {
                me.core += PATCH_PER_TURN;
            }
        }
    }

    fn end_turn(&mut self) {
        if self.winner.is_some() {
            return;
        }
        for u in self.sides[self.active].board.iter_mut() {
            u.charge_bonus = 0;
        }
        if self.active == 1 && self.sides[1].turns >= MAX_TURNS {
            let (a, b) = (self.sides[0].core, self.sides[1].core);
            self.winner = Some(if a == b { Option::None } else if a > b { Some(0) } else { Some(1) });
            return;
        }
        self.active = 1 - self.active;
        self.start_turn();
    }

    fn damage(&mut self, side: usize, i: usize, dmg: i32) {
        if dmg <= 0 {
            return;
        }
        self.sides[side].board[i].hp -= dmg;
    }

    fn check_winner(&mut self) {
        let (a, b) = (self.sides[0].core, self.sides[1].core);
        if a <= 0 || b <= 0 {
            self.winner = Some(if a <= 0 && b <= 0 { Option::None } else if a <= 0 { Some(1) } else { Some(0) });
        }
    }

    fn resolve_deaths(&mut self) {
        for _ in 0..20 {
            let mut dead: Vec<(usize, Unit)> = vec![];
            for side in 0..2 {
                for u in &self.sides[side].board {
                    if u.hp <= 0 {
                        dead.push((side, u.clone()));
                    }
                }
            }
            if dead.is_empty() {
                return;
            }
            for (side, u) in &dead {
                self.sides[*side].board.retain(|x| x.uid != u.uid);
                self.wear_mut(&u.uid).destroyed = true;
            }
            for (side, u) in &dead {
                if u.model.kind != Blast {
                    continue;
                }
                let n = u.model.n;
                let en = 1 - side;
                for i in 0..self.sides[en].board.len() {
                    let dmg = (n - armor(&self.sides[en].board[i])).max(0);
                    self.damage(en, i, dmg);
                }
            }
        }
    }

    fn deploy_targets(&self, side: usize, md: &Model) -> Vec<Target> {
        match md.kind {
            Repair => {
                let me = &self.sides[side];
                let mut t: Vec<Target> =
                    me.board.iter().filter(|u| u.hp < u.max_hp || u.heat > 0).map(|u| Target::Unit(side, u.uid.clone())).collect();
                if me.core < CORE_HP {
                    t.push(Target::Core(side));
                }
                t
            }
            Shock => self.sides[1 - side].board.iter().filter(|u| !u.offline).map(|u| Target::Unit(1 - side, u.uid.clone())).collect(),
            _ => vec![],
        }
    }

    fn auto_target(&self, side: usize, md: &Model, targets: Vec<Target>) -> Option<Target> {
        let score = |t: &Target| -> f64 {
            match t {
                Target::Core(_) => {
                    if md.kind == Repair {
                        (CORE_HP - self.sides[side].core) as f64 * 0.8
                    } else {
                        0.0
                    }
                }
                Target::Unit(s, uid) => {
                    let u = &self.sides[*s].board[self.unit_idx(*s, uid).unwrap()];
                    if md.kind == Repair {
                        (u.max_hp - u.hp) as f64 + u.heat as f64 * 0.8 + u.model.atk as f64 * 0.2
                    } else {
                        u.model.atk as f64 * 2.0 + u.model.hp as f64 * 0.3 + if u.ready { 1.0 } else { 0.0 }
                    }
                }
            }
        };
        let mut best: Option<(f64, Target)> = Option::None;
        for t in targets {
            let s = score(&t);
            if best.as_ref().map(|(b, _)| s > *b).unwrap_or(true) {
                best = Some((s, t));
            }
        }
        best.map(|(_, t)| t)
    }

    fn attack_targets(&self, side: usize, u: &Unit) -> Vec<String> {
        let en = &self.sides[1 - side];
        let guards: Vec<String> = en.board.iter().filter(|x| x.model.kind == Armor).map(|x| x.uid.clone()).collect();
        if !guards.is_empty() && u.model.kind != Maneuver {
            return guards;
        }
        let mut t: Vec<String> = en.board.iter().map(|x| x.uid.clone()).collect();
        if !u.fresh {
            t.push("core".into());
        }
        t
    }

    /// Applies one action (as JSON, like the game's log). Err = illegal.
    pub fn apply(&mut self, a: &Value) -> Result<(), String> {
        if self.winner.is_some() {
            return Err("The battle is over".into());
        }
        let side = self.active;
        let t = a["t"].as_str().ok_or("bad action")?;
        match t {
            "end" => {
                self.end_turn();
                Ok(())
            }
            "deploy" => {
                let uid = a["uid"].as_str().ok_or("bad action")?.to_string();
                let hi = self.sides[side].hand.iter().position(|x| *x == uid).ok_or("not in hand")?;
                let (md, bonus) = self.model_of(&uid).ok_or("unknown robot")?;
                if md.cost > self.sides[side].energy {
                    return Err("Not enough energy".into());
                }
                if self.sides[side].board.len() >= BOARD_SLOTS {
                    return Err("board full".into());
                }
                let targets = self.deploy_targets(side, md);
                let target: Option<Target> = match a.get("target") {
                    Some(tv) if !tv.is_null() => {
                        let ts = tv["side"].as_u64().ok_or("bad target")? as usize;
                        let ok_t = if tv.get("core").map(|c| c.as_bool() == Some(true)).unwrap_or(false) {
                            targets.iter().any(|x| matches!(x, Target::Core(s) if *s == ts)).then(|| Target::Core(ts))
                        } else {
                            let tu = tv["uid"].as_str().ok_or("bad target")?;
                            targets.iter().any(|x| matches!(x, Target::Unit(s, u) if *s == ts && u == tu)).then(|| Target::Unit(ts, tu.to_string()))
                        };
                        Some(ok_t.ok_or("Invalid target")?)
                    }
                    _ => {
                        if targets.is_empty() {
                            Option::None
                        } else {
                            self.auto_target(side, md, targets)
                        }
                    }
                };
                let taken: Vec<usize> = self.sides[side].board.iter().map(|u| u.pos).collect();
                let pos = match a.get("slot").and_then(|s| s.as_i64()) {
                    Some(s) => {
                        if s < 0 || s as usize >= BOARD_SLOTS || taken.contains(&(s as usize)) {
                            return Err("This slot is taken".into());
                        }
                        s as usize
                    }
                    Option::None => (0..BOARD_SLOTS).find(|i| !taken.contains(i)).unwrap(),
                };
                let me = &mut self.sides[side];
                me.energy -= md.cost;
                me.hand.remove(hi);
                let charge = md.kind == Charge;
                me.board.push(Unit {
                    uid: uid.clone(),
                    model: md,
                    hp: md.hp + bonus,
                    max_hp: md.hp + bonus,
                    heat: 0,
                    ready: charge,
                    offline: false,
                    charge_bonus: if charge { md.n } else { 0 },
                    fresh: charge,
                    pos,
                });
                self.wear_mut(&uid).fielded = true;
                if md.kind == Repair {
                    match &target {
                        Some(Target::Core(_)) => {
                            let me = &mut self.sides[side];
                            let amount = md.n.min(CORE_HP - me.core);
                            me.core += amount;
                        }
                        Some(Target::Unit(_, tu)) => {
                            let i = self.unit_idx(side, tu).unwrap();
                            let t = &mut self.sides[side].board[i];
                            let amount = md.n.min(t.max_hp - t.hp);
                            t.hp += amount;
                            t.heat = 0;
                        }
                        Option::None => {}
                    }
                }
                if md.kind == Shock {
                    if let Some(Target::Unit(_, tu)) = target {
                        let i = self.unit_idx(1 - side, &tu).unwrap();
                        let t = &mut self.sides[1 - side].board[i];
                        t.offline = true;
                        t.ready = false;
                    }
                }
                Ok(())
            }
            "vent" => {
                let uid = a["uid"].as_str().ok_or("bad action")?;
                let i = self.unit_idx(side, uid).ok_or("No such robot")?;
                let u = &mut self.sides[side].board[i];
                if !u.ready {
                    return Err("cannot act".into());
                }
                let cooled = u.heat.min(VENT_COOL);
                u.heat -= cooled;
                u.ready = false;
                Ok(())
            }
            "attack" => {
                let from = a["from"].as_str().ok_or("bad action")?;
                let to = a["to"].as_str().ok_or("bad action")?.to_string();
                let ui = self.unit_idx(side, from).ok_or("No such robot")?;
                let u = self.sides[side].board[ui].clone();
                if !u.ready {
                    return Err("cannot attack".into());
                }
                if !self.attack_targets(side, &u).contains(&to) {
                    return Err("must attack a guard".into());
                }
                let atk = u.model.atk + u.charge_bonus;
                {
                    let me = &mut self.sides[side].board[ui];
                    me.charge_bonus = 0;
                    me.ready = false;
                }
                if to == "core" {
                    self.sides[1 - side].core -= atk;
                } else {
                    let ti = self.unit_idx(1 - side, &to).unwrap();
                    let tgt = self.sides[1 - side].board[ti].clone();
                    let dmg = (atk - armor(&tgt)).max(0);
                    let counter = (tgt.model.atk - armor(&u)).max(0);
                    self.damage(1 - side, ti, dmg);
                    self.damage(side, ui, counter);
                    if u.model.kind == Shock && self.sides[1 - side].board[ti].hp > 0 {
                        let t = &mut self.sides[1 - side].board[ti];
                        t.heat += SHOCK_HEAT;
                        if t.heat >= heat_cap(t.model) {
                            t.offline = true;
                            t.ready = false;
                            t.heat = 0;
                            let id = t.uid.clone();
                            self.wear_mut(&id).overheated = true;
                        }
                    }
                }
                // the attacker heats up
                let me = &mut self.sides[side].board[ui];
                me.heat += HEAT_PER_ATTACK;
                if me.heat >= heat_cap(me.model) && me.hp > 0 {
                    me.offline = true;
                    me.heat = 0;
                    let id = me.uid.clone();
                    self.wear_mut(&id).overheated = true;
                }
                self.resolve_deaths();
                self.check_winner();
                Ok(())
            }
            _ => Err("bad action".into()),
        }
    }

    /// Wear after the battle (battle.ts wearLoss): light = the player's rules (only destroyed / overheated wear).
    pub fn wear_loss(&self, uid: &str, light: bool) -> u32 {
        let w = match self.wear.iter().find(|(u, _)| u == uid) {
            Some((_, w)) => *w,
            Option::None => return 0,
        };
        if !w.fielded {
            return 0;
        }
        let extra = w.destroyed as u32 + w.overheated as u32;
        if light { extra } else { (1 + extra).min(3) }
    }
}

/// Replays a log to its end. Err if any action is illegal or the battle doesn't finish.
pub fn replay(log: &BattleLog) -> Result<Battle, String> {
    require_len(log.actions.len())?;
    let mut b = Battle::new(&log.input.a, &log.input.b, log.input.seed)?;
    for (i, a) in log.actions.iter().enumerate() {
        b.apply(a).map_err(|e| format!("action {} is illegal: {e}", i + 1))?;
    }
    if b.winner.is_none() {
        return Err("the log ends before the battle does".into());
    }
    Ok(b)
}

fn require_len(n: usize) -> Result<(), String> {
    if n > 400 { Err("log too long".into()) } else { Ok(()) }
}
