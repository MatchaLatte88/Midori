<script setup>
/* The transport: play, pause, one bar at a time — and the ways of covering
 * ground faster than that.
 *
 * It sits above the chart rather than in the side panel because it is the one
 * control that is used constantly, and because the keyboard does the same
 * things — a bar you reach for without looking should be where you are already
 * looking.
 *
 * Speed is bars per second, not a multiplier of real time. A "4×" on a daily
 * chart and a "4×" on a one-minute chart would be four days and four minutes,
 * which is the same number meaning two completely different amounts of
 * waiting.
 *
 * Skipping is stepping, not seeking
 * ---------------------------------
 * Every bar a skip covers goes through the engine: orders fill where they
 * would have filled, a bar that touches both stop and target is decided by its
 * minutes, and a position that would have been stopped out is. A jump that
 * merely moved the playhead would hand back an account that survived moves it
 * did not survive — the same lie as look-ahead, told backwards.
 *
 * Which is also why it only goes forwards. The account has traded through the
 * bars behind it; taking them back would mean deciding which of the trades it
 * took never happened.
 */
import { onBeforeUnmount, onMounted, computed, ref } from 'vue';

import {
  SPEEDS, closeFraction, closePosition, flattenAll, breakEven, jumpTo, marketEntry, pause,
  replay, reversePosition, setShowClosedTrades, setSpeed, stepBars, stepReplay, togglePlay,
} from '../stores/replay.js';
import { setError } from '../stores/session.js';

/* Read out of the reactive window rather than off the session, which is a
 * plain object: a computed over it would never be invalidated, and the clock
 * would show the bar the session started on for the rest of the replay.
 *
 * The clock rather than the bar's own time: it is the same instant on every
 * timeframe, so switching timeframe under a session does not make the readout
 * jump backwards by most of a bar. */
const barTime = computed(() => {
  const at = replay.clock ?? replay.bars[replay.index]?.time;
  return at ? new Date(at).toISOString().replace('T', ' ').slice(0, 16) : '—';
});

const ended = computed(() => replay.status === 'ended');
const ready = computed(() => replay.active && replay.status === 'ready');

/* ─── Covering ground ───────────────────────────────────────────────────── */

/** How many bars a skip covers. Ten is a coffee's worth of chart, not a day. */
const skip = ref(10);

function skipAhead() {
  const count = Math.floor(Number(skip.value));
  if (!(count > 0)) return;
  stepBars(count);
}

/**
 * Where a jump is aimed, as a datetime-local value.
 *
 * Empty until something is typed. Prefilling it with the current moment would
 * put a target in the field that is behind the playhead by the time it is
 * pressed, and the refusal that follows would be the app's fault rather than
 * the person's.
 */
const target = ref('');

async function jump() {
  if (!target.value) return;
  try {
    // The field is naive local time; the session's clock is UTC, like the bars.
    await jumpTo(Date.parse(`${target.value}:00Z`));
  } catch (err) {
    setError(err);
  }
}

/* ─── The keyboard ──────────────────────────────────────────────────────── *
 *
 * The hands are on the chart, not on the buttons. Everything here has a button
 * somewhere too — a shortcut that is the only way to do something is a feature
 * nobody finds — and none of it fires while a field is being typed in, or the
 * ticket's note would start the replay and its first letter would send an
 * order.
 *
 * The ones that move money are deliberately single keys with no modifier,
 * because that is what makes them usable at speed, and deliberately only the
 * ones a person can undo by looking at the chart: an entry can be closed, a
 * close cannot be un-closed but is also never a surprise. Buy and sell send
 * the quick bar's size and nothing else — with no size in that field they do
 * nothing at all, for the reason the field itself is never given a default.
 */
const KEYS = [
  ['Space', 'play or pause'],
  ['→', 'one bar'],
  ['⇧ →', 'skip ahead'],
  ['B / S', 'buy / sell at market, at the quick bar’s size'],
  ['H', 'close half the position'],
  ['C', 'close the position'],
  ['⇧ C', 'close everything'],
  ['E', 'stop to break-even'],
  ['⇧ R', 'turn the position round'],
];

