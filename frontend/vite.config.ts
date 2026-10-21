import { resolve } from 'node:path'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'MOAT_')
  const target = env.MOAT_BACKEND_ORIGIN || 'http://127.0.0.1:8787'
  // Keep legacy documents and their requests on this origin, preserving the
  // shared navigation's localStorage auth state. No legacy page is rebuilt.
  const proxy = {
    '^/(v1|mcp)(/|$)': { target },
    '^/(dashboard|tests|status)(\\.html)?(\\?|$)': { target },
    '^/((app|footer)\\.(css|js)|playground\\.js|trail\\.js)(\\?|$)': { target },
  }

  return {
    plugins: [react(), tailwindcss()],
    appType: 'spa',
    build: {
      outDir: 'dist',
      rollupOptions: {
        input: {
          home: resolve(process.cwd(), 'index.html'),
          compare: resolve(process.cwd(), 'compare/index.html'),
          docs: resolve(process.cwd(), 'docs/index.html'),
          team: resolve(process.cwd(), 'team/index.html'),
        },
      },
    },
    server: { host: '127.0.0.1', port: 5174, strictPort: true, proxy },
    preview: { host: '127.0.0.1', port: 4174, strictPort: true, proxy },
  }
})
