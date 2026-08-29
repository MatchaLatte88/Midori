/* End-to-end check without Electron: download → store → read back.
 * Usage: node scripts/smoke.js [SYMBOL] [FROM] [TO]
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { downloadRange } from '../electron/data/providers/binance.js';
import { listDatasets, mergeBars, readBars } from '../electron/data/store/barStore.js';
import { computeVolumeProfile } from '../shared/indicators/volumeProfile.js';

const symbol = (process.argv[2] ?? 'BTCUSDT').toUpperCase();
const from = new Date(process.argv[3] ?? '2024-01-01T00:00:00Z');
const to = new Date(process.argv[4] ?? '2024-02-01T00:00:00Z');

const dir = await mkdtemp(path.join(tmpdir(), 'midori-smoke-'));
console.log(`store: ${dir}`);

const t0 = Date.now();
const { bars, missing } = await downloadRange(symbol, from, to, '1m', (p) =>
  console.log(`  fetched ${p.label} (${p.done}/${p.total})`));
console.log(`downloaded ${bars.length.toLocaleString('en-GB')} bars in ${Date.now() - t0} ms`);
if (missing.length) console.log(`not published: ${missing.join(', ')}`);

const t1 = Date.now();
const merged = await mergeBars(dir, symbol, bars, { source: 'binance-spot' });
console.log(`stored ${merged.total.toLocaleString('en-GB')} bars in ${Date.now() - t1} ms`);
console.log(`range: ${new Date(merged.first).toISOString()} → ${new Date(merged.last).toISOString()}`);

for (const tf of ['1m', '15m', '1h', '1d']) {
  const t2 = Date.now();
  const out = await readBars(dir, symbol, tf, from.getTime(), to.getTime());
  const first = out[0];
  console.log(
    `${tf.padEnd(4)} ${String(out.length).padStart(6)} bars  ${Date.now() - t2} ms  `
    + `first ${new Date(first.time).toISOString()} O${first.open} H${first.high} L${first.low} C${first.close}`,
  );
}

// The 1d bar must equal the aggregate of its own minutes — the invariant the
// whole multi-timeframe engine rests on.
const day0 = Date.UTC(2024, 0, 2);
const [daily] = await readBars(dir, symbol, '1d', day0, day0 + 86_400_000);
const minutes = await readBars(dir, symbol, '1m', day0, day0 + 86_400_000);
const check = {
  open: minutes[0].open,
  high: Math.max(...minutes.map((b) => b.high)),
  low: Math.min(...minutes.map((b) => b.low)),
  close: minutes.at(-1).close,
};
const ok = daily.open === check.open && daily.high === check.high
  && daily.low === check.low && daily.close === check.close;
console.log(`\n1d bar vs its ${minutes.length} minutes: ${ok ? 'MATCH' : 'MISMATCH'}`);
if (!ok) console.log({ daily, check });

// Volume profile over the whole stored range, measured — this runs on every
// pan of the chart, so it has to stay well inside a frame budget.
const all = await readBars(dir, symbol, '1m', from.getTime(), to.getTime(), false);
const t3 = Date.now();
const profile = computeVolumeProfile(all, { bins: 120, valueArea: 70 });
const profileMs = Date.now() - t3;

const binSum = profile.volumes.reduce((a, b) => a + b, 0);
const barSum = all.reduce((a, b) => a + b.volume, 0);
const conserved = Math.abs(binSum - barSum) < barSum * 1e-9;

console.log(`\nvolume profile over ${all.length.toLocaleString('en-GB')} 1m bars: ${profileMs} ms`);
console.log(`  POC ${profile.poc.price.toFixed(2)}  `
  + `VAH ${profile.valueArea.high.toFixed(2)}  VAL ${profile.valueArea.low.toFixed(2)}`);
console.log(`  value area holds ${(profile.valueArea.volume / profile.totalVolume * 100).toFixed(1)}% of volume`);
console.log(`  volume conserved: ${conserved ? 'YES' : `NO (${binSum} vs ${barSum})`}`);

// Buy/sell split: the two sides must add back up to the total at every level.
let splitOk = profile.hasDelta;
if (profile.hasDelta) {
  for (let i = 0; i < profile.bins; i++) {
    const sum = profile.buyVolumes[i] + profile.sellVolumes[i];
    if (Math.abs(sum - profile.volumes[i]) > profile.volumes[i] * 1e-9 + 1e-9) {
      splitOk = false;
      console.log(`  MISMATCH at level ${i}: ${sum} vs ${profile.volumes[i]}`);
      break;
    }
  }
  const pct = (profile.totalBuyVolume / (profile.totalBuyVolume + profile.totalSellVolume)) * 100;
  console.log(`  buy ${profile.totalBuyVolume.toFixed(2)} / `
    + `sell ${profile.totalSellVolume.toFixed(2)} → ${pct.toFixed(1)}% bought into the ask`);
  console.log(`  delta ${profile.totalDelta >= 0 ? '+' : ''}${profile.totalDelta.toFixed(2)}  `
    + `coverage ${(profile.deltaCoverage * 100).toFixed(1)}%`);
  console.log(`  buy + sell == total at every level: ${splitOk ? 'YES' : 'NO'}`);
} else {
  console.log('  no buy/sell split in this data');
}

console.log('\ncatalog:', await listDatasets(dir));
await rm(dir, { recursive: true, force: true });
process.exit(ok && conserved && splitOk ? 0 : 1);
