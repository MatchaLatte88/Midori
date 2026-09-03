<script setup>
/* The editor an annotation is typed into.
 *
 * A note with no words is an invisible object that still takes clicks, so the
 * annotation tools are not finished when their anchor lands — they are finished
 * when something has been typed. This opens over the anchor the moment it is
 * placed, and closes on the first thing that means "done": a click somewhere
 * else, Ctrl+Enter, or Escape to abandon it.
 *
 * A real textarea rather than a canvas caret. Everything a text field is
 * expected to do — selection, undo inside the field, IME, paste, a spellchecker
 * — comes free with it, and none of it would come free with a caret drawn on
 * the chart.
 */
import { nextTick, ref, watch } from 'vue';
import { MAX_TEXT_LENGTH, textSizePx } from './chart/drawings/model.js';

const props = defineProps({
  /** `{ id, x, y }` for the annotation being edited, or null. */
  target: { type: [Object, null], default: null },
  /** What is already there, for an annotation being edited rather than placed. */
  value: { type: String, default: '' },
  fontSize: { type: String, default: 'md' },
  bold: { type: Boolean, default: false },
  italic: { type: Boolean, default: false },
  /* Quick picks offered above the field, for the sticker tool. Empty for every
   * other annotation: a note is typed, not chosen. */
  glyphs: { type: Array, default: () => [] },
});

const emit = defineEmits(['commit', 'cancel']);

const field = ref(null);
const draft = ref('');
/* Whether this close was already dealt with. The blur handler and the keyboard
 * handlers can both fire for one dismissal — Escape blurs the field on its way
 * out — and without this the second one commits what the first threw away. */
let settled = false;

watch(() => props.target, async (target) => {
  if (!target) return;
  draft.value = props.value ?? '';
  settled = false;
  await nextTick();
  field.value?.focus();
  field.value?.select();
}, { immediate: true });

function commit() {
  if (settled) return;
  settled = true;
  emit('commit', draft.value);
}

function cancel() {
  if (settled) return;
  settled = true;
  emit('cancel');
}

/* A glyph replaces the field's contents rather than appending to it. A sticker
 * is one mark; two of them in the same drawing is not a thing anyone means, and
 * picking a second one is far more likely to be a change of mind. */
function pickGlyph(glyph) {
  draft.value = glyph;
  commit();
}

function onKeydown(event) {
  if (event.key === 'Escape') {
    event.stopPropagation();
    cancel();
    return;
  }
  // Enter inserts a line, because an annotation is often two. Ctrl+Enter is the
  // one that means "that is the note".
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    event.stopPropagation();
    commit();
  }
}
</script>

<template>
  <div
    v-if="props.target"
    class="editor k-pop"
    :style="{
      left: `${Math.round(props.target.x)}px`,
      top: `${Math.round(props.target.y)}px`,
    }"
  >
    <div v-if="props.glyphs.length" class="glyphs">
      <button
        v-for="glyph in props.glyphs"
        :key="glyph"
        class="glyph"
        type="button"
        :title="`Place ${glyph}`"
        @mousedown.prevent
        @click="pickGlyph(glyph)"
      >{{ glyph }}</button>
    </div>

    <textarea
      ref="field"
      v-model="draft"
      class="field"
      :style="{
        fontSize: `${textSizePx(props.fontSize)}px`,
        fontWeight: props.bold ? 600 : 400,
        fontStyle: props.italic ? 'italic' : 'normal',
      }"
      :maxlength="MAX_TEXT_LENGTH"
      :rows="props.glyphs.length ? 1 : 2"
      spellcheck="false"
      placeholder="Note…"
      @keydown="onKeydown"
      @blur="commit"
    ></textarea>
    <span class="k-mono-label hint">
      {{ props.glyphs.length ? 'Pick one, or type any character' : 'Ctrl+Enter to place' }}
      · Esc to discard
    </span>
  </div>
</template>

<style scoped>
/* Positioned in the chart's own coordinate space, which is why the host has to
   be the element the anchor was measured against. */
.editor {
  position: absolute;
  z-index: 12;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  /* Never off the right edge of a narrow pane, and never so wide that a short
     note opens a dialog-sized box. */
  width: min(260px, 40vw);
}

.field {
  width: 100%;
  min-height: 42px;
  resize: vertical;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--input-bg, var(--panel));
  color: var(--txt);
  padding: 5px 6px;
  font-family: "DM Mono", ui-monospace, monospace;
  line-height: 1.35;
}
.field:focus {
  outline: none;
  border-color: var(--accent);
}

.hint {
  opacity: 0.6;
  white-space: nowrap;
}

.glyphs {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 2px;
}
.glyph {
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  padding: 3px 0;
  font-size: 15px;
  line-height: 1.1;
  cursor: pointer;
}
.glyph:hover { background: var(--hover); }
</style>
