// Burst-momentum bot for cbBTC/USDC, agent-fun/bars-replay/v1.
//
// Strategy (long only, one position, full-size entries):
//
//   The dev window is a choppy, slightly down-trending tape: per-minute
//   volatility is ~7 bps while a full-size round trip costs ~26-32 bps in
//   fee + slippage + price impact, so ordinary trend-following and
//   mean-reversion both lose money there (checked offline: every
//   10-60 bar momentum variant and every dip-buy variant is negative).
//   The only moves that pay are sharp upward bursts that keep running:
//   a fast 3-bar spike, or a strong 10-bar push. So this bot sits in
//   cash almost all the time and only buys those two bursts:
//
//   * Signal A (fast burst): close now is > 50 bps above the close
//     3 bars ago. Take profit +60 bps, stop loss -150 bps.
//   * Signal B (sustained push): close now is > 90 bps above the
//     close 10 bars ago. Take profit +110 bps, stop loss -150 bps.
//
//   Exits, checked on every close while holding:
//   * take profit / stop loss of the signal that entered the trade;
//   * a trailing stop: once the position's peak gain reaches +40 bps,
//     exit if the gain falls 40 bps below that peak (protects a rally
//     that rolls over without ever printing the take-profit close).
//
//   Risk controls: at most one open position; buys spend all cash
//   (one position, full size, so sizing is the whole account); every
//   order caps slippage at 100 bps from the latest close, so a fill
//   far past the decision close is rejected instead of chased; no
//   orders during the warm-up; no dip-buying (drops keep dropping on
//   the dev window).
//
//   All comparisons are exact bigint arithmetic on the scaled close
//   prices, so the bot is deterministic: the same bars always give the
//   same orders. No clock, no randomness, no files, no network.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Signal A: 3-bar return threshold (bps), take profit (bps).
const A_LOOKBACK = 3;
const A_THRESHOLD_BPS = 50n;
const A_TAKE_PROFIT_BPS = 60n;
// Signal B: 10-bar return threshold (bps), take profit (bps).
const B_LOOKBACK = 10;
const B_THRESHOLD_BPS = 90n;
const B_TAKE_PROFIT_BPS = 110n;
// Shared stop loss (bps below the fill price).
const STOP_LOSS_BPS = 150n;
// Trailing stop: arm once the peak gain reaches this (bps), then exit
// when the gain has fallen this far (bps) below the peak gain.
const TRAIL_ARM_BPS = 40n;
const TRAIL_GIVEBACK_BPS = 40n;
// Max slippage vs the latest close, per order (bps).
const MAX_SLIPPAGE_BPS = 100;

// Closes of CBBTC, oldest first, one per batch that carried its bar.
const closes: bigint[] = [];
// The trade currently open, or null: its fill price and take-profit bps.
let openTrade: { entry: bigint; takeProfitBps: bigint } | null = null;
// Highest close seen since the open trade's fill (trailing stop).
let peakClose: bigint | null = null;
// The signal whose buy order awaits its fill report, or null:
// its take-profit bps. Set when the buy is sent, consumed by its fill.
let pendingEntry: bigint | null = null;

/** True when now is more than thresholdBps above then (exact bigint). */
function above(now: bigint, then: bigint, thresholdBps: bigint): boolean {
  return now * 10000n > then * (10000n + thresholdBps);
}

/** True when close is at least bps above entry (exact bigint). */
function gainAtLeast(close: bigint, entry: bigint, bps: bigint): boolean {
  return close * 10000n >= entry * (10000n + bps);
}

/** True when close is at least bps below entry (exact bigint). */
function lossAtLeast(close: bigint, entry: bigint, bps: bigint): boolean {
  return close * 10000n <= entry * (10000n - bps);
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // Fold in this batch's fills first: a buy fill opens the trade at
    // its fill price, a sell fill (or a rejected buy) closes the book.
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL) continue;
      if (fill.status === 'filled' && fill.side === 'buy') {
        if (pendingEntry !== null) {
          openTrade = { entry: BigInt(fill.price), takeProfitBps: pendingEntry };
          peakClose = BigInt(fill.price);
        }
        pendingEntry = null;
      } else if (fill.status === 'filled' && fill.side === 'sell') {
        openTrade = null;
        peakClose = null;
      } else if (fill.status === 'rejected' && fill.side === 'buy') {
        pendingEntry = null;
      }
    }

    const close = state.close(SYMBOL);
    if (close === null) return [];
    closes.push(close);

    if (state.warmingUp) return [];

    const held = state.positions.get(SYMBOL);
    if (held !== undefined && openTrade !== null && peakClose !== null) {
      const { entry, takeProfitBps } = openTrade;
      if (close > peakClose) peakClose = close;
      let exitTrade = false;
      if (gainAtLeast(close, entry, takeProfitBps)) {
        exitTrade = true;
      } else if (lossAtLeast(close, entry, STOP_LOSS_BPS)) {
        exitTrade = true;
      } else if (
        gainAtLeast(peakClose, entry, TRAIL_ARM_BPS) &&
        peakClose * 10000n - close * 10000n >= TRAIL_GIVEBACK_BPS * peakClose
      ) {
        // Peak gain is armed and the price has given back 40 bps from it.
        exitTrade = true;
      }
      if (exitTrade) {
        openTrade = null;
        peakClose = null;
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    if (held !== undefined) {
      // A position exists but its fill was never seen (should not
      // happen): hold it rather than trading blind around it.
      return [];
    }

    // Flat: look for a burst. Signal A first, then signal B.
    const n = closes.length;
    let signal: bigint | null = null;
    if (n > A_LOOKBACK && above(closes[n - 1]!, closes[n - 1 - A_LOOKBACK]!, A_THRESHOLD_BPS)) {
      signal = A_TAKE_PROFIT_BPS;
    } else if (n > B_LOOKBACK && above(closes[n - 1]!, closes[n - 1 - B_LOOKBACK]!, B_THRESHOLD_BPS)) {
      signal = B_TAKE_PROFIT_BPS;
    }
    if (signal === null) return [];
    if (state.cash < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    pendingEntry = signal;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },
});
