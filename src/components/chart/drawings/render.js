/* Canvas helpers shared by every drawing tool.
 *
 * Split out of drawingPrimitive.js when the tool set grew past a handful:
 * eighty-odd renderers cannot each reach into the primitive's private methods, and
 * a tool that lives in its own file needs the same stroke, fill and label
 * primitives as every other one. Nothing here knows what a drawing is — it
 * takes a context and coordinates, which is what makes it usable from any of
 * them.
 *
 * All of it works in media coordinates, after the chart has converted time and
 * price. See geometry.js for why that boundary sits where it does.
 */

/** Resolves a CSS token id to its value, falling back to the accent. */
export function tokenColor(id) {
  const s = getComputedStyle(document.documentElement);
  const value = s.getPropertyValue(`--${id}`).trim();
  return value || s.getPropertyValue('--accent').trim();
}

/** The palette the chrome of a drawing is painted in — text, ground, semantics. */
export function chromeColors() {
  const s = getComputedStyle(document.documentElement);
  return {
    text: s.getPropertyValue('--chart-text').trim(),
    panel: s.getPropertyValue('--chart-bg').trim(),
    pos: s.getPropertyValue('--pos').trim(),
    neg: s.getPropertyValue('--neg').trim(),
    line: s.getPropertyValue('--line').trim(),
  };
}

/**
 * Fills a rectangle at a given opacity.
 *
 * Opacity is applied in exactly one place — globalAlpha — and never also baked
 * into the colour. Doing both multiplies them: a zone asked for at 0.13 came
 * out at 0.017, and a fib band at 0.005, which is invisible. Going through
 * globalAlpha alone also works with any colour notation a token might hold,
 * not just hex.
 */
export function fillRectAlpha(ctx, color, alpha, x, y, width, height) {
  const previous = ctx.globalAlpha;
  ctx.globalAlpha = previous * alpha;
  ctx.fillStyle = color;
  ctx.fillRect(x, y, width, height);
  ctx.globalAlpha = previous;
}

/** Fills the current path at a given opacity, on the same terms as fillRectAlpha. */
export function fillPathAlpha(ctx, color, alpha) {
  const previous = ctx.globalAlpha;
  ctx.globalAlpha = previous * alpha;
  ctx.fillStyle = color;
  ctx.fill();
  ctx.globalAlpha = previous;
}

/** Fills a polygon given as screen points, at a given opacity. */
export function fillPolygonAlpha(ctx, color, alpha, pts) {
  if (pts.length < 3) return;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  fillPathAlpha(ctx, color, alpha);
}

export function line(ctx, x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

/** Strokes a run of points as one open path. */
export function polyline(ctx, pts) {
  if (pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
}

/** Strokes a closed polygon through the given points. */
export function polygon(ctx, pts) {
  if (pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.stroke();
}

/* How far past its second point an extended line runs. The pane's own diagonal
 * would be enough for a line drawn through it, but an anchor can sit far off
 * screen while the line it defines still crosses the visible pane — so the
 * reach is a generous multiple rather than an exact fit. Cheap: it is one
 * lineTo, and the canvas clips the rest for free. */
const REACH = 12;

/**
 * Strokes the ray from a through b, running past b to well beyond the pane.
 *
 * Clipping to the pane rectangle would be the exact answer, but the canvas
 * already clips, and the exact version needs a Liang-Barsky against four edges
 * for every ray on the chart. Overshooting is the cheaper equivalent.
 */
export function ray(ctx, ax, ay, bx, by, size) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len === 0) return;
  const reach = (size.width + size.height) * REACH;
  line(ctx, ax, ay, ax + (dx / len) * reach, ay + (dy / len) * reach);
}

/** Strokes the whole infinite line through a and b. */
export function extendedLine(ctx, ax, ay, bx, by, size) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len === 0) return;
  const reach = (size.width + size.height) * REACH;
  line(ctx,
    ax - (dx / len) * reach, ay - (dy / len) * reach,
    ax + (dx / len) * reach, ay + (dy / len) * reach);
}

