import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  /*
   * Public path the built assets are served under.
   *
   * Netlify serves the app from the domain root, so '/' is the default and
   * nothing needs setting for that deployment. GitHub Pages project sites live
   * under a repository sub-path (`/Stock-Recheck/`), and every asset URL in the
   * bundle is absolute — with the wrong base the page loads and then 404s on
   * its own JavaScript, which presents as a blank screen with no error.
   *
   * Set through the environment rather than hard-coded so ONE codebase builds
   * correctly for both hosts; the Pages workflow passes BASE_PATH explicitly.
   * The trailing slash is enforced because Vite joins this to asset names by
   * concatenation, so '/Stock-Recheck' would emit '/Stock-Recheckassets/...'.
   */
  base: (process.env.BASE_PATH ?? '/').replace(/\/*$/, '/'),
  plugins: [react(), tailwindcss()],
  css: {
    /*
     * An INLINE PostCSS config, deliberately empty.
     *
     * Without this, Vite searches parent directories for a `postcss.config.*`
     * and will happily adopt an unrelated one from the developer's home
     * directory — which, if it is a Tailwind v3 config, tries to process this
     * project's Tailwind v4 stylesheet and fails with a confusing
     * "`@layer base` is used but no matching `@tailwind base` directive"
     * error. Tailwind here is handled by @tailwindcss/vite, not PostCSS, so
     * an empty object is correct as well as protective.
     */
    postcss: {},
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    /*
     * Only proxy /api when Vite is run STANDALONE (`npm run dev:vite`).
     *
     * Under `netlify dev` the topology is reversed: Netlify owns :8888, matches
     * function routes, and forwards everything else to Vite on :5173. Enabling
     * the proxy there closes a loop — an /api path that matches no function
     * falls through to Vite, which proxies it straight back to :8888, which
     * again finds no function... The request never returns and the retries
     * exhaust ephemeral ports (`AggregateError [EADDRINUSE]`). A plain 404 is
     * turned into a hang, which is far harder to diagnose.
     *
     * `netlify dev` sets NETLIFY_DEV=true in the framework process it spawns.
     */
    proxy: process.env.NETLIFY_DEV
      ? undefined
      : {
          '/api': {
            target: process.env.FUNCTIONS_ORIGIN ?? 'http://localhost:8888',
            changeOrigin: false,
          },
        },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          query: ['@tanstack/react-query'],
          excel: ['exceljs'],
        },
      },
    },
  },
});
