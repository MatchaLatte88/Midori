/* Every name a template uses has to exist in its component.
 *
 * This is not a style check. A `<script setup>` binding that a template
 * references but the script never declares compiles cleanly, builds cleanly,
 * and then throws at render time — `_ctx.swatchFor is not a function` — taking
 * the whole panel with it. Nothing else in the suite looks at templates, and
 * `vite build` does not either.
 *
 * Vue resolves a name it cannot find in the setup scope to `_ctx.<name>`, so
 * that prefix in the compiled render function is the bug, spelled out.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { compileScript, compileTemplate, parse } from 'vue/compiler-sfc';

const COMPONENTS = path.join(import.meta.dirname, '..', 'src', 'components');

/** Runtime helpers a template may legitimately reach for on the context. */
const ALLOWED = new Set(['$event', '$slots', '$props', '$attrs', '$emit']);

function sfcFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sfcFiles(full);
    return entry.name.endsWith('.vue') ? [full] : [];
  });
}

test('no template reads a name its script never defines', () => {
  const files = sfcFiles(COMPONENTS);
  assert.ok(files.length > 0, 'expected to find components to check');

  for (const file of files) {
    const name = path.basename(file);
    const { descriptor } = parse(readFileSync(file, 'utf8'), { filename: file });
    if (!descriptor.template) continue;

    const script = compileScript(descriptor, { id: file });
    const { code } = compileTemplate({
      filename: file,
      id: file,
      source: descriptor.template.content,
      compilerOptions: { bindingMetadata: script.bindings, prefixIdentifiers: true },
    });

    const unresolved = [...new Set(
      [...code.matchAll(/_ctx\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
    )].filter((n) => !ALLOWED.has(n));

    assert.deepEqual(unresolved, [], `${name} uses undefined: ${unresolved.join(', ')}`);
  }
});

test('every custom directive a template uses is registered', () => {
  /* Same failure shape as an undefined binding: Vue compiles `v-hint` to a
   * _resolveDirective call, the build stays green, and the app only complains
   * at render time. Directives are registered in main.js, so that is the list
   * to check against. */
  const main = readFileSync(path.join(import.meta.dirname, '..', 'src', 'main.js'), 'utf8');
  const registered = new Set(
    [...main.matchAll(/\.directive\(\s*['"]([\w-]+)['"]/g)].map((m) => m[1]),
  );

  for (const file of sfcFiles(COMPONENTS)) {
    const { descriptor } = parse(readFileSync(file, 'utf8'), { filename: file });
    if (!descriptor.template) continue;

    const { code } = compileTemplate({
      filename: file,
      id: file,
      source: descriptor.template.content,
      compilerOptions: { prefixIdentifiers: true },
    });

    for (const [, name] of code.matchAll(/_resolveDirective\(\s*["']([\w-]+)["']/g)) {
      assert.ok(
        registered.has(name),
        `${path.basename(file)} uses v-${name}, which main.js never registers`,
      );
    }
  }
});
