/* The tool registry: every drawing tool, and the questions the app asks about one.
 *
 * A tool used to be five switch statements — how many anchors, how it is
 * dragged, what counts as a hit, how it is painted, which icon — spread across
 * three files. That works for ten tools. At eighty-seven it means every new tool
 * is five edits in three places, and a tool that is only added to four of them
 * fails in a way nothing catches.
 *
 * So a tool is one object, in one file, next to the tools it is related to, and
 * this module is the only thing that knows the whole list. Everything else asks
 * it a question.
 *
 * A spec:
 *
 *   id, name, hint          identity, and what the tooltip says
 *   group, icon             where it sits on the rail and what it looks like
 *   points                  anchors stored: a number, or 'variable'
 *   minPoints               the fewest a variable tool is worth keeping
 *   gesture                 how those anchors are collected — see GESTURES
 *   build(start, end)       optional: anchors from a two-point drag, when the
 *                           drawing keeps something other than what was dragged
 *   linkAnchor(index)       optional: another anchor that must follow this one
 *   noAxisSnap              optional: shift does not lock this tool to an axis
 *   space                   optional 'screen': anchored to the pane, not to bars
 *   style                   which style bar applies: line, position or text
 *   editable                optional: placing it opens a text editor
 *   hit(pts, at, size, drawing, ctx, env)
 *   draw(ctx, env)
 *
 * Import order here is the order tools appear on the rail.
 */
import { isPositionTool } from './model.js';
import lines from './tools/lines.js';
import channels from './tools/channels.js';
import pitchfork from './tools/pitchfork.js';
import fibs from './tools/fib.js';
import gann from './tools/gann.js';
import patterns from './tools/patterns.js';
import shapes from './tools/shapes.js';
import annotations from './tools/annotations.js';
import projection from './tools/projection.js';
import special from './tools/special.js';

export { ICONS, GROUP_ICONS, iconFor } from './tools/icons.js';

/**
 * How a tool's anchors are collected.
 *
 *   click   one press, one anchor
 *   drag    press, move, release — two anchors, possibly expanded by build()
 *   clicks  one click per anchor, until the tool has all of them
 *   poly    clicks until the user says stop; any number of anchors
 *   free    anchors sampled along a drag; any number
 *   pick    one press, and the chart supplies the anchors — see the FVG tool
 */
export const GESTURES = ['click', 'drag', 'clicks', 'poly', 'free', 'pick'];

/** The one tool that is not a drawing: it selects and moves the others. */
export const CURSOR = {
  id: 'cursor',
  name: 'Cursor',
  hint: 'Select and move drawings',
  group: 'cursor',
  icon: 'cursor',
};

export const TOOL_SPECS = [
  ...lines, ...channels, ...pitchfork, ...fibs, ...gann,
  ...patterns, ...shapes, ...annotations, ...projection, ...special,
];

const BY_ID = new Map(TOOL_SPECS.map((spec) => [spec.id, spec]));

/* Groups in rail order. The rail shows one button per group; the group opens to
 * the tools inside it. Flat would be a column of eighty-seven buttons, which is
 * not a toolbar, it is a list. */
export const TOOL_GROUPS = [
  { id: 'lines', label: 'Lines' },
  { id: 'channels', label: 'Channels' },
  { id: 'pitchfork', label: 'Pitchforks' },
  { id: 'fib', label: 'Fibonacci' },
  { id: 'gann', label: 'Gann' },
  { id: 'patterns', label: 'Patterns' },
  { id: 'shapes', label: 'Shapes' },
  { id: 'text', label: 'Annotations' },
  { id: 'projection', label: 'Prediction & measurement' },
  { id: 'special', label: 'Midorii' },
].map((group) => ({
  ...group,
  tools: TOOL_SPECS.filter((spec) => spec.group === group.id),
}));

/* Sanity check at load: a spec whose group has no column on the rail would be
 * unreachable, and nothing else would ever notice. */
const grouped = new Set(TOOL_GROUPS.flatMap((g) => g.tools.map((t) => t.id)));
for (const spec of TOOL_SPECS) {
  if (!grouped.has(spec.id)) {
    throw new Error(`registry: tool "${spec.id}" has group "${spec.group}", which is not on the rail`);
  }
}

