<script setup>
/* One open position, and everything that can be done to it.
 *
 * This is the face the chart points at: clicking a block opens it, and from
 * then on the panel is talking about that trade and no other. What used to be
 * here was a row of buttons squeezed under a position in a list of positions,
 * which meant the two things a person does most — move the stop, take part off
 * — were the two things hardest to reach.
 *
 * The division of labour with the chart
 * -------------------------------------
 * Levels are dragged, not typed. The stop and the target of an open position
 * are lines on the chart with handles on them, and that is the better gesture
 * by a distance: you look at where the level should be and you put it there.
 * So there is no ⌖ picker here, unlike the ticket — the ticket needs one
 * because the trade it is describing has no lines yet. The fields are for the
 * times a level is known as a number, and they follow the drag.
 *
 * Why R is on everything
 * ---------------------
 * A trade is thought in R and reported in money. "+$412" says nothing until
 * you know what was risked for it; "+1.4R" is the same statement on every
 * symbol at every size. Both are shown, and money is the one that is always
 * there — R needs a stop, and a position without a stop has no R, which this
 * says out loud rather than printing a zero.
 */
import { computed, ref, watch } from 'vue';

import {
  breakEven, closeFraction, closePosition, protectPosition, replay, reversePosition,
  selectPosition, setTrailing,
} from '../stores/replay.js';
import { setError } from '../stores/session.js';
import { money, price, rMultiple, shortStamp, signedMoney, units } from '../format.js';

const position = computed(() => replay.position);
const long = computed(() => (position.value?.size ?? 0) > 0);
const openSize = computed(() => Math.abs(position.value?.size ?? 0));

/* Every field the panel holds, declared together and before the watch that
 * refills them. Split across the sections they belong to, the `immediate`
 * watch below ran before half of them existed — which is a ReferenceError on
 * the way in, not a subtle bug, but only for a session that already has a
 * position open when the panel first appears. */
const stop = ref(null);
const target = ref(null);
/** How far behind the extreme a trailing stop follows, in price. */
const trailDistance = ref(null);
/** A size to take off, in base units. Empty until one is typed. */
const closeSize = ref(null);

/* ─── Protection ────────────────────────────────────────────────────────── */

/* Prefilled from what the position already carries, so moving one leg does not
 * silently drop the other.
 *
 * Keyed on which position it is rather than on the object: the mirror is
 * rebuilt on every step, and refilling from it each time would wipe a level
 * being typed the moment the next bar arrived. Switching to another trade does
 * refill, because it is then a different trade's levels. */
watch(() => position.value?.id ?? null, () => {
  stop.value = position.value?.stopLoss ?? null;
  target.value = position.value?.takeProfit ?? null;
  trailDistance.value = position.value?.trailing?.distance ?? null;
  closeSize.value = null;
}, { immediate: true });

/* A level moved on the chart or by a trail is the same level these show, so
 * they follow it — unless one is under the cursor, which is how a half-typed
 * stop turns into a wrong one. */
watch(() => [position.value?.stopLoss, position.value?.takeProfit], ([sl, tp]) => {
  if (document.activeElement?.tagName === 'INPUT') return;
  stop.value = sl ?? null;
  target.value = tp ?? null;
});

function protect() {
  protectPosition({
    stopLoss: Number(stop.value) || null,
    takeProfit: Number(target.value) || null,
  });
}

/**
 * One R, in price: what this trade risked per unit when it first had a stop.
 *
 * Not the distance to wherever the stop is now. After a break-even that
 * distance is almost nothing, and a "2R target" measured against it would land
 * a few cents from the entry — which is the opposite of what anyone pressing
 * that button means.
 */
const rDistance = computed(() => position.value?.riskPerUnit ?? null);

/**
 * What the stop in the market is doing, in the three states it can be in.
 *
 * Rounded to the cents the figure beside it is printed to, so the sentence and
 * the number can never disagree — a break-even stop lands a fraction of a cent
 * off zero and would otherwise read as "locked in $0.00".
 */
