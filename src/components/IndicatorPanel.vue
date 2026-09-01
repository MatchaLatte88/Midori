<script setup>
import { computed, ref } from 'vue';
import ConfirmModal from './ConfirmModal.vue';
import { INDICATORS, indicatorCatalog } from '../../shared/indicators/index.js';
import { VOLUME_PROFILE_PARAMS } from '../../shared/indicators/volumeProfile.js';
// Zone colours live with the fair-value-gap schema, which defined them first;
// a session is another zone and uses the same eight.
import { ZONE_PALETTE } from '../../shared/indicators/fvg.js';
import {
  SESSION_PRESETS, SESSION_ZONES, newSession,
} from '../../shared/indicators/sessions.js';
import {
  addIndicator, removeIndicator, session, setVolumeProfile, toggleIndicator,
  updateIndicatorParam,
} from '../stores/session.js';

const catalog = indicatorCatalog();
const picking = ref(false);

/* What is waiting on a confirmation: an indicator, a custom session row, or
 * nothing. One slot rather than one per kind — only one prompt can be open. */
const pending = ref(null);

const vp = computed(() => session.volumeProfile);
const vpStats = computed(() => session.volumeProfile.stats);

function specFor(id) {
  return INDICATORS[id];
}

/* A zone indicator carries its own pair of colours, so its swatch shows both;
 * everything else takes the colour slot it was given when it was added. Stop
 * hunts are drawn differently but named the same way — a bull and a bear
 * colour — so they read off the same pair. A range has a direction only once it
 * breaks, so its swatch is the one colour the box is actually drawn in. */
function swatchFor(ind) {
  const spec = INDICATORS[ind.id];
  if (spec.kind === 'ranges') return `var(--${ind.params.color})`;
  if (!['zones', 'hunts', 'setups'].includes(spec.kind)) return `var(--ind-${ind.colorIndex})`;
  return 'linear-gradient(135deg, '
    + `var(--${ind.params.bullColor}) 0 50%, var(--${ind.params.bearColor}) 50%)`;
}

function add(spec) {
  addIndicator(spec);
  picking.value = false;
}

function askRemoveIndicator(ind) {
  pending.value = {
    kind: 'indicator',
    title: 'Remove this indicator?',
    message: `${INDICATORS[ind.id].name} comes off the chart, along with the settings `
      + 'you gave it. Adding it back starts from the defaults.',
    confirmLabel: 'Remove',
    run: () => removeIndicator(ind.uid),
  };
}

function askRemoveSession(ind, key, i) {
  const name = ind.params[key][i]?.name?.trim();
  pending.value = {
    kind: 'session',
    title: 'Remove this session?',
    message: `${name || 'This session'} is removed from the list, with its time zone `
      + 'and hours. This cannot be undone.',
    confirmLabel: 'Remove',
    run: () => removeSession(ind, key, i),
  };
}

function confirmPending() {
  const action = pending.value;
  pending.value = null;
  action?.run();
}

/* Adds or removes one value of a multi-select parameter, writing a whole new
 * array for the reason writeSessions gives below: an edit that mutates the
 * array in the store is an edit the watcher never sees. Order follows the
 * schema rather than the clicks, so the same three choices always serialise
 * the same way. */
function toggleMulti(ind, p, value) {
  const current = ind.params[p.key] ?? [];
  const next = current.includes(value)
    ? current.filter((v) => v !== value)
    : p.options.map((o) => o.value).filter((v) => v === value || current.includes(v));
  updateIndicatorParam(ind.uid, p.key, next);
}

/* ─── Custom sessions ────────────────────────────────────────────────────── */

/* The list is a single parameter value, so every edit writes a whole new array
 * rather than mutating the one in the store — the same shape any other
 * parameter change has, and it keeps the watcher honest. */
function writeSessions(ind, key, list) {
  updateIndicatorParam(ind.uid, key, list);
}

