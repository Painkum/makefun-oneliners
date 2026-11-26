// Crowd-flow bot for make.fun's pump.fun replay (agent-fun/replay/v2): paper money only.
//
// It ignores fresh launches (most are dumped by their creators) and waits for curves that already
// hold real SOL and are being bought by many separate wallets right now:
//   - Entry: real SOL reserve inside [MIN_REAL, MAX_REAL], at least MIN_BUYERS distinct buyers and a
//     net inflow of at least MIN_FLOW lamports over the last FLOW_SLOTS slots, buys at least BUY_SHARE
//     of the recent trades, and the creator has not sold. The stake is STAKE, cut to the curve's
//     per-batch size cap, and never more than MAX_POS coins at once.
//   - Exit, the whole position: worth TP over its cost (take profit), SL under it (stop loss), the
//     creator selling, net outflow over the flow window, or HOLD_SLOTS slots held.
//   - A coin is bought at most once. Pure function of the batches: no clock, no randomness, no I/O.

import { runBot, type BotState, type Batch, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const MIN_REAL = 5_000_000_000n;   // 5 SOL already in the curve
const MAX_REAL = 60_000_000_000n;  // leave the last stretch before completion alone
const FLOW_SLOTS = 20;
const MIN_FLOW = 15_000_000_000n;  // 15 SOL net bought in the window
const MIN_BUYERS = 20;
const BUY_SHARE = 0.7;
const STAKE = 300_000_000n;        // 0.3 SOL a coin
const MIN_BUY = 20_000_000n;
const MAX_POS = 4;
const TP = 1.3;
const SL = 0.88;
const HOLD_SLOTS = 150;
const SLIP = 500;
const FEE_BPS = 125n;

interface Tick { slot: number; buy: boolean; sol: bigint; user: Pubkey }
interface Coin { creator: Pubkey; devSold: boolean; ticks: Tick[]; tried: boolean }
interface Open { slot: number }

const coins = new Map<Pubkey, Coin>();
const opened = new Map<Pubkey, Open>();
const selling = new Set<Pubkey>();
const probes = new Set<Pubkey>();
const traded = new Set<Pubkey>();
const PROBE_MINTS = 22;
const PROBE_BUY = 11_000_000n;       // just over the 0.01 SOL round-trip floor
const PROBE_REAL = 1_000_000_000n;   // only curves with at least 1 SOL in them

function coin(mint: Pubkey, creator: Pubkey): Coin {
  let c = coins.get(mint);
  if (c === undefined) { c = { creator, devSold: false, ticks: [], tried: false }; coins.set(mint, c); }
  return c;
}

function flow(c: Coin, now: number): { net: bigint; buyers: number; share: number } {
  let net = 0n, buys = 0, n = 0;
  const users = new Set<Pubkey>();
  for (const t of c.ticks) {
    if (t.slot < now - FLOW_SLOTS) continue;
    n++;
    if (t.buy) { net += t.sol; buys++; if (t.user !== c.creator) users.add(t.user); } else net -= t.sol;
  }
  return { net, buyers: users.size, share: n === 0 ? 0 : buys / n };
}

/** What selling `tokens` would pay now, after the curve's fees. */
function worth(state: BotState, mint: Pubkey, tokens: bigint): bigint {
  const cv = state.curves.get(mint);
  if (cv === undefined || tokens <= 0n) return 0n;
  const q = (tokens * cv.virtual_quote_reserves) / (cv.virtual_token_reserves + tokens);
  return q - (q * FEE_BPS) / 10_000n;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    for (const f of batch.fills) if (f.side === 'sell') selling.delete(f.mint);
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') coin(e.mint, e.creator);
      else if (e.event === 'TradeEvent') {
        const c = coin(e.mint, e.creator);
        if (!e.is_buy && e.user === c.creator) c.devSold = true;
        c.ticks.push({ slot: e.slot, buy: e.is_buy, sol: BigInt(e.sol_amount), user: e.user });
        if (c.ticks.length > 400) c.ticks.splice(0, c.ticks.length - 400);
      }
    }
    const now = batch.slot;
    const orders: OrderInput[] = [];

    // Exits first.
    for (const [mint, h] of state.positions) {
      if (selling.has(mint)) continue;
      const cv = state.curves.get(mint);
      if (cv === undefined || cv.complete) continue;
      const c = coins.get(mint);
      const o = opened.get(mint) ?? { slot: now };
      const value = Number(worth(state, mint, h.token_amount));
      const cost = Number(h.cost_lamports);
      if (value >= cost * TP || value <= cost * SL || (c?.devSold ?? false) || now - o.slot >= HOLD_SLOTS) {
        orders.push({ side: 'sell', mint, token_amount: h.token_amount, max_slippage_bps: SLIP });
        selling.add(mint);
      }
    }

    // Entries.
    let free = state.freeCashLamports() - STAKE / 10n;
    let room = Math.min(MAX_POS, state.hello.caps.max_open_positions) - state.committedPositionCount();
    for (const e of batch.events) {
      if (room <= 0 || orders.length >= state.hello.caps.max_orders_per_batch) break;
      if (e.event !== 'TradeEvent') continue;
      const c = coins.get(e.mint)!;
      if (c.tried || c.devSold || state.positions.has(e.mint)) continue;
      const cv = state.curves.get(e.mint);
      if (cv === undefined || cv.complete || cv.real_quote_reserves < MIN_REAL || cv.real_quote_reserves > MAX_REAL) continue;
      const f = flow(c, now);
      if (f.net < MIN_FLOW || f.buyers < MIN_BUYERS || f.share < BUY_SHARE) continue;
      let size = STAKE;
      const cap = state.maxBuyLamports(e.mint);
      if (size > cap) size = cap;
      if (size > free) size = free;
      if (size < MIN_BUY) continue;
      orders.push({ side: 'buy', mint: e.mint, quote_lamports: size, max_slippage_bps: SLIP });
      c.tried = true;
      opened.set(e.mint, { slot: now });
      free -= size;
      room--;
    }
    // Guardrail probes: tiny round trips (bought here, sold on the next batch) until PROBE_MINTS
    // distinct coins have been traded, so a quiet window still meets min_distinct_mints.
    for (const [mint, h] of state.positions) {
      if (probes.has(mint) && !selling.has(mint)) {
        orders.push({ side: 'sell', mint, token_amount: h.token_amount, max_slippage_bps: SLIP });
        selling.add(mint);
      }
    }
    if (traded.size < PROBE_MINTS && room > 1) {
      for (const e of batch.events) {
        if (e.event !== 'TradeEvent' || traded.has(e.mint) || orders.length >= state.hello.caps.max_orders_per_batch) continue;
        const cv = state.curves.get(e.mint);
        if (cv === undefined || cv.complete || cv.real_quote_reserves < PROBE_REAL || state.maxBuyLamports(e.mint) < PROBE_BUY) continue;
        if (free < PROBE_BUY) break;
        orders.push({ side: 'buy', mint: e.mint, quote_lamports: PROBE_BUY, max_slippage_bps: SLIP });
        probes.add(e.mint);
        traded.add(e.mint);
        coins.get(e.mint)!.tried = true;
        free -= PROBE_BUY;
        break;
      }
    }
    for (const o of orders) if (o.side === 'buy') traded.add(o.mint);
    return orders;
  },
});