const stopStance = computed(() => {
  const result = position.value?.stopResult ?? null;
  if (result == null) return 'none';
  const cents = Math.round(result * 100);
  return cents < 0 ? 'risk' : cents === 0 ? 'flat' : 'locked';
});

/* Break-even is only available once the trade is far enough in front for that
 * level to be behind the market — the Broker owns the rule and the reason. */
const breakEvenRefusal = computed(() => position.value?.breakEvenRefusal ?? null);

/**
 * Puts the target a whole number of R away and sends it.
 *
 * Typing a target price means doing the arithmetic in your head against an
 * entry with eight decimals in it, every time, while the trade is running.
 * These are the three answers anybody actually wants, and they are only
 * offered when there is a stop to measure them against — without one there is
 * no R for them to be a multiple of.
 */
function targetAt(multiple) {
  const p = position.value;
  const r = rDistance.value;
  if (!p || !r) return;
  const level = p.entryPrice + (long.value ? r * multiple : -r * multiple);
  target.value = Number(level.toPrecision(8));
  protectPosition({ stopLoss: Number(stop.value) || null, takeProfit: target.value });
}

/* ─── Trailing ──────────────────────────────────────────────────────────── */

const trailing = computed(() => position.value?.trailing ?? null);

function toggleTrail() {
  if (trailing.value) {
    setTrailing(null);
    return;
  }
  const distance = Number(trailDistance.value);
  if (!(distance > 0)) {
    setError(new Error('A trailing stop needs a distance — how far behind price it follows'));
    return;
  }
  setTrailing(distance);
}

/* ─── Getting out ───────────────────────────────────────────────────────── */

const FRACTIONS = [
  { label: '¼', value: 0.25 },
  { label: '½', value: 0.5 },
  { label: '¾', value: 0.75 },
];

const canClosePart = computed(() => {
  const size = Number(closeSize.value);
  return size > 0 && size < openSize.value;
});

function closePart() {
  if (!canClosePart.value) return;
  closePosition(position.value.id, Number(closeSize.value));
  closeSize.value = null;
}

/* Turning round is the one action here that opens something as well as
 * closing something, so it says so on the button rather than hiding behind an
 * arrow. It is not guarded by a confirmation: it is reversible by pressing it
 * again, and a dialog in front of a decision that is already late is worse
 * than the mistake it prevents. */
function reverse() {
  reversePosition(position.value.id);
}
</script>

