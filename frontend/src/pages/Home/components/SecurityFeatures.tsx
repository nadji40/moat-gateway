import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { L } from '../../../i18n'

interface Feature {
  icon: React.ReactNode
  title: string
  titleAr: string
  description: string
  descriptionAr: string
}

const FEATURES: Feature[] = [
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21a8 8 0 0 1 16 0" />
      </svg>
    ),
    title: 'Payee',
    titleAr: 'المستفيد',
    description: 'From the user, never from a page',
    descriptionAr: 'من المستخدم، لا من صفحة أبدًا',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M15 9.5c-.6-1-1.7-1.5-3-1.5-1.7 0-3 .9-3 2.2 0 3 6 1.6 6 4.6 0 1.3-1.3 2.2-3 2.2-1.4 0-2.6-.6-3.1-1.6M12 6v2M12 16v2" />
      </svg>
    ),
    title: 'Amount and currency',
    titleAr: 'المبلغ والعملة',
    description: 'Exactly what was asked',
    descriptionAr: 'تمامًا كما طُلب',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M9 12l2 2 4-4" />
        <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" />
      </svg>
    ),
    title: 'Approvals',
    titleAr: 'الموافقات',
    description: 'One approval, one payment',
    descriptionAr: 'موافقة واحدة لدفعة واحدة',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 19V5M4 19h16" />
        <path d="M8 15l4-4 3 3 5-6" />
      </svg>
    ),
    title: 'Limits',
    titleAr: 'الحدود',
    description: 'Judged at real value, in any currency',
    descriptionAr: 'تُقاس بالقيمة الفعلية، بأي عملة',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 6h16M4 12h10M4 18h7" />
        <path d="M17 15l2 2 3-4" />
      </svg>
    ),
    title: 'Languages',
    titleAr: 'اللغات',
    description: 'Multilingual',
    descriptionAr: 'متعدد اللغات',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="4" y="3" width="16" height="18" rx="2" />
        <path d="M8 8h8M8 12h8M8 16h5" />
      </svg>
    ),
    title: 'Evidence',
    titleAr: 'الأدلة',
    description: 'A signed record of every verdict',
    descriptionAr: 'سجل موقَّع لكل حكم',
  },
]

const CHECK = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 13l4 4L19 7" />
  </svg>
)

function ArrowRight() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"  // decorative — the link label carries the accessible name
    >
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  )
}

const reducedMotion = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * SecurityFeatures — the six checks, shown as one payment passing them.
 *
 * A payment waits at the top. The checks slide past one at a time: each
 * comes forward, gets its tick, and steps back as the next one arrives. When
 * the sixth has passed, the payment goes through, and the run starts again.
 * It only runs while the section is on screen, and not at all for a visitor
 * who has asked for less motion: they get the six checks, all passed, still.
 */
export default function SecurityFeatures() {
  const N = FEATURES.length
  const [still] = useState(reducedMotion)
  const [running, setRunning] = useState(false)
  const [step, setStep] = useState(still ? N : 0)
  const [ticked, setTicked] = useState(still)
  const section = useRef<HTMLElement>(null)
  const view = useRef<HTMLDivElement>(null)
  const track = useRef<HTMLDivElement>(null)
  const cards = useRef<(HTMLElement | null)[]>([])
  const [shift, setShift] = useState(0)

  const done = step >= N
  const active = Math.min(step, N - 1)
  const passed = (i: number) => done || i < step || (i === step && ticked)

  // Start when the section scrolls into view, stop when it leaves.
  useEffect(() => {
    if (still || typeof IntersectionObserver === 'undefined' || !section.current) return
    const io = new IntersectionObserver(([e]) => setRunning(Boolean(e?.isIntersecting)), { threshold: 0.35 })
    io.observe(section.current)
    return () => io.disconnect()
  }, [still])

  // The run: forward, tick, back and on to the next; then the payment passes.
  useEffect(() => {
    if (!running) return
    const t = done
      ? setTimeout(() => { setStep(0); setTicked(false) }, 2800)
      : !ticked
        ? setTimeout(() => setTicked(true), 1000)
        : setTimeout(() => { setStep((s) => s + 1); setTicked(false) }, 1100)
    return () => clearTimeout(t)
  }, [running, done, ticked, step])

  // Keep the check in play at the centre. Measured from layout, so it holds
  // in either direction, Arabic or English.
  useLayoutEffect(() => {
    const measure = () => {
      const v = view.current, tr = track.current, c = cards.current[active]
      if (!v || !tr || !c) return
      const centre = done ? tr.offsetLeft + tr.offsetWidth / 2 : tr.offsetLeft + c.offsetLeft + c.offsetWidth / 2
      setShift(v.clientWidth / 2 - centre)
    }
    measure()
    addEventListener('resize', measure)
    return () => removeEventListener('resize', measure)
  }, [active, done])

  const current = FEATURES[active]!
  return (
    <section id="checks" className="tight gl-glow" ref={section}>
      <div className="head">
        <h2>{L('What it checks', 'ما الذي يتحقق منه')}</h2>
      </div>

      <div className={`chk${still ? ' chk-still' : ''}`}>
        <div className={`chk-pay${done ? ' ok' : ''}`} aria-hidden="true">
          <span className="chk-pay-ic">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="2.6" y="5" width="18.8" height="14" rx="3" /><path d="M2.6 9.6h18.8" /><path d="M6 14.5h3.5" /></svg>
          </span>
          <span className="chk-pay-who">Atlas Supplies</span>
          <span className="chk-pay-amt">480 USD</span>
          <span className="chk-pay-st">
            {done
              ? <>{CHECK}{L('Paid', 'مدفوعة')}</>
              : <>{L(current.title, current.titleAr)}</>}
          </span>
        </div>

        <div className="chk-view" ref={view}>
          <div className={`chk-track${done ? ' all-ok' : ''}`} ref={track} style={{ transform: `translateX(${shift}px)` }}>
            {FEATURES.map((f, i) => (
              <article
                key={f.title}
                ref={(el) => { cards.current[i] = el }}
                className={`chk-card glass gl-card${i === active && !done ? ' is-active' : ''}${passed(i) ? ' is-passed' : ''}`}
                data-d={Math.min(Math.abs(i - active), 3)}
              >
                <span className="chk-badge" aria-hidden="true">{CHECK}</span>
                <div className="ic">{f.icon}</div>
                <h3>{L(f.title, f.titleAr)}</h3>
                <p>{L(f.description, f.descriptionAr)}</p>
              </article>
            ))}
          </div>
        </div>

        <div className="chk-steps" aria-hidden="true">
          {FEATURES.map((f, i) => (
            <span key={f.title} className={passed(i) ? 'ok' : i === step ? 'on' : ''} />
          ))}
        </div>
      </div>

      {/* Where to see the checks run for real, and against what. */}
      <div className="chk-more">
        <a className="more" href="/compare">
          {L('Compare', 'المقارنة')}
          <ArrowRight />
        </a>
        <a className="more" href="/tests">
          {L('The tests', 'الاختبارات')}
          <ArrowRight />
        </a>
      </div>
    </section>
  )
}
