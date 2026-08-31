/* Strategies — what an indicator becomes once it has entries, stops and size.
 *
 * The line between the two folders is not about complexity. An indicator
 * describes the market; a strategy commits to a trade. The moment something
 * says "buy here, risk this much, get out there", it stops being a drawing on
 * a chart and becomes a thing that can be right or wrong about money — and
 * that is what belongs in here, because that is what can be backtested.
 *
 * A strategy is allowed to *use* an indicator, and Silver Bullet does: the
 * detector stays in `shared/indicators/`, keeps drawing on the chart, and the
 * strategy declares it as an event source. One definition, two uses. If the
 * strategy re-implemented the detection, the chart and the backtest would
 * eventually disagree about the same market, which is the failure the whole
 * `shared/` folder exists to prevent.
 *
 * Contract
 * --------
 * Every entry in STRATEGIES has a param schema — the same shape the indicator
 * panel already builds fields from — and a `build(params)` that returns what
 * runBacktest takes:
 *
 *   build(params) -> { indicators?, events?, params, init?, onBar, onFinish? }
 *
 * `build` exists because a strategy's parameters have to reach the indicators
 * it declares. A Silver Bullet run with a 0.5% minimum gap has to hand that
 * number to the detector, and a static object cannot.
 *
 * Risk lives here, not in the strategy
 * ------------------------------------
 * Every strategy gets the same two questions, so they are asked once, in
 * RISK_PARAMS, and answered the same way everywhere: how much is at stake on a
 * trade, and where the target sits relative to that. A strategy that invented
 * its own names for these would make two runs impossible to compare, which is
 * the whole point of storing them.
 *
 * Position sizing is derived, never set. You choose the risk; the distance to
 * the stop decides the size, so being stopped out costs what you said it would
 * regardless of how wide the stop happens to be.
 */

import { RISK_MODES, RISK_PARAMS, positionSize } from './risk.js';
import { SILVER_BULLET_STRATEGY } from './silverBullet.js';

/* Re-exported so callers have one import for the whole strategy surface. The
 * definitions live in risk.js because the strategies need them too, and
 * importing them back out of here would be a cycle. */
export { RISK_MODES, RISK_PARAMS, positionSize };

export const STRATEGIES = {
  silverbullet: SILVER_BULLET_STRATEGY,
};

/** Metadata for the UI, without the build functions. */
export function strategyCatalog() {
  return Object.values(STRATEGIES).map(({ build, ...rest }) => rest);
}

/**
 * Validates params against a strategy's schema and returns them merged with
 * the defaults — the same rules computeIndicator applies, for the same reason:
 * a bad value must be refused where it was entered, not silently ignored by
 * whatever reads it later.
 */
export function resolveStrategyParams(id, params = {}) {
  const spec = STRATEGIES[id];
  if (!spec) {
    throw new Error(`Unknown strategy "${id}". Known: ${Object.keys(STRATEGIES).join(', ')}`);
  }

  const merged = {};
  for (const p of spec.params) {
    const given = params[p.key];
    if (given === undefined) {
      merged[p.key] = p.default;
      continue;
    }
    if (p.type === 'number') {
      const n = Number(given);
      if (!Number.isFinite(n)) throw new Error(`${id}.${p.key}: "${given}" is not a number`);
      if (p.min !== undefined && n < p.min) throw new Error(`${id}.${p.key}: ${n} is below ${p.min}`);
      if (p.max !== undefined && n > p.max) throw new Error(`${id}.${p.key}: ${n} is above ${p.max}`);
      merged[p.key] = n;
    } else if (p.type === 'multi') {
      if (!Array.isArray(given)) {
        throw new Error(`${id}.${p.key}: expected a list, got ${typeof given}`);
      }
      for (const v of given) {
        if (!p.options.some((o) => o.value === v)) {
          throw new Error(`${id}.${p.key}: "${v}" is not one of ${p.options.map((o) => o.value).join(', ')}`);
        }
      }
      merged[p.key] = given;
    } else if (p.type === 'select') {
      if (!p.options.some((o) => o.value === given)) {
        throw new Error(`${id}.${p.key}: "${given}" is not one of ${p.options.map((o) => o.value).join(', ')}`);
      }
      merged[p.key] = given;
    } else {
      merged[p.key] = given;
    }
  }
  return merged;
}

/** Builds a runnable strategy from an id and raw params. */
export function buildStrategy(id, params = {}) {
  const spec = STRATEGIES[id];
  if (!spec) {
    throw new Error(`Unknown strategy "${id}". Known: ${Object.keys(STRATEGIES).join(', ')}`);
  }
  return spec.build(resolveStrategyParams(id, params));
}
