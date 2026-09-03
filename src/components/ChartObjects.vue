<script setup>
/* Everything drawn on this symbol, as a list you can put things away in.
 *
 * The bin used to be the only thing on offer for a drawing that was in the
 * way. That is the wrong tool for the ordinary case: on a chart with a season
 * of work on it most levels are right and most of them are not what you are
 * looking at this afternoon. So a drawing can be taken off the chart and put
 * back, and hidden is stored with the drawing — a chart you cleared today
 * should still be clear tomorrow.
 *
 * Hidden means gone, not faint. A drawing that is off cannot be clicked, cannot
 * be dragged and cannot be selected (`findAt` in useDrawings), because a line
 * you cannot see that still takes the pointer is the worst kind of bug to be
 * told about: there is nothing on the screen to explain it.
 *
 * The eye beside the list is a different thing again — every drawing off at
 * once, for a glance at bare price — and deliberately not remembered: a glance
 * that survived a restart would look like the work had been lost.
 */
import { computed, ref } from 'vue';

import MenuPopover from './MenuPopover.vue';
import { TOOLS, styleKind } from './chart/drawings/registry.js';

const props = defineProps({
  /** Every drawing on this symbol, hidden ones included. */
  drawings: { type: Array, default: () => [] },
  selectedId: { type: [String, null], default: null },
  allHidden: { type: Boolean, default: false },
});

const emit = defineEmits(['toggle', 'lock', 'edit', 'remove', 'select', 'toggle-all', 'clear']);

const open = ref(false);
const trigger = ref(null);

const NAMES = Object.fromEntries(TOOLS.map((t) => [t.id, t.name]));

/* Newest first. A list of drawings is read to find the one just made far more
 * often than the one made in March. */
const rows = computed(() => [...props.drawings]
  .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  .map((d) => ({
    id: d.id,
    hidden: d.hidden === true,
    locked: d.locked === true,
    /* Only the annotations can be edited from here, and this is the one place
     * a flag's caption can be given at all — placing one deliberately does not
     * stop to ask for words. */
    editable: styleKind(d.type) === 'text',
    color: d.color,
    name: NAMES[d.type] ?? d.type,
    detail: detail(d),
  })));

const hiddenCount = computed(() => props.drawings.filter((d) => d.hidden).length);

/**
 * The one thing worth saying about a drawing besides what kind it is.
 *
 * A price for anything that is about a level, a date for anything that is
 * about a moment — which between them is every tool here. Two drawings of the
 * same kind are otherwise indistinguishable in a list, which is exactly when
 * a list stops being useful.
 */
function detail(d) {
  // What an annotation says is more use than where it is.
  if (d.text) return d.text.split(/\n/)[0];
  const [first] = d.points ?? [];
  // A pane-anchored note has no market coordinates to report.
  if (d.screen) return 'pinned to the pane';
  if (!first) return '';
  if (d.type === 'vertical') return day(first.time);
  if (d.type === 'horizontal') return price(first.price);
  const prices = d.points.map((p) => p.price);
  return `${price(Math.min(...prices))} – ${price(Math.max(...prices))}`;
}

/* Short enough for a list. The full precision is on the chart and in the
 * style bar; here two identical-looking rows only have to be told apart, and
 * "79,979.11956243" is worse at that than "79,979.12". A symbol that costs
 * 0.00001 still gets the decimals it needs. */
function price(v) {
  if (v == null) return '—';
  const digits = Math.abs(v) >= 100 ? 2 : 6;
  return v.toLocaleString('en-GB', { maximumFractionDigits: digits });
}
function day(ms) {
  return ms ? new Date(ms).toISOString().slice(0, 10) : '—';
}
</script>

