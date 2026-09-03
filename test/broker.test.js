import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { Broker, resetOrderIds } from '../shared/engine/broker.js';

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

/* ─── The one way out of it ─────────────────────────────────────────────── *
 *
 * `fillNow` is what a person clicking Buy in a replay goes through. Only a
 * market order can, only a caller holding it can ask, and it costs what every
 * other market fill costs — the moment and the price are all that differ.
 */

test('a market order can be pushed through at the last price', () => {
  const b = makeBroker();
  b.processBar(bar(0, { open: 100, high: 105, low: 95, close: 102 }));
  const order = b.fillNow(b.placeOrder({ side: 'buy', size: 1, type: 'market' }));

  assert.equal(order.status, 'filled');
  assert.equal(b.fills[0].price, 102, 'the close it was sent at, not a bar that has not happened');
  assert.equal(b.fills[0].resolution, 'immediate', 'no bar decided this one');
  assert.equal(b.position.size, 1);
});

test('pushing one through still pays the spread, the slippage and the fee', () => {
  const b = makeBroker({ feeRate: 0.001, spreadPct: 0.0002, slippagePct: 0.0002 });
  b.processBar(bar(0, { open: 100, high: 105, low: 95, close: 100 }));
  b.fillNow(b.placeOrder({ side: 'buy', size: 1, type: 'market' }));

  assert.equal(b.fills[0].price, 100 * (1 + 0.0001 + 0.0002));
  assert.ok(b.fills[0].fee > 0);
});

test('only a pending market order can be pushed through', () => {
  const b = makeBroker();
  b.processBar(bar(0, { open: 100, high: 105, low: 95, close: 102 }));

  const resting = b.placeOrder({ side: 'buy', size: 1, type: 'limit', limitPrice: 98 });
  assert.throws(() => b.fillNow(resting), /only a market order/);

  const order = b.fillNow(b.placeOrder({ side: 'buy', size: 1, type: 'market' }));
  assert.throws(() => b.fillNow(order), /already filled/);
});

test('with no price seen yet there is nothing to fill against, and it says so', () => {
  const b = makeBroker();
  const order = b.placeOrder({ side: 'buy', size: 1, type: 'market' });
  assert.throws(() => b.fillNow(order), /no price yet/);
});

