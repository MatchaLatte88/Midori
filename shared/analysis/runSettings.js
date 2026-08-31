/* What a stored run was configured with, in a shape a page can render.
 *
 * A result without its settings is not a result. Two runs of the same strategy
 * that disagree only in one number are the whole point of storing them, and a
 * page that shows the outcome but not the inputs makes that comparison
 * impossible — you are left reading percentages with no idea what produced
 * them.
 *
 * The values are read back through the strategy's own parameter schema, so a
 * stored `riskMode: 'percent'` displays as "Percent of equity" rather than as
 * its wire value. That schema is also what supplies the labels, which means a
 * strategy that gains a setting gets it shown here without anyone touching
 * this file.
 *
 * Missing schema is not an error
 * ------------------------------
 * A run can outlive the strategy that made it — renamed, removed, or a
 * parameter dropped between versions. Every lookup therefore falls back to the
 * raw key and the raw value rather than hiding the setting: a run that says
 * `minGapSize: 50` under an unfamiliar name is still telling the truth, and a
 * blank row would not be.
 */

/** Formats a stored value using the schema entry that describes it. */
export function formatValue(param, value) {
  if (value === undefined || value === null) return '—';

  if (param?.type === 'select') {
    return param.options?.find((o) => o.value === value)?.label ?? String(value);
  }

  if (param?.type === 'multi') {
    if (!Array.isArray(value)) return String(value);
    // An empty list is a real setting — the indicator is switched off.
    if (value.length === 0) return 'None';
    return value
      .map((v) => param.options?.find((o) => o.value === v)?.label ?? v)
      .join(', ');
  }

  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** UTC day, matching how a range is entered and how bars are stored. */
function day(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '—';
}

/** A rate stored as a fraction, shown as the percentage people quote. */
function rate(value) {
  if (!Number.isFinite(value)) return '—';
  // Enough decimals for a 0.02% spread to survive; trailing zeroes trimmed.
  return `${Number((value * 100).toFixed(4))}%`;
}

/**
 * Every setting a run was made with, grouped for display.
 *
 * @param {object} run     a run as stored by runStore
 * @param {object} [spec]  the strategy's catalog entry, for labels; optional
 * @returns {Array<{title: string, rows: Array<{key, label, value}>}>}
 */
export function describeSettings(run, spec = null) {
  if (!run) return [];

  const groups = [];

  groups.push({
    title: 'Run',
    rows: [
      { key: 'strategy', label: 'Strategy', value: run.strategyName ?? run.strategy ?? '—' },
      { key: 'symbol', label: 'Symbol', value: run.symbol ?? '—' },
      { key: 'timeframe', label: 'Timeframe', value: run.timeframe ?? '—' },
      { key: 'range', label: 'Range', value: `${day(run.from)} → ${day(run.to)}` },
      {
        key: 'initialBalance',
        label: 'Starting balance',
        value: Number.isFinite(run.initialBalance) ? run.initialBalance.toLocaleString() : '—',
      },
      {
        key: 'resolution',
        label: 'Fills',
        /* Which of the two rules decided a bar that touched both stop and
         * target — see ARCHITECTURE section 4. It changes results, so it is a
         * setting of the run rather than a footnote. */
        value: run.resolution === 'intrabar' ? 'Resolved from minute bars' : 'Pessimistic',
      },
    ],
  });

  const params = run.params ?? {};
  const schema = spec?.params ?? [];
  const seen = new Set();
  const rows = [];

  // Schema order first: it groups risk before detector settings, as the form does.
  for (const param of schema) {
    if (!(param.key in params)) continue;
    seen.add(param.key);
    rows.push({
      key: param.key,
      label: param.label ?? param.key,
      value: formatValue(param, params[param.key]),
    });
  }

  /* Anything the schema no longer describes still gets a row. A parameter
   * dropped in a later version is exactly the kind of difference someone
   * comparing two runs needs to see. */
  for (const [key, value] of Object.entries(params)) {
    if (seen.has(key)) continue;
    rows.push({ key, label: key, value: formatValue(null, value) });
  }

  if (rows.length > 0) groups.push({ title: 'Strategy', rows });

  const costs = run.costs ?? {};
  if (Object.keys(costs).length > 0) {
    groups.push({
      title: 'Costs',
      rows: [
        { key: 'feeRate', label: 'Fee per side', value: rate(costs.feeRate) },
        { key: 'spreadPct', label: 'Spread', value: rate(costs.spreadPct) },
        { key: 'slippagePct', label: 'Slippage', value: rate(costs.slippagePct) },
      ],
    });
  }

  return groups;
}
