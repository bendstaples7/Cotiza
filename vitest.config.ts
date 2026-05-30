import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    include: [
      'tests/**/*.test.ts',
      'tests/**/*.property.test.ts',
      'tests/**/*.test.tsx',
    ],
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
  },
});
