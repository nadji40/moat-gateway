import { useRef, useState } from 'react'
import { L } from '../../../i18n'
import { call } from '../api'
import { CopyButton, useThumb } from './bits'

/** Where agents reach Moat. The public site proxies the same gateway, but an
 *  MCP client belongs on the API host. */
function apiOrigin() {
  if (typeof location === 'undefined') return ''
  return location.hostname === 'moatgateway.dpdns.org' ? 'https://api.moatgateway.dpdns.org' : location.origin
}

const KEY = 'YOUR_AGENT_KEY'
const ASK = 'Pay the Northwind Cloud Co invoice INV-4471 for 480 USD.'

type Client = { id: string; name: string; where: string; lang: string; code: (url: string, key: string) => string }

/* One entry per client. Each is the client's own documented way to add a
   remote MCP server with a bearer header; nothing here is Moat-specific
   except the address and the key. */
const CLIENTS: Client[] = [
  {
    id: 'claude-code', name: 'Claude Code', where: L('Terminal', 'الطرفية'), lang: 'bash',
    code: (url, key) => `claude mcp add --transport http moat ${url} \\\n  --header "Authorization: Bearer ${key}"`,
  },
  {
    id: 'claude-desktop', name: 'Claude Desktop', where: 'claude_desktop_config.json', lang: 'json',
    code: (url, key) => JSON.stringify({
      mcpServers: {
        moat: {
          command: 'npx',
          args: ['-y', 'mcp-remote', url, '--header', 'Authorization:${MOAT_AUTH}'],
          env: { MOAT_AUTH: `Bearer ${key}` },
        },
      },
    }, null, 2),
  },
  {
    id: 'claude-api', name: 'Claude API', where: 'Python', lang: 'python',
    code: (url, key) => [
      'import anthropic',
      '',
      'client = anthropic.Anthropic()',
      'response = client.beta.messages.create(',
      '    model="claude-opus-5-5",',
      '    max_tokens=16000,',
      '    betas=["mcp-client-2025-11-20"],',
      `    mcp_servers=[{"type": "url", "url": "${url}", "name": "moat", "authorization_token": "${key}"}],`,
      '    tools=[{"type": "mcp_toolset", "mcp_server_name": "moat"}],',
      `    messages=[{"role": "user", "content": "${ASK}"}],`,
      ')',
    ].join('\n'),
  },
  {
    id: 'openai', name: 'OpenAI', where: 'Python, Responses API', lang: 'python',
    code: (url, key) => [
      'from openai import OpenAI',
      '',
      'client = OpenAI()',
      'response = client.responses.create(',
      '    model="gpt-5",',
      '    tools=[{',
      '        "type": "mcp",',
      '        "server_label": "moat",',
      `        "server_url": "${url}",`,
      `        "headers": {"Authorization": "Bearer ${key}"},`,
      '        "require_approval": "never",',
      '    }],',
      `    input="${ASK}",`,
      ')',
    ].join('\n'),
  },
  {
    id: 'cursor', name: 'Cursor', where: '~/.cursor/mcp.json', lang: 'json',
    code: (url, key) => JSON.stringify({ mcpServers: { moat: { url, headers: { Authorization: `Bearer ${key}` } } } }, null, 2),
  },
  {
    id: 'vscode', name: 'VS Code', where: '.vscode/mcp.json', lang: 'json',
    code: (url, key) => JSON.stringify({ servers: { moat: { type: 'http', url, headers: { Authorization: `Bearer ${key}` } } } }, null, 2),
  },
  {
    id: 'any', name: L('Any MCP client', 'أي عميل MCP'), where: 'Streamable HTTP', lang: 'text',
    code: (url, key) => [`URL     ${url}`, `Header  Authorization: Bearer ${key}`].join('\n'),
  },
]

export default function ConnectPane() {
  const [client, setClient] = useState(CLIENTS[0].id)
  const [agentKey, setAgentKey] = useState<string | null>(null)
  const [minting, setMinting] = useState(false)
  const [error, setError] = useState('')
  const tablist = useRef<HTMLDivElement | null>(null)
  const active = CLIENTS.findIndex((c) => c.id === client)
  const thumb = useThumb(tablist, active)

  const url = `${apiOrigin()}/mcp`
  const chosen = CLIENTS[active]
  const code = chosen.code(url, agentKey ?? KEY)

  // An agent key for this client, shown in the snippets once. It can pay and
  // do nothing else; the user's words come from your app on another key.
  const mintAgentKey = async () => {
    setMinting(true)
    setError('')
    try {
      const out = await call<{ secret: string }>('/v1/keys', {
        method: 'POST',
        body: JSON.stringify({ label: `${chosen.name} agent`, access_role: 'agent', scopes: [] }),
      })
      setAgentKey(out.secret)
    } catch (e) {
      setError(String((e as Error)?.message || e))
    } finally {
      setMinting(false)
    }
  }

  const intent = [
    `curl -s ${apiOrigin()}/v1/session/SESSION_ID/intent \\`,
    "  -H 'authorization: Bearer YOUR_APPROVER_KEY' \\",
    "  -H 'content-type: application/json' \\",
    `  -d '{"text":"${ASK}"}'`,
  ].join('\n')

  return (
    <section className="pane" id="pane-connect">
      <div className="page-head">
        <div className="titles">
          <h1 className="page-title">{L('Connect', 'الربط')}</h1>
        </div>
        <button className="btn-create-key" type="button" disabled={minting || Boolean(agentKey)} onClick={mintAgentKey}>
          {agentKey ? L('KEY ADDED BELOW', 'أُضيف المفتاح أدناه') : minting ? L('CREATING…', 'جارٍ الإنشاء…') : L('CREATE AGENT KEY', 'أنشئ مفتاح وكيل')}
        </button>
      </div>

      {agentKey && (
        <p className="connect-once" role="status">
          {L('This key is shown once. Copy the setup now.', 'يُعرض هذا المفتاح مرة واحدة. انسخ الإعداد الآن.')}
        </p>
      )}
      {error && <p className="hint" role="alert" style={{ color: 'var(--red-l)' }}>{error}</p>}

      <div className="connect-clients" id="connect-clients" role="tablist" ref={tablist} aria-label={L('Client', 'العميل')}>
        <span className="thumb" aria-hidden="true" style={thumb} />
        {CLIENTS.map((c) => (
          <button key={c.id} type="button" role="tab" aria-selected={c.id === client} onClick={() => setClient(c.id)}>
            {c.name}
          </button>
        ))}
      </div>

      <div className="panel connect-panel" role="tabpanel">
        <div className="connect-where">
          <span>{chosen.where}</span>
          <span className="mono" dir="ltr">{url}</span>
        </div>
        <div className="code-block" dir="ltr">
          <pre id="connect-code" data-lang={chosen.lang}>{code}</pre>
          <CopyButton text={code} />
        </div>
      </div>

      <div className="panel connect-panel" id="connect-app">
        <h2 className="panel-title">{L('Your app: what the user asked for', 'تطبيقك: ما طلبه المستخدم')}</h2>
        <div className="code-block" dir="ltr">
          <pre>{intent}</pre>
          <CopyButton text={intent} />
        </div>
        <a className="tests-link" href="/docs#quickstart">{L('Docs', 'التوثيق')}</a>
      </div>
    </section>
  )
}
