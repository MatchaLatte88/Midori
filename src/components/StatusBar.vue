<script setup>
/* The strip along the bottom: what is true right now, in the smallest type in
 * the app.
 *
 * Nothing here is a control. It is the row you glance at rather than read —
 * which market, where the playhead is, what time it is in the timezone the
 * bars are stored in. That last one earns its place: every timestamp in this
 * app is UTC, and a person reading a chart at 01:00 local has to be able to
 * check what that is in the market's clock without doing the arithmetic.
 *
 * "Local data only" is a statement about the app, not a connection status.
 * There is no live feed to lose — bars are downloaded once and read off the
 * disk — and saying so is the honest version of the green dot every terminal
 * puts here.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import { session } from '../stores/session.js';
import { replay } from '../stores/replay.js';

const VIEW_NAMES = {
  chart: 'Chart',
  replay: 'Replay',
  backtest: 'Backtest',
  sweep: 'Auto backtest',
  results: 'Results',
};

const now = ref(Date.now());
let timer = null;

onMounted(() => { timer = setInterval(() => { now.value = Date.now(); }, 1000); });
onBeforeUnmount(() => clearInterval(timer));

const utc = computed(() => new Date(now.value).toISOString().slice(11, 19));

/* Where the playhead stands, as the clock rather than as a bar number: the
 * clock is the same instant on every timeframe, so it does not jump when the
 * resolution is switched under a running session. */
const playhead = computed(() => {
  if (!replay.active || replay.clock == null) return null;
  return new Date(replay.clock).toISOString().replace('T', ' ').slice(0, 16);
});

const state = computed(() => {
  if (!replay.active) return null;
  if (replay.status === 'loading') return 'Loading';
  if (replay.status === 'ended') return 'At the end of the data';
  return replay.playing ? 'Playing' : 'Paused';
});
</script>

<template>
  <footer class="status">
    <span class="item strong">{{ VIEW_NAMES[session.view] ?? session.view }}</span>
    <span class="k-divider"></span>
    <span class="item">{{ session.symbol ?? 'No symbol' }} · {{ session.timeframe }}</span>

    <template v-if="playhead">
      <span class="k-divider"></span>
      <span class="item">
        <span class="dot" :class="{ 'is-live': replay.playing }"></span>
        {{ state }} · {{ playhead }}
      </span>
      <span class="k-divider"></span>
      <span class="item">{{ replay.account.tradeCount }} trades</span>
    </template>

    <span class="spacer"></span>

    <span class="item">Local data only</span>
    <span class="k-divider"></span>
    <span class="item">UTC</span>
    <span class="item clock">{{ utc }}</span>
  </footer>
</template>

<style scoped>
.status {
  height: var(--statusbar-height);
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 12px;
  background: var(--surface-1);
  border-top: 1px solid var(--line);
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.02em;
  color: var(--faint);
  overflow: hidden;
  white-space: nowrap;
}
.item { display: inline-flex; align-items: center; gap: 6px; }
.strong { color: var(--sec); }
.clock {
  color: var(--sec);
  font-variant-numeric: tabular-nums;
  min-width: 58px;
}
.spacer { flex: 1; }

.dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--faint);
}
.dot.is-live { background: var(--accent); }
</style>