<template>
  <!-- Every drawing off at once. Beside the list rather than inside it: it is
       about the chart, not about any one object. -->
  <button
    class="tool-btn"
    :class="{ 'is-active': props.allHidden }"
    :title="props.allHidden ? 'Show the drawings again' : 'Take every drawing off the chart'"
    @click="emit('toggle-all')"
  >
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
      <template v-if="props.allHidden">
        <path d="M3 3l18 18" />
        <path d="M10.6 5.1A9.7 9.7 0 0112 5c5 0 9 4.5 9 7a12 12 0 01-2.4 3.4M6.6 6.7C4.2 8.2 3 10.5 3 12c0 2.5 4 7 9 7a9.6 9.6 0 004.4-1.1" />
        <path d="M9.9 9.9a3 3 0 004.2 4.2" />
      </template>
      <template v-else>
        <path d="M3 12s3.5-7 9-7 9 7 9 7-3.5 7-9 7-9-7-9-7z" />
        <circle cx="12" cy="12" r="2.6" />
      </template>
    </svg>
  </button>

  <button
    ref="trigger"
    class="tool-btn"
    :class="{ 'is-open': open }"
    title="Objects — everything drawn on this symbol"
    @click="open = !open"
  >
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
      <path d="M12 3l9 5-9 5-9-5z" />
      <path d="M3 12.5l9 5 9-5M3 16.5l9 5 9-5" />
    </svg>
    <span v-if="props.drawings.length" class="badge">{{ props.drawings.length }}</span>
  </button>

  <MenuPopover
    :open="open"
    :anchor="trigger"
    align="right"
    :width="292"
    label="Objects"
    @close="open = false"
  >
    <div class="head">
      <span class="k-label">On this symbol</span>
      <button
        v-if="props.drawings.length"
        class="clear"
        title="Remove every drawing on this symbol"
        @click="emit('clear'); open = false"
      >Remove all</button>
    </div>

    <p v-if="!props.drawings.length" class="empty k-prose">
      Nothing drawn here yet. The tools are down the left of the chart.
    </p>

    <template v-else>
      <div
        v-for="row in rows"
        :key="row.id"
        class="row"
        :class="{
          'is-active': row.id === props.selectedId,
          'is-hidden': row.hidden,
          'is-locked': row.locked,
        }"
        @click="emit('select', row.id)"
      >
        <span class="swatch" :style="{ background: `var(--${row.color})` }"></span>
        <span class="text">
          <span class="name">{{ row.name }}</span>
          <span class="detail">{{ row.detail }}</span>
        </span>
        <button
          class="act"
          :title="row.hidden ? 'Show on the chart' : 'Take off the chart'"
          @click.stop="emit('toggle', row.id)"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
            <template v-if="row.hidden">
              <path d="M3 3l18 18" />
              <path d="M10.6 5.1A9.7 9.7 0 0112 5c5 0 9 4.5 9 7a12 12 0 01-2.4 3.4M6.6 6.7C4.2 8.2 3 10.5 3 12c0 2.5 4 7 9 7a9.6 9.6 0 004.4-1.1" />
            </template>
            <template v-else>
              <path d="M3 12s3.5-7 9-7 9 7 9 7-3.5 7-9 7-9-7-9-7z" />
              <circle cx="12" cy="12" r="2.6" />
            </template>
          </svg>
        </button>
        <button
          v-if="row.editable"
          class="act"
          title="Edit the text"
          @click.stop="emit('edit', row.id); open = false"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
            <path d="M4 20h4l10-10-4-4L4 16z" />
            <path d="M14 6l4 4" />
          </svg>
        </button>
        <button
          class="act"
          :class="{ 'is-locked': row.locked }"
          :title="row.locked
            ? 'Unlock — it can be dragged again'
            : 'Lock — it stays on the chart but the pointer goes through it'"
          @click.stop="emit('lock', row.id)"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
            <rect x="5" y="11" width="14" height="9" rx="1.5" />
            <path v-if="row.locked" d="M8 11V7a4 4 0 0 1 8 0v4" />
            <path v-else d="M8 11V7a4 4 0 0 1 7.5-2" />
          </svg>
        </button>
        <button class="act danger" title="Delete" @click.stop="emit('remove', row.id)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
            <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
          </svg>
        </button>
      </div>

      <p v-if="hiddenCount" class="foot k-prose">
        {{ hiddenCount }} of {{ props.drawings.length }} put away.
      </p>
    </template>
  </MenuPopover>
</template>

<style scoped>
.tool-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex: none;
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--sec);
  cursor: pointer;
  transition: color 0.12s, background 0.12s;
}
.tool-btn:hover,
.tool-btn.is-open { color: var(--txt); background: var(--hover); }
.tool-btn.is-active { color: var(--txt); background: var(--sel-bg); }
.tool-btn svg { width: 15px; height: 15px; }

/* How many objects there are, without a second control to read it from. */
.badge {
  position: absolute;
  top: 1px;
  right: 0;
  min-width: 12px;
  padding: 0 2px;
  border-radius: var(--radius-pill);
  background: var(--surface-3);
  color: var(--sec);
  font-family: var(--font-mono);
  font-size: 8px;
  line-height: 12px;
  text-align: center;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 3px 8px 6px;
}
.clear {
  border: none;
  background: none;
  color: var(--faint);
  font-size: 11px;
  cursor: pointer;
  padding: 0;
}
.clear:hover { color: var(--neg); }

.row {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 6px 6px 6px 8px;
  border-radius: var(--radius-md);
  cursor: pointer;
}
.row:hover { background: var(--hover); }
.row.is-active { background: var(--sel-bg); }
/* Put away, so it reads as put away in the list too — but still legible, since
   this is the one place it can be found again. */
.row.is-hidden .text { opacity: 0.45; }

.swatch {
  width: 9px;
  height: 9px;
  border-radius: 2px;
  flex: none;
}
.row.is-hidden .swatch { opacity: 0.35; }

.text { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
.name {
  font-size: 12.5px;
  color: var(--txt);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.detail {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.act {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  flex: none;
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--faint);
  cursor: pointer;
  opacity: 0;
  transition: color 0.12s, background 0.12s, opacity 0.12s;
}
/* The actions appear under the pointer, and the eye stays put on a row that is
   already off — otherwise the only way back is to guess where the button was. */
.row:hover .act,
.row.is-hidden .act:first-of-type,
.row.is-locked .act.is-locked { opacity: 1; }
.act:hover { color: var(--txt); background: var(--glass-strong); }
.act.danger:hover { color: var(--neg); }
.act svg { width: 14px; height: 14px; }

.empty { padding: 4px 9px 8px; }
.foot { padding: 7px 9px 3px; font-size: 11px; color: var(--faint); }
</style>
