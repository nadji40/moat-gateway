import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../app/App'

const ADMIN = 'moat_admin_secret_never_shown_0123456789abcdef'
const now = Date.now()
const iso = (ms: number) => new Date(ms).toISOString()

const KEYS = [
  { id: 'key_admin01', label: 'first admin key', access_role: 'admin', scopes: [], active: true, current: true,
    created_at: iso(now - 9e8), last_used_at: iso(now - 6e4), expires_at: null, expired: false },
  { id: 'key_agent01', label: 'staging agent', access_role: 'agent', scopes: ['rail:card'], active: true,
    created_at: iso(now - 8e8), last_used_at: null, expires_at: iso(now + 6 * 864e5), expired: false },
  { id: 'key_old01', label: 'old agent', access_role: 'agent', scopes: [], active: true,
    created_at: iso(now - 2e9), last_used_at: null, expires_at: iso(now - 864e5), expired: true },
  { id: 'key_gone01', label: 'revoked agent', access_role: 'agent', scopes: [], active: false,
    created_at: iso(now - 2e9), last_used_at: null, expires_at: null, expired: false },
]
const FEED = [
  { evidence_id: 'ev_1', at: iso(now - 3e5), session_id: 's1', verdict: 'deny', rail: 'card', tool: 'pay',
    payee: 'Nova Studio', amount: '480', currency: 'USD', payee_source: 'tool_result', failed_rules: 'authorization-payee' },
  { evidence_id: 'ev_2', at: iso(now - 6e5), session_id: 's1', verdict: 'allow', rail: 'card', tool: 'pay',
    payee: 'Atlas Supplies', amount: '480', currency: 'USD', payee_source: 'user', failed_rules: null },
]
// The gateway's own counts, deliberately far more than the two-line feed.
const USAGE = { total: 1234, week: 56, allow: 1000, step_up: 34, deny: 200, other: 0, sessions: 7, last_at: FEED[0].at }

type Seen = { url: string; method: string; auth?: string; body?: unknown; session?: string }

function gateway(overrides: Record<string, (seen: Seen) => Response | undefined> = {}) {
  const seen: Seen[] = []
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input)
    const headers = (init.headers ?? {}) as Record<string, string>
    const entry: Seen = {
      url, method: init.method ?? 'GET', auth: headers.authorization, session: headers['mcp-session-id'],
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    }
    seen.push(entry)
    for (const [prefix, answer] of Object.entries(overrides)) {
      if (url.startsWith(prefix)) { const r = answer(entry); if (r) return r }
    }
    if (url === '/v1/usage') return json(USAGE)
    if (url === '/v1/verdicts') return json(FEED)
    if (url === '/v1/keys' && entry.method === 'GET') return json(KEYS)
    if (url === '/v1/keys' && entry.method === 'POST') return json({ id: 'key_new', secret: 'moat_new_secret' })
    return json({ error: 'no such endpoint' }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
  return seen
}

function openDashboard(pane = '') {
  window.history.replaceState({}, '', '/dashboard' + pane)
  return render(<App />)
}

