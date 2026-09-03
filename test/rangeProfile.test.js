/* Range volume profiles: the window a drawn span asks for, and the key that
 * decides whether it has to be asked for again.
 *
 * The rendering itself needs a chart, but neither of these does — and both are
 * places where a quiet mistake costs a wrong point of control rather than a
 * visible error.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { profileWindow, windowKey } from '../src/components/chart/rangeProfilePrimitive.js';
import { createDrawing, parseDrawing } from '../src/components/chart/drawings/factory.js';
import { pointsRequired } from '../src/components/chart/drawings/registry.js';
import { computeVolumeProfile } from '../shared/indicators/volumeProfile.js';

const span = (t1, t2) => ({ id: 'd1', points: [{ time: t1, price: 10 }, { time: t2, price: 20 }] });

test('a span reads the same dragged either way', () => {
  const left = profileWindow(span(1000, 5000));
  const right = profileWindow(span(5000, 1000));
  assert.deepEqual(left, { from: 1000, to: 5000 });
  assert.deepEqual(right, left, 'dragging right to left is the same window');
});

test('anchors are already milliseconds and are not converted again', () => {
  // useDrawings hands the layer milliseconds; multiplying by 1000 here would
  // ask the data process for a window in the year 57000.
  const ms = Date.UTC(2026, 7, 28, 10, 0);
  const { from } = profileWindow(span(ms, ms + 3_600_000));
  assert.equal(from, ms);
  assert.ok(new Date(from).getUTCFullYear() === 2026);
});

test('the key changes when the span moves and when the binning changes', () => {
  const options = { bins: 120, valueArea: 70, distribution: 'uniform' };
  const base = windowKey(span(1000, 5000), options);

  assert.equal(windowKey(span(1000, 5000), options), base, 'same span, same key');
  assert.notEqual(windowKey(span(1000, 6000), options), base, 'moved span');
  assert.notEqual(windowKey(span(1000, 5000), { ...options, bins: 60 }), base, 'other bins');
  assert.notEqual(
    windowKey(span(1000, 5000), { ...options, distribution: 'close' }),
    base,
    'other distribution',
  );

  // Two spans over the same window are still two profiles to draw.
  const other = { ...span(1000, 5000), id: 'd2' };
  assert.notEqual(windowKey(other, options), base);
});

test('the tool takes two anchors and survives a save/load round trip', () => {
  assert.equal(pointsRequired('rangeprofile'), 2);

  const drawing = createDrawing('rangeprofile', [
    { time: 1000, price: 10 },
    { time: 5000, price: 20 },
  ]);
  assert.equal(drawing.type, 'rangeprofile');

  const loaded = parseDrawing(JSON.parse(JSON.stringify(drawing)));
  assert.ok(loaded, 'a saved range profile must load again');
  assert.deepEqual(loaded.points, drawing.points);
  assert.deepEqual(profileWindow(loaded), profileWindow(drawing));
});

test('a span with no width produces an empty window', () => {
  /* A click without a drag leaves both anchors on one bar. The chart skips
   * these rather than asking for them: the data process refuses a range that
   * does not end after it starts, and that error would surface in the UI as if
   * something had gone wrong. */
  const { from, to } = profileWindow(span(4000, 4000));
  assert.equal(from, to);
  assert.equal(to > from, false);
});

test('a profile over a window covers only the bars inside it', () => {
  /* The window is applied by reading bars, not by the profile itself — so the
   * guarantee that matters here is that the same bars always produce the same
   * total, which is what the chart then draws inside the span. */
  const bars = Array.from({ length: 60 }, (_, i) => ({
    time: Date.UTC(2026, 0, 1) + i * 60_000,
    open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 2,
  }));

  const all = computeVolumeProfile(bars, { bins: 40 });
  const half = computeVolumeProfile(bars.slice(0, 30), { bins: 40 });

  // Spreading volume across a range is a lot of floating-point addition, so
  // the suite compares totals with a tolerance here as it does elsewhere.
  assert.ok(Math.abs(all.totalVolume - 120) < 1e-9);
  assert.ok(Math.abs(half.totalVolume - 60) < 1e-9);
  assert.ok(half.poc.price < all.poc.price, 'the earlier half peaks lower');
});
