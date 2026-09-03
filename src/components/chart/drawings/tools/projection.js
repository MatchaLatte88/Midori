/* Prediction and measurement.
 *
 * The tools here answer "what is this worth" and "what would happen if" — the
 * two questions that need arithmetic rather than geometry. They are the only
 * family that reads the bars: a measurement in bars, a VWAP and a copied bar
 * pattern all need the data behind the pixels, which arrives as env.bars().
 */
import {
  DEFAULT_RR, HIT_TOLERANCE, distanceToPolyline, distanceToSegment,
  isInsidePolygon, measureStats, positionDirection, positionStats,
} from '../geometry.js';
import { DEFAULT_POSITION_STYLE, ENTRY, STOP, TARGET, normalizeOpacity } from '../model.js';
import {
  chipLines, fillPolygonAlpha, fillRectAlpha, formatPercent, formatPrice, haloText,
  line, polyline,
} from '../render.js';

/* ─── Position ──────────────────────────────────────────────────────────── */

export const position = {
  id: 'position',
  name: 'Position',
  hint: 'Drag from the entry to the stop — down for a long, up for a short',
  group: 'projection',
  icon: 'position',
  points: 3,
  gesture: 'drag',
  style: 'position',

  /**
   * Turns the drag into three anchors.
   *
   * The drag gives entry and stop; the target is placed at DEFAULT_RR times the
   * risk on the other side of the entry — the way a trader sizes a trade in the
   * first place. All three stay adjustable afterwards, so dragging down from
   * the entry produces a long and dragging up a short without the tool needing
   * to be told which was meant.
   */
  build(start, end) {
    const risk = start.price - end.price; // signed: the drag decides the direction
    return [
      { time: start.time, price: start.price },
      { time: end.time, price: end.price },
      { time: end.time, price: start.price + risk * DEFAULT_RR },
    ];
  },

  /**
   * A position block has one right edge, shared by the stop and target anchors.
   * Dragging either of them must move both, or the block tears in half. The
   * entry anchor owns the left edge on its own.
   */
  linkAnchor(index) {
    if (index === STOP) return { index: TARGET, axis: 'time' };
    if (index === TARGET) return { index: STOP, axis: 'time' };
    return null;
  },

  /* Position blocks are exempt from the shift-axis lock: their three anchors
   * already encode a direction, and locking a drag to the horizontal would set
   * the risk to zero, which is not a position anyone is trying to draw. */
  noAxisSnap: true,

  hit(pts, at) {
    if (pts.length < 3) return false;
    // The whole block is grabbable: it is a zone, and clicking inside one is
    // the obvious way to pick it up.
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    return at.x >= Math.min(...xs) - HIT_TOLERANCE
      && at.x <= Math.max(...xs) + HIT_TOLERANCE
      && at.y >= Math.min(...ys) - HIT_TOLERANCE
      && at.y <= Math.max(...ys) + HIT_TOLERANCE;
  },

  /**
   * The risk zone from entry to stop, the reward zone from entry to target, and
   * the numbers that decide whether the trade is worth taking.
   *
   * Colour follows meaning, not direction: the stop side takes the loss colour
   * and the target side the profit colour, so a short reads the same way round
   * as a long. The defaults are red and green — the one place they belong on
   * this chart, since a zone cannot be mistaken for a candle — but both colours
   * and the fill opacity are per drawing, so several planned trades can be told
   * apart on one chart.
   */
  draw(ctx, { pts, drawing, chrome, tokenColor }) {
    if (pts.length < 3) return;
    const [entryPt, stopPt, targetPt] = drawing.points;
    const stats = positionStats(entryPt.price, stopPt.price, targetPt.price);

    const left = pts[ENTRY].x;
    const right = pts[STOP].x;
    const x = Math.min(left, right);
    const width = Math.abs(right - left);

    const yEntry = pts[ENTRY].y;
    const yStop = pts[STOP].y;
    const yTarget = pts[TARGET].y;

    const opacity = normalizeOpacity(drawing.fillOpacity);
    const profitColor = tokenColor(drawing.profitColor ?? DEFAULT_POSITION_STYLE.profitColor);
    const lossColor = tokenColor(drawing.lossColor ?? DEFAULT_POSITION_STYLE.lossColor);

    // Zones. Each spans from the entry line to its own level, so they meet at
    // the entry and never overlap.
    const zone = (yFrom, yTo, color) => {
      const top = Math.min(yFrom, yTo);
      const height = Math.abs(yTo - yFrom);
      if (height < 0.5) return;
      fillRectAlpha(ctx, color, opacity, x, top, width, height);
    };

    zone(yEntry, yStop, lossColor);
    zone(yEntry, yTarget, profitColor);

    const level = (y, color, dashed) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.setLineDash(dashed ? [4, 3] : []);
      line(ctx, x, y, x + width, y);
      ctx.setLineDash([]);
    };

    level(yStop, lossColor, false);
    level(yTarget, profitColor, false);
    level(yEntry, chrome.text, true);

    /* Everything is written inside the block, on the side facing the entry.
     * Nothing hangs off the edges, so a label cannot be clipped by the pane or
     * covered by anything the block itself draws. */
    ctx.font = '10px "DM Mono", ui-monospace, monospace';

    const label = (y, side, text, color) => {
      ctx.fillStyle = color;
      ctx.textAlign = 'left';
      ctx.textBaseline = side === 'above' ? 'bottom' : 'top';
      ctx.fillText(text, x + 5, side === 'above' ? y - 3 : y + 3);
    };

    // Which way the target lies decides which side of each line is "inwards".
    const targetAbove = yTarget < yEntry;
    const pct = (v) => (v == null ? '—' : `${v.toFixed(2)}%`);

    label(yTarget, targetAbove ? 'below' : 'above',
      `TP  ${formatPrice(stats.target)}   +${pct(stats.rewardPercent)}`, profitColor);
    label(yStop, targetAbove ? 'above' : 'below',
      `SL  ${formatPrice(stats.stop)}   −${pct(stats.riskPercent)}`, lossColor);
    label(yEntry, targetAbove ? 'above' : 'below',
      `Entry  ${formatPrice(stats.entry)}`, chrome.text);

    /* Direction and reward-to-risk go into the risk zone, right against the
     * entry line. The direction is read off the anchors, never stored: dragging
     * the target across the entry turns a long into a short, and the label has
     * to follow the picture rather than what the block was called when it was
     * drawn. */
    const direction = positionDirection(stats.entry, stats.stop, stats.target);
    const name = direction === 'long' ? 'LONG' : direction === 'short' ? 'SHORT' : 'POSITION';
    const rr = stats.rr == null ? '—' : stats.rr.toFixed(2);

    label(yEntry, targetAbove ? 'below' : 'above', `${name}   R:R ${rr}`, chrome.text);
  },
};

