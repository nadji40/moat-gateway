import { useState } from 'react'
import { L } from '../../../i18n'
import { vmeta, moneyOf, railOf, ruleText, failedOf, CALL } from '../formatters'
import type { Verdict } from '../types'

interface VerdictDrawerProps {
  verdict: Verdict
  onClose: () => void
}

const SOURCE_NAMES: Record<string, string> = {
  user: L('the user', 'المستخدم'),
  allowlist: L('your allowlist', 'قائمتك المسموح بها'),
  tool_result: L('a tool result, not the user', 'نتيجة أداة، لا المستخدم'),
  unknown: L('nowhere Moat could trace', 'مصدر لم يتمكن Moat من تتبّعه'),
}

export default function VerdictDrawer({ verdict, onClose }: VerdictDrawerProps) {
  const [copied, setCopied] = useState(false)

  const m = vmeta(verdict.verdict)
  const failed = failedOf(verdict)
  const payeeName = verdict.payee || verdict.tool || CALL

  const handleCopyEvidence = async () => {
    if (!verdict.evidence_id) return
    try {
      await navigator.clipboard.writeText(verdict.evidence_id)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // fallback
    }
  }

  const kvList: [string, string | undefined, boolean?][] = [
    [
      L('Payee from', 'مصدر المستفيد'),
      verdict.payee_source
        ? SOURCE_NAMES[verdict.payee_source] || verdict.payee_source
        : undefined,
    ],
    [L('Rail', 'القناة'), railOf(verdict.rail)],
    [L('Tool', 'الأداة'), verdict.tool],
    [
      L('When', 'الوقت'),
      verdict.at ? new Date(verdict.at).toLocaleString() : undefined,
    ],
    [L('Session', 'الجلسة'), verdict.session_id, true],
    [L('Evidence', 'الأدلة'), verdict.evidence_id, true],
  ].filter(([, val]) => Boolean(val))

  return (
    <aside
      className="drawer on"
      id="drawer"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dr-payee"
    >
      <div className="dr-h">
        <span
          id="dr-pill"
          className={`pill ${m.cls || ''}`}
          style={{ background: m.c, color: '#000', fontWeight: 600, padding: '2px 10px', borderRadius: 999 }}
        >
          {m.label}
        </span>
        <button
          className="dr-x"
          id="dr-x"
          type="button"
          aria-label={L('Close', 'إغلاق')}
          onClick={onClose}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
          >
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      <div>
        <h2 id="dr-payee">{payeeName}</h2>
        <p className="dr-amt mono" id="dr-amt">
          {moneyOf(verdict)}
        </p>
      </div>

      <ul className="dr-why" id="dr-why">
        {failed.length > 0 ? (
          failed.map((id) => (
            <li key={id}>
              <span>
                {ruleText(id)}
                <code>{id}</code>
              </span>
            </li>
          ))
        ) : (
          <li>
            <span>
              {verdict.verdict === 'allow'
                ? L(
                    'Every field traced back to the user or an approval.',
                    'كل حقل يعود إلى المستخدم أو إلى موافقة.'
                  )
                : L('No rule detail on this record.', 'لا تفاصيل عن القواعد في هذا السجل.')}
            </span>
          </li>
        )}
      </ul>

      <dl className="dr-kv" id="dr-kv">
        {kvList.map(([k, val, mono], i) => (
          <div key={i} style={{ display: 'contents' }}>
            <dt>{k}</dt>
            <dd className={mono ? 'mono' : ''}>{val}</dd>
          </div>
        ))}
      </dl>

      <div className="row">
        <button
          className="btn ghost small"
          id="dr-copy"
          type="button"
          onClick={handleCopyEvidence}
        >
          {copied ? L('Copied', 'تم النسخ') : L('Copy evidence id', 'انسخ معرّف الأدلة')}
        </button>
      </div>
    </aside>
  )
}
