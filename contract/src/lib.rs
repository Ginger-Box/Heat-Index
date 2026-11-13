//! HEAT INDEX on NEAR — the game's ledger as a NEP-245 multi-token contract.
//!
//! * Token `cr` — credits (fungible inside the multi-token contract).
//! * Token `robot:<model>:<serial>` — one robot (supply 1) with on-chain metadata: model and durability.
//! * A player `register`s once and receives the starter robots and starting credits.
//! * Every trade (`buy_robot`, `sell_robot`, `repair_robot`) and every battle result (`record_battle`) is a
//!   transaction that mints / burns tokens and emits NEP-245 events (`mt_mint`, `mt_burn`, `mt_transfer`)
//!   plus a `heat_index` event with the game details — so the whole economy can be replayed from the chain.
//!
//! Trust model (hackathon version): the market and the battles are simulated in the client, so prices,
//! rewards and wear are reported by the player's client and only sanity-checked here (bounded rewards,
//! the robot must belong to the caller, credits can't go negative). The next step is a verifier that
//! re-runs battles from their seed, so results can't be forged.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::store::{IterableSet, LookupMap};
use near_sdk::{env, near, require, AccountId, Allowance, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseResult, PublicKey};

pub const CREDITS: &str = "cr";
const START_CREDITS: u128 = 1_000;
/// The robots every new player starts with (same as the game's starter deck).
const STARTER: [&str; 12] = [
    "spark", "scout", "bolt", "ram", "welder", "volt", "wall", "dozer", "drone", "cracker", "dash", "plate",
];
/// The game's robot models and their energy cost (app/src/engine/robots.ts). The contract prices from this table,
/// so a client can't invent prices: base price = BASE_PRICE[cost], max durability = 4 + 2 × cost.
const MODELS: [(&str, u32); 28] = [
    ("spark", 1), ("bolt", 2), ("volt", 3), ("dozer", 4), ("plate", 2), ("wall", 3), ("bastion", 4), ("titan", 6),
    ("scout", 1), ("hound", 3), ("ghost", 4), ("raptor", 5), ("drone", 1), ("welder", 2), ("medic", 4), ("ark", 6),
    ("cracker", 1), ("mine", 3), ("shrapnel", 5), ("apoc", 6), ("dash", 1), ("ram", 2), ("hammer", 3), ("bull", 5),
    ("zapper", 2), ("arc", 3), ("tesla", 4), ("storm", 6),
];
const BASE_PRICE: [u128; 7] = [0, 30, 55, 100, 180, 320, 560];
/// The market's price range, from the game's pricing rules (app/src/engine/pricing.ts), in % of the base price:
/// fair = base × (0.5…1.5 relevance) × (0.6…1.6 stock); ask = fair × (1 + markup ≤ 15%);
/// bid = fair × (1 − markup) × wear factor.
const BUY_MIN_PCT: u128 = 30;
const BUY_MAX_PCT: u128 = 280;
const SELL_MAX_PCT: u128 = 240;
/// A full repair (empty → full bar) costs at least this % of the base price (fair × 30% × missing, fair ≥ 0.3 base).
const REPAIR_MIN_PCT: u128 = 8;
/// A battle pays at most this % of the base value of the player's robots, and never more than MAX_REWARD.
const REWARD_MAX_PCT: u128 = 25;
const MAX_REWARD: u128 = 400;
/// One battle result per account per this many milliseconds (a real battle takes minutes).
const BATTLE_COOLDOWN_MS: u64 = 30_000;
/// Veteran ranks (same as the game's engine/veteran.ts): wins needed for ★ / ★★ / ★★★, and how much more a broker
/// may pay for a robot of that rank (% of the normal sell limit).
const VET_WINS: [u32; 3] = [3, 8, 15];
const VET_PRICE_PCT: [u128; 4] = [100, 115, 135, 160];

fn vet_rank(wins: u32) -> usize {
    VET_WINS.iter().filter(|&&w| wins >= w).count()
}

