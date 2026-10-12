import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __TARGET__: JSON.stringify('chrome') },
  test: {
    environment: 'jsdom',
    include: ['tests/unit/**/*.test.ts'],
    setupFiles: ['tests/unit/setup.ts'],
    restoreMocks: true,
  },
});
