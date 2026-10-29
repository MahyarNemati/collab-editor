import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.COLLAB_E2E_PORT ?? 4173);

/**
 * The e2e suite runs against the production build served by the real server —
 * one process serving both the static client and the WebSocket endpoint, which
 * is how the container runs it. Testing the Vite dev server instead would test
 * a proxy that does not exist in production.
 */
export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run build && npm run start',
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      COLLAB_HOST: '127.0.0.1',
      COLLAB_PORT: String(PORT),
      COLLAB_DATA_DIR: '.e2e-data',
      COLLAB_ALLOW_TOKEN_ENDPOINT: '1',
      COLLAB_PRESENCE_TIMEOUT_MS: '30000',
      COLLAB_LOG_LEVEL: 'warn',
    },
  },
});
