import { defineConfig } from '@playwright/test';

// Fake Supabase values: all Supabase traffic is stubbed in the tests.
const env = {
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-anon-key',
  NEXT_PUBLIC_APP_URL: 'http://localhost:3100',
};

export default defineConfig({
  testDir: 'e2e',
  use: {
    baseURL: 'http://localhost:3100',
    launchOptions: { executablePath: process.env.PW_CHROMIUM },
  },
  webServer: {
    command: 'npx next dev -p 3100',
    url: 'http://localhost:3100',
    env,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