/* Arrowhead size in pixels. Fixed rather than scaled with the stroke: a head
 * that grew with a 3px line would swamp the line it terminates, and the head
 * is a marker rather than part of the stroke weight. */
const HEAD = 9;
const HEAD_ANGLE = Math.PI / 7;

/** Draws a filled arrowhead at (x, y), pointing away from (fromX, fromY). */
export function arrowHead(ctx, fromX, fromY, x, y, color, scale = 1) {
  const angle = Math.atan2(y - fromY, x - fromX);
  const size = HEAD * scale;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - size * Math.cos(angle - HEAD_ANGLE), y - size * Math.sin(angle - HEAD_ANGLE));
  ctx.lineTo(x - size * Math.cos(angle + HEAD_ANGLE), y - size * Math.sin(angle + HEAD_ANGLE));
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

/** The font every drawing labels itself in. One place, so they all match. */
export const LABEL_FONT = '10px "DM Mono", ui-monospace, monospace';
export const LABEL_LINE = 13;

/**
 * A filled label chip with its text knocked out of it.
 *
 * `align` says which side of the chip the given x is, which is how a label
 * stays inside the shape it belongs to rather than hanging off an edge where
 * the pane would clip it.
 */
export function chip(ctx, x, y, text, color, chrome, align = 'left') {
  ctx.font = LABEL_FONT;
  const width = ctx.measureText(text).width + 8;
  const left = align === 'right' ? x - width : align === 'center' ? x - width / 2 : x;

  ctx.fillStyle = color;
  ctx.fillRect(left, y - 8, width, 16);
  ctx.fillStyle = chrome.panel;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, left + 4, y);
  ctx.fillStyle = color;
  return { left, width };
}

/** A multi-line chip, for the tools that report a set of numbers at once. */
export function chipLines(ctx, x, y, lines, color, chrome, align = 'center') {
  ctx.font = LABEL_FONT;
  const width = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 12;
  const height = lines.length * LABEL_LINE + 8;
  const left = align === 'right' ? x - width : align === 'center' ? x - width / 2 : x;

  ctx.fillStyle = color;
  ctx.fillRect(left, y, width, height);
  ctx.fillStyle = chrome.panel;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  lines.forEach((l, i) => ctx.fillText(l, left + 6, y + 5 + i * LABEL_LINE));
  ctx.fillStyle = color;
  return { left, width, height };
}

/**
 * Plain text with no chip behind it, for labels that sit on a line.
 *
 * A halo in the chart's own ground colour goes down first: these land on top
 * of candles, and without it a level's price is unreadable wherever a wick
 * happens to cross it.
 */
export function haloText(ctx, x, y, text, color, chrome, align = 'left', baseline = 'bottom') {
  /* The stroke settings are put back afterwards. Most tools label themselves
   * from inside a loop that also draws lines, and a halo left behind would make
   * the next stroke three pixels wide in the caller's own colour — a bug that
   * only shows on the second level of a fib and is baffling when it does. */
  const width = ctx.lineWidth;
  const stroke = ctx.strokeStyle;

  ctx.font = LABEL_FONT;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.lineWidth = 3;
  ctx.strokeStyle = chrome.panel;
  ctx.lineJoin = 'round';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);

  ctx.lineWidth = width;
  ctx.strokeStyle = stroke;
  ctx.textAlign = 'left';
}

/** Prices span BTC at 100k and altcoins at 0.00001 — pick decimals to match. */
export function formatPrice(p) {
  const abs = Math.abs(p);
  const decimals = abs >= 1000 ? 2 : abs >= 1 ? 4 : 8;
  return p.toLocaleString('en-GB', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** A signed percentage, or an em dash when there was nothing to divide by. */
export function formatPercent(v) {
  return v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}
