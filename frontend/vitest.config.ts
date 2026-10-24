
import { defineConfig } from 'vitest/config'
import { fileURLToPath, URL } from 'node:url'

// Vitest owns its Vite version; application plugin/config never runs in jsdom.
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },

  test: {
    environment: 'jsdom',
    setupFiles: ['./src/tests/setup.ts'],
    include: ['src/tests/**/*.test.{ts,tsx}'],
    restoreMocks: true,
    unstubGlobals: true,
  },
})
