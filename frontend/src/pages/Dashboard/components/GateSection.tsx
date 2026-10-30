import { useRef, useState } from 'react'
import { L } from '../../../i18n'
import { useThumb } from './bits'
import { Card } from '../../../components/ui/glass/card'
import { readKeyInput } from '../api'

interface GateSectionProps {
  onCreate: (id: string, name: string, email: string) => Promise<void>
  onSignin: (key: string) => Promise<void>
  /** Trade a mailed recovery key for a new admin key. */
  onRedeem: (recoveryKey: string) => Promise<void>
  /** Ask for a recovery key by mail; resolves to the gateway's own sentence. */
  onRecover: (workspace: string, email: string) => Promise<string>
}

export default function GateSection({ onCreate, onSignin, onRedeem, onRecover }: GateSectionProps) {
  const [tab, setTab] = useState<'new' | 'key'>('new')
  const [workspaceId, setWorkspaceId] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [keyInput, setKeyInput] = useState('')
  const [createNote, setCreateNote] = useState('')
  const [createBad, setCreateBad] = useState(false)
  const [signinNote, setSigninNote] = useState('')
  const [signinBad, setSigninBad] = useState(false)
  const [working, setWorking] = useState(false)
  const [lost, setLost] = useState(false)
  const [lostWorkspace, setLostWorkspace] = useState('')
  const [lostEmail, setLostEmail] = useState('')
  const [lostNote, setLostNote] = useState('')
  const [lostBad, setLostBad] = useState(false)
  const tablist = useRef<HTMLDivElement | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)
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
      await onCreate(workspaceId.trim(), displayName.trim() || workspaceId.trim(), email.trim())
    } catch (err: unknown) {
      setCreateNote(String((err as Error).message || err))
      setCreateBad(true)
    } finally {
      setWorking(false)
    }
  }

  // One box takes a key, a key file's contents, or a recovery key from the
  // mail; which it is decides which door it opens.
  const handleSignin = async () => {
    const input = readKeyInput(keyInput)
    if (!input) {
      setSigninNote(
        keyInput.trim()
          ? L('That is not a key or a key file.', 'هذا ليس مفتاحًا ولا ملف مفتاح.')
          : L('Paste a key to sign in', 'الصق مفتاحًا لتسجيل الدخول'),
      )
      setSigninBad(true)
      return
    }
    setWorking(true)
    setSigninNote(
      input.kind === 'recovery'
        ? L('Issuing a new admin key…', 'جارٍ إصدار مفتاح مسؤول جديد…')
        : L('Checking key…', 'جارٍ التحقق من المفتاح…'),
    )
    setSigninBad(false)
    try {
      if (input.kind === 'recovery') await onRedeem(input.key)
      else await onSignin(input.key)
    } catch (err: unknown) {
      setSigninNote(String((err as Error).message || err))
      setSigninBad(true)
    } finally {
      setWorking(false)
    }
  }

  // A key file chosen from disk: its text goes where a paste would go, and
  // the same reader decides what it is.
  const handleFile = async (file: File | undefined) => {
    if (!file) return
    const text = await file.text()
    if (!readKeyInput(text)) {
      setSigninNote(L('That file does not hold a Moat key.', 'هذا الملف لا يحتوي مفتاح Moat.'))
      setSigninBad(true)
      return
    }
    setKeyInput(text)
    setSigninNote(L(`Read ${file.name}. Log in to continue.`, `تمت قراءة ${file.name}. سجّل الدخول للمتابعة.`))
    setSigninBad(false)
  }

  const handleRecover = async () => {
    if (!lostWorkspace.trim() || !lostEmail.trim()) {
      setLostNote(L('Enter the workspace id and the owner email you signed up with.', 'أدخل معرّف مساحة العمل وبريد المالك الذي سجّلت به.'))
      setLostBad(true)
      return
    }
    setWorking(true)
    setLostNote(L('Sending…', 'جارٍ الإرسال…'))
    setLostBad(false)
    try {
      setLostNote(await onRecover(lostWorkspace.trim(), lostEmail.trim()))
    } catch (err: unknown) {
      setLostNote(String((err as Error).message || err))
      setLostBad(true)
    } finally {
      setWorking(false)
    }
  }

  return (
    <div className="wrap">
      <section className="tight" id="gate">
        <Card material="clear" tint="rgba(255, 135, 55, 0.10)" className="swiper gate-swiper" id="gate-swiper" role="tablist" ref={tablist} aria-label={L('How to start', 'كيف تبدأ')}>
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
        </Card>

        <div className="deck react-deck" id="gate-deck">
          <div className={`slide ${tab === 'new' ? 'on' : ''}`} id="slide-new" hidden={tab !== 'new'}>
            <Card material="clear" tint="rgba(255, 135, 55, 0.10)" className="panel gate-panel">
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
                <label className="lbl" htmlFor="new-email">
                  {L('Owner email, for recovering a lost key', 'بريد المالك، لاستعادة مفتاح مفقود')}
                </label>
                <input
                  id="new-email"
                  name="new-email"
                  type="email"
                  placeholder="you@company.com"
                  autoComplete="email"
                  maxLength={254}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                />
                <p className="hint">
                  {L(
                    'Optional. Without it, a lost admin key cannot be recovered.',
                    'اختياري. بدونه لا يمكن استعادة مفتاح مسؤول مفقود.',
                  )}
                </p>
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
            </Card>
          </div>

          <div className={`slide ${tab === 'key' ? 'on' : ''}`} id="slide-key" hidden={tab !== 'key'}>
            <Card material="clear" tint="rgba(255, 135, 55, 0.10)" className="panel gate-panel">
              <div className="ph">
                <h3>{L('Open one you have', 'افتح مساحة لديك')}</h3>
              </div>
              <div className="pb">
                <p className="hint">
                  {L(
                    'Paste an admin key or a recovery key, or use the key file you downloaded. It stays in this browser.',
                    'الصق مفتاح المسؤول أو مفتاح الاستعادة، أو استخدم ملف المفتاح الذي نزّلته. يبقى في هذا المتصفح.',
                  )}
                </p>
                <label className="lbl" htmlFor="key-in">
                  {L('Admin key', 'مفتاح المسؤول')}
                </label>
                <input
                  id="key-in"
                  name="key-in"
                  placeholder="moat_…  rk_…  {…}"
                  autoComplete="off"
                  spellCheck="false"
                  type="password"
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSignin()}
                />
                <input
                  ref={fileInput}
                  type="file"
                  accept=".json,application/json"
                  hidden
                  onChange={(e) => { void handleFile(e.target.files?.[0]); e.target.value = '' }}
                />
                <div className="row">
                  <button className="btn" id="signin" disabled={working} onClick={handleSignin}>
                    {L('Log in', 'تسجيل الدخول')}
                  </button>
                  <button className="btn ghost" id="key-file" type="button" disabled={working} onClick={() => fileInput.current?.click()}>
                    {L('Use a key file', 'استخدم ملف مفتاح')}
                  </button>
                </div>
                {signinNote && (
                  <p
                    className="hint"
                    id="signin-note"
                    style={{ color: signinBad ? 'var(--red-l)' : 'var(--ink-2)', marginTop: 8 }}
                  >
                    {signinNote}
                  </p>
                )}
                <button className="linkish" id="lost-key" type="button" aria-expanded={lost} onClick={() => setLost((v) => !v)}>
                  {L('Lost your admin key?', 'فقدت مفتاح المسؤول؟')}
                </button>
                {lost && (
                  <div className="lost" id="lost-form">
                    <p className="hint">
                      {L(
                        'A recovery key goes to the owner email given at signup. It works once, for 30 minutes, and issues a new admin key; the old admin keys stop working.',
                        'يُرسل مفتاح استعادة إلى بريد المالك الذي أُعطي عند التسجيل. يعمل مرة واحدة لمدة 30 دقيقة ويصدر مفتاح مسؤول جديدًا؛ وتتوقف مفاتيح المسؤول القديمة عن العمل.',
                      )}
                    </p>
                    <label className="lbl" htmlFor="lost-id">{L('Workspace id', 'معرّف مساحة العمل')}</label>
                    <input
                      id="lost-id"
                      name="lost-id"
                      placeholder="northwind-cloud"
                      autoComplete="off"
                      spellCheck="false"
                      maxLength={64}
                      value={lostWorkspace}
                      onChange={(e) => setLostWorkspace(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleRecover()}
                    />
                    <label className="lbl" htmlFor="lost-email">{L('Owner email', 'بريد المالك')}</label>
                    <input
                      id="lost-email"
                      name="lost-email"
                      type="email"
                      placeholder="you@company.com"
                      autoComplete="email"
                      maxLength={254}
                      value={lostEmail}
                      onChange={(e) => setLostEmail(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleRecover()}
                    />
                    <button className="btn ghost" id="recover" type="button" disabled={working} onClick={handleRecover}>
                      {L('Email me a recovery key', 'أرسل لي مفتاح استعادة')}
                    </button>
                    {lostNote && (
                      <p
                        className="hint"
                        id="lost-note"
                        style={{ color: lostBad ? 'var(--red-l)' : 'var(--ink-2)', marginTop: 8 }}
                      >
                        {lostNote}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </Card>
          </div>
        </div>
      </section>
    </div>
  )
}
