/* Making, validating and editing a drawing.
 *
 * Split from model.js because these functions have to ask the registry what a
 * type is — how many anchors it takes, whether it is anchored to the pane, what
 * moves when one of its handles does — and model.js must stay free of that
 * import so the vocabulary, the tool specs and the registry cannot form a
 * cycle. See the note at the top of model.js.
 */
import {
  DEFAULT_LINE_STYLE, DEFAULT_POSITION_STYLE, DEFAULT_TEXT_STYLE, LEGACY_POSITION_TYPES,
  LINE_STYLES, TEXT_SIZES, isPositionTool, normalizeOpacity, normalizeText, normalizeWidth,
} from './model.js';
import { DRAWING_TYPES, isScreenSpace, isVariable, pointsRequired, specFor, styleKind } from './registry.js';

let nextLocalId = 1;

function freshId() {
  return `d${Date.now().toString(36)}${nextLocalId++}`;
}

/** Every anchor has to be a real point on the chart, or the drawing is damage. */
function validatePoints(type, points) {
  const required = pointsRequired(type);

  if (isScreenSpace(type)) {
    if (Array.isArray(points) && points.length > 0) {
      throw new Error(`createDrawing: ${type} is anchored to the pane and takes no points`);
    }
    return [];
  }

  if (!Array.isArray(points)) {
    throw new Error(`createDrawing: ${type} needs exactly ${required} point(s), got ${points?.length}`);
  }
  if (isVariable(type) ? points.length < required : points.length !== required) {
    const what = isVariable(type) ? `at least ${required}` : `exactly ${required}`;
    throw new Error(`createDrawing: ${type} needs ${what} point(s), got ${points.length}`);
  }
  for (const p of points) {
    if (!Number.isFinite(p?.time) || !Number.isFinite(p?.price)) {
      throw new Error(`createDrawing: every point needs a finite time and price, got ${JSON.stringify(p)}`);
    }
  }
  return points.map((p) => ({ time: p.time, price: p.price }));
}

/**
 * A pane-relative anchor, as a fraction of the pane in each axis.
 *
 * Not clamped to 0..1: a caption dragged past the edge is still where the user
 * put it, and clamping would silently move it back on the next pan.
 */
function validateScreen(type, screen) {
  if (!isScreenSpace(type)) return null;
  if (!Number.isFinite(screen?.x) || !Number.isFinite(screen?.y)) {
    throw new Error(`createDrawing: ${type} needs a screen anchor with a finite x and y`);
  }
  return { x: screen.x, y: screen.y };
}

