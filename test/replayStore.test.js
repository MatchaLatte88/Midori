/* The replay store against a stand-in data layer.
 *
 * The engine's own rules are checked in replaySession.test.js with twenty bars
 * in an array. This checks the half that only exists in the renderer: fetching
 * a window, walking it forward, swapping it for another timeframe, and putting
 * the session down and picking it up again. Those are the paths where a bug
 * does not throw — it quietly plays a stretch of history twice, or hands back
 * an account that was marked to the wrong price.
 *
 * The store reaches for `window.midori`, so there is one here: a minute series
 * generated once and aggregated on demand, which is what the real store does
 * with the data on disk. No Electron, no chart, no browser.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 5); // a Monday, so the day boundaries are plain

const TF_MS = {
  '1m': MIN, '5m': 5 * MIN, '15m': 15 * MIN, '30m': 30 * MIN,
  '1h': 60 * MIN, '4h': 240 * MIN, '1d': 1440 * MIN,
};

/**
 * A week of minutes with a shape that is easy to reason about.
 *
 * Price walks up and down in a slow triangle so that highs and lows are where
 * arithmetic says they are, rather than wherever a random walk put them.
 */
function minuteBars(count = 4000) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const wave = Math.abs(((i % 400) - 200)) / 10; // 0…20, back down
    const open = 100 + wave;
    out.push({
      time: T0 + i * MIN,
      open,
      high: open + 0.5,
      low: open - 0.5,
      close: open + 0.1,
      volume: 10,
      takerBuyVolume: 6,
    });
  }
  return out;
}

const MINUTES = minuteBars();

/** Aggregates the minute series the way the bar store does. */
function aggregate(timeframe, from, to) {
  const step = TF_MS[timeframe];
  const buckets = new Map();

  for (const m of MINUTES) {
    if (m.time < from || m.time >= to) continue;
    const key = Math.floor(m.time / step) * step;
    const bucket = buckets.get(key);
    if (!bucket) {
      buckets.set(key, {
        time: key, open: m.open, high: m.high, low: m.low, close: m.close,
        volume: m.volume, takerBuyVolume: m.takerBuyVolume, minutes: 1,
      });
      continue;
    }
    bucket.high = Math.max(bucket.high, m.high);
    bucket.low = Math.min(bucket.low, m.low);
    bucket.close = m.close;
    bucket.volume += m.volume;
    bucket.takerBuyVolume += m.takerBuyVolume;
    bucket.minutes += 1;
  }

  return [...buckets.values()]
    .sort((a, b) => a.time - b.time)
    /* `dropIncomplete` is what the real store does at the live edge; here it is
     * enough that a bucket the window cut in half never reaches the session,
     * which is the property the session relies on. */
    .filter((b) => b.minutes === step / MIN)
    .map(({ minutes, ...bar }) => bar);
}

/** What the preload bridge exposes, with the parts a replay touches. */
function fakeBridge() {
  const sessions = new Map();
  let nextId = 1;

  return {
    data: {
      bars: async ({ timeframe, from, to }) => aggregate(timeframe, from, to),
    },
    replay: {
      save: async (request) => ({ id: 'r1', ...request }),
      saveSession: async (request) => {
        const id = request.id ?? `s${nextId++}`;
        sessions.set(id, { ...request, id, savedAt: Date.now() });
        return { id, savedAt: Date.now() };
      },
      sessions: async () => [...sessions.values()],
      loadSession: async (id) => sessions.get(id),
      deleteSession: async (id) => sessions.delete(id),
    },
  };
}

/* The store pulls in stores/session.js for setError, and that one asks the
 * browser about the theme on the way in. Enough of a window for both of them
 * to load; nothing in here is what is being tested. */
globalThis.window = {
  midori: fakeBridge(),
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
};

const store = await import('../src/stores/replay.js');

const START = T0 + 2000 * MIN;

