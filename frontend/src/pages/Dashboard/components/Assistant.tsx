import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Bot, Send, X } from 'lucide-react'
import { L, isAr } from '../../../i18n'
import { held } from '../api'

/* The dashboard's assistant: a chat that knows Moat and this workspace,
   answered by Claude through the site's server, which reads the workspace
   with the signed-in key and streams the answer back. The reply is shown as
   it is written: a thinking state first, then the words a few at a time. */

export const SUPPORT = 'support@moatgateway.dpdns.org'
const FAB = 'moat.ws.assistant.fab'

type State = 'thinking' | 'streaming' | 'done' | 'error'
interface Msg { id: string; role: 'user' | 'assistant'; text: string; state?: State }

const pref = {
  get: (k: string) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* a private window */ } },
}

/** The Moat mark at work, the same one the Playground's button uses. */
function WorkingMark() {
  return (
    <svg className="pg-working-mark" viewBox="69 43 144 144" aria-hidden="true" focusable="false">
      <g className="pg-working-arcs" fill="none" stroke="currentColor" strokeWidth="13" strokeLinecap="round">
        <path className="pg-working-arc" pathLength="100" d="M117 52.4 A67 67 0 0 1 202.7 141.2" />
        <path className="pg-working-arc" pathLength="100" d="M177.5 171.2 A67 67 0 0 1 86.1 76.6" />
      </g>
      <g className="pg-working-dots" fill="currentColor">
        <circle cx="99.7" cy="62.2" r="12" />
        <circle cx="192.3" cy="158.1" r="12" />
      </g>
      <path fill="currentColor" fillRule="evenodd" d="M110 90 H173 A7 7 0 0 1 180 97 V133 A7 7 0 0 1 173 140 H110 A7 7 0 0 1 103 133 V97 A7 7 0 0 1 110 90 Z M115 105 H123 A2 2 0 0 1 125 107 V112 A2 2 0 0 1 123 114 H115 A2 2 0 0 1 113 112 V107 A2 2 0 0 1 115 105 Z" />
    </svg>
  )
}

/** Bold, code and simple lists; the model is asked to keep it to that. */
function render(text: string): ReactNode {
  const inline = (s: string, key: string): ReactNode[] =>
    s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean).map((part, i) => {
      if (part.startsWith('**') && part.endsWith('**')) return <strong key={`${key}-${i}`}>{part.slice(2, -2)}</strong>
      if (part.startsWith('`') && part.endsWith('`')) return <code key={`${key}-${i}`}>{part.slice(1, -1)}</code>
      return <span key={`${key}-${i}`}>{part}</span>
    })
  const out: ReactNode[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  const flush = () => {
    if (!list) return
    const items = list.items.map((it, i) => <li key={i}>{inline(it, `li${out.length}-${i}`)}</li>)
    out.push(list.ordered ? <ol key={`l${out.length}`}>{items}</ol> : <ul key={`l${out.length}`}>{items}</ul>)
    list = null
  }
  for (const line of text.split('\n')) {
    const bullet = /^\s*[-•]\s+(.*)$/.exec(line)
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (bullet || numbered) {
      const ordered = Boolean(numbered)
      if (!list || list.ordered !== ordered) { flush(); list = { ordered, items: [] } }
      list.items.push((bullet ?? numbered)![1]!)
      continue
    }
    flush()
    if (line.trim()) out.push(<p key={`p${out.length}`}>{inline(line, `p${out.length}`)}</p>)
  }
  flush()
  return out
}

function welcome(): string {
  return L(
    `Hi, I'm Moat's assistant. This workspace is a **test environment**: no real money moves here. Card payments go to Stripe in test mode and chain payments to public testnets.\n\nAsk me how to run an attack in the Playground, what a verdict means, or how to connect your agent. If you need a person, write to ${SUPPORT}.`,
    `مرحبًا، أنا مساعد Moat. مساحة العمل هذه **بيئة تجريبية**: لا تتحرك فيها أموال حقيقية. دفعات البطاقة تذهب إلى Stripe في وضع الاختبار، ودفعات السلاسل إلى شبكات اختبار عامة.\n\nاسألني كيف تجرّب هجومًا في ساحة التجربة، أو ماذا يعني حكم ما، أو كيف تربط وكيلك. وإن احتجت إلى شخص، راسل ${SUPPORT}.`,
  )
}

