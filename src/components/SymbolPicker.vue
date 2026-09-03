<script setup>
/* Choosing what the app is looking at, from the symbol card that names it.
 *
 * The list of downloaded symbols also lives in the data panel, and that is not
 * a duplicate: the panel is where a market is *acquired* — download a range,
 * see what it cost in bars and megabytes — and this is where one is *switched
 * to*, from the one place on the screen that already says which symbol is
 * showing. Two different verbs, and putting the second one behind the panel is
 * what made changing market a three-click errand.
 *
 * Nothing is fetched here. It lists what is on disk, because a symbol with no
 * bars behind it is not something the chart can be switched to.
 */
import { computed, nextTick, ref, watch } from 'vue';

import { selectSymbol, session } from '../stores/session.js';

const props = defineProps({
  open: { type: Boolean, default: false },
});
const emit = defineEmits(['close']);

const query = ref('');
const input = ref(null);

/* Opening the list is the same gesture as starting to type in it, so the
 * caret goes to the field without a second click. The filter is cleared on
 * the way in rather than on the way out: what was typed stays readable until
 * the panel is actually gone. */
watch(() => props.open, async (open) => {
  if (!open) return;
  query.value = '';
  await nextTick();
  input.value?.focus();
});

/* The quote currency, split off so the base can carry the weight — BTC is the
 * market, USDT is the unit it is priced in. A symbol whose ending is not one
 * we know is left whole rather than guessed at. */
const QUOTES = ['USDT', 'FDUSD', 'USDC', 'BUSD', 'TUSD', 'USD', 'EUR', 'TRY', 'BTC', 'ETH', 'BNB'];

function split(symbol) {
  const quote = QUOTES.find((q) => symbol.length > q.length && symbol.endsWith(q));
  return quote ? { base: symbol.slice(0, -quote.length), quote } : { base: symbol, quote: '' };
}

const rows = computed(() => {
  const q = query.value.trim().toUpperCase();
  return session.datasets
    .filter((d) => !q || d.symbol.includes(q))
    .map((d) => ({ ...d, ...split(d.symbol) }));
});

function fmtCount(n) {
  return (n ?? 0).toLocaleString('en-GB');
}
function fmtRange(d) {
  if (!d.first || !d.last) return '—';
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  return `${day(d.first)} → ${day(d.last)}`;
}

function choose(symbol) {
  selectSymbol(symbol);
  emit('close');
}
</script>

<template>
  <!-- A click anywhere else closes it. The backdrop is what makes that one
       rule rather than a listener per surface underneath. -->
  <div v-if="props.open" class="backdrop" @pointerdown.self="emit('close')">
    <div class="picker k-pop anim-fade-up" role="dialog" aria-label="Choose symbol">
      <div class="search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
          <circle cx="11" cy="11" r="7" /><path d="M20 20l-4.2-4.2" />
        </svg>
        <input
          ref="input"
          v-model="query"
          class="search-input"
          placeholder="Search symbols…"
          spellcheck="false"
          @keydown.esc="emit('close')"
          @keydown.enter="rows.length && choose(rows[0].symbol)"
        />
      </div>

      <div class="k-label section">On this machine</div>

      <ul v-if="rows.length" class="list">
        <li
          v-for="d in rows"
          :key="d.symbol"
          class="row"
          :class="{ 'is-active': d.symbol === session.symbol }"
          @click="choose(d.symbol)"
        >
          <span class="avatar">{{ d.base.slice(0, 2) }}</span>
          <span class="name">
            <b>{{ d.base }}</b><span class="quote">{{ d.quote }}</span>
          </span>
          <span class="range k-mono-meta">{{ fmtRange(d) }}</span>
          <span class="bars">{{ fmtCount(d.count) }}</span>
        </li>
      </ul>

      <p v-else class="empty k-prose">
        {{ session.datasets.length
          ? 'No stored symbol matches that.'
          : 'Nothing downloaded yet — the data panel on the left fetches a range.' }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
}
.picker {
  position: absolute;
  top: calc(var(--titlebar-height) + var(--toolbar-height) - 6px);
  left: 12px;
  width: 460px;
  max-height: min(520px, calc(100vh - 160px));
  display: flex;
  flex-direction: column;
  padding: 8px;
  overflow: hidden;
}

.search {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 38px;
  padding: 0 11px;
  border: 1px solid var(--brd);
  border-radius: var(--radius-md);
  background: var(--surface-1);
  color: var(--faint);
  flex: none;
}
.search svg { width: 15px; height: 15px; flex: none; }
.search-input {
  flex: 1;
  min-width: 0;
  border: none;
  background: none;
  color: var(--txt);
  font-family: var(--font-ui);
  font-size: 13px;
  outline: none;
}
.search-input::placeholder { color: var(--faint); }

.section { padding: 12px 8px 6px; }

.list {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  min-height: 0;
}
.row {
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 10px;
  padding: 7px 8px;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  cursor: pointer;
}
.row:hover { background: var(--hover); }
.row.is-active { background: var(--sel-bg); border-color: var(--brd); }

/* The base currency's first two letters, as a mark. A real logo would need a
   network round trip and a fallback for everything it did not have; this is
   the fallback, used for everything. */
.avatar {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: var(--radius-sm);
  background: var(--surface-3);
  color: var(--sec);
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.02em;
}
.name {
  font-family: var(--font-num);
  font-size: 13px;
  letter-spacing: -0.01em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.name b { font-weight: 700; color: var(--txt); }
.quote { color: var(--faint); font-weight: 500; }

.range { color: var(--faint); }
.bars {
  font-family: var(--font-num);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--sec);
  min-width: 62px;
  text-align: right;
}

.empty { padding: 10px 8px 14px; }
</style>
