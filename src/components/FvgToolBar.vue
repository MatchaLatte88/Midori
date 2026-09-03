<script setup>
/* The gap tool's one setting, shown while the tool is armed.
 *
 * The other two bars appear when a drawing is selected, because what they edit
 * is on the chart already. This one is the opposite case: it decides what the
 * next click will pick up, so it has to be readable before the click and is
 * gone once the tool disarms. They never overlap — arming a tool clears the
 * selection — so all three can share the same corner.
 *
 * A run of stacked imbalances is one zone or several depending on how wide a
 * traded strip still counts as nothing. That is a number, not a preview, so
 * unlike the stroke bar this one has a field rather than three pictures.
 */
import { SIZE_UNITS } from '../../shared/indicators/fvg.js';

const props = defineProps({
  mergeWick: { type: Number, required: true },
  mergeUnit: { type: String, required: true },
});

const emit = defineEmits(['update']);

/* Short forms of the two units the detector accepts, so the bar cannot offer
 * one it would reject. */
const UNIT_LABELS = { percent: '%', points: 'pt' };

function setWick(value) {
  const wick = Number(value);
  // A field can be cleared or typed into halfway; neither is a threshold.
  emit('update', { mergeWick: Number.isFinite(wick) && wick > 0 ? wick : 0 });
}
</script>

<template>
  <div class="style-bar k-panel">
    <span class="k-eyebrow">Gap</span>

    <div
      class="group"
      v-hint="{
        label: 'Merge across',
        text: 'Mark a run of stacked gaps as one zone, as long as the traded strip '
          + 'between them is no wider than this and their bars run together. '
          + '0 marks every gap on its own.',
      }"
    >
      <span class="k-mono-label">Merge across</span>
      <input
        class="input"
        type="number"
        min="0"
        step="0.01"
        :value="props.mergeWick"
        @change="setWick($event.target.value)"
      />
      <div class="picks">
        <button
          v-for="unit in SIZE_UNITS"
          :key="unit"
          class="pick"
          :class="{ 'is-active': unit === props.mergeUnit }"
          @click="emit('update', { mergeUnit: unit })"
        >{{ UNIT_LABELS[unit] }}</button>
      </div>
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

.input {
  width: 62px;
  height: 24px;
  padding: 0 6px;
  border: 1px solid var(--brd);
  border-radius: var(--radius-sm);
  background: var(--glass);
  color: var(--txt);
  font: inherit;
  font-size: 12px;
  min-width: 0;
}
.input:focus-visible { border-color: var(--accent-brd); }

.picks { display: flex; gap: 3px; }
.pick {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  height: 22px;
  padding: 0 5px;
  border: 1px solid var(--brd);
  border-radius: var(--radius-sm);
  background: var(--glass);
  color: var(--sec);
  font-size: 11px;
  cursor: pointer;
}
.pick:hover { background: var(--glass-strong); color: var(--txt); }
.pick.is-active {
  border-color: var(--accent-brd);
  background: var(--accent-bg);
  color: var(--accent);
}
</style>
