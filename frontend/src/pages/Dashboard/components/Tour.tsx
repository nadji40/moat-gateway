import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { L } from '../../../i18n'
import type { PaneId } from '../types'

interface Step {
  /** The pane the step is about; the tour opens it first. */
  pane?: PaneId
  /** What to light up on a wide screen, and on a phone when it differs. */
  target: string
  phoneTarget?: string
  /** Steps that only make sense on one kind of screen. */
  only?: 'desktop' | 'phone'
  title: string
  text: string
}

const STEPS: Step[] = [
  {
    target: '.sidebar .nav', phoneTarget: '.tabbar',
    title: L('Your workspace', 'مساحة عملك'),
    text: L('Five places. Everything else is inside them.', 'خمسة أقسام. وكل شيء آخر بداخلها.'),
  },
  {
    pane: 'pane-usage', target: '.stat-rail',
    title: L('Usage', 'الاستخدام'),
    text: L('Every payment Moat checked: paid, held for a person, or refused.', 'كل دفعة فحصها Moat: مدفوعة، أو مُعلَّقة لشخص، أو مرفوضة.'),
  },
  {
    pane: 'pane-keys', target: '.btn-create-key',
    title: L('API keys', 'مفاتيح API'),
    text: L('An agent key for the agent, an approver key for your app. Set an expiry if you like.', 'مفتاح وكيل للوكيل، ومفتاح مُوافِق لتطبيقك. ويمكنك تحديد مدة انتهاء.'),
  },
  {
    pane: 'pane-connect', target: '#connect-clients',
    title: L('Connect', 'الربط'),
    text: L('Copy the setup for Claude, OpenAI, Cursor or any MCP client.', 'انسخ الإعداد لـ Claude أو OpenAI أو Cursor أو أي عميل MCP.'),
  },
  {
    pane: 'pane-playground', target: '#attempt',
    title: L('Playground', 'ساحة التجربة'),
    text: L('Try to get a payment past your own policy.', 'حاول تمرير دفعة رغم سياستك.'),
  },
  {
    pane: 'pane-verdicts', target: '#vfilter',
    title: L('Verdicts', 'الأحكام'),
    text: L('Each decision with its reason. Open one for the evidence.', 'كل قرار مع سببه. افتح أيًّا منها لترى الأدلة.'),
  },
  {
    target: '.collapse-btn', only: 'desktop',
    title: L('More room', 'مساحة أكبر'),
    text: L('Fold the sidebar to icons.', 'اطوِ الشريط الجانبي إلى أيقونات.'),
  },
  {
    target: '.topbar-actions',
    title: L('Language, theme, this tour', 'اللغة، والمظهر، وهذه الجولة'),
    text: L('Arabic or English, light or dark, and the tour again whenever you want it.', 'العربية أو الإنجليزية، فاتح أو داكن، والجولة متى شئت.'),
  },
]

const PHONE = '(max-width: 720px)'
const isPhone = () => typeof window !== 'undefined' && window.matchMedia?.(PHONE).matches

interface TourProps {
  onPane: (pane: PaneId) => void
  onClose: () => void
}

/** A guided walk round the workspace: one control at a time, lit up, with a
 *  line on what it is for. Keyboard: arrows to move, Escape to leave. */
