/* Comparing stored runs against each other.
 *
 * Why this is not just "draw two curves"
 * --------------------------------------
 * The equity curve a run stores is condensed — one point per balance change,
 * not one per bar (see runStore.condenseEquity). Two runs over the same months
 * therefore have completely different numbers of points: a run with nine
 * trades has eleven, a run with four hundred has four hundred and two.
 *
 * Drawing each of them across the same width means the ninth trade of one run
 * sits above the three hundredth of the other. The lines cross, the crossings
 * look like something, and none of it is about the market. The x-axis has to
 * be time, and every point has one — so that is what this file builds.
 *
 * Calendar or aligned
 * -------------------
 * Two runs over the same months belong on a calendar axis: the whole question
 * is which one was ahead in March. Two runs over *different* months do not —
 * on a calendar axis they are two disconnected segments with a gap between
 * them, which is true and useless. Aligning both to "days since this run
 * started" is what compares them.
 *
 * Neither is picked automatically. Which of the two questions is being asked
 * is not something the data says, and a chart that silently changes its axis
 * is a chart nobody can read twice the same way.
 *
 * Comparability is reported, never enforced
 * -----------------------------------------
 * Comparing a 5m run on BTC with a 4h run on ETH is a perfectly reasonable
 * thing to want to look at, and refusing it would be the tool deciding what
 * the user meant. Saying plainly that the two differ in symbol and timeframe
 * is not.
 */

import { analyseRun } from './runAnalysis.js';
import { formatValue } from './runSettings.js';

/* ─── Curves ────────────────────────────────────────────────────────────── */

/** How the horizontal axis is read. */
export const CURVE_MODES = ['calendar', 'aligned'];
/** Which quantity the curve shows. */
export const CURVE_MEASURES = ['equity', 'drawdown'];

/**
 * One run's curve as {x, value} points.
 *
 * `equity` is the percentage gain on the run's own starting balance, which is
 * the only way two accounts of different sizes are comparable at all: the one
 * that began with more would otherwise look better at identical skill.
 *
 * `drawdown` is how far below its own high-water mark the account was, as a
 * percentage of that mark, and always negative or zero so it reads downwards.
 * Both parts of it are in the stored point: the engine recorded the absolute
 * drawdown over the *full* curve before it was condensed, so the peak it was
 * measured against is `equity + drawdown` and nothing has to be re-derived
 * from the thinned points — which would understate it.
 */
export function curveOf(run, measure = 'equity') {
  if (!CURVE_MEASURES.includes(measure)) {
    throw new Error(`curveOf: unknown measure "${measure}". Known: ${CURVE_MEASURES.join(', ')}`);
  }
  const points = run?.equityCurve ?? [];
  const initial = run?.initialBalance;

  if (measure === 'drawdown') {
    return points.map((p) => {
      const down = p.drawdown ?? 0;
      const peak = p.equity + down;
      /* Zero exactly, never -0: negating it survives every arithmetic step and
       * comes out of toFixed as "-0.0%", which reads as a loss. */
      return { x: p.time, value: down > 0 && peak > 0 ? -(down / peak) * 100 : 0 };
    });
  }

  if (!(initial > 0)) return [];
  return points.map((p) => ({ x: p.time, value: ((p.equity - initial) / initial) * 100 }));
}

/**
 * Every compared run's curve on one axis, plus the extents to scale it into.
 *
 * In `aligned` mode each run's own first point becomes zero, so runs over
 * different stretches of history sit on top of each other and the axis is
 * elapsed time rather than a date.
 *
 * Zero is always inside the value range: it is the line that separates a run
 * that made money from one that did not, and a scale that cropped it would
 * make every losing run look like a winning one.
 *
 * @param {Array<object>} runs
 * @param {{mode?: string, measure?: string}} [options]
 */
export function compareCurves(runs, options = {}) {
  const { mode = 'calendar', measure = 'equity' } = options;
  if (!CURVE_MODES.includes(mode)) {
    throw new Error(`compareCurves: unknown mode "${mode}". Known: ${CURVE_MODES.join(', ')}`);
  }

  const series = (runs ?? []).map((run) => {
    const points = curveOf(run, measure);
    const origin = points.length > 0 ? points[0].x : 0;
    return {
      id: run.id,
      label: run.strategyName ?? run.strategy ?? '—',
      points: mode === 'aligned'
        ? points.map((p) => ({ x: p.x - origin, value: p.value }))
        : points,
    };
  });

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = 0;
  let maxY = 0;

  for (const s of series) {
    for (const p of s.points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.value < minY) minY = p.value;
      if (p.value > maxY) maxY = p.value;
    }
  }

  // Nothing to draw, or a single instant: give the axes a band to sit in
  // rather than a division by zero.
  if (!Number.isFinite(minX)) { minX = 0; maxX = 1; }
  if (maxX === minX) maxX = minX + 1;
  if (maxY - minY < 1e-9) { minY -= 1; maxY += 1; }

  return { series, mode, measure, minX, maxX, minY, maxY };
}

