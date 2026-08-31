import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  annotateRun, condenseEquity, deleteRun, listRuns, loadRun, saveRun,
} from '../electron/data/store/runStore.js';

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), 'midori-runs-'));
}

/** A minimal run in the shape runBacktest produces. */
function makeRun(over = {}) {
  return {
    strategy: 'silverbullet',
    strategyName: 'Silver Bullet',
    symbol: 'BTCUSDT',
    timeframe: '5m',
    from: Date.UTC(2026, 0, 1),
    to: Date.UTC(2026, 1, 1),
    initialBalance: 10_000,
    params: { riskValue: 1, rrr: 2 },
    trades: [
      { side: 'long', netPnl: 100, openedAt: 1, closedAt: 2, entryTag: 'am', exitTag: 'take-profit' },
      { side: 'short', netPnl: -50, openedAt: 3, closedAt: 4, entryTag: 'pm', exitTag: 'stop-loss' },
    ],
    equityCurve: [
      { time: 1, equity: 10_000, balance: 10_000, drawdown: 0 },
      { time: 2, equity: 10_100, balance: 10_100, drawdown: 0 },
      { time: 3, equity: 10_050, balance: 10_050, drawdown: 50 },
    ],
    stats: {
      netPnl: 50, returnPct: 0.005, winRate: 0.5, tradeCount: 2,
      maxDrawdownPct: 0.005, profitFactor: 2, expectancy: 25, feesPaid: 3,
    },
    resolution: 'intrabar',
    ...over,
  };
}

/* ─── Condensing ────────────────────────────────────────────────────────── */

test('the curve keeps only the points where the balance moved', () => {
  /* The whole reason a run fits in a file: between two trades the realised
   * balance does not move, so those points describe nothing. */
  const curve = [
    { time: 1, equity: 100, balance: 100 },
    { time: 2, equity: 101, balance: 100 },   // unrealised only
    { time: 3, equity: 105, balance: 105 },   // a trade closed
    { time: 4, equity: 105, balance: 105 },
    { time: 5, equity: 110, balance: 110 },   // and another
  ];
  const out = condenseEquity(curve);

  assert.deepEqual(out.map((p) => p.time), [1, 3, 5]);
});

test('the last bar is always kept, trade or not', () => {
  // It is where the run ended; dropping it would shorten the curve's span.
  const curve = [
    { time: 1, equity: 100, balance: 100 },
    { time: 2, equity: 105, balance: 105 },
    { time: 3, equity: 105, balance: 105 },
    { time: 4, equity: 104, balance: 105 },
  ];
  const out = condenseEquity(curve);
  assert.equal(out[out.length - 1].time, 4);
});

test('condensing does not lose the first point or invent any', () => {
  const curve = Array.from({ length: 500 }, (_, i) => ({
    time: i, equity: 100 + (i % 7), balance: 100 + Math.floor(i / 100),
  }));
  const out = condenseEquity(curve);

  assert.equal(out[0].time, 0);
  assert.ok(out.length < curve.length, 'nothing was condensed');
  for (const point of out) assert.ok(curve.includes(point), 'a point was fabricated');
});

test('an empty curve condenses to an empty curve', () => {
  assert.deepEqual(condenseEquity([]), []);
  assert.deepEqual(condenseEquity(null), []);
});

/* ─── Round trip ────────────────────────────────────────────────────────── */

test('a saved run comes back with its trades and its condensed curve', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const summary = await saveRun(dir, makeRun());
  assert.match(summary.id, /^r[0-9a-z]+$/);
  assert.equal(summary.stats.netPnl, 50);

  const full = await loadRun(dir, summary.id);
  assert.equal(full.trades.length, 2);
  assert.equal(full.equityCondensed, true);
  assert.equal(full.strategyName, 'Silver Bullet');
  assert.equal(full.initialBalance, 10_000);
});

test('the order and fill logs are dropped, the inputs are not', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const summary = await saveRun(dir, makeRun({
    orders: new Array(500).fill({ id: 1 }),
    fills: new Array(500).fill({ id: 1 }),
  }));
  const full = await loadRun(dir, summary.id);

  assert.equal(full.orders, undefined, 'orders should not be stored');
  assert.equal(full.fills, undefined, 'fills should not be stored');
  // What the run was is kept, so it can be reproduced.
  assert.deepEqual(full.params, { riskValue: 1, rrr: 2 });
  assert.equal(full.symbol, 'BTCUSDT');
  assert.equal(full.from, Date.UTC(2026, 0, 1));
});

test('the bar duration is stored with the run', async (t) => {
  /* The trade review reads it to decide how much chart one trade is worth.
   * Without it the renderer would need its own timeframe-to-milliseconds
   * table, which is exactly the kind of duplicate that drifts. */
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const summary = await saveRun(dir, makeRun({ stepMs: 300_000 }));
  assert.equal((await loadRun(dir, summary.id)).stepMs, 300_000);
});

test('a run stored before the step was reported still loads', async (t) => {
  // Older runs have no stepMs; the review falls back rather than breaking.
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const summary = await saveRun(dir, makeRun());
  const full = await loadRun(dir, summary.id);
  assert.equal(full.stepMs, undefined);
  assert.ok(full.trades.length > 0, 'the run itself must still be usable');
});

