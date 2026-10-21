import { useState, useMemo } from 'react'
import { L } from '../../../i18n'
import { roleName, ago, LOCALE } from '../formatters'
import type { ApiKey } from '../types'
import { Chevrons, MenuCheck, CopyButton } from './bits'

interface ApiKeysPaneProps {
  keys: ApiKey[]
  onMintKey: (label: string, role: string, days: number | null, scopes: string[]) => Promise<void>
  onRevokeKey: (keyId: string) => Promise<void>
  error?: string
}

type Role = 'agent' | 'approver' | 'admin'

const SCOPES: Record<Role, [string, string][]> = {
  admin: [
    ['keys:read', L('See the keys', 'عرض المفاتيح')],
    ['keys:write', L('Issue and revoke keys', 'إصدار المفاتيح وإلغاؤها')],
    ['usage:read', L('Read usage', 'قراءة الاستخدام')],
    ['verdicts:read', L('Read the verdict feed', 'قراءة سجل الأحكام')],
  ],
  agent: [
    ['rail:card', L('Pay on cards', 'الدفع بالبطاقات')],
    ['rail:bank', L('Pay by bank transfer', 'الدفع بتحويل بنكي')],
    ['rail:crypto', L('Pay on chain', 'الدفع على السلسلة')],
  ],
  approver: [
    ['intent:write', L('Register what the user typed', 'تسجيل ما كتبه المستخدم')],
    ['authorizations:write', L('Register and cancel what a person signed off', 'تسجيل ما وافق عليه شخص وإلغاؤه')],
    ['holds:release', L('Approve or refuse a held payment', 'قبول دفعة مُعلَّقة أو رفضها')],
    ['evidence:read', L('Read outcomes and evidence', 'قراءة النتائج والأدلة')],
  ],
}

const ROLES: [Role, string][] = [
  ['agent', L('Agent: makes the payments', 'الوكيل: يُجري الدفعات')],
  ['approver', L('Approver: your own application, for intent and approvals', 'المُوافِق: تطبيقك أنت، للنية والموافقات')],
  ['admin', L('Admin: manages keys', 'المسؤول: يدير المفاتيح')],
]

/** The gateway takes a whole number of days from 1 to 3650, or nothing. */
const MAX_DAYS = 3650
type Expiry = number | null | 'custom'
const EXPIRIES: [Expiry, string][] = [
  [null, L('Never expires', 'لا ينتهي')],
  [1, L('1 day', 'يوم واحد')],
  [7, L('7 days', '7 أيام')],
  [30, L('30 days', '30 يومًا')],
  [90, L('90 days', '90 يومًا')],
  [365, L('1 year', 'سنة')],
  ['custom', L('Custom…', 'مدة مخصّصة…')],
]

const day = (t: string) =>
  new Date(t).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' })

function expiryText(k: ApiKey) {
  if (!k.expires_at) return L('Never', 'لا ينتهي')
  return k.expired ? L(`Expired ${day(k.expires_at)}`, `انتهى ${day(k.expires_at)}`) : day(k.expires_at)
}

/** Revoked wins over expired: a revoked key is gone whatever its date says. */
function statusOf(k: ApiKey): ['active' | 'revoked' | 'expired', string] {
  if (!k.active) return ['revoked', L('Revoked', 'مُلغى')]
  if (k.expired) return ['expired', L('Expired', 'منتهٍ')]
  return ['active', L('Active', 'نشط')]
}

