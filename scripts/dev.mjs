/**
 * Local development launcher.
 *
 * Loads `.env` into the process environment and then starts `netlify dev`,
 * which passes its own environment down to the serverless functions.
 *
 * Why this exists: the Netlify CLI only injects `.env` for a project that has
 * been `netlify link`ed to a site. An unlinked local clone therefore starts the
 * functions with no DATABASE_URL or AUTH_JWT_SECRET, and every request fails
 * with DATABASE_UNAVAILABLE. Loading the file here makes `npm run dev` work on
 * a fresh clone with no Netlify account at all.
 *
 * The `--functions` flag is passed explicitly for the same reason: the CLI does
 * not reliably resolve the functions directory from netlify.toml when the
 * project is unlinked.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = join(ROOT, '.env');

if (existsSync(ENV_FILE)) {
  const result = dotenv.config({ path: ENV_FILE });
  const loaded = Object.keys(result.parsed ?? {});
  console.log(`Loaded ${loaded.length} variables from .env`);

  const missing = ['DATABASE_URL', 'AUTH_JWT_SECRET'].filter(
    (name) => (process.env[name] ?? '') === '',
  );
  if (missing.length > 0) {
    console.error(`\n  .env is missing: ${missing.join(', ')}`);
    console.error('  See the "Local development setup" section of README.md.\n');
    process.exit(1);
  }
} else {
  console.error('\n  No .env file found.');
  console.error('  Copy .env.example to .env and fill it in — see README.md.\n');
  process.exit(1);
}

const child = spawn(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['netlify', 'dev', '--functions', 'netlify/functions'],
  { cwd: ROOT, stdio: 'inherit', env: process.env, shell: process.platform === 'win32' },
);

child.on('exit', (code, signal) => {
  process.exit(signal !== null ? 1 : (code ?? 0));
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
