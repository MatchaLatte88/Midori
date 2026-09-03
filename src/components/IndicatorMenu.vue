<script setup>
/* The catalogue of indicators, as a list of names.
 *
 * It used to be a list of names each followed by two lines explaining what the
 * indicator is, stacked inside a 280px panel. Read once, that is useful; read
 * the fiftieth time, it is forty lines of prose between you and the one word
 * you came for. So the name is the row and the explanation is the tooltip:
 * the person who does not know gets it by pausing, and the person who does
 * gets a list they can scan.
 *
 * Adding one opens the right panel, because what happens next is always
 * setting its period — and an indicator that appeared on the chart with its
 * settings somewhere unnamed would send you looking for them.
 */
import { computed, ref } from 'vue';

import MenuPopover from './MenuPopover.vue';
import { INDICATORS, indicatorCatalog } from '../../shared/indicators/index.js';
import { addIndicator, openPanel, session } from '../stores/session.js';

const open = ref(false);
const trigger = ref(null);

const catalog = indicatorCatalog();

/* Which of them are already on the chart, and how many times. The same
 * indicator can be added twice with different settings — a 20 and a 50 — so
 * this is a count and not a tick. */
const counts = computed(() => {
  const map = {};
  for (const ind of session.indicators) map[ind.id] = (map[ind.id] ?? 0) + 1;
  return map;
});

function add(spec) {
  addIndicator(spec);
  open.value = false;
  // Where its settings are. Opening rather than toggling: the click already
  // said what was wanted.
  openPanel('right');
}

function manage() {
  open.value = false;
  openPanel('right');
}

const onChart = computed(() => session.indicators.length);
</script>

<template>
  <button
    ref="trigger"
    class="ind-btn"
    :class="{ 'is-open': open }"
    title="Indicators — add one to the chart"
    @click="open = !open"
  >
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
      <path d="M4 19V9M9 19V5M14 19v-7M19 19v-11" />
    </svg>
    <span>Indicators</span>
    <span class="k-divider"></span>
    <span class="count">{{ onChart }}</span>
  </button>

  <MenuPopover
    :open="open"
    :anchor="trigger"
    align="right"
    :width="268"
    label="Indicators"
    @close="open = false"
  >
    <div class="k-label section">Add to the chart</div>

    <button
      v-for="spec in catalog"
      :key="spec.id"
      class="row"
      v-hint="{ label: spec.name, text: spec.description }"
      @click="add(spec)"
    >
      <span class="name">{{ spec.name }}</span>
      <span v-if="counts[spec.id]" class="on">{{ counts[spec.id] }} on</span>
      <svg class="plus" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 5v14M5 12h14" />
      </svg>
    </button>

    <div class="k-rule foot-rule"></div>

    <button v-if="onChart" class="row foot" @click="manage">
      <span class="name">
        {{ onChart }} on the chart — settings, colour and removal
      </span>
    </button>
    <p v-else class="empty k-prose">Nothing on the chart yet.</p>
  </MenuPopover>
</template>

<style scoped>
.ind-btn {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 28px;
  padding: 0 10px;
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--sec);
  font-size: 12px;
  cursor: pointer;
  flex: none;
  transition: color 0.12s, background 0.12s;
}
.ind-btn:hover,
.ind-btn.is-open { color: var(--txt); background: var(--hover); }
.ind-btn svg { width: 14px; height: 14px; }
.ind-btn .count {
  font-family: var(--font-num);
  font-size: 11.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--txt);
}
.ind-btn .k-divider { height: 12px; }

.section { padding: 3px 8px 5px; }

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: var(--radius-md);
  background: none;
  color: var(--txt);
  text-align: left;
  cursor: pointer;
}
.row:hover { background: var(--hover); }
.name { flex: 1; font-size: 12.5px; }

/* Already on the chart. Not a bar to adding it again — two periods of the same
   indicator is the ordinary case — just a note that it is there. */
.on {
  font-family: var(--font-mono);
  font-size: 9.5px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--faint);
}
.plus { width: 13px; height: 13px; flex: none; color: var(--faint); opacity: 0; }
.row:hover .plus { opacity: 1; }

.foot-rule { margin: 5px 4px; }
.foot .name { color: var(--sec); font-size: 12px; }
.empty { padding: 4px 9px 7px; }
</style>
