/* Turning a drawn position block into an order.
 *
 * The property that separates the two modes: a pending order keeps the *levels*
 * that were drawn, a market order keeps the *shape*. A block drawn an hour ago
 * has an entry the market has left behind, and moving its risk and reward to
 * the current price is the only way it still means anything.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PLAN_MODES, orderFromPlan, sizingEntry, sizingStop,
} from '../shared/engine/plannedTrade.js';

/** A long drawn at 60,000 risking 500 for 1,000. */
const LONG = { entry: 60_000, stop: 59_500, target: 61_000 };
/** The mirror of it. */
const SHORT = { entry: 60_000, stop: 60_500, target: 59_000 };

/* ─── Direction ─────────────────────────────────────────────────────────── */

test('a stop below the entry is a buy, above it a sell', () => {
  assert.equal(orderFromPlan(LONG, { price: 60_000, mode: 'market' }).side, 'buy');
  assert.equal(orderFromPlan(SHORT, { price: 60_000, mode: 'market' }).side, 'sell');
});

test('a stop sitting on the entry is refused, not sized to infinity', () => {
  assert.throws(
    () => orderFromPlan({ entry: 100, stop: 100, target: 110 }, { price: 100, mode: 'market' }),
    /no risk/,
  );
});

test('a target on the same side as the stop is refused', () => {
  /* Draggable into existence, and not a trade in either direction. The drawing
   * still has to render as something; an order does not. */
  assert.throws(
    () => orderFromPlan({ entry: 100, stop: 95, target: 90 }, { price: 100, mode: 'market' }),
    /same side as its stop/,
  );
});

test('a block with no target is a trade with no target, not an error', () => {
  const spec = orderFromPlan({ entry: 100, stop: 95, target: null }, { price: 100, mode: 'market' });
  assert.equal(spec.reward, null);
  assert.equal(spec.bracket.targetDistance, undefined);
  assert.equal(spec.bracket.stopDistance, 5);
});

/* ─── Market ────────────────────────────────────────────────────────────── */

test('a market order carries the drawn distances, not the drawn levels', () => {
  /* The whole point: the block was drawn at 60,000 and the market is at
   * 58,000. What survives is risk 500 and reward 1,000. */
  const spec = orderFromPlan(LONG, { price: 58_000, mode: 'market' });

  assert.equal(spec.type, 'market');
  assert.equal(spec.price, null, 'a market order has no level to wait at');
  assert.equal(spec.bracket.stopDistance, 500);
  assert.equal(spec.bracket.targetDistance, 1000);
  assert.equal(spec.bracket.stopLoss, undefined, 'levels are resolved at the fill');
  assert.equal(spec.bracket.takeProfit, undefined);
});

test('the distances do not move when the market does', () => {
  const near = orderFromPlan(LONG, { price: 60_010, mode: 'market' });
  const far = orderFromPlan(LONG, { price: 12_345, mode: 'market' });
  assert.deepEqual(near.bracket, far.bracket);
});

test('a short keeps the same distances as its mirror image', () => {
  const long = orderFromPlan(LONG, { price: 58_000, mode: 'market' });
  const short = orderFromPlan(SHORT, { price: 58_000, mode: 'market' });
  assert.deepEqual(long.bracket, short.bracket);
  assert.notEqual(long.side, short.side);
});

/* ─── Pending ───────────────────────────────────────────────────────────── */

test('a pending order waits at the drawn entry with the drawn levels', () => {
  const spec = orderFromPlan(LONG, { price: 61_500, mode: 'pending' });
  assert.equal(spec.price, 60_000);
  assert.equal(spec.bracket.stopLoss, 59_500);
  assert.equal(spec.bracket.takeProfit, 61_000);
  assert.equal(spec.bracket.stopDistance, undefined, 'a waiting order knows its levels');
});

test('buying below the market is a limit, buying above it a stop', () => {
  assert.equal(orderFromPlan(LONG, { price: 61_500, mode: 'pending' }).type, 'limit');
  assert.equal(orderFromPlan(LONG, { price: 58_000, mode: 'pending' }).type, 'stop');
});

test('selling above the market is a limit, selling below it a stop', () => {
  assert.equal(orderFromPlan(SHORT, { price: 58_000, mode: 'pending' }).type, 'limit');
  assert.equal(orderFromPlan(SHORT, { price: 61_500, mode: 'pending' }).type, 'stop');
});

test('an entry exactly at the market is a limit, which fills on the next touch', () => {
  assert.equal(orderFromPlan(LONG, { price: 60_000, mode: 'pending' }).type, 'limit');
  assert.equal(orderFromPlan(SHORT, { price: 60_000, mode: 'pending' }).type, 'limit');
});

/* ─── Refusals ──────────────────────────────────────────────────────────── */

test('an unknown mode is refused rather than treated as one of the two', () => {
  assert.throws(() => orderFromPlan(LONG, { price: 100, mode: 'oco' }), /unknown mode/);
});

test('every mode the module claims to know actually works', () => {
  for (const mode of PLAN_MODES) {
    assert.ok(orderFromPlan(LONG, { price: 60_000, mode }).side);
  }
});

test('no current price means nothing to place the order against', () => {
  assert.throws(() => orderFromPlan(LONG, { price: null, mode: 'market' }), /no current price/);
  assert.throws(() => orderFromPlan(LONG, { price: 0, mode: 'pending' }), /no current price/);
});

test('a block missing an anchor is refused', () => {
  assert.throws(() => orderFromPlan(null, { price: 100, mode: 'market' }), /entry and a stop/);
  assert.throws(
    () => orderFromPlan({ entry: 100 }, { price: 100, mode: 'market' }),
    /entry and a stop/,
  );
});

/* ─── Sizing ────────────────────────────────────────────────────────────── */

test('a resting order is sized against the level it will fill at', () => {
  const spec = orderFromPlan(LONG, { price: 58_000, mode: 'pending' });
  const entry = sizingEntry(spec, 58_000);
  assert.equal(entry, 60_000, 'not the current price — it waits at its own level');
  assert.equal(sizingStop(spec, entry), 59_500);
});

test('a market order is sized against the last close and its own distance', () => {
  const spec = orderFromPlan(LONG, { price: 58_000, mode: 'market' });
  const entry = sizingEntry(spec, 58_000);
  assert.equal(entry, 58_000);
  assert.equal(sizingStop(spec, entry), 57_500, 'the drawn risk, moved to now');
});

test('the distance a size is worked out from is the drawn one, either way', () => {
  /* Sizing only ever divides by entry − stop, so both modes have to produce
   * the same 500 the block was drawn with — otherwise the same plan would risk
   * two different amounts depending on which menu item was clicked. */
  for (const mode of PLAN_MODES) {
    const spec = orderFromPlan(LONG, { price: 58_000, mode });
    const entry = sizingEntry(spec, 58_000);
    assert.equal(Math.abs(entry - sizingStop(spec, entry)), 500, mode);
  }
});

test('a short sizes against a stop above its entry', () => {
  const spec = orderFromPlan(SHORT, { price: 58_000, mode: 'market' });
  const entry = sizingEntry(spec, 58_000);
  assert.equal(sizingStop(spec, entry), 58_500);
});
