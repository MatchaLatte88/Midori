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
import { applyTitleBarTheme } from './titlebar.js';

/** Datasets live outside the app bundle so an update never touches them. */
export function dataDir() {
  return path.join(app.getPath('userData'), 'market-data');
}

/** Separate from the candles: redownloading data must not erase annotations. */
export function drawingsDir() {
  return path.join(app.getPath('userData'), 'drawings');
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
