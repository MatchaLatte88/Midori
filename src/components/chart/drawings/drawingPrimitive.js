/* Renders every drawing on the chart through one pane primitive.
 *
 * One primitive rather than one per drawing: the library rebuilds its renderer
 * list whenever primitives change, and a chart with forty levels on it would
 * otherwise churn that list on every edit.
 *
 * Drawn at zOrder 'top' — unlike the volume profile, a level the user placed
 * by hand should sit above the candles, because that is where they put it.
 */
import { FIB_LEVELS, HANDLE_RADIUS, fibPrices, measureStats } from './geometry.js';

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

/** Semi-transparent fill from a solid colour, for zones. */
function withAlpha(color, alpha) {
  if (color.startsWith('#') && (color.length === 7 || color.length === 4)) {
    const hex = color.length === 4
      ? color.slice(1).split('').map((c) => c + c).join('')
      : color.slice(1);
    const n = parseInt(hex, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  // Already a functional colour — let the browser blend it via globalAlpha.
  return color;
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
          ctx.globalAlpha *= 0.12;
          ctx.fillStyle = withAlpha(color, 0.12);
          ctx.fillRect(x, y, w, h);
          ctx.globalAlpha /= 0.12;
          ctx.fillStyle = color;
          ctx.strokeRect(x, y, w, h);
        }
        break;

      case 'fib':
        if (b) this._fib(ctx, size, drawing, a, b, color);
        break;

      case 'measure':
        if (b) this._measure(ctx, drawing, a, b);
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
    ctx.globalAlpha *= 0.07;
    ctx.fillStyle = withAlpha(color, 0.07);
    ctx.fillRect(left, Math.min(a.y, b.y), right - left, Math.abs(b.y - a.y));
    ctx.globalAlpha /= 0.07;
    ctx.fillStyle = color;
  }

  _measure(ctx, drawing, a, b) {
    const [from, to] = drawing.points;
    const bars = this._source.barsBetween(from.time, to.time);
    const stats = measureStats(from.price, to.price, bars);
    const c = chromeColors();
    const tone = stats.change >= 0 ? c.pos : c.neg;

    ctx.strokeStyle = tone;
    ctx.fillStyle = withAlpha(tone, 0.10);
    ctx.globalAlpha *= 0.10;
    ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    ctx.globalAlpha /= 0.10;

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
