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
 * The gesture problem
 * -------------------
 * Six kinds of tool are placed six different ways — see GESTURES in registry.js
 * — and three of them are not over when the pointer comes up. A pitchfork needs
 * three separate clicks, a polyline needs as many as the user feels like, and
 * an annotation is not finished until something has been typed into it. So a
 * gesture here has two halves: `gesture`, which lives for one press, and
 * `pending`, which lives across presses until the shape is complete.
 *
 * Times are stored in milliseconds like everything else in the app; the chart
 * works in seconds, so conversion happens at this boundary and nowhere else.
 */
import { computed, ref, shallowRef } from 'vue';
import { HIT_TOLERANCE, handleAt, snapAxis, snapToAxis } from './geometry.js';
import {
  DEFAULT_LINE_STYLE, DEFAULT_POSITION_STYLE, DEFAULT_TEXT_STYLE, FVG_COLORS,
} from './model.js';
import {
  createDrawing, moveAnchor, parseDrawing, translateDrawing, translateScreen,
} from './factory.js';
import {
  gesturePoints, hitTest, isEditable, isScreenSpace, isVariable, pointsRequired,
  specFor, styleKind,
} from './registry.js';
import { zoneAnchors, zoneAt } from './fvgSnap.js';

/** How far apart freehand samples have to be, in pixels, before one is kept. */
const FREEHAND_SPACING = 3;

/** Magnet strengths, in the order the toolbar cycles them. */
export const MAGNET_MODES = ['off', 'weak', 'strong'];

/** How close a weak magnet has to be, in pixels, before it takes hold. */
const WEAK_MAGNET_RANGE = 14;

