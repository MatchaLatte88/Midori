/* Annotations: the tools whose content is words rather than geometry.
 *
 * Two things set this family apart from every other one.
 *
 * The first is that placing one is not the end of the gesture — a drawing with
 * no text in it is an invisible drawing, so the tools here are finished by
 * typing, and useDrawings opens an editor over the anchor as soon as the anchor
 * lands. A note abandoned without text is removed rather than stored.
 *
 * The second is that two of them do not live in market coordinates at all. An
 * anchored note is pinned to the pane, not to a bar: it is a caption on the
 * chart as a whole, and it has to stay where it was put when the chart is
 * panned. Those declare `space: 'screen'` and store a fraction of the pane
 * instead of a time and a price.
 */
import { HIT_TOLERANCE, distanceToSegment } from '../geometry.js';
import { textSizePx } from '../model.js';
import {
  LABEL_FONT, chip, fillRectAlpha, formatPrice, haloText, line,
} from '../render.js';

/* Padding inside a boxed annotation, and the gap between its lines, both as a
 * multiple of the font size so they hold at every text size. */
const PAD = 0.45;
const LEADING = 1.35;

/** The font a drawing's text is set in, honouring its size and emphasis. */
function textFont(drawing) {
  const px = textSizePx(drawing.fontSize);
  const weight = drawing.bold ? '600 ' : '';
  const slant = drawing.italic ? 'italic ' : '';
  return `${slant}${weight}${px}px "DM Mono", ui-monospace, monospace`;
}

/** The pixel box a drawing's text occupies, before it is placed anywhere. */
export function textMetrics(ctx, drawing) {
  ctx.font = textFont(drawing);
  const lines = (drawing.text || '').split('\n');
  const px = textSizePx(drawing.fontSize);
  const width = Math.max(0, ...lines.map((l) => ctx.measureText(l).width));
  return {
    lines,
    px,
    width: width + px * PAD * 2,
    height: lines.length * px * LEADING + px * PAD * 2,
  };
}

/**
 * Draws a drawing's text with its top-left corner at (x, y).
 *
 * A boxed annotation gets a filled plate; an unboxed one gets the halo every
 * other label on this chart uses, because it lands on candles and would
 * otherwise be unreadable wherever a wick crosses it.
 */
export function drawText(ctx, x, y, drawing, color, chrome) {
  const { lines, px, width, height } = textMetrics(ctx, drawing);
  const pad = px * PAD;
  // Restored at the end: an annotation is often drawn in the middle of a tool
  // that has its own stroke — see the note in haloText.
  const strokeWidth = ctx.lineWidth;
  const stroke = ctx.strokeStyle;

  if (drawing.boxed) {
    fillRectAlpha(ctx, color, 0.16, x, y, width, height);
    const dash = ctx.getLineDash();
    ctx.setLineDash([]);
    ctx.strokeStyle = color;
    ctx.strokeRect(x, y, width, height);
    ctx.setLineDash(dash);
  }

  ctx.font = textFont(drawing);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  lines.forEach((l, i) => {
    const lineY = y + pad + i * px * LEADING;
    if (!drawing.boxed) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = chrome.panel;
      ctx.lineJoin = 'round';
      ctx.strokeText(l, x + pad, lineY);
    }
    ctx.fillStyle = color;
    ctx.fillText(l, x + pad, lineY);
  });

  ctx.lineWidth = strokeWidth;
  ctx.strokeStyle = stroke;
  return { width, height };
}

/** Hit test for a block of text whose top-left corner is at the anchor. */
function textHit(offsetX = 0, offsetY = 0) {
  return (pts, at, size, drawing, ctx) => {
    if (pts.length === 0) return false;
    // The context is only there to measure text; without one, fall back to a
    // generous box so a note is never unpickable.
    const box = ctx ? textMetrics(ctx, drawing) : { width: 90, height: 20 };
    const x = pts[0].x + offsetX;
    const y = pts[0].y + offsetY;
    return at.x >= x - HIT_TOLERANCE && at.x <= x + box.width + HIT_TOLERANCE
      && at.y >= y - HIT_TOLERANCE && at.y <= y + box.height + HIT_TOLERANCE;
  };
}

