import {
  useEffect,
  type CSSProperties,
  type ReactNode,
} from 'react'
import Footer from '../../components/layout/Footer'
import { L } from '../../i18n'
import BenchmarkChart from './BenchmarkChart'
import { LiquidGlassProvider } from '../../components/ui/liquid/liquid-glass-provider'
import SecurityFlow from './SecurityFlow'
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from '../../components/ui/glass/tabs'


import {
  FileCode2,
  ShieldCheck,
  ScanSearch,
  CheckCircle2,
  AlertTriangle,
  Info,
} from 'lucide-react'

import { Card } from '../../components/ui/glass/card'


function FlowArt() {
  return (
    <div className="flowart" aria-hidden="true">
      <svg viewBox="0 0 460 142">
        <line className="c-line c-wire" x1="70" y1="34" x2="198" y2="62" />
        <line className="c-line c-wire" x1="70" y1="92" x2="198" y2="64" />
        <line className="c-line c-wire" x1="262" y1="63" x2="348" y2="63" />
        <rect className="c-line" x="10" y="16" width="54" height="34" rx="11" />
        <circle cx="37" cy="27" r="5.4" fill="none" stroke="currentColor" strokeWidth="2.4" />
        <path className="c-ink" d="M28 43a9 9 0 0 1 18 0" />
        <text className="c-lbl" x="37" y="10">{L('USER', 'المستخدم')}</text>
        <rect className="c-line" x="10" y="76" width="54" height="34" rx="11" />
        <path className="c-ink" d="M26 86H48M26 93H42M26 100H46" />
        <text className="c-lbl" x="37" y="124">{L('TOOL', 'نتيجة')}<tspan x="37" dy="13">{L('RESULT', 'أداة')}</tspan></text>
        <text className="c-lbl" x="230" y="106">MOAT</text>
        <rect className="c-line" x="354" y="41" width="54" height="44" rx="13" />
        <rect x="366" y="53" width="30" height="20" rx="4" fill="none" stroke="currentColor" strokeWidth="2.2" />
        <path className="c-ink" d="M366 60H396" />
        <text className="c-lbl" x="381" y="106">{L('PAYEE', 'المستفيد')}</text>
        <g className="c-leg" style={{ '--dx': '126px', '--dy': '28px', animationDelay: '.2s' } as CSSProperties}><rect x="64" y="30" width="16" height="8" rx="4" fill="var(--ink-2)" /></g>
        <g className="c-leg" style={{ '--dx': '84px', '--dy': '0px', animationDelay: '1.3s' } as CSSProperties}><rect x="256" y="59" width="16" height="8" rx="4" fill="var(--green-l)" /></g>
        <g className="c-leg" style={{ '--dx': '126px', '--dy': '-28px', animationDelay: '6s' } as CSSProperties}><rect x="64" y="88" width="16" height="8" rx="4" fill="var(--ink-2)" /></g>
        <g className="c-leg" style={{ '--dx': '-100px', '--dy': '23px', animationDelay: '7s' } as CSSProperties}><rect x="182" y="62" width="16" height="8" rx="4" fill="var(--red-l)" /></g>
        <g transform="translate(175.28 18.37) scale(.3881)"><g className="c-gate" fill="none" stroke="var(--ink)" strokeWidth="10" strokeLinecap="round"><path d="M117 52.4A67 67 0 0 1 202.7 141.2" /><path d="M177.5 171.2A67 67 0 0 1 86.1 76.6" /></g></g>
        <g className="c-no"><circle cx="230" cy="63" r="9" fill="var(--red-l)" /><path d="m226.4 59.4 7.2 7.2m0-7.2-7.2 7.2" fill="none" stroke="#000" strokeWidth="2.2" strokeLinecap="round" /></g>
        <g className="c-paid"><circle cx="404" cy="45" r="8.5" fill="var(--green-l)" /><path d="m400.2 45 2.6 2.6 4.4-4.8" fill="none" stroke="#000" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></g>
      </svg>
    </div>
  )
}

