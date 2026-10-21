import { useState } from 'react'
import { L } from '../../../i18n'

interface MintedSectionProps {
  secret: string
  onDone: () => void
}

export default function MintedSection({ secret, onDone }: MintedSectionProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(secret)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // fallback
    }
  }

  return (
    <div className="wrap">
      <section className="tight" id="minted">
        <div className="panel glass">
          <div className="ph">
            <h3>{L('Save this now', 'احفظه الآن')}</h3>
          </div>
          <div className="pb">
            <p className="hint">
              {L('Shown once. Moat keeps only a hash of it.', 'يُعرض مرة واحدة. لا يحتفظ Moat إلا بتجزئة منه.')}
            </p>
            <pre className="glass" id="secret">
              {secret}
            </pre>
            <div className="row">
              <button className="btn" id="copy-secret" onClick={handleCopy}>
                {copied ? L('Copied!', 'تم النسخ!') : L('Copy key', 'انسخ المفتاح')}
              </button>
              <button className="btn ghost" id="minted-done" onClick={onDone}>
                {L('I have saved it', 'حفظته')}
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
