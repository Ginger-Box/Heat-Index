// Veterans: every robot keeps a battle record. Wins earn ranks (★ Veteran, ★★ Elite, ★★★ Legend):
// brokers pay more for a veteran, and Elite / Legend robots come into battle with extra HP.
// The same thresholds and price bonuses are checked by the NEAR contract (contract/src/lib.rs, VET_WINS).

export interface VetRecord {
  /** battles fought */
  b: number;
  /** battles its team won */
  w: number;
}

export const VET_WINS = [3, 8, 15];
export const VET_NAME = ['Rookie', 'Veteran', 'Elite', 'Legend'];
/** a broker's bid for the robot is multiplied by this */
export const VET_PRICE = [1, 1.15, 1.35, 1.6];
/** extra HP in battle */
export const VET_HP = [0, 0, 1, 2];

export const vetRank = (r: { vet?: VetRecord }) => VET_WINS.filter((x) => (r.vet?.w ?? 0) >= x).length;
export const vetStars = (rank: number) => '★'.repeat(rank);
/** wins still needed for the next rank (null at Legend) */
export const winsToNext = (r: { vet?: VetRecord }) => {
  const rank = vetRank(r);
  return rank >= VET_WINS.length ? null : VET_WINS[rank] - (r.vet?.w ?? 0);
};
export function vetPerks(rank: number): string {
  if (!rank) return 'No perks yet';
  const price = `brokers pay +${Math.round((VET_PRICE[rank] - 1) * 100)}%`;
  return VET_HP[rank] ? `${price}, +${VET_HP[rank]} HP in battle` : price;
}
