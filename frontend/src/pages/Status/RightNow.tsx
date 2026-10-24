import { useCallback, useEffect, useState } from 'react'
import { Box, Play, RadioTower } from 'lucide-react'
import { Card } from '../../components/ui/glass/card'
import { L } from '../../i18n'
import './RightNow.css'

type Method = 'GET' | 'POST' | 'DELETE'
type CheckState = 'up' | 'slow' | 'down' | null
type Result = { method: Method; path: string; ms: number | null; code: number | 'skip' | 'error' | null; state: CheckState }
type FlowStep = {
  method: Method
  path: (state: Record<string, string>) => string
  init: (state: Record<string, string>) => RequestInit
  keep?: (json: Record<string, unknown>) => Record<string, string>
}
const post = (payload: Record<string, unknown>): RequestInit => ({
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
})
// Source of truth: demo/public/status.html FLOW. Steps are sequential by design.
const FLOW: FlowStep[] = [
  { method: 'GET', path: () => '/v1/limits', init: () => ({}) },
  { method: 'GET', path: () => '/v1/tests', init: () => ({}) },
  { method: 'POST', path: () => '/v1/sandbox', init: () => ({ method: 'POST' }), keep: j => ({ id: String(j.id ?? '') }) },
  { method: 'POST', path: s => `/v1/sandbox/${s.id}/intent`, init: () => post({ text: 'Pay the Northwind Cloud Co invoice INV-4471 for 480 USD.' }) },
  { method: 'POST', path: s => `/v1/sandbox/${s.id}/authorization`, init: () => post({ payee: 'Northwind Cloud Co', amount: '480', currency: 'USD' }), keep: j => ({ auth: String(j.authorization_id ?? '') }) },
  { method: 'POST', path: s => `/v1/sandbox/${s.id}/pay`, init: s => post({ payee: 'Northwind Cloud Co', amount: 480, currency: 'USD', authorization_id: s.auth }) },
  { method: 'GET', path: s => `/v1/sandbox/${s.id}/evidence`, init: () => ({}) },
  { method: 'DELETE', path: s => `/v1/sandbox/${s.id}`, init: () => ({ method: 'DELETE' }) },
]
const displayPath = (path: string) => path.replace(/(\/v1\/sandbox\/)[^/]+/, '$1{id}')
const endpointDescription = (path: string) => {
  if (path === '/v1/limits') return L('Get rate limits and current usage', 'حدود المعدل والاستخدام الحالي')
  if (path === '/v1/tests') return L('List available tests', 'عرض الاختبارات المتاحة')
  if (path === '/v1/sandbox') return L('Create a new sandbox session', 'إنشاء جلسة تجريبية جديدة')
  if (path.endsWith('/intent')) return L('Submit payment intent', 'إرسال نية الدفع')
  if (path.endsWith('/authorization')) return L('Authorize the payment', 'تفويض الدفع')
  if (path.endsWith('/pay')) return L('Execute the authorized payment', 'تنفيذ الدفع المفوض')
  if (path.endsWith('/evidence')) return L('Retrieve payment evidence', 'جلب إثبات الدفع')
  return L('Close the sandbox session', 'إغلاق الجلسة التجريبية')
}
function PulseWave({ warn = false }: { warn?: boolean }) {
  return <svg className={`rn-wave ${warn ? 'rn-warn' : ''}`} viewBox="0 0 120 40" aria-hidden="true" fill="none">
    <path d="M1 29 C16 34 18 28 27 29 S39 6 49 11 S61 31 72 28 S91 16 98 22 S110 30 119 27" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
  </svg>
}
/** Same MOAT spinning mark geometry used by the leader's demo/public/app.js. */
function MoatWorkingMark() {
  return <svg className="rn-spin-mark" viewBox="69 43 144 144" aria-hidden="true">
    <g className="rn-spin-arcs" fill="none" stroke="currentColor" strokeWidth="13" strokeLinecap="round">
      <path className="rn-spin-arc" pathLength="100" d="M117 52.4 A67 67 0 0 1 202.7 141.2" />
      <path className="rn-spin-arc" pathLength="100" d="M177.5 171.2 A67 67 0 0 1 86.1 76.6" />
    </g>
    <g className="rn-spin-dots" fill="currentColor">
      <circle cx="99.7" cy="62.2" r="12" />
      <circle cx="192.3" cy="158.1" r="12" />
    </g>
    <path fill="currentColor" fillRule="evenodd" d="M110 90 H173 A7 7 0 0 1 180 97 V133 A7 7 0 0 1 173 140 H110 A7 7 0 0 1 103 133 V97 A7 7 0 0 1 110 90 Z M115 105 H123 A2 2 0 0 1 125 107 V112 A2 2 0 0 1 123 114 H115 A2 2 0 0 1 113 112 V107 A2 2 0 0 1 115 105 Z" />
  </svg>
}
function Bars() { return <span className="rn-bars" aria-hidden="true">{[8, 12, 19, 28, 37, 30, 21, 13, 7].map((h, i) => <i key={i} style={{ height: `${h}px` }} />)}</span> }
function Ring({ up, total, tone }: { up: number; total: number; tone: 'good' | 'warn' | 'bad' | 'idle' }) {
  return <span className={`rn-ring rn-tone-${tone}`} style={{ '--rn-progress': `${total ? up / total * 100 : 0}%` } as React.CSSProperties}>
    <span>{up}/{total}</span>
  </span>
}
export default function RightNow() {
  const [rows, setRows] = useState<Result[]>([])
  const [running, setRunning] = useState(false)
  const [hasRun, setHasRun] = useState(false)
  const [completed, setCompleted] = useState(0)
  const run = useCallback(async (signal?: AbortSignal) => {
    setRunning(true)
    setHasRun(false)
    setCompleted(0)
    const next: Result[] = FLOW.map(step => ({ method: step.method, path: displayPath(step.path({ id: '{id}', auth: '{auth}' })), ms: null, code: null, state: null }))
    setRows([...next])
    let session: Record<string, string> = {}
    try {
      for (let i = 0; i < FLOW.length; i++) {
        if (signal?.aborted) return
        const step = FLOW[i]
        const path = step.path(session)
        next[i].path = displayPath(path)
        if (path.includes('undefined') || path.includes('//') || (path.includes('/sandbox/') && !session.id)) {
          next[i] = { ...next[i], code: 'skip', state: 'down' }
          setRows([...next]); setCompleted(i + 1); continue
        }
        const t0 = performance.now()
        try {
          const response = await fetch(path, { ...step.init(session), signal })
          next[i] = { ...next[i], ms: Math.round(performance.now() - t0), code: response.status,
            state: !response.ok ? 'down' : performance.now() - t0 > 2500 ? 'slow' : 'up' }
          const json: Record<string, unknown> = await response.json().catch(() => ({}))
          if (step.keep && response.ok) session = { ...session, ...step.keep(json) }
        } catch {
          if (signal?.aborted) return
          next[i] = { ...next[i], ms: Math.round(performance.now() - t0), code: 'error', state: 'down' }
        }
        setRows([...next])
        setCompleted(i + 1)
      }
      setHasRun(true)
    } finally { if (!signal?.aborted) setRunning(false) }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    void run(controller.signal)
    return () => controller.abort()
  }, [run])
  const done = rows.filter(row => row.code !== null)
  const progress = Math.round(completed / FLOW.length * 100)
  const online = done.filter(row => row.state === 'up' || row.state === 'slow').length
  // Health uses the number of successful checks, not the visual mock values.
  // Slow but successful responses remain online, while latency gets its own warning color.
  const healthTone: 'good' | 'warn' | 'bad' | 'idle' =
    done.length === 0 ? 'idle' : online === FLOW.length ? 'good' : online === 0 ? 'bad' : 'warn'
  const times = done.map(row => row.ms).filter((n): n is number => n !== null).sort((a,b) => a-b)
  const median = times.length ? times[Math.floor(times.length / 2)] : null
  const slowest = times.length ? times[times.length - 1] : null
  return <section className="rn-section" aria-labelledby="rn-heading">
    <div className="rn-heading">
      <h2 id="rn-heading">{L('Right now', 'الآن')}</h2>
      <p><span className="rn-live-dot" />{L('Live API status', 'حالة الواجهة مباشرة')} <span className="rn-sub-sep">·</span> {hasRun ? L('Last checked just now', 'آخر تحقق للتو') : L('Checking endpoints', 'جارٍ فحص نقاط الاتصال')}</p>
      <button type="button" className="rn-run" disabled={running} aria-busy={running} onClick={() => void run()}>
        {running ? <MoatWorkingMark /> : <Play size={18} fill="currentColor" />}
        {running ? L('Checking…', 'جارٍ الفحص…') : L('Run the checks', 'شغّل الفحوص')}
      </button>
      {running && <div className="rn-check-progress" role="progressbar" aria-label={L('Endpoint checks progress', 'تقدم فحص نقاط الاتصال')} aria-valuemin={0} aria-valuemax={FLOW.length} aria-valuenow={completed}>
        <div className="rn-check-progress-caption"><span>{L('Checking endpoints', 'جارٍ فحص نقاط الاتصال')}</span><span>{completed} / {FLOW.length}</span></div>
        <div className="rn-check-progress-track"><span style={{ width: `${progress}%` }} /></div>
      </div>}
    </div>
    <Card material="clear" tint="rgba(0, 224, 180, 0.065)" className="rn-metrics" data-glass-shape="rn-capsule">
      <div className={`rn-metric rn-response rn-tone-${healthTone}`}><Ring up={online} total={FLOW.length} tone={healthTone}/><div><strong>{online} / {FLOW.length}</strong><b>{L('responding', 'تستجيب')}</b><small>{L('ENDPOINTS ONLINE', 'نقاط الاتصال المتاحة')}</small></div></div>
      <span className="rn-divider" />
      <div className="rn-metric"><span className="rn-metric-icon rn-cyan"><PulseWave /></span><div><strong>{median === null ? '—' : `${median} ms`}</strong><b>{L('median round trip', 'وسيط زمن الاستجابة')}</b></div></div>
      <span className="rn-divider" />
      <div className={`rn-metric rn-slowest ${slowest !== null && slowest > 2500 ? 'rn-tone-warn' : 'rn-tone-good'}`}><span className="rn-metric-icon rn-orange"><Bars /></span><div><strong>{slowest === null ? '—' : `${slowest} ms`}</strong><b>{L('slowest', 'الأبطأ')}</b></div></div>
    </Card>
    <Card material="clear" tint="rgba(255, 255, 255, 0.045)" className="rn-panel">
      <div className="rn-panel-title"><div><Box size={23} color="#ff881f"/><span>{L('ENDPOINTS', 'نقاط الاتصال')}</span></div><span className={`rn-online rn-tone-${healthTone}`}><span className="rn-live-dot" />{online} / {FLOW.length} {L('ONLINE', 'متاح')}</span></div>
      <div className="rn-list">{rows.map((row,i) => <div key={i} className={`rn-endpoint ${row.state === 'slow' ? 'rn-row-slow' : row.state === 'down' ? 'rn-row-down' : ''}`}>
        <span className={`rn-method rn-${row.method.toLowerCase()}`}>{row.method}</span>
        <span className="rn-route"><strong>{row.path}</strong><small>{endpointDescription(row.path)}</small></span>
        <span className="rn-mini-wave"><PulseWave warn={row.state === 'slow'} /></span>
        <span className={`rn-latency ${row.state === 'slow' ? 'rn-tone-warn' : row.state === 'down' ? 'rn-tone-bad' : ''}`}>{row.ms === null ? (running ? '…' : '—') : `${row.ms} ms`}</span>
        <span className={`rn-code ${row.state === 'down' ? 'rn-code-bad' : ''}`}>{row.code ?? (running ? '…' : '—')}</span>
      </div>)}</div>
      <p className="rn-origin"><RadioTower size={14}/>{L('Checked against this site’s API from your browser; network round-trip time is included.', 'تم فحص الواجهة من متصفحك؛ مدة الشبكة محسوبة.')}</p>
    </Card>
  </section>
}
