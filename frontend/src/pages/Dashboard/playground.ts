/* The playground's real side: the endpoints a customer uses, driven by this
 * workspace's own keys.
 *
 * The agent side is an `agent` key on /mcp. The trusted side is an
 * `approver` key on the intent API. They are two keys on purpose and the
 * split is the whole design: an agent that could register its own intent
 * would be an agent that authorizes itself, so the key that says what the
 * user asked for is one the agent never sees.
 *
 * Both are minted with the admin key you signed in with, held in this
 * browser under the same slot the classic page used, and listed in the Keys
 * tab like any other. Revoke them there and the playground mints a new pair. */

import { call } from './api'

const SLOT = 'moat.playground.keys'

interface Pair {
  agent: { id: string; secret: string }
  approver: { id: string; secret: string }
}

function heldPair(): Pair | null {
  try { return JSON.parse(localStorage.getItem(SLOT) || 'null') as Pair | null } catch { return null }
}

export function forgetPair() {
  try { localStorage.removeItem(SLOT) } catch { /* a private window */ }
}

/** The pair, minted with exactly the scopes each side needs and no others:
 *  the agent settles on cards and can do nothing else; the harness writes
 *  intent and authorizations and cannot release a held payment, which is a
 *  person's decision and not this page's. */
async function pair(): Promise<Pair> {
  const held = heldPair()
  if (held) return held
  const mint = (label: string, access_role: string, scopes: string[]) =>
    call<{ id: string; secret: string }>('/v1/keys', {
      method: 'POST',
      body: JSON.stringify({ label, access_role, scopes }),
    })
  const minted: Pair = {
    agent: await mint('playground agent', 'agent', ['rail:card']),
    approver: await mint('playground harness', 'approver', ['intent:write', 'authorizations:write']),
  }
  try { localStorage.setItem(SLOT, JSON.stringify(minted)) } catch { /* a private window: minted again next time */ }
  return minted
}

interface RpcReply {
  body: { error?: { message?: string; data?: { moat?: MoatVerdict } }; result?: { content?: { text?: string }[] } }
  session: string | null
}

/** One JSON-RPC message over the MCP endpoint, as the agent. */
async function asAgent(secret: string, session: string | null, message: unknown): Promise<RpcReply> {
  const res = await fetch('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer ' + secret,
      ...(session ? { 'mcp-session-id': session } : {}),
    },
    body: JSON.stringify(message),
  })
  const text = await res.text()
  if (!res.ok && !text.trim().startsWith('{')) throw new Error(text.slice(0, 200) || res.statusText)
  // A notification is answered with 202 and no body at all.
  return { body: text.trim() ? JSON.parse(text) : {}, session: res.headers.get('mcp-session-id') }
}

export interface MoatVerdict {
  verdict: 'allow' | 'step_up' | 'deny'
  reasons?: { id: string; message: string }[]
  prompt?: string
  evidence_id?: string
}

export interface Approval {
  payee: string
  amount: string
  currency: string
}

export interface Attempt {
  payee: string
  amount: number
  currency: string
}

export interface Outcome {
  decision: 'allow' | 'step_up' | 'deny'
  /** What the provider said, when the call reached it; Moat's verdict otherwise. */
  providerSaid?: string
  reasons: [string, string][]
  prompt?: string
  evidenceId?: string
}

/** A session with the user's words registered. Intent is append-only within
 *  a session, so the caller makes a new one whenever the words or the
 *  approval change, rather than leaving two sentences on record. */
export async function openSession(intent: string): Promise<string> {
  const keys = await pair()
  const open = await asAgent(keys.agent.secret, null, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'playground', version: '1' } },
  })
  if (open.body.error) throw new Error(open.body.error.message || 'the gateway refused the session')
  const session = open.session
  if (!session) throw new Error('the gateway returned no session id')
  await asAgent(keys.agent.secret, session, { jsonrpc: '2.0', method: 'notifications/initialized' })
  // The trusted side. Note the key: the agent never holds this one.
  await call(`/v1/session/${encodeURIComponent(session)}/intent`, {
    method: 'POST', body: JSON.stringify({ text: intent }),
  }, keys.approver.secret)
  return session
}

const token = () => Math.random().toString(36).slice(2, 10)

/** One attempt: a fresh single-use authorization, as production would write
 *  it, then the agent's call. A fresh one each time keeps the answer about
 *  the field that was changed rather than about the previous attempt having
 *  already used the approval up. */
export async function attempt(session: string, approval: Approval | null, tried: Attempt): Promise<Outcome> {
  const keys = await pair()
  const args: Record<string, string | number> = { ...tried }
  if (approval) {
    const authorization_id = 'pg-' + token()
    const invoice_id = 'INV-' + token().slice(0, 6).toUpperCase()
    await call(`/v1/session/${encodeURIComponent(session)}/authorizations`, {
      method: 'POST',
      body: JSON.stringify({
        authorization_id, invoice_id, ...approval,
        // An hour is longer than anyone will sit here, and short enough that
        // an approval left behind expires on its own.
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        repeat_payments: false,
        max_payments: 1,
      }),
    }, keys.approver.secret)
    args.authorization_id = authorization_id
    args.invoice_id = invoice_id
  }
  const out = await asAgent(keys.agent.secret, session, {
    jsonrpc: '2.0', id: Date.now() % 100000, method: 'tools/call',
    params: { name: 'stripe__pay', arguments: args },
  })
  // A refusal arrives as a JSON-RPC error carrying Moat's own verdict; an
  // allow arrives as the provider's reply, because the call was forwarded.
  const err = out.body.error
  const moat = err?.data?.moat
  if (err && !moat) throw new Error(err.message || 'the gateway refused the call')
  return {
    decision: moat ? moat.verdict : 'allow',
    providerSaid: !err ? String(out.body.result?.content?.[0]?.text ?? '').slice(0, 220) : undefined,
    reasons: (moat?.reasons ?? []).map((r) => [r.id, r.message]),
    prompt: moat?.prompt,
    evidenceId: moat?.evidence_id,
  }
}
