<script setup>
import { computed } from 'vue';
import { DRAWING_COLORS, TOOLS } from './chart/drawings/model.js';

const props = defineProps({
  activeTool: { type: String, required: true },
  activeColor: { type: String, required: true },
  hasSelection: { type: Boolean, default: false },
  count: { type: Number, default: 0 },
});

const emit = defineEmits(['select-tool', 'select-color', 'delete', 'clear']);

const tools = computed(() => TOOLS);
</script>

<template>
  <div class="toolbar">
    <button
      v-for="tool in tools"
      :key="tool.id"
      class="tool"
      :class="{ 'is-active': tool.id === props.activeTool }"
      :title="`${tool.name} — ${tool.hint}`"
      @click="emit('select-tool', tool.id)"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <!-- Cursor -->
        <path v-if="tool.icon === 'cursor'" d="M5 3l6 16 2.5-6.5L20 10z" />
        <!-- Trend line: a segment with its two anchors -->
        <template v-else-if="tool.icon === 'trendline'">
          <path d="M5 18L19 6" />
          <circle cx="5" cy="18" r="2" />
          <circle cx="19" cy="6" r="2" />
        </template>
        <!-- Ray: anchored once, arrow at the far end -->
        <template v-else-if="tool.icon === 'ray'">
          <path d="M4 19L19 7" />
          <circle cx="4" cy="19" r="2" />
          <path d="M14 6.5h5.5V12" />
        </template>
        <!-- Horizontal -->
        <template v-else-if="tool.icon === 'horizontal'">
          <path d="M3 12h18" />
          <circle cx="8" cy="12" r="2" />
        </template>
        <!-- Vertical -->
        <template v-else-if="tool.icon === 'vertical'">
          <path d="M12 3v18" />
          <circle cx="12" cy="8" r="2" />
        </template>
        <!-- Rectangle -->
        <rect v-else-if="tool.icon === 'rectangle'" x="4" y="6" width="16" height="12" rx="1" />

        <!-- A bracketed span with a histogram inside it. -->
        <template v-else-if="tool.icon === 'rangeprofile'">
          <path d="M4 4v16M20 4v16" />
          <path d="M7 8h7M7 12h10M7 16h4" />
        </template>
        <!-- Fib: stacked levels -->
        <template v-else-if="tool.icon === 'fib'">
          <path d="M4 6h16M4 10h16M4 14h16M4 18h16" />
        </template>
        <!-- Measure: a span with end caps -->
        <template v-else-if="tool.icon === 'measure'">
          <path d="M6 4v16M18 4v16M6 12h12" />
          <path d="M9 9l-3 3 3 3M15 9l3 3-3 3" />
        </template>
        <!-- Position: two zones either side of the entry, and arrows both ways
             because the same tool draws a long or a short -->
        <template v-else-if="tool.icon === 'position'">
          <rect x="6" y="5" width="14" height="7" rx="1" :style="{ fill: 'var(--pos)', fillOpacity: 0.28 }" />
          <rect x="6" y="12" width="14" height="7" rx="1" :style="{ fill: 'var(--neg)', fillOpacity: 0.28 }" />
          <path d="M6 12h14" />
          <path d="M3 8.5l1.5-2 1.5 2M3 15.5l1.5 2 1.5-2" />
        </template>
      </svg>
    </button>

    <div class="sep"></div>

    <div class="colors">
      <button
        v-for="c in DRAWING_COLORS"
        :key="c.id"
        class="swatch"
        :class="{ 'is-active': c.id === props.activeColor }"
        :style="{ background: `var(--${c.id})` }"
        :title="props.hasSelection ? `Recolour selection — ${c.label}` : c.label"
        @click="emit('select-color', c.id)"
      ></button>
    </div>

    <div class="sep"></div>

    <button
      class="tool"
      :disabled="!props.hasSelection"
      title="Delete selected (Del)"
      @click="emit('delete')"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
      </svg>
    </button>

    <button
      class="tool"
      :disabled="props.count === 0"
      :title="`Remove all ${props.count} drawing${props.count === 1 ? '' : 's'} on this symbol`"
      @click="emit('clear')"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M4 4l16 16M20 4L4 20" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 6px 4px;
  width: 38px;
  flex-shrink: 0;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: linear-gradient(160deg, var(--panel-a), var(--panel-b));
  box-shadow: var(--panel-shadow);
}

.tool {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--sec);
  cursor: pointer;
  transition: color 0.15s, background 0.15s, border-color 0.15s;
}
.tool:hover:not(:disabled) { color: var(--txt); background: var(--glass); }
.tool:disabled { opacity: 0.3; cursor: default; }
.tool.is-active {
  color: var(--accent);
  background: var(--accent-bg);
  border-color: var(--accent-brd);
}
.tool svg { width: 17px; height: 17px; }

.sep {
  width: 20px;
  height: 1px;
  background: var(--line);
  margin: 3px 0;
}

.colors {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 3px;
}
.swatch {
  width: 12px;
  height: 12px;
  border-radius: 3px;
  border: 1px solid var(--brd);
  cursor: pointer;
  padding: 0;
}
.swatch.is-active {
  outline: 1.5px solid var(--txt);
  outline-offset: 1px;
}
</style>
