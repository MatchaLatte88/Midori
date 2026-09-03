<script setup>
/* Per-parameter: one value, or a range to try.
 *
 * Every numeric setting gets a switch. Left, it is a single number and behaves
 * exactly as it does in a normal backtest; right, it becomes from/to/step and
 * multiplies the work. The switch is per parameter rather than a list of
 * "things to sweep" chosen elsewhere, because the question "is this fixed or
 * varied" belongs next to the field it is about — and because a separate list
 * would let a parameter be swept and set at the same time.
 *
 * Only numbers can be swept. A range over a set of trading hours or over a
 * choice between percent and points is not a range, it is a handful of
 * separate sweeps; offering it here would produce combinations nobody means.
 * Those parameters stay single-valued and are shown by ParamFields.
 */
import { expandRange } from '../../shared/analysis/sweep.js';

const props = defineProps({
  /** Parameter schema entries, numeric ones only. */
  schema: { type: Array, required: true },
  /** Fixed values, keyed by parameter key. */
  values: { type: Object, required: true },
  /** Ranges, keyed by parameter key: { from, to, step }. Absent means fixed. */
  ranges: { type: Object, required: true },
});

const emit = defineEmits(['update-value', 'update-range', 'toggle']);

/** How many values a range yields, or null if it does not describe one yet. */
function countFor(key) {
  const range = props.ranges[key];
  if (!range) return null;
  try {
    return expandRange(range).length;
  } catch {
    // Half-typed input — say nothing rather than show an error per keystroke.
    return null;
  }
}

/** A sensible starting range when a parameter is switched to being swept. */
function defaultRange(param) {
  const current = Number(props.values[param.key]) || 0;
  const step = param.step ?? 1;
  return {
    from: current,
    to: Number((current + step * 4).toFixed(6)),
    step,
  };
}

function toggle(param) {
  emit('toggle', param.key, props.ranges[param.key] ? null : defaultRange(param));
}

function patchRange(key, patch) {
  emit('update-range', key, { ...props.ranges[key], ...patch });
}
</script>

<template>
  <div class="fields">
    <div v-for="p in props.schema" :key="p.key" class="param">
      <div class="head">
        <span v-hint="{ label: p.label, text: p.hint }" class="k-mono-label">{{ p.label }}</span>
        <button
          class="sweep-toggle"
          :class="{ 'is-on': !!props.ranges[p.key] }"
          :title="props.ranges[p.key] ? 'Use one value' : 'Try a range of values'"
          @click="toggle(p)"
        >{{ props.ranges[p.key] ? 'Range' : 'Fixed' }}</button>
      </div>

      <input
        v-if="!props.ranges[p.key]"
        class="input input--sm"
        type="number"
        :value="props.values[p.key]"
        :min="p.min"
        :max="p.max"
        :step="p.step"
        @change="emit('update-value', p.key, Number($event.target.value))"
      />

      <div v-else class="range">
        <label class="leg">
          <span class="leg-label k-mono-label">from</span>
          <input
            class="input input--sm"
            type="number"
            :value="props.ranges[p.key].from"
            :min="p.min"
            :max="p.max"
            :step="p.step"
            @change="patchRange(p.key, { from: Number($event.target.value) })"
          />
        </label>
        <label class="leg">
          <span class="leg-label k-mono-label">to</span>
          <input
            class="input input--sm"
            type="number"
            :value="props.ranges[p.key].to"
            :min="p.min"
            :max="p.max"
            :step="p.step"
            @change="patchRange(p.key, { to: Number($event.target.value) })"
          />
        </label>
        <label class="leg">
          <span class="leg-label k-mono-label">step</span>
          <input
            class="input input--sm"
            type="number"
            :value="props.ranges[p.key].step"
            :min="p.step ?? 0.0001"
            :step="p.step"
            @change="patchRange(p.key, { step: Number($event.target.value) })"
          />
        </label>
        <span class="count k-mono-label" :class="{ 'is-bad': countFor(p.key) === null }">
          {{ countFor(p.key) == null ? 'invalid' : `${countFor(p.key)} values` }}
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fields { display: flex; flex-direction: column; gap: 9px; }

.param { display: flex; flex-direction: column; gap: 3px; }
.head { display: flex; align-items: center; justify-content: space-between; gap: 6px; }

/* Reads as a state, not a command: it says what the field currently is. */
.sweep-toggle {
  padding: 2px 7px;
  font-family: var(--font-mono);
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  border: 1px solid var(--brd);
  border-radius: 4px;
  background: var(--glass);
  color: var(--faint);
  cursor: pointer;
}
.sweep-toggle:hover { background: var(--glass-strong); color: var(--txt); }
.sweep-toggle.is-on {
  border-color: var(--accent-brd);
  background: var(--accent-bg);
  color: var(--accent);
}

.range { display: flex; align-items: flex-end; gap: 4px; flex-wrap: wrap; }
.leg { display: flex; flex-direction: column; gap: 1px; }
.leg-label { color: var(--faint); font-size: 9px; }
.leg .input { width: 66px; }

.count { color: var(--sec); padding-bottom: 5px; white-space: nowrap; }
.count.is-bad { color: var(--neg); }
</style>
