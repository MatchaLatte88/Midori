/* Volume profile drawn as a lightweight-charts pane primitive.
 *
 * The library has no horizontal histogram, so this draws directly onto the
 * chart canvas through the plugin API: paneViews() -> renderer() -> draw().
 *
 * It renders at zOrder 'bottom' so candles always stay legible on top — the
 * profile is context, not the subject.
 *
 * Colors are read from the CSS tokens on every draw rather than passed in, so
 * a theme switch needs no bookkeeping here.
 */

function tokens() {
  const s = getComputedStyle(document.documentElement);
  const v = (name) => s.getPropertyValue(name).trim();
  return {
    bar: v('--vp-bar'),
    barVa: v('--vp-bar-va'),
    poc: v('--vp-poc'),
    vaEdge: v('--vp-va-edge'),
    buy: v('--vp-buy'),
    sell: v('--vp-sell'),
    text: v('--chart-text'),
  };
}

class VolumeProfileRenderer {
  constructor(source) {
    this._source = source;
  }

  draw(target) {
    const profile = this._source.profile;
    const series = this._source.series;
    if (!profile || !series || profile.totalVolume <= 0) return;

    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const { volumes, bins, binHeight, priceMin, maxBinVolume, poc, valueArea } = profile;
      if (maxBinVolume <= 0) return;

      const c = tokens();
      const widthFraction = this._source.options.width / 100;
      const maxWidth = mediaSize.width * widthFraction;
      const right = mediaSize.width;

      // One bin spans binHeight in price; convert to pixels via the price scale.
      const topY = series.priceToCoordinate(priceMin + bins * binHeight);
      const bottomY = series.priceToCoordinate(priceMin);
      if (topY == null || bottomY == null) return;

      const pixelsPerBin = (bottomY - topY) / bins;
      // Below roughly a pixel per bin the bars merge into a block; leave a
      // hairline gap only when there is room for one.
      const gap = pixelsPerBin > 3 ? 1 : 0;

      ctx.save();

      // 'delta' falls back to the plain profile when the source never reported
      // a buy/sell split — drawing an all-zero delta would look like balance.
      const mode = profile.hasDelta ? this._source.options.mode : 'total';

      for (let i = 0; i < bins; i++) {
        const volume = volumes[i];
        if (volume <= 0) continue;

        const y = bottomY - (i + 1) * pixelsPerBin;
        const h = Math.max(1, pixelsPerBin - gap);

        if (mode === 'delta') {
          const delta = profile.deltas[i];
          if (delta === 0 || profile.maxAbsDelta === 0) continue;
          const w = (Math.abs(delta) / profile.maxAbsDelta) * maxWidth;
          ctx.fillStyle = delta > 0 ? c.buy : c.sell;
          ctx.fillRect(right - w, y, w, h);
          continue;
        }

        const w = (volume / maxBinVolume) * maxWidth;

        if (mode === 'buysell') {
          // Stacked: total length still reads as volume, the split sits inside.
          const known = profile.buyVolumes[i] + profile.sellVolumes[i];
          if (known > 0) {
            const buyW = w * (profile.buyVolumes[i] / known);
            ctx.fillStyle = c.sell;
            ctx.fillRect(right - w, y, w, h);
            ctx.fillStyle = c.buy;
            ctx.fillRect(right - buyW, y, buyW, h);
          } else {
            ctx.fillStyle = c.bar;
            ctx.fillRect(right - w, y, w, h);
          }
          continue;
        }

        const inValueArea = valueArea && i >= valueArea.lowIndex && i <= valueArea.highIndex;
        ctx.fillStyle = inValueArea ? c.barVa : c.bar;
        ctx.fillRect(right - w, y, w, h);
      }

      // Point of control — the level that traded the most.
      if (poc) {
        const y = bottomY - (poc.index + 0.5) * pixelsPerBin;
        const w = maxWidth;
        ctx.fillStyle = c.poc;
        ctx.fillRect(right - w, y - Math.max(0.5, pixelsPerBin / 2), w, Math.max(1, pixelsPerBin));

        if (this._source.options.showLabels) {
          ctx.strokeStyle = c.poc;
          ctx.setLineDash([3, 3]);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(right - w, y);
          ctx.stroke();
          ctx.setLineDash([]);

          ctx.fillStyle = c.poc;
          ctx.font = '10px "DM Mono", ui-monospace, monospace';
          ctx.textBaseline = 'bottom';
          ctx.fillText('POC', 6, y - 2);
        }
      }

      // Value area boundaries.
      if (valueArea && this._source.options.showLabels) {
        ctx.strokeStyle = c.vaEdge;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 4]);

        for (const [price, label] of [[valueArea.high, 'VAH'], [valueArea.low, 'VAL']]) {
          const y = series.priceToCoordinate(price);
          if (y == null) continue;
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(right - maxWidth, y);
          ctx.stroke();

          ctx.fillStyle = c.vaEdge;
          ctx.font = '10px "DM Mono", ui-monospace, monospace';
          ctx.textBaseline = 'bottom';
          ctx.fillText(label, 6, y - 2);
        }
        ctx.setLineDash([]);
      }

      ctx.restore();
    });
  }
}

class VolumeProfilePaneView {
  constructor(source) {
    this._renderer = new VolumeProfileRenderer(source);
  }

  zOrder() {
    return 'bottom';
  }

  renderer() {
    return this._renderer;
  }
}

export class VolumeProfilePrimitive {
  /**
   * @param {{width?:number, showLabels?:boolean}} [options]
   *   width — how much of the chart width the widest bar may take, in percent.
   */
  constructor(options = {}) {
    this.options = { width: 30, showLabels: true, mode: 'total', ...options };
    this.profile = null;
    this.series = null;
    this._requestUpdate = null;
    this._paneViews = [new VolumeProfilePaneView(this)];
  }

  attached({ series, requestUpdate }) {
    this.series = series;
    this._requestUpdate = requestUpdate;
  }

  detached() {
    this.series = null;
    this._requestUpdate = null;
  }

  /** Replaces the profile and asks the chart to repaint. */
  setProfile(profile) {
    this.profile = profile;
    this._requestUpdate?.();
  }

  setOptions(options) {
    this.options = { ...this.options, ...options };
    this._requestUpdate?.();
  }

  paneViews() {
    // Same array every time — the library caches on identity.
    return this._paneViews;
  }
}