/** Builds a drawing. Ids are local and only need to be unique per symbol. */
export function createDrawing(type, points, options = {}) {
  if (!DRAWING_TYPES.includes(type)) {
    throw new Error(`createDrawing: unknown type "${type}"`);
  }

  const drawing = {
    id: freshId(),
    type,
    points: validatePoints(type, points),
    color: options.color ?? 'ind-1',
    width: normalizeWidth(options.width),
    lineStyle: LINE_STYLES.some((s) => s.id === options.lineStyle)
      ? options.lineStyle : DEFAULT_LINE_STYLE.lineStyle,
    /* Put away rather than deleted. A level that is right but in the way is the
     * ordinary case on a chart with a season of work on it, and the only thing
     * that used to be on offer there was the bin. */
    hidden: false,
    /* Locked drawings are painted but cannot be picked up. The point is a chart
     * whose structure is settled: the levels stay, and a stray drag lands on
     * the chart instead of dragging a level nobody meant to touch. */
    locked: false,
    createdAt: Date.now(),
  };

  const screen = validateScreen(type, options.screen);
  if (screen) drawing.screen = screen;

  /* Which way the gap goes. The one stored fact in this model that cannot be
   * read back off the anchors: a box knows its two prices, not whether the
   * imbalance that left them came from a move up or down. */
  if (type === 'fvg') {
    if (options.direction !== 'bull' && options.direction !== 'bear') {
      throw new Error(`createDrawing: fvg needs a direction of "bull" or "bear", got ${options.direction}`);
    }
    drawing.direction = options.direction;
  }

  // Zone styling only means something on a position block; other types would
  // just carry dead fields around.
  if (styleKind(type) === 'position') {
    drawing.profitColor = options.profitColor ?? DEFAULT_POSITION_STYLE.profitColor;
    drawing.lossColor = options.lossColor ?? DEFAULT_POSITION_STYLE.lossColor;
    drawing.fillOpacity = normalizeOpacity(options.fillOpacity);
  }

  // Likewise the text fields: only the annotations have anything to say.
  if (styleKind(type) === 'text') {
    drawing.text = normalizeText(options.text);
    drawing.fontSize = TEXT_SIZES.some((s) => s.id === options.fontSize)
      ? options.fontSize : DEFAULT_TEXT_STYLE.fontSize;
    drawing.bold = options.bold === true;
    drawing.italic = options.italic === true;
    drawing.boxed = options.boxed === true;
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

  const points = [];
  if (isScreenSpace(type)) {
    if (!Number.isFinite(raw.screen?.x) || !Number.isFinite(raw.screen?.y)) return null;
  } else {
    if (!Array.isArray(raw.points)) return null;
    const required = pointsRequired(type);
    if (isVariable(type) ? raw.points.length < required : raw.points.length !== required) return null;
    for (const p of raw.points) {
      if (!Number.isFinite(p?.time) || !Number.isFinite(p?.price)) return null;
      points.push({ time: p.time, price: p.price });
    }
  }

  const drawing = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : freshId(),
    type,
    points,
    color: typeof raw.color === 'string' ? raw.color : 'ind-1',
    /* Stroke settings written before these fields existed, or written badly,
     * fall back to the defaults rather than costing the drawing. */
    width: normalizeWidth(raw.width),
    lineStyle: LINE_STYLES.some((s) => s.id === raw.lineStyle)
      ? raw.lineStyle : DEFAULT_LINE_STYLE.lineStyle,
    /* Anything but an explicit true is showing, and unlocked. A file written
       before these fields existed therefore comes back visible and editable,
       which is the only safe reading: a drawing nobody hid must not come back
       hidden, and one nobody locked must not come back stuck. */
    hidden: raw.hidden === true,
    locked: raw.locked === true,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
  };

  if (isScreenSpace(type)) drawing.screen = { x: raw.screen.x, y: raw.screen.y };

  /* A gap with no readable direction cannot be coloured, and the anchors
   * cannot supply one — so the entry is lost rather than guessed at. Unlike the
   * styling below, this is content, not decoration. */
  if (type === 'fvg') {
    if (raw.direction !== 'bull' && raw.direction !== 'bear') return null;
    drawing.direction = raw.direction;
  }

  if (styleKind(type) === 'position') {
    // Styling written before these fields existed, or written badly, falls back
    // to the defaults rather than costing the drawing.
    drawing.profitColor = typeof raw.profitColor === 'string'
      ? raw.profitColor : DEFAULT_POSITION_STYLE.profitColor;
    drawing.lossColor = typeof raw.lossColor === 'string'
      ? raw.lossColor : DEFAULT_POSITION_STYLE.lossColor;
    drawing.fillOpacity = normalizeOpacity(raw.fillOpacity);
  }

  if (styleKind(type) === 'text') {
    /* An annotation with no text is not corrupt, it is empty — a note whose
     * editor was dismissed. It loads, and the object list is where it can be
     * given words or deleted. */
    drawing.text = normalizeText(raw.text);
    drawing.fontSize = TEXT_SIZES.some((s) => s.id === raw.fontSize)
      ? raw.fontSize : DEFAULT_TEXT_STYLE.fontSize;
    drawing.bold = raw.bold === true;
    drawing.italic = raw.italic === true;
    drawing.boxed = raw.boxed === true;
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

/**
 * Moves a pane-anchored drawing by a delta expressed as a fraction of the pane.
 *
 * A separate function rather than a branch inside translateDrawing: the two
 * take different units, and one function that silently reinterpreted its
 * arguments depending on the drawing would be the kind of thing that produces a
 * caption several thousand pixels off screen.
 */
export function translateScreen(drawing, deltaX, deltaY) {
  if (!drawing.screen) return drawing;
  return {
    ...drawing,
    screen: { x: drawing.screen.x + deltaX, y: drawing.screen.y + deltaY },
  };
}

/**
 * Moves a single anchor, for handle dragging.
 *
 * A tool may declare that another anchor has to follow — a position block has
 * one right edge shared by its stop and target, and dragging either of them
 * must move both or the block tears in half.
 */
export function moveAnchor(drawing, index, time, price) {
  if (index < 0 || index >= drawing.points.length) {
    throw new Error(`moveAnchor: index ${index} out of range for ${drawing.type}`);
  }

  const points = drawing.points.map((p, i) => (i === index ? { time, price } : p));

  const link = specFor(drawing.type)?.linkAnchor?.(index);
  if (link && link.index < points.length) {
    points[link.index] = link.axis === 'time'
      ? { ...points[link.index], time }
      : { ...points[link.index], price };
  }

  return { ...drawing, points };
}

/** Replaces an annotation's words, leaving everything else alone. */
export function setText(drawing, text) {
  return { ...drawing, text: normalizeText(text) };
}

/* Re-exported so callers that only deal in drawings do not have to know which
 * of the two vocabulary modules a helper came from. */
export { isPositionTool };
