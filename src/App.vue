<script setup>
import { onMounted, ref } from 'vue';
import ChartPanel from './components/ChartPanel.vue';
import DataManager from './components/DataManager.vue';
import IndicatorPanel from './components/IndicatorPanel.vue';
import {
  isDark, refreshDatasets, session, setError, setTimeframe, toggleTheme,
} from './stores/session.js';

const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];
const dark = ref(isDark());

onMounted(async () => {
  try {
    await refreshDatasets();
  } catch (err) {
    setError(err);
  }
});

function flipTheme() {
  dark.value = toggleTheme();
}
</script>

<template>
  <div class="ambient"></div>

  <header class="topbar">
    <div class="brand">
      <span class="brand-mark">緑</span>
      <span class="brand-name">Midori</span>
    </div>

    <div class="k-divider"></div>

    <span class="current-symbol">{{ session.symbol ?? 'No symbol' }}</span>

    <div class="tf-group">
      <button
        v-for="tf in TIMEFRAMES"
        :key="tf"
        :class="['btn', 'btn--sm', session.timeframe === tf ? 'btn--accent' : 'btn--default']"
        @click="setTimeframe(tf)"
      >{{ tf }}</button>
    </div>

    <div class="spacer"></div>

    <button class="icon-btn" :title="dark ? 'Switch to light' : 'Switch to dark'" @click="flipTheme">
      <svg v-if="dark" viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
      <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" />
      </svg>
    </button>
  </header>

  <main class="workspace">
    <DataManager />
    <ChartPanel :symbol="session.symbol" :timeframe="session.timeframe" />
    <IndicatorPanel />
  </main>
</template>

<style scoped>
.topbar {
  position: relative;
  z-index: 1;
  height: var(--titlebar-height);
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 12px;
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

.brand { display: flex; align-items: center; gap: 7px; }
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
  font-family: 'Plus Jakarta Sans', Inter, sans-serif;
  font-weight: 700;
  letter-spacing: -0.01em;
}
.current-symbol {
  font-family: 'Plus Jakarta Sans', Inter, sans-serif;
  font-weight: 600;
  font-size: 13px;
}
.tf-group { display: flex; gap: 3px; }
.spacer { flex: 1; }

.workspace {
  position: relative;
  z-index: 1;
  display: flex;
  gap: 12px;
  padding: 12px;
  height: calc(100% - var(--titlebar-height));
}
</style>
