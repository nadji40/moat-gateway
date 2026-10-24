import { useEffect, useRef, useState } from 'react'
import Footer from '../../components/layout/Footer'
import { L } from '../../i18n'

/** The public API, from wherever the page is served. */
function apiBase(): string {
  if (typeof window === 'undefined') return 'https://api.moatgateway.dpdns.org'
  return window.location.hostname === 'moatgateway.dpdns.org'
    ? 'https://api.moatgateway.dpdns.org'
    : window.location.origin
}

/** [id, English label, Arabic label]; the label is picked at render. */
const SECTIONS = [
  ['overview', 'Overview', 'نظرة عامة'],
  ['verdicts', 'How a payment is decided', 'كيف يُحكم على الدفعة'],
  ['quickstart', 'Quickstart', 'البدء السريع'],
  ['connect', 'Connect an agent', 'ربط وكيل'],
  ['keys', 'Keys and roles', 'المفاتيح والأدوار'],
  ['intent', 'What the user asked for', 'ما طلبه المستخدم'],
  ['approvals', 'Approvals', 'الموافقات'],
  ['holds', 'Held payments', 'الدفعات المُعلَّقة'],
  ['evidence', 'Evidence', 'الأدلة'],
  ['policy', 'Policy reference', 'مرجع السياسة'],
  ['rules', 'Rule ids', 'معرّفات القواعد'],
  ['languages', 'Languages and currencies', 'اللغات والعملات'],
  ['selfhost', 'Self-hosting', 'الاستضافة الذاتية'],
] as const

/** A code block with a copy button. Plain text in, no HTML. */
function Code({ children, lang }: { children: string; lang?: string }) {
  const [state, setState] = useState<'copy' | 'copied' | 'select'>('copy')
  const pre = useRef<HTMLPreElement>(null)
  async function copy() {
    const text = pre.current?.textContent ?? ''
    let ok = false
    try { if (navigator.clipboard && isSecureContext) { await navigator.clipboard.writeText(text); ok = true } } catch { ok = false }
    setState(ok ? 'copied' : 'select')
    setTimeout(() => setState('copy'), 1600)
  }
  const label = state === 'copied' ? L('Copied', 'تم النسخ') : state === 'select' ? L('Select and copy', 'حدّد وانسخ') : L('Copy', 'نسخ')
  return (
    <div className="codewrap">
      <div className="codebar">
        {lang && <span className="codebar-lbl">{lang}</span>}
        <span className="codebar-sp" />
        <button type="button" className="chip docs-copy" onClick={copy} aria-label={L('Copy to clipboard', 'نسخ إلى الحافظة')}>{label}</button>
      </div>
      <pre className="glass docs-code" ref={pre}>{children}</pre>
    </div>
  )
}

