<script setup>
/* The tool rail.
 *
 * Eighty-seven tools do not fit in a column of buttons, so the rail shows one
 * button per family and the family opens beside it. The button is not a folder
 * icon: it shows the tool most recently used from that family and arming it is
 * one click, which is what makes a rail of ten buttons as fast as a rail of ten
 * tools for the way anyone actually works — a handful of tools, over and over,
 * with the rest a click further away.
 *
 * The little corner mark is the only affordance saying there is more inside.
 * Clicking it, or holding the button, opens the family.
 */
import { computed, ref } from 'vue';
import { DRAWING_COLORS } from './chart/drawings/model.js';
import { CURSOR, TOOL_GROUPS } from './chart/drawings/registry.js';
import { MAGNET_MODES } from './chart/drawings/useDrawings.js';
import MenuPopover from './MenuPopover.vue';
import ToolIcon from './ToolIcon.vue';

const props = defineProps({
  activeTool: { type: String, required: true },
  activeColor: { type: String, required: true },
  hasSelection: { type: Boolean, default: false },
  count: { type: Number, default: 0 },
  magnet: { type: String, default: 'off' },
  stayArmed: { type: Boolean, default: false },
  allHidden: { type: Boolean, default: false },
  allLocked: { type: Boolean, default: false },
  canUndo: { type: Boolean, default: false },
  canRedo: { type: Boolean, default: false },
});

const emit = defineEmits([
  'select-tool', 'select-color', 'delete', 'clear',
  'cycle-magnet', 'toggle-stay', 'toggle-all-hidden', 'toggle-all-locked',
  'undo', 'redo',
]);

/* Which tool each family currently offers on the rail. Seeded with the first of
 * each family and updated whenever one is picked, so the rail learns the
 * handful of tools this chart is actually drawn with. Kept in the component
 * because it is a property of the toolbar, not of the drawings: it does not
 * belong in a file on disk and nothing else needs to read it. */
const chosen = ref(Object.fromEntries(TOOL_GROUPS.map((g) => [g.id, g.tools[0].id])));

const openGroup = ref(null);
const buttons = ref({});

const groups = computed(() => TOOL_GROUPS.map((group) => {
  const current = group.tools.find((t) => t.id === chosen.value[group.id]) ?? group.tools[0];
  return {
    ...group,
    current,
    // The whole family lights up when any of its tools is armed, so it is
    // always clear which button the armed tool came from.
    active: group.tools.some((t) => t.id === props.activeTool),
  };
}));

function pick(group, tool) {
  chosen.value = { ...chosen.value, [group.id]: tool.id };
  openGroup.value = null;
  emit('select-tool', tool.id);
}

function toggleGroup(group) {
  openGroup.value = openGroup.value === group.id ? null : group.id;
}

/* Holding the button opens the family too. A right-click would be the other
 * obvious gesture, but the chart's own context menu already owns that.
 *
 * A press that turns into a hold still ends in a click, so the hold has to
 * swallow it — otherwise opening the family also arms whatever the button was
 * showing, and the menu appears over a chart that has already changed mode. */
let holdTimer = null;
let heldOpen = false;

function onHoldStart(group) {
  heldOpen = false;
  holdTimer = setTimeout(() => {
    holdTimer = null;
    heldOpen = true;
    openGroup.value = group.id;
  }, 380);
}

function onHoldEnd() {
  if (holdTimer) clearTimeout(holdTimer);
  holdTimer = null;
}

/** A press on the face of a group button arms whatever it is showing. */
function armCurrent(group) {
  if (heldOpen) {
    heldOpen = false;
    return;
  }
  emit('select-tool', group.current.id);
}

const magnetLabel = computed(() => ({
  off: 'Magnet off — levels go where the pointer is',
  weak: 'Weak magnet — snaps to a nearby open, high, low or close',
  strong: 'Strong magnet — always snaps to the nearest OHLC',
}[props.magnet] ?? 'Magnet'));

/** The next mode, so the tooltip can say what the click will do. */
const nextMagnet = computed(() => (
  MAGNET_MODES[(MAGNET_MODES.indexOf(props.magnet) + 1) % MAGNET_MODES.length]
));
</script>

