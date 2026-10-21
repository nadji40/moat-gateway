import { useState, useMemo } from 'react'
import { L } from '../../../i18n'
import { roleName, ago } from '../formatters'
import type { ApiKey } from '../types'

interface ApiKeysPaneProps {
  keys: ApiKey[]
  onMintKey: (label: string, role: string, days: number | null, scopes: string[]) => Promise<void>
  onRevokeKey: (keyId: string, purge: boolean) => Promise<void>
  error?: string
}

const SCOPES_CONFIG: Record<string, [string, string][]> = {
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

function expiryLabel(k: ApiKey) {
  if (!k.expires_at) return 'Never'
  const d = Math.round(
    (new Date(k.expires_at).getTime() - new Date(k.created_at || Date.now()).getTime()) / 864e5
  )
  const map: Record<number, string> = {
    1: '1 Day',
    7: '7 Days',
    30: '30 Days',
    90: '3 Months',
    180: '6 Months',
    365: '12 months',
  }
  return map[d] || `${d} days`
}

export default function ApiKeysPane({ keys, onMintKey, onRevokeKey, error }: ApiKeysPaneProps) {
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [pendingDeleteKey, setPendingDeleteKey] = useState<ApiKey | null>(null)

  // Create form state
  const [newLabel, setNewLabel] = useState('')
  const [newRole, setNewRole] = useState<'agent' | 'approver' | 'admin'>('admin')
  const [newDays, setNewDays] = useState<number | null>(365)
  const [newDaysLabel, setNewDaysLabel] = useState('12 months')
  const [selectedScopes, setSelectedScopes] = useState<string[]>([])
  const [minting, setMinting] = useState(false)
  const [mintError, setMintError] = useState('')

  // Dropdown states inside modal
  const [expiryDropOpen, setExpiryDropOpen] = useState(false)
  const [roleDropOpen, setRoleDropOpen] = useState(false)

  // Copy states for connect snippets
  const [copiedCurl1, setCopiedCurl1] = useState(false)
  const [copiedCurl2, setCopiedCurl2] = useState(false)

  const apiOrigin = typeof location !== 'undefined'
    ? location.hostname === 'moatgateway.dpdns.org'
      ? 'https://api.moatgateway.dpdns.org'
      : location.origin
    : ''

  const curlAgent = useMemo(() => {
    return [
      `${apiOrigin}/mcp`,
      '',
      '# any MCP client, with the agent key as a bearer token:',
      `curl -s ${apiOrigin}/mcp \\`,
      "  -H 'authorization: Bearer YOUR_AGENT_KEY' \\",
      "  -H 'content-type: application/json' \\",
      "  -H 'accept: application/json, text/event-stream' \\",
      '  -d \'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"you","version":"1"}}}\'',
    ].join('\n')
  }, [apiOrigin])

  const curlIntent = useMemo(() => {
    return [
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
    ].join('\n')
  }, [apiOrigin])

  const handleCopyAgent = async () => {
    try {
      await navigator.clipboard.writeText(curlAgent)
      setCopiedCurl1(true)
      setTimeout(() => setCopiedCurl1(false), 1600)
    } catch {
      // fallback
    }
  }

  const handleCopyIntent = async () => {
    try {
      await navigator.clipboard.writeText(curlIntent)
      setCopiedCurl2(true)
      setTimeout(() => setCopiedCurl2(false), 1600)
    } catch {
      // fallback
    }
  }

  const handleToggleScope = (scopeId: string) => {
    setSelectedScopes((prev) =>
      prev.includes(scopeId) ? prev.filter((s) => s !== scopeId) : [...prev, scopeId]
    )
  }

  const handleCreateKey = async () => {
    setMinting(true)
    setMintError('')
    try {
      await onMintKey(newLabel.trim() || 'New Key', newRole, newDays, selectedScopes)
      setShowCreateModal(false)
      setNewLabel('')
      setSelectedScopes([])
    } catch (err: unknown) {
      setMintError(String((err as Error).message || err))
    } finally {
      setMinting(false)
    }
  }

  const handleConfirmDelete = async () => {
    if (!pendingDeleteKey) return
    try {
      await onRevokeKey(pendingDeleteKey.id, false)
      setPendingDeleteKey(null)
    } catch {
      // handled by parent
    }
  }

  const currentRoleScopes = SCOPES_CONFIG[newRole] || []

  return (
    <section className="pane" id="pane-keys">
      <div className="page-head">
        <div className="titles">
          <h1 className="page-title">API keys</h1>
          <div className="page-caption">Bearer credentials for your mcp clients</div>
        </div>
        <button
          className="btn-create-key"
          data-create-key
          type="button"
          onClick={() => {
            setShowCreateModal(true)
            setMintError('')
          }}
        >
          {L('CREATE KEY', 'أنشئ مفتاحًا')}
        </button>
      </div>

      <div className="panel">
        <div className="table-shell">
          <div className="table-grid kgrid">
            <div className="th-cell">{L('Name', 'الاسم')}</div>
            <div className="th-cell">{L('KEY', 'المفتاح')}</div>
            <div className="th-cell">{L('Role', 'الدور')}</div>
            <div className="th-cell">{L('Created', 'أُنشئ')}</div>
            <div className="th-cell">{L('Expired', 'الانتهاء')}</div>
            <div className="th-cell">{L('Last used', 'آخر استخدام')}</div>
            <div className="th-cell">{L('Status', 'الحالة')}</div>
          </div>
          <div className="table-div" />
          <div id="keys">
            {keys.length > 0 ? (
              keys.map((k) => {
                const live = k.active && !k.expired
                const keyStr = String(k.id)
                const masked =
                  keyStr.length > 12 ? keyStr.slice(0, 8) + '...' + keyStr.slice(-4) : keyStr
                const createdDate = k.created_at
                  ? new Date(k.created_at).toLocaleDateString('en-GB', {
                      day: 'numeric',
                      month: 'short',
                    })
                  : ''
                const lastUsed = k.last_used_at ? ago(k.last_used_at) : L('never', 'أبدًا')

                return (
                  <div key={k.id} className={`table-grid kgrid ${live ? '' : 'spent'}`}>
                    <span className="rt primary">{k.label || '—'}</span>
                    <span className="rt muted">{masked}</span>
                    <span className="rt muted">{roleName(k.access_role)}</span>
                    <span className="rt muted">{createdDate}</span>
                    <span className="rt muted">{expiryLabel(k)}</span>
                    <span className="rt muted">{lastUsed}</span>
                    <div className="row-actions">
                      {k.current ? (
                        <span className="rt muted" style={{ color: 'var(--orange)' }}>
                          in use here
                        </span>
                      ) : (
                        <button
                          className="btn btn-danger-outline"
                          type="button"
                          onClick={() => setPendingDeleteKey(k)}
                        >
                          <svg
                            width="24"
                            height="24"
                            viewBox="0 0 24 24"
                            fill="none"
                            aria-hidden="true"
                          >
                            <path
                              d="M4 7h16M9.5 7V5h5v2M6.5 7l1 13h9l1-13M10 11v6M14 11v6"
                              stroke="white"
                              strokeWidth="1.7"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                          <span>Delete</span>
                        </button>
                      )}
                    </div>
                  </div>
                )
              })
            ) : (
              <div className="vempty">{L('No keys yet.', 'لا مفاتيح بعد.')}</div>
            )}
          </div>
        </div>
      </div>

      <p className="hint foot-note" id="keys-note">
        {error ? error : `${keys.length} ${keys.length === 1 ? 'key' : 'keys'}`}
      </p>

      {/* Connect your Agent section */}
      <div className="page-head" style={{ marginTop: 20 }}>
        <div className="titles" style={{ maxWidth: 640 }}>
          <h1 className="page-title">Connect your Agent</h1>
          <div className="page-caption">
            The agent receives an agent key, while your app holds an approver key and records the
            user’s input. The agent never sees the user’s input.
          </div>
        </div>
      </div>

      <div className="connect-cols" style={{ marginTop: -10 }}>
        <div className="code-col">
          <h3>1. The Agent</h3>
          <div className="code-block">
            <pre id="curl">{curlAgent}</pre>
            <button
              className="code-copy"
              type="button"
              aria-label="Copy code"
              onClick={handleCopyAgent}
            >
              {!copiedCurl1 ? (
                <img src="/console-assets/Copy.svg" width="24" height="24" alt="" />
              ) : (
                <svg
                  className="ico-check"
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                >
                  <path
                    d="M9 10L12.2581 12.4436C12.6766 12.7574 13.2662 12.6957 13.6107 12.3021L20 5"
                    strokeWidth="2"
                    strokeLinecap="round"
                    stroke="white"
                  />
                  <path
                    d="M21 12C21 13.8805 20.411 15.7137 19.3156 17.2423C18.2203 18.7709 16.6736 19.9179 14.893 20.5224C13.1123 21.1268 11.187 21.1583 9.38744 20.6125C7.58792 20.0666 6.00459 18.9707 4.85982 17.4789C3.71505 15.987 3.06635 14.174 3.00482 12.2945C2.94329 10.415 3.47203 8.56344 4.51677 6.99987C5.56152 5.4363 7.06979 4.23925 8.82975 3.57685C10.5897 2.91444 12.513 2.81996 14.3294 3.30667"
                    strokeWidth="2"
                    strokeLinecap="round"
                    stroke="white"
                  />
                </svg>
              )}
            </button>
          </div>
          <a className="tests-link" href="/tests">
            {L('Run the nine tests', 'شغّل الاختبارات التسعة')}
          </a>
        </div>

        <div className="code-col">
          <h3>2. Your application, with an approver key</h3>
          <div className="code-block">
            <pre id="curl-intent">{curlIntent}</pre>
            <button
              className="code-copy"
              type="button"
              aria-label="Copy code"
              onClick={handleCopyIntent}
            >
              {!copiedCurl2 ? (
                <img src="/console-assets/Copy.svg" width="24" height="24" alt="" />
              ) : (
                <svg
                  className="ico-check"
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                >
                  <path
                    d="M9 10L12.2581 12.4436C12.6766 12.7574 13.2662 12.6957 13.6107 12.3021L20 5"
                    strokeWidth="2"
                    strokeLinecap="round"
                    stroke="white"
                  />
                  <path
                    d="M21 12C21 13.8805 20.411 15.7137 19.3156 17.2423C18.2203 18.7709 16.6736 19.9179 14.893 20.5224C13.1123 21.1268 11.187 21.1583 9.38744 20.6125C7.58792 20.0666 6.00459 18.9707 4.85982 17.4789C3.71505 15.987 3.06635 14.174 3.00482 12.2945C2.94329 10.415 3.47203 8.56344 4.51677 6.99987C5.56152 5.4363 7.06979 4.23925 8.82975 3.57685C10.5897 2.91444 12.513 2.81996 14.3294 3.30667"
                    strokeWidth="2"
                    strokeLinecap="round"
                    stroke="white"
                  />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Create API Key Modal */}
      {showCreateModal && (
        <div className="modal-overlay open" data-modal onClick={() => setShowCreateModal(false)}>
          <div
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mk-dialog-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="dialog-title" id="mk-dialog-title">
              Create API Key
            </div>
            <div className="dialog-body">
              <div className="dialog-inner">
                <div className="dialog-field">
                  <div className="dialog-label">Name</div>
                  <div className="field">
                    <input
                      type="text"
                      id="lbl"
                      placeholder="Something"
                      aria-label="Key name"
                      spellCheck="false"
                      value={newLabel}
                      onChange={(e) => setNewLabel(e.target.value)}
                    />
                  </div>
                </div>

                <div className="dialog-field">
                  <div className="dialog-label">Expiration</div>
                  <div className={`drop dialog-drop ${expiryDropOpen ? 'open' : ''}`}>
                    <button
                      className="trigger"
                      type="button"
                      aria-expanded={expiryDropOpen}
                      onClick={() => setExpiryDropOpen((v) => !v)}
                    >
                      <span className="trg-label">{newDaysLabel}</span>
                      <svg
                        className="chev-down"
                        width="12"
                        height="12"
                        viewBox="0 0 12 12"
                        fill="none"
                      >
                        <path
                          d="M1 4.5l5 5 5-5"
                          fill="none"
                          stroke="white"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                      <svg className="chev-up" width="12" height="12" viewBox="0 0 12 12" fill="none">
                        <path
                          d="M1 7.5l5-5 5 5"
                          fill="none"
                          stroke="white"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                    {expiryDropOpen && (
                      <div className="drop-panel">
                        <div className="menu-body">
                          {[
                            { label: '12 months', days: 365 },
                            { label: '3 Months', days: 90 },
                            { label: '7 Days', days: 7 },
                            { label: 'Never', days: null },
                          ].map((opt) => (
                            <button
                              key={opt.label}
                              className={`menu-item ${newDays === opt.days ? 'selected' : ''}`}
                              type="button"
                              onClick={() => {
                                setNewDays(opt.days)
                                setNewDaysLabel(opt.label)
                                setExpiryDropOpen(false)
                              }}
                            >
                              <span className="check">
                                <svg viewBox="0 0 11.5 9" fill="none">
                                  <path
                                    d="M11.5 0l-7.75 9.00513-3.75-5"
                                    fill="none"
                                    stroke="white"
                                    strokeWidth="1.5"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                  />
                                </svg>
                              </span>
                              <span className="tag">{opt.label}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <div className="dialog-field">
                  <div className="dialog-label">Staging Agent</div>
                  <div className={`drop dialog-drop ${roleDropOpen ? 'open' : ''}`}>
                    <button
                      className="trigger"
                      type="button"
                      aria-expanded={roleDropOpen}
                      onClick={() => setRoleDropOpen((v) => !v)}
                    >
                      <span className="trg-label">
                        {newRole === 'agent'
                          ? 'Agent (makes payment)'
                          : newRole === 'approver'
                          ? 'Approver (your own application)'
                          : 'Admin (manages keys)'}
                      </span>
                      <svg
                        className="chev-down"
                        width="12"
                        height="12"
                        viewBox="0 0 12 12"
                        fill="none"
                      >
                        <path
                          d="M1 4.5l5 5 5-5"
                          fill="none"
                          stroke="white"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                      <svg className="chev-up" width="12" height="12" viewBox="0 0 12 12" fill="none">
                        <path
                          d="M1 7.5l5-5 5 5"
                          fill="none"
                          stroke="white"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                    {roleDropOpen && (
                      <div className="drop-panel">
                        <div className="menu-body">
                          <button
                            className={`menu-item ${newRole === 'agent' ? 'selected' : ''}`}
                            type="button"
                            onClick={() => {
                              setNewRole('agent')
                              setSelectedScopes([])
                              setRoleDropOpen(false)
                            }}
                          >
                            <span className="check">
                              <svg viewBox="0 0 11.5 9" fill="none">
                                <path
                                  d="M11.5 0l-7.75 9.00513-3.75-5"
                                  fill="none"
                                  stroke="white"
                                  strokeWidth="1.5"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            </span>
                            <span className="tag">Agent (makes payment)</span>
                          </button>
                          <button
                            className={`menu-item ${newRole === 'approver' ? 'selected' : ''}`}
                            type="button"
                            onClick={() => {
                              setNewRole('approver')
                              setSelectedScopes([])
                              setRoleDropOpen(false)
                            }}
                          >
                            <span className="check">
                              <svg viewBox="0 0 11.5 9" fill="none">
                                <path
                                  d="M11.5 0l-7.75 9.00513-3.75-5"
                                  fill="none"
                                  stroke="white"
                                  strokeWidth="1.5"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            </span>
                            <span className="tag">
                              Approver (your own application: intent and approvals)
                            </span>
                          </button>
                          <button
                            className={`menu-item ${newRole === 'admin' ? 'selected' : ''}`}
                            type="button"
                            onClick={() => {
                              setNewRole('admin')
                              setSelectedScopes([])
                              setRoleDropOpen(false)
                            }}
                          >
                            <span className="check">
                              <svg viewBox="0 0 11.5 9" fill="none">
                                <path
                                  d="M11.5 0l-7.75 9.00513-3.75-5"
                                  fill="none"
                                  stroke="white"
                                  strokeWidth="1.5"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            </span>
                            <span className="tag">Admin (manages keys)</span>
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <div className="dialog-field" id="scopes">
                  <div className="dialog-label">Permissions</div>
                  <div className="permissions" id="scopelist">
                    {currentRoleScopes.map(([id, label]) => {
                      const on = selectedScopes.includes(id)
                      return (
                        <button
                          key={id}
                          type="button"
                          className={`checkbox ${on ? 'on' : ''}`}
                          role="checkbox"
                          aria-checked={on}
                          onClick={() => handleToggleScope(id)}
                        >
                          <span className="box">
                            <svg
                              className="tick"
                              viewBox="0 0 6 4"
                              fill="none"
                              aria-hidden="true"
                            >
                              <path
                                d="M1 2l1.5 1.5L5 0.75"
                                stroke="white"
                                strokeWidth="1.25"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          </span>
                          <span className="txt">{label}</span>
                        </button>
                      )
                    })}
                  </div>
                  <p className="hint" id="scope-hint">
                    {L(
                      'Leave them all unticked for a key that carries the whole role.',
                      'اتركها كلها دون تحديد لمفتاح يحمل الدور كاملًا.'
                    )}
                  </p>
                </div>

                {mintError && (
                  <p className="hint" style={{ color: 'var(--red-l)' }}>
                    {mintError}
                  </p>
                )}
              </div>

              <div className="dialog-footer">
                <button
                  className="btn btn-dark"
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                >
                  <span>Cancel</span>
                </button>
                <button
                  className="btn btn-primary"
                  id="mint"
                  type="button"
                  disabled={minting}
                  onClick={handleCreateKey}
                >
                  <span>{minting ? 'Creating…' : 'Create'}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete Key Confirm Modal */}
      {pendingDeleteKey && (
        <div
          className="modal-overlay open"
          id="del-confirm"
          onClick={() => setPendingDeleteKey(null)}
        >
          <div
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="del-confirm-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="dialog-title" id="del-confirm-title">
              Delete API key
            </div>
            <div className="dialog-body">
              <div className="dialog-inner">
                <div className="confirm-msg">
                  {L('Are you sure you want to delete this API key?', 'هل أنت متأكد من حذف مفتاح API هذا؟')}
                </div>
                <div className="confirm-sub" id="del-confirm-sub">
                  {(pendingDeleteKey.label || pendingDeleteKey.id) +
                    ' · ' +
                    roleName(pendingDeleteKey.access_role) +
                    ' — this cannot be undone.'}
                </div>
              </div>
              <div className="dialog-footer">
                <button
                  className="btn btn-dark"
                  type="button"
                  onClick={() => setPendingDeleteKey(null)}
                >
                  <span>Cancel</span>
                </button>
                <button
                  className="btn btn-danger-outline"
                  type="button"
                  onClick={handleConfirmDelete}
                >
                  <span>Delete</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
