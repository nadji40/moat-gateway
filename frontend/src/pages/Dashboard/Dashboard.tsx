import { useState, useEffect, useCallback, useRef } from 'react'
import { L } from '../../i18n'
import { call, held, hold, type KeyMeta } from './api'
import Topbar from './components/Topbar'
import Sidebar, { Tabbar } from './components/Sidebar'
import UsagePane from './components/UsagePane'
import VerdictsPane from './components/VerdictsPane'
import ApiKeysPane from './components/ApiKeysPane'
import PlaygroundPane from './components/PlaygroundPane'
import ConnectPane from './components/ConnectPane'
import Tour from './components/Tour'
import GateSection from './components/GateSection'
import { LiquidGlassProvider } from '../../components/ui/liquid/liquid-glass-provider'
import MintedSection from './components/MintedSection'
import VerdictDrawer from './components/VerdictDrawer'
import AssistantPanel, { AssistantLauncher } from './components/Assistant'
import Footer from '../../components/layout/Footer'
import type { Verdict, ApiKey, UsageData, PaneId } from './types'
// The console's own styles travel with this page's chunk, so the other pages
// never load them.
import '../../styles/console.css'
import '../../styles/chart-components.css'

const PANES: PaneId[] = ['pane-usage', 'pane-verdicts', 'pane-keys', 'pane-connect', 'pane-playground']

/* Per-browser preferences: the theme, a folded sidebar, and whether the tour
   has been seen. Conveniences only, so a private window simply forgets them. */
const pref = {
  get: (k: string) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* a private window */ } },
}
type Theme = 'dark' | 'light'
const THEME = 'moat.ws.theme'
const FOLDED = 'moat.ws.collapsed'
const TOURED = 'moat.ws.toured'

/** The pane named in the address, so a reload or a shared link lands there.
 *  With none named, the playground: the first thing to do in a new workspace
 *  is to watch a payment be refused. */
function paneFromHash(): PaneId {
  const h = typeof location !== 'undefined' ? location.hash.slice(1) : ''
  return (PANES as string[]).includes(h) ? (h as PaneId) : 'pane-playground'
}

