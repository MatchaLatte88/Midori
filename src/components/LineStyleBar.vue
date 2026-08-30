<script setup>
/* Stroke styling for a selected line drawing.
 *
 * Floats over the chart for the same reason PositionStyleBar does: the thing
 * being edited is right there, and a width or a dash is far easier to judge
 * next to the line it changes than across the window from it. The two bars sit
 * in the same place and never appear together — a drawing is either a position
 * block or it is not.
 *
 * Each control previews what it does rather than naming it. A row of numbers
 * would need reading; three lines of different thickness do not.
 */
import { DRAWING_COLORS, LINE_STYLES, LINE_WIDTHS } from './chart/drawings/model.js';

const props = defineProps({
  color: { type: String, required: true },
  width: { type: Number, required: true },
  lineStyle: { type: String, required: true },
});

const emit = defineEmits(['update']);
</script>

<template>
  <div class="style-bar k-panel">
    <span class="k-eyebrow">Line</span>

    <div class="group">
      <span class="k-mono-label">Colour</span>
      <div class="swatches">
        <button
          v-for="c in DRAWING_COLORS"
          :key="c.id"
          class="swatch"
          :class="{ 'is-active': c.id === props.color }"
          :style="{ background: `var(--${c.id})` }"
          :title="c.label"
          @click="emit('update', { color: c.id })"
        ></button>
      </div>
    </div>

    <div class="group">
      <span class="k-mono-label">Width</span>
      <div class="picks">
        <button
          v-for="w in LINE_WIDTHS"
          :key="w"
          class="pick"
          :class="{ 'is-active': w === props.width }"
          :title="`${w}px`"
          @click="emit('update', { width: w })"
        >
          <!-- The preview is the setting: a rule of exactly that thickness. -->
          <span class="rule" :style="{ borderTopWidth: `${w}px` }"></span>
        </button>
      </div>
    </div>

    <div class="group">
      <span class="k-mono-label">Style</span>
      <div class="picks">
        <button
          v-for="s in LINE_STYLES"
          :key="s.id"
          class="pick"
          :class="{ 'is-active': s.id === props.lineStyle }"
          :title="s.label"
          @click="emit('update', { lineStyle: s.id })"
        >
          <span class="rule" :style="{ borderTopStyle: s.id }"></span>
        </button>
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

.picks { display: flex; gap: 3px; }
.pick {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 18px;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: transparent;
  cursor: pointer;
}
.pick:hover { border-color: var(--brd); }
.pick.is-active {
  border-color: var(--accent-brd);
  background: var(--accent-bg);
}

/* The preview rule. Width and style are set inline per button; everything the
   two previews share lives here so they line up at the same length. */
.rule {
  display: block;
  width: 16px;
  border-top: 1px solid var(--txt);
}
</style>
