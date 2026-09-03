/* Session state — plain reactive objects, no store library.
 *
 * The app has one selected symbol and timeframe at a time; everything else is
 * derived from what is on disk. A store framework would only add ceremony.
 */
import { reactive, readonly } from 'vue';

const state = reactive({
  datasets: [],          // metadata for every dataset on disk
  symbol: null,          // currently charted symbol
  timeframe: '15m',
  /* Which top-level view is showing. The symbol and timeframe stay shared
   * across all of them: a backtest runs on what the chart is looking at, so
   * switching to it must not mean choosing the market a second time. */
  view: 'chart',
  /* A set of settings on its way from one view to another — a sweep result
   * being handed to the backtest form. Held here rather than passed as a prop
   * because the two views are siblings that are never mounted together, so
   * there is no component between them to route it through. */
  handoff: null,
  loading: false,
  error: null,
  /** 'system' | 'light' | 'dark' — read from storage below. */
  themeMode: 'system',

  /* Whether each side panel is showing.
   *
   * Per side rather than one flag, because the two answer different questions —
   * the left one is where a session or a download is set up, the right one is
   * what is on the chart — and someone reading a chart wants the second one
   * gone far more often than the first. Persisted: room made on a chart today
   * should still be there tomorrow. */
  panels: { left: true, right: true, dock: true },

  /* Active chart indicators. `uid` exists because the same indicator can be
   * added twice with different periods — a 20 and a 50 SMA are two entries. */
  indicators: [],

  volumeProfile: {
    enabled: false,
    /* total | buysell | delta — a display choice, so changing it repaints
     * without recomputing the profile. */
    mode: 'total',
    bins: 120,
    valueArea: 70,
    distribution: 'uniform',
    width: 30,
    showLabels: true,
    /* Which stretch of history the profile covers. 'visible' recomputes as the
     * chart is panned; 'all' profiles everything stored for the symbol. */
    range: 'visible',
    /* Filled in by the chart after each computation, for the readout. */
    stats: null,
  },
});

export const session = readonly(state);

export async function refreshDatasets() {
  state.datasets = await window.midori.data.datasets();
  // Keep the selection valid: if the chosen symbol is gone, fall back to the first.
  if (state.symbol && !state.datasets.some((d) => d.symbol === state.symbol)) {
    state.symbol = null;
  }
  if (!state.symbol && state.datasets.length) {
    state.symbol = state.datasets[0].symbol;
  }
  return state.datasets;
}

export function selectSymbol(symbol) {
  state.symbol = symbol;
}

export const VIEWS = ['chart', 'replay', 'backtest', 'sweep', 'results'];

export function setView(view) {
  if (!VIEWS.includes(view)) throw new Error(`Unknown view "${view}". Known: ${VIEWS.join(', ')}`);
  state.view = view;
}

/**
 * Sends a set of parameters to the backtest form and goes there.
 *
 * The symbol and timeframe travel with them: a combination found on BTC 5m
 * means nothing applied to whatever the chart happens to be showing now, and
 * silently running it against a different market would be the kind of wrong
 * that looks right.
 */
export function sendToBacktest(config) {
  state.handoff = { ...config };
  state.view = 'backtest';
}

/**
 * Takes the pending settings, if any, and clears them.
 *
 * Consumed rather than read: leaving it in place would re-apply the same
 * settings every time the backtest tab is opened, quietly undoing whatever was
 * edited since.
 */
export function takeHandoff() {
  const pending = state.handoff;
  state.handoff = null;
  return pending;
}

export function setTimeframe(tf) {
  state.timeframe = tf;
}

export function clearError() {
  state.error = null;
}

export function setError(err) {
  state.error = err ? (err.message ?? String(err)) : null;
}

export function setLoading(v) {
  state.loading = v;
}

export function datasetFor(symbol) {
  return state.datasets.find((d) => d.symbol === symbol) ?? null;
}

/* ─── Indicators ────────────────────────────────────────────────────────── */

let nextUid = 1;

/** Adds an indicator instance with its default params. */
export function addIndicator(spec) {
  const params = {};
  for (const p of spec.params) params[p.key] = p.default;
  state.indicators.push({
    uid: nextUid++,
    id: spec.id,
    params,
    visible: true,
    // Cycle the five line colors so two overlays never share one by default.
    colorIndex: (state.indicators.length % 5) + 1,
  });
}

export function removeIndicator(uid) {
  const i = state.indicators.findIndex((ind) => ind.uid === uid);
  if (i !== -1) state.indicators.splice(i, 1);
}

