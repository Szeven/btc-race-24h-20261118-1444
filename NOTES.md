# btc-race-24h-20261118-1444 — burst-momentum cbBTC bot

## Strategy

Long-only, one position, full-size entries. The dev window is a choppy,
slightly down-trending tape (BTC -2.8% over 24h, ~7 bps per-minute
volatility) while a full-size round trip costs ~26-32 bps in fee +
slippage + price impact. Offline checks showed every ordinary
10-60 bar momentum variant and every dip-buy variant loses money on
this window — dip-buying is especially bad (drops keep dropping).
The only moves that pay are sharp upward bursts that keep running,
so the bot sits in cash almost all the time and only buys two bursts:

- **Signal A (fast burst):** close > 50 bps above the close 3 bars
  ago. Take profit +60 bps, stop loss -150 bps.
- **Signal B (sustained push):** close > 90 bps above the close 10
  bars ago. Take profit +110 bps, stop loss -150 bps.

Exits, checked on every close while holding: the entering signal's
take profit / stop loss, plus a trailing stop — once the peak gain
reaches +40 bps, exit if the gain falls 40 bps below the peak
(protects a rally that rolls over without printing the take-profit
close).

Risk controls: at most one open position; buys spend all cash;
every order caps slippage at 100 bps from the latest close; no
orders during warm-up; no dip-buying. All comparisons are exact
bigint arithmetic on scaled close prices — deterministic, no clock,
no randomness, no files, no network. Standard library only; the
`vendor/makefun-bars.ts` shim is a byte-identical copy of the kit SDK.

This is not a copy of any kit baseline: the baselines are
buy-and-hold, hold-cash, 24-bar momentum, EMA(8/21) cross,
RSI+Bollinger and ADX-momentum. This bot's signals, exits and sizing
are its own (burst thresholds + per-signal take profits + trailing
stop), and its action log differs from every baseline's.

## Dev-window grade (local, kit grader, `grade-local --driver process`)

- **Net PnL: +14.639911 USDC** (return +1.4639911%)
- Trades: 4 (2 round trips, win rate 1.000)
- Max drawdown: 0.015010198 (1.50%)
- Fees: 1.610818 USDC; net PnL at 2x fees: +13.020389 USDC
- Exposure: 0.300000000, Sharpe (per bar): 0.021941451, 0 rejected orders
- Guardrails: met (trades ok, drawdown ok)
- Determinism: L1 regrade reproduced byte for byte
  (action_log_sha256 5355cc66e4911f1eec14abc2bcf62ddda80ca23b30c2f29d6089c01435d81f19)
- Dev gate: PASSED — net PnL > 0 with margin
- result_sha256: aed3a7940441df5d64aa17b162904382d597dd679bdfe521a9794e198c3ae208
  (note: the kit reports this cannot equal the server's because the
  local Node is v24.22.1 while the server harness runs v26.13.1, and
  the process driver records no image digest — the score itself is
  the server's grading logic on the same data.)

## How to run / verify

From the kit directory:

```
node cli/makefun.mjs grade-local --kit . \
  --bot /path/to/this/repo --driver process --worktree
```

The bot runs as `node /bot/main.ts` (Node 22+, erasable TypeScript,
standard library only). Runtime entrypoint: `main.ts` at the repo root.

## Local commit

SHA: 9757f86a3d27905c89ed970069f96603c52f8209 — the code commit graded
above by grade-local (worktree hash 1c4de8fecec3). Later commits only
edit this NOTES.md file; they do not change the bot.
