/* Drawing model — the vocabulary a drawing is described in.
 *
 * Anchors are (time, price) pairs, never pixels. A trend line drawn on the 15m
 * chart has to sit on the same two points when the chart is switched to 4h or
 * panned three months back, and only market coordinates survive that.
 *
 * Drawings belong to a symbol, not to a timeframe: a level that matters on the
 * hourly matters on the daily.
 *
 * This file is constants and normalisers only, and imports nothing. That is
 * load-bearing rather than tidy: the tool specs in tools/ need these values,
 * registry.js collects those specs, and factory.js asks the registry how many
 * anchors a type takes. If the vocabulary imported the registry back, the four
 * would form a cycle and whichever module happened to be entered first would
 * read half-initialised constants out of the others.
 */

/* One tool covers both directions of a position, because dragging an anchor
 * across the entry turns one into the other anyway. Two tools that behave
 * identically and then disagree with the picture are worse than one that reads
 * its direction off the geometry. These are the names used before 0.1.1;
 * drawings saved under them load as positions. */
export const LEGACY_POSITION_TYPES = ['long', 'short'];

/** Anchor order for the position tools, used by the renderer and the handles. */
export const ENTRY = 0;
export const STOP = 1;
export const TARGET = 2;

export function isPositionTool(type) {
  return type === 'position' || LEGACY_POSITION_TYPES.includes(type);
}

/** Palette offered in the toolbar; values resolve against the CSS tokens. */
export const DRAWING_COLORS = [
  { id: 'ind-1', label: 'Amber' },
  { id: 'ind-2', label: 'Violet' },
  { id: 'ind-3', label: 'Pink' },
  { id: 'ind-4', label: 'Orange' },
  { id: 'ind-5', label: 'Slate' },
  { id: 'accent', label: 'Midorii' },
];

/* An FVG box is coloured by the direction of the gap rather than by whatever
 * the toolbar had armed, so a marked imbalance reads the same way as the
 * indicator's. These are the indicator's own two defaults. It lands in the
 * normal `color` field, so the palette recolours it afterwards like anything
 * else. */
export const FVG_COLORS = { bull: 'candle-up-brd', bear: 'candle-down-body' };

/* Stroke widths offered for line-based drawings, in pixels. Finely stepped at
 * the thin end, because that is the end that gets used: these strokes sit on
 * top of candles, and the edges of a gap box are often only a few pixels apart
 * to begin with. */
export const LINE_WIDTHS = [1, 1.5, 2, 3];

/* The thickest width offered before this scale was narrowed. A drawing saved
 * with one of the old numbers clamps onto the nearest current width instead of
 * losing its stroke and snapping back to a hairline. */
const LEGACY_MAX_WIDTH = 4;

/* Dash patterns, named rather than stored as arrays: the numbers are a
 * rendering detail, and a saved file that carried them would freeze today's
 * spacing into every drawing ever made. */
export const LINE_STYLES = [
  { id: 'solid', label: 'Solid', dash: [] },
  { id: 'dashed', label: 'Dashed', dash: [6, 4] },
  { id: 'dotted', label: 'Dotted', dash: [1, 3] },
];

export const DEFAULT_LINE_STYLE = {
  width: 1,
  lineStyle: 'solid',
};

/** The dash pattern for a style id; an unknown id draws solid rather than not at all. */
export function dashPattern(lineStyle) {
  return LINE_STYLES.find((s) => s.id === lineStyle)?.dash ?? [];
}

/**
 * Clamps a stored width to one the toolbar can actually show.
 *
 * Anything outside the range this app has ever offered is not a width, it is
 * damage: 0 draws nothing, a negative throws in some engines, 99 is nonsense.
 * Those fall back. A number inside the range came from somewhere — an older
 * scale, a hand-edited file — and the nearest offered width is closer to that
 * intent than the default would be. A tie goes to the thinner of the two, since
 * a stroke that is too thin is easier to notice and fix than one that quietly
 * covers the candles under it.
 */
export function normalizeWidth(value) {
  if (!Number.isFinite(value)) return DEFAULT_LINE_STYLE.width;
  if (value < LINE_WIDTHS[0] || value > LEGACY_MAX_WIDTH) return DEFAULT_LINE_STYLE.width;

  return LINE_WIDTHS.reduce((best, w) => (
    Math.abs(w - value) < Math.abs(best - value) ? w : best
  ), LINE_WIDTHS[0]);
}

