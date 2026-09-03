<script setup>
/* One renderer for every tool icon.
 *
 * The icons are data — see tools/icons.js — so this is the loop that turns a
 * list of primitives into SVG. It exists because the alternative is eighty-six
 * branches in a template, which is what the toolbar was when there were ten
 * tools and is the reason the icons became data in the first place.
 */
import { computed } from 'vue';
import { iconFor } from './chart/drawings/tools/icons.js';

const props = defineProps({
  /** An icon id from ICONS, or the primitives themselves. */
  icon: { type: [String, Array], required: true },
  size: { type: Number, default: 18 },
});

const parts = computed(() => (
  Array.isArray(props.icon) ? props.icon : iconFor(props.icon)
));

/* A filled rectangle may name a colour token — the position icon paints its two
 * zones in the semantic pair, because that is the one thing about it worth
 * saying at 18 pixels. Everything else inherits the button's colour. */
function fillFor(token) {
  return token ? `var(--${token})` : 'currentColor';
}
</script>

<template>
  <svg
    :width="props.size"
    :height="props.size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <template v-for="(part, i) in parts" :key="i">
      <path v-if="part[0] === 'p'" :d="part[1]" />
      <path v-else-if="part[0] === 'f'" :d="part[1]" fill="currentColor" stroke="none" />
      <circle v-else-if="part[0] === 'c'" :cx="part[1]" :cy="part[2]" :r="part[3]" />
      <circle
        v-else-if="part[0] === 'fc'"
        :cx="part[1]" :cy="part[2]" :r="part[3]"
        fill="currentColor" stroke="none"
      />
      <rect
        v-else-if="part[0] === 'r'"
        :x="part[1]" :y="part[2]" :width="part[3]" :height="part[4]" rx="1"
      />
      <rect
        v-else-if="part[0] === 'fr'"
        :x="part[1]" :y="part[2]" :width="part[3]" :height="part[4]" rx="1"
        stroke="none"
        :fill="fillFor(part[6])"
        :fill-opacity="part[5]"
      />
    </template>
  </svg>
</template>
