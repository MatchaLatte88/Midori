import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { Broker, resetOrderIds } from '../electron/engine/broker.js';

const MIN = 60_000;
const T0 = Date.UTC(2024, 0, 1);

/** Costs off by default, so a test measures the logic and not the fees. */
function makeBroker(costs = { feeRate: 0, spreadPct: 0, slippagePct: 0 }, balance = 10_000) {
  return new Broker({ balance, costs });
}

function bar(i, { open, high, low, close }) {
  return { time: T0 + i * MIN, open, high, low, close, volume: 1 };
}

beforeEach(() => resetOrderIds());

/* ─── Timing ────────────────────────────────────────────────────────────── */

test('an order never fills on the bar that placed it', () => {
  const b = makeBroker();
  b.processBar(bar(0, { open: 100, high: 105, low: 95, close: 102 }));
  b.placeOrder({ side: 'buy', size: 1, type: 'market' });

  assert.equal(b.fills.length, 0, 'still pending after the bar it was placed on');
  assert.equal(b.isFlat, true);

  b.processBar(bar(1, { open: 103, high: 106, low: 102, close: 104 }));
  assert.equal(b.fills.length, 1);
  assert.equal(b.fills[0].price, 103, 'market fills at the next open, not the signal close');
});

/* ─── Order types ───────────────────────────────────────────────────────── */

test('a limit buy fills only when price trades down to it', () => {
  const b = makeBroker();
  b.placeOrder({ side: 'buy', size: 1, type: 'limit', limitPrice: 98 });

  b.processBar(bar(0, { open: 100, high: 102, low: 99, close: 101 }));
  assert.equal(b.fills.length, 0, 'low never reached the limit');

  b.processBar(bar(1, { open: 100, high: 101, low: 97, close: 99 }));
  assert.equal(b.fills.length, 1);
  assert.equal(b.fills[0].price, 98, 'fills at the limit price');
});

test('a limit order that gaps past its price fills at the better open', () => {
  const b = makeBroker();
  b.placeOrder({ side: 'buy', size: 1, type: 'limit', limitPrice: 98 });
  b.processBar(bar(0, { open: 95, high: 96, low: 94, close: 95.5 }));

  assert.equal(b.fills[0].price, 95, 'a gap below the limit is a better fill, not a worse one');
});

test('a stop buy triggers on the high and fills at the stop', () => {
  const b = makeBroker();
  b.placeOrder({ side: 'buy', size: 1, type: 'stop', stopPrice: 105 });

  b.processBar(bar(0, { open: 100, high: 104, low: 99, close: 103 }));
  assert.equal(b.fills.length, 0);

  b.processBar(bar(1, { open: 103, high: 107, low: 102, close: 106 }));
  assert.equal(b.fills[0].price, 105);
});

test('a stop that gaps through fills at the open, not at the stop', () => {
  // Understating gap risk is how a backtest hides its worst days.
  const b = makeBroker();
  b.placeOrder({ side: 'sell', size: 1, type: 'stop', stopPrice: 95 });
  b.processBar(bar(0, { open: 90, high: 91, low: 88, close: 89 }));

  assert.equal(b.fills[0].price, 90, 'the fill is where the market actually opened');
});

/* ─── Position accounting ───────────────────────────────────────────────── */

test('a round trip realises the right P&L and leaves the account flat', () => {
  const b = makeBroker();
  b.placeOrder({ side: 'buy', size: 2, type: 'market' });
  b.processBar(bar(0, { open: 100, high: 101, low: 99, close: 100 }));

  assert.equal(b.position.size, 2);
  assert.equal(b.position.entryPrice, 100);

  b.closePosition();
  b.processBar(bar(1, { open: 110, high: 111, low: 109, close: 110 }));

  assert.equal(b.isFlat, true);
  assert.equal(b.balance, 10_000 + 20, '2 units × 10 points');
  assert.equal(b.trades.length, 1);
  assert.equal(b.trades[0].pnl, 20);
  assert.equal(b.trades[0].side, 'long');
});

