/* Reads the installed app's real datasets through the current store code,
 * to confirm that data written by an earlier format still opens correctly.
 * Read-only: nothing here writes to the user's data directory.
 *
 * Usage: node scripts/check-migration.js
 */
import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { STRIDE, listDatasets, readBars, readDataset } from '../electron/data/store/barStore.js';

const dir = path.join(os.homedir(), 'AppData', 'Roaming', 'project-midori', 'market-data');
if (!existsSync(dir)) {
  console.log(`No installed data at ${dir} — nothing to check.`);
  process.exit(0);
}

console.log(`store: ${dir}\n`);
const datasets = await listDatasets(dir);
let failures = 0;

for (const meta of datasets) {
  const bin = path.join(dir, `${meta.symbol}-1m.bin`);
  const size = (await stat(bin)).size;
  console.log(`${meta.symbol}  format v${meta.format}  ${size.toLocaleString('en-GB')} bytes  `
    + `meta says ${meta.count.toLocaleString('en-GB')} bars`);

  const t0 = Date.now();
  const data = await readDataset(dir, meta.symbol);
  const bars = data.length / STRIDE;
  console.log(`  read in ${Date.now() - t0} ms → ${bars.toLocaleString('en-GB')} bars in memory`);

  if (bars !== meta.count) {
    console.log(`  FAIL: expected ${meta.count} bars, got ${bars}`);
    failures++;
    continue;
  }

  const sample = await readBars(dir, meta.symbol, '1m', meta.first, meta.first + 3 * 60_000);
  const first = sample[0];
  console.log(`  first bar ${new Date(first.time).toISOString()}  `
    + `O${first.open} H${first.high} L${first.low} C${first.close} V${first.volume}`);
  console.log(`  buy volume: ${Number.isNaN(first.buyVolume) ? 'unknown (migrated from v1)' : first.buyVolume}`);

  // Sanity: prices must be ordered and finite, or the stride is being misread.
  let bad = 0;
  for (let i = 0; i < bars; i++) {
    const b = i * STRIDE;
    if (!(data[b + 2] >= data[b + 3]) || !Number.isFinite(data[b + 1]) || !Number.isFinite(data[b])) {
      bad++;
      if (bad === 1) {
        console.log(`  FAIL at bar ${i}: t=${data[b]} o=${data[b + 1]} h=${data[b + 2]} l=${data[b + 3]}`);
      }
    }
  }
  if (bad) {
    console.log(`  FAIL: ${bad} bars have impossible values — the layout is being misread`);
    failures++;
  } else {
    console.log('  every bar has high >= low and finite values: OK');
  }

  // Timestamps must stay strictly ascending, one minute apart where continuous.
  let outOfOrder = 0;
  for (let i = 1; i < bars; i++) {
    if (data[i * STRIDE] <= data[(i - 1) * STRIDE]) outOfOrder++;
  }
  if (outOfOrder) {
    console.log(`  FAIL: ${outOfOrder} timestamps out of order`);
    failures++;
  } else {
    console.log('  timestamps strictly ascending: OK');
  }
  console.log();
}

console.log(failures === 0
  ? `All ${datasets.length} dataset(s) read correctly under the current format.`
  : `${failures} problem(s) found.`);
process.exit(failures === 0 ? 0 : 1);
