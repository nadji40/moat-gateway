import { Fragment, useEffect, type CSSProperties, type ReactNode } from 'react'
import Footer from '../../components/layout/Footer'
import { L } from '../../i18n'

const Icon = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
)

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

/* Each row holds its English and its Arabic; the language is picked at render. */
const rows = [
  ['Key-level policy', 'The transaction, not where the address came from', '370', 'bad', 'سياسة على مستوى المفتاح', 'المعاملة، لا مصدر العنوان'],
  ['Payee allowlists', 'The name on the call, not the account behind it', '190', 'bad', 'قوائم المستفيدين المسموح بها', 'الاسم في الطلب، لا الحساب الذي وراءه'],
  ['moat', 'Everything the agent reads, and the payment it then makes', '0', 'good', 'moat', 'كل ما يقرؤه الوكيل، والدفعة التي يجريها بعد ذلك'],
] as const
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

function ComparisonRow({ title, description, result, resultLabel, tone, icon, badge, us = false }: { title: string; description: string; result: string; resultLabel: string; tone: string; icon: ReactNode; badge?: string; us?: boolean }) {
  return <article className={`row ${us ? 'us' : ''}`}><span className="row-i">{icon}</span><div className="row-t"><h3>{title}{badge && <span className="row-e">{badge}</span>}</h3><p className="row-s">{description}</p></div><span className={`row-r ${tone}`}>{result}<i>{resultLabel}</i></span></article>
}

export default function Compare() {
  useEffect(() => {
    document.title = L('moat, compared', 'moat، المقارنة')
  }, [])

  return (
    <>
      <main className="compare-page">
        <div className="wrap">
          <header className="hero"><p className="kicker">{L('Compared', 'المقارنة')}</p><h1>{L(<>It is not what<br /><span className="g">they check</span></>, <>ليست المسألة<br /><span className="g">ما يفحصونه</span></>)}</h1></header>
          <FlowArt />
          <section className="tight">
            <p className="lbl">{L('Put through the same 380 payments', 'على الدفعات الـ380 نفسها')}</p>
            <div className="rows">
              {rows.map(([title, description, result, tone, titleAr, descriptionAr], index) => (
                <ComparisonRow key={title} us={title === 'moat'} title={L<string>(title, titleAr)} description={L<string>(description, descriptionAr)} result={result} resultLabel={L('paid', 'دُفعت')} tone={tone} icon={index === 0 ? <Icon><circle cx="8" cy="12" r="4" /><path d="M12 12h9M18 12v3.5M15.5 12v2.5" /></Icon> : index === 1 ? <Icon><path d="M4 20h16M4 16c3-6 5 2 8-3s4 1 8-4" /></Icon> : <svg viewBox="69 43 144 144" aria-hidden="true"><g fill="none" stroke="currentColor" strokeWidth="13" strokeLinecap="round"><path d="M117 52.4A67 67 0 0 1 202.7 141.2M177.5 171.2A67 67 0 0 1 86.1 76.6" /></g><g fill="currentColor"><circle cx="99.7" cy="62.2" r="12" /><circle cx="192.3" cy="158.1" r="12" /></g></svg>} />
              ))}
            </div>
            <p className="hint foot-note">{L(<>The 370 and the 190 are our own baseline arms. No vendor&apos;s product has been run.</>, <>الرقمان 370 و190 هما ذراعا خط الأساس لدينا. لم يُشغَّل منتج أي مورّد.</>)}</p>
            <p className="lbl gap">{L('Asked their own question', 'أمام السؤال الذي تطرحه هي')}</p>
            <div className="rows">
              <ComparisonRow title={L('Mandate protocols', 'بروتوكولات التفويض')} badge="AP2, x402" description={L('That approval happened, not who wrote it', 'أن الموافقة حصلت، لا من كتبها')} result={L('run', 'جُرّبت')} resultLabel={L('below', 'أدناه')} tone="warn" icon={<Icon><path d="m12 3 8 4v5c0 4.5-3.2 7.9-8 9-4.8-1.1-8-4.5-8-9V7zM9 11h6M9 14h4" /></Icon>} />
              <ComparisonRow title={L('Injection classifiers', 'مصنّفات الحقن')} description={L('An instruction, when the content carries one', 'التعليمات، حين يحملها المحتوى')} result="12" resultLabel={L('of 21 blind', 'من 21 دون رصد')} tone="warn" icon={<Icon><path d="M4 5h16l-6 7v6l-4 2v-8z" /></Icon>} />
              <ComparisonRow title={L('MCP gateways', 'بوابات MCP')} description={L('Every call. It simply never decides a payment.', 'كل طلب. لكنها لا تبتّ في أي دفعة.')} result={L('no', 'لا')} resultLabel={L('verdict', 'حكم')} tone="warn" icon={<Icon><circle cx="12" cy="12" r="2.6" /><path d="M12 4v5M12 15v5M4 12h5M15 12h5" /></Icon>} />
            </div>
          </section>
          <section id="tested" className="tight">
            <div className="headrow"><h2>{L('Run against their own code', 'شُغّلت على شيفرتها نفسها')}</h2></div>
            <div className="probes">
              <Probe title="x402" version={L('@x402/core 2.26.0, balance and nonce stubbed', '@x402/core 2.26.0، مع محاكاة الرصيد والـ nonce')} rows={x402Rows} note={L(<><span className="mono">payTo</span> comes from the server being paid.</>, <>يأتي <span className="mono">payTo</span> من الخادم الذي يتلقّى الدفعة.</>)} />
              <Probe title="AP2" version={L('google-agentic-commerce/AP2, unmodified', 'google-agentic-commerce/AP2، دون تعديل')} rows={ap2Rows} note={L('It checks the constraint, not who authored it', 'يتحقّق من القيد، لا ممّن كتبه')} />
              <Probe title={L('Injection classifiers', 'مصنّفات الحقن')} version={L('a detector that never misses, counted generously', 'كاشف لا يُخطئ أبدًا، باحتساب متساهل')} rows={injectionRows} note={L('An invoice reading 499 is not lying about anything a reader could check', 'فاتورة تقول 499 لا تكذب في شيء يستطيع القارئ التحقق منه')} />
            </div>
          </section>
        </div>
      </main>
      <Footer />
    </>
  )
}

function Probe({ title, version, rows, note }: { title: string; version: string; rows: ProbeRow[]; note: ReactNode }) {
  return <div className="probe glass"><div className="probe-h"><h3>{title}</h3><span className="probe-v">{version}</span></div><dl className="probe-r">{rows.map(([term, value, tone, termAr, valueAr]) => <Fragment key={term}><dt>{L(term, termAr)}</dt><dd className={tone}>{L(value, valueAr)}</dd></Fragment>)}</dl><p className="probe-n">{note}</p></div>
}
