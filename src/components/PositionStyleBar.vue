<script setup>
/* Zone styling for a selected long/short block.
 *
 * Floats over the chart rather than living in a side panel: the thing being
 * edited is right there, and a colour choice is much easier to judge next to
 * the block it changes than across the window from it.
 */
import { MAX_FILL_OPACITY, ZONE_COLORS } from './chart/drawings/model.js';

const props = defineProps({
  profitColor: { type: String, required: true },
  lossColor: { type: String, required: true },
  fillOpacity: { type: Number, required: true },
});

const emit = defineEmits(['update']);

const percent = (v) => Math.round(v * 100);
</script>

<template>
  <div class="style-bar k-panel">
    <span class="k-eyebrow">Position</span>

    <div class="group">
      <span class="k-mono-label">Profit</span>
      <div class="swatches">
        <button
          v-for="c in ZONE_COLORS"
          :key="`p-${c.id}`"
          class="swatch"
          :class="{ 'is-active': c.id === props.profitColor }"
          :style="{ background: `var(--${c.id})` }"
          :title="c.label"
          @click="emit('update', { profitColor: c.id })"
        ></button>
      </div>
    </div>

    <div class="group">
      <span class="k-mono-label">Loss</span>
      <div class="swatches">
        <button
          v-for="c in ZONE_COLORS"
          :key="`l-${c.id}`"
          class="swatch"
          :class="{ 'is-active': c.id === props.lossColor }"
          :style="{ background: `var(--${c.id})` }"
          :title="c.label"
          @click="emit('update', { lossColor: c.id })"
        ></button>
      </div>
    </div>

    <div class="group group--wide">
      <span class="k-mono-label">Fill {{ percent(props.fillOpacity) }}%</span>
      <input
        class="slider"
        type="range"
        min="0"
        :max="percent(MAX_FILL_OPACITY)"
        step="1"
        :value="percent(props.fillOpacity)"
        @input="emit('update', { fillOpacity: Number($event.target.value) / 100 })"
      />
    </div>
  </div>
</template>

<style scoped>
.style-bar {
  position: absolute;
  top: 8px;
  left: 8px;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 7px 11px;
}

.group { display: flex; align-items: center; gap: 6px; }
.group--wide { min-width: 150px; gap: 8px; }

.swatches { display: flex; gap: 2px; }
.swatch {
  width: 13px;
  height: 13px;
  border-radius: 3px;
  border: 1px solid var(--brd);
  padding: 0;
  cursor: pointer;
}
.swatch.is-active {
  outline: 1.5px solid var(--txt);
  outline-offset: 1px;
}

/* A plain range input inherits none of the design language, so it is styled
   here rather than left as the browser default. */
.slider {
  flex: 1;
  height: 3px;
  appearance: none;
  border-radius: 2px;
  background: var(--line);
  cursor: pointer;
}
.slider::-webkit-slider-thumb {
  appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--accent);
  border: none;
  cursor: pointer;
}
</style>
