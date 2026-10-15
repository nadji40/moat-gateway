import { defineConfig } from 'vitest/config'

// Vitest owns its Vite version; application plugin/config never runs in jsdom.
export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/tests/setup.ts'],
    include: ['src/tests/**/*.test.{ts,tsx}'],
    restoreMocks: true,
    unstubGlobals: true,
  },
})
