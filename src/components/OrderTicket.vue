<script setup>
/* The considered way in: an order type, a stop, a target, and a size that
 * follows from them.
 *
 * Every order placed here goes through the same Broker a strategy's orders go
 * through, at the same spread, slippage and commission. That is what makes the
 * result worth storing next to a backtest instead of beside it. A market order
 * fills at once, at the last price on the chart; a limit or a stop waits for
 * the bars that answer it.
 *
 * Sizing is derived, not typed
 * ----------------------------
 * By default you say what a trade may lose and where it is wrong, and the size
 * follows — the same positionSize the strategies use, so a trade taken by hand
 * and a trade taken by a bot are the same size for the same stop. A fixed size
 * is still available, because sometimes the question really is "what does one
 * whole coin do here", but it is the second option and not the first.
 *
 * A stop and a target on an entry that has not filled yet cannot be two live
 * orders — they would trade against a position that does not exist. They ride
 * along on the order instead and become real orders the moment it fills, so a
 * limit or stop entry is bracketed here exactly like a market one. The
 * mechanism is Broker._attachBracket; the trade manager does the same job for
 * a position that is already open.
 *
 * This used to be one section of a very long side panel. It is its own tab now
 * for a reason that is not tidiness: with the manager beside it, the panel is
 * either about getting in or about what is already on, and those are different
 * frames of mind that were competing for the same 304 pixels.
 */
import { computed, ref, watch } from 'vue';

import { RISK_MODES, positionSize } from '../../shared/strategies/risk.js';
import {
  marketEntry, openTradeManager, pickPrice, replay, restingEntry, setRisk, takePicked,
} from '../stores/replay.js';
import { money, units } from '../format.js';

const ORDER_TYPES = [
  { id: 'market', label: 'Market' },
  { id: 'limit', label: 'Limit' },
  { id: 'stop', label: 'Stop' },
];

const orderType = ref('market');
const entryPrice = ref(null);
const stopLoss = ref(null);
const takeProfit = ref(null);
const sizing = ref('risk');
const fixedSize = ref(0.01);

/** A price clicked on the chart lands in whichever field asked for it. */
watch(() => replay.picked, (picked) => {
  if (!picked) return;
  const taken = takePicked();
  if (taken.field === 'entryPrice') entryPrice.value = round(taken.price);
  else if (taken.field === 'stopLoss') stopLoss.value = round(taken.price);
  else if (taken.field === 'takeProfit') takeProfit.value = round(taken.price);
});

/** Enough decimals for a cheap coin, not so many that a click reads as noise. */
function round(price) {
  return Number(price.toPrecision(8));
}

/** The close of the bar under the playhead — the last price anyone can see. */
const lastClose = computed(() => replay.bars[replay.index]?.close ?? null);

/* What the fill is expected around. A market order fills at the last close
 * plus costs, so this is that close; the actual fill is whatever the engine
 * charges on top. */
const referencePrice = computed(() => (
  orderType.value === 'market' ? lastClose.value : Number(entryPrice.value) || null
));

/**
 * The size the ticket will send, or null when there is no honest answer.
 *
 * Risk sizing without a stop has none: the distance the risk is divided by is
 * missing, and the tempting fallbacks — a default size, the largest the
 * account allows — both turn "this trade has no defined risk" into a real
 * position. The button is disabled instead.
 */
const size = computed(() => {
  if (sizing.value === 'fixed') {
    const value = Number(fixedSize.value);
    return value > 0 ? value : null;
  }
  const entry = referencePrice.value;
  const stop = Number(stopLoss.value);
  if (!(entry > 0) || !(stop > 0) || !replay.account) return null;
  return positionSize(
    replay.account.equity, entry, stop,
    replay.risk.mode, Number(replay.risk.value), Number(replay.risk.maxLeverage),
  );
});

const notional = computed(() => (
  size.value != null && referencePrice.value ? size.value * referencePrice.value : null
));

/** True where the leverage ceiling, not the risk, decided the size. */
const capped = computed(() => {
  if (sizing.value !== 'risk' || size.value == null || !replay.account) return false;
  const ceiling = (replay.account.equity * Number(replay.risk.maxLeverage))
    / (referencePrice.value || 1);
  return Math.abs(size.value - ceiling) < ceiling * 1e-9;
});

/**
 * What the trade being described risks, in money and against the account.
 *
 * The size is already derived from these two numbers, so this is arithmetic
 * anyone could do — but not while deciding whether to press the button, which
 * is the only moment it matters. It is also the check on a fixed size: a size
 * typed by hand has a risk nobody worked out, and this is where it appears.
 */
