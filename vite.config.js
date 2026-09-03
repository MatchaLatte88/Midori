import { createHash } from 'node:crypto';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

/* The packaged app has no server and therefore no CSP header — file:// requests
 * never reach webRequest.onHeadersReceived — so the policy has to travel inside
 * the document. Dev is deliberately left without one: Vite's HMR client needs
 * allowances that must not end up in a release, and Electron's console warning
 * about the missing policy only appears while unpackaged.
 *
 * index.html carries an inline script (the theme, set before first paint). It is
 * allowed by its hash, computed from the built HTML, so editing that script can
 * never silently invalidate the policy. */
function contentSecurityPolicy() {
  const INLINE_SCRIPT = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g;

  return {
    name: 'midori-csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        const hashes = [...html.matchAll(INLINE_SCRIPT)]
          .map((m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`);

        const policy = [
          "default-src 'none'",
          `script-src 'self' ${hashes.join(' ')}`.trim(),
          // Vue writes static style attributes, and lightweight-charts styles the
          // canvases it creates; neither is a script vector.
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data:",
          "font-src 'self'",
          // The renderer talks to the main process over IPC only. Nothing fetches.
          "connect-src 'none'",
          "object-src 'none'",
          "base-uri 'none'",
          "form-action 'none'",
          "frame-src 'none'",
        ].join('; ');

        return {
          html,
          tags: [{
            tag: 'meta',
            attrs: { 'http-equiv': 'Content-Security-Policy', content: policy },
            injectTo: 'head-prepend',
          }],
        };
      },
    },
  };
}

export default defineConfig({
  plugins: [vue(), contentSecurityPolicy()],
  base: './',
  server: { port: 5300, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true },
});
