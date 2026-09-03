/* Renders every drawing on the chart through one pane primitive.
 *
 * One primitive rather than one per drawing: the library rebuilds its renderer
 * list whenever primitives change, and a chart with forty levels on it would
 * otherwise churn that list on every edit.
 *
 * Drawn at zOrder 'top' — unlike the volume profile, a level the user placed
 * by hand should sit above the candles, because that is where they put it.
 *
 * What each tool actually paints lives with the tool, in tools/. This file owns
 * only what is true of all of them: converting anchors to pixels, setting the
 * stroke, and drawing the handles.
 */
import { HANDLE_RADIUS } from './geometry.js';
import { dashPattern } from './model.js';
import { specFor } from './registry.js';
import { chromeColors, tokenColor } from './render.js';

export { formatPrice } from './render.js';

class DrawingRenderer {
  constructor(source) {
    this._source = source;
    /* Per-drawing scratch space, keyed by id. Two tools need something worked
     * out during the paint to still be there when the pointer asks about them —
     * an anchored VWAP's curve costs a pass over every bar, and the hit test
     * has no bars to recompute it from. Cleared per frame for drawings that are
     * no longer on the chart, so it cannot grow without bound. */
    this._cache = new Map();
  }

  /** The scratch object for one drawing, created on first use. */
  cacheFor(id) {
    let entry = this._cache.get(id);
    if (!entry) {
      entry = {};
      this._cache.set(id, entry);
    }
    return entry;
  }

  draw(target) {
    const { drawings, project, selectedId, draft } = this._source;
    if (!project) return;

    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.save();
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      /* Colours are resolved once for the frame rather than once per drawing.
       * Every lookup is a getComputedStyle on the document element, and a chart
       * with forty drawings on it at sixty frames a second was making several
       * thousand of those a second — all of them returning the same six values,
       * since the tokens cannot change inside one paint. */
      const palette = new Map();
      const colorOf = (id) => {
        if (!palette.has(id)) palette.set(id, tokenColor(id));
        return palette.get(id);
      };
      const chrome = chromeColors();

      const live = new Set();
      for (const drawing of drawings) {
        live.add(drawing.id);
        const pts = this.screenPoints(drawing, mediaSize);
        if (!pts) continue; // off the current scale
        this._drawOne(ctx, mediaSize, drawing, pts, drawing.id === selectedId, colorOf, chrome);
      }

      // The shape currently being dragged out, before it is committed.
      if (draft && (draft.points.length > 0 || draft.screen)) {
        const pts = this.screenPoints(draft, mediaSize);
        if (pts) {
          ctx.globalAlpha = 0.75;
          this._drawOne(ctx, mediaSize, draft, pts, false, colorOf, chrome);
          ctx.globalAlpha = 1;
        }
      }

      for (const id of this._cache.keys()) {
        if (!live.has(id)) this._cache.delete(id);
      }

      ctx.restore();
    });
  }

  /**
   * A drawing's anchors in pixels, or null when any of them is off the scale.
   *
   * A pane-anchored drawing does not go through the chart at all: its anchor is
   * a fraction of the pane, so it survives panning by construction.
   */
  screenPoints(drawing, size) {
    if (drawing.screen) {
      return [{ x: drawing.screen.x * size.width, y: drawing.screen.y * size.height }];
    }
    const pts = drawing.points.map(this._source.project);
    return pts.some((p) => p === null) ? null : pts;
  }

  _drawOne(ctx, size, drawing, pts, selected, colorOf, chrome) {
    const spec = specFor(drawing.type);
    if (!spec) return; // a type from a newer version of the app: skip, do not throw

    const color = colorOf(drawing.color);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    /* Text state is reset per drawing, not per label. A tool that left an
     * alignment behind would silently move the next tool's labels, and with
     * eighty-six of them that is a bug nobody would trace back. */
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    /* Selection adds a pixel rather than doubling. Doubling reads fine at the
     * old fixed width of 1, but once the width is the user's own choice the
     * thickest stroke would double along with it and swamp the candles under
     * it. At width 1 both rules give the same 2px, so nothing that existed
     * before this setting looks different. */
    ctx.lineWidth = drawing.width + (selected ? 1 : 0);
    /* The stroke pattern applies to the plain line shapes. The tools whose
     * dashes carry meaning — which fib level, which edge of a block — set their
     * own inside draw(), and a per-drawing style must not overwrite that. */
    ctx.setLineDash(dashPattern(drawing.lineStyle));

    spec.draw(ctx, {
      size,
      pts,
      drawing,
      color,
      selected,
      chrome,
      // For the tools that paint in a colour other than the drawing's own —
      // a position block's two zones, which are semantic.
      tokenColor: colorOf,
      project: this._source.project,
      bars: this._source.bars,
      barsBetween: this._source.barsBetween,
      cache: this.cacheFor(drawing.id),
    });

    // Chrome is never dashed, whatever the drawing itself is.
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
    if (selected) this._handles(ctx, pts, color);
    if (drawing.locked && selected) this._lockMark(ctx, pts, color);
  }

  _handles(ctx, pts, color) {
    const bg = chromeColors().panel;
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, HANDLE_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = bg;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.stroke();
    }
    ctx.fillStyle = color;
    ctx.lineWidth = 1;
  }

  /**
   * A padlock over the first anchor of a locked drawing.
   *
   * Only while it is selected: a locked drawing still has to look like the
   * thing it is, and a chart with thirty locked levels would otherwise be a
   * chart with thirty padlocks on it.
   */
  _lockMark(ctx, pts, color) {
    const { x, y } = pts[0];
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x + 10, y - 12, 3, Math.PI, 0);
    ctx.stroke();
    ctx.fillRect(x + 6, y - 12, 8, 6);
    ctx.restore();
  }
}

class DrawingPaneView {
  constructor(source) {
    this._renderer = new DrawingRenderer(source);
  }

  zOrder() {
    return 'top';
  }

  renderer() {
    return this._renderer;
  }
}

export class DrawingPrimitive {
  constructor() {
    this.drawings = [];
    this.draft = null;
    this.selectedId = null;
    /** Set by the host: converts {time, price} to {x, y}, or null if off-scale. */
    this.project = null;
    /** Set by the host: how many bars lie between two timestamps. */
    this.barsBetween = () => 0;
    /** Set by the host: the bars currently loaded, time in SECONDS. */
    this.bars = () => [];

    this._requestUpdate = null;
    this._paneViews = [new DrawingPaneView(this)];
  }

  attached({ requestUpdate }) {
    this._requestUpdate = requestUpdate;
  }

  detached() {
    this._requestUpdate = null;
  }

  update({ drawings, draft, selectedId }) {
    if (drawings !== undefined) this.drawings = drawings;
    if (draft !== undefined) this.draft = draft;
    if (selectedId !== undefined) this.selectedId = selectedId;
    this._requestUpdate?.();
  }

  repaint() {
    this._requestUpdate?.();
  }

  /**
   * The scratch space a tool filled in during its last paint.
   *
   * Exposed so the pointer layer can hit-test a curve the renderer worked out —
   * see the anchored VWAP, which cannot be recomputed without the bars.
   */
  cacheFor(id) {
    return this._paneViews[0].renderer().cacheFor(id);
  }

  paneViews() {
    // Same array every time — the library caches on identity.
    return this._paneViews;
  }
}