const plannedRisk = computed(() => {
  const entry = referencePrice.value;
  const stop = Number(stopLoss.value);
  if (size.value == null || !(entry > 0) || !(stop > 0)) return null;
  const cash = Math.abs(entry - stop) * size.value;
  const equity = replay.account?.equity;
  return { cash, share: equity > 0 ? cash / equity : null };
});

/** How far the target is, measured in stops — the only ratio worth the space. */
const plannedR = computed(() => {
  const entry = referencePrice.value;
  const stop = Number(stopLoss.value);
  const target = Number(takeProfit.value);
  if (!(entry > 0) || !(stop > 0) || !(target > 0)) return null;
  const distance = Math.abs(entry - stop);
  return distance > 0 ? Math.abs(target - entry) / distance : null;
});

const canSend = computed(() => (
  replay.active
  && replay.status !== 'ended'
  && size.value != null
  && (orderType.value === 'market' || Number(entryPrice.value) > 0)
));

function send(side) {
  if (!canSend.value) return;
  const spec = {
    side,
    size: size.value,
    tag: orderType.value === 'market' ? 'manual' : `manual-${orderType.value}`,
  };

  const bracket = {
    stopLoss: Number(stopLoss.value) || null,
    takeProfit: Number(takeProfit.value) || null,
  };

  if (orderType.value === 'market') {
    marketEntry({ ...spec, ...bracket });
    /* A market order is filled by the time this returns, so there is a
     * position to manage — and managing it is what anyone does next. The panel
     * moves to it rather than leaving the ticket in front of a trade that is
     * already on. Only for market orders: a resting entry has opened nothing
     * yet, and moving away from the ticket then would be moving away from the
     * thing still being worked on. */
    if (replay.position) openTradeManager(replay.position.id);
  } else {
    restingEntry({
      ...spec, ...bracket, type: orderType.value, price: Number(entryPrice.value),
    });
  }

  /* Emptied afterwards. A ticket still holding the last trade's stop is the
   * one mistake here that costs money: the next click would send a level from
   * a setup that is already over. */
  entryPrice.value = null;
  stopLoss.value = null;
  takeProfit.value = null;
}
</script>