/* ─── Plain text ────────────────────────────────────────────────────────── */

export const text = {
  id: 'text',
  name: 'Text',
  hint: 'Click where the note goes, then type it',
  group: 'text',
  icon: 'text',
  points: 1,
  gesture: 'click',
  style: 'text',
  editable: true,
  hit: textHit(),
  draw(ctx, { pts, drawing, color, chrome }) {
    drawText(ctx, pts[0].x, pts[0].y, drawing, color, chrome);
  },
};

/* Pinned to the pane rather than to a bar: this is a caption on the chart, and
 * it stays put while the chart is panned under it. */
export const anchoredtext = {
  id: 'anchoredtext',
  name: 'Anchored text',
  hint: 'Text pinned to the pane — it stays put when the chart is panned',
  group: 'text',
  icon: 'anchoredtext',
  points: 0,
  space: 'screen',
  gesture: 'click',
  style: 'text',
  editable: true,
  hit: textHit(),
  draw(ctx, { pts, drawing, color, chrome }) {
    drawText(ctx, pts[0].x, pts[0].y, drawing, color, chrome);
  },
};

/* ─── Notes ─────────────────────────────────────────────────────────────── */

/** How far a note's plate sits from the point it is pinned to. */
const NOTE_OFFSET = 14;

/* A note is text with a leader: the plate sits clear of the bar so it does not
 * cover it, and a short stalk says which bar it belongs to. */
function note(id, name, hint, icon, space) {
  return {
    id,
    name,
    hint,
    group: 'text',
    icon,
    points: space === 'screen' ? 0 : 1,
    ...(space ? { space } : {}),
    gesture: 'click',
    style: 'text',
    editable: true,
    hit: textHit(NOTE_OFFSET, -NOTE_OFFSET),
    draw(ctx, { pts, drawing, color, chrome }) {
      const { x, y } = pts[0];
      const boxX = x + NOTE_OFFSET;
      const boxY = y - NOTE_OFFSET;

      const dash = ctx.getLineDash();
      ctx.setLineDash([]);
      ctx.strokeStyle = color;
      line(ctx, x, y, boxX, boxY + 8);
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.setLineDash(dash);

      drawText(ctx, boxX, boxY, { ...drawing, boxed: true }, color, chrome);
    },
  };
}

export const noteTool = note('note', 'Note', 'A note pinned to one bar', 'note');
export const anchorednote = note(
  'anchorednote', 'Anchored note',
  'A note pinned to the pane rather than to a bar', 'anchorednote', 'screen',
);

/* ─── Callout ───────────────────────────────────────────────────────────── */

/* Two anchors: what is being pointed at, and where the bubble sits. Unlike a
 * note, the tail is as long as it needs to be — a callout is for labelling
 * something the label cannot sit on top of. */
