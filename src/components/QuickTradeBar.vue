<script setup>
/* Buy and sell at market, from the chart, in one click.
 *
 * The ticket in the side panel is the considered way in: an order type, a stop,
 * a target, a size derived from what the trade may lose. This is the other
 * mood — price is doing something now and the decision is already made. Two
 * buttons and a size, on the chart where the eyes are, and the order goes in as
 * a market order with nothing attached.
 *
 * Nothing attached is the point, not an omission. Protection put on from here
 * would be a number typed under time pressure; the position it opens is drawn
 * on the chart a moment later with its own stop and target line, and those are
 * dragged into place by looking at the chart. Decide the entry with the mouse,
 * decide the levels with the mouse.
 *
 * The size starts empty and stays whatever it is set to. A size left over from
 * a setup that is already over is the one mistake here that costs money, so it
 * is never guessed at — with nothing in the field both buttons are dead.
 */
import { computed, ref } from 'vue';

import { marketEntry, replay, setQuickSize } from '../stores/replay.js';

/* The field holds its own text rather than reading the store back.
 *
 * A controlled number input that re-reads a parsed value cannot be typed into:
 * the "0" of "0.05" parses to nothing, the field is emptied under the cursor,
 * and no size below one can ever be entered. So the text is local, the store
 * takes what parses out of it, and the two only meet when the arrows move it.
 */
const size = ref(replay.quickSize == null ? '' : String(replay.quickSize));

function onType(value) {
  size.value = value;
  setQuickSize(Number(value));
}

/**
 * One step up or down.
 *
 * Rounded on the way out because 1.1 − 1 is 0.10000000000000009 in binary
 * floating point, and a field that shows that after one click on an arrow is a
 * field nobody trusts again. Twelve significant digits keeps every size anyone
 * would type and loses only the dirt.
 */
function nudge(delta) {
  const next = Number(Number((Number(size.value) || 0) + delta).toPrecision(12));
  size.value = next > 0 ? String(next) : '';
  setQuickSize(next);
}

/* Ready, not merely active: a session is `active` from the moment Start is
 * pressed, and for the second or two the window takes to load there is no
 * session behind it for an order to reach. `ended` is the other end of the
 * same thing — the data ran out, so there is no next bar to fill on. */
const canSend = computed(() => replay.quickSize != null && replay.status === 'ready');

function send(side) {
  if (!canSend.value) return;
  /* Tagged apart from the ticket's own market orders, so a stored session can
   * be broken down by how a trade was actually decided. */
  marketEntry({ side, size: replay.quickSize, tag: 'quick' });
}
</script>

<template>
  <div class="quick-bar k-panel">
    <button
      class="side buy"
      :disabled="!canSend"
      v-hint="{
        label: 'Buy at market',
        text: 'Sends a market order for the size beside this, with no stop and no target. '
          + 'It fills on the bar after the one you are looking at, like every other order. '
          + 'Put the levels on afterwards by dragging them off the position line.',
      }"
      @click="send('buy')"
    >Buy</button>

    <div
      class="stepper"
      v-hint="{
        label: 'Size',
        text: 'In base units — coins, not currency. Empty means nothing to send, which is '
          + 'why both buttons are off until you set one. The arrows step by 1; type any '
          + 'size directly for anything finer.',
      }"
    >
      <button class="arrow" :disabled="!size" @click="nudge(-1)">▾</button>
      <input
        class="input"
        type="number"
        min="0"
        step="1"
        placeholder="size"
        :value="size"
        @input="onType($event.target.value)"
      />
      <button class="arrow" @click="nudge(1)">▴</button>
    </div>

    <button
      class="side sell"
      :disabled="!canSend"
      v-hint="{
        label: 'Sell at market',
        text: 'Sends a market order for the size beside this, with no stop and no target. '
          + 'It fills on the bar after the one you are looking at, like every other order. '
          + 'Put the levels on afterwards by dragging them off the position line.',
      }"
      @click="send('sell')"
    >Sell</button>
  </div>
</template>

<style scoped>
/* Top left, where the eye already is for the chart's own chrome. The three
   style bars share this corner and are shown one at a time, but any of them can
   be up while a session runs — so they step down out of the way, which is the
   rule in ChartPanel next to `.is-trading`. */
.quick-bar {
  position: absolute;
  top: 8px;
  left: 8px;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 7px;
}

.side {
  min-width: 52px;
  height: 26px;
  padding: 0 10px;
  border-radius: var(--radius-sm);
  font-family: 'Plus Jakarta Sans', Inter, sans-serif;
  font-weight: 600;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s, opacity 0.15s;
}
.buy {
  border: 1px solid var(--pos);
  color: var(--pos);
  background: color-mix(in srgb, var(--pos) 9%, transparent);
}
.sell {
  border: 1px solid var(--neg);
  color: var(--neg);
  background: color-mix(in srgb, var(--neg) 9%, transparent);
}
.buy:hover:not(:disabled) { background: color-mix(in srgb, var(--pos) 18%, transparent); }
.sell:hover:not(:disabled) { background: color-mix(in srgb, var(--neg) 18%, transparent); }
.side:disabled { opacity: 0.4; cursor: default; }

.stepper { display: flex; align-items: center; gap: 3px; }

.arrow {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 24px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--sec);
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
}
.arrow:hover:not(:disabled) { border-color: var(--brd); color: var(--txt); }
.arrow:disabled { opacity: 0.35; cursor: default; }

.input {
  width: 66px;
  height: 24px;
  padding: 0 6px;
  border: 1px solid var(--brd);
  border-radius: var(--radius-sm);
  background: var(--glass);
  color: var(--txt);
  font-family: 'DM Mono', ui-monospace, monospace;
  font-size: 12px;
  text-align: center;
  min-width: 0;
}
.input:focus-visible { border-color: var(--accent-brd); }
/* Our own arrows are beside it; the browser's would be a second pair. */
.input { appearance: textfield; -moz-appearance: textfield; }
.input::-webkit-outer-spin-button,
.input::-webkit-inner-spin-button { appearance: none; margin: 0; }
</style>