describe('the dashboard', () => {
  beforeEach(() => localStorage.setItem('moat.admin', ADMIN))
  afterEach(() => {
    localStorage.clear()
    window.history.replaceState({}, '', '/')
  })

  it('asks for a workspace or a key when nobody is signed in', async () => {
    localStorage.removeItem('moat.admin')
    gateway()
    openDashboard()
    expect(await screen.findByRole('tab', { name: 'Create a workspace' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'I have a key' })).toBeInTheDocument()
  })

  it('counts every verdict from the gateway, not just the recent feed', async () => {
    gateway()
    openDashboard()
    expect(await screen.findByRole('heading', { level: 1, name: 'Usage' })).toBeInTheDocument()
    await waitFor(() => expect(document.querySelector('#stat-total')!.textContent).toBe('1,234'))
    expect(document.querySelector('#stat-paid')!.textContent).toBe('1,000')
    expect(document.querySelector('#stat-refused')!.textContent).toBe('200')
    expect(document.querySelector('#stat-sub')!.textContent).toContain('56')
  })

  it('never shows any part of the admin secret, only the key it belongs to', async () => {
    gateway()
    openDashboard()
    await waitFor(() => expect(document.querySelector('#ws-key')!.textContent).toBe('first admin key'))
    expect(document.querySelector('#ws-mask')!.textContent).toBe('key_admin01')
    expect(document.body.textContent).not.toContain(ADMIN.slice(0, 8))
    expect(document.body.textContent).not.toContain(ADMIN.slice(-4))
  })

  it('lists each key with its expiry, its scopes and whether it still works', async () => {
    gateway()
    openDashboard('#pane-keys')
    const rows = await screen.findByText('staging agent')
    const keys = document.querySelector<HTMLElement>('#keys')!
    expect(within(keys).getByText('rail:card')).toBeInTheDocument()
    const old = [...keys.children].find((r) => r.textContent!.includes('old agent'))!
    expect(old.className).toContain('spent')
    expect(old.textContent).toMatch(/Expired .+/)
    expect(within(old as HTMLElement).queryByRole('button', { name: /Revoke/ })).toBeNull()
    const gone = [...keys.children].find((r) => r.textContent!.includes('revoked agent'))!
    expect(gone.textContent).toContain('Revoked')
    expect(within(gone as HTMLElement).queryByRole('button', { name: /Revoke/ })).toBeNull()
    const live = [...keys.children].find((r) => r.textContent!.includes('staging agent'))!
    expect(within(live as HTMLElement).getByRole('button', { name: /Revoke/ })).toBeInTheDocument()
    expect(rows).toBeInTheDocument()
  })

  it('issues an agent key that never expires unless told otherwise', async () => {
    const seen = gateway()
    openDashboard('#pane-keys')
    fireEvent.click(await screen.findByRole('button', { name: 'CREATE KEY' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'ci agent' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(seen.some((s) => s.url === '/v1/keys' && s.method === 'POST')).toBe(true))
    const minted = seen.find((s) => s.url === '/v1/keys' && s.method === 'POST')!
    expect(minted.body).toEqual({ label: 'ci agent', access_role: 'agent', scopes: [] })
    expect(minted.auth).toBe('Bearer ' + ADMIN)
    expect(await screen.findByText('moat_new_secret')).toBeInTheDocument()
  })

  it('sends a chosen expiry in days, and refuses a custom one out of range', async () => {
    const seen = gateway()
    openDashboard('#pane-keys')
    fireEvent.click(await screen.findByRole('button', { name: 'CREATE KEY' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'short lived' } })
    fireEvent.click(screen.getByRole('button', { name: /Never expires/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Custom…' }))
    fireEvent.change(screen.getByLabelText('Expires in how many days'), { target: { value: '5000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('from 1 to 3650')
    expect(seen.some((s) => s.url === '/v1/keys' && s.method === 'POST')).toBe(false)

    fireEvent.change(screen.getByLabelText('Expires in how many days'), { target: { value: '45' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(seen.some((s) => s.url === '/v1/keys' && s.method === 'POST')).toBe(true))
    expect(seen.find((s) => s.url === '/v1/keys' && s.method === 'POST')!.body).toMatchObject({ expires_in_days: 45 })
  })

  it('shows why a revoke failed instead of closing as if it had worked', async () => {
    gateway({ '/v1/keys/': () => new Response(JSON.stringify({ error: 'that key is not yours to revoke' }), { status: 403 }) })
    openDashboard('#pane-keys')
    const live = (await screen.findByText('staging agent')).closest('.kgrid') as HTMLElement
    fireEvent.click(within(live).getByRole('button', { name: /Revoke/ }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('that key is not yours to revoke')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('runs a playground attempt through the real gateway with two separate keys', async () => {
    localStorage.setItem('moat.playground.keys', JSON.stringify({
      agent: { id: 'key_pga', secret: 'agent_secret' },
      approver: { id: 'key_pgh', secret: 'approver_secret' },
    }))
    const seen = gateway({
      '/mcp': (s) => {
        const body = s.body as { method: string }
        if (body.method === 'initialize') {
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), { headers: { 'mcp-session-id': 'sess-1' } })
        }
        if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
        return new Response(JSON.stringify({
          jsonrpc: '2.0', id: 2,
          error: { code: -32001, message: 'refused', data: { moat: {
            verdict: 'deny', evidence_id: 'ev_from_the_gateway',
            reasons: [{ id: 'authorization-payee', message: 'payee does not match the approval' }],
          } } },
        }))
      },
      '/v1/session/': () => new Response(JSON.stringify({ ok: true })),
    })
    openDashboard('#pane-playground')
    fireEvent.click(await screen.findByRole('button', { name: /Attempt payment/ }))

    expect(await screen.findByText(/ev_from_the_gateway/)).toBeInTheDocument()
    expect(screen.getByText('authorization-payee')).toBeInTheDocument()
    const intent = seen.find((s) => s.url === '/v1/session/sess-1/intent')!
    const approval = seen.find((s) => s.url === '/v1/session/sess-1/authorizations')!
    const pay = seen.find((s) => (s.body as { method?: string } | undefined)?.method === 'tools/call')!
    // The words and the approval go in on the approver key; the agent only pays.
    expect(intent.auth).toBe('Bearer approver_secret')
    expect(approval.auth).toBe('Bearer approver_secret')
    expect(pay.auth).toBe('Bearer agent_secret')
    expect(pay.session).toBe('sess-1')
    expect((pay.body as { params: { arguments: Record<string, unknown> } }).params.arguments)
      .toMatchObject({ authorization_id: (approval.body as { authorization_id: string }).authorization_id })
  })

  it('has a tab bar for phones that reaches every pane and says where you are', async () => {
    gateway()
    openDashboard()
    await screen.findByRole('heading', { level: 1, name: 'Usage' })
    const tabbar = document.querySelector<HTMLElement>('.tabbar')!
    // Live keys (not revoked, not expired) and recent verdicts are counted.
    await waitFor(() => expect(within(tabbar).getAllByRole('button').map((t) => t.textContent))
      .toEqual(['Usage', '2API keys', 'Playground', '2Verdicts']))
    expect(within(tabbar).getByRole('button', { name: /Usage/ })).toHaveAttribute('aria-current', 'page')
    fireEvent.click(within(tabbar).getByRole('button', { name: /Verdicts/ }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Verdicts' })).toBeInTheDocument()
    expect(within(tabbar).getByRole('button', { name: /Verdicts/ })).toHaveAttribute('aria-current', 'page')
    expect(location.hash).toBe('#pane-verdicts')
    // The signed-in key travels to the header, where a phone shows it.
    expect(document.querySelector('.topbar-key')!.textContent).toBe('first admin key')
  })

  it('runs in Arabic, right to left', async () => {
    localStorage.setItem('moat.lang', 'ar')
    document.documentElement.dir = 'rtl'
    gateway()
    // Switching language reloads the page; a fresh import is that reload.
    vi.resetModules()
    const { default: FreshApp } = await import('../app/App')
    window.history.replaceState({}, '', '/dashboard#pane-keys')
    render(<FreshApp />)
    expect(await screen.findByRole('heading', { level: 1, name: 'مفاتيح API' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'أنشئ مفتاحًا' })).toBeInTheDocument()
    expect(screen.queryByText('API keys')).toBeNull()
    expect(document.querySelector('.sidebar')!.textContent).toContain('الأحكام')
    document.documentElement.dir = 'ltr'
  })
})
