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
  annotateRun, deleteRun, listRuns, loadRun, saveRun,
} from './data/store/runStore.js';
import { runBacktest } from './engine/backtest.js';
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