<template>
  <div class="ticket">
    <div class="modes">
      <button
        v-for="t in ORDER_TYPES"
        :key="t.id"
        class="mode-btn"
        :class="{ 'is-active': orderType === t.id }"
        @click="orderType = t.id"
      >{{ t.label }}</button>
    </div>

    <div v-if="orderType !== 'market'" class="row">
      <label class="field field--tight">
        <span class="k-mono-label">Price</span>
        <input v-model.number="entryPrice" class="input input--sm" type="number" step="any" />
      </label>
      <button
        class="pick"
        :class="{ 'is-active': replay.picking === 'entryPrice' }"
        title="Click a price on the chart"
        @click="pickPrice('entryPrice')"
      >⌖</button>
    </div>

    <div class="row">
      <label class="field field--tight">
        <span class="k-mono-label">Stop</span>
        <input v-model.number="stopLoss" class="input input--sm" type="number" step="any" />
      </label>
      <button
        class="pick"
        :class="{ 'is-active': replay.picking === 'stopLoss' }"
        title="Click a price on the chart"
        @click="pickPrice('stopLoss')"
      >⌖</button>
    </div>

    <div class="row">
      <label class="field field--tight">
        <span class="k-mono-label">Target</span>
        <input v-model.number="takeProfit" class="input input--sm" type="number" step="any" />
      </label>
      <button
        class="pick"
        :class="{ 'is-active': replay.picking === 'takeProfit' }"
        title="Click a price on the chart"
        @click="pickPrice('takeProfit')"
      >⌖</button>
    </div>

    <p v-if="orderType !== 'market'" class="k-prose faint">
      These go into the market when the entry fills, not before — nothing to protect
      until then.
    </p>

    <div class="modes">
      <button
        class="mode-btn"
        :class="{ 'is-active': sizing === 'risk' }"
        @click="sizing = 'risk'"
      >Risk</button>
      <button
        class="mode-btn"
        :class="{ 'is-active': sizing === 'fixed' }"
        @click="sizing = 'fixed'"
      >Fixed size</button>
    </div>

    <template v-if="sizing === 'risk'">
      <label
        v-hint="{
          label: 'Risk per trade',
          text: 'How much this trade may lose — percent of equity compounds with the '
            + 'account, fixed always risks the same cash. The size follows from this and '
            + 'the distance to the stop, so a wider stop buys a smaller position rather '
            + 'than a bigger loss.',
        }"
        class="field field--tight"
      >
        <span class="k-mono-label">Risk</span>
        <span class="pair">
          <select
            class="input input--sm"
            :value="replay.risk.mode"
            @change="setRisk({ mode: $event.target.value })"
          >
            <option v-for="m in RISK_MODES" :key="m" :value="m">
              {{ m === 'percent' ? '%' : 'cash' }}
            </option>
          </select>
          <input
            class="input input--sm"
            type="number"
            step="0.25"
            min="0.01"
            :value="replay.risk.value"
            @input="setRisk({ value: Number($event.target.value) })"
          />
        </span>
      </label>

      <label
        v-hint="{
          label: 'Max leverage',
          text: 'The most notional the position may carry, as a multiple of equity. '
            + 'A real limit, not a formality — risking 1% behind a stop 0.08% away asks '
            + 'for twenty times the account, and the fees on that phantom size would '
            + 'decide the whole session.',
        }"
        class="field field--tight"
      >
        <span class="k-mono-label">Max lev.</span>
        <input
          class="input input--sm"
          type="number"
          step="0.5"
          min="1"
          :value="replay.risk.maxLeverage"
          @input="setRisk({ maxLeverage: Number($event.target.value) })"
        />
      </label>
    </template>

    <label v-else class="field field--tight">
      <span class="k-mono-label">Size</span>
      <input v-model.number="fixedSize" class="input input--sm" type="number" step="any" min="0" />
    </label>

    <p class="size-line k-prose">
      <span v-if="size == null" class="faint">
        {{ sizing === 'risk'
          ? 'No stop, so this trade has no defined risk to size against.'
          : 'Set a size above.' }}
      </span>
      <span v-else>
        {{ units(size) }} · {{ money(notional) }} notional
        <span v-if="capped" class="capped">— pinned to the leverage ceiling</span>
      </span>
    </p>

    <!-- What pressing the button costs if it is wrong, and what it pays if it
         is right. Both derived from numbers already on this panel, and both
         only useful in the second before the click. -->
    <p v-if="plannedRisk" class="size-line k-prose">
      Risking <b>{{ money(plannedRisk.cash) }}</b><span v-if="plannedRisk.share != null">
      ({{ (plannedRisk.share * 100).toFixed(2) }}% of equity)</span><span v-if="plannedR != null">
      for {{ plannedR.toFixed(2) }}R</span>.
    </p>

    <div class="row">
      <button class="btn btn--sm buy grow" :disabled="!canSend" @click="send('buy')">Buy</button>
      <button class="btn btn--sm sell grow" :disabled="!canSend" @click="send('sell')">Sell</button>
    </div>
  </div>
</template>

<style scoped>
.ticket { display: flex; flex-direction: column; gap: 7px; }
.faint { color: var(--faint); }
.grow { flex: 1; }
.row { display: flex; align-items: flex-end; gap: 6px; }

.field { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.field--tight { flex: 1; }
.field .input { max-width: 148px; }
.pair { display: flex; gap: 4px; max-width: 148px; }
.pair .input:first-child { width: 58px; }

/* Arms a field to take its value from the next click on the chart. */
.pick {
  flex: none;
  width: 26px;
  height: 26px;
  border: 1px solid var(--brd);
  border-radius: var(--radius-sm);
  background: var(--glass);
  color: var(--sec);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}
.pick:hover { color: var(--txt); border-color: var(--accent-brd); }
.pick.is-active { color: var(--accent); background: var(--accent-bg); border-color: var(--accent-brd); }

.modes {
  display: flex;
  gap: 1px;
  padding: 2px;
  border: 1px solid var(--brd);
  border-radius: var(--radius-sm);
  background: var(--glass);
}
.mode-btn {
  flex: 1;
  padding: 3px 8px;
  border: none;
  border-radius: 5px;
  background: none;
  color: var(--sec);
  font-family: var(--font-num);
  font-weight: 600;
  font-size: 11px;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.mode-btn:hover { color: var(--txt); }
.mode-btn.is-active { color: var(--accent); background: var(--accent-bg); }

.size-line { margin: 0; color: var(--txt); line-height: 1.45; }
.size-line b { font-weight: 600; }
.capped { color: var(--sec); }

.buy { border: 1px solid var(--pos); color: var(--pos); background: color-mix(in srgb, var(--pos) 9%, transparent); }
.sell { border: 1px solid var(--neg); color: var(--neg); background: color-mix(in srgb, var(--neg) 9%, transparent); }
.buy:disabled, .sell:disabled { opacity: 0.45; }
</style>
