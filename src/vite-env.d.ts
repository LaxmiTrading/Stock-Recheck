/// <reference types="vite/client" />

/**
 * Build-time configuration.
 *
 * Both are optional and both default to the single-origin deployment, where the
 * UI and the API are served from the same host. They only need setting when the
 * frontend is hosted separately — GitHub Pages in front of a backend elsewhere.
 *
 * These are baked into the bundle at build time and are therefore PUBLIC. Never
 * put a secret in a `VITE_` variable: everything prefixed that way is readable
 * by anyone who opens the deployed JavaScript.
 */
interface ImportMetaEnv {
  /**
   * Absolute origin of the API, e.g. `https://stock-recheck.netlify.app`.
   * Unset (the default) keeps every request relative and same-origin.
   */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}