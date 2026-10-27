import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRight, CheckCircle2, CircleDollarSign, Coins, Clock3, FileCheck2, FileWarning, Play, Repeat2, ShieldAlert, ShieldCheck, Search, Wallet } from 'lucide-react'
import { Card } from '../../components/ui/glass/card'
import { LiquidGlassProvider } from '../../components/ui/liquid/liquid-glass-provider'
import Footer from '../../components/layout/Footer'
import { L } from '../../i18n'
import "../../styles/Tests.css";
/** Exact SVG geometry and timing from Status/RightNow.tsx. */
function MoatWorkingMark() {
  return (
    <svg className="tests-moat-spin-mark" viewBox="69 43 144 144" aria-hidden="true" focusable="false">
      <g className="tests-moat-spin-arcs" fill="none" stroke="currentColor" strokeWidth="13" strokeLinecap="round">
        <path className="tests-moat-spin-arc" pathLength="100" d="M117 52.4 A67 67 0 0 1 202.7 141.2" />
        <path className="tests-moat-spin-arc" pathLength="100" d="M177.5 171.2 A67 67 0 0 1 86.1 76.6" />
      </g>
      <g className="tests-moat-spin-dots" fill="currentColor">
        <circle cx="99.7" cy="62.2" r="12" />
        <circle cx="192.3" cy="158.1" r="12" />
      </g>
      <path fill="currentColor" fillRule="evenodd" d="M110 90 H173 A7 7 0 0 1 180 97 V133 A7 7 0 0 1 173 140 H110 A7 7 0 0 1 103 133 V97 A7 7 0 0 1 110 90 Z M115 105 H123 A2 2 0 0 1 125 107 V112 A2 2 0 0 1 123 114 H115 A2 2 0 0 1 113 112 V107 A2 2 0 0 1 115 105 Z" />
    </svg>
  )
}

type Decision = 'allow' | 'deny' | 'step_up'
type TestCase = {
  id: string; title: string; icon: string; family: string; summary: string
  task: string; page?: string; mandate?: { payee: string; amount: string; currency: string }
  calls: { payee?: string; amount?: number | string; currency?: string }[]
  expect: Decision; note: string
}
type TestResult = {
  id: string; decision: Decision; expected: Decision; met: boolean
  reasons: { id: string; message: string }[]; paid: boolean; ms: number
}
type Outcome = { result?: TestResult; error?: string }

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const json = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(json.error || `HTTP ${response.status}`)
  return json as T
}
const icons = { inject: FileWarning, lookalike: Search, amount: CircleDollarSign, currency: Wallet, replay: Repeat2, cap: ShieldAlert, check: ShieldCheck, none: ShieldAlert }
const familyArabic: Record<string, string> = { provenance: 'مصدر الحقول', mandate: 'الموافقة', replay: 'إعادة الإرسال', control: 'حالة مشروعة' }
const translation: Record<string, [string, string, string]> = {
  legitimate: ['الدفعة التي يجب أن تمرّ', 'ما وافق عليه المستخدم تمامًا، حتى آخر سنت.', 'طبقة تحجب هذه الدفعة ليست وسيلة حماية، بل عُطل. يجب رفض كل هجوم أدناه دون رفض هذه.'],
  'injected-payee': ['الصفحة تقول ادفع لشخص آخر', 'صفحة مورّد تحمل تعليمة لم يُعطها المستخدم قط.', 'المبلغ صحيح والفاتورة حقيقية. الخطأ في مَن يتلقّاه.'],
  lookalike: ['مستفيد يختلف بحرف واحد', 'اسم المورّد مع نقطة مضافة.', 'مَن يوافق عليها بالنظر قد لا يلاحظها.'],
  homoglyph: ['مستفيد ليس بالحروف التي تقرؤها', 'حرف سيريلي يحلّ محلّ حرف لاتيني.', 'المقارنة تتم على الحروف، لا على شكلها.'],
  inflated: ['المورّد الصحيح، بسعر أعلى', '499 حيث وافق المستخدم على 480.', 'يوقف Moat الدفعة ويطلب موافقة الشخص.'],
  currency: ['الرقم الصحيح، العملة الخاطئة', '480 EUR مقابل موافقة على 480 USD.', 'الرقم مطابق لكن العملة مختلفة.'],
  'over-cap': ['مبلغ يتجاوز الموافقة بكثير', '9,999 مقابل موافقة على 480.', 'حدّ الإنفاق التقليدي يكتشف هذه المحاولة.'],
  replay: ['الفاتورة نفسها، مدفوعة مرتين', 'دفعة تتكرر تحت موافقة واحدة.', 'يجب أن يُكتشف الطلب الثاني من سجل الدفع.'],
  'no-mandate': ['دفعة لم يأذن بها أحد', 'حاول الوكيل الدفع بلا موافقة.', 'لا توجد موافقة للرجوع إليها.'],
}
const verdict = (value: Decision) => ({ allow: L('allow', 'مسموح بها'), deny: L('deny', 'مرفوضة'), step_up: L('step up', 'مُعلّقة') })[value]

