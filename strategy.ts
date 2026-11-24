// Pump.fun paper-trading bot for the 6-hour replay sprint.
//
// Two edges, both about selection (exits can't save a bad pick: a coordinated
// dump can crash a coin 1.24x -> 0.14x inside a single slot, and the harness
// only shows the bot one batch per slot, so a stop-loss never fires in time):
//
//  1. Dispersed momentum — buy a young coin that is already pumping on broad,
//     spread-out inflow: many distinct buyers, real net SOL inflow, a 1.5x-3x
//     runup off its create price, and no single buyer dominating the tape.
//     One small buy per coin, fast +30% take-profit, wide -25% stop.
//  2. Completion ride — when a coin's real SOL reserve reaches ~50 SOL, most
//     such coins go on to complete the bonding curve at exactly 14.7x the
//     create price. Ride with a bigger stake and no take-profit, only a
//     -15% stop and a long hold.
//
// Why the 6-hour window changes the tuning: the dev window is 24h with 1222
// mints; a 6h final window holds roughly a quarter of that, so the entry
// filters must admit enough coins to clear the >=20-coin guardrail with
// margin, and positions opened late in the window may never close — so the
// momentum hold is kept short and the filters a touch looser than the 24h
// optimum. The defaults below are the 6h retune (20 buyers / 6 SOL net /
// age <= 3000 slots / top-share <= 0.18); see the slice analysis in the
// build notes for why the 24h v4 defaults (25 / 8 / 1000 / 0.15) were not
// kept: they trade only 14-15 coins on a cold 6h slice and would miss the
// >=20-coin guardrail, ranking below every entry that meets it.
//
// Deterministic by construction: no clock, no randomness, no environment
// reads; iteration only over insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Momentum entry: coin age in slots at entry. */
  minAgeSlots: number;
  maxAgeSlots: number;
  /** Distinct non-creator buyers since the coin was created. */
  minBuyers: number;
  /** Net SOL inflow (buys minus sells) since create. */
  minNetSol: number;
  /** Price now / create price: must have pumped, but not already mooned. */
  minRunup: number;
  maxRunup: number;
  /** Largest single buyer's share of buy SOL since create, at most. */
  maxTopShare: number;
  /** Momentum buy size in SOL. One buy per coin, never add. */
  buySol: number;
  /** Slippage allowed on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Momentum exits: stop-loss and take-profit fractions. */
  stopLoss: number;
  takeProfit: number;
  /** Momentum max hold, in slots. */
  maxHoldSlots: number;
  /** Completion-ride entry: real SOL reserve at entry, at least this. */
  rideMinReserveSol: number;
  /** Completion-ride stake in SOL, stop-loss fraction, max hold in slots. */
  rideStakeSol: number;
  rideStopLoss: number;
  rideMaxHoldSlots: number;
  /** Exit a held coin when its creator sells. */
  exitOnCreatorSell: boolean;
  /** Slots to wait after an exit before the same coin may be bought again. */
  cooldownSlots: number;
  /** Most entries per coin over the whole run. */
  maxEntriesPerCoin: number;
}