export default function ApiKeysPane({ keys, onMintKey, onRevokeKey, error }: ApiKeysPaneProps) {
  const [showCreate, setShowCreate] = useState(false)
  const [pendingRevoke, setPendingRevoke] = useState<ApiKey | null>(null)
  const [revoking, setRevoking] = useState(false)
  const [revokeError, setRevokeError] = useState('')

  const [label, setLabel] = useState('')
  const [role, setRole] = useState<Role>('agent')
  const [expiry, setExpiry] = useState<Expiry>(null)
  const [customDays, setCustomDays] = useState('')
  const [scopes, setScopes] = useState<string[]>([])
  const [minting, setMinting] = useState(false)
  const [mintError, setMintError] = useState('')
  const [expiryOpen, setExpiryOpen] = useState(false)
  const [roleOpen, setRoleOpen] = useState(false)

  const apiOrigin = typeof location !== 'undefined'
    ? location.hostname === 'moatgateway.dpdns.org' ? 'https://api.moatgateway.dpdns.org' : location.origin
    : ''

  const curlAgent = useMemo(() => [
    `${apiOrigin}/mcp`,
    '',
    '# any MCP client, with the agent key as a bearer token:',
    `curl -s ${apiOrigin}/mcp \\`,
    "  -H 'authorization: Bearer YOUR_AGENT_KEY' \\",
    "  -H 'content-type: application/json' \\",
    "  -H 'accept: application/json, text/event-stream' \\",
    '  -d \'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"you","version":"1"}}}\'',
  ].join('\n'), [apiOrigin])

  const curlIntent = useMemo(() => [
    '# before the agent runs: what the user actually typed, from your own code',
    `curl -s ${apiOrigin}/v1/session/SESSION_ID/intent \\`,
    "  -H 'authorization: Bearer YOUR_APPROVER_KEY' \\",
    "  -H 'content-type: application/json' \\",
    '  -d \'{"text":"Pay the Northwind Cloud Co invoice INV-4471 for 480 USD."}\'',
    '',
    '# what a person signed off, if you use structured authorizations',
    `curl -s ${apiOrigin}/v1/session/SESSION_ID/authorizations \\`,
    "  -H 'authorization: Bearer YOUR_APPROVER_KEY' \\",
    "  -H 'content-type: application/json' \\",
    '  -d \'{"authorization_id":"auth-1","invoice_id":"INV-4471","payee":"Northwind Cloud Co","amount":"480","currency":"USD","expires_at":"2030-01-01T00:00:00Z"}\'',
  ].join('\n'), [apiOrigin])

  const openCreate = () => {
    setLabel('')
    setRole('agent')
    setExpiry(null)
    setCustomDays('')
    setScopes([])
    setMintError('')
    setShowCreate(true)
  }

  /** The expiry asked for: a number of days, null for never, or undefined when
   *  the custom box does not hold a whole number in range. */
  const pickedDays = (): number | null | undefined => {
    if (expiry !== 'custom') return expiry
    const n = Number(customDays.trim())
    return Number.isInteger(n) && n >= 1 && n <= MAX_DAYS ? n : undefined
  }

  const handleCreate = async () => {
    if (!label.trim()) {
      setMintError(L('Give the key a name.', 'أعطِ المفتاح اسمًا.'))
      return
    }
    const days = pickedDays()
    if (days === undefined) {
      setMintError(L(`Give the expiry as a whole number of days, from 1 to ${MAX_DAYS}.`,
        `اكتب مدة الانتهاء بعدد صحيح من الأيام، من 1 إلى ${MAX_DAYS}.`))
      return
    }
    setMinting(true)
    setMintError('')
    try {
      await onMintKey(label.trim(), role, days, scopes)
      setShowCreate(false)
    } catch (err) {
      setMintError(String((err as Error)?.message || err))
    } finally {
      setMinting(false)
    }
  }

  const handleRevoke = async () => {
    if (!pendingRevoke) return
    setRevoking(true)
    setRevokeError('')
    try {
      await onRevokeKey(pendingRevoke.id)
      setPendingRevoke(null)
    } catch (err) {
      setRevokeError(String((err as Error)?.message || err))
    } finally {
      setRevoking(false)
    }
  }

  const expiryLabel = expiry === 'custom'
    ? L('Custom…', 'مدة مخصّصة…')
    : (EXPIRIES.find(([v]) => v === expiry)?.[1] ?? '')

  return (
    <section className="pane" id="pane-keys">
      <div className="page-head">
        <div className="titles">
          <h1 className="page-title">{L('API keys', 'مفاتيح API')}</h1>
          <div className="page-caption">{L('Bearer keys for your MCP clients and your application', 'مفاتيح حاملة لعملاء MCP ولتطبيقك')}</div>
        </div>
        <button className="btn-create-key" type="button" onClick={openCreate}>
          {L('CREATE KEY', 'أنشئ مفتاحًا')}
        </button>
      </div>

      <div className="panel">
        <div className="table-shell">
          <div className="table-grid kgrid khead">
            <div className="th-cell">{L('Name', 'الاسم')}</div>
            <div className="th-cell">{L('Key id', 'معرّف المفتاح')}</div>
            <div className="th-cell">{L('Role', 'الدور')}</div>
            <div className="th-cell">{L('Created', 'أُنشئ')}</div>
            <div className="th-cell">{L('Expires', 'ينتهي')}</div>
            <div className="th-cell">{L('Last used', 'آخر استخدام')}</div>
            <div className="th-cell">{L('Status', 'الحالة')}</div>
          </div>
          <div className="table-div" />
          <div id="keys">
            {keys.length > 0 ? keys.map((k) => {
              const [status, statusText] = statusOf(k)
              return (
                <div key={k.id} className={`table-grid kgrid ${status === 'active' ? '' : 'spent'}`}>
                  <span className="rt primary k-name">
                    {k.label || '—'}
                    {k.scopes && k.scopes.length > 0 && (
                      <span className="key-scopes" dir="ltr">{k.scopes.join(' · ')}</span>
                    )}
                  </span>
                  <span className="rt muted mono k-id" dir="ltr">{k.id}</span>
                  <span className="rt muted k-cell" data-label={L('Role', 'الدور')}>{roleName(k.access_role)}</span>
                  <span className="rt muted k-cell" data-label={L('Created', 'أُنشئ')}>{k.created_at ? day(k.created_at) : ''}</span>
                  <span className={`rt muted k-cell ${k.expired ? 'is-expired' : ''}`} data-label={L('Expires', 'ينتهي')}>{expiryText(k)}</span>
                  <span className="rt muted k-cell" data-label={L('Last used', 'آخر استخدام')}>{k.last_used_at ? ago(k.last_used_at) : L('never', 'أبدًا')}</span>
                  <div className="row-actions k-act">
                    {k.current ? (
                      <span className="key-status here">{L('in use here', 'قيد الاستخدام هنا')}</span>
                    ) : status === 'active' ? (
                      <>
                        <span className="key-status active">{statusText}</span>
                        <button className="btn btn-danger-outline" type="button" onClick={() => { setRevokeError(''); setPendingRevoke(k) }}>
                          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                            <path d="M4 7h16M9.5 7V5h5v2M6.5 7l1 13h9l1-13M10 11v6M14 11v6" stroke="white" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                          <span>{L('Revoke', 'إلغاء')}</span>
                        </button>
                      </>
                    ) : (
                      <span className={`key-status ${status}`}>{statusText}</span>
                    )}
                  </div>
                </div>
              )
            }) : (
              <div className="vempty">{L('No keys yet.', 'لا مفاتيح بعد.')}</div>
            )}
          </div>
        </div>
      </div>

      <p className="hint foot-note" id="keys-note" style={error ? { color: 'var(--red-l)' } : undefined}>
        {error || L(`${keys.length} ${keys.length === 1 ? 'key' : 'keys'}`, `${keys.length} مفتاح`)}
      </p>

      <div className="page-head" style={{ marginTop: 20 }}>
        <div className="titles" style={{ maxWidth: 640 }}>
          <h2 className="page-title">{L('Connect your agent', 'اربط وكيلك')}</h2>
          <div className="page-caption">
            {L('The agent holds an agent key. Your application holds an approver key and records what the user typed. The agent never sees it.',
              'يحمل الوكيل مفتاح وكيل. ويحمل تطبيقك مفتاح مُوافِق ويسجّل ما كتبه المستخدم. ولا يراه الوكيل أبدًا.')}
          </div>
        </div>
      </div>

      <div className="connect-cols" style={{ marginTop: -10 }}>
        <div className="code-col">
          <h3>{L('1. The agent', '1. الوكيل')}</h3>
          <div className="code-block" dir="ltr">
            <pre id="curl">{curlAgent}</pre>
            <CopyButton text={curlAgent} />
          </div>
          <a className="tests-link" href="/tests">{L('Run the nine tests', 'شغّل الاختبارات التسعة')}</a>
        </div>
        <div className="code-col">
          <h3>{L('2. Your application, with an approver key', '2. تطبيقك، بمفتاح مُوافِق')}</h3>
          <div className="code-block" dir="ltr">
            <pre id="curl-intent">{curlIntent}</pre>
            <CopyButton text={curlIntent} />
          </div>
        </div>
      </div>

      {showCreate && (
        <div className="modal-overlay open" onClick={() => setShowCreate(false)}>
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="mk-dialog-title"
            onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && setShowCreate(false)}>
            <div className="dialog-title" id="mk-dialog-title">{L('Create an API key', 'أنشئ مفتاح API')}</div>
            <div className="dialog-body">
              <div className="dialog-inner">
                <div className="dialog-field">
                  <div className="dialog-label" id="lbl-name">{L('Name', 'الاسم')}</div>
                  <div className="field">
                    <input type="text" id="lbl" aria-labelledby="lbl-name" placeholder={L('staging agent', 'وكيل الاختبار')} spellCheck="false"
                      maxLength={80} autoFocus value={label} onChange={(e) => setLabel(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleCreate()} />
                  </div>
                </div>

                <div className="dialog-field">
                  <div className="dialog-label">{L('Expires', 'الانتهاء')}</div>
                  <div className={`drop dialog-drop ${expiryOpen ? 'open' : ''}`}>
                    <button className="trigger" type="button" aria-expanded={expiryOpen} onClick={() => setExpiryOpen((v) => !v)}>
                      <span className="trg-label">{expiryLabel}</span>
                      <Chevrons />
                    </button>
                    {expiryOpen && (
                      <div className="drop-panel">
                        <div className="menu-body">
                          {EXPIRIES.map(([value, text]) => (
                            <button key={String(value)} className={`menu-item ${expiry === value ? 'selected' : ''}`} type="button"
                              onClick={() => { setExpiry(value); setExpiryOpen(false) }}>
                              <MenuCheck />
                              <span className="tag">{text}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                  {expiry === 'custom' && (
                    <div className="field" style={{ marginTop: 8 }}>
                      <input id="expiry-days" type="number" min={1} max={MAX_DAYS} step={1} inputMode="numeric"
                        placeholder={L(`Days, 1 to ${MAX_DAYS}`, `أيام، من 1 إلى ${MAX_DAYS}`)}
                        aria-label={L('Expires in how many days', 'ينتهي بعد كم يومًا')}
                        value={customDays} onChange={(e) => setCustomDays(e.target.value)} />
                    </div>
                  )}
                </div>

                <div className="dialog-field">
                  <div className="dialog-label">{L('Role', 'الدور')}</div>
                  <div className={`drop dialog-drop ${roleOpen ? 'open' : ''}`}>
                    <button className="trigger" type="button" aria-expanded={roleOpen} onClick={() => setRoleOpen((v) => !v)}>
                      <span className="trg-label">{ROLES.find(([r]) => r === role)?.[1]}</span>
                      <Chevrons />
                    </button>
                    {roleOpen && (
                      <div className="drop-panel">
                        <div className="menu-body">
                          {ROLES.map(([r, text]) => (
                            <button key={r} className={`menu-item ${role === r ? 'selected' : ''}`} type="button"
                              onClick={() => { setRole(r); setScopes([]); setRoleOpen(false) }}>
                              <MenuCheck />
                              <span className="tag">{text}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <div className="dialog-field" id="scopes">
                  <div className="dialog-label">{L('Permissions', 'الصلاحيات')}</div>
                  <div className="permissions" id="scopelist">
                    {SCOPES[role].map(([id, text]) => {
                      const on = scopes.includes(id)
                      return (
                        <button key={id} type="button" className={`checkbox ${on ? 'on' : ''}`} role="checkbox" aria-checked={on}
                          onClick={() => setScopes((prev) => (on ? prev.filter((s) => s !== id) : [...prev, id]))}>
                          <span className="box">
                            <svg className="tick" viewBox="0 0 6 4" fill="none" aria-hidden="true">
                              <path d="M1 2l1.5 1.5L5 0.75" stroke="white" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          </span>
                          <span className="txt">{text}</span>
                        </button>
                      )
                    })}
                  </div>
                  <p className="hint" id="scope-hint">
                    {L('Leave them all unticked for a key that carries the whole role.', 'اتركها كلها دون تحديد لمفتاح يحمل الدور كاملًا.')}
                  </p>
                </div>

                {mintError && <p className="hint" role="alert" style={{ color: 'var(--red-l)' }}>{mintError}</p>}
              </div>

              <div className="dialog-footer">
                <button className="btn btn-dark" type="button" onClick={() => setShowCreate(false)}>
                  <span>{L('Cancel', 'إلغاء')}</span>
                </button>
                <button className="btn btn-primary" id="mint" type="button" disabled={minting} onClick={handleCreate}>
                  <span>{minting ? L('Creating…', 'جارٍ الإنشاء…') : L('Create', 'أنشئ')}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {pendingRevoke && (
        <div className="modal-overlay open" id="del-confirm" onClick={() => setPendingRevoke(null)}>
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="del-confirm-title"
            onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && setPendingRevoke(null)}>
            <div className="dialog-title" id="del-confirm-title">{L('Revoke API key', 'إلغاء مفتاح API')}</div>
            <div className="dialog-body">
              <div className="dialog-inner">
                <div className="confirm-msg">
                  {L('Revoke this key? Anything using it stops working at once.', 'أتلغي هذا المفتاح؟ كل ما يستخدمه يتوقف فورًا.')}
                </div>
                <div className="confirm-sub" id="del-confirm-sub">
                  {(pendingRevoke.label || pendingRevoke.id) + ' · ' + roleName(pendingRevoke.access_role) + ' · '
                    + L('this cannot be undone.', 'لا يمكن التراجع عن هذا.')}
                </div>
                {revokeError && <p className="hint" role="alert" style={{ color: 'var(--red-l)' }}>{revokeError}</p>}
              </div>
              <div className="dialog-footer">
                <button className="btn btn-dark" type="button" autoFocus onClick={() => setPendingRevoke(null)}>
                  <span>{L('Cancel', 'إلغاء')}</span>
                </button>
                <button className="btn btn-danger-outline" type="button" disabled={revoking} onClick={handleRevoke}>
                  <span>{revoking ? L('Revoking…', 'جارٍ الإلغاء…') : L('Revoke', 'ألغِ المفتاح')}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
