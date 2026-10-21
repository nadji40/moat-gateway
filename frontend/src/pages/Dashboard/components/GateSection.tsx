import { useRef, useState } from 'react'
import { L } from '../../../i18n'
import { useThumb } from './bits'

interface GateSectionProps {
  onCreate: (id: string, name: string) => Promise<void>
  onSignin: (key: string) => Promise<void>
}

export default function GateSection({ onCreate, onSignin }: GateSectionProps) {
  const [tab, setTab] = useState<'new' | 'key'>('new')
  const [workspaceId, setWorkspaceId] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [keyInput, setKeyInput] = useState('')
  const [createNote, setCreateNote] = useState('')
  const [createBad, setCreateBad] = useState(false)
  const [signinNote, setSigninNote] = useState('')
  const [signinBad, setSigninBad] = useState(false)
  const [working, setWorking] = useState(false)
  const tablist = useRef<HTMLDivElement | null>(null)
  const thumb = useThumb(tablist, tab === 'new' ? 0 : 1)

  const handleCreate = async () => {
    if (!workspaceId.trim()) {
      setCreateNote(L('Enter a workspace id', 'أدخل معرّف مساحة العمل'))
      setCreateBad(true)
      return
    }
    setWorking(true)
    setCreateNote(L('Minting workspace and admin key…', 'جارٍ إنشاء مساحة العمل ومفتاح المسؤول…'))
    setCreateBad(false)
    try {
      await onCreate(workspaceId.trim(), displayName.trim() || workspaceId.trim())
    } catch (err: unknown) {
      setCreateNote(String((err as Error).message || err))
      setCreateBad(true)
    } finally {
      setWorking(false)
    }
  }

  const handleSignin = async () => {
    if (!keyInput.trim()) {
      setSigninNote(L('Paste a key to sign in', 'الصق مفتاحًا لتسجيل الدخول'))
      setSigninBad(true)
      return
    }
    setWorking(true)
    setSigninNote(L('Checking key…', 'جارٍ التحقق من المفتاح…'))
    setSigninBad(false)
    try {
      await onSignin(keyInput.trim())
    } catch (err: unknown) {
      setSigninNote(String((err as Error).message || err))
      setSigninBad(true)
    } finally {
      setWorking(false)
    }
  }

  return (
    <div className="wrap">
      <section className="tight" id="gate">
        <div className="swiper" id="gate-swiper" role="tablist" ref={tablist} aria-label={L('How to start', 'كيف تبدأ')}>
          <span className="thumb" aria-hidden="true" style={thumb} />
          <button
            role="tab"
            aria-controls="slide-new"
            aria-selected={tab === 'new'}
            onClick={() => setTab('new')}
          >
            {L('Create a workspace', 'أنشئ مساحة عمل')}
          </button>
          <button
            role="tab"
            aria-controls="slide-key"
            aria-selected={tab === 'key'}
            onClick={() => setTab('key')}
          >
            {L('I have a key', 'لديّ مفتاح')}
          </button>
        </div>

        <div className="deck react-deck" id="gate-deck">
          <div className={`slide ${tab === 'new' ? 'on' : ''}`} id="slide-new" hidden={tab !== 'new'}>
            <article className="panel glass">
              <div className="ph">
                <h3>{L('Open a workspace', 'افتح مساحة عمل')}</h3>
              </div>
              <div className="pb">
                <p className="hint">
                  {L('Your keys and every verdict, in one place.', 'مفاتيحك وكل الأحكام، في مكان واحد.')}
                </p>
                <label className="lbl" htmlFor="new-id">
                  {L('Workspace id', 'معرّف مساحة العمل')}
                </label>
                <input
                  id="new-id"
                  name="new-id"
                  placeholder="northwind-cloud"
                  autoComplete="off"
                  spellCheck="false"
                  maxLength={64}
                  value={workspaceId}
                  onChange={(e) => setWorkspaceId(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                />
                <label className="lbl" htmlFor="new-name">
                  {L('Display name', 'الاسم المعروض')}
                </label>
                <input
                  id="new-name"
                  name="new-name"
                  placeholder="Northwind Cloud Co"
                  autoComplete="off"
                  maxLength={120}
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                />
                <button className="btn" id="create" disabled={working} onClick={handleCreate}>
                  {L('Create workspace', 'أنشئ مساحة العمل')}
                </button>
                {createNote && (
                  <p
                    className="hint"
                    id="signup-note"
                    style={{ color: createBad ? 'var(--red-l)' : 'var(--ink-2)', marginTop: 8 }}
                  >
                    {createNote}
                  </p>
                )}
              </div>
            </article>
          </div>

          <div className={`slide ${tab === 'key' ? 'on' : ''}`} id="slide-key" hidden={tab !== 'key'}>
            <article className="panel glass">
              <div className="ph">
                <h3>{L('Open one you have', 'افتح مساحة لديك')}</h3>
              </div>
              <div className="pb">
                <p className="hint">
                  {L('Paste an admin key. It stays in this browser.', 'الصق مفتاح المسؤول. يبقى في هذا المتصفح.')}
                </p>
                <label className="lbl" htmlFor="key-in">
                  {L('Admin key', 'مفتاح المسؤول')}
                </label>
                <input
                  id="key-in"
                  name="key-in"
                  placeholder="moat_..."
                  autoComplete="off"
                  spellCheck="false"
                  type="password"
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSignin()}
                />
                <button className="btn" id="signin" disabled={working} onClick={handleSignin}>
                  {L('Log in', 'تسجيل الدخول')}
                </button>
                {signinNote && (
                  <p
                    className="hint"
                    id="signin-note"
                    style={{ color: signinBad ? 'var(--red-l)' : 'var(--ink-2)', marginTop: 8 }}
                  >
                    {signinNote}
                  </p>
                )}
              </div>
            </article>
          </div>
        </div>
      </section>
    </div>
  )
}
