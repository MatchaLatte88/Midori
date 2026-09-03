/* Undo and redo over the drawing set.
 *
 * Driven through the real composable rather than a copy of its logic: the whole
 * risk in an undo stack is that some command forgets to open an edit, and a
 * test that reimplemented the commands would forget in the same places.
 *
 * The chart is stubbed out entirely. Everything exercised here is a command —
 * delete, hide, lock, restyle, clear — none of which touches the chart API, so
 * `chart` and `series` can simply be null and the pointer paths stay out of it.
 * The pointer gestures are covered by their own reasoning in useDrawings; what
 * matters here is that a step is a step.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { useDrawings } from '../src/components/chart/drawings/useDrawings.js';
import { createDrawing } from '../src/components/chart/drawings/factory.js';

/** Three drawings, as they would come back off disk. */
function stored() {
  return [
    createDrawing('horizontal', [{ time: 1_000, price: 100 }], { color: 'ind-1' }),
    createDrawing('trendline', [
      { time: 1_000, price: 100 }, { time: 5_000, price: 120 },
    ], { color: 'ind-2' }),
    createDrawing('rectangle', [
      { time: 2_000, price: 90 }, { time: 6_000, price: 110 },
    ], { color: 'ind-3' }),
  ];
}

/**
 * A composable wired to nothing, with the drawings already loaded.
 *
 * `saved` records what reached the store, which is how the tests check that an
 * undo is persisted rather than only shown — a chart that came back on restart
 * with the undone state still in it would be the worst version of this bug.
 */
async function harness(initial = stored()) {
  const saved = [];
  globalThis.window = {
    midori: {
      drawings: {
        load: async () => initial,
        save: async (symbol, list) => { saved.push(list); },
      },
    },
  };

  const draw = useDrawings({
    chart: () => null,
    series: () => null,
    bars: () => [],
    symbol: () => 'BTCUSDT',
    onError: (err) => { throw err; },
  });

  await draw.load();
  return { draw, saved };
}

/** The ids currently on the chart, in order. */
const ids = (draw) => draw.drawings.value.map((d) => d.id);

test('nothing to undo on a freshly loaded chart', async () => {
  const { draw } = await harness();
  assert.equal(draw.canUndo.value, false);
  assert.equal(draw.canRedo.value, false);
  assert.equal(draw.undo(), false);
  assert.equal(draw.redo(), false);
  assert.equal(draw.drawings.value.length, 3);
});

test('a delete is one step, and comes back where it was', async () => {
  const { draw } = await harness();
  const before = ids(draw);

  draw.selectedId.value = before[1];
  assert.equal(draw.deleteSelected(), true);
  assert.deepEqual(ids(draw), [before[0], before[2]]);
  assert.equal(draw.canUndo.value, true);

  assert.equal(draw.undo(), true);
  assert.deepEqual(ids(draw), before, 'the order is restored, not just the count');
  assert.equal(draw.canUndo.value, false);
  assert.equal(draw.canRedo.value, true);

  assert.equal(draw.redo(), true);
  assert.deepEqual(ids(draw), [before[0], before[2]]);
});

test('undo is persisted, not only shown', async () => {
  const { draw, saved } = await harness();
  draw.selectedId.value = ids(draw)[0];
  draw.deleteSelected();
  draw.undo();

  // The last thing written has to be the restored set; otherwise the undone
  // state is what comes back on the next start.
  assert.equal(saved.at(-1).length, 3);
});

test('hiding, locking and restyling are each their own step', async () => {
  const { draw } = await harness();
  const [first] = ids(draw);

  draw.setHidden(first, true);
  draw.setLocked(first, true);
  draw.selectedId.value = first;
  draw.setColor('ind-4');

  const now = () => draw.drawings.value.find((d) => d.id === first);
  assert.equal(now().hidden, true);
  assert.equal(now().locked, true);
  assert.equal(now().color, 'ind-4');

  draw.undo();
  assert.equal(now().color, 'ind-1', 'the colour goes back first');
  assert.equal(now().locked, true);

  draw.undo();
  assert.equal(now().locked, false);
  assert.equal(now().hidden, true);

  draw.undo();
  assert.equal(now().hidden, false);
  assert.equal(draw.canUndo.value, false);
});

test('a command that changes nothing records no step', async () => {
  const { draw } = await harness();
  const [first] = ids(draw);

  // Already visible, already unlocked: neither is a change.
  assert.equal(draw.setHidden(first, false), false);
  assert.equal(draw.setLocked(first, false), false);
  assert.equal(draw.setAllLocked(false), false);
  assert.equal(draw.remove('nothing-by-this-id'), false);

  assert.equal(draw.canUndo.value, false, 'no-ops must not fill the history');
});

test('clearing everything is one step and is fully reversible', async () => {
  const { draw } = await harness();
  const before = ids(draw);

  draw.clearAll();
  assert.equal(draw.drawings.value.length, 0);

  draw.undo();
  assert.deepEqual(ids(draw), before);
});

test('a new edit forks the timeline', async () => {
  const { draw } = await harness();
  const before = ids(draw);

  draw.selectedId.value = before[2];
  draw.deleteSelected();
  draw.undo();
  assert.equal(draw.canRedo.value, true);

  // Doing something else means the redone future can no longer be reached — it
  // describes a chart that is not this one any more.
  draw.setHidden(before[0], true);
  assert.equal(draw.canRedo.value, false);
  assert.equal(draw.redo(), false);
  assert.deepEqual(ids(draw), before);
});

test('the selection is dropped when what it named is gone', async () => {
  const { draw } = await harness();
  const [first] = ids(draw);

  draw.selectedId.value = first;
  draw.deleteSelected();
  assert.equal(draw.selectedId.value, null);

  draw.undo();
  // Back on the chart but not reselected: undo restores drawings, not focus.
  assert.equal(draw.drawings.value.length, 3);

  // And the other way round: a selection that survives the restore is kept.
  draw.selectedId.value = first;
  draw.setHidden(ids(draw)[1], true);
  draw.undo();
  assert.equal(draw.selectedId.value, first);
});

test('a redo that would restore a deleted drawing drops the selection again', async () => {
  const { draw } = await harness();
  const [first] = ids(draw);

  draw.selectedId.value = first;
  draw.deleteSelected();
  draw.undo();
  draw.selectedId.value = first;

  draw.redo();
  assert.equal(draw.selectedId.value, null, 'the redone delete takes the selection with it');
});

test('switching symbol starts a new history', async () => {
  const { draw } = await harness();
  draw.selectedId.value = ids(draw)[0];
  draw.deleteSelected();
  assert.equal(draw.canUndo.value, true);

  await draw.load();
  assert.equal(draw.canUndo.value, false, 'undo must not reach across symbols');
  assert.equal(draw.canRedo.value, false);
  assert.equal(draw.drawings.value.length, 3);
});

test('the stack is bounded, and drops the oldest step rather than the newest', async () => {
  const { draw } = await harness();
  const [first] = ids(draw);

  // Well past the limit of 100, alternating so every call is a real change.
  for (let i = 0; i < 260; i++) draw.setHidden(first, i % 2 === 0);

  let steps = 0;
  while (draw.undo()) steps++;
  assert.equal(steps, 100, 'exactly the limit is kept');
  // The oldest reachable state is a mid-run one, not the loaded one — which is
  // the honest consequence of a bounded stack.
  assert.equal(draw.drawings.value.length, 3);
});
