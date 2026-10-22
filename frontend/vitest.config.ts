import { defineConfig } from 'vitest/config'

// Vitest owns its Vite version; application plugin/config never runs in jsdom.
export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/tests/setup.ts'],
    include: ['src/tests/**/*.test.{ts,tsx}'],
    restoreMocks: true,
    unstubGlobals: true,
    // The Compare page's chunk is large; under a full parallel run on a laptop
    // its tests take several seconds, which is load, not a fault.
    testTimeout: 15000,
  },
})
