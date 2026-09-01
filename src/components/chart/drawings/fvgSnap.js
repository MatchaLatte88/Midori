/* Picking a fair value gap off the chart with one click.
 *
 * The FVG drawing tool does not ask the user to drag a box around an imbalance
 * — it asks the market where the imbalance is. A click lands somewhere in price
 * and time, and this file answers which gap, if any, covers that spot.
 *
 * The gaps come out of the same detector the indicator uses, run over the bars
 * the chart is currently showing. Two consequences, both deliberate:
 *
 *   - The FVG indicator does not have to be switched on, and its settings —
 *     min size, lookback, which mitigation rule — do not narrow what the tool
 *     can find. A tool that could only mark what an indicator happened to be
 *     configured to show would be a tool that silently does nothing.
 *   - `show: 'all'`, because a filled gap is exactly the kind of thing someone
 *     marks by hand: it is over, and that is why it is worth annotating.
 *
 * Stacked gaps are joined up the same way the indicator does it, when the tool
 * is set to — one click on a run of imbalances then marks the whole run rather
 * than whichever sliver the pointer happened to be inside.
 *
 * Zone indices are positions in the array that was passed in, so nothing here
 * may be held past the next time bars are paged in. The caller converts to
 * (time, price) anchors immediately — see zoneAnchors — and it is those that
 * get stored.
 *
 * Times are whatever unit the bars carry. The chart holds seconds and the
 * engine holds milliseconds; this file never interprets a timestamp beyond
 * comparing two of them, so it works with either as long as the click is
 * expressed in the same unit as the bars.
 */
import { detectFairValueGaps } from '../../../../shared/indicators/fvg.js';

/**
 * The fair value gap under a point, or null.
 *
 * A click has to land inside the box as it is drawn: within the gap's two
 * prices, at or after the bar it starts on, and not past the bar that filled
 * it. An unfilled gap runs on to the right edge, so it has no upper time bound.
 *
 * Where boxes overlap — and they do, constantly, since a strong move leaves
 * gaps on top of each other — the smallest wins. The big one stays reachable
 * everywhere the small one is not, whereas a nested gap picked by any other
 * rule could never be clicked at all.
 *
 * @param {Array<{time,open,high,low,close}>} bars ascending, as the chart holds them
 * @param {{time:number, price:number}} at  the click, in the bars' own time unit
 * @param {number} [priceTolerance=0] slack in price, so a gap a few pixels tall
 *   is still clickable; the caller converts its pixel tolerance for this
 * @param {object} [merge] the tool's stacking setting
 * @param {number} [merge.mergeWick=0] widest traded strip that still counts as
 *   no separation; 0 marks every gap on its own
 * @param {'percent'|'points'} [merge.mergeUnit='percent'] how to read it
 * @returns {object|null} a zone from detectFairValueGaps
 */
export function zoneAt(bars, at, priceTolerance = 0, merge = {}) {
  if (!Array.isArray(bars) || bars.length < 3) return null;

  const { zones } = detectFairValueGaps(bars, {
    show: 'all',
    mergeWick: merge.mergeWick ?? 0,
    /* The detector reads one unit for both of its size settings, and the tool
     * only has the one — so the tool's name for it is translated here rather
     * than borrowing a name for a filter it does not offer. */
    minSizeUnit: merge.mergeUnit ?? 'percent',
  });

  let best = null;
  for (const zone of zones) {
    if (at.price < zone.bottom - priceTolerance) continue;
    if (at.price > zone.top + priceTolerance) continue;
    if (at.time < bars[zone.startIndex].time) continue;
    if (zone.mitigatedIndex !== null && at.time > bars[zone.mitigatedIndex].time) continue;
    if (best === null || zone.size < best.size) best = zone;
  }

  return best;
}

/**
 * The two anchors a zone becomes: top-left and bottom-right.
 *
 * The right edge is where the gap ended — the bar that filled it — or, for one
 * still open, the last bar loaded. A drawing stores fixed anchors, so an open
 * gap cannot keep growing with the chart the way the indicator's box does; it
 * is frozen at the moment it was marked, and the handle is there to drag it on.
 *
 * Times come back in the bars' unit. The caller converts.
 */
export function zoneAnchors(zone, bars) {
  const right = zone.mitigatedIndex ?? bars.length - 1;
  return [
    { time: bars[zone.startIndex].time, price: zone.top },
    { time: bars[right].time, price: zone.bottom },
  ];
}
