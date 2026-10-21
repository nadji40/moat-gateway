
import { Card } from '../../components/ui/glass/card'
import { ShieldCheck } from 'lucide-react'
import {
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import type { TooltipContentProps } from 'recharts'
import { L } from '../../i18n'

const TOTAL_ATTEMPTS = 380
const RISK_GRADIENT_ID = 'moat-benchmark-risk-gradient'

const data = [
  {
    name: 'Key-level policy',
    nameAr: 'سياسة على مستوى المفتاح',
    description: 'The transaction, not where the address came from',
    descriptionAr: 'المعاملة، لا مصدر العنوان',
    passed: 370,
    color: '#C6455C',
  },
  {
    name: 'Payee allowlists',
    nameAr: 'قوائم المستفيدين المسموح بها',
    description: 'The name on the call, not the account behind it',
    descriptionAr: 'الاسم في الطلب، لا الحساب الذي وراءه',
    passed: 190,
    color: '#DFA15A',
  },
  {
    name: 'moat',
    nameAr: 'moat',
    description: 'Everything the agent reads, and the payment it then makes',
    descriptionAr: 'كل ما يقرؤه الوكيل، والدفعة التي يجريها بعد ذلك',
    passed: 0,
    color: '#28D58B',
  },
] as const

type BenchmarkItem = (typeof data)[number]

function BenchmarkIcon({ index }: { index: number }) {
  if (index === 0) {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="8" cy="12" r="4" />
        <path d="M12 12h9M18 12v3.5M15.5 12v2.5" />
      </svg>
    )
  }

  if (index === 1) {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M4 20h16M4 16c3-6 5 2 8-3s4 1 8-4" />
      </svg>
    )
  }

  return (
    <svg viewBox="69 43 144 144" aria-hidden="true">
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="13"
        strokeLinecap="round"
      >
        <path d="M117 52.4A67 67 0 0 1 202.7 141.2M177.5 171.2A67 67 0 0 1 86.1 76.6" />
      </g>
      <g fill="currentColor">
        <circle cx="99.7" cy="62.2" r="12" />
        <circle cx="192.3" cy="158.1" r="12" />
      </g>
    </svg>
  )
}

type BenchmarkTooltipProps = Pick<
  TooltipContentProps<number, string>,
  'active' | 'payload'
>

function BenchmarkTooltip({
  active,
  payload,
}: BenchmarkTooltipProps) {
  if (!active || !payload?.length) return null

  const item = payload[0]?.payload as BenchmarkItem | undefined
  if (!item) return null

  const isMoat = item.name === 'moat'

  return (
    <div className="moat-benchmark-tooltip">
      <div className="moat-benchmark-tooltip-title">
        <span
          className="moat-benchmark-tooltip-dot"
          style={{
            background: isMoat
              ? item.color
              : 'linear-gradient(90deg, #DFA15A, #D86A52, #C6455C)',
          }}
        />
        <strong>{L(item.name, item.nameAr)}</strong>
      </div>

      <div className="moat-benchmark-tooltip-value">
        <strong style={{ color: item.color }}>
          {item.passed}
        </strong>
        <span>/ {TOTAL_ATTEMPTS}</span>
      </div>

      <p>
        {L(
          'Unauthorized payments passed',
          'مدفوعات غير مصرح بها تم تمريرها'
        )}
      </p>
    </div>
  )
}

function BenchmarkLabel({ index }: { index: number }) {
  const item = data[index]
  if (!item) return null

  return (
    <div className="moat-benchmark-label">
      <Card
  material="clear"
  tint="rgba(255, 135, 55, 0.18)"
  className="moat-benchmark-label-icon"
  aria-hidden="true"
  style={{ color: item.color }}
>
  <BenchmarkIcon index={index} />
</Card>

      <div className="moat-benchmark-label-copy">
        <strong>{L(item.name, item.nameAr)}</strong>
        <span>{L(item.description, item.descriptionAr)}</span>
      </div>
    </div>
  )
}