async function start(timeframe = '5m', over = {}) {
  await store.startReplay({
    symbol: 'TESTUSDT',
    timeframe,
    stepMs: TF_MS[timeframe],
    from: START,
    balance: 10_000,
    costs: { feeRate: 0, spreadPct: 0, slippagePct: 0 },
    ...over,
  });
}

beforeEach(() => {
  store.stopReplay();
  window.midori = fakeBridge();
});

/* ─── The window ────────────────────────────────────────────────────────── */

test('a session starts on the bar holding the moment it was given', async () => {
  await start('5m');

  const { replay } = store;
  assert.equal(replay.active, true);
  assert.equal(replay.status, 'ready');
  assert.ok(replay.bars[replay.index].time <= START);
  assert.ok(replay.bars[replay.index].time + TF_MS['5m'] > START);
  assert.equal(replay.clock, replay.bars[replay.index].time + TF_MS['5m']);
});

test('stepping moves the clock by exactly one bar', async () => {
  await start('5m');
  const before = store.replay.clock;

  await store.stepReplay();
  assert.equal(store.replay.clock, before + TF_MS['5m']);
});

test('a skip of n bars is n steps, not a seek', async () => {
  await start('5m');
  const before = store.replay.clock;

  const moved = await store.stepBars(20);
  assert.equal(moved, 20);
  assert.equal(store.replay.clock, before + 20 * TF_MS['5m']);
  assert.equal(store.replay.account.progress, 20, 'every one of them went through the engine');
});

test('a resting order placed before a skip is filled by the bars it covers', async () => {
  await start('5m');

  const price = store.replay.bars[store.replay.index].close;
  store.restingEntry({ side: 'buy', type: 'limit', size: 1, price: price + 5 });
  assert.equal(store.replay.orders.length, 1);

  await store.stepBars(60);

  assert.equal(store.replay.orders.length, 0, 'the limit was answered on the way through');
  assert.equal(store.replay.positions.length, 1);
});

test('a jump lands on the moment asked for and refuses to go backwards', async () => {
  await start('5m');
  const target = store.replay.clock + 30 * TF_MS['5m'];

  await store.jumpTo(target);
  assert.equal(store.replay.clock, target);

  await assert.rejects(
    () => store.jumpTo(target - 10 * TF_MS['5m']),
    /only runs forwards/,
  );
});

/* ─── Changing timeframe under a running session ────────────────────────── */

test('switching to a slower timeframe keeps the clock and forms the running bar', async () => {
  await start('5m');
  await store.stepBars(7); // land somewhere inside an hour

  const clock = store.replay.clock;
  await store.switchTimeframe('1h');

  const { replay } = store;
  assert.equal(replay.timeframe, '1h');
  assert.equal(replay.clock, clock, 'the playhead is the same instant');

  const bar = replay.bars[replay.index];
  assert.ok(bar.time <= clock && bar.time + TF_MS['1h'] >= clock);
  if (bar.time + TF_MS['1h'] > clock) {
    assert.equal(bar.forming, true, 'the hour in progress is drawn as far as it has got');
  }
});

test('switching back to the faster timeframe returns to the same instant', async () => {
  await start('5m');
  await store.stepBars(7);
  const clock = store.replay.clock;

  await store.switchTimeframe('1h');
  await store.switchTimeframe('5m');

  assert.equal(store.replay.clock, clock);
  assert.equal(store.replay.timeframe, '5m');
  assert.equal(store.replay.bars[store.replay.index].time + TF_MS['5m'], clock);
});

test('an open position survives a switch untouched', async () => {
  await start('5m');
  store.marketEntry({ side: 'buy', size: 1 });
  const before = { ...store.replay.positions[0] };
  const equity = store.replay.account.equity;

  await store.switchTimeframe('1h');

  const after = store.replay.positions[0];
  assert.equal(after.entryPrice, before.entryPrice);
  assert.equal(after.openedAt, before.openedAt);
  assert.equal(store.replay.account.equity, equity, 'the account is not re-marked by a redraw');
});

