<script setup>
/* What the account is holding, under the chart where a terminal keeps it.
 *
 * Everything here used to live in the side panel, stacked: the figures, then
 * the open positions with all their controls, then the ticket, then the
 * working orders, then the finished trades. Two positions and a handful of
 * trades was already more than 304 pixels of column, so the ordinary act of
 * closing a position began with scrolling — which is the wrong thing to be
 * doing with a position open.
 *
 * Widthways there is room for all of it. A row here is a whole position on one
 * line, with the numbers in fixed columns so two of them can be compared by
 * looking rather than by reading, and the actions at the end where the pointer
 * already is.
 *
 * What this is not
 * ----------------
 * It is not where a position is managed. Manage opens the trade manager in the
 * side panel, which is where the stop, the trail, the part-close and the
 * reversal live. Here there is exactly one destructive action per row — close,
 * and the confirmation is that it happens where you can see it happen — and
 * everything else is a way of looking at the account.
 *
 * The strip on the right of the tab row is the account itself: what it is
 * worth, what is open, and what the stops in the market would cost if they all
 * filled. That last one is the number this app had nowhere to put, and it is
 * the one worth having in the corner of the eye all afternoon.
 */
import { computed } from 'vue';

import {
  cancelAll, cancelOrder, closePosition, flattenAll, focusTrade, hoverTrade,
  openTradeManager, replay, reversePosition, setDockTab,
} from '../stores/replay.js';
import { session, togglePanel } from '../stores/session.js';
import { money, percent, price, rMultiple, shortStamp, signedMoney, units } from '../format.js';

const TABS = [
  { id: 'positions', label: 'Positions' },
  { id: 'orders', label: 'Orders' },
  { id: 'history', label: 'History' },
];

/* The dock's own tab, kept beside the side panel's so that opening the trade
 * manager from a row does not also change what the dock is showing. */
const tab = computed(() => replay.dockTab);

const counts = computed(() => ({
  positions: replay.positions.length,
  orders: replay.orders.length,
  history: replay.trades.length,
}));

const open = computed(() => session.panels.dock);

/* Whether the open-risk figure has anything to be a figure of. Without it a
 * book whose stops are all past break-even reads as a dash — the same as a
 * book with no stops at all, which is the opposite situation. */
const anyProtected = computed(() => replay.positions.length > replay.exposure.unprotected);

/**
 * What a finished trade made, in R.
 *
 * Measured against what it risked per unit to begin with, which the trade
 * carries. Not against `stopLoss`, which is where the stop was when it ended:
 * a trade managed to break-even and then closed for a small gain would divide
 * by almost nothing and report a triumph.
 *
 * Trades filed before the Broker recorded the ruler fall back to that closing
 * stop. It is the wrong denominator for a managed trade and the right one for
 * every trade that was left alone, and it is better than a column of dashes
 * over a run that has already been saved.
 */
function tradeR(trade) {
  const unit = trade.riskPerUnit
    ?? (trade.stopLoss == null ? null : Math.abs(trade.entryPrice - trade.stopLoss));
  if (!(unit > 0)) return null;
  return trade.netPnl / (unit * trade.size);
}

/** Where a resting order is waiting. */
function orderPrice(order) {
  return order.type === 'limit' ? order.limitPrice : order.stopPrice;
}
</script>

