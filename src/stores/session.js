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
  loading: false,
  error: null,

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

export function setTimeframe(tf) {
  state.timeframe = tf;
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

/** Theme is a UI concern with exactly one switch — it lives here too. */
export function toggleTheme() {
  const dark = document.documentElement.classList.toggle('dark');
  try {
    localStorage.setItem('midori.theme', dark ? 'dark' : 'light');
  } catch (e) { /* private mode — the class is still applied */ }
  return dark;
}

export function isDark() {
  return document.documentElement.classList.contains('dark');
}