export default function Dashboard() {
  const [authed, setAuthed] = useState(() => Boolean(held()))
  const [showMinted, setShowMinted] = useState(false)
  const [secret, setSecret] = useState('')
  // What the shown secret is, for the file it can be saved as.
  const [minted, setMinted] = useState<KeyMeta>({ label: 'key', role: 'admin' })
  const [activePane, setActivePane] = useState<PaneId>(paneFromHash)
  const [feed, setFeed] = useState<Verdict[]>([])
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [usage, setUsage] = useState<UsageData | null>(null)
  const [error, setError] = useState('')
  const [drawerVerdict, setDrawerVerdict] = useState<Verdict | null>(null)
  const returnToRef = useRef<HTMLElement | null>(null)
  const [theme, setTheme] = useState<Theme>(() => (pref.get(THEME) === 'light' ? 'light' : 'dark'))
  const [collapsed, setCollapsed] = useState(() => pref.get(FOLDED) === '1')
  const [touring, setTouring] = useState(false)
  const [assistantOpen, setAssistantOpen] = useState(false)

  // The theme belongs to the workspace, so it is set while the workspace is
  // open and taken off again when it closes.
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    pref.set(THEME, theme)
    return () => { delete document.documentElement.dataset.theme }
  }, [theme])

  useEffect(() => { pref.set(FOLDED, collapsed ? '1' : '0') }, [collapsed])

  useEffect(() => {
    document.title = L('moat, your workspace', 'moat، مساحة عملك')
  }, [])

  // The workspace draws its own header, so the site's navigation steps aside.
  useEffect(() => {
    document.body.classList.toggle('in-ws', authed && !showMinted)
    return () => { document.body.classList.remove('in-ws') }
  }, [authed, showMinted])

  // A link to another pane, or the browser's back button, changes the hash
  // without loading the page again.
  useEffect(() => {
    const follow = () => setActivePane(paneFromHash())
    window.addEventListener('hashchange', follow)
    return () => window.removeEventListener('hashchange', follow)
  }, [])

  const choosePane = useCallback((pane: PaneId) => {
    setActivePane(pane)
    history.replaceState(null, '', '#' + pane)
    // A new pane starts at its top: the page on a phone, the surface on a desktop.
    window.scrollTo?.({ top: 0 })
    document.querySelector('.surface')?.scrollTo?.({ top: 0 })
  }, [])

  // The first time a workspace is opened in this browser, the tour offers
  // itself; after that it is the button in the header.
  useEffect(() => {
    if (authed && !showMinted && !pref.get(TOURED)) setTouring(true)
  }, [authed, showMinted])

  const endTour = useCallback(() => {
    setTouring(false)
    pref.set(TOURED, '1')
  }, [])

  const refresh = useCallback(async () => {
    const [usageRes, feedRes, keysRes] = await Promise.allSettled([
      call<UsageData>('/v1/usage'),
      call<Verdict[]>('/v1/verdicts'),
      call<ApiKey[]>('/v1/keys'),
    ])
    if (usageRes.status === 'fulfilled') setUsage(usageRes.value)
    if (feedRes.status === 'fulfilled') setFeed(feedRes.value)
    if (keysRes.status === 'fulfilled') setKeys(keysRes.value)
    const failed = [usageRes, feedRes, keysRes].find((r) => r.status === 'rejected')
    setError(failed && failed.status === 'rejected' ? String((failed.reason as Error)?.message || failed.reason) : '')
  }, [])

  useEffect(() => {
    if (authed && !showMinted) void refresh()
  }, [authed, showMinted, refresh])

  const handleCreate = async (id: string, name: string, email: string) => {
    const out = await call<{ secret: string; workspace?: string }>(
      '/v1/signup',
      { method: 'POST', body: JSON.stringify({ id, name, ...(email ? { email } : {}) }) },
      null,
    )
    hold(out.secret)
    setSecret(out.secret)
    setMinted({ workspace: out.workspace ?? id, label: 'first admin key', role: 'admin' })
    setShowMinted(true)
    setAuthed(true)
  }

  // Neither recovery call carries a key: the caller has lost theirs.
  const handleRecover = async (workspace: string, email: string) => {
    const out = await call<{ message?: string }>(
      '/v1/recover',
      { method: 'POST', body: JSON.stringify({ workspace, email }) },
      null,
    )
    return out.message || L('If that matches a workspace, a recovery key is on its way.', 'إذا طابق ذلك مساحة عمل، فمفتاح الاستعادة في طريقه إليك.')
  }

  const handleRedeem = async (recoveryKey: string) => {
    const out = await call<{ secret: string; workspace?: string }>(
      '/v1/recover/redeem',
      { method: 'POST', body: JSON.stringify({ recovery_key: recoveryKey }) },
      null,
    )
    hold(out.secret)
    setSecret(out.secret)
    setMinted({ ...(out.workspace ? { workspace: out.workspace } : {}), label: 'recovered admin key', role: 'admin' })
    setShowMinted(true)
    setAuthed(true)
  }

  const handleSignin = async (key: string) => {
    hold(key)
    try {
      await call('/v1/keys')
      setAuthed(true)
    } catch (e) {
      hold(null)
      throw e
    }
  }

  const handleSignout = () => {
    hold(null)
    setAuthed(false)
    setShowMinted(false)
    setFeed([])
    setKeys([])
    setUsage(null)
  }

  const handleMintKey = async (label: string, role: string, days: number | null, scopes: string[]) => {
    const out = await call<{ secret: string }>('/v1/keys', {
      method: 'POST',
      body: JSON.stringify({
        label,
        access_role: role,
        scopes,
        ...(days ? { expires_in_days: days } : {}),
      }),
    })
    setSecret(out.secret)
    setMinted({ label, role })
    setShowMinted(true)
  }

  // Revoking is permanent: the gateway keeps the row, marked revoked, so the
  // key's history stays readable.
  const handleRevokeKey = async (keyId: string) => {
    await call('/v1/keys/' + encodeURIComponent(keyId), { method: 'DELETE' })
    await refresh()
  }

  const handleOpenVerdict = (evidenceId: string) => {
    const v = feed.find((x) => x.evidence_id === evidenceId)
    if (v) {
      returnToRef.current = document.activeElement as HTMLElement
      setDrawerVerdict(v)
    }
  }

  const handleCloseVerdict = () => {
    setDrawerVerdict(null)
    returnToRef.current?.focus?.()
  }

  if (!authed) {
    // The same liquid-glass renderer as the site's pages, for the gate only:
    // the signed-in console keeps its own surfaces.
    return (
      <LiquidGlassProvider
        backdrop="/glass-backdrop.svg"
        options={{ refraction: 16, dispersion: 0.035, frost: 8, liquid: false }}
      >
        <GateSection onCreate={handleCreate} onSignin={handleSignin} onRedeem={handleRedeem} onRecover={handleRecover} />
        <Footer />
      </LiquidGlassProvider>
    )
  }

  if (showMinted) {
    return (
      <>
        <MintedSection secret={secret} {...minted} onDone={() => setShowMinted(false)} />
        <Footer />
      </>
    )
  }

  const currentKey = keys.find((k) => k.current)
  const keyLabel = currentKey?.label || L('an admin key', 'مفتاح المسؤول')
  const liveKeys = keys.filter((k) => k.active && !k.expired).length

  return (
    <>
      <div className="shell">
        <Topbar onSignout={handleSignout} keyLabel={keyLabel} theme={theme}
          onTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))} onTour={() => setTouring(true)}
          onAssistant={() => setAssistantOpen(true)} />
        <div className={`app ${collapsed ? 'collapsed' : ''}`}>
          <Sidebar
            activePane={activePane}
            onPaneChange={choosePane}
            keyLabel={keyLabel}
            keyId={currentKey?.id}
            keysCount={liveKeys}
            verdictsCount={feed.length}
            collapsed={collapsed}
            onToggleCollapse={() => setCollapsed((c) => !c)}
          />
          <main className="surface" id="main-content">
            {activePane === 'pane-usage' && (
              <UsagePane feed={feed} usage={usage} onOpenVerdict={handleOpenVerdict} />
            )}
            {activePane === 'pane-verdicts' && (
              <VerdictsPane feed={feed} onOpenVerdict={handleOpenVerdict} />
            )}
            {activePane === 'pane-keys' && (
              <ApiKeysPane
                keys={keys}
                onMintKey={handleMintKey}
                onRevokeKey={handleRevokeKey}
                error={error}
              />
            )}
            {activePane === 'pane-connect' && <ConnectPane />}
            {activePane === 'pane-playground' && <PlaygroundPane onAttempted={refresh} />}
          </main>
        </div>
        <Tabbar activePane={activePane} onPaneChange={choosePane} keysCount={liveKeys} verdictsCount={feed.length} />
        {touring && <Tour onPane={choosePane} onClose={endTour} />}
        <AssistantLauncher open={assistantOpen} onOpen={() => setAssistantOpen(true)} />
        <AssistantPanel open={assistantOpen} onClose={() => setAssistantOpen(false)} pane={activePane} />
      </div>

      {drawerVerdict && (
        <>
          <div className="scrim" onClick={handleCloseVerdict} />
          <VerdictDrawer verdict={drawerVerdict} onClose={handleCloseVerdict} />
        </>
      )}
    </>
  )
}