const CHIPS = () => [
  L('How do I test an attack?', 'كيف أجرّب هجومًا؟'),
  L('What do allow, deny, step up and hold mean?', 'ماذا تعني allow وdeny وstep up وhold؟'),
  L('How do I connect my agent?', 'كيف أربط وكيلي؟'),
]

/** The floating way in: a robot that can be sent away. It comes back from
 *  the header, where the assistant always lives. */
export function AssistantLauncher({ open, onOpen }: { open: boolean; onOpen: () => void }) {
  const [gone, setGone] = useState(() => pref.get(FAB) === 'gone')
  if (gone || open) return null
  return (
    <div className="assistant-fab" id="assistant-fab">
      <button type="button" className="assistant-fab-btn" onClick={onOpen}
        aria-label={L('Ask the assistant', 'اسأل المساعد')} title={L('Ask the assistant', 'اسأل المساعد')}>
        <Bot size={26} strokeWidth={2} aria-hidden="true" />
      </button>
      <button type="button" className="assistant-fab-x" onClick={() => { pref.set(FAB, 'gone'); setGone(true) }}
        aria-label={L('Hide this button; the assistant stays in the header', 'أخفِ هذا الزر؛ يبقى المساعد في الترويسة')}
        title={L('Hide', 'إخفاء')}>
        <X size={12} strokeWidth={2.5} aria-hidden="true" />
      </button>
    </div>
  )
}

interface AssistantPanelProps {
  open: boolean
  onClose: () => void
  /** The pane the user is looking at, so the answer can start from there. */
  pane: string
}