function patchSession(ind, key, index, patch) {
  const list = ind.params[key].map((s, i) => (i === index ? { ...s, ...patch } : s));
  writeSessions(ind, key, list);
}

function removeSession(ind, key, index) {
  writeSessions(ind, key, ind.params[key].filter((_, i) => i !== index));
}

/* Starting from the preset that was on screen beats starting from nothing:
 * most custom sets are one of the standard ones with a window moved. */
function addSession(ind, key) {
  const current = ind.params[key];
  const seed = current.length === 0 ? (SESSION_PRESETS[ind.params.preset] ?? []) : [];
  writeSessions(ind, key, seed.length ? seed.map((s) => ({ ...s })) : [...current, newSession()]);
}

/** Prices span BTC at 100k and altcoins at 0.00001 — pick decimals to match. */
function fmtPrice(p) {
  if (p == null) return '—';
  const abs = Math.abs(p);
  const decimals = abs >= 1000 ? 2 : abs >= 1 ? 4 : 8;
  return p.toLocaleString('en-GB', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function fmtVolume(v) {
  if (v == null) return '—';
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(2)}K`;
  return v.toFixed(2);
}

function fmtCount(n) {
  return n == null ? '—' : n.toLocaleString('en-GB');
}
</script>

<template>
  <aside class="k-panel side-panel">
    <!-- ─── Volume profile ─────────────────────────────────────────────── -->
    <div class="section-head">
      <div class="k-eyebrow">Volume profile</div>
      <label class="switch">
        <input
          type="checkbox"
          :checked="vp.enabled"
          @change="setVolumeProfile({ enabled: $event.target.checked })"
        />
        <span></span>
      </label>
    </div>

    <p class="k-note">
      Always built from <b>1-minute bars</b>, whatever timeframe the chart shows.
    </p>

    <template v-if="vp.enabled">
      <label
        v-hint="{
          label: 'Range',
          text: 'Which stretch of history the profile covers. The visible range recomputes as you pan; everything stored profiles the whole symbol, however much of it you have.',
        }"
        class="field"
      >
        <span class="k-mono-label">Range</span>
        <select
          class="input"
          :value="vp.range"
          @change="setVolumeProfile({ range: $event.target.value })"
        >
          <option value="visible">Visible chart range</option>
          <option value="all">Everything stored</option>
        </select>
      </label>

      <label
        v-for="p in VOLUME_PROFILE_PARAMS"
        :key="p.key"
        v-hint="{ label: p.label, text: p.hint }"
        class="field"
      >
        <span class="k-mono-label">{{ p.label }}</span>
        <select
          v-if="p.type === 'select'"
          class="input"
          :value="vp[p.key]"
          @change="setVolumeProfile({ [p.key]: $event.target.value })"
        >
          <option v-for="o in p.options" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
        <input
          v-else
          class="input"
          type="number"
          :value="vp[p.key]"
          :min="p.min"
          :max="p.max"
          :step="p.step"
          @change="setVolumeProfile({ [p.key]: Number($event.target.value) })"
        />
      </label>

      <label
        v-hint="{
          label: 'POC / VAH / VAL',
          text: 'Draws the point of control and both value-area edges as lines across the chart, with a label, instead of only colouring the bars.',
        }"
        class="checkline"
      >
        <input
          type="checkbox"
          :checked="vp.showLabels"
          @change="setVolumeProfile({ showLabels: $event.target.checked })"
        />
        <span class="k-mono-label">Show POC / VAH / VAL lines</span>
      </label>

      <div v-if="vpStats" class="readout">
        <div class="readout-row">
          <span class="k-mono-label">POC</span>
          <span class="k-num poc">{{ fmtPrice(vpStats.poc) }}</span>
        </div>
        <div class="readout-row">
          <span class="k-mono-label">VAH</span>
          <span class="k-num">{{ fmtPrice(vpStats.vah) }}</span>
        </div>
        <div class="readout-row">
          <span class="k-mono-label">VAL</span>
          <span class="k-num">{{ fmtPrice(vpStats.val) }}</span>
        </div>
        <div class="readout-row">
          <span class="k-mono-label">Volume</span>
          <span class="k-num">{{ fmtVolume(vpStats.totalVolume) }}</span>
        </div>
        <div class="readout-row">
          <span class="k-mono-label">From bars</span>
          <span class="k-num">{{ fmtCount(vpStats.barCount) }}</span>
        </div>

        <template v-if="vpStats.hasDelta">
          <div class="readout-sep"></div>
          <div class="readout-row">
            <span class="k-mono-label">Buy</span>
            <span class="k-num">{{ fmtVolume(vpStats.buyVolume) }}</span>
          </div>
          <div class="readout-row">
            <span class="k-mono-label">Sell</span>
            <span class="k-num">{{ fmtVolume(vpStats.sellVolume) }}</span>
          </div>
          <div class="readout-row">
            <span class="k-mono-label">Delta</span>
            <span class="k-num" :class="vpStats.delta >= 0 ? 'pos' : 'neg'">
              {{ vpStats.delta >= 0 ? '+' : '−' }}{{ fmtVolume(Math.abs(vpStats.delta)) }}
            </span>
          </div>
        </template>
      </div>

      <p v-if="vpStats && !vpStats.hasDelta" class="k-note">
        No buy/sell split in this data. Re-download the symbol to record it.
      </p>
      <p v-else-if="vpStats && vpStats.deltaCoverage < 0.999" class="k-note">
        Delta covers {{ (vpStats.deltaCoverage * 100).toFixed(0) }}% of the volume here —
        the rest predates the split being recorded.
      </p>
    </template>

    <div class="k-divider-h"></div>

    <!-- ─── Indicators ─────────────────────────────────────────────────── -->
    <div class="section-head">
      <div class="k-eyebrow">Indicators</div>
      <button class="btn btn--sm btn--default" @click="picking = !picking">
        {{ picking ? 'Close' : 'Add' }}
      </button>
    </div>

    <ul v-if="picking" class="catalog">
      <li v-for="spec in catalog" :key="spec.id">
        <button
          v-hint="{ label: spec.name, text: spec.description }"
          class="catalog-item"
          @click="add(spec)"
        >
          <span class="catalog-name">{{ spec.name }}</span>
          <span class="k-mono-meta">{{ spec.description }}</span>
        </button>
      </li>
    </ul>

    <p v-if="!session.indicators.length" class="k-mono-meta">No indicators on the chart.</p>

    <div v-for="ind in session.indicators" :key="ind.uid" class="indicator">
      <div class="indicator-head">
        <!-- A zone indicator is coloured by direction, so its swatch shows both
             of its chosen colours rather than one slot colour. -->
        <span class="swatch" :style="{ background: swatchFor(ind) }"></span>
        <span class="indicator-name">{{ specFor(ind.id).name }}</span>
        <button
          class="icon-btn"
          :class="{ 'is-active': ind.visible }"
          v-hint="ind.visible ? 'Hide this indicator without removing it' : 'Show this indicator again'"
          @click="toggleIndicator(ind.uid)"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path v-if="ind.visible" d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z" />
            <path v-else d="M4 4l16 16M9.9 5.2A9.6 9.6 0 0112 5c6.4 0 10 7 10 7a17 17 0 01-3.2 3.9M6.5 7.8A17 17 0 002 12s3.6 7 10 7c1.4 0 2.6-.3 3.7-.8" />
            <circle v-if="ind.visible" cx="12" cy="12" r="3" />
          </svg>
        </button>
        <button
          v-hint="'Take this indicator off the chart'"
          class="icon-btn"
          @click="askRemoveIndicator(ind)"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      <div class="indicator-params">
        <!-- The hint comes from the same schema the field itself is built from,
             so a new parameter cannot arrive without its explanation. -->
        <label
          v-for="p in specFor(ind.id).params"
          :key="p.key"
          v-hint="{ label: p.label, text: p.hint }"
          class="field"
          :class="['sessions', 'multi'].includes(p.type) ? 'field--stacked' : 'field--inline'"
        >
          <span class="k-mono-label">{{ p.label }}</span>
          <div v-if="p.type === 'sessions'" class="sessions">
            <div v-for="(sess, i) in ind.params[p.key]" :key="i" class="session">
              <input
                class="input input--sm session-name"
                :value="sess.name"
                @change="patchSession(ind, p.key, i, { name: $event.target.value })"
              />
              <button
                v-hint="'Remove this session'"
                class="icon-btn icon-btn--tiny"
                @click="askRemoveSession(ind, p.key, i)"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>

              <select
                class="input input--sm session-zone"
                :value="sess.zone"
                @change="patchSession(ind, p.key, i, { zone: $event.target.value })"
              >
                <option v-for="z in SESSION_ZONES" :key="z.value" :value="z.value">{{ z.label }}</option>
              </select>

              <input
                class="input input--sm session-time"
                type="time"
                :value="sess.start"
                @change="patchSession(ind, p.key, i, { start: $event.target.value })"
              />
              <input
                class="input input--sm session-time"
                type="time"
                :value="sess.end"
                @change="patchSession(ind, p.key, i, { end: $event.target.value })"
              />

              <div class="swatches session-colors">
                <button
                  v-for="o in ZONE_PALETTE"
                  :key="o.value"
                  class="pick"
                  :class="{ 'is-active': o.value === sess.color }"
                  :style="{ background: `var(--${o.value})` }"
                  :title="o.label"
                  @click="patchSession(ind, p.key, i, { color: o.value })"
                ></button>
              </div>
            </div>

            <button class="btn btn--sm btn--default" @click="addSession(ind, p.key)">
              {{ ind.params[p.key].length ? 'Add session' : 'Start from preset' }}
            </button>
          </div>

          <div v-else-if="p.type === 'multi'" class="toggles">
            <button
              v-for="o in p.options"
              :key="o.value"
              class="toggle"
              :class="{ 'is-active': (ind.params[p.key] ?? []).includes(o.value) }"
              @click="toggleMulti(ind, p, o.value)"
            >{{ o.label }}</button>
          </div>

          <div v-else-if="p.type === 'color'" class="swatches">
            <button
              v-for="o in p.options"
              :key="o.value"
              class="pick"
              :class="{ 'is-active': o.value === ind.params[p.key] }"
              :style="{ background: `var(--${o.value})` }"
              v-hint="o.label"
              @click="updateIndicatorParam(ind.uid, p.key, o.value)"
            ></button>
          </div>
          <select
            v-else-if="p.type === 'select'"
            class="input input--sm"
            :value="ind.params[p.key]"
            @change="updateIndicatorParam(ind.uid, p.key, $event.target.value)"
          >
            <option v-for="o in p.options" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
          <input
            v-else
            class="input input--sm"
            type="number"
            :value="ind.params[p.key]"
            :min="p.min"
            :max="p.max"
            :step="p.step"
            @change="updateIndicatorParam(ind.uid, p.key, Number($event.target.value))"
          />
        </label>
      </div>
    </div>

    <ConfirmModal
      :open="pending !== null"
      :title="pending?.title ?? ''"
      :message="pending?.message ?? ''"
      :confirm-label="pending?.confirmLabel ?? 'Remove'"
      @confirm="confirmPending"
      @cancel="pending = null"
    />
  </aside>
</template>

<style scoped>
.side-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  width: 268px;
  flex-shrink: 0;
  overflow-y: auto;
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.field { display: flex; flex-direction: column; gap: 5px; }
.field--stacked { flex-direction: column; align-items: stretch; gap: 5px; }
.field--inline {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.input {
  height: 30px;
  padding: 0 8px;
  border: 1px solid var(--brd);
  border-radius: var(--radius-sm);
  background: var(--glass);
  color: var(--txt);
  font: inherit;
  min-width: 0;
}
.input--sm { height: 26px; width: 110px; font-size: 12px; }
.input:focus-visible { border-color: var(--accent-brd); }

.checkline { display: flex; align-items: center; gap: 7px; cursor: pointer; }

/* Switch — the one control that turns the profile on. */
.switch { position: relative; display: inline-flex; cursor: pointer; }
.switch input { position: absolute; opacity: 0; width: 0; height: 0; }
.switch span {
  width: 34px;
  height: 19px;
  border-radius: 10px;
  background: var(--line);
  border: 1px solid var(--brd);
  transition: background 0.18s;
  position: relative;
}
.switch span::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: var(--sec);
  transition: transform 0.18s, background 0.18s;
}
.switch input:checked + span { background: var(--accent-bg); border-color: var(--accent-brd); }
.switch input:checked + span::after { transform: translateX(15px); background: var(--accent); }

.readout {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 9px 10px;
  border: 1px solid var(--accent-brd);
  border-radius: var(--radius-sm);
  background: var(--accent-bg);
}
.readout-row { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.readout-row .poc { color: var(--accent); font-weight: 600; }
.readout-row .pos { color: var(--pos); }
.readout-row .neg { color: var(--neg); }
.readout-sep { height: 1px; background: var(--accent-brd); margin: 3px 0; }

.k-divider-h { height: 1px; background: var(--line); margin: 2px 0; }

.catalog { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.catalog-item {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 7px 9px;
  border: 1px solid var(--brd);
  border-radius: var(--radius-sm);
  background: var(--glass);
  text-align: left;
  cursor: pointer;
}
.catalog-item:hover { border-color: var(--accent-brd); background: var(--accent-bg); }
.catalog-name { font-weight: 600; font-size: 12px; }

.indicator {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 9px 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
}
.indicator-head { display: flex; align-items: center; gap: 7px; }
.indicator-name { flex: 1; font-weight: 600; font-size: 12px; }
.swatch { width: 9px; height: 9px; border-radius: 2px; flex-shrink: 0; }

/* Colour picker — the same swatch row as the position style bar, sized down to
   fit a side panel rather than a floating toolbar. */
.swatches { display: flex; gap: 2px; }
.pick {
  width: 12px;
  height: 12px;
  border-radius: 3px;
  border: 1px solid var(--brd);
  padding: 0;
  cursor: pointer;
}
.pick.is-active { outline: 1.5px solid var(--txt); outline-offset: 1px; }

/* A row of on/off choices. Equal widths rather than content widths, so the row
   keeps its shape when the labels change and stays inside the 268px panel. */
.toggles { display: flex; gap: 3px; width: 100%; }
.toggle {
  flex: 1;
  min-width: 0;
  padding: 5px 2px;
  font-size: 10.5px;
  letter-spacing: 0.01em;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--sec);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.toggle:hover { border-color: var(--brd); color: var(--txt); }
.toggle.is-active {
  border-color: var(--accent-brd);
  background: var(--accent-bg);
  color: var(--txt);
}

/* Custom sessions — a stack of small editors rather than a table, because the
   panel is 268px wide and a table of five columns is unreadable there. */
.sessions { display: flex; flex-direction: column; gap: 6px; width: 100%; }
.session {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 4px;
  padding: 7px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
}
.session-name { grid-column: 1; width: auto; }
.session-zone { grid-column: 1 / -1; width: auto; }
.session-time { width: auto; }
.session-colors { grid-column: 1 / -1; }
.icon-btn--tiny { width: 24px; height: 24px; }
.icon-btn--tiny svg { width: 13px; height: 13px; }
.indicator-params { display: flex; flex-direction: column; gap: 5px; }
</style>