/**
 * Each series' value at a moment on the axis, for a readout under the pointer.
 *
 * The value carried forward from the last point at or before `x`, never
 * interpolated: between two points the account did not drift towards the next
 * balance, it sat at the last one. A run that had not started yet at `x` has
 * no value there, which is a real answer and not zero.
 */
export function valuesAt(compared, x) {
  return compared.series.map((s) => {
    let found = null;
    for (const p of s.points) {
      if (p.x > x) break;
      found = p;
    }
    return { id: s.id, label: s.label, value: found ? found.value : null };
  });
}

/* ─── Comparability ─────────────────────────────────────────────────────── */

/** Two runs overlap in time if either one's range contains part of the other's. */
function overlaps(a, b) {
  return a.from < b.to && b.from < a.to;
}

/**
 * What the compared runs disagree about, in words.
 *
 * Every one of these is a legitimate comparison to want — a strategy on two
 * symbols, the same strategy at two fee levels — and none of them is refused.
 * They are listed because each one is a reason the two numbers underneath are
 * not answering quite the same question, and that is worth seeing before the
 * numbers are.
 */
export function comparability(runs) {
  const list = runs ?? [];
  if (list.length < 2) return [];

  const notes = [];
  const distinct = (read) => [...new Set(list.map(read))];

  const symbols = distinct((r) => r.symbol);
  if (symbols.length > 1) {
    notes.push({ key: 'symbol', message: `Different markets: ${symbols.join(', ')}.` });
  }

  const timeframes = distinct((r) => r.timeframe);
  if (timeframes.length > 1) {
    notes.push({ key: 'timeframe', message: `Different timeframes: ${timeframes.join(', ')}.` });
  }

  const disjoint = list.some((a) => list.some((b) => a !== b && !overlaps(a, b)));
  if (disjoint) {
    notes.push({
      key: 'period',
      message: 'These runs do not all cover the same period, so a calendar axis '
        + 'shows them side by side rather than on top of each other.',
    });
  }

  const balances = distinct((r) => r.initialBalance);
  if (balances.length > 1) {
    notes.push({
      key: 'balance',
      message: 'Different starting balances. The curve is in percent, so it still '
        + 'compares; the cash figures do not.',
    });
  }

  const costs = distinct((r) => JSON.stringify(r.costs ?? {}));
  if (costs.length > 1) {
    notes.push({ key: 'costs', message: 'Different trading costs — see the settings below.' });
  }

  const resolutions = distinct((r) => r.resolution);
  if (resolutions.length > 1) {
    notes.push({
      key: 'resolution',
      message: 'One of these resolved its fills from minute bars and another guessed '
        + 'pessimistically, which decides every bar that touched both stop and target.',
    });
  }

  return notes;
}

/* ─── Settings ──────────────────────────────────────────────────────────── */

/**
 * The runs' parameters side by side, with the differing ones marked.
 *
 * The question a comparison is always actually asking — what did I change? —
 * and the one a per-run settings list cannot answer without reading two
 * columns of identical numbers looking for the odd one out.
 *
 * A key one run has and another does not counts as a difference, and the run
 * without it shows an absence rather than a blank: a parameter that only
 * exists on one side is exactly the kind of thing worth noticing.
 *
 * @param {Array<object>} runs
 * @param {Array<object>} [catalog]  strategy catalog entries, for labels
 */