function typing() {
  const tag = document.activeElement?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function onKeyDown(event) {
  if (!replay.active || typing()) return;
  if (event.ctrlKey || event.altKey || event.metaKey) return;

  if (event.code === 'Space') {
    event.preventDefault();
    togglePlay();
    return;
  }

  if (event.key === 'ArrowRight') {
    event.preventDefault();
    pause();
    if (event.shiftKey) skipAhead();
    else stepReplay();
    return;
  }

  if (!ready.value) return;

  switch (event.key.toLowerCase()) {
    case 'b':
      if (replay.quickSize != null) marketEntry({ side: 'buy', size: replay.quickSize, tag: 'key' });
      break;
    case 's':
      if (replay.quickSize != null) marketEntry({ side: 'sell', size: replay.quickSize, tag: 'key' });
      break;
    case 'h':
      if (replay.position) closeFraction(0.5);
      break;
    case 'c':
      if (event.shiftKey) flattenAll();
      else if (replay.position) closePosition();
      break;
    case 'e':
      if (replay.position) breakEven();
      break;
    /* Behind shift, like flatten-all and unlike the rest. The single keys are
     * the ones a person can undo by looking at the chart; a reversal is two
     * decisions at once and deserves the extra finger. */
    case 'r':
      if (event.shiftKey && replay.position) reversePosition();
      break;
    default:
  }
}

onMounted(() => window.addEventListener('keydown', onKeyDown));
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown);
  // Leaving the view must not leave a timer stepping bars nobody is watching.
  pause();
});
</script>

<template>
  <div class="transport" :class="{ 'is-idle': !replay.active }">
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

    <span
      class="skip"
      v-hint="{
        label: 'Skip ahead',
        text: 'Plays this many bars at once — every one of them through the engine, so '
          + 'anything that would have filled does. Shift and the right arrow key do the '
          + 'same.',
      }"
    >
      <button
        class="btn btn--sm btn--default"
        :disabled="!replay.active || ended"
        @click="pause(); skipAhead()"
      >Skip ››</button>
      <input
        v-model="skip"
        class="input input--sm skip-count"
        type="number"
        min="1"
        step="1"
        :disabled="!replay.active"
      >
    </span>

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

    <span
      class="clock"
      v-hint="{
        label: 'The playhead',
        text: 'Where the revealed history ends. It is a moment rather than a bar, so it '
          + 'stays put when you change timeframe.',
      }"
    >{{ barTime }}</span>

    <span
      v-if="replay.active"
      class="jump"
      v-hint="{
        label: 'Jump to',
        text: 'Plays forward to a date and time, one bar at a time through the engine. '
          + 'Only forwards: the account has already traded the bars behind it.',
      }"
    >
      <input
        v-model="target"
        class="input input--sm"
        type="datetime-local"
        :disabled="!ready"
      >
      <button class="btn btn--sm btn--default" :disabled="!ready || !target" @click="jump">
        Go
      </button>
    </span>

    <span v-if="replay.active" class="k-mono-label faint">
      {{ replay.account?.progress ?? 0 }} bars · {{ replay.account?.tradeCount ?? 0 }} trades
    </span>

    <span class="spacer"></span>

    <button
      v-if="replay.active"
      class="btn btn--sm"
      :class="replay.showClosedTrades ? 'btn--accent' : 'btn--default'"
      v-hint="{
        label: 'Finished trades',
        text: 'Draws every closed trade as a line from entry to exit, in the colour of '
          + 'its result. Off leaves the chart to the candles.',
      }"
      @click="setShowClosedTrades(!replay.showClosedTrades)"
    >Trades</button>

    <span
      v-if="replay.active"
      class="keys"
      v-hint="{
        label: 'Keyboard',
        text: KEYS.map(([key, what]) => `${key} — ${what}`).join('. ') + '. None of them '
          + 'fire while you are typing in a field.',
      }"
    >⌨</span>

    <span v-if="replay.status === 'loading'" class="k-mono-label faint">Loading…</span>
    <span v-else-if="ended" class="k-prose ended">
      Caught up with the stored data.
    </span>
    <span v-else-if="!replay.active" class="k-prose faint">
      No session — set one up on the left.
    </span>
  </div>
</template>

<style scoped>
/* The transport is chrome, so it is built like chrome: a band across the top
   of the stage with a hairline under it, not a floating strip. */
.transport {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  height: 40px;
  padding: 0 10px;
  background: var(--surface-1);
  border-bottom: 1px solid var(--line);
}
.transport.is-idle { opacity: 0.75; }
.spacer { flex: 1; }
.faint { color: var(--faint); }

.skip, .jump { display: flex; align-items: center; gap: 4px; }
.skip-count { width: 52px; }
.jump .input { width: 168px; }

.clock {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--txt);
}

.keys {
  padding: 0 4px;
  color: var(--faint);
  font-size: 14px;
  cursor: help;
}

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
  font-family: var(--font-mono);
  font-size: 11px;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.speed-btn:hover:not(:disabled) { color: var(--txt); }
.speed-btn.is-active { color: var(--txt); background: var(--sel-bg); }
.speed-btn:disabled { opacity: 0.4; cursor: default; }

.ended { color: var(--accent); }
</style>
