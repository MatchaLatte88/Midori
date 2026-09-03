<script setup>
/* The side of a replay: setting one up, and then three faces of running one.
 *
 * It used to be a single column holding everything at once — figures, open
 * positions with all their controls, ticket, working orders, finished trades,
 * note, save, suspend. In 304 pixels that is a scroll, and the things that
 * scrolled out of reach first were the two that matter most while a trade is
 * on: the stop and the close.
 *
 * What is open now lives in the dock under the chart, where there is room to
 * put a whole position on one line. What is left here is the three things that
 * need a column rather than a row:
 *
 *   Trade    everything that can be done to the position being worked on. The
 *            chart opens this, by clicking the block — point at a trade, get
 *            the trade.
 *   Ticket   the considered way into a new one.
 *   Session  the account as a whole, and the ways of putting the afternoon
 *            down: saved as a run, or suspended to be picked up again.
 *
 * v-show and not v-if. A half-typed stop in the ticket has to survive a look
 * at the position that is already open, and it is the same argument the app
 * makes for the side panels themselves.
 */
import { computed, onMounted, ref, watch } from 'vue';

import ConfirmModal from './ConfirmModal.vue';
import OrderTicket from './OrderTicket.vue';
import TradeManager from './TradeManager.vue';
import {
  TIMEFRAME_MS, deleteSavedSession, replay, resumeSession, savedSessions, saveReplay,
  setPanelTab, startReplay, stopReplay, suspendReplay,
} from '../stores/replay.js';
import {
  datasetFor, selectSymbol, session, setError, setTimeframe, setView,
} from '../stores/session.js';
import { money, percent, shortStamp } from '../format.js';

const TF_MS = TIMEFRAME_MS;

const TABS = [
  { id: 'trade', label: 'Trade' },
  { id: 'ticket', label: 'Ticket' },
  { id: 'session', label: 'Session' },
];

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

/* ─── Putting it down and picking it up ─────────────────────────────────── *
 *
 * Different from saving, and worth keeping different. Saving files a finished
 * account in the library the backtests are in, to be compared against them.
 * This keeps an afternoon that is not over — eighty bars in, two positions
 * open — so that stopping is a decision about the evening rather than about
 * the session.
 */

const stored = ref([]);
const sessionName = ref('');
const suspending = ref(false);

async function refreshStored() {
  try {
    stored.value = await savedSessions();
  } catch (err) {
    setError(err);
  }
}

onMounted(refreshStored);

async function suspend() {
  suspending.value = true;
  try {
    await suspendReplay(sessionName.value || `${replay.symbol} ${replay.timeframe}`);
    await refreshStored();
  } catch (err) {
    setError(err);
  } finally {
    suspending.value = false;
  }
}

async function resume(id) {
  try {
    await resumeSession(id);
    /* The shared timeframe follows the session, or the chart's own controls
     * would be pointing at one timeframe while the session played another. */
    if (replay.timeframe !== session.timeframe) setTimeframe(replay.timeframe);
    if (replay.symbol !== session.symbol) selectSymbol(replay.symbol);
  } catch (err) {
    setError(err);
  }
}

