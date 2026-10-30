import { useState } from 'react'
import { L } from '../../../i18n'
import { downloadText, keyFile, type KeyMeta } from '../api'

interface MintedSectionProps extends KeyMeta {
  secret: string
  onDone: () => void
}

export default function MintedSection({ secret, workspace, label, role, onDone }: MintedSectionProps) {
  const [copied, setCopied] = useState(false)
  const [saved, setSaved] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(secret)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // fallback
    }
  }

  // The file is the key in a form that survives a cleared browser: the
  // sign-in form reads it back, so saving it is saving the way in.
  const handleDownload = () => {
    const file = keyFile(secret, { ...(workspace ? { workspace } : {}), label, role })
    downloadText(file.name, file.text)
    setSaved(true)
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
              {L(
                'Shown once. Moat keeps only a hash of it. Save it as a file and you can sign in from the file later.',
                'يُعرض مرة واحدة. لا يحتفظ Moat إلا بتجزئة منه. احفظه كملف وستتمكن من تسجيل الدخول منه لاحقًا.',
              )}
            </p>
            <pre className="glass" id="secret">
              {secret}
            </pre>
            <div className="row">
              <button className="btn" id="copy-secret" onClick={handleCopy}>
                {copied ? L('Copied!', 'تم النسخ!') : L('Copy key', 'انسخ المفتاح')}
              </button>
              <button className="btn" id="download-secret" onClick={handleDownload}>
                {saved ? L('Saved', 'تم الحفظ') : L('Download as file', 'نزّله كملف')}
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
