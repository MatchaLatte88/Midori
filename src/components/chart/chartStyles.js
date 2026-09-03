/* How price is drawn — the ten shapes the same bars can take.
 *
 * One catalogue, read by two places that must not disagree: the menu in the
 * instrument bar, which lists them, and ChartPanel, which builds the series.
 * Splitting those would mean a style could be offered that the chart cannot
 * make.
 *
 * Only styles this library can draw honestly are in here. "High-Low" and
 * "Volume bars" are in the terminal this was modelled on and are deliberately
 * absent: a bar series can hide its open tick but not its close tick, so a
 * high-low bar would be a bar with a stray mark on it, and a volume-weighted
 * candle needs a renderer this chart does not have. An almost-right chart is
 * worse than one that is not offered — it is read as the thing it is labelled.
 *
 * Heikin Ashi is the one style that redraws the data rather than restyling it,
 * which is the whole point of it and also the thing to know about it: the
 * candle you see is an average, and no trade happened at its open or its
 * close. Everything else in the app keeps reading the real bars — the legend,
 * the indicators, the engine — so the only thing that changes is the picture.
 */
import {
  AreaSeries, BarSeries, BaselineSeries, CandlestickSeries, HistogramSeries, LineSeries,
} from 'lightweight-charts';

/** Line types, from the library's LineType enum — kept as numbers so the
 *  enum import is not needed for three values that never change. */
const LINE_SIMPLE = 0;
const LINE_STEPS = 1;

/**
 * @typedef {object} ChartStyle
 * @property {string} name        what the menu calls it
 * @property {string} group       the menu section it sits in
 * @property {string} [hint]      a sentence for the tooltip, where one is owed
 * @property {Function} series    the lightweight-charts series constructor
 * @property {boolean} ohlc       true for a series that takes open/high/low/close
 * @property {Function} options   (palette) => series options
 */

/** @type {Record<string, ChartStyle>} */
export const CHART_STYLES = {
  candle: {
    name: 'Candle',
    group: 'Candles',
    series: CandlestickSeries,
    ohlc: true,
    options: (p) => ({
      upColor: p.upBody,
      downColor: p.downBody,
      borderUpColor: p.upBrd,
      borderDownColor: p.downBrd,
      wickUpColor: p.upWick,
      wickDownColor: p.downWick,
      borderVisible: true,
    }),
  },

  hollow: {
    name: 'Hollow candle',
    group: 'Candles',
    hint: 'Up bars drawn as an outline, so a run of them reads as one shape.',
    series: CandlestickSeries,
    ohlc: true,
    options: (p) => ({
      // The body is the ground showing through; the outline carries the colour.
      upColor: 'rgba(0,0,0,0)',
      downColor: p.downBody,
      borderUpColor: p.upBrd,
      borderDownColor: p.downBrd,
      wickUpColor: p.upWick,
      wickDownColor: p.downWick,
      borderVisible: true,
    }),
  },

  heikin: {
    name: 'Heikin Ashi',
    group: 'Candles',
    hint: 'Averaged bars. Smoother to read, but no trade happened at the open '
      + 'or close of one — the rest of the app keeps using the real bars.',
    series: CandlestickSeries,
    ohlc: true,
    /* The averaging itself is in `encoder` below: it needs the previous drawn
     * bar, so it cannot be a per-bar mapping like every other style here. */
    heikin: true,
    options: (p) => ({
      upColor: p.upBody,
      downColor: p.downBody,
      borderUpColor: p.upBrd,
      borderDownColor: p.downBrd,
      wickUpColor: p.upWick,
      wickDownColor: p.downWick,
      borderVisible: true,
    }),
  },

  bar: {
    name: 'Bars',
    group: 'Bars',
    series: BarSeries,
    ohlc: true,
    options: (p) => ({ upColor: p.upBrd, downColor: p.downBody, thinBars: false }),
  },

  column: {
    name: 'Columns',
    group: 'Bars',
    hint: 'One column per bar, at its close.',
    series: HistogramSeries,
    ohlc: false,
    value: (b) => b.close,
    /* Coloured per point rather than per series — a column chart that is one
     * colour throughout says nothing about direction, which is the only thing
     * a column of the close has left to say. */
    colored: true,
    options: () => ({ priceLineVisible: true }),
  },

  line: {
    name: 'Line',
    group: 'Lines',
    series: LineSeries,
    ohlc: false,
    value: (b) => b.close,
    options: (p) => ({ color: p.upBrd, lineWidth: 2, lineType: LINE_SIMPLE }),
  },

  markers: {
    name: 'Line with markers',
    group: 'Lines',
    hint: 'A dot per bar, so single bars stay countable when the line is flat.',
    series: LineSeries,
    ohlc: false,
    value: (b) => b.close,
    options: (p) => ({
      color: p.upBrd, lineWidth: 2, lineType: LINE_SIMPLE, pointMarkersVisible: true,
    }),
  },

  step: {
    name: 'Step line',
    group: 'Lines',
    hint: 'Holds each close until the next one — the honest shape for a price '
      + 'that only exists once per bar.',
    series: LineSeries,
    ohlc: false,
    value: (b) => b.close,
    options: (p) => ({ color: p.upBrd, lineWidth: 2, lineType: LINE_STEPS }),
  },

  area: {
    name: 'Area',
    group: 'Areas',
    series: AreaSeries,
    ohlc: false,
    value: (b) => b.close,
    options: (p) => ({
      lineColor: p.upBrd,
      topColor: p.areaTop,
      bottomColor: p.areaBottom,
      lineWidth: 2,
    }),
  },

  baseline: {
    name: 'Baseline',
    group: 'Areas',
    hint: 'Filled away from the first close in view — above it in one colour, '
      + 'below it in the other.',
    series: BaselineSeries,
    ohlc: false,
    value: (b) => b.close,
    options: (p) => ({
      topLineColor: p.upBrd,
      topFillColor1: p.areaTop,
      topFillColor2: p.areaBottom,
      bottomLineColor: p.downBody,
      bottomFillColor1: p.downFillSoft,
      bottomFillColor2: p.downFillStrong,
      lineWidth: 2,
    }),
  },
};