/* Zone colours for the position tools. The semantic pair leads, because that is
 * what almost everyone wants; the rest are there for telling several planned
 * trades apart on one chart. */
export const ZONE_COLORS = [
  { id: 'pos', label: 'Green' },
  { id: 'neg', label: 'Red' },
  { id: 'accent', label: 'Midorii' },
  { id: 'ind-1', label: 'Amber' },
  { id: 'ind-2', label: 'Violet' },
  { id: 'ind-3', label: 'Pink' },
  { id: 'ind-4', label: 'Orange' },
  { id: 'ind-5', label: 'Slate' },
];

export const DEFAULT_POSITION_STYLE = {
  profitColor: 'pos',
  lossColor: 'neg',
  /** Zone fill opacity, 0..1. */
  fillOpacity: 0.13,
};

export const MAX_FILL_OPACITY = 0.6;

/** Clamps a stored opacity into range; anything unusable falls back. */
export function normalizeOpacity(value) {
  if (!Number.isFinite(value)) return DEFAULT_POSITION_STYLE.fillOpacity;
  return Math.min(MAX_FILL_OPACITY, Math.max(0, value));
}

/* ─── Text ──────────────────────────────────────────────────────────────── */

/* Sizes offered for the annotation tools, in pixels. Three rather than a
 * spinner: a chart annotation is a caption, a heading or a marker, and the
 * sizes in between are choices nobody needs to make. */
export const TEXT_SIZES = [
  { id: 'sm', label: 'Small', px: 10 },
  { id: 'md', label: 'Medium', px: 13 },
  { id: 'lg', label: 'Large', px: 18 },
];

export const DEFAULT_TEXT_STYLE = {
  fontSize: 'md',
  bold: false,
  italic: false,
  /* Whether the text carries a filled plate behind it. Off by default: a
   * caption on a chart usually wants to sit *on* the price action, and the
   * halo the renderer puts down already keeps it readable. */
  boxed: false,
};

/** The pixel size for a stored id; an unknown one falls back rather than vanishing. */
export function textSizePx(id) {
  return TEXT_SIZES.find((s) => s.id === id)?.px ?? TEXT_SIZES[1].px;
}

/** Longest annotation accepted, in characters. */
export const MAX_TEXT_LENGTH = 500;

/**
 * Cleans a stored or typed annotation.
 *
 * Carriage returns are dropped so a string pasted from Windows does not draw a
 * blank line between every real one, and the length is capped — an annotation
 * is a note, and a runaway paste would otherwise be stored forever and painted
 * on every frame.
 */
export function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\r/g, '').slice(0, MAX_TEXT_LENGTH);
}

/* ─── Fib and Gann levels ───────────────────────────────────────────────── */

/* Extension levels, used by the trend-based tools. These run past 1 because
 * that is the whole point of an extension: where the move goes *after* it has
 * retraced. */
export const FIB_EXTENSION_LEVELS = [0, 0.618, 1, 1.618, 2.618, 3.618, 4.236];

/** Time-based fib steps, in bars, for the time zone and time extension tools. */
export const FIB_TIME_STEPS = [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89];

/** Ratios the speed-resistance and circle tools divide a move by. */
export const FIB_SPEED_RATIOS = [0.236, 0.382, 0.5, 0.618, 0.786, 1];

/* The Gann fan's eight angles, as price-per-bar ratios. Named the way traders
 * name them — 1x1 is the 45 degree line only when a bar is as wide as a unit of
 * price is tall, which is a property of the scale rather than of the fan. */
export const GANN_ANGLES = [
  { label: '8/1', ratio: 8 },
  { label: '4/1', ratio: 4 },
  { label: '3/1', ratio: 3 },
  { label: '2/1', ratio: 2 },
  { label: '1/1', ratio: 1 },
  { label: '1/2', ratio: 1 / 2 },
  { label: '1/3', ratio: 1 / 3 },
  { label: '1/4', ratio: 1 / 4 },
  { label: '1/8', ratio: 1 / 8 },
];

/** The grid a Gann box divides its two axes into. */
export const GANN_BOX_LEVELS = [0, 0.25, 0.382, 0.5, 0.618, 0.75, 1];
