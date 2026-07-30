/**
 * Vitest global setup.
 *
 * Provides the environment variables the server modules require so that unit
 * tests can import them without a real deployment.
 */

import { beforeAll } from 'vitest';

beforeAll(() => {
  // 48 random-looking bytes; only ever used by tests.
  process.env.AUTH_JWT_SECRET ??=
    'test-secret-do-not-use-in-production-0123456789abcdefghijklmnop';
  process.env.APP_BASE_URL ??= 'http://localhost:8888';
  process.env.NODE_ENV ??= 'test';
});
