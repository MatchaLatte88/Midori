<script setup>
/* How price is drawn, chosen from the row that says which price it is.
 *
 * The styles are grouped the way they differ: candles say what happened inside
 * the bar, bars say it more soberly, a line says only where it ended, an area
 * says that and how far it is from nothing. Picking one is a question about
 * how much of the bar you want to see, so the groups are the answer scale and
 * the menu is ordered by it.
 *
 * Only the picture changes. Indicators, the legend and the replay engine all
 * keep reading the real bars — see chartStyles.js, which is also where the two
 * styles this library cannot draw honestly are named and refused.
 */
import { computed, ref } from 'vue';

import MenuPopover from './MenuPopover.vue';
import { chartStyle, chartStyleGroups } from './chart/chartStyles.js';
import { session, setChartStyle } from '../stores/session.js';

const open = ref(false);
const trigger = ref(null);

const groups = chartStyleGroups();
const current = computed(() => chartStyle(session.chartStyle));

function choose(id) {
  setChartStyle(id);
  open.value = false;
}
</script>

<template>
  <button
    ref="trigger"
    class="style-btn"
    :class="{ 'is-open': open }"
    :title="`Chart style — ${current.name}`"
    @click="open = !open"
  >
    <!-- Two candles, which is what the button means whatever it is set to. Two
         rather than three: at 15px a third one closes the gaps and the whole
         mark reads as a smudge. -->
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
         stroke-linecap="round">
      <path d="M8 3v18M16 5v14" />
      <rect x="5" y="7" width="6" height="9" rx="1.5" fill="currentColor" stroke="none" />
      <rect x="13" y="9" width="6" height="7" rx="1.5" />
    </svg>
    <svg class="caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M6 9l6 6 6-6" />
    </svg>
  </button>

  <MenuPopover
    :open="open"
    :anchor="trigger"
    :width="248"
    label="Chart style"
    @close="open = false"
  >
    <template v-for="group in groups" :key="group.name">
      <div class="k-label section">{{ group.name }}</div>
      <button
        v-for="item in group.items"
        :key="item.id"
        class="row"
        :class="{ 'is-active': item.id === session.chartStyle }"
        v-hint="item.hint ? { label: item.name, text: item.hint } : null"
        @click="choose(item.id)"
      >
        <span class="glyph">
          <svg viewBox="0 0 40 20" fill="none" stroke="currentColor" stroke-width="1.4">
            <!-- One drawing per style, at the size the menu reads it. -->
            <template v-if="item.id === 'candle'">
              <path d="M7 3v14M20 2v16M33 5v11" />
              <rect x="4" y="6" width="6" height="8" rx="1" fill="currentColor" stroke="none" />
              <rect x="17" y="5" width="6" height="10" rx="1" fill="currentColor" stroke="none" opacity="0.45" />
              <rect x="30" y="8" width="6" height="5" rx="1" fill="currentColor" stroke="none" />
            </template>
            <!-- Averaged: bodies that touch, and hardly any wick — which is
                 what the picture actually looks like. -->
            <template v-else-if="item.id === 'heikin'">
              <path d="M7 4v12M20 3v14M33 6v9" />
              <rect x="4" y="5" width="6" height="9" rx="1" fill="currentColor" stroke="none" />
              <rect x="17" y="4" width="6" height="10" rx="1" fill="currentColor" stroke="none" />
              <rect x="30" y="7" width="6" height="7" rx="1" fill="currentColor" stroke="none" opacity="0.45" />
            </template>
            <template v-else-if="item.id === 'hollow'">
              <path d="M7 3v14M20 2v16M33 5v11" />
              <rect x="4" y="6" width="6" height="8" rx="1" />
              <rect x="17" y="5" width="6" height="10" rx="1" fill="currentColor" stroke="none" opacity="0.45" />
              <rect x="30" y="8" width="6" height="5" rx="1" />
            </template>
            <template v-else-if="item.id === 'bar'">
              <path d="M7 3v14M4 6h3M7 11h3M20 2v16M17 5h3M20 12h3M33 5v11M30 7h3M33 13h3" />
            </template>
            <template v-else-if="item.id === 'column'">
              <rect x="4" y="8" width="5" height="9" rx="1" fill="currentColor" stroke="none" />
              <rect x="12" y="5" width="5" height="12" rx="1" fill="currentColor" stroke="none" opacity="0.5" />
              <rect x="20" y="10" width="5" height="7" rx="1" fill="currentColor" stroke="none" />
              <rect x="28" y="3" width="5" height="14" rx="1" fill="currentColor" stroke="none" opacity="0.5" />
            </template>
            <template v-else-if="item.id === 'line'">
              <path d="M3 14l8-6 7 5 8-9 11 6" />
            </template>
            <template v-else-if="item.id === 'markers'">
              <path d="M3 14l8-6 7 5 8-9 11 6" />
              <circle cx="11" cy="8" r="1.8" fill="currentColor" />
              <circle cx="18" cy="13" r="1.8" fill="currentColor" />
              <circle cx="26" cy="4" r="1.8" fill="currentColor" />
            </template>
            <template v-else-if="item.id === 'step'">
              <path d="M3 15h7v-5h7v6h7V6h9" />
            </template>
            <template v-else-if="item.id === 'area'">
              <path d="M3 14l8-6 7 5 8-9 11 6" />
              <path d="M3 14l8-6 7 5 8-9 11 6v9H3z" fill="currentColor" stroke="none" opacity="0.22" />
            </template>
            <template v-else>
              <path d="M3 10h34" stroke-dasharray="2 2" opacity="0.6" />
              <path d="M3 14l8-6 7 4 8-7 11 8" />
              <path d="M11 8l7 4 8-7 11 8v-3H11z" fill="currentColor" stroke="none" opacity="0.22" />
            </template>
          </svg>
        </span>
        <span class="name">{{ item.name }}</span>
        <svg v-if="item.id === session.chartStyle" class="check" viewBox="0 0 24 24"
             fill="none" stroke="currentColor" stroke-width="2.2">
          <path d="M5 13l4 4L19 7" />
        </svg>
      </button>
    </template>
  </MenuPopover>
</template>

<style scoped>
.style-btn {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 30px;
  padding: 0 6px 0 8px;
  border: 1px solid var(--brd);
  border-radius: var(--radius-md);
  background: var(--glass);
  color: var(--sec);
  cursor: pointer;
  flex: none;
  transition: color 0.12s, background 0.12s;
}
.style-btn:hover,
.style-btn.is-open { color: var(--txt); background: var(--glass-strong); }
.style-btn svg { width: 15px; height: 15px; }
.style-btn .caret { width: 12px; height: 12px; }

.section { padding: 8px 8px 5px; }
.section:first-child { padding-top: 3px; }

.row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: var(--radius-md);
  background: none;
  color: var(--sec);
  text-align: left;
  cursor: pointer;
}
.row:hover { background: var(--hover); color: var(--txt); }
.row.is-active { background: var(--sel-bg); color: var(--txt); }

.glyph { display: grid; place-items: center; width: 34px; flex: none; color: var(--sec); }
.row.is-active .glyph,
.row:hover .glyph { color: var(--txt); }
.glyph svg { width: 34px; height: 17px; }

.name { flex: 1; font-size: 12.5px; }
.check { width: 14px; height: 14px; flex: none; color: var(--accent); }
</style>
