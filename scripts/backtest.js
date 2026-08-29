/* Runs a strategy over locally stored data and prints the result.
 *
 * Usage:
 *   node scripts/backtest.js [strategy] [symbol] [timeframe] [from] [to]
 *   node scripts/backtest.js sma-cross BTCUSDT 1h 2026-06-01 2026-08-01
 *
 * Runs twice: once resolving fills through the 1m bars, once with only the
 * strategy timeframe. The gap between the two is what intrabar resolution is
 * worth on this data — and how wrong a backtester without it can be.
 */
import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { listDatasets, readBars } from '../electron/data/store/barStore.js';
import { runBacktest } from '../electron/engine/backtest.js';
import { TIMEFRAMES } from '../electron/data/store/barStore.js';

const [, , strategyName = 'sma-cross', symbolArg, tfArg = '1h', fromArg, toArg] = process.argv;

const dir = path.join(os.homedir(), 'AppData', 'Roaming', 'project-midori', 'market-data');
if (!existsSync(dir)) {
  console.error(`No local data at ${dir}. Download a symbol in the app first.`);
  process.exit(1);
}

const datasets = await listDatasets(dir);
if (datasets.length === 0) {
  console.error('No datasets stored. Download a symbol in the app first.');
  process.exit(1);
}

const meta = symbolArg
  ? datasets.find((d) => d.symbol === symbolArg.toUpperCase())
  : datasets[0];
if (!meta) {
  console.error(`${symbolArg} is not stored. Available: ${datasets.map((d) => d.symbol).join(', ')}`);
  process.exit(1);
}

if (!TIMEFRAMES[tfArg]) {
  console.error(`Unknown timeframe "${tfArg}". Known: ${Object.keys(TIMEFRAMES).join(', ')}`);
  process.exit(1);
}

const from = fromArg ? Date.parse(`${fromArg}T00:00:00Z`) : meta.first;
const to = toArg ? Date.parse(`${toArg}T00:00:00Z`) : meta.last + 60_000;

const strategyPath = path.resolve('strategies', `${strategyName}.js`);
if (!existsSync(strategyPath)) {
  console.error(`No strategy at ${strategyPath}`);
  process.exit(1);
}
const strategy = await import(pathToFileURL(strategyPath).href);

console.log(`${meta.symbol}  ${tfArg}  `
  + `${new Date(from).toISOString().slice(0, 10)} → ${new Date(to).toISOString().slice(0, 10)}`);
console.log(`strategy: ${strategyName}\n`);

// Only closed buckets reach the strategy; the 1m bars are for fills.
const bars = await readBars(dir, meta.symbol, tfArg, from, to, true);
const baseBars = await readBars(dir, meta.symbol, '1m', from, to, false);
console.log(`${bars.length.toLocaleString('en-GB')} ${tfArg} bars, `
  + `${baseBars.length.toLocaleString('en-GB')} 1m bars for intrabar fills\n`);

if (bars.length === 0) {
  console.error('No bars in that range.');
  process.exit(1);
}

const brokerOptions = {
  balance: 10_000,
  costs: { feeRate: 0.001, spreadPct: 0.0002, slippagePct: 0.0002 },
};

const withMinutes = runBacktest({
  bars, baseBars, strategy, broker: brokerOptions, stepMs: TIMEFRAMES[tfArg],
});
const withoutMinutes = runBacktest({
  bars, strategy, broker: brokerOptions, stepMs: TIMEFRAMES[tfArg],
});

const money = (v) => (v == null ? '—' : v.toLocaleString('en-GB', {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
}));
const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(2)}%`);

function report(label, r) {
  const s = r.stats;
  console.log(`── ${label} ${'─'.repeat(Math.max(0, 46 - label.length))}`);
  console.log(`  net P&L        ${money(s.netPnl)}  (${pct(s.returnPct)})`);
  console.log(`  final equity   ${money(s.finalEquity)}`);
  console.log(`  max drawdown   ${money(s.maxDrawdown)}  (${pct(s.maxDrawdownPct)})`);
  console.log(`  trades         ${s.tradeCount}  (${s.winCount}W / ${s.lossCount}L, `
    + `win rate ${pct(s.winRate)})`);
  console.log(`  avg win/loss   ${money(s.avgWin)} / ${money(s.avgLoss)}`);
  console.log(`  profit factor  ${s.profitFactor == null ? '—' : s.profitFactor.toFixed(2)}`);
  console.log(`  expectancy     ${money(s.expectancy)} per trade`);
  console.log(`  fees paid      ${money(s.feesPaid)}`);
  console.log(`  warm-up        ${r.warmupBars} bars`);
  console.log(`  ran in         ${r.elapsedMs} ms\n`);
}

report(`intrabar fills (1m resolution)`, withMinutes);
report(`bar-only fills (pessimistic)`, withoutMinutes);

// How often did the two disagree about the outcome of a trade?
const a = withMinutes.trades;
const b = withoutMinutes.trades;
const pairs = Math.min(a.length, b.length);
let differing = 0;
for (let i = 0; i < pairs; i++) {
  if (a[i].exitTag !== b[i].exitTag) differing++;
}

console.log('── what the minutes changed ────────────────────────');
const delta = withMinutes.stats.netPnl - withoutMinutes.stats.netPnl;
console.log(`  P&L difference   ${money(delta)}`
  + `  (${delta >= 0 ? 'intrabar was kinder' : 'intrabar was harsher'})`);
console.log(`  trades resolved differently: ${differing} of ${pairs}`);
if (a.length !== b.length) {
  console.log(`  trade counts differ: ${a.length} vs ${b.length} — `
    + 'a different exit changes what the next signal finds');
}

const ambiguous = withMinutes.trades.filter((t, i) => b[i] && t.exitTag !== b[i].exitTag).length;
if (ambiguous === 0 && pairs > 0) {
  console.log('  no bar in this run hit both the stop and the target');
}
