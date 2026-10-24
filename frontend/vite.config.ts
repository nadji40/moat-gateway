import { resolve } from 'node:path'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'MOAT_')
  const target = env.MOAT_BACKEND_ORIGIN || 'http://127.0.0.1:8787'
  // Keep legacy documents and their requests on this origin, preserving the
  // shared navigation's localStorage auth state. No legacy page is rebuilt.
  // changeOrigin rewrites the Host header to the target's, which a remote
  // MOAT_BACKEND_ORIGIN behind Cloudflare needs; a local gateway does not care.
  const proxy = {
    '^/(v1|mcp)(/|$)': { target, changeOrigin: true },
    '^/status\\.html(\\?|$)': { target, changeOrigin: true },
    '^/((app|footer)\\.(css|js)|trail\\.js)(\\?|$)': { target, changeOrigin: true },
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
          dashboard: resolve(process.cwd(), 'dashboard/index.html'),
          status: resolve(process.cwd(), 'status/index.html'),
          tests: resolve(process.cwd(), 'tests/index.html'),
        },
      },
    },
    server: { host: '127.0.0.1', port: 5174, strictPort: true, proxy },
    preview: { host: '127.0.0.1', port: 4174, strictPort: true, proxy },
    resolve: { alias: { '@': resolve(import.meta.dirname, './src') } },
  }
})