async function forget(id) {
  try {
    await deleteSavedSession(id);
    await refreshStored();
  } catch (err) {
    setError(err);
  }
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

      <p class="lead k-prose">
        Steps through history one bar at a time on the engine the backtests run on.
        Orders fill on the bar after the one you are looking at, at the same costs —
        so a session you trade by hand can be compared with what a strategy did.
      </p>
      <p class="lead k-prose">
        Draw a trade with the position tool and right-click it to send it as a market
        or a pending order, or use the ticket here.
      </p>

      <p v-if="!session.symbol" class="empty k-prose">
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

      <!-- Sessions that were put down rather than finished. -->
      <section v-if="stored.length > 0" class="card">
        <div class="card-head">
          <span class="k-eyebrow">Carry on</span>
          <span
            class="k-mono-label faint"
            v-hint="{
              label: 'Unfinished sessions',
              text: 'Sessions that were put down mid-play. The account and the playhead are '
                + 'stored; the bars are fetched again, so picking one up puts you back on '
                + 'the same bar with the same positions open.',
            }"
          >{{ stored.length }}</span>
        </div>
        <ul class="stored">
          <li v-for="s in stored" :key="s.id">
            <button class="stored-open" @click="resume(s.id)">
              <span class="k-mono-label">{{ s.name || s.symbol }}</span>
              <span class="k-mono-label faint">{{ s.symbol }} · {{ s.timeframe }}</span>
              <span class="k-mono-label faint">{{ shortStamp(s.clock) }}</span>
              <span class="stored-figures">
                <span class="k-mono-label faint">{{ s.trades }}t</span>
                <span
                  v-if="s.equity != null"
                  class="k-mono-label"
                  :class="s.equity >= s.initialBalance ? 'is-up' : 'is-down'"
                >{{ money(s.equity) }}</span>
              </span>
            </button>
            <button class="pick" title="Delete" @click="forget(s.id)">×</button>
          </li>
        </ul>
      </section>
    </template>

    <!-- ─── A session in progress ──────────────────────────────────────── -->
    <template v-else>
      <nav class="tabs">
        <button
          v-for="t in TABS"
          :key="t.id"
          class="tab"
          :class="{ 'is-active': replay.panelTab === t.id }"
          @click="setPanelTab(t.id)"
        >
          {{ t.label }}
          <span v-if="t.id === 'trade' && replay.positions.length > 0" class="count">
            {{ replay.positions.length }}
          </span>
        </button>
      </nav>

      <div class="face">
        <TradeManager v-show="replay.panelTab === 'trade'" />
        <OrderTicket v-show="replay.panelTab === 'ticket'" />

        <div v-show="replay.panelTab === 'session'" class="session-face">
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
              <dd :class="replay.account.equity >= replay.account.initialBalance
                ? 'is-up' : 'is-down'">
                {{ percent((replay.account.equity - replay.account.initialBalance)
                  / replay.account.initialBalance) }}
              </dd>
            </div>
            <div><dt>Max DD</dt><dd>{{ percent(replay.account.maxDrawdownPct) }}</dd></div>
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
                label: 'Save as a run',
                text: 'Files the finished account in the same library the backtests land in — so '
                  + 'it can be put next to what a strategy did over the same bars. For a session '
                  + 'that is not over yet, use Pause for later.',
              }"
              @click="store"
            >{{ saving ? 'Saving…' : 'Save as run' }}</button>
            <button class="btn btn--sm btn--default grow" @click="pendingStop = true">Stop</button>
          </div>

          <div
            class="row"
            v-hint="{
              label: 'Pause for later',
              text: 'Puts the session down without ending it: the account, the open positions '
                + 'and the playhead are stored, and it starts again on the same bar. The bars '
                + 'themselves are not stored — they are already downloaded, and they are the '
                + 'same bars tomorrow.',
            }"
          >
            <input
              v-model="sessionName"
              class="input input--sm grow"
              :placeholder="`${replay.symbol} ${replay.timeframe}`"
            />
            <button class="btn btn--sm btn--default" :disabled="suspending" @click="suspend">
              {{ suspending ? 'Saving…' : replay.savedSessionId ? 'Update' : 'Pause for later' }}
            </button>
          </div>
        </div>
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
  gap: 12px;
  width: 304px;
  flex: none;
  padding: 18px;
  overflow-y: auto;
}
.head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.lead { color: var(--sec); margin: 0; line-height: 1.5; }
.empty { color: var(--faint); }
.faint { color: var(--faint); }
.spacer { flex: 1; }
.grow { flex: 1; }
.row { display: flex; align-items: flex-end; gap: 6px; }

/* The three faces of a running session. Underlined rather than segmented, the
   same way the app's own navigation is: these are places, not settings. */
.tabs {
  display: flex;
  gap: 2px;
  flex: none;
  margin: -4px -4px 0;
  border-bottom: 1px solid var(--line-soft);
}
.tab {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 9px;
  border: none;
  border-bottom: 2px solid transparent;
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
  background: none;
  color: var(--sec);
  font-family: var(--font-num);
  font-weight: 600;
  font-size: 12px;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}
.tab:hover { color: var(--txt); background: var(--glass); }
.tab.is-active { color: var(--accent); border-bottom-color: var(--accent); }
.count {
  min-width: 15px;
  padding: 0 4px;
  border-radius: var(--radius-pill);
  background: var(--glass-strong);
  color: var(--sec);
  font-family: var(--font-mono);
  font-size: 9.5px;
  line-height: 15px;
  text-align: center;
}
.tab.is-active .count { background: var(--accent-bg); color: var(--accent); }

.face { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.session-face { display: flex; flex-direction: column; gap: 10px; flex: 1; min-height: 0; }

.field { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.field--stacked { flex-direction: column; align-items: stretch; gap: 3px; }
.field .input { max-width: 148px; }
.field--stacked .input { max-width: none; }

/* Arms a field to take its value from the next click on the chart; here it is
   only the delete button on a stored session, which borrows the shape. */
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

.card {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 14px;
  border: 1px solid var(--brd);
  border-radius: var(--radius-md);
  background: var(--glass);
}
.card-head { display: flex; align-items: center; gap: 7px; }

.figures { display: grid; grid-template-columns: 1fr 1fr; gap: 7px 10px; margin: 0; }
.figures div { display: flex; flex-direction: column; gap: 1px; }
.figures dt {
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--faint);
}
.figures dd { margin: 0; font-family: var(--font-mono); font-size: 13px; }

.stored { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.stored li { display: flex; align-items: center; gap: 6px; }
.stored-open {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  padding: 4px 6px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: none;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.stored-open:hover { border-color: var(--accent-brd); background: var(--accent-bg); }
.stored-open > .k-mono-label:first-child {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.stored-figures { display: flex; gap: 6px; }

.is-up { color: var(--pos); }
.is-down { color: var(--neg); }
</style>