export const DEFAULT_PARAMS: Params = {
  minAgeSlots: 0,
  // 6h retune (see build notes): the 24h v4 defaults (25 buyers / 8 SOL /
  // age 1000 / top-share 0.15) trade only 14-15 coins on a cold 6h slice and
  // would MISS the >=20-coin guardrail; this retune clears it on all four
  // 6h slices of the dev window (20/21/38/36 coins) while staying positive
  // on 3 of 4 slices (sim +0.03/+0.01/+0.95/-0.64 SOL). Looser still (top
  // share 0.20, buyers 15, net 4) goes negative — the tight dispersion
  // filter is the edge, so it is only relaxed to 0.18.
  maxAgeSlots: 3000,
  minBuyers: 20,
  minNetSol: 6.0,
  minRunup: 1.5,
  maxRunup: 3.0,
  maxTopShare: 0.18,
  buySol: 0.1,
  buySlipBps: 1500,
  stopLoss: 0.25,
  takeProfit: 0.3,
  maxHoldSlots: 2000,
  rideMinReserveSol: 50,
  rideStakeSol: 0.5,
  rideStopLoss: 0.15,
  rideMaxHoldSlots: 3000,
  exitOnCreatorSell: false,
  cooldownSlots: 300,
  maxEntriesPerCoin: 1,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface Tape {
  createdAt: number | null;
  creator: Pubkey | null;
  createPrice: number;
  netSol: number;
  buySol: number;
  buyers: Set<Pubkey>;
  biggestBuy: number;
  creatorSold: boolean;
  entries: number;
  lastExitSlot: number;
}

interface OpenPosition {
  openedAt: number;
  costSol: number;
  filled: boolean;
  ride: boolean;
}

function quotePrice(virtualQuote: bigint, virtualTokens: bigint): number {
  return Number(virtualQuote) / Number(virtualTokens);
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const open = new Map<Pubkey, OpenPosition>();

  const tapeFor = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = {
        createdAt: null,
        creator: null,
        createPrice: 0,
        netSol: 0,
        buySol: 0,
        buyers: new Set(),
        biggestBuy: 0,
        creatorSold: false,
        entries: 0,
        lastExitSlot: -1e12,
      };
      tapes.set(mint, t);
    }
    return t;
  };

  const momentumEntryOk = (t: Tape, now: number, price: number): boolean => {
    if (t.createdAt === null || t.creator === null) return false;
    const age = now - t.createdAt;
    if (age < p.minAgeSlots || age > p.maxAgeSlots) return false;
    if (t.buyers.size < p.minBuyers) return false;
    if (t.netSol < p.minNetSol) return false;
    if (t.creatorSold) return false;
    if (t.createPrice <= 0) return false;
    const runup = price / t.createPrice;
    if (runup < p.minRunup || runup > p.maxRunup) return false;
    if (t.buySol > 0 && t.biggestBuy > p.maxTopShare * t.buySol) return false;
    if (t.entries >= p.maxEntriesPerCoin) return false;
    if (now - t.lastExitSlot < p.cooldownSlots) return false;
    return true;
  };

  const rideEntryOk = (t: Tape, now: number, reserveSol: number): boolean => {
    if (t.createdAt === null || t.creator === null) return false;
    if (reserveSol < p.rideMinReserveSol) return false;
    if (t.creatorSold) return false;
    if (t.entries >= p.maxEntriesPerCoin) return false;
    if (now - t.lastExitSlot < p.cooldownSlots) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();

      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const t = tapeFor(e.mint);
          t.createdAt = e.slot;
          t.creator = e.creator;
          t.createPrice = quotePrice(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        } else if (e.event === 'TradeEvent') {
          const t = tapeFor(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.netSol += e.is_buy ? sol : -sol;
          if (e.is_buy) {
            t.buySol += sol;
            if (e.user !== t.creator) t.buyers.add(e.user);
            if (sol > t.biggestBuy) t.biggestBuy = sol;
          } else if (e.user === t.creator) {
            t.creatorSold = true;
          }
          traded.add(e.mint);
        } else {
          // CompleteEvent: the replay closes the position itself.
          traded.add(e.mint);
        }
      }

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingCount = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingCount.set(po.order.mint, (pendingCount.get(po.order.mint) ?? 0) + 1);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const txSol = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first: stops, take-profits, creator-sell exits, max holds.
      for (const [mint, h] of open) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingCount.has(mint)) {
            open.delete(mint);
            if (h.filled) tapeFor(mint).lastExitSlot = now;
            else tapeFor(mint).entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const valueSol = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - txSol;
        const costSol = Number(pos.cost_lamports) / LAMPORTS;
        const sl = h.ride ? p.rideStopLoss : p.stopLoss;
        const hold = h.ride ? p.rideMaxHoldSlots : p.maxHoldSlots;
        let exit = false;
        if (valueSol < costSol * (1 - sl)) exit = true;
        if (!exit && !h.ride && valueSol >= costSol * (1 + p.takeProfit)) exit = true;
        if (!exit && p.exitOnCreatorSell && tapeFor(mint).creatorSold) exit = true;
        if (!exit && now - h.openedAt > hold) exit = true;
        if (!exit) continue;
        let sellPending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        }
        if (sellPending) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Entries: completion rides first (the fat tail), then momentum.
      let freeSol = Number(state.freeCashLamports()) / LAMPORTS;
      let freeSlots = state.hello.caps.max_open_positions - state.committedPositionCount();

      const tryEnter = (mint: Pubkey, ride: boolean): void => {
        if (orders.length >= cap || freeSlots <= 0) return;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) return;
        if (pendingCount.has(mint) || open.has(mint)) return;
        const t = tapes.get(mint)!;
        const price = quotePrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        const reserveSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (ride) {
          if (!rideEntryOk(t, now, reserveSol)) return;
        } else if (!momentumEntryOk(t, now, price)) {
          return;
        }
        const want = ride ? p.rideStakeSol : p.buySol;
        const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
        let amount = Math.min(capSol, want);
        if (amount > freeSol - txSol) amount = freeSol - txSol;
        if (amount < 0.01) return;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        if (lamports <= 0n) return;
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        freeSol -= amount + txSol;
        open.set(mint, { openedAt: now, costSol: amount, filled: false, ride });
        t.entries++;
        freeSlots--;
      };

      for (const mint of traded) tryEnter(mint, true);
      for (const mint of traded) tryEnter(mint, false);

      return orders;
    },
  };
}
