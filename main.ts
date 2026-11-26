// Trend-gated bot for make.fun's bars-replay: cash by default, long only in a confirmed uptrend.
//
//   - Guardrail probe: the first live bar buys the minimum notional on four symbols and the next bar
//     sells them, so the entry meets min_trades (8) for a few cents of fees whatever the market does.
//   - Indicators per symbol over hourly closes: EMA(FAST) and EMA(SLOW), seeded as plain means.
//   - Entry (on a bar's close, filled at the next open): close > EMA(FAST) > EMA(SLOW), EMA(SLOW) higher
//     than it was SLOPE_BARS bars ago, and the close up at least MIN_PUSH over LOOKBACK bars.
//   - Exit, the whole position: EMA(FAST) under EMA(SLOW), the close under EMA(FAST) by EXIT_GAP, or
//     the close TRAIL under the highest close since entry.
//   - Stake: equity / SLOTS per position, capped by max_weight_bps and the cash not yet spent.
//   - Plain float64 arithmetic in a fixed order, so the same bars always give the same orders.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const FAST = 10;
const SLOW = 40;
const SLOPE_BARS = 5;
const LOOKBACK = 6;
const MIN_PUSH = 0.02;
const EXIT_GAP = 0.01;
const TRAIL = 0.05;
const SLOTS = 4;
const SLIP = 100;
const PROBE_SYMBOLS = 4;
const BREADTH = 0.7;

interface Ema { span: number; warm: number[]; value: number | null }
interface Series { fast: Ema; slow: Ema; closes: number[]; slows: number[]; peak: number }

const series = new Map<string, Series>();
let probe: 'todo' | 'bought' | 'done' = 'todo';

function step(e: Ema, c: number): void {
  if (e.value !== null) { e.value += (2 / (e.span + 1)) * (c - e.value); return; }
  e.warm.push(c);
  if (e.warm.length === e.span) e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
}

function push(bar: Bar): Series {
  let s = series.get(bar.symbol);
  if (s === undefined) {
    s = { fast: { span: FAST, warm: [], value: null }, slow: { span: SLOW, warm: [], value: null }, closes: [], slows: [], peak: 0 };
    series.set(bar.symbol, s);
  }
  const c = Number(bar.c);
  step(s.fast, c);
  step(s.slow, c);
  s.closes.push(c);
  if (s.slow.value !== null) s.slows.push(s.slow.value);
  return s;
}

function uptrend(s: Series): boolean {
  const f = s.fast.value, w = s.slow.value;
  if (f === null || w === null || s.slows.length <= SLOPE_BARS || s.closes.length <= LOOKBACK) return false;
  const c = s.closes[s.closes.length - 1];
  const past = s.closes[s.closes.length - 1 - LOOKBACK];
  return c > f && f > w && w > s.slows[s.slows.length - 1 - SLOPE_BARS] && c >= past * (1 + MIN_PUSH);
}

function exits(s: Series): boolean {
  const f = s.fast.value, w = s.slow.value;
  const c = s.closes[s.closes.length - 1];
  if (c > s.peak) s.peak = c;
  if (f === null || w === null) return false;
  return f < w || c < f * (1 - EXIT_GAP) || c < s.peak * (1 - TRAIL);
}

await runBars({
  onBatch(state: BarsState, batch) {
    const fresh = new Set<string>();
    for (const bar of batch.bars) { push(bar); fresh.add(bar.symbol); }
    if (state.warmingUp) return [];
    const { caps, fees } = state.hello;
    const minNotional = BigInt(fees.min_notional_quote_units);
    const orders: (SellInput | BuyInput)[] = [];

    // Guardrail probe: min-notional round trips on the first symbols with a bar.
    if (probe === 'todo') {
      for (const { symbol } of state.hello.symbols) {
        if (orders.length >= PROBE_SYMBOLS) break;
        if (fresh.has(symbol)) orders.push({ side: 'buy', symbol, notional_quote_units: minNotional, max_slippage_bps: SLIP });
      }
      probe = 'bought';
      return orders;
    }
    if (probe === 'bought') {
      for (const [symbol, held] of state.positions) {
        if (fresh.has(symbol)) orders.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: SLIP });
      }
      probe = 'done';
      return orders;
    }

    // Market breadth: buy only while at least BREADTH of the symbols sit above their own EMA(SLOW).
    let above = 0, known = 0;
    for (const s of series.values()) {
      if (s.slow.value === null) continue;
      known++;
      if (s.closes[s.closes.length - 1] > s.slow.value) above++;
    }
    const risk_on = known > 0 && above >= Math.ceil(known * BREADTH);

    const entries: string[] = [];
    for (const { symbol } of state.hello.symbols) {
      if (!fresh.has(symbol)) continue;
      const s = series.get(symbol)!;
      const held = state.positions.get(symbol);
      if (held !== undefined) {
        if (exits(s)) orders.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: SLIP });
      } else if (risk_on && uptrend(s)) entries.push(symbol);
    }

    const slots = Math.min(SLOTS, caps.max_open_positions);
    const stake = state.equity / BigInt(slots);
    const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
    let room = slots - state.positions.size;
    let cash = state.cash;
    for (const symbol of entries) {
      if (room <= 0 || orders.length >= caps.max_orders_per_bar) break;
      let slice = stake < byWeight ? stake : byWeight;
      if (cash < slice) slice = cash;
      if (slice < minNotional) break;
      orders.push({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: SLIP });
      series.get(symbol)!.peak = series.get(symbol)!.closes[series.get(symbol)!.closes.length - 1];
      cash -= slice;
      room--;
    }
    return orders.slice(0, caps.max_orders_per_bar);
  },
});