fn model_cost(model_id: &str) -> u32 {
    MODELS
        .iter()
        .find(|(id, _)| *id == model_id)
        .map(|(_, c)| *c)
        .unwrap_or_else(|| env::panic_str("Unknown robot model"))
}
fn base_price(model_id: &str) -> u128 {
    BASE_PRICE[model_cost(model_id) as usize]
}
fn max_durability(model_id: &str) -> u32 {
    4 + 2 * model_cost(model_id)
}

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Balances,
    Supply,
    Robots,
    Players,
    Owned,
    OwnedSet { account_hash: Vec<u8> },
    OwnerKeys,
    LastBattle,
    Records,
}

/// New player accounts get this much NEAR for gas, and the game key may spend up to GAME_KEY_ALLOWANCE of it.
const NEW_ACCOUNT_FUNDING: NearToken = NearToken::from_millinear(150);
const GAME_KEY_ALLOWANCE: NearToken = NearToken::from_millinear(120);
const GAME_METHODS: &str = "register,buy_robot,sell_robot,repair_robot,record_battle";
/// At most this many new accounts per hour (the sponsor key is public on testnet).
const ACCOUNTS_PER_HOUR: u32 = 40;

/// On-chain state of one robot token.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Robot {
    pub model_id: String,
    pub durability: u32,
    pub owner_id: AccountId,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Default)]
pub struct Player {
    pub wins: u32,
    pub losses: u32,
    pub draws: u32,
    pub battles: u32,
    pub trades: u32,
    pub registered_at_ms: u64,
}

/// A robot's battle record: every battle it fought on-chain and how many of them its team won.
/// Wins make a robot a veteran (★ 3, ★★ 8, ★★★ 15), and brokers pay more for veterans.
#[near(serializers = [borsh, json])]
#[derive(Clone, Default)]
pub struct Record {
    pub battles: u32,
    pub wins: u32,
    pub rank: u8,
}

/// One robot's wear after a battle, as reported by the client.
#[near(serializers = [json])]
pub struct Wear {
    pub token_id: String,
    pub durability: u32,
}

/// NEP-245 token view (`mt_token`).
#[near(serializers = [json])]
pub struct TokenView {
    pub token_id: String,
    pub owner_id: Option<AccountId>,
    pub metadata: Option<Robot>,
    /// the robot's battle record (veteran rank); none for credits and for robots that never fought
    pub record: Option<Record>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner_id: AccountId,
    /// "token_id|account" -> balance
    balances: LookupMap<String, u128>,
    supply: LookupMap<String, u128>,
    robots: LookupMap<String, Robot>,
    players: LookupMap<AccountId, Player>,
    /// robot token ids per owner (enumeration)
    owned: LookupMap<AccountId, IterableSet<String>>,
    next_serial: u64,
    total_battles: u64,
    total_trades: u64,
    /// NEAR Auth (email) key → the player account it owns, to find the account again after logging in
    owner_keys: LookupMap<String, AccountId>,
    hour_bucket: u64,
    created_this_hour: u32,
    /// when each player last recorded a battle (rate limit)
    last_battle: LookupMap<AccountId, u64>,
    /// robot token id -> battle record (veterans)
    records: LookupMap<String, Record>,
}

/// State layout of v0.3 (before veteran records) — used once by `migrate`.
#[near(serializers = [borsh])]
struct ContractV3 {
    owner_id: AccountId,
    balances: LookupMap<String, u128>,
    supply: LookupMap<String, u128>,
    robots: LookupMap<String, Robot>,
    players: LookupMap<AccountId, Player>,
    owned: LookupMap<AccountId, IterableSet<String>>,
    next_serial: u64,
    total_battles: u64,
    total_trades: u64,
    owner_keys: LookupMap<String, AccountId>,
    hour_bucket: u64,
    created_this_hour: u32,
    last_battle: LookupMap<AccountId, u64>,
}

fn bal_key(token_id: &str, account: &AccountId) -> String {
    format!("{token_id}|{account}")
}

