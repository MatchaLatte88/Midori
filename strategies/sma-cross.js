/* Example strategy: moving-average crossover with an ATR stop.
 *
 * Not advice and not a good system — it exists to exercise the engine end to
 * end and to show the shape a strategy takes.
 *
 * Everything a strategy can see comes through ctx, and none of it reaches past
 * the current bar.
 */

export const params = {
  fastPeriod: 20,
  slowPeriod: 50,
  atrPeriod: 14,
  stopAtr: 2,      // stop distance in ATR multiples
  targetR: 2,      // target at this multiple of the stop distance
  riskPct: 0.01,   // fraction of equity risked per trade
};

export const indicators = {
  fast: { id: 'sma', params: { period: params.fastPeriod } },
  slow: { id: 'sma', params: { period: params.slowPeriod } },
  atr: { id: 'atr', params: { period: params.atrPeriod } },
};

export function onBar(ctx) {
  // One position at a time: a crossover system that pyramids is a different
  // system, and mixing the two makes the result impossible to read.
  if (!ctx.isFlat || ctx.pendingOrders.length > 0) return;

  const fast = ctx.ind('fast');
  const slow = ctx.ind('slow');
  const fastPrev = ctx.ind('fast', 1);
  const slowPrev = ctx.ind('slow', 1);
  const atr = ctx.ind('atr');

  if (fastPrev == null || slowPrev == null || atr == null || atr <= 0) return;

  const crossedUp = fastPrev <= slowPrev && fast > slow;
  const crossedDown = fastPrev >= slowPrev && fast < slow;
  if (!crossedUp && !crossedDown) return;

  const price = ctx.bar.close;
  const stopDistance = atr * params.stopAtr;

  // Size so that being stopped out costs the intended fraction of equity.
  const size = (ctx.equity * params.riskPct) / stopDistance;
  if (!(size > 0)) return;

  if (crossedUp) {
    ctx.buy({
      size,
      stopLoss: price - stopDistance,
      takeProfit: price + stopDistance * params.targetR,
    });
  } else {
    ctx.sell({
      size,
      stopLoss: price + stopDistance,
      takeProfit: price - stopDistance * params.targetR,
    });
  }
}