export function settingsDiff(runs, catalog = []) {
  const list = runs ?? [];
  if (list.length === 0) return [];

  /* Schema order first, so risk settings stay above detector settings the way
   * the form shows them; anything only a stored run knows about follows. */
  const schemaFor = (run) => catalog.find((c) => c.id === run.strategy)?.params ?? [];
  const order = [];
  const seen = new Set();
  for (const run of list) {
    for (const p of schemaFor(run)) {
      if (!seen.has(p.key)) { seen.add(p.key); order.push(p.key); }
    }
  }
  for (const run of list) {
    for (const key of Object.keys(run.params ?? {})) {
      if (!seen.has(key)) { seen.add(key); order.push(key); }
    }
  }

  return order.map((key) => {
    const cells = list.map((run) => {
      const params = run.params ?? {};
      if (!(key in params)) return { text: '—', missing: true };
      const param = schemaFor(run).find((p) => p.key === key) ?? null;
      return { text: formatValue(param, params[key]), missing: false };
    });

    const label = list
      .map((run) => schemaFor(run).find((p) => p.key === key)?.label)
      .find(Boolean) ?? key;

    return {
      key,
      label,
      cells,
      differs: new Set(cells.map((c) => c.text)).size > 1,
    };
  });
}

/* ─── Figures ───────────────────────────────────────────────────────────── */

/**
 * How each figure is read and which direction is better.
 *
 * `better` is not decoration: a table that highlighted the largest number in
 * every row would crown the run with the deepest drawdown and the highest fees.
 */
export const COMPARE_METRICS = [
  {
    key: 'returnPct',
    label: 'Return',
    format: 'percent',
    better: 'high',
    read: (run) => run.stats.returnPct,
  },
  {
    key: 'netPnl',
    label: 'Net PnL',
    format: 'money',
    better: 'high',
    read: (run) => run.stats.netPnl,
  },
  {
    key: 'maxDrawdownPct',
    label: 'Max drawdown',
    format: 'percent',
    better: 'low',
    read: (run) => run.stats.maxDrawdownPct,
  },
  {
    /* Return per unit of the worst loss on the way to it. Not a new claim —
     * both halves are already in the table — but the one row that says whether
     * a bigger number was bought with a worse ride. A run that never drew down
     * has no ratio rather than an infinite one. */
    key: 'returnOverDd',
    label: 'Return / max DD',
    format: 'ratio',
    better: 'high',
    read: (run) => {
      const dd = run.stats.maxDrawdownPct;
      return dd > 0 ? run.stats.returnPct / dd : null;
    },
  },
  {
    key: 'tradeCount',
    label: 'Trades',
    format: 'count',
    better: 'none',
    read: (run) => run.stats.tradeCount,
  },
  {
    key: 'winRate',
    label: 'Win rate',
    format: 'percent',
    better: 'high',
    read: (run) => run.stats.winRate,
  },
  {
    key: 'profitFactor',
    label: 'Profit factor',
    format: 'ratio',
    better: 'high',
    read: (run) => run.stats.profitFactor,
  },
  {
    key: 'expectancy',
    label: 'Expectancy',
    format: 'money',
    better: 'high',
    read: (run) => run.stats.expectancy,
  },
  {
    key: 'longestLoss',
    label: 'Worst streak',
    format: 'count',
    better: 'low',
    read: (run, derived) => derived.streaks.longestLoss,
  },
  {
    key: 'avgHoldMs',
    label: 'Avg hold',
    format: 'duration',
    better: 'none',
    read: (run, derived) => derived.avgHoldMs,
  },
  {
    key: 'feesPaid',
    label: 'Fees paid',
    format: 'money',
    better: 'low',
    read: (run) => run.stats.feesPaid,
  },
];

/**
 * One row per figure, one cell per run, with the best cell of each row marked.
 *
 * A null is an absence and never wins a row — a run with no trades has no win
 * rate, and letting that top the column would read as a perfect one. Ties mark
 * every cell that ties, because a row where two runs are level is a row where
 * the setting did not decide anything.
 */
export function metricTable(runs) {
  const list = runs ?? [];
  if (list.length === 0) return [];

  const derived = list.map((run) => analyseRun(run));

  return COMPARE_METRICS.map((metric) => {
    const values = list.map((run, i) => metric.read(run, derived[i]));
    const real = values.filter((v) => v != null && Number.isFinite(v));

    /* Only where there is something to compare against. One run alone has a
     * best of everything, which is not a finding; and a figure no run could
     * report has no winner at all. */
    let best = null;
    if (metric.better !== 'none' && list.length > 1 && real.length > 0) {
      best = metric.better === 'high' ? Math.max(...real) : Math.min(...real);
    }

    return {
      key: metric.key,
      label: metric.label,
      format: metric.format,
      cells: values.map((value) => ({
        value,
        best: best !== null && value === best,
      })),
    };
  });
}
