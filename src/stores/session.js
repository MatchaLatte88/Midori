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
  loading: false,
  error: null,
  /** 'system' | 'light' | 'dark' — read from storage below. */
  themeMode: 'system',

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

export const VIEWS = ['chart', 'backtest', 'results'];

export function setView(view) {
  if (!VIEWS.includes(view)) throw new Error(`Unknown view "${view}". Known: ${VIEWS.join(', ')}`);
  state.view = view;
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