test('the costs the run was charged are stored with it', async (t) => {
  /* Without them a stored run cannot say what it paid, and two runs made
   * either side of a change to the defaults would look comparable. */
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const costs = { feeRate: 0.001, spreadPct: 0.0002, slippagePct: 0.0002 };
  const summary = await saveRun(dir, makeRun({ costs }));

  assert.deepEqual((await loadRun(dir, summary.id)).costs, costs);
});

test('runs are listed newest first', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const first = await saveRun(dir, makeRun({ symbol: 'AAAUSDT' }));
  const second = await saveRun(dir, makeRun({ symbol: 'BBBUSDT' }));

  const list = await listRuns(dir);
  assert.equal(list.length, 2);
  assert.equal(list[0].id, second.id);
  assert.equal(list[1].id, first.id);
});

test('the listing carries the figures without opening a run file', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await saveRun(dir, makeRun());
  const [entry] = await listRuns(dir);

  for (const key of ['netPnl', 'winRate', 'tradeCount', 'maxDrawdownPct']) {
    assert.ok(entry.stats[key] !== undefined, `the summary is missing ${key}`);
  }
  // But not the bulk: that is what the summary exists to avoid loading.
  assert.equal(entry.trades, undefined);
  assert.equal(entry.equityCurve, undefined);
});

/* ─── The index is disposable ───────────────────────────────────────────── */

test('a missing index is rebuilt from the run files', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const summary = await saveRun(dir, makeRun());
  await annotateRun(dir, summary.id, 'kept');
  await rm(path.join(dir, 'index.json'));

  const list = await listRuns(dir);
  assert.equal(list.length, 1, 'the run was lost with the index');
  assert.equal(list[0].id, summary.id);
  assert.equal(list[0].note, 'kept', 'the note comes from the file, not the index');
});

test('a corrupt index is rebuilt rather than surfacing as empty', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await saveRun(dir, makeRun());
  await writeFile(path.join(dir, 'index.json'), 'not json at all', 'utf8');

  const list = await listRuns(dir);
  assert.equal(list.length, 1, 'a broken index must not hide the library');
});

test('one unreadable run costs its own entry, not the listing', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const good = await saveRun(dir, makeRun());
  await writeFile(path.join(dir, 'rbroken1.json'), '{ truncated', 'utf8');
  await rm(path.join(dir, 'index.json'));

  const list = await listRuns(dir);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, good.id);
});

test('listing an empty or absent folder is empty, not an error', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  assert.deepEqual(await listRuns(dir), []);
  assert.deepEqual(await listRuns(path.join(dir, 'never-created')), []);
});

/* ─── Deleting and annotating ───────────────────────────────────────────── */

test('deleting removes the file and the index entry', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const summary = await saveRun(dir, makeRun());
  await deleteRun(dir, summary.id);

  assert.deepEqual(await listRuns(dir), []);
  await assert.rejects(() => loadRun(dir, summary.id), /No such backtest run/);
});

test('a deleted run does not come back when the index is rebuilt', async (t) => {
  /* The file has to go with the entry: a rebuild reads the folder, so a file
   * left behind would resurrect a run the user deleted. */
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const summary = await saveRun(dir, makeRun());
  await deleteRun(dir, summary.id);
  await rm(path.join(dir, 'index.json'), { force: true });

  assert.deepEqual(await listRuns(dir), []);
});

test('a note is stored on the run and mirrored into the listing', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const summary = await saveRun(dir, makeRun());
  await annotateRun(dir, summary.id, 'tighter stop');

  assert.equal((await loadRun(dir, summary.id)).note, 'tighter stop');
  assert.equal((await listRuns(dir))[0].note, 'tighter stop');
});

/* ─── Guards ────────────────────────────────────────────────────────────── */

test('an id that could escape the folder is refused', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  for (const bad of ['../secrets', 'r../x', 'notanid', '', 'r!', 'r/../x']) {
    await assert.rejects(() => loadRun(dir, bad), /Invalid run id|No such backtest/, `accepted ${bad}`);
  }
});

test('saving something that is not a run is refused', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await assert.rejects(() => saveRun(dir, null), /a run object is required/);
  await assert.rejects(() => saveRun(dir, { trades: [] }), /has no stats/);
});

test('a stored run stays small enough to keep hundreds of', async (t) => {
  /* The judgement the whole storage decision rests on. A run with a per-bar
   * curve would be megabytes; condensed, it is kilobytes. */
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const bars = 100_000;
  const summary = await saveRun(dir, makeRun({
    equityCurve: Array.from({ length: bars }, (_, i) => ({
      time: i, equity: 10_000 + (i % 13), balance: 10_000 + Math.floor(i / 2000),
    })),
  }));

  const bytes = (await stat(path.join(dir, `${summary.id}.json`))).size;
  assert.ok(bytes < 100_000, `a run of ${bars} bars stored as ${bytes} bytes`);

  const full = await loadRun(dir, summary.id);
  assert.ok(full.equityCurve.length < 100, `curve still has ${full.equityCurve.length} points`);
});
