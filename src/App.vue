<script setup>
/* The shell: four bands down the window, and the work in the middle one.
 *
 *   nav          where you are, and the switches that belong to the whole app
 *   instrument   which market, at what resolution, at what price
 *   workspace    the view itself — panels and chart, flush against each other
 *   status       what is true right now, in the smallest type in the app
 *
 * Nothing floats. The bands are separated by a hairline and the columns inside
 * the workspace are too, which is the whole of the layout: a terminal is read
 * by scanning columns, and a gap between cards makes a column stop being one.
 * That is why there is no padding here and no gutter between the panels.
 */
import { onMounted, ref } from 'vue';
import AppNav from './components/AppNav.vue';
import InstrumentBar from './components/InstrumentBar.vue';
import StatusBar from './components/StatusBar.vue';
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
import {
  clearError, initTheme, refreshDatasets, session, setError, togglePanel,
} from './stores/session.js';
import { replay } from './stores/replay.js';

const changelogOpen = ref(false);

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
  <!-- One surface for every hover hint in the app; see hints.js. -->
  <HintTooltip />

  <AppNav @open-changelog="changelogOpen = true" />

  <!-- On every view, not only the charting ones: a backtest runs on the symbol
       and timeframe named here, and hiding them would make it unclear what a
       run is about to test. -->
  <InstrumentBar />

  <ChangelogModal :open="changelogOpen" @close="changelogOpen = false" />

  <main class="workspace">
    <!-- v-if for the chart, so a view that is not showing holds no chart
         instance and no listeners. The cost is that it rebuilds and refetches
         its bars on the way back; v-show would keep it alive but hand
         lightweight-charts a zero-sized container while hidden, which it does
         not survive without a resize on every return.

         v-show for the side panels, for the opposite reason: a download being
         set up or a half-typed indicator has to survive being folded away, and
         neither of them minds a zero-sized container. -->
    <template v-if="session.view === 'chart'">
      <DataManager v-show="session.panels.left" />
      <PanelToggle side="left" :open="session.panels.left" @toggle="togglePanel('left')" />
      <!-- The drawing tools, against the chart they draw on and inboard of the
           panel where a session or a download is set up. ChartPanel owns the
           tool state and teleports the rail in here (deferred; see the Teleport
           there). Written into both branches rather than hoisted, because there
           is no single place before the chart that both layouts share — and
           only one branch is ever in the DOM, so there is only ever one. -->
      <div id="tool-rail" class="rail-slot"></div>
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
      <div id="tool-rail" class="rail-slot"></div>
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

  <StatusBar />

  <!-- One place for every error in the app. It used to be rendered inside the
       DataManager, which only exists on the chart view — so anything that went
       wrong on the backtest or results pages was caught, stored, and shown to
       nobody. An error nobody can see is worse than one that crashes. -->
  <div v-if="session.error" class="error-toast k-pop" role="alert">
    <span class="error-text">{{ session.error }}</span>
    <button class="error-close" title="Dismiss" @click="clearError">×</button>
  </div>
</template>

<style scoped>
.workspace {
  position: relative;
  display: flex;
  flex: 1;
  min-height: 0;
  min-width: 0;
  background: var(--bg);
}

.rail-slot { display: flex; flex: none; }

/* The replay column: transport on top, dock at the bottom, chart taking
   whatever is left — which is most of it, and the point of moving the account
   out of the side panel in the first place. */
.stage {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
}

/* Sits above everything and stays put while the view under it scrolls: an
   error that scrolled out of sight would be the same bug again. */
.error-toast {
  position: fixed;
  left: 50%;
  bottom: calc(var(--statusbar-height) + 14px);
  transform: translateX(-50%);
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: min(720px, calc(100vw - 32px));
  padding: 9px 12px;
  border-color: color-mix(in srgb, var(--neg) 40%, transparent);
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
  border-radius: var(--radius-sm);
  background: none;
  color: var(--sec);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}
.error-close:hover { color: var(--txt); background: var(--hover); }
</style>
