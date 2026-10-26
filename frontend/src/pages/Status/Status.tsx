import Footer from '../../components/layout/Footer'
import RightNow from './RightNow'
import { useEffect, useMemo, useState } from 'react'
import {
  HoverCard,
  HoverCardTrigger,
  HoverCardContent,
} from "@/components/ui/glass/hover-card"
import {

  Pagination,

  PaginationContent,

  PaginationEllipsis,

  PaginationItem,

  PaginationLink,

  PaginationNext,

  PaginationPrevious,

} from '../../components/ui/glass/pagination'

import {

  CalendarDays,

  Activity,

  RefreshCw,

} from 'lucide-react'

import { L } from '../../i18n'

import { Card } from '../../components/ui/glass/card'

import { LiquidGlassProvider } from '../../components/ui/liquid/liquid-glass-provider'

import './Status.css'

type UptimeDay = {

  date: string

  ratio: number | null

  partial?: boolean

  declared?: boolean

  /** sampled by the recorder, logs: from the web server's log, declared, or none */
  source?: 'sampled' | 'logs' | 'declared' | 'none'

  expected?: number

  ok?: number

}

type UptimeResponse = {

  days?: UptimeDay[]

}

const PAGE_SIZE = 5

const percent = (day: UptimeDay) =>

  day.ratio === null

    ? null

    : Math.round(Number(day.ratio) * 1000) / 10

const dayState = (day: UptimeDay) => {

  const value = percent(day)

  if (value === null || !Number.isFinite(value)) return 'unknown'

  if (value >= 99.5) return 'healthy'

  if (value >= 95) return 'warning'

  return 'degraded'

}

const readableDate = (date: string) => {

  const locale = document.documentElement.lang?.startsWith('ar')

    ? 'ar-DZ'

    : 'en-GB'

  return new Date(`${date}T00:00:00Z`).toLocaleDateString(locale, {

    weekday: 'short',

    month: 'short',

    day: 'numeric',

    timeZone: 'UTC',

  })

}

function StatusContent() {
  const [compactLayout, setCompactLayout] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches
  )
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 900px)')
    const onChange = (event: MediaQueryListEvent) => setCompactLayout(event.matches)
    setCompactLayout(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])


const [days, setDays] = useState<UptimeDay[]>([])

  const [loading, setLoading] = useState(true)

  const [error, setError] = useState('')

  const [selected, setSelected] = useState<string | null>(null)

  const [page, setPage] = useState(0)

  const [reload, setReload] = useState(0)

  useEffect(() => {
const controller = new AbortController()

    setLoading(true)

    setError('')

    fetch('/v1/uptime', {

      signal: controller.signal,

      headers: {

        accept: 'application/json',

      },

    })

      .then(async response => {

        if (!response.ok) {

          throw new Error(`HTTP ${response.status}`)

        }

        return response.json() as Promise<UptimeResponse>

      })

      .then(data => {

        if (controller.signal.aborted) return

        const receivedDays = Array.isArray(data.days)

          ? data.days

          : []

        setDays(receivedDays)

        setPage(0)

        setLoading(false)

      })

      .catch(err => {

        if (controller.signal.aborted) return

        setError(String(err?.message || err))

        setLoading(false)

      })

    return () => controller.abort()

  }, [reload])
// Always display timeline cells in chronological order.
  const timeline = useMemo(

    () => [...days].sort((a, b) => a.date.localeCompare(b.date)),

    [days]

  )
// History: newest measured days first.
  const measured = useMemo(

    () =>

      timeline

        .filter(

          day =>

            day.ratio !== null &&

            Number.isFinite(Number(day.ratio))

        )

        .slice()

        .reverse(),

    [timeline]

  )
