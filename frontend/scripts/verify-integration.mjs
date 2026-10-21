import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createServer, preview } from 'vite'

// Exercise the real Vite configuration against an isolated protocol stub.
// This checks forwarding, not the gateway's payment-policy decisions.
const root = fileURLToPath(new URL('../', import.meta.url))
const requests = []
const upstream = createHttpServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  requests.push({ url: req.url, method: req.method, auth: req.headers.authorization, body })
  if (req.url.startsWith('/v1/')) {
    res.writeHead(503, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'integration fixture: unavailable' }))
  } else {
    res.setHeader('content-type', 'text/html')
    res.end('<title>Legacy integration fixture</title>')
  }
})
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
process.env.MOAT_BACKEND_ORIGIN = `http://127.0.0.1:${upstream.address().port}`
const results = []
let dev
let built
try {
  dev = await createServer({ root, server: { port: 0, strictPort: false } })
  await dev.listen()
  built = await preview({ root, preview: { port: 0, strictPort: false } })
  for (const [mode, server] of [['dev', dev], ['preview', built]]) {
    const base = `http://127.0.0.1:${server.httpServer.address().port}`
    const home = await (await fetch(base)).text()
    assert.match(home, /id="root"/)
    assert.ok(home.includes(mode === 'dev' ? '/src/app/main.tsx' : '/assets/'))
    assert.equal((await fetch(`${base}/unknown-page`)).status, 200)

    for (const file of ['shared/app.js', 'shared/trail.js', 'favicon.svg', 'cursor.svg']) {
      const response = await fetch(`${base}/${file}`)
      assert.equal(response.status, 200)
      assert.equal(await response.text(), await readFile(new URL(`../public/${file}`, import.meta.url), 'utf8'))
    }
    for (const route of ['/status', '/tests?run=1', '/app.css?v=cbb4282', '/app.js', '/footer.css', '/footer.js']) {
      const response = await fetch(base + route)
      assert.equal(response.status, 200)
      assert.match(await response.text(), /Legacy integration fixture/)
      assert.equal(requests.at(-1).url, route)
    }
    for (const page of ['/compare', '/dashboard']) {
      const response = await fetch(base + page)
      assert.equal(response.status, 200)
      assert.match(await response.text(), /id="root"/)
    }
    const body = JSON.stringify({ text: 'frontend integration fixture' })
    const api = await fetch(`${base}/v1/sandbox/fixture/intent`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test-fixture' }, body,
    })
    assert.equal(api.status, 503)
    assert.deepEqual(await api.json(), { error: 'integration fixture: unavailable' })
    assert.deepEqual(requests.at(-1), {
      url: '/v1/sandbox/fixture/intent', method: 'POST', auth: 'Bearer test-fixture', body,
    })
    const mcp = await fetch(`${base}/mcp/fixture`, { method: 'POST', body: '{}' })
    assert.equal(mcp.status, 200)
    assert.equal(requests.at(-1).url, '/mcp/fixture')
    results.push({ mode, entry: 'pass', assets: 'pass', legacyRoutes: 'pass', apiAndMcpProxy: 'pass', spaFallback: 200 })
  }
  console.log(JSON.stringify(results, null, 2))
} finally {
  await dev?.close()
  if (built) await new Promise(resolve => built.httpServer.close(resolve))
  await new Promise(resolve => upstream.close(resolve))
}