/* ─── Measure ───────────────────────────────────────────────────────────── */

export const measure = {
  id: 'measure',
  name: 'Measure',
  hint: 'Change in price, percent and bars',
  group: 'projection',
  icon: 'measure',
  points: 2,
  gesture: 'drag',
  style: 'line',
  hit(pts, at) {
    const [a, b] = pts;
    return b ? distanceToSegment(at.x, at.y, a.x, a.y, b.x, b.y) <= HIT_TOLERANCE : false;
  },
  draw(ctx, env) {
    const { pts, drawing, chrome } = env;
    const [a, b] = pts;
    if (!b) return;
    const [from, to] = drawing.points;
    const bars = env.barsBetween(from.time, to.time);
    const stats = measureStats(from.price, to.price, bars);
    const tone = stats.change >= 0 ? chrome.pos : chrome.neg;

    ctx.strokeStyle = tone;
    fillRectAlpha(ctx, tone, 0.12,
      Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));

    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    line(ctx, a.x, a.y, b.x, b.y);
    ctx.setLineDash([]);

    chipLines(ctx, (a.x + b.x) / 2, Math.min(a.y, b.y) - 47, [
      `${stats.change >= 0 ? '+' : ''}${formatPrice(stats.change)}`,
      formatPercent(stats.percent),
      `${bars} bar${bars === 1 ? '' : 's'}`,
    ], tone, chrome);
  },
};