export default function Tour({ onPane, onClose }: TourProps) {
  const steps = STEPS.filter((s) => !s.only || s.only === (isPhone() ? 'phone' : 'desktop'))
  const [i, setI] = useState(0)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const card = useRef<HTMLDivElement | null>(null)
  const step = steps[i]
  const last = i === steps.length - 1

  const target = useCallback(() => {
    const sel = isPhone() && step.phoneTarget ? step.phoneTarget : step.target
    return document.querySelector<HTMLElement>(sel)
  }, [step])

  // Open the step's pane, then find what to light up once it has drawn.
  useEffect(() => {
    if (step.pane) onPane(step.pane)
    let tries = 0
    let frame = 0
    const find = () => {
      const el = target()
      if (el) {
        // Instant, so the light lands where the control is, not where it was.
        el.scrollIntoView?.({ block: 'center', behavior: 'auto' })
        setRect(el.getBoundingClientRect())
      } else if (tries++ < 30) {
        frame = requestAnimationFrame(find)
      } else {
        setRect(null)
      }
    }
    find()
    return () => cancelAnimationFrame(frame)
  }, [step, target, onPane])

  // Follow the target as the page scrolls or the window changes size.
  useEffect(() => {
    const follow = () => { const el = target(); if (el) setRect(el.getBoundingClientRect()) }
    window.addEventListener('scroll', follow, true)
    window.addEventListener('resize', follow)
    // A pane can keep growing after it first draws (fonts, the playground's
    // form), pushing the control out of view; look again once it has settled.
    const settle = setTimeout(() => {
      const el = target()
      if (!el) return
      const r = el.getBoundingClientRect()
      const bar = document.querySelector<HTMLElement>('.tabbar')?.offsetHeight ?? 0
      if (r.top < 0 || r.bottom > innerHeight - bar) el.scrollIntoView?.({ block: 'center', behavior: 'auto' })
      follow()
    }, 350)
    return () => {
      window.removeEventListener('scroll', follow, true)
      window.removeEventListener('resize', follow)
      clearTimeout(settle)
    }
  }, [target])

  useEffect(() => { card.current?.focus() }, [i])

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      const rtl = document.documentElement.dir === 'rtl'
      const next = rtl ? 'ArrowLeft' : 'ArrowRight'
      const back = rtl ? 'ArrowRight' : 'ArrowLeft'
      if (e.key === next) setI((n) => Math.min(steps.length - 1, n + 1))
      if (e.key === back) setI((n) => Math.max(0, n - 1))
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [onClose, steps.length])

  // The card sits below what is lit up when there is room, above otherwise,
  // and never off the screen.
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
  useLayoutEffect(() => {
    const c = card.current
    if (!c) return
    const w = c.offsetWidth
    const h = c.offsetHeight
    const pad = 12
    if (!rect) {
      setPos({ top: (innerHeight - h) / 2, left: (innerWidth - w) / 2 })
      return
    }
    // On a phone the tab bar covers the bottom of the screen; the card stays above it.
    const bar = document.querySelector<HTMLElement>('.tabbar')
    const barUp = bar !== null && bar.offsetHeight > 0
    const floor = innerHeight - (barUp ? bar.offsetHeight : 0)
    const below = rect.bottom + pad + h < floor
    const above = rect.top - pad - h >= pad
    const wanted = below ? rect.bottom + pad : above ? rect.top - pad - h : floor - h - pad
    const top = Math.min(Math.max(pad, wanted), Math.max(pad, floor - h - pad))
    const left = Math.min(Math.max(pad, rect.left + rect.width / 2 - w / 2), innerWidth - w - pad)
    setPos({ top, left })
  }, [rect, i, step])

  const ring = rect && {
    top: rect.top - 6, left: rect.left - 6, width: rect.width + 12, height: rect.height + 12,
  }

  return (
    <div className="tour" role="dialog" aria-modal="true" aria-labelledby="tour-title">
      {ring ? <div className="tour-ring" style={ring} /> : <div className="tour-dim" />}
      <div className="tour-card" ref={card} tabIndex={-1} style={pos}>
        <div className="tour-count">{L(`${i + 1} of ${steps.length}`, `${i + 1} من ${steps.length}`)}</div>
        <h2 id="tour-title">{step.title}</h2>
        <p>{step.text}</p>
        <div className="tour-actions">
          <button type="button" className="tour-skip" onClick={onClose}>{L('Skip', 'تخطَّ')}</button>
          <span className="tour-gap" />
          {i > 0 && (
            <button type="button" className="btn btn-dark" onClick={() => setI(i - 1)}>{L('Back', 'السابق')}</button>
          )}
          <button type="button" className="btn btn-primary" onClick={() => (last ? onClose() : setI(i + 1))}>
            {last ? L('Done', 'تم') : L('Next', 'التالي')}
          </button>
        </div>
      </div>
    </div>
  )
}
