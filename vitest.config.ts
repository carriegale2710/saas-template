import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname) },
  },
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: [
        'app/api/**/route.ts',
        'services/emailService.ts',
        'hooks/useTrialStatus.ts',
        'contexts/AuthContext.tsx',
        'utils/cors.ts',
        'utils/stripe-server.ts',
        'utils/supabase-server.ts',
      ],
      thresholds: {
        perFile: true,
        statements: 80,
        branches: 70,
        functions: 85,
        lines: 80,
      },
    },
  },
});