test('protection attached to an entry pushed through waits for the next bar', () => {
  const b = makeBroker();
  b.processBar(bar(0, { open: 100, high: 105, low: 95, close: 100 }));
  b.fillNow(b.placeOrder({
    side: 'buy', size: 1, type: 'market', bracket: { stopDistance: 2 },
  }));

  assert.equal(b.position.stopLoss, 98, 'measured from the fill');
  assert.equal(b.pending.length, 1, 'and resting, not filled by the bar that has closed');

  b.processBar(bar(1, { open: 100, high: 101, low: 97, close: 99 }));
  assert.equal(b.isFlat, true, 'the next bar reached it');
  assert.equal(b.trades[0].exitTag, 'stop-loss');
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

/* ─── Brackets attached on fill ─────────────────────────────────────────── */

/* A resting entry cannot carry its stop and target as live orders: they would
 * be two orders in the market against a position that does not exist, and the
 * first bar to trade through either of them would open a trade the wrong way
 * round or cancel the protection before the entry ever arrived. So the levels
 * ride along on the order and become orders at the fill. */

test('a bracket is not in the market while its entry is still waiting', () => {
  const b = makeBroker();
  b.placeOrder({
    side: 'buy', size: 1, type: 'limit', limitPrice: 98,
    bracket: { stopLoss: 95, takeProfit: 105 },
  });

  assert.equal(b.pending.length, 1, 'the entry alone');
  b.processBar(bar(0, { open: 100, high: 106, low: 99, close: 100 }));
  assert.equal(b.fills.length, 0, 'the entry never filled');
  assert.equal(b.pending.length, 1, 'and no stop or target appeared without it');
});

test('the stop and target appear the moment the entry fills', () => {
  const b = makeBroker();
  b.placeOrder({
    side: 'buy', size: 1, type: 'limit', limitPrice: 98,
    bracket: { stopLoss: 95, takeProfit: 105 },
  });

  b.processBar(bar(0, { open: 100, high: 101, low: 97, close: 99 }));

  assert.equal(b.position.size, 1);
  const tags = b.pending.map((o) => o.tag).sort();
  assert.deepEqual(tags, ['stop-loss', 'take-profit']);
  assert.equal(b.position.stopLoss, 95, 'the position carries them for the closed trade');
  assert.equal(b.position.takeProfit, 105);
});

test('a bracket cannot fill on the step that placed it', () => {
  /* The same one-step rule every order here is subject to: the bar that filled
   * the entry also ran to 95, but the stop did not exist while it did. */
  const b = makeBroker();
  b.placeOrder({
    side: 'buy', size: 1, type: 'limit', limitPrice: 98,
    bracket: { stopLoss: 95, takeProfit: 105 },
  });

  b.processBar(bar(0, { open: 100, high: 101, low: 94, close: 96 }));
  assert.equal(b.trades.length, 0, 'nothing closed on the bar the entry arrived on');
  assert.equal(b.position.size, 1);

  b.processBar(bar(1, { open: 96, high: 97, low: 94, close: 95 }));
  assert.equal(b.trades.length, 1, 'and it is live from the next bar');
  assert.equal(b.trades[0].exitTag, 'stop-loss');
});

test('with minutes the bracket arms inside the same bar', () => {
  /* The minute the entry fills on is one step; the next minute is another, so
   * protection is live for the rest of the hour rather than only from the next
   * one. That is the whole difference between this and guessing. */
  const b = makeBroker();
  b.placeOrder({
    side: 'buy', size: 1, type: 'limit', limitPrice: 98,
    bracket: { stopLoss: 95, takeProfit: 105 },
  });

  b.processBar(bar(0, { open: 100, high: 101, low: 94, close: 96 }), [
    bar(0, { open: 100, high: 100, low: 97, close: 98 }),   // entry fills here
    bar(0, { open: 98, high: 98, low: 94, close: 95 }),     // stop taken here
  ]);

  assert.equal(b.trades.length, 1);
  assert.equal(b.trades[0].exitTag, 'stop-loss');
});

test('a distance bracket is measured from the price it actually filled at', () => {
  /* The reason distances exist: the plan said "risk 5", and a gap on the way in
   * must not turn that into 3 or 8. */
  const b = makeBroker();
  b.placeOrder({
    side: 'buy', size: 1, type: 'market',
    bracket: { stopDistance: 5, targetDistance: 10 },
  });

  b.processBar(bar(0, { open: 93, high: 94, low: 92, close: 93 }));

  assert.equal(b.fills[0].price, 93, 'gapped well below where the plan was drawn');
  assert.equal(b.position.stopLoss, 88, '93 − 5, not the level of some earlier plan');
  assert.equal(b.position.takeProfit, 103);
});

test('costs are inside the fill the distances are measured from', () => {
  /* So the risk is what the account actually stands to lose, not what it would
   * have lost at a price nobody got. */
  const b = new Broker({ balance: 10_000, costs: { feeRate: 0, spreadPct: 0.001, slippagePct: 0 } });
  b.placeOrder({ side: 'buy', size: 1, type: 'market', bracket: { stopDistance: 5 } });
  b.processBar(bar(0, { open: 100, high: 101, low: 99, close: 100 }));

  const paid = b.fills[0].price;
  assert.ok(paid > 100, 'half the spread was paid');
  assert.equal(b.position.stopLoss, paid - 5);
});

test('a short brackets the other way round', () => {
  const b = makeBroker();
  b.placeOrder({
    side: 'sell', size: 1, type: 'market',
    bracket: { stopDistance: 5, targetDistance: 10 },
  });
  b.processBar(bar(0, { open: 100, high: 101, low: 99, close: 100 }));

  assert.equal(b.position.size, -1);
  assert.equal(b.position.stopLoss, 105, 'above, where a short is wrong');
  assert.equal(b.position.takeProfit, 90);
});

test('an attached leg that fills retires its sibling', () => {
  const b = makeBroker();
  b.placeOrder({
    side: 'buy', size: 1, type: 'market',
    bracket: { stopLoss: 95, takeProfit: 105 },
  });
  b.processBar(bar(0, { open: 100, high: 100, low: 100, close: 100 }));
  assert.equal(b.pending.length, 2);

  b.processBar(bar(1, { open: 100, high: 106, low: 100, close: 105 }));
  assert.equal(b.trades[0].exitTag, 'take-profit');
  assert.equal(b.pending.length, 0, 'the stop did not stay behind');
});

test('a bracket on a fill that opened nothing is simply not attached', () => {
  const b = makeBroker();
  // reduceOnly with no position: the order cancels itself, and nothing follows.
  b.placeOrder({
    side: 'sell', size: 1, type: 'market', reduceOnly: true,
    bracket: { stopLoss: 105 },
  });
  b.processBar(bar(0, { open: 100, high: 101, low: 99, close: 100 }));

  assert.equal(b.pending.length, 0);
  assert.equal(b.fills.length, 0);
});

test('a leg given as both a level and an offset is refused', () => {
  const b = makeBroker();
  assert.throws(
    () => b.placeOrder({
      side: 'buy', size: 1, type: 'market',
      bracket: { stopLoss: 95, stopDistance: 5 },
    }),
    /not both/,
  );
});

test('a bracket distance that is not a distance is refused', () => {
  const b = makeBroker();
  assert.throws(
    () => b.placeOrder({ side: 'buy', size: 1, type: 'market', bracket: { stopDistance: 0 } }),
    /stopDistance must be a positive number/,
  );
  assert.throws(
    () => b.placeOrder({ side: 'buy', size: 1, type: 'market', bracket: { targetDistance: -3 } }),
    /targetDistance must be a positive number/,
  );
  assert.throws(
    () => b.placeOrder({ side: 'buy', size: 1, type: 'market', bracket: { stopLoss: NaN } }),
    /stopLoss must be a finite number/,
  );
});

test('an order without a bracket is unchanged by any of this', () => {
  const b = makeBroker();
  const o = b.placeOrder({ side: 'buy', size: 1, type: 'market' });
  assert.equal(o.bracket, null);
  b.processBar(bar(0, { open: 100, high: 101, low: 99, close: 100 }));
  assert.equal(b.pending.length, 0, 'nothing was attached');
  assert.equal(b.position.stopLoss, null);
});

/* ─── Managing what is open ─────────────────────────────────────────────── *
 *
 * Half off at the first target, the stop to break-even, the rest trailed —
 * that is most of what trading a position consists of, and none of it was
 * reachable when the only two states were all-in and flat.
 */

test('a partial close books the part that went and leaves the rest open', () => {
  const b = makeBroker();
  b.processBar(bar(0, { open: 100, high: 105, low: 95, close: 100 }));
  b.fillNow(b.placeOrder({ side: 'buy', size: 4, type: 'market' }));

  b.processBar(bar(1, { open: 110, high: 112, low: 108, close: 110 }));
  b.fillNow(b.closePosition('scale-out', { size: 3 }));

  assert.equal(b.trades.length, 1);
  assert.equal(b.trades[0].size, 3);
  assert.equal(b.trades[0].pnl, 30, '(110 − 100) × 3');
  assert.equal(b.position.size, 1, 'the runner stays');
  assert.equal(b.position.entryPrice, 100, 'at the entry it was opened at');
});

test('closing more than is open closes what is there, not more', () => {
  const b = makeBroker();
  b.processBar(bar(0, { open: 100, high: 105, low: 95, close: 100 }));
  b.fillNow(b.placeOrder({ side: 'buy', size: 1, type: 'market' }));

  b.processBar(bar(1, { open: 110, high: 112, low: 108, close: 110 }));
  b.fillNow(b.closePosition('close', { size: 99 }));

  assert.equal(b.isFlat, true);
  assert.equal(b.trades[0].size, 1);
});

test('a partial close cuts the protection down to what is left', () => {
  const b = makeBroker();
  b.processBar(bar(0, { open: 100, high: 105, low: 95, close: 100 }));
  b.fillNow(b.submitEntry({ side: 'buy', size: 4, stopLoss: 95, takeProfit: 120 }));

  b.processBar(bar(1, { open: 110, high: 112, low: 108, close: 110 }));
  b.fillNow(b.closePosition('scale-out', { size: 3 }));

  const stop = b.pending.find((o) => o.tag === 'stop-loss');
  assert.equal(stop.size, 1, 'a stop for four when one is open would be a lie');
});

test('a stop is moved rather than cancelled and replaced', () => {
  const b = makeBroker();
  b.processBar(bar(0, { open: 100, high: 105, low: 95, close: 100 }));
  b.fillNow(b.submitEntry({ side: 'buy', size: 1, stopLoss: 95 }));

  const before = b.pending.find((o) => o.tag === 'stop-loss');
  b.protect(b.position, { stopLoss: 98 });
  const after = b.pending.find((o) => o.tag === 'stop-loss');

  assert.equal(after.id, before.id, 'the same order, amended');
  assert.equal(after.stopPrice, 98);
  assert.equal(b.position.stopLoss, 98);
  assert.equal(b.pending.filter((o) => o.tag === 'stop-loss').length, 1);
});

test('protect with null takes the leg off', () => {
  const b = makeBroker();
  b.processBar(bar(0, { open: 100, high: 105, low: 95, close: 100 }));
  b.fillNow(b.submitEntry({ side: 'buy', size: 1, stopLoss: 95, takeProfit: 110 }));

  b.protect(b.position, { takeProfit: null });
  assert.equal(b.pending.filter((o) => o.tag === 'take-profit').length, 0);
  assert.equal(b.position.takeProfit, null);
  assert.equal(b.pending.filter((o) => o.tag === 'stop-loss').length, 1, 'the stop is untouched');
});

test('modifyOrder moves a resting entry and refuses to grow it', () => {
  const b = makeBroker();
  b.processBar(bar(0, { open: 100, high: 105, low: 95, close: 100 }));
  const order = b.placeOrder({ side: 'buy', size: 1, type: 'limit', limitPrice: 90 });

  b.modifyOrder(order.id, { limitPrice: 92, size: 0.5 });
  assert.equal(order.limitPrice, 92);
  assert.equal(order.size, 0.5);

  assert.throws(() => b.modifyOrder(order.id, { size: 2 }), /cut down but not grown/);
  assert.throws(() => b.modifyOrder(order.id, { stopPrice: 95 }), /has no stop price/);
  b.cancelOrder(order.id);
  assert.throws(() => b.modifyOrder(order.id, { limitPrice: 91 }), /no pending order/);
});

const COSTLY = { feeRate: 0.001, spreadPct: 0.0002, slippagePct: 0.0002 };

test('break-even sits past the entry by what getting out costs', () => {
  const b = makeBroker(COSTLY);
  b.processBar(bar(0, { open: 100, high: 105, low: 95, close: 100 }));
  b.fillNow(b.placeOrder({ side: 'buy', size: 1, type: 'market' }));
  b.processBar(bar(1, { open: 100, high: 102, low: 100, close: 101 }));

  b.breakEven(b.position);
  assert.ok(b.position.stopLoss > b.position.entryPrice, 'the entry itself is a small loss');
});

test('a short break-even sits below the entry', () => {
  const b = makeBroker(COSTLY);
  b.processBar(bar(0, { open: 100, high: 105, low: 95, close: 100 }));
  b.fillNow(b.placeOrder({ side: 'sell', size: 1, type: 'market' }));
  b.processBar(bar(1, { open: 100, high: 100, low: 98, close: 99 }));

  b.breakEven(b.position);
  assert.ok(b.position.stopLoss < b.position.entryPrice);
});

/* The number the whole feature is named after. An estimate that charges the
 * exit fee on the entry price instead of on the level it is placing lands a
 * fraction of a fee out — which happens to be the same size as the answer. */
test('a stop at break-even comes out at exactly nothing', () => {
  for (const side of ['buy', 'sell']) {
    const b = makeBroker(COSTLY);
    b.processBar(bar(0, { open: 100, high: 105, low: 95, close: 100 }));
    b.fillNow(b.placeOrder({ side, size: 3, type: 'market' }));

    const p = b.position;
    assert.ok(Math.abs(b.exitResult(p, b.breakEvenPrice(p))) < 1e-9, side);
  }
});

/* What a stop and a target are worth is one function, and it has to agree with
 * the fill the order would actually get — spread and slippage on a stop, half
 * the spread alone on a resting target. */
test('what a level is worth is what closing there really pays', () => {
  const b = makeBroker(COSTLY);
  b.processBar(bar(0, { open: 100, high: 105, low: 95, close: 100 }));
  b.fillNow(b.placeOrder({ side: 'buy', size: 2, type: 'market' }));
  const p = b.position;

  const expected = b.exitResult(p, 110, { takesLiquidity: true });
  assert.ok(
    b.exitResult(p, 110, { takesLiquidity: false }) > expected,
    'a resting exit pays no slippage, so the same level is worth more',
  );

  b.protect(p, { stopLoss: 110 });
  b.processBar(bar(1, { open: 110, high: 110, low: 110, close: 110 }));

  const [trade] = b.trades;
  assert.equal(trade.netPnl.toFixed(8), expected.toFixed(8));
});

test('break-even is refused while the trade is not far enough in front', () => {
  const b = makeBroker(COSTLY);
  b.processBar(bar(0, { open: 100, high: 105, low: 95, close: 100 }));
  b.fillNow(b.placeOrder({ side: 'buy', size: 1, type: 'market' }));

  /* The level is above the market here, and a sell stop above the market is
   * marketable: it would close the trade on the next open, for a loss. */
  assert.ok(b.breakEvenRefusal(b.position), 'and it says why');
  assert.throws(() => b.breakEven(b.position), /not far enough in front/);
  assert.equal(b.position.stopLoss, null, 'nothing was moved');

  b.processBar(bar(1, { open: 100, high: 102, low: 100, close: 101 }));
  assert.equal(b.breakEvenRefusal(b.position), null);
  b.breakEven(b.position);
  assert.ok(b.position.stopLoss < b.lastPrice, 'and lands behind the market, as a stop does');
});

/* ─── Trailing ──────────────────────────────────────────────────────────── */

test('a trailing stop follows the high and never gives ground back', () => {
  const b = makeBroker();
  b.processBar(bar(0, { open: 100, high: 100, low: 100, close: 100 }));
  b.fillNow(b.placeOrder({ side: 'buy', size: 1, type: 'market' }));
  b.setTrailing(b.position, 5);

  b.processBar(bar(1, { open: 101, high: 110, low: 100, close: 108 }));
  assert.equal(b.position.stopLoss, 105, '110 − 5');

  b.processBar(bar(2, { open: 108, high: 109, low: 106, close: 107 }));
  assert.equal(b.position.stopLoss, 105, 'a lower high does not lower the stop');

  b.processBar(bar(3, { open: 107, high: 120, low: 107, close: 119 }));
  assert.equal(b.position.stopLoss, 115);
});

test('the trail moves after the fills of its bar, not before', () => {
  const b = makeBroker();
  b.processBar(bar(0, { open: 100, high: 100, low: 100, close: 100 }));
  b.fillNow(b.placeOrder({ side: 'buy', size: 1, type: 'market' }));
  b.setTrailing(b.position, 5);

  // The first bar arms the stop at 105.
  b.processBar(bar(1, { open: 101, high: 110, low: 100, close: 108 }));
  assert.equal(b.position.stopLoss, 105);

  /* This bar makes a new high *and* trades through the standing stop. Trailing
   * first would lift the stop to 115 and the trade would survive a bar that
   * went through it. */
  b.processBar(bar(2, { open: 108, high: 120, low: 104, close: 118 }));
  assert.equal(b.isFlat, true, 'the stop that was in the market got hit');
  assert.equal(b.trades[0].exitTag, 'stop-loss');
  assert.equal(b.trades[0].exitPrice, 105);
});

test('a trail can wait for a level before it starts following', () => {
  const b = makeBroker();
  b.processBar(bar(0, { open: 100, high: 100, low: 100, close: 100 }));
  b.fillNow(b.submitEntry({ side: 'buy', size: 1, stopLoss: 95 }));
  b.setTrailing(b.position, 5, { activateAt: 110 });

  b.processBar(bar(1, { open: 101, high: 108, low: 100, close: 107 }));
  assert.equal(b.position.stopLoss, 95, 'not there yet, so the original stop stands');

  b.processBar(bar(2, { open: 107, high: 112, low: 106, close: 111 }));
  assert.equal(b.position.stopLoss, 107, '112 − 5');
});

test('a short trails down from the low, and switching it off leaves the stop', () => {
  const b = makeBroker();
  b.processBar(bar(0, { open: 100, high: 100, low: 100, close: 100 }));
  b.fillNow(b.placeOrder({ side: 'sell', size: 1, type: 'market' }));
  b.setTrailing(b.position, 5);

  b.processBar(bar(1, { open: 99, high: 100, low: 90, close: 92 }));
  assert.equal(b.position.stopLoss, 95, '90 + 5');

  b.setTrailing(b.position, null);
  b.processBar(bar(2, { open: 92, high: 93, low: 88, close: 89 }));
  assert.equal(b.position.stopLoss, 95, 'switched off, so it stays where it was');
});

/* ─── Two positions at once ─────────────────────────────────────────────── *
 *
 * Hedging mode is for the person, not for the strategies: a second entry is a
 * second idea, and averaging it into the first destroys the only thing worth
 * knowing afterwards — whether each of them was right.
 */

function hedged(costs = { feeRate: 0, spreadPct: 0, slippagePct: 0 }) {
  return new Broker({ balance: 10_000, costs, mode: 'hedging' });
}

test('a second entry stands beside the first instead of averaging into it', () => {
  const b = hedged();
  b.processBar(bar(0, { open: 100, high: 100, low: 100, close: 100 }));
  b.fillNow(b.placeOrder({ side: 'buy', size: 1, type: 'market' }));

  b.processBar(bar(1, { open: 120, high: 120, low: 120, close: 120 }));
  b.fillNow(b.placeOrder({ side: 'buy', size: 1, type: 'market' }));

  assert.equal(b.positions.length, 2);
  assert.deepEqual(b.positions.map((p) => p.entryPrice), [100, 120]);
  assert.equal(b.netSize, 2);
  assert.equal(b.unrealizedPnl, 20, '(120−100) + (120−120)');
});

test('long and short can be open at the same time', () => {
  const b = hedged();
  b.processBar(bar(0, { open: 100, high: 100, low: 100, close: 100 }));
  b.fillNow(b.placeOrder({ side: 'buy', size: 1, type: 'market' }));
  b.fillNow(b.placeOrder({ side: 'sell', size: 1, type: 'market' }));

  assert.equal(b.positions.length, 2, 'the sell did not close the long');
  assert.equal(b.netSize, 0);
  assert.equal(b.trades.length, 0, 'nothing has been closed');
});

test('each position keeps its own stop, and one being hit leaves the other', () => {
  const b = hedged();
  b.processBar(bar(0, { open: 100, high: 100, low: 100, close: 100 }));
  b.fillNow(b.submitEntry({ side: 'buy', size: 1, stopLoss: 95 }));
  b.fillNow(b.submitEntry({ side: 'buy', size: 1, stopLoss: 90 }));

  b.processBar(bar(1, { open: 99, high: 100, low: 93, close: 97 }));

  assert.equal(b.positions.length, 1, 'only the tighter stop was reached');
  assert.equal(b.positions[0].stopLoss, 90);
  assert.equal(b.trades.length, 1);
  assert.equal(b.trades[0].exitPrice, 95);
});

test('closing one position by id leaves the others alone', () => {
  const b = hedged();
  b.processBar(bar(0, { open: 100, high: 100, low: 100, close: 100 }));
  b.fillNow(b.placeOrder({ side: 'buy', size: 1, type: 'market' }));
  b.fillNow(b.placeOrder({ side: 'buy', size: 2, type: 'market' }));
  const [first, second] = b.positions;

  b.processBar(bar(1, { open: 110, high: 110, low: 110, close: 110 }));
  b.fillNow(b.closePosition('manual', { positionId: second.id }));

  assert.equal(b.positions.length, 1);
  assert.equal(b.positions[0].id, first.id);
  assert.equal(b.trades[0].size, 2);
});

test('flatten closes everything that is open', () => {
  const b = hedged();
  b.processBar(bar(0, { open: 100, high: 100, low: 100, close: 100 }));
  b.fillNow(b.placeOrder({ side: 'buy', size: 1, type: 'market' }));
  b.fillNow(b.placeOrder({ side: 'sell', size: 1, type: 'market' }));

  b.processBar(bar(1, { open: 110, high: 110, low: 110, close: 110 }));
  for (const order of b.flatten()) b.fillNow(order);

  assert.equal(b.isFlat, true);
  assert.equal(b.trades.length, 2);
});

test('an unnamed reduce-only order takes the oldest position facing the other way', () => {
  const b = hedged();
  b.processBar(bar(0, { open: 100, high: 100, low: 100, close: 100 }));
  b.fillNow(b.placeOrder({ side: 'buy', size: 1, type: 'market' }));
  b.processBar(bar(1, { open: 120, high: 120, low: 120, close: 120 }));
  b.fillNow(b.placeOrder({ side: 'buy', size: 1, type: 'market' }));

  b.fillNow(b.placeOrder({ side: 'sell', size: 1, type: 'market', reduceOnly: true }));

  assert.equal(b.positions.length, 1);
  assert.equal(b.positions[0].entryPrice, 120, 'first in, first out');
  assert.equal(b.trades[0].entryPrice, 100);
});

test('a bracket sibling whose position is gone cancels instead of hitting another', () => {
  const b = hedged();
  b.processBar(bar(0, { open: 100, high: 100, low: 100, close: 100 }));
  b.fillNow(b.submitEntry({ side: 'buy', size: 1, stopLoss: 95, takeProfit: 110 }));
  b.fillNow(b.placeOrder({ side: 'buy', size: 1, type: 'market' }));

  // The first position's target fills; its stop must not touch the second.
  b.processBar(bar(1, { open: 111, high: 112, low: 109, close: 111 }));

  assert.equal(b.trades.length, 1);
  assert.equal(b.positions.length, 1, 'the unprotected second position is still open');
  assert.equal(b.pending.length, 0, 'and the orphaned stop is gone, not resting');
});

test('netting mode is untouched by any of this', () => {
  const b = makeBroker();
  b.processBar(bar(0, { open: 100, high: 100, low: 100, close: 100 }));
  b.fillNow(b.placeOrder({ side: 'buy', size: 1, type: 'market' }));
  b.processBar(bar(1, { open: 120, high: 120, low: 120, close: 120 }));
  b.fillNow(b.placeOrder({ side: 'buy', size: 1, type: 'market' }));

  assert.equal(b.positions.length, 1, 'still one position');
  assert.equal(b.position.entryPrice, 110, 'averaged, as an exchange account does');
});

/* ─── Protection does not outlive what it protected ─────────────────────── */

test('closing a position by hand takes its stop and target out of the book', () => {
  const b = hedged();
  b.processBar(bar(0, { open: 100, high: 100, low: 100, close: 100 }));
  b.fillNow(b.submitEntry({ side: 'buy', size: 1, stopLoss: 95, takeProfit: 110 }));
  assert.equal(b.pending.length, 2);

  b.fillNow(b.closePosition('manual', { positionId: b.positions[0].id }));

  /* They closed nothing once the position was gone — they are reduceOnly — but
   * they sat in the book until price happened to touch one, which put a stop
   * line on the chart under a trade that was over. */
  assert.equal(b.pending.length, 0);
  assert.equal(b.orders.filter((o) => o.status === 'cancelled').length, 2);
});

test('a stop cancelled with its position leaves another position’s alone', () => {
  const b = hedged();
  b.processBar(bar(0, { open: 100, high: 100, low: 100, close: 100 }));
  b.fillNow(b.submitEntry({ side: 'buy', size: 1, stopLoss: 95, tag: 'first' }));
  b.fillNow(b.submitEntry({ side: 'buy', size: 2, stopLoss: 90, tag: 'second' }));
  assert.equal(b.pending.length, 2);

  b.fillNow(b.closePosition('manual', { positionId: b.positions[0].id }));

  assert.equal(b.pending.length, 1);
  assert.equal(b.pending[0].stopPrice, 90, 'the survivor keeps its own');
});

test('a partial close leaves the protection standing', () => {
  const b = hedged();
  b.processBar(bar(0, { open: 100, high: 100, low: 100, close: 100 }));
  b.fillNow(b.submitEntry({ side: 'buy', size: 2, stopLoss: 95, takeProfit: 110 }));

  b.fillNow(b.closePosition('scale-out', { size: 1, positionId: b.positions[0].id }));

  assert.equal(b.positions.length, 1, 'half of it is still open');
  assert.equal(b.pending.length, 2, 'so it is still protected');
  assert.equal(b.pending[0].size, 1, 'and for what is actually left');
});

/* ─── The ruler R is measured with ──────────────────────────────────────── */

test('a position remembers what it risked per unit, once', () => {
  const b = hedged();
  b.processBar(bar(0, { open: 100, high: 100, low: 100, close: 100 }));
  b.fillNow(b.submitEntry({ side: 'buy', size: 2, stopLoss: 96 }));

  const p = b.positions[0];
  assert.equal(p.riskPerUnit, 4);

  b.protect(p, { stopLoss: 98 });
  assert.equal(p.riskPerUnit, 4, 'managing the trade must not move the unit it is judged in');

  b.processBar(bar(1, { open: 100, high: 102, low: 100, close: 101 }));
  b.breakEven(p);
  assert.equal(p.riskPerUnit, 4, 'least of all break-even, which is where it would go to zero');
});

test('a position with no stop has no ruler until it gets one', () => {
  const b = hedged();
  b.processBar(bar(0, { open: 100, high: 100, low: 100, close: 100 }));
  b.fillNow(b.placeOrder({ side: 'buy', size: 1, type: 'market' }));
  assert.equal(b.positions[0].riskPerUnit, null);

  b.protect(b.positions[0], { stopLoss: 94 });
  assert.equal(b.positions[0].riskPerUnit, 6);
});

test('a bracket that arrives with a resting entry sets the ruler when it fills', () => {
  const b = hedged();
  b.processBar(bar(0, { open: 100, high: 100, low: 100, close: 100 }));
  b.placeOrder({
    side: 'buy', size: 1, type: 'limit', limitPrice: 95,
    bracket: { stopLoss: 90, takeProfit: 110 },
  });
  b.processBar(bar(1, { open: 99, high: 99, low: 94, close: 96 }));

  assert.equal(b.positions[0].riskPerUnit, 5);
});

test('a closed trade carries the ruler, not the stop it ended on', () => {
  const b = hedged();
  b.processBar(bar(0, { open: 100, high: 100, low: 100, close: 100 }));
  b.fillNow(b.submitEntry({ side: 'buy', size: 1, stopLoss: 90 }));

  b.processBar(bar(1, { open: 101, high: 101, low: 101, close: 101 }));
  b.breakEven(b.positions[0]);

  b.processBar(bar(2, { open: 110, high: 110, low: 110, close: 110 }));
  b.fillNow(b.closePosition('manual', { positionId: b.positions[0].id }));

  const [trade] = b.trades;
  assert.equal(trade.riskPerUnit, 10);
  assert.equal(trade.stopLoss, 100, 'where the stop was at the end — a different question');
  assert.equal(trade.netPnl / (trade.riskPerUnit * trade.size), 1, 'one R made, not forty');
});