test('a short profits when price falls', () => {
  const b = makeBroker();
  b.placeOrder({ side: 'sell', size: 1, type: 'market' });
  b.processBar(bar(0, { open: 100, high: 101, low: 99, close: 100 }));
  assert.equal(b.position.size, -1);

  b.closePosition();
  b.processBar(bar(1, { open: 90, high: 91, low: 89, close: 90 }));
  assert.equal(b.trades[0].pnl, 10);
  assert.equal(b.balance, 10_010);
});

test('adding to a position averages the entry by size', () => {
  const b = makeBroker();
  b.placeOrder({ side: 'buy', size: 1, type: 'market' });
  b.processBar(bar(0, { open: 100, high: 100, low: 100, close: 100 }));
  b.placeOrder({ side: 'buy', size: 3, type: 'market' });
  b.processBar(bar(1, { open: 120, high: 120, low: 120, close: 120 }));

  assert.equal(b.position.size, 4);
  assert.equal(b.position.entryPrice, 115, '(100×1 + 120×3) / 4');
});

test('a partial close realises only the closed part', () => {
  const b = makeBroker();
  b.placeOrder({ side: 'buy', size: 4, type: 'market' });
  b.processBar(bar(0, { open: 100, high: 100, low: 100, close: 100 }));

  b.placeOrder({ side: 'sell', size: 1, type: 'market', reduceOnly: true });
  b.processBar(bar(1, { open: 110, high: 110, low: 110, close: 110 }));

  assert.equal(b.position.size, 3, 'the rest stays open');
  assert.equal(b.position.entryPrice, 100, 'the entry of the remainder is untouched');
  assert.equal(b.trades.length, 1);
  assert.equal(b.trades[0].pnl, 10);
  assert.equal(b.balance, 10_010);
});

test('an oversized opposite order reverses the position', () => {
  const b = makeBroker();
  b.placeOrder({ side: 'buy', size: 1, type: 'market' });
  b.processBar(bar(0, { open: 100, high: 100, low: 100, close: 100 }));

  b.placeOrder({ side: 'sell', size: 3, type: 'market' });
  b.processBar(bar(1, { open: 110, high: 110, low: 110, close: 110 }));

  assert.equal(b.trades.length, 1, 'the long is closed');
  assert.equal(b.trades[0].pnl, 10);
  assert.equal(b.position.size, -2, 'and 2 units of short remain');
  assert.equal(b.position.entryPrice, 110);
});

test('a reduce-only order is dropped when the position is already gone', () => {
  const b = makeBroker();
  b.placeOrder({ side: 'sell', size: 1, type: 'market', reduceOnly: true });
  b.processBar(bar(0, { open: 100, high: 100, low: 100, close: 100 }));

  assert.equal(b.isFlat, true, 'it must not open a short by accident');
  assert.equal(b.fills.length, 0);
  assert.equal(b.orders[0].status, 'cancelled');
});

/* ─── Brackets ──────────────────────────────────────────────────────────── */

test('a filled stop-loss cancels the take-profit', () => {
  const b = makeBroker();
  b.submitEntry({ side: 'buy', size: 1, stopLoss: 95, takeProfit: 110 });
  b.processBar(bar(0, { open: 100, high: 101, low: 99, close: 100 }));
  assert.equal(b.position.size, 1);
  assert.equal(b.pending.length, 2, 'stop and target are both live');

  b.processBar(bar(1, { open: 99, high: 100, low: 94, close: 96 }));

  assert.equal(b.isFlat, true);
  assert.equal(b.pending.length, 0, 'the target was retired with the stop');
  assert.equal(b.trades[0].exitTag, 'stop-loss');
  assert.equal(b.trades[0].pnl, -5);
});

