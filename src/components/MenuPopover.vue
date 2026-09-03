<script setup>
/* The shell every dropdown in the chrome sits in.
 *
 * Three menus hang off the instrument bar — chart style, indicators, objects —
 * and each of them needs the same four things: a surface that is over the app
 * rather than in it, a click anywhere else that closes it, Escape, and a
 * position under the button that opened it. Written once, because three copies
 * of "close when the pointer lands somewhere else" is three chances for one of
 * them to be subtly different.
 *
 * Positioned against the trigger rather than nested inside it. The instrument
 * bar clips its overflow — it has to, or a long symbol name would push the
 * price off the row — so a menu absolutely positioned inside it would be cut
 * off at the bar's own height. Fixed and measured is the way out that does not
 * cost the bar its clipping.
 */
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';

const props = defineProps({
  open: { type: Boolean, default: false },
  /** The element the menu hangs under — an element, or a component with `$el`. */
  anchor: { type: [Object, null], default: null },
  /** Which edge lines up with the trigger: 'left' | 'right'. */
  align: { type: String, default: 'left' },
  /**
   * Which side of the trigger the menu opens on: 'below' | 'right'.
   *
   * The chrome menus hang under their button. The tool rail's cannot — it runs
   * the full height of the workspace at the left edge, so a menu under a button
   * halfway down it would cover the buttons below, and one under the bottom
   * button would be off the screen entirely.
   */
  placement: { type: String, default: 'below' },
  /** A fixed width in px, or 0 to shrink to the content. */
  width: { type: Number, default: 0 },
  label: { type: String, default: 'Menu' },
});

const emit = defineEmits(['close']);

const style = ref({});

function place() {
  const el = props.anchor?.$el ?? props.anchor;
  if (!el?.getBoundingClientRect) return;
  const r = el.getBoundingClientRect();

  if (props.placement === 'right') {
    /* Beside the trigger, and lifted up whenever the menu would otherwise run
     * off the bottom. The rail's groups have fourteen tools in the longest of
     * them, so this is the ordinary case near the foot of the rail rather than
     * an edge case. */
    const height = Math.min(420, Math.round(window.innerHeight - 32));
    const top = Math.min(Math.round(r.top), Math.max(16, window.innerHeight - height - 16));
    style.value = {
      top: `${top}px`,
      left: `${Math.round(r.right + 6)}px`,
      maxHeight: `${height}px`,
      ...(props.width ? { width: `${props.width}px` } : {}),
    };
    return;
  }

  const top = Math.round(r.bottom + 6);
  const next = {
    top: `${top}px`,
    /* Never past the bottom of the window. The lists here are open-ended — a
     * chart with forty drawings on it is ordinary — so the menu scrolls rather
     * than running off the screen. */
    maxHeight: `${Math.max(160, Math.round(window.innerHeight - top - 16))}px`,
  };
  if (props.align === 'right') next.right = `${Math.round(window.innerWidth - r.right)}px`;
  else next.left = `${Math.round(r.left)}px`;
  if (props.width) next.width = `${props.width}px`;
  style.value = next;
}

watch(() => props.open, async (open) => {
  if (!open) return;
  await nextTick();
  place();
});

/* The window can change under an open menu — the app is resizable and the
 * chart is the thing being resized. Cheaper to reposition than to close. */
function onResize() {
  if (props.open) place();
}
window.addEventListener('resize', onResize);
onBeforeUnmount(() => window.removeEventListener('resize', onResize));

function onKey(event) {
  if (event.key === 'Escape') emit('close');
}
</script>

<template>
  <!-- The backdrop is what makes "a click anywhere else closes it" one rule
       rather than a listener per surface underneath. -->
  <div
    v-if="props.open"
    class="backdrop"
    @pointerdown.self="emit('close')"
    @contextmenu.prevent="emit('close')"
  >
    <div
      class="menu k-pop anim-fade-up"
      :style="style"
      role="menu"
      :aria-label="props.label"
      tabindex="-1"
      @keydown="onKey"
    >
      <slot />
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
}
.menu {
  position: fixed;
  min-width: 200px;
  padding: 6px;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.menu:focus { outline: none; }
</style>
