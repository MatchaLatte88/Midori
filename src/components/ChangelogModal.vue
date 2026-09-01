<script setup>
/* Release notes, read from src/data/changelog.json.
 *
 * Entries are never written in this component — the JSON file is the only place
 * they live, so shipping a release means editing one file rather than hunting
 * for hardcoded text in a modal.
 *
 * The "latest" marker goes on whichever entry matches APP_VERSION. If the
 * changelog and the version disagree, no entry is marked rather than the wrong
 * one — and `npm run check:version` fails, which is where that gets caught.
 */
import { computed } from 'vue';
import { APP_VERSION } from '../generated/version.js';
import changelog from '../data/changelog.json';

defineProps({ open: { type: Boolean, default: false } });
const emit = defineEmits(['close']);

const releases = computed(() => changelog.releases ?? []);

const TYPE_LABELS = {
  feat: 'New',
  fix: 'Fixed',
  perf: 'Faster',
  style: 'Polish',
  break: 'Changed',
};

function isLatest(release) {
  return release.version === `v${APP_VERSION}`;
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="backdrop" @click.self="emit('close')">
      <div class="modal k-panel" role="dialog" aria-label="Release notes">
        <header class="head">
          <div>
            <div class="k-eyebrow">Release notes</div>
            <div class="title">Midori {{ APP_VERSION }}</div>
          </div>
          <button class="icon-btn" title="Close" @click="emit('close')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>

        <div class="scroll">
          <section v-for="release in releases" :key="release.version" class="release">
            <div class="release-head">
              <span class="version">{{ release.version }}</span>
              <span v-if="isLatest(release)" class="k-chip latest">Latest</span>
              <span class="k-mono-meta">{{ release.date }}</span>
            </div>
            <ul class="changes">
              <li v-for="(change, i) in release.changes" :key="i" class="change">
                <span :class="['badge', `badge--${change.type}`]">
                  {{ TYPE_LABELS[change.type] ?? change.type }}
                </span>
                <span class="change-text">{{ change.text }}</span>
              </li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: grid;
  place-items: center;
  padding: 40px 20px;
  background: rgba(2, 6, 16, 0.45);
}
.modal {
  display: flex;
  flex-direction: column;
  width: min(620px, 100%);
  max-height: 100%;
  padding: 18px 20px 4px;
  background: linear-gradient(160deg, var(--tile-bg), var(--tile-bg));
}

.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--line);
}
.title {
  font-family: 'Plus Jakarta Sans', Inter, sans-serif;
  font-weight: 700;
  font-size: 16px;
  margin-top: 3px;
}

.scroll {
  /* A flex item's min-height is its content by default, so without this the
     list pushes the modal past its own max-height and the overflow below never
     comes into play — the notes simply run off the bottom of the screen. */
  min-height: 0;
  overflow-y: auto;
  /* The page behind a modal should not scroll when its list reaches the end. */
  overscroll-behavior: contain;
  padding: 14px 0 16px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.release-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.version {
  font-family: 'DM Mono', ui-monospace, monospace;
  font-size: 12px;
  font-weight: 500;
}
.latest {
  color: var(--accent);
  border-color: var(--accent-brd);
  background: var(--accent-bg);
}

.changes { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 7px; }
.change { display: flex; gap: 9px; align-items: baseline; }
.change-text { flex: 1; font-size: 12.5px; line-height: 1.55; color: var(--txt); }

/* One badge per change type, so a fix and a breaking change are told apart at
   a glance rather than by reading. */
.badge {
  flex-shrink: 0;
  width: 54px;
  padding: 2px 0;
  border-radius: 4px;
  border: 1px solid var(--brd);
  font-family: 'DM Mono', ui-monospace, monospace;
  font-size: 9px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  text-align: center;
  color: var(--sec);
}
.badge--feat { color: var(--accent); border-color: var(--accent-brd); background: var(--accent-bg); }
.badge--fix { color: var(--ember); border-color: rgba(212, 83, 29, 0.28); }
.badge--break { color: var(--neg); border-color: rgba(220, 38, 38, 0.3); }
</style>
