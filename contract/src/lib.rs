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
use near_sdk::{env, near, require, AccountId, Allowance, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PublicKey};

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

/// Wins that count toward a robot's rank per day (UTC): a Legend takes at least 3 days, so ranks can't be farmed
/// with a burst of reported battles.
const VET_WINS_PER_DAY: u32 = 6;
/// Anti-arbitrage. A robot never sells for more than GAIN_MAX_PCT % of what its owner paid for it (× its veteran
/// bonus), and an account's realised trading profit (sale price − purchase price, summed) is capped per day.
/// Starter robots count as bought at their base price.
const GAIN_MAX_PCT: u128 = 250;
const DAILY_GAIN_MAX: u128 = 1_500;
const DAY_MS: u64 = 86_400_000;

/// The Pit League (same as app/src/engine/league.ts): the 12 NPC teams by division, and the division prizes.
/// Beat every team of your division once (a recorded win) to move up; winning the Apex League is a crown.
const LEAGUE: [(&str, u8); 12] = [
    ("Rusty Dogs", 0), ("Glitch", 0), ("Short Circuit", 0),
    ("Steel Rats", 1), ("Byte Gang", 1), ("Dead Pixel", 1),
    ("Night Shift", 2), ("Chrome Hawks", 2), ("Sector 9", 2),
    ("Neon-17", 3), ("Syndicate Zero", 3), ("Protocol Omega", 3),
];
const LEAGUE_PRIZE: [u128; 4] = [150, 300, 500, 1_000];
const CROWN_DEFENSE_PRIZE: u128 = 300;
/// Battle rewards + league prizes an account can receive per day (UTC). The client reports results, so this is the
/// ceiling on what a scripted client can mint; an honest player rarely reaches it. Over the cap, the reward is cut.
const DAILY_PURSE_MAX: u128 = 3_000;
/// Direct `register` calls (wallet players) per hour — each new player costs the contract storage.
const REGISTERS_PER_HOUR: u32 = 60;
/// Free-text arguments (opponent, broker, memo) are cut to this length in logs.
const MAX_TEXT: usize = 64;

fn short(s: &str) -> String {
    s.chars().take(MAX_TEXT).collect()
}

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
    Paid,
    Gains,
    VetDay,
    League,
    PurseDay,
}

/// New player accounts get this much NEAR for gas, and the game key may spend up to GAME_KEY_ALLOWANCE of it.
const NEW_ACCOUNT_FUNDING: NearToken = NearToken::from_millinear(150);
const GAME_KEY_ALLOWANCE: NearToken = NearToken::from_millinear(120);
/// A new account's browser key may only register — trades and battles are recorded by the game server.
const GAME_METHODS: &str = "register";
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

/// A player's climb through the Pit League.
#[near(serializers = [borsh, json])]
#[derive(Clone, Default)]
pub struct League {
    pub div: u8,
    pub beaten: Vec<String>,
    pub crowns: u32,
}

/// A per-day counter (UTC day number + amount).
#[near(serializers = [borsh, json])]
#[derive(Clone, Default)]
pub struct DayCount {
    pub day: u64,
    pub amount: u128,
}

/// One robot's wear after a battle, as reported by the client.
#[near(serializers = [json])]
pub struct Wear {
    pub token_id: String,
    pub durability: u32,
}

/// A robot of a world wallet (adopt_world_wallet).
#[near(serializers = [json])]
pub struct WalletRobot {
    pub model_id: String,
    pub durability: u32,
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
fn unhex(s: &str) -> Vec<u8> {
    if s.len() % 2 != 0 || !s.chars().all(|c| c.is_ascii_hexdigit()) {
        return vec![];
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
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
    /// robot token id -> what its owner paid (starters: the base price)
    paid: LookupMap<String, u128>,
    /// account -> realised trading profit today
    gains: LookupMap<AccountId, DayCount>,
    /// robot token id -> wins counted toward its rank today
    vet_day: LookupMap<String, DayCount>,
    /// account -> its Pit League progress
    league: LookupMap<AccountId, League>,
    /// account -> battle rewards + league prizes received today
    purse_day: LookupMap<AccountId, DayCount>,
    register_bucket: u64,
    registered_this_hour: u32,
}

/// State layout of v0.5 (before the daily purse cap) — used once by `migrate`.
#[near(serializers = [borsh])]
struct ContractV5 {
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
    records: LookupMap<String, Record>,
    paid: LookupMap<String, u128>,
    gains: LookupMap<AccountId, DayCount>,
    vet_day: LookupMap<String, DayCount>,
    league: LookupMap<AccountId, League>,
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
            paid: LookupMap::new(Key::Paid),
            gains: LookupMap::new(Key::Gains),
            vet_day: LookupMap::new(Key::VetDay),
            league: LookupMap::new(Key::League),
            purse_day: LookupMap::new(Key::PurseDay),
            register_bucket: 0,
            registered_this_hour: 0,
        }
    }