test('a filled take-profit cancels the stop-loss', () => {
  const b = makeBroker();
  b.submitEntry({ side: 'buy', size: 1, stopLoss: 95, takeProfit: 110 });
  b.processBar(bar(0, { open: 100, high: 101, low: 99, close: 100 }));
  b.processBar(bar(1, { open: 101, high: 112, low: 100, close: 111 }));

  assert.equal(b.isFlat, true);
  assert.equal(b.pending.length, 0);
  assert.equal(b.trades[0].exitTag, 'take-profit');
  assert.equal(b.trades[0].pnl, 10);
});

/* ─── The intrabar question ─────────────────────────────────────────────── */

test('without finer data, the bar that touches both levels resolves against the trade', () => {
  // Long with stop 95 and target 110; the bar reaches both. Nothing in OHLC
  // says which came first, so the loss is assumed.
  const b = makeBroker();
  b.submitEntry({ side: 'buy', size: 1, stopLoss: 95, takeProfit: 110 });
  b.processBar(bar(0, { open: 100, high: 100, low: 100, close: 100 }));

  b.processBar(bar(1, { open: 100, high: 112, low: 94, close: 105 }));

  assert.equal(b.trades.length, 1);
  assert.equal(b.trades[0].exitTag, 'stop-loss', 'the pessimistic outcome is taken');
  assert.equal(b.fills.at(-1).resolution, 'pessimistic');
});

test('with 1m sub-bars, the level actually reached first wins', () => {
  const b = makeBroker();
  b.submitEntry({ side: 'buy', size: 1, stopLoss: 95, takeProfit: 110 });
  b.processBar(bar(0, { open: 100, high: 100, low: 100, close: 100 }));

  // Same ambiguous hour — but the minutes show the target came first.
  const hour = bar(1, { open: 100, high: 112, low: 94, close: 105 });
  const minutes = [
    { time: T0 + MIN, open: 100, high: 103, low: 100, close: 103, volume: 1 },
    { time: T0 + 2 * MIN, open: 103, high: 112, low: 103, close: 111, volume: 1 }, // target
    { time: T0 + 3 * MIN, open: 111, high: 111, low: 94, close: 105, volume: 1 },  // stop
  ];
  b.processBar(hour, minutes);

  assert.equal(b.trades.length, 1);
  assert.equal(b.trades[0].exitTag, 'take-profit', 'the minutes settle it');
  assert.equal(b.trades[0].pnl, 10);
  assert.equal(b.fills.at(-1).resolution, 'intrabar');
  assert.equal(b.pending.length, 0, 'the stop was cancelled, not left behind');
});

test('sub-bars can also confirm the loss came first', () => {
  const b = makeBroker();
  b.submitEntry({ side: 'buy', size: 1, stopLoss: 95, takeProfit: 110 });
  b.processBar(bar(0, { open: 100, high: 100, low: 100, close: 100 }));

  const minutes = [
    { time: T0 + MIN, open: 100, high: 100, low: 94, close: 95, volume: 1 },      // stop
    { time: T0 + 2 * MIN, open: 95, high: 112, low: 95, close: 111, volume: 1 },  // target
  ];
  b.processBar(bar(1, { open: 100, high: 112, low: 94, close: 111 }), minutes);

  assert.equal(b.trades[0].exitTag, 'stop-loss');
  assert.equal(b.trades[0].pnl, -5);
});

/* ─── Costs ─────────────────────────────────────────────────────────────── */

test('spread, slippage and commission are all charged', () => {
  const b = new Broker({
    balance: 10_000,
    costs: { feeRate: 0.001, spreadPct: 0.002, slippagePct: 0.001 },
  });
  b.placeOrder({ side: 'buy', size: 1, type: 'market' });
  b.processBar(bar(0, { open: 100, high: 100, low: 100, close: 100 }));

  // half spread 0.1% + slippage 0.1% → 100 × 1.002
  const expectedPrice = 100 * 1.002;
  assert.ok(Math.abs(b.fills[0].price - expectedPrice) < 1e-9, `got ${b.fills[0].price}`);
  assert.ok(Math.abs(b.fills[0].fee - expectedPrice * 0.001) < 1e-9);
  assert.ok(b.balance < 10_000, 'the fee left the account immediately');
});