test('the hour in progress is finished by the next step, not skipped', async () => {
  await start('5m');
  await store.stepBars(7);
  await store.switchTimeframe('1h');

  const bar = store.replay.bars[store.replay.index];
  const wasForming = bar.forming === true;
  await store.stepReplay();

  if (wasForming) {
    assert.equal(store.replay.bars[store.replay.index].time, bar.time, 'the same hour');
    assert.equal(store.replay.clock, bar.time + TF_MS['1h']);
  }
  assert.ok(!store.replay.bars[store.replay.index].forming);
});

test('switching to a timeframe with no stored bars leaves the session where it was', async () => {
  await start('5m');
  const before = { tf: store.replay.timeframe, clock: store.replay.clock };

  window.midori.data.bars = async () => [];
  await store.switchTimeframe('1h');

  assert.equal(store.replay.timeframe, before.tf);
  assert.equal(store.replay.clock, before.clock);
  assert.equal(store.replay.status, 'ready');
});

/* ─── Several positions ─────────────────────────────────────────────────── */

test('two market entries are two positions, and the active one is the newest', async () => {
  await start('5m');
  store.marketEntry({ side: 'buy', size: 1 });
  await store.stepBars(3);
  store.marketEntry({ side: 'buy', size: 2 });

  const { replay } = store;
  assert.equal(replay.positions.length, 2);
  assert.equal(replay.activePositionId, replay.positions[1].id);
  assert.equal(replay.position.size, 2);
});

test('closing part of one leaves the other alone', async () => {
  await start('5m');
  store.marketEntry({ side: 'buy', size: 4 });
  const first = store.replay.positions[0].id;
  store.marketEntry({ side: 'sell', size: 1 });

  await store.stepBars(2);
  store.closeFraction(0.5, first);

  const { replay } = store;
  assert.equal(replay.positions.length, 2);
  assert.equal(Math.abs(replay.positions.find((p) => p.id === first).size), 2);
  assert.equal(replay.trades.length, 1);
});

test('flatten closes everything', async () => {
  await start('5m');
  store.marketEntry({ side: 'buy', size: 1 });
  store.marketEntry({ side: 'sell', size: 1 });
  await store.stepBars(2);

  store.flattenAll();
  assert.equal(store.replay.positions.length, 0);
  assert.equal(store.replay.trades.length, 2);
});

test('break-even and a trail act on the position that is selected', async () => {
  await start('5m');
  /* Short, because the fixture walks down from here and break-even is refused
   * until the trade is far enough in front for that level to be behind the
   * market — put there any sooner it would close the trade rather than
   * protect it. */
  store.marketEntry({ side: 'sell', size: 1, stopLoss: 150 });
  const first = store.replay.positions[0].id;
  store.marketEntry({ side: 'sell', size: 1, stopLoss: 150 });
  const second = store.replay.positions[1].id;
  await store.stepBars(1);

  store.selectPosition(first);
  store.breakEven();
  store.setTrailing(2);

  const positions = store.replay.positions;
  assert.ok(positions.find((p) => p.id === first).stopLoss < 150);
  assert.equal(positions.find((p) => p.id === second).stopLoss, 150);
  assert.ok(positions.find((p) => p.id === first).trailing);
  assert.equal(positions.find((p) => p.id === second).trailing, null);
});

/* ─── Putting it down and picking it up ─────────────────────────────────── */

test('a suspended session comes back on the same bar with the same account', async () => {
  await start('5m');
  await store.stepBars(5);
  store.marketEntry({ side: 'buy', size: 1, stopLoss: 90 });
  await store.stepBars(3);

  const before = {
    clock: store.replay.clock,
    equity: store.replay.account.equity,
    positions: store.replay.positions.length,
    orders: store.replay.orders.length,
    progress: store.replay.account.progress,
  };

  const { id } = await store.suspendReplay('an afternoon');
  store.stopReplay();
  assert.equal(store.replay.active, false);

  await store.resumeSession(id);

  assert.equal(store.replay.active, true);
  assert.equal(store.replay.clock, before.clock);
  assert.equal(store.replay.account.equity, before.equity);
  assert.equal(store.replay.positions.length, before.positions);
  assert.equal(store.replay.orders.length, before.orders, 'the resting stop came back');
  assert.equal(store.replay.account.progress, before.progress);

  await store.stepReplay();
  assert.equal(store.replay.clock, before.clock + TF_MS['5m'], 'and it carries on from there');
});