// Preserve the backend's existing aggregate calculation.// Partial and declared days are excluded.
  const full = useMemo(

    () =>

      timeline.filter(

        day =>

          !day.partial &&

          !day.declared &&

          Number(day.expected) > 0

      ),

    [timeline]

  )

  const fromLogs = full.filter(day => day.source === 'logs').length

  const totalExpected = full.reduce(

    (sum, day) => sum + Number(day.expected || 0),

    0

  )

  const totalOk = full.reduce(

    (sum, day) => sum + Number(day.ok || 0),

    0

  )

  const availability =

    totalExpected > 0

      ? (100 * totalOk) / totalExpected

      : null

  const gaugeText =

    availability === null

      ? '—'

      : `${availability.toFixed(2)}%`

  const availabilityState =

    availability === null

      ? 'unknown'

      : availability >= 80

        ? 'good'

        : availability >= 50

          ? 'medium'

          : 'low'

  const gaugeColor =

    availabilityState === 'good'

      ? '#00e5a3'

      : availabilityState === 'medium'

        ? '#ff9f1a'

        : availabilityState === 'low'

          ? '#d00000'

          : '#7c8596'

  const pageCount = Math.max(

    1,

    Math.ceil(measured.length / PAGE_SIZE)

  )

  const currentPage = Math.min(page, pageCount - 1)

  const pageItems = measured.slice(

    currentPage * PAGE_SIZE,

    (currentPage + 1) * PAGE_SIZE

  )



  const selectDay = (day: UptimeDay) => {

    setSelected(day.date)

    const measuredIndex = measured.findIndex(

      item => item.date === day.date

    )

    if (measuredIndex !== -1) {

      setPage(Math.floor(measuredIndex / PAGE_SIZE))

    }

  }

  const goToPage = (nextPage: number) => {

    setPage(Math.max(0, Math.min(pageCount - 1, nextPage)))

    setSelected(null)

  }

  // Keep the current page visible while matching Crenspire's compact ellipsis pattern.
  // Pages are zero-based internally; labels shown in the UI are one-based.


  const paginationSlots: (number | 'ellipsis')[] =
    pageCount <= 5
      ? Array.from({ length: pageCount }, (_, i) => i)
      : currentPage <= 2
        ? [0, 1, 2, 'ellipsis', pageCount - 1]
        : currentPage >= pageCount - 3
          ? [0, 'ellipsis', pageCount - 3, pageCount - 2, pageCount - 1]
          : [0, 'ellipsis', currentPage, 'ellipsis', pageCount - 1]

  return (


<main
  className="status-pulse-page"
  id="main-content"
  tabIndex={-1}
  dir={
    document.documentElement.lang.startsWith('ar')
      ? 'rtl'
      : 'ltr'
  }
>


      <section

        className="status-pulse-section"

        aria-labelledby="status-pulse-heading"

      >

        <div className="status-pulse-heading">

          <h1 id="status-pulse-heading">

            {L('Thirty days', 'ثلاثون يومًا')}

          </h1>

          <p>

            {L(

              'Daily service availability across the last thirty days.',

              'سجل التوفّر التشغيلي خلال آخر ثلاثين يومًا.'

            )}

          </p>

        </div>

        {/* Main shaped glass overview */}

        <Card

          material="clear"

          tint="rgba(255, 255, 255, 0.08)"

          key={compactLayout ? "plain-mobile" : "shoulders-desktop"}
          data-glass-shape={compactLayout ? undefined : "shoulders"}

          className="op-board"

        >

          {/* Glass reporting window, positioned in the right raised shoulder */}

          <div className="op-window-shoulder">

            <Card

              material="clear"

              tint="rgba(255, 135, 55, 0.10)"

              className="op-window-card"

            >

              <span className="op-window-icon" aria-hidden="true">

                <CalendarDays size={20} />

              </span>

              <div className="op-window-copy">

                <small>{L('REPORTING WINDOW', 'فترة التقرير')}</small>

                <strong>

                  {timeline.length

                    ? `${timeline[0].date} → ${timeline[timeline.length - 1].date}`

                    : '—'}

                </strong>

              </div>

            </Card>

            <div className="op-key">

              <i className="op-key-dot healthy" />

              {L('Healthy', 'متاح')}

              <i className="op-key-dot degraded" />

              {L('Degraded', 'متدهور')}

              <i className="op-key-dot unknown" />

              {L('No data', 'لا توجد بيانات')}

            </div>

          </div>

          <div className="op-board-top">

            {/* Circular gauge: liquid-glass rim is a sibling of the opaque progress ring. */}

            <div className="op-gauge-shell">

              <Card

                material="clear"

                tint="rgba(255, 255, 255, 0.08)"

                className="op-gauge-liquid"

                aria-hidden="true"

              />

              <div

                className={`op-gauge ${availability === null ? 'is-unknown' : ''}`}

                style={

                  {

                    '--op-pct': `${Math.max(0, Math.min(100, availability ?? 0))}%`,

                    '--op-gauge-color': gaugeColor,

                  } as React.CSSProperties

                }

                role="img"

                aria-label={`${L('Availability', 'التوفّر')} ${gaugeText}`}

              >

                <div className="op-gauge-core">

                  <strong>{gaugeText}</strong>

                  <span>{L('Availability', 'التوفّر')}</span>

                  <small>

                    {fromLogs > 0
                      ? L(`over ${full.length} days, ${fromLogs} from web logs`, `على مدى ${full.length} يومًا، ${fromLogs} منها من سجلات الخادم`)
                      : L(`over ${full.length} measured days`, `على مدى ${full.length} أيام مقيسة`)}

                  </small>

                </div>

              </div>

            </div>

            {/* Reporting window and timeline */}

            <div className="op-strip-side">

              <div className="op-strip-top">

              </div>

              <div className="op-strip-wrap">

                <div

                  className="op-strip"

                  role="group"

                  aria-label={L(

                    'Daily availability timeline',

                    'التوفّر اليومي'

                  )}

                >


{timeline.map(day => {
  const value = percent(day)

  const availabilityLabel =
    value === null
      ? L('No data', 'لا توجد بيانات')
      : `${value}%`

  return (
    <HoverCard
      key={day.date}
      openDelay={120}
      closeDelay={100}
    >
      <HoverCardTrigger asChild>
        <button
          type="button"
          className={[
            'op-day',
            dayState(day),
            day.partial ? 'partial' : '',
            day.declared ? 'declared' : '',
            day.source === 'logs' ? 'from-logs' : '',
            selected === day.date ? 'selected' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          onClick={() => selectDay(day)}
          aria-pressed={selected === day.date}
          aria-label={`${day.date}: ${
            value === null
              ? L('Not measured', 'لم يُقَس')
              : `${value}%`
          }`}
        >
          <span aria-hidden="true" />
        </button>
      </HoverCardTrigger>

      <HoverCardContent
  variant="liquid"
  material="regular"
  side="top"
  align="center"
  sideOffset={10}
  collisionPadding={12}
  avoidCollisions
  className="w-52 status-timeline-hover !z-[9999]"
>
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-semibold">
              {readableDate(day.date)}
            </span>

            <span
              className={
                dayState(day) === 'degraded'
                  ? 'text-rose-400 font-bold'
                  : dayState(day) === 'warning'
                    ? 'text-amber-400 font-bold'
                    : dayState(day) === 'healthy'
                      ? 'text-emerald-400 font-bold'
                      : 'text-muted-foreground font-bold'
              }
            >
              {availabilityLabel}
            </span>
          </div>

          <div className="text-xs text-muted-foreground">
            {day.date}
          </div>

          <div className="text-xs text-muted-foreground">
            {day.partial
              ? L('So far today', 'حتى الآن اليوم')
              : day.declared
                ? L('Declared, not sampled', 'مُصرّح به، غير مقيس')
                : day.source === 'logs'
                  ? L('From the web server log, not sampled', 'من سجل الخادم، غير مقيس')
                  : L('Daily availability', 'التوفر اليومي')}
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  )
})}


                </div>

              </div>

              <div className="op-strip-ends">

                <span>{timeline[0]?.date || '—'}</span>

                <span>{L('today', 'اليوم')}</span>

              </div>



            </div>

          </div>

        </Card>

        {/* Availability history */}

        <div

          className="op-history"

          aria-label={L(

            'Daily availability records',

            'سجل التوفّر اليومي'

          )}

        >

          {loading && (

            <div className="op-empty">

              <Activity size={18} />

              {L(

                'Loading availability data…',

                'جارٍ تحميل بيانات التوفّر…'

              )}

            </div>

          )}

          {!loading && error && (

            <div className="op-empty op-error">

              {L(

                'Could not read uptime data:',

                'تعذّر تحميل بيانات التوفّر:'

              )}{' '}

              {error}

              <button

                type="button"

                onClick={() => setReload(n => n + 1)}

              >

                <RefreshCw size={15} />

                {L('Retry', 'إعادة المحاولة')}

              </button>

            </div>

          )}

          {!loading && !error && measured.length === 0 && (

            <div className="op-empty">

              {L(

                'No measured days available yet.',

                'لا تتوفر أيام مقيسة حتى الآن.'

              )}

            </div>

          )}

          {!loading &&

            !error &&

            pageItems.map(day => {

              const state = dayState(day)

              const value = percent(day)

              return (

                <Card

                  key={day.date}

                  material="clear"

                  tint="rgba(255, 255, 255, 0.06)"

                  className={`op-history-glass ${state} ${selected === day.date ? 'selected' : ''

                    }`}

                >

                  <button

                    type="button"

                    className={`op-record ${state} ${selected === day.date

                        ? 'selected'

                        : ''

                      }`}

                    onClick={() => selectDay(day)}

                    aria-pressed={selected === day.date}

                  >

                    <span className="op-record-icon">

                      <span />

                    </span>

                    <span className="op-record-date">

                      <strong>

                        {readableDate(day.date)}

                      </strong>

                      <small>{day.date}</small>

                    </span>

                    <span className="op-record-tag">

                      <i />

                      {day.partial

                        ? L(

                          'SO FAR TODAY',

                          'حتى الآن اليوم'

                        )

                        : day.declared

                          ? L(

                            'DECLARED, NOT SAMPLED',

                            'مُصرّح به، غير مقيس'

                          )

                          : day.source === 'logs'

                            ? state === 'degraded'

                              ? L('DEGRADED, FROM WEB LOGS', 'متدهور، من سجلات الخادم')

                              : L('FROM WEB LOGS', 'من سجلات الخادم')

                            : state === 'degraded'

                            ? L(

                              'DEGRADED PERFORMANCE',

                              'أداء متدهور'

                            )

                            : L(

                              'MEASURED DAY',

                              'يوم مقيس'

                            )}

                    </span>

                    <span

                      className="op-record-bars"

                      aria-hidden="true"

                    >

                      {Array.from(

                        { length: 12 },

                        (_, index) => (

                          <i

                            key={index}

                            style={{

                              height: `${7 +

                                Math.round(

                                  ((index + 1) / 12) * 18

                                )

                                }px`,

                              opacity:

                                (index + 1) / 12 <=

                                  (value ?? 0) / 100

                                  ? 1

                                  : 0.18,

                            }}

                          />

                        )

                      )}

                    </span>

                    <strong className="op-record-value">

                      {value === null ? '—' : `${value}%`}

                    </strong>

                  </button>

                </Card>

              )

            })}

        </div>


{pageCount > 1 && !loading && !error && (
  <Pagination className="status-pagination">
    <PaginationContent
  variant="liquid"
  material="clear"
  tint="rgba(255, 255, 255, 0.06)"
  className="status-pagination-content"
>
      <PaginationItem>
        <PaginationPrevious
          href="#"
          aria-disabled={currentPage === 0}
          tabIndex={currentPage === 0 ? -1 : 0}
          onClick={e => {
            e.preventDefault()
            if (currentPage > 0) goToPage(currentPage - 1)
          }}
        />
      </PaginationItem>

      {paginationSlots.map((slot, index) => (
        <PaginationItem key={`${index}-${slot}`}>
          {slot === 'ellipsis' ? (
            <PaginationEllipsis />
          ) : (
            <PaginationLink
                variant="default"
              href="#"
              isActive={slot === currentPage}
              aria-label={`Page ${slot + 1}`}
              onClick={e => {
                e.preventDefault()
                goToPage(slot)
              }}
            >
              {slot + 1}
            </PaginationLink>
          )}
        </PaginationItem>
      ))}

      <PaginationItem>
        <PaginationNext
          href="#"
          aria-disabled={currentPage === pageCount - 1}
          tabIndex={currentPage === pageCount - 1 ? -1 : 0}
          onClick={e => {
            e.preventDefault()
            if (currentPage < pageCount - 1) {
              goToPage(currentPage + 1)
            }
          }}
        />
      </PaginationItem>
    </PaginationContent>
  </Pagination>
)}

      </section>
      <RightNow />
    </main>

  )
}
// Same liquid-glass renderer used on Compare.
export default function Status() {

  return (

  <LiquidGlassProvider
  backdrop="/glass-backdrop.svg"
  options={{
    refraction: 4,
    dispersion: 0,
    frost: 8,
  }}
>

      <StatusContent />
      <Footer />

    </LiquidGlassProvider>

  )

}
