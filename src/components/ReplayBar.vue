<script setup>
/* The transport: play, pause, one bar at a time.
 *
 * It sits above the chart rather than in the side panel because it is the one
 * control that is used constantly, and because Space and the arrow key do the
 * same two things — a bar you reach for without looking should be where you
 * are already looking.
 *
 * Speed is bars per second, not a multiplier of real time. A "4×" on a daily
 * chart and a "4×" on a one-minute chart would be four days and four minutes,
 * which is the same number meaning two completely different amounts of
 * waiting.
 */
import { onBeforeUnmount, onMounted, computed } from 'vue';

import { SPEEDS, pause, replay, setSpeed, stepReplay, togglePlay } from '../stores/replay.js';

const account = computed(() => replay.account);

/* Read out of the reactive window rather than off the session, which is a
 * plain object: a computed over it would never be invalidated, and the clock
 * would show the bar the session started on for the rest of the replay. */
const barTime = computed(() => {
  const bar = replay.bars[replay.index];
  return bar ? new Date(bar.time).toISOString().replace('T', ' ').slice(0, 16) : '—';
});

const ended = computed(() => replay.status === 'ended');

/* Space and the right arrow, because the hands are on the chart and not on the
 * buttons. Never stolen from a field being typed in — the ticket is one input
 * away from here and a space in a note would otherwise start the replay. */
function onKeyDown(event) {
  if (!replay.active) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  if (event.code === 'Space') {
    event.preventDefault();
    togglePlay();
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    pause();
    stepReplay();
  }
}

onMounted(() => window.addEventListener('keydown', onKeyDown));
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown);
  // Leaving the view must not leave a timer stepping bars nobody is watching.
  pause();
});

const money = (v) => (v == null ? '—' : v.toLocaleString(undefined, {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
}));
</script>

<template>
  <div class="transport k-panel" :class="{ 'is-idle': !replay.active }">
    <button
      class="btn btn--sm"
      :class="replay.playing ? 'btn--default' : 'btn--accent'"
      :disabled="!replay.active || ended"
      v-hint="{
        label: replay.playing ? 'Pause' : 'Play',
        text: 'Reveals bars one after another at the speed set beside this. Space does '
          + 'the same thing without reaching for the button.',
      }"
      @click="togglePlay"
    >{{ replay.playing ? '❚❚ Pause' : '▶ Play' }}</button>

    <button
      class="btn btn--sm btn--default"
      :disabled="!replay.active || ended"
      v-hint="{
        label: 'One bar',
        text: 'Reveals the next bar and settles anything it fills. The right arrow key '
          + 'does the same. Orders you place now are for the bar after this one.',
      }"
      @click="pause(); stepReplay()"
    >Step ›</button>

    <div class="k-divider"></div>

    <span
      class="speeds"
      v-hint="{
        label: 'Speed',
        text: 'Bars per second, not a multiple of real time — four bars a second means '
          + 'the same amount of waiting on every timeframe.',
      }"
    >
      <button
        v-for="s in SPEEDS"
        :key="s"
        class="speed-btn"
        :class="{ 'is-active': replay.speed === s }"
        :disabled="!replay.active"
        @click="setSpeed(s)"
      >{{ s }}</button>
    </span>

    <div class="k-divider"></div>

    <span class="k-mono-label">{{ barTime }}</span>
    <span v-if="replay.active" class="k-mono-label faint">
      {{ account?.progress ?? 0 }} bars · {{ account?.tradeCount ?? 0 }} trades
    </span>

    <span class="spacer"></span>

    <template v-if="account">
      <span class="k-mono-label faint">equity</span>
      <span class="equity" :class="account.equity >= account.initialBalance ? 'is-up' : 'is-down'">
        {{ money(account.equity) }}
      </span>
    </template>

    <span v-if="replay.status === 'loading'" class="k-mono-label faint">Loading…</span>
    <span v-else-if="ended" class="k-mono-label ended">
      Caught up with the stored data.
    </span>
    <span v-else-if="!replay.active" class="k-mono-label faint">
      No session — set one up on the left.
    </span>
  </div>
</template>

<style scoped>
.transport {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  padding: 6px 10px;
}
.transport.is-idle { opacity: 0.75; }
.spacer { flex: 1; }
.faint { color: var(--faint); }

.speeds {
  display: flex;
  gap: 1px;
  padding: 2px;
  border: 1px solid var(--brd);
  border-radius: var(--radius-sm);
  background: var(--glass);
}
.speed-btn {
  min-width: 24px;
  padding: 2px 5px;
  border: none;
  border-radius: 5px;
  background: none;
  color: var(--sec);
  font-family: 'DM Mono', ui-monospace, monospace;
  font-size: 11px;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.speed-btn:hover:not(:disabled) { color: var(--txt); }
.speed-btn.is-active { color: var(--accent); background: var(--accent-bg); }
.speed-btn:disabled { opacity: 0.4; cursor: default; }

.equity { font-family: 'DM Mono', ui-monospace, monospace; font-size: 13px; }
.is-up { color: var(--pos); }
.is-down { color: var(--neg); }
.ended { color: var(--accent); }
</style>
