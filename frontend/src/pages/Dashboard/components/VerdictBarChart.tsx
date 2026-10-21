import { useState, useRef } from 'react'
import { L } from '../../../i18n'
import type { BucketData } from '../types'

interface VerdictBarChartProps {
  data: BucketData[]
}

const W = 700
const H = 220
const padT = 8
const padR = 8
const padB = 40
const padL = 8
const plotW = W - padL - padR
const plotH = H - padT - padB
const baseY = padT + plotH

const STATUSES = [
  { key: 'allow' as const, name: L('Paid', 'مدفوعة'), fill: 'var(--green)' },
  { key: 'deny' as const, name: L('Refused', 'مرفوضة'), fill: 'var(--red)' },
  { key: 'step' as const, name: L('Held', 'مُعلَّقة'), fill: 'var(--chart-3)' },
]

export default function VerdictBarChart({ data }: VerdictBarChartProps) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  if (!data || data.length === 0) {
    return <div style={{ height: 220 }} />
  }

  const totals = data.map((d) => d.total)
  const highest = Math.max(1, ...totals)
  const maxVal = Math.max(10, Math.ceil(highest / 10) * 10)
  const colStep = plotW / data.length
  const barW = Math.max(6, Math.min(20, Math.floor(colStep * 0.5)))
  const rx = Math.min(3, barW / 4)

  const gridYs = [0, 0.5, 1].map((t) => padT + plotH * (1 - t))

  const handleMouseEnter = (idx: number) => {
    setHoverIdx(idx)
    if (wrapRef.current) {
      const rect = wrapRef.current.getBoundingClientRect()
      const colCenter = padL + (idx + 0.5) * colStep
      const tipX = (colCenter / W) * rect.width
      setTooltipPos({ x: tipX, y: 10 })
    }
  }

  const handleMouseLeave = () => {
    setHoverIdx(null)
    setTooltipPos(null)
  }

  const activeBucket = hoverIdx !== null ? data[hoverIdx] : null

  return (
    <div className="bklit-bar-wrap" ref={wrapRef} style={{ position: 'relative' }}>
      <svg
        className={`bklit-bar-svg ${hoverIdx !== null ? 'dim' : ''}`}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
      >
        {/* Horizontal grid lines */}
        {gridYs.map((y, i) => (
          <line key={i} className="bklit-grid-line" x1={padL} y1={y} x2={W - padR} y2={y} />
        ))}

        {/* Bars and interactive hover columns */}
        {data.map((d, i) => {
          const colX = padL + i * colStep
          const x = colX + (colStep - barW) / 2
          let acc = 0

          const segs = STATUSES.map((s) => {
            const val = d[s.key]
            const h = (val / maxVal) * plotH
            const y = baseY - acc - h
            acc += h
            return (
              <rect
                key={s.key}
                x={x}
                y={y}
                width={barW}
                height={Math.max(0, h)}
                fill={s.fill}
                rx={rx}
              />
            )
          })

          const showLabel = data.length <= 14 || i % Math.ceil(data.length / 10) === 0
          const isHot = hoverIdx === i

          return (
            <g
              key={i}
              className={`bklit-bar-group ${isHot ? 'hot' : ''}`}
              data-idx={i}
              style={{ animationDelay: `${Math.min(280, i * 18)}ms` }}
            >
              {segs}
              <rect
                className="bklit-bar-col"
                x={colX}
                y={padT}
                width={colStep}
                height={plotH}
                fill="transparent"
                style={{ cursor: 'pointer' }}
                onMouseEnter={() => handleMouseEnter(i)}
                onMouseLeave={handleMouseLeave}
              />
              {showLabel && (
                <text
                  className="bklit-axis-text"
                  x={colX + colStep / 2}
                  y={H - 12}
                  textAnchor="middle"
                >
                  {d.label}
                </text>
              )}
            </g>
          )
        })}
      </svg>

      {/* Tooltip */}
      {activeBucket && tooltipPos && (
        <div
          className="bklit-tooltip on"
          style={{
            position: 'absolute',
            left: `${tooltipPos.x}px`,
            top: `${tooltipPos.y}px`,
            transform: 'translateX(-50%)',
            pointerEvents: 'none',
          }}
        >
          <div className="bklit-tooltip-title">{activeBucket.label}</div>
          {STATUSES.slice()
            .reverse()
            .map((s) => (
              <div key={s.key} className="bklit-tooltip-row">
                <span className="bklit-tooltip-dot" style={{ background: s.fill }} />
                {s.name}: <b>{activeBucket[s.key]}</b>
              </div>
            ))}
        </div>
      )}
    </div>
  )
}