    /// One-off upgrade from v0.5: keeps everything, adds the daily purse cap and the register rate limit.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let old: ContractV5 = env::state_read().unwrap_or_else(|| env::panic_str("No v0.5 state"));
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
            records: old.records,
            paid: old.paid,
            gains: old.gains,
            vet_day: old.vet_day,
            league: old.league,
            purse_day: LookupMap::new(Key::PurseDay),
            register_bucket: 0,
            registered_this_hour: 0,
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
        // only the game's own relayer (signing as this contract account) may spend the contract's NEAR on new accounts
        require!(env::predecessor_account_id() == env::current_account_id(), "Only the game's relayer can create accounts");
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
        if !matches!(env::promise_result_checked(0, 64), Ok(_)) {
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

    /// Owner only: point a login key (NEAR Auth or the public site's email login) at an existing player account.
    /// The login can only use that account if the key is also an access key on it — which only the account's own
    /// owner can add — so this changes where a login lands, never who controls an account.
    pub fn link_owner_key(&mut self, owner_key: String, account_id: AccountId) {
        require!(env::predecessor_account_id() == self.owner_id, "Owner only");
        require!(self.players.get(&account_id).is_some(), "Not a player");
        self.owner_keys.insert(owner_key, account_id);
    }

    /// Owner only: move a player's game state (robot tokens, credits, battle stats, the further league progress)
    /// from duplicate accounts into one — for players who ended up with several accounts while logins were tied to
    /// a browser. Every move is a standard NEP-245 `mt_transfer` event with the memo "account merge".
    pub fn merge_players(&mut self, from: Vec<AccountId>, into: AccountId) {
        require!(env::predecessor_account_id() == self.owner_id, "Owner only");
        require!(self.players.get(&into).is_some(), "Target is not a player");
        for src in from {
            require!(src != into, "Can't merge an account into itself");
            let Some(p) = self.players.get(&src).cloned() else { continue };
            let tokens: Vec<String> = self.owned.get(&src).map(|set| set.iter().cloned().collect()).unwrap_or_default();
            for t in &tokens {
                if let Some(mut r) = self.robots.get(t).cloned() {
                    self.sub(t, &src, 1);
                    self.add(t, &into, 1);
                    r.owner_id = into.clone();
                    self.robots.insert(t.clone(), r);
                    self.untrack(&src, t);
                    self.track(&into, t);
                }
            }
            let cr = self.balance(CREDITS, &src);
            if cr > 0 {
                self.sub(CREDITS, &src, cr);
                self.add(CREDITS, &into, cr);
            }
            let mut ids = tokens.clone();
            if cr > 0 {
                ids.push(CREDITS.to_string());
            }
            if !ids.is_empty() {
                let amounts: Vec<U128> = ids.iter().map(|t| if t == CREDITS { U128(cr) } else { U128(1) }).collect();
                event("nep245", "1.0.0", "mt_transfer", json!([{ "old_owner_id": src, "new_owner_id": into, "token_ids": ids, "amounts": amounts, "memo": "account merge" }]));
            }
            let mut q = self.players.get(&into).cloned().unwrap_or_default();
            q.wins += p.wins;
            q.losses += p.losses;
            q.draws += p.draws;
            q.battles += p.battles;
            q.trades += p.trades;
            self.players.insert(into.clone(), q);
            self.players.insert(src.clone(), Player { registered_at_ms: p.registered_at_ms, ..Default::default() });
            if let Some(l) = self.league.get(&src).cloned() {
                let cur = self.league.get(&into).cloned().unwrap_or_default();
                if (l.div, l.crowns) > (cur.div, cur.crowns) {
                    self.league.insert(into.clone(), l);
                }
            }
        }
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
        let hour = env::block_timestamp_ms() / 3_600_000;
        if hour != self.register_bucket {
            self.register_bucket = hour;
            self.registered_this_hour = 0;
        }
        require!(self.registered_this_hour < REGISTERS_PER_HOUR, "Too many new players this hour, try later");
        self.registered_this_hour += 1;
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

    // ---------------- moves, recorded by the game server ----------------
    //
    // The shared world (web/src/world.ts) is the market and the arena: it prices every trade from its brokers'
    // quotes and replays every battle from its action log, then records the result here, signed by this contract
    // account (a function-call key limited to these methods). A player's own key can't record moves any more, so a
    // browser can't report a made-up price or a battle that never happened. The rules below still bound every value.

    /// The game server only: a purchase at the shared world's broker price.
    pub fn buy_robot_for(&mut self, player: AccountId, model_id: String, price: U128, durability: u32, broker: String) -> String {
        self.server_only();
        self.do_buy_robot(player, model_id, price, durability, broker)
    }

    /// The game server only: a sale at the shared world's broker bid.
    pub fn sell_robot_for(&mut self, player: AccountId, token_id: String, price: U128, broker: String) {
        self.server_only();
        self.do_sell_robot(player, token_id, price, broker)
    }

    /// The game server only: a repair at the shared world's cheapest workshop.
    pub fn repair_robot_for(&mut self, player: AccountId, token_id: String, cost: U128, durability: u32) {
        self.server_only();
        self.do_repair_robot(player, token_id, cost, durability)
    }

    /// The game server only: a battle the server replayed from its action log. `replay` (the log's SHA-256) is
    /// required, and a win must name the robots that fought.
    pub fn record_battle_for(&mut self, player: AccountId, opponent: String, result: u8, reward: U128, seed: u64, wear: Vec<Wear>, replay: String) {
        self.server_only();
        require!(result != 1 || !wear.is_empty(), "A win must list the robots that fought");
        self.do_record_battle(player, opponent, result, reward, seed, wear, Some(replay))
    }

    fn server_only(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "Moves are recorded by the game server");
    }

    /// Buy a new robot from a broker for `price` credits. The price comes from the game's market, but it must lie in
    /// the market's possible range for that model (BUY_MIN_PCT…BUY_MAX_PCT of its base price, set on-chain).
    fn do_buy_robot(&mut self, who: AccountId, model_id: String, price: U128, durability: u32, broker: String) -> String {
        require!(self.players.get(&who).is_some(), "Register first");
        let base = base_price(&model_id);
        require!(
            price.0 * 100 >= base * BUY_MIN_PCT && price.0 * 100 <= base * BUY_MAX_PCT,
            "Price is outside this model's market range"
        );
        require!(durability >= 1 && durability <= max_durability(&model_id), "Durability out of range");
        self.burn_credits(&who, price.0, "buy robot");
        let id = self.mint_robot(&who, &model_id, durability, "bought from a broker");
        self.paid.insert(id.clone(), price.0);
        self.trade(&who, "buy", &id, price.0, &broker);
        id
    }

    /// Sell a robot to a broker: the robot token is burned, the credits are minted to the seller.
    /// The price can't exceed what a broker could pay for this model at this wear (SELL_MAX_PCT × wear factor).
    fn do_sell_robot(&mut self, who: AccountId, token_id: String, price: U128, broker: String) {
        require!(self.players.get(&who).is_some(), "Register first");
        let r = self.robots.get(&token_id).cloned().unwrap_or_else(|| env::panic_str("No such robot"));
        let max_d = max_durability(&r.model_id) as u128;
        let d = (r.durability as u128).min(max_d);
        // wear factor 15% … 100%, like the game's durabilityFactor (which is never above the linear one)
        let vet = VET_PRICE_PCT[self.records.get(&token_id).map(|x| x.rank as usize).unwrap_or(0)];
        let limit = base_price(&r.model_id) * SELL_MAX_PCT * vet * (15 * max_d + 85 * d) / (100 * 100 * 100 * max_d) + 1;
        require!(price.0 <= limit, "Price is above what any broker would pay for this robot");
        require!(price.0 >= 1, "A broker pays at least 1 CR");
        // anti-arbitrage: at most GAIN_MAX_PCT of the purchase price (× veteran bonus), and a daily profit cap
        let paid = self.paid.get(&token_id).copied().unwrap_or_else(|| base_price(&r.model_id));
        require!(price.0 * 100 * 100 <= paid * GAIN_MAX_PCT * vet + 100 * 100, "Price is too far above what you paid for this robot");
        let gain = price.0.saturating_sub(paid);
        if gain > 0 {
            let day = env::block_timestamp_ms() / DAY_MS;
            let mut g = self.gains.get(&who).cloned().unwrap_or_default();
            if g.day != day {
                g = DayCount { day, amount: 0 };
            }
            require!(g.amount + gain <= DAILY_GAIN_MAX, "Daily trading profit limit reached");
            g.amount += gain;
            self.gains.insert(who.clone(), g);
        }
        self.burn_robot(&who, &token_id, "sold to a broker");
        self.mint_credits(&who, price.0, "robot sold");
        self.trade(&who, "sell", &token_id, price.0, &broker);
    }

    /// Repair a robot: pay `cost` credits, raise its durability. The cost can't be below the game's cheapest
    /// possible repair for the restored durability, and durability can't exceed the model's maximum.
    fn do_repair_robot(&mut self, who: AccountId, token_id: String, cost: U128, durability: u32) {
        require!(self.players.get(&who).is_some(), "Register first");
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
    /// `replay` (optional): SHA-256 (hex) of the battle's full action log, published by the game at
    /// /api/battles/<hash> — anyone can replay it with the game engine and check this record
    /// (`npm run verify-battle <tx>`).
    fn do_record_battle(&mut self, who: AccountId, opponent: String, result: u8, reward: U128, seed: u64, wear: Vec<Wear>, replay: Option<String>) {
        if let Some(h) = &replay {
            require!(h.len() == 64 && h.chars().all(|c| c.is_ascii_hexdigit()), "replay must be a SHA-256 hex hash");
        }
        require!(self.players.get(&who).is_some(), "Register first");
        require!(result <= 2, "Bad result");
        require!(wear.len() <= 15, "A deck has at most 15 robots");
        let mut ids: Vec<&String> = wear.iter().map(|w| &w.token_id).collect();
        ids.sort();
        ids.dedup();
        require!(ids.len() == wear.len(), "A robot can be listed only once");
        let now = env::block_timestamp_ms();
        if let Some(last) = self.last_battle.get(&who) {
            require!(now >= last + BATTLE_COOLDOWN_MS, "One battle per 30 seconds");
        }
        self.last_battle.insert(who.clone(), now);
        let value: u128 = self
            .owned
            .get(&who)
            .map(|set| {
                set.iter()
                    .filter_map(|t| self.robots.get(t))
                    .filter(|r| r.durability > 0)
                    .map(|r| base_price(&r.model_id))
                    .sum()
            })
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
                // only VET_WINS_PER_DAY wins a day count toward the rank
                let day = now / DAY_MS;
                let mut d = self.vet_day.get(&w.token_id).cloned().unwrap_or_default();
                if d.day != day {
                    d = DayCount { day, amount: 0 };
                }
                if d.amount < VET_WINS_PER_DAY as u128 {
                    d.amount += 1;
                    rec.wins += 1;
                }
                self.vet_day.insert(w.token_id.clone(), d);
            }
            let rank = vet_rank(rec.wins) as u8;
            if rank > rec.rank {
                event("heat_index", "1.0.0", "veteran", json!([{ "account_id": who, "token_id": w.token_id, "rank": rank, "wins": rec.wins }]));
            }
            rec.rank = rank;
            self.records.insert(w.token_id.clone(), rec);
        }
        let paid_reward = self.take_purse(&who, reward.0);
        if paid_reward > 0 {
            self.mint_credits(&who, paid_reward, "battle reward");
        }
        if result == 1 {
            self.league_win(&who, &opponent);
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
                "account_id": who, "opponent": short(&opponent), "result": result, "reward": U128(paid_reward), "seed": seed, "replay": replay,
                "wear": wear.iter().map(|w| json!({ "token_id": w.token_id, "durability": w.durability })).collect::<Vec<_>>()
            }]),
        );
    }

    // ---------------- the world's own wallets: brokers and NPC teams ----------------
    //
    // The 3 brokers and the 12 Pit League teams are NEAR accounts (`<name>.heat-index-game.testnet`). A team's
    // robots are tokens on its account and its trades and battles are recorded with the same `*_for` methods as a
    // player's. A broker records its own AI decisions (`record_broker_decision`, signed by the broker's account), and
    // the contract checks each one against the NEAR AI Cloud TEE signature before storing it.
    // Stored under raw keys (no change to the contract's state layout).

    /// Owner: make `account` one of the world's wallets — a broker (`kind` "broker") or an NPC team ("npc") — with
    /// its in-game credits and robots minted to it. Once per account; returns the robot token ids.
    pub fn adopt_world_wallet(&mut self, account: AccountId, kind: String, name: String, credits: U128, robots: Vec<WalletRobot>) -> Vec<String> {
        self.server_only();
        require!(kind == "broker" || kind == "npc", "kind is broker or npc");
        require!(self.players.get(&account).is_none(), "Already registered");
        require!(robots.len() <= 200, "Too many robots");
        self.players.insert(account.clone(), Player { registered_at_ms: env::block_timestamp_ms(), ..Default::default() });
        if credits.0 > 0 {
            self.mint_credits(&account, credits.0, "world wallet");
        }
        let ids: Vec<String> = robots
            .iter()
            .map(|r| {
                require!(r.durability <= max_durability(&r.model_id), "Durability out of range");
                self.mint_robot(&account, &r.model_id, r.durability, "world wallet")
            })
            .collect();
        env::storage_write(format!("ww:{account}").as_bytes(), json!({ "kind": kind, "name": short(&name) }).to_string().as_bytes());
        event("heat_index", "1.0.0", "world_wallet", json!([{ "account_id": account, "kind": kind, "name": short(&name), "credits": credits, "robots": ids }]));
        ids
    }

    /// Owner: bring a world wallet's credits to the world's number (NPC stipends, broker upkeep and dividends happen
    /// in the simulation) — the difference is minted or burned, with an event.
    pub fn sync_world_credits(&mut self, account: AccountId, credits: U128) {
        self.server_only();
        require!(env::storage_has_key(format!("ww:{account}").as_bytes()), "Not a world wallet");
        let have = self.balance(CREDITS, &account);
        if credits.0 > have {
            self.mint_credits(&account, credits.0 - have, "world sync");
        } else if have > credits.0 {
            self.burn_credits(&account, have - credits.0, "world sync");
        }
    }

    /// Owner: a world wallet's robot left the world (scrapped, written off) — its token is burned.
    pub fn drop_world_robot(&mut self, account: AccountId, token_id: String) {
        self.server_only();
        require!(env::storage_has_key(format!("ww:{account}").as_bytes()), "Not a world wallet");
        self.burn_robot(&account, &token_id, "left the world");
    }

    /// Owner: the NEAR AI Cloud TEE signing addresses (0x…, from the model's attestation report) that broker
    /// decisions must be signed by.
    pub fn set_tee_signers(&mut self, signers: Vec<String>) {
        self.server_only();
        let list: Vec<String> = signers.iter().map(|x| x.trim_start_matches("0x").to_lowercase()).collect();
        env::storage_write(b"tee_signers", json!(list).to_string().as_bytes());
    }

    pub fn tee_signers(&self) -> Vec<String> {
        env::storage_read(b"tee_signers").and_then(|v| serde_json::from_slice(&v).ok()).unwrap_or_default()
    }

    /// A broker records its AI decision itself (called by the broker's own account). `response` is the exact
    /// body NEAR AI Cloud returned; `text` and `signature` are NEAR AI's signature for that chat
    /// (`<model>:<sha256 request>:<sha256 response>`, EIP-191, by a key inside the TEE). The contract checks that
    /// `text` names this response, recovers the signer and requires it to be an attested TEE address.
    pub fn record_broker_decision(&mut self, model: String, chat_id: String, response: String, text: String, signature: String) {
        let broker = env::predecessor_account_id();
        let ww: serde_json::Value = env::storage_read(format!("ww:{broker}").as_bytes())
            .and_then(|v| serde_json::from_slice(&v).ok())
            .unwrap_or_else(|| env::panic_str("Not a broker"));
        require!(ww["kind"] == "broker", "Not a broker");
        require!(response.len() <= 16_000 && text.len() <= 300, "Too long");
        // the signed text names the model and this exact response
        let resp_hash = hex(&env::sha256(response.as_bytes()));
        require!(text.starts_with(&format!("{model}:")) && text.ends_with(&format!(":{resp_hash}")), "The signature is for another response");
        // EIP-191 personal message → recover the signing address
        let sig = unhex(signature.trim_start_matches("0x"));
        require!(sig.len() == 65, "Bad signature");
        let msg = format!("\x19Ethereum Signed Message:\n{}{}", text.len(), text);
        let digest = env::keccak256(msg.as_bytes());
        let v = if sig[64] >= 27 { sig[64] - 27 } else { sig[64] };
        let pubkey = env::ecrecover(&digest, &sig[..64], v, true).unwrap_or_else(|| env::panic_str("Bad signature"));
        let signer = hex(&env::keccak256(&pubkey)[12..]);
        require!(self.tee_signers().contains(&signer), "Not signed by an attested NEAR AI TEE key");
        // what the model said (the policy the game then clamps to the broker's bounds)
        let content = serde_json::from_str::<serde_json::Value>(&response)
            .ok()
            .and_then(|v| v["choices"][0]["message"]["content"].as_str().map(|s| s.to_string()))
            .unwrap_or_default();
        let content: String = content.chars().take(1500).collect();
        let rec = json!({
            "model": model, "chat_id": chat_id, "signer": format!("0x{signer}"), "response_sha256": resp_hash,
            "content": content, "at_ms": env::block_timestamp_ms(),
        });
        env::storage_write(format!("bd:{broker}").as_bytes(), rec.to_string().as_bytes());
        event("heat_index", "1.0.0", "broker_decision", json!([{ "broker": broker, "model": model, "chat_id": short(&chat_id), "signer": format!("0x{signer}"), "response_sha256": resp_hash }]));
    }

    /// A broker's latest TEE-verified AI decision.
    pub fn broker_decision(&self, broker: AccountId) -> Option<serde_json::Value> {
        env::storage_read(format!("bd:{broker}").as_bytes()).and_then(|v| serde_json::from_slice(&v).ok())
    }

    /// Whether an account is one of the world's wallets (broker / NPC team) and its name.
    pub fn world_wallet(&self, account: AccountId) -> Option<serde_json::Value> {
        env::storage_read(format!("ww:{account}").as_bytes()).and_then(|v| serde_json::from_slice(&v).ok())
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
        // credits are earned in the arena, not moved between accounts (stops sybil farms feeding one account)
        require!(token_id != CREDITS, "Credits can't be transferred");
        require!(self.players.get(&receiver_id).is_some(), "The receiver must be a registered player");
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
            json!([{ "old_owner_id": from, "new_owner_id": receiver_id, "token_ids": [token_id], "amounts": [amount], "memo": memo.as_deref().map(short) }]),
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

    /// The account's Pit League progress (division 0…3, teams beaten in it, crowns).
    pub fn league_of(&self, account_id: AccountId) -> League {
        self.league.get(&account_id).cloned().unwrap_or_default()
    }

    /// What the account paid for a robot (starters: its base price) — the anti-arbitrage basis.
    pub fn paid_for(&self, token_id: String) -> Option<U128> {
        self.robots.get(&token_id).map(|r| U128(self.paid.get(&token_id).copied().unwrap_or_else(|| base_price(&r.model_id))))
    }

    pub fn player_of(&self, account_id: AccountId) -> Option<Player> {
        self.players.get(&account_id).cloned()
    }

    pub fn stats(&self) -> serde_json::Value {
        json!({ "owner_id": self.owner_id, "battles": self.total_battles, "trades": self.total_trades, "robots_minted": self.next_serial })
    }

    // ---------------- internals ----------------


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
        self.paid.remove(token_id);
        self.vet_day.remove(token_id);
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

    /// Takes up to `amount` from the account's daily purse (DAILY_PURSE_MAX); returns what may be paid.
    fn take_purse(&mut self, who: &AccountId, amount: u128) -> u128 {
        let day = env::block_timestamp_ms() / DAY_MS;
        let mut d = self.purse_day.get(who).cloned().unwrap_or_default();
        if d.day != day {
            d = DayCount { day, amount: 0 };
        }
        let pay = amount.min(DAILY_PURSE_MAX.saturating_sub(d.amount));
        d.amount += pay;
        self.purse_day.insert(who.clone(), d);
        pay
    }

    /// Battle rewards + league prizes the account has received today (the game shows the remaining daily purse).
    pub fn purse_today(&self, account_id: AccountId) -> U128 {
        let day = env::block_timestamp_ms() / DAY_MS;
        U128(self.purse_day.get(&account_id).filter(|d| d.day == day).map(|d| d.amount).unwrap_or(0))
    }

    /// A recorded win over a team of the player's division counts toward the climb; beating all of them pays the
    /// division prize (minted here, so the game's credits and the chain's stay equal) and moves the player up.
    fn league_win(&mut self, who: &AccountId, opponent: &str) {
        let Some(&(_, div)) = LEAGUE.iter().find(|(n, _)| *n == opponent) else { return };
        let mut l = self.league.get(who).cloned().unwrap_or_default();
        if div != l.div || l.beaten.iter().any(|b| b == opponent) {
            return;
        }
        l.beaten.push(opponent.to_string());
        let left = LEAGUE.iter().filter(|(_, d)| *d == l.div).any(|(n, _)| !l.beaten.iter().any(|b| b == n));
        if !left {
            let last = (LEAGUE_PRIZE.len() - 1) as u8;
            let prize = if l.div == last && l.crowns > 0 { CROWN_DEFENSE_PRIZE } else { LEAGUE_PRIZE[l.div as usize] };
            let prize = self.take_purse(who, prize);
            if prize > 0 {
                self.mint_credits(who, prize, "league prize");
            }
            event("heat_index", "1.0.0", "league", json!([{ "account_id": who, "division": l.div, "prize": U128(prize) }]));
            if l.div < last {
                l.div += 1;
            } else {
                l.crowns += 1;
            }
            l.beaten.clear();
        }
        self.league.insert(who.clone(), l);
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
            json!([{ "account_id": who, "kind": kind, "token_id": token_id, "amount": U128(amount), "counterparty": short(counterparty) }]),
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
    fn world_wallets_and_tee_verified_broker_decisions() {
        let (mut c, _) = setup("alice.testnet");
        ctx("game.testnet");
        let ids = c.adopt_world_wallet("magpie.game.testnet".parse().unwrap(), "broker".into(), "Magpie".into(), U128(1200), vec![]);
        assert!(ids.is_empty());
        let npc = c.adopt_world_wallet(
            "rusty-dogs.game.testnet".parse().unwrap(),
            "npc".into(),
            "Rusty Dogs".into(),
            U128(500),
            vec![WalletRobot { model_id: "ram".into(), durability: 7 }],
        );
        assert_eq!(npc.len(), 1);
        c.sync_world_credits("rusty-dogs.game.testnet".parse().unwrap(), U128(320));
        assert_eq!(c.mt_balance_of("rusty-dogs.game.testnet".parse().unwrap(), CREDITS.into()).0, 320);
        // a real NEAR AI Cloud response and its TEE signature
        let resp = include_str!("../fixtures/nearai-response.json").to_string();
        let sig: serde_json::Value = serde_json::from_str(include_str!("../fixtures/nearai-signature.json")).unwrap();
        let (text, signature, signer) = (sig["text"].as_str().unwrap().to_string(), sig["signature"].as_str().unwrap().to_string(), sig["signing_address"].as_str().unwrap().to_string());
        c.set_tee_signers(vec![signer]);
        ctx("magpie.game.testnet");
        c.record_broker_decision("deepseek-ai/DeepSeek-V4.1-Flash-1017".into(), "chat-1".into(), resp.clone(), text.clone(), signature.clone());
        let d = c.broker_decision("magpie.game.testnet".parse().unwrap()).unwrap();
        assert_eq!(d["chat_id"], "chat-1");
        // a changed response is refused
        let forged = resp.replacen("\"content\"", "\"content\" ", 1);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.record_broker_decision("deepseek-ai/DeepSeek-V4.1-Flash-1017".into(), "chat-2".into(), forged, text.clone(), signature.clone())
        }));
        assert!(r.is_err());
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
        let bought = c.do_buy_robot(env::predecessor_account_id(), "titan".into(), U128(560), 16, "kessler".into());
        assert_eq!(c.mt_balance_of(alice.clone(), CREDITS.into()).0, 440);
        c.do_record_battle(env::predecessor_account_id(), "npc3".into(), 1, U128(90), 42, vec![Wear { token_id: bought.clone(), durability: 14 }], None);
        assert_eq!(c.mt_balance_of(alice.clone(), CREDITS.into()).0, 530);
        assert_eq!(c.mt_token(vec![bought.clone()])[0].as_ref().unwrap().metadata.as_ref().unwrap().durability, 14);
        c.do_repair_robot(env::predecessor_account_id(), bought.clone(), U128(30), 16);
        c.do_sell_robot(env::predecessor_account_id(), bought.clone(), U128(500), "magpie".into());
        assert_eq!(c.mt_balance_of(alice.clone(), bought.clone()).0, 0);
        assert_eq!(c.mt_balance_of(alice.clone(), CREDITS.into()).0, 1000);
        let p = c.player_of(alice).unwrap();
        assert_eq!((p.wins, p.battles, p.trades), (1, 1, 3));
    }

    #[test]
    #[should_panic(expected = "Not enough balance")]
    fn cannot_overspend() {
        let (mut c, _) = setup("bob.testnet");
        c.do_buy_robot(env::predecessor_account_id(), "apoc".into(), U128(1500), 16, "kessler".into());
    }

    #[test]
    #[should_panic(expected = "Durability can only go down")]
    fn battle_cannot_heal() {
        let (mut c, ids) = setup("carol.testnet");
        ctx_at("carol.testnet", 1_000);
        c.do_record_battle(env::predecessor_account_id(), "npc1".into(), 1, U128(10), 1, vec![Wear { token_id: ids[0].clone(), durability: 5 }], None);
        ctx_at("carol.testnet", 40_000);
        c.do_record_battle(env::predecessor_account_id(), "npc1".into(), 1, U128(10), 2, vec![Wear { token_id: ids[0].clone(), durability: 6 }], None);
    }

    #[test]
    #[should_panic(expected = "above what any broker would pay")]
    fn cannot_sell_for_a_fortune() {
        let (mut c, ids) = setup("dave.testnet");
        c.do_sell_robot(env::predecessor_account_id(), ids[0].clone(), U128(100_000), "magpie".into()); // a Spark (base 30)
    }

    #[test]
    #[should_panic(expected = "outside this model's market range")]
    fn cannot_buy_for_free() {
        let (mut c, _) = setup("erin.testnet");
        c.do_buy_robot(env::predecessor_account_id(), "titan".into(), U128(0), 16, "kessler".into());
    }

    #[test]
    #[should_panic(expected = "Unknown robot model")]
    fn cannot_invent_models() {
        let (mut c, _) = setup("fay.testnet");
        c.do_buy_robot(env::predecessor_account_id(), "god-mode".into(), U128(10), 10, "kessler".into());
    }

    #[test]
    #[should_panic(expected = "Repair cost is out of range")]
    fn cannot_repair_for_free() {
        let (mut c, ids) = setup("gus.testnet");
        c.do_record_battle(env::predecessor_account_id(), "npc1".into(), 0, U128(0), 1, vec![Wear { token_id: ids[0].clone(), durability: 1 }], None);
        c.do_repair_robot(env::predecessor_account_id(), ids[0].clone(), U128(0), 6);
    }

    #[test]
    #[should_panic(expected = "Reward out of range")]
    fn reward_is_capped() {
        let (mut c, _) = setup("hal.testnet");
        c.do_record_battle(env::predecessor_account_id(), "npc1".into(), 1, U128(2_000), 1, vec![], None);
    }

    #[test]
    fn veterans_earn_rank_and_price() {
        let (mut c, ids) = setup("jon.testnet");
        let volt = ids[5].clone(); // Volt-7, cost 3, base 100
        // 4 wins a day over two days (the daily cap is 6)
        for i in 0..8u64 {
            ctx_at("jon.testnet", 1_000 + (i / 4) * DAY_MS + (i % 4) * 31_000);
            c.do_record_battle(env::predecessor_account_id(), "npc1".into(), 1, U128(20), i, vec![Wear { token_id: volt.clone(), durability: 10 }], None);
        }
        let rec = c.mt_token(vec![volt.clone()])[0].as_ref().unwrap().record.clone().unwrap();
        assert_eq!((rec.battles, rec.wins, rec.rank), (8, 8, 2));
        // a normal Volt sells for at most 240 at full durability; an Elite (★★) for up to 135% of that
        c.do_sell_robot(env::predecessor_account_id(), volt, U128(320), "magpie".into());
    }

    #[test]
    #[should_panic(expected = "above what any broker would pay")]
    fn rookies_get_no_veteran_price() {
        let (mut c, ids) = setup("kim.testnet");
        c.do_sell_robot(env::predecessor_account_id(), ids[5].clone(), U128(320), "magpie".into());
    }

    #[test]
    fn veteran_wins_are_capped_per_day() {
        let (mut c, ids) = setup("lea.testnet");
        for i in 0..10u64 {
            ctx_at("lea.testnet", 1_000 + i * 31_000);
            c.do_record_battle(env::predecessor_account_id(), "npc1".into(), 1, U128(20), i, vec![Wear { token_id: ids[5].clone(), durability: 10 }], None);
        }
        let rec = c.mt_token(vec![ids[5].clone()])[0].as_ref().unwrap().record.clone().unwrap();
        assert_eq!((rec.battles, rec.wins), (10, 6));
    }

    #[test]
    #[should_panic(expected = "too far above what you paid")]
    fn cheap_buy_cannot_be_flipped() {
        let (mut c, _) = setup("max.testnet");
        // a Titan (base 560) bought at the market's floor (168) can't be sold at the market's ceiling
        let t = c.do_buy_robot(env::predecessor_account_id(), "titan".into(), U128(168), 16, "magpie".into());
        c.do_sell_robot(env::predecessor_account_id(), t, U128(1_300), "kessler".into());
    }

    #[test]
    #[should_panic(expected = "Daily trading profit limit")]
    fn trading_profit_is_capped_per_day() {
        let (mut c, _) = setup("ned.testnet");
        c.mint_credits(&"ned.testnet".parse().unwrap(), 5_000, "test");
        for _ in 0..5 {
            let t = c.do_buy_robot(env::predecessor_account_id(), "titan".into(), U128(300), 16, "magpie".into());
            c.do_sell_robot(env::predecessor_account_id(), t, U128(700), "kessler".into()); // +400 each: the 4th sale passes 1500
        }
    }

    #[test]
    fn league_prize_is_minted_on_chain() {
        let (mut c, _) = setup("ola.testnet");
        let ola: AccountId = "ola.testnet".parse().unwrap();
        for (i, team) in ["Rusty Dogs", "Glitch", "Short Circuit"].iter().enumerate() {
            ctx_at("ola.testnet", 1_000 + i as u64 * 31_000);
            c.do_record_battle(env::predecessor_account_id(), team.to_string(), 1, U128(10), i as u64, vec![], None);
        }
        let l = c.league_of(ola.clone());
        assert_eq!((l.div, l.beaten.len()), (1, 0));
        assert_eq!(c.mt_balance_of(ola, CREDITS.into()).0, 1000 + 30 + 150);
        // a team of another division doesn't count
        ctx_at("ola.testnet", 200_000);
        c.do_record_battle(env::predecessor_account_id(), "Protocol Omega".into(), 1, U128(10), 9, vec![], None);
        assert_eq!(c.league_of("ola.testnet".parse().unwrap()).beaten.len(), 0);
    }

    #[test]
    #[should_panic(expected = "Only the game's relayer")]
    fn factory_is_relayer_only() {
        let (mut c, _) = setup("pat.testnet");
        let k: PublicKey = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp".parse().unwrap();
        c.create_player_account("evil".into(), k.clone(), k);
    }

    #[test]
    fn battle_purse_is_capped_per_day() {
        let (mut c, _) = setup("quinn.testnet");
        let q: AccountId = "quinn.testnet".parse().unwrap();
        c.do_buy_robot(env::predecessor_account_id(), "titan".into(), U128(400), 16, "kessler".into()); // working robots' value 750 + 560
        let before = c.mt_balance_of(q.clone(), CREDITS.into()).0;
        // 12 battles × 300 = 3600 asked, but at most 3000 a day is paid (unknown opponent: no league prize)
        for i in 0..12u64 {
            ctx_at("quinn.testnet", 1_000 + i * 31_000);
            c.do_record_battle(env::predecessor_account_id(), "npc".into(), 1, U128(300), i, vec![], None);
        }
        assert_eq!(c.mt_balance_of(q.clone(), CREDITS.into()).0 - before, 3_000);
        assert_eq!(c.purse_today(q.clone()).0, 3_000);
        // the next day the purse is full again
        ctx_at("quinn.testnet", DAY_MS + 1_000);
        c.do_record_battle(env::predecessor_account_id(), "npc".into(), 1, U128(300), 99, vec![], None);
        assert_eq!(c.mt_balance_of(q, CREDITS.into()).0 - before, 3_300);
    }

    #[test]
    #[should_panic(expected = "listed only once")]
    fn wear_cannot_repeat_a_robot() {
        let (mut c, ids) = setup("ray.testnet");
        c.do_record_battle(env::predecessor_account_id(), "npc".into(), 1, U128(10), 1, vec![Wear { token_id: ids[0].clone(), durability: 5 }, Wear { token_id: ids[0].clone(), durability: 5 }], None);
    }

    #[test]
    #[should_panic(expected = "Credits can't be transferred")]
    fn credits_are_not_transferable() {
        let (mut c, _) = setup("sam.testnet");
        ctx("tom.testnet");
        c.register();
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id("sam.testnet".parse().unwrap())
            .attached_deposit(NearToken::from_yoctonear(1))
            .build());
        c.mt_transfer("tom.testnet".parse().unwrap(), CREDITS.into(), U128(100), None, None);
    }

    #[test]
    #[should_panic(expected = "registered player")]
    fn robots_only_go_to_players() {
        let (mut c, ids) = setup("uma.testnet");
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id("uma.testnet".parse().unwrap())
            .attached_deposit(NearToken::from_yoctonear(1))
            .build());
        c.mt_transfer("nobody.testnet".parse().unwrap(), ids[0].clone(), U128(1), None, None);
    }

    #[test]
    fn duplicate_accounts_merge_into_one() {
        let (mut c, _) = setup("vic.testnet");
        ctx("vic-2.testnet");
        c.register();
        ctx("game.testnet");
        c.merge_players(vec!["vic-2.testnet".parse().unwrap()], "vic.testnet".parse().unwrap());
        let vic: AccountId = "vic.testnet".parse().unwrap();
        assert_eq!(c.mt_balance_of(vic.clone(), CREDITS.into()).0, 2000);
        assert_eq!(c.mt_tokens_for_owner(vic, None, Some(100)).len(), 24);
        assert_eq!(c.mt_tokens_for_owner("vic-2.testnet".parse().unwrap(), None, None).len(), 0);
    }

    #[test]
    #[should_panic(expected = "Owner only")]
    fn only_the_owner_merges() {
        let (mut c, _) = setup("wes.testnet");
        c.merge_players(vec!["x.testnet".parse().unwrap()], "wes.testnet".parse().unwrap());
    }

    // ---- the moves only the game server can record (jury findings, Nov 14) ----

    fn as_server() {
        ctx("game.testnet");
    }

    #[test]
    #[should_panic(expected = "Moves are recorded by the game server")]
    fn a_player_cannot_report_a_battle_directly() {
        let (mut c, _) = setup("xan.testnet");
        // the exploit: a win with no robots and no replay, straight from the browser key
        c.record_battle_for("xan.testnet".parse().unwrap(), "npc".into(), 1, U128(180), 1, vec![], "00".repeat(32));
    }

    #[test]
    #[should_panic(expected = "Moves are recorded by the game server")]
    fn a_player_cannot_set_their_own_buy_price() {
        let (mut c, _) = setup("yul.testnet");
        // the exploit: buy a Titan at the floor (30%) from the browser, resell it at 2.5×
        c.buy_robot_for("yul.testnet".parse().unwrap(), "titan".into(), U128(168), 16, "magpie".into());
    }

    #[test]
    #[should_panic(expected = "A win must list the robots that fought")]
    fn even_the_server_cannot_record_a_win_without_robots() {
        let (mut c, _) = setup("zed.testnet");
        as_server();
        c.record_battle_for("zed.testnet".parse().unwrap(), "npc".into(), 1, U128(50), 1, vec![], "ab".repeat(32));
    }

    #[test]
    fn the_server_records_trades_and_replayed_battles_for_a_player() {
        let (mut c, ids) = setup("amy.testnet");
        let amy: AccountId = "amy.testnet".parse().unwrap();
        as_server();
        let t = c.buy_robot_for(amy.clone(), "volt".into(), U128(110), 10, "kessler".into());
        c.record_battle_for(amy.clone(), "Glitch".into(), 1, U128(40), 7, vec![Wear { token_id: ids[0].clone(), durability: 5 }], "cd".repeat(32));
        c.repair_robot_for(amy.clone(), ids[0].clone(), U128(10), 6);
        c.sell_robot_for(amy.clone(), t, U128(120), "magpie".into());
        assert_eq!(c.mt_balance_of(amy.clone(), CREDITS.into()).0, 1000 - 110 + 40 - 10 + 120);
        assert_eq!(c.player_of(amy).unwrap().battles, 1);
    }

    #[test]
    #[should_panic(expected = "replay must be a SHA-256 hex hash")]
    fn a_battle_needs_a_real_replay_hash() {
        let (mut c, ids) = setup("bea.testnet");
        as_server();
        c.record_battle_for("bea.testnet".parse().unwrap(), "npc".into(), 1, U128(40), 7, vec![Wear { token_id: ids[0].clone(), durability: 5 }], "nope".into());
    }

    #[test]
    fn robots_move_between_players_with_mt_transfer() {
        let (mut c, ids) = setup("cal.testnet");
        ctx("dee.testnet");
        c.register();
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id("cal.testnet".parse().unwrap())
            .attached_deposit(NearToken::from_yoctonear(1))
            .build());
        c.mt_transfer("dee.testnet".parse().unwrap(), ids[0].clone(), U128(1), None, Some("gift".into()));
        assert_eq!(c.mt_token(vec![ids[0].clone()])[0].as_ref().unwrap().owner_id.as_ref().unwrap().as_str(), "dee.testnet");
        assert_eq!(c.mt_tokens_for_owner("dee.testnet".parse().unwrap(), None, Some(100)).len(), 13);
    }

    #[test]
    fn a_login_can_be_pointed_at_an_existing_account_only_by_the_owner() {
        let (mut c, _) = setup("eve.testnet");
        as_server();
        c.link_owner_key("ed25519:abc".into(), "eve.testnet".parse().unwrap());
        assert_eq!(c.account_for_owner_key("ed25519:abc".into()).unwrap().as_str(), "eve.testnet");
        c.forget_owner_key("ed25519:abc".into());
        assert!(c.account_for_owner_key("ed25519:abc".into()).is_none());
    }

    #[test]
    #[should_panic(expected = "One battle per 30 seconds")]
    fn battles_are_rate_limited() {
        let (mut c, _) = setup("ivy.testnet");
        c.do_record_battle(env::predecessor_account_id(), "npc1".into(), 1, U128(50), 1, vec![], None);
        c.do_record_battle(env::predecessor_account_id(), "npc1".into(), 1, U128(50), 2, vec![], None);
    }
}
