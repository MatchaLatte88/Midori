/* Every tool, exercised once.
 *
 * Eighty-six renderers is eighty-six chances for a typo that only shows up as a
 * blank chart and an exception in a canvas callback, where nothing in the app
 * is watching. So each one is built, painted against a recording context and
 * asked about a click. The assertions are deliberately shallow — this is not
 * checking that a Gann fan is correct, it is checking that every tool is wired
 * up, draws something, and answers a hit test without throwing.
 *
 * The canvas and the token lookups are stubbed rather than mocked from a DOM
 * library: the tools only use a handful of context calls, and a stub that
 * records them is both faster and a clearer statement of what they are allowed
 * to depend on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

/* The renderers resolve their colours through getComputedStyle, and the
 * annotation tools measure text. Both have to exist before the modules under
 * test are imported, because render.js reads them at call time from the
 * globals. */
globalThis.document = {
  documentElement: {},
  createElement: () => ({ getContext: () => makeContext() }),
};
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '#7dd3a0' });

const { TOOL_SPECS, hitTest, pointsRequired, isVariable, isScreenSpace } =
  await import('../src/components/chart/drawings/registry.js');
const { createDrawing } = await import('../src/components/chart/drawings/factory.js');

const SIZE = { width: 900, height: 500 };

/** A canvas context that records what was asked of it. */
function makeContext() {
  const calls = [];
  const record = (name) => (...args) => { calls.push({ name, args }); };
  return {
    calls,
    canvas: { width: SIZE.width, height: SIZE.height },
    globalAlpha: 1,
    lineWidth: 1,
    strokeStyle: '',
    fillStyle: '',
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    lineCap: 'butt',
    lineJoin: 'miter',
    _dash: [],
    save: record('save'),
    restore: record('restore'),
    beginPath: record('beginPath'),
    closePath: record('closePath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    arc: record('arc'),
    ellipse: record('ellipse'),
    rect: record('rect'),
    stroke: record('stroke'),
    fill: record('fill'),
    fillRect: record('fillRect'),
    strokeRect: record('strokeRect'),
    fillText: record('fillText'),
    strokeText: record('strokeText'),
    measureText: (text) => ({ width: String(text).length * 6 }),
    setLineDash(dash) { this._dash = dash; calls.push({ name: 'setLineDash', args: [dash] }); },
    getLineDash() { return this._dash; },
  };
}

/* Bars a tool can be fitted to. Enough of them, and varied enough, that the
 * regression and VWAP tools have something real to work on. */
const BARS = Array.from({ length: 60 }, (_, i) => ({
  time: 1_700_000_000 + i * 3600,
  open: 100 + i,
  high: 103 + i,
  low: 98 + i,
  close: 101 + i,
  volume: 1000 + i * 10,
}));

const FIRST = BARS[0].time * 1000;
const STEP = 3600 * 1000;

/**
 * Anchors for a tool, spread out enough that no two coincide.
 *
 * A degenerate shape is a legitimate thing to paint — it happens on the first
 * frame of every drag — but it is not what this test is for, and a zero-length
 * leg would let a renderer skip most of its own body.
 */
function anchorsFor(type) {
  const count = isVariable(type) ? pointsRequired(type) + 2 : pointsRequired(type);
  return Array.from({ length: count }, (_, i) => ({
    time: FIRST + (i + 4) * STEP * 3,
    // Alternating, so patterns are zigzags and channels have a width.
    price: 110 + i * 7 * (i % 2 === 0 ? 1 : -1),
  }));
}

/** The environment the primitive hands a renderer. */
function envFor(drawing, ctx) {
  const points = drawing.screen
    ? [{ x: drawing.screen.x * SIZE.width, y: drawing.screen.y * SIZE.height }]
    : drawing.points.map(project);
  return {
    size: SIZE,
    pts: points,
    drawing,
    color: '#7dd3a0',
    selected: false,
    chrome: { text: '#eee', panel: '#111', pos: '#3a7', neg: '#a33', line: '#333' },
    tokenColor: (id) => `var(--${id})`,
    project,
    bars: () => BARS,
    barsBetween: (a, b) => Math.abs(Math.round((b - a) / STEP)),
    cache: {},
    ctx,
  };
}

/** A linear stand-in for the chart's own projection. */
function project(point) {
  return {
    x: ((point.time - FIRST) / STEP) * 2,
    y: SIZE.height - (point.price - 80) * 4,
  };
}

test('every tool builds, paints and answers a hit test', () => {
  for (const spec of TOOL_SPECS) {
    const ctx = makeContext();
    const screen = isScreenSpace(spec.id) ? { x: 0.3, y: 0.4 } : undefined;
    const points = isScreenSpace(spec.id) ? [] : anchorsFor(spec.id);

    const drawing = createDrawing(spec.id, points, {
      color: 'ind-1',
      // Only the gap tool demands one, and only it reads it.
      ...(spec.id === 'fvg' ? { direction: 'bull' } : {}),
      ...(screen ? { screen } : {}),
      // An annotation with no words draws nothing, which would make this test
      // pass for the wrong reason.
      ...(spec.style === 'text' ? { text: 'note\nsecond line' } : {}),
    });

    const env = envFor(drawing, ctx);
    assert.doesNotThrow(() => spec.draw(ctx, env), `${spec.id} threw while painting`);

    /* Something has to reach the canvas. A renderer that returns early on
     * complete, well-formed anchors is the exact bug this test is for. */
    assert.ok(ctx.calls.length > 0, `${spec.id} painted nothing`);

    const at = env.pts[0];
    assert.doesNotThrow(
      () => hitTest(spec.id, env.pts, at, SIZE, drawing, ctx, env),
      `${spec.id} threw while hit testing`,
    );
    assert.equal(
      typeof hitTest(spec.id, env.pts, at, SIZE, drawing, ctx, env),
      'boolean',
      `${spec.id} answered a hit test with something other than a boolean`,
    );
  }
});

test('a click far from a drawing misses it', () => {
  /* Not every tool can be tested this way — the ones that span the whole pane
   * are hit everywhere along an axis by design, and the radial tools cover
   * their own area. So this checks the shapes that are genuinely local, which
   * is where a broken hit test would actually be felt. */
  const local = [
    'trendline', 'rectangle', 'measure', 'position', 'fvg', 'fib',
    'polyline', 'triangle', 'circle', 'abcd', 'callout',
  ];

  for (const type of local) {
    const ctx = makeContext();
    const drawing = createDrawing(type, anchorsFor(type), {
      ...(type === 'fvg' ? { direction: 'bear' } : {}),
      ...(type === 'callout' ? { text: 'x' } : {}),
    });
    const env = envFor(drawing, ctx);
    const far = { x: -4000, y: -4000 };
    assert.equal(
      hitTest(type, env.pts, far, SIZE, drawing, ctx, env), false,
      `${type} claims a hit four thousand pixels away`,
    );
  }
});

test('an unfinished shape survives being asked about', () => {
  /* Half-placed anchors are the normal state of a three-click tool, and the
   * pointer runs over them the whole time it is being placed. A partial shape
   * never reaches findAt — only finished drawings are stored, and a draft is
   * not hit-tested — so the requirement here is not that it misses, it is that
   * nothing indexes past the end of the array it was handed. Several tools
   * legitimately answer yes: a pattern is a polyline whether or not its last
   * pivot is in yet. */
  for (const spec of TOOL_SPECS) {
    if (isScreenSpace(spec.id)) continue;
    const needed = pointsRequired(spec.id);
    if (needed < 2) continue;

    const drawing = createDrawing(spec.id, anchorsFor(spec.id), {
      ...(spec.id === 'fvg' ? { direction: 'bull' } : {}),
      ...(spec.style === 'text' ? { text: 'x' } : {}),
    });
    const ctx = makeContext();
    const env = envFor(drawing, ctx);

    for (let n = 1; n < needed; n++) {
      const partial = env.pts.slice(0, n);
      assert.equal(
        typeof hitTest(spec.id, partial, partial[0], SIZE, drawing, ctx, env), 'boolean',
        `${spec.id} broke when asked about ${n} of ${needed} anchors`,
      );
      assert.doesNotThrow(
        () => spec.draw(ctx, { ...env, pts: partial }),
        `${spec.id} threw while painting ${n} of ${needed} anchors`,
      );
    }
  }
});

test('the shapes that enclose an area are hit inside them, not only on the edge', () => {
  // Clicking the middle of a box is how anyone picks one up; an outline-only
  // hit test makes a zone feel broken.
  const enclosing = ['rectangle', 'fvg', 'rangeprofile', 'position', 'triangle', 'ellipse'];
  for (const type of enclosing) {
    const ctx = makeContext();
    const drawing = createDrawing(type, anchorsFor(type), {
      ...(type === 'fvg' ? { direction: 'bull' } : {}),
    });
    const env = envFor(drawing, ctx);
    const xs = env.pts.map((p) => p.x);
    const ys = env.pts.map((p) => p.y);
    const middle = {
      x: (Math.min(...xs) + Math.max(...xs)) / 2,
      y: (Math.min(...ys) + Math.max(...ys)) / 2,
    };
    assert.equal(
      hitTest(type, env.pts, middle, SIZE, drawing, ctx, env), true,
      `${type} cannot be picked up from the middle`,
    );
  }
});

test('a tool paints nothing rather than throwing when its anchors are degenerate', () => {
  // The first frame of every drag: both anchors on the same pixel.
  const at = { time: FIRST + 10 * STEP, price: 120 };
  for (const spec of TOOL_SPECS) {
    if (isScreenSpace(spec.id)) continue;
    const count = isVariable(spec.id) ? pointsRequired(spec.id) : spec.points;
    const drawing = createDrawing(spec.id, Array.from({ length: count }, () => ({ ...at })), {
      ...(spec.id === 'fvg' ? { direction: 'bull' } : {}),
      ...(spec.style === 'text' ? { text: 'x' } : {}),
    });
    const ctx = makeContext();
    assert.doesNotThrow(
      () => spec.draw(ctx, envFor(drawing, ctx)),
      `${spec.id} threw on a degenerate shape`,
    );
  }
});
