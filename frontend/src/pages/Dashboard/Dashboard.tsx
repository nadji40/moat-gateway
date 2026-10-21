import { useState, useEffect, useCallback, useRef } from 'react'
import { L } from '../../i18n'
import Topbar from './components/Topbar'
import Sidebar from './components/Sidebar'
import UsagePane from './components/UsagePane'
import VerdictsPane from './components/VerdictsPane'
import ApiKeysPane from './components/ApiKeysPane'
import PlaygroundPane from './components/PlaygroundPane'
import GateSection from './components/GateSection'
import MintedSection from './components/MintedSection'
import VerdictDrawer from './components/VerdictDrawer'
import type { Verdict, ApiKey, UsageData } from './types'

const SLOT = 'moat.admin'

function held(): string | null {
  try { return localStorage.getItem(SLOT) } catch { return null }
}
function hold(v: string | null) {
  try { v ? localStorage.setItem(SLOT, v) : localStorage.removeItem(SLOT) } catch { /* private */ }
}

async function control(path: string, opts: RequestInit = {}) {
  const key = held()
  const res = await fetch(path, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: 'Bearer ' + key } : {}),
      ...(opts.headers || {}),
    },
  })
  const text = await res.text()
  let body: unknown
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  if (!res.ok) throw new Error(typeof body === 'string' ? body : ((body as Record<string, string>)?.error) || res.statusText)
  return body
}

type PaneId = 'pane-usage' | 'pane-verdicts' | 'pane-keys' | 'pane-playground'

export default function Dashboard() {
  const [authed, setAuthed] = useState(() => Boolean(held()))
  const [showMinted, setShowMinted] = useState(false)
  const [secret, setSecret] = useState('')
  const [activePane, setActivePane] = useState<PaneId>('pane-usage')
  const [feed, setFeed] = useState<Verdict[]>([])
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [usage, setUsage] = useState<UsageData | null>(null)
  const [error, setError] = useState('')
  const [drawerVerdict, setDrawerVerdict] = useState<Verdict | null>(null)
  const returnToRef = useRef<HTMLElement | null>(null)

  // apply body class for workspace mode
  useEffect(() => {
    if (authed && !showMinted) {
      document.body.classList.add('in-ws')
    } else {
      document.body.classList.remove('in-ws')
    }
    return () => { document.body.classList.remove('in-ws') }
  }, [authed, showMinted])

  const refresh = useCallback(async () => {
    const [usageRes, feedRes, keysRes] = await Promise.allSettled([
      control('/v1/usage'),
      control('/v1/verdicts'),
      control('/v1/keys'),
    ])
    if (usageRes.status === 'fulfilled') setUsage(usageRes.value as UsageData)
    if (feedRes.status === 'fulfilled') setFeed(feedRes.value as Verdict[])
    if (keysRes.status === 'fulfilled') setKeys(keysRes.value as ApiKey[])
    if (usageRes.status === 'rejected' || feedRes.status === 'rejected' || keysRes.status === 'rejected') {
      const err = [usageRes, feedRes, keysRes].find(r => r.status === 'rejected')
      if (err && err.status === 'rejected') setError(String((err.reason as Error).message || err.reason))
    }
  }, [])

  useEffect(() => {
    if (authed && !showMinted) refresh()
  }, [authed, showMinted, refresh])

  const handleCreate = async (id: string, name: string) => {
    const out = await control('/v1/signup', { method: 'POST', body: JSON.stringify({ id, name }) }) as { secret: string }
    hold(out.secret)
    setSecret(out.secret)
    setShowMinted(true)
    setAuthed(true)
  }

  const handleSignin = async (key: string) => {
    hold(key)
    try {
      await control('/v1/keys')
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
    const out = await control('/v1/keys', {
      method: 'POST',
      body: JSON.stringify({
        label,
        access_role: role,
        scopes,
        ...(days ? { expires_in_days: days } : {}),
      }),
    }) as { secret: string }
    setSecret(out.secret)
    setShowMinted(true)
    document.body.classList.remove('in-ws')
  }

  const handleMintedDone = () => {
    setShowMinted(false)
  }

  const handleRevokeKey = async (keyId: string, purge: boolean) => {
    const purgeQ = purge ? '?purge=1' : ''
    await control('/v1/keys/' + keyId + purgeQ, { method: 'DELETE' })
    await refresh()
  }

  const handleOpenVerdict = (evidenceId: string) => {
    const v = feed.find(x => x.evidence_id === evidenceId)
    if (v) {
      returnToRef.current = document.activeElement as HTMLElement
      setDrawerVerdict(v)
    }
  }

  const handleCloseVerdict = () => {
    setDrawerVerdict(null)
    if (returnToRef.current?.focus) returnToRef.current.focus()
  }

  // Gate (login) screen
  if (!authed) {
    return <GateSection onCreate={handleCreate} onSignin={handleSignin} />
  }

  // Minted key screen
  if (showMinted) {
    return <MintedSection secret={secret} onDone={handleMintedDone} />
  }

  // Workspace
  const maskedKey = (() => {
    const sec = held() || ''
    return sec.length > 12 ? sec.slice(0, 8) + '...' + sec.slice(-4) : sec
  })()

  const currentKey = keys.find(k => k.current)

  return (
    <>
      <div className="shell">
        <Topbar onSignout={handleSignout} />
        <div className="app">
          <Sidebar
            activePane={activePane}
            onPaneChange={setActivePane}
            keyLabel={currentKey?.label || L('an admin key', 'مفتاح المسؤول')}
            maskedKey={maskedKey}
            keysCount={keys.filter(k => k.active).length}
            verdictsCount={feed.length}
          />
          <main className="surface">
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
            {activePane === 'pane-playground' && (
              <PlaygroundPane />
            )}
          </main>
        </div>
      </div>

      {/* Drawer overlay + drawer */}
      {drawerVerdict && (
        <>
          <div className="scrim" onClick={handleCloseVerdict} />
          <VerdictDrawer verdict={drawerVerdict} onClose={handleCloseVerdict} />
        </>
      )}
    </>
  )
}
