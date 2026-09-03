<script setup>
/* Form fields generated from a parameter schema.
 *
 * The same schema shape the indicators use — { key, label, type, default,
 * hint, options } — so a strategy that adds a setting gets its field, its
 * label and its explanation without anyone touching this file. That is the
 * point of the schema: a control and the thing it controls cannot drift apart
 * if only one of them is written by hand.
 *
 * IndicatorPanel renders the same types inline rather than through this
 * component. Sharing it would mean rebuilding a panel that works, including
 * its custom sessions editor, which nothing here needs — so this exists for
 * the strategy form and the two are kept apart on purpose. If a third caller
 * ever appears, this is the one to reuse.
 */
import { ZONE_PALETTE } from '../../shared/indicators/fvg.js';

const props = defineProps({
  /** Parameter schema: an array of { key, label, type, ... }. */
  schema: { type: Array, required: true },
  /** Current values, keyed by parameter key. */
  values: { type: Object, required: true },
});

const emit = defineEmits(['update']);

function set(key, value) {
  emit('update', { [key]: value });
}

/* A multi-select writes a whole new array in schema order, so the same choices
 * always serialise the same way and a stored run can be compared to another. */
function toggleMulti(param, value) {
  const current = props.values[param.key] ?? [];
  const next = current.includes(value)
    ? current.filter((v) => v !== value)
    : param.options.map((o) => o.value).filter((v) => v === value || current.includes(v));
  set(param.key, next);
}
</script>

<template>
  <div class="fields">
    <label
      v-for="p in props.schema"
      :key="p.key"
      v-hint="{ label: p.label, text: p.hint }"
      class="field"
      :class="p.type === 'multi' ? 'field--stacked' : 'field--inline'"
    >
      <span class="k-mono-label">{{ p.label }}</span>

      <div v-if="p.type === 'multi'" class="toggles">
        <button
          v-for="o in p.options"
          :key="o.value"
          class="toggle"
          :class="{ 'is-active': (props.values[p.key] ?? []).includes(o.value) }"
          @click.prevent="toggleMulti(p, o.value)"
        >{{ o.label }}</button>
      </div>

      <div v-else-if="p.type === 'color'" class="swatches">
        <button
          v-for="o in (p.options ?? ZONE_PALETTE)"
          :key="o.value"
          class="pick"
          :class="{ 'is-active': o.value === props.values[p.key] }"
          :style="{ background: `var(--${o.value})` }"
          :title="o.label"
          @click.prevent="set(p.key, o.value)"
        ></button>
      </div>

      <select
        v-else-if="p.type === 'select'"
        class="input input--sm"
        :value="props.values[p.key]"
        @change="set(p.key, $event.target.value)"
      >
        <option v-for="o in p.options" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>

      <input
        v-else
        class="input input--sm"
        type="number"
        :value="props.values[p.key]"
        :min="p.min"
        :max="p.max"
        :step="p.step"
        @change="set(p.key, Number($event.target.value))"
      />
    </label>
  </div>
</template>

<style scoped>
.fields { display: flex; flex-direction: column; gap: 5px; }

.field { display: flex; gap: 5px; }
.field--stacked { flex-direction: column; align-items: stretch; }
.field--inline {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
}
.field--inline .input { width: 108px; flex: none; }

.toggles { display: flex; gap: 3px; width: 100%; }
.toggle {
  flex: 1;
  min-width: 0;
  padding: 5px 2px;
  font-size: 10.5px;
  border: 1px solid var(--brd);
  border-radius: var(--radius-sm);
  background: var(--glass);
  color: var(--sec);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.toggle:hover { background: var(--glass-strong); color: var(--txt); }
.toggle.is-active {
  border-color: var(--line-strong);
  background: var(--sel-bg);
  color: var(--txt);
}

.swatches { display: flex; gap: 2px; }
.pick {
  width: 12px;
  height: 12px;
  border-radius: 3px;
  border: 1px solid var(--line);
  padding: 0;
  cursor: pointer;
}
.pick.is-active { outline: 1.5px solid var(--txt); outline-offset: 1px; }
</style>
