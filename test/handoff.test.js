/* What a sweep combination has to carry to be usable as a backtest.
 *
 * The handoff itself — store it, take it once, clear it — is six lines in the
 * session store and is not tested here: that store is browser code that reads
 * the colour-scheme preference and builds Vue reactivity as it loads, so
 * reaching it from Node means standing up a fake DOM. Faking a browser to
 * check six lines of object copying would cost more than it protects.
 *
 * What is worth pinning is the part that fails quietly. `expandSweep` only
 * sets the keys that were swept, so a combination is only a complete set of
 * settings because the panel builds its base from the schema defaults. Get
 * that wrong and the backtest form opens with empty inputs, or fills in
 * cleanly and is refused the moment Run is pressed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { expandSweep } from '../shared/analysis/sweep.js';
import { STRATEGIES, resolveStrategyParams } from '../shared/strategies/index.js';

/** The base the sweep panel builds: every parameter at its schema default. */
function defaultsFor(id) {
  return Object.fromEntries(STRATEGIES[id].params.map((p) => [p.key, p.default]));
}

test('a sweep combination fills every field the backtest form needs', () => {
  for (const [id, spec] of Object.entries(STRATEGIES)) {
    const numeric = spec.params.filter((p) => p.type === 'number').slice(0, 2);
    if (numeric.length === 0) continue;

    const ranges = Object.fromEntries(numeric.map((p) => [
      p.key,
      { from: p.default, to: p.default + (p.step ?? 1) * 2, step: p.step ?? 1 },
    ]));

    for (const params of expandSweep(ranges, defaultsFor(id))) {
      for (const p of spec.params) {
        assert.notEqual(params[p.key], undefined, `${id}: a combination has no ${p.key}`);
      }
    }
  }
});

test('a handed-over combination survives the validation the run applies', () => {
  // Otherwise the form fills in cleanly and only fails when Run is pressed.
  const combos = expandSweep(
    { rrr: { from: 1.2, to: 3, step: 0.2 }, minGapSize: { from: 0, to: 40, step: 20 } },
    defaultsFor('silverbullet'),
  );

  assert.ok(combos.length > 1);
  for (const params of combos) {
    assert.doesNotThrow(
      () => resolveStrategyParams('silverbullet', params),
      `a combination the sweep produced would be refused: ${JSON.stringify(params)}`,
    );
  }
});

test('the swept values survive, they are not overwritten by the defaults', () => {
  /* The base carries a value for every key, including the ones being swept.
   * If the merge went the other way round, every combination would run with
   * the same default and the whole sweep would report one result many times. */
  const combos = expandSweep(
    { rrr: { from: 1.5, to: 2.5, step: 0.5 } },
    defaultsFor('silverbullet'),
  );

  assert.deepEqual(combos.map((c) => c.rrr), [1.5, 2, 2.5]);
});

test('merging a handoff over the defaults keeps missing settings valid', () => {
  /* The rule the backtest form follows. A combination stored before a strategy
   * gained a parameter carries no value for it; merging over the defaults
   * leaves that one usable instead of undefined, and lets the handoff win
   * everywhere it does have a value. */
  const defaults = defaultsFor('silverbullet');
  const older = { rrr: 2.5, minGapSize: 8 };   // an older, partial combination

  const merged = { ...defaults, ...older };

  assert.equal(merged.rrr, 2.5, 'the handoff has to win where it has a value');
  assert.equal(merged.riskMode, defaults.riskMode, 'and lose where it has none');
  assert.doesNotThrow(() => resolveStrategyParams('silverbullet', merged));
});

test('a combination carries the parameters, never the figures', () => {
  /* What the button hands over is `row.params`. Handing the whole row would
   * put stats into the form's parameter object, where they would be sent to
   * the engine as settings it does not have. */
  const combos = expandSweep({ rrr: { from: 1, to: 2, step: 1 } }, defaultsFor('silverbullet'));
  for (const params of combos) {
    assert.equal(params.stats, undefined);
    assert.equal(params.outOfSample, undefined);
    assert.equal(params.expectancy, undefined);
  }
});