/* ─── Ranges ────────────────────────────────────────────────────────────── */

/* Three tools, one shape. They differ in which axis the span is drawn on and
 * therefore which numbers are worth printing — a date range that also reported
 * a price change would be answering a question nobody asked it. */
function rangeTool(id, name, hint, icon, axes) {
  return {
    id,
    name,
    hint,
    group: 'projection',
    icon,
    points: 2,
    gesture: 'drag',
    style: 'line',
    hit(pts, at) {
      const [a, b] = pts;
      if (!b) return false;
      const inX = at.x >= Math.min(a.x, b.x) - HIT_TOLERANCE
        && at.x <= Math.max(a.x, b.x) + HIT_TOLERANCE;
      const inY = at.y >= Math.min(a.y, b.y) - HIT_TOLERANCE
        && at.y <= Math.max(a.y, b.y) + HIT_TOLERANCE;
      // A single-axis tool spans the pane on the other one, so only its own
      // axis narrows the hit.
      if (axes === 'time') return inX;
      if (axes === 'price') return inY;
      return inX && inY;
    },
    draw(ctx, env) {
      const { pts, drawing, color, chrome, size } = env;
      const [a, b] = pts;
      if (!b) return;
      const [from, to] = drawing.points;

      const left = Math.min(a.x, b.x);
      const right = Math.max(a.x, b.x);
      const top = axes === 'time' ? 0 : Math.min(a.y, b.y);
      const bottom = axes === 'time' ? size.height : Math.max(a.y, b.y);
      const x1 = axes === 'price' ? 0 : left;
      const x2 = axes === 'price' ? size.width : right;

      fillRectAlpha(ctx, color, 0.1, x1, top, x2 - x1, bottom - top);
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(x1, top, x2 - x1, bottom - top);
      ctx.setLineDash([]);

      const bars = env.barsBetween(from.time, to.time);
      const stats = measureStats(from.price, to.price, bars);
      const lines = [];
      if (axes !== 'price') lines.push(`${bars} bar${bars === 1 ? '' : 's'}`, spanLabel(from.time, to.time));
      if (axes !== 'time') {
        lines.push(`${stats.change >= 0 ? '+' : ''}${formatPrice(stats.change)}`);
        lines.push(formatPercent(stats.percent));
      }

      chipLines(ctx, (x1 + x2) / 2, top + 6, lines, color, chrome);
    },
  };
}

/**
 * A span of time in the largest unit that still reads as a whole number.
 *
 * Times are in milliseconds throughout the app, so this is plain arithmetic —
 * no calendar. That makes a "month" thirty days rather than a real one, which
 * is the right trade for a chart annotation: it is describing a distance, not
 * a date.
 */