export function updateIndicatorParam(uid, key, value) {
  const ind = state.indicators.find((x) => x.uid === uid);
  if (!ind) throw new Error(`No indicator with uid ${uid}`);
  ind.params[key] = value;
}

export function toggleIndicator(uid) {
  const ind = state.indicators.find((x) => x.uid === uid);
  if (!ind) throw new Error(`No indicator with uid ${uid}`);
  ind.visible = !ind.visible;
}

/* ─── Volume profile ────────────────────────────────────────────────────── */

export function setVolumeProfile(patch) {
  Object.assign(state.volumeProfile, patch);
}

/* ─── Side panels ───────────────────────────────────────────────────────── */

/* 'dock' is the trade dock under a replay's chart. Not a side, strictly — but
 * it is a panel that folds away and has to remember that it did, which is the
 * whole of what this mechanism is, so it uses it rather than growing a second
 * one beside it. */
export const PANEL_SIDES = ['left', 'right', 'dock'];

/* Read the same way the theme is, and for the same reason: a UI preference
 * that cannot be read back is a preference that does not persist, not an error
 * anyone needs a banner about. Anything stored that is not a boolean per side
 * is treated as nothing stored — both panels open is the state the app ships
 * in, and the worst it costs is one click. */
function storedPanels() {
  const open = { left: true, right: true, dock: true };
  try {
    const raw = JSON.parse(localStorage.getItem('midori.panels') ?? '{}');
    for (const side of PANEL_SIDES) {
      if (typeof raw?.[side] === 'boolean') open[side] = raw[side];
    }
  } catch (e) { /* nothing stored, or not ours */ }
  return open;
}

Object.assign(state.panels, storedPanels());

export function togglePanel(side) {
  setPanel(side, !state.panels[side]);
}

/**
 * Opens a panel that something is about to put content into.
 *
 * Clicking a position on the chart opens its manager in the side panel — and
 * if that panel is folded away, the click would otherwise do nothing anybody
 * can see. Asking is not an option here: the click already said what was
 * wanted.
 */
export function openPanel(side) {
  if (state.panels[side]) return;
  setPanel(side, true);
}

function setPanel(side, open) {
  if (!PANEL_SIDES.includes(side)) {
    throw new Error(`Unknown panel side "${side}". Known: ${PANEL_SIDES.join(', ')}`);
  }
  state.panels[side] = open;
  try {
    localStorage.setItem('midori.panels', JSON.stringify(state.panels));
  } catch (e) { /* private mode — the panel still moves, it just forgets */ }
}

/* ─── Theme ─────────────────────────────────────────────────────────────── */

/* Three modes rather than a toggle: "system" is a real choice, not the absence
 * of one, and without it a single click permanently detaches the app from the
 * OS setting. */
export const THEME_MODES = ['system', 'light', 'dark'];

const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

function storedMode() {
  try {
    const mode = localStorage.getItem('midori.theme');
    return THEME_MODES.includes(mode) ? mode : 'system';
  } catch (e) {
    return 'system'; // private mode: the choice just does not persist
  }
}

state.themeMode = storedMode();

/** Which of light/dark the current mode actually resolves to. */
export function effectiveTheme() {
  if (state.themeMode === 'system') return systemDark.matches ? 'dark' : 'light';
  return state.themeMode;
}

/* The CSS side is one class, but the native window frame is drawn by the OS and
 * has to be told separately — otherwise switching to dark leaves a bright title
 * bar sitting on top of a dark app. */
function applyTheme() {
  const theme = effectiveTheme();
  document.documentElement.classList.toggle('dark', theme === 'dark');
  window.midori?.ui?.setTheme(theme).catch(setError);
}

export function setThemeMode(mode) {
  if (!THEME_MODES.includes(mode)) {
    throw new Error(`Unknown theme mode "${mode}". Known: ${THEME_MODES.join(', ')}`);
  }
  state.themeMode = mode;
  try {
    localStorage.setItem('midori.theme', mode);
  } catch (e) { /* private mode — the class is still applied */ }
  applyTheme();
}

// While following the system, a change out there has to reach the app.
systemDark.addEventListener('change', () => {
  if (state.themeMode === 'system') applyTheme();
});

/** Pushes the startup theme to the native frame, which knows nothing yet. */
export function initTheme() {
  applyTheme();
}

export function isDark() {
  return document.documentElement.classList.contains('dark');
}