/** [term, value, tone, term in Arabic, value in Arabic] */
type ProbeRow = [string, string, string, string, string]
const x402Rows: ProbeRow[] = [
  ['the destination the user approved', 'isValid: true', 'bad', 'الوجهة التي وافق عليها المستخدم', 'isValid: true'],
  ['an address the user never named', 'isValid: true', 'bad', 'عنوان لم يذكره المستخدم قط', 'isValid: true'],
  ['the same two, put to moat', 'allow, then deny', 'good', 'الاثنتان نفسهما، أمام moat', 'مسموح بها، ثم مرفوضة'],
]
const ap2Rows: ProbeRow[] = [
  ["a homoglyph merchant, against the user's allowlist", 'catches it', 'good', 'تاجر باسم متشابه الحروف، مقابل القائمة المسموح بها لدى المستخدم', 'يكتشفه'],
  ['499 where 480 was approved', 'verifies', 'bad', '499 بينما الموافقة على 480', 'يقبله'],
  ['an allowlist the agent wrote itself', 'verifies', 'bad', 'قائمة مسموح بها كتبها الوكيل بنفسه', 'يقبلها'],
]
const injectionRows: ProbeRow[] = [
  ['attacks that carry an instruction to find', '9 of 21', 'good', 'هجمات تحمل تعليمات يمكن رصدها', '9 من 21'],
  ['attacks with nothing in them to object to', '12 of 21', 'bad', 'هجمات ليس فيها ما يُعترض عليه', '12 من 21'],
]


export default function Compare() {


  useEffect(() => {
    document.title = L('moat, compared', 'moat، المقارنة')
  }, [])

  return (
<LiquidGlassProvider
  backdrop="/glass-backdrop.svg"
  options={{
    refraction: 16,
    dispersion: 0.035,
    frost: 8,
    liquid: false,
  }}
>
    <main id="main-content" tabIndex={-1} className="compare-page">
        <div className="wrap">
          <header className="hero"><p className="kicker">{L('Compared', 'المقارنة')}</p><h1>{L(<>It is not what<br /><span className="g">they check</span></>, <>ليست المسألة<br /><span className="g">ما يفحصونه</span></>)}</h1></header>
          <FlowArt />
          <section className="tight">


<div className="compare-benchmark-section">
  <div className="compare-security-flow-heading">
    <span
      className="compare-security-flow-rule"
      aria-hidden="true"
    />

    <h2>
      {L(
        'PUT THROUGH THE SAME 380 PAYMENTS',
        'اختُبرت عبر محاولات الدفع الـ 380 نفسها'
      )}
    </h2>

    <span
      className="compare-security-flow-rule"
      aria-hidden="true"
    />
  </div>

  <BenchmarkChart />
</div>

            <SecurityFlow />
          </section>





<section id="tested" className="tight moat-evidence-section">
  <div className="compare-security-flow-heading">
    <span
      className="compare-security-flow-rule"
      aria-hidden="true"
    />
    <h2>
      {L(
        'RUN AGAINST THEIR OWN CODE',
        'شُغّلت على شيفرتها نفسها'
      )}
    </h2>
    <span
      className="compare-security-flow-rule"
      aria-hidden="true"
    />
  </div>

  <Tabs defaultValue="x402" className="moat-evidence-tabs">

<TabsList
  variant="liquid"
  material="clear"
  glow={false}
  hover="none"
  className="moat-evidence-tabs-list"
>
  <TabsTrigger
    value="x402"
    className="moat-evidence-tab-trigger"
  >
    x402
  </TabsTrigger>

  <TabsTrigger
    value="ap2"
    className="moat-evidence-tab-trigger"
  >
    AP2
  </TabsTrigger>

  <TabsTrigger
    value="classifiers"
    className="moat-evidence-tab-trigger"
  >
    {L('Injection classifiers', 'مصنّفات حقن التعليمات')}
  </TabsTrigger>
</TabsList>


    <Card
      material="clear"
      tint="rgba(255, 135, 55, 0.18)"
      className="moat-evidence-card"
    >
      <TabsContent
        value="x402"
        className="moat-evidence-tabs-content"
      >
        <Probe
          title="x402"
          version={L(
            '@x402/core 2.26.0, balance and nonce stubbed',
            '@x402/core 2.26.0، مع محاكاة الرصيد والـ nonce'
          )}
          rows={x402Rows}
          note={L(
            <>
              <span className="mono">payTo</span> comes from
              the server being paid.
            </>,
            <>
              يأتي <span className="mono">payTo</span> من
              الخادم الذي يتلقّى الدفعة.
            </>
          )}
        />
      </TabsContent>

      <TabsContent
        value="ap2"
        className="moat-evidence-tabs-content"
      >
        <Probe
          title="AP2"
          version={L(
            'google-agentic-commerce/AP2, unmodified',
            'google-agentic-commerce/AP2، دون تعديل'
          )}
          rows={ap2Rows}
          note={L(
            'It checks the constraint, not who authored it',
            'يتحقّق من القيد، لا ممّن كتبه'
          )}
        />
      </TabsContent>

      <TabsContent
        value="classifiers"
        className="moat-evidence-tabs-content"
      >
        <Probe
          title={L(
            'Injection classifiers',
            'مصنّفات الحقن'
          )}
          version={L(
            'a detector that never misses, counted generously',
            'كاشف لا يُخطئ أبدًا، باحتساب متساهل'
          )}
          rows={injectionRows}
          note={L(
            'An invoice reading 499 is not lying about anything a reader could check',
            'فاتورة تقول 499 لا تكذب في شيء يستطيع القارئ التحقق منه'
          )}
        />
      </TabsContent>
    </Card>
  </Tabs>
</section>

        </div>
          </main>
      <Footer />
  </LiquidGlassProvider>

  )
}




