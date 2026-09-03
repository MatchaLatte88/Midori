<script setup>
/* The single hover-hint surface. Mounted once, near the root.
 *
 * Styled as a smaller sibling of `.k-panel`: same gradient, same 1px line, same
 * shadow, one radius step down because it is a small object. No blur — the
 * design language uses gradient surfaces rather than frosted glass, and the
 * chart underneath must not smear.
 *
 * It prefers the side with more room, which in practice puts it to the left of
 * the settings panel — the panel sits against the window edge, so there is
 * nowhere else for it to go without being clipped.
 */
import { computed } from 'vue';
import { HINT_OFFSET, hint } from '../hints.js';

/** Roughly the widest the box can get; used to decide which side fits. */
const MAX_WIDTH = 260;

const placement = computed(() => {
  const { top, bottom, left, right } = hint.anchor;
  const roomLeft = left;
  const roomRight = window.innerWidth - right;
  const style = {};

  // Vertically centred on the anchor, then kept inside the viewport so a field
  // near the bottom of a scrolled panel still shows its whole explanation.
  const centre = (top + bottom) / 2;
  style.top = `${Math.round(centre)}px`;

  if (roomLeft >= MAX_WIDTH + HINT_OFFSET || roomLeft > roomRight) {
    style.right = `${Math.round(window.innerWidth - left + HINT_OFFSET)}px`;
  } else {
    style.left = `${Math.round(right + HINT_OFFSET)}px`;
  }
  return style;
});
</script>

<template>
  <Transition name="hint">
    <div v-if="hint.visible" class="hint" :style="placement" role="tooltip">
      <span v-if="hint.label" class="k-mono-label hint-label">{{ hint.label }}</span>
      <p class="hint-text">{{ hint.text }}</p>
    </div>
  </Transition>
</template>

<style scoped>
.hint {
  position: fixed;
  z-index: 60;
  transform: translateY(-50%);
  max-width: 260px;
  padding: 9px 11px;
  border: 1px solid var(--brd);
  border-radius: var(--radius-md);
  background: var(--panel-bg);
  box-shadow: var(--panel-shadow);
  pointer-events: none;
}

/* The accent marks the thing being explained, the way the eyebrow marks a
   section — one accent, used for the same job in both places. */
.hint-label {
  display: block;
  margin-bottom: 4px;
  color: var(--accent);
}

.hint-text {
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--txt);
  text-wrap: pretty;
}

/* Short and flat, like every other transition in the app. The slight shift
   comes from the side it is on, so it reads as coming out of the panel. */
.hint-enter-active,
.hint-leave-active { transition: opacity 120ms ease, transform 120ms ease; }
.hint-enter-from,
.hint-leave-to { opacity: 0; }
.hint-enter-from { transform: translateY(-50%) translateX(4px); }
.hint-leave-to { transform: translateY(-50%); }

@media (prefers-reduced-motion: reduce) {
  .hint-enter-from { transform: translateY(-50%); }
}
</style>
