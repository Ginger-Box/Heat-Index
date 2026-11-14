//! HEAT INDEX on NEAR — the game's ledger as a NEP-245 multi-token contract.
//!
//! * Token `cr` — credits (fungible inside the multi-token contract).
//! * Token `robot:<model>:<serial>` — one robot (supply 1) with on-chain metadata: model and durability.
//! * A player `register`s once and receives the starter robots and starting credits.
//! * Every trade (`buy_robot`, `sell_robot`, `repair_robot`) and every battle result (`record_battle`) is a
//!   transaction that mints / burns tokens and emits NEP-245 events (`mt_mint`, `mt_burn`, `mt_transfer`)
//!   plus a `heat_index` event with the game details — so the whole economy can be replayed from the chain.
//!
//! Trust model: only the game server records moves (`*_for`, callable by this account alone); every value is
//! still bounded by the rules kept here (model table, price ranges, wear, rewards, daily caps). Online battles are
//! dealt from a seed this contract draws from NEAR's randomness (`open_battle_for`) — the server can't pick a
//! favourable deal — and every battle carries the SHA-256 of its public action log, which anyone can replay
//! (`npm run verify-battle <tx>`). The world's brokers and bot teams have their own accounts here, and the
//! brokers' AI decisions are accepted only with NEAR AI Cloud's TEE signature (`record_broker_decision`).
//! NEP-245: balances, tokens, enumeration, transfers, batch transfers, `mt_transfer_call` (with refunds through
//! `mt_resolve_transfer`) and approvals; credits can't be transferred.