test('a session suspended mid-hour comes back mid-hour', async () => {
  await start('5m');
  await store.stepBars(7);
  await store.switchTimeframe('1h');
  const clock = store.replay.clock;

  const { id } = await store.suspendReplay('mid hour');
  store.stopReplay();
  await store.resumeSession(id);

  assert.equal(store.replay.clock, clock);
  assert.equal(store.replay.timeframe, '1h');
});

test('suspending twice replaces the stored session rather than piling up', async () => {
  await start('5m');
  const first = await store.suspendReplay('one');
  await store.stepBars(2);
  const second = await store.suspendReplay('one');

  assert.equal(second.id, first.id);
  assert.equal((await store.savedSessions()).length, 1);
});

test('a stored session can be thrown away', async () => {
  await start('5m');
  const { id } = await store.suspendReplay('gone');
  await store.deleteSavedSession(id);

  assert.equal((await store.savedSessions()).length, 0);
  assert.equal(store.replay.savedSessionId, null);
});

/* ─── What a position is risking ────────────────────────────────────────── */

test('a position carries what it risks and where it stands in R', async () => {
  await start('5m');
  const { replay } = store;

  const entry = replay.bars[replay.index].close;
  store.marketEntry({ side: 'buy', size: 2, stopLoss: entry - 5 });

  const p = replay.positions[0];
  assert.equal(p.risk, 10, 'two units, five away from the stop');
  assert.equal(p.rMultiple, 0, 'flat at the entry, so nothing gained in R yet');
  assert.equal(p.targetR, null, 'and no target to measure one against');
});

test('a target is reported in stops, not in price', async () => {
  await start('5m');
  const { replay } = store;
  const entry = replay.bars[replay.index].close;

  store.marketEntry({ side: 'buy', size: 1, stopLoss: entry - 4, takeProfit: entry + 12 });

  assert.equal(replay.positions[0].targetR, 3);
});

test('a position with no stop has no risk rather than none', async () => {
  await start('5m');
  const { replay } = store;

  store.marketEntry({ side: 'buy', size: 1 });

  const p = replay.positions[0];
  assert.equal(p.risk, null, 'undefined, and never zero');
  assert.equal(p.rMultiple, null);
  assert.equal(replay.exposure.unprotected, 1);
  assert.equal(replay.exposure.risk, 0, 'nothing to add, because nothing was decided');
});

/* The two numbers a managed trade used to get wrong. A stop is not a loss by
 * construction — it is a loss while it is on the losing side of the entry, and
 * once it is past break-even it is the opposite. Reporting the distance to it
 * instead read a break-even stop as a loss the size of the round trip, which
 * is what the chart then printed beside it. */
test('a stop past break-even is what it locks in, not what it risks', async () => {
  await start('5m');
  const { replay } = store;
  const entry = replay.bars[replay.index].close;

  store.marketEntry({ side: 'buy', size: 2, stopLoss: entry - 5 });
  assert.equal(replay.positions[0].stopResult, -10, 'below the entry it costs ten');

  store.protectPosition({ stopLoss: entry + 3 });
  const p = replay.positions[0];
  assert.equal(p.stopResult, 6, 'above it, it holds six');
  assert.equal(p.risk, 0, 'and there is nothing left on it to lose');
  assert.equal(replay.exposure.risk, -6, 'which is what the book is carrying');
});

