/* The levels of an open position that can be taken hold of on the chart.
 *
 * Typing a stop into the ticket and clicking the ⌖ picker both work, but
 * neither is how anyone actually moves a stop: you look at the chart, see where
 * the level should be, and put it there. So the two lines the position draws
 * are draggable, and dropping one replaces the protection on the position —
 * through protectPosition, which cancels and re-places the orders, so a level
 * moved by hand is the same order as a level typed in.
 *
 * The geometry is here rather than in the component for the reason every other
 * chart module gives: a hit test against a pixel is worth checking without a
 * chart to run it on.
 *
 * Nothing in here mutates anything. The component owns the drag, the store owns
 * the orders, and this file only answers two questions: what is under the
 * pointer, and whether a level may go where it has been dropped.
 */

/** How close the pointer has to come to a line, in pixels. */
export const GRAB_TOLERANCE = 5;

/**
 * How far in from the right edge a level can be grabbed whatever else is true.
 *
 * The lines only run from the bar the position was opened on, so a position
 * opened two bars ago has a block a few pixels wide — and that is exactly when
 * the stop still has to be put on it. The tags sit against the right edge and
 * are handles in their own right, so the reach never begins further right than
 * they do. Wide enough for the longest of them, which is the P&L with an R
 * beside it.
 */
export const TAG_REACH = 140;

/** The button that closes the position: a square against the right edge. */
export const CLOSE_SIZE = 20;
/** How far it is held off the edge — the same inset the tags keep. */
export const CLOSE_INSET = 2;

/**
 * Where that button sits, given the pane's width and the entry line.
 *
 * On the entry line and hard against the right edge, beside the number that
 * says what closing would realise. Both the drawing and the hit test come from
 * here, so the thing that is clicked and the thing that is painted cannot drift
 * apart — which for a button that liquidates a position is worth insisting on.
 */
export function closeButtonRect(paneWidth, yEntry) {
  return {
    x: paneWidth - CLOSE_SIZE - CLOSE_INSET,
    y: yEntry - CLOSE_SIZE / 2,
    width: CLOSE_SIZE,
    height: CLOSE_SIZE,
  };
}

/** Whether a pointer is inside a rectangle. */
export function inRect(point, rect) {
  return point.x >= rect.x && point.x <= rect.x + rect.width
    && point.y >= rect.y && point.y <= rect.y + rect.height;
}

/**
 * The levels of a position a pointer can take hold of, as {field, price}.
 *
 * The entry line is always one of them, and it is not there to be moved: a
 * position was opened where it was opened. It is the *source* of the other two.
 * Dragging off it is how a stop or a target gets put on a position that has
 * none — which is how it is done everywhere else, and the alternative here was
 * typing two numbers into a ticket for a trade that is already running.
 *
 * Which of the two a drag off the entry becomes is `fieldForPrice`, and it is
 * decided by where the pointer ends up rather than by which way it went.
 */
export function draggableLevels(position) {
  if (!position) return [];
  const levels = [{ field: 'entry', price: position.entryPrice }];
  if (position.stopLoss != null) levels.push({ field: 'stopLoss', price: position.stopLoss });
  if (position.takeProfit != null) levels.push({ field: 'takeProfit', price: position.takeProfit });
  return levels;
}

/**
 * Which level a price dragged off the entry line becomes.
 *
 * The side of the *last price* decides, not the side of the entry. Below the
 * market is where a long is protected and where a short takes profit, whatever
 * the entry has done since — a long that is already 200 in front has an entry
 * far below the market, and dragging down from it still means "this is where I
 * am wrong", not "this is my target".
 *
 * A price exactly on the last one is answered rather than refused here, and
 * `levelRefusal` turns it away: one place decides what a level is, another
 * decides whether it may be there.
 */
export function fieldForPrice(price, position, lastPrice) {
  const long = position.size > 0;
  const below = price < lastPrice;
  return (long ? below : !below) ? 'stopLoss' : 'takeProfit';
}

/**
 * Which level a pointer has hold of, or null.
 *
 * Only where the line is actually drawn: the block starts at the bar the
 * position was opened on, and a grab to the left of it would be a grab at
 * nothing. The nearest of two levels within tolerance wins, so a stop and a
 * target a few pixels apart still resolve to the one being pointed at.
 *
 * @param {{x:number, y:number}} point
 * @param {{left:number, right:number}} extent   where the lines run, in pixels
 * @param {Array<{field:string, y:number}>} levels
 */
export function levelAt(point, extent, levels, tolerance = GRAB_TOLERANCE) {
  if (point.x < extent.left || point.x > extent.right) return null;

  let best = null;
  for (const level of levels) {
    const distance = Math.abs(level.y - point.y);
    if (distance > tolerance) continue;
    if (best === null || distance < best.distance) best = { field: level.field, distance };
  }
  return best === null ? null : best.field;
}

/**
 * Why a level may not be moved to a price, or null when it may.
 *
 * A stop on the wrong side of the last price is not a stop: the order goes into
 * the market on the next bar, triggers against the open immediately, and closes
 * the position at market — the level would have *ended* the trade rather than
 * protected it. A target on the wrong side does the same thing through a limit
 * that is already marketable. Both are refused where they are made rather than
 * accepted and silently executed, because a position that closed itself one bar
 * after a drag is the hardest kind of surprise to trace back.
 *
 * Compared against the last close, which is the last price anybody can see. The
 * bar that actually fills is the next one and nobody knows it yet; a level that
 * is fine now and gapped through overnight is a real stop that was really hit,
 * which is a different thing entirely.
 */
export function levelRefusal(field, price, position, lastPrice) {
  if (!position || !Number.isFinite(price) || !Number.isFinite(lastPrice)) {
    return 'There is nothing to move this level against.';
  }

  const long = position.size > 0;
  const side = long ? 'long' : 'short';

  /* Strictly the protective side, so a level dropped exactly on the last price
   * is refused as well: the next bar opens on it, which side of it the fill
   * lands is a coin toss, and a stop that may already be triggered is not a
   * stop anybody chose. */
  if (field === 'stopLoss' && !(long ? price < lastPrice : price > lastPrice)) {
    return `A stop ${long ? 'above' : 'below'} the last price would close this ${side} `
      + 'at market on the next bar, not protect it.';
  }
  if (field === 'takeProfit' && !(long ? price > lastPrice : price < lastPrice)) {
    return `A target ${long ? 'below' : 'above'} the last price would close this ${side} `
      + 'at market on the next bar, not wait for it.';
  }
  return null;
}
