/* Drawing model — what a drawing is, and what it means to store one.
 *
 * Anchors are (time, price) pairs, never pixels. A trend line drawn on the 15m
 * chart has to sit on the same two points when the chart is switched to 4h or
 * panned three months back, and only market coordinates survive that.
 *
 * Drawings belong to a symbol, not to a timeframe: a level that matters on the
 * hourly matters on the daily.
 */
import { pointsRequired } from './geometry.js';

export const TOOLS = [
  {
    id: 'cursor',
    name: 'Cursor',
    hint: 'Select and move drawings',
    icon: 'cursor',
  },
  {
    id: 'trendline',
    name: 'Trend line',
    hint: 'Two points, drawn between them',
    icon: 'trendline',
  },
  {
    id: 'ray',
    name: 'Ray',
    hint: 'Two points, extended forward',
    icon: 'ray',
  },
  {
    id: 'horizontal',
    name: 'Horizontal line',
    hint: 'A price level across the chart',
    icon: 'horizontal',
  },
  {
    id: 'vertical',
    name: 'Vertical line',
    hint: 'A moment in time',
    icon: 'vertical',
  },
  {
    id: 'rectangle',
    name: 'Rectangle',
    hint: 'A zone in price and time',
    icon: 'rectangle',
  },
  {
    id: 'fib',
    name: 'Fib retracement',
    hint: 'Drag from the start of a move to its end',
    icon: 'fib',
  },
  {
    id: 'measure',
    name: 'Measure',
    hint: 'Change in price, percent and bars',
    icon: 'measure',
  },
  {
    id: 'rangeprofile',
    name: 'Range volume profile',
    hint: 'Drag across a stretch of chart to profile the volume traded in it',
    icon: 'rangeprofile',
  },
  {
    id: 'position',
    name: 'Position',
    hint: 'Drag from the entry to the stop — down for a long, up for a short',
    icon: 'position',
  },
];

/* One tool covers both directions, because dragging an anchor across the entry
 * turns one into the other anyway. Two tools that behave identically and then
 * disagree with the picture are worse than one that reads its direction off the
 * geometry. These are the names used before 0.1.1; drawings saved under them
 * load as positions. */
export const LEGACY_POSITION_TYPES = ['long', 'short'];

/** Anchor order for the position tools, used by the renderer and the handles. */
export const ENTRY = 0;
export const STOP = 1;
export const TARGET = 2;

export function isPositionTool(type) {
  return type === 'position' || LEGACY_POSITION_TYPES.includes(type);
}

export const DRAWING_TYPES = TOOLS.filter((t) => t.id !== 'cursor').map((t) => t.id);

/** Palette offered in the toolbar; values resolve against the CSS tokens. */
export const DRAWING_COLORS = [
  { id: 'ind-1', label: 'Amber' },
  { id: 'ind-2', label: 'Violet' },
  { id: 'ind-3', label: 'Pink' },
  { id: 'ind-4', label: 'Orange' },
  { id: 'ind-5', label: 'Slate' },
  { id: 'accent', label: 'Midori' },
];

/* Zone colours for the position tools. The semantic pair leads, because that is
 * what almost everyone wants; the rest are there for telling several planned
 * trades apart on one chart. */
export const ZONE_COLORS = [
  { id: 'pos', label: 'Green' },
  { id: 'neg', label: 'Red' },
  { id: 'accent', label: 'Midori' },
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

let nextLocalId = 1;

/** Builds a drawing. Ids are local and only need to be unique per symbol. */
export function createDrawing(type, points, options = {}) {
  if (!DRAWING_TYPES.includes(type)) {
    throw new Error(`createDrawing: unknown type "${type}"`);
  }
  const required = pointsRequired(type);
  if (!Array.isArray(points) || points.length !== required) {
    throw new Error(`createDrawing: ${type} needs exactly ${required} point(s), got ${points?.length}`);
  }
  for (const p of points) {
    if (!Number.isFinite(p?.time) || !Number.isFinite(p?.price)) {
      throw new Error(`createDrawing: every point needs a finite time and price, got ${JSON.stringify(p)}`);
    }
  }

  const drawing = {
    id: `d${Date.now().toString(36)}${nextLocalId++}`,
    type,
    points: points.map((p) => ({ time: p.time, price: p.price })),
    color: options.color ?? 'ind-1',
    width: options.width ?? 1,
    createdAt: Date.now(),
  };

  // Zone styling only means something on a position block; other types would
  // just carry dead fields around.
  if (isPositionTool(type)) {
    drawing.profitColor = options.profitColor ?? DEFAULT_POSITION_STYLE.profitColor;
    drawing.lossColor = options.lossColor ?? DEFAULT_POSITION_STYLE.lossColor;
    drawing.fillOpacity = normalizeOpacity(options.fillOpacity);
  }

  return drawing;
}

/**
 * Validates a drawing loaded from disk. Returns null for anything malformed —
 * one corrupt entry should cost its own drawing, not the whole file.
 */
export function parseDrawing(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!DRAWING_TYPES.includes(raw.type) && !LEGACY_POSITION_TYPES.includes(raw.type)) return null;
  // A long or short saved before the two were merged becomes a position; its
  // direction comes from the anchors it already has.
  const type = LEGACY_POSITION_TYPES.includes(raw.type) ? 'position' : raw.type;
  if (!Array.isArray(raw.points)) return null;

  const required = pointsRequired(type);
  if (raw.points.length !== required) return null;

  const points = [];
  for (const p of raw.points) {
    if (!Number.isFinite(p?.time) || !Number.isFinite(p?.price)) return null;
    points.push({ time: p.time, price: p.price });
  }

  const drawing = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `d${Date.now().toString(36)}${nextLocalId++}`,
    type,
    points,
    color: typeof raw.color === 'string' ? raw.color : 'ind-1',
    width: Number.isFinite(raw.width) ? raw.width : 1,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
  };

  if (isPositionTool(type)) {
    // Styling written before these fields existed, or written badly, falls back
    // to the defaults rather than costing the drawing.
    drawing.profitColor = typeof raw.profitColor === 'string'
      ? raw.profitColor : DEFAULT_POSITION_STYLE.profitColor;
    drawing.lossColor = typeof raw.lossColor === 'string'
      ? raw.lossColor : DEFAULT_POSITION_STYLE.lossColor;
    drawing.fillOpacity = normalizeOpacity(raw.fillOpacity);
  }

  return drawing;
}

/** Moves every anchor of a drawing by a delta in market coordinates. */
export function translateDrawing(drawing, deltaTime, deltaPrice) {
  return {
    ...drawing,
    points: drawing.points.map((p) => ({
      time: p.time + deltaTime,
      price: p.price + deltaPrice,
    })),
  };
}

/** Moves a single anchor, for handle dragging. */
export function moveAnchor(drawing, index, time, price) {
  if (index < 0 || index >= drawing.points.length) {
    throw new Error(`moveAnchor: index ${index} out of range for ${drawing.type}`);
  }

  const points = drawing.points.map((p, i) => (i === index ? { time, price } : p));

  /* A position block has one right edge, shared by the stop and target anchors.
   * Dragging either of them must move both, or the block tears in half. The
   * entry anchor owns the left edge on its own. */
  if (isPositionTool(drawing.type) && (index === STOP || index === TARGET)) {
    const other = index === STOP ? TARGET : STOP;
    points[other] = { ...points[other], time };
  }

  return { ...drawing, points };
}
