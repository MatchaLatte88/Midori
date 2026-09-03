<script setup>
import { onMounted, ref } from 'vue';
import ChartPanel from './components/ChartPanel.vue';
import DataManager from './components/DataManager.vue';
import IndicatorPanel from './components/IndicatorPanel.vue';
import BacktestPanel from './components/BacktestPanel.vue';
import ReplayBar from './components/ReplayBar.vue';
import ReplayPanel from './components/ReplayPanel.vue';
import TradeDock from './components/TradeDock.vue';
import ResultsPage from './components/ResultsPage.vue';
import SweepPanel from './components/SweepPanel.vue';
import ChangelogModal from './components/ChangelogModal.vue';
import HintTooltip from './components/HintTooltip.vue';
import PanelToggle from './components/PanelToggle.vue';
import { APP_VERSION } from './generated/version.js';
import {
  clearError, initTheme, refreshDatasets, session, setError, setThemeMode, setTimeframe,
  setView, togglePanel,
} from './stores/session.js';
import { replay, switchTimeframe } from './stores/replay.js';

/* The chart's own controls only mean something on the chart. Symbol and
 * timeframe are shared with a run, so they stay visible everywhere — a
 * backtest reads them, and hiding them would make it unclear what a run is
 * about to test. */
const NAV = [
  { id: 'chart', label: 'Chart' },
  { id: 'replay', label: 'Replay' },
  { id: 'backtest', label: 'Backtest' },
  { id: 'sweep', label: 'Auto backtest' },
  { id: 'results', label: 'Results' },
];

const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];

/**
 * Changes the timeframe, including under a running replay.
 *
 * It used to be fixed for the length of a session, and the reason was real:
 * the session counts indices into one array of bars, so swapping the array
 * under it would move every trade it had taken. But reading the higher
 * timeframe and trading the lower one is not a preference, it is the method —
 * fixing it asks the person to trade blind or to start again.
 *
 * What makes it safe now is that a session keeps a clock as well as an index;
 * `switchTimeframe` in the replay store, and `ReplaySession.rebase` under it,
 * are where that is written down. The shared timeframe follows only once the
 * session has actually moved, so a switch that could not be loaded leaves the
 * two of them agreeing rather than disagreeing.
 */
async function chooseTimeframe(tf) {
  if (tf === session.timeframe) return;
  if (!replay.active) {
    setTimeframe(tf);
    return;
  }
  await switchTimeframe(tf);
  if (replay.timeframe === tf) setTimeframe(tf);
}

const changelogOpen = ref(false);

const THEME_OPTIONS = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'system', label: 'Follow system' },
];

onMounted(async () => {
  // The native title bar starts on the OS setting; tell it what the app chose.
  initTheme();
  try {
    await refreshDatasets();
  } catch (err) {
    setError(err);
  }
});
</script>

