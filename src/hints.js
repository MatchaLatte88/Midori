/* Hover hints — one tooltip element for the whole app, driven by a directive.
 *
 * Why not `title`
 * ---------------
 * The native tooltip cannot be styled at all, waits about half a second before
 * it appears, and renders in the OS chrome rather than in the app. In a panel
 * where every control needs an explanation, that reads as an afterthought.
 *
 * Why one element rather than one per field
 * -----------------------------------------
 * The side panel scrolls (`overflow-y: auto`), so a tooltip positioned inside
 * it would be clipped at the panel edge — which is exactly where it needs to
 * go, since the panel sits against the window edge. The single element lives at
 * the top of the app and is positioned in viewport coordinates, so it can sit
 * anywhere regardless of what scrolls underneath it.
 *
 * Usage: `v-hint="'some explanation'"` on any element. An empty or missing
 * string binds nothing, so a schema entry without a hint simply has no tooltip
 * rather than an empty box.
 */
import { reactive } from 'vue';

/** Milliseconds of hover before the hint appears. */
const OPEN_DELAY = 380;
/** Gap between the anchor and the tooltip. */
const OFFSET = 10;

export const hint = reactive({
  text: '',
  label: '',
  visible: false,
  /** Viewport coordinates of the anchor, read when the hint opens. */
  anchor: { top: 0, bottom: 0, left: 0, right: 0 },
});

let timer = null;

function show(el, payload) {
  const rect = el.getBoundingClientRect();
  hint.text = payload.text;
  hint.label = payload.label;
  hint.anchor = {
    top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right,
  };
  hint.visible = true;
}

function hide() {
  clearTimeout(timer);
  hint.visible = false;
}

/**
 * Reads the binding into { text, label }.
 *
 * A plain string is the whole hint. An object may name the control as well, so
 * the tooltip can carry a heading when it opens far from the field it explains.
 */
function parse(value) {
  if (!value) return null;
  if (typeof value === 'string') return { text: value, label: '' };
  if (!value.text) return null;
  return { text: value.text, label: value.label ?? '' };
}

export const vHint = {
  mounted(el, binding) {
    el._hint = parse(binding.value);

    el._hintEnter = () => {
      if (!el._hint) return;
      clearTimeout(timer);
      timer = setTimeout(() => show(el, el._hint), OPEN_DELAY);
    };
    // Keyboard users get the same explanation, without the delay.
    el._hintFocus = () => {
      if (!el._hint) return;
      clearTimeout(timer);
      show(el, el._hint);
    };

    el.addEventListener('mouseenter', el._hintEnter);
    el.addEventListener('mouseleave', hide);
    el.addEventListener('focusin', el._hintFocus);
    el.addEventListener('focusout', hide);
    /* A tooltip that survives the click it was covering is noise: the user has
     * already decided what the control does. */
    el.addEventListener('pointerdown', hide);
  },

  updated(el, binding) {
    el._hint = parse(binding.value);
  },

  beforeUnmount(el) {
    el.removeEventListener('mouseenter', el._hintEnter);
    el.removeEventListener('mouseleave', hide);
    el.removeEventListener('focusin', el._hintFocus);
    el.removeEventListener('focusout', hide);
    el.removeEventListener('pointerdown', hide);
    // An element can be removed while its own hint is up — a parameter list
    // rebuilding under the pointer does exactly that.
    hide();
  },
};

export { OFFSET as HINT_OFFSET };