test('a limit fill pays the spread but not slippage', () => {
  const b = new Broker({
    balance: 10_000,
    costs: { feeRate: 0, spreadPct: 0.002, slippagePct: 0.05 },
  });
  b.placeOrder({ side: 'buy', size: 1, type: 'limit', limitPrice: 100 });
  b.processBar(bar(0, { open: 101, high: 101, low: 99, close: 100 }));

  // Resting orders are not the ones crossing the spread aggressively.
  assert.ok(Math.abs(b.fills[0].price - 100 * 1.001) < 1e-9, `got ${b.fills[0].price}`);
});

test('a full round trip with costs loses money on an unchanged price', () => {
  const b = new Broker({ balance: 10_000, costs: { feeRate: 0.001, spreadPct: 0.002, slippagePct: 0 } });
  b.placeOrder({ side: 'buy', size: 1, type: 'market' });
  b.processBar(bar(0, { open: 100, high: 100, low: 100, close: 100 }));
  b.closePosition();
  b.processBar(bar(1, { open: 100, high: 100, low: 100, close: 100 }));

  assert.ok(b.balance < 10_000, 'flat price plus costs must be a loss');
  assert.equal(b.trades.length, 1);
  assert.ok(b.trades[0].netPnl < 0);
});

/* ─── Equity and validation ─────────────────────────────────────────────── */

test('equity tracks the open position, balance does not', () => {
  const b = makeBroker();
  b.placeOrder({ side: 'buy', size: 2, type: 'market' });
  b.processBar(bar(0, { open: 100, high: 100, low: 100, close: 100 }));
  b.processBar(bar(1, { open: 100, high: 120, low: 100, close: 115 }));

  assert.equal(b.balance, 10_000, 'nothing realised yet');
  assert.equal(b.unrealizedPnl, 30, '2 units × 15 points');
  assert.equal(b.equity, 10_030);
});

test('bad orders are rejected loudly', () => {
  const b = makeBroker();
  assert.throws(() => b.placeOrder({ side: 'up', size: 1 }), /side must be/);
  assert.throws(() => b.placeOrder({ side: 'buy', size: 0 }), /size must be a positive/);
  assert.throws(() => b.placeOrder({ side: 'buy', size: -1 }), /size must be a positive/);
  assert.throws(() => b.placeOrder({ side: 'buy', size: 1, type: 'limit' }), /needs a limitPrice/);
  assert.throws(() => b.placeOrder({ side: 'buy', size: 1, type: 'stop' }), /needs a stopPrice/);
  assert.throws(() => b.placeOrder({ side: 'buy', size: 1, type: 'oco' }), /unknown order type/);
  assert.throws(() => new Broker({ balance: 0 }), /balance must be positive/);
  assert.throws(() => new Broker({ costs: { feeRate: -1 } }), /feeRate must be/);
});

test('cancelling removes an order from the book', () => {
  const b = makeBroker();
  const o = b.placeOrder({ side: 'buy', size: 1, type: 'limit', limitPrice: 50 });
  assert.equal(b.cancelOrder(o.id), true);
  assert.equal(o.status, 'cancelled');
  assert.equal(b.cancelOrder(o.id), false, 'cancelling twice is not an error, just false');

  b.processBar(bar(0, { open: 40, high: 41, low: 39, close: 40 }));
  assert.equal(b.fills.length, 0, 'a cancelled order does not fill');
});

test('cancelAll can target a single tag', () => {
  const b = makeBroker();
  b.placeOrder({ side: 'buy', size: 1, type: 'limit', limitPrice: 50, tag: 'entry' });
  b.placeOrder({ side: 'buy', size: 1, type: 'limit', limitPrice: 60, tag: 'entry' });
  b.placeOrder({ side: 'sell', size: 1, type: 'limit', limitPrice: 200, tag: 'other' });

  assert.equal(b.cancelAll('entry'), 2);
  assert.equal(b.pending.length, 1);
  assert.equal(b.pending[0].tag, 'other');
});