<template>
  <div class="ambient"></div>

  <!-- One surface for every hover hint in the app; see hints.js. -->
  <HintTooltip />

  <header class="topbar">
    <button class="brand" title="Release notes" @click="changelogOpen = true">
      <span class="brand-mark">緑</span>
      <span class="brand-name">Midorii<span class="brand-dot">.</span></span>
      <span class="brand-version">{{ APP_VERSION }}</span>
    </button>

    <nav class="nav">
      <button
        v-for="item in NAV"
        :key="item.id"
        class="nav-btn"
        :class="{ 'is-active': session.view === item.id }"
        @click="setView(item.id)"
      >{{ item.label }}</button>
    </nav>

    <div class="k-divider"></div>

    <span class="current-symbol">{{ session.symbol ?? 'No symbol' }}</span>

    <!-- Live under a running session as well; see chooseTimeframe above for
         what makes that safe. Only greyed while a window is loading, which is
         the one moment there are two answers to what the session is playing. -->
    <div
      class="tf-group"
      v-hint="replay.active ? {
        label: 'Timeframe',
        text: 'Changes under a running session too. The playhead stays at the same '
          + 'instant, nothing already played is played again, and where the moment '
          + 'falls inside a bar of the new timeframe that bar is drawn as far as it '
          + 'has got.',
      } : null"
    >
      <button
        v-for="tf in TIMEFRAMES"
        :key="tf"
        :disabled="replay.status === 'loading'"
        :class="['btn', 'btn--sm', session.timeframe === tf ? 'btn--accent' : 'btn--default']"
        @click="chooseTimeframe(tf)"
      >{{ tf }}</button>
    </div>

    <div class="spacer"></div>

    <div class="theme-switch">
      <button
        v-for="option in THEME_OPTIONS"
        :key="option.id"
        class="theme-btn"
        :class="{ 'is-active': session.themeMode === option.id }"
        :title="option.label"
        @click="setThemeMode(option.id)"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
          <template v-if="option.id === 'light'">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </template>
          <path v-else-if="option.id === 'dark'" d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" />
          <template v-else>
            <rect x="3" y="4" width="18" height="12" rx="1.5" />
            <path d="M8 20h8M12 16v4" />
          </template>
        </svg>
      </button>
    </div>
  </header>

  <ChangelogModal :open="changelogOpen" @close="changelogOpen = false" />

  <main class="workspace">
    <!-- v-if, so a view that is not showing holds no chart instance and no
         listeners. The cost is that the chart rebuilds and refetches its bars
         on the way back; the alternative, v-show, keeps it alive but hands
         lightweight-charts a zero-sized container while hidden, which it does
         not survive without a resize on every return. Worth revisiting if the
         rebuild ever becomes noticeable. -->
    <!-- v-show rather than v-if for the side panels: a download being set up or
         a half-typed indicator has to survive being folded away, and unlike the
         chart these hold nothing that minds a zero-sized container. -->
    <template v-if="session.view === 'chart'">
      <DataManager v-show="session.panels.left" />
      <PanelToggle side="left" :open="session.panels.left" @toggle="togglePanel('left')" />
      <ChartPanel :symbol="session.symbol" :timeframe="session.timeframe" />
      <PanelToggle side="right" :open="session.panels.right" @toggle="togglePanel('right')" />
      <IndicatorPanel v-show="session.panels.right" />
    </template>

    <!-- Replay is the chart with a playhead on it, so it is the same chart:
         the indicators, the drawing tools and the panels all work exactly as
         they do on the chart view, because they are the same components. What
         changes is where the bars come from — see stores/replay.js. -->
    <template v-else-if="session.view === 'replay'">
      <ReplayPanel v-show="session.panels.left" />
      <PanelToggle side="left" :open="session.panels.left" @toggle="togglePanel('left')" />
      <div class="stage">
        <ReplayBar />
        <ChartPanel :symbol="session.symbol" :timeframe="session.timeframe" />
        <!-- Under the chart, the way a terminal keeps it: what is open, what is
             waiting, what is over. Only once there is an account for it to be
             about — on the setup screen it would be three empty lists. -->
        <TradeDock v-if="replay.active" />
      </div>
      <PanelToggle side="right" :open="session.panels.right" @toggle="togglePanel('right')" />
      <IndicatorPanel v-show="session.panels.right" />
    </template>

    <BacktestPanel v-else-if="session.view === 'backtest'" />
    <SweepPanel v-else-if="session.view === 'sweep'" />
    <ResultsPage v-else />
  </main>

  <!-- One place for every error in the app. It used to be rendered inside the
       DataManager, which only exists on the chart view — so anything that went
       wrong on the backtest or results pages was caught, stored, and shown to
       nobody. An error nobody can see is worse than one that crashes. -->
  <div v-if="session.error" class="error-toast k-panel" role="alert">
    <span class="error-text">{{ session.error }}</span>
    <button class="error-close" title="Dismiss" @click="clearError">×</button>
  </div>
</template>

