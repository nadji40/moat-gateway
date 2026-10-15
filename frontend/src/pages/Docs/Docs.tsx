import { useEffect, useRef, useState } from 'react'
import Footer from '../../components/layout/Footer'

/** The public API, from wherever the page is served. */
function apiBase(): string {
  if (typeof window === 'undefined') return 'https://api.moatgateway.dpdns.org'
  return window.location.hostname === 'moatgateway.dpdns.org'
    ? 'https://api.moatgateway.dpdns.org'
    : window.location.origin
}

const SECTIONS = [
  ['overview', 'Overview'],
  ['verdicts', 'How a payment is decided'],
  ['quickstart', 'Quickstart'],
  ['connect', 'Connect an agent'],
  ['keys', 'Keys and roles'],
  ['intent', 'What the user asked for'],
  ['approvals', 'Approvals'],
  ['holds', 'Held payments'],
  ['evidence', 'Evidence'],
  ['policy', 'Policy reference'],
  ['rules', 'Rule ids'],
  ['languages', 'Languages and currencies'],
  ['selfhost', 'Self-hosting'],
] as const

/** A code block with a copy button. Plain text in, no HTML. */
function Code({ children, lang }: { children: string; lang?: string }) {
  const [label, setLabel] = useState('Copy')
  const pre = useRef<HTMLPreElement>(null)
  async function copy() {
    const text = pre.current?.textContent ?? ''
    let ok = false
    try { if (navigator.clipboard && isSecureContext) { await navigator.clipboard.writeText(text); ok = true } } catch { ok = false }
    setLabel(ok ? 'Copied' : 'Select and copy')
    setTimeout(() => setLabel('Copy'), 1600)
  }
  return (
    <div className="codewrap">
      <div className="codebar">
        {lang && <span className="codebar-lbl">{lang}</span>}
        <span className="codebar-sp" />
        <button type="button" className="chip" onClick={copy} aria-label="Copy to clipboard">{label}</button>
      </div>
      <pre className="glass" ref={pre}>{children}</pre>
    </div>
  )
}

function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="tblwrap">
      <table className="tbl">
        <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{j === 0 ? <code>{c}</code> : c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  )
}

