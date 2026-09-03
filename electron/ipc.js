/* IPC surface — the only bridge between the renderer and the data layer.
 *
 * Every handler is a thin adapter: validate, delegate, let errors propagate.
 * Electron serializes a thrown Error back to the caller as a rejected promise,
 * so a failed download surfaces in the UI instead of vanishing into a log.
 */
import { app, ipcMain, BrowserWindow } from 'electron';
import path from 'node:path';

import { downloadRange, listSymbols } from './data/providers/binance.js';
import {
  BASE_TIMEFRAME, TIMEFRAMES, listDatasets, mergeBars, readBars, readMeta,
} from './data/store/barStore.js';
import { computeVolumeProfile } from '../shared/indicators/volumeProfile.js';
import { loadDrawings, saveDrawings } from './data/store/drawingStore.js';
import {
  annotateRun, condenseEquity, deleteRun, listRuns, loadRun, saveRun,
} from './data/store/runStore.js';
import {
  deleteSession, listSessions, loadSession, saveSession,
} from './data/store/sessionStore.js';
import { runBacktest } from './engine/backtest.js';
import { isSweepRunning, startSweep, stopSweep } from './engine/sweepManager.js';
import { countCombinations } from '../shared/analysis/sweep.js';
import { STRATEGIES, buildStrategy, strategyCatalog } from '../shared/strategies/index.js';
import { applyTitleBarTheme } from './titlebar.js';

/** Datasets live outside the app bundle so an update never touches them. */
export function dataDir() {
  return path.join(app.getPath('userData'), 'market-data');
}

/** Separate from the candles: redownloading data must not erase annotations. */
export function drawingsDir() {
  return path.join(app.getPath('userData'), 'drawings');
}

/** Results outlive the data they were computed from, so they live apart too. */
export function runsDir() {
  return path.join(app.getPath('userData'), 'backtests');
}

/**
 * Sessions that are not finished yet.
 *
 * Apart from the runs on purpose: these are working state, they are removed
 * when they are picked up again, and a library of results should not have
 * half-played accounts sitting in it.
 */
export function sessionsDir() {
  return path.join(app.getPath('userData'), 'replay-sessions');
}


function requireString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function requireTimeframe(tf) {
  if (!TIMEFRAMES[tf]) {
    throw new Error(`Unknown timeframe "${tf}". Known: ${Object.keys(TIMEFRAMES).join(', ')}`);
  }
  return tf;
}