<style scoped>
.topbar {
  position: relative;
  z-index: 1;
  height: var(--titlebar-height);
  display: flex;
  align-items: center;
  gap: 10px;

  /* The window's minimise, maximise and close buttons are drawn by the OS as an
     overlay on top of the page, so anything the app puts underneath them is
     visible but not clickable. Electron exposes the area left over for the app
     as env(titlebar-area-*) — measured here: 1569 of 1706 px, so the controls
     take 137. Reserving the difference keeps app controls clear of them at any
     window width and on any DPI, instead of hardcoding a number that is right
     on one machine.

     The fallback covers a build without titleBarOverlay (macOS, Linux); there
     the controls sit at the left, which env(titlebar-area-x) accounts for. */
  padding-left: calc(env(titlebar-area-x, 0px) + 12px);
  padding-right: calc(100% - env(titlebar-area-width, calc(100% - 140px))
    - env(titlebar-area-x, 0px) + 12px);
  background: var(--topbar-bg);
  border-bottom: 1px solid var(--line);
  box-shadow: var(--topbar-shadow);
  /* Everything is draggable except the controls, which opt back in below. */
  -webkit-app-region: drag;
}
.topbar button,
.topbar .tf-group {
  -webkit-app-region: no-drag;
}

.brand {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 3px 6px 3px 3px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: none;
  cursor: pointer;
  -webkit-app-region: no-drag;
}
.brand:hover { background: var(--glass); }
.brand-version {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--faint);
}
.brand-mark {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  background: var(--accent-bg);
  border: 1px solid var(--accent-brd);
  color: var(--accent);
  font-size: 12px;
  line-height: 1;
}
.brand-name {
  font-family: var(--font-num);
  font-weight: 700;
  letter-spacing: -0.01em;
}
/* The full stop is the mark, and the one place the ember reads as branding
   rather than as a warning. */
.brand-dot { color: var(--ember); }

.current-symbol {
  font-family: var(--font-num);
  font-weight: 600;
  font-size: 13px;
}
.tf-group { display: flex; gap: 3px; }

/* Top-level navigation. Underlined rather than boxed: these are places, not
   settings, and the segmented look is already spoken for by the theme switch
   at the other end of the bar. */
.nav { display: flex; gap: 2px; -webkit-app-region: no-drag; }
.nav-btn {
  padding: 5px 9px;
  border: none;
  border-bottom: 2px solid transparent;
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
  background: none;
  color: var(--sec);
  font-family: var(--font-num);
  font-weight: 600;
  font-size: 12px;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}
.nav-btn:hover { color: var(--txt); background: var(--glass); }
.nav-btn.is-active { color: var(--accent); border-bottom-color: var(--accent); }
.spacer { flex: 1; }

/* Segmented control: three states, so "follow the system" stays a choice
   rather than the absence of one. */
.theme-switch {
  display: flex;
  gap: 1px;
  padding: 2px;
  border: 1px solid var(--brd);
  border-radius: var(--radius-sm);
  background: var(--glass);
  -webkit-app-region: no-drag;
}
.theme-btn {
  display: grid;
  place-items: center;
  width: 24px;
  height: 22px;
  border: none;
  border-radius: 5px;
  background: none;
  color: var(--sec);
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.theme-btn:hover { color: var(--txt); }
.theme-btn.is-active { color: var(--accent); background: var(--accent-bg); }
.theme-btn svg { width: 14px; height: 14px; }

/* Sits above everything and stays put while the view under it scrolls: an
   error that scrolled out of sight would be the same bug again. */
.error-toast {
  position: fixed;
  left: 50%;
  bottom: 16px;
  transform: translateX(-50%);
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: min(720px, calc(100vw - 32px));
  padding: 9px 12px;
  border-color: var(--neg);
}
.error-text {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--neg);
  overflow-wrap: anywhere;
}
.error-close {
  flex: none;
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 5px;
  background: none;
  color: var(--sec);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}
.error-close:hover { color: var(--txt); background: var(--glass); }

/* The replay column: transport on top, dock at the bottom, chart taking
   whatever is left — which is most of it, and the point of moving the account
   out of the side panel in the first place. */
.stage {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1;
  min-width: 0;
  min-height: 0;
}

.workspace {
  position: relative;
  z-index: 1;
  display: flex;
  gap: 12px;
  padding: 12px;
  height: calc(100% - var(--titlebar-height));
}
</style>