export default function Docs() {
  const [base] = useState(apiBase)
  const [active, setActive] = useState<string>(SECTIONS[0][0])

  useEffect(() => {
    document.title = 'moat, documentation'
    if (typeof IntersectionObserver === 'undefined') return
    const targets = SECTIONS.map(([id]) => document.getElementById(id)).filter((e): e is HTMLElement => !!e)
    const seen = new Map<string, boolean>()
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) seen.set(e.target.id, e.isIntersecting)
      const first = SECTIONS.find(([id]) => seen.get(id))
      if (first) setActive(first[0])
    }, { rootMargin: '-96px 0px -60% 0px' })
    targets.forEach((t) => io.observe(t))
    return () => io.disconnect()
  }, [])

  const H = `-H 'content-type: application/json'`

  return (
    <>
      <main className="docs wrap">
        <aside className="docs-nav" aria-label="On this page">
          <p className="docs-k">Documentation</p>
          {SECTIONS.map(([id, label]) => (
            <a key={id} href={`#${id}`} aria-current={active === id ? 'true' : undefined}>{label}</a>
          ))}
        </aside>

        <article className="docs-body">
          <header className="docs-head">
            <p className="kicker">Documentation</p>
            <h1>Moat, from first call to production.</h1>
            <p className="lede">Everything here runs against the public API at <code>{base}</code>. The sandbox needs no key. A workspace does.</p>
          </header>

          <section id="overview">
            <h2>Overview</h2>
            <p>Moat is an authorization layer between an AI agent and whatever moves money for it: a card provider, a bank, a chain. It runs as an MCP proxy, so one process sees both the content the agent reads as tool results and the payment it then tries to make as a tool call. That is the one place where it is still possible to tell which of the two a payee came from.</p>
            <p>Every payment call returns a verdict, <code>allow</code>, <code>step_up</code> or <code>deny</code>, together with a signed evidence record of how it was reached. Nothing reaches the provider on a <code>step_up</code> or a <code>deny</code>.</p>
            <p>Three things feed a verdict: what the user asked for, registered through the intent API; what an approver signed, registered as an authorization; and the workspace policy, which sets the limits and the rules.</p>
          </section>

          <section id="verdicts">
            <h2>How a payment is decided</h2>
            <p>Each field of a payment, the payee, the amount, the currency and the invoice, is traced to where it came from: the user's own request, a signed approval, the allowlist, or a tool result the agent read. The policy says which sources are acceptable for each field and what happens when a field fails.</p>
            <Table head={['verdict', 'meaning', 'what happens']} rows={[
              ['allow', 'Every field traced to the user, an approval or the allowlist, within the limits.', 'The call is forwarded to the provider.'],
              ['step_up', 'Something could be right but cannot be confirmed: a payee from a web page, a currency the user did not name, an amount nobody asked for.', 'The call is held. An approver releases or refuses it with the resume token.'],
              ['deny', 'A hard rule failed: over the cap, a reused approval, a currency with no rate, a mismatch with the approval it carries.', 'The call stops. The agent gets the reasons back.'],
            ]} />
            <p>With nobody to ask, <code>step_up</code> degrades to the policy's <code>no_human_available</code>, which is <code>deny</code> in the default policy.</p>
          </section>

          <section id="quickstart">
            <h2>Quickstart</h2>
            <p>The sandbox gives you a gateway of your own with a mock provider, so nothing can move money. No key, no account. Five calls show the whole idea: the user asks for one payee, an approver signs it, and the agent tries to pay somebody else.</p>
            <Code lang="bash">{`# a sandbox of your own
S=$(curl -s -XPOST ${base}/v1/sandbox | jq -r .id)

# what the user asked for
curl -s -XPOST ${base}/v1/sandbox/$S/intent ${H} \\
  -d '{"text":"Pay the Aseer Cloud Co invoice INV-4471 for 480 USD."}'

# what an approver signed off
A=$(curl -s -XPOST ${base}/v1/sandbox/$S/authorization ${H} \\
  -d '{"payee":"Aseer Cloud Co","amount":"480","currency":"USD"}')

# now try to pay someone else with that approval
P=$(echo "$A" | jq -c '{payee:"Qassim Trading Est",amount:480,currency:"USD",authorization_id,invoice_id}')
curl -s -XPOST ${base}/v1/sandbox/$S/pay ${H} -d "$P"

# the signed record of why
curl -s -XGET ${base}/v1/sandbox/$S/evidence

# hand the sandbox back
curl -s -XDELETE ${base}/v1/sandbox/$S`}</Code>
            <p>The pay call comes back <code>deny</code> with the rule <code>authorization-payee</code>: the recipient does not match the approval. <code>GET /v1/limits</code> says what a sandbox may do, and <code>GET /v1/tests</code> returns the nine attacks the <a href="/tests">tests page</a> runs, as data.</p>
          </section>

          <section id="connect">
            <h2>Connect an agent</h2>
            <p>A workspace holds your keys and every verdict made with them. Open one on the <a href="/dashboard">dashboard</a>; it gives you an admin key, shown once. Then issue an <strong>agent</strong> key and point your MCP client at the gateway, with the key as a bearer token.</p>
            <Code lang="bash">{`curl -s ${base}/mcp \\
  -H 'authorization: Bearer YOUR_AGENT_KEY' \\
  -H 'content-type: application/json' \\
  -H 'accept: application/json, text/event-stream' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"you","version":"1"}}}'`}</Code>
            <p>The reply carries the session id in the <code>Mcp-Session-Id</code> header. Later requests echo it. The agent then calls payment tools as usual; Moat decides each call and forwards or refuses it. The agent never needs to know Moat is there, and it never holds a key that could register intent or approve a payment.</p>
          </section>

          <section id="keys">
            <h2>Keys and roles</h2>
            <p>Three roles, and they do not overlap. A key can carry the whole role or a subset of its scopes; the gateway refuses anything the key was not given.</p>
            <Table head={['role', 'who holds it', 'scopes']} rows={[
              ['agent', 'The agent. It can only spend, and only within what was asked and approved.', 'rail:card, rail:bank, rail:crypto'],
              ['approver', 'Your own application: the code that owns the chat box or the approval screen.', 'intent:write, authorizations:write, holds:release, evidence:read'],
              ['admin', 'Whoever manages the workspace. Cannot pay or approve.', 'keys:read, keys:write, usage:read, verdicts:read'],
            ]} />
            <p>Keys are issued and revoked on the dashboard. The server keeps a hash, never the key, so a key cannot be shown twice.</p>
          </section>

          <section id="intent">
            <h2>What the user asked for</h2>
            <p>Moat cannot see the user's request in the MCP stream, because the host never sends it there. Your application registers it, once per user turn, with an approver key. <strong>Without a registered intent nothing can have come from the user, so every payment is held or refused.</strong></p>
            <Code lang="http">{`POST /v1/session/{id}/intent
authorization: Bearer YOUR_APPROVER_KEY

{ "text": "Pay the Aseer Cloud Co invoice INV-4471 for 480 USD." }`}</Code>
            <p>Send the words, the fields, or both. Fields are the strongest: a checkout or a form that already knows what was confirmed sends it exactly.</p>
            <Code lang="json">{`{
  "text": "Non pagare Orbit Labs Srl, paga 480 euro a Vega Cloud Srl, fattura 2024-17",
  "fields": {
    "pay": ["Vega Cloud Srl"],
    "refused": ["Orbit Labs Srl"],
    "amounts": ["480"],
    "currencies": ["EUR"],
    "references": ["2024-17"],
    "cancels_previous": false
  }
}`}</Code>
            <p>Text sent alone is read by a small language model beside the gateway. Every value it returns is checked against the message before it counts: a payee must be written there, an amount must be a number the message contains, a currency must be backed by a code or an unambiguous sign. What fails a check is dropped and reported, so a misreading costs a confirmation, never a payment. The reply says who read it:</p>
            <Code lang="json">{`{ "session": "s_…", "turn": 1, "read_by": "model",
  "fields": { "pay": ["Aseer Cloud Co"], "amounts": ["480"], "currencies": ["USD"], "references": ["INV-4471"] },
  "dropped": [] }`}</Code>
            <p><code>read_by</code> is <code>caller</code> when you sent fields, <code>model</code> when the reader read the text, and <code>rules</code> when the model was unavailable and the gateway's own rules read it instead. A client that needs the model checks this value.</p>
          </section>

          <section id="approvals">
            <h2>Approvals</h2>
            <p>An approval is what a person signed off: a payee, an amount, a currency, and usually an invoice. A payment that carries one is checked against it field by field.</p>
            <Code lang="http">{`POST /v1/session/{id}/authorizations
authorization: Bearer YOUR_APPROVER_KEY

{ "authorization_id": "auth-1", "invoice_id": "INV-4471",
  "payee": "Aseer Cloud Co", "amount": "480", "currency": "USD",
  "expires_at": "2030-01-01T00:00:00Z" }`}</Code>
            <p>One approval is one payment. Using it again, for another payee or the same one, is refused. Splitting a payment into pieces does not help: payments without an approval also meet a session total. An approval can be cancelled with <code>POST /v1/session/{'{id}'}/authorizations/{'{authorization_id}'}/cancel</code>.</p>
          </section>

          <section id="holds">
            <h2>Held payments</h2>
            <p>A <code>step_up</code> verdict returns a single-use <code>resume_token</code> to the agent. Your application shows the proposal to a person and answers with their decision:</p>
            <Code lang="http">{`POST /v1/session/{id}/resume
authorization: Bearer YOUR_APPROVER_KEY   (scope holds:release)

{ "resume_token": "…", "approved": true }`}</Code>
            <p>With <code>approved: true</code>, the exact proposal the person saw is allowed once: the agent retries the same call and it goes through; a second identical call is held again. Approving a payment does not open its payee for the rest of the session. If no person is available, <code>POST /v1/session/{'{id}'}/headless</code> with <code>{'{ "headless": true }'}</code> tells Moat so, and holds become the policy's <code>no_human_available</code>.</p>
          </section>

          <section id="evidence">
            <h2>Evidence</h2>
            <p>Every verdict is written to a hash-chained, signed record: the call, where each field came from, every rule and whether it passed, and the outcome. Editing, dropping or reordering a record breaks the chain.</p>
            <Code lang="http">{`GET /v1/session/{id}/evidence        every record of the session, in order
GET /v1/session/{id}/outcomes        what the provider did with each allowed payment
GET /v1/outcomes                     the same, across the workspace`}</Code>
            <p>The dashboard's verdict panel shows the same records with the rules in words. The <code>evidence_id</code> on a verdict is the handle for all of it.</p>
          </section>

          <section id="policy">
            <h2>Policy reference</h2>
            <p>A policy is a YAML file per gateway. This is the shape of the one the public gateway runs.</p>
            <Code lang="yaml">{`version: 1

payment_tools:                      # tools that move money; everything else is refused
  - { server: stripe, tool: pay }
non_payment_tools:                  # tools allowed through without a verdict
  - { server: stripe, tool: list_payments }

fields:                             # which argument carries what
  payee:    { args: [payee] }
  amount:   { args: [amount] }
  currency: { args: [currency] }

allowlist:
  payees: ["Monitoring Pro Inc"]    # trusted as recipients, not as a reason to pay

rules:
  - id: payee-provenance
    when: field == payee
    require_source: [User, Allowlist]
    on_fail: step_up
  - id: absolute-spending-cap
    when: field == amount
    max: 500                        # in the fx base currency
    on_fail: deny
  - id: amount-provenance
    when: field == amount
    require_source: [User, Allowlist, ToolResult]
    on_fail: step_up

velocity:
  max_calls_per_session: 50
  max_calls_per_minute: 30
  max_amount_per_session: 1000      # payments without an approval, added up
  on_exceed: deny

fx:                                 # every amount is valued in the base before a cap
  base: USD
  rates: { EUR: 1.133, SAR: 0.2667, AED: 0.2723, KWD: 3.258, EGP: 0.0202 }

no_human_available: deny`}</Code>
            <Table head={['key', 'meaning']} rows={[
              ['payment_tools', 'The tools that move money. A tool in neither list is refused and hidden from the agent.'],
              ['fields', 'Which call arguments are the payee, the amount and the currency.'],
              ['allowlist.payees', 'Names trusted as recipients. An allowlisted payee still needs the user to have asked for a payment.'],
              ['rules[].require_source', 'Where a field may come from: User, Allowlist, ToolResult, Authorization.'],
              ['rules[].max', 'A cap on the amount, in the fx base currency.'],
              ['rules[].on_fail', 'step_up or deny.'],
              ['velocity', 'Calls per session and per minute, and a total for payments made without an approval.'],
              ['fx', 'The base currency and the rate of every other one. A currency with no rate fails the caps.'],
              ['no_human_available', 'What step_up becomes when the session is headless.'],
            ]} />
          </section>

          <section id="rules">
            <h2>Rule ids</h2>
            <p>The ids that appear in a verdict's reasons and in the evidence. The dashboard shows them in words.</p>
            <Table head={['id', 'it fails when']} rows={[
              ['payee-provenance', 'The payee did not come from the user or an approval.'],
              ['amount-provenance', 'The amount did not come from the user or an approval.'],
              ['user-request', 'Nothing in the payment traces to what the user asked for.'],
              ['intent-currency', 'The user named a currency and the payment is in another, or the user named none and the payment names one.'],
              ['intent-invoice', 'The user named an invoice and the payment settles a different one.'],
              ['absolute-spending-cap', 'The amount, valued in the base currency, is over the cap.'],
              ['amount-precision', 'The amount has more decimals than its currency.'],
              ['session-total', 'Payments without an approval add up past the session total.'],
              ['authorization-payee', 'The payee does not match the approval the payment carries.'],
              ['authorization-amount', 'The amount does not match the approval.'],
              ['authorization-currency', 'The currency does not match the approval.'],
              ['authorization-invoice', 'The invoice does not match the approval.'],
              ['authorization-usage', 'The approval was already used.'],
              ['authorization-duplicate', 'The same invoice was already paid.'],
              ['authorization-expiry', 'The approval has expired.'],
              ['authorization-recipient-account', 'The account does not match the approval.'],
              ['authorization-network', 'The chain does not match the approval.'],
            ]} />
          </section>

          <section id="languages">
            <h2>Languages and currencies</h2>
            <p>The reader takes the message as the user wrote it: English, French, Arabic, including Gulf and Maghrebi dialects, and the other languages the model knows. Arabic-Indic digits are read as digits. Amounts keep the decimal conventions of the message.</p>
            <p>A currency counts only when the message backs it. A code (<code>SAR</code>, <code>EUR</code>) or an unambiguous sign counts: <code>SR</code>, <code>ر.س</code> and <code>ريال سعودي</code> are Saudi riyals; <code>KD</code> and <code>د.ك</code> are Kuwaiti dinars; <code>Dhs</code> and <code>د.إ</code> are UAE dirhams; <code>QR</code> is Qatari riyals; <code>دج</code> and <code>DA</code> are Algerian dinars; <code>TL</code> and <code>₺</code> are Turkish lira. A bare <code>ريال</code>, <code>دينار</code> or <code>درهم</code> could be several currencies, so it is dropped and the payment is held for a person rather than guessed.</p>
          </section>

          <section id="selfhost">
            <h2>Self-hosting</h2>
            <p>Moat is a single Rust binary, <code>moat-gateway</code>, with an optional PostgreSQL database for durable state and an optional <code>moat-intent</code> reader beside it. A minimal <code>moat.yaml</code>:</p>
            <Code lang="yaml">{`listen: { transport: http, addr: "127.0.0.1:7071" }
upstreams:
  - name: stripe
    transport: stdio
    command: ["node", "arena/mock-stripe/server.js"]
policy: policies/supplier-invoice.yaml
evidence: ./evidence.jsonl
keys: ./keys
intent_api: { addr: "127.0.0.1:7072", reader: "http://127.0.0.1:7083" }
storage: { database_url_env: "MOAT_DATABASE_URL" }
auth: { required: true }`}</Code>
            <Table head={['key', 'meaning', 'default']} rows={[
              ['listen', 'stdio, or http with an address. Loopback only unless auth is required.', 'stdio'],
              ['upstreams', 'The MCP servers behind Moat, each with a unique name.', 'required'],
              ['policy', 'The policy file.', 'none: payments denied'],
              ['intent_api.addr', 'Where the intent API listens.', 'none: no intents'],
              ['intent_api.reader', 'The moat-intent service that reads text into fields.', 'none: rules read text'],
              ['intent_api.reader_timeout_secs', 'How long to wait for the reader before the rules take over.', '45'],
              ['storage', 'PostgreSQL, from the named environment variable.', 'memory only'],
              ['auth.required', 'Require a workspace key on every HTTP route.', 'false'],
            ]} />
            <p>The repository README covers the database roles, migrations, the deploy script and the arena that produced the numbers on the <a href="/compare">compare page</a>.</p>
          </section>
        </article>
      </main>
      <Footer />
    </>
  )
}