test('a stop moved to break-even comes out at nothing, costs and all', async () => {
  await start('5m', { costs: { feeRate: 0.001, spreadPct: 0.0002, slippagePct: 0.0002 } });
  const { replay } = store;

  // The fixture walks down from here, so a short is the one that gets in front.
  store.marketEntry({ side: 'sell', size: 1 });
  await store.stepBars(1);
  store.breakEven();

  const p = replay.positions[0];
  assert.ok(p.stopLoss < p.entryPrice, 'a short comes out flat below where it went on');
  assert.ok(Math.abs(p.stopResult) < 1e-9, 'and that level is worth exactly nothing');
  assert.ok(p.risk < 1e-9, 'so there is nothing at risk on it either');
});

test('break-even is refused, and says so, while the trade is behind', async () => {
  await start('5m');
  const { replay } = store;

  store.marketEntry({ side: 'buy', size: 1 });
  const refusal = replay.positions[0].breakEvenRefusal;
  assert.match(refusal ?? '', /not far enough in front/);

  store.breakEven();
  assert.equal(replay.positions[0].stopLoss, null, 'nothing was moved');
});

test('open risk adds up the stops and counts what has none separately', async () => {
  await start('5m');
  const { replay } = store;
  const entry = replay.bars[replay.index].close;

  store.marketEntry({ side: 'buy', size: 1, stopLoss: entry - 3, tag: 'one' });
  store.marketEntry({ side: 'buy', size: 2, stopLoss: entry - 4, tag: 'two' });
  store.marketEntry({ side: 'sell', size: 1, tag: 'bare' });

  assert.equal(replay.exposure.risk, 11, '3 + 8');
  assert.equal(replay.exposure.unprotected, 1);
});

/* ─── Turning one round ─────────────────────────────────────────────────── */

test('reversing leaves one position, the other way, and one closed trade', async () => {
  await start('5m');
  const { replay } = store;

  store.marketEntry({ side: 'buy', size: 1 });
  const before = replay.positions[0].id;

  store.reversePosition();

  assert.equal(replay.positions.length, 1);
  assert.equal(replay.positions[0].size, -1);
  assert.notEqual(replay.positions[0].id, before);
  assert.equal(replay.trades.length, 1);
  assert.equal(replay.activePositionId, replay.positions[0].id, 'and the new one is active');
});

/* ─── Which face of the panel is showing ────────────────────────────────── */

test('opening the trade manager selects the position and shows it', async () => {
  await start('5m');
  const { replay } = store;

  store.marketEntry({ side: 'buy', size: 1, tag: 'one' });
  store.marketEntry({ side: 'sell', size: 1, tag: 'two' });
  const first = replay.positions[0].id;

  store.setPanelTab('ticket');
  store.openTradeManager(first);

  assert.equal(replay.activePositionId, first);
  assert.equal(replay.panelTab, 'trade');
});

test('the manager steps aside when the last position closes', async () => {
  await start('5m');
  const { replay } = store;

  store.marketEntry({ side: 'buy', size: 1 });
  assert.equal(replay.panelTab, 'ticket', 'a fresh session opens on the way in');
  store.openTradeManager(replay.positions[0].id);
  assert.equal(replay.panelTab, 'trade');

  store.closePosition();

  assert.equal(replay.positions.length, 0);
  assert.equal(replay.panelTab, 'ticket', 'a lit but empty tab is worse than one that moves');
});

/* ─── Pointing at a finished trade ──────────────────────────────────────── */

test('a trade in the history can be pointed at and let go of', async () => {
  await start('5m');
  const { replay } = store;

  store.marketEntry({ side: 'buy', size: 1 });
  store.closePosition();
  const [trade] = replay.trades;

  assert.equal(trade.n, 0, 'a trade knows its place in the book it came from');

  store.focusTrade(trade.n);
  assert.equal(replay.focusedTrade, 0);

  store.focusTrade(trade.n);
  assert.equal(replay.focusedTrade, null, 'the second click on the same row lets go');
});

test('the closed trades a session ends with are dropped with it', async () => {
  await start('5m');
  store.marketEntry({ side: 'buy', size: 1 });
  store.closePosition();
  store.focusTrade(0);

  store.stopReplay();

  assert.equal(store.replay.focusedTrade, null);
  assert.equal(store.replay.exposure.risk, 0);
});
