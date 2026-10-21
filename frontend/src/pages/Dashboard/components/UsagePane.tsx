import { useState, useMemo } from 'react'
import { L } from '../../../i18n'
import VerdictBarChart from './VerdictBarChart'
import { vmeta, moneyOf, ago, CALL, bucketize, LOCALE } from '../formatters'
import type { Verdict, UsageData } from '../types'

interface UsagePaneProps {
  feed: Verdict[]
  usage: UsageData | null
  onOpenVerdict: (evidenceId: string) => void
}

type Range = '24H' | '7D' | '30D'
const RANGES: [Range, string][] = [
  ['24H', L('24H', '24 س')],
  ['7D', L('7D', '7 أيام')],
  ['30D', L('30D', '30 يومًا')],
]

const fmt = (n?: number) => (n ?? 0).toLocaleString(LOCALE)

function VerdictRow({ v, onOpen }: { v: Verdict; onOpen: (id: string) => void }) {
  const m = vmeta(v.verdict)
  return (
    <button type="button" className="rowlist-row" onClick={() => v.evidence_id && onOpen(v.evidence_id)}>
      <span className={`badge ${m.cls || 'refused'}`}>{m.label}</span>
      <span className="cell cell-payee">{v.payee || v.tool || CALL}</span>
      <span className="cell cell-amount" dir="ltr">{moneyOf(v)}</span>
      <span className="cell cell-when">{ago(v.at)}</span>
    </button>
  )
}

export default function UsagePane({ feed, usage, onOpenVerdict }: UsagePaneProps) {
  const [range, setRange] = useState<Range>('24H')

  // The chart is drawn from the feed, which is the most recent verdicts only,
  // so it shows their timing. The totals beside it are the gateway's own
  // counts of every verdict, and never a sum of what the chart shows.
  const buckets = useMemo(() => {
    if (range === '24H') return bucketize(feed, 24, 'hours')
    if (range === '7D') return bucketize(feed, 7, 'days')
    return bucketize(feed, 30, 'days')
  }, [feed, range])

  const held = useMemo(() => feed.filter((v) => v.verdict === 'step_up').slice(0, 5), [feed])
  const latest = useMemo(() => feed.slice(0, 5), [feed])
  const lastAt = usage?.last_at || feed[0]?.at

  return (
    <section className="pane" id="pane-usage">
      <div className="page-head">
        <div className="titles">
          <h1 className="page-title">{L('Usage', 'الاستخدام')}</h1>
          <div className="page-caption">{L('How many payments were checked, and what Moat decided', 'كم دفعة فُحصت، وماذا قرّر Moat')}</div>
          {lastAt && (
            <div className="page-caption" id="last-at">
              {usage?.sessions
                ? L(`${fmt(usage.sessions)} agent sessions · last verdict ${ago(lastAt)}`,
                    `${fmt(usage.sessions)} جلسة وكيل · آخر حكم ${ago(lastAt)}`)
                : L(`Last verdict ${ago(lastAt)}`, `آخر حكم ${ago(lastAt)}`)}
            </div>
          )}
        </div>
        <div className="menubar" id="usage-ranges" role="group" aria-label={L('Chart range', 'مدى الرسم')}>
          {RANGES.map(([r, text]) => (
            <button key={r} type="button" className={range === r ? 'active' : ''} aria-pressed={range === r} onClick={() => setRange(r)}>
              {text}
            </button>
          ))}
        </div>
      </div>

      <div className="usage-body">
        <div className="usage-main">
          <section className="panel">
            <h2 className="panel-title">{L('Recent verdicts over time', 'الأحكام الأخيرة عبر الزمن')}</h2>
            <div id="chart-area" style={{ position: 'relative' }}>
              <VerdictBarChart data={buckets} />
            </div>
            <p className="hint">{L(`From your ${fmt(feed.length)} most recent verdicts.`, `من أحدث ${fmt(feed.length)} حكم لديك.`)}</p>
          </section>

          <div className="usage-lists">
            <section className="panel">
              <h2 className="panel-title">{L('HELD FOR A PERSON', 'مُعلَّقة لقرار شخص')}</h2>
              <div className="rowlist" id="ov-held">
                {held.length > 0
                  ? held.map((v, i) => <VerdictRow key={v.evidence_id || i} v={v} onOpen={onOpenVerdict} />)
                  : <div className="vempty">{L('Nothing held recently.', 'لا شيء مُعلَّق مؤخرًا.')}</div>}
              </div>
            </section>
            <section className="panel">
              <h2 className="panel-title">{L('LATEST', 'الأحدث')}</h2>
              <div className="rowlist" id="ov-latest">
                {latest.length > 0
                  ? latest.map((v, i) => <VerdictRow key={v.evidence_id || i} v={v} onOpen={onOpenVerdict} />)
                  : <div className="vempty">{L('No verdicts yet.', 'لا أحكام بعد.')}</div>}
              </div>
            </section>
          </div>
        </div>

        <aside className="stat-rail" aria-label={L('All verdicts', 'كل الأحكام')}>
          <div className="stat-card big">
            <div className="num" id="stat-total">{fmt(usage?.total)}</div>
            <div className="lbl">{L('Verdicts, all time', 'الأحكام، منذ البداية')}</div>
            <div className="sub" id="stat-sub">{L(`${fmt(usage?.week)} in the last 7 days`, `${fmt(usage?.week)} في آخر 7 أيام`)}</div>
          </div>
          <div className="stat-card mini">
            <div className="num" id="stat-paid">{fmt(usage?.allow)}</div>
            <span className="badge paid">{L('Paid', 'مدفوعة')}</span>
          </div>
          <div className="stat-card mini">
            <div className="num" id="stat-held">{fmt(usage?.step_up)}</div>
            <span className="badge held">{L('Held', 'مُعلَّقة')}</span>
          </div>
          <div className="stat-card mini">
            <div className="num" id="stat-refused">{fmt(usage?.deny)}</div>
            <span className="badge refused">{L('Refused', 'مرفوضة')}</span>
          </div>
        </aside>
      </div>
    </section>
  )
}
