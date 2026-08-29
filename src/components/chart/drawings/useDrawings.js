/* Drawing interaction: pointer handling, coordinate conversion, persistence.
 *
 * The overlay problem
 * -------------------
 * A transparent layer that swallows every pointer event would also swallow
 * panning and zooming, and a chart you cannot drag is worse than one you
 * cannot draw on. A layer that never takes events cannot support dragging a
 * shape.
 *
 * So the overlay is transparent by default and switches itself on only while
 * the pointer is actually over a drawing (or a tool is armed). Hit testing runs
 * on plain mousemove, which passes through a `pointer-events: none` layer, and
 * the layer is enabled the moment the answer is yes. Everywhere else the chart
 * keeps its own gestures.
 *
 * Times are stored in milliseconds like everything else in the app; the chart
 * works in seconds, so conversion happens at this boundary and nowhere else.
 */
import { ref, shallowRef } from 'vue';
import { buildFromGesture, gesturePoints, handleAt, hitTest } from './geometry.js';
import { createDrawing, moveAnchor, parseDrawing, translateDrawing } from './model.js';

/**
 * @param {object} deps
 * @param {() => object|null} deps.chart        the chart API
 * @param {() => object|null} deps.series       the candle series, for price conversion
 * @param {() => Array} deps.bars               current bars, time in SECONDS
 * @param {() => string|null} deps.symbol
 * @param {(err:Error) => void} deps.onError
 */
