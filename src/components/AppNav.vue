<script setup>
/* The top line: who this is, where you are, and the two switches that belong
 * to the whole app rather than to a chart.
 *
 * It is a *nav* and not a toolbar, which is why nothing about the market is in
 * it. The market — symbol, timeframe, price — lives one line down, in the
 * instrument bar, and the split is the whole reason the chrome is two rows: a
 * place you are going and an instrument you are looking at are different
 * questions, and mixing them is what made the old single bar unreadable at a
 * glance.
 *
 * The window's minimise, maximise and close buttons are drawn by the OS on top
 * of this row, so its right padding is measured from what Electron leaves the
 * app rather than hardcoded.
 */
import { APP_VERSION } from '../generated/version.js';
import { session, setThemeMode, setView } from '../stores/session.js';

const NAV = [
  { id: 'chart', label: 'Chart' },
  { id: 'replay', label: 'Replay' },
  { id: 'backtest', label: 'Backtest' },
  { id: 'sweep', label: 'Auto backtest' },
  { id: 'results', label: 'Results' },
];

const THEME_OPTIONS = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'system', label: 'Follow system' },
];

defineEmits(['open-changelog']);
</script>

<template>
  <header class="nav-row">
    <div class="brand">
      <span class="brand-mark">緑</span>
      <span class="brand-name">Midorii<span class="brand-dot">.</span></span>
    </div>

    <nav class="nav">
      <button
        v-for="item in NAV"
        :key="item.id"
        class="nav-btn"
        :class="{ 'is-active': session.view === item.id }"
        @click="setView(item.id)"
      >{{ item.label }}</button>
    </nav>

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
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
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

    <div class="k-divider"></div>

    <!-- The version is the button: release notes are what anyone clicking a
         version number is after, and a second icon beside it would be two
         controls for one intention. -->
    <button class="version-pill" title="Release notes" @click="$emit('open-changelog')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
        <path d="M6 3h9l4 4v14H6z" />
        <path d="M9 12h7M9 16h5M14 3v5h5" />
      </svg>
      <span>{{ APP_VERSION }}</span>
    </button>
  </header>
</template>

<style scoped>
.nav-row {
  position: relative;
  z-index: 4;
  height: var(--titlebar-height);
  flex: none;
  display: flex;
  align-items: center;
  gap: 14px;

  /* Electron reports the strip left over beside the OS window controls as
     env(titlebar-area-*). Reserving the difference keeps app controls clear of
     them at any window width and DPI, instead of hardcoding a number that is
     right on exactly one machine. The fallback covers a build without
     titleBarOverlay (macOS, Linux), where the controls sit at the left — which
     env(titlebar-area-x) accounts for. */
  padding-left: calc(env(titlebar-area-x, 0px) + 12px);
  padding-right: calc(100% - env(titlebar-area-width, calc(100% - 140px))
    - env(titlebar-area-x, 0px) + 10px);
  background: var(--surface-1);
  border-bottom: 1px solid var(--line);
  /* Everything is draggable except the controls, which opt back in below. */
  -webkit-app-region: drag;
}
.nav-row button,
.nav-row .theme-switch { -webkit-app-region: no-drag; }

.brand {
  display: flex;
  align-items: center;
  gap: 7px;
  padding-right: 2px;
}
.brand-mark {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: var(--btn-primary-fg);
  font-size: 11px;
  line-height: 1;
}
.brand-name {
  font-family: var(--font-title);
  font-weight: 700;
  font-size: 15px;
  letter-spacing: -0.015em;
  color: var(--txt);
}
/* The full stop is the mark, and the one place the accent reads as branding
   rather than as a live number. */
.brand-dot { color: var(--accent); }

/* Places, not settings: a word that lights up, with no box and no rule under
   it. The boxed look belongs to the controls one row down, and using it here
   too would make going somewhere look like switching something on. */
.nav { display: flex; align-items: center; gap: 4px; }
.nav-btn {
  padding: 5px 11px;
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--sec);
  font-family: var(--font-ui);
  font-weight: 500;
  font-size: 12.5px;
  cursor: pointer;
  transition: color 0.12s, background 0.12s;
}
.nav-btn:hover { color: var(--txt); background: var(--hover); }
.nav-btn.is-active { color: var(--txt); font-weight: 600; }

.spacer { flex: 1; }

.theme-switch { display: flex; align-items: center; gap: 1px; }
.theme-btn {
  display: grid;
  place-items: center;
  width: 26px;
  height: 24px;
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--faint);
  cursor: pointer;
  transition: color 0.12s, background 0.12s;
}
.theme-btn:hover { color: var(--txt); background: var(--hover); }
.theme-btn.is-active { color: var(--txt); background: var(--sel-bg); }
.theme-btn svg { width: 14px; height: 14px; }

.version-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px 0 8px;
  border: 1px solid var(--brd);
  border-radius: var(--radius-pill);
  background: var(--glass);
  color: var(--sec);
  font-family: var(--font-mono);
  font-size: 10.5px;
  cursor: pointer;
  transition: color 0.12s, background 0.12s;
}
.version-pill:hover { color: var(--txt); background: var(--glass-strong); }
.version-pill svg { width: 13px; height: 13px; }
</style>
