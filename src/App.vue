<script setup>
import { onMounted, ref } from 'vue';
import ChartPanel from './components/ChartPanel.vue';
import DataManager from './components/DataManager.vue';
import IndicatorPanel from './components/IndicatorPanel.vue';
import ChangelogModal from './components/ChangelogModal.vue';
import { APP_VERSION } from './generated/version.js';
import {
  initTheme, refreshDatasets, session, setError, setThemeMode, setTimeframe,
} from './stores/session.js';

const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];

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

  <header class="topbar">
    <button class="brand" title="Release notes" @click="changelogOpen = true">
      <span class="brand-mark">緑</span>
      <span class="brand-name">Midori</span>
      <span class="brand-version">{{ APP_VERSION }}</span>
    </button>

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
.brand:hover { border-color: var(--brd); background: var(--glass); }
.brand-version {
  font-family: 'DM Mono', ui-monospace, monospace;
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

.workspace {
  position: relative;
  z-index: 1;
  display: flex;
  gap: 12px;
  padding: 12px;
  height: calc(100% - var(--titlebar-height));
}
</style>