pub mod battle;

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
        let game_key_str = String::from(&game_key);
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
                    .on_player_account(account_id, key_str, Some(game_key_str)),
            )
    }

    /// Callback: if the account was created, remember it for this login and register the player.
    #[private]
    pub fn on_player_account(&mut self, account_id: AccountId, owner_key: String, game_key: Option<String>) -> Option<AccountId> {
        if !matches!(env::promise_result_checked(0, 64), Ok(_)) {
            return None; // e.g. the name was taken — nothing to undo
        }
        self.owner_keys.insert(owner_key, account_id.clone());
        if let Some(k) = game_key {
            self.add_signer_key(&account_id, k);
        }
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
        // already registered: this call links the key that signed it as one of the player's move-signing keys
        // (the browser's game key can only call `register`, so this is how a device enrols for signed moves)
        let signer = String::from(&env::signer_account_pk());
        if self.players.get(&who).is_some() {
            self.add_signer_key(&who, signer);
            return vec![];
        }
        self.add_signer_key(&who, signer);
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
        self.world_wallet_only(&player);
        self.do_buy_robot(player, model_id, price, durability, broker)
    }

    /// The game server only: a sale at the shared world's broker bid.
    pub fn sell_robot_for(&mut self, player: AccountId, token_id: String, price: U128, broker: String) {
        self.server_only();
        self.world_wallet_only(&player);
        self.do_sell_robot(player, token_id, price, broker)
    }

    /// The game server only: a repair at the shared world's cheapest workshop.
    pub fn repair_robot_for(&mut self, player: AccountId, token_id: String, cost: U128, durability: u32) {
        self.server_only();
        self.world_wallet_only(&player);
        self.do_repair_robot(player, token_id, cost, durability)
    }

    /// The game server only: a battle the server replayed from its action log. `replay` (the log's SHA-256) is
    /// required, and a win must name the robots that fought.
    pub fn record_battle_for(&mut self, player: AccountId, opponent: String, result: u8, reward: U128, seed: u64, wear: Vec<Wear>, replay: String) {
        self.server_only();
        self.world_wallet_only(&player);
        require!(result != 1 || !wear.is_empty(), "A win must list the robots that fought");
        self.use_ticket(&player, &opponent, seed);
        self.do_record_battle(player, opponent, result, reward, seed, wear, Some(replay))
    }

    /// The game server only: open an online battle. The contract draws the deal's seed from NEAR's randomness
    /// (`env::random_seed`, set by the validators), so the server can't shop for a good deal; the battle must then be
    /// recorded with exactly this seed. Returns the seed.
    pub fn open_battle_for(&mut self, player: AccountId, opponent: String) -> u64 {
        self.server_only();
        self.world_wallet_only(&player);
        self.do_open_battle(player, opponent)
    }

    fn do_open_battle(&mut self, player: AccountId, opponent: String) -> u64 {
        require!(self.players.get(&player).is_some(), "Register first");
        let r = env::random_seed();
        let seed = (u32::from_le_bytes([r[0], r[1], r[2], r[3]]) & 0x7fff_ffff) as u64;
        env::storage_write(
            format!("ticket:{player}").as_bytes(),
            json!({ "seed": seed, "opponent": short(&opponent), "at_ms": env::block_timestamp_ms() }).to_string().as_bytes(),
        );
        event("heat_index", "1.0.0", "battle_opened", json!([{ "account_id": player, "opponent": short(&opponent), "seed": seed }]));
        seed
    }

    /// The open online battle of a player (its on-chain seed), if any.
    pub fn open_battle_of(&self, account_id: AccountId) -> Option<serde_json::Value> {
        env::storage_read(format!("ticket:{account_id}").as_bytes()).and_then(|v| serde_json::from_slice(&v).ok())
    }

    /// an online battle must have been opened on-chain, and it is recorded with the seed the contract drew
    fn use_ticket(&mut self, player: &AccountId, opponent: &str, seed: u64) {
        let ticket_key = format!("ticket:{player}");
        if opponent.starts_with("online:") {
            let t: serde_json::Value = env::storage_read(ticket_key.as_bytes())
                .and_then(|v| serde_json::from_slice(&v).ok())
                .unwrap_or_else(|| env::panic_str("This online battle was never opened on-chain"));
            require!(t["seed"].as_u64() == Some(seed), "The battle wasn't dealt from the seed drawn on-chain");
            env::storage_remove(ticket_key.as_bytes());
        }
    }

    /// The game server only: a battle the CONTRACT replays. `log` is the battle's full action log (seed, both decks,
    /// every action — the text published at /api/battles/<sha256>); the contract re-runs it with its own copy of the
    /// rules (`battle.rs`), rejects any illegal move or unfinished battle, and decides the result for `side` (0 / 1)
    /// and each of the player's robots' wear itself — from the durability it has on-chain. The server only supplies
    /// the reward (still capped). The log's SHA-256 is stored as the battle's replay hash.
    pub fn record_verified_battle_for(&mut self, player: AccountId, side: u8, opponent: String, reward: U128, log: String) {
        self.server_only();
        // a player's battle is either an online one (opened with the player's signature: the ticket) or comes
        // through signed_move with the log hash the player signed
        require!(self.is_world_wallet(&player) || opponent.starts_with("online:"), "A player's battle needs the player's signature");
        self.do_verified_battle(player, side, opponent, reward, log);
    }

    fn do_verified_battle(&mut self, player: AccountId, side: u8, opponent: String, reward: U128, log: String) {
        require!(side <= 1, "side is 0 or 1");
        require!(log.len() <= 60_000, "Log too big");
        let parsed: battle::BattleLog = serde_json::from_str(&log).unwrap_or_else(|_| env::panic_str("Bad battle log"));
        let b = battle::replay(&parsed).unwrap_or_else(|e| env::panic_str(&format!("The battle doesn't replay: {e}")));
        let result: u8 = match b.winner.unwrap() {
            None => 2,
            Some(w) if w == side as usize => 1,
            _ => 0,
        };
        let seed = parsed.input.seed;
        self.use_ticket(&player, &opponent, seed);
        // players wear lightly (destroyed / overheated only); the world's bot teams by the full rule
        let light = !env::storage_has_key(format!("ww:{player}").as_bytes());
        let team = if side == 0 { &parsed.input.a } else { &parsed.input.b };
        let mut wear = vec![];
        for r in team {
            let Some(tid) = &r.token_id else { continue };
            let robot = self.robots.get(tid).cloned().unwrap_or_else(|| env::panic_str("No such robot"));
            require!(robot.owner_id == player, "Not your robot");
            require!(robot.model_id == r.model_id, "The log's robot is another model than its token");
            if light {
                // the veteran HP bonus in the log can't exceed the rank the robot has on-chain
                let rank = vet_rank(self.records.get(tid).map(|x| x.wins).unwrap_or(0));
                require!(vet_rank(r.vw.unwrap_or(0)) <= rank, "The log claims a higher veteran rank than the token has");
            }
            let max_d = max_durability(&robot.model_id);
            let now = robot.durability.min(max_d);
            wear.push(Wear { token_id: tid.clone(), durability: now.saturating_sub(b.wear_loss(&r.uid, light)) });
        }
        require!(result != 1 || !wear.is_empty(), "A win must list the robots that fought");
        let hash = hex(&env::sha256(log.as_bytes()));
        event("heat_index", "1.0.0", "battle_verified", json!([{ "account_id": player, "side": side, "result": result, "replay": hash, "actions": parsed.actions.len() }]));
        self.do_record_battle(player, opponent, result, reward, seed, wear, Some(hash));
    }

    fn is_world_wallet(&self, a: &AccountId) -> bool {
        env::storage_has_key(format!("ww:{a}").as_bytes())
    }
    /// The server-relayed `*_for` methods move only the world's own wallets (bot teams); a player's moves need the
    /// player's signature (`signed_move`).
    fn world_wallet_only(&self, a: &AccountId) {
        require!(self.is_world_wallet(a), "A player's move needs the player's signature (signed_move)");
    }

    fn signer_keys(&self, a: &AccountId) -> Vec<String> {
        env::storage_read(format!("sk:{a}").as_bytes()).and_then(|v| serde_json::from_slice(&v).ok()).unwrap_or_default()
    }
    fn add_signer_key(&mut self, a: &AccountId, key: String) {
        let mut ks = self.signer_keys(a);
        if ks.contains(&key) {
            return;
        }
        ks.push(key);
        if ks.len() > 10 {
            ks.remove(0); // the oldest device drops out
        }
        env::storage_write(format!("sk:{a}").as_bytes(), json!(ks).to_string().as_bytes());
    }

    /// The keys that may sign a player's moves (their devices' game keys, enrolled through `register`).
    pub fn signing_keys_of(&self, account_id: AccountId) -> Vec<String> {
        self.signer_keys(&account_id)
    }

    /// A player's move, signed by the player and relayed by the game server. `message` is the exact text the
    /// player's key signed — JSON `{ "v": 1, "account", "nonce", "at" (ms), "op", … }`; `signature` is its ed25519
    /// signature (hex) by `public_key`, one of the player's enrolled keys. The contract checks the signature, that the
    /// nonce is new and the message fresh, and that what happens is what the player signed:
    /// * `buy` {model, broker, max_price} — `price` ≤ max_price
    /// * `sell` {token, broker, min_price} — `price` ≥ min_price
    /// * `repair` {token, max_cost} — `price` (the cost) ≤ max_cost, up to `durability`
    /// * `list` {token, price}, `unlist` {token}, `buy_listing` {token, max_price}
    /// * `battle` {log_sha256, opponent} — `log` hashes to what the player signed; the contract replays it
    /// * `open_battle` {} — consent to an online battle (the contract draws the seed; `opponent` from the server)
    pub fn signed_move(
        &mut self,
        player: AccountId,
        message: String,
        signature: String,
        public_key: String,
        price: Option<U128>,
        durability: Option<u32>,
        log: Option<String>,
        reward: Option<U128>,
        opponent: Option<String>,
    ) -> serde_json::Value {
        self.server_only();
        require!(message.len() <= 600, "Message too long");
        require!(self.signer_keys(&player).contains(&public_key), "This key isn't enrolled for the player's moves");
        let pk: PublicKey = public_key.parse().unwrap_or_else(|_| env::panic_str("Bad public key"));
        let pkb = pk.as_bytes();
        require!(pkb.len() == 33 && pkb[0] == 0, "An ed25519 key is required");
        let mut pk32 = [0u8; 32];
        pk32.copy_from_slice(&pkb[1..33]);
        let sig = unhex(&signature);
        require!(sig.len() == 64, "Bad signature");
        let mut sig64 = [0u8; 64];
        sig64.copy_from_slice(&sig);
        require!(env::ed25519_verify(&sig64, message.as_bytes(), &pk32), "The player's signature doesn't match");
        let m: serde_json::Value = serde_json::from_str(&message).unwrap_or_else(|_| env::panic_str("Bad message"));
        require!(m["v"] == 1 && m["account"].as_str() == Some(player.as_str()), "The message is for another account");
        // replay protection: a fresh, increasing nonce, and the message is at most an hour old
        let nonce = m["nonce"].as_u64().unwrap_or_else(|| env::panic_str("No nonce"));
        let nk = format!("nonce:{player}");
        let last: u64 = env::storage_read(nk.as_bytes()).and_then(|v| String::from_utf8(v).ok()).and_then(|x| x.parse().ok()).unwrap_or(0);
        require!(nonce > last, "This move was already used");
        env::storage_write(nk.as_bytes(), nonce.to_string().as_bytes());
        let at = m["at"].as_u64().unwrap_or(0);
        let now = env::block_timestamp_ms();
        require!(at + 3_600_000 >= now && at <= now + 600_000, "The signed move expired");
        let s = |k: &str| m[k].as_str().map(|x| x.to_string()).unwrap_or_else(|| env::panic_str(&format!("No {k}")));
        let n = |k: &str| -> u128 {
            m[k].as_str().and_then(|x| x.parse().ok()).or_else(|| m[k].as_u64().map(|x| x as u128)).unwrap_or_else(|| env::panic_str(&format!("No {k}")))
        };
        let p = || price.map(|x| x.0).unwrap_or_else(|| env::panic_str("No price"));
        let op = s("op");
        event("heat_index", "1.0.0", "signed_move", json!([{ "account_id": player, "op": op, "nonce": nonce, "key": public_key }]));
        match op.as_str() {
            "buy" => {
                require!(p() <= n("max_price"), "Price is above what the player signed");
                let id = self.do_buy_robot(player, s("model"), U128(p()), durability.unwrap_or_else(|| env::panic_str("No durability")), s("broker"));
                json!(id)
            }
            "sell" => {
                require!(p() >= n("min_price"), "Price is below what the player signed");
                self.do_sell_robot(player, s("token"), U128(p()), s("broker"));
                json!(null)
            }
            "repair" => {
                require!(p() <= n("max_cost"), "Repair costs more than the player signed");
                self.do_repair_robot(player, s("token"), U128(p()), durability.unwrap_or_else(|| env::panic_str("No durability")));
                json!(null)
            }
            "list" => {
                self.do_list(player, s("token"), U128(n("price")));
                json!(null)
            }
            "unlist" => {
                self.do_unlist(player, s("token"));
                json!(null)
            }
            "buy_listing" => {
                self.do_buy_listing(player, s("token"), n("max_price"));
                json!(null)
            }
            "battle" => {
                let log = log.unwrap_or_else(|| env::panic_str("No log"));
                require!(hex(&env::sha256(log.as_bytes())) == s("log_sha256"), "The log isn't the one the player signed");
                let opp = s("opponent");
                require!(!opp.starts_with("online:"), "Online battles are opened with open_battle");
                self.do_verified_battle(player, 0, opp, reward.unwrap_or(U128(0)), log);
                json!(null)
            }
            "open_battle" => {
                let opp = opponent.unwrap_or_else(|| env::panic_str("No opponent"));
                require!(opp.starts_with("online:"), "Not an online battle");
                json!(self.do_open_battle(player, opp))
            }
            _ => env::panic_str("Unknown move"),
        }
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

    // ---------------- the world's hourly commitments ----------------

    /// The game server only: commit hour `epoch` of the shared world — the SHA-256 of the published snapshot
    /// (/api/world-log/<epoch>/snapshot, players' decks stripped) and of the journal that led to it from the previous
    /// snapshot. Append-only: epochs go 0, 1, 2… and each names the previous state, so history can't be rewritten.
    /// Anyone can replay journal N on snapshot N-1 with the game's engine and must get snapshot N
    /// (`npm run verify-world`).
    pub fn commit_world(&mut self, epoch: u64, state_sha256: String, journal_sha256: String, prev_sha256: String) {
        self.server_only();
        let is_hex = |h: &str| h.len() == 64 && h.chars().all(|c| c.is_ascii_hexdigit());
        require!(is_hex(&state_sha256) && is_hex(&journal_sha256), "Hashes must be SHA-256 hex");
        let next: u64 = env::storage_read(b"wc_next").and_then(|v| String::from_utf8(v).ok()).and_then(|x| x.parse().ok()).unwrap_or(0);
        require!(epoch == next, "Commitments go in order");
        if epoch > 0 {
            let prev: serde_json::Value = env::storage_read(format!("wc:{}", epoch - 1).as_bytes()).and_then(|v| serde_json::from_slice(&v).ok()).unwrap();
            require!(prev["state"].as_str() == Some(prev_sha256.as_str()), "prev_sha256 isn't the last committed state");
        }
        let rec = json!({ "state": state_sha256, "journal": journal_sha256, "prev": prev_sha256, "at_ms": env::block_timestamp_ms() });
        env::storage_write(format!("wc:{epoch}").as_bytes(), rec.to_string().as_bytes());
        env::storage_write(b"wc_next", (epoch + 1).to_string().as_bytes());
        event("heat_index", "1.0.0", "world_commit", json!([{ "epoch": epoch, "state": state_sha256, "journal": journal_sha256 }]));
    }

    /// One hourly commitment of the shared world (or none).
    pub fn world_commit(&self, epoch: u64) -> Option<serde_json::Value> {
        env::storage_read(format!("wc:{epoch}").as_bytes()).and_then(|v| serde_json::from_slice(&v).ok())
    }

    /// How many commitments there are (the next epoch).
    pub fn world_epochs(&self) -> u64 {
        env::storage_read(b"wc_next").and_then(|v| String::from_utf8(v).ok()).and_then(|x| x.parse().ok()).unwrap_or(0)
    }

    // ---------------- the player market: robots listed by their owners, at their own price ----------------
    //
    // A player (or a bot team) lists a robot at a price they choose: the token goes into escrow (owned by this
    // contract) until someone buys it or it is withdrawn. The buyer's credits go to the seller, minus a 5% market fee
    // that is burned. The price can't exceed what a broker could pay for that robot at its wear (× veteran bonus) nor
    // GAIN_MAX_PCT of what the seller paid, and the seller's profit counts toward the daily cap — so the market can't
    // be used to move credits between accounts.

    fn list_limit(&self, token_id: &str, r: &Robot) -> u128 {
        let max_d = max_durability(&r.model_id) as u128;
        let d = (r.durability as u128).min(max_d);
        let vet = VET_PRICE_PCT[self.records.get(token_id).map(|x| x.rank as usize).unwrap_or(0)];
        let wear_cap = base_price(&r.model_id) * SELL_MAX_PCT * vet * (15 * max_d + 85 * d) / (100 * 100 * 100 * max_d) + 1;
        let paid = self.paid.get(token_id).copied().unwrap_or_else(|| base_price(&r.model_id));
        wear_cap.min(paid * GAIN_MAX_PCT * vet / (100 * 100) + 1)
    }

    fn listings_index(&self) -> Vec<String> {
        env::storage_read(b"listings").and_then(|v| serde_json::from_slice(&v).ok()).unwrap_or_default()
    }
    fn set_listings_index(&self, ids: &[String]) {
        env::storage_write(b"listings", json!(ids).to_string().as_bytes());
    }

    /// The game server only, for the world's wallets (players list through signed_move).
    pub fn list_robot_for(&mut self, player: AccountId, token_id: String, price: U128) {
        self.server_only();
        self.world_wallet_only(&player);
        self.do_list(player, token_id, price)
    }

    fn do_list(&mut self, player: AccountId, token_id: String, price: U128) {
        let mut r = self.robots.get(&token_id).cloned().unwrap_or_else(|| env::panic_str("No such robot"));
        require!(r.owner_id == player, "Not your robot");
        require!(r.durability > 0, "A broken robot can't be listed");
        require!(price.0 >= 1 && price.0 <= self.list_limit(&token_id, &r), "Price is above what this robot can be listed for");
        let me = env::current_account_id();
        self.sub(&token_id, &player, 1);
        self.add(&token_id, &me, 1);
        r.owner_id = me.clone();
        self.robots.insert(token_id.clone(), r);
        self.untrack(&player, &token_id);
        env::storage_write(format!("listing:{token_id}").as_bytes(), json!({ "seller": player, "price": price, "at_ms": env::block_timestamp_ms() }).to_string().as_bytes());
        let mut idx = self.listings_index();
        idx.push(token_id.clone());
        self.set_listings_index(&idx);
        event("heat_index", "1.0.0", "listed", json!([{ "account_id": player, "token_id": token_id, "price": price }]));
    }

    fn take_listing(&mut self, token_id: &str) -> (AccountId, u128) {
        let l: serde_json::Value = env::storage_read(format!("listing:{token_id}").as_bytes())
            .and_then(|v| serde_json::from_slice(&v).ok())
            .unwrap_or_else(|| env::panic_str("Not listed"));
        env::storage_remove(format!("listing:{token_id}").as_bytes());
        let idx: Vec<String> = self.listings_index().into_iter().filter(|x| x != token_id).collect();
        self.set_listings_index(&idx);
        let seller: AccountId = l["seller"].as_str().unwrap().parse().unwrap();
        let price: u128 = l["price"].as_str().and_then(|x| x.parse().ok()).unwrap_or(0);
        (seller, price)
    }

    fn release(&mut self, token_id: &str, to: &AccountId) {
        let me = env::current_account_id();
        let mut r = self.robots.get(token_id).cloned().unwrap();
        self.sub(token_id, &me, 1);
        self.add(token_id, to, 1);
        r.owner_id = to.clone();
        self.robots.insert(token_id.to_string(), r);
        self.track(to, token_id);
    }

    /// The game server only, for the world's wallets: the seller withdraws a listing (the robot comes back).
    pub fn unlist_robot_for(&mut self, player: AccountId, token_id: String) {
        self.server_only();
        self.world_wallet_only(&player);
        self.do_unlist(player, token_id)
    }

    fn do_unlist(&mut self, player: AccountId, token_id: String) {
        let (seller, _) = self.take_listing(&token_id);
        require!(seller == player, "Not your listing");
        self.release(&token_id, &seller);
        event("heat_index", "1.0.0", "unlisted", json!([{ "account_id": player, "token_id": token_id }]));
    }

    /// The game server only, for the world's wallets (bot teams shop the player market).
    pub fn buy_listing_for(&mut self, buyer: AccountId, token_id: String) {
        self.server_only();
        self.world_wallet_only(&buyer);
        self.do_buy_listing(buyer, token_id, u128::MAX)
    }

    /// `buyer` buys a listed robot at its price (≤ max_price) — credits to the seller (5% fee burned).
    fn do_buy_listing(&mut self, buyer: AccountId, token_id: String, max_price: u128) {
        require!(self.players.get(&buyer).is_some(), "Register first");
        let (seller, price) = self.take_listing(&token_id);
        require!(price <= max_price, "The listing costs more than the player signed");
        require!(seller != buyer, "That's your own listing");
        // the seller's profit counts toward the daily cap (no funnelling credits through the market)
        let paid = self.paid.get(&token_id).copied().unwrap_or_else(|| base_price(&self.robots.get(&token_id).unwrap().model_id));
        let fee = price * 5 / 100;
        let gain = (price - fee).saturating_sub(paid);
        if gain > 0 {
            let day = env::block_timestamp_ms() / DAY_MS;
            let mut g = self.gains.get(&seller).cloned().unwrap_or_default();
            if g.day != day {
                g = DayCount { day, amount: 0 };
            }
            require!(g.amount + gain <= DAILY_GAIN_MAX, "The seller's daily trading profit limit is reached");
            g.amount += gain;
            self.gains.insert(seller.clone(), g);
        }
        self.burn_credits(&buyer, price, "market purchase");
        self.mint_credits(&seller, price - fee, "market sale");
        self.release(&token_id, &buyer);
        self.paid.insert(token_id.clone(), price);
        self.trade(&buyer, "market_buy", &token_id, price, seller.as_str());
        self.trade(&seller, "market_sell", &token_id, price - fee, buyer.as_str());
    }

    /// Open listings (token id, seller, price).
    pub fn listings(&self) -> Vec<serde_json::Value> {
        self.listings_index()
            .iter()
            .filter_map(|t| {
                env::storage_read(format!("listing:{t}").as_bytes())
                    .and_then(|v| serde_json::from_slice::<serde_json::Value>(&v).ok())
                    .map(|mut l| {
                        l["token_id"] = json!(t);
                        l
                    })
            })
            .collect()
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

    // ---------------- NEP-245 transfers, transfer_call and approvals ----------------
    //
    // Credits can't be transferred (they're earned in the arena). A robot can: to another player, to any contract
    // with `mt_transfer_call` (e.g. a marketplace — it gets `mt_on_transfer` and can hand the token back), or by an
    // approved account (`mt_approve`). A transferred robot's resale basis becomes 1 CR (anti-sybil: gifts can't be
    // cashed in at a broker). Approvals are cleared whenever the robot changes hands.

    /// Moves `amount` of `token_id` from its owner to `to`. With `approval`, the caller is an approved account
    /// acting for `owner` (approval id must match). Returns the previous owner.
    fn internal_transfer(&mut self, to: &AccountId, token_id: &str, amount: u128, approval: Option<(AccountId, u64)>, to_players_only: bool) -> AccountId {
        require!(amount > 0, "Amount must be positive");
        require!(token_id != CREDITS, "Credits can't be transferred");
        let caller = env::predecessor_account_id();
        let from = match approval {
            Some((owner, id)) => {
                let a = self.approvals_of(token_id);
                require!(a["owner"].as_str() == Some(owner.as_str()), "Approval from another owner");
                require!(a["approvals"][caller.as_str()].as_u64() == Some(id), "Not approved (or a stale approval id)");
                owner
            }
            None => caller,
        };
        require!(&from != to, "Sender and receiver must differ");
        if to_players_only {
            require!(self.players.get(to).is_some(), "The receiver must be a registered player");
        }
        self.sub(token_id, &from, amount);
        self.add(token_id, to, amount);
        if let Some(mut r) = self.robots.get(token_id).cloned() {
            r.owner_id = to.clone();
            self.robots.insert(token_id.to_string(), r);
            self.untrack(&from, token_id);
            self.track(to, token_id);
            self.paid.insert(token_id.to_string(), 1);
        }
        env::storage_remove(format!("appr:{token_id}").as_bytes());
        from
    }

    fn approvals_of(&self, token_id: &str) -> serde_json::Value {
        env::storage_read(format!("appr:{token_id}").as_bytes())
            .and_then(|v| serde_json::from_slice(&v).ok())
            .unwrap_or_else(|| json!({ "owner": null, "approvals": {}, "next": 0 }))
    }

    /// Standard transfer (exactly 1 yoctoNEAR, as NEP-245 requires). `approval`: (owner, approval id) when an
    /// approved account moves the owner's robot.
    #[payable]
    pub fn mt_transfer(&mut self, receiver_id: AccountId, token_id: String, amount: U128, approval: Option<(AccountId, u64)>, memo: Option<String>) {
        require!(env::attached_deposit() == NearToken::from_yoctonear(1), "Requires exactly 1 yoctoNEAR");
        let from = self.internal_transfer(&receiver_id, &token_id, amount.0, approval, true);
        event("nep245", "1.0.0", "mt_transfer", json!([{ "old_owner_id": from, "new_owner_id": receiver_id, "token_ids": [token_id], "amounts": [amount], "memo": memo.as_deref().map(short) }]));
    }

    /// NEP-245 batch transfer: the same rules as `mt_transfer`, for several tokens at once (1 yoctoNEAR).
    #[payable]
    pub fn mt_batch_transfer(&mut self, receiver_id: AccountId, token_ids: Vec<String>, amounts: Vec<U128>, approvals: Option<Vec<Option<(AccountId, u64)>>>, memo: Option<String>) {
        require!(env::attached_deposit() == NearToken::from_yoctonear(1), "Requires exactly 1 yoctoNEAR");
        require!(token_ids.len() == amounts.len() && !token_ids.is_empty() && token_ids.len() <= 50, "Bad batch");
        let approvals = approvals.unwrap_or_else(|| vec![None; token_ids.len()]);
        require!(approvals.len() == token_ids.len(), "Bad approvals");
        let mut olds = vec![];
        for ((t, a), ap) in token_ids.iter().zip(amounts.iter()).zip(approvals.into_iter()) {
            olds.push(self.internal_transfer(&receiver_id, t, a.0, ap, true));
        }
        event("nep245", "1.0.0", "mt_transfer", json!([{ "old_owner_id": olds[0], "new_owner_id": receiver_id, "token_ids": token_ids, "amounts": amounts, "memo": memo.as_deref().map(short) }]));
    }

    /// NEP-245 transfer and call: the robot goes to `receiver_id` (any account, e.g. a marketplace contract), which is
    /// then asked `mt_on_transfer(sender_id, previous_owner_ids, token_ids, amounts, msg)` and returns how much it
    /// didn't take; `mt_resolve_transfer` gives that back (or everything, if the call failed).
    #[payable]
    pub fn mt_transfer_call(&mut self, receiver_id: AccountId, token_id: String, amount: U128, approval: Option<(AccountId, u64)>, memo: Option<String>, msg: String) -> Promise {
        self.mt_batch_transfer_call(receiver_id, vec![token_id], vec![amount], approval.map(|a| vec![Some(a)]), memo, msg)
    }

    #[payable]
    pub fn mt_batch_transfer_call(&mut self, receiver_id: AccountId, token_ids: Vec<String>, amounts: Vec<U128>, approvals: Option<Vec<Option<(AccountId, u64)>>>, memo: Option<String>, msg: String) -> Promise {
        require!(env::attached_deposit() == NearToken::from_yoctonear(1), "Requires exactly 1 yoctoNEAR");
        require!(token_ids.len() == amounts.len() && !token_ids.is_empty() && token_ids.len() <= 20, "Bad batch");
        require!(env::prepaid_gas().as_tgas() >= 60, "Attach at least 60 Tgas");
        let approvals = approvals.unwrap_or_else(|| vec![None; token_ids.len()]);
        require!(approvals.len() == token_ids.len(), "Bad approvals");
        let sender = env::predecessor_account_id();
        let mut olds: Vec<AccountId> = vec![];
        for ((t, a), ap) in token_ids.iter().zip(amounts.iter()).zip(approvals.into_iter()) {
            olds.push(self.internal_transfer(&receiver_id, t, a.0, ap, false));
        }
        event("nep245", "1.0.0", "mt_transfer", json!([{ "old_owner_id": olds[0], "new_owner_id": receiver_id, "token_ids": token_ids, "amounts": amounts, "memo": memo.as_deref().map(short) }]));
        Promise::new(receiver_id.clone())
            .function_call(
                "mt_on_transfer".to_string(),
                json!({ "sender_id": sender, "previous_owner_ids": olds, "token_ids": token_ids, "amounts": amounts, "msg": msg }).to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                Gas::from_tgas(25),
            )
            .then(Promise::new(env::current_account_id()).function_call(
                "mt_resolve_transfer".to_string(),
                json!({ "previous_owner_ids": olds, "receiver_id": receiver_id, "token_ids": token_ids, "amounts": amounts }).to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                Gas::from_tgas(15),
            ))
    }

    /// Callback of `mt_transfer_call`: returns the amounts the receiver didn't use (all of them if its call failed),
    /// as long as the receiver still holds them. Returns the amounts that stayed with the receiver.
    #[private]
    pub fn mt_resolve_transfer(&mut self, previous_owner_ids: Vec<AccountId>, receiver_id: AccountId, token_ids: Vec<String>, amounts: Vec<U128>) -> Vec<U128> {
        let unused: Vec<u128> = match env::promise_result_checked(0, 2_000) {
            Ok(bytes) => serde_json::from_slice::<Vec<U128>>(&bytes)
                .ok()
                .filter(|v| v.len() == amounts.len())
                .map(|v| v.iter().zip(amounts.iter()).map(|(u, a)| u.0.min(a.0)).collect())
                .unwrap_or_else(|| amounts.iter().map(|a| a.0).collect()),
            Err(_) => amounts.iter().map(|a| a.0).collect(),
        };
        let mut kept = vec![];
        for (i, t) in token_ids.iter().enumerate() {
            let back = unused[i].min(self.balance(t, &receiver_id));
            if back > 0 {
                let prev = &previous_owner_ids[i];
                self.sub(t, &receiver_id, back);
                self.add(t, prev, back);
                if let Some(mut r) = self.robots.get(t).cloned() {
                    r.owner_id = prev.clone();
                    self.robots.insert(t.clone(), r);
                    self.untrack(&receiver_id, t);
                    self.track(prev, t);
                }
                event("nep245", "1.0.0", "mt_transfer", json!([{ "old_owner_id": receiver_id, "new_owner_id": prev, "token_ids": [t], "amounts": [U128(back)], "memo": "refund" }]));
            }
            kept.push(U128(amounts[i].0 - back));
        }
        kept
    }

    /// NEP-245 approvals: let `account_id` move these robots (owner only, 1 yoctoNEAR or more). With `msg`, the
    /// approved account is told with `mt_on_approve(token_ids, amounts, owner_id, approval_ids, msg)`.
    #[payable]
    pub fn mt_approve(&mut self, token_ids: Vec<String>, amounts: Vec<U128>, account_id: AccountId, msg: Option<String>) -> Option<Promise> {
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "Requires at least 1 yoctoNEAR");
        require!(token_ids.len() == amounts.len() && !token_ids.is_empty() && token_ids.len() <= 20, "Bad batch");
        let owner = env::predecessor_account_id();
        let mut ids = vec![];
        for (t, a) in token_ids.iter().zip(amounts.iter()) {
            require!(t != CREDITS, "Credits can't be approved");
            require!(self.balance(t, &owner) >= a.0 && a.0 > 0, "Not your token");
            let mut ap = self.approvals_of(t);
            if ap["owner"].as_str() != Some(owner.as_str()) {
                ap = json!({ "owner": owner, "approvals": {}, "next": 0 });
            }
            let id = ap["next"].as_u64().unwrap_or(0) + 1;
            ap["next"] = json!(id);
            ap["approvals"][account_id.as_str()] = json!(id);
            require!(ap["approvals"].as_object().map(|o| o.len()).unwrap_or(0) <= 10, "At most 10 approvals per robot");
            env::storage_write(format!("appr:{t}").as_bytes(), ap.to_string().as_bytes());
            ids.push(id);
        }
        event("heat_index", "1.0.0", "mt_approve", json!([{ "owner_id": owner, "account_id": account_id, "token_ids": token_ids, "approval_ids": ids }]));
        msg.map(|m| {
            Promise::new(account_id).function_call(
                "mt_on_approve".to_string(),
                json!({ "token_ids": token_ids, "amounts": amounts, "owner_id": owner, "approval_ids": ids, "msg": m }).to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                Gas::from_tgas(20),
            )
        })
    }

    /// Revoke one account's approval for these robots (owner only, exactly 1 yoctoNEAR).
    #[payable]
    pub fn mt_revoke(&mut self, token_ids: Vec<String>, account_id: AccountId) {
        require!(env::attached_deposit() == NearToken::from_yoctonear(1), "Requires exactly 1 yoctoNEAR");
        let owner = env::predecessor_account_id();
        for t in &token_ids {
            let mut ap = self.approvals_of(t);
            require!(ap["owner"].as_str() == Some(owner.as_str()), "Not your token");
            if let Some(o) = ap["approvals"].as_object_mut() {
                o.remove(account_id.as_str());
            }
            env::storage_write(format!("appr:{t}").as_bytes(), ap.to_string().as_bytes());
        }
    }

    /// Revoke every approval for these robots (owner only, exactly 1 yoctoNEAR).
    #[payable]
    pub fn mt_revoke_all(&mut self, token_ids: Vec<String>) {
        require!(env::attached_deposit() == NearToken::from_yoctonear(1), "Requires exactly 1 yoctoNEAR");
        let owner = env::predecessor_account_id();
        for t in &token_ids {
            require!(self.balance(t, &owner) > 0, "Not your token");
            env::storage_remove(format!("appr:{t}").as_bytes());
        }
    }

    /// Whether `approved_account_id` may move these robots (optionally: with exactly these approval ids).
    pub fn mt_is_approved(&self, token_ids: Vec<String>, approved_account_id: AccountId, amounts: Vec<U128>, approval_ids: Option<Vec<u64>>) -> bool {
        token_ids.iter().enumerate().all(|(i, t)| {
            let ap = self.approvals_of(t);
            let Some(owner) = ap["owner"].as_str() else { return false };
            let Ok(owner) = owner.parse::<AccountId>() else { return false };
            let id = ap["approvals"][approved_account_id.as_str()].as_u64();
            id.is_some()
                && self.balance(t, &owner) >= amounts.get(i).map(|a| a.0).unwrap_or(1)
                && approval_ids.as_ref().map(|ids| ids.get(i).copied() == id).unwrap_or(true)
        })
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
    fn the_rust_rules_replay_the_games_battles_exactly() {
        let fx: Vec<serde_json::Value> = serde_json::from_str(include_str!("../fixtures/battles.json")).unwrap();
        assert!(fx.len() >= 30);
        for (n, f) in fx.iter().enumerate() {
            let log: battle::BattleLog = serde_json::from_str(f["log"].as_str().unwrap()).unwrap();
            let b = battle::replay(&log).unwrap_or_else(|e| panic!("battle {n}: {e}"));
            let want = f["winner"].as_u64().map(|x| x as usize);
            assert_eq!(b.winner, Some(want), "battle {n}: winner");
            for (uid, w) in f["wear"].as_object().unwrap() {
                assert_eq!(b.wear_loss(uid, true) as u64, w[0].as_u64().unwrap(), "battle {n}: light wear of {uid}");
                assert_eq!(b.wear_loss(uid, false) as u64, w[1].as_u64().unwrap(), "battle {n}: wear of {uid}");
            }
        }
    }

    #[test]
    fn online_battles_use_the_seed_drawn_on_chain() {
        let (mut c, ids) = setup("alice.testnet");
        let alice: AccountId = "alice.testnet".parse().unwrap();
        let hash = "a".repeat(64);
        ctx("game.testnet");
        world_wallet("alice.testnet");
        // never opened → refused
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut c2 = Contract::new("game.testnet".parse().unwrap());
            c2.record_battle_for(alice.clone(), "online:Bob".into(), 0, U128(0), 5, vec![], hash.clone())
        }));
        assert!(r.is_err());
        let seed = c.open_battle_for(alice.clone(), "online:Bob".into());
        assert_eq!(c.open_battle_of(alice.clone()).unwrap()["seed"].as_u64(), Some(seed));
        // another seed → refused
        let wrong = (seed + 1) & 0x7fff_ffff;
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.record_battle_for(alice.clone(), "online:Bob".into(), 0, U128(0), wrong, vec![], hash.clone())
        }));
        assert!(r.is_err());
        ctx_at("game.testnet", 60_000);
        c.record_battle_for(alice.clone(), "online:Bob".into(), 1, U128(10), seed, vec![Wear { token_id: ids[0].clone(), durability: 5 }], hash.clone());
        assert!(c.open_battle_of(alice).is_none());
    }

    #[test]
    fn the_player_market_escrows_and_pays_the_seller() {
        let (mut c, ids) = setup("bob.testnet");
        ctx("alice.testnet");
        c.register();
        ctx("game.testnet");
        world_wallet("bob.testnet");
        world_wallet("alice.testnet");
        let bob: AccountId = "bob.testnet".parse().unwrap();
        let alice: AccountId = "alice.testnet".parse().unwrap();
        // a Spark (base 30): the cap is ~2.4× base at full wear and 2.5× what was paid
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.list_robot_for(bob.clone(), ids[0].clone(), U128(500))));
        assert!(r.is_err());
        c.list_robot_for(bob.clone(), ids[0].clone(), U128(60));
        assert_eq!(c.mt_balance_of(bob.clone(), ids[0].clone()).0, 0);
        assert_eq!(c.listings().len(), 1);
        c.buy_listing_for(alice.clone(), ids[0].clone());
        assert_eq!(c.mt_balance_of(alice.clone(), ids[0].clone()).0, 1);
        assert_eq!(c.mt_balance_of(alice, CREDITS.into()).0, 940);
        assert_eq!(c.mt_balance_of(bob.clone(), CREDITS.into()).0, 1057); // 60 − 5% fee
        assert!(c.listings().is_empty());
        // listing and withdrawing gives the robot back
        c.list_robot_for(bob.clone(), ids[1].clone(), U128(10));
        c.unlist_robot_for(bob.clone(), ids[1].clone());
        assert_eq!(c.mt_balance_of(bob, ids[1].clone()).0, 1);
    }

    /// these rule tests drive the server-relayed `*_for` methods, which move only the world's wallets
    fn world_wallet(who: &str) {
        env::storage_write(format!("ww:{who}").as_bytes(), br#"{"kind":"npc","name":"t"}"#);
    }

    fn ctx_pay(who: &str) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(who.parse().unwrap())
            .attached_deposit(NearToken::from_yoctonear(1))
            .prepaid_gas(Gas::from_tgas(200))
            .build());
    }

    #[test]
    fn nep245_approvals_let_an_approved_account_move_a_robot_once() {
        let (mut c, ids) = setup("alice.testnet");
        ctx("carol.testnet");
        c.register();
        ctx_pay("alice.testnet");
        c.mt_approve(vec![ids[0].clone()], vec![U128(1)], "market.testnet".parse().unwrap(), None);
        assert!(c.mt_is_approved(vec![ids[0].clone()], "market.testnet".parse().unwrap(), vec![U128(1)], Some(vec![1])));
        // the approved account moves it for alice
        ctx_pay("market.testnet");
        c.mt_transfer("carol.testnet".parse().unwrap(), ids[0].clone(), U128(1), Some(("alice.testnet".parse().unwrap(), 1)), None);
        assert_eq!(c.mt_balance_of("carol.testnet".parse().unwrap(), ids[0].clone()).0, 1);
        // the approval is gone with the change of hands
        assert!(!c.mt_is_approved(vec![ids[0].clone()], "market.testnet".parse().unwrap(), vec![U128(1)], None));
        // a stranger without approval can't
        ctx_pay("mallory.testnet");
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.mt_transfer("mallory.testnet".parse().unwrap(), ids[1].clone(), U128(1), Some(("alice.testnet".parse().unwrap(), 1)), None)
        }));
        assert!(r.is_err());
        // credits are never transferable, approved or not
        ctx_pay("alice.testnet");
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.mt_approve(vec![CREDITS.into()], vec![U128(5)], "market.testnet".parse().unwrap(), None)));
        assert!(r.is_err());
    }

    #[test]
    fn nep245_transfer_call_refunds_what_the_receiver_did_not_take() {
        let (mut c, ids) = setup("alice.testnet");
        let alice: AccountId = "alice.testnet".parse().unwrap();
        let shop: AccountId = "shop.testnet".parse().unwrap();
        ctx_pay("alice.testnet");
        let _ = c.mt_transfer_call(shop.clone(), ids[0].clone(), U128(1), None, None, "list".into());
        assert_eq!(c.mt_balance_of(shop.clone(), ids[0].clone()).0, 1);
        // the receiver's call failed → the robot goes back
        testing_env!(
            VMContextBuilder::new().predecessor_account_id("game.testnet".parse().unwrap()).current_account_id("game.testnet".parse().unwrap()).build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![near_sdk::PromiseResult::Failed]
        );
        let kept = c.mt_resolve_transfer(vec![alice.clone()], shop.clone(), vec![ids[0].clone()], vec![U128(1)]);
        assert_eq!(kept[0].0, 0);
        assert_eq!(c.mt_balance_of(alice.clone(), ids[0].clone()).0, 1);
        // the receiver took it (returned 0 unused) → it stays
        ctx_pay("alice.testnet");
        let _ = c.mt_transfer_call(shop.clone(), ids[1].clone(), U128(1), None, None, "list".into());
        testing_env!(
            VMContextBuilder::new().predecessor_account_id("game.testnet".parse().unwrap()).current_account_id("game.testnet".parse().unwrap()).build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![near_sdk::PromiseResult::Successful(b"[\"0\"]".to_vec())]
        );
        let kept = c.mt_resolve_transfer(vec![alice.clone()], shop.clone(), vec![ids[1].clone()], vec![U128(1)]);
        assert_eq!(kept[0].0, 1);
        assert_eq!(c.mt_balance_of(shop, ids[1].clone()).0, 1);
    }

    #[test]
    fn signed_moves_do_only_what_the_player_signed() {
        use ed25519_dalek::{Signer, SigningKey};
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let pk = PublicKey::from_parts(near_sdk::CurveType::ED25519, sk.verifying_key().to_bytes().to_vec()).unwrap();
        let pk_str = String::from(&pk);
        let (mut c, _) = setup("alice.testnet");
        let alice: AccountId = "alice.testnet".parse().unwrap();
        // the device's key enrols through register (the only method a game key may call)
        testing_env!(VMContextBuilder::new().predecessor_account_id(alice.clone()).signer_account_pk(pk.clone()).build());
        c.register();
        assert!(c.signing_keys_of(alice.clone()).contains(&pk_str));
        let t = 5_000_000u64;
        let sign = |msg: &str| ed25519_dalek::Signature::to_bytes(&sk.sign(msg.as_bytes())).iter().map(|b| format!("{b:02x}")).collect::<String>();
        let buy = |nonce: u64, max: u64| format!(r#"{{"v":1,"account":"alice.testnet","nonce":{nonce},"at":{t},"op":"buy","model":"volt","broker":"kessler","max_price":"{max}"}}"#);
        ctx_at("game.testnet", t);
        let m1 = buy(1, 120);
        let token = c.signed_move(alice.clone(), m1.clone(), sign(&m1), pk_str.clone(), Some(U128(110)), Some(10), None, None, None);
        assert!(token.as_str().unwrap().starts_with("robot:volt:"));
        let fails = |c: &mut Contract, msg: &str, sig: String, price: u128| {
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.signed_move(alice.clone(), msg.to_string(), sig, pk_str.clone(), Some(U128(price)), Some(10), None, None, None))).is_err()
        };
        // the same signed move can't be replayed
        assert!(fails(&mut c, &m1, sign(&m1), 110));
        // the server can't charge more than the player signed
        let m2 = buy(2, 120);
        assert!(fails(&mut c, &m2, sign(&m2), 130));
        // a tampered message breaks the signature
        let m3 = buy(3, 120);
        assert!(fails(&mut c, &buy(3, 500), sign(&m3), 400));
        // and without a signature the server can't move a player's assets at all
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.buy_robot_for(alice.clone(), "volt".into(), U128(110), 10, "kessler".into())));
        assert!(r.is_err());
    }

    #[test]
    fn world_commitments_are_append_only_and_chained() {
        let (mut c, _) = setup("alice.testnet");
        ctx("game.testnet");
        let (h0, h1, j) = ("0".repeat(64), "1".repeat(64), "a".repeat(64));
        c.commit_world(0, h0.clone(), j.clone(), String::new());
        // out of order or with another previous state → refused
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.commit_world(2, h1.clone(), j.clone(), h0.clone()))).is_err());
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.commit_world(1, h1.clone(), j.clone(), h1.clone()))).is_err());
        c.commit_world(1, h1.clone(), j.clone(), h0.clone());
        assert_eq!(c.world_epochs(), 2);
        assert_eq!(c.world_commit(1).unwrap()["prev"], h0);
        // only the server commits
        ctx("mallory.testnet");
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.commit_world(2, h0.clone(), j.clone(), h1.clone()))).is_err());
    }

    #[test]
    fn a_gifted_robot_cannot_be_cashed_in() {
        let (mut c, _) = setup("bob.testnet");
        ctx("alice.testnet");
        let ids = c.register();
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id("alice.testnet".parse().unwrap())
            .attached_deposit(NearToken::from_yoctonear(1))
            .build());
        c.mt_transfer("bob.testnet".parse().unwrap(), ids[0].clone(), U128(1), None, None);
        assert_eq!(c.paid_for(ids[0].clone()), Some(U128(1)));
        ctx("game.testnet");
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.sell_robot_for("bob.testnet".parse().unwrap(), ids[0].clone(), U128(20), "kessler".into())
        }));
        assert!(r.is_err());
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
        world_wallet("zed.testnet");
        c.record_battle_for("zed.testnet".parse().unwrap(), "npc".into(), 1, U128(50), 1, vec![], "ab".repeat(32));
    }

    #[test]
    fn the_server_records_trades_and_replayed_battles_for_a_player() {
        let (mut c, ids) = setup("amy.testnet");
        let amy: AccountId = "amy.testnet".parse().unwrap();
        as_server();
        world_wallet("amy.testnet");
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
        world_wallet("bea.testnet");
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