export const callout = {
  id: 'callout',
  name: 'Callout',
  hint: 'Click what you mean, then where the bubble goes',
  group: 'text',
  icon: 'callout',
  points: 2,
  gesture: 'drag',
  style: 'text',
  editable: true,
  hit(pts, at, size, drawing, ctx) {
    if (pts.length < 2) return false;
    const box = ctx ? textMetrics(ctx, drawing) : { width: 90, height: 20 };
    const [target, bubble] = pts;
    const inBubble = at.x >= bubble.x - HIT_TOLERANCE
      && at.x <= bubble.x + box.width + HIT_TOLERANCE
      && at.y >= bubble.y - HIT_TOLERANCE
      && at.y <= bubble.y + box.height + HIT_TOLERANCE;
    return inBubble
      || distanceToSegment(at.x, at.y, target.x, target.y, bubble.x, bubble.y) <= HIT_TOLERANCE;
  },
  draw(ctx, { pts, drawing, color, chrome }) {
    if (pts.length < 2) return;
    const [target, bubble] = pts;
    const box = textMetrics(ctx, drawing);

    // The tail meets the plate on whichever side faces the target, so it never
    // crosses the text on its way there.
    const anchorX = target.x < bubble.x ? bubble.x : bubble.x + box.width;
    const anchorY = bubble.y + box.height / 2;

    const dash = ctx.getLineDash();
    ctx.setLineDash([]);
    ctx.strokeStyle = color;
    line(ctx, target.x, target.y, anchorX, anchorY);
    ctx.beginPath();
    ctx.arc(target.x, target.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.setLineDash(dash);

    drawText(ctx, bubble.x, bubble.y, { ...drawing, boxed: true }, color, chrome);
  },
};

/* ─── Markers that carry a word ─────────────────────────────────────────── */

/** Radius of the round comment marker. */
const COMMENT_R = 8;

export const comment = {
  id: 'comment',
  name: 'Comment',
  hint: 'A small marker on one bar; the text shows beside it',
  group: 'text',
  icon: 'comment',
  points: 1,
  gesture: 'click',
  style: 'text',
  editable: true,
  hit: (pts, at) => Math.hypot(at.x - pts[0].x, at.y - pts[0].y) <= COMMENT_R + HIT_TOLERANCE,
  draw(ctx, { pts, drawing, color, chrome }) {
    const { x, y } = pts[0];
    const dash = ctx.getLineDash();
    ctx.setLineDash([]);

    // A speech bubble: a disc with a tail at the bottom left.
    ctx.beginPath();
    ctx.arc(x, y, COMMENT_R, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x - 3, y + COMMENT_R - 1);
    ctx.lineTo(x - 1, y + COMMENT_R + 6);
    ctx.lineTo(x + 4, y + COMMENT_R - 2);
    ctx.closePath();
    ctx.fill();
    ctx.setLineDash(dash);

    if (drawing.text) {
      drawText(ctx, x + COMMENT_R + 6, y - textSizePx(drawing.fontSize) * 0.9,
        drawing, color, chrome);
    }
  },
};

export const signpost = {
  id: 'signpost',
  name: 'Signpost',
  hint: 'A stalk down to the bar, with the note on top',
  group: 'text',
  icon: 'signpost',
  points: 1,
  gesture: 'click',
  style: 'text',
  editable: true,
  hit(pts, at, size, drawing, ctx) {
    const { x, y } = pts[0];
    const box = ctx ? textMetrics(ctx, drawing) : { width: 90, height: 20 };
    const top = y - SIGNPOST_HEIGHT;
    if (Math.abs(at.x - x) <= HIT_TOLERANCE && at.y >= top && at.y <= y) return true;
    return at.x >= x - HIT_TOLERANCE && at.x <= x + box.width + HIT_TOLERANCE
      && at.y >= top - box.height - HIT_TOLERANCE && at.y <= top + HIT_TOLERANCE;
  },
  draw(ctx, { pts, drawing, color, chrome }) {
    const { x, y } = pts[0];
    const top = y - SIGNPOST_HEIGHT;
    const dash = ctx.getLineDash();
    ctx.setLineDash([]);
    ctx.strokeStyle = color;
    line(ctx, x, y, x, top);
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.setLineDash(dash);

    const box = textMetrics(ctx, drawing);
    drawText(ctx, x, top - box.height, { ...drawing, boxed: true }, color, chrome);
  },
};

/** How tall a signpost's stalk stands above the bar it marks. */
const SIGNPOST_HEIGHT = 46;

/** Flag dimensions in pixels. */
const FLAG_W = 16;
const FLAG_H = 11;
const FLAG_POLE = 24;

export const flag = {
  id: 'flag',
  name: 'Flag',
  hint: 'A flag on one bar — the text shows on hover and in the object list',
  group: 'text',
  icon: 'flag',
  points: 1,
  gesture: 'click',
  style: 'text',
  /* The only annotation that does not open an editor. A flag is a bookmark:
   * its whole job is to be spotted on a chart from across the room, and asking
   * for a caption every time would make it slower to place than the thing it
   * replaces. Its text is still editable from the object list. */
  editable: false,
  hit(pts, at) {
    const { x, y } = pts[0];
    return at.x >= x - HIT_TOLERANCE && at.x <= x + FLAG_W + HIT_TOLERANCE
      && at.y >= y - FLAG_POLE - HIT_TOLERANCE && at.y <= y + HIT_TOLERANCE;
  },
  draw(ctx, { pts, drawing, color, chrome }) {
    const { x, y } = pts[0];
    const dash = ctx.getLineDash();
    ctx.setLineDash([]);
    ctx.strokeStyle = color;
    line(ctx, x, y, x, y - FLAG_POLE);
    ctx.fillStyle = color;
    ctx.fillRect(x, y - FLAG_POLE, FLAG_W, FLAG_H);
    ctx.setLineDash(dash);

    if (drawing.text) {
      haloText(ctx, x + FLAG_W + 4, y - FLAG_POLE + FLAG_H / 2,
        drawing.text.split('\n')[0], color, chrome, 'left', 'middle');
    }
  },
};

/* ─── Sticker ───────────────────────────────────────────────────────────── */

/** How much bigger a sticker is than the text size it was given. */
const STICKER_SCALE = 2.2;

/* A glyph on the chart, at a size meant to be spotted rather than read. It is
 * a text drawing with a different renderer: an emoji is one grapheme, so a
 * separate storage shape would buy nothing, and everything the annotations
 * already do — colour, size, the editor, the object list — applies unchanged.
 * The editor offers a row of glyphs; anything else the system emoji picker can
 * produce is typed in the same field. */
export const sticker = {
  id: 'sticker',
  name: 'Sticker',
  hint: 'A glyph on one bar — pick one, or type any character',
  group: 'text',
  icon: 'sticker',
  points: 1,
  gesture: 'click',
  style: 'text',
  editable: true,
  /** Offered in the editor. Enough to mark a chart, not a keyboard. */
  glyphs: ['⭐', '🔺', '🔻', '❗', '❓', '✅', '❌', '👀', '🔒', '💡', '🎯', '🔥'],
  hit(pts, at, size, drawing) {
    const reach = textSizePx(drawing.fontSize) * STICKER_SCALE * 0.6;
    return Math.abs(at.x - pts[0].x) <= reach && Math.abs(at.y - pts[0].y) <= reach;
  },
  draw(ctx, { pts, drawing, color }) {
    const px = textSizePx(drawing.fontSize) * STICKER_SCALE;
    ctx.font = `${px}px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    /* No halo. A colour emoji paints its own glyph and a stroke behind it comes
     * out as a smear; the ones that are not coloured take the drawing's colour
     * like any other text. */
    ctx.fillStyle = color;
    ctx.fillText(drawing.text || '⭐', pts[0].x, pts[0].y);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  },
};

/* ─── Price labels ──────────────────────────────────────────────────────── */

export const pricelabel = {
  id: 'pricelabel',
  name: 'Price label',
  hint: 'A chip stating the price at one point',
  group: 'text',
  icon: 'pricelabel',
  points: 1,
  gesture: 'click',
  style: 'line',
  hit(pts, at, size, drawing, ctx) {
    const width = ctx
      ? (ctx.measureText(formatPrice(drawing.points[0].price)).width + 8) : 70;
    return at.x >= pts[0].x - HIT_TOLERANCE && at.x <= pts[0].x + width + HIT_TOLERANCE
      && Math.abs(at.y - pts[0].y) <= 8 + HIT_TOLERANCE;
  },
  draw(ctx, { pts, drawing, color, chrome }) {
    ctx.font = LABEL_FONT;
    chip(ctx, pts[0].x, pts[0].y, formatPrice(drawing.points[0].price), color, chrome);
  },
};

/* The price and a note about it. Stored separately from the price so the note
 * survives the anchor being dragged to a different level. */
export const pricenote = {
  id: 'pricenote',
  name: 'Price note',
  hint: 'A price, and a note about why it matters',
  group: 'text',
  icon: 'pricenote',
  points: 1,
  gesture: 'click',
  style: 'text',
  editable: true,
  hit: textHit(0, -8),
  draw(ctx, { pts, drawing, color, chrome }) {
    const { x, y } = pts[0];
    const withPrice = {
      ...drawing,
      boxed: true,
      text: `${formatPrice(drawing.points[0].price)}${drawing.text ? `\n${drawing.text}` : ''}`,
    };
    drawText(ctx, x, y - 8, withPrice, color, chrome);
  },
};

export default [
  text, anchoredtext, noteTool, anchorednote, callout,
  comment, signpost, flag, sticker, pricelabel, pricenote,
];
