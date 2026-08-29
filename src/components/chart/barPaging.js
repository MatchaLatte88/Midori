/* Paging bars into the chart, one page at a time.
 *
 * The subtle part is where a page starts and ends. Higher timeframes are
 * aggregated into buckets on UTC boundaries, so a request that begins in the
 * middle of a bucket produces a bucket that begins *before* the request — and
 * the next page back, ending at that same instant, produces the very same
 * bucket again.
 *
 * That went wrong in two ways at once: the chart got two bars with one
 * timestamp (which lightweight-charts refuses outright), and the first bar of
 * every page was built from only part of its bucket, so its open, high, low and
 * close were quietly wrong.
 *
 * Both disappear once page boundaries are aligned to the timeframe. The merge
 * still de-duplicates as a safety net, for gapped data and for a timeframe
 * switch arriving mid-flight.
 */

/** Largest multiple of `step` at or below `time`. */
export function alignDown(time, step) {
  if (!Number.isFinite(time)) throw new Error(`alignDown: time must be finite, got ${time}`);
  if (!(step > 0)) throw new Error(`alignDown: step must be positive, got ${step}`);
  return Math.floor(time / step) * step;
}

/**
 * The newest page for a dataset: [from, to) on bucket boundaries.
 *
 * `to` is the end of the bucket holding the last stored bar, so the newest
 * bucket is included whole.
 */
export function latestPage(meta, step, pageSize) {
  const to = alignDown(meta.last, step) + step;
  const from = Math.max(alignDown(meta.first, step), to - pageSize * step);
  return { from, to };
}

/**
 * The page immediately before `earliest`, which is itself already a boundary.
 * Returns null when there is nothing older to fetch.
 */
export function previousPage(meta, step, pageSize, earliest) {
  const firstBucket = alignDown(meta.first, step);
  if (earliest <= firstBucket) return null;
  const from = Math.max(firstBucket, earliest - pageSize * step);
  return { from, to: earliest };
}

/**
 * Puts an older page in front of what is already loaded.
 *
 * Anything at or after the first existing bar is dropped: with aligned pages
 * there should be nothing to drop, but a duplicate timestamp reaching the chart
 * is a hard error, and silently keeping the older copy of a bar would be worse
 * than dropping it.
 */
export function prependBars(older, existing) {
  if (existing.length === 0) return [...older];
  const boundary = existing[0].time;
  const kept = [];
  for (const bar of older) {
    if (bar.time < boundary) kept.push(bar);
  }
  return [...kept, ...existing];
}

/** True if a series is strictly ascending — what the chart library demands. */
export function isAscending(bars) {
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].time <= bars[i - 1].time) return false;
  }
  return true;
}
