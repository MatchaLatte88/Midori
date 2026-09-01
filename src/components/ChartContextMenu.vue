<script setup>
/* A small menu at the pointer, for acting on whatever was right-clicked.
 *
 * Deliberately knows nothing about trading: it takes a list of rows and says
 * which one was picked. What the rows mean is the caller's business, so the
 * same menu can grow a second use without becoming a switch statement.
 *
 * Positioned in viewport coordinates and rendered at the top level of the app,
 * for the same reason the hint tooltip is: the chart pane clips its own
 * children, and a menu opened near the bottom edge is exactly the one that has
 * to reach outside it.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

const props = defineProps({
  open: { type: Boolean, default: false },
  /** Viewport coordinates of the click. */
  x: { type: Number, default: 0 },
  y: { type: Number, default: 0 },
  /** Optional heading, naming what was clicked. */
  title: { type: String, default: '' },
  /** [{ id, label, detail?, disabled? }] */
  items: { type: Array, default: () => [] },
});

const emit = defineEmits(['select', 'close']);

const el = ref(null);
/* Measured after it opens, so a menu near an edge can be flipped rather than
 * clipped. Zero until then, which places it at the pointer — the right answer
 * everywhere except the last few pixels of the window. */
const size = ref({ width: 0, height: 0 });

const MARGIN = 8;

const style = computed(() => {
  const { width, height } = size.value;
  const flipX = props.x + width + MARGIN > window.innerWidth;
  const flipY = props.y + height + MARGIN > window.innerHeight;
  return {
    left: `${flipX ? Math.max(MARGIN, props.x - width) : props.x}px`,
    top: `${flipY ? Math.max(MARGIN, props.y - height) : props.y}px`,
  };
});

watch(() => props.open, async (open) => {
  if (!open) return;
  size.value = { width: 0, height: 0 };
  // One frame later the element exists and has been laid out.
  requestAnimationFrame(() => {
    const rect = el.value?.getBoundingClientRect();
    if (rect) size.value = { width: rect.width, height: rect.height };
  });
});

function onDocumentDown(event) {
  if (!props.open) return;
  if (el.value?.contains(event.target)) return;
  emit('close');
}

function onKeyDown(event) {
  if (props.open && event.key === 'Escape') emit('close');
}

/* Capture, so a click that opens something else underneath still closes this
 * first — and pointerdown rather than click, because the menu should be gone
 * before whatever was clicked reacts. */
onMounted(() => {
  document.addEventListener('pointerdown', onDocumentDown, true);
  window.addEventListener('keydown', onKeyDown);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentDown, true);
  window.removeEventListener('keydown', onKeyDown);
});

function pick(item) {
  if (item.disabled) return;
  emit('select', item.id);
  emit('close');
}
</script>

<template>
  <div v-if="open" ref="el" class="menu k-panel" :style="style" role="menu">
    <span v-if="title" class="menu-title k-mono-label">{{ title }}</span>
    <button
      v-for="item in items"
      :key="item.id"
      class="row"
      :class="{ 'is-disabled': item.disabled }"
      role="menuitem"
      @click="pick(item)"
    >
      <span class="label">{{ item.label }}</span>
      <span v-if="item.detail" class="detail k-mono-label">{{ item.detail }}</span>
    </button>
  </div>
</template>

<style scoped>
.menu {
  position: fixed;
  z-index: 30;
  min-width: 208px;
  max-width: 320px;
  padding: 5px;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.menu-title {
  padding: 3px 7px 5px;
  color: var(--faint);
  border-bottom: 1px solid var(--line);
  margin-bottom: 3px;
}

.row {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 5px 7px;
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  text-align: left;
  cursor: pointer;
}
.row:hover:not(.is-disabled) { background: var(--glass); }
.row.is-disabled { cursor: default; }

.label {
  font-family: 'Plus Jakarta Sans', Inter, sans-serif;
  font-weight: 600;
  font-size: 12px;
  color: var(--txt);
}
.is-disabled .label { color: var(--faint); }
.detail { color: var(--sec); line-height: 1.4; }
.is-disabled .detail { color: var(--neg); }
</style>
