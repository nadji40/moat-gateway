import { useState, useMemo } from 'react'
import { L } from '../../../i18n'
import { vmeta, moneyOf, ago, railOf, whyOf, CALL } from '../formatters'
import type { Verdict } from '../types'

interface VerdictsPaneProps {
  feed: Verdict[]
  onOpenVerdict: (evidenceId: string) => void
}

type FilterType = 'all' | 'allow' | 'step_up' | 'deny'
const PAGE_SIZE = 10

export default function VerdictsPane({ feed, onOpenVerdict }: VerdictsPaneProps) {
  const [filter, setFilter] = useState<FilterType>('all')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)

  const counts = useMemo(() => {
    return {
      all: feed.length,
      allow: feed.filter((v) => v.verdict === 'allow').length,
      step_up: feed.filter((v) => v.verdict === 'step_up').length,
      deny: feed.filter((v) => v.verdict === 'deny').length,
    }
  }, [feed])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return feed.filter((v) => {
      const matchFilter = filter === 'all' || v.verdict === filter
      if (!matchFilter) return false
      if (!q) return true
      const fields = [v.payee, v.evidence_id, v.session_id, v.currency, v.amount, v.tool, v.rail]
      return fields.some((x) => x && String(x).toLowerCase().includes(q))
    })
  }, [feed, filter, search])

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE) || 1
  const currentPage = Math.min(page, totalPages)

  const pagedRows = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE
    return filtered.slice(start, start + PAGE_SIZE)
  }, [filtered, currentPage])

  // Pagination page buttons generator
  const paginationItems = useMemo(() => {
    if (totalPages <= 5) {
      return Array.from({ length: totalPages }, (_, i) => i + 1)
    }
    const items: (number | 'dots')[] = []
    items.push(1)
    const start = Math.max(2, currentPage - 1)
    const end = Math.min(totalPages - 1, currentPage + 1)
    if (start > 2) items.push('dots')
    for (let i = start; i <= end; i++) {
      items.push(i)
    }
    if (end < totalPages - 1) items.push('dots')
    items.push(totalPages)
    return items
  }, [totalPages, currentPage])

  return (
    <section className="pane" id="pane-verdicts">
      <div className="search-row">
        <div className="titles" style={{ flex: 1, minWidth: 260 }}>
          <h1 className="page-title">{L('Verdicts', 'الأحكام')}</h1>
          <div className="page-caption">
            {L('Payments checked against your approvals: paid, held, or refused with the reason.',
              'دفعات فُحصت مقابل موافقاتك: مدفوعة، أو مُعلَّقة، أو مرفوضة مع السبب.')}
          </div>
        </div>
        <div className="search-field">
          <input
            id="vsearch"
            type="text"
            placeholder={L('Search payee, amount, reason…', 'ابحث عن المستفيد، المبلغ، السبب…')}
            autoComplete="off"
            spellCheck="false"
            aria-label={L('Search verdicts', 'ابحث في الأحكام')}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setPage(1)
            }}
          />
        </div>
        <div className="menubar" id="vfilter" role="group" aria-label={L('Show', 'اعرض')}>
          <button
            type="button"
            className={filter === 'all' ? 'active' : ''}
            data-f="all"
            aria-pressed={filter === 'all'}
            title={String(counts.all)}
            onClick={() => {
              setFilter('all')
              setPage(1)
            }}
          >
            {L('All', 'الكل')}
          </button>
          <button
            type="button"
            className={filter === 'allow' ? 'active' : ''}
            data-f="allow"
            aria-pressed={filter === 'allow'}
            title={String(counts.allow)}
            onClick={() => {
              setFilter('allow')
              setPage(1)
            }}
          >
            {L('Paid', 'مدفوعة')}
          </button>
          <button
            type="button"
            className={filter === 'step_up' ? 'active' : ''}
            data-f="step_up"
            aria-pressed={filter === 'step_up'}
            title={String(counts.step_up)}
            onClick={() => {
              setFilter('step_up')
              setPage(1)
            }}
          >
            {L('Held', 'مُعلَّقة')}
          </button>
          <button
            type="button"
            className={filter === 'deny' ? 'active' : ''}
            data-f="deny"
            aria-pressed={filter === 'deny'}
            title={String(counts.deny)}
            onClick={() => {
              setFilter('deny')
              setPage(1)
            }}
          >
            {L('Refused', 'مرفوضة')}
          </button>
        </div>
      </div>

      <div className="panel">
        <div className="table-shell">
          <div className="table-grid vgrid vhead">
            <div />
            <div className="th-cell">{L('Payee', 'المستفيد')}</div>
            <div className="th-cell">{L('Amount', 'المبلغ')}</div>
            <div className="th-cell">{L('Rail', 'القناة')}</div>
            <div className="th-cell">{L('Why', 'السبب')}</div>
            <div className="th-cell right">{L('When', 'التاريخ')}</div>
          </div>
          <div className="table-div" />
          <div id="feed">
            {pagedRows.length > 0 ? (
              pagedRows.map((v, i) => {
                const m = vmeta(v.verdict)
                const b = v.verdict === 'allow' ? 'paid' : v.verdict === 'step_up' ? 'held' : 'refused'
                return (
                  <button
                    key={v.evidence_id || i}
                    type="button"
                    className="table-grid vgrid"
                    data-ev={v.evidence_id}
                    onClick={() => v.evidence_id && onOpenVerdict(v.evidence_id)}
                  >
                    <span className={`badge ${b} v-badge`}>{m.label}</span>
                    <span className="rt primary v-payee">{v.payee || v.tool || CALL}</span>
                    <span className="rt primary v-amount" dir="ltr">{moneyOf(v)}</span>
                    <span className="rt muted v-rail">{railOf(v.rail)}</span>
                    <span className="rt muted v-why">{whyOf(v)}</span>
                    <span className="rt muted v-when">{ago(v.at)}</span>
                  </button>
                )
              })
            ) : (
              <div className="vempty">
                {feed.length
                  ? L('Nothing matches.', 'لا شيء يطابق.')
                  : L('No verdicts yet.', 'لا أحكام بعد.')}
              </div>
            )}
          </div>
        </div>
      </div>

      {totalPages > 1 && (
        <div className="menubar pages" role="navigation" aria-label={L('Pages', 'الصفحات')}>
          <button
            className="chev"
            type="button"
            disabled={currentPage <= 1}
            aria-label={L('Previous page', 'الصفحة السابقة')}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M10 3 5 8l5 5"
                stroke="white"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          {paginationItems.map((item, idx) => {
            if (item === 'dots') {
              return (
                <span key={`dots-${idx}`} className="dots" aria-hidden="true">
                  …
                </span>
              )
            }
            return (
              <button
                key={item}
                type="button"
                className={currentPage === item ? 'active' : ''}
                aria-current={currentPage === item ? 'page' : undefined}
                aria-label={L(`Page ${item}`, `الصفحة ${item}`)}
                onClick={() => setPage(item)}
              >
                {item}
              </button>
            )
          })}
          <button
            className="chev"
            type="button"
            disabled={currentPage >= totalPages}
            aria-label={L('Next page', 'الصفحة التالية')}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M6 3l5 5-5 5"
                stroke="white"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      )}

      <p className="hint foot-note" id="feed-note">
        {L(`${filtered.length} of your ${feed.length} most recent verdicts`, `${filtered.length} من أحدث ${feed.length} حكم`)}
      </p>
    </section>
  )
}
