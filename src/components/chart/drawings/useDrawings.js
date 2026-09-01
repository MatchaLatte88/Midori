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
import {
  HIT_TOLERANCE, buildFromGesture, gesturePoints, handleAt, hitTest, snapAxis, snapToAxis,
} from './geometry.js';
import {
  DEFAULT_LINE_STYLE, DEFAULT_POSITION_STYLE, FVG_COLORS, createDrawing, isPositionTool,
  moveAnchor, parseDrawing, translateDrawing,
} from './model.js';
import { zoneAnchors, zoneAt } from './fvgSnap.js';

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
  /* Zone styling for position blocks. Editing a selected block also updates
   * this, so the next one drawn keeps the look the user just chose. */
  const positionStyle = ref({ ...DEFAULT_POSITION_STYLE });
  /* How the gap tool reads a run of stacked imbalances, kept alongside the
   * other tool settings and for the same reason: chosen once, it should hold
   * for the next click. Off by default — every gap marked on its own. */
  const fvgStyle = ref({ mergeWick: 0, mergeUnit: 'percent' });
  /* Stroke styling for everything else, kept the same way and for the same
   * reason: a width chosen once should survive to the next drawing. Colour is
   * not in here - it has its own control in the toolbar and its own setter. */
  const lineStyle = ref({ ...DEFAULT_LINE_STYLE });
  /** Whether the overlay should currently take pointer events. */
  const overlayActive = ref(false);
  const cursorStyle = ref('default');
  /* What the last click could not do. A gap tool that lands on empty chart has
   * not failed — there is no imbalance there to mark — so this is a line of
   * feedback rather than an error, and it never reaches the app's error banner.
   * Cleared by the next thing that makes it untrue. */
  const notice = ref(null);

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

  /**
   * Constrains a point to one axis through an anchor while shift is held.
   *
   * The axis is decided from the *pixel* deltas - see snapAxis for why market
   * units cannot answer this - so the anchor has to be projected back to the
   * screen rather than compared in time and price.
   *
   * Position blocks are left alone: their three anchors already encode a
   * direction, and locking a drag to the horizontal would set the risk to
   * zero, which is not a position anyone is trying to draw.
   */
  function applySnap(at, anchor, x, y, type) {
    if (isPositionTool(type)) return at;
    const anchorXY = project(anchor);
    if (!anchorXY) return at;
    return snapToAxis(anchor, at, snapAxis(x - anchorXY.x, y - anchorXY.y));
  }

  /**
   * The hit tolerance expressed in price, at a given height on the pane.
   *
   * A gap two pixels tall is the normal case on a zoomed-out chart, and a click
   * has to be able to land on one. Measured through the price scale rather than
   * assumed, so it stays six pixels whatever the scale is doing.
   */
  function priceSlack(x, y) {
    const above = unproject(x, y - HIT_TOLERANCE);
    const below = unproject(x, y + HIT_TOLERANCE);
    if (!above || !below) return 0;
    return Math.abs(above.price - below.price) / 2;
  }

  /**
   * Marks the fair value gap under the pointer, if there is one.
   *
   * Unlike every other tool this one commits on the press: there is nothing to
   * drag out, because the gap already has its shape — the click only says which
   * one. On a miss the tool stays armed, since a click that found no imbalance
   * still meant "mark an imbalance", and says so rather than doing nothing
   * visible.
   */
  function placeFvg(x, y, at) {
    const bars = deps.bars();
    /* Bars are in seconds here and drawings in milliseconds. The click arrives
     * as the latter, so it goes into the bars' unit for the lookup and the
     * anchors come back out of it. */
    const zone = zoneAt(
      bars, { time: at.time / 1000, price: at.price }, priceSlack(x, y), fvgStyle.value,
    );
    if (!zone) {
      notice.value = 'No fair value gap under the pointer.';
      return;
    }

    const [top, bottom] = zoneAnchors(zone, bars);
    try {
      const drawing = createDrawing('fvg', [
        { time: top.time * 1000, price: top.price },
        { time: bottom.time * 1000, price: bottom.price },
      ], {
        color: FVG_COLORS[zone.direction],
        ...lineStyle.value,
        direction: zone.direction,
      });
      drawings.value = [...drawings.value, drawing];
      selectedId.value = drawing.id;
      notice.value = null;
      save();
    } catch (err) {
      deps.onError(err);
    }

    // One shape per arming, like every other tool.
    activeTool.value = 'cursor';
    overlayActive.value = false;
    cursorStyle.value = 'default';
  }

  function onPointerDown(x, y, size) {
    const at = unproject(x, y);
    if (!at) return;

    // Picked, not dragged, so it never opens a gesture.
    if (activeTool.value === 'fvg') {
      placeFvg(x, y, at);
      return;
    }

    if (activeTool.value !== 'cursor') {
      // One-point tools are a single click; the rest are a drag. The draft
      // always holds finished anchors, so a position block shows its zones and
      // its reward-to-risk while it is still being dragged out.
      draft.value = {
        type: activeTool.value,
        color: activeColor.value,
        ...lineStyle.value,
        ...(isPositionTool(activeTool.value) ? positionStyle.value : {}),
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

  function onPointerMove(x, y, size, shift = false) {
    if (!gesture) {
      updateHover(x, y, size);
      return;
    }
    let at = unproject(x, y);
    if (!at) return;

    if (gesture.mode === 'create') {
      if (gesturePoints(draft.value.type) === 2) {
        if (shift) at = applySnap(at, gesture.start, x, y, draft.value.type);
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
      const drawing = list[index];
      /* An anchor snaps against the one it is tethered to - the other end of
       * the line - so shift-dragging a trend line's end makes it level with
       * its start rather than with wherever the drag began. */
      if (shift && drawing.points.length === 2) {
        const other = drawing.points[gesture.anchorIndex === 0 ? 1 : 0];
        at = applySnap(at, other, x, y, drawing.type);
      }
      const updated = moveAnchor(drawing, gesture.anchorIndex, at.time, at.price);
      drawings.value = list.map((d, i) => (i === index ? updated : d));
      return;
    }

    if (gesture.mode === 'move') {
      // Moving snaps the whole shape against where the drag started.
      if (shift) at = applySnap(at, gesture.startPoint, x, y, gesture.original.type);
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
      const { type, points, color, width, lineStyle: dash } = draft.value;

      // A dragged shape that never moved is a stray click, not a drawing.
      const degenerate = gesturePoints(type) === 2
        && points[0].time === points[1].time && points[0].price === points[1].price;

      if (!degenerate) {
        try {
          const drawing = createDrawing(type, points, {
            color,
            width,
            lineStyle: dash,
            ...(isPositionTool(type) ? positionStyle.value : {}),
          });
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
    notice.value = null;
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

  /** The drawing currently selected, or null. */
  function selectedDrawing() {
    return drawings.value.find((d) => d.id === selectedId.value) ?? null;
  }

  /**
   * Restyles the selected position block and remembers the choice for the next
   * one. Without the second half, every new block would snap back to the
   * defaults and the setting would feel broken.
   */
  function setPositionStyle(patch) {
    positionStyle.value = { ...positionStyle.value, ...patch };

    const selected = selectedDrawing();
    if (selected && isPositionTool(selected.type)) {
      drawings.value = drawings.value.map((d) => (
        d.id === selected.id ? { ...d, ...patch } : d
      ));
      save();
    }
  }

  /**
   * Restyles the selected drawing's stroke and remembers the choice for the
   * next one, the same way setPositionStyle does - without the second half,
   * every new drawing would snap back to a 1px solid line and the setting
   * would feel broken.
   */
  function setLineStyle(patch) {
    lineStyle.value = { ...lineStyle.value, ...patch };

    const selected = selectedDrawing();
    if (selected && !isPositionTool(selected.type)) {
      drawings.value = drawings.value.map((d) => (
        d.id === selected.id ? { ...d, ...patch } : d
      ));
      save();
    }
  }

  /**
   * Changes how the gap tool treats stacked imbalances. Nothing to restyle
   * afterwards, unlike the two style setters: the setting decides what the next
   * click picks up, and a gap already marked is a fixed pair of anchors.
   */
  function setFvgStyle(patch) {
    fvgStyle.value = { ...fvgStyle.value, ...patch };
    notice.value = null;
  }

  function deleteSelected() {
    if (!selectedId.value) return false;
    drawings.value = drawings.value.filter((d) => d.id !== selectedId.value);
    selectedId.value = null;
    save();
    return true;
  }

  /**
   * Removes one drawing by id, whether or not it is selected.
   *
   * `deleteSelected` covers the keyboard and the toolbar, which can only ever
   * mean the selected one. This is for a drawing that has been *consumed* by
   * something else — a planned trade that has now been entered, and whose block
   * the engine draws from here on.
   */
  function remove(id) {
    if (!drawings.value.some((d) => d.id === id)) return false;
    drawings.value = drawings.value.filter((d) => d.id !== id);
    if (selectedId.value === id) selectedId.value = null;
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
    notice,

    project,
    unproject,
    barsBetween,
    /* Exposed so a right-click can ask what is under the pointer. The overlay
     * only takes events while something is there, so the component doing the
     * asking is the one that owns the event, not this. */
    findAt,

    onPointerDown,
    onPointerMove,
    onPointerUp,
    cancelGesture,
    updateHover,

    positionStyle,
    lineStyle,
    fvgStyle,
    selectedDrawing,
    setPositionStyle,
    setLineStyle,
    setFvgStyle,

    setTool,
    setColor,
    deleteSelected,
    remove,
    clearAll,
    load,
  };
}
