/* Derived figures for a finished run.
 *
 * The engine already reports what it can compute while the run is happening —
 * net PnL, win rate, drawdown, profit factor. This file holds what is only
 * worth computing afterwards, from the stored trades: the shape of the equity
 * curve relative to nothing, streaks, and how the result breaks down by
 * direction or session.
 *
 * It lives in `shared/` rather than in a component because these are the
 * numbers a run gets judged on. A figure computed inside a Vue template cannot
 * be tested, and a win rate nobody can test is a win rate nobody should trust.
 *
 * Everything here reads a stored run, so it works on a run loaded from disk
 * months later, not just on one that is still in memory.
 */

/**
 * The equity curve rebased so it starts at zero.
 *
 * What the account made, rather than what it holds. Two runs with different
 * starting balances cannot be compared on absolute equity, and the same run
 * looks like a different one if the balance changes — the shape is the part
 * that means something, and the shape is what this keeps.
 */
export function equityBaseZero(curve, initialBalance) {
  if (!Array.isArray(curve)) return [];
  return curve.map((point) => ({
    time: point.time,
    value: point.equity - initialBalance,
  }));
}

/** The same curve as a percentage of the starting balance, for comparing runs. */
export function equityPercent(curve, initialBalance) {
  if (!Array.isArray(curve) || !(initialBalance > 0)) return [];
  return curve.map((point) => ({
    time: point.time,
    value: ((point.equity - initialBalance) / initialBalance) * 100,
  }));
}

/**
 * Longest runs of winners and losers, and the current one.
 *
 * A run of ten losses matters even when the win rate looks survivable: it is
 * the part that decides whether the account, or the person holding it, is
 * still there at the end. Breakeven trades end a streak without starting one
 * in the other direction — they are neither.
 */
export function streaks(trades) {
  let longestWin = 0;
  let longestLoss = 0;
  let current = 0;

  for (const trade of trades ?? []) {
    const pnl = trade.netPnl;
    if (pnl > 0) {
      current = current > 0 ? current + 1 : 1;
      if (current > longestWin) longestWin = current;
    } else if (pnl < 0) {
      current = current < 0 ? current - 1 : -1;
      if (-current > longestLoss) longestLoss = -current;
    } else {
      current = 0;
    }
  }

  return { longestWin, longestLoss, current };
}

/**
 * Results grouped by whatever a trade carries — its direction, or the tag the
 * strategy attached, which for Silver Bullet is the window it fired in.
 *
 * A group with no losers reports a null profit factor rather than Infinity,
 * matching how the engine's summary handles the same case: a number that
 * cannot be averaged or sorted is worse than an admitted absence.
 */
export function breakdown(trades, key) {
  const groups = new Map();

  for (const trade of trades ?? []) {
    const name = trade[key] ?? 'untagged';
    let g = groups.get(name);
    if (!g) {
      g = { name, trades: 0, wins: 0, losses: 0, netPnl: 0, grossProfit: 0, grossLoss: 0 };
      groups.set(name, g);
    }
    g.trades++;
    g.netPnl += trade.netPnl;
    if (trade.netPnl > 0) {
      g.wins++;
      g.grossProfit += trade.netPnl;
    } else if (trade.netPnl < 0) {
      g.losses++;
      g.grossLoss += Math.abs(trade.netPnl);
    }
  }

  return [...groups.values()]
    .map((g) => ({
      ...g,
      winRate: g.trades > 0 ? g.wins / g.trades : null,
      profitFactor: g.grossLoss > 0 ? g.grossProfit / g.grossLoss : null,
    }))
    .sort((a, b) => b.netPnl - a.netPnl);
}

/**
 * Everything a result page needs, in one pass over the stored run.
 *
 * @param {object} run  a run as stored by runStore
 */
export function analyseRun(run) {
  const trades = run?.trades ?? [];
  const initial = run?.initialBalance ?? 0;

  return {
    equity: equityBaseZero(run?.equityCurve ?? [], initial),
    equityPct: equityPercent(run?.equityCurve ?? [], initial),
    streaks: streaks(trades),
    byDirection: breakdown(trades, 'side'),
    /* What the entry was tagged with — for Silver Bullet, the window it fired
     * in, which is the breakdown that actually answers something. */
    byTag: breakdown(trades, 'entryTag'),
    /* And how each one ended: stop, target, or a close the strategy asked for. */
    byExit: breakdown(trades, 'exitTag'),
    /* Mean holding time. A strategy whose winners run for hours and whose
     * losers close in one bar is a different animal from the reverse, and the
     * summary alone cannot tell them apart. */
    avgHoldMs: averageBarsHeld(trades),
  };
}

/** Mean time a trade was open, in milliseconds, or null with no trades. */
function averageBarsHeld(trades) {
  const spans = trades
    .map((t) => (Number.isFinite(t.closedAt) && Number.isFinite(t.openedAt)
      ? t.closedAt - t.openedAt : null))
    .filter((v) => v != null);
  if (spans.length === 0) return null;
  return spans.reduce((a, b) => a + b, 0) / spans.length;
}
