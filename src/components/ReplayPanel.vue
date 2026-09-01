<script setup>
/* Trading a replay by hand: the account, the ticket, and what is still open.
 *
 * Every order placed here goes through the same Broker a strategy's orders go
 * through, at the same spread, slippage and commission, and fills on the bar
 * after the one being looked at. That is what makes the result worth storing
 * next to a backtest instead of beside it.
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
 * mechanism is Broker._attachBracket; the Protect row below does the same job
 * for a position that is already open.
 */
import { computed, ref, watch } from 'vue';

import ConfirmModal from './ConfirmModal.vue';
import { RISK_MODES, positionSize } from '../../shared/strategies/risk.js';
import {
  cancelAll, cancelOrder, closePosition, marketEntry, pickPrice, protectPosition, replay,
  restingEntry, saveReplay, setRisk, startReplay, stopReplay, takePicked,
} from '../stores/replay.js';
import { datasetFor, session, setError, setView } from '../stores/session.js';

const TF_MS = {
  '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000,
};

/* ─── Setting one up ────────────────────────────────────────────────────── */

const startDay = ref('');
const balance = ref(10_000);
const starting = ref(false);

const dataset = computed(() => (session.symbol ? datasetFor(session.symbol) : null));

/* Halfway through what is stored, so there is history behind the playhead to
 * read and enough ahead of it to be worth replaying. A default of "the first
 * day" would start the session with an empty chart to its left. */
watch(dataset, (meta) => {
  if (!meta || startDay.value) return;
  startDay.value = new Date(meta.first + (meta.last - meta.first) / 2)
    .toISOString().slice(0, 10);
}, { immediate: true });

const canStart = computed(() => (
  !starting.value && !!session.symbol && !!startDay.value && balance.value > 0
));

async function begin() {
  starting.value = true;
  try {
    await startReplay({
      symbol: session.symbol,
      timeframe: session.timeframe,
      stepMs: TF_MS[session.timeframe],
      from: Date.parse(`${startDay.value}T00:00:00Z`),
      balance: Number(balance.value),
      costs: replay.costs,
    });
  } catch (err) {
    setError(err);
  } finally {
    starting.value = false;
  }
}

/* ─── The ticket ────────────────────────────────────────────────────────── */

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

/* What the fill is expected around. A market order fills at the next bar's
 * open, which nobody knows yet — the last close is the honest estimate, and
 * the actual fill is whatever the engine finds. */
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

/* ─── Protecting what is open ───────────────────────────────────────────── */

const protectStop = ref(null);
const protectTarget = ref(null);

/* Prefilled from whatever is already on the position, so adjusting one leg
 * does not silently drop the other.
 *
 * Keyed on which position it is, not on the position object — that is rebuilt
 * on every step, and refilling the fields from it each time would wipe a level
 * being typed the moment the next bar arrived. */
watch(() => replay.position?.openedAt ?? null, () => {
  protectStop.value = replay.position?.stopLoss ?? null;
  protectTarget.value = replay.position?.takeProfit ?? null;
});

function protect() {
  protectPosition({
    stopLoss: Number(protectStop.value) || null,
    takeProfit: Number(protectTarget.value) || null,
  });
}

/* ─── Ending it ─────────────────────────────────────────────────────────── */

const note = ref('');
const saving = ref(false);
const pendingStop = ref(false);

async function store() {
  saving.value = true;
  try {
    await saveReplay(note.value);
    note.value = '';
    // The result belongs beside the backtests, which is where it just went.
    setView('results');
  } catch (err) {
    setError(err);
  } finally {
    saving.value = false;
  }
}

function confirmStop() {
  pendingStop.value = false;
  stopReplay();
}

/* ─── Formatting ───────────────────────────────────────────────────────── */

/* The currency goes in front of the digits and the sign in front of that, so a
 * loss reads −$250.00 rather than $-250.00. Same shape as the chart's own
 * money(), because it is the same account being written down twice. */
const money = (v) => (v == null ? '—' : `${v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString(undefined, {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
})}`);
const price = (v) => (v == null ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: 8 }));
const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const units = (v) => (v == null ? '—' : Number(v.toPrecision(6)).toString());
const clock = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(5, 16);
</script>

