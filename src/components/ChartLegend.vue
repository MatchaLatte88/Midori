<script setup>
/* What the candle under the crosshair is, in the corner of the chart.
 *
 * A terminal puts this over the chart rather than in the chrome, and the
 * reason is not decoration: it names the bar you are *pointing at*, which
 * changes as the pointer moves, and a number that changes with the pointer has
 * to be near the pointer. The instrument bar above says what the market is
 * doing; this says what this one bar did.
 *
 * With the pointer off the chart it falls back to the bar at the right edge —
 * the same bar the header is quoting, so the two never contradict each other.
 *
 * It is not clickable and it never takes the pointer: everything it says is
 * also somewhere else, and a legend that swallowed a drag would break the one
 * gesture the chart is actually for.
 */
import { computed } from 'vue';

import { session } from '../stores/session.js';
import { replay } from '../stores/replay.js';

const props = defineProps({
  symbol: { type: String, default: null },
  timeframe: { type: String, default: null },
  /** The bar under the pointer, or null to fall back to the chart's last. */
  bar: { type: Object, default: null },
});

const QUOTES = ['USDT', 'FDUSD', 'USDC', 'BUSD', 'TUSD', 'USD', 'EUR', 'TRY', 'BTC', 'ETH', 'BNB'];

const parts = computed(() => {
  const s = props.symbol;
  if (!s) return { base: '—', quote: '' };
  const q = QUOTES.find((x) => s.length > x.length && s.endsWith(x));
  return q ? { base: s.slice(0, -q.length), quote: q } : { base: s, quote: '' };
});

const shown = computed(() => props.bar ?? session.quote);

/* Against the bar's own open, not against the one before it. This line is
 * about a single candle — what it did between opening and closing — and
 * measuring it against a neighbour would be answering the header's question a
 * second time, in a worse place. */
const change = computed(() => {
  const b = shown.value;
  if (!b || !(b.open > 0)) return null;
  const abs = b.close - b.open;
  return { abs, pct: abs / b.open };
});

const dir = computed(() => {
  const c = change.value;
  if (!c || c.abs === 0) return 'flat';
  return c.abs > 0 ? 'up' : 'down';
});

/** Prices to as many decimals as the symbol actually uses, never padded. */
function px(value) {
  return value == null ? '—' : value.toLocaleString('en-GB', { maximumFractionDigits: 8 });
}

function vol(value) {
  if (value == null) return '—';
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return value.toFixed(2);
}

const visibleIndicators = computed(() => session.indicators.filter((i) => i.visible).length);
</script>

<template>
  <div class="legend">
    <div class="line title">
      <span class="sym"><b>{{ parts.base }}</b><span class="quote">{{ parts.quote }}</span></span>
      <span class="venue k-label">Binance</span>
      <span class="k-divider"></span>
      <span class="tf">{{ props.timeframe ?? '—' }}</span>
      <span v-if="replay.active" class="replay-tag">Replay</span>
    </div>

    <div v-if="shown" class="line ohlc">
      <span><i>O</i>{{ px(shown.open) }}</span>
      <span><i>H</i>{{ px(shown.high) }}</span>
      <span><i>L</i>{{ px(shown.low) }}</span>
      <span><i>C</i>{{ px(shown.close) }}</span>
      <span v-if="change" class="chg" :class="dir">
        {{ change.abs > 0 ? '+' : '' }}{{ px(Number(change.abs.toPrecision(6))) }}
        ({{ change.abs > 0 ? '+' : '' }}{{ (change.pct * 100).toFixed(2) }}%)
      </span>
    </div>

    <div v-if="shown" class="line meta">
      <span><i>Vol</i>{{ vol(shown.volume) }}</span>
      <span v-if="visibleIndicators" class="ind">
        {{ visibleIndicators }} indicator{{ visibleIndicators === 1 ? '' : 's' }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.legend {
  position: absolute;
  top: 8px;
  left: 10px;
  /* Above the canvas, below the overlay that takes drags and below the
     floating bars — it is the one thing here that is only ever read. */
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  /* Never takes the pointer — the chart under it is the thing being used. */
  pointer-events: none;
  user-select: none;
}

.line {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-num);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.title { gap: 7px; }
.sym { font-size: 14px; letter-spacing: -0.015em; }
.sym b { font-weight: 700; color: var(--txt); }
.quote { color: var(--faint); font-weight: 500; }
.venue { color: var(--faint); }
.tf {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--sec);
}
.replay-tag {
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  background: var(--accent-bg);
  color: var(--accent);
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.ohlc { gap: 10px; color: var(--txt); font-weight: 500; }
/* The letter is the label and the number is the value, so the letter steps
   back — the same relationship every other label in the app has to its
   number, at the one size where a whole word would not fit. */
.ohlc i,
.meta i {
  font-style: normal;
  margin-right: 4px;
  color: var(--faint);
  font-weight: 400;
}
.chg { font-weight: 600; }
.up { color: var(--pos); }
.down { color: var(--neg); }
.flat { color: var(--sec); }

.meta { color: var(--sec); font-size: 11px; }
.ind { color: var(--faint); }
</style>