<template>
  <div v-if="!position" class="empty k-prose">
    Nothing open. Take a trade from the ticket, from the quick bar on the chart, or by
    drawing a position and right-clicking it.
  </div>

  <div v-else class="manager">
    <!-- More than one open: which trade this is about, and a way to the others.
         The pills carry their own result, so choosing between them is a
         decision made on what they are doing rather than on their order. -->
    <div v-if="replay.positions.length > 1" class="pills">
      <button
        v-for="p in replay.positions"
        :key="p.id"
        class="pill"
        :class="{ 'is-active': p.id === position.id, 'is-long': p.size > 0, 'is-short': p.size < 0 }"
        @click="selectPosition(p.id)"
      >
        <span class="pill-side">{{ p.size > 0 ? 'L' : 'S' }}</span>
        <span class="k-mono-label">{{ units(Math.abs(p.size)) }}</span>
        <span class="k-mono-label" :class="p.unrealized >= 0 ? 'is-up' : 'is-down'">
          {{ signedMoney(p.unrealized) }}
        </span>
      </button>
    </div>

    <header class="head">
      <span class="side" :class="long ? 'is-long' : 'is-short'">{{ long ? 'long' : 'short' }}</span>
      <span class="k-mono-label">{{ units(openSize) }}</span>
      <span class="k-mono-label faint">@ {{ price(position.entryPrice) }}</span>
      <span class="spacer"></span>
      <span class="k-mono-label faint">{{ shortStamp(position.openedAt) }}</span>
    </header>

    <!-- What it is doing, in both units at once. -->
    <div class="live">
      <span class="pnl" :class="position.unrealized >= 0 ? 'is-up' : 'is-down'">
        {{ signedMoney(position.unrealized) }}
      </span>
      <span
        v-if="position.rMultiple != null"
        class="pnl-r"
        :class="position.rMultiple >= 0 ? 'is-up' : 'is-down'"
      >{{ rMultiple(position.rMultiple) }}</span>
      <span v-else class="pnl-r faint">no R without a stop</span>
    </div>

    <!-- The one thing worth interrupting for. A position with no stop is not a
         position with a small risk, it is one whose risk nobody has decided,
         and every other number on this panel is quietly conditional on it. -->
    <p v-if="stopStance === 'none'" class="warn k-prose">
      No stop — this trade’s risk is undefined. Drag one off the entry line, or set it below.
    </p>
    <p v-else class="risk-line k-prose">
      <template v-if="stopStance === 'risk'">Risking
        <b>{{ money(position.risk) }}</b> to the stop</template>
      <template v-else-if="stopStance === 'flat'">The stop is at break-even —
        <b>nothing</b> left to lose on it</template>
      <template v-else><b>{{ signedMoney(position.stopResult) }}</b>
        locked in at the stop</template><span v-if="position.targetR != null">,
      target at {{ position.targetR.toFixed(2) }}R</span>.
    </p>

    <!-- Levels. Both go in together, because sending one leg alone through
         `protect` would read as "and remove the other". -->
    <div class="field">
      <span class="k-mono-label">Stop</span>
      <input v-model.number="stop" class="input input--sm" type="number" step="any" />
    </div>

    <div class="field">
      <span class="k-mono-label">Target</span>
      <input v-model.number="target" class="input input--sm" type="number" step="any" />
    </div>

    <div
      v-if="rDistance"
      class="row"
      v-hint="{
        label: 'Target in R',
        text: 'Puts the target a whole number of stop-distances from the entry and sends '
          + 'it. The arithmetic is the same every time and doing it in your head against '
          + 'an eight-decimal entry while the trade runs is where it goes wrong.',
      }"
    >
      <span class="k-mono-label faint">Target</span>
      <button v-for="n in [1, 2, 3]" :key="n" class="mode-btn grow" @click="targetAt(n)">
        {{ n }}R
      </button>
    </div>

    <div class="row">
      <button class="btn btn--sm btn--default grow" @click="protect">Protect</button>
      <button
        class="btn btn--sm btn--default grow"
        :disabled="breakEvenRefusal != null"
        :title="breakEvenRefusal ?? undefined"
        v-hint="{
          label: 'Break-even',
          text: 'Moves the stop to where this trade comes out at nothing — past the entry '
            + 'by what getting out costs, since the fee on the way in is already paid. A '
            + 'stop on the entry itself is a small loss every time. Off until the trade is '
            + 'far enough in front for that level to be behind the market: put there any '
            + 'sooner it would close the trade at market on the next bar.',
        }"
        @click="breakEven()"
      >Break-even</button>
    </div>

    <div
      class="row"
      v-hint="{
        label: 'Trailing stop',
        text: 'Follows price with the stop at this distance behind the best level reached '
          + 'since it was switched on, and never the other way. R fills in one R — what this '
          + 'trade risked per unit to begin with, whatever the stop has done since.',
      }"
    >
      <span class="k-mono-label faint">Trail</span>
      <input
        v-model.number="trailDistance"
        class="input input--sm grow"
        type="number"
        step="any"
        :placeholder="trailing ? String(trailing.distance) : 'distance'"
      />
      <button
        v-if="rDistance"
        class="mode-btn narrow"
        title="One R — what this trade risked to begin with"
        @click="trailDistance = Number(rDistance.toPrecision(8))"
      >R</button>
      <button
        class="btn btn--sm"
        :class="trailing ? 'btn--accent' : 'btn--default'"
        @click="toggleTrail"
      >{{ trailing ? 'On' : 'Trail' }}</button>
    </div>

    <div class="k-divider divider--wide"></div>

    <!-- Getting out. The fractions are the common answers and the field is
         every other one; both close at market, and what goes is a finished
         trade with its own result while what stays keeps the same entry. -->
    <div
      class="row"
      v-hint="{
        label: 'Take part off',
        text: 'Closes a fraction at market and leaves the rest running at the same entry. '
          + 'What goes is a closed trade in its own right.',
      }"
    >
      <span class="k-mono-label faint">Close</span>
      <button
        v-for="f in FRACTIONS"
        :key="f.value"
        class="mode-btn grow"
        @click="closeFraction(f.value)"
      >{{ f.label }}</button>
    </div>

    <div class="row">
      <input
        v-model.number="closeSize"
        class="input input--sm grow"
        type="number"
        step="any"
        min="0"
        :placeholder="`of ${units(openSize)}`"
      />
      <button class="btn btn--sm btn--default" :disabled="!canClosePart" @click="closePart">
        Take off
      </button>
    </div>

    <div class="row">
      <button class="btn btn--sm btn--default grow" @click="closePosition(position.id)">
        Close all
      </button>
      <button
        class="btn btn--sm grow reverse"
        v-hint="{
          label: 'Turn it round',
          text: 'Closes this position and opens the same size the other way, both at the '
            + 'same price. The old trade is recorded with the result it had — a reversal '
            + 'is two trades, and showing it as one would hide a loss inside a winner. '
            + 'The new one starts with no stop: the levels of a read that was wrong are '
            + 'wrong too.',
        }"
        @click="reverse"
      >Reverse</button>
    </div>
  </div>
