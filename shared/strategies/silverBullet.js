/* Silver Bullet as a tradable strategy.
 *
 * The detection is not repeated here. `shared/indicators/silverBullet.js`
 * stays the single definition of what a setup is and keeps drawing on the
 * chart; this file declares it as an event source and decides what to do about
 * each setup — which is the whole difference between an indicator and a
 * strategy.
 *
 * Why the fills are worse than the indicator's outcomes
 * -----------------------------------------------------
 * The detector reports an entry on the bar where price *touched* the near edge
 * of the gap. It knows that in hindsight; an order cannot. By the time that
 * bar has closed and the strategy is asked what to do, the touch has already
 * happened and that price is gone.
 *
 * So the strategy sends a market order on the signal bar, and the engine —
 * which never lets an order fill on the bar that created it — fills it against
 * the next one, plus spread, slippage and fee. The entry is therefore a little
 * worse than the detector's, sometimes a lot worse when the next bar gaps
 * away, and the run will not match the indicator's `outcome` fields.
 *
 * That gap between the two numbers is not a defect to reconcile. It is the
 * cost of the setup being knowable only after the fact, and a backtest that
 * hid it would be reporting a price nobody could have got.
 *
 * A resting limit order at the gap edge would fill closer, and it is the more
 * realistic model of how this is actually traded. It is not what this does,
 * because the detector only reports setups that *did* get an entry: asking it
 * on the shift bar would hand the strategy a pre-filtered list of the ones
 * price came back to, which is hindsight wearing a limit order's clothes.
 * Fixing that properly means the detector emitting armed setups before it
 * knows their fate, and that is a change to the indicator, not to this file.
 *
 * Stop and target
 * ---------------
 * The stop is the detector's: just beyond the wick that took the liquidity.
 * That price is a fact about the market and does not move with the fill.
 *
 * The target is recomputed here rather than taken from the detector, because
 * `rrr` is a strategy parameter and has to mean the same thing across every
 * strategy — see RISK_PARAMS. It is measured from the last close the strategy
 * could see, which is the best estimate of the fill available at the moment
 * the order is sent.
 */

import { SILVER_BULLET_PARAMS } from '../indicators/silverBullet.js';
import { RISK_PARAMS, positionSize } from './risk.js';

/* The detector settings a trader would actually reach for, minus the ones that
 * describe a drawing rather than a market. Colours say nothing about whether a
 * setup is worth taking, and `rrr` is a strategy-level parameter, so the
 * shared one governs and the detector's copy is left at its default. */
const DRAWING_ONLY = new Set(['bullColor', 'bearColor', 'rrr']);

const DETECTOR_PARAMS = SILVER_BULLET_PARAMS.filter((p) => !DRAWING_ONLY.has(p.key));

/** The keys handed straight to the detector, so the two cannot drift. */
const DETECTOR_KEYS = DETECTOR_PARAMS.map((p) => p.key);

export const SILVER_BULLET_STRATEGY = {
  id: 'silverbullet',
  name: 'Silver Bullet',
  description: 'Sweep, gap, structure shift and retest, inside one of the three hours. '
    + 'Enters on the signal bar and exits at a fixed reward-to-risk.',
  /** The chart indicator this is built on, so the UI can offer to draw it. */
  indicator: 'silverbullet',
  /* Which parameters change what is detected rather than what is done about
   * it. A sweep reuses one detection across every combination that shares
   * these, so they are what decides how long it takes — see detectionCount. */
  detectorKeys: DETECTOR_KEYS,
  params: [...RISK_PARAMS, ...DETECTOR_PARAMS],

  build(params) {
    const detectorParams = {};
    for (const key of DETECTOR_KEYS) detectorParams[key] = params[key];

    return {
      params,

      /* Declared as an event, not an indicator: a setup is a discrete thing
       * that happens a few dozen times across a year, not a value that exists
       * at every bar. The engine buckets these by the bar that confirmed each
       * one, so nothing arrives early. */
      events: {
        setups: { id: 'silverbullet', params: detectorParams, output: 'setups' },
      },

      onBar(ctx) {
        /* One position at a time. A setup that lands while another is running
         * is skipped rather than queued: two overlapping trades from the same
         * rules make the result impossible to attribute, and the detector
         * already keeps only one setup per window. */
        if (!ctx.isFlat || ctx.pendingOrders.length > 0) return;

        const setups = ctx.events('setups');
        if (setups.length === 0) return;

        // Only ever the first: see above.
        const setup = setups[0];
        const price = ctx.bar.close;
        const stop = setup.stop;

        /* The stop has to be on the losing side of the price the order will
         * fill around. When the signal bar closes past its own stop — price
         * ran through the level after touching the gap — the trade is already
         * wrong before it is open, and there is nothing to enter. */
        const long = setup.direction === 'bull';
        if (long ? stop >= price : stop <= price) return;

        const size = positionSize(
          ctx.equity, price, stop, params.riskMode, params.riskValue, params.maxLeverage,
        );
        if (size == null) return;

        const distance = Math.abs(price - stop);
        const target = long ? price + distance * params.rrr : price - distance * params.rrr;

        const order = { size, stopLoss: stop, takeProfit: target, tag: setup.window };
        if (long) ctx.buy(order);
        else ctx.sell(order);
      },
    };
  },
};