export function useDrawings(deps) {
  const drawings = shallowRef([]);
  const draft = shallowRef(null);
  const selectedId = ref(null);
  const activeTool = ref('cursor');
  const activeColor = ref('ind-1');
  /** Whether the overlay should currently take pointer events. */
  const overlayActive = ref(false);
  const cursorStyle = ref('default');

  let gesture = null; // { mode, drawingId, anchorIndex, startPoint, original }

  /* ─── Coordinate conversion ───────────────────────────────────────────── */

  /** Bar index (fractional) for a timestamp in ms, extrapolating past the ends. */
  function timeToLogical(timeMs) {
    const bars = deps.bars();
    if (bars.length === 0) return null;
    const t = timeMs / 1000;

    if (t <= bars[0].time) {
      // Before the first bar: step backwards at the current bar spacing.
      const step = bars.length > 1 ? bars[1].time - bars[0].time : 60;
      return (t - bars[0].time) / step;
    }
    const last = bars.length - 1;
    if (t >= bars[last].time) {
      const step = bars.length > 1 ? bars[last].time - bars[last - 1].time : 60;
      return last + (t - bars[last].time) / step;
    }

    // Binary search for the surrounding pair, then interpolate between them.
    let lo = 0;
    let hi = last;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (bars[mid].time <= t) lo = mid;
      else hi = mid;
    }
    const span = bars[hi].time - bars[lo].time;
    return span === 0 ? lo : lo + (t - bars[lo].time) / span;
  }

  /** Timestamp in ms for a fractional bar index. */
  function logicalToTime(logical) {
    const bars = deps.bars();
    if (bars.length === 0) return null;
    const last = bars.length - 1;

    if (logical <= 0) {
      const step = bars.length > 1 ? bars[1].time - bars[0].time : 60;
      return (bars[0].time + logical * step) * 1000;
    }
    if (logical >= last) {
      const step = bars.length > 1 ? bars[last].time - bars[last - 1].time : 60;
      return (bars[last].time + (logical - last) * step) * 1000;
    }

    const i = Math.floor(logical);
    const frac = logical - i;
    return (bars[i].time + (bars[i + 1].time - bars[i].time) * frac) * 1000;
  }

  /** {time, price} in market units → {x, y} in pixels, or null if unmappable. */
  function project(point) {
    const chart = deps.chart();
    const series = deps.series();
    if (!chart || !series) return null;

    const logical = timeToLogical(point.time);
    if (logical === null) return null;

    const x = chart.timeScale().logicalToCoordinate(logical);
    const y = series.priceToCoordinate(point.price);
    if (x === null || y === null) return null;
    return { x, y };
  }

  /** {x, y} in pixels → {time, price} in market units. */
  function unproject(x, y) {
    const chart = deps.chart();
    const series = deps.series();
    if (!chart || !series) return null;

    const logical = chart.timeScale().coordinateToLogical(x);
    const price = series.coordinateToPrice(y);
    if (logical === null || price === null) return null;

    const time = logicalToTime(logical);
    if (time === null) return null;
    return { time, price };
  }

  /** Whole bars between two timestamps, for the measure tool. */
  function barsBetween(fromMs, toMs) {
    const a = timeToLogical(fromMs);
    const b = timeToLogical(toMs);
    if (a === null || b === null) return 0;
    return Math.abs(Math.round(b - a));
  }

  /* ─── Hit testing ─────────────────────────────────────────────────────── */

  function screenPoints(drawing) {
    const pts = drawing.points.map(project);
    return pts.some((p) => p === null) ? null : pts;
  }

  /** Topmost drawing under the pointer — later drawings sit above earlier ones. */
  function findAt(x, y, size) {
    for (let i = drawings.value.length - 1; i >= 0; i--) {
      const drawing = drawings.value[i];
      const pts = screenPoints(drawing);
      if (!pts) continue;
      if (hitTest(drawing.type, pts, { x, y }, size)) return drawing;
    }
    return null;
  }

  function findHandle(x, y) {
    if (!selectedId.value) return -1;
    const drawing = drawings.value.find((d) => d.id === selectedId.value);
    if (!drawing) return -1;
    const pts = screenPoints(drawing);
    if (!pts) return -1;
    return handleAt(pts, { x, y });
  }

  /**
   * Decides whether the overlay should be taking events, based on what is
   * under the pointer. Called from a listener that works through the
   * transparent layer.
   */
  function updateHover(x, y, size) {
    if (activeTool.value !== 'cursor') {
      overlayActive.value = true;
      cursorStyle.value = 'crosshair';
      return;
    }
    if (gesture) return; // mid-drag, keep it

    if (findHandle(x, y) !== -1) {
      overlayActive.value = true;
      cursorStyle.value = 'grab';
      return;
    }
    const hit = findAt(x, y, size);
    overlayActive.value = hit !== null;
    cursorStyle.value = hit ? 'move' : 'default';
  }

  /* ─── Gestures ────────────────────────────────────────────────────────── */

  function onPointerDown(x, y, size) {
    const at = unproject(x, y);
    if (!at) return;

    if (activeTool.value !== 'cursor') {
      // One-point tools are a single click; the rest are a drag. The draft
      // always holds finished anchors, so a position block shows its zones and
      // its reward-to-risk while it is still being dragged out.
      draft.value = {
        type: activeTool.value,
        color: activeColor.value,
        width: 1,
        points: buildFromGesture(activeTool.value, at, at),
      };
      gesture = { mode: 'create', start: at };
      return;
    }

    const handleIndex = findHandle(x, y);
    if (handleIndex !== -1) {
      gesture = { mode: 'handle', drawingId: selectedId.value, anchorIndex: handleIndex };
      return;
    }

    const hit = findAt(x, y, size);
    selectedId.value = hit ? hit.id : null;
    if (hit) {
      gesture = { mode: 'move', drawingId: hit.id, startPoint: at, original: hit };
    }
  }

  function onPointerMove(x, y, size) {
    if (!gesture) {
      updateHover(x, y, size);
      return;
    }
    const at = unproject(x, y);
    if (!at) return;

    if (gesture.mode === 'create') {
      if (gesturePoints(draft.value.type) === 2) {
        draft.value = {
          ...draft.value,
          points: buildFromGesture(draft.value.type, gesture.start, at),
        };
      }
      return;
    }

    const list = drawings.value;
    const index = list.findIndex((d) => d.id === gesture.drawingId);
    if (index === -1) return;

    if (gesture.mode === 'handle') {
      const updated = moveAnchor(list[index], gesture.anchorIndex, at.time, at.price);
      drawings.value = list.map((d, i) => (i === index ? updated : d));
      return;
    }

    if (gesture.mode === 'move') {
      const moved = translateDrawing(
        gesture.original,
        at.time - gesture.startPoint.time,
        at.price - gesture.startPoint.price,
      );
      drawings.value = list.map((d, i) => (i === index ? moved : d));
    }
  }

  function onPointerUp() {
    if (!gesture) return;

    if (gesture.mode === 'create' && draft.value) {
      const { type, points, color } = draft.value;

      // A dragged shape that never moved is a stray click, not a drawing.
      const degenerate = gesturePoints(type) === 2
        && points[0].time === points[1].time && points[0].price === points[1].price;

      if (!degenerate) {
        try {
          const drawing = createDrawing(type, points, { color });
          drawings.value = [...drawings.value, drawing];
          selectedId.value = drawing.id;
          save();
        } catch (err) {
          deps.onError(err);
        }
      }
      draft.value = null;
      // One shape per arming, like every charting tool: back to the cursor.
      activeTool.value = 'cursor';
      overlayActive.value = false;
    } else {
      save();
    }

    gesture = null;
  }

  function cancelGesture() {
    if (gesture?.mode === 'create') {
      draft.value = null;
      activeTool.value = 'cursor';
      overlayActive.value = false;
    }
    gesture = null;
  }

  /* ─── Commands ────────────────────────────────────────────────────────── */

  function setTool(tool) {
    activeTool.value = tool;
    overlayActive.value = tool !== 'cursor';
    cursorStyle.value = tool === 'cursor' ? 'default' : 'crosshair';
    if (tool !== 'cursor') selectedId.value = null;
  }

  function setColor(color) {
    activeColor.value = color;
    // Recolour the selection too — that is what picking a colour means when
    // something is selected.
    if (selectedId.value) {
      drawings.value = drawings.value.map((d) => (
        d.id === selectedId.value ? { ...d, color } : d
      ));
      save();
    }
  }

  function deleteSelected() {
    if (!selectedId.value) return false;
    drawings.value = drawings.value.filter((d) => d.id !== selectedId.value);
    selectedId.value = null;
    save();
    return true;
  }

  function clearAll() {
    drawings.value = [];
    selectedId.value = null;
    save();
  }

  /* ─── Persistence ─────────────────────────────────────────────────────── */

  /* Every action that changes the set is discrete — a shape is finished, an
   * anchor is dropped, something is deleted — so each one writes straight away.
   * Debouncing would buy nothing here and would lose the last edit whenever the
   * window closes inside the delay. Dragging does not write per pixel: the
   * position updates in memory and only the pointerup lands on disk. */
  async function save() {
    const symbol = deps.symbol();
    if (!symbol) return;
    try {
      await window.midori.drawings.save(symbol, drawings.value);
    } catch (err) {
      deps.onError(err);
    }
  }

  async function load() {
    const symbol = deps.symbol();
    selectedId.value = null;
    draft.value = null;
    if (!symbol) {
      drawings.value = [];
      return;
    }
    try {
      const raw = await window.midori.drawings.load(symbol);
      // One malformed entry costs its own drawing, not the whole file.
      drawings.value = (Array.isArray(raw) ? raw : []).map(parseDrawing).filter(Boolean);
    } catch (err) {
      drawings.value = [];
      deps.onError(err);
    }
  }

  return {
    drawings,
    draft,
    selectedId,
    activeTool,
    activeColor,
    overlayActive,
    cursorStyle,

    project,
    unproject,
    barsBetween,

    onPointerDown,
    onPointerMove,
    onPointerUp,
    cancelGesture,
    updateHover,

    setTool,
    setColor,
    deleteSelected,
    clearAll,
    load,
  };
}