/**
 * @param {object} deps
 * @param {() => object|null} deps.chart        the chart API
 * @param {() => object|null} deps.series       the candle series, for price conversion
 * @param {() => Array} deps.bars               current bars, time in SECONDS
 * @param {() => string|null} deps.symbol
 * @param {(id:string) => object} [deps.cacheFor] renderer scratch, for hit testing
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
  /** How annotations are set, kept across drawings like the two above. */
  const textStyle = ref({ ...DEFAULT_TEXT_STYLE });
  /** Every drawing off the chart at once — a glance at bare price. */
  const allHidden = ref(false);
  /** Whether the overlay should currently take pointer events. */
  const overlayActive = ref(false);
  const cursorStyle = ref('default');
  /** Snap to the nearest open, high, low or close: 'off', 'weak' or 'strong'. */
  const magnet = ref('off');
  /* Whether a finished drawing re-arms its tool. Off by default, which is what
   * every terminal does: one shape per arming, then back to the cursor. On, the
   * rail stays armed until it is disarmed, for marking up twenty gaps in a row. */
  const stayArmed = ref(false);
  /* What the last click could not do. A gap tool that lands on empty chart has
   * not failed — there is no imbalance there to mark — so this is a line of
   * feedback rather than an error, and it never reaches the app's error banner.
   * Cleared by the next thing that makes it untrue. */
  const notice = ref(null);
  /**
   * The annotation currently being typed into, if any.
   *
   * `{ id, x, y }` — the id of the drawing and where on the pane its editor
   * belongs. Held here rather than in the component because the lifecycle is
   * this file's: the editor opens when an anchor lands and closes when the text
   * is committed or the drawing is thrown away for having none.
   */
  const editing = ref(null);

  let gesture = null; // { mode, drawingId, anchorIndex, startPoint, original }
  /* A shape being built over several presses: {type, points}. Separate from
   * `gesture`, which is per press — see the note at the top of this file. */
  let pending = null;
  let lastSample = null; // pixel position of the last kept freehand sample

  /* A context that exists only to measure text. The annotation tools have no
   * extent until something has measured their words, and the hit test runs
   * outside any paint, so it cannot borrow the chart's. Created lazily because
   * a chart with no annotations on it never needs one. */
  let measureCtx = null;
  function measuringContext() {
    if (!measureCtx && typeof document !== 'undefined') {
      measureCtx = document.createElement('canvas').getContext('2d');
    }
    return measureCtx;
  }

  /* ─── History ─────────────────────────────────────────────────────────── */

  /* Undo works on whole snapshots of the drawing set rather than on a log of
   * described changes. That is affordable here only because every mutation in
   * this file replaces the array and copies the drawings it touches — so a
   * "snapshot" is one array reference, and two snapshots share every drawing
   * that did not change. A chart with forty drawings and a hundred steps of
   * history holds forty objects and a hundred arrays of pointers to them, not
   * four thousand drawings.
   *
   * The alternative — an inverse operation per command — is where undo bugs
   * live: every new command needs its own inverse, and the one that is wrong is
   * the one nobody exercised.
   */

  /** Steps kept. Far more than anyone walks back, and cheap for the reason above. */
  const HISTORY_LIMIT = 100;
  const past = [];
  const future = [];
  /* How deep each stack is, mirrored into refs. The stacks are plain arrays on
   * purpose — a reactive one would have Vue proxy every snapshot inside it, and
   * a snapshot is an array of drawings — so these two are what the buttons
   * watch, and syncDepths is what keeps them true. */
  const undoDepth = ref(0);
  const redoDepth = ref(0);

  function syncDepths() {
    undoDepth.value = past.length;
    redoDepth.value = future.length;
  }

  /**
   * The set as it was when the edit in progress began, or null.
   *
   * An edit is not a mutation. Dragging a level changes the array on every
   * mouse move, and typing a note is a second change that belongs with the
   * first — placing an annotation and giving it words is one thing that
   * happened, and one press of undo has to take back both, or the first press
   * leaves an annotation with no text on the chart, which is invisible and
   * still takes clicks. So an edit is opened once, held across however many
   * mutations it takes, and closed when the interaction is over.
   */
  let openSnapshot = null;

  /**
   * Whether two snapshots hold the same drawings.
   *
   * Reference equality per drawing is exactly the right test, because nothing
   * here mutates a drawing in place. It matters for the interactions that end
   * where they started: placing an annotation and dismissing its editor without
   * typing adds a drawing and removes it again, which leaves a different array
   * holding an identical set — and an undo step that visibly does nothing is
   * worse than no undo step at all.
   */
  function sameSet(a, b) {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /** Opens an edit, if one is not already open. Nesting is deliberate. */
  function beginEdit() {
    if (openSnapshot === null) openSnapshot = drawings.value;
  }

  /** Closes the open edit, recording it as one undo step if anything changed. */
  function endEdit() {
    if (openSnapshot === null) return false;
    const before = openSnapshot;
    openSnapshot = null;
    if (sameSet(before, drawings.value)) return false;

    past.push(before);
    if (past.length > HISTORY_LIMIT) past.shift();
    // A new edit forks the timeline: what was undone is no longer ahead.
    future.length = 0;
    syncDepths();
    return true;
  }

  /** Runs a change to the drawing set as one undo step. */
  function asEdit(change) {
    beginEdit();
    const result = change();
    endEdit();
    return result;
  }

  /** Clears the history. Called when the symbol changes — see load(). */
  function resetHistory() {
    past.length = 0;
    future.length = 0;
    openSnapshot = null;
    syncDepths();
  }

  /**
   * Puts a restored set on the chart, and repairs what pointed into the old one.
   *
   * A selection or an open editor that names a drawing the restored set does not
   * contain would leave handles floating over nothing, or a field typing into a
   * drawing that is gone.
   */
  function restore(snapshot) {
    drawings.value = snapshot;
    if (selectedId.value && !snapshot.some((d) => d.id === selectedId.value)) {
      selectedId.value = null;
    }
    if (editing.value && !snapshot.some((d) => d.id === editing.value.id)) {
      editing.value = null;
    }
    syncDepths();
    save();
  }

  function undo() {
    /* A shape half dragged out is not on the chart yet, so it is thrown away
     * rather than undone — but the tool stays armed, because the user asked to
     * take back the last thing they finished, not to put the tool down. An edit
     * caught in progress becomes its own step first, so the interrupted drag is
     * exactly what the next undo reverses. */
    discardDraft();
    endEdit();

    if (past.length === 0) return false;
    future.push(drawings.value);
    restore(past.pop());
    return true;
  }

  function redo() {
    discardDraft();
    endEdit();

    if (future.length === 0) return false;
    past.push(drawings.value);
    restore(future.pop());
    return true;
  }

  const canUndo = computed(() => undoDepth.value > 0);
  const canRedo = computed(() => redoDepth.value > 0);

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

  /* ─── Magnet ──────────────────────────────────────────────────────────── */

  /**
   * Snaps a point onto the nearest open, high, low or close of the bar under it.
   *
   * A level is almost always meant to sit on a specific price the market
   * printed, and placing one by eye at 1px resolution puts it a few cents off
   * every time. The magnet fixes that, and the two strengths are the difference
   * between "help me" and "do not let me miss": a weak magnet only takes hold
   * within WEAK_MAGNET_RANGE pixels, so free placement is still possible
   * between bars, while a strong one always snaps.
   *
   * The time is snapped too, onto the bar's own timestamp. Half of the value of
   * a level that sits exactly on the high is that it also starts exactly at the
   * bar that made it.
   */
  function applyMagnet(at, y) {
    if (magnet.value === 'off') return at;
    const bars = deps.bars();
    if (!Array.isArray(bars) || bars.length === 0) return at;

    const logical = timeToLogical(at.time);
    if (logical === null) return at;
    const index = Math.max(0, Math.min(bars.length - 1, Math.round(logical)));
    const bar = bars[index];
    if (!bar) return at;

    let best = null;
    let bestDistance = Infinity;
    for (const price of [bar.open, bar.high, bar.low, bar.close]) {
      const distance = Math.abs(price - at.price);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = price;
      }
    }
    if (best === null) return at;

    if (magnet.value === 'weak') {
      // Measured on screen, not in price: "within fourteen pixels" is a rule a
      // hand can follow, "within four dollars" is not.
      const candidate = project({ time: bar.time * 1000, price: best });
      if (!candidate || Math.abs(candidate.y - y) > WEAK_MAGNET_RANGE) return at;
    }

    return { time: bar.time * 1000, price: best };
  }

  /** The market point under a pixel, with the magnet applied. */
  function pointAt(x, y) {
    const at = unproject(x, y);
    return at ? applyMagnet(at, y) : null;
  }

  /* ─── Hit testing ─────────────────────────────────────────────────────── */

  function screenPoints(drawing, size) {
    if (drawing.screen) {
      return [{ x: drawing.screen.x * size.width, y: drawing.screen.y * size.height }];
    }
    const pts = drawing.points.map(project);
    return pts.some((p) => p === null) ? null : pts;
  }

  /** Topmost drawing under the pointer — later drawings sit above earlier ones. */
  function findAt(x, y, size) {
    /* Nothing that is not on the chart can be picked up. Without this a hidden
     * level still takes the pointer, so a drag that was aimed at a candle grabs
     * something invisible — the worst kind of bug to be told about, because
     * there is nothing on the screen to explain it. */
    if (allHidden.value) return null;
    for (let i = drawings.value.length - 1; i >= 0; i--) {
      const drawing = drawings.value[i];
      if (drawing.hidden) continue;
      /* A locked drawing is painted but not reachable: the pointer passes
       * through to the chart, which is the whole point of locking one. It can
       * still be selected from the object list, where the padlock is. */
      if (drawing.locked) continue;
      const pts = screenPoints(drawing, size);
      if (!pts) continue;
      if (hitTest(drawing.type, pts, { x, y }, size, drawing, measuringContext(),
        { cache: deps.cacheFor?.(drawing.id) })) return drawing;
    }
    return null;
  }

  function findHandle(x, y, size) {
    if (!selectedId.value) return -1;
    const drawing = drawings.value.find((d) => d.id === selectedId.value);
    if (!drawing || drawing.locked) return -1;
    // A pane-anchored drawing has no anchors to grab: its one point is derived
    // from the pane, and dragging it means moving the whole thing.
    if (drawing.screen) return -1;
    const pts = screenPoints(drawing, size);
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

    if (findHandle(x, y, size) !== -1) {
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
   * Tools that declare noAxisSnap are left alone. A position block is the one
   * that does: its three anchors already encode a direction, and locking a drag
   * to the horizontal would set the risk to zero, which is not a position
   * anyone is trying to draw.
   */
  function applySnap(at, anchor, x, y, type) {
    if (specFor(type)?.noAxisSnap) return at;
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

  /** Style options a new drawing of a given type starts with. */
  function styleFor(type) {
    const kind = styleKind(type);
    return {
      color: activeColor.value,
      ...lineStyle.value,
      ...(kind === 'position' ? positionStyle.value : {}),
      ...(kind === 'text' ? textStyle.value : {}),
    };
  }

  /**
   * Adds a finished drawing, selects it, and persists.
   *
   * Opens an edit but does not close it: an annotation is not finished until it
   * has words, and the editor's commit closes the same edit so that placing and
   * typing come back as one undo. The callers that are done here close it
   * themselves.
   */
  function commit(drawing) {
    beginEdit();
    drawings.value = [...drawings.value, drawing];
    selectedId.value = drawing.id;
    notice.value = null;
    save();
    return drawing;
  }

  /** Throws away whatever shape was being built, leaving the tool as it is. */
  function discardDraft() {
    gesture = null;
    pending = null;
    lastSample = null;
    draft.value = null;
  }

  /** Puts the rail back to the cursor, unless the user asked it to stay armed. */
  function disarm() {
    pending = null;
    draft.value = null;
    lastSample = null;
    if (!stayArmed.value) {
      activeTool.value = 'cursor';
      overlayActive.value = false;
      cursorStyle.value = 'default';
    }
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
      commit(createDrawing('fvg', [
        { time: top.time * 1000, price: top.price },
        { time: bottom.time * 1000, price: bottom.price },
      ], {
        ...styleFor('fvg'),
        color: FVG_COLORS[zone.direction],
        direction: zone.direction,
      }));
    } catch (err) {
      deps.onError(err);
    }

    endEdit();
    disarm();
  }

  /**
   * Places a pane-anchored drawing — an anchored note or caption.
   *
   * Stored as a fraction of the pane rather than as a time and a price, so it
   * stays where it was put when the chart is panned under it.
   */
  function placeScreen(type, x, y, size) {
    try {
      const drawing = commit(createDrawing(type, [], {
        ...styleFor(type),
        screen: { x: x / size.width, y: y / size.height },
      }));
      if (isEditable(type)) editing.value = { id: drawing.id, x, y };
    } catch (err) {
      deps.onError(err);
    }
    // An editable one keeps its edit open until the text is settled.
    if (!isEditable(type)) endEdit();
    disarm();
  }

  /** Finishes a shape that has collected all the anchors it needs. */
  function finish(type, points, at) {
    try {
      const drawing = commit(createDrawing(type, points, styleFor(type)));
      if (isEditable(type)) {
        const anchor = at ?? project(points[0]);
        editing.value = { id: drawing.id, x: anchor?.x ?? 0, y: anchor?.y ?? 0 };
      }
    } catch (err) {
      deps.onError(err);
    }
    if (!isEditable(type)) endEdit();
    disarm();
  }

  function onPointerDown(x, y, size) {
    const at = pointAt(x, y);
    if (!at) return;
    const tool = activeTool.value;

    if (tool !== 'cursor') {
      const spec = specFor(tool);
      if (!spec) return;

      switch (spec.gesture) {
        case 'pick':
          // Picked, not dragged, so it never opens a gesture.
          placeFvg(x, y, at);
          return;

        case 'click':
          if (isScreenSpace(tool)) placeScreen(tool, x, y, size);
          else finish(tool, [at], { x, y });
          return;

        case 'clicks':
        case 'poly': {
          /* Each press adds one anchor. The draft carries the anchors placed so
           * far plus the pointer, so the shape is visible while it is being
           * built rather than appearing all at once at the last click. */
          if (!pending || pending.type !== tool) pending = { type: tool, points: [] };
          pending.points.push(at);
          if (spec.gesture === 'clicks' && pending.points.length >= spec.points) {
            finish(tool, pending.points, { x, y });
            return;
          }
          // Redrawn here as well as on the next move, so the anchor that was
          // just placed appears under the pointer rather than a frame later.
          draft.value = {
            type: tool,
            ...styleFor(tool),
            points: [...pending.points, at],
          };
          return;
        }

        case 'free':
          pending = { type: tool, points: [at] };
          lastSample = { x, y };
          gesture = { mode: 'create', start: at };
          draft.value = { type: tool, ...styleFor(tool), points: [at, at] };
          return;

        default:
          // A drag. The draft always holds finished anchors, so a position
          // block shows its zones and its reward-to-risk while it is still
          // being dragged out.
          draft.value = {
            type: tool,
            ...styleFor(tool),
            points: buildDraftPoints(tool, at, at),
          };
          gesture = { mode: 'create', start: at };
          return;
      }
    }

    const handleIndex = findHandle(x, y, size);
    if (handleIndex !== -1) {
      /* The edit opens here and closes on the release. Without that a drag
       * across the pane would leave one undo step per mouse move, and walking
       * a level back to where it started would take four hundred presses. */
      beginEdit();
      gesture = { mode: 'handle', drawingId: selectedId.value, anchorIndex: handleIndex };
      return;
    }

    const hit = findAt(x, y, size);
    selectedId.value = hit ? hit.id : null;
    if (hit) {
      beginEdit();
      gesture = {
        mode: 'move',
        drawingId: hit.id,
        startPoint: at,
        startPixel: { x, y },
        original: hit,
      };
    }
  }

  /** The anchors a drag has produced so far, through the tool's own build(). */
  function buildDraftPoints(type, start, end) {
    const spec = specFor(type);
    if (spec?.build) return spec.build(start, end);
    return spec?.points === 1 ? [start] : [start, end];
  }

  function onPointerMove(x, y, size, shift = false) {
    // A multi-click shape previews against the pointer even between presses,
    // which is the only thing that makes three-click tools placeable.
    if (pending && !gesture) {
      const at = pointAt(x, y);
      if (at) {
        draft.value = {
          type: pending.type,
          ...styleFor(pending.type),
          points: [...pending.points, at],
        };
      }
      return;
    }

    if (!gesture) {
      updateHover(x, y, size);
      return;
    }
    let at = pointAt(x, y);
    if (!at) return;

    if (gesture.mode === 'create') {
      const spec = specFor(draft.value.type);

      if (spec?.gesture === 'free') {
        /* Freehand keeps every sample far enough from the last one to be worth
         * keeping. Without the spacing rule a slow hand produces hundreds of
         * points a second, all of them within a pixel of each other, and the
         * stroke costs more to store and paint than the whole rest of the
         * chart. */
        if (!lastSample || Math.hypot(x - lastSample.x, y - lastSample.y) >= FREEHAND_SPACING) {
          pending.points.push(at);
          lastSample = { x, y };
          draft.value = { ...draft.value, points: [...pending.points] };
        }
        return;
      }

      if (gesturePoints(draft.value.type) === 2) {
        if (shift) at = applySnap(at, gesture.start, x, y, draft.value.type);
        draft.value = {
          ...draft.value,
          points: buildDraftPoints(draft.value.type, gesture.start, at),
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
      const original = gesture.original;

      /* A pane-anchored drawing moves in pane fractions; everything else moves
       * in market units. See translateScreen for why these are two functions
       * rather than one that reinterprets its arguments. */
      if (original.screen) {
        const moved = translateScreen(original,
          (x - gesture.startPixel.x) / size.width,
          (y - gesture.startPixel.y) / size.height);
        drawings.value = list.map((d, i) => (i === index ? moved : d));
        return;
      }

      // Moving snaps the whole shape against where the drag started.
      if (shift) at = applySnap(at, gesture.startPoint, x, y, original.type);
      const moved = translateDrawing(
        original,
        at.time - gesture.startPoint.time,
        at.price - gesture.startPoint.price,
      );
      drawings.value = list.map((d, i) => (i === index ? moved : d));
    }
  }

  function onPointerUp() {
    if (!gesture) return;

    if (gesture.mode === 'create' && draft.value) {
      const { type, points } = draft.value;
      const spec = specFor(type);

      if (spec?.gesture === 'free') {
        // A stroke of one point is a click, not a drawing.
        if (pending && pending.points.length >= spec.minPoints) {
          finish(type, pending.points, null);
        } else {
          disarm();
        }
        gesture = null;
        return;
      }

      // A dragged shape that never moved is a stray click, not a drawing.
      const degenerate = gesturePoints(type) === 2
        && points[0].time === points[1].time && points[0].price === points[1].price;

      if (degenerate) disarm();
      else finish(type, points, null);

      gesture = null;
      return;
    }

    // A move or a handle drag: one step, closed here.
    endEdit();
    save();
    gesture = null;
  }

  /**
   * Ends an open-ended shape where it currently stands — a double-click, Enter,
   * or the tool being disarmed.
   *
   * Returns whether anything was finished, so the caller can tell a deliberate
   * finish from a keystroke that meant something else.
   */
  function finishPending() {
    if (!pending) return false;
    const spec = specFor(pending.type);
    const enough = isVariable(pending.type)
      ? pending.points.length >= spec.minPoints
      : pending.points.length >= spec.points;

    if (!enough) {
      disarm();
      return false;
    }
    finish(pending.type, pending.points, null);
    return true;
  }

  function cancelGesture() {
    const building = gesture?.mode === 'create' || pending;
    /* A drag that was interrupted rather than finished still moved something,
     * so it is recorded as a step. A shape that was never committed has nothing
     * to record and closing the edit is a no-op. */
    endEdit();
    discardDraft();
    if (building) {
      activeTool.value = 'cursor';
      overlayActive.value = false;
      cursorStyle.value = 'default';
    }
  }

  /* ─── Text ────────────────────────────────────────────────────────────── */

  /**
   * Stores what was typed into the annotation being edited.
   *
   * An annotation left empty is removed rather than kept: it would be an
   * invisible object that still takes clicks, which is indistinguishable from a
   * bug. Cancelling a *new* one therefore deletes it; cancelling an edit of an
   * existing one that already had words leaves those words alone.
   */
  function commitText(value) {
    const target = editing.value;
    editing.value = null;
    if (!target) {
      endEdit();
      return;
    }

    const text = (value ?? '').trim();
    if (!text) {
      remove(target.id);
      /* Placing an annotation and dismissing its editor without typing leaves
       * the set exactly as it was, so endEdit records nothing — see sameSet. */
      endEdit();
      return;
    }
    beginEdit();
    drawings.value = drawings.value.map((d) => (
      d.id === target.id ? { ...d, text } : d
    ));
    save();
    endEdit();
  }

  function cancelText() {
    const target = editing.value;
    editing.value = null;
    if (target) {
      const drawing = drawings.value.find((d) => d.id === target.id);
      if (drawing && !drawing.text) remove(target.id);
    }
    endEdit();
  }

  /** Opens the editor on an existing annotation, from the object list. */
  function editText(id) {
    const drawing = drawings.value.find((d) => d.id === id);
    if (!drawing || styleKind(drawing.type) !== 'text') return false;
    const anchor = drawing.screen ? null : project(drawing.points[0]);
    selectedId.value = id;
    editing.value = { id, x: anchor?.x ?? 40, y: anchor?.y ?? 40 };
    return true;
  }

  /* ─── Commands ────────────────────────────────────────────────────────── */

  function setTool(tool) {
    // Arming a different tool abandons whatever was half-built.
    pending = null;
    draft.value = null;
    lastSample = null;
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
      asEdit(() => {
        drawings.value = drawings.value.map((d) => (
          d.id === selectedId.value ? { ...d, color } : d
        ));
        save();
      });
    }
  }

  /** The drawing currently selected, or null. */
  function selectedDrawing() {
    return drawings.value.find((d) => d.id === selectedId.value) ?? null;
  }

  /**
   * Restyles the selected drawing and remembers the choice for the next one.
   *
   * Without the second half, every new drawing would snap back to the defaults
   * and the setting would feel broken. `kind` keeps the three style bars from
   * writing over each other: a width chosen on a trend line must not become the
   * next position block's, because a block has no width to set.
   */
  function applyStyle(store, kind, patch) {
    store.value = { ...store.value, ...patch };
    const selected = selectedDrawing();
    if (selected && styleKind(selected.type) === kind) {
      asEdit(() => {
        drawings.value = drawings.value.map((d) => (
          d.id === selected.id ? { ...d, ...patch } : d
        ));
        save();
      });
    }
  }

  const setPositionStyle = (patch) => applyStyle(positionStyle, 'position', patch);
  const setLineStyle = (patch) => applyStyle(lineStyle, 'line', patch);
  const setTextStyle = (patch) => applyStyle(textStyle, 'text', patch);

  /**
   * Changes how the gap tool treats stacked imbalances. Nothing to restyle
   * afterwards, unlike the style setters: the setting decides what the next
   * click picks up, and a gap already marked is a fixed pair of anchors.
   */
  function setFvgStyle(patch) {
    fvgStyle.value = { ...fvgStyle.value, ...patch };
    notice.value = null;
  }

  /** Cycles the magnet through off, weak and strong. */
  function cycleMagnet() {
    const next = (MAGNET_MODES.indexOf(magnet.value) + 1) % MAGNET_MODES.length;
    magnet.value = MAGNET_MODES[next];
    return magnet.value;
  }

  function setStayArmed(on) {
    stayArmed.value = on === true;
  }

  function deleteSelected() {
    if (!selectedId.value) return false;
    const drawing = drawings.value.find((d) => d.id === selectedId.value);
    // A locked drawing does not go away on a keystroke — that is what the lock
    // is for. It has to be unlocked first, from the object list.
    if (!drawing || drawing.locked) return false;
    return asEdit(() => {
      drawings.value = drawings.value.filter((d) => d.id !== selectedId.value);
      selectedId.value = null;
      save();
      return true;
    });
  }

  /**
   * Puts one drawing away, or brings it back.
   *
   * Hidden is stored with the drawing rather than held in the session: a chart
   * with a season of work on it is read by putting most of it away, and having
   * to do that again every time the app opens would make the feature not worth
   * using.
   */
  function setHidden(id, hidden) {
    const drawing = drawings.value.find((d) => d.id === id);
    if (!drawing || drawing.hidden === hidden) return false;
    return asEdit(() => {
      drawings.value = drawings.value.map((d) => (d.id === id ? { ...d, hidden } : d));
      // A hidden drawing cannot stay selected — its handles would be the only
      // thing left of it on the chart.
      if (hidden && selectedId.value === id) selectedId.value = null;
      save();
      return true;
    });
  }

  function toggleHidden(id) {
    const drawing = drawings.value.find((d) => d.id === id);
    return drawing ? setHidden(id, !drawing.hidden) : false;
  }

  /**
   * Locks one drawing against the pointer, or releases it.
   *
   * Stored like `hidden` and for the same reason: a chart whose structure is
   * settled stays settled across restarts, or the lock is busywork.
   */
  function setLocked(id, locked) {
    const drawing = drawings.value.find((d) => d.id === id);
    if (!drawing || drawing.locked === locked) return false;
    return asEdit(() => {
      drawings.value = drawings.value.map((d) => (d.id === id ? { ...d, locked } : d));
      save();
      return true;
    });
  }

  function toggleLocked(id) {
    const drawing = drawings.value.find((d) => d.id === id);
    return drawing ? setLocked(id, !drawing.locked) : false;
  }

  /** Locks or releases everything at once, for settling a chart in one go. */
  function setAllLocked(locked) {
    if (!drawings.value.some((d) => d.locked !== locked)) return false;
    return asEdit(() => {
      drawings.value = drawings.value.map((d) => ({ ...d, locked }));
      if (locked) selectedId.value = null;
      save();
      return true;
    });
  }

  /**
   * Takes every drawing off the chart at once, without touching any of them.
   *
   * A different thing from hiding them one by one, and deliberately not
   * persisted: this is "let me look at the price for a minute", and a glance
   * that survived a restart would look like the drawings had been lost.
   */
  function setAllHidden(on) {
    allHidden.value = on;
    if (on) selectedId.value = null;
  }

  /** What the chart paints, and the only thing the pointer can reach. */
  function visibleDrawings() {
    if (allHidden.value) return [];
    return drawings.value.filter((d) => !d.hidden);
  }

  /**
   * Removes one drawing by id, whether or not it is selected.
   *
   * `deleteSelected` covers the keyboard and the toolbar, which can only ever
   * mean the selected one. This is for a drawing that has been *consumed* by
   * something else — a planned trade that has now been entered, and whose block
   * the engine draws from here on — and for the object list, which addresses
   * drawings by id and is allowed to delete a locked one.
   */
  function remove(id) {
    if (!drawings.value.some((d) => d.id === id)) return false;
    return asEdit(() => {
      drawings.value = drawings.value.filter((d) => d.id !== id);
      if (selectedId.value === id) selectedId.value = null;
      if (editing.value?.id === id) editing.value = null;
      save();
      return true;
    });
  }

  function clearAll() {
    asEdit(() => {
      drawings.value = [];
      selectedId.value = null;
      editing.value = null;
      save();
    });
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
    editing.value = null;
    pending = null;
    /* History belongs to the symbol. Carrying it across would let one undo
     * paste another instrument's drawings onto this chart — and then save them
     * under this symbol's name. */
    resetHistory();
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
    editing,
    magnet,
    stayArmed,

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
    finishPending,
    updateHover,

    positionStyle,
    lineStyle,
    textStyle,
    fvgStyle,
    selectedDrawing,
    setPositionStyle,
    setLineStyle,
    setTextStyle,
    setFvgStyle,

    setTool,
    setColor,
    cycleMagnet,
    undo,
    redo,
    canUndo,
    canRedo,
    setStayArmed,
    deleteSelected,
    remove,
    clearAll,
    load,

    commitText,
    cancelText,
    editText,

    allHidden,
    setAllHidden,
    setHidden,
    toggleHidden,
    setLocked,
    toggleLocked,
    setAllLocked,
    visibleDrawings,
  };
}
