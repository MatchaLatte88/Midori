<script setup>
/* Styling for a selected annotation.
 *
 * The third of the three bars that float over the chart's top left corner, and
 * it never appears with either of the others: a drawing is a position block, an
 * annotation, or a line, and the registry decides which. Same shape as
 * LineStyleBar for that reason — a bar that swapped its layout when the
 * selection changed would read as a different window opening.
 */
import { DRAWING_COLORS, TEXT_SIZES } from './chart/drawings/model.js';

const props = defineProps({
  color: { type: String, required: true },
  fontSize: { type: String, required: true },
  bold: { type: Boolean, default: false },
  italic: { type: Boolean, default: false },
  boxed: { type: Boolean, default: false },
});

const emit = defineEmits(['update', 'edit']);
</script>

<template>
  <div class="style-bar k-pop">
    <span class="k-eyebrow">Text</span>

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
      <span class="k-mono-label">Size</span>
      <div class="picks">
        <button
          v-for="s in TEXT_SIZES"
          :key="s.id"
          class="pick"
          :class="{ 'is-active': s.id === props.fontSize }"
          :title="s.label"
          @click="emit('update', { fontSize: s.id })"
        >
          <!-- The preview is the setting: an A at the size it sets. -->
          <span :style="{ fontSize: `${Math.min(s.px, 14)}px`, lineHeight: 1 }">A</span>
        </button>
      </div>
    </div>

    <div class="group">
      <div class="picks">
        <button
          class="pick"
          :class="{ 'is-active': props.bold }"
          title="Bold"
          @click="emit('update', { bold: !props.bold })"
        >
          <span style="font-weight: 700">B</span>
        </button>
        <button
          class="pick"
          :class="{ 'is-active': props.italic }"
          title="Italic"
          @click="emit('update', { italic: !props.italic })"
        >
          <span style="font-style: italic">I</span>
        </button>
        <button
          class="pick"
          :class="{ 'is-active': props.boxed }"
          title="Plate behind the text"
          @click="emit('update', { boxed: !props.boxed })"
        >
          <span class="plate"></span>
        </button>
      </div>
    </div>

    <!-- Every annotation can be given words from here, including the flag,
         which is the one that does not stop to ask for them when it is placed. -->
    <button class="edit" @click="emit('edit')">Edit text</button>
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
  border: 1px solid var(--line);
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
  border: 1px solid var(--brd);
  border-radius: var(--radius-sm);
  background: var(--glass);
  color: var(--txt);
  cursor: pointer;
}
.pick:hover { background: var(--glass-strong); }
.pick.is-active {
  border-color: var(--line-strong);
  background: var(--sel-bg);
}

.plate {
  display: block;
  width: 12px;
  height: 9px;
  border: 1px solid var(--txt);
  border-radius: 2px;
  background: var(--sel-bg);
}

.edit {
  border: 1px solid var(--brd);
  border-radius: var(--radius-sm);
  background: var(--glass);
  color: var(--txt);
  font: inherit;
  padding: 3px 8px;
  cursor: pointer;
}
.edit:hover { background: var(--glass-strong); }
</style>