function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="tblwrap gl-panel">
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
    document.title = L('moat, documentation', 'moat، التوثيق')
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

  // A link to a section (/docs#quickstart) arrives before the page has drawn
  // it, so the browser has nothing to scroll to; go there once it exists.
  useEffect(() => {
    const id = decodeURIComponent(location.hash.slice(1))
    if (id) document.getElementById(id)?.scrollIntoView({ behavior: 'instant', block: 'start' })
  }, [])

  const H = `-H 'content-type: application/json'`

  return (
    <>
      <div className="docs-page gl-glow top">
      <main className="docs wrap">
        <aside className="docs-nav gl-board" aria-label={L('On this page', 'في هذه الصفحة')}>
          <p className="docs-k">{L('Documentation', 'التوثيق')}</p>
          {SECTIONS.map(([id, label, labelAr]) => (
            <a key={id} href={`#${id}`} aria-current={active === id ? 'true' : undefined}>{L<string>(label, labelAr)}</a>
          ))}
        </aside>

        <article className="docs-body">
          <header className="docs-head">
            <p className="kicker">{L('Documentation', 'التوثيق')}</p>
            <h1>{L(<>Moat, from first call <span className="gl-grad">to production</span></>, <>Moat، من أول طلب <span className="gl-grad">إلى الإنتاج</span></>)}</h1>
            <p className="lede docs-lede gl-panel">{L(<>Everything here runs against the public API at <code>{base}</code>. The sandbox needs no key. A workspace does.</>, <>كل ما هنا يعمل على الواجهة البرمجية العامة في <code>{base}</code>. لا تحتاج بيئة التجربة إلى مفتاح، أما مساحة العمل فتحتاج إليه.</>)}</p>
          </header>

          <section id="overview">
            <h2>{L('Overview', 'نظرة عامة')}</h2>
            <p>{L(<>Moat is an authorization layer between an AI agent and whatever moves money for it: a card provider, a bank, or a payment on chain. It runs as an MCP proxy, so one process sees both the content the agent reads as tool results and the payment it then tries to make as a tool call. That is the one place where it is still possible to tell which of the two a payee came from.</>, <>Moat طبقة موافقة بين وكيل الذكاء الاصطناعي وأي جهة تنقل المال نيابةً عنه: مزوّد بطاقات، أو بنك، أو دفع على السلسلة. يعمل وسيطَ MCP، فترى عملية واحدة المحتوى الذي يقرؤه الوكيل في نتائج الأدوات، والدفعة التي يحاول إجراءها بعد ذلك عبر استدعاء أداة. وهذا هو الموضع الوحيد الذي لا يزال ممكنًا فيه معرفة أيّ الاثنين جاء منه المستفيد.</>)}</p>
            <p>{L(<>Every payment call returns a verdict, <code>allow</code>, <code>step_up</code> or <code>deny</code>, together with a signed evidence record of how it was reached. Nothing reaches the provider on a <code>step_up</code> or a <code>deny</code>.</>, <>كل طلب دفع يعيد حكمًا، <code>allow</code> أو <code>step_up</code> أو <code>deny</code>، ومعه سجل أدلة موقَّع يبيّن كيف صدر. ولا يصل شيء إلى مزوّد الدفع عند <code>step_up</code> أو <code>deny</code>.</>)}</p>
            <p>{L(<>Three things feed a verdict: what the user asked for, registered through the intent API; what an approver signed, registered as an authorization; and the workspace policy, which sets the limits and the rules.</>, <>ثلاثة أمور يُبنى عليها الحكم: ما طلبه المستخدم، ويُسجَّل عبر واجهة intent البرمجية؛ وما وقّعه المُوافِق، ويُسجَّل موافقةً (authorization)؛ وسياسة مساحة العمل، التي تحدد الحدود والقواعد.</>)}</p>
          </section>

          <section id="verdicts">
            <h2>{L('How a payment is decided', 'كيف يُحكم على الدفعة')}</h2>
            <p>{L(<>Each field of a payment, the payee, the amount, the currency and the invoice, is traced to where it came from: the user's own request, a signed approval, the allowlist, or a tool result the agent read. The policy says which sources are acceptable for each field and what happens when a field fails.</>, <>كل حقل في الدفعة، المستفيد والمبلغ والعملة والفاتورة، يُتتبَّع إلى مصدره: طلب المستخدم نفسه، أو موافقة موقَّعة، أو القائمة المسموح بها، أو نتيجة أداة قرأها الوكيل. وتحدد السياسة المصادر المقبولة لكل حقل، وما يحدث حين يفشل حقل.</>)}</p>
            <Table head={[L('verdict', 'الحكم'), L('meaning', 'المعنى'), L('what happens', 'ما يحدث')]} rows={[
              ['allow', L('Every field traced to the user, an approval or the allowlist, within the limits.', 'مسموح بها. كل حقل يعود إلى المستخدم أو إلى موافقة أو إلى القائمة المسموح بها، ضمن الحدود.'), L('The call is forwarded to the provider.', 'يُمرَّر الطلب إلى مزوّد الدفع.')],
              ['step_up', L('Something could be right but cannot be confirmed: a payee from a web page, a currency the user did not name, an amount nobody asked for.', 'مُعلَّقة. أمر قد يكون صحيحًا لكن لا يمكن تأكيده: مستفيد من صفحة ويب، أو عملة لم يذكرها المستخدم، أو مبلغ لم يطلبه أحد.'), L('The call is held. An approver releases or refuses it with the resume token.', 'يُعلَّق الطلب. ويُفرج عنه المُوافِق أو يرفضه برمز الاستئناف.')],
              ['deny', L('A hard rule failed: over the cap, a reused approval, a currency with no rate, a mismatch with the approval it carries.', 'مرفوضة. فشلت قاعدة صارمة: تجاوز الحد، أو موافقة مُعاد استخدامها، أو عملة بلا سعر صرف، أو عدم تطابق مع الموافقة التي يحملها الطلب.'), L('The call stops. The agent gets the reasons back.', 'يتوقف الطلب. ويتلقى الوكيل الأسباب.')],
            ]} />
            <p>{L(<>With nobody to ask, <code>step_up</code> degrades to the policy's <code>no_human_available</code>, which is <code>deny</code> in the default policy.</>, <>حين لا يوجد من يُسأل، يتحول <code>step_up</code> إلى قيمة <code>no_human_available</code> في السياسة، وهي <code>deny</code> في السياسة الافتراضية.</>)}</p>
          </section>

          <section id="quickstart">
            <h2>{L('Quickstart', 'البدء السريع')}</h2>
            <p>{L(<>The sandbox gives you a gateway of your own with a mock provider, so nothing can move money. No key, no account. Five calls show the whole idea: the user asks for one payee, an approver signs it, and the agent tries to pay somebody else.</>, <>تمنحك بيئة التجربة بوابة خاصة بك مع مزوّد دفع وهمي، فلا يمكن لشيء أن ينقل المال. بلا مفتاح ولا حساب. خمسة طلبات تُظهر الفكرة كلها: يطلب المستخدم مستفيدًا واحدًا، ويوقّع المُوافِق عليه، ثم يحاول الوكيل الدفع لشخص آخر.</>)}</p>
            <Code lang="bash">{`# a sandbox of your own
S=$(curl -s -XPOST ${base}/v1/sandbox | jq -r .id)

# what the user asked for
curl -s -XPOST ${base}/v1/sandbox/$S/intent ${H} \\
  -d '{"text":"Pay the Al Noor Supplies invoice INV-4471 for 480 SAR."}'

# what an approver signed off
A=$(curl -s -XPOST ${base}/v1/sandbox/$S/authorization ${H} \\
  -d '{"payee":"Al Noor Supplies","amount":"480","currency":"SAR"}')

# now try to pay someone else with that approval
P=$(echo "$A" | jq -c '{payee:"Nova Studio",amount:480,currency:"SAR",authorization_id,invoice_id}')
curl -s -XPOST ${base}/v1/sandbox/$S/pay ${H} -d "$P"

# the signed record of why
curl -s -XGET ${base}/v1/sandbox/$S/evidence

# hand the sandbox back
curl -s -XDELETE ${base}/v1/sandbox/$S`}</Code>
            <p>{L(<>The pay call comes back <code>deny</code> with the rule <code>authorization-payee</code>: the recipient does not match the approval. <code>GET /v1/limits</code> says what a sandbox may do, and <code>GET /v1/tests</code> returns the nine attacks the <a href="/tests">tests page</a> runs, as data.</>, <>يعود طلب الدفع بالحكم <code>deny</code> مع القاعدة <code>authorization-payee</code>: المستلم لا يطابق الموافقة. يبيّن <code>GET /v1/limits</code> ما يُسمح لبيئة التجربة بفعله، ويعيد <code>GET /v1/tests</code> الهجمات التسع التي تشغّلها <a href="/tests">صفحة الاختبارات</a>، على هيئة بيانات.</>)}</p>
          </section>

          <section id="connect">
            <h2>{L('Connect an agent', 'ربط وكيل')}</h2>
            <p>{L(<>A workspace holds your keys and every verdict made with them. Open one on the <a href="/dashboard">dashboard</a>; it gives you an admin key, shown once. Then issue an <strong>agent</strong> key and point your MCP client at the gateway, with the key as a bearer token.</>, <>تحفظ مساحة العمل مفاتيحك وكل حكم صدر بها. أنشئ واحدة من <a href="/dashboard">لوحة التحكم</a>؛ وستمنحك مفتاح admin يُعرض مرة واحدة. ثم أصدر مفتاحًا للوكيل (<strong>agent</strong>) ووجّه عميل MCP لديك إلى البوابة، مع المفتاح رمزًا من نوع bearer.</>)}</p>
            <Code lang="bash">{`curl -s ${base}/mcp \\
  -H 'authorization: Bearer YOUR_AGENT_KEY' \\
  -H 'content-type: application/json' \\
  -H 'accept: application/json, text/event-stream' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"you","version":"1"}}}'`}</Code>
            <p>{L(<>The reply carries the session id in the <code>Mcp-Session-Id</code> header. Later requests echo it. The agent then calls payment tools as usual; Moat decides each call and forwards or refuses it. The agent never needs to know Moat is there, and it never holds a key that could register intent or approve a payment.</>, <>يحمل الرد معرّف الجلسة في الترويسة <code>Mcp-Session-Id</code>، وتعيده الطلبات اللاحقة. ثم يستدعي الوكيل أدوات الدفع كالمعتاد؛ ويحكم Moat في كل طلب فيمرّره أو يرفضه. لا يحتاج الوكيل أبدًا إلى معرفة وجود Moat، ولا يحمل أبدًا مفتاحًا يستطيع تسجيل ما طلبه المستخدم أو الموافقة على دفعة.</>)}</p>
          </section>

          <section id="keys">
            <h2>{L('Keys and roles', 'المفاتيح والأدوار')}</h2>
            <p>{L('Three roles, and they do not overlap. A key can carry the whole role or a subset of its scopes; the gateway refuses anything the key was not given.', 'ثلاثة أدوار لا تتداخل. يمكن أن يحمل المفتاح الدور كاملًا أو جزءًا من صلاحياته؛ وترفض البوابة كل ما لم يُمنح للمفتاح.')}</p>
            <Table head={[L('role', 'الدور'), L('who holds it', 'من يحمله'), L('scopes', 'الصلاحيات')]} rows={[
              ['agent', L('The agent. It can only spend, and only within what was asked and approved.', 'الوكيل. لا يستطيع إلا الإنفاق، وضمن ما طُلب وتمت الموافقة عليه فقط.'), 'rail:card, rail:bank, rail:crypto'],
              ['approver', L('Your own application: the code that owns the chat box or the approval screen.', 'المُوافِق: تطبيقك أنت، أي الشيفرة التي تملك صندوق المحادثة أو شاشة الموافقة.'), 'intent:write, authorizations:write, holds:release, evidence:read'],
              ['admin', L('Whoever manages the workspace. Cannot pay or approve.', 'المدير: من يدير مساحة العمل. لا يستطيع الدفع ولا الموافقة.'), 'keys:read, keys:write, usage:read, verdicts:read'],
            ]} />
            <p>{L('Keys are issued and revoked on the dashboard. The server keeps a hash, never the key, so a key cannot be shown twice.', 'تُصدَر المفاتيح وتُلغى من لوحة التحكم. يحتفظ الخادم بتجزئة المفتاح لا بالمفتاح نفسه، لذا لا يمكن عرض المفتاح مرتين.')}</p>
            <p>{L(<>A key can also be issued for a set time: give <code>expires_in_days</code> (1 to 3650) when you create it, or pick an expiry on the dashboard. Past it, the key is refused everywhere, as if it had been revoked, and stays in the list marked expired. Leave it out and the key does not expire.</>, <>يمكن أيضًا إصدار مفتاح لمدة محدّدة: مرّر <code>expires_in_days</code> (من 1 إلى 3650) عند إنشائه، أو اختر مدة الانتهاء من لوحة التحكم. بعدها يُرفض المفتاح في كل مكان كأنه أُلغي، ويبقى في القائمة موسومًا بأنه منتهٍ. وإن لم تحدّد مدة فلا ينتهي المفتاح.</>)}</p>
          </section>

          <section id="intent">
            <h2>{L('What the user asked for', 'ما طلبه المستخدم')}</h2>
            <p>{L(<>Moat cannot see the user's request in the MCP stream, because the host never sends it there. Your application registers it, once per user turn, with an approver key. <strong>Without a registered intent nothing can have come from the user, so every payment is held or refused.</strong></>, <>لا يستطيع Moat رؤية طلب المستخدم في تدفق MCP، لأن المضيف لا يرسله إليه أصلًا. يسجّله تطبيقك، مرة في كل دور للمستخدم، بمفتاح المُوافِق. <strong>من دون تسجيل ما طلبه المستخدم لا يمكن أن يكون أي شيء قد جاء منه، فتُعلَّق كل دفعة أو تُرفض.</strong></>)}</p>
            <Code lang="http">{`POST /v1/session/{id}/intent
authorization: Bearer YOUR_APPROVER_KEY

{ "text": "Pay the Al Noor Supplies invoice INV-4471 for 480 SAR." }`}</Code>
            <p>{L('Send the words, the fields, or both. Fields are the strongest: a checkout or a form that already knows what was confirmed sends it exactly.', 'أرسل النص، أو الحقول، أو كليهما. الحقول هي الأقوى: صفحة الدفع أو النموذج الذي يعرف مسبقًا ما تم تأكيده يرسله كما هو تمامًا.')}</p>
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
            <p>{L('Text sent alone is read by a small language model beside the gateway. Every value it returns is checked against the message before it counts: a payee must be written there, an amount must be a number the message contains, a currency must be backed by a code or an unambiguous sign. What fails a check is dropped and reported, so a misreading costs a confirmation, never a payment. The reply says who read it:', 'النص المرسل وحده يقرؤه نموذج لغوي صغير بجوار البوابة. وكل قيمة يعيدها تُطابَق مع الرسالة قبل أن تُحتسب: يجب أن يكون المستفيد مكتوبًا فيها، وأن يكون المبلغ رقمًا واردًا فيها، وأن تستند العملة إلى رمز أو علامة لا لبس فيها. ما يفشل في التحقق يُسقَط ويُبلَّغ عنه، فالقراءة الخاطئة تكلّف تأكيدًا، لا دفعة. ويبيّن الرد من قرأ النص:')}</p>
            <Code lang="json">{`{ "session": "s_…", "turn": 1, "read_by": "model",
  "fields": { "pay": ["Al Noor Supplies"], "amounts": ["480"], "currencies": ["SAR"], "references": ["INV-4471"] },
  "dropped": [] }`}</Code>
            <p>{L(<><code>read_by</code> is <code>caller</code> when you sent fields, <code>model</code> when the reader read the text, and <code>rules</code> when the model was unavailable and the gateway's own rules read it instead. A client that needs the model checks this value.</>, <>تكون قيمة <code>read_by</code> هي <code>caller</code> حين ترسل الحقول، و<code>model</code> حين يقرأ القارئ النص، و<code>rules</code> حين لا يكون النموذج متاحًا فتقرؤه قواعد البوابة نفسها بدلًا منه. والعميل الذي يحتاج إلى النموذج يتحقق من هذه القيمة.</>)}</p>
          </section>

          <section id="approvals">
            <h2>{L('Approvals', 'الموافقات')}</h2>
            <p>{L('An approval is what a person signed off: a payee, an amount, a currency, and usually an invoice. A payment that carries one is checked against it field by field.', 'الموافقة هي ما أقرّه شخص بتوقيعه: مستفيد، ومبلغ، وعملة، وفاتورة في الغالب. والدفعة التي تحمل موافقة تُطابَق معها حقلًا حقلًا.')}</p>
            <Code lang="http">{`POST /v1/session/{id}/authorizations
authorization: Bearer YOUR_APPROVER_KEY

{ "authorization_id": "auth-1", "invoice_id": "INV-4471",
  "payee": "Al Noor Supplies", "amount": "480", "currency": "SAR",
  "expires_at": "2030-01-01T00:00:00Z" }`}</Code>
            <p>{L(<>One approval is one payment. Using it again, for another payee or the same one, is refused. Splitting a payment into pieces does not help: payments without an approval also meet a session total. An approval can be cancelled with <code>POST /v1/session/{'{id}'}/authorizations/{'{authorization_id}'}/cancel</code>.</>, <>الموافقة الواحدة لدفعة واحدة. واستخدامها مرة أخرى، لمستفيد آخر أو للمستفيد نفسه، مرفوض. ولا يفيد تقسيم الدفعة إلى أجزاء: فالدفعات التي بلا موافقة تخضع أيضًا لإجمالي الجلسة. ويمكن إلغاء الموافقة عبر <code>POST /v1/session/{'{id}'}/authorizations/{'{authorization_id}'}/cancel</code>.</>)}</p>
          </section>

          <section id="holds">
            <h2>{L('Held payments', 'الدفعات المُعلَّقة')}</h2>
            <p>{L(<>A <code>step_up</code> verdict returns a single-use <code>resume_token</code> to the agent. Your application shows the proposal to a person and answers with their decision:</>, <>يعيد الحكم <code>step_up</code> إلى الوكيل رمز <code>resume_token</code> صالحًا لمرة واحدة. يعرض تطبيقك الدفعة المقترحة على شخص، ثم يردّ بقراره:</>)}</p>
            <Code lang="http">{`POST /v1/session/{id}/resume
authorization: Bearer YOUR_APPROVER_KEY   (scope holds:release)

{ "resume_token": "…", "approved": true }`}</Code>
            <p>{L(<>With <code>approved: true</code>, the exact proposal the person saw is allowed once: the agent retries the same call and it goes through; a second identical call is held again. Approving a payment does not open its payee for the rest of the session. If no person is available, <code>POST /v1/session/{'{id}'}/headless</code> with <code>{'{ "headless": true }'}</code> tells Moat so, and holds become the policy's <code>no_human_available</code>.</>, <>مع <code>approved: true</code> يُسمح مرة واحدة بالمقترح نفسه الذي رآه الشخص تمامًا: يعيد الوكيل الطلب نفسه فيمرّ، أما طلب ثانٍ مطابق فيُعلَّق من جديد. والموافقة على دفعة لا تفتح مستفيدها لبقية الجلسة. وإذا لم يتوفر أي شخص، فإن <code>POST /v1/session/{'{id}'}/headless</code> مع <code>{'{ "headless": true }'}</code> يُبلغ Moat بذلك، فتصير الدفعات المُعلَّقة إلى قيمة <code>no_human_available</code> في السياسة.</>)}</p>
          </section>

          <section id="evidence">
            <h2>{L('Evidence', 'الأدلة')}</h2>
            <p>{L('Every verdict is written to a hash-chained, signed record: the call, where each field came from, every rule and whether it passed, and the outcome. Editing, dropping or reordering a record breaks the chain.', 'يُكتب كل حكم في سجل موقَّع مُتسلسل بالتجزئة: الطلب، ومصدر كل حقل، وكل قاعدة وهل نجحت، والنتيجة. وتعديل سجل أو حذفه أو تغيير ترتيبه يكسر السلسلة.')}</p>
            <Code lang="http">{`GET /v1/session/{id}/evidence        every record of the session, in order
GET /v1/session/{id}/outcomes        what the provider did with each allowed payment
GET /v1/outcomes                     the same, across the workspace`}</Code>
            <p>{L(<>The dashboard's verdict panel shows the same records with the rules in words. The <code>evidence_id</code> on a verdict is the handle for all of it.</>, <>تعرض لوحة الأحكام في لوحة التحكم السجلات نفسها مع شرح القواعد بالكلمات. و<code>evidence_id</code> في الحكم هو المرجع إلى ذلك كله.</>)}</p>
          </section>

          <section id="policy">
            <h2>{L('Policy reference', 'مرجع السياسة')}</h2>
            <p>{L('A policy is a YAML file per gateway. This is the shape of the one the public gateway runs.', 'السياسة ملف YAML لكل بوابة. وهذا شكل السياسة التي تعمل بها البوابة العامة.')}</p>
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
            <Table head={[L('key', 'المفتاح'), L('meaning', 'المعنى')]} rows={[
              ['payment_tools', L('The tools that move money. A tool in neither list is refused and hidden from the agent.', 'الأدوات التي تنقل المال. والأداة غير الموجودة في أي من القائمتين تُرفض وتُخفى عن الوكيل.')],
              ['fields', L('Which call arguments are the payee, the amount and the currency.', 'أيّ وسائط الطلب هي المستفيد والمبلغ والعملة.')],
              ['allowlist.payees', L('Names trusted as recipients. An allowlisted payee still needs the user to have asked for a payment.', 'أسماء موثوقة بصفتها مستلمين. والمستفيد الموجود في القائمة المسموح بها يحتاج مع ذلك إلى أن يكون المستخدم قد طلب الدفع.')],
              ['rules[].require_source', L('Where a field may come from: User, Allowlist, ToolResult, Authorization.', 'المصادر التي يجوز أن يأتي منها الحقل: User، Allowlist، ToolResult، Authorization.')],
              ['rules[].max', L('A cap on the amount, in the fx base currency.', 'حدّ أعلى للمبلغ، بالعملة الأساسية في fx.')],
              ['rules[].on_fail', L('step_up or deny.', 'step_up أو deny.')],
              ['velocity', L('Calls per session and per minute, and a total for payments made without an approval.', 'عدد الطلبات لكل جلسة ولكل دقيقة، وإجمالي للدفعات التي تتم بلا موافقة.')],
              ['fx', L('The base currency and the rate of every other one. A currency with no rate fails the caps.', 'العملة الأساسية وسعر صرف كل عملة أخرى. والعملة التي بلا سعر لا تجتاز الحدود.')],
              ['no_human_available', L('What step_up becomes when the session is headless.', 'ما يتحول إليه step_up حين تكون الجلسة بلا شخص (headless).')],
            ]} />
          </section>

          <section id="rules">
            <h2>{L('Rule ids', 'معرّفات القواعد')}</h2>
            <p>{L(<>The ids that appear in a verdict's reasons and in the evidence. The dashboard shows them in words.</>, <>المعرّفات التي تظهر في أسباب الحكم وفي الأدلة. وتعرضها لوحة التحكم بالكلمات.</>)}</p>
            <Table head={[L('id', 'المعرّف'), L('it fails when', 'تفشل حين')]} rows={[
              ['payee-provenance', L('The payee did not come from the user or an approval.', 'لم يأتِ المستفيد من المستخدم أو من موافقة.')],
              ['amount-provenance', L('The amount did not come from the user or an approval.', 'لم يأتِ المبلغ من المستخدم أو من موافقة.')],
              ['user-request', L('Nothing in the payment traces to what the user asked for.', 'لا شيء في الدفعة يعود إلى ما طلبه المستخدم.')],
              ['intent-currency', L('The user named a currency and the payment is in another, or the user named none and the payment names one.', 'ذكر المستخدم عملة والدفعة بعملة أخرى، أو لم يذكر أي عملة والدفعة تحدد عملة.')],
              ['intent-invoice', L('The user named an invoice and the payment settles a different one.', 'ذكر المستخدم فاتورة والدفعة تسدّد فاتورة أخرى.')],
              ['absolute-spending-cap', L('The amount, valued in the base currency, is over the cap.', 'المبلغ، مقوَّمًا بالعملة الأساسية، يتجاوز حدّ الإنفاق.')],
              ['amount-precision', L('The amount has more decimals than its currency.', 'في المبلغ منازل عشرية أكثر مما تسمح به عملته.')],
              ['session-total', L('Payments without an approval add up past the session total.', 'مجموع الدفعات التي بلا موافقة يتجاوز إجمالي الجلسة.')],
              ['authorization-payee', L('The payee does not match the approval the payment carries.', 'المستفيد لا يطابق الموافقة التي تحملها الدفعة.')],
              ['authorization-amount', L('The amount does not match the approval.', 'المبلغ لا يطابق الموافقة.')],
              ['authorization-currency', L('The currency does not match the approval.', 'العملة لا تطابق الموافقة.')],
              ['authorization-invoice', L('The invoice does not match the approval.', 'الفاتورة لا تطابق الموافقة.')],
              ['authorization-usage', L('The approval was already used.', 'سبق استخدام الموافقة.')],
              ['authorization-duplicate', L('The same invoice was already paid.', 'سبق دفع الفاتورة نفسها.')],
              ['authorization-expiry', L('The approval has expired.', 'انتهت صلاحية الموافقة.')],
              ['authorization-recipient-account', L('The account does not match the approval.', 'الحساب لا يطابق الموافقة.')],
              ['authorization-network', L('The on-chain network does not match the approval.', 'الشبكة على السلسلة لا تطابق الموافقة.')],
            ]} />
          </section>

          <section id="languages">
            <h2>{L('Languages and currencies', 'اللغات والعملات')}</h2>
            <p>{L('The reader takes the message as the user wrote it: English, French, Arabic, including Gulf and Maghrebi dialects, and the other languages the model knows. Arabic-Indic digits are read as digits. Amounts keep the decimal conventions of the message.', 'يأخذ القارئ الرسالة كما كتبها المستخدم: بالإنجليزية أو الفرنسية أو العربية، بما فيها اللهجات الخليجية والمغاربية، وباللغات الأخرى التي يعرفها النموذج. وتُقرأ الأرقام العربية الهندية أرقامًا. وتحتفظ المبالغ بأعراف الكسور العشرية المتّبعة في الرسالة.')}</p>
            <p>{L(<>A currency counts only when the message backs it. A code (<code>SAR</code>, <code>EUR</code>) or an unambiguous sign counts: <code>SR</code>, <code>ر.س</code> and <code>ريال سعودي</code> are Saudi riyals; <code>KD</code> and <code>د.ك</code> are Kuwaiti dinars; <code>Dhs</code> and <code>د.إ</code> are UAE dirhams; <code>QR</code> is Qatari riyals; <code>دج</code> and <code>DA</code> are Algerian dinars; <code>TL</code> and <code>₺</code> are Turkish lira. A bare <code>ريال</code>, <code>دينار</code> or <code>درهم</code> could be several currencies, so it is dropped and the payment is held for a person rather than guessed.</>, <>لا تُحتسب العملة إلا إذا استندت إليها الرسالة. يُحتسب الرمز (<code>SAR</code>، <code>EUR</code>) أو العلامة التي لا لبس فيها: <code>SR</code> و<code>ر.س</code> و<code>ريال سعودي</code> تعني الريال السعودي؛ و<code>KD</code> و<code>د.ك</code> تعني الدينار الكويتي؛ و<code>Dhs</code> و<code>د.إ</code> تعني الدرهم الإماراتي؛ و<code>QR</code> يعني الريال القطري؛ و<code>دج</code> و<code>DA</code> تعني الدينار الجزائري؛ و<code>TL</code> و<code>₺</code> تعني الليرة التركية. أما <code>ريال</code> أو <code>دينار</code> أو <code>درهم</code> وحدها فقد تدل على عدة عملات، لذا تُسقَط وتُعلَّق الدفعة بانتظار شخص بدلًا من التخمين.</>)}</p>
          </section>

          <section id="selfhost">
            <h2>{L('Self-hosting', 'الاستضافة الذاتية')}</h2>
            <p>{L(<>Moat is a single Rust binary, <code>moat-gateway</code>, with an optional PostgreSQL database for durable state and an optional <code>moat-intent</code> reader beside it. A minimal <code>moat.yaml</code>:</>, <>Moat ملف تنفيذي واحد مكتوب بلغة Rust، هو <code>moat-gateway</code>، مع قاعدة بيانات PostgreSQL اختيارية للحالة الدائمة، وقارئ <code>moat-intent</code> اختياري بجانبه. وهذا ملف <code>moat.yaml</code> في حدّه الأدنى:</>)}</p>
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
            <Table head={[L('key', 'المفتاح'), L('meaning', 'المعنى'), L('default', 'الافتراضي')]} rows={[
              ['listen', L('stdio, or http with an address. Loopback only unless auth is required.', 'stdio، أو http مع عنوان. على عنوان loopback فقط ما لم تكن المصادقة مطلوبة.'), 'stdio'],
              ['upstreams', L('The MCP servers behind Moat, each with a unique name.', 'خوادم MCP التي تقف خلف Moat، لكلٍّ منها اسم فريد.'), L('required', 'إلزامي')],
              ['policy', L('The policy file.', 'ملف السياسة.'), L('none: payments denied', 'لا شيء: الدفعات مرفوضة')],
              ['intent_api.addr', L('Where the intent API listens.', 'العنوان الذي تستمع عليه واجهة intent.'), L('none: no intents', 'لا شيء: لا يُسجَّل ما طلبه المستخدم')],
              ['intent_api.reader', L('The moat-intent service that reads text into fields.', 'خدمة moat-intent التي تقرأ النص وتحوّله إلى حقول.'), L('none: rules read text', 'لا شيء: القواعد تقرأ النص')],
              ['intent_api.reader_timeout_secs', L('How long to wait for the reader before the rules take over.', 'مدة انتظار القارئ قبل أن تتولى القواعد القراءة.'), '45'],
              ['storage', L('PostgreSQL, from the named environment variable.', 'PostgreSQL، من متغير البيئة المسمّى.'), L('memory only', 'الذاكرة فقط')],
              ['auth.required', L('Require a workspace key on every HTTP route.', 'اشتراط مفتاح مساحة عمل في كل مسار HTTP.'), 'false'],
            ]} />
            <p>{L(<>The repository README covers the database roles, migrations, the deploy script and the arena that produced the numbers on the <a href="/compare">compare page</a>.</>, <>يغطي ملف README في المستودع أدوار قاعدة البيانات، وعمليات الترحيل، وسكربت النشر، وبيئة الاختبار (arena) التي أنتجت الأرقام في <a href="/compare">صفحة المقارنة</a>.</>)}</p>
          </section>
        </article>
      </main>
      </div>
      <Footer />
    </>
  )
}