<template>
  <section class="dock k-panel" :class="{ 'is-closed': !open }">
    <div class="tabs">
      <button
        v-for="t in TABS"
        :key="t.id"
        class="tab"
        :class="{ 'is-active': open && tab === t.id }"
        @click="open && tab === t.id ? togglePanel('dock') : setDockTab(t.id)"
      >
        {{ t.label }}
        <span v-if="counts[t.id] > 0" class="count">{{ counts[t.id] }}</span>
      </button>

      <span class="spacer"></span>

      <!-- The account, always visible, whether the dock is open or folded. -->
      <div class="strip">
        <span class="k-mono-label faint">equity</span>
        <span
          class="figure"
          :class="replay.account && replay.account.equity >= replay.account.initialBalance
            ? 'is-up' : 'is-down'"
        >{{ money(replay.account?.equity) }}</span>

        <span class="k-mono-label faint">open</span>
        <span
          class="figure"
          :class="(replay.account?.unrealized ?? 0) >= 0 ? 'is-up' : 'is-down'"
        >{{ signedMoney(replay.account?.unrealized) }}</span>

        <span
          class="k-mono-label faint"
          v-hint="{
            label: 'Open risk',
            text: 'What every stop in the market would come to together if all of them '
              + 'filled, net of what getting out costs. A stop moved past break-even '
              + 'pays into this rather than adding to it, so it can read as a gain. A '
              + 'position with no stop is counted separately rather than as zero — its '
              + 'risk is not small, it is undecided.',
          }"
        >risk</span>
        <span
          class="figure"
          :class="replay.exposure.risk > 0 ? 'is-down' : 'is-up'"
        >
          {{ anyProtected ? signedMoney(-replay.exposure.risk) : '—' }}
        </span>
        <span v-if="replay.exposure.unprotected > 0" class="unprotected">
          +{{ replay.exposure.unprotected }} unprotected
        </span>
      </div>

      <button
        class="fold"
        :title="open ? 'Fold the dock away' : 'Open the dock'"
        @click="togglePanel('dock')"
      >{{ open ? '⌄' : '⌃' }}</button>
    </div>

    <div v-if="open" class="body">
      <!-- ─── What is open ──────────────────────────────────────────────── -->
      <template v-if="tab === 'positions'">
        <p v-if="replay.positions.length === 0" class="empty k-prose">
          Nothing open.
        </p>
        <table v-else class="grid">
          <thead>
            <tr>
              <th>Side</th><th>Size</th><th>Entry</th><th>Stop</th><th>Target</th>
              <th>At stop</th><th class="num">P&amp;L</th><th class="num">R</th><th></th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="p in replay.positions"
              :key="p.id"
              :class="{ 'is-active': p.id === replay.activePositionId }"
              @click="openTradeManager(p.id)"
            >
              <td><span class="side" :class="p.size > 0 ? 'is-long' : 'is-short'">
                {{ p.size > 0 ? 'long' : 'short' }}
              </span></td>
              <td class="mono">{{ units(Math.abs(p.size)) }}</td>
              <td class="mono">{{ price(p.entryPrice) }}</td>
              <td class="mono" :class="{ faint: p.stopLoss == null }">
                {{ p.stopLoss == null ? 'none' : price(p.stopLoss) }}
              </td>
              <td class="mono" :class="{ faint: p.takeProfit == null }">
                {{ p.takeProfit == null ? 'none' : price(p.takeProfit) }}
              </td>
              <!-- What the stop in the market does if it fills, not how far away it
                   is: past break-even it is a gain, and printing that as risk was
                   the block on the chart telling the same lie. -->
              <td
                class="mono"
                :class="p.stopResult == null ? 'undecided' : p.stopResult >= 0 ? 'is-up' : 'faint'"
              >
                {{ p.stopResult == null ? 'undefined' : signedMoney(p.stopResult) }}
              </td>
              <td class="mono num" :class="p.unrealized >= 0 ? 'is-up' : 'is-down'">
                {{ signedMoney(p.unrealized) }}
              </td>
              <td
                class="mono num"
                :class="p.rMultiple == null ? 'faint' : p.rMultiple >= 0 ? 'is-up' : 'is-down'"
              >{{ rMultiple(p.rMultiple) }}</td>
              <td class="actions">
                <button class="act" title="Manage this trade" @click.stop="openTradeManager(p.id)">
                  Manage
                </button>
                <button
                  class="act act--ember"
                  title="Close it and open the same size the other way"
                  @click.stop="reversePosition(p.id)"
                >Reverse</button>
                <button class="act act--x" title="Close at market" @click.stop="closePosition(p.id)">
                  ×
                </button>
              </td>
            </tr>
          </tbody>
        </table>

        <div v-if="replay.positions.length > 1" class="foot">
          <button class="act" @click="flattenAll">Flatten all</button>
        </div>
      </template>

      <!-- ─── What is waiting ───────────────────────────────────────────── -->
      <template v-else-if="tab === 'orders'">
        <p v-if="replay.orders.length === 0" class="empty k-prose">
          Nothing waiting. A limit or a stop entry from the ticket lands here, and so does
          the protection on an open trade.
        </p>
        <template v-else>
          <table class="grid">
            <thead>
              <tr>
                <th>Side</th><th>Type</th><th>Size</th><th>Price</th><th>Tag</th><th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="o in replay.orders" :key="o.id">
                <td><span class="side" :class="o.side === 'buy' ? 'is-long' : 'is-short'">
                  {{ o.side }}
                </span></td>
                <td class="mono">{{ o.type }}</td>
                <td class="mono">{{ units(o.size) }}</td>
                <td class="mono">{{ price(orderPrice(o)) }}</td>
                <td class="mono faint">{{ o.tag ?? '—' }}</td>
                <td class="actions">
                  <button class="act act--x" title="Cancel" @click="cancelOrder(o.id)">×</button>
                </td>
              </tr>
            </tbody>
          </table>
          <div class="foot">
            <span class="k-prose faint">Drag an order’s line on the chart to move it.</span>
            <span class="spacer"></span>
            <button class="act" @click="cancelAll">Cancel all</button>
          </div>
        </template>
      </template>

      <!-- ─── What is over ──────────────────────────────────────────────── -->
      <template v-else>
        <p v-if="replay.trades.length === 0" class="empty k-prose">
          Nothing finished yet.
        </p>
        <table v-else class="grid">
          <thead>
            <tr>
              <th>Side</th><th>Size</th><th>In</th><th>Out</th><th>Opened</th><th>Closed</th>
              <th>Exit</th><th class="num">R</th><th class="num">Net</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="t in replay.trades"
              :key="t.n"
              class="is-clickable"
              :class="{ 'is-focused': replay.focusedTrade === t.n }"
              @click="focusTrade(t.n)"
              @mouseenter="hoverTrade(t.n)"
              @mouseleave="hoverTrade(null)"
            >
              <td><span class="side" :class="t.side === 'long' ? 'is-long' : 'is-short'">
                {{ t.side }}
              </span></td>
              <td class="mono">{{ units(t.size) }}</td>
              <td class="mono">{{ price(t.entryPrice) }}</td>
              <td class="mono">{{ price(t.exitPrice) }}</td>
              <td class="mono faint">{{ shortStamp(t.openedAt) }}</td>
              <td class="mono faint">{{ shortStamp(t.closedAt) }}</td>
              <td class="mono faint">{{ t.exitTag ?? '—' }}</td>
              <td
                class="mono num"
                :class="tradeR(t) == null ? 'faint' : tradeR(t) >= 0 ? 'is-up' : 'is-down'"
              >{{ rMultiple(tradeR(t)) }}</td>
              <td class="mono num" :class="t.netPnl >= 0 ? 'is-up' : 'is-down'">
                {{ signedMoney(t.netPnl) }}
              </td>
            </tr>
          </tbody>
        </table>

        <div v-if="replay.trades.length > 0" class="foot">
          <span class="k-prose faint">
            Click a row to take the chart to that trade — {{ percent(
              replay.trades.filter((t) => t.netPnl > 0).length / replay.trades.length, 0
            ) }} of {{ replay.trades.length }} came out in front.
          </span>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.dock {
  display: flex;
  flex-direction: column;
  flex: none;
  /* Tall enough for five or six rows and their heading, which is what an
     afternoon usually has open at once. Beyond that it scrolls rather than
     taking the chart's room — the chart is the thing being read. */
  max-height: 216px;
  padding: 0;
  overflow: hidden;
}
.dock.is-closed { max-height: none; }

.tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: none;
  padding: 4px 8px;
  border-bottom: 1px solid var(--line-soft);
}
.dock.is-closed .tabs { border-bottom: none; }

.tab {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 9px;
  border: none;
  border-bottom: 2px solid transparent;
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
  background: none;
  color: var(--sec);
  font-family: var(--font-num);
  font-weight: 600;
  font-size: 11.5px;
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

.spacer { flex: 1; }
.faint { color: var(--faint); }

.strip { display: flex; align-items: baseline; gap: 6px; padding-right: 4px; }
.strip .k-mono-label + .figure { margin-right: 6px; }
.figure { font-family: var(--font-mono); font-size: 12px; }
.unprotected {
  padding: 1px 6px;
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--ember) 12%, transparent);
  color: var(--ember);
  font-family: var(--font-mono);
  font-size: 10px;
}

.fold {
  flex: none;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 5px;
  background: none;
  color: var(--sec);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}
.fold:hover { color: var(--txt); background: var(--glass); }

.body { flex: 1; min-height: 0; overflow-y: auto; padding: 2px 8px 8px; }
.empty { color: var(--faint); padding: 8px 2px; margin: 0; }

/* A table rather than a flex row per line, so the columns line up between
   positions — two trades are compared by looking down a column, and that only
   works if the columns are columns. */
.grid { width: 100%; border-collapse: collapse; }
.grid th {
  padding: 3px 8px 4px 0;
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-weight: 400;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--faint);
  text-align: left;
  white-space: nowrap;
}
.grid td { padding: 3px 8px 3px 0; white-space: nowrap; font-size: 12px; }
.grid th.num, .grid td.num { text-align: right; padding-right: 12px; }
.grid td.mono { font-family: var(--font-mono); }
.grid tbody tr { border-top: 1px solid var(--line-soft); }
.grid tbody tr:hover { background: var(--glass); }
.grid tbody tr.is-active { background: var(--accent-bg); }
.grid tbody tr.is-clickable { cursor: pointer; }
.grid tbody tr.is-focused { background: var(--accent-bg); }
.grid td:last-child { width: 1%; padding-right: 0; }

/* A position with no stop: the one figure in the table that is a warning
   rather than a number. */
.undecided { color: var(--ember); }

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

.actions { display: flex; gap: 4px; justify-content: flex-end; }
.act {
  padding: 2px 8px;
  border: 1px solid var(--brd);
  border-radius: var(--radius-sm);
  background: var(--glass);
  color: var(--sec);
  font-family: var(--font-num);
  font-weight: 600;
  font-size: 10.5px;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.act:hover { color: var(--txt); background: var(--glass-strong); }
.act--ember { color: var(--ember); }
.act--x {
  width: 22px;
  padding: 2px 0;
  color: var(--neg);
  font-size: 13px;
  line-height: 1;
  text-align: center;
}

.foot { display: flex; align-items: center; gap: 8px; padding: 6px 0 0; }
.foot .k-prose { margin: 0; }

.is-up { color: var(--pos); }
.is-down { color: var(--neg); }
</style>