function Probe({
  title,
  version,
  rows,
  note,
}: {
  title: string
  version: string
  rows: ProbeRow[]
  note: ReactNode
}) {
  const kind =
    title === 'x402'
      ? 'x402'
      : title === 'AP2'
        ? 'ap2'
        : 'classifiers'

  const EvidenceIcon =
    kind === 'x402'
      ? FileCode2
      : kind === 'ap2'
        ? ShieldCheck
        : ScanSearch

  const sectionTitle =
    kind === 'x402'
      ? L('PAYMENT DESTINATION TESTS', 'اختبارات وجهة الدفع')
      : kind === 'ap2'
        ? L('PAYMENT AUTHORIZATION TESTS', 'اختبارات تفويض الدفع')
        : L('INJECTION DETECTION TESTS', 'اختبارات كشف حقن التعليمات')

  const sectionMeta =
    kind === 'x402'
      ? 'x402 / CORE 2.26.0'
      : kind === 'ap2'
        ? 'AP2 / UNMODIFIED'
        : L('DETECTION', 'الكشف')

  return (
    <div className={`moat-evidence-panel moat-evidence-${kind}`}>
      <div className="moat-evidence-header">
        <div className="moat-evidence-header-main">
          <Card
            material="clear"
            tint="rgba(255, 135, 55, 0.18)"
            className="moat-evidence-header-icon"
            aria-hidden="true"
          >
            <EvidenceIcon size={28} strokeWidth={1.7} />
          </Card>

          <div className="moat-evidence-header-copy">
            <h3>{title}</h3>
            <p>{version}</p>
          </div>
        </div>

        <span className="moat-evidence-chip">
          <span
            className="moat-evidence-chip-dot"
            aria-hidden="true"
          />
          {L('TEST EVIDENCE', 'أدلة الاختبار')}
        </span>
      </div>

      <div className="moat-evidence-inner">
        <div className="moat-evidence-inner-heading">
          <span>{sectionTitle}</span>
          <span className="moat-evidence-inner-meta">
            {sectionMeta}
          </span>
        </div>

        <dl className="moat-evidence-test-list">
          {rows.map(
            ([term, value, tone, termAr, valueAr], index) => {
              const isGood = tone === 'good'
              const ResultIcon = isGood
                ? CheckCircle2
                : AlertTriangle

              return (
                <div
                  className="moat-evidence-test"
                  key={`${kind}-${index}`}
                >
                  <span
                    className="moat-evidence-test-number"
                    aria-hidden="true"
                  >
                    {String(index + 1).padStart(2, '0')}
                  </span>

                  <dt className="moat-evidence-test-description">
                    {L(term, termAr)}
                  </dt>

                  <dd
                    className={`moat-evidence-test-result ${
                      isGood ? 'is-good' : 'is-risk'
                    }`}
                  >
                    <ResultIcon
                      size={16}
                      strokeWidth={1.9}
                      aria-hidden="true"
                    />
                    <span>{L(value, valueAr)}</span>
                  </dd>
                </div>
              )
            }
          )}
        </dl>

        <div className="moat-evidence-footnote">
          <Info
            size={18}
            strokeWidth={1.7}
            aria-hidden="true"
          />
          <p>{note}</p>
        </div>
      </div>
    </div>
  )
}