<template>
  <aside class="k-panel replay-panel">
    <!-- ─── Setting one up ─────────────────────────────────────────────── -->
    <template v-if="!replay.active">
      <header class="head">
        <span class="k-eyebrow">Replay</span>
        <span v-if="session.symbol" class="k-mono-label faint">
          {{ session.symbol }} · {{ session.timeframe }}
        </span>
      </header>

      <p class="lead k-mono-label">
        Steps through history one bar at a time on the engine the backtests run on.
        Orders fill on the bar after the one you are looking at, at the same costs —
        so a session you trade by hand can be compared with what a strategy did.
      </p>
      <p class="lead k-mono-label">
        Draw a trade with the position tool and right-click it to send it as a market
        or a pending order, or use the ticket here.
      </p>

      <p v-if="!session.symbol" class="empty k-mono-label">
        Pick a symbol on the chart first.
      </p>

      <template v-else>
        <label
          v-hint="{
            label: 'Start date',
            text: 'The first bar you are asked to decide on, in UTC. Everything before it '
              + 'is on the chart to read; everything after it is revealed one bar at a time.',
          }"
          class="field"
        >
          <span class="k-mono-label">Start</span>
          <input v-model="startDay" class="input input--sm" type="date" />
        </label>

        <label
          v-hint="{
            label: 'Starting balance',
            text: 'The account the session begins with, in quote currency. Percentage risk '
              + 'is measured against it, so it also decides how large the first position is.',
          }"
          class="field"
        >
          <span class="k-mono-label">Balance</span>
          <input v-model.number="balance" class="input input--sm" type="number" min="1" step="1000" />
        </label>

        <button class="btn btn--accent" :disabled="!canStart" @click="begin">
          {{ starting ? 'Loading…' : 'Start replay' }}
        </button>
      </template>
    </template>

    <!-- ─── A session in progress ──────────────────────────────────────── -->
    <template v-else>
      <header class="head">
        <span class="k-eyebrow">Account</span>
        <span class="k-mono-label faint">
          {{ replay.symbol }} · {{ replay.timeframe }}
        </span>
      </header>

      <dl v-if="replay.account" class="figures">
        <div><dt>Equity</dt><dd>{{ money(replay.account.equity) }}</dd></div>
        <div><dt>Cash</dt><dd>{{ money(replay.account.balance) }}</dd></div>
        <div>
          <dt>Open</dt>
          <dd :class="replay.account.unrealized >= 0 ? 'is-up' : 'is-down'">
            {{ money(replay.account.unrealized) }}
          </dd>
        </div>
        <div>
          <dt>Return</dt>
          <dd :class="replay.account.equity >= replay.account.initialBalance ? 'is-up' : 'is-down'">
            {{ pct((replay.account.equity - replay.account.initialBalance)
              / replay.account.initialBalance) }}
          </dd>
        </div>
        <div><dt>Max DD</dt><dd>{{ pct(replay.account.maxDrawdownPct) }}</dd></div>
        <div
          v-hint="{
            label: 'Fills',
            text: 'How the bars that touched both stop and target were decided. Minute '
              + 'means the minutes inside the bar were walked in order; pessimistic means '
              + 'the fill that hurts came first, because nothing finer was there to ask.',
          }"
        >
          <dt>Fills</dt>
          <dd>{{ replay.account.resolution === 'intrabar' ? 'minute' : 'pessimistic' }}</dd>
        </div>
      </dl>

      <!-- What is open right now, and what protects it. -->
      <section v-if="replay.position" class="card">
        <div class="card-head">
          <span class="side" :class="replay.position.size > 0 ? 'is-long' : 'is-short'">
            {{ replay.position.size > 0 ? 'long' : 'short' }}
          </span>
          <span class="k-mono-label">{{ units(Math.abs(replay.position.size)) }}</span>
          <span class="k-mono-label faint">@ {{ price(replay.position.entryPrice) }}</span>
          <span class="spacer"></span>
          <span
            class="k-mono-label"
            :class="replay.position.unrealized >= 0 ? 'is-up' : 'is-down'"
          >{{ money(replay.position.unrealized) }}</span>
        </div>

        <div class="row">
          <label class="field field--tight">
            <span class="k-mono-label">Stop</span>
            <input v-model.number="protectStop" class="input input--sm" type="number" step="any" />
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
            <input v-model.number="protectTarget" class="input input--sm" type="number" step="any" />
          </label>
          <button
            class="pick"
            :class="{ 'is-active': replay.picking === 'takeProfit' }"
            title="Click a price on the chart"
            @click="pickPrice('takeProfit')"
          >⌖</button>
        </div>

        <div class="row">
          <button class="btn btn--sm btn--default grow" @click="protect">Protect</button>
          <button class="btn btn--sm btn--default grow" @click="closePosition">Close</button>
        </div>
      </section>

      <!-- The ticket. -->
      <section class="card">
        <span class="k-eyebrow">Ticket</span>

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

        <p v-if="orderType !== 'market'" class="k-mono-label faint">
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

        <p class="size-line k-mono-label">
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

        <div class="row">
          <button class="btn btn--sm buy grow" :disabled="!canSend" @click="send('buy')">Buy</button>
          <button class="btn btn--sm sell grow" :disabled="!canSend" @click="send('sell')">Sell</button>
        </div>
      </section>

      <!-- Waiting orders. -->
      <section v-if="replay.orders.length > 0" class="card">
        <div class="card-head">
          <span class="k-eyebrow">Working</span>
          <span class="spacer"></span>
          <button class="mode-btn" @click="cancelAll">Cancel all</button>
        </div>
        <ul class="orders">
          <li v-for="o in replay.orders" :key="o.id">
            <span class="k-mono-label">{{ o.tag ?? `${o.side} ${o.type}` }}</span>
            <span class="k-mono-label faint">{{ units(o.size) }}</span>
            <span class="k-mono-label">
              {{ price(o.type === 'limit' ? o.limitPrice : o.stopPrice) }}
            </span>
            <span class="spacer"></span>
            <button class="pick" title="Cancel" @click="cancelOrder(o.id)">×</button>
          </li>
        </ul>
      </section>

      <!-- What has been closed, newest first. -->
      <section v-if="replay.trades.length > 0" class="card">
        <span class="k-eyebrow">Trades</span>
        <ul class="trades">
          <li v-for="(t, i) in replay.trades" :key="i">
            <span class="side" :class="t.side === 'long' ? 'is-long' : 'is-short'">{{ t.side }}</span>
            <span class="k-mono-label faint">{{ clock(t.closedAt) }}</span>
            <span class="k-mono-label faint">{{ t.exitTag }}</span>
            <span class="spacer"></span>
            <span class="k-mono-label" :class="t.netPnl >= 0 ? 'is-up' : 'is-down'">
              {{ t.netPnl >= 0 ? '+' : '' }}{{ money(t.netPnl) }}
            </span>
          </li>
        </ul>
      </section>

      <div class="spacer"></div>

      <label class="field field--stacked">
        <span class="k-mono-label">Note</span>
        <input v-model="note" class="input input--sm" placeholder="What was this session testing?" />
      </label>

      <div class="row">
        <button
          class="btn btn--sm btn--accent grow"
          :disabled="saving || replay.trades.length === 0"
          v-hint="{
            label: 'Save session',
            text: 'Stores it as a run, in the same library the backtests land in — so it '
              + 'can be put next to what a strategy did over the same bars.',
          }"
          @click="store"
        >{{ saving ? 'Saving…' : 'Save session' }}</button>
        <button class="btn btn--sm btn--default grow" @click="pendingStop = true">Stop</button>
      </div>
    </template>

    <ConfirmModal
      :open="pendingStop"
      title="Stop this replay?"
      :message="replay.trades.length > 0
        ? `${replay.trades.length} trade${replay.trades.length === 1 ? '' : 's'} and the `
          + 'account they made are discarded unless the session is saved first. The chart '
          + 'goes back to the latest bars.'
        : 'The session is discarded and the chart goes back to the latest bars.'"
      confirm-label="Stop"
      @confirm="confirmStop"
      @cancel="pendingStop = false"
    />
  </aside>