export function registerIpc() {
  ipcMain.handle('data:datasets', () => listDatasets(dataDir()));

  ipcMain.handle('data:meta', (_e, symbol) => readMeta(dataDir(), requireString(symbol, 'symbol')));

  ipcMain.handle('data:symbols', () => listSymbols());

  ipcMain.handle('data:bars', async (_e, { symbol, timeframe, from, to, dropIncomplete = false }) => {
    requireString(symbol, 'symbol');
    requireTimeframe(timeframe);
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      throw new Error('from and to must be timestamps in milliseconds');
    }
    return readBars(dataDir(), symbol, timeframe, from, to, dropIncomplete);
  });

  /* The profile is always built from base-timeframe bars, never from what the
   * chart happens to be displaying — see shared/indicators/volumeProfile.js.
   * It is computed here, in the process that already holds the data, so only
   * the finished bins cross the bridge instead of a year of minutes. */
  ipcMain.handle('data:volume-profile', async (_e, { symbol, from, to, ...options }) => {
    requireString(symbol, 'symbol');
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      throw new Error('from and to must be timestamps in milliseconds');
    }
    if (to <= from) throw new Error('The profile range must end after it starts');

    const bars = await readBars(dataDir(), symbol, BASE_TIMEFRAME, from, to, false);
    const profile = computeVolumeProfile(bars, options);

    // A Float64Array survives structured cloning; the array of bars would not
    // have been worth sending in the first place.
    return { ...profile, barCount: bars.length };
  });

  /* The native frame is drawn by the OS and cannot read a CSS class, so the
   * renderer tells it which theme is in effect. */
  ipcMain.handle('ui:set-theme', (event, theme) => (
    applyTitleBarTheme(BrowserWindow.fromWebContents(event.sender), theme)
  ));

  ipcMain.handle('drawings:load', (_e, symbol) => (
    loadDrawings(drawingsDir(), requireString(symbol, 'symbol'))
  ));

  ipcMain.handle('drawings:save', (_e, { symbol, drawings }) => (
    saveDrawings(drawingsDir(), requireString(symbol, 'symbol'), drawings)
  ));

  /* ─── Backtesting ───────────────────────────────────────────────────── */

  ipcMain.handle('backtest:strategies', () => strategyCatalog());

  /* The run happens here rather than in the renderer for the same reason the
   * volume profile does: the bars are already in this process, and a year of
   * minutes has no business crossing the bridge twice. Only the finished
   * summary goes back. */
  ipcMain.handle('backtest:run', async (_e, request) => {
    const {
      strategy: strategyId, params = {}, symbol, timeframe, from, to,
      balance = 10_000, costs = {}, note = '',
    } = request ?? {};

    requireString(strategyId, 'strategy');
    if (!STRATEGIES[strategyId]) {
      throw new Error(`Unknown strategy "${strategyId}". `
        + `Known: ${Object.keys(STRATEGIES).join(', ')}`);
    }
    requireString(symbol, 'symbol');
    requireTimeframe(timeframe);
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      throw new Error('from and to must be timestamps in milliseconds');
    }
    if (to <= from) throw new Error('The backtest range must end after it starts');
    if (!Number.isFinite(balance) || balance <= 0) {
      throw new Error('The starting balance must be a positive number');
    }

    /* Closed bars only. The engine must never see the bar currently forming —
     * see ARCHITECTURE section 4; this is the flag that enforces it. */
    const bars = await readBars(dataDir(), symbol, timeframe, from, to, true);
    if (bars.length === 0) {
      throw new Error('No bars in that range — download the data for this symbol first');
    }

    /* Minute bars underneath, so a bar that touches both stop and target is
     * resolved by replaying it rather than guessed at. Reaching a day past the
     * end lets a trade still open at the boundary finish honestly. */
    const baseBars = timeframe === BASE_TIMEFRAME
      ? null
      : await readBars(dataDir(), symbol, BASE_TIMEFRAME, from, to + 86_400_000, true);

    const built = buildStrategy(strategyId, params);
    const result = runBacktest({ bars, baseBars, strategy: built, broker: { balance, costs } });

    /* `result` already carries the resolved costs and the starting balance, so
     * they are not repeated here — spreading it first and then overwriting
     * them with the request's own values would put back the `{}` the caller
     * sent. */
    return saveRun(runsDir(), {
      ...result,
      strategy: strategyId,
      strategyName: STRATEGIES[strategyId].name,
      // The resolved params, not the ones sent: a stored run has to say what
      // it actually ran with, including every default that was filled in.
      params: built.params,
      symbol,
      timeframe,
      from,
      to,
      note: typeof note === 'string' ? note.slice(0, 2000) : '',
    });
  });

  ipcMain.handle('backtest:list', () => listRuns(runsDir()));

  ipcMain.handle('backtest:load', (_e, id) => loadRun(runsDir(), requireString(id, 'id')));

  ipcMain.handle('backtest:delete', (_e, id) => deleteRun(runsDir(), requireString(id, 'id')));

  ipcMain.handle('backtest:annotate', (_e, { id, note }) => (
    annotateRun(runsDir(), requireString(id, 'id'), note)
  ));

  /* ─── Replay ────────────────────────────────────────────────────────── */

  /* A replay is played out in the renderer — a click has to become an order
   * and a redrawn chart in the same frame, which a round trip through here
   * cannot do. The engine it runs on is the same one; see
   * shared/engine/replaySession.js for why that class lives in shared/.
   *
   * So only the finished session crosses the bridge, and it goes into the same
   * store a backtest does. That is the whole point of storing it: a run traded
   * by hand and a run produced by a strategy end up in one library, on one
   * results page, comparable against each other.
   */
  ipcMain.handle('replay:save', async (_e, request) => {
    const { symbol, timeframe, note = '', ...result } = request ?? {};

    requireString(symbol, 'symbol');
    requireTimeframe(timeframe);
    if (!result.stats || !Array.isArray(result.trades)) {
      throw new Error('replay:save: the session has no result to store');
    }
    if (result.trades.length === 0) {
      throw new Error('replay:save: the session took no trades');
    }
    if (!Number.isFinite(result.from) || !Number.isFinite(result.to)) {
      throw new Error('replay:save: the session has no range');
    }

    return saveRun(runsDir(), {
      ...result,
      strategy: 'replay',
      strategyName: 'Manual replay',
      /* Deliberately empty. A replay has no settings that held for the whole
       * session — the risk on each trade was decided at the moment it was
       * taken — and storing one of them would be a claim the session cannot
       * support. The trades carry what actually happened. */
      params: {},
      symbol,
      timeframe,
      note: typeof note === 'string' ? note.slice(0, 2000) : '',
    });
  });

  /* A session that is not over yet is a different thing from a finished run,
   * and goes somewhere else. What crosses the bridge is the account and the
   * clock — never the bars, which are already in the data store and are the
   * same bars tomorrow. See ReplaySession.snapshot.
   */
  ipcMain.handle('replay:saveSession', async (_e, request) => {
    const { id = null, name = '', symbol, timeframe, session, stats = {} } = request ?? {};

    requireString(symbol, 'symbol');
    requireTimeframe(timeframe);
    if (!session || session.version !== 1 || !session.broker) {
      throw new Error('replay:saveSession: this is not a session snapshot');
    }
    if (!Number.isFinite(session.clock) || !Number.isFinite(session.startTime)) {
      throw new Error('replay:saveSession: the session has no clock');
    }

    return saveSession(sessionsDir(), {
      id,
      name: typeof name === 'string' ? name.slice(0, 120) : '',
      symbol,
      timeframe,
      startTime: session.startTime,
      clock: session.clock,
      stats,
      session: {
        ...session,
        /* The same condensing a stored run gets, and for the same reason: the
         * curve carries a point per bar, and the figures that need every point
         * — the peak, the worst drawdown — were computed over the full curve
         * before it got here and are stored beside it. */
        equityCurve: condenseEquity(session.equityCurve ?? []),
      },
    });
  });

  ipcMain.handle('replay:sessions', () => listSessions(sessionsDir()));

  ipcMain.handle('replay:loadSession', (_e, id) => (
    loadSession(sessionsDir(), requireString(id, 'id'))
  ));

  ipcMain.handle('replay:deleteSession', (_e, id) => (
    deleteSession(sessionsDir(), requireString(id, 'id'))
  ));

  /* ─── Sweeps ────────────────────────────────────────────────────────── */

  /* The sweep itself runs on a worker thread — see sweepManager. This handler
   * therefore stays responsive for hours, and its promise resolves only when
   * the whole thing is finished, stopped or broken.
   *
   * Nothing is stored. A sweep is a question asked once — "does this parameter
   * matter here" — and its answer is read on the spot; keeping a library of
   * them would be a second archive to manage beside the runs, for results
   * nobody goes back to. A combination worth keeping is worth re-running as a
   * backtest, and that one does get stored. */
  ipcMain.handle('sweep:run', async (event, request) => {
    const {
      strategy: strategyId, ranges = {}, base = {}, symbol, timeframe, from, to,
      balance = 10_000, trainFraction = 0.7, metric = 'expectancy',
      minTrades = 10, showCount = 4,
    } = request ?? {};

    requireString(strategyId, 'strategy');
    if (!STRATEGIES[strategyId]) {
      throw new Error(`Unknown strategy "${strategyId}". `
        + `Known: ${Object.keys(STRATEGIES).join(', ')}`);
    }
    requireString(symbol, 'symbol');
    requireTimeframe(timeframe);
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      throw new Error('from and to must be timestamps in milliseconds');
    }
    if (to <= from) throw new Error('The sweep range must end after it starts');
    if (!Number.isFinite(balance) || balance <= 0) {
      throw new Error('The starting balance must be a positive number');
    }
    /* Counted here, before a worker is started: a range that expands to
     * millions should be refused in the click that asked for it, not after
     * spinning up a thread that immediately throws. */
    if (countCombinations(ranges) === 0) {
      throw new Error('Give at least one parameter a range to sweep');
    }
    if (isSweepRunning()) throw new Error('A sweep is already running');

    const sender = BrowserWindow.fromWebContents(event.sender);
    const onEvent = (payload) => sender?.webContents.send('sweep:progress', payload);

    const result = await startSweep({
      dataDir: dataDir(),
      symbol,
      timeframe,
      from,
      to,
      strategy: strategyId,
      ranges,
      base,
      balance,
      trainFraction,
      metric,
      minTrades,
      showCount,
    }, onEvent);

    // Stopped on request: not an error either.
    if (result.cancelled) return { cancelled: true };

    return {
      ...result,
      strategyName: STRATEGIES[strategyId].name,
      symbol,
      timeframe,
    };
  });

  ipcMain.handle('sweep:stop', () => stopSweep());

  ipcMain.handle('sweep:running', () => isSweepRunning());

  ipcMain.handle('data:download', async (event, { symbol, from, to }) => {
    const sym = requireString(symbol, 'symbol').toUpperCase();
    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      throw new Error('from and to must be valid dates');
    }
    if (fromDate >= toDate) throw new Error('The start date must be before the end date');

    const sender = BrowserWindow.fromWebContents(event.sender);
    const progress = (p) => sender?.webContents.send('data:download-progress', { symbol: sym, ...p });

    const { bars, missing } = await downloadRange(sym, fromDate, toDate, '1m', progress);
    const result = await mergeBars(dataDir(), sym, bars, { source: 'binance-spot' });
    return { ...result, missing };
  });
}