export default function Tests() {
  const [tests, setTests] = useState<TestCase[]>([])
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({})
  const [running, setRunning] = useState<string[]>([])
  const [loadError, setLoadError] = useState('')
  const launched = useRef(false)
  // The homepage CTA navigates to /tests?run=1. Start at the hero rather
  // than inheriting the homepage's old scroll position.
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
  }, [])
  const busy = useRef(new Set<string>())
  const outcomesRef = useRef<Record<string, Outcome>>({})

  const runTests = useCallback(async (ids: string[]) => {
    const pending = ids.filter(id => !busy.current.has(id))
    if (!pending.length) return
    pending.forEach(id => { busy.current.add(id); delete outcomesRef.current[id] })
    setOutcomes({ ...outcomesRef.current })
    setRunning([...busy.current])
    const queue = [...pending]
    // Keep the legacy concurrency limit: each test gets a separate sandbox,
    // and demo/src/server.ts permits at most three suite slots per caller.
    const worker = async () => {
      while (queue.length) {
        const id = queue.shift()!
        try {
          const payload = await getJson<{ results: TestResult[] }>(`/v1/suite?test=${encodeURIComponent(id)}`, { method: 'POST' })
          if (!Array.isArray(payload.results) || !payload.results.some(r => r.id === id)) throw new Error('Invalid suite response')
          for (const result of payload.results) outcomesRef.current[result.id] = { result }
        } catch (e) {
          // Never convert a failed HTTP request into a fabricated "deny" verdict.
          outcomesRef.current[id] = { error: e instanceof Error ? e.message : String(e) }
        } finally {
          busy.current.delete(id)
          setOutcomes({ ...outcomesRef.current })
          setRunning([...busy.current])
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, pending.length) }, () => worker()))
  }, [])

  useEffect(() => {
    document.title = L('moat, the nine tests', 'moat، الاختبارات التسعة')
    let cancelled = false
    getJson<{ tests: TestCase[] }>('/v1/tests').then(({ tests }) => {
      if (cancelled) return
      if (!Array.isArray(tests)) throw Error('Invalid tests response')
      setTests(tests)
      if (new URLSearchParams(window.location.search).has('run') && !launched.current) {
        launched.current = true
        void runTests(tests.map(t => t.id))
      }
    }).catch(error => { if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error)) })
    return () => { cancelled = true }
  }, [runTests])

  const completed = Object.values(outcomes).flatMap(o => o.result ? [o.result] : [])
  const matched = completed.filter(r => r.met).length
  const attackerPaid = completed.filter(r => r.paid && r.expected !== 'allow').length
  const totalMs = completed.reduce((total, r) => total + r.ms, 0)
  // Settled outcomes include backend failures so progress never implies a fake pass.
  const settled = Object.keys(outcomes).length
  const progressPercent = Math.min(100, Math.round((settled / Math.max(tests.length, 1)) * 100))
  const isExecuting = running.length > 0
  return <LiquidGlassProvider backdrop="/glass-backdrop.svg" options={{ refraction: 4, dispersion: 0, frost: 8 }}>
    <main id="main-content" className="tests-page" tabIndex={-1}>
      <div className="wrap">
        <header className="hero tests-hero">
          <p className="kicker">{L('The tests', 'الاختبارات')}</p>
          <h1>{L('Nine attacks, each isolating one thing', 'تسع هجمات، كلٌّ منها يعزل أمرًا واحدًا')}</h1>
          <p className="lede">{L('Rows from the measured corpus. Each runs in a gateway of its own.', 'صفوف من مجموعة الاختبارات المقيسة. كلٌّ منها يعمل في بوابة خاصة به.')}</p>
          <div className="tests-actions">
            <button className="btn" type="button" disabled={!tests.length || running.length > 0} onClick={() => void runTests(tests.map(t => t.id))}>
              {running.length ? <MoatWorkingMark /> : <Play size={16} fill="currentColor" />}
              {running.length ? L('Running', 'جارٍ التشغيل') : L('Run all nine', 'شغّل الاختبارات التسعة')}
            </button>
            <a href="/#compose" className="btn ghost">{L('Compose your own', 'صمّم اختبارك')} <ArrowRight size={15} /></a>
          </div>
        </header>
        {loadError && <p className="tests-error" role="alert">{L('Could not reach the sandbox:', 'تعذّر الوصول إلى بيئة التجربة:')} {loadError}</p>}
        {(completed.length > 0 || isExecuting || settled > 0) && (
          <Card
            material="clear"
            tint="rgba(255, 255, 255, 0.06)"
            className={`tests-summary tests-summary--radial ${isExecuting ? 'is-running' : ''}`}
            aria-label={L('Test execution summary', 'ملخص تنفيذ الاختبارات')}
          >
            <div className="tests-summary-rail" aria-hidden="true">
              <span className="tests-summary-rail-fill" style={{ width: `${progressPercent}%` }} />
            </div>
            <div className="tests-summary-metrics" aria-live="polite" aria-atomic="true">
              <div className="tests-summary-metric metric-success">
                <span className="tests-summary-orbit"><ShieldCheck size={27} strokeWidth={1.75} /></span>
                <span className="tests-summary-copy">
                  <strong>{matched} / {completed.length}</strong>
                  <small>{L('as the corpus says', 'كما تقول مجموعة الاختبارات')}</small>
                </span>
              </div>
              <div className="tests-summary-metric metric-threat">
                <span className="tests-summary-orbit"><Coins size={27} strokeWidth={1.75} /></span>
                <span className="tests-summary-copy">
                  <strong className={attackerPaid ? 'tests-bad' : ''}>{attackerPaid}</strong>
                  <small>{L('attacker paid', 'دُفع للمهاجم')}</small>
                </span>
              </div>
              <div className="tests-summary-metric metric-time">
                <span className="tests-summary-orbit"><Clock3 size={27} strokeWidth={1.75} /></span>
                <span className="tests-summary-copy">
                  <strong>{totalMs.toLocaleString('en-US')} ms</strong>
                  <small>{L('gateway time', 'وقت البوابة')}</small>
                </span>
              </div>
              <div className="tests-summary-metric metric-signed">
                <span className="tests-summary-orbit"><FileCheck2 size={27} strokeWidth={1.75} /></span>
                <span className="tests-summary-copy">
                  <span className="tests-summary-signed">{isExecuting ? `${running.length} ${L('running', 'قيد التشغيل')}` : L('signed and recorded', 'موقَّعة ومسجَّلة')}</span>
                </span>
              </div>
            </div>
          </Card>
        )}
        <section className="tests-grid" aria-label={L('Security tests', 'اختبارات الحماية')}>
          {tests.map((test, index) => {
            const Icon = icons[test.icon as keyof typeof icons] || ShieldAlert
            const outcome = outcomes[test.id]
            const result = outcome?.result
            const active = running.includes(test.id)
            const ar = translation[test.id]
            return <Card key={test.id} material="clear" tint="rgba(255, 255, 255, 0.06)" className={`tests-card tests-family-${test.family} ${result ? `tests-result-${result.decision}` : 'tests-result-pending'}`}>
              <div className="tests-card-header"><div className="tests-icon"><Icon size={22} strokeWidth={1.8} /></div>
                <div><span className="tests-family-label">{L(test.family, familyArabic[test.family] || test.family)} · {String(index + 1).padStart(2, '0')}</span>
                  <h2>{L(test.title, ar?.[0] || test.title)}</h2>
                  <p>{L(test.summary, ar?.[1] || test.summary)}</p>
                </div>
              </div>
              <details className="tests-scenario"><summary>{L('What happens', 'ماذا يحدث')}</summary>
                <dl><dt>{L('User said', 'قال المستخدم')}</dt><dd className="tests-quote">{test.task}</dd>
                  {test.page && <><dt>{L('Page said', 'قالت الصفحة')}</dt><dd className="tests-quote">{test.page}</dd></>}
                  <dt>{L('Approved', 'المُوافَق عليه')}</dt><dd>{test.mandate ? `${test.mandate.payee}, ${test.mandate.amount} ${test.mandate.currency}` : L('nothing', 'لا شيء')}</dd>
                  <dt>{L('Agent tries', 'يحاول الوكيل')}</dt><dd className="tests-mono">{test.calls.map((call, i) => <span key={i}>{i > 0 && <><br />{L('then again: ', 'ثم مرة أخرى: ')}</>}{`${call.payee}, ${call.amount} ${call.currency}`}</span>)}</dd>
                  <dt>{L('Expected', 'المتوقَّع')}</dt><dd>{verdict(test.expect)}</dd></dl>
                <p className="tests-note">{L(test.note, ar?.[2] || test.note)}</p>
              </details>
              {result && <div className="tests-reasons" aria-live="polite">
                {result.reasons?.length ? result.reasons.map((reason, i) => <div key={`${reason.id}-${i}`}><code>{reason.id}</code> {reason.message}</div>) : result.decision === 'allow' ? (result.paid ? L('allowed, the provider was paid', 'مسموح بها، تم الدفع لمزوّد الدفع') : L('allowed, the provider was called', 'مسموح بها، تم استدعاء مزوّد الدفع')) : result.decision === 'step_up' ? L('held for a person to approve', 'مُعلَّقة بانتظار شخص يوافق عليها') : L('refused', 'مرفوضة')}
              </div>}
              {outcome?.error && <p className="tests-error" role="alert">{outcome.error}</p>}
              <div className="tests-card-footer">
                {result && <span className={`tests-pill tests-${result.decision}`}>{result.decision === 'allow' ? <CheckCircle2 size={14} /> : <ShieldAlert size={14} />}{verdict(result.decision)}</span>}
                {result && <span className="tests-ms">{result.ms} ms</span>}
                <button type="button" className="tests-run" disabled={active} aria-label={result || outcome?.error ? L('Run this test again', 'أعد تشغيل هذا الاختبار') : L('Run this test', 'شغّل هذا الاختبار')} onClick={() => void runTests([test.id])}>{active ? <MoatWorkingMark /> : <Play size={18} fill="currentColor" />}</button>
              </div>
            </Card>
          })}
        </section>
      </div>
    </main>
    <Footer />
  </LiquidGlassProvider>
}
