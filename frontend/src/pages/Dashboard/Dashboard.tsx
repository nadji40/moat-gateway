import { useState, useEffect, useCallback, useRef } from 'react'
import { L } from '../../i18n'
import { call, held, hold } from './api'
import Topbar from './components/Topbar'
import Sidebar, { Tabbar } from './components/Sidebar'
import UsagePane from './components/UsagePane'
import VerdictsPane from './components/VerdictsPane'
import ApiKeysPane from './components/ApiKeysPane'
import PlaygroundPane from './components/PlaygroundPane'
import GateSection from './components/GateSection'
import MintedSection from './components/MintedSection'
import VerdictDrawer from './components/VerdictDrawer'
import Footer from '../../components/layout/Footer'
import type { Verdict, ApiKey, UsageData, PaneId } from './types'
// The console's own styles travel with this page's chunk, so the other pages
// never load them.
import '../../styles/console.css'
import '../../styles/chart-components.css'

const PANES: PaneId[] = ['pane-usage', 'pane-verdicts', 'pane-keys', 'pane-playground']

/** The pane named in the address, so a reload or a shared link lands there. */
function paneFromHash(): PaneId {
  const h = typeof location !== 'undefined' ? location.hash.slice(1) : ''
  return (PANES as string[]).includes(h) ? (h as PaneId) : 'pane-usage'
}

export default function Dashboard() {
  const [authed, setAuthed] = useState(() => Boolean(held()))
  const [showMinted, setShowMinted] = useState(false)
  const [secret, setSecret] = useState('')
  const [activePane, setActivePane] = useState<PaneId>(paneFromHash)
  const [feed, setFeed] = useState<Verdict[]>([])
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [usage, setUsage] = useState<UsageData | null>(null)
  const [error, setError] = useState('')
  const [drawerVerdict, setDrawerVerdict] = useState<Verdict | null>(null)
  const returnToRef = useRef<HTMLElement | null>(null)

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

  const choosePane = (pane: PaneId) => {
    setActivePane(pane)
    history.replaceState(null, '', '#' + pane)
    // A new pane starts at its top: the page on a phone, the surface on a desktop.
    window.scrollTo?.({ top: 0 })
    document.querySelector('.surface')?.scrollTo?.({ top: 0 })
  }

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

  const handleCreate = async (id: string, name: string) => {
    const out = await call<{ secret: string }>('/v1/signup', { method: 'POST', body: JSON.stringify({ id, name }) }, null)
    hold(out.secret)
    setSecret(out.secret)
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
    return (
      <>
        <GateSection onCreate={handleCreate} onSignin={handleSignin} />
        <Footer />
      </>
    )
  }

  if (showMinted) {
    return (
      <>
        <MintedSection secret={secret} onDone={() => setShowMinted(false)} />
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
        <Topbar onSignout={handleSignout} keyLabel={keyLabel} />
        <div className="app">
          <Sidebar
            activePane={activePane}
            onPaneChange={choosePane}
            keyLabel={keyLabel}
            keyId={currentKey?.id}
            keysCount={liveKeys}
            verdictsCount={feed.length}
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
            {activePane === 'pane-playground' && <PlaygroundPane onAttempted={refresh} />}
          </main>
        </div>
        <Tabbar activePane={activePane} onPaneChange={choosePane} keysCount={liveKeys} verdictsCount={feed.length} />
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