</template>

<style scoped>
.replay-panel {
  display: flex;
  flex-direction: column;
  gap: 9px;
  width: 292px;
  flex: none;
  padding: 12px;
  overflow-y: auto;
}
.head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.lead { color: var(--sec); margin: 0; line-height: 1.5; }
.empty { color: var(--faint); }
.faint { color: var(--faint); }
.spacer { flex: 1; }
.grow { flex: 1; }
.row { display: flex; align-items: flex-end; gap: 6px; }

.field { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.field--tight { flex: 1; }
.field--stacked { flex-direction: column; align-items: stretch; gap: 3px; }
.field .input { max-width: 148px; }
.field--stacked .input { max-width: none; }
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

.card {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 9px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--glass);
}
.card-head { display: flex; align-items: center; gap: 7px; }

.modes {
  display: flex;
  gap: 1px;
  padding: 2px;
  border: 1px solid var(--brd);
  border-radius: var(--radius-sm);
}
.mode-btn {
  flex: 1;
  padding: 3px 8px;
  border: none;
  border-radius: 5px;
  background: none;
  color: var(--sec);
  font-family: 'Plus Jakarta Sans', Inter, sans-serif;
  font-weight: 600;
  font-size: 11px;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.mode-btn:hover { color: var(--txt); }
.mode-btn.is-active { color: var(--accent); background: var(--accent-bg); }

.figures { display: grid; grid-template-columns: 1fr 1fr; gap: 7px 10px; margin: 0; }
.figures div { display: flex; flex-direction: column; gap: 1px; }
.figures dt {
  font-family: 'DM Mono', ui-monospace, monospace;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--faint);
}
.figures dd { margin: 0; font-family: 'DM Mono', ui-monospace, monospace; font-size: 13px; }

.side {
  font-family: 'DM Mono', ui-monospace, monospace;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 1px 5px;
  border-radius: 4px;
}
.side.is-long { color: var(--pos); background: color-mix(in srgb, var(--pos) 12%, transparent); }
.side.is-short { color: var(--neg); background: color-mix(in srgb, var(--neg) 12%, transparent); }

.size-line { margin: 0; color: var(--txt); line-height: 1.45; }
.capped { color: var(--sec); }

.buy { border: 1px solid var(--pos); color: var(--pos); background: color-mix(in srgb, var(--pos) 9%, transparent); }
.sell { border: 1px solid var(--neg); color: var(--neg); background: color-mix(in srgb, var(--neg) 9%, transparent); }
.buy:disabled, .sell:disabled { opacity: 0.45; }

.orders, .trades { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.orders li, .trades li { display: flex; align-items: center; gap: 6px; }

.is-up { color: var(--pos); }
.is-down { color: var(--neg); }
</style>