export const DEFAULT_CHART_STYLE = 'candle';

export const CHART_STYLE_IDS = Object.keys(CHART_STYLES);

/** The catalogue as the menu wants it: sections, in the order they are shown. */
export function chartStyleGroups() {
  const groups = [];
  for (const [id, style] of Object.entries(CHART_STYLES)) {
    let group = groups.find((g) => g.name === style.group);
    if (!group) {
      group = { name: style.group, items: [] };
      groups.push(group);
    }
    group.items.push({ id, name: style.name, hint: style.hint ?? null });
  }
  return groups;
}

export function chartStyle(id) {
  return CHART_STYLES[id] ?? CHART_STYLES[DEFAULT_CHART_STYLE];
}

/**
 * Turns bars into the points one style wants.
 *
 * Stateful on purpose, and that is the whole reason it is a factory rather
 * than a function: Heikin Ashi's bar depends on the bar drawn before it, so a
 * replay appending one bar at a time has to be able to continue the sequence
 * rather than recompute it. `data` starts a fresh sequence, `point` continues
 * the one `data` left off at — which is exactly the order the chart uses them
 * in, a full render followed by single updates.
 *
 * @param {string} id       a key of CHART_STYLES
 * @param {object} palette  the chart palette, for the per-point colours a
 *   column chart needs; unused by every other style
 */
export function styleEncoder(id, palette = {}) {
  const style = chartStyle(id);
  let prev = null;

  function one(bar) {
    if (style.heikin) {
      const close = (bar.open + bar.high + bar.low + bar.close) / 4;
      const open = prev === null ? (bar.open + bar.close) / 2 : (prev.open + prev.close) / 2;
      const point = {
        time: bar.time,
        open,
        high: Math.max(bar.high, open, close),
        low: Math.min(bar.low, open, close),
        close,
      };
      prev = point;
      return point;
    }
    if (style.ohlc) {
      return {
        time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close,
      };
    }
    const point = { time: bar.time, value: style.value(bar) };
    if (style.colored) {
      point.color = bar.close >= bar.open ? palette.volUp : palette.volDown;
    }
    return point;
  }

  return {
    /** The whole window, from the beginning of the sequence. */
    data(bars) {
      prev = null;
      return bars.map(one);
    },
    /** One more bar, continuing where `data` stopped. */
    point(bar) {
      return one(bar);
    },
  };
}
