import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // Integration tests share one Postgres database and truncate between
    // cases, so they must not run concurrently with each other.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      JWT_SECRET: 'test-secret-test-secret-test-secret-test-secret',
      STAFF_REGISTRATION_CODE: 'staff-code-for-tests',
      LOG_LEVEL: 'silent',
    },
  },
});