</template>

<style scoped>
.manager { display: flex; flex-direction: column; gap: 8px; }
.empty { color: var(--faint); line-height: 1.5; }
.faint { color: var(--faint); }
.spacer { flex: 1; }
.grow { flex: 1; min-width: 0; }
.row { display: flex; align-items: center; gap: 6px; }
.divider--wide { width: 100%; height: 1px; margin: 2px 0; }

.field { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.field .input { max-width: 148px; }

.head { display: flex; align-items: center; gap: 7px; }

.side {
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 1px 5px;
  border-radius: 4px;
}
.side.is-long { color: var(--pos); background: color-mix(in srgb, var(--pos) 12%, transparent); }
.side.is-short { color: var(--neg); background: color-mix(in srgb, var(--neg) 12%, transparent); }

/* The two numbers the eye comes back to, so they are the two largest here. */
.live { display: flex; align-items: baseline; gap: 10px; }
.pnl { font-family: var(--font-mono); font-size: 22px; letter-spacing: -0.01em; }
.pnl-r { font-family: var(--font-mono); font-size: 13px; opacity: 0.85; }

.risk-line { margin: 0; color: var(--sec); line-height: 1.45; }
.risk-line b { color: var(--txt); font-weight: 600; }

.warn {
  margin: 0;
  padding: 6px 8px;
  border: 1px solid color-mix(in srgb, var(--ember) 30%, transparent);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--ember) 8%, transparent);
  color: var(--ember);
  line-height: 1.45;
}

.mode-btn {
  padding: 4px 8px;
  border: 1px solid var(--brd);
  border-radius: var(--radius-sm);
  background: var(--glass);
  color: var(--sec);
  font-family: var(--font-num);
  font-weight: 600;
  font-size: 11px;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.mode-btn:hover { color: var(--txt); background: var(--glass-strong); }
.mode-btn.narrow { flex: none; width: 28px; padding: 4px 0; }

.reverse {
  border: 1px solid color-mix(in srgb, var(--ember) 45%, transparent);
  color: var(--ember);
  background: color-mix(in srgb, var(--ember) 8%, transparent);
}

/* Which trade this is about, when several are open. */
.pills { display: flex; flex-wrap: wrap; gap: 4px; }
.pill {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 3px 7px;
  border: 1px solid var(--brd);
  border-radius: var(--radius-pill);
  background: var(--glass);
  color: var(--sec);
  cursor: pointer;
}
.pill:hover { background: var(--glass-strong); }
.pill.is-active { border-color: var(--line-strong); background: var(--sel-bg); color: var(--txt); }
.pill-side { font-family: var(--font-mono); font-size: 10px; font-weight: 700; }
.pill.is-long .pill-side { color: var(--pos); }
.pill.is-short .pill-side { color: var(--neg); }

.is-up { color: var(--pos); }
.is-down { color: var(--neg); }
</style>