fn event(standard: &str, version: &str, name: &str, data: serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": standard, "version": version, "event": name, "data": data })
    ));
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner_id: AccountId) -> Self {
        Self {
            owner_id,
            balances: LookupMap::new(Key::Balances),
            supply: LookupMap::new(Key::Supply),
            robots: LookupMap::new(Key::Robots),
            players: LookupMap::new(Key::Players),
            owned: LookupMap::new(Key::Owned),
            next_serial: 0,
            total_battles: 0,
            total_trades: 0,
            owner_keys: LookupMap::new(Key::OwnerKeys),
            hour_bucket: 0,
            created_this_hour: 0,
            last_battle: LookupMap::new(Key::LastBattle),
            records: LookupMap::new(Key::Records),
        }
    }

    /// One-off upgrade from v0.3: keeps all balances, robots and players, adds the robots' battle records.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let old: ContractV3 = env::state_read().unwrap_or_else(|| env::panic_str("No v0.3 state"));
        Self {
            owner_id: old.owner_id,
            balances: old.balances,
            supply: old.supply,
            robots: old.robots,
            players: old.players,
            owned: old.owned,
            next_serial: old.next_serial,
            total_battles: old.total_battles,
            total_trades: old.total_trades,
            owner_keys: old.owner_keys,
            hour_bucket: old.hour_bucket,
            created_this_hour: old.created_this_hour,
            last_battle: old.last_battle,
            records: LookupMap::new(Key::Records),
        }
    }

    // ---------------- account factory (email login without a server) ----------------

    /// Creates `<name>.<this contract>` for a new player and registers them in one go.
    /// * `owner_key` — the player's NEAR Auth (email login) key: full access, so the account is truly theirs;
    /// * `game_key` — a key generated in the player's browser, limited to this contract's game methods,
    ///   so the game can sign moves without a popup.
    /// Called through a public, function-call-only "sponsor" key of this contract; the contract pays the
    /// account's NEAR, and creation is rate-limited per hour.
    pub fn create_player_account(&mut self, name: String, owner_key: PublicKey, game_key: PublicKey) -> Promise {
        require!(
            name.len() >= 2
                && name.len() <= 24
                && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_'),
            "Name: 2-24 chars, a-z 0-9 - _"
        );
        let key_str = String::from(&owner_key);
        require!(self.owner_keys.get(&key_str).is_none(), "This login already has an account");
        let hour = env::block_timestamp_ms() / 3_600_000;
        if hour != self.hour_bucket {
            self.hour_bucket = hour;
            self.created_this_hour = 0;
        }
        require!(self.created_this_hour < ACCOUNTS_PER_HOUR, "Too many new accounts this hour, try later");
        self.created_this_hour += 1;
        let account_id: AccountId = format!("{name}.{}", env::current_account_id())
            .parse()
            .unwrap_or_else(|_| env::panic_str("Bad account name"));
        Promise::new(account_id.clone())
            .create_account()
            .transfer(NEW_ACCOUNT_FUNDING)
            .add_full_access_key(owner_key)
            .add_access_key_allowance(
                game_key,
                Allowance::limited(GAME_KEY_ALLOWANCE).unwrap(),
                env::current_account_id(),
                GAME_METHODS.to_string(),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(30))
                    .on_player_account(account_id, key_str),
            )
    }

    /// Callback: if the account was created, remember it for this login and register the player.
    #[private]
    pub fn on_player_account(&mut self, account_id: AccountId, owner_key: String) -> Option<AccountId> {
        if !matches!(env::promise_result(0), PromiseResult::Successful(_)) {
            return None; // e.g. the name was taken — nothing to undo
        }
        self.owner_keys.insert(owner_key, account_id.clone());
        if self.players.get(&account_id).is_none() {
            self.register_account(&account_id);
        }
        Some(account_id)
    }

    /// Owner only: forget which account a NEAR Auth key created, so the same login can get a new account
    /// (used when the player's browser lost its game key — e.g. a new device in this demo).
    pub fn forget_owner_key(&mut self, owner_key: String) {
        require!(env::predecessor_account_id() == self.owner_id, "Owner only");
        self.owner_keys.remove(&owner_key);
    }

    /// The player account created for a NEAR Auth (email) key, if any.
    pub fn account_for_owner_key(&self, owner_key: String) -> Option<AccountId> {
        self.owner_keys.get(&owner_key).cloned()
    }

    // ---------------- game actions (called by the player's game client) ----------------

    /// Join the arena: mints the starting credits and the starter robots to the caller (once).
    pub fn register(&mut self) -> Vec<String> {
        let who = env::predecessor_account_id();
        require!(self.players.get(&who).is_none(), "Already registered");
        self.register_account(&who)
    }

    fn register_account(&mut self, who: &AccountId) -> Vec<String> {
        let who = who.clone();
        self.players.insert(
            who.clone(),
            Player { registered_at_ms: env::block_timestamp_ms(), ..Default::default() },
        );
        self.mint_credits(&who, START_CREDITS, "starting credits");
        let ids: Vec<String> = STARTER.iter().map(|m| self.mint_robot(&who, m, max_durability(m), "starter robot")).collect();
        event(
            "heat_index",
            "1.0.0",
            "register",
            json!([{ "account_id": who, "credits": U128(START_CREDITS), "robots": ids }]),
        );
        ids
    }

    /// Buy a new robot from a broker for `price` credits. The price comes from the game's market, but it must lie in
    /// the market's possible range for that model (BUY_MIN_PCT…BUY_MAX_PCT of its base price, set on-chain).
    pub fn buy_robot(&mut self, model_id: String, price: U128, durability: u32, broker: String) -> String {
        let who = self.player();
        let base = base_price(&model_id);
        require!(
            price.0 * 100 >= base * BUY_MIN_PCT && price.0 * 100 <= base * BUY_MAX_PCT,
            "Price is outside this model's market range"
        );
        require!(durability >= 1 && durability <= max_durability(&model_id), "Durability out of range");
        self.burn_credits(&who, price.0, "buy robot");
        let id = self.mint_robot(&who, &model_id, durability, "bought from a broker");
        self.trade(&who, "buy", &id, price.0, &broker);
        id
    }

    /// Sell a robot to a broker: the robot token is burned, the credits are minted to the seller.
    /// The price can't exceed what a broker could pay for this model at this wear (SELL_MAX_PCT × wear factor).
    pub fn sell_robot(&mut self, token_id: String, price: U128, broker: String) {
        let who = self.player();
        let r = self.robots.get(&token_id).cloned().unwrap_or_else(|| env::panic_str("No such robot"));
        let max_d = max_durability(&r.model_id) as u128;
        let d = (r.durability as u128).min(max_d);
        // wear factor 15% … 100%, like the game's durabilityFactor (which is never above the linear one)
        let vet = VET_PRICE_PCT[self.records.get(&token_id).map(|x| x.rank as usize).unwrap_or(0)];
        let limit = base_price(&r.model_id) * SELL_MAX_PCT * vet * (15 * max_d + 85 * d) / (100 * 100 * 100 * max_d) + 1;
        require!(price.0 <= limit, "Price is above what any broker would pay for this robot");
        self.burn_robot(&who, &token_id, "sold to a broker");
        self.mint_credits(&who, price.0, "robot sold");
        self.trade(&who, "sell", &token_id, price.0, &broker);
    }

    /// Repair a robot: pay `cost` credits, raise its durability. The cost can't be below the game's cheapest
    /// possible repair for the restored durability, and durability can't exceed the model's maximum.
    pub fn repair_robot(&mut self, token_id: String, cost: U128, durability: u32) {
        let who = self.player();
        let mut r = self.robots.get(&token_id).cloned().unwrap_or_else(|| env::panic_str("No such robot"));
        require!(r.owner_id == who, "Not your robot");
        let max_d = max_durability(&r.model_id);
        require!(durability <= max_d, "Durability out of range");
        let from = r.durability.min(max_d);
        require!(durability >= from, "A repair can't lower durability");
        let base = base_price(&r.model_id);
        let min_cost = base * REPAIR_MIN_PCT * (durability - from) as u128 / (100 * max_d as u128);
        require!(cost.0 >= min_cost && cost.0 <= base, "Repair cost is out of range");
        self.burn_credits(&who, cost.0, "repair");
        r.durability = durability;
        self.robots.insert(token_id.clone(), r);
        self.trade(&who, "repair", &token_id, cost.0, "repair shop");
    }

    /// Record a finished battle: the reward is minted, the robots' durability is updated (broken robots stay
    /// as tokens with durability 0 until they are sold for scrap).
    /// `result`: 1 win, 0 loss, 2 draw. `seed` lets a verifier replay the battle later.
    /// Limits: one battle per BATTLE_COOLDOWN_MS per account; the reward is at most REWARD_MAX_PCT of the base value
    /// of the player's robots on-chain and at most MAX_REWARD; durability can only go down.
    pub fn record_battle(&mut self, opponent: String, result: u8, reward: U128, seed: u64, wear: Vec<Wear>) {
        let who = self.player();
        require!(result <= 2, "Bad result");
        let now = env::block_timestamp_ms();
        if let Some(last) = self.last_battle.get(&who) {
            require!(now >= last + BATTLE_COOLDOWN_MS, "One battle per 30 seconds");
        }
        self.last_battle.insert(who.clone(), now);
        let value: u128 = self
            .owned
            .get(&who)
            .map(|set| set.iter().filter_map(|t| self.robots.get(t)).map(|r| base_price(&r.model_id)).sum())
            .unwrap_or(0);
        require!(reward.0 <= MAX_REWARD && reward.0 * 100 <= value * REWARD_MAX_PCT, "Reward out of range");
        for w in &wear {
            let mut r = self.robots.get(&w.token_id).cloned().unwrap_or_else(|| env::panic_str("No such robot"));
            require!(r.owner_id == who, "Not your robot");
            require!(w.durability <= r.durability, "Durability can only go down in a battle");
            r.durability = w.durability;
            self.robots.insert(w.token_id.clone(), r);
            // the robot's battle record: a win counts for every robot that fought
            let mut rec = self.records.get(&w.token_id).cloned().unwrap_or_default();
            rec.battles += 1;
            if result == 1 {
                rec.wins += 1;
            }
            let rank = vet_rank(rec.wins) as u8;
            if rank > rec.rank {
                event("heat_index", "1.0.0", "veteran", json!([{ "account_id": who, "token_id": w.token_id, "rank": rank, "wins": rec.wins }]));
            }
            rec.rank = rank;
            self.records.insert(w.token_id.clone(), rec);
        }
        if reward.0 > 0 {
            self.mint_credits(&who, reward.0, "battle reward");
        }
        let mut p = self.players.get(&who).cloned().unwrap_or_default();
        match result {
            1 => p.wins += 1,
            0 => p.losses += 1,
            _ => p.draws += 1,
        }
        p.battles += 1;
        self.players.insert(who.clone(), p);
        self.total_battles += 1;
        event(
            "heat_index",
            "1.0.0",
            "battle",
            json!([{
                "account_id": who, "opponent": opponent, "result": result, "reward": reward, "seed": seed,
                "wear": wear.iter().map(|w| json!({ "token_id": w.token_id, "durability": w.durability })).collect::<Vec<_>>()
            }]),
        );
    }

    // ---------------- NEP-245 core ----------------

    /// Standard transfer (needs exactly 1 yoctoNEAR, as NEP-245 requires, so it is always a wallet-confirmed action).
    #[payable]
    pub fn mt_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        approval: Option<(AccountId, u64)>,
        memo: Option<String>,
    ) {
        require!(env::attached_deposit() == NearToken::from_yoctonear(1), "Requires exactly 1 yoctoNEAR");
        require!(approval.is_none(), "Approvals are not supported");
        let from = env::predecessor_account_id();
        require!(from != receiver_id, "Sender and receiver must differ");
        require!(amount.0 > 0, "Amount must be positive");
        self.sub(&token_id, &from, amount.0);
        self.add(&token_id, &receiver_id, amount.0);
        if let Some(mut r) = self.robots.get(&token_id).cloned() {
            r.owner_id = receiver_id.clone();
            self.robots.insert(token_id.clone(), r);
            self.untrack(&from, &token_id);
            self.track(&receiver_id, &token_id);
        }
        event(
            "nep245",
            "1.0.0",
            "mt_transfer",
            json!([{ "old_owner_id": from, "new_owner_id": receiver_id, "token_ids": [token_id], "amounts": [amount], "memo": memo }]),
        );
    }

    pub fn mt_balance_of(&self, account_id: AccountId, token_id: String) -> U128 {
        U128(self.balance(&token_id, &account_id))
    }

    pub fn mt_batch_balance_of(&self, account_id: AccountId, token_ids: Vec<String>) -> Vec<U128> {
        token_ids.iter().map(|t| U128(self.balance(t, &account_id))).collect()
    }

    pub fn mt_supply(&self, token_id: String) -> Option<U128> {
        self.supply.get(&token_id).map(|s| U128(*s))
    }

    pub fn mt_batch_supply(&self, token_ids: Vec<String>) -> Vec<Option<U128>> {
        token_ids.iter().map(|t| self.supply.get(t).map(|s| U128(*s))).collect()
    }

    pub fn mt_token(&self, token_ids: Vec<String>) -> Vec<Option<TokenView>> {
        token_ids
            .into_iter()
            .map(|t| {
                if t == CREDITS {
                    return Some(TokenView { token_id: t, owner_id: None, metadata: None, record: None });
                }
                self.robots.get(&t).map(|r| TokenView {
                    token_id: t.clone(),
                    owner_id: Some(r.owner_id.clone()),
                    metadata: Some(r.clone()),
                    record: self.records.get(&t).cloned(),
                })
            })
            .collect()
    }

    /// NEP-245 enumeration: robot tokens of an owner (credits are reported by `mt_balance_of(account, "cr")`).
    pub fn mt_tokens_for_owner(&self, account_id: AccountId, from_index: Option<U128>, limit: Option<u32>) -> Vec<TokenView> {
        let Some(set) = self.owned.get(&account_id) else { return vec![] };
        let start = from_index.map(|x| x.0 as usize).unwrap_or(0);
        set.iter()
            .skip(start)
            .take(limit.unwrap_or(50) as usize)
            .filter_map(|t| {
                self.robots.get(t).map(|r| TokenView {
                    token_id: t.clone(),
                    owner_id: Some(r.owner_id.clone()),
                    metadata: Some(r.clone()),
                    record: self.records.get(t).cloned(),
                })
            })
            .collect()
    }

    // ---------------- views for the game ----------------

    pub fn player_of(&self, account_id: AccountId) -> Option<Player> {
        self.players.get(&account_id).cloned()
    }

    pub fn stats(&self) -> serde_json::Value {
        json!({ "owner_id": self.owner_id, "battles": self.total_battles, "trades": self.total_trades, "robots_minted": self.next_serial })
    }

    // ---------------- internals ----------------

    fn player(&self) -> AccountId {
        let who = env::predecessor_account_id();
        require!(self.players.get(&who).is_some(), "Register first");
        who
    }

    fn balance(&self, token_id: &str, account: &AccountId) -> u128 {
        self.balances.get(&bal_key(token_id, account)).copied().unwrap_or(0)
    }

    fn add(&mut self, token_id: &str, account: &AccountId, amount: u128) {
        let k = bal_key(token_id, account);
        let b = self.balances.get(&k).copied().unwrap_or(0);
        self.balances.insert(k, b + amount);
    }

    fn sub(&mut self, token_id: &str, account: &AccountId, amount: u128) {
        let k = bal_key(token_id, account);
        let b = self.balances.get(&k).copied().unwrap_or(0);
        require!(b >= amount, "Not enough balance");
        if b == amount {
            self.balances.remove(&k);
        } else {
            self.balances.insert(k, b - amount);
        }
    }

    fn change_supply(&mut self, token_id: &str, delta: i128) {
        let s = self.supply.get(token_id).copied().unwrap_or(0) as i128 + delta;
        if s <= 0 {
            self.supply.remove(token_id);
        } else {
            self.supply.insert(token_id.to_string(), s as u128);
        }
    }

    fn mint_credits(&mut self, to: &AccountId, amount: u128, memo: &str) {
        self.add(CREDITS, to, amount);
        self.change_supply(CREDITS, amount as i128);
        event("nep245", "1.0.0", "mt_mint", json!([{ "owner_id": to, "token_ids": [CREDITS], "amounts": [U128(amount)], "memo": memo }]));
    }

    fn burn_credits(&mut self, from: &AccountId, amount: u128, memo: &str) {
        if amount == 0 {
            return;
        }
        self.sub(CREDITS, from, amount);
        self.change_supply(CREDITS, -(amount as i128));
        event("nep245", "1.0.0", "mt_burn", json!([{ "owner_id": from, "token_ids": [CREDITS], "amounts": [U128(amount)], "memo": memo }]));
    }

    fn mint_robot(&mut self, to: &AccountId, model_id: &str, durability: u32, memo: &str) -> String {
        model_cost(model_id); // panics on an unknown model
        self.next_serial += 1;
        let id = format!("robot:{model_id}:{}", self.next_serial);
        self.robots.insert(id.clone(), Robot { model_id: model_id.to_string(), durability, owner_id: to.clone() });
        self.add(&id, to, 1);
        self.change_supply(&id, 1);
        self.track(to, &id);
        event("nep245", "1.0.0", "mt_mint", json!([{ "owner_id": to, "token_ids": [id], "amounts": ["1"], "memo": memo }]));
        id
    }

    fn burn_robot(&mut self, from: &AccountId, token_id: &str, memo: &str) {
        let r = self.robots.get(token_id).cloned().unwrap_or_else(|| env::panic_str("No such robot"));
        require!(&r.owner_id == from, "Not your robot");
        self.sub(token_id, from, 1);
        self.change_supply(token_id, -1);
        self.robots.remove(token_id);
        self.records.remove(token_id);
        self.untrack(from, token_id);
        event("nep245", "1.0.0", "mt_burn", json!([{ "owner_id": from, "token_ids": [token_id], "amounts": ["1"], "memo": memo }]));
    }

    fn track(&mut self, owner: &AccountId, token_id: &str) {
        if self.owned.get(owner).is_none() {
            let set = IterableSet::new(Key::OwnedSet { account_hash: env::sha256(owner.as_bytes()) });
            self.owned.insert(owner.clone(), set);
        }
        self.owned.get_mut(owner).unwrap().insert(token_id.to_string());
    }

    fn untrack(&mut self, owner: &AccountId, token_id: &str) {
        if let Some(set) = self.owned.get_mut(owner) {
            set.remove(token_id);
        }
    }

    fn trade(&mut self, who: &AccountId, kind: &str, token_id: &str, amount: u128, counterparty: &str) {
        let mut p = self.players.get(who).cloned().unwrap_or_default();
        p.trades += 1;
        self.players.insert(who.clone(), p);
        self.total_trades += 1;
        event(
            "heat_index",
            "1.0.0",
            "trade",
            json!([{ "account_id": who, "kind": kind, "token_id": token_id, "amount": U128(amount), "counterparty": counterparty }]),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{get_logs, VMContextBuilder};
    use near_sdk::testing_env;

    fn ctx(who: &str) {
        ctx_at(who, 0);
    }
    fn ctx_at(who: &str, ms: u64) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(who.parse().unwrap())
            .block_timestamp(ms * 1_000_000)
            .build());
    }
    fn setup(who: &str) -> (Contract, Vec<String>) {
        ctx("game.testnet");
        let mut c = Contract::new("game.testnet".parse().unwrap());
        ctx(who);
        let ids = c.register();
        (c, ids)
    }

    #[test]
    fn full_loop() {
        let (mut c, ids) = setup("alice.testnet");
        assert_eq!(ids.len(), 12);
        let alice: AccountId = "alice.testnet".parse().unwrap();
        assert_eq!(c.mt_balance_of(alice.clone(), CREDITS.into()).0, 1000);
        assert_eq!(c.mt_tokens_for_owner(alice.clone(), None, None).len(), 12);
        assert!(get_logs().iter().any(|l| l.contains("\"standard\":\"nep245\"") && l.contains("mt_mint")));
        // starters get their model's durability (spark: cost 1 → 6)
        assert_eq!(c.mt_token(vec![ids[0].clone()])[0].as_ref().unwrap().metadata.as_ref().unwrap().durability, 6);

        // buy, battle, repair, sell — all within the market's limits
        let bought = c.buy_robot("titan".into(), U128(560), 16, "kessler".into());
        assert_eq!(c.mt_balance_of(alice.clone(), CREDITS.into()).0, 440);
        c.record_battle("npc3".into(), 1, U128(90), 42, vec![Wear { token_id: bought.clone(), durability: 14 }]);
        assert_eq!(c.mt_balance_of(alice.clone(), CREDITS.into()).0, 530);
        assert_eq!(c.mt_token(vec![bought.clone()])[0].as_ref().unwrap().metadata.as_ref().unwrap().durability, 14);
        c.repair_robot(bought.clone(), U128(30), 16);
        c.sell_robot(bought.clone(), U128(500), "magpie".into());
        assert_eq!(c.mt_balance_of(alice.clone(), bought.clone()).0, 0);
        assert_eq!(c.mt_balance_of(alice.clone(), CREDITS.into()).0, 1000);
        let p = c.player_of(alice).unwrap();
        assert_eq!((p.wins, p.battles, p.trades), (1, 1, 3));
    }

    #[test]
    #[should_panic(expected = "Not enough balance")]
    fn cannot_overspend() {
        let (mut c, _) = setup("bob.testnet");
        c.buy_robot("apoc".into(), U128(1500), 16, "kessler".into());
    }

    #[test]
    #[should_panic(expected = "Durability can only go down")]
    fn battle_cannot_heal() {
        let (mut c, ids) = setup("carol.testnet");
        ctx_at("carol.testnet", 1_000);
        c.record_battle("npc1".into(), 1, U128(10), 1, vec![Wear { token_id: ids[0].clone(), durability: 5 }]);
        ctx_at("carol.testnet", 40_000);
        c.record_battle("npc1".into(), 1, U128(10), 2, vec![Wear { token_id: ids[0].clone(), durability: 6 }]);
    }

    #[test]
    #[should_panic(expected = "above what any broker would pay")]
    fn cannot_sell_for_a_fortune() {
        let (mut c, ids) = setup("dave.testnet");
        c.sell_robot(ids[0].clone(), U128(100_000), "magpie".into()); // a Spark (base 30)
    }

    #[test]
    #[should_panic(expected = "outside this model's market range")]
    fn cannot_buy_for_free() {
        let (mut c, _) = setup("erin.testnet");
        c.buy_robot("titan".into(), U128(0), 16, "kessler".into());
    }

    #[test]
    #[should_panic(expected = "Unknown robot model")]
    fn cannot_invent_models() {
        let (mut c, _) = setup("fay.testnet");
        c.buy_robot("god-mode".into(), U128(10), 10, "kessler".into());
    }

    #[test]
    #[should_panic(expected = "Repair cost is out of range")]
    fn cannot_repair_for_free() {
        let (mut c, ids) = setup("gus.testnet");
        c.record_battle("npc1".into(), 0, U128(0), 1, vec![Wear { token_id: ids[0].clone(), durability: 1 }]);
        c.repair_robot(ids[0].clone(), U128(0), 6);
    }

    #[test]
    #[should_panic(expected = "Reward out of range")]
    fn reward_is_capped() {
        let (mut c, _) = setup("hal.testnet");
        c.record_battle("npc1".into(), 1, U128(2_000), 1, vec![]);
    }

    #[test]
    fn veterans_earn_rank_and_price() {
        let (mut c, ids) = setup("jon.testnet");
        let volt = ids[5].clone(); // Volt-7, cost 3, base 100
        for i in 0..8u64 {
            ctx_at("jon.testnet", 1_000 + i * 31_000);
            c.record_battle("npc1".into(), 1, U128(20), i, vec![Wear { token_id: volt.clone(), durability: 10 }]);
        }
        let rec = c.mt_token(vec![volt.clone()])[0].as_ref().unwrap().record.clone().unwrap();
        assert_eq!((rec.battles, rec.wins, rec.rank), (8, 8, 2));
        // a normal Volt sells for at most 240 at full durability; an Elite (★★) for up to 135% of that
        c.sell_robot(volt, U128(320), "magpie".into());
    }

    #[test]
    #[should_panic(expected = "above what any broker would pay")]
    fn rookies_get_no_veteran_price() {
        let (mut c, ids) = setup("kim.testnet");
        c.sell_robot(ids[5].clone(), U128(320), "magpie".into());
    }

    #[test]
    #[should_panic(expected = "One battle per 30 seconds")]
    fn battles_are_rate_limited() {
        let (mut c, _) = setup("ivy.testnet");
        c.record_battle("npc1".into(), 1, U128(50), 1, vec![]);
        c.record_battle("npc1".into(), 1, U128(50), 2, vec![]);
    }
}