export default function AssistantPanel({ open, onClose, pane }: AssistantPanelProps) {
  const [messages, setMessages] = useState<Msg[]>(() => [{ id: 'welcome', role: 'assistant', text: welcome(), state: 'done' }])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const logRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  // Words arrive in pieces; they are shown a few characters at a time so the
  // answer reads as being written rather than dropped in.
  const queue = useRef('')
  const timer = useRef<number | null>(null)

  useEffect(() => {
    if (!open) return
    inputRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useEffect(() => {
    logRef.current?.scrollTo?.({ top: logRef.current.scrollHeight })
  }, [messages, open])

  const patchLast = useCallback((fn: (m: Msg) => Msg) => {
    setMessages((prev) => prev.map((m, i) => (i === prev.length - 1 && m.role === 'assistant' ? fn(m) : m)))
  }, [])

  const startTyping = useCallback(() => {
    if (timer.current !== null) return
    timer.current = window.setInterval(() => {
      if (!queue.current) return
      const take = queue.current.slice(0, 3)
      queue.current = queue.current.slice(3)
      patchLast((m) => ({ ...m, text: m.text + take, state: 'streaming' }))
    }, 16)
  }, [patchLast])

  const stopTyping = useCallback((final: State) => {
    const finish = () => {
      if (timer.current !== null) { window.clearInterval(timer.current); timer.current = null }
      patchLast((m) => ({ ...m, text: m.text + queue.current, state: final }))
      queue.current = ''
    }
    // Let what is queued finish writing before the state settles.
    const wait = () => (queue.current ? window.setTimeout(wait, 40) : finish())
    wait()
  }, [patchLast])

  useEffect(() => () => { if (timer.current !== null) window.clearInterval(timer.current); abortRef.current?.abort() }, [])

  const send = async (text: string) => {
    const question = text.trim()
    if (!question || busy) return
    setDraft('')
    setBusy(true)
    const history: Msg[] = [...messages.filter((m) => m.id !== 'welcome'), { id: 'u' + Date.now(), role: 'user', text: question }]
    setMessages([...messages, history[history.length - 1]!, { id: 'a' + Date.now(), role: 'assistant', text: '', state: 'thinking' }])
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const res = await fetch('/v1/assistant', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(held() ? { authorization: 'Bearer ' + held() } : {}) },
        body: JSON.stringify({
          messages: history.map((m) => ({ role: m.role, content: m.text })),
          pane,
          lang: isAr() ? 'ar' : 'en',
        }),
        signal: controller.signal,
      })
      if (!res.ok || !res.body) {
        let message = res.statusText
        try { message = ((await res.json()) as { error?: string }).error || message } catch { /* not json */ }
        throw new Error(message)
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let sawText = false
      const handle = (chunk: string) => {
        let event = ''
        let data = ''
        for (const line of chunk.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) data += line.slice(5).trim()
        }
        if (event === 'text') {
          const { t } = JSON.parse(data) as { t: string }
          if (!sawText) { sawText = true; patchLast((m) => ({ ...m, state: 'streaming' })) }
          queue.current += t
          startTyping()
        } else if (event === 'error') {
          const { message } = JSON.parse(data) as { message: string }
          queue.current += (sawText ? '\n\n' : '') + message
          startTyping()
        }
        // `thinking` keeps the thinking state it started in; `done` is the end of the stream.
      }
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let at: number
        while ((at = buffer.indexOf('\n\n')) >= 0) {
          handle(buffer.slice(0, at))
          buffer = buffer.slice(at + 2)
        }
      }
      if (buffer.trim()) handle(buffer)
      stopTyping('done')
    } catch (err: unknown) {
      if (controller.signal.aborted) return
      const message = String((err as Error).message || err)
      queue.current += (queue.current || messages.length ? '' : '') + (message || L('Something went wrong.', 'حدث خطأ ما.'))
      startTyping()
      stopTyping('error')
    } finally {
      setBusy(false)
      abortRef.current = null
    }
  }

  if (!open) return null
  return (
    <aside className="assistant-panel" id="assistant" role="dialog" aria-label={L('Moat assistant', 'مساعد Moat')} dir={isAr() ? 'rtl' : 'ltr'}>
      <div className="assistant-head">
        <Bot size={20} strokeWidth={2} aria-hidden="true" />
        <div className="assistant-title">
          <strong>{L('Moat assistant', 'مساعد Moat')}</strong>
          <span>{L('Test environment. No real money moves.', 'بيئة تجريبية. لا تتحرك أموال حقيقية.')}</span>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label={L('Close', 'إغلاق')}>
          <X size={18} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      <div className="assistant-log" ref={logRef} aria-live="polite">
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}${m.state === 'thinking' ? ' is-thinking' : ''}`}>
            {m.role === 'assistant' && m.state === 'thinking' ? (
              <span className="assistant-thinking"><WorkingMark /> {L('Thinking…', 'يفكّر…')}</span>
            ) : (
              <>
                {m.role === 'assistant' ? render(m.text) : <p>{m.text}</p>}
                {m.state === 'streaming' && <span className="caret" aria-hidden="true" />}
              </>
            )}
          </div>
        ))}
      </div>

      {messages.length <= 1 && (
        <div className="assistant-chips">
          {CHIPS().map((c) => (
            <button key={c} type="button" className="chip" onClick={() => void send(c)}>{c}</button>
          ))}
        </div>
      )}

      <form className="assistant-form" onSubmit={(e) => { e.preventDefault(); void send(draft) }}>
        <textarea
          ref={inputRef}
          rows={1}
          value={draft}
          placeholder={L('Ask about Moat or this workspace…', 'اسأل عن Moat أو مساحة العمل هذه…')}
          aria-label={L('Your question', 'سؤالك')}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(draft) } }}
        />
        <button type="submit" className="btn assistant-send" disabled={busy || !draft.trim()} aria-label={L('Send', 'إرسال')}>
          <Send size={16} strokeWidth={2.2} aria-hidden="true" />
        </button>
      </form>
      <p className="assistant-foot">
        {L('Need a person?', 'تحتاج إلى شخص؟')} <a href={`mailto:${SUPPORT}`}>{SUPPORT}</a>
      </p>
    </aside>
  )
}
