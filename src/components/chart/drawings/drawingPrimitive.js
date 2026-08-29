/* Renders every drawing on the chart through one pane primitive.
 *
 * One primitive rather than one per drawing: the library rebuilds its renderer
 * list whenever primitives change, and a chart with forty levels on it would
 * otherwise churn that list on every edit.
 *
 * Drawn at zOrder 'top' — unlike the volume profile, a level the user placed
 * by hand should sit above the candles, because that is where they put it.
 */
import {
  FIB_LEVELS, HANDLE_RADIUS, fibPrices, measureStats, positionStats,
} from './geometry.js';
import {
  DEFAULT_POSITION_STYLE, ENTRY, STOP, TARGET, normalizeOpacity,
} from './model.js';

function tokenColor(id) {
  const s = getComputedStyle(document.documentElement);
  const value = s.getPropertyValue(`--${id}`).trim();
  return value || s.getPropertyValue('--accent').trim();
}

function chromeColors() {
  const s = getComputedStyle(document.documentElement);
  return {
    text: s.getPropertyValue('--chart-text').trim(),
    panel: s.getPropertyValue('--chart-bg').trim(),
    pos: s.getPropertyValue('--pos').trim(),
    neg: s.getPropertyValue('--neg').trim(),
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
function fillRectAlpha(ctx, color, alpha, x, y, width, height) {
  const previous = ctx.globalAlpha;
  ctx.globalAlpha = previous * alpha;
  ctx.fillStyle = color;
  ctx.fillRect(x, y, width, height);
  ctx.globalAlpha = previous;
}

class DrawingRenderer {
  constructor(source) {
    this._source = source;
  }

  draw(target) {
    const { drawings, project, selectedId, draft } = this._source;
    if (!project) return;

    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.save();
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      for (const drawing of drawings) {
        const pts = drawing.points.map(project);
        if (pts.some((p) => p === null)) continue; // off the current scale
        this._drawOne(ctx, mediaSize, drawing, pts, drawing.id === selectedId);
      }

      // The shape currently being dragged out, before it is committed.
      if (draft && draft.points.length > 0) {
        const pts = draft.points.map(project);
        if (!pts.some((p) => p === null)) {
          ctx.globalAlpha = 0.75;
          this._drawOne(ctx, mediaSize, draft, pts, false);
          ctx.globalAlpha = 1;
        }
      }

      ctx.restore();
    });
  }

  _drawOne(ctx, size, drawing, pts, selected) {
    const color = tokenColor(drawing.color);
    const [a, b] = pts;

    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = drawing.width * (selected ? 2 : 1);
    ctx.setLineDash([]);

    switch (drawing.type) {
      case 'horizontal':
        this._line(ctx, 0, a.y, size.width, a.y);
        this._priceTag(ctx, size, a.y, drawing.points[0].price, color);
        break;

      case 'vertical':
        this._line(ctx, a.x, 0, a.x, size.height);
        break;

      case 'trendline':
        if (b) this._line(ctx, a.x, a.y, b.x, b.y);
        break;

      case 'ray':
        if (b) {
          // Extend past the second point to the far edge of the pane.
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const len = Math.hypot(dx, dy);
          if (len > 0) {
            const reach = size.width + size.height;
            this._line(ctx, a.x, a.y, a.x + (dx / len) * reach, a.y + (dy / len) * reach);
          }
        }
        break;

      case 'rectangle':
        if (b) {
          const x = Math.min(a.x, b.x);
          const y = Math.min(a.y, b.y);
          const w = Math.abs(b.x - a.x);
          const h = Math.abs(b.y - a.y);
          fillRectAlpha(ctx, color, 0.12, x, y, w, h);
          ctx.strokeRect(x, y, w, h);
        }
        break;

      case 'fib':
        if (b) this._fib(ctx, size, drawing, a, b, color);
        break;

      case 'measure':
        if (b) this._measure(ctx, drawing, a, b);
        break;

      case 'long':
      case 'short':
        if (pts.length === 3) this._position(ctx, size, drawing, pts);
        break;

      default:
        break;
    }

    if (selected) this._handles(ctx, pts, color);
  }

  _line(ctx, x1, y1, x2, y2) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
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
  }

  _priceTag(ctx, size, y, price, color) {
    const label = formatPrice(price);
    ctx.font = '10px "DM Mono", ui-monospace, monospace';
    const width = ctx.measureText(label).width + 8;
    const x = size.width - width - 2;

    ctx.fillStyle = color;
    ctx.fillRect(x, y - 8, width, 16);
    ctx.fillStyle = chromeColors().panel;
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + 4, y);
    ctx.fillStyle = color;
  }

  _fib(ctx, size, drawing, a, b, color) {
    const [from, to] = drawing.points;
    const levels = fibPrices(from.price, to.price, FIB_LEVELS);
    const left = Math.min(a.x, b.x);
    const right = Math.max(a.x, b.x);

    ctx.font = '10px "DM Mono", ui-monospace, monospace';
    ctx.textBaseline = 'bottom';

    for (let i = 0; i < levels.length; i++) {
      const { level, price } = levels[i];
      // Level fractions map linearly between the two anchor pixels.
      const y = b.y + (a.y - b.y) * level;

      ctx.setLineDash(level === 0 || level === 1 ? [] : [4, 3]);
      ctx.lineWidth = level === 0.618 || level === 0.5 ? 1.5 : 1;
      this._line(ctx, left, y, right, y);

      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.fillText(`${(level * 100).toFixed(1)}%  ${formatPrice(price)}`, left + 4, y - 2);
    }

    // Shade the body of the retracement so the zone reads at a glance.
    fillRectAlpha(ctx, color, 0.09, left, Math.min(a.y, b.y), right - left, Math.abs(b.y - a.y));
    ctx.fillStyle = color;
  }

  /**
   * A long or short position: the risk zone from entry to stop, the reward zone
   * from entry to target, and the numbers that decide whether the trade is
   * worth taking.
   *
   * Colour follows meaning, not direction: the stop side takes the loss colour
   * and the target side the profit colour, so a short reads the same way round
   * as a long. The defaults are red and green — the one place they belong on
   * this chart, since a zone cannot be mistaken for a candle — but both colours
   * and the fill opacity are per drawing, so several planned trades can be told
   * apart on one chart.
   */
  _position(ctx, size, drawing, pts) {
    const c = chromeColors();
    const [entryPt, stopPt, targetPt] = drawing.points;
    const stats = positionStats(entryPt.price, stopPt.price, targetPt.price);

    const left = pts[ENTRY].x;
    const right = pts[STOP].x;
    const x = Math.min(left, right);
    const width = Math.abs(right - left);

    const yEntry = pts[ENTRY].y;
    const yStop = pts[STOP].y;
    const yTarget = pts[TARGET].y;

    // Zones. Each spans from the entry line to its own level, so they meet at
    // the entry and never overlap.
    const opacity = normalizeOpacity(drawing.fillOpacity);
    const profitColor = tokenColor(drawing.profitColor ?? DEFAULT_POSITION_STYLE.profitColor);
    const lossColor = tokenColor(drawing.lossColor ?? DEFAULT_POSITION_STYLE.lossColor);

    const zone = (yFrom, yTo, color) => {
      const top = Math.min(yFrom, yTo);
      const height = Math.abs(yTo - yFrom);
      if (height < 0.5) return;
      fillRectAlpha(ctx, color, opacity, x, top, width, height);
    };

    zone(yEntry, yStop, lossColor);
    zone(yEntry, yTarget, profitColor);

    // Level lines.
    const level = (y, color, dashed) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.setLineDash(dashed ? [4, 3] : []);
      this._line(ctx, x, y, x + width, y);
      ctx.setLineDash([]);
    };

    level(yStop, lossColor, false);
    level(yTarget, profitColor, false);
    level(yEntry, c.text, true);

    // Labels on each level, inside the block.
    ctx.font = '10px "DM Mono", ui-monospace, monospace';
    ctx.textBaseline = 'bottom';

    const label = (y, text, color) => {
      ctx.fillStyle = color;
      ctx.fillText(text, x + 5, y - 3);
    };

    const pct = (v) => (v == null ? '—' : `${v.toFixed(2)}%`);
    label(yTarget, `TP  ${formatPrice(stats.target)}   +${pct(stats.rewardPercent)}`, profitColor);
    label(yEntry, `Entry  ${formatPrice(stats.entry)}`, c.text);
    label(yStop, `SL  ${formatPrice(stats.stop)}   −${pct(stats.riskPercent)}`, lossColor);

    // Summary box, above or below the block depending on where there is room.
    const rr = stats.rr == null ? '—' : `${stats.rr.toFixed(2)}`;
    const lines = [
      `${drawing.type === 'long' ? 'LONG' : 'SHORT'}   R:R ${rr}`,
      `risk ${formatPrice(stats.risk)}   reward ${formatPrice(stats.reward)}`,
    ];

    const boxWidth = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 12;
    const boxHeight = lines.length * 13 + 7;
    const blockTop = Math.min(yEntry, yStop, yTarget);
    const blockBottom = Math.max(yEntry, yStop, yTarget);
    const boxY = blockTop - boxHeight - 5 >= 0 ? blockTop - boxHeight - 5 : blockBottom + 5;

    const tone = stats.rr != null && stats.rr >= 1 ? profitColor : lossColor;
    ctx.fillStyle = tone;
    ctx.fillRect(x, boxY, boxWidth, boxHeight);
    ctx.fillStyle = c.panel;
    ctx.textBaseline = 'top';
    lines.forEach((line, i) => ctx.fillText(line, x + 6, boxY + 4 + i * 13));
  }

  _measure(ctx, drawing, a, b) {
    const [from, to] = drawing.points;
    const bars = this._source.barsBetween(from.time, to.time);
    const stats = measureStats(from.price, to.price, bars);
    const c = chromeColors();
    const tone = stats.change >= 0 ? c.pos : c.neg;

    ctx.strokeStyle = tone;
    fillRectAlpha(ctx, tone, 0.12,
      Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));

    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = tone;
    ctx.lineWidth = 1;
    this._line(ctx, a.x, a.y, b.x, b.y);
    ctx.setLineDash([]);

    const lines = [
      `${stats.change >= 0 ? '+' : ''}${formatPrice(stats.change)}`,
      stats.percent == null ? '—' : `${stats.percent >= 0 ? '+' : ''}${stats.percent.toFixed(2)}%`,
      `${bars} bar${bars === 1 ? '' : 's'}`,
    ];

    ctx.font = '10px "DM Mono", ui-monospace, monospace';
    const width = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 12;
    const height = lines.length * 13 + 8;
    const x = (a.x + b.x) / 2 - width / 2;
    const y = Math.min(a.y, b.y) - height - 6;

    ctx.fillStyle = tone;
    ctx.fillRect(x, y, width, height);
    ctx.fillStyle = chromeColors().panel;
    ctx.textBaseline = 'top';
    lines.forEach((line, i) => ctx.fillText(line, x + 6, y + 5 + i * 13));
  }
}

/** Prices span BTC at 100k and altcoins at 0.00001 — pick decimals to match. */
function formatPrice(p) {
  const abs = Math.abs(p);
  const decimals = abs >= 1000 ? 2 : abs >= 1 ? 4 : 8;
  return p.toLocaleString('en-GB', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
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

  paneViews() {
    // Same array every time — the library caches on identity.
    return this._paneViews;
  }
}
