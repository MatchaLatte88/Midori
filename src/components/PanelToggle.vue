<script setup>
/* The handle that folds a side panel away, and brings it back.
 *
 * A full-height strip in the gap between the panel and the chart, rather than a
 * button inside the panel: a button inside it can only ever close it, and
 * whatever opens it again then has to live somewhere else — two controls for
 * one state, in two places, one of which is only sometimes there. This is one
 * control that is always in the same spot whichever way the panel is.
 *
 * It stays quiet until the pointer is on it. It is chrome sitting beside the
 * thing being read, and a chart has enough going on without a permanent bar of
 * furniture down each side.
 */
import { computed } from 'vue';

const props = defineProps({
  /** Which side of the workspace this belongs to: 'left' | 'right'. */
  side: { type: String, required: true },
  open: { type: Boolean, required: true },
});

const emit = defineEmits(['toggle']);

/* The chevron points where the panel is about to go — inwards to fold it away,
 * outwards to bring it back. Which pixel direction that is depends on the side,
 * so the two cases fall out of one comparison rather than four branches. */
const pointsLeft = computed(() => (props.side === 'left') === props.open);

const label = computed(() => (
  `${props.open ? 'Hide' : 'Show'} the ${props.side} panel`
));
</script>

<template>
  <button
    class="handle"
    :class="{ 'is-closed': !props.open }"
    :title="label"
    :aria-label="label"
    :aria-expanded="props.open"
    @click="emit('toggle')"
  >
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
         stroke-linecap="round" stroke-linejoin="round">
      <path v-if="pointsLeft" d="M15 5l-7 7 7 7" />
      <path v-else d="M9 5l7 7-7 7" />
    </svg>
  </button>
</template>

<style scoped>
.handle {
  flex: none;
  width: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: transparent;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
/* Visible without hovering while the panel is away — otherwise the only clue
   that something folded up is a gap at the edge of the window. */
.handle.is-closed { color: var(--faint); }
.handle:hover { background: var(--glass); color: var(--txt); }
.handle:focus-visible { color: var(--txt); outline: 1px solid var(--accent-brd); }

.handle svg { width: 12px; height: 12px; }
</style>