<template>
  <div class="toolbar">
    <button
      class="tool"
      :class="{ 'is-active': props.activeTool === CURSOR.id }"
      :title="`${CURSOR.name} — ${CURSOR.hint}`"
      @click="emit('select-tool', CURSOR.id)"
    >
      <ToolIcon :icon="CURSOR.icon" />
    </button>

    <div class="sep"></div>

    <div v-for="group in groups" :key="group.id" class="group-slot">
      <button
        :ref="(el) => { buttons[group.id] = el; }"
        class="tool has-more"
        :class="{ 'is-active': group.active }"
        :title="`${group.current.name} — ${group.current.hint}`"
        @click="armCurrent(group)"
        @pointerdown="onHoldStart(group)"
        @pointerup="onHoldEnd"
        @pointerleave="onHoldEnd"
      >
        <ToolIcon :icon="group.current.icon" />
      </button>
      <!-- The corner mark is its own hit target: the face of the button arms
           the tool, this opens the family. -->
      <button
        class="more"
        :title="`${group.label} — ${group.tools.length} tools`"
        :aria-label="`${group.label}, ${group.tools.length} tools`"
        @click.stop="toggleGroup(group)"
      >
        <svg viewBox="0 0 6 6" aria-hidden="true"><path d="M6 0v6H0z" fill="currentColor" /></svg>
      </button>

      <MenuPopover
        :open="openGroup === group.id"
        :anchor="buttons[group.id]"
        placement="right"
        :width="230"
        :label="group.label"
        @close="openGroup = null"
      >
        <span class="k-eyebrow menu-head">{{ group.label }}</span>
        <button
          v-for="tool in group.tools"
          :key="tool.id"
          class="menu-row"
          :class="{ 'is-active': tool.id === props.activeTool }"
          :title="tool.hint"
          @click="pick(group, tool)"
        >
          <ToolIcon :icon="tool.icon" :size="16" />
          <span class="menu-name">{{ tool.name }}</span>
        </button>
      </MenuPopover>
    </div>

    <div class="sep"></div>

    <!-- Placement aids. They change how the next click lands rather than what
         it draws, so they sit apart from the tools. -->
    <button
      class="tool"
      :class="{ 'is-active': props.magnet !== 'off', 'is-strong': props.magnet === 'strong' }"
      :title="`${magnetLabel} — click for ${nextMagnet}`"
      @click="emit('cycle-magnet')"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M6 4v8a6 6 0 0 0 12 0V4" />
        <path d="M6 9h4M14 9h4" />
        <path d="M6 4h4M14 4h4" />
      </svg>
    </button>

    <button
      class="tool"
      :class="{ 'is-active': props.stayArmed }"
      :title="props.stayArmed
        ? 'Staying in drawing mode — the tool re-arms after each shape'
        : 'One shape per arming. Click to stay in drawing mode'"
      @click="emit('toggle-stay')"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M5 3l5 13 2-5 5-2z" />
        <path d="M16 14l4 4M14 16l4 4" />
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
      :disabled="props.count === 0"
      :class="{ 'is-active': props.allHidden }"
      :title="props.allHidden ? 'Bring every drawing back' : 'Take every drawing off the chart'"
      @click="emit('toggle-all-hidden')"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <template v-if="props.allHidden">
          <path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z" />
          <circle cx="12" cy="12" r="2.5" />
          <path d="M4 4l16 16" />
        </template>
        <template v-else>
          <path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z" />
          <circle cx="12" cy="12" r="2.5" />
        </template>
      </svg>
    </button>

    <button
      class="tool"
      :disabled="props.count === 0"
      :class="{ 'is-active': props.allLocked }"
      :title="props.allLocked
        ? 'Release every drawing'
        : 'Lock every drawing — they stay on the chart but the pointer goes through them'"
      @click="emit('toggle-all-locked')"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <rect x="5" y="11" width="14" height="9" rx="1.5" />
        <path v-if="props.allLocked" d="M8 11V7a4 4 0 0 1 8 0v4" />
        <path v-else d="M8 11V7a4 4 0 0 1 7.5-2" />
      </svg>
    </button>

    <div class="sep"></div>

    <button
      class="tool"
      :disabled="!props.canUndo"
      title="Undo (Ctrl+Z)"
      @click="emit('undo')"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M4 9h11a5 5 0 0 1 0 10h-6" />
        <path d="M8 5L4 9l4 4" />
      </svg>
    </button>

    <button
      class="tool"
      :disabled="!props.canRedo"
      title="Redo (Ctrl+Shift+Z)"
      @click="emit('redo')"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M20 9H9a5 5 0 0 0 0 10h6" />
        <path d="M16 5l4 4-4 4" />
      </svg>
    </button>

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
/* A rail, not a card: it is the left edge of the chart, so it runs the full
   height of it, sits on the same ground, and is separated by the one hairline
   that faces the work. A floating toolbar would have put a gutter between the
   tools and the thing they draw on. */
.toolbar {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 9px 0;
  width: var(--rail-width);
  flex-shrink: 0;
  background: var(--rail-bg);
  border-right: 1px solid var(--line);
  overflow-y: auto;
  overflow-x: visible;
}

.tool {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border: none;
  border-radius: var(--radius-md);
  background: none;
  color: var(--sec);
  cursor: pointer;
  transition: color 0.12s, background 0.12s;
}
.tool:hover:not(:disabled) { color: var(--txt); background: var(--hover); }
.tool:disabled { opacity: 0.28; cursor: default; }
/* Armed. Grey rather than accent, like every other "this one is on" in the
   app — the accent belongs to price. */
.tool.is-active { color: var(--txt); background: var(--sel-bg); }
/* Except the magnet at full strength, which is the one setting that silently
   changes where a click lands. That earns the accent. */
.tool.is-strong { color: var(--accent); }

.group-slot { position: relative; }

/* The corner mark sits inside the button's own square, so the rail stays one
   column wide. It only takes the four pixels it draws on. */
.more {
  position: absolute;
  right: 2px;
  bottom: 2px;
  width: 10px;
  height: 10px;
  padding: 0;
  border: none;
  background: none;
  color: var(--sec);
  opacity: 0.5;
  cursor: pointer;
  display: grid;
  place-items: center;
}
.more svg { width: 5px; height: 5px; }
.group-slot:hover .more { opacity: 1; color: var(--txt); }

.menu-head {
  padding: 4px 8px 6px;
}
.menu-row {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--txt);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.menu-row:hover { background: var(--hover); }
.menu-row.is-active { background: var(--sel-bg); }
.menu-row svg { color: var(--sec); flex-shrink: 0; }
.menu-row:hover svg, .menu-row.is-active svg { color: var(--txt); }
.menu-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.sep {
  width: 20px;
  height: 1px;
  background: var(--line);
  margin: 7px 0;
}

.colors {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 5px;
  padding: 3px 0;
}
.swatch {
  width: 13px;
  height: 13px;
  border-radius: 3px;
  border: 1px solid var(--line);
  cursor: pointer;
  padding: 0;
}
.swatch.is-active {
  outline: 1.5px solid var(--txt);
  outline-offset: 1.5px;
}
</style>
