/* Tool icons, as data rather than as markup.
 *
 * Eighty-seven tools cannot each be a branch in a template — the toolbar was one
 * `v-else-if` per icon when there were ten, and that does not scale. So an icon
 * is a list of primitives in a 24x24 box and the toolbar renders any of them
 * with one loop.
 *
 * Primitives:
 *   ['p', d]              a stroked path
 *   ['f', d]              a filled path
 *   ['c', cx, cy, r]      a stroked circle
 *   ['fc', cx, cy, r]     a filled circle
 *   ['r', x, y, w, h]     a stroked rectangle
 *   ['fr', x, y, w, h, a] a filled rectangle at alpha a
 *
 * The drawn shape is the tool's own shape wherever that is legible at 18px.
 * Where it is not — the harmonics, the Elliott counts — the icon shows the
 * skeleton rather than the detail, because at this size a five-legged zigzag
 * with labels on it is a smudge.
 */

/* Anchor dots mark the points a tool is defined by. They are what tells a
 * trend line from a ray at a glance: same stroke, different anchors. */
const A = (x, y) => ['c', x, y, 2];

export const ICONS = {
  cursor: [['f', 'M5 3l6 16 2.5-6.5L20 10z']],

  /* ─── Lines ───────────────────────────────────────────────────────────── */
  trendline: [['p', 'M5 18L19 6'], A(5, 18), A(19, 6)],
  ray: [['p', 'M4 19L19 7'], A(4, 19), ['p', 'M14 6.5h5.5V12']],
  extended: [['p', 'M3 20L21 4'], A(8, 15.5), A(16, 8.5)],
  infoline: [['p', 'M4 19L14 9'], A(4, 19), A(14, 9), ['p', 'M15 4h6v5h-6z']],
  trendangle: [['p', 'M4 19L18 7'], ['p', 'M4 19h11'], ['p', 'M12 19a8 8 0 0 0-2.4-5.7'], A(4, 19)],
  horizontal: [['p', 'M3 12h18'], A(8, 12)],
  horizontalray: [['p', 'M7 12h14'], A(7, 12), ['p', 'M17 9l3 3-3 3']],
  vertical: [['p', 'M12 3v18'], A(12, 8)],
  crossline: [['p', 'M3 12h18M12 3v18'], A(12, 12)],
  arrow: [['p', 'M4 19L17 7'], ['f', 'M20 4l-1.4 6L14 5.5z'], A(4, 19)],
  arrowup: [['p', 'M12 20V7'], ['f', 'M12 3l5 6H7z']],
  arrowdown: [['p', 'M12 4v13'], ['f', 'M12 21l5-6H7z']],
  arrowleft: [['p', 'M20 12H7'], ['f', 'M3 12l6 5V7z']],
  arrowright: [['p', 'M4 12h13'], ['f', 'M21 12l-6 5V7z']],

  /* ─── Channels ────────────────────────────────────────────────────────── */
  parallelchannel: [['p', 'M3 15L18 5'], ['p', 'M6 20L21 10'], ['fr', 3, 5, 18, 15, 0.12]],
  disjointchannel: [['p', 'M3 14L19 5'], ['p', 'M4 20L21 14']],
  flatchannel: [['p', 'M3 17L20 8'], ['p', 'M3 5h17'], ['fr', 3, 5, 17, 12, 0.1]],
  regression: [
    ['p', 'M3 17L21 7'], ['p', 'M3 12L21 2'], ['p', 'M3 22L21 12'],
    ['fc', 7, 15, 1], ['fc', 12, 13, 1], ['fc', 17, 10, 1],
  ],

  /* ─── Pitchfork ───────────────────────────────────────────────────────── */
  pitchfork: [['p', 'M4 12L20 12'], ['p', 'M9 4L21 4'], ['p', 'M9 20L21 20'], ['p', 'M4 12L9 4M4 12L9 20'], A(4, 12)],
  schiff: [['p', 'M4 9L20 12'], ['p', 'M9 4L21 6'], ['p', 'M9 20L21 21'], ['p', 'M4 9L9 4M4 9L9 20']],
  modschiff: [['p', 'M7 12L20 12'], ['p', 'M9 4L21 4'], ['p', 'M9 20L21 20'], ['p', 'M7 12L9 4M7 12L9 20'], A(3, 12)],
  insidepitchfork: [['p', 'M7 8L20 11'], ['p', 'M10 3L21 5'], ['p', 'M8 17L21 19'], A(7, 8), A(10, 3)],
  pitchfan: [['p', 'M4 20L21 4M4 20L21 10M4 20L21 16M4 20L14 3'], A(4, 20)],

  /* ─── Fibonacci ───────────────────────────────────────────────────────── */
  fib: [['p', 'M4 6h16M4 10h16M4 14h16M4 18h16']],
  fibextension: [['p', 'M3 18L8 8L12 14'], ['p', 'M12 5h9M12 9h9M12 13h9M12 17h9']],
  fibchannel: [['p', 'M3 20L15 4'], ['p', 'M7 21L19 5'], ['p', 'M11 22L21 8']],
  fibtimezone: [['p', 'M4 3v18M7 3v18M12 3v18M20 3v18']],
  fibtimeextension: [['p', 'M3 16L8 8'], ['p', 'M11 3v18M14 3v18M19 3v18']],
  fibcircles: [['c', 12, 12, 3], ['c', 12, 12, 6], ['c', 12, 12, 9]],
  fibspeedarcs: [['p', 'M4 20a6 6 0 0 1 6-6M4 20a11 11 0 0 1 11-11M4 20a16 16 0 0 1 16-16'], A(4, 20)],
  fibspeedfan: [['r', 4, 4, 16, 16], ['p', 'M4 4L20 20M4 4L20 12M4 4L12 20']],
  fibwedge: [['p', 'M4 20L20 8'], ['p', 'M4 20a8 8 0 0 1 5.6-7.6M4 20a14 14 0 0 1 9.8-13.4'], A(4, 20)],
  fibspiral: [['p', 'M13 12a1.5 1.5 0 1 0-1.5-1.5A3.5 3.5 0 0 0 15 14a6 6 0 0 0 6-6A9.5 9.5 0 0 0 3 6.5']],

  /* ─── Gann ────────────────────────────────────────────────────────────── */
  gannbox: [['r', 4, 4, 16, 16], ['p', 'M4 10h16M4 15h16M10 4v16M15 4v16']],
  gannfan: [['p', 'M4 20L20 4M4 20L20 11M4 20L20 16M4 20L13 4M4 20L9 4'], A(4, 20)],
  gannsquare: [['r', 4, 6, 16, 12], ['p', 'M4 6l16 12M20 6L4 18M4 12h16M12 6v12']],
  gannsquarefixed: [['r', 5, 5, 14, 14], ['p', 'M5 5l14 14M19 5L5 19'], ['p', 'M5 19a14 14 0 0 0 14-14']],

  /* ─── Shapes ──────────────────────────────────────────────────────────── */
  rectangle: [['r', 4, 6, 16, 12]],
  rotatedrect: [['p', 'M3 14L13 5L21 10L11 19z']],
  circle: [['c', 12, 12, 8], ['fc', 12, 12, 1]],
  ellipse: [['p', 'M12 5c4.4 0 8 3.1 8 7s-3.6 7-8 7-8-3.1-8-7 3.6-7 8-7z']],
  triangle: [['p', 'M12 4L21 19H3z']],
  polyline: [['p', 'M3 18L8 9L13 15L21 5'], A(3, 18), A(21, 5)],
  path: [['p', 'M3 18L9 10L14 14'], ['f', 'M21 5l-1 6-5-4z']],
  brush: [['p', 'M3 19c4-1 3-9 7-9s3 6 6 6 4-4 5-8']],
  highlighter: [['p', 'M4 16c5-2 9-8 15-9'], ['p', 'M4 20h16']],
  curve: [['p', 'M4 18C8 4 16 4 20 18'], A(4, 18), A(20, 18)],
  arc: [['p', 'M4 18C8 4 16 4 20 18'], ['p', 'M4 18h16'], ['fr', 4, 8, 16, 10, 0.12]],
  doublecurve: [['p', 'M3 18C7 18 7 6 12 6s5 12 9 12'], A(3, 18), A(21, 18)],

  /* ─── Text ────────────────────────────────────────────────────────────── */
  text: [['p', 'M5 6h14M12 6v13'], ['p', 'M9 19h6']],
  anchoredtext: [['p', 'M6 8h12M12 8v10'], ['p', 'M9 18h6'], ['r', 3, 4, 18, 17]],
  note: [['r', 9, 4, 12, 10], ['p', 'M9 12L4 19'], ['fc', 4, 19, 1.6], ['p', 'M12 7h6M12 10h4']],
  anchorednote: [['r', 8, 5, 13, 10], ['p', 'M11 8h7M11 11h4'], ['r', 3, 3, 18, 18]],
  callout: [['r', 8, 4, 13, 10], ['p', 'M8 12L3 20'], ['fc', 3, 20, 1.6], ['p', 'M11 7h7M11 10h4']],
  comment: [['fc', 12, 10, 6], ['f', 'M9 14l0.5 5L14 15z']],
  signpost: [['p', 'M12 21V9'], ['r', 12, 3, 9, 6], ['fc', 12, 21, 1.6]],
  flag: [['p', 'M7 21V4'], ['f', 'M7 4h11l-3 3.5L18 11H7z']],
  sticker: [['c', 12, 12, 8], ['fc', 9.5, 10, 1.2], ['fc', 14.5, 10, 1.2], ['p', 'M8.5 14.5a4.5 4.5 0 0 0 7 0']],
  pricelabel: [['fr', 4, 9, 16, 7, 1], ['p', 'M4 9h16v7H4z']],
  pricenote: [['r', 4, 6, 16, 12], ['p', 'M7 10h10M7 14h6']],

  /* ─── Patterns ────────────────────────────────────────────────────────── */
  xabcd: [['p', 'M3 19L7 6L12 14L17 5L21 18'], ['fr', 3, 5, 18, 14, 0.08]],
  cypher: [['p', 'M3 18L8 5L11 13L18 7L21 19'], ['fc', 8, 5, 1.4], ['fc', 18, 7, 1.4]],
  abcd: [['p', 'M3 19L8 7L14 15L21 4'], A(3, 19), A(21, 4)],
  headshoulders: [['p', 'M2 19L5 12L8 17L12 4L16 17L19 12L22 19'], ['p', 'M8 17h8']],
  trianglepattern: [['p', 'M3 4L12 20L15 8L18 16L20 11'], ['p', 'M3 4L21 12M3 20L21 12']],
  threedrives: [['p', 'M3 20L7 12L9 16L13 8L15 12L19 4'], A(3, 20)],
  elliottimpulse: [['p', 'M3 20L7 11L9 15L14 5L16 10L21 3']],
  elliottcorrection: [['p', 'M4 6L10 17L15 9L21 19']],
  elliotttriangle: [['p', 'M3 5L9 19L12 8L16 17L19 11'], ['p', 'M3 5L21 13']],
  elliottdoublecombo: [['p', 'M4 5L9 18L14 8L21 19']],
  elliotttriplecombo: [['p', 'M3 5L6 17L10 8L13 18L17 9L21 19']],
  cyclic: [['p', 'M4 3v18M10 3v18M16 3v18M22 3v18']],
  timecycles: [['p', 'M3 18h18'], ['p', 'M3 18a4 4 0 0 1 8 0M11 18a4 4 0 0 1 8 0']],
  sineline: [['p', 'M2 12c3-9 6-9 9 0s6 9 9 0']],

  /* ─── Prediction and measurement ──────────────────────────────────────── */
  position: [
    ['fr', 6, 5, 14, 7, 0.28, 'pos'], ['fr', 6, 12, 14, 7, 0.28, 'neg'],
    ['p', 'M6 12h14'], ['p', 'M3 8.5l1.5-2 1.5 2M3 15.5l1.5 2 1.5-2'],
  ],
  measure: [['p', 'M6 4v16M18 4v16M6 12h12'], ['p', 'M9 9l-3 3 3 3M15 9l3 3-3 3']],
  daterange: [['p', 'M6 3v18M18 3v18'], ['fr', 6, 3, 12, 18, 0.1], ['p', 'M9 12h6M12 9l-3 3 3 3M15 9l3 3-3 3']],
  pricerange: [['p', 'M3 6h18M3 18h18'], ['fr', 3, 6, 18, 12, 0.1], ['p', 'M12 9v6M9 9l3-3 3 3M9 15l3 3 3-3']],
  datepricerange: [['r', 5, 5, 14, 14], ['fr', 5, 5, 14, 14, 0.1], ['p', 'M8 12h8M12 8v8']],
  pricebarratio: [['p', 'M4 19L20 6'], ['p', 'M4 19h16'], ['p', 'M9 19v-3M14 19v-6M19 19v-9']],
  forecast: [['p', 'M4 12L20 5M4 12L20 19'], ['fr', 4, 5, 16, 14, 0.1], ['p', 'M4 12h14'], A(4, 12)],
  projection: [['p', 'M3 18L9 7'], ['p', 'M13 20L19 9'], A(3, 18), A(13, 20)],
  barspattern: [
    ['p', 'M5 6v12M9 8v9'], ['p', 'M15 6v12M19 8v9'],
    ['fr', 4, 9, 2, 6, 1], ['fr', 8, 11, 2, 4, 1], ['fr', 14, 9, 2, 6, 0.35], ['fr', 18, 11, 2, 4, 0.35],
  ],
  ghostfeed: [
    ['p', 'M5 7v10M10 5v13M15 8v9M20 6v11'],
    ['fr', 4, 9, 2, 6, 0.35], ['fr', 9, 8, 2, 7, 0.35],
    ['fr', 14, 11, 2, 4, 0.35], ['fr', 19, 9, 2, 5, 0.35],
  ],
  anchoredvwap: [['p', 'M4 18C9 18 12 10 21 6'], ['fc', 4, 18, 2.2], ['p', 'M4 21v-3']],

  /* ─── Special ─────────────────────────────────────────────────────────── */
  /* Three bars, and the stretch between the outer two that neither of them
   * traded into. */
  fvg: [
    ['fr', 3, 9, 18, 4, 0.3], ['p', 'M3 9h18M3 13h18'], ['p', 'M6 13v7M12 4v16M18 4v5'],
  ],
  /* A bracketed span with a histogram inside it. */
  rangeprofile: [['p', 'M4 4v16M20 4v16'], ['p', 'M7 8h7M7 12h10M7 16h4']],
};

/* Group icons for the rail. Each is the family's most recognisable member, so a
 * collapsed group still says what is inside it without a label. */
export const GROUP_ICONS = {
  lines: ICONS.trendline,
  channels: ICONS.parallelchannel,
  pitchfork: ICONS.pitchfork,
  fib: ICONS.fib,
  gann: ICONS.gannfan,
  shapes: ICONS.rectangle,
  text: ICONS.text,
  patterns: ICONS.xabcd,
  projection: ICONS.position,
  special: ICONS.fvg,
};

/** The primitives for an icon id, or an empty list rather than a crash. */
export function iconFor(id) {
  return ICONS[id] ?? [];
}
