<script setup>
/* Confirmation for an action that cannot be undone.
 *
 * One component for every such prompt, so a destructive action always looks
 * and behaves the same way. Nothing here decides *what* is destructive — the
 * caller does that by reaching for this at all — and nothing here performs the
 * action either: it emits `confirm` and the caller does the work. A modal that
 * deleted things itself would need to know about every store in the app.
 *
 * The confirming button takes focus on open, which sounds like the wrong
 * default for a destructive prompt. It is not: Escape and the backdrop both
 * cancel, so the escape routes are the easy ones, and putting focus on the
 * action means the keyboard path is Enter rather than Tab-then-Enter. The
 * button is also styled as the dangerous one, so what is focused reads as a
 * warning rather than an invitation.
 *
 * Callers keep their own `pending` state — what is about to be deleted — and
 * clear it on either outcome. Holding that here would mean this component
 * knowing the shape of every kind of thing the app can delete.
 */
import { nextTick, ref, watch } from 'vue';

const props = defineProps({
  open: { type: Boolean, default: false },
  /** Short, specific: "Delete this run?" rather than "Are you sure?". */
  title: { type: String, required: true },
  /** What will be lost, and whether it can come back. */
  message: { type: String, default: '' },
  confirmLabel: { type: String, default: 'Delete' },
  cancelLabel: { type: String, default: 'Cancel' },
});

const emit = defineEmits(['confirm', 'cancel']);

const confirmButton = ref(null);

watch(() => props.open, async (open) => {
  if (!open) return;
  await nextTick();
  confirmButton.value?.focus();
});

/* Escape cancels. The listener lives on the dialog rather than on window
 * because the dialog holds focus while it is open, and a global one would
 * outlive a component that unmounted with the modal still showing. */
function onKey(event) {
  if (event.key === 'Escape') {
    event.stopPropagation();
    emit('cancel');
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="props.open" class="backdrop" @click.self="emit('cancel')">
      <div
        class="modal k-panel"
        role="alertdialog"
        aria-modal="true"
        :aria-label="props.title"
        tabindex="-1"
        @keydown="onKey"
      >
        <div class="k-eyebrow">Confirm</div>
        <h2 class="title">{{ props.title }}</h2>
        <p v-if="props.message" class="message">{{ props.message }}</p>

        <div class="actions">
          <button class="btn btn--default" @click="emit('cancel')">
            {{ props.cancelLabel }}
          </button>
          <button ref="confirmButton" class="btn btn--danger" @click="emit('confirm')">
            {{ props.confirmLabel }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  /* Above the error toast, which sits at 20: a prompt that opened behind
     something else would be a prompt nobody could answer. */
  z-index: 60;
  display: grid;
  place-items: center;
  padding: 40px 20px;
  background: rgba(2, 6, 16, 0.45);
}
.modal {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: min(400px, 100%);
  padding: 18px 20px 16px;
  background: linear-gradient(160deg, var(--tile-bg), var(--tile-bg));
}

.title {
  margin: 2px 0 0;
  font-family: 'Plus Jakarta Sans', Inter, sans-serif;
  font-weight: 700;
  font-size: 15px;
  letter-spacing: -0.01em;
}
.message {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--sec);
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 12px;
}

/* The button itself is the project's existing .btn--danger from base.css —
   defined there, unused until now, and the established look for a destructive
   action. Only the focus ring is added, because this button takes focus on
   open and the default outline is invisible against the red. */
.btn--danger:focus-visible {
  outline: 2px solid var(--neg);
  outline-offset: 2px;
}
</style>
