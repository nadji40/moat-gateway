import { Card } from '../../components/ui/glass/card'
import { L } from '../../i18n'
import { Play, ScanSearch, ShieldOff } from 'lucide-react'
import './security-flow.css'

type Kind = 'mandate' | 'classifier' | 'gateway'

const approaches = [
  {
    kind: 'mandate' as Kind,
    title: 'Mandate protocols',
    titleAr: 'بروتوكولات التفويض',
    meta: 'AP2, X402',
    description: 'That approval happened, not who wrote it',
    descriptionAr: 'حدثت الموافقة، وليس من كتبها',
    value: 'run',
    valueAr: 'تشغيل',
    suffix: 'BELOW',
    suffixAr: 'أدناه',
  },
  {
    kind: 'classifier' as Kind,
    title: 'Injection classifiers',
    titleAr: 'مصنّفات حقن التعليمات',
    meta: '',
    description: 'An instruction, when the content carries one',
    descriptionAr: 'تعليمة حين يحتوي المحتوى على واحدة',
    value: '12',
    valueAr: '12',
    suffix: 'OF 21 BLIND',
    suffixAr: 'من أصل 21 اختبارًا معمى',
  },
  {
    kind: 'gateway' as Kind,
    title: 'MCP gateways',
    titleAr: 'بوابات MCP',
    meta: '',
    description: 'Every call. It simply never decides a payment.',
    descriptionAr: 'كل استدعاء. لكنها لا تتخذ قرارًا بشأن الدفع.',
    value: 'no',
    valueAr: 'لا',
    suffix: 'VERDICT',
    suffixAr: 'النتيجة',
  },
]

function ApproachIcon({ kind }: { kind: Kind }) {
  if (kind === 'mandate') {
    return (
      <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M16 3.5 27 8v8.5c0 7.1-4.4 11-11 13-6.6-2-11-5.9-11-13V8L16 3.5Z" />
        <path d="M12 14h8M12 18h8" />
      </svg>
    )
  }
  if (kind === 'classifier') {
    return (
      <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 7h24L19 17v8l-6 3V17L4 7Z" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <circle cx="16" cy="16" r="5" />
      <path d="M16 2v9M16 21v9M2 16h9M21 16h9" />
      <circle cx="16" cy="16" r="1.3" fill="currentColor" stroke="none" />
    </svg>
  )
}

export default function SecurityFlow() {
  return (
    <section className="compare-security-flow" aria-labelledby="compare-security-flow-heading">
      <div className="compare-security-flow-heading">
        <h2 id="compare-security-flow-heading">
          {L('ASKED THEIR OWN QUESTION', 'طرحوا سؤالهم الخاص')}
        </h2>
        <p className="compare-section-subtitle">{L('Three approaches to the same payment security problem.', 'ثلاثة أساليب لمعالجة مشكلة أمان الدفع نفسها.')}</p>
      </div>

      <div className="compare-security-flow-cards">
        {approaches.map(approach => (
          <Card
            key={approach.kind}
            material="clear"
            tint="rgba(255, 135, 55, 0.18)"
            className={`compare-security-flow-card compare-security-flow-card-${approach.kind}`}
          >
            <Card
  material="clear"
  tint="rgba(255, 135, 55, 0.18)"
  className="compare-security-flow-icon"
  aria-hidden="true"
>
  <ApproachIcon kind={approach.kind} />
</Card>

            <div className="compare-security-flow-title-group">
              <h3>{L(approach.title, approach.titleAr)}</h3>
              {approach.meta && (
                <span className="compare-security-flow-meta" dir="ltr">
                  {approach.meta}
                </span>
              )}
            </div>

            <p className="compare-security-flow-description">
              {L(approach.description, approach.descriptionAr)}
            </p>

            <div className="compare-security-flow-result">
              <span className="compare-security-flow-result-icon" aria-hidden="true">
                {approach.kind === 'mandate' ? (
                  <Play size={19} strokeWidth={2.2} fill="currentColor" />
                ) : approach.kind === 'classifier' ? (
                  <ScanSearch size={19} strokeWidth={2} />
                ) : (
                  <ShieldOff size={19} strokeWidth={2} />
                )}
              </span>
              <span className="compare-security-flow-result-copy">
                <strong>{L(approach.value, approach.valueAr)}</strong>
                <small>{L(approach.suffix, approach.suffixAr)}</small>
              </span>
            </div>
          </Card>
        ))}
      </div>
    </section>
  )
}