/**
 * The UI-facing shape of the tool list: identity and presentation only.
 *
 * The cursor is in here and not in TOOL_SPECS, because it is a mode rather than
 * a drawing — nothing is ever stored with type 'cursor'.
 */
export const TOOLS = [CURSOR, ...TOOL_SPECS].map(({ id, name, hint, group, icon }) => ({
  id, name, hint, group, icon,
}));

/** Every type that can be stored. Excludes the cursor for exactly that reason. */
export const DRAWING_TYPES = TOOL_SPECS.map((spec) => spec.id);

/**
 * The spec for a stored type, or undefined.
 *
 * The two pre-0.1.1 position names resolve to the position spec, so a drawing
 * saved under them is painted and hit-tested by the tool that replaced them.
 */
export function specFor(type) {
  if (isPositionTool(type)) return BY_ID.get('position');
  return BY_ID.get(type);
}

function requireSpec(type, who) {
  const spec = specFor(type);
  if (!spec) throw new Error(`${who}: unknown drawing type "${type}"`);
  return spec;
}

/**
 * How many anchor points a type needs before it is finished.
 *
 * A variable-length tool reports its minimum: below that there is no shape, and
 * above it every count is as valid as the last.
 */
export function pointsRequired(type) {
  const spec = requireSpec(type, 'pointsRequired');
  return spec.points === 'variable' ? spec.minPoints : spec.points;
}

/** Whether a type accepts any number of anchors above its minimum. */
export function isVariable(type) {
  return requireSpec(type, 'isVariable').points === 'variable';
}

/** Whether a type is anchored to the pane rather than to bars. */
export function isScreenSpace(type) {
  return specFor(type)?.space === 'screen';
}

/**
 * How many points the gesture itself collects, before build().
 *
 * A fair value gap is picked rather than drawn: one click, and the gap under it
 * supplies both anchors. So it is the one type where the gesture collects fewer
 * points than the drawing keeps and build() cannot bridge the two — the answer
 * depends on the bars, which is not something pure geometry can see.
 */
export function gesturePoints(type) {
  const spec = requireSpec(type, 'gesturePoints');
  switch (spec.gesture) {
    case 'click':
    case 'pick':
      return 1;
    case 'drag':
      return 2;
    case 'clicks':
      return spec.points;
    default:
      // poly and free run until the user stops; the minimum is all that can be
      // promised in advance.
      return spec.minPoints;
  }
}

/**
 * Turns the points of a gesture into a drawing's stored anchors.
 *
 * Most tools store exactly what was collected. A tool with a build() does not —
 * see the position tool, where the drag gives entry and stop and the target is
 * derived from them.
 */
export function buildFromGesture(type, start, end) {
  const spec = requireSpec(type, 'buildFromGesture');
  if (spec.build) return spec.build(start, end);
  // A pane-anchored tool has no market coordinates to build; where it went is
  // recorded as a fraction of the pane instead. See placeScreen in useDrawings.
  if (spec.space === 'screen') return [];
  return spec.points === 1 ? [start] : [start, end];
}

/**
 * Hit test against a drawing whose points have already been converted to
 * screen coordinates.
 *
 * `ctx` and `env` are optional and only the annotation tools use them — a block
 * of text has no extent until something has measured it. Every other tool
 * ignores both, which is why they are last.
 */
export function hitTest(type, pts, at, size, drawing, ctx, env) {
  const spec = requireSpec(type, 'hitTest');
  if (pts.length === 0) return false;
  return spec.hit(pts, at, size, drawing, ctx, env);
}

/** Which style bar applies to a type: 'line', 'position' or 'text'. */
export function styleKind(type) {
  return specFor(type)?.style ?? 'line';
}

/** Whether placing this tool should open a text editor over it. */
export function isEditable(type) {
  return specFor(type)?.editable === true;
}

/** The display name of a type, for prompts and the object list. */
export function toolName(type) {
  return specFor(type)?.name ?? 'Drawing';
}