function spanLabel(fromMs, toMs) {
  const ms = Math.abs(toMs - fromMs);
  const minutes = ms / 60000;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(hours < 10 ? 1 : 0)}h`;
  const days = hours / 24;
  if (days < 60) return `${days.toFixed(days < 10 ? 1 : 0)}d`;
  return `${(days / 30).toFixed(1)}mo`;
}

export const daterange = rangeTool(
  'daterange', 'Date range',
  'How long a stretch of chart lasted', 'daterange', 'time',
);
export const pricerange = rangeTool(
  'pricerange', 'Price range',
  'How far price travelled', 'pricerange', 'price',
);
export const datepricerange = rangeTool(
  'datepricerange', 'Date and price range',
  'Both at once', 'datepricerange', 'both',
);

/* ─── Price/bar ratio ───────────────────────────────────────────────────── */

export const pricebarratio = {
  id: 'pricebarratio',
  name: 'Price/bar ratio',
  hint: 'How much price moved per bar across a leg',
  group: 'projection',
  icon: 'pricebarratio',
  points: 2,
  gesture: 'drag',
  style: 'line',
  hit(pts, at) {
    const [a, b] = pts;
    return b ? distanceToSegment(at.x, at.y, a.x, a.y, b.x, b.y) <= HIT_TOLERANCE : false;
  },
  draw(ctx, env) {
    const { pts, drawing, color, chrome } = env;
    const [a, b] = pts;
    if (!b) return;
    line(ctx, a.x, a.y, b.x, b.y);

    const [from, to] = drawing.points;
    const bars = env.barsBetween(from.time, to.time);
    const change = to.price - from.price;
    // A leg inside one bar has no per-bar rate; say so rather than dividing.
    const perBar = bars === 0 ? null : change / bars;

    chipLines(ctx, (a.x + b.x) / 2, Math.min(a.y, b.y) - 34, [
      perBar === null ? '—' : `${perBar >= 0 ? '+' : ''}${formatPrice(perBar)} / bar`,
      `${bars} bar${bars === 1 ? '' : 's'}`,
    ], color, chrome);
  },
};

/* ─── Forecast and projection ───────────────────────────────────────────── */

/* Both take an origin, a target and a spread. The forecast draws the cone the
 * outcome is expected to land in; the projection draws the same leg again from
 * a new starting point, which is the "if it repeats" question rather than the
 * "how sure am I" one. */

export const forecast = {
  id: 'forecast',
  name: 'Forecast',
  hint: 'Origin, expected target, then how wide the outcome could be',
  group: 'projection',
  icon: 'forecast',
  points: 3,
  gesture: 'clicks',
  style: 'line',
  hit(pts, at) {
    if (pts.length < 3) return false;
    const [a, b, c] = pts;
    const spread = Math.abs(c.y - b.y);
    return isInsidePolygon(at.x, at.y, [
      a, { x: b.x, y: b.y - spread }, { x: b.x, y: b.y + spread },
    ]) || distanceToSegment(at.x, at.y, a.x, a.y, b.x, b.y) <= HIT_TOLERANCE;
  },
  draw(ctx, { pts, drawing, color, chrome }) {
    if (pts.length < 3) return;
    const [a, b, c] = pts;
    const spread = Math.abs(c.y - b.y);
    const cone = [a, { x: b.x, y: b.y - spread }, { x: b.x, y: b.y + spread }];

    fillPolygonAlpha(ctx, color, 0.1, cone);
    ctx.setLineDash([4, 3]);
    line(ctx, a.x, a.y, cone[1].x, cone[1].y);
    line(ctx, a.x, a.y, cone[2].x, cone[2].y);
    ctx.setLineDash([]);
    line(ctx, a.x, a.y, b.x, b.y);

    const [pa, pb, pc] = drawing.points;
    const change = pb.price - pa.price;
    chipLines(ctx, b.x, b.y - 40, [
      `${change >= 0 ? '+' : ''}${formatPrice(change)}`,
      `± ${formatPrice(Math.abs(pc.price - pb.price))}`,
    ], color, chrome, 'right');
  },
};

export const projection = {
  id: 'projection',
  name: 'Projection',
  hint: 'A leg, then where to repeat it from',
  group: 'projection',
  icon: 'projection',
  points: 3,
  gesture: 'clicks',
  style: 'line',
  hit(pts, at) {
    if (pts.length < 3) return false;
    const [a, b, c] = pts;
    const end = { x: c.x + (b.x - a.x), y: c.y + (b.y - a.y) };
    return distanceToSegment(at.x, at.y, a.x, a.y, b.x, b.y) <= HIT_TOLERANCE
      || distanceToSegment(at.x, at.y, c.x, c.y, end.x, end.y) <= HIT_TOLERANCE;
  },
  draw(ctx, { pts, drawing, color, chrome }) {
    if (pts.length < 3) return;
    const [a, b, c] = pts;
    const end = { x: c.x + (b.x - a.x), y: c.y + (b.y - a.y) };

    // The measured leg, then the copy. The copy is dashed: it has not happened.
    line(ctx, a.x, a.y, b.x, b.y);
    ctx.setLineDash([5, 4]);
    line(ctx, c.x, c.y, end.x, end.y);
    ctx.setLineDash([]);

    const [pa, pb, pc] = drawing.points;
    const projected = pc.price + (pb.price - pa.price);
    haloText(ctx, end.x + 4, end.y, formatPrice(projected), color, chrome, 'left', 'middle');
  },
};

/* ─── Bars pattern ──────────────────────────────────────────────────────── */

/**
 * The bars inside a time span, as OHLC in market units.
 *
 * Returned raw rather than scaled, because the two tools that use them want
 * different things: the bars pattern re-plots them somewhere else and the
 * anchored VWAP integrates them.
 */
function barsIn(env, fromMs, toMs) {
  const bars = env.bars();
  if (!Array.isArray(bars)) return [];
  const from = Math.min(fromMs, toMs) / 1000;
  const to = Math.max(fromMs, toMs) / 1000;
  return bars.filter((b) => b.time >= from && b.time <= to);
}

/* A copy of a stretch of bars, re-plotted from a third anchor. The copy keeps
 * the shape of the original — the same highs and lows relative to its own open
 * — which is what makes it a pattern rather than a screenshot. */
export const barspattern = {
  id: 'barspattern',
  name: 'Bars pattern',
  hint: 'Two clicks over a stretch of bars, a third for where to replay it',
  group: 'projection',
  icon: 'barspattern',
  points: 3,
  gesture: 'clicks',
  style: 'line',
  hit(pts, at) {
    if (pts.length < 3) return false;
    const width = Math.abs(pts[1].x - pts[0].x);
    return at.x >= pts[2].x - HIT_TOLERANCE && at.x <= pts[2].x + width + HIT_TOLERANCE
      && Math.abs(at.y - pts[2].y) <= Math.abs(pts[1].y - pts[0].y) + HIT_TOLERANCE;
  },
  draw(ctx, env) {
    const { pts, drawing, color, chrome } = env;
    if (pts.length < 3) return;
    const source = barsIn(env, drawing.points[0].time, drawing.points[1].time);
    if (source.length === 0) {
      haloText(ctx, pts[2].x, pts[2].y, 'no bars in that span', color, chrome, 'left', 'middle');
      return;
    }

    // The span the copy is drawn across, taken from the source span so the copy
    // is the same width as the original.
    const width = Math.abs(pts[1].x - pts[0].x) || 1;
    const step = width / source.length;
    const body = Math.max(1, step * 0.6);

    /* Prices are re-based onto the placement anchor and scaled by the same
     * pixels-per-price the source span was drawn at, so the copy is the same
     * size on screen as the original — not merely the same shape. */
    const priceSpan = Math.abs(drawing.points[1].price - drawing.points[0].price) || 1;
    const pixelSpan = Math.abs(pts[1].y - pts[0].y) || 1;
    const scale = pixelSpan / priceSpan;
    const base = source[0].open;
    const yFor = (price) => pts[2].y - (price - base) * scale;

    ctx.setLineDash([]);
    for (let i = 0; i < source.length; i++) {
      const bar = source[i];
      const x = pts[2].x + i * step + step / 2;
      const up = bar.close >= bar.open;
      ctx.strokeStyle = up ? chrome.pos : chrome.neg;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = 1;
      line(ctx, x, yFor(bar.high), x, yFor(bar.low));
      const top = yFor(Math.max(bar.open, bar.close));
      const height = Math.max(1, Math.abs(yFor(bar.close) - yFor(bar.open)));
      ctx.fillRect(x - body / 2, top, body, height);
    }
    ctx.strokeStyle = color;
    ctx.fillStyle = color;

    haloText(ctx, pts[2].x, pts[2].y - 6,
      `${source.length} bars`, color, chrome, 'left', 'bottom');
  },
};

/* ─── Ghost feed ────────────────────────────────────────────────────────── */

/**
 * A deterministic pseudo-random sequence.
 *
 * Seeded from the drawing's own id so the same ghost bars come back on every
 * frame, every repaint and every reload. Math.random here would redraw a
 * different future sixty times a second, which is unusable and would also make
 * the tool impossible to reason about.
 */
function seeded(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h ^= h << 13; h >>>= 0;
    h ^= h >> 17;
    h ^= h << 5; h >>>= 0;
    return h / 4294967296;
  };
}

/** How many synthetic bars a ghost feed invents across its span. */
const GHOST_BARS = 30;

export const ghostfeed = {
  id: 'ghostfeed',
  name: 'Ghost feed',
  hint: 'Invents bars across the box, to see how a setup would look playing out',
  group: 'projection',
  icon: 'ghostfeed',
  points: 2,
  gesture: 'drag',
  style: 'line',
  hit(pts, at) {
    const [a, b] = pts;
    if (!b) return false;
    return at.x >= Math.min(a.x, b.x) - HIT_TOLERANCE
      && at.x <= Math.max(a.x, b.x) + HIT_TOLERANCE
      && at.y >= Math.min(a.y, b.y) - HIT_TOLERANCE
      && at.y <= Math.max(a.y, b.y) + HIT_TOLERANCE;
  },
  draw(ctx, { pts, drawing, chrome }) {
    const [a, b] = pts;
    if (!b) return;
    const random = seeded(drawing.id);

    const left = Math.min(a.x, b.x);
    const width = Math.abs(b.x - a.x);
    const step = width / GHOST_BARS;
    const body = Math.max(1, step * 0.6);
    const amplitude = Math.abs(b.y - a.y) / 6;

    let y = a.y;
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
    for (let i = 0; i < GHOST_BARS; i++) {
      const x = left + i * step + step / 2;
      const open = y;
      const close = y + (random() - 0.5) * amplitude * 2;
      const high = Math.min(open, close) - random() * amplitude;
      const low = Math.max(open, close) + random() * amplitude;

      const up = close <= open; // y grows downwards, so a lower y is a rise
      ctx.strokeStyle = up ? chrome.pos : chrome.neg;
      ctx.fillStyle = ctx.strokeStyle;
      line(ctx, x, high, x, low);
      ctx.fillRect(x - body / 2, Math.min(open, close), body,
        Math.max(1, Math.abs(close - open)));
      y = close;
    }
  },
};

/* ─── Anchored VWAP ─────────────────────────────────────────────────────── */

export const anchoredvwap = {
  id: 'anchoredvwap',
  name: 'Anchored VWAP',
  hint: 'Volume-weighted average price, counted from the bar you click',
  group: 'projection',
  icon: 'anchoredvwap',
  points: 1,
  gesture: 'click',
  style: 'line',
  hit(pts, at, size, drawing, ctx, env) {
    const curve = env?.cache?.vwap;
    if (!curve || curve.length < 2) {
      // Before the curve exists, the anchor itself is the only thing to grab.
      return Math.hypot(at.x - pts[0].x, at.y - pts[0].y) <= HIT_TOLERANCE * 2;
    }
    return distanceToPolyline(at.x, at.y, curve) <= HIT_TOLERANCE;
  },
  draw(ctx, env) {
    const { pts, drawing, color, chrome, project } = env;
    const bars = env.bars();
    if (!Array.isArray(bars) || bars.length === 0) return;

    const from = drawing.points[0].time / 1000;
    let cumulativePV = 0;
    let cumulativeVolume = 0;
    const curve = [];

    for (const bar of bars) {
      if (bar.time < from) continue;
      const typical = (bar.high + bar.low + bar.close) / 3;
      // A feed with no volume would divide by zero on the first bar; counting
      // it as one share makes the line degrade to a typical-price average
      // rather than vanishing.
      const volume = Number.isFinite(bar.volume) && bar.volume > 0 ? bar.volume : 1;
      cumulativePV += typical * volume;
      cumulativeVolume += volume;
      const point = project({ time: bar.time * 1000, price: cumulativePV / cumulativeVolume });
      if (point) curve.push(point);
    }

    // Kept for the hit test, which cannot recompute it — it has no bars.
    if (env.cache) env.cache.vwap = curve;
    if (curve.length < 2) return;

    polyline(ctx, curve);
    const last = curve[curve.length - 1];
    haloText(ctx, last.x + 4, last.y, 'VWAP', color, chrome, 'left', 'middle');

    // The anchor itself, so it is clear which bar the average starts from.
    ctx.beginPath();
    ctx.arc(pts[0].x, pts[0].y, 3, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  },
};

export default [
  position, measure, daterange, pricerange, datepricerange, pricebarratio,
  forecast, projection, barspattern, ghostfeed, anchoredvwap,
];
