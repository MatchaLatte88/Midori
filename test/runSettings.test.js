import { test } from 'node:test';
import assert from 'node:assert/strict';

import { describeSettings, formatValue } from '../shared/analysis/runSettings.js';
import { strategyCatalog } from '../shared/strategies/index.js';

const SPEC = strategyCatalog().find((s) => s.id === 'silverbullet');

/** A stored run, in the shape runStore writes. */
function makeRun(over = {}) {
  return {
    strategy: 'silverbullet',
    strategyName: 'Silver Bullet',
    symbol: 'BTCUSDT',
    timeframe: '5m',
    from: Date.UTC(2026, 6, 1),
    to: Date.UTC(2026, 7, 1),
    initialBalance: 10_000,
    resolution: 'intrabar',
    params: { riskMode: 'percent', riskValue: 1, rrr: 2, windows: ['london', 'am'] },
    costs: { feeRate: 0.001, spreadPct: 0.0002, slippagePct: 0.0002 },
    ...over,
  };
}

const groupNamed = (groups, title) => groups.find((g) => g.title === title);
const rowFor = (groups, title, key) => groupNamed(groups, title)?.rows.find((r) => r.key === key);

/* ─── Formatting one value ──────────────────────────────────────────────── */

test('a select shows its label, not its wire value', () => {
  const param = {
    type: 'select',
    options: [{ value: 'percent', label: 'Percent of equity' }, { value: 'fixed', label: 'Fixed amount' }],
  };
  assert.equal(formatValue(param, 'percent'), 'Percent of equity');
  assert.equal(formatValue(param, 'fixed'), 'Fixed amount');
});

test('a multi-select lists its labels', () => {
  const param = {
    type: 'multi',
    options: [
      { value: 'london', label: 'London' },
      { value: 'am', label: 'NY AM' },
      { value: 'pm', label: 'NY PM' },
    ],
  };
  assert.equal(formatValue(param, ['london', 'pm']), 'London, NY PM');
});

test('an empty multi-select is a setting, not an absence', () => {
  // No windows means the strategy was switched off; a blank would hide that.
  assert.equal(formatValue({ type: 'multi', options: [] }, []), 'None');
});

test('a value the schema does not recognise falls back to itself', () => {
  /* A parameter whose options changed between versions still has to show what
   * the run actually used. */
  const param = { type: 'select', options: [{ value: 'a', label: 'A' }] };
  assert.equal(formatValue(param, 'gone'), 'gone');
  assert.equal(formatValue({ type: 'multi', options: [] }, ['x', 'y']), 'x, y');
});

test('a missing value says so rather than printing null', () => {
  assert.equal(formatValue({ type: 'number' }, undefined), '—');
  assert.equal(formatValue({ type: 'number' }, null), '—');
  // Zero is a value, not an absence — this is the classic falsy bug.
  assert.equal(formatValue({ type: 'number' }, 0), '0');
});

test('values with no schema at all are still readable', () => {
  assert.equal(formatValue(null, 42), '42');
  assert.equal(formatValue(null, true), 'Yes');
  assert.equal(formatValue(null, false), 'No');
  assert.equal(formatValue(null, ['a', 'b']), 'a, b');
});

/* ─── The whole run ─────────────────────────────────────────────────────── */

test('a run reports what it was run on', () => {
  const groups = describeSettings(makeRun(), SPEC);

  assert.equal(rowFor(groups, 'Run', 'symbol').value, 'BTCUSDT');
  assert.equal(rowFor(groups, 'Run', 'timeframe').value, '5m');
  assert.equal(rowFor(groups, 'Run', 'range').value, '2026-07-01 → 2026-08-01');
  assert.equal(rowFor(groups, 'Run', 'initialBalance').value, (10_000).toLocaleString());
});

test('how fills were resolved is reported as a setting', () => {
  /* It decides the outcome of every bar that touched both stop and target, so
   * two runs that differ only in this are not comparable — see ARCHITECTURE
   * section 4. */
  const intrabar = describeSettings(makeRun(), SPEC);
  assert.match(rowFor(intrabar, 'Run', 'resolution').value, /minute bars/);

  const pessimistic = describeSettings(makeRun({ resolution: 'pessimistic' }), SPEC);
  assert.equal(rowFor(pessimistic, 'Run', 'resolution').value, 'Pessimistic');
});

test('strategy parameters are labelled and ordered by the schema', () => {
  const groups = describeSettings(makeRun(), SPEC);
  const rows = groupNamed(groups, 'Strategy').rows;

  assert.equal(rowFor(groups, 'Strategy', 'riskMode').label, 'Risk per trade');
  assert.equal(rowFor(groups, 'Strategy', 'riskMode').value, 'Percent of equity');
  assert.equal(rowFor(groups, 'Strategy', 'windows').value, 'London, NY AM');

  // Schema order, so risk leads — the same order the form asks in.
  assert.equal(rows[0].key, 'riskMode');
});

test('costs are shown as the percentages people quote', () => {
  const groups = describeSettings(makeRun(), SPEC);
  assert.equal(rowFor(groups, 'Costs', 'feeRate').value, '0.1%');
  assert.equal(rowFor(groups, 'Costs', 'spreadPct').value, '0.02%');
});

test('a run stored before costs were recorded shows no cost group', () => {
  /* Rather than a group of three dashes implying the run was free. */
  const groups = describeSettings(makeRun({ costs: {} }), SPEC);
  assert.equal(groupNamed(groups, 'Costs'), undefined);
});

/* ─── Surviving a schema that moved on ──────────────────────────────────── */

test('a parameter the schema no longer knows is still shown', () => {
  /* A run can outlive the version that made it. Hiding a setting because the
   * strategy dropped it would silently make two runs look identical. */
  const groups = describeSettings(makeRun({
    params: { riskValue: 1, retiredSetting: 'kept' },
  }), SPEC);

  const row = rowFor(groups, 'Strategy', 'retiredSetting');
  assert.ok(row, 'the dropped parameter vanished');
  assert.equal(row.value, 'kept');
});

test('no schema at all still lists every parameter', () => {
  const groups = describeSettings(makeRun(), null);
  const rows = groupNamed(groups, 'Strategy').rows;

  assert.equal(rows.length, 4);
  // Raw keys and raw values, which is honest rather than blank.
  assert.equal(rowFor(groups, 'Strategy', 'riskMode').value, 'percent');
});

test('a run with no parameters has no strategy group', () => {
  const groups = describeSettings(makeRun({ params: {} }), SPEC);
  assert.equal(groupNamed(groups, 'Strategy'), undefined);
  // But it still says what it ran on.
  assert.ok(groupNamed(groups, 'Run'));
});

test('nothing at all describes to nothing rather than throwing', () => {
  assert.deepEqual(describeSettings(null), []);
  assert.doesNotThrow(() => describeSettings({}));
});

test('every row has a key, a label and a printable value', () => {
  // The template renders these directly; an undefined would show as blank.
  for (const group of describeSettings(makeRun(), SPEC)) {
    assert.ok(group.title, 'a group has no title');
    for (const row of group.rows) {
      assert.ok(row.key, `${group.title} has a row with no key`);
      assert.ok(row.label, `${group.title}.${row.key} has no label`);
      assert.equal(typeof row.value, 'string', `${group.title}.${row.key} is not printable`);
    }
  }
});
