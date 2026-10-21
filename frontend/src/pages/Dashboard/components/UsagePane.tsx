import { useState, useMemo } from 'react'
import { L } from '../../../i18n'
import VerdictBarChart from './VerdictBarChart'
import { vmeta, moneyOf, ago, CALL, bucketize } from '../formatters'
import type { Verdict, UsageData } from '../types'

interface UsagePaneProps {
  feed: Verdict[]
  usage: UsageData | null
  onOpenVerdict: (evidenceId: string) => void
}

type RangeOption = '24H' | '7D' | '30D' | 'CUSTUME'

export default function UsagePane({ feed, usage, onOpenVerdict }: UsagePaneProps) {
  const [range, setRange] = useState<RangeOption>('24H')

  const buckets = useMemo(() => {
    if (range === '24H') return bucketize(feed, 14, 'hours')
    if (range === '7D') return bucketize(feed, 7, 'days')
    if (range === '30D') return bucketize(feed, 30, 'days')
    return bucketize(feed, 14, 'days')
  }, [feed, range])

  const sums = useMemo(() => {
    return buckets.reduce(
      (acc, b) => {
        acc.allow += b.allow
        acc.step += b.step
        acc.deny += b.deny
        acc.total += b.total
        return acc
      },
      { allow: 0, step: 0, deny: 0, total: 0 }
    )
  }, [buckets])

  const subText = useMemo(() => {
    switch (range) {
      case '24H':
        return 'in the last day'
      case '7D':
        return 'past 7 days'
      case '30D':
        return 'past 30 days'
      default:
        return 'in range'
    }
  }, [range])

  const heldList = useMemo(() => {
    return feed.filter((v) => v.verdict === 'step_up').slice(0, 5)
  }, [feed])

  const latestList = useMemo(() => {
    return feed.slice(0, 5)
  }, [feed])

  const lastVerdictTime = usage?.last_at || (feed.length ? feed[0]?.at : undefined)

  return (
    <section className="pane" id="pane-usage">
      <div className="page-head">
        <div className="titles">
          <h1 className="page-title">Usage</h1>
          <div className="page-caption">Call valume and vardict mix over time</div>
          {lastVerdictTime && (
            <div className="page-caption" id="last-at">
              {usage?.sessions
                ? `${usage.sessions.toLocaleString()} agent sessions · last verdict ${ago(lastVerdictTime)}`
                : `Last verdict ${ago(lastVerdictTime)}`}
            </div>
          )}
        </div>
        <div className="menubar" id="usage-ranges">
          {(['24H', '7D', '30D', 'CUSTUME'] as RangeOption[]).map((r) => (
            <button
              key={r}
              type="button"
              className={range === r ? 'active' : ''}
              data-range={r}
              onClick={() => setRange(r)}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      <div className="usage-body">
        <div className="usage-main">
          <section className="panel">
            <h2 className="panel-title">Decision Velocity &amp; Proposal Volume</h2>
            <div id="chart-area" style={{ position: 'relative' }}>
              <VerdictBarChart data={buckets} />
            </div>
          </section>

          <div className="usage-lists">
            <section className="panel">
              <h2 className="panel-title">HELD FOR A PERSON</h2>
              <div className="rowlist" id="ov-held">
                {heldList.length > 0 ? (
                  heldList.map((v, i) => {
                    const m = vmeta(v.verdict)
                    const b = v.verdict === 'allow' ? 'paid' : v.verdict === 'step_up' ? 'held' : 'refused'
                    return (
                      <button
                        key={v.evidence_id || i}
                        type="button"
                        className="rowlist-row"
                        onClick={() => v.evidence_id && onOpenVerdict(v.evidence_id)}
                      >
                        <span className={`badge ${b}`}>{m.label}</span>
                        <span className="cell cell-payee">{v.payee || v.tool || CALL}</span>
                        <span className="cell cell-amount">{moneyOf(v)}</span>
                        <span className="cell cell-when">{ago(v.at)}</span>
                      </button>
                    )
                  })
                ) : (
                  <div className="vempty">{L('Nothing held recently.', 'لا شيء مُعلَّق مؤخرًا.')}</div>
                )}
              </div>
            </section>

            <section className="panel">
              <h2 className="panel-title">LATEST</h2>
              <div className="rowlist" id="ov-latest">
                {latestList.length > 0 ? (
                  latestList.map((v, i) => {
                    const m = vmeta(v.verdict)
                    const b = v.verdict === 'allow' ? 'paid' : v.verdict === 'step_up' ? 'held' : 'refused'
                    return (
                      <button
                        key={v.evidence_id || i}
                        type="button"
                        className="rowlist-row"
                        onClick={() => v.evidence_id && onOpenVerdict(v.evidence_id)}
                      >
                        <span className={`badge ${b}`}>{m.label}</span>
                        <span className="cell cell-payee">{v.payee || v.tool || CALL}</span>
                        <span className="cell cell-amount">{moneyOf(v)}</span>
                        <span className="cell cell-when">{ago(v.at)}</span>
                      </button>
                    )
                  })
                ) : (
                  <div className="vempty">{L('No verdicts yet.', 'لا أحكام بعد.')}</div>
                )}
              </div>
            </section>
          </div>
        </div>

        <aside className="stat-rail">
          <div className="stat-card big">
            <div className="num" id="stat-total">
              {sums.total.toLocaleString()}
            </div>
            <div className="lbl">Verdicts</div>
            <div className="sub" id="stat-sub">
              {sums.total.toLocaleString()} {subText}
            </div>
          </div>
          <div className="stat-card mini">
            <div className="num" id="stat-paid">
              {sums.allow.toLocaleString()}
            </div>
            <span className="badge paid" data-stat="paid">
              Paid
            </span>
          </div>
          <div className="stat-card mini">
            <div className="num" id="stat-held">
              {sums.step.toLocaleString()}
            </div>
            <span className="badge held" data-stat="held">
              Held
            </span>
          </div>
          <div className="stat-card mini">
            <div className="num" id="stat-refused">
              {sums.deny.toLocaleString()}
            </div>
            <span className="badge refused" data-stat="refused">
              Refused
            </span>
          </div>
        </aside>
      </div>
    </section>
  )
}