/* Existing Recharts chart: desktop and tablet */
function DesktopBenchmark() {
  return (
    <div className="moat-benchmark-chart moat-benchmark-desktop">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          layout="vertical"
          margin={{
            top: 8,
            right: 24,
            left: 4,
            bottom: 8,
          }}
          barCategoryGap="35%"
        >
          <defs>
            <linearGradient
              id={RISK_GRADIENT_ID}
              x1="0%"
              y1="0%"
              x2="100%"
              y2="0%"
            >
              <stop offset="0%" stopColor="#DFA15A" />
              <stop offset="45%" stopColor="#D86A52" />
              <stop offset="100%" stopColor="#C6455C" />
            </linearGradient>
          </defs>

          <CartesianGrid
            horizontal={false}
            stroke="rgba(255,255,255,0.09)"
            strokeDasharray="3 6"
          />

          <XAxis
            type="number"
            domain={[0, TOTAL_ATTEMPTS]}
            ticks={[0, 95, 190, 285, 380]}
            tick={{
              fill: '#92929D',
              fontSize: 12,
            }}
            axisLine={false}
            tickLine={false}
            allowDecimals={false}
          />

          <YAxis
            type="category"
            dataKey="name"
            width={290}
            interval={0}
            axisLine={false}
            tickLine={false}
            tick={({ x, y, payload }) => {
              const index = data.findIndex(
                item => item.name === payload.value
              )

              if (index < 0) return <g />

              return (
                <g>
                  <foreignObject
                    x={Number(x) - 282}
                    y={Number(y) - 28}
                    width={278}
                    height={56}
                  >
                    <BenchmarkLabel index={index} />
                  </foreignObject>
                </g>
              )
            }}
          />

          <Tooltip
            content={({ active, payload }) => (
              <BenchmarkTooltip
                active={active}
                payload={payload}
              />
            )}
            cursor={{
              fill: 'rgba(255,255,255,0.035)',
              stroke: 'rgba(255,255,255,0.06)',
              strokeWidth: 1,
            }}
            wrapperStyle={{
              outline: 'none',
              zIndex: 10,
            }}
          />

          <Bar
            dataKey="passed"
            name="Unauthorized payments passed"
            barSize={26}
            radius={[6, 6, 6, 6]}
            isAnimationActive={false}
            activeBar={false}
          >
            {data.map(item => (
              <Cell
                key={item.name}
                fill={
                  item.name === 'moat'
                    ? item.color
                    : `url(#${RISK_GRADIENT_ID})`
                }
                fillOpacity={
                  item.name === 'Payee allowlists'
                    ? 0.85
                    : 1
                }
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

/* Dedicated mobile layout: no clipped descriptions or bars */
function MobileBenchmark() {
  return (
    <div className="moat-benchmark-mobile">
      {data.map((item, index) => {
        const isMoat = item.name === 'moat'
        const percentage =
          (item.passed / TOTAL_ATTEMPTS) * 100

        return (
          <div
            className="moat-benchmark-mobile-item"
            key={item.name}
          >
            <div className="moat-benchmark-mobile-heading">
              <Card
  material="clear"
  tint="rgba(255, 135, 55, 0.18)"
  className="moat-benchmark-label-icon"
  aria-hidden="true"
  style={{ color: item.color }}
>
  <BenchmarkIcon index={index} />
</Card>

              <div className="moat-benchmark-label-copy">
                <strong>
                  {L(item.name, item.nameAr)}
                </strong>
                <span>
                  {L(item.description, item.descriptionAr)}
                </span>
              </div>
            </div>

            <div className="moat-benchmark-mobile-value">
              <span>
                {L(
                  'Unauthorized payments passed',
                  'مدفوعات غير مصرح بها تم تمريرها'
                )}
              </span>

              <strong
                style={{
                  color: isMoat ? item.color : '#F5F5F5',
                }}
                dir="ltr"
              >
                {item.passed} / {TOTAL_ATTEMPTS}
              </strong>
            </div>

            <div
              className="moat-benchmark-mobile-track"
              role="img"
              aria-label={L(
                `${item.name}: ${item.passed} of ${TOTAL_ATTEMPTS} unauthorized payments passed`,
                `${item.nameAr}: مرت ${item.passed} من أصل ${TOTAL_ATTEMPTS} دفعة غير مصرح بها`
              )}
            >
              {isMoat ? (
                <span className="moat-benchmark-mobile-zero" />
              ) : (
                <div
                  className="moat-benchmark-mobile-fill"
                  style={{ width: `${percentage}%` }}
                />
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export default function BenchmarkChart() {
  return (
    <Card
      material="clear"
      tint="rgba(255, 135, 55, 0.18)"
      className="moat-benchmark-card"
      aria-label={L(
        'Security benchmark comparing 380 payment attempts',
        'مقارنة أمنية بين 380 محاولة دفع'
      )}
    >
      <DesktopBenchmark />

      <MobileBenchmark />

      <div className="moat-benchmark-success">
  <span className="moat-benchmark-success-icon" aria-hidden="true">
    <ShieldCheck size={21} strokeWidth={1.8} />
  </span>
  <strong>
          {L(
            'MOAT: 0 unauthorized payments passed',
            'MOAT: لم تمر أي دفعة غير مصرح بها'
          )}
        </strong>
      </div>

      <p className="moat-benchmark-note">
        {L(
          "The 370 and the 190 are our own baseline arms. No vendor's product has been run.",
          'الرقمان 370 و190 هما ذراعا خط الأساس لدينا. لم يُشغَّل منتج أي مورّد.'
        )}
      </p>
    </Card>
  )
}
